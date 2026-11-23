// babeldoc-install.ts — 无 Python 环境用户的 babeldoc 自动安装（纯函数，不依赖 Cordis）。
//
// 链路：uv 独立二进制（GitHub Releases，带 sha256 校验）
//   → `uv venv`（系统有 ≥3.10 的 Python 就直接用，省 ~30MB 托管 Python 的 GitHub 下载；
//     没有才让 uv 下载托管版）
//   → `uv pip install babeldoc`（官方/镜像探速取快者；官方失败 → 清华镜像续装；
//     再失败退到 pip + 国内镜像轮询自举——uv 通道默认走 pypi.org，
//     babeldoc 依赖树 ~200MB 在国内裸连会顶死超时，这是安装超时的第一根因）
// 使用前后各做一次 `babeldoc --version` 自检：venv 残缺（依赖被杀软/中断搞掉一半，
// exe 还在但一跑就 ModuleNotFoundError）会被当场抓住并自动走重装修复，而不是让用户
// 在翻译时对着 import 报错干瞪眼。
// 全部落在用户目录：uv 二进制在 <dshHome>/.dsh-paper-reader/bin/uv（win32 为 uv.exe），
// venv 在 文献库同级 .venv-pdf2zh（必须与 translate.ts findBabeldoc 的第一候选位一致），
// 不碰系统 Python、不需要 sudo。
// win32 差异：uv 发 zip 而非 tar.gz（Win10 1803+ 自带 bsdtar 可解 zip，tar -xf 通吃两种格式）、
// exe 后缀、venv 用 Scripts/ 而非 bin/、PATH 查找用 where 替代 which、不需要 chmod。

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 安装进度回调：phase 文案会原样显示在阅读器状态栏。 */
export type PhaseFn = (phase: string) => void

const isWin = process.platform === 'win32'

/** uv 发布的 target triple；不支持的平台返回 null（给手动安装指引）。 */
function uvTriple(): string | null {
  const { platform, arch } = process
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  if (platform === 'win32') return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  // musl 静态构建：不依赖系统 glibc 版本，最省心
  if (platform === 'linux') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl'
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl'
  }
  return null
}

function run(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, {
      timeout: opts.timeout ?? 5 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...opts.env },
    }, (err, stdout, stderr) => {
      if (err) {
        const tail = (stdout + '\n' + stderr).trim().slice(-300)
        rej(new Error(`${cmd} ${args.join(' ')} 失败：${err.message}${tail ? `\n${tail}` : ''}`))
      } else res(stdout)
    })
  })
}

async function whichOk(cmd: string): Promise<boolean> {
  // win32 没有 which，用 where（两者都找不到时都只是跳下一个候选，不算错误）
  return new Promise((res) => {
    execFile(isWin ? 'where' : 'which', [cmd], (err, stdout) => res(!err && stdout.trim() !== ''))
  })
}

/** 插件托管的 uv 位置（不落系统目录，删插件目录即清干净）。 */
export function uvPath(home: string): string {
  return join(home, '.dsh-paper-reader', 'bin', isWin ? 'uv.exe' : 'uv')
}

