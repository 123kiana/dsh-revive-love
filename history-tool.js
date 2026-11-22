/**
 * The `history_search` tool: first level of the two-level retrieval over an archive.
 *
 * A revived session carries a summary, not the transcript. The dropped turns sit in
 * `.dsh-revive/history-<id>/part-NN.md`; a big session has dozens of pages, and one page
 * costs ~4,700 tokens *and stays in the context for every later step*. So the model searches
 * for a keyword (bounded, independent of archive size) and gets back the **whole turns** its
 * hits fell in — the user's message and the reply, uncut. It needs both to answer: the facts
 * are in the words, and the way the two of them were talking is what the next reply should
 * follow. Whole turns also cost far less than a page and can be dropped when they are done,
 * where a read page stays in context for every later step.
 *
 * The tool is visible only to agents whose session was amplified: `register` takes a
 * step-time `when` condition, so other conversations never pay for its schema.
 * @module dsh-revive-love/history-tool
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { summaryOf } from './summary-prompt.js'

/** Marker the archive pointer starts with; the directory follows it. Must match the text
 * `amplify.js` writes (`完整原文存档：`), or the tool silently finds nothing to search. */
const ARCHIVE_MARKER = '完整原文存档：'

/**
 * The only directory shape this tool will read.
 *
 * The pointer is parsed out of the summary, and the summary is model output: a confused or
 * steered model could write `完整原文存档：../../..` and turn the tool into an arbitrary
 * directory reader. The writer only ever produces `.dsh-revive/history-<base36>-<base36>`,
 * so anything else is rejected rather than resolved.
 */
const SAFE_ARCHIVE_DIR = /^\.dsh-revive\/history-[a-z0-9-]{1,64}$/

/** Archive pages only. The index is an overview, not a search target. */
const PART_FILE = /^part-\d+\.md$/

/** At most this many hits, so one search cannot dominate the context. */
const MAX_HITS = 5

/**
 * Longest one turn is rendered.
 *
 * The whole turn is the point: it carries the facts *and* the way the two of them were
 * talking. The bound only guards against a pasted file or a very long scene.
 */
const TURN_CHARS = 2000

/** Total characters of turn text in one result; a later hit only rides along if it fits. */
const RESULT_BUDGET_CHARS = 4500

/** Distribution entries shown before collapsing into a count; a common word hits 50+ pages. */
const DISTRIBUTION_SHOWN = 12

/** Characters on each side of a match used only to count how many query terms co-occur. */
const CONTEXT_WINDOW_CHARS = 300

/** A query longer than this is almost certainly a paste, not a keyword. */
const MAX_QUERY_CHARS = 120

/**
 * Output shape. The pipeline assigns `output.render(...)` straight to the tool result's
 * `content` and then calls `content.some(...)` on it, so `render` must return a **content
 * block array**. Returning the bare string throws `content.some is not a function` at
 * dispatch time — invisible until a model actually calls the tool (1.4.0 shipped with it).
 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: value.text }]
  },
}

/**
 * Read the archive directory out of a summary's pointer line.
 * @param summary - the amplified session's summary text.
 * @returns the workspace-relative directory, or undefined when there is no valid pointer.
 */
export function archiveDirOf(summary) {
  if (typeof summary !== 'string') return undefined
  for (const line of summary.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(ARCHIVE_MARKER)) continue
    // The pointer is `完整原文存档：<dir>/（已按片切分）`; keep only the directory.
    const rest = trimmed.slice(ARCHIVE_MARKER.length).replace(/（.*$/u, '').trim()
    const dir = rest.replace(/[\\/]+$/u, '').replace(/\\/gu, '/')
    return SAFE_ARCHIVE_DIR.test(dir) ? dir : undefined
  }
  return undefined
}

/** An archive page's per-turn heading: `### 第 12 轮` or `### Turn 12`. */
const TURN_HEADING = /^### (?:第 (\d+) 轮|Turn (\d+))\s*$/gmu

/** Most alternatives one query may expand to; more than this is a sentence, not keywords. */
const MAX_TERMS = 4

/**
 * Split a query into alternative keywords, any of which may match.
 *
 * The archive is verbatim, so the wording the user remembers and the wording actually used
 * rarely agree. Accepting several candidates lets one call cover both instead of making
 * the model guess and pay for a second search.
 * @param raw - the trimmed query.
 * @returns lowercased distinct terms, at most `MAX_TERMS`.
 */
export function splitTerms(raw) {
  const unique = []
  for (const part of raw.split(/[\s,，、;；|]+/u)) {
    const term = part.trim().toLowerCase()
    if (term === '' || unique.includes(term)) continue
    unique.push(term)
    if (unique.length >= MAX_TERMS) break
  }
  return unique
}

