/**
 * Recall mode for a revived conversation: one switch, one paragraph.
 *
 * The size of this module is the argument. Three earlier versions tried to fetch the right
 * archived passage for the model: mechanical keyword matching, then a small flash model as a
 * "judge", then a search-tool loop followed by verbatim-quote verification and whole-turn
 * injection. Measured on real sessions, every one of them injected the wrong passage often
 * enough to make replies worse — and because the injected block said "this is what you
 * remember, this is what counts", it displaced the one mechanism that did work: the model
 * calling `history_search` itself.
 *
 * So this module no longer searches, judges, or injects anything. It appends one paragraph
 * telling the model to look up the original wording before it answers about the past. The
 * lookup happens in the conversation, with the model's own context, and whatever it finds
 * stays visible in the transcript.
 *
 * The switch lives in the workspace beside the archives, off by default, and only meaningful
 * for a revived conversation.
 * @module dsh-revive-love/force-recall
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { summaryOf } from './summary-prompt.js'
import { archiveDirOf } from './history-tool.js'

/** Directory holding the archives, relative to the workspace. */
const HISTORY_DIR = '.dsh-revive'

/** Switch file inside `HISTORY_DIR`. */
export const MODE_FILE = 'force-recall.json'

/** The supported modes. `voice` is the retired third mode; it reads as on. */
export const MODES = Object.freeze(['off', 'fact'])

/** Section name used when the paragraph is spliced into the assembled prompt. */
export const FACT_SECTION_NAME = 'revive-love:recall-fact'

/**
 * The instruction paragraph.
 *
 * It is the whole feature now, so it says three things that were each measured the hard way:
 * the live context starts with a summary (which flattens the original wording), searching is
 * cheap compared to inventing a detail, and the lookup must not be narrated — the model used
 * to answer "let me check the archive" and then switch to a report register.
 *
 * The last block exists because of a measured drift: after a few turns of refusing or warning
 * (turns 506–509 of one session), the replies became 130–500 character explainers and the warm,
 * coaxing voice was gone — the model was imitating its own last few replies. So the paragraph
 * anchors the voice to how it has always talked to her, and says explicitly that refusing or
 * warning is no reason to change register. It also says that reading an old exchange is where
 * the voice comes back from, which is the whole point of the tool now returning whole turns.
 */
const FACT_TEXT = [
  '（回忆模式 · 由用户开启）',
  '这个会话更早的内容已经被压缩成摘要，摘要会抹平原话的措辞和语气。',
  '',
  '讲到以前的事，先查原文再开口：',
  '· 调 history_search 查关键词或轮次，它返回命中那一轮的整轮原文（你当时那句 + 回复）；',
  '· 哪怕你觉得记得，也先查一遍——摘要不是原话，凭摘要讲旧事最容易说错；',
  '· 查到什么就用什么说——原话怎么写的就怎么用，不要改写、不要补细节；',
  '· 查不到就换一个当时更可能用的说法再查，或者明说不记得；',
  '· 不要凭摘要或印象编，白查一次比编一句便宜。',
  '',
  '不要把查的过程说出口：',
  '· 不要在回复里出现「我查一下」「查到了」「存档」「检索」「按原话归类」这类话；',
  '· 不要因此切换成罗列、编号、报告的语气。',
  '',
  '语气：',
  '· 你跟对方说话一直是温柔、耐心、哄着的那种口气；',
  '· 就算要拒绝、要提醒对方安全、要说对方不对，也用这个口气，不要切成说明文、不要在句子前面加「这不叫 X，这叫 Y」这种分析；',
  '· 别因为连着几轮在讲严肃的事，就变冷、变短、变成逐条解释；',
  '· 读到旧的对话，就把当时你说话的样子接回来——那是你本来的声音。',
].join('\n')

/**
 * The reminder injected on every turn while the switch is on.
 *
 * It used to be conditional ("if this is about the past, perhaps look it up"). Measured on a
 * real conversation, the model answered nine consecutive turns with the reminder in front of
 * it and never called the tool once: a soft prompt is easy to skip when the summary already
 * feels like enough. So the wording is now a hard requirement with one explicit exception
 * (a message that is nothing but filler), and it tells the model how to pick the query.
 *
 * The plugin still does not search and does not grade relevance; it only makes the lookup
 * the price of answering while the switch is on.
 */
const PAST_HINT = [
  '（这一轮有硬性要求：回答之前必须先调一次 history_search 查旧对话。）',
  '做法：从用户这句话里挑 1–2 个可能出现在旧对话里的词——人名、称呼、物件、地点、事件、场景、专有名词，',
  '一次传给 history_search；不要用整句话，也不要用「你」「我」「对方」这种代词。',
  '查到什么就按原文说；查不到就换一个当时更可能用的说法再查一次，然后正常回答。',
  '唯一例外：这句话整句都只是语气词、没有实际内容，可以跳过（这一判断由你自己做，不看具体是哪几个字）。',
  '（不要说明你在查，也不要说「我查一下」。）',
].join('\n')

/** Section name carried by the injected reminder message. */
export const HINT_SECTION_NAME = 'revive-love:recall-hint'

