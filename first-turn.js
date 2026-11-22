/**
 * First-turn guard for freshly imported conversations.
 *
 * The shipped importer writes a bare session header, so an imported session holds no model
 * selection. Measured: the agent built for such a session can arrive with options that carry
 * `provider` and `model` but no `reasoningEffort` at all, so the first request leaves the
 * field out and the provider fills its own default — `high` for DeepSeek. Every later turn is
 * fine because the first request records a selection.
 *
 * The guard closes that gap once, before the first turn: if the agent of an imported session
 * has no explicit thinking level, it records one for that session only. It never writes the
 * deployment default and never touches a session the user already chose for.
 *
 * It cannot run later than this: `preStep` captures the selection before assembling the
 * prompt, and the loop asserts the request matches that captured selection, so changing it
 * mid-turn would be an error rather than a fix.
 * @module dsh-revive-love/first-turn
 */

import { revivedArchiveOf } from './force-recall.js'

/** Provider stamp the shipped importer writes on every imported assistant message. */
export const EXPORT_PROVIDER = 'deepseek-chat-export'

/** Thinking level used when the deployment default names none. */
export const FALLBACK_EFFORT = 'off'

/**
 * Whether a session carries imported messages.
 * @param session - a Session instance.
 * @returns true when the shipped importer wrote part of this session.
 */
export function looksImported(session) {
  let events
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  }
  catch {
    return false
  }
  if (!Array.isArray(events)) return false
  for (const event of events) {
    const source = event?.data?.message?.source ?? event?.data?.source
    if (source === null || typeof source !== 'object') continue
    if (source.provider === EXPORT_PROVIDER || source.model === EXPORT_PROVIDER) return true
  }
  return false
}

/**
 * The selection to record, or undefined when nothing should change.
 * @param options - `{ current, imported, effort }`.
 * @returns `{ provider, model, reasoningEffort }`, or undefined.
 */
export function guardSelection(options) {
  const { current, imported, effort } = options
  if (imported !== true) return undefined
  if (current === null || typeof current !== 'object') return undefined
  const provider = typeof current.provider === 'string' ? current.provider : ''
  const model = typeof current.model === 'string' ? current.model : ''
  if (provider === '' || model === '') return undefined
  // An explicit level already means somebody decided; leave it alone.
  if (typeof current.reasoningEffort === 'string' && current.reasoningEffort !== '') return undefined
  const reasoningEffort = typeof effort === 'string' && effort !== '' ? effort : FALLBACK_EFFORT
  return { provider, model, reasoningEffort }
}

/**
 * Record a thinking level for imported sessions that have none.
 * @param ctx - the plugin context.
 * @param options - `{ headers, getDefaultSelection, warn }`.
 */
export function installFirstTurnGuard(ctx, options) {
  const { headers, getDefaultSelection, warn } = options
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      const session = agent?.session
      if (session === undefined || session === null) return
      const current = typeof agent.model?.current === 'function' ? agent.model.current() : undefined
      // Cheap pre-check first: the entry scan below reads the whole event list.
      if (current !== null && typeof current === 'object'
        && typeof current.reasoningEffort === 'string' && current.reasoningEffort !== '') return
      const imported = looksImported(session) || revivedArchiveOf(session, headers) !== undefined
      let effort
      try {
        effort = typeof getDefaultSelection === 'function' ? getDefaultSelection()?.reasoningEffort : undefined
      }
      catch {
        effort = undefined
      }
      const selection = guardSelection({ current, imported, effort })
      if (selection === undefined) return
      if (typeof agent.model?.select !== 'function') {
        warn('first turn: agent has no model.select')
        return
      }
      agent.model.select(selection)
    }
    catch (error) {
      warn('first turn: guard failed', error)
    }
  })
}