/** 找 uv：插件托管 → PATH → 常见安装位。 */
async function findUv(home: string): Promise<string | null> {
  const own = uvPath(home)
  if (existsSync(own)) return own
  // 测试钩子：CI runner 常在 PATH 预装 uv，会静默绕过 downloadUv；
  // DSH_PR_MANAGED_UV_ONLY=1 时跳过系统查找，强制走插件托管下载链路（含 sha256 校验）。
  if (process.env.DSH_PR_MANAGED_UV_ONLY === '1') return null
  if (await whichOk('uv')) return 'uv'
  const candidates = isWin
    ? [join(homedir(), '.local', 'bin', 'uv.exe')]
    : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv')]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

interface GhAsset { id: number; name: string; digest?: string }

/**
 * GitHub 加速前缀:统一用于 uv 二进制(api.github.com 资产)与 uv 托管 Python 下载
 * (UV_PYTHON_INSTALL_MIRROR)。选择顺序:DSH_PR_GH_MIRROR 显式指定 > 直连探通 GitHub(海外用户,不用)
 * > 候选社区代理逐个探活取首个可达。
 * 为什么敢走社区代理:传输层只转发,完整性有两道独立校验——uv 二进制对 GitHub API 的
 * digest 做 sha256(见 downloadUv),uv 对托管 Python 自带 manifest 哈希校验(实测喂
 * 「合法 gzip 但内容被换」的假包,uv 报 `Hash mismatch` 直接拒装)。代理挂了/作恶都只会失败,
 * 不会装进坏东西。背景:Node fetch 不读系统代理,挂代理的国内用户直连 GitHub 必超时;
 * 裸 Windows 用户(无 Python)又必须从 GitHub 下托管 Python——这是安装超时的最后一根硬骨头。
 */
const GH_PROXY_CANDIDATES = ['https://gh-proxy.com/', 'https://ghfast.top/']
let ghPrefixCache: string | undefined

async function probeReachable(url: string, ms: number): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(ms) })
    return r.ok || r.status === 405 // 有些代理不支持 HEAD,405 也算通
  } catch {
    return false
  }
}

async function ghMirrorPrefix(): Promise<string> {
  if (ghPrefixCache !== undefined) return ghPrefixCache
  const forced = process.env.DSH_PR_GH_MIRROR
  if (forced) {
    ghPrefixCache = forced.replace(/\/?$/, '/')
    return ghPrefixCache
  }
  if (await probeReachable('https://api.github.com/repos/astral-sh/uv', 3_000)) {
    ghPrefixCache = '' // 直连可达(海外/专线),不用代理
    return ghPrefixCache
  }
  for (const p of GH_PROXY_CANDIDATES) {
    const prefix = p.replace(/\/?$/, '/')
    if (await probeReachable(`${prefix}https://api.github.com/repos/astral-sh/uv`, 4_000)) {
      ghPrefixCache = prefix
      console.warn(`[dsh-paper-reader] GitHub 直连不可达,使用加速前缀 ${prefix}(完整性由 sha256/uv manifest 校验保障)`)
      return ghPrefixCache
    }
  }
  ghPrefixCache = '' // 代理也全挂:维持直连,靠 fetchWithRetry 兜底
  return ghPrefixCache
}

/** GitHub API 请求头：有 GITHUB_TOKEN/GH_TOKEN 就带上——匿名限流 60/h 按出口 IP 算，
 * CI runner 和企业 NAT 都是共享 IP,极易撞 403;带 token 后按账号 5000/h。 */
function ghHeaders(accept: string): Record<string, string> {
  const h: Record<string, string> = { accept, 'user-agent': 'dsh-paper-reader' }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) h.authorization = `Bearer ${token}`
  return h
}

/**
 * fetch 带重试：用户网络抖一下（尤其国内到 GitHub）就直接失败太脆了。
 * 只对网络错误和 5xx 重试，4xx 是确定性错误直接抛。
 */
