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
import { listPapers, paperRefFor, resolvePaper, type PaperRef } from './library.ts'
import { ManageError, resolveTopicDir, validateTopicPath } from './library-manage.ts'
import { chunkText, searchChunks, type Chunk } from './search.ts'
import type { PageSpan } from './transcribe.ts'

/** 方案 §B3.2 冻结的五个上限（导出以便断言）。 */
export const MAX_CONTEXT_CHARS = 40_000
export const MAX_PER_DOC = 8_000
export const MAX_MANIFEST = 2_000
export const MAX_PAPERS_IN_SCOPE = 12
export const MAX_HITS_PER_PAPER = 3
/** 正文/命中装配时给「段标题 + 末尾说明行」预留的余量：保证 `block.length` 也不越 MAX_CONTEXT_CHARS。 */
const BLOCK_RESERVE = 400
/** 论文正文的来源优先级（MinerU 的版面重排质量最好） */
export const BODY_SOURCES = ['.mineru.md', '.txt'] as const

/**
 * 按**码点**截断（PR #8 维护者点名要跟 issue #9 同类修复；上游 main 的 `cutToCodePoint` 在本分支
 * 不存在，故此处自建同语义实现，合入 main 时再对账）。
 *
 * 为什么必须：`String.prototype.slice` 按 UTF-16 码元切。切点若落在**代理对中间**（如 U+1D400
 * 数学粗体字母，占 2 个码元），结果里就留一个孤立代理项。这个字符串一旦进会话历史，
 * JSON 序列化后带 `\ud800`，服务端 `JSON.parse` 不接受孤立代理项 ⇒ **整条会话 400**。
 * 语义：切点若正好落在代理对中间，就少切 1 个码元（不越界、不补字）。
 */
export function cutToCodePoint(text: string, limit: number): string {
  if (typeof text !== 'string') return ''
  if (!Number.isFinite(limit) || limit >= text.length) return text
  const n = Math.max(0, Math.floor(limit))
  if (n >= text.length) return text
  if (n === 0) return ''
  const last = text.charCodeAt(n - 1)
  const midPair = last >= 0xd800 && last <= 0xdbff
  return text.slice(0, midPair ? n - 1 : n)
}

export type AskScope =
  | { kind: 'paper'; topic?: string; name?: string }
  | { kind: 'topic'; topic: string }

export type ScopeKind = AskScope['kind']

/** 一篇论文在本次上下文里的展开状态（截断必须显式，不许静默）。 */
export type Coverage = 'full' | 'truncated' | 'omitted-no-room' | 'no-body' | 'omitted-duplicate'

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
  /** 逐篇的「为什么没展开」：与 omitted 对应，绝不静默丢（如同名论文在多处）。 */
  omittedNotes: string[]
  /** 台账：`papers[]` 里 coverage='full' 的篇数（与逐篇明细**同源**，见代码里的 setCov）。 */
  full: number
  /** 台账：`papers[]` 里 coverage='truncated' 的篇数。**只算论文正文/片段**，
   *  清单被 MAX_MANIFEST 截断不算在这里（那是 `manifestTruncated`）——否则「统计与明细打架」。 */
  truncated: number
  /** 目录清单本身是否被 MAX_MANIFEST 截断（提示块里仍有显式文案）。 */
  manifestTruncated: boolean
}

function readText(file: string, limit: number): string | null {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size === 0) return null
    return cutToCodePoint(readFileSync(file, 'utf8'), limit)
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

/** 无法唯一定位、因而没有进正文的论文（**必须**在结果里如实标注，不许静默丢）。 */
export interface ScopeSkip {
  topic: string
  name: string
  path: string
  reason: string
}

export interface ScopeResolution {
  refs: PaperRef[]
  skipped: ScopeSkip[]
  /** kind='topic' 时规范化后的专题路径（已校验存在）；kind='paper' 为 null。 */
  topic: string | null
}

