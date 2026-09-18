// transcribe.ts — PDF 转录（纯函数，不依赖 Cordis）。
//
// 移植 pdfqa 的三级策略（视觉兜底后置）：
//  1. 缓存：.txt 已存在直接复用
//  2. 快路径：pdfjs-dist（pdf.js）本地提取文本层（文本型 PDF 毫秒级，纯 Node，无需 Python）
//  3. 慢路径：视觉转录（扫描件兜底）— 暂不支持，返回明确错误
//
// 与 pdfqa 的差异：输出附带 pages.json 页码偏移表（每页文本在全文中的 [start,end) 区间），
// 让 search_paper 能把片段映射回页码。清洗（连字/断词/段落重排）全部在偏移计算之前完成，
// 保证偏移与最终文本严格一致。
//
// 历史上快路径用 python3 + PyMuPDF，0.3.0 起换成 pdfjs-dist：阅读器本来就用 pdf.js 渲染，
// 提取能力等价，且消除了对用户机 Python 环境的依赖。清洗规则与 PyMuPDF 版逐条对齐，
// 缓存格式（.txt + .pages.json）不变，旧缓存继续兼容。

import { readFile, writeFile } from 'node:fs/promises'
import type { PaperRef } from './library.ts'
import { transcriptCached } from './library.ts'

export interface PageSpan {
  page: number
  start: number
  end: number
}

export interface Transcript {
  text: string
  pages: PageSpan[]
  pageCount: number
  chars: number
  /** cache=复用缓存, local=本次本地提取 */
  source: 'cache' | 'local'
}

/** 扫描件信号：文本层过少，换提取器也没用，上层据此给专门提示。 */
class ScannedPdfError extends Error {}

// ---- 以下为 PyMuPDF 版清洗规则的逐条 TS 移植 ----

const LIGATURES: [string, string][] = [
  ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬀ', 'ff'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'], ['ﬅ', 'st'],
]
function ligature(s: string): string {
  for (const [k, v] of LIGATURES) s = s.replaceAll(k, v)
  return s
}

/** 页眉页脚归一化：去数字标点（对应 Python re.sub(r'[\d\W]+','',l).lower()，保留 unicode 字母）。 */
function norm(l: string): string {
  return l.replace(/[^\p{L}_]/gu, '').toLowerCase()
}

const SENT_END = /[.!?:;]["'”’)\]]*$/

interface RawExtract {
  pageCount: number
  chars: number
  text: string
  pages: PageSpan[]
}

/**
 * pdfjs 提取文本层 → 剔页眉页脚 → 清洗 → 带偏移拼页。
 * 扫描件（文本过少）抛 ScannedPdfError，交给上层决定兜底策略。
 * pdfjs-dist 体积不小，动态 import，首次转录时才加载。
 */
async function extractWithPdfjs(pdfPath: string): Promise<RawExtract> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(pdfPath))
  const loadingTask = getDocument({ data, disableFontFace: true, verbosity: 0 })
  const doc = await loadingTask.promise
  try {
    // 每页拼行：getTextContent 的 hasEOL 标记行尾，等价于 PyMuPDF get_text().splitlines()
    const rawPages: string[][] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const lines: string[] = []
      let cur = ''
      for (const item of tc.items) {
        if (typeof (item as { str?: unknown }).str !== 'string') continue
        cur += (item as { str: string }).str
        if ((item as { hasEOL?: boolean }).hasEOL) {
          lines.push(cur.trim())
          cur = ''
        }
      }
      if (cur.trim()) lines.push(cur.trim())
      rawPages.push(lines.filter((l) => l))
      page.cleanup()
    }

    // 页眉页脚识别：页首 2 行/页尾 3 行归一化（去数字标点），
    // 在 >=1/5 页面边缘反复出现即剔除；只剔边缘行，正文相同行不受影响。
    const thresh = Math.max(3, Math.floor(rawPages.length / 5))
    const edge = new Map<string, number>()
    for (const p of rawPages) {
      for (const l of [...p.slice(0, 2), ...p.slice(-3)]) {
        const n = norm(l)
        edge.set(n, (edge.get(n) ?? 0) + 1)
      }
    }
    const bad = new Set([...edge].filter(([, n]) => n >= thresh).map(([l]) => l))

    const pageTexts: string[] = []
    for (const p of rawPages) {
      while (p.length && bad.has(norm(p[0]!))) p.shift()
      while (p.length && bad.has(norm(p[p.length - 1]!))) p.pop()
      let t = p.join('\n')
      t = ligature(t)
      t = t.replace(/(\w)-\n(\w)/g, '$1$2') // 页内断词愈合
      pageTexts.push(t.trim())
    }

    const total = pageTexts.reduce((s, t) => s + t.length, 0)
    if (total < 100 * Math.max(1, doc.numPages)) throw new ScannedPdfError()

    // 段落重排拼页：PDF 分页会把一个句子拆到相邻两页（页眉页脚剔除后就挨在一起）。
    // 上一页不以句末标点结束、且下一页以小写字母开头 → 同句延续，用空格衔接；
    // 该页的偏移区间只覆盖它自己的文字（跨页句引用起始页）。
    let buf = ''
    const spans: PageSpan[] = []
    for (let i = 0; i < pageTexts.length; i++) {
      const t = pageTexts[i]!
      if (!t) continue
      if (!buf) {
        spans.push({ page: i + 1, start: 0, end: t.length })
        buf = t
        continue
      }
      let start: number
      if (!SENT_END.test(buf) && /^\p{Ll}/u.test(t)) {
        buf = buf.replace(/[ \n]+$/, '')
        start = buf.length + 1
        buf = buf + ' ' + t
      } else {
        start = buf.length + 2
        buf = buf + '\n\n' + t
      }
      spans.push({ page: i + 1, start, end: buf.length })
    }

    return { pageCount: doc.numPages, chars: buf.length, text: buf, pages: spans }
  } finally {
    await loadingTask.destroy()
  }
}

