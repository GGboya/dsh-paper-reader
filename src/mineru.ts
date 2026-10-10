// mineru.ts — MinerU 解析后端（纯函数，不依赖 Cordis）。
//
// 两条路径统一返回 MineruParseResult：
//   1. 本地 legacy API：优先异步 POST /tasks → 轮询 GET /tasks/{id}/result（§2.5 冻结的生产路径），
//      另保留同步 /file_parse 作为集成测试用冒烟入口（不进工具调用路径）。
//   2. mineru.net v4 云端：POST /file-urls/batch → PUT 预签名 URL（不带 Content-Type）→
//      轮询 GET /extract-results/batch/{id} → 下载 zip → 解出 full.md + *_content_list.json。
//      ⚠️ 本机无 mineru.net token，云端序列全程【未实测】，仅按 refs/llm-for-zotero 落地 + mock 单测。
//
// content_list 是 JSON 字符串，必须 JSON.parse（§2.4 实测）；块按 page_idx（0 起）聚页，
// 投影成与 pdfjs 路径同构的 .txt + .pages.json（page = page_idx + 1，1 起）。

import { inflateRawSync } from 'node:zlib'
import type { PageSpan } from './transcribe.ts'
import type { MineruCloudModel, MineruLocalBackend, MineruParseMethod } from './mineru-config.ts'

/** content_list 里的单个块（原始透传，字段宽松，未知字段/未知 type 都不得抛错）。 */
export type MineruBlock = Record<string, unknown>

export interface MineruProjection {
  text: string
  pages: PageSpan[]
  pageCount: number
  warnings: string[]
}

export interface MineruMeta {
  kind: 'mineru-local' | 'mineru-cloud'
  api: 'legacy' | 'v4'
  baseUrl: string
  serverVersion?: string
  backend?: string
  effort?: string
  parseMethod?: string
  langList?: string[]
  taskId?: string
  batchId?: string
  modelVersion?: string
  elapsedMs: number
  observedStatuses?: string[]
}

export interface MineruParseResult {
  /** md_content 原样（可为空串；本地服务端产物缺失时为 null → 这里落成空串，由上层判空）。 */
  markdown: string
  /** JSON.parse(content_list) 的原样数组（不重排、不删字段）。 */
  blocks: MineruBlock[]
  projection: MineruProjection
  meta: MineruMeta
}

/** MinerU 错误：附带 HTTP 状态码（可为 null）与经过脱敏的 message。 */
export class MineruError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'MineruError'
  }
}

/** 令牌类字符集：短密钥只在两侧都不是这些字符时才替换（见 redactSecret）。 */
const TOKEN_CHAR_CLASS = '[A-Za-z0-9._~+/=@-]'
/** 长度达到该值的密钥按字面量全量替换；更短的走「词边界」替换，避免毁掉整条消息。 */
const SHORT_SECRET_LITERAL_MIN = 4

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 抹掉本次请求实际使用的 key（服务端把 token 原样回显时的最后一道保险）。
 * - 长度 ≥4：按字面量全量替换，保证任何拼装形式都不泄露；
 * - 长度 1~3：只替换「独立出现」的那一段（前后都不是令牌字符），既不泄露又不会把
 *   正文里的普通单词（例如包含该片段的 `abcdef`）一起抹掉（验证报告 O7）。
 * - 同时处理**变形回显**：服务端可能把 key 以 URL 编码或 JSON 转义后的形式写进错误页，
 *   这两种变体也一并抹掉（key 只在 URL 里出现过时也能堵住）。
 */