/**
 * 把范围内的论文解析成 PaperRef 列表（kind='paper' 只有一篇；不带 topic/name 时 = 当前这篇）。
 *
 * PR #8 评审 G（如实提示）在这里落三件事：
 *  ① `kind='topic'` 先**校验专题存在**（404 ManageError：`host.ts` 的 isManageError 分支会给出
 *     明确 404），不再装配出「空的但看起来正常」的范围 + 200 假成功；
 *  ② `listPapers` 已递归整棵子树、给出**精确的** (topic, name)，据此用 `paperRefFor` 直接构造引用
 *     ——不再逐篇 `resolvePaper`（那会按**名字**重扫子树：既有 N+1 开销，同名论文还会被解析成
 *     「命中多篇」而**静默消失**）；
 *  ③ 同名论文出现在不同深度时无法按名字唯一确定 ⇒ 进 `skipped`（带路径与原因），由调用方
 *     计入 omitted 并在提示里点名，绝不静默丢。
 */
export function resolveScopePapers(dataDir: string, scope: AskScope, current: PaperRef): ScopeResolution {
  if (scope.kind === 'paper') {
    const args: { topic?: string; name?: string } = {}
    if (scope.topic !== undefined) args.topic = scope.topic
    if (scope.name !== undefined) args.name = scope.name
    // `{kind:'paper'}` 不带 topic/name = 「本篇」（默认范围的语义）；带则按给定的那篇
    if (args.topic === undefined && args.name === undefined) return { refs: [current], skipped: [], topic: null }
    return { refs: [resolvePaper(dataDir, args)], skipped: [], topic: null }
  }
  // 专题/子专题：**整棵子树**内的全部论文（listPapers 已递归；论文目录不递归）。
  // 先过存在性/边界校验：已改名/删除的专题必须 404，不能假装「范围是空的」。
  const topicPath = validateTopicPath(scope.topic, false)
  resolveTopicDir(dataDir, topicPath) // 不存在的专题 ⇒ ManageError('not-found', 404)
  const list = listPapers(dataDir, topicPath)
  const pathsByName = new Map<string, string[]>()
  for (const p of list) {
    const paths = pathsByName.get(p.name) ?? []
    paths.push(`${p.topic}/${p.name}`)
    pathsByName.set(p.name, paths)
  }
  const refs: PaperRef[] = []
  const skipped: ScopeSkip[] = []
  for (const p of list) {
    const path = `${p.topic}/${p.name}`
    const sameName = pathsByName.get(p.name) ?? [path]
    if (sameName.length > 1) {
      skipped.push({
        topic: p.topic,
        name: p.name,
        path,
        reason: `同名论文在多处（${sameName.join('、')}），无法唯一定位，已跳过（可改用单篇范围指定）`,
      })
      continue
    }
    refs.push(paperRefFor(dataDir, p.topic, p.name))
  }
  return { refs, skipped, topic: topicPath }
}

/** 兼容旧入口：只取可唯一定位的论文（省略项见 `resolveScopePapers().skipped`）。 */
export function scopePapers(dataDir: string, scope: AskScope, current: PaperRef): PaperRef[] {
  return resolveScopePapers(dataDir, scope, current).refs
}

/**
 * 装配三段式上下文。纯读，无副作用。
 * `question` 用于 kind='topic' 时的范围内检索（每篇 top-k）。
 */
