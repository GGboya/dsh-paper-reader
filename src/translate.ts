// translate.ts — 中文对照 PDF 生成（纯函数，不依赖 Cordis）。
// 移植 pdfqa 的 runPdf2zh：shell 调 babeldoc（pdf2zh 2.x），版式/图/公式原地保留，
// 产出 <文献>-zh.pdf（纯中文）与 <文献>-dual.pdf（中英对照）。
// babeldoc 只支持 OpenAI 兼容端点 → 端点/key/模型由插件配置提供。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { join, dirname, basename, extname } from 'node:path'
import type { PaperRef } from './library.ts'
import { dshHome } from './library.ts'
import { ensureBabeldoc } from './babeldoc-install.ts'

export interface TranslateEndpoint {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface ZhStatus {
  /** <文献>-zh.pdf（纯中文）存在 */
  zh: boolean
  /** <文献>-dual.pdf（中英对照）存在 */
  dual: boolean
  busy: boolean
  error?: string
  /** busy 时的阶段说明（如首次自动安装翻译引擎），UI 直接展示 */
  phase?: string
}

export function zhPdfPath(ref: PaperRef): string {
  return ref.pdfPath.slice(0, -extname(ref.pdfPath).length) + '-zh.pdf'
}
export function dualPdfPath(ref: PaperRef): string {
  return ref.pdfPath.slice(0, -extname(ref.pdfPath).length) + '-dual.pdf'
}

/** 进程内每篇文献一个翻译任务（幂等：进行中/已生成直接返回）。 */
// key=pdfPath；null=进行中（无阶段说明）；{phase}=进行中；{error}=已失败
const busy = new Map<string, { error?: string; phase?: string } | null>()

export function zhStatus(ref: PaperRef): ZhStatus {
  const zh = existsSync(zhPdfPath(ref))
  const dual = existsSync(dualPdfPath(ref))
  const b = busy.get(ref.pdfPath)
  return {
    zh,
    dual,
    busy: b === null || Boolean(b && !b.error),
    ...(b?.error ? { error: b.error } : {}),
    ...(b && !b.error && b.phase ? { phase: b.phase } : {}),
  }
}

/** 找 babeldoc 可执行文件：pdfqa venv（文献库同级 .venv-pdf2zh）→ PATH → miniconda。 */
async function findBabeldoc(dataDir: string): Promise<string | null> {
  const candidates = [
    join(dirname(dataDir), '.venv-pdf2zh', 'bin', 'babeldoc'),
    'babeldoc',
    '/opt/homebrew/Caskroom/miniconda/base/bin/babeldoc',
  ]
  for (const c of candidates) {
    if (c.includes('/')) {
      if (existsSync(c)) return c
      continue
    }
    // PATH 查找
    const found = await new Promise<boolean>((res) => {
      execFile('which', [c], (err, stdout) => res(!err && stdout.trim() !== ''))
    })
    if (found) return c
  }
  return null
}

/**
 * 探测 babeldoc 支持的 CLI 参数（按 bin 缓存，进程内只跑一次 --help）。
 * 必要性：--skip-figure-text 目前只在 GGboya 的 fork（PR#616）里，PyPI 版没有；
 * 不认识的参数会让 babeldoc 启动即报错，所以可选参数必须探测后再传。
 * 探测失败返回空集合——只丢可选功能，不影响核心参数。
 */
const flagSupport = new Map<string, Promise<Set<string>>>()
function babeldocFlags(bin: string): Promise<Set<string>> {
  let p = flagSupport.get(bin)
  if (!p) {
    p = new Promise<Set<string>>((res) => {
      execFile(bin, ['--help'], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) console.warn('[dsh-paper-reader] babeldoc --help 探测失败，按最老参数集运行')
        const flags = new Set<string>()
        for (const m of (stdout + '\n' + stderr).matchAll(/--[a-z0-9-]+/g)) {
          flags.add(m[0].slice(2))
        }
        res(flags)
      })
    })
    flagSupport.set(bin, p)
  }
  return p
}

/**
 * 启动 babeldoc 后台翻译。幂等：已生成或进行中直接返回 false 表示未新启动。
 * 完成/失败结果写进 busy map，由 zhStatus 暴露。
 * babeldoc 缺失时不再报错：后台自动走 uv 安装链路（首次约几分钟），
 * 期间 zhStatus.phase 展示安装进度，装完直接接着翻译。
 */
export async function startTranslation(
  ref: PaperRef,
  dataDir: string,
  endpoint: TranslateEndpoint,
): Promise<{ started: boolean; reason?: string; code?: string; firstRun?: boolean }> {
  const st = zhStatus(ref)
  if (st.zh || st.dual) return { started: false, reason: 'already-exists' }
  if (st.busy) return { started: false, reason: 'busy' }

  const pre = precheck(endpoint)
  if (pre) return pre
  const firstRun = !(await findBabeldoc(dataDir))
  void runPipeline(ref, dataDir, endpoint as Required<TranslateEndpoint>)
  return { started: true, firstRun }
}

/** 端点预检：不齐全时返回与 startTranslation 同形的失败结果。 */
function precheck(
  endpoint: TranslateEndpoint,
): { started: false; reason: string; code?: string } | null {
  if (!endpoint.baseUrl || !endpoint.apiKey || !endpoint.model) {
    // code 供前端判定「该弹配置表单了」，别让它去匹配中文文案
    return {
      started: false,
      code: 'no-endpoint',
      reason: '未配置翻译端点：在阅读器里点「中」按钮填写（OpenAI 兼容端点即可），或改 profile 的 translate 配置',
    }
  }
  return null
}