function redactSecret(msg: string, secret: string): string {
  if (!secret) return msg
  const variants = new Set<string>([secret])
  const urlEncoded = encodeURIComponent(secret)
  if (urlEncoded !== secret) variants.add(urlEncoded)
  const jsonEscaped = secret.replace(/[\\"]/g, (c) => `\\${c}`)
  if (jsonEscaped !== secret) variants.add(jsonEscaped)

  let out = msg
  for (const v of variants) {
    out = v.length >= SHORT_SECRET_LITERAL_MIN
      ? out.split(v).join('[redacted]')
      : out.replace(new RegExp(`(?<!${TOKEN_CHAR_CLASS})${escapeRegExp(v)}(?!${TOKEN_CHAR_CLASS})`, 'g'), '[redacted]')
  }
  return out
}

/**
 * 把可能的令牌/URL 从错误信息里抹掉：日志与工具输出都不允许出现明文 key。
 * `secret` 是本次请求实际使用的 key——服务端（或中间代理）把 token 原样回显在
 * 错误体里时，只有按字面量替换才能保证不泄露，所以调用点一律把 key 传进来。
 * 导出供 `mineru-config.ts` 的预检复用（预检也会把响应体片段拼进错误，见 F-R2-1）。
 */
export function sanitizeDetail(msg: string, secret = ''): string {
  const out = redactSecret(msg, secret)
  return out
    // Bearer 之后只吃到「不可能属于令牌」的字符为止：不要把紧跟的 ) ] } , ; 引号 一起吃掉（验证报告 O4）
    .replace(/Bearer\s+[^\s)\]}>"',;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, '[redacted]')
    .replace(/[?&](?:token|access_token|signature|Signature|Expires)=[^\s&"']+/gi, (m) => `${m.split('=')[0]}=[redacted]`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 从服务端错误体里取可读 message（脱敏；secret=本次请求的 key）。 */
function errorDetail(body: unknown, secret = ''): string {
  if (!isRecord(body)) return ''
  const msg = body['error'] ?? body['detail'] ?? body['message'] ?? body['msg'] ?? body['err_msg']
  if (typeof msg === 'string' && msg.trim()) return sanitizeDetail(msg, secret)
  if (isRecord(msg)) {
    const inner = msg['message'] ?? msg['msg']
    if (typeof inner === 'string') return sanitizeDetail(inner, secret)
  }
  return ''
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MineruError('解析已取消')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new MineruError('解析已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 组合外部 signal 与单次请求超时（Node 22 有 AbortSignal.any）。 */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const signals: AbortSignal[] = []
  if (signal) signals.push(signal)
  signals.push(AbortSignal.timeout(timeoutMs))
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals)
}

/** 读取 JSON 响应；非 JSON 返回 null。 */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '')
  try { return JSON.parse(text) } catch { return null }
}

// ── 块投影（§7.4 冻结规则）───────────────────────────────────────────────

/** 表格 HTML 剥标签：标签替换成空格、解基本实体、折成单行。 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function blockStr(b: MineruBlock, key: string): string | null {
  const v = b[key]
  return typeof v === 'string' ? v : null
}

function blockStrArr(b: MineruBlock, key: string): string[] {
  const v = b[key]
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function blockPageIdx(b: MineruBlock): number | null {
  const v = b['page_idx']
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

/** 单块投影为纯文本；无内容返回 null（未知 type 有 text 用 text，有 list_items 用条目，否则跳过）。 */
function blockToText(b: MineruBlock): string | null {
  const text = blockStr(b, 'text')
  if (text && text.trim()) return text
  const listItems = blockStrArr(b, 'list_items')
  if (listItems.length) return listItems.join('\n')
  const type = typeof b['type'] === 'string' ? b['type'] : ''
  if (type === 'table') {
    const parts: string[] = []
    const caption = blockStrArr(b, 'table_caption')
    if (caption.length) parts.push(caption.join(' '))
    const body = blockStr(b, 'table_body')
    if (body) {
      const stripped = stripHtmlTags(body)
      if (stripped) parts.push(stripped)
    }
    const footnote = blockStrArr(b, 'table_footnote')
    if (footnote.length) parts.push(footnote.join(' '))
    return parts.length ? parts.join('\n') : null
  }
  if (type === 'image' || type === 'chart') {
    const parts: string[] = []
    const caption = blockStrArr(b, 'image_caption').concat(blockStrArr(b, 'chart_caption'))
    if (caption.length) parts.push(caption.join(' '))
    const footnote = blockStrArr(b, 'image_footnote')
    if (footnote.length) parts.push(footnote.join(' '))
    return parts.length ? parts.join('\n') : null
  }
  return null
}

/**
 * 把 content_list 数组投影成 .txt + .pages.json 的形状。
 * 页内块用 \n\n 连接，页间也用 \n\n；page = page_idx + 1（1 起）。
 * 块缺 page_idx 归到上一个有 page_idx 的块页码，之前没有则归第 1 页（记 warnings）。
 */
export function projectContentList(blocks: MineruBlock[], warnings: string[] = []): MineruProjection {
  const pageTexts = new Map<number, string[]>()
  let lastPage = 0
  let maxPage = 0
  for (const b of blocks) {
    const idx = blockPageIdx(b)
    let page: number
    if (idx !== null) {
      page = idx + 1
      lastPage = page
    } else {
      page = lastPage || 1
      if (lastPage === 0) warnings.push('content_list 首个块缺少 page_idx，已归到第 1 页')
      else warnings.push(`content_list 存在缺少 page_idx 的块，已归到第 ${page} 页`)
    }
    maxPage = Math.max(maxPage, page)
    const text = blockToText(b)
    if (text === null) continue
    const arr = pageTexts.get(page) ?? []
    arr.push(text)
    pageTexts.set(page, arr)
  }

  const sortedPages = [...pageTexts.keys()].sort((a, b) => a - b)
  let buf = ''
  const pages: PageSpan[] = []
  for (const page of sortedPages) {
    const pageText = pageTexts.get(page)!.join('\n\n')
    if (!pageText) continue
    const start = buf.length === 0 ? 0 : buf.length + 2
    buf = buf.length === 0 ? pageText : `${buf}\n\n${pageText}`
    pages.push({ page, start, end: buf.length })
  }
  return { text: buf, pages, pageCount: Math.max(1, maxPage), warnings }
}

/** JSON.parse(content_list)。content_list 是 JSON 字符串（§2.4 实测），必须是数组。 */
export function parseContentListString(s: string | null | undefined): MineruBlock[] | null {
  if (s === null || s === undefined) return null
  let v: unknown
  try {
    v = JSON.parse(s)
  } catch {
    throw new MineruError('MinerU 返回的 content_list 不是合法 JSON 字符串')
  }
  if (!Array.isArray(v)) throw new MineruError('MinerU 返回的 content_list 不是数组')
  return v as MineruBlock[]
}

// ── 本地 legacy API（异步 /tasks 轮询为生产路径）─────────────────────────

export interface LocalMineruOptions {
  baseUrl: string
  apiKey: string
  backend: MineruLocalBackend
  effort: 'medium' | 'high'
  parseMethod: MineruParseMethod
  serverUrl: string
  langList: string[]
  imageAnalysis: boolean
  requestTimeoutMs: number
  pollIntervalMs: number
  noResponseTimeoutMs: number
  jobTimeoutMs: number
  pdfBytes: Uint8Array
  fileName: string
  signal?: AbortSignal
  report?: (msg: string) => void
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

/** 组装 /file_parse 与 /tasks 共用的 multipart 参数（§2.2 参数表）。 */
function buildLocalForm(opts: LocalMineruOptions): FormData {
  const form = new FormData()
  form.append('files', new Blob([opts.pdfBytes], { type: 'application/pdf' }), opts.fileName)
  form.append('backend', opts.backend)
  form.append('return_md', 'true')
  form.append('return_content_list', 'true')
  form.append('return_middle_json', 'false')
  form.append('response_format_zip', 'false')
  form.append('formula_enable', 'true')
  form.append('table_enable', 'true')
  form.append('image_analysis', opts.imageAnalysis ? 'true' : 'false')
  form.append('parse_method', opts.parseMethod)
  form.append('effort', opts.effort)
  for (const lang of opts.langList) form.append('lang_list', lang)
  if (opts.serverUrl) form.append('server_url', opts.serverUrl)
  return form
}

function baseNoSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** 从 results + file_names 拼出统一结果。取结果键用响应里的 file_names[0]（§2.2 实测）。 */
function buildResult(
  results: unknown,
  fileNames: unknown,
  fallback: { baseUrl: string; backend: string; version?: string | undefined; taskId?: string | undefined; started: number; observedStatuses: string[]; opts: LocalMineruOptions },
): MineruParseResult {
  const names = Array.isArray(fileNames) ? fileNames.filter((x): x is string => typeof x === 'string') : []
  const resultsRec = isRecord(results) ? results : {}
  let entry: Record<string, unknown> | null = null
  const key = names[0]
  if (key && isRecord(resultsRec[key])) entry = resultsRec[key] as Record<string, unknown>
  if (!entry) {
    const first = Object.values(resultsRec).find(isRecord)
    entry = first ?? null
  }
  if (!entry) throw new MineruError('MinerU 响应缺少 results（或 results 为空对象）')

  const md = entry['md_content']
  const contentListStr = entry['content_list']
  const markdown = typeof md === 'string' ? md : ''
  const blocks = parseContentListString(typeof contentListStr === 'string' ? contentListStr : null) ?? []
  const warnings: string[] = []
  const projection = projectContentList(blocks, warnings)

  const version = typeof fallback.version === 'string' ? fallback.version : undefined
  const meta: MineruMeta = {
    kind: 'mineru-local',
    api: 'legacy',
    baseUrl: fallback.baseUrl,
    ...(version ? { serverVersion: version } : {}),
    backend: fallback.backend,
    effort: fallback.opts.effort,
    parseMethod: fallback.opts.parseMethod,
    langList: fallback.opts.langList,
    ...(fallback.taskId ? { taskId: fallback.taskId } : {}),
    elapsedMs: Date.now() - fallback.started,
    observedStatuses: fallback.observedStatuses,
  }
  return { markdown, blocks, projection, meta }
}

/**
 * 本地 MinerU 异步解析：POST /tasks → 轮询 GET /tasks/{id}/result。
 * result 端点三种 HTTP 码必须区分（§2.3）：202=未就绪、200=完成、409=解析失败（不是服务忙）。
 */
export async function parseLocalMineru(opts: LocalMineruOptions): Promise<MineruParseResult> {
  throwIfAborted(opts.signal)
  const base = baseNoSlash(opts.baseUrl)
  const started = Date.now()
  const observedStatuses: string[] = []
  const report = opts.report ?? (() => {})

  // 提交（POST /tasks → 202 pending）。缺 files/扩展名不合法会在此 400/422。
  let submitRes: Response
  try {
    submitRes = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: authHeaders(opts.apiKey),
      body: buildLocalForm(opts),
      signal: requestSignal(opts.signal, opts.requestTimeoutMs),
    })
  } catch (err) {
    throwIfAborted(opts.signal)
    throw new MineruError(`本地 MinerU 提交失败：${sanitizeDetail(networkMessage(err), opts.apiKey)}`)
  }
  const submitBody = await readJson(submitRes)
  if (!submitRes.ok) {
    throw new MineruError(`本地 MinerU 提交失败（HTTP ${submitRes.status}）${errorDetail(submitBody, opts.apiKey) ? `：${errorDetail(submitBody, opts.apiKey)}` : ''}`, submitRes.status)
  }
  if (!isRecord(submitBody) || typeof submitBody['task_id'] !== 'string') {
    throw new MineruError('本地 MinerU 提交响应缺少 task_id')
  }
  const taskId = submitBody['task_id']
  const fileNames = submitBody['file_names']
  const submitStatus = typeof submitBody['status'] === 'string' ? submitBody['status'] : ''
  if (submitStatus) observedStatuses.push(submitStatus)
  report(`本地 MinerU 已提交任务（${taskId.slice(0, 8)}…，${submitStatus || 'pending'}）`)

  // 轮询 result 端点：202/200/409/404/网络错 分别处理（§2.3 冻结）。
  let lastResponseAt = Date.now()
  let poll = 0
  while (true) {
    throwIfAborted(opts.signal)
    if (Date.now() - started >= opts.jobTimeoutMs) {
      throw new MineruError(`本地 MinerU 解析超时（超过 ${Math.round(opts.jobTimeoutMs / 1000)}s）。legacy API 没有取消端点，放弃等待后服务端任务可能仍在跑。`)
    }
    let res: Response
    try {
      res = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}/result`, {
        headers: authHeaders(opts.apiKey),
        signal: requestSignal(opts.signal, opts.requestTimeoutMs),
      })
    } catch (err) {
      throwIfAborted(opts.signal)
      // 网络错/超时视为可重试，但受 noResponseTimeout 约束（§2.5）。
      if (Date.now() - lastResponseAt >= opts.noResponseTimeoutMs) {
        throw new MineruError(`本地 MinerU 持续无响应（超过 ${Math.round(opts.noResponseTimeoutMs / 1000)}s），请检查或重启本地 MinerU 服务`)
      }
      report(`本地 MinerU 状态查询失败，重试中…（${sanitizeDetail(networkMessage(err), opts.apiKey)}）`)
      await sleep(backoffMs(poll++, opts.pollIntervalMs), opts.signal)
      continue
    }
    const status = res.status
    const body = await readJson(res)
    if (status === 200) {
      lastResponseAt = Date.now()
      const backend = isRecord(body) && typeof body['backend'] === 'string' ? body['backend'] : opts.backend
      const version = isRecord(body) && typeof body['version'] === 'string' ? body['version'] : undefined
      const results = isRecord(body) ? body['results'] : undefined
      report('本地 MinerU 解析完成')
      return buildResult(results, fileNames, { baseUrl: base, backend, version, taskId, started, observedStatuses, opts })
    }
    if (status === 202) {
      lastResponseAt = Date.now()
      const st = isRecord(body) && typeof body['status'] === 'string' ? body['status'] : 'processing'
      if (st && !observedStatuses.includes(st)) observedStatuses.push(st)
      report(`本地 MinerU 解析中…（${st}）`)
      await sleep(backoffMs(poll++, opts.pollIntervalMs), opts.signal)
      continue
    }
    if (status === 409) {
      // 409 = 解析失败（不是「服务忙」），不重试（§2.3 / 易踩坑 2）。
      throw new MineruError(`本地 MinerU 解析失败（HTTP 409）${errorDetail(body, opts.apiKey) ? `：${errorDetail(body, opts.apiKey)}` : ''}`, 409)
    }
    if (status === 404) {
      throw new MineruError('本地 MinerU 已丢失该任务（HTTP 404），服务可能重启了，请重试', 404)
    }
    if (status === 401 || status === 403) {
      throw new MineruError(`本地 MinerU 拒绝鉴权（HTTP ${status}），请检查本地 API Key`, status)
    }
    if (status >= 500 || status === 429 || status === 408) {
      if (Date.now() - lastResponseAt >= opts.noResponseTimeoutMs) {
        throw new MineruError(`本地 MinerU 持续返回错误（HTTP ${status}，超过 ${Math.round(opts.noResponseTimeoutMs / 1000)}s），请检查或重启服务`, status)
      }
      report(`本地 MinerU 暂时不可用（HTTP ${status}），重试中…`)
      await sleep(backoffMs(poll++, opts.pollIntervalMs), opts.signal)
      continue
    }
    throw new MineruError(`本地 MinerU 返回意外状态（HTTP ${status}）${errorDetail(body, opts.apiKey) ? `：${errorDetail(body, opts.apiKey)}` : ''}`, status)
  }
}

/** 同步 /file_parse：仅用于集成测试冒烟（§2.5，不进工具调用路径）。 */
export async function parseLocalMineruSync(opts: LocalMineruOptions): Promise<MineruParseResult> {
  throwIfAborted(opts.signal)
  const base = baseNoSlash(opts.baseUrl)
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(`${base}/file_parse`, {
      method: 'POST',
      headers: authHeaders(opts.apiKey),
      body: buildLocalForm(opts),
      // 同步长连接可能持续数分钟，给足超时（jobTimeoutMs 作为单次上限）
      signal: requestSignal(opts.signal, opts.jobTimeoutMs),
    })
  } catch (err) {
    throwIfAborted(opts.signal)
    throw new MineruError(`本地 MinerU 同步解析失败：${sanitizeDetail(networkMessage(err), opts.apiKey)}`)
  }
  const body = await readJson(res)
  if (!res.ok) {
    throw new MineruError(`本地 MinerU 同步解析失败（HTTP ${res.status}）${errorDetail(body, opts.apiKey) ? `：${errorDetail(body, opts.apiKey)}` : ''}`, res.status)
  }
  if (!isRecord(body)) throw new MineruError('本地 MinerU 同步响应不是 JSON')
  const backend = typeof body['backend'] === 'string' ? body['backend'] : opts.backend
  const version = typeof body['version'] === 'string' ? body['version'] : undefined
  const taskId = typeof body['task_id'] === 'string' ? body['task_id'] : undefined
  return buildResult(body['results'], body['file_names'], { baseUrl: base, backend, version, taskId, started, observedStatuses: [], opts })
}

/** 退避：pollInterval × 1.5^poll，上限 10s（§2.5）。 */
function backoffMs(poll: number, baseMs: number): number {
  return Math.min(baseMs * 1.5 ** poll, 10_000)
}

function networkMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `：${err.cause.message}` : ''
    return `${err.name === 'TimeoutError' ? '请求超时' : err.message}${cause}`
  }
  return String(err)
}

// ── 最小 ZIP 读取器（method 0 / method 8，不引入新依赖）──────────────────

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const decoder = new TextDecoder('utf-8')

/**
 * 从 ZIP 字节里读出全部条目（EOCD → 中央目录 → local header）。
 * method 0 直取、method 8 inflateRaw；只用中央目录的 compSize 定位，兼容 data descriptor。
 */
export function extractZipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new MineruError('下载的结果不是 ZIP 文件')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 反向扫 EOCD（PK\x05\x06），容忍尾部注释
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new MineruError('下载的结果缺少 ZIP 结束标记（EOCD）')
  const total = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < total; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new MineruError('ZIP 中央目录损坏')
    const method = view.getUint16(p + 10, true)
    const compSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    const lnLen = view.getUint16(localOffset + 26, true)
    const leLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lnLen + leLen
    const raw = bytes.subarray(dataStart, dataStart + compSize)
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) data = inflateRawSync(raw)
    else throw new MineruError(`ZIP 压缩方式不支持（method ${method}）`)
    entries.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 取 full.md（否则任意 .md）与 *_content_list.json（否则 content_list.json）。 */
export function pickZipMarkdown(entries: ZipEntry[]): ZipEntry | undefined {
  return (
    entries.find((e) => /(^|[\\/])full\.md$/i.test(e.name)) ??
    entries.find((e) => e.name.toLowerCase().endsWith('.md'))
  )
}

export function pickZipContentList(entries: ZipEntry[]): ZipEntry | undefined {
  return (
    entries.find((e) => /content_list\.json$/i.test(e.name)) ??
    entries.find((e) => e.name.toLowerCase().endsWith('_content_list.json'))
  )
}

// ── mineru.net v4 云端序列（⚠️ 未实测，按 refs/llm-for-zotero 落地）───────

export interface CloudMineruOptions {
  baseUrl: string
  apiKey: string
  modelVersion: MineruCloudModel
  pollIntervalMs: number
  zipTimeoutMs: number
  pdfBytes: Uint8Array
  fileName: string
  signal?: AbortSignal
  report?: (msg: string) => void
}

const CLOUD_TERMINAL_CODES = new Set(['A0202', 'A0211', '-60012', '-60013'])
const CLOUD_DAILY_LIMIT_CODE = '-60018'
const CLOUD_NO_STATUS_TIMEOUT_MS = 10 * 60 * 1000
const CLOUD_PRE_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000
const CLOUD_RATE_LIMIT_MAX_POLL_INTERVAL_MS = 60 * 1000
const CLOUD_ZIP_RETRY_DELAYS_MS = [5000, 15000] as const
// CDN 证书 2026-10-02 过期，同一产物在 OSS 桶里有副本；只做精确 host 映射。
const MINERU_ZIP_HOST_FALLBACKS: Readonly<Record<string, string>> = {
  'cdn-mineru.openxlab.org.cn': 'mineru.oss-cn-shanghai.aliyuncs.com',
}

function cloudHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` }
}

/** 云端上传文件名 ASCII 化（非 ASCII → "_"），缓存仍按本地 stem 落盘。 */
export function asciiSanitize(fileName: string): string {
  return fileName.replace(/[^\x20-\x7E]/g, '_') || 'paper.pdf'
}

function rewriteZipHost(url: string): string {
  try {
    const u = new URL(url)
    const mapped = MINERU_ZIP_HOST_FALLBACKS[u.host]
    if (mapped) {
      u.host = mapped
      return u.href
    }
  } catch { /* 非法 URL 原样返回 */ }
  return url
}

export async function parseCloudMineru(opts: CloudMineruOptions): Promise<MineruParseResult> {
  throwIfAborted(opts.signal)
  const base = baseNoSlash(opts.baseUrl)
  const apiKey = opts.apiKey
  const started = Date.now()
  const report = opts.report ?? (() => {})
  if (!apiKey) throw new MineruError('云端 MinerU 需要 API Key（mineru.net 的 token）')

  const fileName = asciiSanitize(opts.fileName)

  // 1) 申请批量上传地址
  let batchRes: Response
  try {
    batchRes = await fetch(`${base}/file-urls/batch`, {
      method: 'POST',
      headers: { ...cloudHeaders(apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({
        enable_formula: true,
        enable_table: true,
        language: 'ch',
        model_version: opts.modelVersion,
        files: [{ name: fileName, is_ocr: false }],
      }),
      signal: requestSignal(opts.signal, 60_000),
    })
  } catch (err) {
    throwIfAborted(opts.signal)
    throw new MineruError(`云端 MinerU 申请上传地址失败：${sanitizeDetail(networkMessage(err), apiKey)}`)
  }
  const batchBody = await readJson(batchRes)
  if (batchRes.status === 429 || (isRecord(batchBody) && /rate.?limit|quota|exceeded|limit.*reached/i.test(String(batchBody['msg'] ?? '')))) {
    throw new MineruError('云端 MinerU 当日额度用尽或限流（HTTP 429）', 429)
  }
  if (!batchRes.ok) {
    throw new MineruError(`云端 MinerU 申请上传地址失败（HTTP ${batchRes.status}）${errorDetail(batchBody, apiKey) ? `：${errorDetail(batchBody, apiKey)}` : ''}`, batchRes.status)
  }
  const batchData = isRecord(batchBody) ? batchBody['data'] : undefined
  const batchId = isRecord(batchData) && typeof batchData['batch_id'] === 'string' ? batchData['batch_id'] : ''
  const fileUrls = isRecord(batchData) && Array.isArray(batchData['file_urls']) ? batchData['file_urls'].filter((x): x is string => typeof x === 'string') : []
  if (!batchId || fileUrls.length === 0) {
    throw new MineruError('云端 MinerU 响应缺少 batch_id 或 file_urls')
  }

  // 2) PUT 预签名 URL 上传字节（不带 Content-Type，OSS 签名不含它，加了会 403）
  report('云端 MinerU 上传中…')
  let putRes: Response
  try {
    putRes = await fetch(fileUrls[0]!, {
      method: 'PUT',
      body: opts.pdfBytes,
      signal: requestSignal(opts.signal, 60_000),
    })
  } catch (err) {
    throwIfAborted(opts.signal)
    throw new MineruError(`云端 MinerU 上传失败：${sanitizeDetail(networkMessage(err), apiKey)}`)
  }
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new MineruError(`云端 MinerU 上传失败（HTTP ${putRes.status}，预签名 URL）`, putRes.status)
  }

  // 3) 轮询结果
  const pollStartMs = Date.now()
  let lastStatusAtMs: number | null = null
  let activeStartedAtMs: number | null = null
  let rateLimitDelayMs = 0
  let polls = 0
  while (true) {
    throwIfAborted(opts.signal)
    const nowMs = Date.now()
    // 无状态超时 / 开始处理前等待上限（§3）
    if (lastStatusAtMs === null ? nowMs - pollStartMs >= CLOUD_NO_STATUS_TIMEOUT_MS : nowMs - lastStatusAtMs >= CLOUD_NO_STATUS_TIMEOUT_MS) {
      throw new MineruError('云端 MinerU 状态超时：长时间没有可识别状态')
    }
    if (activeStartedAtMs === null && nowMs - pollStartMs >= CLOUD_PRE_PROCESSING_TIMEOUT_MS) {
      throw new MineruError('云端 MinerU 等待开始处理超时（30 分钟）')
    }
    const delay = Math.max(opts.pollIntervalMs, rateLimitDelayMs)
    await sleep(delay, opts.signal)

    let pollRes: Response
    try {
      pollRes = await fetch(`${base}/extract-results/batch/${encodeURIComponent(batchId)}`, {
        headers: cloudHeaders(apiKey),
        signal: requestSignal(opts.signal, 60_000),
      })
    } catch (err) {
      throwIfAborted(opts.signal)
      report(`云端 MinerU 状态查询失败，重试中…（${sanitizeDetail(networkMessage(err), apiKey)}）`)
      continue
    }
    const pollBody = await readJson(pollRes)
    const code = isRecord(pollBody) ? pollBody['code'] : undefined
    const codeStr = code === undefined || code === null ? '' : String(code).trim()

    if (codeStr === CLOUD_DAILY_LIMIT_CODE) {
      throw new MineruError(`云端 MinerU 当日解析额度用尽（${CLOUD_DAILY_LIMIT_CODE}）${errorDetail(pollBody, apiKey) ? `：${errorDetail(pollBody, apiKey)}` : ''}`)
    }
    if (pollRes.status === 429) {
      rateLimitDelayMs = Math.min(Math.max(rateLimitDelayMs, opts.pollIntervalMs) * 2, CLOUD_RATE_LIMIT_MAX_POLL_INTERVAL_MS)
      report(`云端 MinerU 状态请求被限流，退避重试…`)
      continue
    }
    rateLimitDelayMs = 0
    if (pollRes.status === 401 || pollRes.status === 403) {
      throw new MineruError(`云端 MinerU 鉴权失败（HTTP ${pollRes.status}），token 无效或已过期`, pollRes.status)
    }
    if (codeStr && codeStr !== '0') {
      if (CLOUD_TERMINAL_CODES.has(codeStr)) {
        throw new MineruError(`云端 MinerU 返回不可重试错误（${codeStr}）${errorDetail(pollBody, apiKey) ? `：${errorDetail(pollBody, apiKey)}` : ''}`)
      }
      report(`云端 MinerU 状态暂时不可用（${codeStr}），重试中…`)
      continue
    }
    if (pollRes.status < 200 || pollRes.status >= 300) {
      report(`云端 MinerU 状态暂时不可用（HTTP ${pollRes.status}），重试中…`)
      continue
    }

    const pollData = isRecord(pollBody) ? pollBody['data'] : undefined
    const extractResult = isRecord(pollData) && Array.isArray(pollData['extract_result']) ? pollData['extract_result'][0] : undefined
    if (!isRecord(extractResult)) {
      report('云端 MinerU 尚未返回结果，等待中…')
      continue
    }
    const state = typeof extractResult['state'] === 'string' ? extractResult['state'].trim().toLowerCase() : ''
    if (state && !['waiting-file', 'pending', 'running', 'converting', 'done', 'failed'].includes(state)) {
      report(`云端 MinerU 返回未识别状态（${state.slice(0, 60)}），继续等待…`)
      continue
    }
    if (!state) {
      report('云端 MinerU 状态为空，等待中…')
      continue
    }
    lastStatusAtMs = Date.now()
    if ((state === 'running' || state === 'converting') && activeStartedAtMs === null) {
      activeStartedAtMs = Date.now()
    }
    polls++
    if (state === 'done') {
      const fullZipUrl = typeof extractResult['full_zip_url'] === 'string' ? extractResult['full_zip_url'] : ''
      if (!fullZipUrl) throw new MineruError('云端 MinerU 完成但缺少 full_zip_url')
      const result = await downloadCloudZip(fullZipUrl, opts)
      const meta: MineruMeta = {
        kind: 'mineru-cloud',
        api: 'v4',
        baseUrl: base,
        batchId,
        modelVersion: opts.modelVersion,
        elapsedMs: Date.now() - started,
      }
      return { ...result, meta }
    }
    if (state === 'failed') {
      throw new MineruError(`云端 MinerU 解析失败（state=failed）${errorDetail(extractResult, apiKey) ? `：${errorDetail(extractResult, apiKey)}` : ''}`)
    }
    report(`云端 MinerU 解析中…（${state}，${Math.round((Date.now() - pollStartMs) / 1000)}s）`)
  }
}

/** 下载 zip（重试 [5s,15s]）+ 解出 markdown 与 content_list。 */
async function downloadCloudZip(url: string, opts: CloudMineruOptions): Promise<{ markdown: string; blocks: MineruBlock[]; projection: MineruProjection }> {
  const target = rewriteZipHost(url)
  let bytes: Uint8Array | null = null
  let lastErr: unknown = null
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(opts.signal)
    try {
      const res = await fetch(target, { signal: requestSignal(opts.signal, opts.zipTimeoutMs) })
      if (res.ok) {
        bytes = new Uint8Array(await res.arrayBuffer())
        break
      }
      lastErr = new MineruError(`下载结果失败（HTTP ${res.status}）`, res.status)
    } catch (err) {
      throwIfAborted(opts.signal)
      lastErr = err
    }
    const delay = CLOUD_ZIP_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) break
    await sleep(delay, opts.signal)
  }
  if (!bytes) throw new MineruError(`云端 MinerU 下载结果失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)

  const entries = extractZipEntries(bytes)
  const md = pickZipMarkdown(entries)
  if (!md) throw new MineruError('云端 MinerU 结果 zip 里没有 Markdown 文件')
  const markdown = decoder.decode(md.data)
  if (!markdown.trim()) throw new MineruError('云端 MinerU 结果 Markdown 为空（可能为纯图片 PDF）')

  let blocks: MineruBlock[] = []
  const clEntry = pickZipContentList(entries)
  if (clEntry) {
    let parsed: unknown
    try {
      parsed = JSON.parse(decoder.decode(clEntry.data))
    } catch {
      throw new MineruError('云端 MinerU content_list 文件不是合法 JSON')
    }
    // 兼容「直接是数组」与「{content_list:[...]}」两种布局
    const arr = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed['content_list']) ? parsed['content_list'] : []
    blocks = arr as MineruBlock[]
  }
  const warnings: string[] = []
  const projection = projectContentList(blocks, warnings)
  return { markdown, blocks, projection }
}
