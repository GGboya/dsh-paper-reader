// translate-config.ts — 翻译端点配置的落盘与解析（纯函数，不依赖 Cordis）。
//
// 存 $DSH_HOME/.dsh-paper-reader/translate.json（0600）——刻意不放 dataDir：
// dataDir 是文献库目录，可能被 git / 云盘同步出去，密钥不该跟着走。
// 优先级：文件 > profile 的 cordis.patch.yml config.translate（后者退为部署方默认值）。
// 密钥只落盘、只回显掩码：任何读接口都不返回明文（apiKeyHint 是掩码后的展示串）。

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TranslateEndpoint } from './translate.ts'
import { dshHome } from './library.ts'

/** 端点当前值的来源：file=UI 里填的 / profile=部署方 YAML / none=都没配全 */
export type EndpointSource = 'file' | 'profile' | 'none'

export interface ResolvedEndpoint {
  endpoint: TranslateEndpoint
  source: EndpointSource
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

/** 读配置；文件缺失/损坏/形状不对一律返回 null（与 study.ts 的读策略一致）。 */
export async function readTranslateConfig(home: string = dshHome()): Promise<TranslateEndpoint | null> {
  try {
    const data = JSON.parse(await readFile(translateConfigPath(home), 'utf8')) as unknown
    if (typeof data !== 'object' || data === null) return null
    const rec = data as Record<string, unknown>
    const out: TranslateEndpoint = {}
    if (typeof rec['baseUrl'] === 'string') out.baseUrl = rec['baseUrl']
    if (typeof rec['apiKey'] === 'string') out.apiKey = rec['apiKey']
    if (typeof rec['model'] === 'string') out.model = rec['model']
    return out
  } catch {
    return null
  }
}

/** 写配置。0600：文件含明文密钥，不靠 umask。 */
export async function writeTranslateConfig(cfg: TranslateEndpoint, home: string = dshHome()): Promise<void> {
  const file = translateConfigPath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600) // mode 只在新建时生效；已存在的文件要显式收紧
}

/** 删除配置（回落到 profile 的 translate）。文件不存在也算成功。 */
export async function clearTranslateConfig(home: string = dshHome()): Promise<void> {
  await rm(translateConfigPath(home), { force: true })
}

/** 解析生效端点：文件配全则用文件，否则用 profile，都配不全则返回能凑到的部分供报错。 */
export async function resolveTranslateEndpoint(
  profile?: TranslateEndpoint,
  home: string = dshHome(),
): Promise<ResolvedEndpoint> {
  const file = await readTranslateConfig(home)
  if (isComplete(file)) return { endpoint: file, source: 'file' }
  if (isComplete(profile)) return { endpoint: profile, source: 'profile' }
  return { endpoint: pick(profile, file), source: 'none' }
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
  try {
    const r = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      // max_tokens:1 —— 只要能证明鉴权与模型名有效，不产生实际费用
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok) {
      // 智谱系网关切错路径时（如 /api/v1）会回 HTTP 200 + {"code":1001,"success":false}，
      // 只看状态码会误判成功，babeldoc 跑起来才炸。真成功必须有 choices。
      const text = (await r.text().catch(() => '')).slice(0, 300)
      try {
        const data = JSON.parse(text) as { choices?: unknown }
        if (Array.isArray(data.choices)) return { ok: true }
      } catch { /* 非 JSON 也算失败，走下面报 body */ }
      return { ok: false, detail: `HTTP 200 但响应不是补全结果：${text.slice(0, 200)}（多半是端点路径不对，如智谱应为 /api/paas/v4）` }
    }
    const text = (await r.text().catch(() => '')).slice(0, 200)
    return { ok: false, detail: `HTTP ${r.status}${text ? ' ' + text : ''}` }
  } catch (err) {
    // Node 的 fetch 把真实原因（ECONNREFUSED / 证书错误 / 超时）塞在 cause 里，
    // 只报 "fetch failed" 对用户毫无帮助
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
    return { ok: false, detail: (err instanceof Error ? err.message : String(err)) + cause }
  }
}
