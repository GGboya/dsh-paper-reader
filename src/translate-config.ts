// translate-config.ts — 翻译端点配置的落盘与解析（纯函数，不依赖 Cordis）。
//
// 存 $DSH_HOME/.dsh-paper-reader/translate.json（0600）——刻意不放 dataDir：
// dataDir 是文献库目录，可能被 git / 云盘同步出去，密钥不该跟着走。
// 优先级：显式选择的 file/profile 覆盖 > 部署方 profile 默认 > Harness 当前模型。
// 自定义密钥只落盘、只回显掩码；Harness 跟随只保存 activeId='harness'，不复制宿主凭据。

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TranslateEndpoint } from './translate.ts'
import {
  DEFAULT_TRANSLATION_RUN_OPTIONS,
  sanitizeTranslationRunOptions,
  validateTranslationRunOptions,
  type TranslationRunOptions,
} from './translation-options.ts'
import { dshHome } from './library.ts'
import { isOpenCodeEndpoint, openCodeSessionHeaders, openCodeSessionId } from './opencode.ts'
// 预检会把端点响应体片段拼进错误文案，必须先脱敏（否则端点回显 Authorization 时 key 会泄露）。
// 这里复用 MinerU 客户端里已经过三轮评审的 sanitizeDetail（含 URL 编码 / JSON 转义 / 短 key
// 词边界处理）。mineru.ts 运行时只 import node:zlib（对 mineru-config.ts 是 type-only import），
// 所以 translate-config → mineru 是单向依赖，**不会形成运行时循环**。
import { sanitizeDetail } from './mineru.ts'

/** 端点来源：Harness=跟随宿主当前模型；file/profile=翻译专用覆盖；none=当前环境无法解析。 */
export type EndpointSource = 'file' | 'profile' | 'harness' | 'none'

export interface ResolvedEndpoint {
  endpoint: TranslateEndpoint
  source: EndpointSource
}

export interface StoredTranslateEndpoint extends TranslateEndpoint {
  id: string
  label?: string
  /** 设置页预设 id（deepseek/openai/anthropic/gemini/zhipu/custom），仅用于 UI 归组。 */
  provider?: string
}

export interface TranslateEndpointStore {
  activeId: string | null
  endpoints: StoredTranslateEndpoint[]
  options: TranslationRunOptions
}

export function translateConfigPath(home: string = dshHome()): string {
  return join(home, '.dsh-paper-reader', 'translate.json')
}

/** 三项齐全才算配好——babeldoc 的 --openai/--openai-model/--openai-base-url 缺一不可。 */
function isComplete(e: TranslateEndpoint | null | undefined): e is Required<TranslateEndpoint> {
  return Boolean(e?.baseUrl && e?.apiKey && e?.model)
}

/** 按字段合并多个来源，靠后的覆盖靠前的；空字段不参与（避免 undefined 冲掉已有值）。 */
function pick(...sources: Array<TranslateEndpoint | null | undefined>): TranslateEndpoint {
  const out: TranslateEndpoint = {}
  for (const s of sources) {
    if (!s) continue
    if (s.baseUrl) out.baseUrl = s.baseUrl
    if (s.apiKey) out.apiKey = s.apiKey
    if (s.model) out.model = s.model
  }
  return out
}

function endpointFields(rec: object): TranslateEndpoint {
  const raw = rec as Record<string, unknown>
  const out: TranslateEndpoint = {}
  if (typeof raw['baseUrl'] === 'string') out.baseUrl = raw['baseUrl']
  if (typeof raw['apiKey'] === 'string') out.apiKey = raw['apiKey']
  if (typeof raw['model'] === 'string') out.model = raw['model']
  return out
}

