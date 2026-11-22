/**
 * Diagnostic trace for the thinking level a revived session will actually request.
 *
 * Written because one revived conversation went out with no `reasoningEffort` at all, so the
 * DeepSeek adapter fell back to its own default (`high`). Everything downstream of that is
 * visible in the session log; what is *not* visible is the selection the agent held at the
 * moment the turn was prepared, so this records exactly that: the agent's current selection,
 * plus the deployment default it would fall back to, one line per prepared turn.
 *
 * It is a recorder, not a repair: nothing here changes a selection. Lines land in
 * `<workspace>/.dsh-revive/model-trace.log` and the file is reset past a small cap.
 */
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { revivedArchiveOf } from './force-recall.js'

/** Where the trace lives, relative to the workspace. */
export const TRACE_DIR = '.dsh-revive'
export const TRACE_FILE = 'model-trace.log'
/** Largest trace kept; past this the file starts over. */
export const TRACE_MAX_BYTES = 64 * 1024

/**
 * Render one selection as `provider/model/effort`.
 * @param selection - a model selection, or undefined.
 * @returns the text, or `(none)` when the selection or its effort is missing.
 */
export function selectionText(selection) {
  if (selection === null || typeof selection !== 'object') return '(none)'
  const provider = typeof selection.provider === 'string' ? selection.provider : '?'
  const model = typeof selection.model === 'string' ? selection.model : '?'
  const effort = typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
    ? selection.reasoningEffort
    : '(none)'
  return `${provider}/${model}/${effort}`
}

/**
 * Append one line to the workspace trace, starting over when it grows past the cap.
 * @param workspacePath - absolute workspace path.
 * @param line - the text to append.
 * @returns when the line was written.
 */
export function appendTrace(workspacePath, line) {
  const dir = join(workspacePath, TRACE_DIR)
  const file = join(dir, TRACE_FILE)
  mkdirSync(dir, { recursive: true })
  let reset = false
  try {
    reset = existsSync(file) && statSync(file).size > TRACE_MAX_BYTES
  }
  catch {
    reset = false
  }
  if (reset) writeFileSync(file, '', 'utf8')
  appendFileSync(file, line + '\n', 'utf8')
}

/**
 * One line describing a prepared turn.
 * @param options - `{ sessionId, current, options, recorded, fallback, revived }`.
 * @returns the text, without a trailing newline.
 */
export function traceLine(options) {
  const { sessionId, current, options: agentOptions, recorded, fallback, revived } = options
  // A live getter would read the same service this plugin sees; a plain value means the
  // options were snapshotted somewhere upstream, which is a different bug. Knowing which
  // one it is decides whether the effort was ever available to the agent.
  let kind = 'missing'
  if (agentOptions !== null && typeof agentOptions === 'object') {
    const descriptor = Object.getOwnPropertyDescriptor(agentOptions, 'reasoningEffort')
    kind = descriptor === undefined ? 'absent' : typeof descriptor.get === 'function' ? 'getter' : 'value'
  }
  return [
    new Date().toISOString(),
    `session=${typeof sessionId === 'string' ? sessionId : '?'}`,
    `revived=${revived === true ? 'true' : 'false'}`,
    `current=${selectionText(current)}`,
    `options=${selectionText(agentOptions)}`,
    `optKind=${kind}`,
    `recorded=${selectionText(recorded)}`,
    `default=${selectionText(fallback)}`,
  ].join(' ')
}

/**
 * Record the selection of every prepared turn of a revived session.
 * @param ctx - the plugin context.
 * @param options - `{ getWorkspacePath, headers, warn }`.
 */
export function installModelTrace(ctx, options) {
  const { getWorkspacePath, headers, warn } = options
  /** Whether a session is a revived one, decided once per session: the entry scan is not cheap. */
  const revived = new WeakMap()
  /** Captured once: `ctx.get()` is not available inside the hook later. */
  let defaults
  try {
    ctx.inject(['agentDefaultModel'], (sub) => {
      defaults = sub.get('agentDefaultModel')
    })
  }
  catch {
    /* a deployment without the service simply records `default=(none)` */
  }

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    try {
      const agent = context?.agent
      const session = agent?.session
      if (session !== undefined && session !== null) {
        const workspacePath = typeof getWorkspacePath === 'function' ? getWorkspacePath(session) : undefined
        if (typeof workspacePath === 'string' && workspacePath !== '') {
          let known = revived.get(session)
          if (known === undefined) {
            known = revivedArchiveOf(session, headers) !== undefined
            revived.set(session, known)
          }
          if (known) {
            const current = typeof agent.model?.current === 'function' ? agent.model.current() : undefined
            // The two ingredients of `current()`: the live options object and whatever the
            // session already recorded. Which one lost the effort decides where the bug lives.
            const agentOptions = agent.options
            let recorded
            try {
              recorded = typeof agent.model?.recordedSelection === 'function' ? agent.model.recordedSelection() : undefined
            }
            catch {
              recorded = undefined
            }
            let fallback
            try {
              fallback = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined
            }
            catch {
              fallback = undefined
            }
            appendTrace(workspacePath, traceLine({ sessionId: session.id, current, options: agentOptions, recorded, fallback, revived: true }))
          }
        }
      }
    }
    catch (error) {
      warn('model trace: write failed', error)
    }
    return await next()
  })
}
