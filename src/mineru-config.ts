// mineru-config.ts — MinerU 解析后端的配置落盘与解析（纯函数，不依赖 Cordis）。
//
// 存 $DSH_HOME/.dsh-paper-reader/mineru.json（0600）——与 translate/typesafe 同一套约定：
// dataDir 是文献库目录，可能被 git / 云盘同步，密钥不该跟着走。
// 优先级（逐字段）：文件 > profile 的 cordis.patch.yml config.mineru > 环境变量 > 默认值。
// 环境变量只冻结两个：MINERU_API_KEY（cloud.apiKey）、DSH_MINERU_LOCAL_URL（local.baseUrl）。
// 密钥只落盘、只回显掩码：任何读接口都不返回明文（apiKeyHint 是掩码后的展示串）。

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHome } from './library.ts'
import { maskApiKey } from './translate-config.ts'
// 预检会把响应体片段拼进错误文案，必须先脱敏（requirements §9.6 / 二轮评审 F-R2-1）。
// mineru.ts 对 mineru-config.ts 只有 type-only import（运行时无环），这里做值导入是安全的。
import { sanitizeDetail } from './mineru.ts'

export { maskApiKey }

/** MinerU 生效模式：off=关闭（走 pdfjs）/ local=本地 legacy API / cloud=mineru.net v4。 */
export type MineruMode = 'off' | 'local' | 'cloud'

/** 本地 backend 白名单（§2.2 枚举，默认 pipeline——不假设用户机器有 VLM 模型）。 */
export type MineruLocalBackend =
  | 'pipeline'
  | 'vlm-engine'
  | 'hybrid-engine'
  | 'vlm-http-client'
  | 'hybrid-http-client'

/** 云端 model_version 白名单（默认 pipeline）。 */
export type MineruCloudModel = 'pipeline' | 'vlm'

/** 本地解析方式（§2.2 parse_method）。 */
export type MineruParseMethod = 'auto' | 'txt' | 'ocr'

/** 配置当前值的来源：file=设置面板填的 / profile=部署方 YAML / env=环境变量 / none=没配。 */
export type MineruSource = 'file' | 'profile' | 'env' | 'none'

export interface MineruLocalConfig {
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
}

export interface MineruCloudConfig {
  baseUrl: string
  apiKey: string
  modelVersion: MineruCloudModel
  pollIntervalMs: number
  zipTimeoutMs: number
}

export interface MineruConfig {
  mode: MineruMode
  local: MineruLocalConfig
  cloud: MineruCloudConfig
}

/** 冻结的默认值（§9.2）。mode 默认 off，保证未配置时零行为变化。 */
export const MINERU_DEFAULTS: MineruConfig = {
  mode: 'off',
  local: {
    baseUrl: 'http://127.0.0.1:8000',
    apiKey: '',
    backend: 'pipeline',
    effort: 'medium',
    parseMethod: 'auto',
    serverUrl: '',
    langList: ['ch'],
    imageAnalysis: false,
    requestTimeoutMs: 60_000,
    pollIntervalMs: 1500,
    noResponseTimeoutMs: 600_000,
    jobTimeoutMs: 1_800_000,
  },
  cloud: {
    baseUrl: 'https://mineru.net/api/v4',
    apiKey: '',
    modelVersion: 'pipeline',
    pollIntervalMs: 3000,
    zipTimeoutMs: 300_000,
  },
}

const MODES: readonly MineruMode[] = ['off', 'local', 'cloud']
const BACKENDS: readonly MineruLocalBackend[] = ['pipeline', 'vlm-engine', 'hybrid-engine', 'vlm-http-client', 'hybrid-http-client']
const CLOUD_MODELS: readonly MineruCloudModel[] = ['pipeline', 'vlm']
const PARSE_METHODS: readonly MineruParseMethod[] = ['auto', 'txt', 'ocr']
const LANGS: readonly string[] = ['ch', 'ch_server', 'korean', 'ta', 'te', 'ka', 'th', 'el', 'arabic', 'east_slavic', 'cyrillic', 'devanagari']

export function mineruConfigPath(home: string = dshHome()): string {
  return join(home, '.dsh-paper-reader', 'mineru.json')
}