/**
 * A bare turn number means "the Nth turn", not that literal text.
 * @param raw - the trimmed query.
 * @returns the heading forms to search for, or undefined when this is not a turn number.
 */
export function turnTermsOf(raw) {
  if (!/^\d{1,5}$/u.test(raw)) return undefined
  return [`第 ${raw} 轮`, `turn ${raw}`]
}

/** Numeric page index: part-007.md → 7. */
function pageNumber(name) {
  return Number(name.replace(/\D+/gu, '')) || 0
}

/** Turn headings with their offsets, so a hit can say which turn it fell in. */
function turnMarks(text) {
  const marks = []
  TURN_HEADING.lastIndex = 0
  let match
  while ((match = TURN_HEADING.exec(text)) !== null) {
    marks.push({ at: match.index, turn: Number(match[1] ?? match[2]) })
  }
  return marks
}

/** The turn a character offset falls in, or undefined before the first heading. */
function turnAt(marks, offset) {
  let turn
  for (const mark of marks) {
    if (mark.at > offset) break
    turn = mark.turn
  }
  return turn
}

/**
 * Walk every page once, then pick the hits worth showing.
 *
 * Two things matter and neither is "first come":
 * 1. **How many of the query's terms a window matches.** With OR matching, a page that
 *    happens to contain one common term can flood the answer; a window containing two or
 *    three of them is what the asker meant.
 * 2. **How recent it is.** A revived conversation continues from the end, so a hit on the
 *    last page usually beats the same hit on page 1.
 *
 * The full match count and its per-page distribution are kept regardless: "how did this
 * end" is answered by where the *last* mention is.
 * @param dirAbsolute - absolute archive directory.
 * @param terms - lowercased keywords, any of which may match.
 * @param limit - maximum hits to keep.
 * @returns `{ pages, hits, total, clipped, last, distribution }`.
 */
function scanArchive(dirAbsolute, terms, limit) {
  let names
  try {
    // Numeric order, not string order: part-100 sorts before part-11 as text, and
    // that silently breaks the recency ranking this tool relies on.
    names = readdirSync(dirAbsolute).filter(name => PART_FILE.test(name)).sort((left, right) => pageNumber(left) - pageNumber(right))
  }
  catch {
    return { missing: true }
  }
  /** Every window, with just enough to rank it; the turn is rendered afterwards. */
  const windows = []
  const perPage = new Map()
  let total = 0
  let pages = 0
  let last
  for (const [pageIndex, page] of names.entries()) {
    let text
    try {
      text = readFileSync(join(dirAbsolute, page), 'utf8')
    }
    catch {
      continue
    }
    pages += 1
    const haystack = text.toLowerCase()
    const marks = turnMarks(text)
    let from = 0
    for (;;) {
      // Earliest occurrence of any term at or after `from`.
      let at = -1
      let size = 0
      for (const term of terms) {
        const found = haystack.indexOf(term, from)
        if (found < 0) continue
        if (at < 0 || found < at) {
          at = found
          size = term.length
        }
      }
      if (at < 0) break
      total += 1
      perPage.set(page, (perPage.get(page) ?? 0) + 1)
      const turn = turnAt(marks, at)
      last = { page, offset: at, turn }
      const start = Math.max(0, at - CONTEXT_WINDOW_CHARS)
      const end = Math.min(text.length, at + size + CONTEXT_WINDOW_CHARS)
      // How many distinct terms show up inside this window, not merely at its centre.
      let matched = 0
      for (const term of terms) if (haystack.slice(start, end).includes(term)) matched += 1
      windows.push({ page, pageIndex, at, size, turn, matched })
      // Skip the rest of this window: five copies of one passage help nobody.
      from = at + size + CONTEXT_WINDOW_CHARS
    }
  }

  const ranked = windows
    .slice()
    .sort((left, right) => right.matched - left.matched || right.pageIndex - left.pageIndex || left.at - right.at)
    .slice(0, Math.max(1, limit))

  const hits = ranked.map(window => ({
    page: window.page,
    offset: window.at,
    turn: window.turn,
    matched: window.matched,
  }))

  return {
    pages,
    hits,
    total,
    clipped: total > hits.length,
    last,
    distribution: [...perPage].map(([page, count]) => ({ page, count })),
  }
}

/**
 * Search every page of one archive.
 * @param dirAbsolute - absolute archive directory.
 * @param query - one or more keywords, or a bare turn number; matched case-insensitively.
 * @param limit - maximum hits.
 * @returns the `scanArchive` result, or `{ missing: true }` when the directory is gone.
 */
