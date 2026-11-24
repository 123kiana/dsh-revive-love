/**
 * Archive what a context compaction removes.
 *
 * DSH records `compaction/summary` with `shadowedSeqs` — exactly the events that just left the
 * model's window — and `Session.eventAt(seq)` can still read them. So when the user compacts a
 * revived conversation, the turns that were dropped can be appended to the same archive the
 * amplify run created, in the same `### 第 N 轮` format, and `history_search` keeps finding them.
 *
 * Only **amplified** conversations have that archive, which is what limits this feature to them.
 * The summary message itself is never archived: it is part of the archive's own preamble, not a
 * conversation turn.
 *
 * Everything here is best-effort and runs off the compaction path: a failure logs a warning and
 * leaves the compaction untouched.
 * @module dsh-revive-love/compaction-archive
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCompactionArchive, revivedArchiveOf } from './force-recall.js'

/** Same page budget the amplify archive uses. */
const PAGE_CHARS = 8000

/** Archive page file name. */
const PART_FILE = /^part-(\d+)\.md$/

/** Turn heading inside a page. */
const TURN_HEADING = /^### (?:第 (\d+) 轮|Turn (\d+))\s*$/gmu

/** Manifest recording what has already been appended, so a re-compaction cannot duplicate. */
const MANIFEST = 'compactions.json'

/** The archive's own index. */
const INDEX = '索引.md'

/** Source kinds that are harness injections, never conversation. */
const INJECTED_KINDS = new Set([
  'runtime-context',
  'skill-catalog',
  'time-context',
  'revive-love:recall-hint',
  'compact-checkpoint',
])

/** Page preamble, matching the amplify writer. */
const PREAMBLE = {
  zh: '> 这是你和这个人过去的对话原话，是你自己的记忆，不是外部资料库。\n> 回忆它，别当成查别人的档案。\n\n',
  en: '> These are the words of your own earlier conversation with this person.\n> Recall them; do not look them up like an external archive.\n\n',
}

/** Text of one message's text blocks. */
function textOf(value) {
  const parts = Array.isArray(value?.content) ? value.content : []
  return parts.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('')
}

/** Page numbers present in one archive directory, ascending. */
function pageNumbers(dirAbsolute) {
  try {
    return readdirSync(dirAbsolute)
      .map(name => PART_FILE.exec(name))
      .filter(match => match !== null)
      .map(match => Number(match[1]))
      .sort((left, right) => left - right)
  }
  catch {
    return []
  }
}

/**
 * Read what the archive already contains: highest turn number, next free page, page language.
 * @param dirAbsolute - the `history-<id>` directory.
 * @returns `{ lastTurn, nextPage, locale }`.
 */
