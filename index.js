/**
 * dsh-session-slim — host half.
 *
 * Slims a DeepSeek chat export (`deepseek_data-*.zip`, `export_format_version: 3`)
 * before it is imported, so an over-long conversation becomes one shorter
 * conversation instead of a Session that overflows the model context window.
 *
 * Routes on the harness web server:
 *
 *  - `POST /dsh-session-slim/preview`  body: `application/octet-stream` (the zip)
 *      Reads `manifest.json`, `chat_session_index.json` and every
 *      `chat_sessions/<id>.json` (newest first, capped), and answers
 *      `{ ok, uploadId, conversations: [{ id, title, turns, estTokens, updatedAt, turnChars, turnCharsOffset }] }`.
 *
 *  - `POST /dsh-session-slim/build`  body: JSON `{ uploadId, conversationId, keepTurns, locale, note }`
 *      Rebuilds a single-conversation export archive that keeps only the most
 *      recent `keepTurns` USER turns, and answers the new zip bytes
 *      (`application/zip`) with its metadata in `x-dsh-slim-*` headers.
 *
 * The browser half then hands those bytes to the shipped DeepSeek-import
 * pipeline (its `POST api/deepseek-chat-import/archive` route), or downloads
 * them for the user to import with the shipped import action. This plugin
 * never writes a `session*.jsonl*` log itself.
 *
 * ZIP reading/writing is implemented on `node:zlib` only, following the export
 * format (`export_format_version: 3`) that the DeepSeek website produces: a
 * profile-installed package cannot resolve `@deepseek-ai/*` or third-party
 * bundles, so the archive layer is written from scratch against that format.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { chunkTurns, createAmplifyRunner } from './amplify.js'
import { installSummaryPrompt } from './summary-prompt.js'
import { installHistoryTool } from './history-tool.js'

/** The plugin's own identity, echoed by the patch row and the client bundle. */
export const name = 'session-slim'

/** Host half version, read from the package manifest at load time. */
export const version = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  }
  catch {
    return null
  }
})()

/** Exact routes; the browser bundle resolves the same strings against `document.baseURI`. */
export const PREVIEW_ROUTE = '/dsh-session-slim/preview'
export const BUILD_ROUTE = '/dsh-session-slim/build'
/** Lists export archives already sitting in the user's own folders (no network, no scraping). */
export const SCAN_ROUTE = '/dsh-session-slim/scan'
/** Loads one archive found by the scan, so the wizard skips the file picker. */
export const OPEN_ROUTE = '/dsh-session-slim/scan-open'
/** Amplify mode: plan the segmentation, run it, poll it, cancel it, answer a stall. */
export const AMPLIFY_PLAN_ROUTE = '/dsh-session-slim/amplify/plan'
export const AMPLIFY_START_ROUTE = '/dsh-session-slim/amplify/start'
export const AMPLIFY_STATUS_ROUTE = '/dsh-session-slim/amplify/status'
export const AMPLIFY_CANCEL_ROUTE = '/dsh-session-slim/amplify/cancel'
export const AMPLIFY_DECIDE_ROUTE = '/dsh-session-slim/amplify/decide'

/** Filename shape of a DeepSeek website export. */
const SCAN_PATTERN = /^deepseek_data.*\.zip$/i
/** Most scanned archives offered at once. */
const MAX_CANDIDATES = 10
/** How long a scan result stays loadable. */
const SCAN_TTL_MS = 10 * 60 * 1000

/** The only export format version the shipped importer reads. */
export const SUPPORTED_EXPORT_FORMAT_VERSION = 3

/** Largest accepted upload; the whole archive is held in memory while it is slimmed. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
/** Largest inflated size of one archive entry; keeps a zip bomb from exhausting memory. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

/** Largest accepted JSON body for the light routes (scan-open and the amplify routes). */
const MAX_JSON_BYTES = 8192
/**
 * `/build` additionally carries the amplify summary, which is allowed to be 400k
 * characters. At 3 bytes per CJK character that is over 1 MiB, so the light-route
 * limit above would reject every real summary after the model already ran.
 */
const MAX_BUILD_JSON_BYTES = 2 * 1024 * 1024

/** Most conversations one preview inspects, newest `updated_at` first. */
const MAX_PREVIEW_CONVERSATIONS = 200

/** Most per-turn samples carried to the browser; older turns are summarized instead. */
const MAX_TURN_SAMPLES = 1500

/** How long an uploaded archive stays available for a `build` call. */
const PENDING_TTL_MS = 15 * 60 * 1000

/** `manifest.json` entry name. */
const MANIFEST_ENTRY = 'manifest.json'
/** `chat_session_index.json` entry name. */
const INDEX_ENTRY = 'chat_session_index.json'
/** A conversation id that is safe to place in a zip entry name. */
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** A conversation entry name; the id is the entry name. */
function conversationEntryName(id) {
  return `chat_sessions/${id}.json`
}

/** Recover a conversation id from its entry name. */
function entryNameToId(entryName) {
  const base = String(entryName).split('/').pop() || ''
  const id = base.endsWith('.json') ? base.slice(0, -5) : base
  return SAFE_CONVERSATION_ID.test(id) ? id : 'unknown'
}

/** Context facts the picker marks conversations with. */
const CONTEXT_WINDOW_TOKENS = 1048576
const HISTORY_BUDGET_TOKENS = 790000
/** A conversation longer than this many USER turns carries the "slim first" badge. */
const RECOMMEND_TURNS = 500
/** Most USER turns the wizard offers to keep. */
const MAX_KEEP_TURNS = 500

/** Visible text the rebuilt export carries: the title suffix and the notice turn. */
const NOTICES = {
  zh: {
    suffix: '（复活版）',
    ack: '（历史摘要｜本会话复活自「{title}」：保留最近 {kept} 轮原文，更早的 {removed} 轮已移除。）',
    untitled: '未命名会话',
    summaryHeader: '【较早内容的摘要｜由增幅模式生成】',
  },
  en: {
    suffix: ' (revived)',
    ack: '(History summary — this conversation was revived from "{title}": the most recent {kept} turns are kept and the earlier {removed} turns are removed.)',
    untitled: 'Untitled conversation',
    summaryHeader: '[Summary of the earlier part | produced by amplify mode]',
  },
}

/** A refusal the routes report verbatim, with the same vocabulary the importer uses. */
class SlimError extends Error {
  /**
   * @param code - machine-readable reason consumed by the browser half.
   * @param message - diagnostic text.
   */
  constructor(code, message) {
    super(message)
    this.name = 'SlimError'
    this.code = code
  }
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

/** One JSON response. */
function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

/**
 * A present Origin must match the request Host (same-origin browsers only), and the
 * Host must be a loopback name. Without the loopback check a page on `evil.com` that
 * rebinds that name to 127.0.0.1 would present matching Origin and Host and reach the
 * folder scan and build routes. Requests without Origin are allowed so that non-browser
 * clients on the same machine (curl, scripts) keep working.
 */
function sameOrigin(request) {
  const host = request.headers.host
  if (host === undefined || host === '') return false
  if (!isLoopbackHost(host)) return false
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    return new URL(origin).host === host
  }
  catch {
    return false
  }
}

