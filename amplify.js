/**
 * Amplify mode: keep the discarded turns by having an agent summarize them.
 *
 * The plugin no longer drives one model call per segment. It writes the dropped turns
 * into chunk files inside the workspace and hands the whole job to one agent session,
 * which reads them and answers with a single memory note.
 * @module dsh-revive-love/amplify
 */

/**
 * Largest character count one chunk file may carry. This only bounds the files the
 * agent reads, not a prompt: the agent decides how much to read at a time.
 */
export const CHUNK_CHARS = 400_000
/**
 * Longest slice of one turn written to disk. One enormous turn would otherwise
 * dominate a chunk; the head and tail keep the gist.
 */
export const TURN_CLIP_CHARS = 20_000
/** Characters kept from the start of an over-long turn. */
const TURN_HEAD_CHARS = 12_000

/** Hard ceiling for the whole wait on one summary session. */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000
/**
 * How long with no text before the run parks and asks the user what to do.
 * A summary that finishes quickly should never reach this; a silent one should not
 * leave the panel spinning either.
 */
export const STALL_AFTER_MS = 5 * 60 * 1000
/**
 * How long a parked run waits for the browser to answer before giving up on its own.
 * Without it a closed wizard leaves the run parked inside `pause()` forever, and the
 * single run slot stays busy (`/build` keeps answering 409) until DSH restarts.
 */
export const STALLED_MAX_MS = 15 * 60 * 1000
/**
 * Longest one `wait()` slice may block. The run deadline is checked between awaits, so a
 * `wait()` that never settles would otherwise defeat the 10 minute ceiling.
 */
const WAIT_SLICE_MS = 60 * 1000
/** Sentinel returned by `raceTimeout`. */
const SLICE_TIMEOUT = Symbol('slice-timeout')

/** Model the summary session runs. Explicit on purpose: unset inherits the deployment
 * default, which is `reasoningEffort: "low"` — slower and pricier than `off`. */
export const DEFAULT_MODEL = Object.freeze({
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'off',
})

/**
 * Token estimate for a character count. Deliberately pessimistic: the warning that
 * reaches the user must never undersell the cost.
 * @param chars - character count of the source text.
 * @returns estimated tokens, rounded up.
 */
export function estimateTokensOf(chars) {
  return Math.ceil(chars / 1.3)
}

/** Keep the head and tail of an over-long message, marking the cut. */
function clip(text) {
  if (typeof text !== 'string') return ''
  if (text.length <= TURN_CLIP_CHARS) return text
  const head = text.slice(0, TURN_HEAD_CHARS)
  const tail = text.slice(text.length - (TURN_CLIP_CHARS - TURN_HEAD_CHARS))
  return `${head}\n…（略去 ${text.length - TURN_CLIP_CHARS} 字）…\n${tail}`
}

/** Render one turn as the text written to disk. */
function turnText(turn) {
  const parts = []
  const user = clip(turn.userText)
  const reply = clip(turn.replyText)
  if (user !== '') parts.push(`【用户】${user}`)
  if (reply !== '') parts.push(`【助手】${reply}`)
  return parts.join('\n\n')
}

/**
 * Split the dropped turns into chunk payloads on turn boundaries.
 * A chunk never ends inside a turn: when the next turn would overflow the budget the
 * chunk closes before it, so the run may emit one more chunk rather than cut a turn.
 * @param turns - turns oldest first, each `{ userText, replyText, chars }`.
 * @param maxChars - per-chunk character budget.
 * @returns chunk descriptors carrying their rendered text.
 */
export function chunkTurns(turns, maxChars = CHUNK_CHARS) {
  const chunks = []
  let parts = []
  let chars = 0
  for (const turn of turns) {
    const text = turnText(turn)
    if (parts.length > 0 && chars + text.length > maxChars) {
      chunks.push({ text: parts.join('\n\n'), chars, turns: parts.length })
      parts = []
      chars = 0
    }
    parts.push(text)
    chars += text.length
  }
  if (parts.length > 0) chunks.push({ text: parts.join('\n\n'), chars, turns: parts.length })
  return chunks.map((chunk, index) => ({
    index,
    chars: chunk.chars,
    turns: chunk.turns,
    tokens: estimateTokensOf(chunk.chars),
    text: chunk.text,
  }))
}

/**
 * One prompt that hands the whole job to the agent.
 * @param dirRelative - directory (relative to the workspace) holding the chunks.
 * @param chunkCount - how many chunk files were written.
 * @param locale - `zh` or `en`.
 * @returns the prompt text.
 */