async function fetchWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let lastErr: unknown = null
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init)
      if (r.ok || (r.status >= 400 && r.status < 500)) return r
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (e) {
      lastErr = e
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 下载 uv 独立二进制。全程走 api.github.com（资产接口 + octet-stream 直连），
 * 不依赖 github.com 页面域——后者在部分网络环境不可达，而 API 域通常可达。
 * 完整性用 releases API 返回的 digest（sha256）校验，下载完直接执行的二进制不校验等于裸奔。
 * fetch 下载不带 quarantine xattr，macOS 不会拦。
 */
async function downloadUv(home: string, onPhase: PhaseFn): Promise<string> {
  const triple = uvTriple()
  if (!triple) {
    throw new Error(
      `当前平台（${process.platform}/${process.arch}）暂不支持自动安装：请手动安装 uv（https://docs.astral.sh/uv/）后重试`,
    )
  }
  // GitHub 加速前缀(探活/DSH_PR_GH_MIRROR 见 ghMirrorPrefix):api 与资产都走 `<前缀><原URL>` 转发
  const gh = (url: string) => {
    const p = ghPrefixCache
    return p ? p + url : url
  }
  const want = isWin ? `uv-${triple}.zip` : `uv-${triple}.tar.gz`
  const tmp = join(home, '.dsh-paper-reader', 'bin', `.uv-install-${Date.now()}`)
  await mkdir(tmp, { recursive: true })
  try {
    onPhase('正在安装翻译引擎（1/3 下载 uv）…')
    await ghMirrorPrefix()
    const rel = await fetchWithRetry(gh('https://api.github.com/repos/astral-sh/uv/releases/latest'), {
      headers: ghHeaders('application/vnd.github+json'),
      signal: AbortSignal.timeout(30_000),
    })
    if (!rel.ok) throw new Error(`查询 uv 版本失败：HTTP ${rel.status}（可手动装 uv 后重试）`)
    const assets = ((await rel.json()) as { assets?: GhAsset[] }).assets ?? []
    const asset = assets.find((a) => a.name === want)
    if (!asset) throw new Error(`uv 最新版没有 ${want} 资产`)
    const sumAsset = assets.find((a) => a.name === want + '.sha256')

    const download = async (a: GhAsset): Promise<Buffer> => {
      // 单次 120s 快速失败(GitHub 国内不稳,3 次重试已够;180s×3 会把用户晾 9 分钟才报错)
      const r = await fetchWithRetry(gh(`https://api.github.com/repos/astral-sh/uv/releases/assets/${a.id}`), {
        headers: ghHeaders('application/octet-stream'),
        signal: AbortSignal.timeout(120_000),
      })
      if (!r.ok) throw new Error(`下载 ${a.name} 失败：HTTP ${r.status}`)
      return Buffer.from(await r.arrayBuffer())
    }
    const body = await download(asset)
    // 校验和优先用 API 的 digest；老 GitHub 没有 digest 字段时退到 .sha256 资产（同通道）
    let expect = asset.digest?.replace(/^sha256:/, '')
    if (!expect && sumAsset) expect = (await download(sumAsset)).toString('utf8').trim().split(/\s+/)[0]
    if (!expect) throw new Error('拿不到 uv 校验和，为安全起见放弃安装')
    const actual = createHash('sha256').update(body).digest('hex')
    if (actual !== expect) throw new Error('uv 下载文件校验和不匹配，已丢弃（请重试）')

    const pkgPath = join(tmp, isWin ? 'uv.zip' : 'uv.tar.gz')
    await writeFile(pkgPath, body)
    // 不带 -z：bsdtar（macOS 自带 / Win10 1803+ 的 tar.exe）和 GNU tar 解包时都自动探测格式，
    // 同一条命令通吃 tar.gz 与 zip（win32 的 uv 只发 zip）
    await run('tar', ['-xf', pkgPath, '-C', tmp], { timeout: 60_000 })
    // tar.gz 有顶层目录 uv-<triple>/;win32 的 zip 是平铺的(uv.exe 直接在根)
    const binName = isWin ? 'uv.exe' : 'uv'
    const nested = join(tmp, `uv-${triple}`, binName)
    const extracted = existsSync(nested) ? nested : join(tmp, binName)
    if (!existsSync(extracted)) throw new Error('uv 解包结果不符合预期')
    const dst = uvPath(home)
    await rename(extracted, dst)
    if (!isWin) await chmod(dst, 0o755) // win32 无可执行位概念
    return dst
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** venv 里的 python 路径（win32 在 Scripts/ 且带 .exe）。 */
function venvPython(venvDir: string): string {
  return isWin ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
}

/** venv 里的 babeldoc 可执行文件路径（与 translate.ts findBabeldoc 的第一候选位一致）。 */
function venvBabeldoc(venvDir: string): string {
  return isWin ? join(venvDir, 'Scripts', 'babeldoc.exe') : join(venvDir, 'bin', 'babeldoc')
}

/**
 * 自检：跑一次 --version。import 链上缺任何包（configargparse/pymupdf/rich…）都会在这里炸，
 * 正好覆盖「exe 在、依赖残缺」的坏状态。通过的 bin 记进 Set，后续调用零开销。
 */
const verified = new Set<string>()
function smokeCheck(bin: string): Promise<void> {
  if (verified.has(bin)) return Promise.resolve()
  return new Promise((res, rej) => {
    execFile(bin, ['--version'], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        const tail = (stdout + '\n' + stderr).trim().slice(-300)
        rej(new Error(tail || err.message))
      } else {
        verified.add(bin)
        res()
      }
    })
  })
}

/**
 * uv 之外的备用安装通道：venv 自举 pip（ensurepip）→ 国内镜像轮询装 babeldoc。
 * 触发场景（均在实测中出现过）：
 * - 杀毒软件锁 uv 临时入口 exe 的 PE 资源更新（UpdateResource 被拒，uv 全线失败）；
 * - uv 默认 PyPI 源在国内网络下超时/响应截断。pip 写入口 exe 用普通文件写，不踩这两坑。
 */
const CN_MIRRORS = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://mirrors.cloud.tencent.com/pypi/simple',
]

