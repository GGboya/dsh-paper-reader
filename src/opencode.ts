// opencode.ts — OpenCode Go 端点识别 + `x-opencode-session` 稳定会话标识（纯函数，不依赖 Cordis）。
//
// 为什么需要：OpenCode Go 要求客户端在推理请求里带稳定的会话 ID（`x-opencode-session`），
// 它用这个 ID 做路由与提示词缓存优化；文档也把「缺这个头」列为客户端兼容性问题。
// 参考 https://opencode.ai/v2/docs/console/go/ 。本模块只负责两件事：
//   ① 认端点：只有 host 是 opencode.ai（含子域）才返回会话头——其它 OpenAI 兼容端点
//      （DeepSeek / GLM / Kimi / 本地 vLLM…）一个字节都不多发，行为与改造前完全一致；
//   ② 发会话 ID：同一作用域（同一篇论文 / 同一个端点配置）跨进程重启都得到同一个 ID。
//
// 稳定性怎么来的：不落「每个会话一个 UUID」的大表（会随论文数增长，还要给并发写加锁），
// 而是落一份 0600 的随机 secret，再用 `sha256(secret + scope)` 派生 ID。作用域本身不落盘，
// 文件里只有 secret；同一 scope 永远同 ID，不同 scope 互不相同。
//
// 隐私：派生结果不含论文名、不含 key；secret 与其它端点凭据同目录（$DSH_HOME/.dsh-paper-reader/），
// 权限 0600。作用域串只在内存里参与哈希，不写任何日志。

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHome } from './library.ts'

/** OpenCode Go 要求的会话请求头（小写；fetch 会按原样发出，HTTP 头名大小写不敏感）。 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/** 驱动脚本（babeldoc 子进程）读取会话 ID 的环境变量名。 */
export const OPENCODE_DRIVER_SESSION_ENV = 'DPR_OPENCODE_SESSION'

const SESSION_FILE = 'opencode-session.json'
const SECRET_RE = /^[0-9a-f]{64}$/

/**
 * 端点是否指向 OpenCode。
 * 只认 host（opencode.ai 及其子域，忽略大小写与末尾点），不看路径：
 * OpenAI 兼容根是 /inference/go/openai/v1，用户也可能填到 /v1 或带尾斜杠。
 * 非法/空 URL 一律 false（预检会另行报「URL 不合法」，不在这里猜）。
 */
export function isOpenCodeEndpoint(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  let host: string
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return false
  }
  return host === 'opencode.ai' || host.endsWith('.opencode.ai')
}

/**
 * 直接请求用的会话头：非 OpenCode 端点 / 没有 sessionId 时返回空对象。
 * 调用方用 `{ ...baseHeaders, ...openCodeSessionHeaders(...) }` 合并即可，无需分支。
 */
export function openCodeSessionHeaders(
  baseUrl: string | null | undefined,
  sessionId: string | null | undefined,
): Record<string, string> {
  if (!sessionId || !isOpenCodeEndpoint(baseUrl)) return {}
  return { [OPENCODE_SESSION_HEADER]: sessionId }
}

/**
 * babeldoc 驱动脚本的环境变量：非 OpenCode 端点 / 没有 sessionId 时返回空对象。
 * 驱动脚本把它加进 OpenAI SDK 的 `extra_headers`，覆盖整篇翻译的每一次 LLM 请求。
 */
export function openCodeDriverEnv(
  baseUrl: string | null | undefined,
  sessionId: string | null | undefined,
): Record<string, string> {
  if (!sessionId || !isOpenCodeEndpoint(baseUrl)) return {}
  return { [OPENCODE_DRIVER_SESSION_ENV]: sessionId }
}

/** 落盘失败（只读 HOME / 权限异常）时的进程内 secret：至少保证进程内稳定、头照常发。 */
const fallbackSecret = randomBytes(32).toString('hex')

async function readSecret(file: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (typeof data !== 'object' || data === null) return null
    const secret = (data as Record<string, unknown>)['secret']
    return typeof secret === 'string' && SECRET_RE.test(secret) ? secret : null
  } catch {
    return null
  }
}

/**
 * 取（必要时创建）会话 secret。
 * `flag: 'wx'` 让并发首次创建只有一个赢家：输家读赢家写下的 secret，避免两把 secret 同时生效。
 * 文件损坏/缺失 → 重新生成（一次性失效，可接受）；写不进去 → 退回进程内 secret，不阻塞翻译。
 */
async function ensureSecret(home: string): Promise<string> {
  const file = join(home, '.dsh-paper-reader', SESSION_FILE)
  const existing = await readSecret(file)
  if (existing) return existing
  const secret = randomBytes(32).toString('hex')
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ v: 1, secret }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await chmod(file, 0o600) // mode 只在新建时生效；与其它端点配置文件同一约定
    return secret
  } catch {
    // 并发输家（EEXIST）优先读赢家的值
    const raced = await readSecret(file)
    if (raced) return raced
    // 文件存在但内容损坏：覆盖修复，别让每次调用都退回进程内 secret（跨重启会换 ID）
    try {
      await writeFile(file, JSON.stringify({ v: 1, secret }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await chmod(file, 0o600)
      return secret
    } catch {
      // 只读 / 权限异常：退回进程内 secret，至少保证头存在且进程内稳定
      return fallbackSecret
    }
  }
}

/**
 * 某个作用域的稳定会话 ID。
 * - scope 由调用方给（如 `paper:<专题>/<文献名>`、`translate-precheck:<url>|<model>`），
 *   不同作用域互不相同；同一 scope 跨进程重启相同（secret 持久）。
 * - 返回 32 位十六进制串（`sha256` 前半段）：不含 scope 明文，也不会与真实 key 撞形。
 */
export async function openCodeSessionId(scope: string, home: string = dshHome()): Promise<string> {
  const secret = await ensureSecret(home)
  return createHash('sha256').update(secret).update('\0').update(scope, 'utf8').digest('hex').slice(0, 32)
}