export function inspectArchive(dirAbsolute) {
  const numbers = pageNumbers(dirAbsolute)
  let lastTurn = 0
  let locale = 'zh'
  for (const number of numbers) {
    let text
    try {
      text = readFileSync(join(dirAbsolute, `part-${String(number).padStart(2, '0')}.md`), 'utf8')
    }
    catch {
      continue
    }
    for (const match of text.matchAll(TURN_HEADING)) {
      const turn = Number(match[1] ?? match[2])
      if (Number.isFinite(turn) && turn > lastTurn) lastTurn = turn
    }
    if (/^### Turn \d+/mu.test(text)) locale = 'en'
  }
  return { lastTurn, nextPage: numbers.length === 0 ? 1 : numbers[numbers.length - 1] + 1, locale }
}

/**
 * The nearest real user message before one event.
 *
 * A compaction range can start at the assistant reply of a turn, leaving that turn's user
 * message outside `shadowedSeqs` (measured: turn 539's user message sat at seq 3520 while only
 * the reply at 3523 was shadowed). Walking back fills that one gap. The walk stops at another
 * assistant message, a compaction summary, or a checkpoint, so it can only ever find the user
 * message of the same turn — never an older one. The summary itself is skipped: it is archived
 * nowhere by design.
 * @param session - the live Session.
 * @param seq - the assistant message's seq.
 * @param summaryHeaders - the amplify summary notice headers.
 * @returns the text, or `''` when no same-turn user message precedes it.
 */
function userBefore(session, seq, summaryHeaders) {
  if (typeof session?.eventAt !== 'function') return ''
  for (let previous = seq - 1; previous >= Math.max(0, seq - 200); previous -= 1) {
    let event
    try {
      event = session.eventAt(previous)
    }
    catch {
      return ''
    }
    if (event === undefined || event === null) continue
    if (event.type === 'assistant/message' || event.type === 'compaction/summary') return ''
    if (event.type !== 'user/message') continue
    const kind = event?.data?.source?.kind
    if (kind === 'compact-checkpoint') return ''
    if (kind !== undefined && kind !== 'user') continue
    const text = textOf(event.data).trim()
    if (text === '') continue
    if (summaryHeaders.some(header => text.startsWith(header))) return ''
    return text
  }
  return ''
}

/**
 * Rebuild the turns a compaction removed from the events it shadowed.
 *
 * Injected messages (runtime context, skill catalogue, clock, the plugin's own reminders, the
 * compaction checkpoint) are skipped, and so is the amplify summary itself.
 * @param session - the live Session.
 * @param seqs - `shadowedSeqs` from `compaction/summary`.
 * @param summaryHeaders - the amplify summary notice headers.
 * @returns `[{ turn, userText, replyText }]`, oldest first.
 */
export function turnsFromShadowed(session, seqs, summaryHeaders) {
  const byTurn = new Map()
  const ensure = (turn) => {
    if (!byTurn.has(turn)) byTurn.set(turn, { turn, userText: '', replyText: '' })
    return byTurn.get(turn)
  }
  // Imported user messages carry no `turn` of their own (measured: `data.turn` is undefined for
  // every one of them, while assistant messages do carry it). So a user message is held until the
  // next assistant message names the turn it belongs to; live messages that do carry a turn take
  // the direct path instead.
  let pendingUser = ''
  let currentTurn
  const ordered = Array.isArray(seqs) ? [...seqs].sort((left, right) => left - right) : []
  for (const seq of ordered) {
    let event
    try {
      event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined
    }
    catch {
      event = undefined
    }
    if (event === undefined || event === null) continue
    const ownTurn = typeof event?.data?.turn === 'number' ? event.data.turn : undefined
    if (event.type === 'user/message') {
      const kind = event?.data?.source?.kind
      if (kind !== undefined && kind !== 'user') continue
      if (INJECTED_KINDS.has(kind)) continue
      const text = textOf(event.data).trim()
      if (text === '') continue
      if (summaryHeaders.some(header => text.startsWith(header))) continue
      if (ownTurn !== undefined) {
        const row = ensure(ownTurn)
        if (row.userText === '') row.userText = text
        pendingUser = ''
        continue
      }
      pendingUser = pendingUser === '' ? text : `${pendingUser}\n\n${text}`
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event?.data?.message ?? event.data).trim()
      if (text === '') continue
      const turn = ownTurn ?? currentTurn
      if (turn === undefined) continue
      const row = ensure(turn)
      if (row.userText === '' && pendingUser !== '') row.userText = pendingUser
      pendingUser = ''
      if (row.userText === '') {
        const before = userBefore(session, seq, summaryHeaders)
        if (before !== '') row.userText = before
      }
      row.replyText = row.replyText === '' ? text : `${row.replyText}\n\n${text}`
      currentTurn = turn
    }
  }
  return [...byTurn.values()]
    .filter(row => row.userText !== '' || row.replyText !== '')
    .sort((left, right) => left.turn - right.turn)
}

/** Render one turn the way the amplify archive does. */
export function renderTurn(index, turn, locale) {
  const userLabel = locale === 'en' ? 'User' : '用户'
  const replyLabel = locale === 'en' ? 'Assistant' : '助手'
  const heading = locale === 'en' ? `### Turn ${index}` : `### 第 ${index} 轮`
  const parts = [heading]
  if (turn.userText !== '') parts.push(`**${userLabel}**：${turn.userText}`)
  if (turn.replyText !== '') parts.push(`**${replyLabel}**：${turn.replyText}`)
  return parts.join('\n\n')
}

/**
 * Append turns to the archive: paginate at the existing budget, continue page numbers, keep the
 * same heading format, and add index rows under a section of their own.
 * @param dirAbsolute - the `history-<id>` directory.
 * @param turns - `[{ userText, replyText }]`, oldest first.
 * @param options - `{ lastTurn, nextPage, locale }` from {@link inspectArchive}.
 * @returns `{ pages, lastTurn }`.
 */
export function appendTurns(dirAbsolute, turns, options) {
  const { locale } = options
  const pages = []
  let current = []
  let chars = 0
  let turnNumber = options.lastTurn
  for (const turn of turns) {
    turnNumber += 1
    const block = renderTurn(turnNumber, turn, locale)
    if (current.length > 0 && chars + block.length > PAGE_CHARS) {
      pages.push(current)
      current = []
      chars = 0
    }
    current.push({ turn: turnNumber, block })
    chars += block.length
  }
  if (current.length > 0) pages.push(current)

  const indexLines = []
  pages.forEach((page, offset) => {
    const number = options.nextPage + offset
    const fileName = `part-${String(number).padStart(2, '0')}.md`
    const body = `${PREAMBLE[locale] ?? PREAMBLE.zh}${page.map(item => item.block).join('\n\n')}\n`
    writeFileSync(join(dirAbsolute, fileName), body, 'utf8')
    indexLines.push(`- ${fileName}  轮次 ${page[0].turn}–${page[page.length - 1].turn}`)
  })
  appendIndex(dirAbsolute, indexLines, locale)
  return { pages: pages.length, lastTurn: turnNumber }
}