/** Whether a `Host` header names the local machine. */
function isLoopbackHost(host) {
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * Buffer one request body up to a byte limit.
 * @param request - the incoming request.
 * @param limit - largest accepted body.
 * @returns the body, or undefined when it exceeds the limit (the rest is drained).
 */
function readBoundedBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(tooLarge ? undefined : Buffer.concat(chunks))
    })
    request.on('error', reject)
  })
}

/** Log one contained failure without failing the request that observed it. */
function warn(ctx, message, error) {
  try {
    ctx.logger.warn(`session-slim: ${message}${error === undefined ? '' : `: ${String(error)}`}`)
  }
  catch {
    /* a context without a logger is not a reason to fail */
  }
}

// ── ZIP: read ───────────────────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * Locate the end-of-central-directory record, scanning backwards over the
 * optional archive comment.
 * @param buffer - archive bytes.
 * @returns the record offset, or -1 when absent.
 */
function findEocd(buffer) {
  const minimum = 22
  if (buffer.length < minimum) return -1
  const first = Math.max(0, buffer.length - minimum - 0xffff)
  for (let offset = buffer.length - minimum; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * Index one ZIP archive's central directory.
 * @param buffer - archive bytes.
 * @returns the entry index keyed by entry name.
 * @throws {SlimError} `unreadable-archive` for a container that cannot be walked.
 */
export function readZipIndex(buffer) {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new SlimError('unreadable-archive', 'not a ZIP archive: the end of central directory is missing')
  const total = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset + centralSize > buffer.length) {
    throw new SlimError('unreadable-archive', 'not a ZIP archive: the central directory is out of bounds')
  }
  const entries = new Map()
  let offset = centralOffset
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length) {
      throw new SlimError('unreadable-archive', 'not a ZIP archive: a central directory record is truncated')
    }
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new SlimError('unreadable-archive', 'not a ZIP archive: a central directory record has no signature')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Read and inflate one archive entry.
 * @param buffer - archive bytes.
 * @param entry - the central directory record of the entry.
 * @returns the entry bytes.
 * @throws {SlimError} `unreadable-archive` for a truncated or unsupported entry.
 */
export function readZipEntry(buffer, entry) {
  const at = entry.localOffset
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw new SlimError('unreadable-archive', `entry ${entry.name} has no local header`)
  }
  const nameLength = buffer.readUInt16LE(at + 26)
  const extraLength = buffer.readUInt16LE(at + 28)
  const start = at + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > buffer.length) throw new SlimError('unreadable-archive', `entry ${entry.name} is truncated`)
  const data = buffer.subarray(start, end)
  if (entry.method === 0) {
    if (data.length > MAX_ENTRY_BYTES) {
      throw new SlimError('unreadable-archive', `entry ${entry.name} exceeds ${MAX_ENTRY_BYTES} bytes`)
    }
    return Buffer.from(data)
  }
  if (entry.method === 8) {
    // The declared uncompressed size is attacker-controlled, so it only caps the
    // inflation; MAX_ENTRY_BYTES keeps a zip bomb from exhausting memory either way.
    const declared = Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0
      ? entry.uncompressedSize
      : MAX_ENTRY_BYTES
    if (declared > MAX_ENTRY_BYTES) {
      throw new SlimError('unreadable-archive', `entry ${entry.name} declares more than ${MAX_ENTRY_BYTES} bytes`)
    }
    let inflated
    try {
      inflated = inflateRawSync(data, { maxOutputLength: Math.max(1, declared) })
    }
    catch (error) {
      throw new SlimError('unreadable-archive', `entry ${entry.name} cannot be inflated: ${String(error?.message ?? error)}`)
    }
    if (inflated.length !== declared) {
      throw new SlimError('unreadable-archive', `entry ${entry.name} inflated to ${inflated.length} bytes but declares ${declared}`)
    }
    return inflated
  }
  throw new SlimError('unreadable-archive', `entry ${entry.name} uses unsupported compression method ${entry.method}`)
}

// ── ZIP: write (stored entries, UTF-8 names) ────────────────────────────────

let crcTable

/**
 * CRC-32 of one buffer (the checksum ZIP records per entry).
 * @param buffer - entry bytes.
 * @returns the unsigned checksum.
 */
export function crc32(buffer) {
  if (crcTable === undefined) {
    const table = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      table[index] = value >>> 0
    }
    crcTable = table
  }
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time fields for one moment. */
function dosStamp(at) {
  const year = Math.max(1980, at.getFullYear())
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

/**
 * Build one ZIP archive whose entries are stored uncompressed.
 * @param files - entries in archive order, each `{ name, data }`.
 * @returns the archive bytes.
 * @throws {SlimError} `build-failed` when an entry or the archive would need ZIP64.
 */
export function buildZip(files) {
  const stamp = dosStamp(new Date())
  const parts = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = file.data
    if (data.length > 0xfffffffe || offset > 0xfffffffe) {
      throw new SlimError('build-failed', `entry ${file.name} needs ZIP64, which is not supported`)
    }
    const checksum = crc32(data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    parts.push(local, data)
    const record = Buffer.alloc(46 + name.length)
    record.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(stamp.time, 12)
    record.writeUInt16LE(stamp.date, 14)
    record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    name.copy(record, 46)
    central.push(record)
    offset += local.length + data.length
  }
  let centralSize = 0
  for (const record of central) centralSize += record.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, ...central, eocd])
}

// ── DeepSeek export format (v3) ─────────────────────────────────────────────

/** Parse JSON bytes, treating anything unparsable as undefined. */
function parseJsonBytes(bytes) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes))
  }
  catch {
    return undefined
  }
}

/** Whether a value is a plain JSON object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the export timestamp the index requires.
 * @param value - candidate field.
 * @param fallback - epoch milliseconds used when the field is not a valid timestamp.
 * @returns epoch milliseconds.
 */
function exportTime(value, fallback) {
  if (typeof value !== 'string') return fallback
  const time = Date.parse(value)
  return Number.isSafeInteger(time) && time >= 0 ? time : fallback
}

/**
 * Validate `manifest.json`.
 * @param bytes - the entry bytes.
 * @returns the declared version.
 * @throws {SlimError} `missing-manifest` or `unsupported-version`.
 */
function readManifest(bytes) {
  const parsed = parseJsonBytes(bytes)
  if (!isRecord(parsed) || typeof parsed.export_format_version !== 'number') {
    throw new SlimError('missing-manifest', 'manifest.json is missing or does not declare export_format_version')
  }
  if (parsed.export_format_version !== SUPPORTED_EXPORT_FORMAT_VERSION) {
    throw new SlimError('unsupported-version', `manifest.json declares export_format_version ${parsed.export_format_version}; this plugin reads ${SUPPORTED_EXPORT_FORMAT_VERSION}`)
  }
  return parsed.export_format_version
}

/**
 * Validate `chat_session_index.json` and rank its rows newest first.
 * @param bytes - the entry bytes.
 * @returns the ranked rows.
 * @throws {SlimError} `missing-index` or `no-conversations`.
 */
function readIndex(bytes) {
  const parsed = parseJsonBytes(bytes)
  if (!Array.isArray(parsed)) {
    throw new SlimError('missing-index', 'chat_session_index.json is missing or is not an array')
  }
  const now = Date.now()
  const seen = new Set()
  const rows = []
  for (const row of parsed) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id === '') continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    rows.push({
      id: row.id,
      insertedAt: exportTime(row.inserted_at, now),
      updatedAt: exportTime(row.updated_at, now),
      title: typeof row.title === 'string' ? row.title : '',
    })
  }
  if (rows.length === 0) throw new SlimError('no-conversations', 'the export lists no conversation')
  rows.sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? 1 : -1))
  return rows
}

