// search.ts — 长文档分段检索（纯函数，不依赖 Cordis）。
// 移植 pdfqa 的 chunkText + searchPaper，新增：片段 → 页码映射（经 pages.json 偏移表）。

import type { PageSpan } from './transcribe.ts'
// 折叠项 1：查询侧归一化复用**投影侧同一个** token 级归一化函数（normalizeMathBody 的导出别名），
// 规则逐字符一致，不存在「两套实现各自漂移」的可能。
import { normalizeMathTokens } from './mineru.ts'

export interface Chunk {
  /** 片段序号（1 起，按原文顺序） */
  index: number
  /** 在全文中的字符区间 */
  start: number
  end: number
  text: string
}

/** 按空行分段后打包成 ~size 字符的片段（忠实移植 pdfqa chunkText）。 */
export function chunkText(text: string, size = 1500): Chunk[] {
  const paras = text.split('\n\n')
  const chunks: Chunk[] = []
  let cur = ''
  let curStart = 0
  // offset 追踪：每段在原文中的起点（paras 之间由 \n\n 连接）
  let offset = 0
  const flush = (end: number) => {
    if (cur.length > 0) chunks.push({ index: chunks.length + 1, start: curStart, end, text: cur })
    cur = ''
  }
  for (const raw of paras) {
    const p = raw.trim()
    const pStart = offset + (raw.length - raw.trimStart().length)
    offset += raw.length + 2 // +2 为 \n\n
    if (p === '') continue
    if (cur.length > 0 && cur.length + p.length > size) flush(pStart - 2)
    // 单段超过 size 的硬切
    let rest = p
    let restStart = pStart
    while (rest.length > size) {
      if (cur.length > 0) flush(restStart)
      chunks.push({ index: chunks.length + 1, start: restStart, end: restStart + size, text: rest.slice(0, size) })
      rest = rest.slice(size)
      restStart += size
    }
    if (rest !== '') {
      if (cur.length > 0) cur += '\n\n'
      else curStart = restStart
      cur += rest
    }
  }
  flush(text.length)
  return chunks
}

/** 字符位置 → 页码。无偏移表返回 null；跨页片段返回起始页。 */
export function pageForOffset(pages: PageSpan[] | null, pos: number): number | null {
  if (!pages || pages.length === 0) return null
  let best: PageSpan | undefined
  for (const span of pages) {
    if (pos >= span.start && pos < span.end) return span.page
    if (!best || span.start <= pos) best = span
  }
  return best?.page ?? null
}

export interface SearchHit {
  chunk: Chunk
  score: number
  page: number | null
}

/** 关键词检索：按词项出现频次 × 词长打分，top-k 后按原文顺序返回（移植 pdfqa）。 */
export function searchChunks(chunks: Chunk[], pages: PageSpan[] | null, query: string, k = 5): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hits: SearchHit[] = []
  for (const chunk of chunks) {
    const lc = chunk.text.toLowerCase()
    let score = 0
    for (const t of terms) {
      score += countOccurrences(lc, t) * t.length // 长词权重高
    }
    if (score > 0) hits.push({ chunk, score, page: pageForOffset(pages, chunk.start) })
  }
  hits.sort((a, b) => b.score - a.score)
  const top = hits.slice(0, k)
  top.sort((a, b) => a.chunk.index - b.chunk.index) // 按原文顺序返回
  return top
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

/** 格式化检索结果给模型消费（带页码 + 片段编号）。 */
export function formatHits(hits: SearchHit[], totalChunks: number, query: string): string {
  if (hits.length === 0) {
    return `没有找到与 "${query}" 相关的片段，请换关键词（建议用英文术语或章节号）`
  }
  const parts = [`共 ${totalChunks} 个片段，以下按原文顺序返回最相关的 ${hits.length} 个：\n`]
  for (const h of hits) {
    const where = h.page != null ? `（第 ${h.page} 页）` : ''
    parts.push(`=== 片段 ${h.chunk.index}/${totalChunks}${where} ===\n${h.chunk.text}\n`)
  }
  return parts.join('\n')
}

/**
 * 折叠项 1 —— 查询侧 LaTeX 归一化。
 * 投影侧把 `.txt` 里单 token 的下标/上标去了花括号（`Q_{t}` → `Q_t`），代价是带花括号的查询
 * 命中为 0。这里把同一个规则作用在**查询**上：`Q_{t}` → `Q_t`，于是两种写法命中同一页。
 * 规则一致由代码保证（直接调投影侧同一个 normalizeMathBody）；无需归一化时返回 null：
 * 纯散文查询（没有 `_{...}`/`^{...}` 形态）与多 token 参数（`x_{ij}`、`x_{t-1}`）都原样返回。
 */
export function compactQuery(query: string): string | null {
  const compact = normalizeMathTokens(query)
  return compact === query ? null : compact
}

/**
 * 检索实际要用的查询写法：**原样永远保留**，有紧凑写法时追加一条。
 * 保留原样是关键——归一化只增加召回，不会让任何既有命中消失（对 pdfjs 来源的论文同理）。
 */
export function queryVariants(query: string): string[] {
  const compact = compactQuery(query)
  return compact === null ? [query] : [query, compact]
}

/**
 * 按论文来源决定查询写法：投影侧的紧凑写法只出现在 **MinerU** 产物里，
 * 所以查询侧的镜像变体也只在 MinerU 来源的论文上追加——pdfjs / 旧缓存论文保持
 * 「原查询原样」（不引入任何新行为，也不丢任何既有命中）。
 */
export function queryVariantsFor(producer: string | null | undefined, query: string): string[] {
  const mineru = producer === 'mineru-local' || producer === 'mineru-cloud'
  return mineru ? queryVariants(query) : [query]
}

/**
 * 多写法关键词检索：逐个写法跑一遍 searchChunks，按 chunk 合并（取最高分），再按原有语义取 top-k
 * 并按原文顺序返回。只有一个写法时**直接走 searchChunks**，与改造前逐字节一致。
 */
export function searchChunksMulti(chunks: Chunk[], pages: PageSpan[] | null, queries: string[], k = 5): SearchHit[] {
  const use = queries.filter((q) => q !== '')
  if (use.length <= 1) return searchChunks(chunks, pages, use[0] ?? '', k)
  const merged = new Map<number, SearchHit>()
  for (const q of use) {
    for (const hit of searchChunks(chunks, pages, q, k)) {
      const prev = merged.get(hit.chunk.index)
      if (prev === undefined || hit.score > prev.score) merged.set(hit.chunk.index, hit)
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, k))
    .sort((a, b) => a.chunk.index - b.chunk.index)
}
