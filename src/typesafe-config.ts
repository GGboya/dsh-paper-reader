// typesafe-config.ts — Jev/TypeSafe 端点配置的落盘与解析（纯函数，不依赖 Cordis）。
//
// 与 translate-config.ts 同一套约定：存 $DSH_HOME/.dsh-paper-reader/typesafe.json
// （0600，不进 dataDir——密钥不跟文献库走）；密钥只落盘、只回显掩码。
// 优先级：文件（设置面板填的）> profile 的 cordis.patch.yml config.typesafe
// > 环境变量 TYPESAFE_API_KEY（部署方兜底）。

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TypeSafeClient, noul, type Fetch } from '@typesafe-ai/sdk'
import { Agent, fetch as undiciFetch } from 'undici'
import { dshHome } from './library.ts'
import { maskApiKey } from './translate-config.ts'
import type { RerankConfig } from './rerank.ts'

export { maskApiKey }

// 跨境/弱网链路 TCP 握手可能远超 undici 默认的 10s connect 超时(实测 30s+),
// 单独放宽 connect;总耗时仍由客户端 timeout 控制。fetch 与 Agent 必须用同一个
// undici 包(混用 npm undici 的 Agent + Node 内置 fetch 会因 dispatcher 内部
// 接口版本不匹配而炸),per-call dispatcher,不动全局 dispatcher。
const longConnectAgent = new Agent({ connect: { timeout: 60_000 } })
export const patientFetch: Fetch = (input, init) =>
  // 运行时同源;类型上 @types/node 的 undici-types 与 npm undici 不完全兼容,双断言绕过
  undiciFetch(input, { ...init, dispatcher: longConnectAgent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>

/** 配置当前值的来源：file=设置面板填的 / profile=部署方 YAML / env=环境变量 / none=没配 */
export type TypesafeSource = 'file' | 'profile' | 'env' | 'none'

export interface ResolvedTypesafe {
  cfg: RerankConfig
  source: TypesafeSource
}

export function typesafeConfigPath(home: string = dshHome()): string {
  return join(home, '.dsh-paper-reader', 'typesafe.json')
}

/** 读配置；文件缺失/损坏/形状不对一律返回 null（与 translate-config 的读策略一致）。 */
export async function readTypesafeConfig(home: string = dshHome()): Promise<RerankConfig | null> {
  try {
    const data = JSON.parse(await readFile(typesafeConfigPath(home), 'utf8')) as unknown
    if (typeof data !== 'object' || data === null) return null
    const rec = data as Record<string, unknown>
    const out: RerankConfig = {}
    if (typeof rec['apiKey'] === 'string') out.apiKey = rec['apiKey']
    if (typeof rec['baseUrl'] === 'string') out.baseUrl = rec['baseUrl']
    if (typeof rec['model'] === 'string') out.model = rec['model']
    return out
  } catch {
    return null
  }
}

/** 写配置。0600：文件含明文密钥，不靠 umask。 */
export async function writeTypesafeConfig(cfg: RerankConfig, home: string = dshHome()): Promise<void> {
  const file = typesafeConfigPath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600) // mode 只在新建时生效；已存在的文件要显式收紧
}

/** 删除配置（回落到 profile 的 typesafe / 环境变量）。文件不存在也算成功。 */
export async function clearTypesafeConfig(home: string = dshHome()): Promise<void> {
  await rm(typesafeConfigPath(home), { force: true })
}

/** 解析生效配置：按字段 file > profile > env（只 env 有 key 时 source=env）。 */
export async function resolveTypesafeConfig(
  profile?: RerankConfig,
  home: string = dshHome(),
): Promise<ResolvedTypesafe> {
  const file = await readTypesafeConfig(home)
  const envKey = process.env['TYPESAFE_API_KEY']
  const cfg: RerankConfig = {}
  const apiKey = file?.apiKey || profile?.apiKey || envKey
  const baseUrl = file?.baseUrl || profile?.baseUrl
  const model = file?.model || profile?.model
  if (apiKey) cfg.apiKey = apiKey
  if (baseUrl) cfg.baseUrl = baseUrl
  if (model) cfg.model = model
  const source: TypesafeSource = file?.apiKey
    ? 'file'
    : profile?.apiKey
      ? 'profile'
      : envKey?.trim()
        ? 'env'
        : 'none'
  return { cfg, source }
}

/**
 * 连接预检：打一发极小的 systemOne（一个 Noul、几个 token），确认 key/端点/模型有效。
 * 与翻译预检同理：重排失败会静默降级成关键词排序，key 填错用户很难察觉，落盘前先拦。
 */
export async function testTypesafeEndpoint(cfg: RerankConfig): Promise<{ ok: boolean; detail?: string }> {
  if (!cfg.apiKey?.trim()) return { ok: false, detail: 'API Key 不能为空' }
  try {
    const client = new TypeSafeClient({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      ...(cfg.model ? { defaultModel: cfg.model } : {}),
      timeout: 60_000, // 预检同样走慢链路,15s 容易误杀
      fetch: patientFetch,
      logLevel: 'off',
    })
    await client.systemOne({
      state: 'ping',
      questions: { ok: noul('Is this a connectivity check? Reply yes.') },
    })
    return { ok: true }
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
    return { ok: false, detail: (err instanceof Error ? err.message : String(err)) + cause }
  }
}