/**
 * Normalize one conversation entry so downstream code never re-checks JSON shape.
 * @param bytes - the conversation file bytes.
 * @param entryName - the archive entry name, for diagnostics.
 * @returns the conversation.
 * @throws {SlimError} `unreadable-archive` for a malformed conversation file.
 */
function parseConversation(bytes, entryName) {
  const parsed = parseJsonBytes(bytes)
  if (!isRecord(parsed)) throw new SlimError('unreadable-archive', `${entryName} is not a JSON object`)
  if (typeof parsed.id !== 'string' || parsed.id === '') {
    throw new SlimError('unreadable-archive', `${entryName} has no conversation id`)
  }
  const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : []
  const messages = []
  for (const raw of rawMessages) {
    if (!isRecord(raw)) continue
    if (typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id < 0) continue
    const role = raw.role
    if (role !== 'USER' && role !== 'ASSISTANT') continue
    const parent = typeof raw.parent_id === 'number' && Number.isSafeInteger(raw.parent_id) && raw.parent_id >= 0
      ? raw.parent_id
      : null
    messages.push({
      id: raw.id,
      parentId: parent,
      role,
      status: typeof raw.status === 'string' ? raw.status : 'FINISHED',
      insertedAt: typeof raw.inserted_at === 'string' ? raw.inserted_at : '',
      fragments: Array.isArray(raw.fragments) ? raw.fragments.filter(isRecord) : [],
    })
  }
  const current = typeof parsed.current_message_id === 'number' && Number.isSafeInteger(parsed.current_message_id)
    ? parsed.current_message_id
    : undefined
  // The id ends up in a zip entry name (`chat_sessions/<id>.json`) and in the download
  // filename, so an id carrying `../` or a separator must never reach buildZip.
  const id = typeof parsed.id === 'string' && SAFE_CONVERSATION_ID.test(parsed.id)
    ? parsed.id
    : entryNameToId(entryName)
  return {
    id,
    title: typeof parsed.title === 'string' ? parsed.title : '',
    insertedAt: typeof parsed.inserted_at === 'string' ? parsed.inserted_at : '',
    currentMessageId: current,
    messages,
  }
}

/**
 * Select the imported branch: the path from the root to `current_message_id`,
 * falling back to the greatest message id (the same rule the shipped importer
 * applies).
 * @param conversation - one normalized conversation.
 * @returns messages from root to the selected message.
 * @throws {SlimError} `unreadable-archive` for an empty tree, duplicate ids, a missing parent, or a cycle.
 */
export function selectBranch(conversation) {
  const byId = new Map()
  let newest
  for (const message of conversation.messages) {
    if (byId.has(message.id)) throw new SlimError('unreadable-archive', `duplicate message id ${message.id}`)
    byId.set(message.id, message)
    if (newest === undefined || message.id > newest.id) newest = message
  }
  if (newest === undefined) throw new SlimError('unreadable-archive', `conversation ${conversation.id} has no messages`)
  const current = conversation.currentMessageId
  const selected = current === undefined ? undefined : byId.get(current)
  const chain = []
  let message = selected === undefined ? newest : selected
  for (;;) {
    if (chain.length === byId.size) {
      throw new SlimError('unreadable-archive', `message ${message.id} is part of a parent cycle`)
    }
    chain.push(message)
    if (message.parentId === null) break
    const parent = byId.get(message.parentId)
    if (parent === undefined) {
      throw new SlimError('unreadable-archive', `message parent ${message.parentId} does not exist`)
    }
    message = parent
  }
  chain.reverse()
  return chain
}

/** The body text of one message: its `REQUEST` (`USER`) or `RESPONSE` (`ASSISTANT`) fragments. */
function bodyText(message) {
  const parts = []
  for (const fragment of message.fragments) {
    const type = fragment.type
    if (message.role === 'USER' ? type !== 'REQUEST' : type !== 'RESPONSE') continue
    if (typeof fragment.content === 'string') parts.push(fragment.content)
  }
  return parts.join('\n\n')
}

/**
 * Group one branch into turns: a USER message and the ASSISTANT reply that
 * directly follows it.
 * @param chain - the selected branch, root first.
 * @returns the turns in order.
 */
export function conversationTurns(chain) {
  const turns = []
  for (let index = 0; index < chain.length; index += 1) {
    const message = chain[index]
    if (message.role !== 'USER') continue
    const next = chain[index + 1]
    const reply = next !== undefined && next.role === 'ASSISTANT' ? next : undefined
    if (reply !== undefined) index += 1
    const userText = bodyText(message)
    const replyText = reply === undefined ? '' : bodyText(reply)
    turns.push({
      userText,
      replyText,
      chars: userText.length + replyText.length,
      insertedAt: message.insertedAt,
      replyStatus: reply === undefined ? undefined : reply.status,
    })
  }
  return turns
}

/** Token estimate for mixed Chinese/Latin text: CJK ≈ 1.45 chars per token, ASCII ≈ 3.6. */
function textTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let cjk = 0
  let other = 0
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) >= 0x2e80) cjk += 1
    else other += 1
  }
  return cjk / 1.45 + other / 3.6
}

/** Token estimate for one turn pair. */
function turnTokens(turns) {
  let total = 0
  for (const turn of turns) total += textTokens(turn.userText) + textTokens(turn.replyText)
  return Math.max(1, Math.round(total))
}

/** Per-turn characters and token estimates, trimmed to the newest turns the browser renders. */
function turnCharsOf(turns) {
  const chars = turns.map(turn => turn.chars)
  const tokens = turns.map(turn => Math.max(1, Math.round(textTokens(turn.userText) + textTokens(turn.replyText))))
  if (chars.length <= MAX_TURN_SAMPLES) return { turnChars: chars, turnTokens: tokens, turnCharsOffset: 0 }
  return {
    turnChars: chars.slice(chars.length - MAX_TURN_SAMPLES),
    turnTokens: tokens.slice(tokens.length - MAX_TURN_SAMPLES),
    turnCharsOffset: chars.length - MAX_TURN_SAMPLES,
  }
}

/** Pick the dictionary for one locale id; Chinese is the default. */
function noticeDictionary(locale) {
  const tag = typeof locale === 'string' ? locale.toLowerCase() : ''
  return tag.startsWith('en') ? NOTICES.en : NOTICES.zh
}

/** Fill `{name}` placeholders in one notice string. */
function fillNotice(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (
    params[key] === undefined || params[key] === null ? '' : String(params[key])
  ))
}

/**
 * Collapse whitespace and cut text to a UTF-8 byte budget (the shipped
 * session-title service refuses anything longer, 80 bytes by default).
 * @param text - the candidate title.
 * @param maxBytes - the byte budget.
 * @returns the fitted title.
 */
export function fitBytes(text, maxBytes = 80) {
  const collapsed = String(text).replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0 || maxBytes <= 0) return ''
  let out = ''
  let bytes = 0
  for (const character of collapsed) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    out += character
    bytes += size
  }
  return out.trim()
}

/**
 * Append the slimming suffix while keeping the whole title inside the byte
 * budget: the base is cut first so the suffix always survives.
 * @param title - the original conversation title.
 * @param suffix - the localized suffix.
 * @param fallback - the title used when the original is empty.
 * @param maxBytes - the byte budget.
 * @returns the fitted title.
 */