/** 新格式是多端点；旧版单对象自动视为 id=legacy 的第一项，读取无需用户重配。 */
function parseStore(data: unknown): TranslateEndpointStore {
  if (typeof data !== 'object' || data === null) return { activeId: null, endpoints: [], options: { ...DEFAULT_TRANSLATION_RUN_OPTIONS } }
  const rec = data as Record<string, unknown>
  const endpoints: StoredTranslateEndpoint[] = []
  if (Array.isArray(rec['endpoints'])) {
    for (const item of rec['endpoints']) {
      if (typeof item !== 'object' || item === null) continue
      const e = item as Record<string, unknown>
      if (typeof e['id'] !== 'string' || !e['id']) continue
      endpoints.push({
        id: e['id'],
        ...(typeof e['label'] === 'string' && e['label'] ? { label: e['label'] } : {}),
        ...(typeof e['provider'] === 'string' && e['provider'] ? { provider: e['provider'] } : {}),
        ...endpointFields(e),
      })
    }
  } else {
    const legacy = endpointFields(rec)
    if (legacy.baseUrl || legacy.apiKey || legacy.model) endpoints.push({ id: 'legacy', ...legacy })
  }
  const requested = typeof rec['activeId'] === 'string' ? rec['activeId'] : null
  // 空库缺省跟随 Harness；已有文件配置的老用户仍选中自己的端点，不被升级改写。
  const activeId = requested === 'profile' || requested === 'harness' || endpoints.some((e) => e.id === requested)
    ? requested
    : (endpoints[0]?.id ?? 'harness')
  return { activeId, endpoints, options: sanitizeTranslationRunOptions(rec['options']) }
}

export async function readTranslateEndpointStore(home: string = dshHome()): Promise<TranslateEndpointStore> {
  try { return parseStore(JSON.parse(await readFile(translateConfigPath(home), 'utf8'))) }
  catch { return { activeId: null, endpoints: [], options: { ...DEFAULT_TRANSLATION_RUN_OPTIONS } } }
}

async function writeStore(store: TranslateEndpointStore, home: string): Promise<void> {
  const file = translateConfigPath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600)
}

/** 兼容旧调用方：读出当前选中端点。 */
export async function readTranslateConfig(home: string = dshHome()): Promise<TranslateEndpoint | null> {
  const store = await readTranslateEndpointStore(home)
  const active = store.activeId === 'profile' ? null : store.endpoints.find((e) => e.id === store.activeId) ?? store.endpoints[0]
  return active ? endpointFields(active) : null
}

/** 兼容旧调用方：单端点写入会替换整个文件；UI 多端点保存走 saveTranslateEndpoint。 */
export async function writeTranslateConfig(cfg: TranslateEndpoint, home: string = dshHome()): Promise<void> {
  const current = await readTranslateEndpointStore(home)
  await writeStore({ activeId: 'legacy', endpoints: [{ id: 'legacy', ...cfg }], options: current.options }, home)
}

/** 新建/更新并选中一个端点；id='new' 强制新增，缺省 id 更新当前项（旧 UI 语义）。 */
export async function saveTranslateEndpoint(
  cfg: Required<TranslateEndpoint>,
  options: { id?: string; label?: string; provider?: string; home?: string } = {},
): Promise<StoredTranslateEndpoint> {
  const home = options.home ?? dshHome()
  const store = await readTranslateEndpointStore(home)
  const existing = options.id === 'new'
    ? undefined
    : store.endpoints.find((e) => e.id === (options.id ?? store.activeId))
  const label = options.label?.trim() || existing?.label
  const provider = options.provider?.trim() || existing?.provider
  const entry: StoredTranslateEndpoint = {
    id: existing?.id ?? randomUUID(),
    ...(label ? { label } : {}),
    ...(provider ? { provider } : {}),
    ...cfg,
  }
  const endpoints = existing
    ? store.endpoints.map((e) => e.id === existing.id ? entry : e)
    : [...store.endpoints, entry]
  await writeStore({ activeId: entry.id, endpoints, options: store.options }, home)
  return entry
}

/** 记住生成时选择的来源；harness 不删除任何自定义端点，切回时可继续使用。 */
export async function selectTranslateEndpoint(id: string, home: string = dshHome()): Promise<void> {
  const store = await readTranslateEndpointStore(home)
  if (!['profile', 'harness'].includes(id) && !store.endpoints.some((e) => e.id === id)) throw new Error('翻译端点不存在')
  await writeStore({ ...store, activeId: id }, home)
}