export function summaryPrompt(dirRelative, chunkCount, locale) {
  const fileHint = chunkCount === 1 ? `${dirRelative}/part-01.md` : `${dirRelative}/part-01.md … part-${String(chunkCount).padStart(2, '0')}.md`
  if (locale === 'en') {
    return [
      `The chat history of an earlier part of a conversation was written to \`${fileHint}\` (${chunkCount} file(s), in order).`,
      'Read all of it and condense it into one compact memory note another assistant can use to continue that conversation.',
      'Keep: decisions, preferences, commitments, open threads, recurring jokes, and tone. Drop: pleasantries and repetition.',
      // Measured failure: the agent answered "I'll read the remaining parts of file 1 and file 3"
      // and ended the turn, so the run finished with 51 characters and 61% read.
      'Do not describe what you are about to do — do it. Read every file to the end before you answer.',
      // Answering in the chat is the contract: writing a file inside the workspace can be
      // blocked by the sandbox's folder grants, and a summary that arrives is worth more
      // than a tidy file that does not.
      'Reply with the note itself as your final message — do not ask for confirmation.',
      'Write in the language of the source.',
    ].join('\n')
  }
  return [
    `一段较早的聊天记录已经写到 \`${fileHint}\`（共 ${chunkCount} 个文件，按顺序）。`,
    '请全部读完，压缩成一份紧凑的记忆笔记，供另一个助手继续这段对话时使用。',
    '保留：结论、偏好、承诺、未完成的事、反复出现的梗与语气。删掉：客套和重复。',
    // 实测翻车：它回了一句「I'll read the remaining parts…」就结束了这一轮，
    // 于是 51 字的“摘要”被当成结果，读完的比例只有 61%。
    '不要在回复里描述你打算做什么——直接做。每个文件都要读到结尾再回答。',
    // 直接把笔记回复在对话里：在工作区里写文件可能被沙箱的目录授权挡住，
    // 拿到摘要比留下一个整齐的文件更重要。
    '把你的最终回复本身写成这份笔记，不要询问确认、不要只回复“完成”。',
    '用原文的语言写。',
  ].join('\n')
}

/** Longest reply still treated as a status line rather than a memory note. */
export const SUMMARY_MIN_CHARS = 200

/** Phrases that mean "about to read" rather than "here is the note". */
const NARRATION = /^(?:我(先|来|现在)?(去|要|会)?(读|看|检查|整理|开始)|正在读|开始读|let me|i'?ll|i will|i'?m going to)/iu

/**
 * Whether a reply can stand in as the memory note.
 *
 * A short reply is a status line, not a note: measured, a run ended with
 * "I'll read the remaining parts of file 1 and file 3" (51 characters) and was accepted as the
 * summary, which then went into a revived conversation as its only memory.
 * @param text - the candidate summary.
 * @returns whether it is substantial enough to keep.
 */
export function looksLikeSummary(text) {
  const value = String(text ?? '').trim()
  if (value.length < SUMMARY_MIN_CHARS) return false
  if (NARRATION.test(value) && value.length < SUMMARY_MIN_CHARS * 3) return false
  return true
}

/**
 * What to send when the first attempt only narrated its plan.
 * @param locale - `zh` or `en`.
 * @returns the follow-up prompt.
 */
export function summaryNudge(locale) {
  return locale === 'en'
    ? 'You described what you were about to do and then stopped. Read the remaining part(s) to the end now, and reply with the finished memory note itself.'
    : '你刚才只描述了打算做什么就停下来了。现在把剩下的文件读完，并直接把写完的记忆笔记作为回复。'
}

/** Title for the summary session. */
export function amplifyTitle(removedTurns, locale) {
  return locale === 'en' ? `Summary: the first ${removedTurns} turns` : `摘要：前 ${removedTurns} 轮`
}

/**
 * Title given to a summary session whose run was cancelled. The session itself is kept,
 * but a cancelled one must be recognisable in the sidebar instead of looking like a
 * finished summary.
 */
export function cancelledAmplifyTitle(removedTurns, locale) {
  const count = Number.isFinite(removedTurns) ? removedTurns : 0
  return locale === 'en'
    ? `Cancelled · summary of the first ${count} turns`
    : `已取消 · 摘要前 ${count} 轮`
}

/**
 * Newest assistant text inside a `wait` output.
 * The record shape is not part of this plugin's contract: `wait` hands back session
 * history entries whose nesting has already changed once, so rather than assume one
 * layout this walks whatever arrived and takes the last assistant text it finds.
 * @param output - `SessionWaitValue.output`.
 * @returns the assistant text, or undefined.
 */
