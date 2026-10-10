// formulas.ts — MinerU content_list → 阅读器可用的公式索引（纯函数 + 一次读盘）。
//
// 背景（docs/reader-ux-requirements.md §1）：PDF 文本层里的公式是乱码（`𝑧𝑧1 𝑧𝑧2` 这类
// 重复字形），鼠标选中拿不到可用内容；MinerU 的 content_list 里每个 equation 块带
// LaTeX（`text`）与 `bbox`，这才是可引用的真相源。
//
// bbox 坐标系（实测 + 源码实证，见需求文档 §1.1）：**页面归一化坐标 ×1000**
//   x = bbox[0]/1000 * viewport.width ，y = bbox[1]/1000 * viewport.height
// 原点左上、y 向下、与缩放无关。归一化只在 page_size 存在时才成立，所以这里做一次
// 防御性判定：全页最大分量 ≤ 1000 → 'normalized-1000'，否则退回 'page-units'
// （调用方按 pt/px × scale 处理），避免云端版本差异导致热区整体错位。
//
// ⚠️ 与需求文档的**显式偏离**（队长在 t2 进行中裁定的契约修订）：
//   文档 §1.7 写的是「`latex` 原样含 `$$`」，本轮改为**紧凑形态**——服务端复用既有的
//   投影函数 `compressMathSpaces` + `normalizeMathBraces`（src/mineru.ts 导出，与
//   content_list → .txt 的投影同一套规则）。理由：MinerU 原始输出每个 token 之间都插空格
//   （`\pi ( \mathbf { s } _ { t } )`），① 与同一产品 .txt 里的检索形态自相矛盾；
//   ② 用户会把 LaTeX 粘到别处，紧凑写法才是地道 LaTeX。`$$` 定界符保留（模型友好）。
//   `\text{}`/`\textrm`/`\mbox` 一族按既有规则整组原样保留（组内空格是排版语义）。

import { readFile, stat } from 'node:fs/promises'
import { compressMathSpaces, normalizeMathBraces } from './mineru.ts'
import type { PaperRef } from './library.ts'

export type FormulaReason = 'no-mineru-artifact' | 'no-equations' | 'bad-artifact'
export type BboxSpace = 'normalized-1000' | 'page-units'

export interface FormulaEntry {
  /** 稳定 id：`${pageIdx}:${页内阅读序}`（前端去重/定位用） */
  id: string
  /** 页码（1 起，= page_idx + 1） */
  page: number
  /** content_list 里的 page_idx（0 起） */
  pageIdx: number
  /** 页内序号（1 起，阅读序） */
  index: number
  /** [x0,y0,x1,y1]，归一化坐标（null = 该块没有可用 bbox） */
  bbox: [number, number, number, number] | null
  /** MinerU 原文，形如 `$$\n\\pi ( \\mathbf { s } _ { t } ) …$$` */
  latex: string
  textFormat: string | null
}

export interface FormulaIndex {
  source: 'mineru' | 'none'
  producer: string | null
  backend: string | null
  pageCount: number | null
  /** 恒 null：`.mineru.json` 不落 page_size（bbox 已归一化，前端只用 viewport） */
  pageSize: null
  /** bbox 坐标空间（供前端选择映射分支） */
  bboxSpace: BboxSpace
  equations: FormulaEntry[]
  reason?: FormulaReason
  warning?: string
}

/** 供测试与调用方复用的紧凑化：既有投影两步 + 算子名统一（见下）。 */
export function compactLatex(rawLatex: string): string {
  return unifyOperatorNames(normalizeMathBraces(compressMathSpaces(rawLatex)))
}

/**
 * `\operatorname` / `\operatorname*` 的算子名统一（**引用路径专用**，契约 t2 第 2 次修订）。
 *
 * 背景：MinerU 对算子名做**逐字符空格化**（`\operatorname { D o g }`），照原样渲染会出现
 * `D o g` 这类多余空格；而既有投影函数把 `\operatorname` 整组保护起来（不压空格），
 * 带 `*` 的变体因命令名扫描在 `*` 处断开而**没被保护**——于是两个变体行为不一致。
 *
 * 精确规则（两个变体完全一致）：
 *   · 组内 token **全部是单字符** → 判为逐字符空格化产物，合并成一个词：
 *     `{ m a x }`→`max`、`{ i f }`→`if`、`{ D o g }`→`Dog`、`{ s . t . }`→`s.t.`
 *   · 否则**原样保留**：`{ arg max }`（token 是 `arg`/`max`）绝不能被合并成 `argmax`。
 *   花括号不配对 / 组缺失 → 一律不碰。
 *
 * 上游根因已同步修掉（src/mineru.ts 的 scanCommandName）：命令名扫描原先在 `*` 处停下，
 * 导致带 `*` 的变体压根没被当成受保护组、两个变体行为不一致；现在两变体走同一条路径。
 * 「合并成一个词」这一步仍只放在**引用路径**（本模块）：.txt 投影里 `\operatorname{a b c}`
 * 保持逐字符空格是被既有断言固定的行为（test/embed-search.test.mjs H1、
 * test/embed-verification.test.mjs 6.1），在共享函数里合并会破坏那两条断言与
 * 「既有 182 个用例保持通过」。
 */
