// transcribe.ts — PDF 转录（纯函数，不依赖 Cordis）。
//
// 移植 pdfqa 的三级策略（视觉兜底后置）：
//  1. 缓存：.txt 已存在直接复用
//  2. 快路径：python3 + PyMuPDF 本地提取文本层（文本型 PDF 毫秒级）
//  3. 慢路径：视觉转录（扫描件兜底）— 暂不支持，返回明确错误
//
// 与 pdfqa 的差异：输出附带 pages.json 页码偏移表（每页文本在全文中的 [start,end) 区间），
// 让 search_paper 能把片段映射回页码。清洗（连字/断词/段落重排）全部在 Python 侧、
// 偏移计算之前完成，保证偏移与最终文本严格一致。

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { PaperRef } from './library.ts'
import { transcriptCached } from './library.ts'

const execFileP = promisify(execFile)

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

// Python 脚本：提取文本层 → 剔页眉页脚 → 清洗 → 带偏移拼页。
// 退出码 3 = 文本过少（扫描件），交给上层决定兜底策略。
const EXTRACT_SCRIPT = String.raw`
import fitz, sys, re, json
from collections import Counter

LIG = {'ﬁ':'fi','ﬂ':'fl','ﬀ':'ff','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'st'}
def ligature(s):
    for k, v in LIG.items():
        s = s.replace(k, v)
    return s

doc = fitz.open(sys.argv[1])
raw_pages = []
for page in doc:
    lines = [l.strip() for l in page.get_text().splitlines()]
    raw_pages.append([l for l in lines if l])

# 页眉页脚识别：页首 2 行/页尾 3 行归一化（去数字标点，页码归一为空串），
# 在 >=1/5 页面边缘反复出现即剔除；只剔边缘行，正文相同行不受影响。
thresh = max(3, len(raw_pages) // 5)
def norm(l): return re.sub(r'[\d\W]+', '', l).lower()
edge = Counter()
for p in raw_pages:
    for l in p[:2] + p[-3:]:
        edge[norm(l)] += 1
bad = {l for l, n in edge.items() if n >= thresh}

page_texts = []
for p in raw_pages:
    while p and norm(p[0]) in bad:
        p.pop(0)
    while p and norm(p[-1]) in bad:
        p.pop()
    t = '\n'.join(p)
    t = ligature(t)
    t = re.sub(r'(\w)-\n(\w)', r'\1\2', t)  # 页内断词愈合
    page_texts.append(t.strip())

total = sum(len(t) for t in page_texts)
if total < 100 * max(1, len(doc)):
    sys.exit(3)  # 扫描件

# 段落重排拼页：PDF 分页会把一个句子拆到相邻两页（页眉页脚剔除后就挨在一起）。
# 上一页不以句末标点结束、且下一页以小写字母开头 → 同句延续，用空格衔接；
# 该页的偏移区间只覆盖它自己的文字（跨页句引用起始页）。
SENT_END = re.compile(r'[.!?:;]["\'”’)\]]*$')
buf = ''
spans = []
for i, t in enumerate(page_texts):
    if not t:
        continue
    if not buf:
        spans.append((i + 1, 0, len(t)))
        buf = t
        continue
    if not SENT_END.search(buf) and t[0].islower():
        buf = buf.rstrip(' \n')
        start = len(buf) + 1
        buf = buf + ' ' + t
    else:
        start = len(buf) + 2
        buf = buf + '\n\n' + t
    spans.append((i + 1, start, len(buf)))

print(json.dumps({
    'pageCount': len(doc),
    'chars': len(buf),
    'text': buf,
    'pages': [{'page': p, 'start': s, 'end': e} for p, s, e in spans],
}, ensure_ascii=False))
`

/** 逐个尝试 python 候选（多个 python 里不一定都装了 fitz）。 */
async function runPyMuPDF(script: string, pdfPath: string): Promise<{ ok: boolean; stdout: string; scanned: boolean }> {
  const candidates = ['python3', '/opt/homebrew/Caskroom/miniconda/base/bin/python3', '/usr/bin/python3']
  let sawScanned = false
  for (const py of candidates) {
    try {
      const { stdout } = await execFileP(py, ['-c', script, pdfPath], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      })
      return { ok: true, stdout, scanned: false }
    } catch (err) {
      // 退出码 3 = 扫描件信号，换一个 python 也没用，但记住这个结论
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 3) sawScanned = true
    }
  }
  return { ok: false, stdout: '', scanned: sawScanned }
}

/**
 * 转录一篇文献：缓存优先，否则本地 PyMuPDF 提取并落盘（.txt + .pages.json）。
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
  const { ok, stdout, scanned } = await runPyMuPDF(EXTRACT_SCRIPT, pdfPath)
  if (!ok) {
    throw new Error(
      scanned
        ? '本地提取的文本过少，该 PDF 可能是扫描件。视觉转录兜底尚未实现（Phase 1 后置项），请换文本型 PDF 或手动放置同名 .txt 缓存。'
        : '未找到可用的 python3 + PyMuPDF 环境。请安装：python3 -m pip install PyMuPDF',
    )
  }
  const data = JSON.parse(stdout) as { pageCount: number; chars: number; text: string; pages: PageSpan[] }
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
    return null // 无 python 环境或扫描件：保持旧缓存，页码索引缺席
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
