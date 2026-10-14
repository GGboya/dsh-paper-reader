// scope.ts — 「按范围提问」的三段式上下文装配（纯函数，不依赖 Cordis）。
//
// 冻结方案：docs/darkmode-subtopic-plan.md §B3。用户原话是「提问时只给出该范围的目录内容」，
// 所以三段的定义是（全部由**服务端**按范围装配，客户端只传 scope，不传正文）：
//   ① **目录清单**（必给，≤ MAX_MANIFEST）：范围内每篇论文一行（路径 / 页数 / 产物 / 学习档案状态）。
//      —— 「只给该范围」就体现在这里：范围外一篇都不出现。
//   ② **正文**（按需）：kind='paper' 时给该篇正文（≤ MAX_PER_DOC，超限显式截断）；
//      kind='topic' 时**不做「全塞」**（实测真实库两篇论文正文合计 550 KiB，是上限的 14 倍），
//      改用问题在**范围内**做一次检索，每篇取 top-k 作为代表。
//   ③ **检索命中**：带 `<论文相对路径> 第 N 页` 的片段（页码走 pages.json 的 offset 映射）。
//
// 截断**必须显式**：每篇标注 full / truncated / omitted-no-room，并在末尾追加一行「已给 X 篇，
// 另有 Y 篇因上下文上限未展开」。

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listPapers, resolvePaper, type PaperRef } from './library.ts'
import { chunkText, pageForOffset, searchChunks, type Chunk, type SearchHit } from './search.ts'
import type { PageSpan } from './transcribe.ts'

/** 方案 §B3.2 冻结的五个上限（导出以便断言）。 */
export const MAX_CONTEXT_CHARS = 40_000
export const MAX_PER_DOC = 8_000
export const MAX_MANIFEST = 2_000
export const MAX_PAPERS_IN_SCOPE = 12
export const MAX_HITS_PER_PAPER = 3
/** 论文正文的来源优先级（MinerU 的版面重排质量最好） */
export const BODY_SOURCES = ['.mineru.md', '.txt'] as const

export type AskScope =
  | { kind: 'paper'; topic?: string; name?: string }
  | { kind: 'topic'; topic: string }

export type ScopeKind = AskScope['kind']

/** 一篇论文在本次上下文里的展开状态（截断必须显式，不许静默）。 */
export type Coverage = 'full' | 'truncated' | 'omitted-no-room' | 'no-body'

export interface ScopePaper {
  topic: string
  name: string
  /** `专题路径/篇名` —— 提示里出现的唯一标识 */
  path: string
  pages: number | null
  artifacts: string[]
  study: string
  coverage: Coverage
  /** 正文来源：mineru.md / txt / null */
  source: string | null
  chars: number
}

export interface ScopeContext {
  scope: AskScope
  scopePath: string
  /** 范围说明块（插在既有 `文献：…` 之后、`用户的问题：` 之前） */
  block: string
  papers: ScopePaper[]
  manifestChars: number
  bodyChars: number
  hitChars: number
  totalChars: number
  omitted: number
  truncated: number
}

function readText(file: string, limit: number): string | null {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size === 0) return null
    return readFileSync(file, 'utf8').slice(0, limit)
  } catch {
    return null
  }
}

function readPages(pagesPath: string): PageSpan[] | null {
  try {
    const raw = JSON.parse(readFileSync(pagesPath, 'utf8')) as { pages?: PageSpan[] }
    return Array.isArray(raw.pages) ? raw.pages : null
  } catch {
    return null
  }
}

function pageCountOf(pagesPath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(pagesPath, 'utf8')) as { pageCount?: number }
    return typeof raw.pageCount === 'number' ? raw.pageCount : null
  } catch {
    return null
  }
}

/** 该篇的正文来源：按优先级取第一个存在且非空的（并给名字，便于提示里说明来源）。 */
export function bodyFor(ref: PaperRef): { source: string; text: string } | null {
  const base = ref.pdfPath.slice(0, -4)
  for (const suffix of BODY_SOURCES) {
    const text = readText(base + suffix, Number.MAX_SAFE_INTEGER)
    if (text && text.length > 0) return { source: suffix, text }
  }
  return null
}

/** 逐篇的产物/学习档案摘要（只给元信息与路径，**不给正文**）。 */
function describePaper(ref: PaperRef): { artifacts: string[]; study: string } {
  const base = ref.pdfPath.slice(0, -4)
  const artifacts: string[] = []
  for (const s of ['.pdf', '.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json']) {
    try {
      const st = statSync(base + s)
      if (st.isFile()) artifacts.push(`${s}(${st.size}B)`)
    } catch { /* 不存在 */ }
  }
  const study = readStudyBrief(base + '.study.json')
  return { artifacts, study }
}