export function unifyOperatorNames(latex: string): string {
  if (!latex.includes('\\operatorname')) return latex
  const CMD = '\\operatorname'
  let out = ''
  let i = 0
  while (i < latex.length) {
    const at = latex.indexOf(CMD, i)
    if (at < 0) { out += latex.slice(i); break }
    let k = at + CMD.length
    if (latex.startsWith('withlimits', k)) k += 'withlimits'.length
    else if (latex[k] === '*') k += 1
    else if (isAsciiLetter(latex[k] ?? '')) { out += latex.slice(i, k); i = k; continue } // 前缀同形命令不卷进来
    const head = latex.slice(at, k)
    let p = k
    while (p < latex.length && /\s/.test(latex[p]!)) p++
    if (latex[p] !== '{') { out += latex.slice(i, k); i = k; continue }
    const end = matchBrace(latex, p)
    if (end < 0) { out += latex.slice(i, k); i = k; continue } // 花括号不配对：此后一律不碰
    const inner = latex.slice(p + 1, end)
    const tokens = inner.trim().split(/\s+/).filter((t) => t.length > 0)
    if (tokens.length > 0 && tokens.every((t) => [...t].length === 1)) {
      out += latex.slice(i, at) + head + '{' + tokens.join('') + '}' // 逐字符空格化 → 合并成一个词
    } else {
      // `{ arg max }` 等：组内容一字不动（绝不合并），只削掉紧贴花括号的填充空白——
      // 让带 `*` 与不带 `*` 两个变体输出一致（`\operatorname{arg max}` / `\operatorname*{arg max}`）。
      // 花括号内侧的空格在 \operatorname 组内无语义，削掉安全；\text 一族不走这里（保持逐字节原样）。
      out += latex.slice(i, at) + head + '{' + inner.trim() + '}'
    }
    i = end + 1
  }
  return out
}

function isAsciiLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

/** `{` 起始的配对花括号：返回对应 `}` 的下标，失败返回 -1（转义 `\{` / `\}` 跳过）。 */
function matchBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const EMPTY = (reason: FormulaReason, warning?: string): FormulaIndex => ({
  source: reason === 'no-mineru-artifact' ? 'none' : 'mineru',
  producer: null,
  backend: null,
  pageCount: null,
  pageSize: null,
  bboxSpace: 'normalized-1000',
  equations: [],
  reason,
  ...(warning ? { warning } : {}),
})

function toBbox(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null
  const out: number[] = []
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
    out.push(n)
  }
  return out as [number, number, number, number]
}