export function titleWithSuffix(title, suffix, fallback, maxBytes = 80) {
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  const base = fitBytes(title.trim() === '' ? fallback : title, Math.max(0, maxBytes - suffixBytes))
  if (base === '') return fitBytes(suffix, maxBytes)
  return base + suffix
}

// ── pending uploads (one at a time, like the shipped importer) ──────────────

/** The single archive a `build` call may still read. */
let pendingUpload

/** Drop the pending archive. */
function clearPending() {
  pendingUpload = undefined
}

/**
 * Summarize every conversation an archive lists, newest first.
 * @param buffer - archive bytes.
 * @returns the conversations the picker offers.
 * @throws {SlimError} for an unreadable container, manifest, or index.
 */
export function summarizeArchive(buffer) {
  const entries = readZipIndex(buffer)
  const manifestEntry = entries.get(MANIFEST_ENTRY)
  if (manifestEntry === undefined) throw new SlimError('missing-manifest', 'the archive has no manifest.json')
  readManifest(readZipEntry(buffer, manifestEntry))
  const indexEntry = entries.get(INDEX_ENTRY)
  if (indexEntry === undefined) throw new SlimError('missing-index', 'the archive has no chat_session_index.json')
  const rows = readIndex(readZipEntry(buffer, indexEntry))
  const conversations = []
  for (const row of rows.slice(0, MAX_PREVIEW_CONVERSATIONS)) {
    const entryName = conversationEntryName(row.id)
    const entry = entries.get(entryName)
    if (entry === undefined) continue
    let conversation
    try {
      conversation = parseConversation(readZipEntry(buffer, entry), entryName)
    }
    catch (error) {
      if (error instanceof SlimError) continue
      throw error
    }
    const chain = selectBranch(conversation)
    const turns = conversationTurns(chain)
    const turnChars = turnCharsOf(turns)
    conversations.push({
      id: row.id,
      title: (row.title.trim() !== '' ? row.title : conversation.title).trim(),
      turns: turns.length,
      estTokens: turnTokens(turns),
      updatedAt: new Date(row.updatedAt).toISOString(),
      turnChars: turnChars.turnChars,
      turnTokens: turnChars.turnTokens,
      turnCharsOffset: turnChars.turnCharsOffset,
    })
  }
  if (conversations.length === 0) throw new SlimError('no-conversations', 'the archive has no readable conversation')
  return { entries, conversations, total: rows.length }
}

/**
 * Build the slimmed single-conversation export archive.
 * @param buffer - the uploaded archive bytes.
 * @param entryName - the chosen conversation entry name.
 * @param keepTurns - USER turns to keep, counted from the newest.
 * @param locale - locale id choosing the notice language and title suffix.
 * @param note - optional USER text inserted as the archive's first message.
 * @param amplifySummary - optional summary of the discarded turns; replaces the note.
 * @returns the new archive bytes plus its summary.
 * @throws {SlimError} for an unknown entry or a conversation with no USER turn.
 */
export function buildSlimArchive(buffer, entryName, keepTurns, locale, note, amplifySummary) {
  const entries = readZipIndex(buffer)
  const entry = entries.get(entryName)
  if (entry === undefined) throw new SlimError('unknown-conversation', `the archive has no entry ${entryName}`)
  const conversation = parseConversation(readZipEntry(buffer, entry), entryName)
  const turns = conversationTurns(selectBranch(conversation))
  if (turns.length === 0) throw new SlimError('empty-conversation', 'the conversation has no user turn')
  const keep = Math.max(1, Math.min(Math.floor(keepTurns), turns.length))
  const kept = turns.slice(turns.length - keep)
  const removed = turns.length - kept.length
  const dictionary = noticeDictionary(locale)
  const title = titleWithSuffix(conversation.title, dictionary.suffix, dictionary.untitled)
  const baseTime = exportTime(kept[0].insertedAt, Date.now())
  const messages = []
  let parentId = null
  const push = (role, text, at) => {
    const id = messages.length + 1
    const fragmentType = role === 'USER' ? 'REQUEST' : 'RESPONSE'
    messages.push({
      id,
      parent_id: parentId,
      role,
      status: 'FINISHED',
      inserted_at: new Date(at).toISOString(),
      fragments: [{ type: fragmentType, content: text }],
    })
    parentId = id
    return id
  }
  let at = baseTime - 2
  const noteText = typeof note === 'string' ? note.trim() : ''
  const summaryText = typeof amplifySummary === 'string' ? amplifySummary.trim() : ''
  if (summaryText !== '') {
    // Amplify mode: the summary replaces the bare marker, so the revived session
    // starts with what the discarded turns said rather than a count.
    push('USER', `${dictionary.summaryHeader}\n\n${summaryText}`, at)
    at += 1
    push('ASSISTANT', fillNotice(dictionary.ack, { removed: String(removed), kept: String(kept.length), title }), at)
    at += 1
  }
  else if (noteText !== '') {
    const params = { removed: String(removed), kept: String(kept.length), title }
    push('USER', noteText, at)
    at += 1
    // The note is a synthetic marker, so it is acknowledged explicitly: the
    // shipped importer closes a USER turn that has no reply as a failed turn.
    push('ASSISTANT', fillNotice(dictionary.ack, params), at)
    at += 1
  }
  for (const turn of kept) {
    const time = exportTime(turn.insertedAt, at)
    at = Math.max(at, time)
    push('USER', turn.userText, at)
    if (turn.replyText.trim() !== '') {
      at += 1
      push('ASSISTANT', turn.replyText, at)
    }
    at += 1
  }
  const conversationFile = {
    id: conversation.id,
    title,
    inserted_at: new Date(baseTime).toISOString(),
    current_message_id: messages.length,
    messages,
  }
  const now = new Date().toISOString()
  const manifest = { export_format_version: SUPPORTED_EXPORT_FORMAT_VERSION }
  const index = [{ id: conversation.id, inserted_at: now, updated_at: now, title }]
  const files = [
    { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: INDEX_ENTRY, data: Buffer.from(JSON.stringify(index, null, 2), 'utf8') },
    { name: conversationEntryName(conversation.id), data: Buffer.from(JSON.stringify(conversationFile, null, 2), 'utf8') },
  ]
  return {
    zip: buildZip(files),
    conversationId: conversation.id,
    title,
    keptTurns: kept.length,
    removedTurns: removed,
    totalTurns: turns.length,
    estTokens: turnTokens(kept),
    fileName: `deepseek_data-slim-${conversation.id}.zip`,
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

/**
 * Route handler: `POST /dsh-session-slim/preview`.
 * @param ctx - host context.
 * @returns the Node request handler.
 */
export function previewHandler(ctx) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    const mediaType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (mediaType !== 'application/octet-stream' && mediaType !== 'application/zip') {
      sendJson(response, 415, { ok: false, code: 'bad-request', error: 'content type must be application/octet-stream' })
      return
    }
    let body
    try {
      body = await readBoundedBody(request, MAX_ARCHIVE_BYTES)
    }
    catch (error) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: String(error?.message ?? error) })
      return
    }
    if (body === undefined) {
      sendJson(response, 413, { ok: false, code: 'too-large', error: `the archive exceeds ${MAX_ARCHIVE_BYTES} bytes` })
      return
    }
    let summary
    try {
      summary = summarizeArchive(body)
    }
    catch (error) {
      if (error instanceof SlimError) {
        sendJson(response, 200, { ok: false, code: error.code, error: error.message })
        return
      }
      warn(ctx, 'preview failed', error)
      sendJson(response, 200, { ok: false, code: 'unreadable-archive', error: String(error?.message ?? error) })
      return
    }
    clearPending()
    const uploadId = randomUUID()
    pendingUpload = { id: uploadId, at: Date.now(), buffer: body, entries: summary.entries }
    sendJson(response, 200, {
      ok: true,
      version,
      uploadId,
      total: summary.total,
      omitted: Math.max(0, summary.total - summary.conversations.length),
      limits: {
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        historyBudgetTokens: HISTORY_BUDGET_TOKENS,
        recommendTurns: RECOMMEND_TURNS,
        maxKeepTurns: MAX_KEEP_TURNS,
      },
      conversations: summary.conversations,
    })
  }
}