function readStudyBrief(file: string): string {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { plan?: Array<{ status?: string }>; quizzes?: unknown[] }
    if (!Array.isArray(raw.plan)) return '无'
    const done = raw.plan.filter((s) => s.status === 'done').length
    const quiz = Array.isArray(raw.quizzes) ? raw.quizzes.length : 0
    return `计划 ${done}/${raw.plan.length} 步完成，检验 ${quiz} 次`
  } catch {
    return '无'
  }
}

/** 把范围内的论文列出来（kind='paper' 只有一篇；不带 topic/name 时 = 当前这篇）。 */
export function scopePapers(dataDir: string, scope: AskScope, current: PaperRef): PaperRef[] {
  if (scope.kind === 'paper') {
    const args: { topic?: string; name?: string } = {}
    if (scope.topic !== undefined) args.topic = scope.topic
    if (scope.name !== undefined) args.name = scope.name
    // `{kind:'paper'}` 不带 topic/name = 「本篇」（默认范围的语义）；带则按给定的那篇
    if (args.topic === undefined && args.name === undefined) return [current]
    return [resolvePaper(dataDir, args)]
  }
  // 专题/子专题：**整棵子树**内的全部论文（listPapers 已递归；论文目录不递归）
  const list = listPapers(dataDir, scope.topic)
  const out: PaperRef[] = []
  for (const p of list) {
    try {
      out.push(resolvePaper(dataDir, { topic: p.topic, name: p.name }))
    } catch { /* 竞态：正被删/迁移，跳过 */ }
  }
  return out
}

/**
 * 装配三段式上下文。纯读，无副作用。
 * `question` 用于 kind='topic' 时的范围内检索（每篇 top-k）。
 */