/** 从 `.mineru.json` 的原始文本建索引。`raw === null` = 文件不存在（走 pdfjs 或未转录）。 */
export function buildFormulaIndex(raw: string | null, opts: { producer?: unknown; backend?: unknown; pageCount?: unknown } = {}): FormulaIndex {
  if (raw === null) return EMPTY('no-mineru-artifact')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY('bad-artifact', 'mineru.json 不是合法 JSON，已忽略')
  }
  if (!isRecord(parsed)) return EMPTY('bad-artifact', 'mineru.json 顶层不是对象，已忽略')

  const list = parsed['contentList']
  if (list === undefined) return EMPTY('bad-artifact', 'mineru.json 缺少 contentList，已忽略')
  if (!Array.isArray(list)) return EMPTY('bad-artifact', 'contentList 不是数组，已忽略')

  const producer = typeof parsed['producer'] === 'string' ? parsed['producer'] : (typeof opts.producer === 'string' ? opts.producer : null)
  const backend = typeof parsed['backend'] === 'string' ? parsed['backend'] : (typeof opts.backend === 'string' ? opts.backend : null)
  const pageCount = typeof parsed['pageCount'] === 'number' && Number.isFinite(parsed['pageCount'])
    ? parsed['pageCount']
    : (typeof opts.pageCount === 'number' && Number.isFinite(opts.pageCount) ? opts.pageCount : null)

  // 逐块取 equation（缺 page_idx 的块沿用上一个有页码的块——与 transcribe.ts 的投影口径一致）
  const raw_eq: Array<{ pageIdx: number; bbox: [number, number, number, number] | null; latex: string; fmt: string | null }> = []
  let lastPageIdx = 0
  let malformed = 0
  for (const b of list) {
    if (!isRecord(b)) { malformed++; continue }
    if (b['type'] !== 'equation') continue
    const pi = b['page_idx']
    if (typeof pi === 'number' && Number.isFinite(pi) && pi >= 0) lastPageIdx = Math.trunc(pi)
    const text = b['text']
    const latex = typeof text === 'string' ? text : ''
    const fmt = typeof b['text_format'] === 'string' ? b['text_format'] : null
    if (typeof pi !== 'number' && text === undefined) malformed++
    raw_eq.push({ pageIdx: lastPageIdx, bbox: toBbox(b['bbox']), latex, fmt })
  }

  // 阅读序：先页码，再自上而下（bbox[1]），再自左而右（bbox[0]）。content_list 本身是
  // 版面序（先左栏后右栏），直接照抄会给错序（实测：一页里 y 是 486,688,809,409,511）。
  raw_eq.sort((a, b) => {
    if (a.pageIdx !== b.pageIdx) return a.pageIdx - b.pageIdx
    const ay = a.bbox ? a.bbox[1] : Number.MAX_SAFE_INTEGER
    const by = b.bbox ? b.bbox[1] : Number.MAX_SAFE_INTEGER
    if (ay !== by) return ay - by
    const ax = a.bbox ? a.bbox[0] : Number.MAX_SAFE_INTEGER
    const bx = b.bbox ? b.bbox[0] : Number.MAX_SAFE_INTEGER
    return ax - bx
  })

  const perPage = new Map<number, number>()
  const equations: FormulaEntry[] = raw_eq.map((e) => {
    const index = (perPage.get(e.pageIdx) ?? 0) + 1
    perPage.set(e.pageIdx, index)
    return {
      id: `${e.pageIdx}:${index}`,
      page: e.pageIdx + 1,
      pageIdx: e.pageIdx,
      index,
      bbox: e.bbox,
      // 紧凑形态：既有投影两步 + 算子名统一（见文件头与 unifyOperatorNames 的说明）
      latex: compactLatex(e.latex),
      textFormat: e.fmt,
    }
  })

  if (equations.length === 0) {
    const reason = malformed > 0 ? 'bad-artifact' : 'no-equations'
    const idx = EMPTY(reason, malformed > 0 ? `contentList 中有 ${malformed} 个无法解析的块` : undefined)
    return { ...idx, producer, backend, pageCount }
  }

  // 坐标空间判定：全页最大分量 ≤ 1000 → 归一化（MinerU 3.x 的口径）；否则按原始单位处理。
  let maxComp = 0
  for (const e of equations) {
    if (!e.bbox) continue
    for (const v of e.bbox) maxComp = Math.max(maxComp, v)
  }
  const bboxSpace: BboxSpace = maxComp > 1000 ? 'page-units' : 'normalized-1000'

  return {
    source: 'mineru',
    producer,
    backend,
    pageCount,
    pageSize: null,
    bboxSpace,
    equations,
    ...(bboxSpace === 'page-units' ? { warning: 'bbox 分量超过 1000，按原始单位（pt/px）处理' } : {}),
  }
}

// ── 读盘 + 记忆化（.mineru.json 实测 146KB/31 页，不能让每次渲染都读一遍）─────────
interface CacheEntry { key: string; value: FormulaIndex }
let cache: CacheEntry | null = null

/** 读 `<ref.mineruJsonPath>` 并建索引。文件缺失/损坏一律返回可用的空索引，**不抛异常**。 */
export async function readFormulaIndex(ref: PaperRef): Promise<FormulaIndex> {
  let key = `${ref.mineruJsonPath}:absent`
  try {
    const st = await stat(ref.mineruJsonPath)
    key = `${ref.mineruJsonPath}:${st.mtimeMs}:${st.size}`
    if (cache && cache.key === key) return cache.value
    const raw = await readFile(ref.mineruJsonPath, 'utf8')
    const value = buildFormulaIndex(raw)
    cache = { key, value }
    return value
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR') {
      const value = buildFormulaIndex(null)
      if (cache?.key === key) return cache.value
      cache = { key, value }
      return value
    }
    // 权限等异常也不许把阅读器打崩：降级成 bad-artifact
    return EMPTY('bad-artifact', `读取 mineru.json 失败：${code ?? 'unknown'}`)
  }
}

/** 仅供测试：清空记忆化。 */
export function resetFormulaCache(): void {
  cache = null
}