/** Add rows for the appended pages to the archive index, under one section heading. */
export function appendIndex(dirAbsolute, lines, locale) {
  if (lines.length === 0) return
  const file = join(dirAbsolute, INDEX)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  }
  catch {
    return
  }
  const heading = locale === 'en' ? '## Archived when compacting context' : '## 上下文压缩时追加归档'
  const section = text.includes(heading) ? '' : `\n${heading}\n`
  const addition = `${section}${lines.map(line => `${line}\n`).join('')}`
  try {
    writeFileSync(file, `${text.replace(/\n*$/u, '\n')}${addition}`, 'utf8')
  }
  catch {
    /* the archive itself is still written; the index is only an overview */
  }
}

/** Read the manifest; a missing or broken file reads as empty. */
export function readManifest(dirAbsolute) {
  try {
    const parsed = JSON.parse(readFileSync(join(dirAbsolute, MANIFEST), 'utf8'))
    return {
      compactions: Array.isArray(parsed?.compactions) ? parsed.compactions.filter(value => typeof value === 'string') : [],
      sessionTurns: Array.isArray(parsed?.sessionTurns) ? parsed.sessionTurns.filter(value => typeof value === 'number') : [],
    }
  }
  catch {
    return { compactions: [], sessionTurns: [] }
  }
}

/** Persist the manifest after an append. */
export function writeManifest(dirAbsolute, manifest) {
  try {
    writeFileSync(join(dirAbsolute, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  catch {
    /* best effort */
  }
}

/**
 * Install the compaction archive.
 * @param ctx - the plugin context.
 * @param options - `{ getWorkspacePath, headers, warn }`.
 */
export function installCompactionArchive(ctx, options) {
  const { getWorkspacePath, headers, warn } = options
  /** Session id → workspace-relative archive directory, resolved once per session. */
  const archives = new Map()
  /** Sessions currently being written, so two compactions cannot interleave. */
  const busy = new Set()

  ctx.on('agent/created', (event) => {
    const agent = event?.agent
    const session = agent?.session
    if (session === undefined || session === null || typeof session.id !== 'string') return
    try {
      const dir = revivedArchiveOf(session, headers)
      if (dir !== undefined) archives.set(session.id, dir)
    }
    catch (error) {
      warn('compaction archive: lookup failed', error)
    }
  }, 'revive-love: compaction archive')

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'compaction/summary') return
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (busy.has(sessionId)) return
      const workspacePath = typeof getWorkspacePath === 'function' ? getWorkspacePath(session) : undefined
      if (typeof workspacePath !== 'string' || workspacePath === '') return
      if (!readCompactionArchive(workspacePath, sessionId)) return
      const dirRelative = archives.get(sessionId) ?? revivedArchiveOf(session, headers)
      if (dirRelative === undefined) return
      archives.set(sessionId, dirRelative)
      const dirAbsolute = join(workspacePath, dirRelative)
      const compactionId = typeof event?.data?.compactionId === 'string' ? event.data.compactionId : ''
      const seqs = Array.isArray(event?.data?.shadowedSeqs) ? [...event.data.shadowedSeqs] : []
      if (seqs.length === 0) return
      busy.add(sessionId)
      // Off the compaction path: never make the host wait for a few hundred file writes.
      setImmediate(() => {
        try {
          const manifest = readManifest(dirAbsolute)
          if (compactionId !== '' && manifest.compactions.includes(compactionId)) return
          const turns = turnsFromShadowed(session, seqs, headers)
            .filter(row => !manifest.sessionTurns.includes(row.turn))
          if (turns.length === 0) {
            if (compactionId !== '') {
              writeManifest(dirAbsolute, { compactions: [...manifest.compactions, compactionId], sessionTurns: manifest.sessionTurns })
            }
            return
          }
          const state = inspectArchive(dirAbsolute)
          const written = appendTurns(dirAbsolute, turns, state)
          writeManifest(dirAbsolute, {
            compactions: compactionId === '' ? manifest.compactions : [...manifest.compactions, compactionId],
            sessionTurns: [...manifest.sessionTurns, ...turns.map(row => row.turn)],
          })
          warn(`compaction archive: appended ${turns.length} turns (${written.pages} page(s)) to ${dirRelative}`)
        }
        catch (error) {
          warn('compaction archive: append failed', error)
        }
        finally {
          busy.delete(sessionId)
        }
      })
    }
    catch (error) {
      warn('compaction archive: hook failed', error)
    }
  }, 'revive-love: compaction archive')
}