/**
 * Route handler: `POST /dsh-session-slim/build`.
 * @param ctx - host context.
 * @param runner - the amplify runner, which must not be mid-run: two writers racing
 *   on the same session store is what emptied the session list once already.
 * @returns the Node request handler.
 */
export function buildHandler(ctx, runner) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    if (runner !== undefined && runner.isActive()) {
      sendJson(response, 409, {
        ok: false,
        code: 'amplify-busy',
        error: 'an amplify run is in progress; wait for it or cancel it before building',
      })
      return
    }
    let body
    try {
      body = await readBoundedBody(request, MAX_BUILD_JSON_BYTES)
    }
    catch (error) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: String(error?.message ?? error) })
      return
    }
    if (body === undefined) {
      sendJson(response, 413, { ok: false, code: 'too-large', error: `the request exceeds ${MAX_BUILD_JSON_BYTES} bytes` })
      return
    }
    let params
    try {
      params = JSON.parse(body.toString('utf8'))
    }
    catch (error) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: String(error?.message ?? error) })
      return
    }
    const uploadId = isRecord(params) ? params.uploadId : undefined
    const conversationId = isRecord(params) ? params.conversationId : undefined
    const keepTurns = isRecord(params) ? params.keepTurns : undefined
    const locale = isRecord(params) ? params.locale : undefined
    const note = isRecord(params) ? params.note : undefined
    const amplifySummary = isRecord(params) ? params.amplifySummary : undefined
    if (amplifySummary !== undefined && typeof amplifySummary !== 'string') {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'amplifySummary must be a string' })
      return
    }
    if (typeof amplifySummary === 'string' && amplifySummary.length > 400_000) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'amplifySummary is longer than 400000 characters' })
      return
    }
    if (note !== undefined && typeof note !== 'string') {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'note must be a string' })
      return
    }
    if (typeof note === 'string' && note.length > 20000) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'note is longer than 20000 characters' })
      return
    }
    if (typeof uploadId !== 'string' || uploadId === '') {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'uploadId must be a non-empty string' })
      return
    }
    if (typeof conversationId !== 'string' || conversationId === '') {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'conversationId must be a non-empty string' })
      return
    }
    if (typeof keepTurns !== 'number' || !Number.isSafeInteger(keepTurns) || keepTurns < 1) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'keepTurns must be a positive integer' })
      return
    }
    if (pendingUpload === undefined || pendingUpload.id !== uploadId) {
      sendJson(response, 409, { ok: false, code: 'expired-upload', error: 'the uploaded archive is no longer available; upload it again' })
      return
    }
    if (Date.now() - pendingUpload.at > PENDING_TTL_MS) {
      clearPending()
      sendJson(response, 409, { ok: false, code: 'expired-upload', error: 'the uploaded archive expired; upload it again' })
      return
    }
    try {
      const result = buildSlimArchive(
        pendingUpload.buffer,
        conversationEntryName(conversationId),
        keepTurns,
        locale,
        note,
        amplifySummary,
      )
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(result.zip.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-dsh-slim-conversation-id': encodeURIComponent(result.conversationId),
        'x-dsh-slim-title': encodeURIComponent(result.title),
        'x-dsh-slim-filename': encodeURIComponent(result.fileName),
        'x-dsh-slim-kept-turns': String(result.keptTurns),
        'x-dsh-slim-removed-turns': String(result.removedTurns),
        'x-dsh-slim-est-tokens': String(result.estTokens),
      })
      response.end(result.zip)
    }
    catch (error) {
      if (error instanceof SlimError) {
        const status = error.code === 'unknown-conversation' ? 404 : error.code === 'empty-conversation' ? 409 : 400
        sendJson(response, status, { ok: false, code: error.code, error: error.message })
        return
      }
      warn(ctx, 'build failed', error)
      sendJson(response, 500, { ok: false, code: 'build-failed', error: String(error?.message ?? error) })
    }
  }
}

// ── scans of the user's own folders ────────────────────────────────────────

/** Folders searched for exports the user already downloaded. */
function scanRoots() {
  const home = homedir()
  return [
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
  ]
}

/** Cached scan: ids resolve to absolute paths, and expire with the upload window. */
let scanCache = { at: 0, byId: new Map() }

/** Drop the cached scan. */
function clearScan() {
  scanCache = { at: 0, byId: new Map() }
}

/**
 * List DeepSeek export archives already present in the user's own folders.
 * Nothing leaves the machine: this only stats filenames that match the export shape.
 * @returns candidate descriptors, newest modification first.
 */
export function scanExportFiles() {
  const byId = new Map()
  const candidates = []
  for (const root of scanRoots()) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    }
    catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SCAN_PATTERN.test(entry.name)) continue
      const full = resolve(root, entry.name)
      let stat
      try {
        stat = statSync(full)
      }
      catch {
        continue
      }
      const id = createHash('sha1').update(full).digest('hex').slice(0, 16)
      byId.set(id, full)
      candidates.push({ id, name: entry.name, size: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() })
    }
  }
  candidates.sort((left, right) => (left.modifiedAt < right.modifiedAt ? 1 : -1))
  scanCache = { at: Date.now(), byId }
  return candidates.slice(0, MAX_CANDIDATES)
}

/**
 * Route handler: `POST /dsh-session-slim/scan`.
 * @param ctx - Host context.
 * @returns the Node request handler.
 */
export function scanHandler(ctx) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    try {
      sendJson(response, 200, { ok: true, candidates: scanExportFiles() })
    }
    catch (error) {
      warn(ctx, 'scan failed', error)
      sendJson(response, 200, { ok: false, code: 'scan-failed', error: String(error?.message ?? error) })
    }
  }
}

/**
 * Route handler: `POST /dsh-session-slim/scan-open`.
 * @param ctx - Host context.
 * @returns the Node request handler.
 */
