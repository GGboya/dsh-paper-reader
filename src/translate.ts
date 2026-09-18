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
}

export function zhPdfPath(ref: PaperRef): string {
  return ref.pdfPath.slice(0, -extname(ref.pdfPath).length) + '-zh.pdf'
}
export function dualPdfPath(ref: PaperRef): string {
  return ref.pdfPath.slice(0, -extname(ref.pdfPath).length) + '-dual.pdf'
}

/** 进程内每篇文献一个翻译任务（幂等：进行中/已生成直接返回）。 */
const busy = new Map<string, string | null>() // key=pdfPath, value=error|null(进行中)

export function zhStatus(ref: PaperRef): ZhStatus {
  const zh = existsSync(zhPdfPath(ref))
  const dual = existsSync(dualPdfPath(ref))
  const b = busy.get(ref.pdfPath)
  return {
    zh,
    dual,
    busy: b === null,
    ...(typeof b === 'string' ? { error: b } : {}),
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
 * 启动 babeldoc 后台翻译。幂等：已生成或进行中直接返回 false 表示未新启动。
 * 完成/失败结果写进 busy map，由 zhStatus 暴露。
 */
export async function startTranslation(
  ref: PaperRef,
  dataDir: string,
  endpoint: TranslateEndpoint,
): Promise<{ started: boolean; reason?: string; code?: string }> {
  const st = zhStatus(ref)
  if (st.zh || st.dual) return { started: false, reason: 'already-exists' }
  if (st.busy) return { started: false, reason: 'busy' }

  const pre = await precheck(dataDir, endpoint)
  if (pre) return pre
  return launch(ref, dataDir, endpoint as Required<TranslateEndpoint>)
}

/** 端点/babeldoc 预检：不齐全时返回与 startTranslation 同形的失败结果。 */
async function precheck(
  dataDir: string,
  endpoint: TranslateEndpoint,
): Promise<{ started: false; reason: string; code?: string } | null> {
  const bin = await findBabeldoc(dataDir)
  if (!bin) return { started: false, reason: '未找到 babeldoc（pip install babeldoc，或复用 pdfqa 的 .venv-pdf2zh）' }
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

/**
 * 重新翻译：删除已有译文产物后再启动（换模型/翻得不好时用）。
 * 先预检再删——端点不齐或 babeldoc 缺失时不动旧译文，免得删完才发现跑不起来。
 * babeldoc 的段落缓存 key 含模型名，换模型自然失效，无需 --ignore-cache。
 */
export async function restartTranslation(
  ref: PaperRef,
  dataDir: string,
  endpoint: TranslateEndpoint,
): Promise<{ started: boolean; reason?: string; code?: string }> {
  if (zhStatus(ref).busy) return { started: false, reason: 'busy' }
  const pre = await precheck(dataDir, endpoint)
  if (pre) return pre
  await rm(zhPdfPath(ref), { force: true })
  await rm(dualPdfPath(ref), { force: true })
  return launch(ref, dataDir, endpoint as Required<TranslateEndpoint>)
}

/** 真正拉起 babeldoc 子进程（precheck 已通过、产物不存在/已删）。 */
async function launch(
  ref: PaperRef,
  dataDir: string,
  endpoint: Required<TranslateEndpoint>,
): Promise<{ started: boolean; reason?: string; code?: string }> {
  const bin = (await findBabeldoc(dataDir))!
  const tmpDir = join(dataDir, '.pdf2zh-tmp')
  await mkdir(tmpDir, { recursive: true })
  busy.set(ref.pdfPath, null)

  const stem = basename(ref.pdfPath, extname(ref.pdfPath))
  const dstStem = ref.pdfPath.slice(0, -extname(ref.pdfPath).length)
  // 推理型模型（glm-5.x / k3 / deepseek-flash）默认每段都先跑隐藏推理，翻译慢好几倍还偶尔返回空。
  // 这三家的 OpenAI 兼容端点都接受 DeepSeek 风格 thinking 开关（babeldoc --openai-thinking 即发该字段）；
  // 自定义端点不加——OpenAI 官方等严格校验参数的端点会因未知字段 400。
  const noThink = /bigmodel|kimi|moonshot|deepseek/i.test(endpoint.baseUrl)
    ? ['--openai-thinking', 'disabled']
    : []
  const child = execFile(bin, [
    '--files', ref.pdfPath,
    '--lang-in', 'en', '--lang-out', 'zh-CN',
    '--openai', '--openai-model', endpoint.model,
    '--openai-base-url', endpoint.baseUrl, '--openai-api-key', endpoint.apiKey,
    ...noThink,
    '--qps', '16', '--no-watermark', '--output', tmpDir,
    '--skip-figure-text', // 图/图片区域内的文字保持原文（架构图术语不翻）
    // 跳过术语表自动抽取：该阶段要额外跑十几轮 LLM（推理型模型上能拖十几分钟，比正文还慢），
    // 换来的术语一致性提升有限
    '--no-auto-extract-glossary',
  ], {
    env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' }, // 版面模型走国内镜像
    timeout: 45 * 60 * 1000,
  }, (err, stdout, stderr) => {
    void (async () => {
      if (err) {
        const tail = (stdout + '\n' + stderr).slice(-400)
        console.error('[dsh-paper-reader] babeldoc failed:', tail)
        busy.set(ref.pdfPath, `babeldoc 执行失败: ${err.message}`)
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
          busy.set(ref.pdfPath, 'babeldoc 未产出译文 PDF')
          return
        }
        busy.delete(ref.pdfPath)
        console.log(`[dsh-paper-reader] babeldoc done: ${ref.name}`)
      } catch (e) {
        busy.set(ref.pdfPath, `移动译文产物失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    })()
  })
  child.unref?.()
  return { started: true }
}

/** 解析 PDF 变体路径（原文/zh/dual）。 */
export function pdfVariantPath(ref: PaperRef, variant?: string | null): string {
  if (variant === 'zh') return zhPdfPath(ref)
  if (variant === 'dual') return dualPdfPath(ref)
  return ref.pdfPath
}