export function assistantTextFrom(output) {
  if (output === null || typeof output !== 'object') return undefined
  // The record shape is not part of this plugin's contract and has already surprised us
  // twice, so rather than match one layout, walk the whole value and keep the longest
  // assistant text. A final answer is nearly always the longest thing the agent says.
  let best
  const stack = [output]
  let guard = 0
  while (stack.length > 0 && guard < 20000) {
    guard += 1
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    const role = node.role
    const type = node.type
    const looksAssistant = role === 'assistant' || (typeof type === 'string' && type.includes('assistant'))
    if (looksAssistant && Array.isArray(node.content)) {
      const text = node.content
        .filter((part) => part !== null && typeof part === 'object' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
        .trim()
      if (text !== '' && (best === undefined || text.length > best.length)) best = text
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') stack.push(value)
    }
  }
  return best
}

/**
 * A shape-only sample of the last record, for the run log when extraction finds no text.
 * It deliberately reports keys, types and lengths and never the values: the dropped turns
 * are what this feature exists to move off the open chat, so they must not end up persisted
 * in a diagnostic log that survives cleanup.
 * @param output - `SessionWaitValue.output`.
 * @returns a compact description such as `{turn:number,message:object}`.
 */
export function recordsSample(output) {
  if (output === null || typeof output !== 'object') return 'none'
  const records = Array.isArray(output.records) ? output.records : []
  if (records.length === 0) return 'empty'
  const last = records[records.length - 1]
  if (last === null || typeof last !== 'object') return `last:${typeof last}`
  const keys = Object.keys(last).slice(0, 12)
  const shape = keys.map((key) => {
    const value = last[key]
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const size = typeof value === 'string' || Array.isArray(value) ? `(${value.length})` : ''
    return `${key}:${type}${size}`
  })
  return `{${shape.join(',')}}`
}

/**
 * Total provider-reported usage across every assistant step of a session.
 *
 * `scanUsage` below answers "how big did one step get", which is what the stall guard
 * wants. The floating panel wants the running bill, and that is this sum: reading a file
 * re-sends everything read before it, so the last step's size is nowhere near the total.
 * @param events - `session.snapshotEvents()`.
 * @returns the summed `totalTokens`, or 0 when no step reported usage.
 */
export function totalUsageOf(events) {
  if (!Array.isArray(events)) return 0
  let total = 0
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || usage === null || typeof usage !== 'object') continue
    const reported = Number(usage.totalTokens)
    if (Number.isFinite(reported)) {
      total += reported
      continue
    }
    total += (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.outputTokens) || 0)
  }
  return total
}

/**
 * Sum provider-reported token usage found anywhere in a state snapshot.
 * @param snapshot - whatever `controller.wait()` returned.
 * @returns the largest total found, in tokens, or 0.
 */
export function scanUsage(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return 0
  const stack = [snapshot]
  let best = 0
  let guard = 0
  while (stack.length > 0 && guard < 8000) {
    guard += 1
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    const input = Number(node.uncachedInputTokens)
    const cacheRead = Number(node.cacheReadTokens)
    const output = Number(node.outputTokens)
    if (Number.isFinite(input) || Number.isFinite(cacheRead) || Number.isFinite(output)) {
      const total = (Number.isFinite(input) ? input : 0) + (Number.isFinite(cacheRead) ? cacheRead : 0) + (Number.isFinite(output) ? output : 0)
      if (total > best) best = total
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') stack.push(value)
    }
  }
  return best
}

/** Stable prompt identity. */
function requestIdOf(sessionId) {
  return `${sessionId}-amplify`
}

/** Chunk file names, as written by `files.write`. */
const PART_FILE = /part-\d+\.md$/

/** Coverage at or above this counts as complete; a line-count off-by-one must not alarm. */
const COVERAGE_ENOUGH = 0.99

/**
 * How much of the chunk files the summary session actually read.
 *
 * The prompt asks it to read everything, but `read` returns roughly a thousand lines per
 * call and a 400,000-character chunk is nearly twenty thousand lines, so a long run can end
 * with the model having read part of each file and summarised anyway. The session's own
 * `tool/result` events carry `meta.offset`, the returned line count and `meta.totalLines`,
 * so the real coverage can be measured instead of trusted.
 * @param session - the summary session, from `sessions.get(id)`.
 * @returns `{ ratio, parts }`, or undefined when nothing measurable was read.
 */