/** baseUrl 规范化：http(s)://origin + path（去尾斜杠），非法/为空回落到默认值（照抄参考实现）。 */
export function normalizeLocalBaseUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return MINERU_DEFAULTS.local.baseUrl
  try {
    const url = new URL(raw)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.host) {
      const path = url.pathname.replace(/\/+$/, '')
      return `${url.origin}${path}`
    }
  } catch { /* 非法 URL 回落到默认值 */ }
  return MINERU_DEFAULTS.local.baseUrl
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function strArr(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  const out = v.filter((x): x is string => typeof x === 'string')
  return out.length ? out : fallback
}
function modeOf(v: unknown): MineruMode {
  return MODES.includes(v as MineruMode) ? (v as MineruMode) : MINERU_DEFAULTS.mode
}
function backendOf(v: unknown): MineruLocalBackend {
  return BACKENDS.includes(v as MineruLocalBackend) ? (v as MineruLocalBackend) : MINERU_DEFAULTS.local.backend
}
function cloudModelOf(v: unknown): MineruCloudModel {
  return CLOUD_MODELS.includes(v as MineruCloudModel) ? (v as MineruCloudModel) : MINERU_DEFAULTS.cloud.modelVersion
}
function parseMethodOf(v: unknown): MineruParseMethod {
  return PARSE_METHODS.includes(v as MineruParseMethod) ? (v as MineruParseMethod) : MINERU_DEFAULTS.local.parseMethod
}
function langOf(v: unknown): string[] {
  const arr = strArr(v, [])
  return arr.every((l) => LANGS.includes(l)) ? arr : MINERU_DEFAULTS.local.langList
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function applyLocal(rec: Record<string, unknown> | undefined): MineruLocalConfig {
  const d = MINERU_DEFAULTS.local
  if (!rec) return { ...d }
  return {
    baseUrl: normalizeLocalBaseUrl(rec['baseUrl'] ?? d.baseUrl),
    apiKey: str(rec['apiKey'], d.apiKey),
    backend: backendOf(rec['backend']),
    effort: rec['effort'] === 'high' ? 'high' : d.effort,
    parseMethod: parseMethodOf(rec['parseMethod']),
    serverUrl: str(rec['serverUrl'], d.serverUrl),
    langList: langOf(rec['langList']),
    imageAnalysis: bool(rec['imageAnalysis'], d.imageAnalysis),
    requestTimeoutMs: num(rec['requestTimeoutMs'], d.requestTimeoutMs),
    pollIntervalMs: num(rec['pollIntervalMs'], d.pollIntervalMs),
    noResponseTimeoutMs: num(rec['noResponseTimeoutMs'], d.noResponseTimeoutMs),
    jobTimeoutMs: num(rec['jobTimeoutMs'], d.jobTimeoutMs),
  }
}

function applyCloud(rec: Record<string, unknown> | undefined): MineruCloudConfig {
  const d = MINERU_DEFAULTS.cloud
  if (!rec) return { ...d }
  return {
    baseUrl: str(rec['baseUrl'], d.baseUrl),
    apiKey: str(rec['apiKey'], d.apiKey),
    modelVersion: cloudModelOf(rec['modelVersion']),
    pollIntervalMs: num(rec['pollIntervalMs'], d.pollIntervalMs),
    zipTimeoutMs: num(rec['zipTimeoutMs'], d.zipTimeoutMs),
  }
}

/** 从原始 JSON 解析出 MineruConfig；没有任何已识别字段时返回 null。 */
function configFromRecord(data: unknown): MineruConfig | null {
  if (!isRecord(data)) return null
  const rec = data
  const local = isRecord(rec['local']) ? rec['local'] : undefined
  const cloud = isRecord(rec['cloud']) ? rec['cloud'] : undefined
  const hasAny = 'mode' in rec || local !== undefined || cloud !== undefined
  if (!hasAny) return null
  return {
    mode: modeOf(rec['mode']),
    local: applyLocal(local),
    cloud: applyCloud(cloud),
  }
}

/** 读配置文件原始 JSON（不做默认值填充）；文件缺失/损坏/非对象一律返回 null。 */
export async function readMineruConfigRecord(home: string = dshHome()): Promise<Record<string, unknown> | null> {
  try {
    const data = JSON.parse(await readFile(mineruConfigPath(home), 'utf8')) as unknown
    return isRecord(data) ? data : null
  } catch {
    return null
  }
}

/** 读配置；文件缺失/损坏/形状不对一律返回 null（与 translate-config 的读策略一致）。 */
export async function readMineruConfig(home: string = dshHome()): Promise<MineruConfig | null> {
  return configFromRecord(await readMineruConfigRecord(home))
}

/** 写配置。0600：文件含明文密钥，不靠 umask。 */
export async function writeMineruConfig(cfg: MineruConfig, home: string = dshHome()): Promise<void> {
  const file = mineruConfigPath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600) // mode 只在新建时生效；已存在的文件要显式收紧
}

/** 删除配置（回落到 profile / 环境变量）。文件不存在也算成功。 */
export async function clearMineruConfig(home: string = dshHome()): Promise<void> {
  await rm(mineruConfigPath(home), { force: true })
}

