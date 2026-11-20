/**
 * Put the amplify summary into the revived session's system prompt.
 *
 * Why: a summary stored as the first user message reads like "the user just handed me
 * this text" — the model treats it as current input and may restate or question it.
 * The same text contributed as a scoped system-prompt section reads like background the
 * model already holds, which is what a memory note is supposed to be.
 *
 * The summary itself stays in the session history (it has to survive restarts, and the
 * log is the only durable store this plugin owns), so it is paid for twice: once in the
 * history, once in the system prompt. That is the deliberate trade for the stronger role.
 * @module dsh-revive-love/summary-prompt
 */

/** Section name; unique so it can be replaced or removed by name. */
export const SUMMARY_SECTION_NAME = 'revive-love:earlier-summary'

/** Order value: after the deployment persona, before the generated tool guidance. */
const SUMMARY_SECTION_ORDER = 50

/** Marker the archive pointer starts with; its presence means an archive exists. */
const ARCHIVE_MARKER = '完整原文存档：'

/**
 * Framing text that tells the model this is background rather than a request.
 * The archive hint is only added when the summary actually carries a pointer: sessions
 * summarised before the archive feature existed have nothing to point at.
 * @param summary - the summary text.
 * @param hasArchive - whether the summary ends with an archive pointer.
 * @returns the section text.
 */
const frame = (summary, hasArchive) => [
  '【本会话更早部分的内容摘要】',
  '',
  summary,
  '',
  '上面这些是你在这个会话更早的部分里已经知道的内容。把它当作既有背景，',
  '不要当作新的用户请求，也不要向我复述它。',
  ...(hasArchive
    ? [
      '',
      '上面只是提要，不含原话。涉及具体原话、具体说法、具体细节时，先用 history_search 工具',
      '在存档里查，查到了再答；不要凭提要或印象补全。',
      '存档是你和这个人过去的对话记录，是你的记忆，不是一份陌生的资料库：回忆它，别当成查别人的档案。',
    ]
    : []),
].join('\n')

/**
 * Pull the summary out of the first user message that carries the amplify header.
 * @param session - the Session instance handed to `session/created`, or `agent.session`.
 * @returns the summary text, or undefined when this session was not amplified.
 */
export function summaryOf(session, headers) {
  let events
  try {
    if (typeof session?.snapshotEvents === 'function') events = session.snapshotEvents()
    else if (Array.isArray(session?.events)) events = session.events
    else if (typeof session?.ownEvents === 'function') events = session.ownEvents()
  }
  catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    const text = content.find(part => part?.type === 'text' && typeof part.text === 'string')?.text
    if (typeof text !== 'string') continue
    for (const header of headers) {
      if (text.startsWith(header)) return text.slice(header.length).trim()
    }
    // The first user message is not a summary: nothing to inject for this session.
    return undefined
  }
  return undefined
}

/**
 * Register the injection on a host context.
 * @param ctx - the plugin context.
 * @param options - `{ headers, warn }`.
 */
export function installSummaryPrompt(ctx, options) {
  const { headers, warn } = options
  const done = new WeakSet()

  ctx.inject(['systemPrompt'], (sub) => {
    const systemPrompt = sub.get('systemPrompt')
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
      warn('summary prompt: systemPrompt.section unavailable')
      return
    }
    ctx.on('agent/created', (event) => {
      const agent = event?.agent
      if (agent === null || typeof agent !== 'object') return
      if (done.has(agent)) return
      const session = agent.session
      if (session === undefined || session === null) return
      const summary = summaryOf(session, headers)
      if (summary === undefined || summary === '') return

      // The scoped instance on `agent.ctx` is what keeps the section out of every other
      // conversation. `agent.ctx.effect()` alone only ties the registration's lifetime to
      // the agent — registering on the global service there leaks the text into all sessions.
      const scoped = agent.ctx?.systemPrompt
      if (scoped === undefined || typeof scoped.section !== 'function') {
        warn('summary prompt: agent-scoped systemPrompt unavailable, skipping injection')
        return
      }

      done.add(agent)
      const text = frame(summary, summary.includes(ARCHIVE_MARKER))
      try {
        agent.ctx.effect(() => scoped.section({
          name: SUMMARY_SECTION_NAME,
          order: SUMMARY_SECTION_ORDER,
          text,
        }))
        warn(`summary prompt: injected ${text.length} chars into ${String(session.id)}`)
      }
      catch (error) {
        warn('summary prompt: injection failed', error)
      }
    }, 'revive-love: summary prompt')
  })
}