export function searchArchive(dirAbsolute, query, limit) {
  const terms = turnTermsOf(query) ?? splitTerms(query)
  if (terms.length === 0) return { pages: 0, hits: [], total: 0, clipped: false, distribution: [] }
  return scanArchive(dirAbsolute, terms, limit)
}

/** `part-03.md` → `part-03`, so the distribution line stays short. */
function shortPage(page) {
  return page.replace(/\.md$/u, '')
}

/** `第 41 轮` when the hit fell inside one, otherwise an empty string. */
function turnLabel(turn) {
  return Number.isFinite(turn) ? `第 ${turn} 轮` : ''
}

/** Turn heading, numbered only: a reply may carry markdown headings of its own. */
const TURN_AT = /^### (?:第 (\d+) 轮|Turn (\d+))\s*$/gmu

/**
 * Read the complete turn a hit fell in: the user's line and the reply, from archived heading
 * to the next one.
 *
 * This is what the tool hands the model now. It used to return a 300-character window around
 * the keyword, which starts and ends mid-sentence and loses exactly the register the reply
 * should follow. A whole turn is small (measured: 200–1,300 characters, 4,900 at the extreme)
 * and it is both the fact and the voice.
 * @param text - one archive page.
 * @param turn - the turn number the hit landed in.
 * @param maxChars - clip beyond this many characters.
 * @returns the turn text, or undefined when the page does not hold that turn.
 */
export function turnBlock(text, turn, maxChars = TURN_CHARS) {
  if (!Number.isFinite(turn)) return undefined
  TURN_AT.lastIndex = 0
  let start = -1
  let match
  while ((match = TURN_AT.exec(text)) !== null) {
    if (start < 0) {
      if (Number(match[1] ?? match[2]) === turn) start = match.index
      continue
    }
    return clipBlock(text.slice(start, match.index), maxChars)
  }
  if (start < 0) return undefined
  return clipBlock(text.slice(start), maxChars)
}

/**
 * Trim one turn that is longer than the bound, with a visible marker.
 * @param block - the raw turn text.
 * @param maxChars - the bound.
 * @returns the turn text.
 */
function clipBlock(block, maxChars) {
  const value = block.trim()
  return value.length > maxChars ? `${value.slice(0, maxChars)}…（这一段太长，后面略）` : value
}

/**
 * Render a search result as the tool's text value.
 * @param query - the keyword, echoed back.
 * @param found - the result of `searchArchive`.
 * @param dirAbsolute - absolute archive directory, used for the read hint.
 * @returns the text the model sees.
 */
export function formatResult(query, found, dirAbsolute) {
  if (found.missing === true) {
    return [
      `存档目录不在了：${dirAbsolute}`,
      '工作区可能已经换过，原话查不到。摘要里的事你仍然知道，但别再引用具体原句。',
    ].join('\n')
  }
  if (found.hits.length === 0) {
    const lines = [`在 ${found.pages} 片存档里没找到「${query}」。`]
    if (turnTermsOf(query) !== undefined) {
      lines.push('如果你不是在找第几轮，换一个词再搜：带上一个名词或名字。')
    }
    else {
      lines.push('这是逐字搜索，不是语义搜索：换一个当时更可能用的说法再搜，')
      lines.push('可以一次给几个候选词（空格分开，任一命中就算）。')
      lines.push('也可以先读索引.md 看整体结构，再决定搜什么。')
    }
    return lines.join('\n')
  }
  const shown = found.hits.length < found.total ? `，先显示前 ${found.hits.length} 处` : ''
  const lines = [`在 ${found.pages} 片存档里找到 ${found.total} 处「${query}」${shown}：`]
  if (found.total > 1 && found.distribution.length > 0) {
    const shown = found.distribution.slice(0, DISTRIBUTION_SHOWN)
    const rest = found.distribution.length - shown.length
    lines.push(`分布：${shown.map(item => `${shortPage(item.page)}(${item.count})`).join(' / ')}${rest > 0 ? ` …（共 ${found.distribution.length} 片）` : ''}`)
  }
  if (found.clipped && found.last !== undefined) {
    const where = `${shortPage(found.last.page)}${turnLabel(found.last.turn) === '' ? '' : ` ${turnLabel(found.last.turn)}`}`
    lines.push(`最后一次出现在 ${where} —— 「后来怎么样了」这类问题通常要看这处附近。`)
  }
  if (found.hits.length > 0) {
    lines.push('')
    lines.push('命中所在的整轮原文（你当时那句 + 你的回复）：')
  }
  let budget = RESULT_BUDGET_CHARS
  for (const [index, hit] of found.hits.entries()) {
    let text
    try {
      text = readFileSync(join(dirAbsolute, hit.page), 'utf8')
    }
    catch {
      continue
    }
    const block = turnBlock(text, hit.turn)
    if (block === undefined) continue
    // The first hit always goes in; later ones only if they fit.
    if (index > 0 && block.length > budget) continue
    budget -= block.length
    lines.push('')
    lines.push(`${index + 1}) ${shortPage(hit.page)} ${turnLabel(hit.turn) || `字符 ${hit.offset} 附近`}`)
    lines.push(block)
  }
  const pages = [...new Set(found.hits.map(hit => hit.page))]
  lines.push('')
  lines.push('要看邻近的几轮就读这几片（一次读一片，读完记住了就别再读第二片）：')
  for (const page of pages) lines.push(`- ${join(dirAbsolute, page)}`)
  return lines.join('\n')
}