/** 后台流水线：确保 babeldoc 可用（缺失则自动安装）→ 拉起翻译。 */
async function runPipeline(
  ref: PaperRef,
  dataDir: string,
  endpoint: Required<TranslateEndpoint>,
): Promise<void> {
  const setPhase = (phase: string) => busy.set(ref.pdfPath, { phase })
  try {
    setPhase('正在检查翻译引擎…')
    const bin = await ensureBabeldoc(dataDir, dshHome(), () => findBabeldoc(dataDir), setPhase)
    await launch(ref, dataDir, endpoint, bin)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[dsh-paper-reader] babeldoc 自动安装失败:', msg)
    busy.set(ref.pdfPath, { error: `翻译引擎安装失败：${msg}` })
  }
}

/**
 * 重新翻译：删除已有译文产物后再启动（换模型/翻得不好时用）。
 * 先预检再删——端点不齐时不动旧译文，免得删完才发现跑不起来。
 * babeldoc 的段落缓存 key 含模型名，换模型自然失效，无需 --ignore-cache。
 */
export async function restartTranslation(
  ref: PaperRef,
  dataDir: string,
  endpoint: TranslateEndpoint,
): Promise<{ started: boolean; reason?: string; code?: string; firstRun?: boolean }> {
  if (zhStatus(ref).busy) return { started: false, reason: 'busy' }
  const pre = precheck(endpoint)
  if (pre) return pre
  await rm(zhPdfPath(ref), { force: true })
  await rm(dualPdfPath(ref), { force: true })
  const firstRun = !(await findBabeldoc(dataDir))
  void runPipeline(ref, dataDir, endpoint as Required<TranslateEndpoint>)
  return { started: true, firstRun }
}

/** 真正拉起 babeldoc 子进程（bin 已就绪、产物不存在/已删）。 */
async function launch(
  ref: PaperRef,
  dataDir: string,
  endpoint: Required<TranslateEndpoint>,
  bin: string,
): Promise<void> {
  const tmpDir = join(dataDir, '.pdf2zh-tmp')
  await mkdir(tmpDir, { recursive: true })
  busy.set(ref.pdfPath, null) // 清掉安装阶段说明，回到「翻译进行中」

  const stem = basename(ref.pdfPath, extname(ref.pdfPath))
  const dstStem = ref.pdfPath.slice(0, -extname(ref.pdfPath).length)
  // 推理型模型（glm-5.x / k3 / deepseek-flash）默认每段都先跑隐藏推理，翻译慢好几倍还偶尔返回空。
  // 这三家的 OpenAI 兼容端点都接受 DeepSeek 风格 thinking 开关（babeldoc --openai-thinking 即发该字段）；
  // 自定义端点不加——OpenAI 官方等严格校验参数的端点会因未知字段 400。
  // 可选参数统一过一遍探测：babeldoc 对不认识的参数直接报错退出，探测不到就不传（功能降级但不炸）。
  const supported = await babeldocFlags(bin)
  const opt = (flag: string) => (supported.has(flag) ? [`--${flag}`] : [])
  const noThink = /bigmodel|kimi|moonshot|deepseek/i.test(endpoint.baseUrl)
    ? opt('openai-thinking').flatMap((f) => [f, 'disabled'])
    : []
  const child = execFile(bin, [
    '--files', ref.pdfPath,
    '--lang-in', 'en', '--lang-out', 'zh-CN',
    '--openai', '--openai-model', endpoint.model,
    '--openai-base-url', endpoint.baseUrl, '--openai-api-key', endpoint.apiKey,
    ...noThink,
    '--qps', '16', '--no-watermark', '--output', tmpDir,
    // 图/图片区域内的文字保持原文（架构图术语不翻）——目前仅 fork(PR#616)支持
    ...opt('skip-figure-text'),
    // 跳过术语表自动抽取：该阶段要额外跑十几轮 LLM（推理型模型上能拖十几分钟，比正文还慢），
    // 换来的术语一致性提升有限
    ...opt('no-auto-extract-glossary'),
  ], {
    env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' }, // 版面模型走国内镜像
    timeout: 45 * 60 * 1000,
  }, (err, stdout, stderr) => {
    void (async () => {
      if (err) {
        const tail = (stdout + '\n' + stderr).slice(-400)
        console.error('[dsh-paper-reader] babeldoc failed:', tail)
        busy.set(ref.pdfPath, { error: `babeldoc 执行失败: ${err.message}` })
        return
      }
      // 产出从 scratch 挪回文献目录：<名>.zh-CN.mono.pdf → -zh.pdf，.dual.pdf → -dual.pdf
      try {
        for await (const f of glob(join(tmpDir, `${stem}*.zh-CN.mono.pdf`))) {
          await rename(f, dstStem + '-zh.pdf')
        }
        for await (const f of glob(join(tmpDir, `${stem}*.zh-CN.dual.pdf`))) {
          await rename(f, dstStem + '-dual.pdf')
        }
        if (!existsSync(zhPdfPath(ref)) && !existsSync(dualPdfPath(ref))) {
          busy.set(ref.pdfPath, { error: 'babeldoc 未产出译文 PDF' })
          return
        }
        busy.delete(ref.pdfPath)
        console.log(`[dsh-paper-reader] babeldoc done: ${ref.name}`)
      } catch (e) {
        busy.set(ref.pdfPath, { error: `移动译文产物失败: ${e instanceof Error ? e.message : String(e)}` })
      }
    })()
  })
  child.unref?.()
}

/** 解析 PDF 变体路径（原文/zh/dual）。 */
export function pdfVariantPath(ref: PaperRef, variant?: string | null): string {
  if (variant === 'zh') return zhPdfPath(ref)
  if (variant === 'dual') return dualPdfPath(ref)
  return ref.pdfPath
}