export function readCoverageOf(session) {
  let events
  try {
    if (typeof session?.snapshotEvents === 'function') events = session.snapshotEvents()
    else if (Array.isArray(session?.events)) events = session.events
  }
  catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  const per = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const meta = event.data?.meta
    if (meta === undefined || typeof meta.path !== 'string') continue
    const name = meta.path.replace(/\\/gu, '/').split('/').pop()
    if (name === undefined || !PART_FILE.test(name)) continue
    const total = Number(meta.totalLines)
    if (!Number.isFinite(total) || total <= 0) continue
    const count = Array.isArray(meta.lines) ? meta.lines.length : 0
    if (count === 0) continue
    const start = Number.isFinite(Number(meta.offset)) ? Math.max(1, Number(meta.offset)) : 1
    // Clamp: a slice may overshoot the last line by one, and that is not extra coverage.
    const end = Math.min(total, start + count - 1)
    const previous = per.get(name)
    per.set(name, { total, end: Math.max(previous?.end ?? 0, end) })
  }
  if (per.size === 0) return undefined
  let covered = 0
  let lines = 0
  const parts = []
  for (const [name, item] of per) {
    covered += item.end
    lines += item.total
    parts.push({ name, ratio: item.end / item.total })
  }
  return { ratio: lines === 0 ? 0 : covered / lines, parts }
}

/**
 * State the coverage as a fact. The instruction that follows from it ("check the archive
 * when the wording matters") belongs in the hidden system-prompt section: this text lands
 * in the visible conversation history, where imperative wording reads like an injection.
 * @param coverage - the result of {@link readCoverageOf}.
 * @param locale - `zh` or `en`.
 * @returns the fact line to append to the summary.
 */
export function coverageNote(coverage, locale) {
  const percent = Math.floor(coverage.ratio * 100)
  const detail = coverage.parts
    .filter(part => part.ratio < COVERAGE_ENOUGH)
    .map(part => (locale === 'en'
      ? `${part.name.replace(/\.md$/u, '')} ${Math.floor(part.ratio * 100)}%`
      : `${part.name.replace(/\.md$/u, '')} 读到 ${Math.floor(part.ratio * 100)}%`))
    .join(locale === 'en' ? ', ' : '、')
  if (locale === 'en') {
    return [
      '---',
      `【Coverage】This summary covers ${percent}% of the earlier part${detail === '' ? '' : ` (${detail})`}.`,
    ].join('\n')
  }
  return [
    '---',
    `【覆盖范围】这份摘要覆盖了较早内容的 ${percent}%${detail === '' ? '' : `（${detail}）`}。`,
  ].join('\n')
}

/**
 * Put the deployment default model back after a summary run.
 *
 * `sessionController.selectModel` also saves the *deployment* default, so picking a cheap
 * model for the summary session silently changes what every new conversation starts with —
 * measured: after one amplify run, new conversations defaulted to flash/off, which the user
 * never chose. The restore only happens while the default still equals what this run
 * installed: a user who picked a different model meanwhile keeps their own choice.
 * @param options - `{ controller, sessionId, before, applied, readDefault, warn }`.
 * @returns whether the default was restored.
 */
export async function restoreDefaultSelection(options) {
  const { controller, sessionId, before, applied, readDefault, warn: onWarn } = options
  const same = (left, right) => left !== undefined && left !== null && right !== undefined && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined)
  if (before === undefined || typeof before.provider !== 'string' || typeof before.model !== 'string') return false
  if (applied === undefined || same(before, applied)) return false
  let now
  try {
    now = typeof readDefault === 'function' ? readDefault() : undefined
  }
  catch {
    now = undefined
  }
  if (!same(now, applied)) return false
  try {
    await controller.selectModel({
      provider: before.provider,
      model: before.model,
      ...(before.reasoningEffort === undefined ? {} : { reasoningEffort: before.reasoningEffort }),
      sessionId,
    })
    return true
  }
  catch (error) {
    if (typeof onWarn === 'function') onWarn('amplify: default model restore failed', error)
    return false
  }
}

/**
 * Create a runner bound to one host context.
 * @param options - `{ getController, getSession, getWorkspacePath, getDefaultSelection, files, warn }`,
 *   where `files` supplies `{ write(chunks), read(dir), cleanup(dir) }` over the workspace and
 *   `getSession(id)` returns a live Session so the run can audit its own coverage.
 * @returns `{ start, status, cancel, isActive, dispose }` over a single run slot.
 */
