/**
 * dsh-session-slim — browser half.
 *
 * A three-step wizard mounted in the `sidebar.session.action` slot, beside the
 * New-session row:
 *
 *   1. upload a DeepSeek export ZIP (`deepseek_data-*.zip`);
 *   2. pick one conversation from it (searchable, newest first, conversations
 *      over the history budget marked as needing slimming);
 *   3. choose how many recent turns to keep, add an optional note, generate.
 *
 * The Host rebuilds the archive; this module then hands it to the shipped
 * DeepSeek-import pipeline (`POST api/deepseek-chat-import/archive`) and, when
 * that pipeline is not installed, downloads the ZIP instead.
 *
 * Only `react` is required from the browser module table. Controls are
 * hand-written (no Harness Client package is imported) and styled with theme
 * variables only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-revive-love',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dshSessionSlim'
    /**
     * Host routes are registered as exact absolute paths on the page's own
     * origin, so they are called by absolute path. The shipped import route
     * stays relative to `document.baseURI` exactly as its own client calls it.
     */
    const PREVIEW_ROUTE = '/dsh-session-slim/preview'
    const BUILD_ROUTE = '/dsh-session-slim/build'
    /** Folder scan of exports the user already downloaded, and loading one of them. */
    const SCAN_ROUTE = '/dsh-session-slim/scan'
    const OPEN_ROUTE = '/dsh-session-slim/scan-open'
    /** Amplify mode: plan, run, poll, cancel. */
    const AMPLIFY_PLAN_ROUTE = '/dsh-session-slim/amplify/plan'
    const AMPLIFY_START_ROUTE = '/dsh-session-slim/amplify/start'
    const AMPLIFY_STATUS_ROUTE = '/dsh-session-slim/amplify/status'
    const AMPLIFY_CANCEL_ROUTE = '/dsh-session-slim/amplify/cancel'
    const AMPLIFY_DECIDE_ROUTE = '/dsh-session-slim/amplify/decide'
    /** Forced-recall switch, read and written for the conversation in view. */
    const FORCE_ROUTE = '/dsh-session-slim/force-recall'
    /** What the last turn's recall actually did; shown in the mode panel. */
        /** The shipped import action's upload route (its `protocol.ts` UPLOAD_ROUTE). */
    const IMPORT_ROUTE = 'api/deepseek-chat-import/archive'
    /** Turns offered by default when a conversation is picked. */
    const DEFAULT_KEEP = 10
    /**
     * Longest the browser keeps polling one run. The Host gives up at 10 minutes, and a
     * parked run waits at most 15 more for an answer, so this is comfortably above both:
     * it only exists to stop polling a run that can no longer settle.
     */
    const AMPLIFY_POLL_MAX_MS = 30 * 60 * 1000

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const ZH = {
      'action.label': '复活吧我的爱人',
      'recall.title': '回忆模式',
      'recall.body': '三档：关 / 增强语气 / 增强记忆与语气。后两档都会调高采样温度、屏蔽不必要的上下文注入、系统提示词只留本插件的段；区别是「增强记忆与语气」每一轮都会强制提醒你先调 history_search 查旧原文（整句只是语气词时除外），每条消息多一次工具往返的开销；「增强语气」只给一句鼓励，不强制查，省下工具往返。插件自己不搜、不判断，也不额外调用模型。关掉即回原样，之前注入的提醒也不再发给模型。',
      'recall.mode.off': '关',
      'recall.mode.tone': '增强语气',
      'recall.mode.fact': '增强记忆与语气',
      'recall.hint.off': '回忆模式：关',
      'recall.hint.tone': '增强语气已开启',
      'recall.hint.fact': '增强记忆与语气已开启',
      'recall.notRevived': '这个开关只对复活会话有用',
      'recall.failed': '切换失败，请稍后再试',
      'recall.archive.title': '压缩上下文时归档',
      'recall.archive.body': '每次压缩上下文，把被压缩掉的轮次按原话追加到存档，之后 history_search 还能搜到。只对增幅复活的会话生效，摘要本身不收录。',
      'recall.archive.on': '开',
      'recall.archive.off': '关',
      'recall.archive.flashOn': '压缩时归档：开',
      'recall.archive.flashOff': '压缩时归档：关',
      // Status of the last turn; recall is invisible, so the panel has to report it.
      'dialog.title': '复活吧我的爱人',
      'dialog.description': '把一个过长的对话裁短后再导入，避免超出模型上下文上限。',
      'dialog.step': '第 {step} / 3 步',
      'dialog.close': '关闭',
      'dialog.cancel': '取消',
      'dialog.back': '上一步',
      'dialog.retry': '重试',
      'step.upload.title': '1. 选择导出文件',
      'step.upload.hint': '拖拽 deepseek_data-*.zip 到这里，或选择文件。',
      'step.upload.choose': '选择文件…',
      'step.upload.parsing': '正在解析压缩包…',
      'step.upload.recentTitle': '已下载的导出包',
      'step.upload.recentHint': '扫描下载、桌面、文档三个文件夹里名字像 deepseek_data*.zip 的文件，只在本机读取，不上传。',
      'step.upload.recentEmpty': '没找到已下载的导出包。先在 DeepSeek 官网导出，再回到这里点「重新扫描」。',
      'step.upload.recentScanning': '扫描中…',
      'step.upload.recentRescan': '重新扫描',
      'step.upload.recentMeta': '{size} · {time}',
      'step.upload.privacy': '文件只在本机内存中解析，不会上传到任何外部服务。',
      'step.pick.title': '2. 选择要复活的对话',
      'step.pick.search': '按标题搜索',
      'step.pick.count': '共 {count} 个对话，按最后更新时间倒序',
      'step.pick.recommend': '推荐处理',
      'step.pick.empty': '没有匹配的对话。',
      'step.pick.omitted': '另有 {count} 个更早的对话未列出。',
      'step.pick.turns': '{count} 轮',
      'step.pick.updated': '更新于 {time}',
      'step.config.title': '3. 设定保留范围',
      'step.config.keep': '保留最近多少轮',
      'step.config.keepHint': '可保留 1–{max} 轮',
      'step.config.keptTurns': '保留 {count} 轮',
      'step.config.dropped': '丢弃前 {count} 轮',
      'step.config.overBudget': '保留的内容已经很长，很可能超出模型的上下文窗口；建议再减少保留轮数。',
      'step.config.note': '补充说明（作为第一条 USER 消息）',
      'step.config.noteHint': '留空则不插入说明。',
      'step.config.workspace': '导入到工作区',
      'step.config.workspaceNone': '没有可用的工作区',
      'step.config.generate': '生成',
      'step.config.amplify': '增幅模式：先总结被移除的内容',
      'step.config.waitAmplify': '等总结结束…',
      'step.config.amplifyHint': '开启后会把被移除的 {count} 轮压成摘要，作为新会话的第一条消息。',
      'amplify.title': '开启增幅模式',
      'amplify.lead': '被移除的 {count} 轮原文会发送给模型，用来生成摘要。',
      'amplify.workspace': '会在「{name}」新建 1 条总结会话，保留不自动删除',
      'amplify.model': '模型：flash、思考关闭',
      'amplify.segments': '会写成 {count} 个文件，交给一条总结会话读完并压缩',
      'amplify.cost': '会把整段对话一次性读进上下文，消耗的 token 远高于日常对话；这项任务几乎没有缓存可用',
      'amplify.used': '已用 {tokens} token',
      'amplify.failure': '需要等待，期间可能失败或超时；失败时可以选择不带摘要继续',
      'amplify.confirm': '我已了解，开启',
      'amplify.planning': '正在计算分段…',
      'amplify.progress': '总结会话正在处理 {count} 个分片…',
      'amplify.cancel': '取消（摘要作废）',
      'amplify.done': '摘要已生成，生成复活会话时会自动带上。',
      'amplify.cancelled': '已取消，摘要作废；生成时会不带摘要继续。',
      'amplify.failed': '摘要失败，生成时会不带摘要继续。',
      'amplify.stalledTime': '已经等了很久还没结果，可能失败了。',
      'amplify.keepWaiting': '继续等',
      'amplify.stopHere': '取消（摘要作废）',
      'amplify.without': '不带摘要继续',
      'amplify.miniTitle': '增幅模式运行中',
      'amplify.expand': '展开',
      'amplify.minimize': '最小化',
      'dialog.building': '正在重建压缩包…',
      'dialog.importing': '正在导入…',
      'result.title': '复活完成',
      'result.name': '新会话标题：{title}',
      'result.turns': '保留 {kept} 轮（丢弃 {removed} 轮）',
      'result.partial': '这次摘要覆盖了较早内容的 {percent}%，剩下的部分没有进摘要。原文仍完整存档。',
      'result.imported': '已直接导入到工作区，共 {count} 个新会话。',
      'result.downloaded': '已下载 {name}。请用侧边栏的「导入 DeepSeek 会话」按钮导入它。',
      'result.downloadedNoPlugin': '已下载 {name}，但没有找到官方导入插件；请先安装「导入 DeepSeek 会话」再导入这个文件。',
      'result.done': '完成',
      'note.default': '更早的 {removed} 轮已移除',
      'error.too-large': '文件过大，无法处理。',
      'error.unreadable-archive': '这个文件不是可读取的 ZIP 压缩包。',
      'error.missing-manifest': '缺少 manifest.json，这不是 DeepSeek 导出文件。',
      'error.missing-index': '缺少 chat_session_index.json，或该文件无法读取。',
      'error.unsupported-version': '不支持的导出格式版本（需要 export_format_version 3）。',
      'error.no-conversations': '导出文件中没有可处理的对话。',
      'error.expired-upload': '上传已过期，请重新选择文件。',
      'error.unknown-conversation': '这个对话已不在压缩包中，请重新上传。',
      'error.empty-conversation': '这个对话没有可保留的用户消息。',
      'error.build-failed': '重建压缩包失败：{message}',
      'error.import-failed': '导入失败：{message}',
      'error.upload-failed': '上传或解析失败：{message}',
      'error.bad-request': '请求无效：{message}',
      'error.expired-scan': '上次扫描已过期，请重新扫描。',
      'error.unknown-file': '这个文件已不可用，请重新扫描。',
      'error.scan-failed': '扫描失败：{message}',
      'error.origin': '这个请求的来源不被允许，已拒绝。',
      'error.amplify-busy': '已经有一个增幅任务在跑，等它结束或先取消它。',
      'error.nothing-to-summarize': '没有会被丢弃的轮次，不需要做摘要。',
      'error.unknown': '操作失败：{message}',
    }

    /** English dictionary, complete against the Chinese key set. */
    const EN = {
      'action.label': 'Revive my love',
      'recall.title': 'Recall mode',
      'recall.body': 'Three levels: off / enhanced tone / enhanced recall & tone. The two "on" levels both raise the sampling temperature, hide unnecessary context injections and keep only this plugin\'s system-prompt sections. "Enhanced recall & tone" also requires every turn to look up the original wording with history_search first (filler-only messages excepted), which costs one extra tool round-trip per message; "enhanced tone" only leaves an encouragement and never forces a lookup. The plugin itself does not search, judge, or call any model. Turn it off and everything is back to normal, including the reminders already in the transcript.',
      'recall.mode.off': 'Off',
      'recall.mode.tone': 'Enhanced tone',
      'recall.mode.fact': 'Enhanced recall & tone',
      'recall.hint.off': 'Recall mode: off',
      'recall.hint.tone': 'Enhanced tone on',
      'recall.hint.fact': 'Enhanced recall & tone on',
      'recall.notRevived': 'This switch only applies to a revived conversation',
      'recall.failed': 'Could not switch it, try again',
      'recall.archive.title': 'Archive on compaction',
      'recall.archive.body': 'Every time the context is compacted, append the dropped turns verbatim to the archive so history_search still finds them. Amplified conversations only; the summary itself is not archived.',
      'recall.archive.on': 'On',
      'recall.archive.off': 'Off',
      'recall.archive.flashOn': 'Archive on compaction: on',
      'recall.archive.flashOff': 'Archive on compaction: off',
      'dialog.title': 'Revive my love',
      'dialog.description': 'Shorten one over-long conversation before importing it, so it fits the model context window.',
      'dialog.step': 'Step {step} of 3',
      'dialog.close': 'Close',
      'dialog.cancel': 'Cancel',
      'dialog.back': 'Back',
      'dialog.retry': 'Retry',
      'step.upload.title': '1. Choose the export file',
      'step.upload.hint': 'Drop deepseek_data-*.zip here, or choose a file.',
      'step.upload.choose': 'Choose file…',
      'step.upload.parsing': 'Reading the archive…',
      'step.upload.privacy': 'The file is parsed in memory on this machine; nothing is sent to an external service.',
      'step.upload.recentTitle': 'Exports already downloaded',
      'step.upload.recentHint': 'Looks for deepseek_data*.zip in Downloads, Desktop and Documents. Read locally only; nothing is uploaded.',
      'step.upload.recentEmpty': 'No downloaded export found. Export it on the DeepSeek website, then press Rescan.',
      'step.upload.recentScanning': 'Scanning…',
      'step.upload.recentRescan': 'Rescan',
      'step.upload.recentMeta': '{size} · {time}',
      'step.pick.title': '2. Choose the conversation to revive',
      'step.pick.search': 'Search by title',
      'step.pick.count': '{count} conversations, newest update first',
      'step.pick.recommend': 'recommended',
      'step.pick.empty': 'No conversation matches.',
      'step.pick.omitted': '{count} older conversations are not listed.',
      'step.pick.turns': '{count} turns',
      'step.pick.updated': 'updated {time}',
      'step.config.title': '3. Choose what to keep',
      'step.config.keep': 'Keep the most recent turns',
      'step.config.keepHint': '1–{max} turns can be kept',
      'step.config.keptTurns': 'Keeping {count} turns',
      'step.config.dropped': 'Dropping the first {count} turns',
      'step.config.overBudget': 'That is already a lot of text and will very likely exceed the context window; keep fewer turns.',
      'step.config.note': 'Note (inserted as the first USER message)',
      'step.config.noteHint': 'Leave empty to insert nothing.',
      'step.config.workspace': 'Import into workspace',
      'step.config.workspaceNone': 'No workspace is available',
      'step.config.generate': 'Generate',
      'step.config.amplify': 'Amplify mode: summarize what gets dropped',
      'step.config.waitAmplify': 'Waiting for the summary…',
      'step.config.amplifyHint': 'Condenses the {count} dropped turns into a summary and puts it at the top of the revived conversation.',
      'amplify.title': 'Turn on amplify mode',
      'amplify.lead': 'The {count} dropped turns are sent to a model to produce a summary.',
      'amplify.workspace': 'Creates 1 summary conversation in "{name}" and keeps it',
      'amplify.model': 'Model: flash, reasoning off',
      'amplify.segments': 'Writes {count} file(s) for one summary session to read and condense',
      'amplify.cost': 'Reads the whole history into one context at once, so it burns far more tokens than everyday chatting, with almost no cache reuse',
      'amplify.used': 'used {tokens} tokens',
      'amplify.failure': 'It takes a while and may fail or stall; if it does you can continue without the summary',
      'amplify.confirm': 'I understand, turn it on',
      'amplify.planning': 'Working out the segments…',
      'amplify.progress': 'The summary session is working through {count} chunk(s)…',
      'amplify.cancel': 'Cancel (discard the summary)',
      'amplify.done': 'Summary ready; it will be attached when the revived conversation is built.',
      'amplify.cancelled': 'Cancelled, summary discarded; the build continues without it.',
      'amplify.failed': 'Summarizing failed; the build continues without a summary.',
      'amplify.stalledTime': 'This is taking much longer than expected and may have failed.',
      'amplify.keepWaiting': 'Keep waiting',
      'amplify.stopHere': 'Cancel (discard the summary)',
      'amplify.without': 'Continue without the summary',
      'amplify.miniTitle': 'Amplify mode running',
      'amplify.expand': 'Expand',
      'amplify.minimize': 'Minimize',
      'dialog.building': 'Rebuilding the archive…',
      'dialog.importing': 'Importing…',
      'result.title': 'Revived',
      'result.name': 'New conversation title: {title}',
      'result.turns': 'Kept {kept} turns (dropped {removed})',
      'result.partial': 'This summary covers {percent}% of the earlier part; the rest did not make it in. The full text is still archived.',
      'result.imported': 'Imported directly into the workspace: {count} new sessions.',
      'result.downloaded': 'Downloaded {name}. Import it with the sidebar’s “Import DeepSeek chats” action.',
      'result.downloadedNoPlugin': 'Downloaded {name}, but the official import plugin is not installed; install “Import DeepSeek chats” first.',
      'result.done': 'Done',
      'note.default': 'The earlier {removed} turns were removed',
      'error.too-large': 'The file is too large to process.',
      'error.unreadable-archive': 'This file is not a readable ZIP archive.',
      'error.missing-manifest': 'manifest.json is missing, so this is not a DeepSeek export.',
      'error.missing-index': 'chat_session_index.json is missing or unreadable.',
      'error.unsupported-version': 'Unsupported export format version (export_format_version 3 is required).',
      'error.no-conversations': 'The export contains no conversation to process.',
      'error.expired-upload': 'The upload expired. Choose the file again.',
      'error.unknown-conversation': 'That conversation is no longer in the archive. Upload it again.',
      'error.empty-conversation': 'That conversation has no user message to keep.',
      'error.build-failed': 'Rebuilding the archive failed: {message}',
      'error.import-failed': 'Import failed: {message}',
      'error.upload-failed': 'Upload or parsing failed: {message}',
      'error.bad-request': 'Invalid request: {message}',
      'error.expired-scan': 'The last folder scan expired. Scan again.',
      'error.unknown-file': 'That file is no longer available. Scan again.',
      'error.scan-failed': 'The folder scan failed: {message}',
      'error.origin': 'That request came from a disallowed origin and was refused.',
      'error.amplify-busy': 'An amplify run is already going. Wait for it or cancel it first.',
      'error.nothing-to-summarize': 'No turn would be dropped, so there is nothing to summarize.',
      'error.unknown': 'The action failed: {message}',
    }

    /** Context facts the picker marks conversations with (the Host reports the same values). */
    const HISTORY_BUDGET_CHARS = 700000

    let ctxRef

    /** The browser locale id, read from the Client locale service. */
    function activeLocaleId() {
      try {
        const locale = ctxRef === undefined ? undefined : ctxRef.locale
        if (locale !== null && locale !== undefined && typeof locale.getLocale === 'function') {
          const snapshot = locale.getLocale()
          if (snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string') return snapshot.active
        }
      }
      catch {
        /* fall through to the default locale */
      }
      return 'zh'
    }

    /** One dictionary string, with the key itself as the last resort. */
    function dictText(key) {
      const tag = activeLocaleId().toLowerCase()
      const dictionary = tag.startsWith('en') ? EN : ZH
      const text = dictionary[key]
      return typeof text === 'string' ? text : key
    }

    /** Fill `{name}` placeholders. */
    function fill(text, params) {
      if (params === undefined || params === null) return text
      return text.replace(/\{(\w+)\}/g, (match, key) => (
        params[key] === undefined || params[key] === null ? '' : String(params[key])
      ))
    }

    /** A translator that prefers the slot-provided `t` and falls back to the local dictionaries. */
    function makeT(props) {
      const bound = props === null || props === undefined ? undefined : props.t
      return (key, params) => {
        if (typeof bound === 'function') {
          try {
            const value = bound(key, params)
            if (typeof value === 'string' && value !== key) return value
          }
          catch {
            /* fall back to the local dictionary */
          }
        }
        return fill(dictText(key), params)
      }
    }

    /** One rendered message string out of a `{ key, params }` failure record. */
    function errorText(t, error) {
      if (error === null || error === undefined) return ''
      const key = typeof error.key === 'string' ? error.key : 'error.unknown'
      return t(key, error.params)
    }

    /** One failure record out of a Host refusal payload. */
    function errorFromPayload(payload) {
      if (payload === null || typeof payload !== 'object') return { key: 'error.unknown', params: { message: '' } }
      const code = typeof payload.code === 'string' ? payload.code : 'unknown'
      const message = typeof payload.error === 'string' ? payload.error : ''
      const key = `error.${code}`
      return { key: knownError(key) ? key : 'error.unknown', params: { message } }
    }

    /** Whether a dictionary key exists in the Chinese key set. */
    function knownError(key) {
      return Object.prototype.hasOwnProperty.call(ZH, key)
    }

    /** Format one timestamp for display. */
    function formatTime(text) {
      const time = Date.parse(typeof text === 'string' ? text : '')
      return Number.isFinite(time) ? new Date(time).toLocaleString() : ''
    }

    /** Elapsed seconds as `mm:ss`. */
    function formatElapsed(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const minutes = Math.floor(total / 60)
      const rest = total % 60
      return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    }

    /** Human size for a file, used by the folder scan rows. */
    function formatBytes(value) {
      const bytes = Number(value) || 0
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
      if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
      return bytes + ' B'
    }

    /** A number as a short human string (`12.3k`, `1.2M`). Used for measured usage only. */
    function formatTokens(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`
      if (number >= 1000) return `${(number / 1000).toFixed(1)}k`
      return String(Math.round(number))
    }

    /** A message out of an unknown thrown value. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** Read one `x-dsh-slim-*` response header as text. */
    function headerValue(response, name) {
      const raw = response.headers.get(name)
      if (raw === null || raw === '') return undefined
      try {
        return decodeURIComponent(raw)
      }
      catch {
        return raw
      }
    }

    /** Address one of this plugin's Host routes. */
    function routeUrl(route) {
      return route.startsWith('/') ? route : new URL(route, document.baseURI).href
    }

    /** Drop the browser's view of a session list and re-read it. */
    function refreshSessionList(ctx) {
      return ctx.sessions !== undefined && ctx.sessions !== null && typeof ctx.sessions.refresh === 'function'
        ? ctx.sessions.refresh()
        : Promise.resolve()
    }

    /**
     * Send one archive to the shipped import route and read its NDJSON answer.
     * @returns `{ ok: true, sessionIds }`, or the reason it did not import.
     */
    async function importThroughShippedRoute(blob, workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return { ok: false, reason: 'absent' }
      const url = new URL(IMPORT_ROUTE, document.baseURI)
      url.searchParams.set('workspaceId', workspaceId)
      let response
      try {
        response = await fetch(url.href, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: blob,
        })
      }
      catch (error) {
        return { ok: false, reason: 'transport', message: messageOf(error) }
      }
      if (response.status !== 200) return { ok: false, reason: 'absent', message: `HTTP ${response.status}` }
      let text
      try {
        text = await response.text()
      }
      catch (error) {
        return { ok: false, reason: 'transport', message: messageOf(error) }
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        let parsed
        try {
          parsed = JSON.parse(line)
        }
        catch {
          return { ok: false, reason: 'transport', message: 'the import answer is not JSON' }
        }
        if (parsed === null || typeof parsed !== 'object' || parsed.type !== 'outcome') continue
        const outcome = parsed.outcome
        if (outcome !== null && typeof outcome === 'object' && outcome.ok === true) {
          const value = outcome.value !== null && typeof outcome.value === 'object' ? outcome.value : {}
          const ids = Array.isArray(value.sessionIds) ? value.sessionIds.filter(id => typeof id === 'string') : []
          return { ok: true, sessionIds: ids }
        }
        const failure = outcome !== null && typeof outcome === 'object' && outcome.error !== null && typeof outcome.error === 'object'
          ? outcome.error
          : {}
        return { ok: false, reason: 'import', message: typeof failure.message === 'string' ? failure.message : '' }
      }
      return { ok: false, reason: 'transport', message: 'the import answer carried no outcome' }
    }

    /** Offer one blob as a file download. */
    function downloadBlob(blob, fileName) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      // Transient: the node exists only for the duration of the click.
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 4000)
    }

    /**
     * Estimate the kept characters for one conversation.
     * The Host sends per-turn counts for the newest turns only; older turns are
     * approximated with the average of the sent tail.
     */
    function estimateKeptChars(item, keep) {
      const chars = Array.isArray(item.turnChars) ? item.turnChars : []
      if (chars.length === 0) return 0
      if (keep <= chars.length) {
        let sum = 0
        for (let index = chars.length - keep; index < chars.length; index += 1) sum += chars[index]
        return sum
      }
      let total = 0
      for (const value of chars) total += value
      const average = total / chars.length
      return total + (keep - chars.length) * average
    }

    /** A store hook or a constant-empty stand-in, so the hook call count stays stable. */
    function hookFrom(props, name) {
      return typeof props[name] === 'function' ? props[name] : emptySelector
    }

    /** Stand-in selector hook: no store is composed into this slot. */
    function emptySelector() {
      return []
    }

    /** The heart-with-a-pulse glyph marking the sidebar action. */
    function TriggerIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M12 20.6C5.2 15.7 3.3 12 3.9 9.1 4.3 6.7 6.3 5 8.6 5c1.5 0 2.8.8 3.4 1.9C12.6 5.8 13.9 5 15.4 5c2.3 0 4.3 1.7 4.7 4.1.6 2.9-1.3 6.6-8.1 11.5z',
        }),
        h('polyline', { points: '6.4,12.6 8.8,12.6 10.2,10 12,15 13.6,11.2 14.7,13 17.4,12.6' }),
      )
    }

    /** One labelled meta value. */
    function Meta({ children }) {
      return h('span', { className: 'dsh-slim-meta-item' }, children)
    }

    /**
     * Wizard state and all three steps.
     * @param props - the slot props, the translator, and the dialog close callback.
     */
    function Wizard({ props, t, onClose }) {
      const [step, setStep] = useState('upload')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState(null)
      const [archive, setArchive] = useState(null)
      const [query, setQuery] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [keep, setKeep] = useState(DEFAULT_KEEP)
      const [note, setNote] = useState('')
      const [noteTouched, setNoteTouched] = useState(false)
      const [workspaceId, setWorkspaceId] = useState(undefined)
      const [result, setResult] = useState(null)
      const [dragOver, setDragOver] = useState(false)
      const [recent, setRecent] = useState([])
      const [scanBusy, setScanBusy] = useState(false)
      /** Amplify mode: the switch, its confirmation, the plan, and live progress. */
      const [amplifyOn, setAmplifyOn] = useState(false)
      const [amplifyPlan, setAmplifyPlan] = useState(null)
      const [amplifyDialog, setAmplifyDialog] = useState(false)
      const [amplifyPhase, setAmplifyPhase] = useState('idle')
      const [amplifyProgress, setAmplifyProgress] = useState({ count: 0 })
      const [amplifySummary, setAmplifySummary] = useState(null)
      /** Set when the summary run read only part of its own chunks. */
      const [amplifyCoverage, setAmplifyCoverage] = useState(null)
      const [amplifyError, setAmplifyError] = useState(null)
      const [amplifyStall, setAmplifyStall] = useState(null)
      /** Minimized while running, so the rest of DSH stays usable. */
      const [amplifyMin, setAmplifyMin] = useState(false)
      const [, setAmplifyTick] = useState(0)
      /** When the run started, for the floating timer; the host also reports elapsedMs. */
      const [amplifyStartedAt, setAmplifyStartedAt] = useState(0)
      /** Tokens the host reports for this run, shown on the floating panel. */
      const [amplifyTokens, setAmplifyTokens] = useState(0)
      /** Floating panel position; null keeps it centred until the user drags it. */
      const [floatPos, setFloatPos] = useState(null)
      const floatDrag = useRef(null)
      const fileInput = useRef(null)
      const surface = useRef(null)
      const request = useRef(null)

      const useWorkspaces = hookFrom(props, 'useWorkspaces')
      const useSessions = hookFrom(props, 'useSessions')
      const workspaces = useWorkspaces(state => state.items) || []
      const sessionsById = useSessions(state => state.byId) || {}
      const currentSessionId = useMemo(() => {
        const sessions = Object.values(sessionsById)
        for (const session of sessions) {
          if (session !== null && typeof session === 'object' && session.retainedBy !== undefined
            && session.retainedBy !== null && (session.retainedBy.mainView || 0) > 0) return session.id
        }
        return undefined
      }, [sessionsById])
      const suggestedWorkspace = useMemo(() => {
        for (const workspace of workspaces) {
          if (currentSessionId !== undefined && Array.isArray(workspace.sessionIds)
            && workspace.sessionIds.includes(currentSessionId)) return workspace.workspaceId
        }
        for (const workspace of workspaces) return workspace.workspaceId
        return undefined
      }, [workspaces, currentSessionId])
      const chosenWorkspaceId = workspaceId !== undefined ? workspaceId : suggestedWorkspace

      const conversations = archive === null ? [] : archive.conversations
      const budget = archive !== null && archive.limits !== undefined && typeof archive.limits.historyBudgetChars === 'number'
        ? archive.limits.historyBudgetChars
        : HISTORY_BUDGET_CHARS
      const recommend = archive !== null && archive.limits !== undefined && typeof archive.limits.recommendTurns === 'number'
        ? archive.limits.recommendTurns
        : 500
      const keepCeiling = archive !== null && archive.limits !== undefined && typeof archive.limits.maxKeepTurns === 'number'
        ? archive.limits.maxKeepTurns
        : 500
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return conversations
        return conversations.filter(item => String(item.title || '').toLowerCase().includes(needle))
      }, [conversations, query])
      const selected = useMemo(() => {
        for (const item of conversations) {
          if (item.id === selectedId) return item
        }
        return undefined
      }, [conversations, selectedId])

      const maxKeep = selected === undefined ? 0 : Math.min(selected.turns, keepCeiling)
      const keptChars = selected === undefined ? 0 : estimateKeptChars(selected, keep)
      const keptCharsEstimate = selected === undefined ? 0 : estimateKeptChars(selected, keep)
      const dropped = selected === undefined ? 0 : Math.max(0, selected.turns - keep)

      useEffect(() => {
        if (surface.current !== null) {
          try {
            surface.current.focus()
          }
          catch {
            /* focus is best effort */
          }
        }
      }, [])

      useEffect(() => () => {
        if (request.current !== null) request.current.abort()
      }, [])

      useEffect(() => {
        if (noteTouched) return
        setNote(dropped > 0 ? t('note.default', { removed: String(dropped) }) : '')
      }, [selectedId, dropped, noteTouched, t])

      /**
       * Leaving mid-run must not destroy the panel: closing minimises to the floating window,
       * and that window goes away only when the user cancels the run on purpose.
       */
      const requestClose = useCallback(() => {
        if (amplifyPhase === 'running' || amplifyPhase === 'stalled') {
          setAmplifyMin(true)
          return
        }
        onClose()
      }, [amplifyPhase, onClose])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            requestClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [requestClose])

      const upload = useCallback(async (file) => {
        setBusy('upload')
        setError(null)
        try {
          const response = await fetch(routeUrl(PREVIEW_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: file,
          })
          let payload
          try {
            payload = await response.json()
          }
          catch (parseError) {
            setError({ key: 'error.upload-failed', params: { message: `HTTP ${response.status}: ${messageOf(parseError)}` } })
            return
          }
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
            setError(errorFromPayload(payload))
            return
          }
          setArchive(payload)
          setSelectedId(null)
          setQuery('')
          setStep('pick')
        }
        catch (thrown) {
          setError({ key: 'error.upload-failed', params: { message: messageOf(thrown) } })
        }
        finally {
          setBusy('')
        }
      }, [])

      /** Rescan the user's own folders for exports they already downloaded. */
      const scanFolders = useCallback(async () => {
        setScanBusy(true)
        try {
          const response = await fetch(routeUrl(SCAN_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const payload = await response.json()
          if (payload !== null && typeof payload === 'object' && payload.ok === true && Array.isArray(payload.candidates)) {
            setRecent(payload.candidates)
          }
          else {
            setRecent([])
          }
        }
        catch {
          setRecent([])
        }
        finally {
          setScanBusy(false)
        }
      }, [])

      /** Load one archive the scan found, skipping the file picker. */
      const openRecent = useCallback(async (candidate) => {
        setBusy('upload')
        setError(null)
        try {
          const response = await fetch(routeUrl(OPEN_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: candidate.id }),
          })
          const payload = await response.json()
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
            setError(errorFromPayload(payload))
            return
          }
          setArchive(payload)
          setSelectedId(null)
          setQuery('')
          setStep('pick')
        }
        catch (thrown) {
          setError({ key: 'error.upload-failed', params: { message: messageOf(thrown) } })
        }
        finally {
          setBusy('')
        }
      }, [])

      useEffect(() => {
        scanFolders()
      }, [scanFolders])

      // While a run is live the floating panel shows a clock, so re-render every second.
      useEffect(() => {
        if (amplifyPhase !== 'running' && amplifyPhase !== 'stalled') return undefined
        const timer = setInterval(() => { setAmplifyTick((value) => value + 1) }, 1000)
        return () => { clearInterval(timer) }
      }, [amplifyPhase])

      // A stalled run needs a decision, so bring the full dialog back on its own.
      useEffect(() => {
        if (amplifyPhase === 'stalled') setAmplifyMin(false)
      }, [amplifyPhase])

      /** Ask the Host how the discarded turns would be split, then show the warning. */
      const openAmplify = useCallback(async () => {
        if (selected === undefined || archive === null) return
        setAmplifyError(null)
        setAmplifyPhase('planning')
        try {
          const response = await fetch(routeUrl(AMPLIFY_PLAN_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ conversationId: selected.id, keepTurns: keep }),
          })
          const payload = await response.json()
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
            setAmplifyOn(false)
            setAmplifyPhase('idle')
            setAmplifyError(errorFromPayload(payload))
            return
          }
          setAmplifyPlan(payload)
          setAmplifyPhase('idle')
          setAmplifyDialog(true)
        }
        catch (thrown) {
          setAmplifyOn(false)
          setAmplifyPhase('idle')
          setAmplifyError({ key: 'error.scan-failed', params: { message: messageOf(thrown) } })
        }
      }, [archive, keep, selected])

      /**
       * Poll the Host until the run settles. Shared by a fresh start and by a wizard that
       * was closed and reopened while a run was still going, so the panel always comes back.
       */
      const pollAmplify = useCallback(async () => {
        const pollStartedAt = Date.now()
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          // Only a real unmount aborts the stored request; minimising keeps it alive.
          if (request.current !== null && request.current.signal.aborted) return
          if (Date.now() - pollStartedAt > AMPLIFY_POLL_MAX_MS) {
            setAmplifyPhase('failed')
            setAmplifyOn(false)
            setAmplifyError({ key: 'error.build-failed', params: { message: 'the summary run stopped reporting' } })
            return
          }
          const slice = new AbortController()
          request.current = slice
          let tick
          try {
            tick = await fetch(routeUrl(AMPLIFY_STATUS_ROUTE), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              signal: slice.signal,
            })
          }
          catch (error) {
            if (slice.signal.aborted) return
            throw error
          }
          const status = await tick.json()
          if (status === null || typeof status !== 'object') continue
          setAmplifyProgress({ count: status.chunkCount || 0 })
          if (typeof status.tokens === 'number') setAmplifyTokens(status.tokens)
          if (status.state === 'stalled') {
            setAmplifyPhase('stalled')
            setAmplifyStall({ reason: status.stallReason, tokens: status.tokens || 0, expected: status.expectedTokens || 0 })
            // Keep polling: the run resumes once the user answers.
            continue
          }
          if (status.state === 'done' && typeof status.summary === 'string') {
            setAmplifySummary(status.summary)
            setAmplifyCoverage(status.coverage ?? null)
            setAmplifyPhase('done')
            return
          }
          if (status.state === 'failed' || status.state === 'cancelled' || status.state === 'abandoned') {
            setAmplifyPhase(status.state === 'abandoned' ? 'cancelled' : status.state)
            setAmplifyOn(false)
            setAmplifySummary(null)
            setAmplifyCoverage(null)
            return
          }
        }
      }, [])

      /** Run one amplify round and hand the work to one summary session. */
      const runAmplify = useCallback(async () => {
        if (selected === undefined || archive === null) return
        setAmplifyDialog(false)
        setAmplifyPhase('running')
        // A summary left over from an earlier run must never be folded into this one.
        setAmplifySummary(null)
        setAmplifyCoverage(null)
        // Every new run starts centred again, even if the panel was dragged last time.
        setFloatPos(null)
        setAmplifyMin(true)
        setAmplifyStartedAt(Date.now())
        setAmplifyProgress({ count: amplifyPlan === null ? 0 : amplifyPlan.segments.length })
        try {
          const started = await fetch(routeUrl(AMPLIFY_START_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              conversationId: selected.id,
              keepTurns: keep,
              workspaceId: chosenWorkspaceId,
              locale: activeLocaleId(),
            }),
          })
          const payload = await started.json()
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
            setAmplifyPhase('failed')
            setAmplifyOn(false)
            setAmplifyError(errorFromPayload(payload))
            return
          }
          await pollAmplify()
        }
        catch (thrown) {
          if (request.current !== null && request.current.signal.aborted) return
          setAmplifyPhase('failed')
          setAmplifyOn(false)
          setAmplifyError({ key: 'error.build-failed', params: { message: messageOf(thrown) } })
        }
      }, [amplifyPlan, archive, chosenWorkspaceId, keep, selected, pollAmplify])

      /**
       * A wizard reopened while a run is still going has to show that run again: the Host
       * owns the state, so ask it once on mount and resume polling if anything is active.
       */
      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const response = await fetch(routeUrl(AMPLIFY_STATUS_ROUTE), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
            const status = await response.json()
            if (!alive || status === null || typeof status !== 'object' || status.ok !== true) return
            // Only a run that is still going can be shown again; a finished one would have no
            // conversation loaded on this mount, so its summary could not be used anyway.
            if (!['creating', 'running', 'summarizing', 'stalled'].includes(status.state)) return
            setAmplifyOn(true)
            setAmplifyMin(true)
            setAmplifyStartedAt(Date.now() - (typeof status.elapsedMs === 'number' ? status.elapsedMs : 0))
            setAmplifyProgress({ count: status.chunkCount || 0 })
            setAmplifyTokens(typeof status.tokens === 'number' ? status.tokens : 0)
            if (status.state === 'stalled') {
              setAmplifyPhase('stalled')
              setAmplifyStall({ reason: status.stallReason, tokens: status.tokens || 0, expected: status.expectedTokens || 0 })
            }
            else {
              setAmplifyPhase('running')
            }
            await pollAmplify()
          }
          catch {
            /* no run to recover */
          }
        })()
        return () => { alive = false }
      }, [pollAmplify])

      /** Stop the run; the summary is discarded on purpose. */
      const cancelAmplify = useCallback(async () => {
        try {
          await fetch(routeUrl(AMPLIFY_CANCEL_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        }
        catch {
          /* the run is abandoned either way */
        }
        setAmplifyPhase('cancelled')
        setAmplifySummary(null)
        setAmplifyCoverage(null)
        setAmplifyStall(null)
      }, [])

      /** Answer a parked run: keep waiting, cancel, or continue without the summary. */
      const decideAmplify = useCallback(async (decision) => {
        setAmplifyStall(null)
        try {
          await fetch(routeUrl(AMPLIFY_DECIDE_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision }),
          })
        }
        catch {
          /* the poll loop reports the outcome either way */
        }
        if (decision === 'continue') setAmplifyPhase('running')
        else {
          setAmplifyPhase('cancelled')
          setAmplifySummary(null)
          setAmplifyCoverage(null)
          setAmplifyOn(false)
        }
      }, [])

      const generate = useCallback(async () => {
        if (selected === undefined || archive === null) return
        setBusy('build')
        setError(null)
        try {
          const response = await fetch(routeUrl(BUILD_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              uploadId: archive.uploadId,
              conversationId: selected.id,
              keepTurns: keep,
              locale: activeLocaleId(),
              note,
              ...(amplifySummary === null ? {} : { amplifySummary }),
            }),
          })
          if (!response.ok) {
            let payload
            try {
              payload = await response.json()
            }
            catch {
              payload = undefined
            }
            setError(errorFromPayload(payload))
            return
          }
          const blob = await response.blob()
          const meta = {
            title: headerValue(response, 'x-dsh-slim-title') || selected.title,
            keptTurns: Number(headerValue(response, 'x-dsh-slim-kept-turns') || keep),
            removedTurns: Number(headerValue(response, 'x-dsh-slim-removed-turns') || 0),
            keptChars: Number(headerValue(response, 'x-dsh-slim-kept-chars') || 0),
            fileName: headerValue(response, 'x-dsh-slim-filename') || 'deepseek_data-slim.zip',
          }
          setBusy('import')
          const imported = await importThroughShippedRoute(blob, chosenWorkspaceId)
          if (imported.ok) {
            await refreshSessionList(ctxRef).catch(() => undefined)
            setResult({ ...meta, mode: 'imported', sessionIds: imported.sessionIds })
          }
          else if (imported.reason === 'import') {
            setError({ key: 'error.import-failed', params: { message: imported.message } })
            return
          }
          else {
            downloadBlob(blob, meta.fileName)
            setResult({ ...meta, mode: 'downloaded', hasPlugin: imported.reason !== 'absent' })
          }
          setStep('done')
        }
        catch (thrown) {
          setError({ key: 'error.build-failed', params: { message: messageOf(thrown) } })
        }
        finally {
          setBusy('')
        }
      }, [archive, chosenWorkspaceId, keep, note, selected, amplifySummary])

      const startOver = () => {
        setArchive(null)
        setSelectedId(null)
        setResult(null)
        setError(null)
        setStep('upload')
      }

      const pickFile = () => {
        if (fileInput.current !== null) fileInput.current.click()
      }

      const onDrop = (event) => {
        event.preventDefault()
        setDragOver(false)
        const file = event.dataTransfer !== null && event.dataTransfer.files.length > 0
          ? event.dataTransfer.files[0]
          : undefined
        if (file !== undefined) void upload(file)
      }

      const stepNumber = step === 'upload' ? 1 : step === 'pick' ? 2 : 3
      const running = busy !== ''
      /** Both wizard buttons stay locked until the run is cancelled or settled. */
      const amplifiedBusyLock = amplifyPhase === 'running' || amplifyPhase === 'stalled'

      const header = h('div', { className: 'dsh-slim-head' },
        h('div', { className: 'dsh-slim-titlebox' },
          h('h2', { className: 'dsh-slim-title', id: 'dsh-slim-title' }, t('dialog.title')),
          h('p', { className: 'dsh-slim-steps' }, t('dialog.step', { step: String(stepNumber) })),
        ),
        // Keep both icon buttons pinned to the top-right corner: as direct children
        // of the space-between header, an odd third child would drift to the centre.
        h('div', { className: 'dsh-slim-head-actions' },
          (amplifyPhase === 'running' || amplifyPhase === 'stalled')
            ? h('button', {
              type: 'button',
              className: 'dsh-slim-icon-button',
              'aria-label': t('amplify.minimize'),
              title: t('amplify.minimize'),
              onClick: () => { setAmplifyMin(true) },
            }, '⤡')
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-slim-icon-button',
            'aria-label': t('dialog.close'),
            title: t('dialog.close'),
            onClick: requestClose,
          }, '×'),
        ),
      )

      const errorLine = error === null ? null : h('div', { className: 'dsh-slim-error', role: 'alert' }, errorText(t, error))

      let body
      let footer

      if (step === 'upload') {
        body = h('div', { className: 'dsh-slim-body' },
          h('h3', { className: 'dsh-slim-section' }, t('step.upload.title')),
          h('div', {
            className: `dsh-slim-drop${dragOver ? ' dsh-slim-drop-active' : ''}`,
            onDragOver: (event) => { event.preventDefault(); setDragOver(true) },
            onDragLeave: () => { setDragOver(false) },
            onDrop,
          },
            h('p', { className: 'dsh-slim-drop-hint' }, t('step.upload.hint')),
            h('button', {
              type: 'button',
              className: 'dsh-slim-button dsh-slim-primary',
              disabled: running,
              onClick: pickFile,
              'data-modal-autofocus': true,
            }, t('step.upload.choose')),
            h('input', {
              ref: fileInput,
              type: 'file',
              accept: '.zip,application/zip,application/octet-stream',
              className: 'dsh-slim-hidden',
              tabIndex: -1,
              onChange: (event) => {
                const file = event.target.files !== null && event.target.files.length > 0
                  ? event.target.files[0]
                  : undefined
                event.target.value = ''
                if (file !== undefined) void upload(file)
              },
            }),
          ),
          h('p', { className: 'dsh-slim-note' }, t('step.upload.privacy')),
          h('div', { className: 'dsh-slim-field' },
            h('div', { className: 'dsh-slim-keeprow' },
              h('h3', { className: 'dsh-slim-section' }, t('step.upload.recentTitle')),
              h('button', {
                type: 'button',
                className: 'dsh-slim-button',
                disabled: running || scanBusy,
                onClick: () => { void scanFolders() },
              }, scanBusy ? t('step.upload.recentScanning') : t('step.upload.recentRescan')),
            ),
            h('p', { className: 'dsh-slim-note' }, t('step.upload.recentHint')),
            recent.length === 0
              ? h('p', { className: 'dsh-slim-note' }, t('step.upload.recentEmpty'))
              : h('div', { className: 'dsh-slim-list' }, recent.map(candidate => h('button', {
                key: candidate.id,
                type: 'button',
                className: 'dsh-slim-row',
                disabled: running,
                onClick: () => { void openRecent(candidate) },
              },
                h('span', { className: 'dsh-slim-rowhead' },
                  h('span', { className: 'dsh-slim-rowtitle', title: candidate.name }, candidate.name),
                ),
                h('span', { className: 'dsh-slim-meta' },
                  h(Meta, null, t('step.upload.recentMeta', {
                    size: formatBytes(candidate.size),
                    time: formatTime(candidate.modifiedAt),
                  })),
                ),
              ))),
          ),
          errorLine,
          busy === 'upload' ? h('p', { className: 'dsh-slim-note', role: 'status' }, t('step.upload.parsing')) : null,
        )
        footer = h('div', { className: 'dsh-slim-foot' },
          h('button', { type: 'button', className: 'dsh-slim-button', onClick: onClose }, t('dialog.cancel')),
        )
      }
      else if (step === 'pick') {
        const rows = filtered.map(item => {
          return h('button', {
            key: item.id,
            type: 'button',
            className: 'dsh-slim-row',
            onClick: () => {
              setSelectedId(item.id)
              setKeep(Math.max(1, Math.min(item.turns, keepCeiling)))
              setNoteTouched(false)
              setError(null)
              setStep('config')
            },
          },
            h('span', { className: 'dsh-slim-rowhead' },
              h('span', { className: 'dsh-slim-rowtitle', title: item.title }, item.title === '' ? '—' : item.title),
              item.turns > recommend
                ? h('span', { className: 'dsh-slim-badge dsh-slim-badge-warn' }, t('step.pick.recommend'))
                : null,
            ),
            h('span', { className: 'dsh-slim-meta' },
              h(Meta, null, t('step.pick.turns', { count: String(item.turns) })),
              h(Meta, null, t('step.pick.updated', { time: formatTime(item.updatedAt) })),
            ),
          )
        })
        body = h('div', { className: 'dsh-slim-body' },
          h('h3', { className: 'dsh-slim-section' }, t('step.pick.title')),
          h('input', {
            type: 'search',
            className: 'dsh-slim-search',
            placeholder: t('step.pick.search'),
            'aria-label': t('step.pick.search'),
            value: query,
            onChange: (event) => { setQuery(event.target.value) },
          }),
          h('p', { className: 'dsh-slim-note' }, t('step.pick.count', { count: String(conversations.length) })),
          rows.length === 0
            ? h('p', { className: 'dsh-slim-note' }, t('step.pick.empty'))
            : h('div', { className: 'dsh-slim-list' }, rows),
          archive !== null && archive.omitted > 0
            ? h('p', { className: 'dsh-slim-note' }, t('step.pick.omitted', { count: String(archive.omitted) }))
            : null,
          errorLine,
        )
        footer = h('div', { className: 'dsh-slim-foot' },
          h('button', { type: 'button', className: 'dsh-slim-button', onClick: startOver }, t('dialog.back')),
          h('button', { type: 'button', className: 'dsh-slim-button', onClick: onClose }, t('dialog.cancel')),
        )
      }
      else if (step === 'config') {
        const workspaceOptions = workspaces.map(workspace => h('option', {
          key: workspace.workspaceId,
          value: workspace.workspaceId,
        }, workspace.title === undefined || workspace.title === '' ? workspace.path : workspace.title))
        body = h('div', { className: 'dsh-slim-body' },
          h('h3', { className: 'dsh-slim-section' }, t('step.config.title')),
          selected === undefined ? null : h('p', { className: 'dsh-slim-note' }, selected.title),
          h('div', { className: 'dsh-slim-field' },
            h('label', { className: 'dsh-slim-label', htmlFor: 'dsh-slim-keep' }, t('step.config.keep')),
            h('div', { className: 'dsh-slim-keeprow' },
              h('input', {
                id: 'dsh-slim-keep',
                type: 'range',
                className: 'dsh-slim-range',
                min: 1,
                max: Math.max(1, maxKeep),
                step: 1,
                value: Math.min(keep, Math.max(1, maxKeep)),
                disabled: running,
                onChange: (event) => { setKeep(Number(event.target.value) || 1) },
              }),
              h('input', {
                type: 'number',
                className: 'dsh-slim-number',
                min: 1,
                max: Math.max(1, maxKeep),
                step: 1,
                value: keep,
                disabled: running,
                'aria-label': t('step.config.keep'),
                onChange: (event) => {
                  const value = Number(event.target.value)
                  if (!Number.isFinite(value)) return
                  setKeep(Math.max(1, Math.min(Math.max(1, maxKeep), Math.round(value))))
                },
              }),
            ),
            h('p', { className: 'dsh-slim-note' }, t('step.config.keepHint', { max: String(maxKeep) })),
          ),
          h('p', { className: 'dsh-slim-summary-line' },
            t('step.config.keptTurns', { count: String(Math.min(keep, Math.max(0, maxKeep))) }),
            ' · ',
            t('step.config.dropped', { count: String(dropped) }),
          ),
          keptCharsEstimate > budget ? h('p', { className: 'dsh-slim-warn' }, t('step.config.overBudget')) : null,
          h('div', { className: 'dsh-slim-field' },
            h('label', { className: 'dsh-slim-label', htmlFor: 'dsh-slim-note' }, t('step.config.note')),
            h('textarea', {
              id: 'dsh-slim-note',
              className: 'dsh-slim-textarea',
              value: note,
              disabled: running,
              onChange: (event) => { setNoteTouched(true); setNote(event.target.value) },
            }),
            h('p', { className: 'dsh-slim-note' }, t('step.config.noteHint')),
          ),
          h('div', { className: 'dsh-slim-field' },
            h('label', { className: 'dsh-slim-label', htmlFor: 'dsh-slim-workspace' }, t('step.config.workspace')),
            workspaceOptions.length === 0
              ? h('p', { className: 'dsh-slim-note' }, t('step.config.workspaceNone'))
              : h('select', {
                id: 'dsh-slim-workspace',
                className: 'dsh-slim-select',
                value: chosenWorkspaceId === undefined ? '' : chosenWorkspaceId,
                disabled: running,
                onChange: (event) => { setWorkspaceId(event.target.value) },
              }, workspaceOptions),
          ),
          dropped > 0
            ? h('div', { className: 'dsh-slim-field' },
              h('div', { className: 'dsh-slim-nuke' },
                h('button', {
                  type: 'button',
                  className: `dsh-slim-nuke-btn${amplifyOn ? ' dsh-slim-nuke-on' : ''}`,
                  'aria-pressed': amplifyOn ? 'true' : 'false',
                  'aria-label': t('step.config.amplify'),
                  title: t('step.config.amplify'),
                  disabled: running || amplifyPhase === 'running',
                  onClick: () => {
                    const next = !amplifyOn
                    setAmplifyOn(next)
                    setAmplifySummary(null)
                    setAmplifyCoverage(null)
                    if (next) void openAmplify()
                    else setAmplifyPhase('idle')
                  },
                }, h('span', { className: 'dsh-slim-nuke-icon', 'aria-hidden': 'true' }, '☢')),
                h('span', { className: 'dsh-slim-nuke-label' }, t('step.config.amplify')),
              ),
              h('p', { className: 'dsh-slim-note' }, t('step.config.amplifyHint', { count: String(dropped) })),
              amplifyPhase === 'planning' ? h('p', { className: 'dsh-slim-note', role: 'status' }, t('amplify.planning')) : null,
              amplifyPhase === 'running'
                ? h('p', { className: 'dsh-slim-note', role: 'status' },
                  t('amplify.progress', { count: String(amplifyProgress.count) }))
                : null,
              amplifyPhase === 'running'
                ? h('button', { type: 'button', className: 'dsh-slim-button', onClick: () => { void cancelAmplify() } }, t('amplify.cancel'))
                : null,
              amplifyPhase === 'stalled' && amplifyStall !== null
                ? h('div', { className: 'dsh-slim-field' },
                  h('p', { className: 'dsh-slim-warn' }, t('amplify.stalledTime')),
                  h('div', { className: 'dsh-slim-keeprow' },
                    h('button', { type: 'button', className: 'dsh-slim-button', onClick: () => { void decideAmplify('continue') } }, t('amplify.keepWaiting')),
                    h('button', { type: 'button', className: 'dsh-slim-button', onClick: () => { void decideAmplify('cancel') } }, t('amplify.stopHere')),
                    h('button', { type: 'button', className: 'dsh-slim-button dsh-slim-primary', onClick: () => { void decideAmplify('without') } }, t('amplify.without')),
                  ),
                )
                : null,
              amplifyPhase === 'done'
                ? h('p', { className: 'dsh-slim-note' }, t('amplify.done'))
                : null,
              amplifyPhase === 'cancelled' || amplifyPhase === 'failed'
                ? h('p', { className: 'dsh-slim-warn' }, t(amplifyPhase === 'cancelled' ? 'amplify.cancelled' : 'amplify.failed'))
                : null,
              amplifyError === null ? null : h('div', { className: 'dsh-slim-error', role: 'alert' }, errorText(t, amplifyError)),
            )
            : null,
          errorLine,
          busy === 'build' ? h('p', { className: 'dsh-slim-note', role: 'status' }, t('dialog.building')) : null,
          busy === 'import' ? h('p', { className: 'dsh-slim-note', role: 'status' }, t('dialog.importing')) : null,
        )
        footer = h('div', { className: 'dsh-slim-foot' },
          h('button', {
            type: 'button',
            className: 'dsh-slim-button',
            disabled: running || amplifiedBusyLock,
            onClick: () => { setStep('pick') },
          }, t('dialog.back')),
          h('button', {
            type: 'button',
            className: 'dsh-slim-button dsh-slim-primary',
            // Two writers racing on the session store once emptied the whole sidebar,
            // so building waits until the amplify run has settled.
            disabled: running || selected === undefined || amplifyPhase === 'running' || amplifyPhase === 'stalled',
            onClick: () => { void generate() },
          }, running
            ? t('dialog.importing')
            : amplifyPhase === 'running' || amplifyPhase === 'stalled'
              ? t('step.config.waitAmplify')
              : t('step.config.generate')),
        )
      }
      else {
        const mode = result === null ? 'downloaded' : result.mode
        body = h('div', { className: 'dsh-slim-body', role: 'status' },
          h('h3', { className: 'dsh-slim-section' }, t('result.title')),
          h('p', { className: 'dsh-slim-summary-line' }, t('result.name', { title: result === null ? '' : result.title })),
          h('p', { className: 'dsh-slim-summary-line' }, t('result.turns', {
            kept: String(result === null ? 0 : result.keptTurns),
            removed: String(result === null ? 0 : result.removedTurns),
          })),
          amplifyCoverage === null ? null : h('p', { className: 'dsh-slim-warn' }, t('result.partial', {
            percent: String(Math.floor((amplifyCoverage.ratio ?? 0) * 100)),
          })),
          h('p', { className: 'dsh-slim-note' }, mode === 'imported'
            ? t('result.imported', { count: String(result !== null && result.sessionIds !== undefined ? result.sessionIds.length : 0) })
            : t(result !== null && result.hasPlugin === false ? 'result.downloadedNoPlugin' : 'result.downloaded', {
              name: result === null ? '' : result.fileName,
            })),
        )
        footer = h('div', { className: 'dsh-slim-foot' },
          h('button', { type: 'button', className: 'dsh-slim-button', onClick: startOver }, t('dialog.retry')),
          h('button', { type: 'button', className: 'dsh-slim-button dsh-slim-primary', onClick: onClose }, t('result.done')),
        )
      }

      /** Display name of the workspace the summary session will join. */
      const workspaceNameOf = (id) => {
        for (const workspace of workspaces) {
          if (workspace !== null && typeof workspace === 'object' && workspace.workspaceId === id) {
            return typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : id
          }
        }
        return typeof id === 'string' ? id : ''
      }

      const amplifyWarn = amplifyDialog && amplifyPlan !== null        ? h('div', { className: 'dsh-slim-overlay', role: 'presentation' },
          h('div', {
            className: 'dsh-slim-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-slim-amplify-title',
            tabIndex: -1,
          },
            h('div', { className: 'dsh-slim-head' },
              h('div', { className: 'dsh-slim-titlebox' },
                h('h2', { className: 'dsh-slim-title', id: 'dsh-slim-amplify-title' }, t('amplify.title')),
              ),
            ),
            h('div', { className: 'dsh-slim-body' },
              h('p', { className: 'dsh-slim-summary-line' },
                t('amplify.lead', { count: String(amplifyPlan.removedTurns) })),
              h('ul', { className: 'dsh-slim-bullets' },
                h('li', null, t('amplify.workspace', { name: workspaceNameOf(chosenWorkspaceId) })),
                h('li', null, t('amplify.model')),
                h('li', null, t('amplify.segments', { count: String(amplifyPlan.segments.length) })),
                h('li', null, t('amplify.cost')),
                h('li', null, t('amplify.failure')),
              ),
            ),
            h('div', { className: 'dsh-slim-foot' },
              h('button', {
                type: 'button',
                className: 'dsh-slim-button',
                onClick: () => { setAmplifyDialog(false); setAmplifyOn(false); setAmplifyPhase('idle') },
              }, t('dialog.cancel')),
              h('button', {
                type: 'button',
                className: 'dsh-slim-button dsh-slim-primary',
                onClick: () => { void runAmplify() },
              }, t('amplify.confirm')),
            ),
          ),
        )
        : null

      // While minimized the wizard collapses to a floating panel, so the rest of DSH
      // stays usable and the run is still visible.
      const amplifiedBusy = amplifyPhase === 'running' || amplifyPhase === 'stalled'
      if (amplifyMin && amplifiedBusy) {
        const elapsedSeconds = amplifyStartedAt === 0 ? 0 : Math.max(0, Math.round((Date.now() - amplifyStartedAt) / 1000))
        const dragHandlers = {
          onPointerDown: (event) => {
            const panel = event.currentTarget.parentElement
            if (panel === null) return
            const box = panel.getBoundingClientRect()
            floatDrag.current = { dx: event.clientX - box.left, dy: event.clientY - box.top }
            setFloatPos({ x: box.left, y: box.top })
            if (typeof event.currentTarget.setPointerCapture === 'function') {
              try {
                event.currentTarget.setPointerCapture(event.pointerId)
              }
              catch {
                /* capture is a nicety, dragging works without it */
              }
            }
          },
          onPointerMove: (event) => {
            const drag = floatDrag.current
            if (drag === null) return
            const width = event.currentTarget.parentElement === null ? 260 : event.currentTarget.parentElement.offsetWidth
            const maxX = Math.max(8, window.innerWidth - width - 8)
            const maxY = Math.max(8, window.innerHeight - 60)
            setFloatPos({
              x: Math.max(8, Math.min(maxX, event.clientX - drag.dx)),
              y: Math.max(8, Math.min(maxY, event.clientY - drag.dy)),
            })
          },
          onPointerUp: () => { floatDrag.current = null },
          onPointerCancel: () => { floatDrag.current = null },
        }
        return h('div', {
          className: 'dsh-slim-float',
          role: 'status',
          style: floatPos === null
            ? undefined
            // Clear right/bottom while dragging: with top+bottom both set and height auto
            // the box would stretch from edge to edge instead of keeping its size.
            // transform must go too, or the centred translate would offset the new left/top.
            : { left: `${floatPos.x}px`, top: `${floatPos.y}px`, right: 'auto', bottom: 'auto', transform: 'none' },
        },
          h('div', { className: 'dsh-slim-float-head', style: { cursor: 'grab', touchAction: 'none' }, ...dragHandlers },
            h('span', { className: 'dsh-slim-float-title' }, t('amplify.miniTitle')),
            h('div', { className: 'dsh-slim-head-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-slim-icon-button',
                onPointerDown: (event) => { event.stopPropagation() },
                onClick: () => { setAmplifyMin(false) },
                'aria-label': t('amplify.expand'),
                title: t('amplify.expand'),
              }, '⤢'),
              h('span', { className: 'dsh-slim-float-spacer', 'aria-hidden': 'true' }),
            ),
          ),
          h('p', { className: 'dsh-slim-float-line' }, t('amplify.progress', { count: String(amplifyProgress.count) })),
          h('p', { className: 'dsh-slim-float-meta' },
            `${formatElapsed(elapsedSeconds)} · ${t('amplify.used', { tokens: formatTokens(amplifyTokens) })}`),
          h('button', {
            type: 'button',
            className: 'dsh-slim-button',
            onClick: () => { void cancelAmplify() },
          }, t('amplify.cancel')),
        )
      }

      return h(React.Fragment, null,
        h('div', { className: 'dsh-slim-overlay', role: 'presentation' },
          h('div', {
            className: 'dsh-slim-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-slim-title',
            tabIndex: -1,
            ref: surface,
          }, header, body, footer),
        ),
        amplifyWarn,
      )
    }

    /** Long-press duration on the sidebar trigger that toggles forced-recall mode. */
    const LONG_PRESS_MS = 1000

    /**
     * The sidebar trigger and, while open, the wizard.
     *
     * Holding the trigger for a second toggles forced-recall mode for the conversation in
     * view. It only works there if the conversation is a revived one: the paragraph tells
     * the model to use a tool that session does not have, so the plugin's answer decides
     * rather than the UI guessing.
     */
    function SlimAction(props) {
      const t = makeT(props)
      const [open, setOpen] = useState(false)
      const wide = props.wide === true
      const useSessions = hookFrom(props, 'useSessions')
      const sessionsById = useSessions(state => state.byId) || {}
      const currentSessionId = useMemo(() => {
        for (const session of Object.values(sessionsById)) {
          if (session === null || typeof session !== 'object') continue
          if (session.retainedBy !== undefined && session.retainedBy !== null && (session.retainedBy.mainView || 0) > 0) return session.id
        }
        return undefined
      }, [sessionsById])

      const [recall, setRecall] = useState(null)
      const [hint, setHint] = useState(null)
      const [picker, setPicker] = useState(false)
      const press = useRef(null)
      const suppressClick = useRef(false)
      const hintTimer = useRef(null)

      /** Show one short-lived line of feedback under the sidebar. */
      const flash = useCallback((text) => {
        setHint(text)
        if (hintTimer.current !== null) clearTimeout(hintTimer.current)
        hintTimer.current = setTimeout(() => { setHint(null); hintTimer.current = null }, 2200)
      }, [])

      /** Read the mode for the conversation in view. */
      const refresh = useCallback(async () => {
        if (typeof currentSessionId !== 'string') { setRecall(null); return }
        try {
          const response = await fetch(routeUrl(FORCE_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId }),
          })
          if (!response.ok) { setRecall(null); return }
          const payload = await response.json()
          setRecall(payload !== null && typeof payload === 'object'
            ? {
              revived: payload.revived === true,
              mode: typeof payload.mode === 'string' ? payload.mode : 'off',
              archive: payload.archive === true,
            }
            : null)
        }
        catch {
          setRecall(null)
        }
      }, [currentSessionId])

      useEffect(() => { void refresh() }, [refresh])

      useEffect(() => () => {
        if (press.current !== null) clearTimeout(press.current)
        if (hintTimer.current !== null) clearTimeout(hintTimer.current)
      }, [])

      /** Write the mode and report what the host actually stored. */
      const apply = useCallback(async (mode) => {
        if (typeof currentSessionId !== 'string') return
        try {
          const response = await fetch(routeUrl(FORCE_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, mode }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            flash(t('recall.failed'))
            return
          }
          const stored = typeof payload.mode === 'string' ? payload.mode : 'off'
          setRecall({ revived: true, mode: stored, archive: payload.archive === true })
          flash(t(`recall.hint.${stored}`))
        }
        catch {
          flash(t('recall.failed'))
        }
      }, [currentSessionId, flash, t])

      /** Toggle "archive what compaction drops" for the conversation in view. */
      const applyArchive = useCallback(async (enabled) => {
        if (typeof currentSessionId !== 'string') return
        try {
          const response = await fetch(routeUrl(FORCE_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, archive: enabled }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            flash(t('recall.failed'))
            return
          }
          setRecall({
            revived: true,
            mode: typeof payload.mode === 'string' ? payload.mode : 'off',
            archive: payload.archive === true,
          })
          flash(t(payload.archive === true ? 'recall.archive.flashOn' : 'recall.archive.flashOff'))
        }
        catch {
          flash(t('recall.failed'))
        }
      }, [currentSessionId, flash, t])

      /** A finished long press: open the picker, or explain why it cannot. */
      const longPress = useCallback(() => {
        suppressClick.current = true
        if (recall === null || recall.revived !== true) {
          flash(t(recall === null ? 'recall.failed' : 'recall.notRevived'))
          return
        }
        setPicker(true)
      }, [flash, recall, t])

      const startPress = useCallback((event) => {
        if (event !== undefined && event.button !== undefined && event.button !== 0) return
        if (press.current !== null) clearTimeout(press.current)
        press.current = setTimeout(() => {
          press.current = null
          longPress()
        }, LONG_PRESS_MS)
      }, [longPress])

      const cancelPress = useCallback(() => {
        if (press.current !== null) { clearTimeout(press.current); press.current = null }
      }, [])

      const mode = recall === null ? 'off' : recall.mode
      const label = `${t('recall.title')}：${t(`recall.mode.${mode}`)}`
      const triggerTone = mode === 'off' ? '' : mode === 'tone' ? ' dsh-slim-trigger-amber' : ' dsh-slim-trigger-red'

      return h(React.Fragment, null,
        props.children === undefined ? null : props.children,
        h('button', {
          type: 'button',
          className: `dsh-slim-trigger${triggerTone}`,
          'aria-label': `${t('action.label')} — ${label}`,
          title: `${t('action.label')}（长按 1 秒：${label}）`,
          onPointerDown: startPress,
          onPointerUp: cancelPress,
          onPointerLeave: cancelPress,
          onPointerCancel: cancelPress,
          onKeyDown: (event) => {
            // Keyboard equivalent of the long press.
            if (event.key !== ' ' && event.key !== 'Enter') return
            if (!event.altKey) return
            event.preventDefault()
            longPress()
          },
          onClick: () => {
            if (suppressClick.current) { suppressClick.current = false; return }
            setOpen(true)
          },
        }, h(TriggerIcon, { size: wide ? 16 : 18 })),
        hint === null ? null : h('div', { className: 'dsh-slim-toast', role: 'status' }, hint),
        picker ? h('div', { className: 'dsh-slim-confirm', role: 'dialog', 'aria-modal': 'true' },
          h('h3', { className: 'dsh-slim-confirm-title' }, t('recall.title')),
          h('p', { className: 'dsh-slim-confirm-body' }, t('recall.body')),
          h('div', { className: 'dsh-slim-mode-list' },
            ...['off', 'tone', 'fact'].map(option => {
              const active = mode === option
              return h('button', {
                key: option,
                type: 'button',
                className: `dsh-slim-button dsh-slim-mode${active ? ' dsh-slim-primary' : ''}`,
                'aria-pressed': active,
                onClick: () => { setPicker(false); void apply(option) },
              }, t(`recall.mode.${option}`))
            }),
          ),
          h('div', { className: 'dsh-slim-archive' },
            h('div', { className: 'dsh-slim-archive-text' },
              h('strong', null, t('recall.archive.title')),
              h('p', null, t('recall.archive.body')),
            ),
            h('button', {
              type: 'button',
              className: `dsh-slim-button dsh-slim-mode${recall?.archive === true ? ' dsh-slim-primary' : ''}`,
              'aria-pressed': recall?.archive === true,
              onClick: () => { void applyArchive(!(recall?.archive === true)) },
            }, t(recall?.archive === true ? 'recall.archive.on' : 'recall.archive.off')),
          ),
        ) : null,
        open ? h(Wizard, { props, t, onClose: () => { setOpen(false); void refresh() } }) : null,
      )
    }

    /**
     * Register the dictionaries, the stylesheet, and the sidebar action.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      ctxRef = ctx
      ctx.effect(() => {
        if (ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.register === 'function') {
          return ctx.locale.register(NS, { zh: ZH, en: EN })
        }
        return undefined
      }, 'session-slim: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = 'dsh-session-slim-styles'
        style.textContent = STYLES
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'session-slim: styles')
      ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
        name: 'sidebar.session.action',
        id: 'dsh-session-slim',
        locale: NS,
      }, SlimAction))
    }

    /** Theme-token-only stylesheet; every colour resolves from the host theme. */
    const STYLES = `
.dsh-slim-trigger{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;margin-left:4px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;opacity:.72;cursor:pointer;flex:0 0 auto}
.dsh-slim-trigger:hover{opacity:1;background:var(--dsw-alias-fill-quaternary,rgba(128,128,128,.16))}
.dsh-slim-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:1px}
/* Forced-recall on: the same trigger turns red. */
.dsh-slim-trigger-red{color:#dc2626;opacity:1}
.dsh-slim-trigger-red:hover{color:#dc2626;background:rgba(220,38,38,.12)}
.dsh-slim-trigger-amber{color:#d97706;opacity:1}
.dsh-slim-trigger-amber:hover{color:#d97706;background:rgba(217,119,6,.12)}
.dsh-slim-toast{position:fixed;left:50%;bottom:28px;z-index:1100;transform:translateX(-50%);max-width:min(420px,80vw);padding:7px 14px;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.32));border-radius:999px;background:var(--dsw-alias-bg-elevated,Canvas);color:var(--dsw-alias-text-primary,CanvasText);box-shadow:0 8px 24px rgba(0,0,0,.28);font:inherit;font-size:12px;line-height:1.4;text-align:center;pointer-events:none}
.dsh-slim-confirm{position:fixed;left:50%;top:50%;z-index:1100;transform:translate(-50%,-50%);width:min(360px,86vw);padding:18px 18px 14px;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.32));border-radius:12px;background:var(--dsw-alias-bg-elevated,Canvas);color:var(--dsw-alias-text-primary,CanvasText);box-shadow:0 16px 48px rgba(0,0,0,.38);font:inherit;font-size:13px;line-height:1.5}
.dsh-slim-confirm-title{margin:0 0 8px;font-size:14px;font-weight:600}
.dsh-slim-confirm-body{margin:0 0 14px;color:var(--dsw-alias-text-secondary,GrayText);font-size:12.5px}
.dsh-slim-confirm-actions{display:flex;justify-content:flex-end;gap:8px}
.dsh-slim-mode-list{display:flex;flex-direction:column;gap:8px}
.dsh-slim-mode{width:100%;justify-content:flex-start}
.dsh-slim-archive{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.32))}
.dsh-slim-archive-text{min-width:0;flex:1 1 auto}
.dsh-slim-archive-text strong{display:block;font-size:13px;font-weight:600}
.dsh-slim-archive-text p{margin:2px 0 0;color:var(--dsw-alias-text-secondary,GrayText);font-size:12px;line-height:1.45}
.dsh-slim-archive>.dsh-slim-mode{width:auto;flex:0 0 auto;min-width:64px;justify-content:center}
.dsh-slim-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}
.dsh-slim-dialog{display:flex;flex-direction:column;width:min(620px,100%);max-height:min(86vh,760px);border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.32));border-radius:12px;background:var(--dsw-alias-bg-elevated,Canvas);color:var(--dsw-alias-text-primary,CanvasText);box-shadow:0 16px 48px rgba(0,0,0,.38);font:inherit;font-size:13px;line-height:1.5;overflow:hidden}
.dsh-slim-dialog:focus{outline:none}
.dsh-slim-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 8px}
.dsh-slim-head-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto}
.dsh-slim-titlebox{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-slim-title{margin:0;font-size:15px;font-weight:600}
.dsh-slim-steps{margin:0;font-size:12px;color:var(--dsw-alias-text-secondary,GrayText)}
.dsh-slim-icon-button{width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer}
.dsh-slim-icon-button:hover{background:var(--dsw-alias-fill-quaternary,rgba(128,128,128,.16))}
.dsh-slim-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:4px 18px 14px}
.dsh-slim-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 18px 16px;border-top:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.24))}
.dsh-slim-section{margin:0;font-size:13px;font-weight:600}
.dsh-slim-note{margin:0;font-size:12px;color:var(--dsw-alias-text-secondary,GrayText)}
.dsh-slim-summary-line{margin:0;font-size:13px}
.dsh-slim-warn{margin:0;font-size:12px;color:var(--dsw-alias-text-warning,#b45309)}
.dsh-slim-error{padding:8px 10px;border:1px solid var(--dsw-alias-text-danger,#b91c1c);border-radius:8px;color:var(--dsw-alias-text-danger,#b91c1c);font-size:12px;word-break:break-word}
.dsh-slim-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.36));border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.dsh-slim-button:hover:not(:disabled){background:var(--dsw-alias-fill-quaternary,rgba(128,128,128,.16))}
.dsh-slim-button:disabled{opacity:.5;cursor:default}
.dsh-slim-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:1px}
.dsh-slim-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,Highlight);color:var(--dsw-alias-brand-on-primary,HighlightText)}
.dsh-slim-drop{display:flex;flex-direction:column;align-items:center;gap:10px;padding:26px 16px;border:1px dashed var(--dsw-alias-border-strong,GrayText);border-radius:10px;text-align:center}
.dsh-slim-drop-active{border-color:var(--dsw-alias-brand-primary,Highlight);background:var(--dsw-alias-fill-quaternary,rgba(128,128,128,.1))}
.dsh-slim-drop-hint{margin:0;font-size:12px;color:var(--dsw-alias-text-secondary,GrayText)}
.dsh-slim-hidden{display:none}
.dsh-slim-search,.dsh-slim-select,.dsh-slim-number,.dsh-slim-textarea{padding:5px 9px;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.36));border-radius:7px;background:transparent;color:inherit;font:inherit}
.dsh-slim-search{width:100%}
.dsh-slim-select{width:100%}
.dsh-slim-number{width:84px;flex:0 0 auto}
.dsh-slim-textarea{width:100%;box-sizing:border-box;min-height:72px;resize:vertical}
.dsh-slim-list{display:flex;flex-direction:column;gap:6px;padding-right:2px}
.dsh-slim-row{display:flex;flex-direction:column;gap:4px;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.28));border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-slim-row:hover{background:var(--dsw-alias-fill-quaternary,rgba(128,128,128,.12))}
.dsh-slim-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:1px}
.dsh-slim-rowhead{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.dsh-slim-rowtitle{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-slim-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-text-secondary,GrayText)}
.dsh-slim-meta-item{white-space:nowrap}
.dsh-slim-badge{padding:1px 7px;border:1px solid currentColor;border-radius:999px;font-size:11px;white-space:nowrap;flex:0 0 auto}
.dsh-slim-badge-warn{color:var(--dsw-alias-text-warning,#b45309)}
.dsh-slim-field{display:flex;flex-direction:column;gap:6px}
.dsh-slim-label{font-weight:500}
.dsh-slim-keeprow{display:flex;align-items:center;gap:10px}
.dsh-slim-range{flex:1 1 auto;accent-color:var(--dsw-alias-brand-primary,Highlight)}
.dsh-slim-float{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);right:auto;bottom:auto;z-index:1200;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;width:260px;max-width:calc(100vw - 40px);padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.32));border-radius:12px;background:var(--dsw-alias-bg-elevated,Canvas);color:var(--dsw-alias-text-primary,CanvasText);box-shadow:0 12px 32px rgba(0,0,0,.28);font:inherit;font-size:12px}
.dsh-slim-float-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
/* Matches the width the dialog header spends on its close button, so the expand
   icon lands right on top of the collapse icon instead of jumping when toggled. */