/** 删除单个端点；删当前项后选中下一项。无剩余文件端点时 resolve 会回落 profile。 */
export async function deleteTranslateEndpoint(id: string, home: string = dshHome()): Promise<void> {
  const store = await readTranslateEndpointStore(home)
  const endpoints = store.endpoints.filter((e) => e.id !== id)
  await writeStore({ activeId: store.activeId === id ? (endpoints[0]?.id ?? null) : store.activeId, endpoints, options: store.options }, home)
}

/** 更新整篇 PDF 的运行参数；与选择哪个端点无关，写回时不改变 activeId。 */
export async function writeTranslateRunOptions(input: unknown, home: string = dshHome()): Promise<TranslationRunOptions> {
  const options = validateTranslationRunOptions(input)
  const store = await readTranslateEndpointStore(home)
  await writeStore({ ...store, options }, home)
  return options
}

/** 删除配置（回落到 profile 的 translate）。文件不存在也算成功。 */
export async function clearTranslateConfig(home: string = dshHome()): Promise<void> {
  await rm(translateConfigPath(home), { force: true })
}

/** 解析生效来源：显式 harness 永远跟随宿主；空库有 profile 时兼容部署默认，否则跟随宿主。 */
export async function resolveTranslateEndpoint(
  profile?: TranslateEndpoint,
  home: string = dshHome(),
  endpointId?: string,
): Promise<ResolvedEndpoint> {
  const store = await readTranslateEndpointStore(home)
  if (endpointId === 'harness' || (!endpointId && store.activeId === 'harness')) return { endpoint: {}, source: 'harness' }
  if (endpointId === 'profile' || (!endpointId && store.activeId === 'profile')) return isComplete(profile)
    ? { endpoint: profile, source: 'profile' }
    : { endpoint: {}, source: 'none' }
  const selected = endpointId
    ? store.endpoints.find((e) => e.id === endpointId)
    : store.endpoints.find((e) => e.id === store.activeId) ?? store.endpoints[0]
  const file = selected ? endpointFields(selected) : null
  if (isComplete(file)) return { endpoint: file, source: 'file' }
  if (!endpointId && isComplete(profile)) return { endpoint: profile, source: 'profile' }
  // 全新安装没有任何专用配置时默认跟随；显式选择了一个残缺端点仍如实报 none。
  if (!endpointId && !file) return { endpoint: {}, source: 'harness' }
  return { endpoint: endpointId ? (file ?? {}) : pick(profile, file), source: 'none' }
}