/** 逐字段合并多个 record：后面的覆盖前面的，只有「定义了」的字段才覆盖；嵌套对象浅合并。 */
function mergeRecords(...sources: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const src of sources) {
    if (!src) continue
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue
      if (isRecord(v) && isRecord(out[k])) {
        out[k] = mergeRecords(out[k] as Record<string, unknown>, v)
      } else {
        out[k] = v
      }
    }
  }
  return out
}

/** profile 是否提供了任一 mineru 字段（判定 source 用，§10.3）。 */
function profileHasFields(profile: unknown): boolean {
  if (!isRecord(profile)) return false
  return 'mode' in profile || 'local' in profile || 'cloud' in profile
}

export interface ResolvedMineru {
  config: MineruConfig
  source: MineruSource
}

/** 解析生效配置：逐字段 file > profile > env > 默认；source 按 §10.3 判定。 */
export async function resolveMineruConfig(
  profile?: MineruConfig,
  home: string = dshHome(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedMineru> {
  const file = await readMineruConfigRecord(home)
  // 只有文件里含「已识别的 mineru 字段」才算 file 来源；一个空对象或无关字段的
  // JSON 不应把来源标成 file（§10.3：文件存在**且含任一 mineru 字段** → file）。
  const fileRecognized = configFromRecord(file) !== null
  const envKey = env['MINERU_API_KEY']?.trim()
  const envLocalUrl = env['DSH_MINERU_LOCAL_URL']?.trim()

  // 环境变量层：只冻结两个变量，命中才参与合并（§9.4）
  const envLocal: Record<string, unknown> = {}
  if (envLocalUrl) envLocal['baseUrl'] = envLocalUrl
  const envCloud: Record<string, unknown> = {}
  if (envKey) envCloud['apiKey'] = envKey
  const envRec: Record<string, unknown> = {}
  if (Object.keys(envLocal).length) envRec['local'] = envLocal
  if (Object.keys(envCloud).length) envRec['cloud'] = envCloud

  // 合并顺序（后面的覆盖前面的）：默认 ← env ← profile ← file（§9.5 优先级）
  const merged = mergeRecords(envRec, profile as unknown as Record<string, unknown> | undefined, file)
  const config = configFromRecord(merged) ?? configFromRecord({ mode: MINERU_DEFAULTS.mode })!

  const source: MineruSource = fileRecognized
    ? 'file'
    : profileHasFields(profile)
      ? 'profile'
      : (envKey || envLocalUrl) ? 'env' : 'none'

  return { config, source }
}

/** 连通性预检：GET {baseUrl}/health（超时 5s）。判据与 §2.1 一致。 */
export async function testMineruLocal(
  baseUrl: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; detail?: string; version?: string; health?: Record<string, unknown> }> {
  const base = normalizeLocalBaseUrl(baseUrl)
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    const text = (await r.text().catch(() => '')).slice(0, 2000)
    let data: unknown = null
    try { data = JSON.parse(text) } catch { /* 非 JSON 走失败 */ }
    if (!r.ok) {
      // 响应体片段先脱敏再拼入（同 F-R2-1 的处理；此处不发 apiKey，属统一的模式加固）
      return { ok: false, detail: `HTTP ${r.status}${text ? ' ' + sanitizeDetail(text.slice(0, 120)) : ''}` }
    }
    if (!isRecord(data)) {
      return { ok: false, detail: '响应不是 JSON' }
    }
    if (!['healthy', 'ok'].includes(String(data['status'])) || typeof data['version'] !== 'string') {
      return { ok: false, detail: '不是已识别的 MinerU API 服务（status/version 缺失）' }
    }
    return { ok: true, version: data['version'], health: data }
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
    return { ok: false, detail: (err instanceof Error ? err.message : String(err)) + cause }
  }
}

/**
 * 云端 token 失效类业务码。mineru.net 可能以 **HTTP 200 + body.code** 的形式返回 token 错误，
 * 只判 401/403 会把坏 token 当「连通且有效」放行（评审 F1）。判据见 requirements §9.7：
 * 「401/403 / code A0202/A0211 → 报 token 错」。
 * 刻意**不**把 -60012/-60013 等「批次/任务不存在或无权」类码算进来——预检打的就是一个不存在的
 * 批次（`_test`），那类码是预期内的成功信号。
 */
const CLOUD_TOKEN_ERROR_CODES = new Set(['A0202', 'A0211'])

/** 云端预检：GET {baseUrl}/extract-results/batch/_test（故意不存在的批次 id）。 */
export async function testMineruCloud(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; detail?: string }> {
  const base = baseUrl.replace(/\/+$/, '') || MINERU_DEFAULTS.cloud.baseUrl
  if (!apiKey) return { ok: false, detail: '云端 API Key 不能为空' }
  try {
    const r = await fetch(`${base}/extract-results/batch/_test`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (r.status === 401 || r.status === 403) {
      return { ok: false, detail: `HTTP ${r.status}：云端 token 无效或已过期（请检查 mineru.net 的 API Key）` }
    }
    const text = (await r.text().catch(() => '')).slice(0, 2000)
    let body: unknown
    try { body = JSON.parse(text) } catch {
      // 非 JSON 响应体可能回显 Authorization/错误页：先按本次 key 脱敏再截断拼入（F-R2-1）
      return { ok: false, detail: `响应不是 JSON（HTTP ${r.status}）：${sanitizeDetail(text.slice(0, 120), apiKey)}` }
    }
    // HTTP 200 也可能是 token 失效（业务码判据，§9.7 / 评审 F1）：不查 body.code 会「假绿灯」落盘坏 token
    const code = isRecord(body) ? String(body['code'] ?? '').trim().toUpperCase() : ''
    if (CLOUD_TOKEN_ERROR_CODES.has(code)) {
      return { ok: false, detail: `云端 token 无效或已过期（业务码 ${code}，请检查 mineru.net 的 API Key）` }
    }
    // 能拿到 JSON 响应（含业务级「批次不存在」）即视为「连通 + token 有效」（§9.7）。
    return { ok: true }
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
    return { ok: false, detail: (err instanceof Error ? err.message : String(err)) + cause }
  }
}

/** 按生效 mode 分发预检。mode=off 无需预检直接通过。 */
export async function precheckMineruConfig(config: MineruConfig): Promise<{ ok: boolean; detail?: string }> {
  if (config.mode === 'off') return { ok: true }
  if (config.mode === 'local') {
    const t = await testMineruLocal(config.local.baseUrl)
    return t.ok ? { ok: true } : { ok: false, detail: `本地 MinerU 连接测试失败：${t.detail ?? '未知原因'}` }
  }
  const t = await testMineruCloud(config.cloud.baseUrl, config.cloud.apiKey)
  return t.ok ? { ok: true } : { ok: false, detail: `云端 MinerU 连接测试失败：${t.detail ?? '未知原因'}` }
}

/** 把设置面板 POST 的 body 合并进已有生效配置：apiKey 留空沿用已存值；非法枚举回落已有值；超时等不暴露字段保持原样。 */
export function mergeMineruBody(prev: MineruConfig, body: unknown): MineruConfig {
  const rec = isRecord(body) ? body : {}
  const localRec = isRecord(rec['local']) ? rec['local'] : {}
  const cloudRec = isRecord(rec['cloud']) ? rec['cloud'] : {}

  const localBaseUrl = typeof localRec['baseUrl'] === 'string' && localRec['baseUrl'].trim()
    ? normalizeLocalBaseUrl(localRec['baseUrl'])
    : prev.local.baseUrl
  const localApiKey = typeof localRec['apiKey'] === 'string' ? localRec['apiKey'].trim() : ''
  const cloudBaseUrlRaw = typeof cloudRec['baseUrl'] === 'string' ? cloudRec['baseUrl'].trim() : ''
  const cloudBaseUrl = cloudBaseUrlRaw || prev.cloud.baseUrl
  const cloudApiKey = typeof cloudRec['apiKey'] === 'string' ? cloudRec['apiKey'].trim() : ''

  return {
    mode: modeOf(rec['mode'] ?? prev.mode),
    local: {
      baseUrl: localBaseUrl,
      apiKey: localApiKey || prev.local.apiKey,
      backend: backendOf(localRec['backend'] ?? prev.local.backend),
      effort: localRec['effort'] === 'high' || localRec['effort'] === 'medium' ? localRec['effort'] : prev.local.effort,
      parseMethod: parseMethodOf(localRec['parseMethod'] ?? prev.local.parseMethod),
      serverUrl: typeof localRec['serverUrl'] === 'string' ? localRec['serverUrl'].trim() : prev.local.serverUrl,
      langList: localRec['langList'] !== undefined ? langOf(localRec['langList']) : prev.local.langList,
      imageAnalysis: typeof localRec['imageAnalysis'] === 'boolean' ? localRec['imageAnalysis'] : prev.local.imageAnalysis,
      requestTimeoutMs: prev.local.requestTimeoutMs,
      pollIntervalMs: prev.local.pollIntervalMs,
      noResponseTimeoutMs: prev.local.noResponseTimeoutMs,
      jobTimeoutMs: prev.local.jobTimeoutMs,
    },
    cloud: {
      baseUrl: cloudBaseUrl,
      apiKey: cloudApiKey || prev.cloud.apiKey,
      modelVersion: cloudModelOf(cloudRec['modelVersion'] ?? prev.cloud.modelVersion),
      pollIntervalMs: prev.cloud.pollIntervalMs,
      zipTimeoutMs: prev.cloud.zipTimeoutMs,
    },
  }
}