/**
 * Register `history_search`, visible only to amplified sessions.
 * @param ctx - the plugin context.
 * @param options - `{ headers, warn }`, the same summary headers used for injection.
 */
export function installHistoryTool(ctx, options) {
  const { headers, warn } = options
  /** Agents that have an archive: tool visibility is gated on membership here. */
  const archives = new WeakMap()

  // Resolve the archive once per agent. `when` runs on every step, and scanning every
  // event there would cost real time on a long session.
  ctx.on('agent/created', (event) => {
    const agent = event?.agent
    if (agent === null || typeof agent !== 'object') return
    try {
      const session = agent.session
      if (session === undefined || session === null) return
      const summary = summaryOf(session, headers)
      if (summary === undefined || summary === '') return
      const dirRelative = archiveDirOf(summary)
      if (dirRelative === undefined) return
      archives.set(agent, dirRelative)
    }
    catch (error) {
      warn('history tool: archive lookup failed', error)
    }
  }, 'revive-love: history tool')

  ctx.inject(['tools', 'workingDirectory'], (sub) => {
    const tools = sub.get('tools')
    if (tools === undefined || typeof tools.register !== 'function') {
      warn('history tool: tools.register unavailable')
      return
    }
    const workingDirectory = sub.get('workingDirectory')
    if (workingDirectory === undefined || typeof workingDirectory.get !== 'function') {
      warn('history tool: workingDirectory unavailable')
      return
    }
    sub.effect(() => tools.register({
      name: 'history_search',
      description:
        '在自己的历史原文存档里搜索：这个会话更早的部分已被压缩成摘要，存档里是逐字原话。'
        + '用户问「还记得」「之前说过」「当时我怎么说的」这类需要原话的问题时，先用它查，再回答；别凭摘要或印象编。'
        + '回复给出命中总数、分布，并把命中所在的**整轮原文**（用户那句 + 你当时的回复）交回来；要看邻近几轮再用 read 读它给的路径。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '关键词，或一个轮次号（如 87）。给几个候选词用空格分开，任一命中就算；不要用整句话。',
          },
          limit: {
            type: 'number',
            description: `最多返回几轮原文，默认 ${MAX_HITS}，上限也是 ${MAX_HITS}。总数与分布不受影响。`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const dirRelative = archives.get(exec?.agent)
        if (dirRelative === undefined) {
          return { text: '这个会话没有历史存档，搜不了。' }
        }
        let base
        try {
          base = workingDirectory.get(exec.agent.session)
        }
        catch (error) {
          warn('history tool: working directory lookup failed', error)
          return { text: '拿不到工作区路径，搜不了存档。' }
        }
        if (typeof base !== 'string' || base === '') {
          return { text: '拿不到工作区路径，搜不了存档。' }
        }
        const raw = String(args.query ?? '').trim().replace(/\s+/gu, ' ')
        if (raw === '') return { text: 'query 不能是空的。给一个关键词再搜。' }
        if (raw.length > MAX_QUERY_CHARS) {
          return {
            text: `关键词太长了（${raw.length} 字符，上限 ${MAX_QUERY_CHARS}）。`
              + '存档是逐字原话，用整句话几乎不可能逐字命中：挑里面最有辨识度的一个名字或一个词再搜。',
          }
        }
        const query = raw
        const limit = Math.max(1, Math.min(MAX_HITS, Number(args.limit) || MAX_HITS))
        const dirAbsolute = join(base, dirRelative)
        return { text: formatResult(query, searchArchive(dirAbsolute, query, limit), dirAbsolute) }
      },
    }, {
      // Only an agent with an archive sees the tool. `when` runs before the step's tool
      // schema is assembled, so every other conversation is unaffected.
      when: ({ agent }) => archives.has(agent),
    }), 'revive-love: history tool')
  })
}

export { ARCHIVE_MARKER, MAX_HITS, PART_FILE, RESULT_BUDGET_CHARS, TURN_CHARS }