/** 掩码展示：只露头 3 尾 4，够用户认出是哪把 key，又不足以还原。 */
export function maskApiKey(key: string): string {
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`
}

/**
 * 连接预检：打一发极小的 chat/completions，确认 url/key/model 三者匹配。
 * 必要性：babeldoc 一次要跑几分钟且**异步失败**（错误只落进 translate.ts 的 busy map），
 * key 填错要等很久才知道，所以在落盘前先拦。
 */
export async function testTranslateEndpoint(ep: TranslateEndpoint): Promise<{ ok: boolean; detail?: string }> {
  const { baseUrl, apiKey, model } = ep
  if (!baseUrl || !apiKey || !model) return { ok: false, detail: '端点配置不完整（需要 url + key + 模型）' }
  // OpenCode Go 的预检请求也要带会话头（文档要求每次推理请求都带）；其它端点空对象，零行为变化
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  if (isOpenCodeEndpoint(baseUrl)) {
    const sessionId = await openCodeSessionId(`translate-precheck:${baseUrl.replace(/\/+$/, '')}|${model}`)
    Object.assign(headers, openCodeSessionHeaders(baseUrl, sessionId))
  }
  try {
    const r = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      // max_tokens:1 —— 只要能证明鉴权与模型名有效，不产生实际费用
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok) {
      // 智谱系网关切错路径时（如 /api/v1）会回 HTTP 200 + {"code":1001,"success":false}，
      // 只看状态码会误判成功，babeldoc 跑起来才炸。真成功必须有 choices。
      // 上限放宽到 4000：GLM 等响应字段多，max_tokens:1 也有几百字节；
      // 历史上 slice(0,300) 把合法 JSON 截断导致 parse 失败、误报「不是补全结果」（0.6.2 修复）
      const text = (await r.text().catch(() => '')).slice(0, 4000)
      try {
        const data = JSON.parse(text) as { choices?: unknown }
        if (Array.isArray(data.choices)) return { ok: true }
      } catch { /* 非 JSON 也算失败，走下面报 body */ }
      // 响应体可能回显 Authorization / 错误页：先按本次 key 脱敏再截断展示（保留排查价值）
      return { ok: false, detail: `HTTP 200 但响应不是补全结果：${sanitizeDetail(text.slice(0, 200), apiKey)}（多半是端点路径不对，如智谱应为 /api/paas/v4）` }
    }
    const text = (await r.text().catch(() => '')).slice(0, 200)
    return { ok: false, detail: `HTTP ${r.status}${text ? ' ' + sanitizeDetail(text, apiKey) : ''}` }
  } catch (err) {
    // Node 的 fetch 把真实原因（ECONNREFUSED / 证书错误 / 超时）塞在 cause 里，
    // 只报 "fetch failed" 对用户毫无帮助
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
    // ⚠️ t7（t4 评审 R-04 的同类项）：这条 detail 会进响应体、再上屏（设置浮层）。
    // fetch 抛出的原因串可能带上 baseUrl（含凭据/查询参数）或回显 Authorization ——
    // 与同函数上面两条分支一样先过 sanitizeDetail；可读原因（ECONNREFUSED 等）不受影响。
    return { ok: false, detail: sanitizeDetail((err instanceof Error ? err.message : String(err)) + cause, apiKey) }
  }
}

/** 自动获取 OpenAI 兼容端点可见的聊天模型；只读，不落盘 Key，也不发推理请求。 */
export async function listTranslateModels(
  endpoint: { baseUrl?: string; apiKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; models: string[]; detail?: string }> {
  const baseUrl = endpoint.baseUrl?.trim().replace(/\/+$/, '') ?? ''
  const apiKey = endpoint.apiKey?.trim() ?? ''
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, models: [], detail: '端点 URL 需要以 http:// 或 https:// 开头' }
  if (!apiKey) return { ok: false, models: [], detail: '请先填写 API Key' }
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }
  // Anthropic 的 /v1/models 使用原生鉴权头；其 chat/completions 仍走 OpenAI 兼容模式。
  if (/^https:\/\/api\.anthropic\.com(?:\/|$)/i.test(baseUrl)) {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  }
  try {
    const r = await fetchImpl(baseUrl + '/models', { headers, signal: AbortSignal.timeout(15_000) })
    const text = (await r.text().catch(() => '')).slice(0, 2_000_000)
    if (!r.ok) return { ok: false, models: [], detail: `HTTP ${r.status}${text ? ' ' + sanitizeDetail(text.slice(0, 200), apiKey) : ''}` }
    let data: unknown
    try { data = JSON.parse(text) } catch { return { ok: false, models: [], detail: '模型列表响应不是合法 JSON' } }
    const rec = data as { data?: unknown; models?: unknown }
    const rows = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : []
    const models: string[] = []
    for (const row of rows) {
      const raw = typeof row === 'string'
        ? row
        : typeof row === 'object' && row !== null
          ? (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name
          : null
      if (typeof raw !== 'string' || !raw) continue
      const id = raw.replace(/^models\//, '')
      // 列表端点常混入嵌入/语音/重排模型，它们不能用于 chat/completions。
      if (/(?:embedding|embed-|rerank|whisper|tts|transcribe|moderation|dall-e|image)/i.test(id)) continue
      if (!models.includes(id)) models.push(id)
    }
    if (!models.length) return { ok: false, models: [], detail: '端点没有返回可用于翻译的模型，请在高级设置中手动填写' }
    return { ok: true, models: models.slice(0, 200) }
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
    return { ok: false, models: [], detail: sanitizeDetail((err instanceof Error ? err.message : String(err)) + cause, apiKey) }
  }
}