export function openHandler(ctx) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    let body
    try {
      body = await readBoundedBody(request, MAX_JSON_BYTES)
    }
    catch (error) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: String(error?.message ?? error) })
      return
    }
    let id
    try {
      id = JSON.parse(body.toString('utf8')).id
    }
    catch {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'the request is not valid JSON' })
      return
    }
    if (typeof id !== 'string' || id === '') {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'id must be a non-empty string' })
      return
    }
    if (scanCache.at === 0 || Date.now() - scanCache.at > SCAN_TTL_MS) {
      sendJson(response, 409, { ok: false, code: 'expired-scan', error: 'the folder scan expired; scan again' })
      return
    }
    const full = scanCache.byId.get(id)
    if (full === undefined) {
      sendJson(response, 404, { ok: false, code: 'unknown-file', error: 'that file is not part of the last scan' })
      return
    }
    // Re-validate: the path must still be directly inside one of the scanned roots,
    // so a tampered id can never reach outside them.
    const name = basename(full)
    const inside = scanRoots().some((root) => full === resolve(root, name))
    if (!inside || !SCAN_PATTERN.test(name)) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'the file is outside the scanned folders' })
      return
    }
    let buffer
    let size
    try {
      const stat = statSync(full)
      if (stat.size > MAX_ARCHIVE_BYTES) {
        sendJson(response, 413, { ok: false, code: 'too-large', error: `the archive exceeds ${MAX_ARCHIVE_BYTES} bytes` })
        return
      }
      size = stat.size
      buffer = readFileSync(full)
    }
    catch (error) {
      sendJson(response, 404, { ok: false, code: 'unknown-file', error: String(error?.message ?? error) })
      return
    }
    let summary
    try {
      summary = summarizeArchive(buffer)
    }
    catch (error) {
      if (error instanceof SlimError) {
        sendJson(response, 200, { ok: false, code: error.code, error: error.message })
        return
      }
      warn(ctx, 'scan-open failed', error)
      sendJson(response, 200, { ok: false, code: 'unreadable-archive', error: String(error?.message ?? error) })
      return
    }
    clearPending()
    const uploadId = randomUUID()
    pendingUpload = { id: uploadId, at: Date.now(), buffer, entries: summary.entries }
    sendJson(response, 200, {
      ok: true,
      version,
      uploadId,
      from: { name, size },
      total: summary.total,
      omitted: Math.max(0, summary.total - summary.conversations.length),
      limits: {
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        historyBudgetTokens: HISTORY_BUDGET_TOKENS,
        recommendTurns: RECOMMEND_TURNS,
        maxKeepTurns: MAX_KEEP_TURNS,
      },
      conversations: summary.conversations,
    })
  }
}

// ── amplify routes ──────────────────────────────────────────────────────────

/** Read a JSON request body, answering the refusal itself when unusable. */
async function readJsonBody(request, response) {
  let body
  try {
    body = await readBoundedBody(request, MAX_JSON_BYTES)
  }
  catch (error) {
    sendJson(response, 400, { ok: false, code: 'bad-request', error: String(error?.message ?? error) })
    return undefined
  }
  try {
    return JSON.parse(body.toString('utf8'))
  }
  catch {
    sendJson(response, 400, { ok: false, code: 'bad-request', error: 'the request is not valid JSON' })
    return undefined
  }
}

/** The pending upload, or a refusal already sent. */
function requirePending(response) {
  if (pendingUpload === undefined) {
    sendJson(response, 409, { ok: false, code: 'expired-upload', error: 'upload the archive again' })
    return undefined
  }
  if (Date.now() - pendingUpload.at > PENDING_TTL_MS) {
    clearPending()
    sendJson(response, 409, { ok: false, code: 'expired-upload', error: 'the uploaded archive expired; upload it again' })
    return undefined
  }
  return pendingUpload
}

/**
 * Read the chosen conversation and split its dropped turns into segments.
 * Parsing one conversation means inflating and JSON-parsing a large archive, so the
 * result is cached: `plan`/`start`/`build` all ask for the same thing in one flow, and
 * doing that work three times blocked the host event loop (which emptied the sidebar).
 * @param buffer - the archive bytes.
 * @param entryName - conversation entry name.
 * @param keepTurns - turns to keep.
 * @returns plan with `kept`, `dropped`, `chunks`, `chars`, `tokens`; the plan route
 *   re-labels `chunks` as `segments` for the browser.
 * @throws {SlimError} for an unknown or empty conversation.
 */
export function planAmplify(buffer, entryName, keepTurns) {
  const cacheKey = `${entryName}#${keepTurns}`
  if (planCache !== undefined && planCache.key === cacheKey && planCache.buffer === buffer) {
    return planCache.plan
  }
  const entries = readZipIndex(buffer)
  const entry = entries.get(entryName)
  if (entry === undefined) throw new SlimError('unknown-conversation', 'the archive has no such conversation')
  const conversation = parseConversation(readZipEntry(buffer, entry), entryName)
  const turns = conversationTurns(selectBranch(conversation))
  if (turns.length === 0) throw new SlimError('empty-conversation', 'the conversation has no USER turn')
  const keep = Math.max(1, Math.min(keepTurns, turns.length))
  const dropped = turns.slice(0, turns.length - keep)
  const chunks = chunkTurns(dropped)
  const chars = dropped.reduce((sum, turn) => sum + turn.chars, 0)
  // No `tokens` here on purpose. The amplify cost is dominated by reading every chunk into
  // one context, where each read re-bills everything read before it — measured runs came in
  // 5x the naive "source size" estimate. A number that far off is worse than no number.
  const plan = {
    turns,
    kept: turns.length - dropped.length,
    dropped,
    chunks,
    chars,
    title: conversation.title,
  }
  planCache = { key: cacheKey, buffer, plan }
  return plan
}

/** One-entry plan cache, keyed by entry name, keep count, and archive identity. */
let planCache

/**
 * Route handler: `POST /dsh-session-slim/amplify/plan`.
 * @param ctx - Host context.
 * @returns the Node request handler.
 */
export function amplifyPlanHandler(ctx) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    const pending = requirePending(response)
    if (pending === undefined) return
    const params = await readJsonBody(request, response)
    if (params === undefined) return
    const conversationId = isRecord(params) ? params.conversationId : undefined
    const keepTurns = isRecord(params) ? params.keepTurns : undefined
    if (typeof conversationId !== 'string' || conversationId === '') {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'conversationId must be a non-empty string' })
      return
    }
    if (typeof keepTurns !== 'number' || !Number.isSafeInteger(keepTurns) || keepTurns < 1) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'keepTurns must be a positive integer' })
      return
    }
    try {
      const plan = planAmplify(pending.buffer, conversationEntryName(conversationId), keepTurns)
      sendJson(response, 200, {
        ok: true,
        removedTurns: plan.dropped.length,
        keptTurns: plan.kept,
        chars: plan.chars,
        segments: plan.chunks.map((chunk) => ({
          index: chunk.index, turns: chunk.turns, chars: chunk.chars,
        })),
      })
    }
    catch (error) {
      if (error instanceof SlimError) {
        sendJson(response, 400, { ok: false, code: error.code, error: error.message })
        return
      }
      warn(ctx, 'amplify plan failed', error)
      sendJson(response, 500, { ok: false, code: 'build-failed', error: String(error?.message ?? error) })
    }
  }
}

/**
 * Route handler: `POST /dsh-session-slim/amplify/start`.
 * @param ctx - Host context.
 * @param runner - the amplify runner.
 * @returns the Node request handler.
 */
