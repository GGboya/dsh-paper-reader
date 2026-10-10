// embed-config.ts — OpenAI 兼容嵌入端点配置的落盘与解析（纯函数，不依赖 Cordis）。
//
// 与 translate-config.ts / typesafe-config.ts **同一套约定**：存
// $DSH_HOME/.dsh-paper-reader/embed.json（0600，刻意不放 dataDir——密钥不跟文献库/云盘走）；
// 密钥只落盘、只回显掩码（apiKeyHint）。优先级（逐字段）：
//   文件（设置面板填的）> profile 的 cordis.patch.yml config.embed > 环境变量 DSH_EMBED_API_KEY。
// 未配到 baseUrl+model 时嵌入功能整体关闭（默认关闭，零行为变化）。

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHome } from './library.ts'
import { maskApiKey } from './translate-config.ts'
import { EmbedError, requestEmbeddings, type EmbedConfig } from './embed.ts'

export { maskApiKey }

/** 配置当前值的来源：file=设置面板填的 / profile=部署方 YAML / env=环境变量 / none=没配 */
export type EmbedSource = 'file' | 'profile' | 'env' | 'none'

export interface ResolvedEmbed {
  cfg: EmbedConfig
  source: EmbedSource
  /** 是否具备启用条件（baseUrl + model + apiKey 三者齐全）；false = 保持默认关闭 */
  enabled: boolean
}

export function embedConfigPath(home: string = dshHome()): string {
  return join(home, '.dsh-paper-reader', 'embed.json')
}

/** 读配置；文件缺失/损坏/形状不对一律返回 null（与 translate/typesafe 的读策略一致）。 */
export async function readEmbedConfig(home: string = dshHome()): Promise<EmbedConfig | null> {
  try {
    const data = JSON.parse(await readFile(embedConfigPath(home), 'utf8')) as unknown
    if (typeof data !== 'object' || data === null) return null
    const rec = data as Record<string, unknown>
    const out: EmbedConfig = {}
    if (typeof rec['baseUrl'] === 'string') out.baseUrl = rec['baseUrl']
    if (typeof rec['apiKey'] === 'string') out.apiKey = rec['apiKey']
    if (typeof rec['model'] === 'string') out.model = rec['model']
    if (Number.isInteger(rec['timeoutMs'])) out.timeoutMs = rec['timeoutMs'] as number
    if (Number.isInteger(rec['batchSize'])) out.batchSize = rec['batchSize'] as number
    if (Number.isInteger(rec['candidateSize'])) out.candidateSize = rec['candidateSize'] as number
    return out
  } catch {
    return null
  }
}

/** 写配置。0600：文件含明文密钥，不靠 umask。 */
export async function writeEmbedConfig(cfg: EmbedConfig, home: string = dshHome()): Promise<void> {
  const file = embedConfigPath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600) // mode 只在新建时生效；已存在的文件要显式收紧
}

/** 删除配置（回落到 profile 的 embed / 环境变量）。文件不存在也算成功。 */
export async function clearEmbedConfig(home: string = dshHome()): Promise<void> {
  await rm(embedConfigPath(home), { force: true })
}

/**
 * 解析生效配置：按字段 file > profile > env（只 env 有 key 时 source=env）。
 * enabled 要求 baseUrl + model + apiKey 三者齐全——缺任一项都退回「嵌入关闭」。
 */
export async function resolveEmbedConfig(
  profile?: EmbedConfig,
  home: string = dshHome(),
): Promise<ResolvedEmbed> {
  const file = await readEmbedConfig(home)
  const envKey = process.env['DSH_EMBED_API_KEY']?.trim() || undefined
  const cfg: EmbedConfig = {}
  const apiKey = file?.apiKey || profile?.apiKey || envKey
  const baseUrl = file?.baseUrl || profile?.baseUrl
  const model = file?.model || profile?.model
  const timeoutMs = file?.timeoutMs ?? profile?.timeoutMs
  const batchSize = file?.batchSize ?? profile?.batchSize
  const candidateSize = file?.candidateSize ?? profile?.candidateSize
  if (apiKey) cfg.apiKey = apiKey
  if (baseUrl) cfg.baseUrl = baseUrl
  if (model) cfg.model = model
  if (timeoutMs !== undefined) cfg.timeoutMs = timeoutMs
  if (batchSize !== undefined) cfg.batchSize = batchSize
  if (candidateSize !== undefined) cfg.candidateSize = candidateSize
  const source: EmbedSource = file?.apiKey
    ? 'file'
    : profile?.apiKey
      ? 'profile'
      : envKey
        ? 'env'
        : 'none'
  return { cfg, source, enabled: Boolean(cfg.baseUrl && cfg.model && cfg.apiKey) }
}

/**
 * 连接预检：拿一个极小的输入打一发 /embeddings，确认 url/key/model 三者匹配且返回维度正常。
 * 必要性同翻译/重排：嵌入失败是**静默降级**，key 或模型名填错用户很难察觉，落盘前先拦。
 */
export async function testEmbedEndpoint(cfg: EmbedConfig): Promise<{ ok: boolean; detail?: string }> {
  if (!cfg.baseUrl?.trim()) return { ok: false, detail: '端点 URL 不能为空' }
  if (!cfg.apiKey?.trim()) return { ok: false, detail: 'API Key 不能为空' }
  if (!cfg.model?.trim()) return { ok: false, detail: '嵌入模型名不能为空' }
  try {
    const [vec] = await requestEmbeddings(
      {
        baseUrl: cfg.baseUrl.trim(),
        apiKey: cfg.apiKey.trim(),
        model: cfg.model.trim(),
        timeoutMs: cfg.timeoutMs ?? 30_000,
      },
      ['connectivity check'],
    )
    if (!vec || vec.length === 0) return { ok: false, detail: '端点返回了空向量' }
    return { ok: true, detail: `维度 ${vec.length}` }
  } catch (err) {
    if (err instanceof EmbedError) return { ok: false, detail: err.message }
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