/**
 * 转录一篇文献：缓存优先，否则本地 pdfjs 提取并落盘（.txt + .pages.json）。
 * 扫描件（文本层过少）抛错并说明视觉兜底尚未实现。
 */
export async function transcribePaper(ref: PaperRef, opts: { force?: boolean } = {}): Promise<Transcript> {
  if (!opts.force && transcriptCached(ref)) {
    const text = await readFile(ref.txtPath, 'utf8')
    let pages = await readPages(ref)
    if (!pages) {
      // 兼容升级：pdfqa 时代的缓存只有 .txt 没有页码索引。
      // 重新提取生成页码索引；新旧文本长度接近才覆盖（视觉转录的扫描件缓存不容侵犯）。
      const upgraded = await tryUpgradePageIndex(ref, text.length)
      if (upgraded) {
        pages = upgraded.pages
        return { text: upgraded.text, pages, pageCount: pages.length, chars: upgraded.text.length, source: 'cache' }
      }
    }
    return { text, pages: pages ?? [], pageCount: pages?.length ?? 0, chars: text.length, source: 'cache' }
  }

  const extracted = await extractAndStore(ref)
  return extracted
}

/** 本地提取（不落盘）。 */
async function extractLocal(pdfPath: string): Promise<Transcript> {
  let data: RawExtract
  try {
    data = await extractWithPdfjs(pdfPath)
  } catch (err) {
    if (err instanceof ScannedPdfError) {
      throw new Error('本地提取的文本过少，该 PDF 可能是扫描件。视觉转录兜底尚未实现（Phase 1 后置项），请换文本型 PDF 或手动放置同名 .txt 缓存。')
    }
    throw new Error(`PDF 文本提取失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (data.text.length < 1000) {
    throw new Error(`转录结果过短(${data.text.length} 字符)，疑似失败，请重试`)
  }
  return { text: data.text, pages: data.pages, pageCount: data.pageCount, chars: data.chars, source: 'local' }
}

/** 本地提取并落盘。 */
async function extractAndStore(ref: PaperRef): Promise<Transcript> {
  const t = await extractLocal(ref.pdfPath)
  await writeFile(ref.txtPath, t.text, 'utf8')
  await writeFile(ref.pagesPath, JSON.stringify({ pageCount: t.pageCount, pages: t.pages }, null, 2), 'utf8')
  return t
}

/** 为旧缓存补建页码索引：成功且长度相近才覆盖 .txt，返回新内容；否则返回 null。 */
async function tryUpgradePageIndex(ref: PaperRef, cachedLen: number): Promise<{ text: string; pages: PageSpan[] } | null> {
  try {
    const t = await extractLocal(ref.pdfPath)
    const ratio = t.text.length / Math.max(1, cachedLen)
    if (ratio < 0.5 || ratio > 2) return null // 差异过大：旧文本可能来自视觉转录，不回写
    await writeFile(ref.txtPath, t.text, 'utf8')
    await writeFile(ref.pagesPath, JSON.stringify({ pageCount: t.pageCount, pages: t.pages }, null, 2), 'utf8')
    return { text: t.text, pages: t.pages }
  } catch {
    return null // 提取失败或扫描件：保持旧缓存，页码索引缺席
  }
}

/** 读页码偏移表；旧缓存（pdfqa 时代）没有 pages.json 时返回 null。 */
export async function readPages(ref: PaperRef): Promise<PageSpan[] | null> {
  try {
    const raw = JSON.parse(await readFile(ref.pagesPath, 'utf8')) as { pages: PageSpan[] }
    return raw.pages
  } catch {
    return null
  }
}

/** 读转录文本（不触发转录）；无缓存返回 null。 */
export async function readTranscript(ref: PaperRef): Promise<{ text: string; pages: PageSpan[] | null } | null> {
  try {
    const text = await readFile(ref.txtPath, 'utf8')
    return { text, pages: await readPages(ref) }
  } catch {
    return null
  }
}