export function amplifyStartHandler(ctx, runner) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    const pending = requirePending(response)
    if (pending === undefined) return
    const params = await readJsonBody(request, response)
    if (params === undefined) return
    const conversationId = isRecord(params) ? params.conversationId : undefined
    const keepTurns = isRecord(params) ? params.keepTurns : undefined
    const workspaceId = isRecord(params) ? params.workspaceId : undefined
    const locale = isRecord(params) ? params.locale : undefined
    const model = isRecord(params) ? params.model : undefined
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'workspaceId must be a non-empty string' })
      return
    }
    // Same validation the plan route applies: without it a missing or bogus keepTurns
    // produces NaN, empty chunks, and a summary session that occupies the slot for nothing.
    if (typeof conversationId !== 'string' || !SAFE_CONVERSATION_ID.test(conversationId)) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'conversationId must be a plain conversation id' })
      return
    }
    if (typeof keepTurns !== 'number' || !Number.isFinite(keepTurns)) {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'keepTurns must be a number' })
      return
    }
    let plan
    try {
      plan = planAmplify(pending.buffer, conversationEntryName(conversationId), keepTurns)
    }
    catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: error instanceof SlimError ? error.code : 'build-failed',
        error: String(error?.message ?? error),
      })
      return
    }
    if (!Array.isArray(plan.chunks) || plan.chunks.length === 0) {
      sendJson(response, 400, { ok: false, code: 'nothing-to-summarize', error: 'no turn would be removed, so there is nothing to summarize' })
      return
    }
    try {
      const started = runner.start({
        workspaceId,
        locale,
        model,
        title: plan.title,
        dropped: plan.dropped,
        removedTurns: plan.dropped.length,
        chunks: plan.chunks,
      })
      sendJson(response, 200, { ok: true, ...started })
    }
    catch (error) {
      const code = String(error?.message ?? error)
      const status = code === 'amplify-busy' ? 409 : code === 'amplify-write-failed' || code === 'amplify-no-workspace' ? 400 : 501
      sendJson(response, status, { ok: false, code, error: code })
    }
  }
}

/**
 * Route handler: `POST /dsh-session-slim/amplify/status`.
 * @param runner - the amplify runner.
 * @returns the Node request handler.
 */
export function amplifyStatusHandler(runner) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    sendJson(response, 200, { ok: true, ...runner.status() })
  }
}

/**
 * Route handler: `POST /dsh-session-slim/amplify/decide` — answer a parked run.
 * @param runner - the amplify runner.
 * @returns the Node request handler.
 */
export function amplifyDecideHandler(runner) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    const params = await readJsonBody(request, response)
    if (params === undefined) return
    const decision = isRecord(params) ? params.decision : undefined
    if (decision !== 'continue' && decision !== 'cancel' && decision !== 'without') {
      sendJson(response, 400, { ok: false, code: 'bad-request', error: 'decision must be continue, cancel, or without' })
      return
    }
    sendJson(response, 200, { ok: true, ...runner.decide(decision) })
  }
}

/**
 * Route handler: `POST /dsh-session-slim/amplify/cancel`.
 * @param runner - the amplify runner.
 * @returns the Node request handler.
 */
export function amplifyCancelHandler(runner) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    sendJson(response, 200, { ok: true, ...runner.cancel() })
  }
}

/** Directory (inside the workspace) that keeps the archived original turns. */
const HISTORY_DIR = '.dsh-revive'
/** Index file name inside `HISTORY_DIR`. */
const HISTORY_INDEX = '索引.md'
/** Largest character count one archive page may carry. */
const HISTORY_PAGE_CHARS = 8000

/**
 * Render one dropped turn for the archive.
 * @param index - 1-based turn number within the dropped range.
 * @param turn - `{ userText, replyText }`.
 * @param locale - `zh` or `en`.
 * @returns the markdown block.
 */
function renderHistoryTurn(index, turn, locale) {
  const userLabel = locale === 'en' ? 'User' : '用户'
  const replyLabel = locale === 'en' ? 'Assistant' : '助手'
  const heading = locale === 'en' ? `### Turn ${index}` : `### 第 ${index} 轮`
  const parts = [heading]
  const user = typeof turn?.userText === 'string' ? turn.userText.trim() : ''
  const reply = typeof turn?.replyText === 'string' ? turn.replyText.trim() : ''
  if (user !== '') parts.push(`**${userLabel}**：${user}`)
  if (reply !== '') parts.push(`**${replyLabel}**：${reply}`)
  return parts.join('\n\n')
}

/**
 * A one-line hint for an index row: the two longest user texts on that page.
 * One first sentence rarely says what a page is about; two of the longest usually do.
 */
function historyHint(page) {
  const texts = page
    .map(item => String(item.turnText ?? '').replace(/\s+/g, ' ').trim())
    .filter(text => text !== '')
    .sort((left, right) => right.length - left.length)
    .slice(0, 2)
  if (texts.length === 0) return ''
  return texts.map(text => `「${text.slice(0, 20)}${text.length > 20 ? '…' : ''}」`).join(' ')
}

/**
 * Workspace-scoped scratch files for one amplify run.
 * The chunks go inside the workspace so the summary agent can read them with its own
 * tools; the directory is removed as soon as the run settles.
 */
/**
 * Write the paged archive files and the index into an already-created directory.
 * @param dirAbsolute - absolute path of the `history-<id>` directory.
 * @param name - that directory's name, used to build the relative paths.
 * @param title - original conversation title, recorded in the index header.
 * @param turns - dropped turns, oldest first.
 * @param locale - `zh` or `en`.
 * @returns `{ indexRelative, dirRelative, pages }`.
 */
function writeHistoryPages(dirAbsolute, name, title, turns, locale) {
  const pages = []
  let current = []
  let chars = 0
  for (let i = 0; i < turns.length; i += 1) {
    const block = renderHistoryTurn(i + 1, turns[i], locale)
    if (current.length > 0 && chars + block.length > HISTORY_PAGE_CHARS) {
      pages.push(current)
      current = []
      chars = 0
    }
    current.push({ turn: i + 1, block, turnText: String(turns[i]?.userText ?? '') })
    chars += block.length
  }
  if (current.length > 0) pages.push(current)

  const pagePreamble = locale === 'en'
    ? '> These are the words of your own earlier conversation with this person.\n> Recall them; do not look them up like an external archive.\n\n'
    : '> 这是你和这个人过去的对话原话，是你自己的记忆，不是外部资料库。\n> 回忆它，别当成查别人的档案。\n\n'

  const indexLines = []
  pages.forEach((page, index) => {
    const fileName = `part-${String(index + 1).padStart(2, '0')}.md`
    const pageChars = page.reduce((sum, item) => sum + item.block.length, 0)
    const body = `${pagePreamble}${page.map(item => item.block).join('\n\n')}\n`
    writeFileSync(join(dirAbsolute, fileName), body, 'utf8')
    const first = page[0].turn
    const last = page[page.length - 1].turn
    // A single turn longer than the page budget gets a page of its own; flag it so a
    // reader knows that page costs more than the usual few thousand tokens.
    const oversized = pageChars > HISTORY_PAGE_CHARS ? `  ⚠ 超长 ${pageChars} 字符` : ''
    indexLines.push(`- ${fileName}  轮次 ${first}–${last}  ${historyHint(page)}${oversized}`)
  })

  const header = locale === 'en'
    ? [
      '# Our earlier conversation (archive)',
      `Title: ${title}`,
      `Dropped turns: ${turns.length}, split into ${pages.length} page(s)`,
      '',
      'These are the actual words from your own earlier conversation with this person.',
      'They are your memory, not an external database: recall them, do not look them up.',
      '',
      'To find one topic, search this directory for a keyword first;',
      'read part-NN.md only for the page a search points at. Read this index for the overview.',
      '',
    ]
    : [
      '# 我们之前的对话（存档）',
      `会话：${title}`,
      `被删轮次：${turns.length} 轮，分为 ${pages.length} 片`,
      '',
      '下面是你们过去的对话原话。这是你自己的记忆，不是外部资料库 ——',
      '回忆它，别当成查别人的档案。',
      '',
      '要找某件具体的事，先在这个目录里搜索关键词，命中哪个 part-NN.md 再读那一片；',
      '这张索引只用来先看整体结构。',
      '',
    ]
  writeFileSync(join(dirAbsolute, HISTORY_INDEX), `${[...header, ...indexLines].join('\n')}\n`, 'utf8')
  return {
    indexRelative: `${HISTORY_DIR}/${name}/${HISTORY_INDEX}`,
    dirRelative: `${HISTORY_DIR}/${name}`,
    pages: pages.length,
  }
}