/** uv 通道的镜像。与 CN_MIRRORS[0] 同值(改动时一起改)。 */
const UV_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/**
 * 选 PyPI 源,返回给 uv 通道的环境变量:
 * DSH_PR_PYPI_MIRROR 显式指定 > 官方/镜像各 3s 探速取快者(官方快/镜像挂 → 空,维持官方)。
 * 背景:uv pip 默认走 pypi.org,babeldoc 依赖树 ~200MB,国内裸连 200KB/s ≈ 17min,
 * 正好顶死 20min 超时——「安装老是超时」的第一根因。镜像下同样体积 <1min。
 */
async function pickIndexEnv(): Promise<Record<string, string>> {
  const forced = process.env.DSH_PR_PYPI_MIRROR
  if (forced) return { UV_DEFAULT_INDEX: forced, UV_INDEX_URL: forced }
  const probe = async (base: string): Promise<number> => {
    const t0 = Date.now()
    try {
      const r = await fetch(base, { method: 'HEAD', signal: AbortSignal.timeout(3_000) })
      return r.ok ? Date.now() - t0 : Number.POSITIVE_INFINITY
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }
  const [official, mirror] = await Promise.all([
    probe('https://pypi.org/simple/'),
    probe(`${UV_MIRROR}/`),
  ])
  if (official === Number.POSITIVE_INFINITY && mirror === Number.POSITIVE_INFINITY) return {}
  return mirror < official ? { UV_DEFAULT_INDEX: UV_MIRROR, UV_INDEX_URL: UV_MIRROR } : {}
}

// babeldoc 依赖 bitstring>=4.3.0 无上界，而 bitstring 5.0（2026-10 发布）删除了 BitStream，
// babeldoc 的 pdf_creater.py 仍在 `from bitstring import BitStream` —— 裸装必装出残缺 venv。
// 上游修掉该 import 或锁上界后可移除此 pin。
const BITSTRING_PIN = 'bitstring<5'

async function pipInstallBabeldoc(py: string): Promise<void> {
  await run(py, ['-m', 'ensurepip', '--upgrade'], { timeout: 5 * 60_000 })
  let lastErr: unknown = null
  for (const m of CN_MIRRORS) {
    try {
      await run(py, [
        '-m', 'pip', 'install', '--no-cache-dir', '--timeout', '120', '--retries', '3', '-i', m, 'babeldoc', BITSTRING_PIN,
      ], { timeout: 30 * 60_000 })
      return
    } catch (e) {
      lastErr = e // 换下一个镜像；已装成功的包 pip 会跳过，重试是断点续传式的
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 探测系统 Python,返回解释器绝对路径(给 uv venv --python 直接吃),找不到返回 null。
 * 候补序:python3(macOS/Linux)→ python → py -3(Windows 官方 launcher)。
 * Windows 陷阱:商店的 python/python3「应用执行别名」是个弹商店的假 stub,
 * 跑 -c 会非零退出 → 探活自动跳过,零风险;真 Python(含商店正版)都过得了探活。
 * 版本窗口 3.10 ≤ v < 3.14,两处上限硬事实(engine-smoke 2026-11-23 实证):
 *   · 3.15:onnxruntime 没有 cp315 wheel,uv 解析直接 No solution,镜像兜底同样无解;
 *   · 3.14:babeldoc 0.6.x 的 priority_thread_pool_executor 用了 CPython 私有 _WorkItem,
 *     该签名 3.14 已变,import 即 TypeError。
 * 超界 = 探活不过,自动落回托管 3.12(已知可用窗口)。放开上限前先确认 wheel 与
 * babeldoc 都已兼容,并同步改 test/ci-flake-guards.test.mjs 的 W1 断言。
 * 返回 sys.executable 而非命令名,是怕 PATH 里的别名/同壳名误导 uv 的解析。
 * 用系统 Python 可省掉 ~30MB 托管 Python 的 GitHub 下载(国内慢且是超时第二根因);
 * DSH_PR_MANAGED_UV_ONLY=1 时跳过(CI 强制走托管下载链路)。
 */
async function findSystemPython(): Promise<string | null> {
  const candidates: Array<[cmd: string, pre: string[]]> = [
    ['python3', []],
    ['python', []],
    ['py', ['-3']],
  ]
  for (const [cmd, pre] of candidates) {
    const ok = await new Promise<boolean>((res) => {
      execFile(
        cmd,
        [...pre, '-c', 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)'],
        { timeout: 15_000 },
        (err) => res(!err),
      )
    })
    if (!ok) continue
    const exe = await new Promise<string>((res) => {
      execFile(cmd, [...pre, '-c', 'import sys; print(sys.executable)'], { timeout: 15_000 }, (err, stdout) => {
        if (err) return res('')
        res(stdout.trim().split(/\r?\n/)[0] ?? '')
      })
    })
    if (exe) return exe
  }
  return null
}

/**
 * 建 venv + 装 babeldoc（或修复残缺安装）。
 * venv 已存在时跳过 `uv venv`——它会清空重建，毁掉 pip 修复过的包，直接补依赖即可
 * （`uv pip install` 对缺失的依赖是幂等补装）。
 */
async function installBabeldoc(uv: string, venvDir: string, onPhase: PhaseFn): Promise<string> {
  const py = venvPython(venvDir)
  const bin = venvBabeldoc(venvDir)
  if (!existsSync(join(venvDir, 'pyvenv.cfg'))) {
    onPhase('正在安装翻译引擎（2/3 准备 Python）…')
    // 系统 Python 优先(省 GitHub 下载);建不起来再走托管下载。
    // only-managed 的原语义(不碰残缺系统 Python)由「先试建、失败即弃」保住。
    let sysPy: Awaited<ReturnType<typeof findSystemPython>> = null
    if (process.env.DSH_PR_MANAGED_UV_ONLY !== '1') sysPy = await findSystemPython()
    let usedSystem = false
    if (sysPy) {
      try {
        await run(uv, ['venv', venvDir, '--python', sysPy], { timeout: 2 * 60_000 })
        usedSystem = true
      } catch (e) {
        console.warn(`[dsh-paper-reader] 系统 Python(${sysPy})建 venv 失败,改用 uv 托管 Python:`, e instanceof Error ? e.message : e)
      }
    }
    if (!usedSystem) {
      // 托管 Python 走同一加速前缀(UV_PYTHON_INSTALL_MIRROR,uv 会以 manifest 哈希校验,
      // 见 ghMirrorPrefix 注释)——裸 Windows 用户的 30MB GitHub 下载不再是死路
      const pyEnv: NodeJS.ProcessEnv = {}
      const prefix = await ghMirrorPrefix()
      if (prefix) pyEnv.UV_PYTHON_INSTALL_MIRROR = `${prefix}https://github.com/astral-sh/python-build-standalone/releases/download`
      await run(uv, ['venv', venvDir, '--python', '3.12', '--python-preference', 'only-managed'], { timeout: 10 * 60_000, env: pyEnv })
    }
  }
  onPhase('正在安装翻译引擎（3/3 安装 babeldoc，首次约几分钟）…')
  const viaPipFallback = async (cause: unknown) => {
    onPhase('正在安装翻译引擎（3/3 备用通道：pip + 国内镜像）…')
    if (cause) {
      console.warn('[dsh-paper-reader] uv 安装 babeldoc 失败，改用 pip 镜像通道:', cause instanceof Error ? cause.message : cause)
    }
    await pipInstallBabeldoc(py)
  }
  // 测试钩子：DSH_PR_FORCE_PIP_CHANNEL=1 跳过 uv 通道，让 CI 确定性覆盖 pip 备用路径
  //（杀软锁 uv 入口 exe、PyPI 截断时的逃生通道，Windows 上最关键的一条路径）
  if (process.env.DSH_PR_FORCE_PIP_CHANNEL === '1') await viaPipFallback(null)
  else {
    // 两段式:首段按探速选源、8min 快速失败;官方源失败 → 镜像续装 20min
    //(uv 的 wheel 缓存让第二段从断点续传,不是从零再来);再失败才落 pip 通道
    const indexEnv = await pickIndexEnv()
    try {
      await run(uv, ['pip', 'install', '--python', py, 'babeldoc', BITSTRING_PIN], { timeout: 8 * 60_000, env: indexEnv })
    } catch (first) {
      const firstWasOfficial = Object.keys(indexEnv).length === 0
      if (!firstWasOfficial) await viaPipFallback(first)
      else {
        console.warn('[dsh-paper-reader] 官方源安装失败，镜像续装:', first instanceof Error ? first.message : first)
        onPhase('正在安装翻译引擎（3/3 镜像续装 babeldoc…）')
        try {
          await run(uv, ['pip', 'install', '--python', py, 'babeldoc', BITSTRING_PIN], {
            timeout: 20 * 60_000,
            env: { UV_DEFAULT_INDEX: UV_MIRROR, UV_INDEX_URL: UV_MIRROR },
          })
        } catch (second) {
          await viaPipFallback(second)
        }
      }
    }
  }
  if (!existsSync(bin)) throw new Error('babeldoc 安装完成但未找到可执行文件')
  return bin
}

// 单例：多次点击「中」只允许一个安装流程在跑，其余复用同一个 promise。
let inflight: Promise<string> | null = null

/**
 * 确保 babeldoc 可用，返回可执行文件路径。
 * 已存在（venv/PATH/miniconda）先自检：残缺（exe 在、依赖缺）不直接用，转修复流程。
 * venv 落 dirname(dataDir)/.venv-pdf2zh —— 与 translate.ts findBabeldoc 的第一候选位严格一致。
 */
export function ensureBabeldoc(
  dataDir: string,
  home: string,
  findExisting: () => Promise<string | null>,
  onPhase: PhaseFn,
): Promise<string> {
  if (!inflight) {
    inflight = (async () => {
      const existing = await findExisting()
      if (existing) {
        try {
          await smokeCheck(existing)
          return existing
        } catch (e) {
          console.warn('[dsh-paper-reader] babeldoc 自检未过（残缺安装），进入修复:', e instanceof Error ? e.message : e)
          onPhase('检测到翻译引擎组件缺失，正在修复…')
        }
      }
      const venvDir = join(dirname(dataDir), '.venv-pdf2zh')
      const uv = (await findUv(home)) ?? (await downloadUv(home, onPhase))
      const bin = await installBabeldoc(uv, venvDir, onPhase)
      // 终检：把真实的缺包报错在安装阶段抛出来，别等到翻译跑一半才炸
      await smokeCheck(bin)
      return bin
    })().finally(() => {
      // 成功后清掉单例让下次走快速路径；失败也清掉让下次可以重试
      inflight = null
    })
  } else {
    // 并发复用：把 phase 回调接到同一条进度线上（各自显示各自的状态栏）
    inflight.then(() => onPhase('翻译引擎已就绪')).catch(() => {})
  }
  return inflight
}

// ------------------ GPU 版面检测运行时（按需安装） ------------------

/**
 * 版面检测 GPU 运行时包名（按设备与平台）：
 * - dml/auto + win32 → onnxruntime-directml（DirectML 通用 GPU，约 40MB，N/A/I 卡都能用）；
 * - cuda → 不自动装：onnxruntime-gpu 需要系统级 CUDA + cuDNN（2~3GB），失败率高且排障难，
 *   留给用户手动装（文档写明）；驱动侧对缺失如实回落 CPU；
 * - 非 win32 → 不装：Linux 无 DirectML，macOS 上游已自动走 CoreML。
 */
export function layoutRuntimePackage(device: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') return null
  return device === 'dml' || device === 'auto' ? 'onnxruntime-directml' : null
}

/**
 * 是否需要补装 DML 运行时。providers 为 null（探测不了）时一律不装——
 * 宁可让驱动回落 CPU，也不在状态未知的 venv 上盲动。
 * auto 已有任何 GPU provider（如用户手动装过 onnxruntime-gpu）就不装。
 */
export function needsDmlInstall(device: string, providers: string[] | null, platform: NodeJS.Platform): boolean {
  if (layoutRuntimePackage(device, platform) === null) return false
  if (providers === null) return false
  if (device === 'auto' && providers.includes('CUDAExecutionProvider')) return false
  return !providers.includes('DmlExecutionProvider')
}

/** venv 的 onnxruntime 可用 provider；起不了进程/没有 onnxruntime 时返回 null（不判成错误）。 */
async function onnxProviders(py: string): Promise<string[] | null> {
  try {
    const out = await run(py, ['-c', 'import json, onnxruntime; print(json.dumps(onnxruntime.get_available_providers()))'], { timeout: 30_000 })
    const parsed: unknown = JSON.parse(out.trim().split(/\r?\n/).pop() ?? 'null')
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : null
  } catch {
    return null
  }
}

// 结果缓存（进程内）：present/installed 跳过后续探测；安装失败也缓存——重试按翻译次数
// 反复烧几分钟下载不值，重启进程即重试。探测失败（null）不缓存，下次翻译再探。
const layoutRuntimeCache = new Map<string, 'present' | 'installed' | 'failed'>()

// 单例：多论文并发翻译只跑一次安装，其余等待同一条 promise（并发 pip 会互踩文件锁）。
let dmlInflight: Promise<'present' | 'installed' | 'skipped'> | null = null

/**
 * 按需确保 GPU 版面检测运行时（用户显式选了 dml/auto 才会真正动 venv）。
 * - 已就位 → 'present'（零开销快速路径）；
 * - 缺失 → uv 通道装 onnxruntime-directml（uv 建的 venv 没有 pip，主安装链同理走 uv；
 *   官方源失败镜像续装；没有 uv 时 ensurepip 自举后 pip 走国内镜像）→ 复核 provider 后返回 'installed'；
 * - 任何失败（网络/文件锁/装完 provider 仍缺）→ 如实 phase 提示 + 返回 'skipped'，
 *   驱动侧自动回落 CPU，翻译主流程不受影响。
 * 只对插件自管 venv 的 python（translate.ts resolveDriverPython 解析出的绝对路径）操作；
 * PATH/miniconda 里的 babeldoc 不碰——那是用户自己的环境。
 */
export async function ensureOnnxLayoutDevice(
  py: string | null,
  device: string,
  onPhase: PhaseFn,
  home: string,
): Promise<'present' | 'installed' | 'skipped'> {
  // DPR_SKIP_ENGINE_ENSURE=1：受限环境/测试钩子，只跑现成引擎，别动 venv
  if (process.env.DPR_SKIP_ENGINE_ENSURE === '1') return 'skipped'
  if (!py || !existsSync(py)) return 'skipped'
  const cacheKey = `${py}\u0000${device}`
  const cached = layoutRuntimeCache.get(cacheKey)
  if (cached === 'present' || cached === 'installed') return cached
  if (cached === 'failed') {
    onPhase('GPU 版面检测运行时此前安装失败，本次用 CPU 跑版面（重启后重试）…')
    return 'skipped'
  }
  if (!dmlInflight) {
    dmlInflight = (async (): Promise<'present' | 'installed' | 'skipped'> => {
      const venvPy = py as string
      const pkg = layoutRuntimePackage(device, process.platform)
      if (!pkg) return 'skipped'
      const providers = await onnxProviders(venvPy)
      if (!needsDmlInstall(device, providers, process.platform)) {
        if (providers && providers.includes('DmlExecutionProvider')) {
          layoutRuntimeCache.set(cacheKey, 'present')
          return 'present'
        }
        return 'skipped'
      }
      onPhase(`正在安装 GPU 版面检测运行时（${pkg}，约 40MB）…`)
      const installViaUv = async (indexEnv: NodeJS.ProcessEnv, timeout: number): Promise<void> => {
        const uv = await findUv(home)
        if (!uv) throw new Error('uv 不可用')
        await run(uv, ['pip', 'install', '--python', venvPy, pkg], { timeout, env: indexEnv })
      }
      const installViaPip = async (): Promise<void> => {
        // uv 建的 venv 默认没有 pip：先 ensurepip 自举再镜像轮询
        await run(venvPy, ['-m', 'ensurepip', '--upgrade'], { timeout: 5 * 60_000 })
        let lastErr: unknown = null
        for (const m of CN_MIRRORS) {
          try {
            await run(venvPy, [
              '-m', 'pip', 'install', '--no-cache-dir', '--timeout', '120', '--retries', '3', '-i', m, pkg,
            ], { timeout: 15 * 60_000 })
            return
          } catch (e) {
            lastErr = e // 换下一个镜像；已装成功的包 pip 会跳过，重试是断点续传式的
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
      }
      try {
        try {
          // 两段式：首段按探速选源、10min 快速失败；官方源失败 → 镜像续装 15min（与主安装链同款）
          const indexEnv = await pickIndexEnv()
          await installViaUv(indexEnv, 10 * 60_000)
        } catch (first) {
          console.warn('[dsh-paper-reader] GPU 运行时官方/uv 通道失败，镜像续装:', first instanceof Error ? first.message : first)
          onPhase(`正在安装 GPU 版面检测运行时（${pkg}，镜像通道续装）…`)
          try {
            await installViaUv({ UV_DEFAULT_INDEX: UV_MIRROR, UV_INDEX_URL: UV_MIRROR }, 15 * 60_000)
          } catch (second) {
            // uv 也没有（findUv 落空）→ venv 自举 pip 走国内镜像
            await installViaPip()
          }
        }
      } catch (e) {
        console.warn('[dsh-paper-reader] GPU 版面检测运行时安装失败，本次回落 CPU:', e instanceof Error ? e.message : e)
        onPhase('GPU 版面检测运行时安装失败，本次用 CPU 跑版面…')
        layoutRuntimeCache.set(cacheKey, 'failed')
        return 'skipped'
      }
      // 装完复核：provider 真的出现才算成功（不粉饰「pip 说装好了」）
      const after = await onnxProviders(venvPy)
      if (after?.includes('DmlExecutionProvider')) {
        layoutRuntimeCache.set(cacheKey, 'installed')
        return 'installed'
      }
      console.warn('[dsh-paper-reader] onnxruntime-directml 安装完成但 DmlExecutionProvider 未出现（驱动/系统不支持？），本次回落 CPU')
      onPhase('GPU 版面检测运行时未生效，本次用 CPU 跑版面…')
      layoutRuntimeCache.set(cacheKey, 'failed')
      return 'skipped'
    })().finally(() => {
      dmlInflight = null
    })
  }
  return dmlInflight
}