export function buildScopeContext(dataDir: string, current: PaperRef, scope: AskScope, question: string): ScopeContext {
  const refs = scopePapers(dataDir, scope, current)
  const scopePath = scope.kind === 'paper' ? `${refs[0]?.topic ?? current.topic}/${refs[0]?.name ?? current.name}` : scope.topic
  const papers: ScopePaper[] = []
  let omitted = 0
  let truncated = 0

  // ── ① 目录清单（必给，≤ MAX_MANIFEST）──
  const manifestLines: string[] = [`本次提问范围：${scopePath}（${scope.kind === 'paper' ? '单篇论文' : '该专题及其全部子专题'}）`]
  for (const [i, ref] of refs.entries()) {
    const { artifacts, study } = describePaper(ref)
    const pages = pageCountOf(ref.pagesPath)
    const label = `${ref.topic}/${ref.name}`
    if (i >= MAX_PAPERS_IN_SCOPE) {
      omitted++
      papers.push({ topic: ref.topic, name: ref.name, path: label, pages, artifacts, study, coverage: 'omitted-no-room', source: null, chars: 0 })
      continue
    }
    // 范围内的**每一篇**都进 papers[]（含清单里也是全量）：coverage 先给占位，
    // 正文阶段再按「给了正文 / 被截断 / 没正文 / 没位置」更新 —— 否则统计与断言只覆盖被省略的那几篇。
    papers.push({ topic: ref.topic, name: ref.name, path: label, pages, artifacts, study, coverage: 'no-body', source: null, chars: 0 })
    manifestLines.push(`- ${label}｜${pages != null ? `${pages} 页` : '页数未知'}｜${artifacts.join(' ')}｜学习档案：${study}`)
  }
  // 清单超上限时按行截断（仍显式说明）
  let manifest = manifestLines.join('\n')
  if (manifest.length > MAX_MANIFEST) {
    manifest = manifest.slice(0, MAX_MANIFEST) + '\n…（清单已截断至上限）'
    truncated++
  }

  // ── ② 正文 + ③ 检索命中 ──
  const bodyParts: string[] = []
  const hitParts: string[] = []
  let used = manifest.length
  const budget = (): number => MAX_CONTEXT_CHARS - used

  const pushWithLabel = (ref: PaperRef, label: string, text: string, coverage: Coverage, source: string | null, hits: SearchHit[] | null) => {
    const header = `\n=== ${label}${source ? `（正文来源 ${source}）` : ''} ===\n`
    const body = header + text
    const rec = papers.find((p) => p.path === label)
    if (rec) { rec.coverage = coverage; rec.source = source; rec.chars = text.length }
    bodyParts.push(body)
    used += body.length
    if (hits && hits.length > 0) {
      for (const h of hits) {
        const where = h.page != null ? ` 第 ${h.page} 页` : ''
        const frag = `\n--- ${label}${where} ---\n${h.chunk.text.slice(0, 1200)}`
        hitParts.push(frag)
        used += frag.length
      }
    }
  }

  if (scope.kind === 'paper') {
    const ref = refs[0]
    if (ref) {
      const body = bodyFor(ref)
      const label = `${ref.topic}/${ref.name}`
      const rec = papers.find((p) => p.path === label)
      if (!body) {
        if (rec) rec.coverage = 'no-body'
      } else if (body.text.length <= MAX_PER_DOC && body.text.length < budget()) {
        const head = `\n=== ${label}（正文来源 ${body.source}） ===\n`
        bodyParts.push(head + body.text)
        used += head.length + body.text.length
        if (rec) { rec.coverage = 'full'; rec.source = body.source; rec.chars = body.text.length }
      } else {
        const limit = Math.max(0, Math.min(MAX_PER_DOC, budget() - 200))
        const slice = body.text.slice(0, limit)
        const head = `\n=== ${label}（正文来源 ${body.source}；全文 ${body.text.length} 字，已截断至 ${slice.length} 字） ===\n`
        bodyParts.push(head + slice)
        used += head.length + slice.length
        if (rec) { rec.coverage = 'truncated'; rec.source = body.source; rec.chars = slice.length }
        truncated++
      }
    }
  } else {
    // 专题/子树：正文**不做全塞**，每篇用问题做一次范围内检索取 top-k
    const inScope: PaperRef[] = []
    for (const p of papers) {
      if (p.coverage === 'omitted-no-room') continue
      const ref = refs.find((r) => `${r.topic}/${r.name}` === p.path)
      if (ref) inScope.push(ref)
    }
    for (const ref of inScope) {
      const label = `${ref.topic}/${ref.name}`
      const body = bodyFor(ref)
      const rec = papers.find((p) => p.path === label)!
      if (!body) { rec.coverage = 'no-body'; continue }
      if (budget() < 400) { rec.coverage = 'omitted-no-room'; omitted++; continue }
      const chunks: Chunk[] = chunkText(body.text)
      const pages = readPages(ref.pagesPath)
      const hits = searchChunks(chunks, pages, question, MAX_HITS_PER_PAPER)
      if (hits.length === 0) {
        // 检索无命中：给开头一段作代表（显式标注），否则模型对这篇一无所知
        const limit = Math.max(0, Math.min(MAX_PER_DOC, budget() - 300))
        const slice = body.text.slice(0, limit)
        pushWithLabel(ref, label, `（本问题在该文中无关键词命中，以下是开头片段）\n${slice}`, 'truncated', body.source, null)
        truncated++
        continue
      }
      const text = hits.map((h) => `（第 ${h.page ?? '?'} 页）\n${h.chunk.text}`).join('\n\n')
      const limit = Math.max(0, Math.min(MAX_PER_DOC, budget() - 300))
      const slice = text.slice(0, limit)
      const cov: Coverage = slice.length < text.length ? 'truncated' : 'full'
      pushWithLabel(ref, label, slice, cov, body.source, null)
      // 第 3 段：命中片段（带页码）
      for (const h of hits) {
        const where = h.page != null ? ` 第 ${h.page} 页` : ''
        hitParts.push(`\n--- ${label}${where} ---\n${h.chunk.text.slice(0, 1200)}`)
      }
      if (cov === 'truncated') truncated++
    }
  }

  const body = bodyParts.join('\n')
  const hits = hitParts.join('\n')
  const totalChars = manifest.length + body.length + hits.length
  const tail: string[] = []
  if (omitted > 0) {
    tail.push(`（清单：本次已给 ${papers.length - omitted} 篇，另有 ${omitted} 篇因上下文上限未展开，可缩小范围或指定论文）`)
  }
  if (scope.kind === 'topic') {
    tail.push(`本次提问的范围是 \`${scopePath}\`（含子专题）；如需范围外的论文请显式说明。范围外内容未提供。`)
  }
  tail.push(`（当前阅读的是 \`${current.topic}/${current.name}\`；本次提问范围是 \`${scopePath}\`。）`)

  const block = [
    `【提问范围】${scopePath}`,
    '【范围内目录清单】',
    manifest,
    omitted > 0 ? `（清单：本次已给 ${papers.length - omitted} 篇，另有 ${omitted} 篇因上下文上限未展开，可缩小范围或指定论文）` : '',
    body ? '【范围内正文】' : '',
    body,
    hits ? '【范围内检索命中（带页码）】' : '',
    hits,
    tail.join('\n'),
  ].filter((x) => x !== '').join('\n')

  return {
    scope,
    scopePath,
    block,
    papers,
    manifestChars: manifest.length,
    bodyChars: body.length,
    hitChars: hits.length,
    totalChars,
    omitted,
    truncated,
  }
}
