// babeldoc-install.ts — 无 Python 环境用户的 babeldoc 自动安装（纯函数，不依赖 Cordis）。
//
// 链路：uv 独立二进制（GitHub Releases，带 sha256 校验）
//   → `uv venv`（uv 自动下载托管 Python，系统没有 Python 也能跑）
//   → `uv pip install babeldoc`（失败时退到 pip + 国内镜像自举）
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
  const want = isWin ? `uv-${triple}.zip` : `uv-${triple}.tar.gz`
  const tmp = join(home, '.dsh-paper-reader', 'bin', `.uv-install-${Date.now()}`)
  await mkdir(tmp, { recursive: true })
  try {
    onPhase('正在安装翻译引擎（1/3 下载 uv）…')
    const rel = await fetch('https://api.github.com/repos/astral-sh/uv/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-paper-reader' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!rel.ok) throw new Error(`查询 uv 版本失败：HTTP ${rel.status}（可手动装 uv 后重试）`)
    const assets = ((await rel.json()) as { assets?: GhAsset[] }).assets ?? []
    const asset = assets.find((a) => a.name === want)
    if (!asset) throw new Error(`uv 最新版没有 ${want} 资产`)
    const sumAsset = assets.find((a) => a.name === want + '.sha256')

    const download = async (a: GhAsset): Promise<Buffer> => {
      const r = await fetch(`https://api.github.com/repos/astral-sh/uv/releases/assets/${a.id}`, {
        headers: { accept: 'application/octet-stream', 'user-agent': 'dsh-paper-reader' },
        signal: AbortSignal.timeout(180_000),
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
    const extracted = join(tmp, `uv-${triple}`, isWin ? 'uv.exe' : 'uv')
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

async function pipInstallBabeldoc(py: string): Promise<void> {
  await run(py, ['-m', 'ensurepip', '--upgrade'], { timeout: 5 * 60_000 })
  let lastErr: unknown = null
  for (const m of CN_MIRRORS) {
    try {
      await run(py, [
        '-m', 'pip', 'install', '--no-cache-dir', '--timeout', '120', '--retries', '3', '-i', m, 'babeldoc',
      ], { timeout: 30 * 60_000 })
      return
    } catch (e) {
      lastErr = e // 换下一个镜像；已装成功的包 pip 会跳过，重试是断点续传式的
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 建 venv + 装 babeldoc（或修复残缺安装）。uv 没有可用 Python 时会自己下载托管版。
 * venv 已存在时跳过 `uv venv`——它会清空重建，毁掉 pip 修复过的包，直接补依赖即可
 * （`uv pip install` 对缺失的依赖是幂等补装）。
 */
async function installBabeldoc(uv: string, venvDir: string, onPhase: PhaseFn): Promise<string> {
  const py = venvPython(venvDir)
  const bin = venvBabeldoc(venvDir)
  if (!existsSync(join(venvDir, 'pyvenv.cfg'))) {
    onPhase('正在安装翻译引擎（2/3 安装 Python）…')
    // --python-preference only-managed：不碰用户系统里可能残缺/带 externally-managed 标记的 Python
    await run(uv, ['venv', venvDir, '--python', '3.12', '--python-preference', 'only-managed'], { timeout: 10 * 60_000 })
  }
  onPhase('正在安装翻译引擎（3/3 安装 babeldoc，首次约几分钟）…')
  try {
    await run(uv, ['pip', 'install', '--python', py, 'babeldoc'], { timeout: 20 * 60_000 })
  } catch (uvErr) {
    onPhase('正在安装翻译引擎（3/3 备用通道：pip + 国内镜像）…')
    console.warn('[dsh-paper-reader] uv 安装 babeldoc 失败，改用 pip 镜像通道:', uvErr instanceof Error ? uvErr.message : uvErr)
    await pipInstallBabeldoc(py)
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