export const amplifyFiles = {
  /**
   * Write the chunk files and report where they landed.
   * @param workspacePath - absolute path of the chosen workspace.
   * @param chunks - chunk payloads from `chunkTurns`.
   * @returns `{ dirAbsolute, dirRelative }`.
   */
  write(workspacePath, chunks) {
    const name = `summary-${Date.now().toString(36)}`
    const dirAbsolute = join(workspacePath, '.dsh-slim', name)
    mkdirSync(dirAbsolute, { recursive: true })
    try {
      for (const chunk of chunks) {
        const file = `part-${String(chunk.index + 1).padStart(2, '0')}.md`
        writeFileSync(join(dirAbsolute, file), chunk.text, 'utf8')
      }
    }
    catch (error) {
      // A half-written directory holds the dropped turns, so it must not survive the
      // failure: nothing references it yet, so clean it up right here.
      try {
        rmSync(dirAbsolute, { recursive: true, force: true })
      }
      catch {
        /* best effort */
      }
      throw error
    }
    return { dirAbsolute, dirRelative: `.dsh-slim/${name}` }
  },
  /**
   * Archive the dropped turns as paged files plus an index.
   *
   * The index costs a couple of KB and one page a few thousand tokens, so a revived
   * session can look up the original wording on demand instead of carrying the whole
   * archive in its context. Nothing here calls a model.
   * @param workspacePath - absolute path of the workspace.
   * @param options - `{ title, turns, locale }`.
   * @returns `{ indexRelative, pages }`, or undefined when there is nothing to archive.
   */
  writeHistory(workspacePath, options) {
    const { title, turns, locale } = options
    if (typeof workspacePath !== 'string' || workspacePath === '') return undefined
    if (!Array.isArray(turns) || turns.length === 0) return undefined
    const name = `history-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const dirAbsolute = join(workspacePath, HISTORY_DIR, name)
    mkdirSync(dirAbsolute, { recursive: true })
    try {
      return writeHistoryPages(dirAbsolute, name, title, turns, locale)
    }
    catch (error) {
      // A partial archive with no index is worse than none: a reader would see pages and
      // no map. Nothing references this directory yet, so remove it here.
      try {
        rmSync(dirAbsolute, { recursive: true, force: true })
      }
      catch {
        /* best effort */
      }
      throw error
    }
  },
  /**
   * Read the note the agent was asked to write.
   * @param dirAbsolute - the scratch directory.
   * @returns the note, or undefined when the agent did not write one.
   */
  read(dirAbsolute) {
    try {
      return readFileSync(join(dirAbsolute, 'SUMMARY.md'), 'utf8')
    }
    catch {
      return undefined
    }
  },
  /**
   * Append one line to the run log, which survives cleanup for diagnosis.
   * @param workspacePath - absolute path of the workspace.
   * @param line - the text to append.
   */
  trace(workspacePath, line) {
    if (typeof workspacePath !== 'string' || workspacePath === '') return
    try {
      const dir = join(workspacePath, '.dsh-slim')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'last-run.log')
      const stat = existsSync(file) ? statSync(file) : undefined
      // keep it small: start over once it passes 256 KiB
      if (stat !== undefined && stat.size > 262144) rmSync(file, { force: true })
      writeFileSync(file, line + '\n', { flag: 'a' })
    }
    catch {
      /* diagnostics are best effort */
    }
  },
  /**
   * Delete the scratch directory.
   * @param dirAbsolute - the scratch directory.
   */
  cleanup(dirAbsolute) {
    try {
      rmSync(dirAbsolute, { recursive: true, force: true })
    }
    catch {
      /* leaving a scratch directory behind is harmless */
    }
  },
}

/**
 * Register the routes on the harness web server, which may be acquired later.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  // Amplified sessions get their summary as a scoped system-prompt section, so the model
  // reads it as background instead of as a fresh user message. See summary-prompt.js.
  const headers = [NOTICES.zh.summaryHeader, NOTICES.en.summaryHeader]
  installSummaryPrompt(ctx, {
    headers,
    warn: (message, error) => { warn(ctx, message, error) },
  })
  // Amplified sessions also get `history_search`, so they can look up the dropped turns
  // by keyword instead of reading whole archive pages. See history-tool.js.
  installHistoryTool(ctx, {
    headers,
    warn: (message, error) => { warn(ctx, message, error) },
  })
  // The summary session is read back after the run so the plugin can tell whether it really
  // read every chunk. Captured once here because `ctx.get()` is not available later.
  let sessionsService
  ctx.inject(['sessions'], (sub) => {
    sessionsService = sub.get('sessions')
  })
  const runner = createAmplifyRunner({
    getController: () => ctx.get('sessionController'),
    getSession: (id) => {
      if (sessionsService === undefined || typeof sessionsService.get !== 'function') return undefined
      try {
        return sessionsService.get(id)
      }
      catch {
        return undefined
      }
    },
    getWorkspacePath: (workspaceId) => {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.get !== 'function') return undefined
      const workspace = registry.get(workspaceId)
      if (workspace === undefined || workspace === null) return undefined
      return typeof workspace.path === 'string' ? workspace.path : undefined
    },
    files: amplifyFiles,
    warn: (message, error) => { warn(ctx, message, error) },
  })
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [
        host.webServer.register({ kind: 'exact', path: PREVIEW_ROUTE, handler: previewHandler(ctx) }),
        host.webServer.register({ kind: 'exact', path: BUILD_ROUTE, handler: buildHandler(ctx, runner) }),
        host.webServer.register({ kind: 'exact', path: SCAN_ROUTE, handler: scanHandler(ctx) }),
        host.webServer.register({ kind: 'exact', path: OPEN_ROUTE, handler: openHandler(ctx) }),
        host.webServer.register({ kind: 'exact', path: AMPLIFY_PLAN_ROUTE, handler: amplifyPlanHandler(ctx) }),
        host.webServer.register({ kind: 'exact', path: AMPLIFY_START_ROUTE, handler: amplifyStartHandler(ctx, runner) }),
        host.webServer.register({ kind: 'exact', path: AMPLIFY_STATUS_ROUTE, handler: amplifyStatusHandler(runner) }),
        host.webServer.register({ kind: 'exact', path: AMPLIFY_CANCEL_ROUTE, handler: amplifyCancelHandler(runner) }),
        host.webServer.register({ kind: 'exact', path: AMPLIFY_DECIDE_ROUTE, handler: amplifyDecideHandler(runner) }),
      ]
      return () => {
        runner.dispose()
        clearPending()
        clearScan()
        for (const dispose of disposers) dispose()
      }
    }, 'session-slim: http routes')
  })
}