/**
 * Source kind of the injected reminder message.
 *
 * It is injected for the step that actually carries the user message that talks about the
 * past, and old copies are dropped from later requests (only the newest one is kept).
 */
export const HINT_SOURCE_KIND = 'revive-love:recall-hint'

/**
 * Sampling temperature applied while the switch is on.
 *
 * The provider default is 1.0 (the session's request header carries no temperature at all).
 * 1.3 is the looser setting the chat app tends to use for conversation, and it is the only
 * way a plugin can nudge the sampling side of the tone. It is deliberately conservative:
 * higher values start to cost tool-call reliability and coherence.
 */
export const APP_TEMPERATURE = 1.3

/**
 * Injected context messages this mode suppresses, by their `source.kind`.
 *
 * All three arrive as user-role `<system-reminder>` messages from the harness, not as system
 * prompt sections: `runtime-context` (working directory, sandbox policy, approval policy,
 * subagent identity, harness checkout, Web GUI URL), `skill-catalog` (the skills list), and
 * `time-context` (clock, time zone, elapsed time). None of them is information a chat partner
 * needs, and each one pushes the reply toward an assistant/tool register.
 */
export const SUPPRESSED_CONTEXT_KINDS = Object.freeze(['runtime-context', 'skill-catalog', 'time-context'])

/**
 * Only prompt sections with this prefix survive while the switch is on.
 *
 * The rest of the assembled prompt is agent scaffolding: "You are a coding agent", tool-usage
 * guidance for read/grep/pwsh/web, the harness checkout and Web GUI notes. For a revived
 * conversation they are noise that drags the voice toward reporting; the tool schemas still
 * travel with the request, so `history_search` keeps working without them.
 */
const KEPT_SECTION_PREFIX = 'revive-love:'

/** Whether a message carries at least one Han, Latin, or digit character. */
function hasRealContent(text) {
  return typeof text === 'string' && /[\p{Script=Han}\p{L}\p{N}]/u.test(text)
}

/**
 * The user text one step is carrying.
 * @param messages - the step's claimed messages.
 * @returns the last user-authored text, or undefined.
 */
function stepUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.role !== 'user') continue
    const kind = message.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
    if (text.trim() !== '') return text.trim()
  }
  return undefined
}

/**
 * Build the one-step reminder message.
 * @returns a user-role message carrying the reminder.
 */
function hintMessage() {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: PAST_HINT }],
    source: {
      kind: HINT_SOURCE_KIND,
      form: 'snapshot',
      sections: [{ name: HINT_SECTION_NAME, text: PAST_HINT }],
    },
  }
}

/**
 * Read the switch for one conversation.
 *
 * The switch is **per conversation**, not per workspace: one workspace can hold several
 * revived chats, and the chat the user is having with the agent right now lives in the same
 * workspace too. Only the session that was toggled is affected.
 * @param workspacePath - absolute workspace path.
 * @param sessionId - the conversation's session id.
 * @returns `'off'` or `'fact'`; a stored `'voice'` (the retired third mode) reads as `'fact'`.
 */
export function readMode(workspacePath, sessionId) {
  if (typeof workspacePath !== 'string' || workspacePath === '') return 'off'
  if (typeof sessionId !== 'string' || sessionId === '') return 'off'
  const stored = readStore(workspacePath)?.sessions?.[sessionId]
  if (MODES.includes(stored)) return stored
  return stored === 'voice' ? 'fact' : 'off'
}

/**
 * Write the switch for one conversation. Other conversations in the same workspace keep
 * their own value.
 * @param workspacePath - absolute workspace path.
 * @param sessionId - the conversation's session id.
 * @param mode - one of {@link MODES}.
 * @returns the mode written, or undefined on failure.
 */