export function createAmplifyRunner(options) {
  const { getController, getSession, getWorkspacePath, getDefaultSelection, files, warn } = options
  let job

  /** Whether a run currently holds the slot. */
  function isActive() {
    if (job === undefined) return false
    return !['done', 'failed', 'cancelled', 'abandoned'].includes(job.state)
  }

  /** Current run snapshot for the browser. */
  function status() {
    if (job === undefined) return { state: 'idle' }
    return {
      state: job.state,
      sessionId: job.sessionId,
      summary: job.summary,
      error: job.error,
      elapsedMs: Date.now() - job.startedAt,
      tokens: measuredTokens(job),
      expectedTokens: job.tokensExpected || 0,
      chunkCount: job.chunks.length,
      stallReason: job.stallReason,
      // Present only when the run finished with an incomplete read of its own chunks.
      coverage: job.coverage === undefined
        ? undefined
        : { ratio: job.coverage.ratio, parts: job.coverage.parts },
      diagnostics: job.diagnostics.slice(-20),
    }
  }

  /**
   * The running bill for the browser panel: summed step usage from the session's own
   * events. Falls back to the per-step maximum when the session cannot be read. Cached by
   * the last event sequence, because `status()` is polled and `snapshotEvents()` copies.
   */
  function measuredTokens(current) {
    if (typeof getSession !== 'function' || typeof current.sessionId !== 'string') return current.tokens || 0
    try {
      const session = getSession(current.sessionId)
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
      if (!Array.isArray(events) || events.length === 0) return current.tokens || 0
      const seq = events[events.length - 1]?.seq
      if (current.tokenCache !== undefined && current.tokenCache.seq === seq) return current.tokenCache.total
      const total = totalUsageOf(events)
      current.tokenCache = { seq, total }
      return total > 0 ? total : (current.tokens || 0)
    }
    catch {
      return current.tokens || 0
    }
  }

  /** Stop the run and interrupt the summary session. */
  function cancel() {
    if (job === undefined) return { state: 'idle' }
    job.cancelled = true
    job.state = 'cancelled'
    const controller = getController()
    if (controller !== undefined && typeof job.sessionId === 'string') {
      try {
        controller.cancel({ sessionId: job.sessionId })
      }
      catch (error) {
        warn('amplify cancel failed', error)
      }
    }
    markCancelled(job)
    // Release a run parked in `pause()`: otherwise its promise never settles and the
    // cancelled job keeps its await alive.
    if (typeof job.resume === 'function') {
      try {
        job.resume('cancel')
      }
      catch (error) {
        warn('amplify resume on cancel failed', error)
      }
    }
    if (job.sliceAbort !== undefined) {
      try {
        job.sliceAbort.abort()
      }
      catch {
        /* an already aborted slice is fine */
      }
    }
    cleanup(job)
    return { state: 'cancelled' }
  }

  /** Answer a parked run. */
  function decide(decision) {
    if (job === undefined) return { state: 'idle' }
    const resume = job.resume
    if (typeof resume !== 'function') return { state: job.state }
    if (decision !== 'continue' && decision !== 'cancel' && decision !== 'without') return { state: job.state }
    if (decision !== 'continue') {
      const controller = getController()
      if (controller !== undefined && typeof job.sessionId === 'string') {
        try {
          controller.cancel({ sessionId: job.sessionId })
        }
        catch (error) {
          warn('amplify decide cancel failed', error)
        }
      }
      markCancelled(job)
    }
    resume(decision)
    return { state: job.state }
  }

  /** Forget the run. */
  function dispose() {
    cleanup(job)
    job = undefined
  }

  /** Remove the chunk directory, best effort. */
  function cleanup(current) {
    if (current === undefined || current.dir === undefined) return
    try {
      files.cleanup(current.dir)
    }
    catch (error) {
      warn('amplify cleanup failed', error)
    }
  }

  /**
   * Rename a cancelled run's summary session so it is not mistaken for a finished one.
   * Best effort: a rename that fails must never block cancellation.
   */
  function markCancelled(current) {
    if (current === undefined || typeof current.sessionId !== 'string') return
    const controller = getController()
    if (controller === undefined || typeof controller.rename !== 'function') return
    try {
      void Promise.resolve(controller.rename({
        sessionId: current.sessionId,
        title: cancelledAmplifyTitle(current.removedTurns, current.locale),
      })).catch((error) => { warn('amplify mark cancelled failed', error) })
    }
    catch (error) {
      warn('amplify mark cancelled failed', error)
    }
  }

  /**
   * Start a run. Returns immediately; the browser polls `status()`.
   * @param config - `{ workspaceId, locale, model, removedTurns, chunks }`.
   * @returns `{ chunks, tokens }`.
   */
  function start(config) {
    if (isActive()) throw new Error('amplify-busy')
    const controller = getController()
    if (controller === undefined) throw new Error('amplify-unavailable')
    const workspacePath = getWorkspacePath(config.workspaceId)
    if (workspacePath === undefined) throw new Error('amplify-no-workspace')
    const locale = config.locale === 'en' ? 'en' : 'zh'
    const chunks = config.chunks
    let written
    try {
      written = files.write(workspacePath, chunks)
    }
    catch (error) {
      warn('amplify write chunks failed', error)
      throw new Error('amplify-write-failed')
    }
    job = {
      state: 'creating',
      startedAt: Date.now(),
      locale,
      model: config.model,
      workspaceId: config.workspaceId,
      workspacePath,
      title: config.title,
      dropped: Array.isArray(config.dropped) ? config.dropped : [],
      removedTurns: config.removedTurns,
      chunks,
      dir: written.dirAbsolute,
      dirRelative: written.dirRelative,
      sessionId: undefined,
      summary: undefined,
      error: undefined,
      diagnostics: [],
      cancelled: false,
      tokens: 0,
      tokensExpected: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
      coverage: undefined,
      tokenCache: undefined,
      resume: undefined,
    }
    void run(controller, job)
      .catch((error) => {
        job.state = 'failed'
        job.error = String(error?.message ?? error)
        warn('amplify run failed', error)
      })
      // Every terminal path ends here, quiet failures included: the chunk files hold the
      // dropped turns verbatim, so a run may never leave them behind.
      .finally(() => { cleanup(job) })
    return { chunks: chunks.length, tokens: job.tokensExpected }
  }

  /** Record one line in the run log; the file survives cleanup so a stuck run can be read. */
  function trace(current, message) {
    current.diagnostics.push({ step: message })
    if (typeof files.trace === 'function') {
      try {
        files.trace(current.workspacePath, `${new Date().toISOString()} ${message}`)
      }
      catch {
        /* diagnostics are best effort */
      }
    }
  }

  /** Drive the run, then always put the deployment default back. */
  async function run(controller, current) {
    let before
    try {
      before = typeof getDefaultSelection === 'function' ? getDefaultSelection() : undefined
    }
    catch {
      before = undefined
    }
    let applied
    try {
      applied = await runSummary(controller, current)
    }
    finally {
      const restored = await restoreDefaultSelection({
        controller,
        sessionId: current.sessionId,
        before,
        applied,
        readDefault: getDefaultSelection,
        warn,
      })
      if (restored) trace(current, 'default model restored')
    }
  }

  /**
   * Drive the run: one prompt, one wait, then prefer the chat answer over any file.
   * @returns the model selection this run installed, or undefined when it installed none.
   */
  async function runSummary(controller, current) {
    trace(current, `start chunks=${current.chunks.length} removedTurns=${current.removedTurns}`)
    const created = await controller.create({ workspaceId: current.workspaceId })
    current.sessionId = created.sessionId
    trace(current, `created session=${created.sessionId}`)
    await controller.rename({ sessionId: current.sessionId, title: amplifyTitle(current.removedTurns, current.locale) })
    const requested = current.model !== null && typeof current.model === 'object' && typeof current.model.model === 'string'
      ? current.model
      : DEFAULT_MODEL
    // Never let the effort go missing: `selectModel` also saves the deployment default, so a
    // selection without one would leave every new conversation following the provider default.
    const wanted = {
      provider: requested.provider,
      model: requested.model,
      reasoningEffort: typeof requested.reasoningEffort === 'string' && requested.reasoningEffort !== ''
        ? requested.reasoningEffort
        : DEFAULT_MODEL.reasoningEffort,
    }
    let applied
    try {
      await controller.selectModel({ ...wanted, sessionId: current.sessionId })
      applied = wanted
      current.diagnostics.push({ step: 'selectModel', applied: `${wanted.provider}/${wanted.model}/${wanted.reasoningEffort}` })
    }
    catch (error) {
      current.diagnostics.push({ step: 'selectModel', error: String(error?.message ?? error) })
    }
    if (current.cancelled) return applied
    current.state = 'summarizing'
    /** Send one prompt and wait for the session to settle; returns its last text. */
    const askRound = async (text) => {
      const afterSeq = await readCursor(controller, current.sessionId)
      trace(current, `cursor afterSeq=${String(afterSeq)}`)
      await controller.prompt({
        requestId: requestIdOf(current.sessionId),
        sessionId: current.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, new AbortController().signal)
      trace(current, 'prompt accepted, waiting')
      const result = await waitForAgent(controller, current, afterSeq)
      trace(current, `wait finished outcome=${result === undefined ? 'none' : `${result.length} chars`}`)
      return result
    }
    const prompt = summaryPrompt(current.dirRelative, current.chunks.length, current.locale)
    trace(current, `prompt chars=${prompt.length} chunks=${current.chunks.length}`)
    let outcome = await askRound(prompt)
    if (outcome === undefined) {
      if (!current.cancelled) current.error = 'the summary session produced no result'
      return applied
    }
    /** The note a finished round left behind, from its file or its last message. */
    const summaryOfRound = (text) => {
      const fromFile = files.read(current.dir)
      if (typeof fromFile === 'string' && fromFile.trim() !== '') {
        current.diagnostics.push({ step: 'summary', source: 'file' })
        return fromFile.trim()
      }
      if (typeof text === 'string' && text.trim() !== '') {
        // The agent answered in the chat instead of writing the file.
        current.diagnostics.push({ step: 'summary', source: 'chat' })
        return text.trim()
      }
      return undefined
    }
    let summary = summaryOfRound(outcome)
    if (summary === undefined || !looksLikeSummary(summary)) {
      trace(current, `summary rejected chars=${summary === undefined ? 'none' : summary.length}`)
      if (current.cancelled) return applied
      // One nudge, because this failure is "described the plan and stopped", not "cannot do it".
      outcome = await askRound(summaryNudge(current.locale))
      if (outcome === undefined) {
        if (!current.cancelled) current.error = 'the summary session produced no result after a retry'
        return applied
      }
      summary = summaryOfRound(outcome)
      trace(current, `retry summary chars=${summary === undefined ? 'none' : summary.length}`)
    }
    current.summary = summary
    if (current.summary === undefined || !looksLikeSummary(current.summary)) {
      current.state = 'failed'
      current.error = 'the summary session returned a status line instead of a memory note'
      cleanup(current)
      return applied
    }
    // Measure what the session actually read before it called itself done. This has to
    // happen before cleanup: the events live on the session, not on the scratch files.
    const coverage = measureCoverage(current)
    // Archive the dropped turns beside the summary so the revived session can look up the
    // original wording later. Local file writes only: this adds no model tokens.
    let archived
    if (typeof files.writeHistory === 'function') {
      try {
        archived = files.writeHistory(current.workspacePath, {
          title: current.title ?? '',
          turns: current.dropped,
          locale: current.locale,
        })
        if (archived !== undefined && typeof archived.indexRelative === 'string') {
          // Facts only. Anything phrased as an instruction here ends up in the visible
          // conversation history, where the user reads it as an injected system note; the
          // instructions live in the hidden system-prompt section instead.
          const where = typeof archived.dirRelative === 'string' ? archived.dirRelative : archived.indexRelative
          current.summary = [
            current.summary,
            '',
            '---',
            `完整原文存档：${where}/（共 ${archived.pages} 片，索引见 索引.md）`,
          ].join('\n')
          current.diagnostics.push({ step: 'archive', pages: archived.pages })
          trace(current, `history archived pages=${archived.pages}`)
        }
      }
      catch (error) {
        // An archive failure must not discard a summary that already cost money.
        warn('amplify archive failed', error)
        current.diagnostics.push({ step: 'archive', error: String(error?.message ?? error) })
      }
    }
    // After the archive pointer, so the note is the last thing the reader sees.
    if (coverage !== undefined && coverage.ratio < COVERAGE_ENOUGH) {
      current.summary = `${current.summary}\n\n${coverageNote(coverage, current.locale)}`
      current.coverage = coverage
      trace(current, `partial coverage ${Math.floor(coverage.ratio * 100)}%`)
    }
    current.state = 'done'
    cleanup(current)
    return applied
  }

  /**
   * Read the summary session's event log and measure coverage. Best effort: a missing
   * session or an older log shape must not fail a run that already has its summary.
   */
  function measureCoverage(current) {
    if (typeof getSession !== 'function') return undefined
    try {
      const session = getSession(current.sessionId)
      if (session === undefined || session === null) return undefined
      const coverage = readCoverageOf(session)
      if (coverage === undefined) {
        trace(current, 'coverage unmeasurable')
        return undefined
      }
      trace(current, `coverage ${Math.floor(coverage.ratio * 100)}% parts=${coverage.parts.length}`)
      return coverage
    }
    catch (error) {
      warn('amplify coverage failed', error)
      return undefined
    }
  }

  /** Wait until the agent goes idle; returns its last assistant text. */
  async function waitForAgent(controller, current, afterSeq) {
    const hardDeadline = current.startedAt + RUN_TIMEOUT_MS
    let softDeadline = current.startedAt + STALL_AFTER_MS
    for (;;) {
      if (current.cancelled) return undefined
      if (Date.now() >= hardDeadline) {
        current.state = 'failed'
        current.error = 'the summary session did not settle within 10 minutes'
        return undefined
      }
      if (Date.now() >= softDeadline) {
        // No text after the soft deadline: ask the user instead of spinning.
        const decision = await pause(current, 'timeout')
        if (decision === 'continue') {
          softDeadline = Date.now() + STALL_AFTER_MS
          continue
        }
        return undefined
      }
      let value
      try {
        // Always ask for a generous window of the newest messages. Only one prompt ever
        // enters this session, so its newest assistant text is the summary — filtering by
        // a cursor only risks missing it, which is exactly what went wrong before.
        // The slice is raced against a deadline: the run ceiling is only checked between
        // awaits, so a `wait` that never settles would otherwise hang the run.
        const slice = new AbortController()
        current.sliceAbort = slice
        value = await raceTimeout(
          controller.wait({ sessionId: current.sessionId, maxMessages: 50 }, slice.signal),
          WAIT_SLICE_MS,
        )
        if (value === SLICE_TIMEOUT) {
          try {
            slice.abort()
          }
          catch {
            /* an aborted slice is fine */
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
      }
      catch (error) {
        if (current.diagnostics.length < 40) current.diagnostics.push({ step: 'wait', error: String(error?.message ?? error) })
        await new Promise((resolve) => setTimeout(resolve, 1500))
        continue
      }
      current.tokens = Math.max(current.tokens, scanUsage(value))
      const reason = value === null || typeof value !== 'object' ? 'none' : value.reason
      trace(current, `wait reason=${reason} records=${value && value.output && Array.isArray(value.output.records) ? value.output.records.length : 0}`)
      if (value === null || typeof value !== 'object') continue
      // Accept text on any reason: the record shape and the stopping reason have both
      // surprised us once, and a summary that arrived should not be discarded.
      const text = assistantTextFrom(value.output)
      if (typeof text === 'string' && text !== '') {
        current.sawText = true
        return text
      }
      current.sawText = true
      // Same record count, idle, over and over: stop and leave the shape in the log so the
      // next run explains itself instead of spinning.
      current.idleSlices = (current.idleSlices || 0) + 1
      if (current.idleSlices === 3) trace(current, `no text; record sample=${recordsSample(value.output)}`)
      if (current.idleSlices > 20) {
        current.state = 'failed'
        current.error = 'the summary session went idle but its records carried no assistant text'
        return undefined
      }
      if (value.reason === 'input-required') {
        const decision = await pause(current, 'input-required')
        if (decision === 'continue') continue
        return undefined
      }
      // 'timeout' just means this slice ended; keep waiting. Pause briefly so a `wait`
      // that returns instantly cannot spin the loop.
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /** Park the run until the browser answers, or give up on its own after STALLED_MAX_MS. */
  function pause(current, reason) {
    current.state = 'stalled'
    current.stallReason = reason
    current.diagnostics.push({ step: 'stalled', reason, elapsedMs: Date.now() - current.startedAt, tokens: current.tokens || 0 })
    return new Promise((resolve) => {
      // A wizard that was closed (or a browser that went away) must not park the run
      // forever: nothing else would ever free the single slot.
      const timer = setTimeout(() => {
        current.resume = undefined
        current.state = 'abandoned'
        current.cancelled = true
        trace(current, 'stalled run abandoned after no answer')
        markCancelled(current)
        cleanup(current)
        resolve('timeout')
      }, STALLED_MAX_MS)
      if (typeof timer.unref === 'function') timer.unref()
      current.resume = (decision) => {
        clearTimeout(timer)
        current.resume = undefined
        if (decision === 'continue') {
          current.state = 'summarizing'
          resolve('continue')
          return
        }
        current.state = decision === 'cancel' ? 'cancelled' : 'abandoned'
        current.cancelled = true
        cleanup(current)
        resolve(decision)
      }
    })
  }

  return { start, status, cancel, decide, isActive, dispose }
}

/**
 * Resolve with `promise`, or with `SLICE_TIMEOUT` once `ms` elapses.
 * @param promise - the work to bound.
 * @param ms - how long to wait.
 * @returns the value, or the sentinel.
 */
function raceTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(SLICE_TIMEOUT), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer) })
}

/** Read the durable cursor a `wait` should start after. */
async function readCursor(controller, sessionId) {
  try {
    const state = await controller.state({ sessionId }, new AbortController().signal)
    if (state !== null && typeof state === 'object' && typeof state.cursor === 'number') return state.cursor
  }
  catch {
    /* falling back to "all records" is acceptable for the first prompt */
  }
  return undefined
}