export function buildScopeContext(dataDir: string, current: PaperRef, scope: AskScope, question: string): ScopeContext {
  const resolved = resolveScopePapers(dataDir, scope, current)
  const refs = resolved.refs
  const scopePath = scope.kind === 'paper'
    ? `${refs[0]?.topic ?? current.topic}/${refs[0]?.name ?? current.name}`
    : (resolved.topic ?? scope.topic)
  const papers: ScopePaper[] = []
  const omittedNotes: string[] = []
  let omitted = 0
  let noRoom = 0
  let full = 0
  let truncated = 0
  let manifestTruncated = false

  // ── ① 目录清单（必给，≤ MAX_MANIFEST）──
  const manifestLines: string[] = [`本次提问范围：${scopePath}（${scope.kind === 'paper' ? '单篇论文' : '该专题及其全部子专题'}）`]
  for (const [i, ref] of refs.entries()) {
    const { artifacts, study } = describePaper(ref)
    const pages = pageCountOf(ref.pagesPath)
    const label = `${ref.topic}/${ref.name}`
    if (i >= MAX_PAPERS_IN_SCOPE) {
      omitted++
      noRoom++
      papers.push({ topic: ref.topic, name: ref.name, path: label, pages, artifacts, study, coverage: 'omitted-no-room', source: null, chars: 0 })
      continue
    }
    // 范围内的**每一篇**都进 papers[]（含清单里也是全量）：coverage 先给占位，
    // 正文阶段再按「给了正文 / 被截断 / 没正文 / 没位置」更新 —— 否则统计与断言只覆盖被省略的那几篇。
    papers.push({ topic: ref.topic, name: ref.name, path: label, pages, artifacts, study, coverage: 'no-body', source: null, chars: 0 })
    manifestLines.push(`- ${label}｜${pages != null ? `${pages} 页` : '页数未知'}｜${artifacts.join(' ')}｜学习档案：${study}`)
  }
  // 同名论文在多处：按名字无法唯一定位 ⇒ **显式**进清单与 omitted（带原因），绝不静默丢
  for (const s of resolved.skipped) {
    omitted++
    omittedNotes.push(`${s.path}：${s.reason}`)
    papers.push({ topic: s.topic, name: s.name, path: s.path, pages: null, artifacts: [], study: '未展开', coverage: 'omitted-duplicate', source: null, chars: 0 })
    manifestLines.push(`- ${s.path}｜未展开：${s.reason}`)
  }
  // 清单超上限时按行截断（仍显式说明）。**不计入 truncated**：`truncated` 只统计
  // `papers[].coverage==='truncated'`（评审 G 次级：台账必须与逐篇明细逐条对得上）。
  let manifest = manifestLines.join('\n')
  if (manifest.length > MAX_MANIFEST) {
    manifest = cutToCodePoint(manifest, MAX_MANIFEST) + '\n…（清单已截断至上限）'
    manifestTruncated = true
  }

  // ── ② 正文 + ③ 检索命中 ──
  // 预算口径（PR #8 评审 G）：**实际追加多少就计多少**。`used` 从清单长度起算，正文/命中片段
  // 逐条累加；`BLOCK_RESERVE` 给段标题与末尾说明行留余量 ⇒ `totalChars` 与 `block.length` 都
  // 不会越过 MAX_CONTEXT_CHARS。命中片段只在第 ③ 段出现一次（不再与正文重复同一段文本）。
  const bodyParts: string[] = []
  const hitParts: string[] = []
  let used = manifest.length
  const budget = (): number => Math.max(0, MAX_CONTEXT_CHARS - used - BLOCK_RESERVE)
  const recOf = (label: string): ScopePaper | undefined => papers.find((p) => p.path === label)
  /**
   * 逐篇 coverage 与**台账**的唯一写入口（评审 G 次级：`papers[].coverage` 与
   * `truncated`/`full`/`omitted` 必须同源，否则统计与明细会打架）。
   * `chars` 定义：该篇**内容**（正文/命中片段文本，不含段标题与说明句）实际进入 block 的字数。
   */
  const setCov = (rec: ScopePaper | undefined, cov: Coverage, source: string | null, chars: number): void => {
    if (!rec) return
    rec.coverage = cov
    rec.source = source
    rec.chars = chars
    if (cov === 'full') full++
    else if (cov === 'truncated') truncated++
  }

  if (scope.kind === 'paper') {
    const ref = refs[0]
    if (ref) {
      const body = bodyFor(ref)
      const label = `${ref.topic}/${ref.name}`
      const rec = recOf(label)
      if (!body) {
        setCov(rec, 'no-body', null, 0)
      } else if (body.text.length <= MAX_PER_DOC && body.text.length < budget()) {
        const head = `\n=== ${label}（正文来源 ${body.source}） ===\n`
        bodyParts.push(head + body.text)
        used += head.length + body.text.length
        setCov(rec, 'full', body.source, body.text.length)
      } else {
        const limit = Math.max(0, Math.min(MAX_PER_DOC, budget() - 200))
        const slice = cutToCodePoint(body.text, limit)
        const head = `\n=== ${label}（正文来源 ${body.source}；全文 ${body.text.length} 字，已截断至 ${slice.length} 字） ===\n`
        if (head.length + slice.length > budget()) {
          // 连段标题都放不下：如实标 omitted（不硬塞超预算内容）
          setCov(rec, 'omitted-no-room', null, 0)
          omitted++
          noRoom++
        } else {
          bodyParts.push(head + slice)
          used += head.length + slice.length
          setCov(rec, 'truncated', body.source, slice.length)
        }
      }
    }
  } else {
    // 专题/子树：正文**不做全塞**，每篇用问题做一次范围内检索取 top-k（命中片段即第 ③ 段）。
    for (const ref of refs) {
      const label = `${ref.topic}/${ref.name}`
      const rec = recOf(label)
      if (!rec || rec.coverage === 'omitted-no-room') continue
      if (budget() < 400) { setCov(rec, 'omitted-no-room', null, 0); omitted++; noRoom++; continue }
      const body = bodyFor(ref)
      if (!body) { setCov(rec, 'no-body', null, 0); continue }
      const chunks: Chunk[] = chunkText(body.text)
      const pages = readPages(ref.pagesPath)
      const hits = searchChunks(chunks, pages, question, MAX_HITS_PER_PAPER)
      if (hits.length === 0) {
        // 检索无命中：给开头一段作代表（显式标注），否则模型对这篇一无所知。
        // 评审 G 次级（基线 scope.ts:253）：这里曾**无条件**标 'truncated' + truncated++，
        // 短正文其实整篇都给完了却报「已截断」——现在按「是否真的切掉了正文」判定。
        const limit = Math.max(0, Math.min(MAX_PER_DOC, budget() - 300))
        const slice = cutToCodePoint(body.text, limit)
        const wholeBody = slice.length >= body.text.length
        if ((!wholeBody && limit < 200) || slice.length === 0) {
          setCov(rec, 'omitted-no-room', null, 0)
          omitted++
          noRoom++
          continue
        }
        // 文案也必须诚实：整篇给完就别再说「开头片段」
        const text = `（本问题在该文中无关键词命中，以下是${wholeBody ? '全文' : '开头片段'}）\n${slice}`
        const header = `\n=== ${label}（正文来源 ${body.source}） ===\n`
        bodyParts.push(header + text)
        used += header.length + text.length
        setCov(rec, wholeBody ? 'full' : 'truncated', body.source, slice.length)
        continue
      }
      // 命中片段（带页码）：每篇 top-k，逐条按「全局预算 + 每篇 MAX_PER_DOC」追加并计费。
      // `chars` 只算片段正文（不含 `--- 路径 第 N 页 ---` 标题），与「块内实际字数」对齐。
      let docUsed = 0
      let docChars = 0
      let allHits = true
      for (const h of hits) {
        const where = h.page != null ? ` 第 ${h.page} 页` : ''
        const header = `\n--- ${label}${where} ---\n`
        const room = Math.min(MAX_PER_DOC - docUsed, budget() - header.length - 40)
        if (room < 200) { allHits = false; break }
        const slice = cutToCodePoint(h.chunk.text, Math.min(1200, room))
        if (slice.length < h.chunk.text.length) allHits = false
        const frag = header + slice
        hitParts.push(frag)
        used += frag.length
        docUsed += frag.length
        docChars += slice.length
      }
      if (docUsed === 0) { setCov(rec, 'omitted-no-room', null, 0); omitted++; noRoom++; continue }
      setCov(rec, allHits ? 'full' : 'truncated', body.source, docChars)
    }
  }

  const body = bodyParts.join('\n')
  const hits = hitParts.join('\n')
  const totalChars = manifest.length + body.length + hits.length
  // omitted 提示句**只出现一次**（曾在 tail 与 block 里各输出一遍）
  const omittedLines: string[] = []
  if (omitted > 0) {
    const shown = papers.length - omitted
    if (noRoom > 0) omittedLines.push(`（清单：本次已给 ${shown} 篇，另有 ${noRoom} 篇因上下文上限未展开，可缩小范围或指定论文）`)
    const dup = resolved.skipped.length
    if (dup > 0) omittedLines.push(`（另有 ${dup} 篇同名论文在多处出现、无法唯一定位，已跳过：${resolved.skipped.map((s) => s.path).join('、')}）`)
  }
  const tail: string[] = []
  if (scope.kind === 'topic') {
    tail.push(`本次提问的范围是 \`${scopePath}\`（含子专题）；如需范围外的论文请显式说明。范围外内容未提供。`)
  }
  tail.push(`（当前阅读的是 \`${current.topic}/${current.name}\`；本次提问范围是 \`${scopePath}\`。）`)

  const block = [
    `【提问范围】${scopePath}`,
    '【范围内目录清单】',
    manifest,
    omittedLines.join('\n'),
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
    omittedNotes,
    full,
    truncated,
    manifestTruncated,
  }
}