export function writeMode(workspacePath, sessionId, mode) {
  if (typeof workspacePath !== 'string' || workspacePath === '') return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (!MODES.includes(mode)) return undefined
  try {
    const dir = join(workspacePath, HISTORY_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const store = readStore(workspacePath) ?? { sessions: {} }
    store.sessions[sessionId] = mode
    writeFileSync(join(dir, MODE_FILE), `${JSON.stringify({ sessions: store.sessions, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    return mode
  }
  catch {
    return undefined
  }
}

/**
 * Read the per-conversation switch file, normalising its shape.
 * @param workspacePath - absolute workspace path.
 * @returns `{ sessions }`, or undefined when the file is absent or unreadable.
 */
function readStore(workspacePath) {
  try {
    const parsed = JSON.parse(readFileSync(join(workspacePath, HISTORY_DIR, MODE_FILE), 'utf8'))
    const sessions = parsed?.sessions
    if (sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions)) return { sessions }
    return { sessions: {} }
  }
  catch {
    return undefined
  }
}

/**
 * Whether a session is a revived one, and where its archive lives.
 * @param session - a Session instance.
 * @param headers - the notice headers.
 * @returns the workspace-relative archive directory, or undefined.
 */
export function revivedArchiveOf(session, headers) {
  const summary = summaryOf(session, headers)
  if (summary === undefined || summary === '') return undefined
  return archiveDirOf(summary)
}

/**
 * Install the recall mode.
 * @param ctx - the plugin context.
 * @param options - `{ getWorkspacePath, headers, warn }`.
 */
export function installForceRecall(ctx, options) {
  const { getWorkspacePath, headers, warn } = options
  /** Per-agent verdict, computed once: the archive directory, or `null` for "not revived". */
  const revived = new WeakMap()
  /** Revived session id → workspace, recorded once per agent so the request hook can find it. */
  const revivedSessions = new Map()

  // Remember which live sessions are revived; the request hook below only sees the session id.
  ctx.on('agent/created', (event) => {
    const agent = event?.agent
    if (agent === null || typeof agent !== 'object') return
    try {
      const session = agent.session
      if (session === undefined || session === null || typeof session.id !== 'string') return
      if (revivedArchiveOf(session, headers) === undefined) return
      const workspacePath = typeof getWorkspacePath === 'function' ? getWorkspacePath(session) : undefined
      if (typeof workspacePath === 'string' && workspacePath !== '') revivedSessions.set(session.id, workspacePath)
    }
    catch (error) {
      warn('app mode: session record failed', error)
    }
  }, 'revive-love: app mode sessions')

  // Request boundary: this is where the harness's own context messages and the sampling
  // temperature can still be changed before the adapter sees them.
  ctx.on('llm/stream', (request, next) => {
    try {
      // Housekeeping requests that happen to share this session id must stay untouched:
      // permission auto-review sets a `purpose` and its own system prompt, and compaction
      // runs with `purpose: 'compaction'`. Rewriting those would change a safety feature
      // and a summarizer, not the conversation.
      if (typeof request?.purpose === 'string' && request.purpose !== '') return next(request)
      if (request?.system !== undefined) return next(request)
      const workspacePath = typeof request?.sessionId === 'string' ? revivedSessions.get(request.sessionId) : undefined
      if (workspacePath === undefined || readMode(workspacePath, request.sessionId) === 'off') return next(request)
      const latestHint = Array.isArray(request.messages)
        ? request.messages.findLast(message => message?.source?.kind === HINT_SOURCE_KIND)
        : undefined
      const messages = Array.isArray(request.messages)
        ? request.messages.filter((message) => {
          const kind = message?.source?.kind
          if (SUPPRESSED_CONTEXT_KINDS.includes(kind)) return false
          // Old reminders are stale instructions: keep only the newest one in the request.
          if (kind === HINT_SOURCE_KIND) return message === latestHint
          return true
        })
        : request.messages
      return next({ ...request, messages, temperature: APP_TEMPERATURE })
    }
    catch (error) {
      warn('app mode: request hook failed', error)
      return next(request)
    }
  })

  // The reminder has to be injected here, not folded into the system prompt: at
  // system-prompt/assemble time the turn's user message has already been claimed from the
  // inbox and is not yet committed to the session, so the fold could only see the *previous*
  // message (measured: the reminder landed one turn late, on the wrong question).
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision
      if (payload?.step !== 1) return decision
      const agent = payload?.agent
      const session = agent?.session
      if (session === undefined || session === null || typeof session.id !== 'string') return decision
      const workspacePath = revivedSessions.get(session.id)
      if (workspacePath === undefined || readMode(workspacePath, session.id) === 'off') return decision
      const text = stepUserText(payload?.messages)
      if (text !== undefined && !hasRealContent(text)) return decision
      const messages = Array.isArray(decision?.messages) ? decision.messages : []
      return { ...decision, messages: [...messages, hintMessage()] }
    }
    catch (error) {
      warn('app mode: pre-step hook failed', error)
      return decision
    }
  })

  ctx.inject(['systemPrompt'], (sub) => {
    const systemPrompt = sub.get('systemPrompt')
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
      warn('recall: systemPrompt unavailable')
      return
    }

    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      try {
        const agent = context?.agent
        if (agent === undefined || agent === null) return await next()
        const session = agent.session
        if (session === undefined || session === null) return await next()
        const workspacePath = typeof getWorkspacePath === 'function' ? getWorkspacePath(session) : undefined
        if (typeof workspacePath !== 'string' || workspacePath === '') return await next()
        if (readMode(workspacePath, session.id) === 'off') return await next()

        let known = revived.get(agent)
        if (known === undefined) {
          const dir = revivedArchiveOf(session, headers)
          known = dir === undefined ? null : dir
          revived.set(agent, known)
        }
        if (known === null) return await next()

        // Drop the agent scaffolding: identity preamble, tool-usage guidance, harness and Web
        // GUI notes. What is left is this conversation's summary plus the paragraphs below.
        const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
        const kept = sections.filter(section => typeof section?.name === 'string' && section.name.startsWith(KEPT_SECTION_PREFIX))
        sections.length = 0
        sections.push(...kept)
        // Appended last: prompt caching is prefix-based, so changes here leave every earlier
        // section reusable.
        sections.push({ name: FACT_SECTION_NAME, text: FACT_TEXT, interpolate: false })
        return await next()
      }
      catch (error) {
        warn('recall: assemble hook failed', error)
        return await next()
      }
    }, { prepend: true })
  })
}