.dsh-slim-float-spacer{width:28px;height:1px;flex:0 0 auto}
.dsh-slim-float-title{font-weight:600}
.dsh-slim-float-line{margin:0}
.dsh-slim-float-meta{margin:0;color:var(--dsw-alias-text-secondary,GrayText)}
.dsh-slim-nuke{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
/* Bare glyph: no border, no fill, no circle - just the symbol as the hit target. */
.dsh-slim-nuke-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 auto;padding:0;border:0;border-radius:0;background:none;color:var(--dsw-alias-text-secondary,GrayText);cursor:pointer;transition:color .15s,text-shadow .15s,transform .15s}
.dsh-slim-nuke-btn:hover:not(:disabled){color:var(--dsw-alias-text-primary,CanvasText);transform:scale(1.08)}
.dsh-slim-nuke-btn:active:not(:disabled){transform:scale(.96)}
.dsh-slim-nuke-btn:disabled{opacity:.45;cursor:default}
.dsh-slim-nuke-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:2px}
.dsh-slim-nuke-icon{font-size:20px;line-height:1}
.dsh-slim-nuke-on{color:var(--dsw-alias-text-warning,#b45309);text-shadow:0 0 8px rgba(180,83,9,.55)}
.dsh-slim-nuke-label{font-weight:500}
.dsh-slim-bullets{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-text-secondary,GrayText)}
`

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply,
    }
  },
})
