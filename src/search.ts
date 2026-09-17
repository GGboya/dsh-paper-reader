// search.ts — 长文档分段检索（纯函数，不依赖 Cordis）。
// 移植 pdfqa 的 chunkText + searchPaper，新增：片段 → 页码映射（经 pages.json 偏移表）。

import type { PageSpan } from './transcribe.ts'

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
