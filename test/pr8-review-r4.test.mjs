// test/pr8-review-r4.test.mjs — REV4（t10）对 t9「coverage 误报 truncated + 台账自洽性」的**独立对抗探针**。
//
// 独立性声明（评审协议要求）：
//   · 本文件**不 import** t9 的 `test/pr8-coverage-honesty.test.mjs`，也不复用它的夹具/期望值；
//     夹具、问题词、断言口径全部由本次评审重新构造（连正文长度、标记词都不同）。
//   · 只 import `dist/*.js`（跑前 `npm run build`）；所有库都用 `mkdtemp` 造，\`DSH_HOME\` 指向临时目录，
//     绝不碰真实文献库 / 真实 ~/.dsh。
//   · 同一份探针可在 **fdb45f2 基线** 上复跑：`R4_REPO=/abs/path/to/.worktrees/pr8-baseline node --test test/pr8-review-r4.test.mjs`
//     ⇒ 基线应红（且红在**行为**断言上：coverage/chars），修复后应绿。这样「基线误报」不是引用 t9 的自述，
//     而是本探针自己在两个树上跑出来的对照。
//
// 维护者原话（docs/pr8-maintainer-review.md「G. 次级」）：
//   「短正文全覆盖时 `coverage` 误报 `truncated`（`src/scope.ts:253`）」
// 本探针要独立回答的四个问题：
//   ① 短正文被**完整**纳入 ⇒ coverage 必须 `full`，`truncated` 计数不增，`chars` = 正文实际字数；
//   ② 预算/单篇上限造成的**真截断** ⇒ `truncated`，`chars` 与块内该篇内容逐字一致，且被切掉的尾部确实没进块；
//   ③ 无命中而给开头片段 ⇒ `truncated` **且**提示里有显式标注（「开头片段」）；
//   ④ 台账（`full`/`truncated`/`omitted`）与 `papers[].coverage` **逐条对账**，且 `chars` 与块内实际内容对账；
//      含清单截断（`MAX_MANIFEST`）不得污染论文 `truncated` 台账、omitted 提示句只出现一次。
//
// 判读：本文件「绿」= t9 的修复在本评审自己构造的场景下成立；「红」的消息里带实际值，便于定位。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 默认测当前工作树；`R4_REPO` 指向基线工作树时，用同一探针跑基线对照。 */
const TARGET = process.env.R4_REPO ? resolve(process.env.R4_REPO) : join(HERE, '..')
const BASELINE_MODE = Boolean(process.env.R4_REPO)

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-r4-home-'))

const L = await import(pathToFileURL(join(TARGET, 'dist/library.js')).href)
const SC = await import(pathToFileURL(join(TARGET, 'dist/scope.js')).href)
const SRCH = await import(pathToFileURL(join(TARGET, 'dist/search.js')).href)

// ─────────────────────────────────────────────────────────────────────────────
// 夹具（全部临时目录）
// ─────────────────────────────────────────────────────────────────────────────

function newLib(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局落一篇论文：`<data>/<topic>/<name>/<name>.pdf`，`body != null` 时另写同名 `.txt`。 */
function putPaper(data, topic, name, body = null, artifacts = []) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), `%PDF-1.4 fake ${topic}/${name}`)
  if (body != null) writeFileSync(join(dir, `${name}.txt`), body)
  for (const s of artifacts) writeFileSync(join(dir, `${name}${s}`), 'x')
  return dir
}

function build(data, cur, scope, question) {
  return SC.buildScopeContext(data, cur, scope, question)
}

const countOccurrences = (hay, needle) => hay.split(needle).length - 1

// ─────────────────────────────────────────────────────────────────────────────
// 台账对账：coverage 明细 ↔ 计数 ↔ chars ↔ 预算（独立于实现方的 assertLedger）
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_COVERAGE = new Set(['full', 'truncated', 'no-body', 'omitted-no-room', 'omitted-duplicate'])
const OMITTED_PREFIX = 'omitted-'

function assertLedger(ctx, label, expectedPaperCount) {
  assert.equal(ctx.papers.length, expectedPaperCount,
    `${label}: papers[] 必须把范围内每一篇都列出来（含未展开的）：实际 ${ctx.papers.length}，期望 ${expectedPaperCount}`)
  const cnt = (pred) => ctx.papers.filter(pred).length
  const nFull = cnt((p) => p.coverage === 'full')
  const nTrunc = cnt((p) => p.coverage === 'truncated')
  const nNoBody = cnt((p) => p.coverage === 'no-body')
  const nOmitted = cnt((p) => typeof p.coverage === 'string' && p.coverage.startsWith(OMITTED_PREFIX))

  assert.equal(ctx.full, nFull, `${label}: full 台账(${ctx.full}) ≠ coverage='full' 篇数(${nFull})`)
  assert.equal(ctx.truncated, nTrunc, `${label}: truncated 台账(${ctx.truncated}) ≠ coverage='truncated' 篇数(${nTrunc})`)
  assert.equal(ctx.omitted, nOmitted, `${label}: omitted 台账(${ctx.omitted}) ≠ coverage='omitted-*' 篇数(${nOmitted})`)
  assert.equal(nFull + nTrunc + nNoBody + nOmitted, ctx.papers.length,
    `${label}: 四类终态必须覆盖 papers[] 的每一篇（${nFull}+${nTrunc}+${nNoBody}+${nOmitted} ≠ ${ctx.papers.length}）`)

  for (const p of ctx.papers) {
    assert.ok(KNOWN_COVERAGE.has(p.coverage), `${label}: ${p.path} 的 coverage 非法：${p.coverage}`)
    if (p.coverage === 'full' || p.coverage === 'truncated') {
      assert.ok(p.chars > 0, `${label}: ${p.path} 已给内容（${p.coverage}）但 chars=${p.chars}（必须 > 0）`)
      assert.ok(p.chars <= SC.MAX_PER_DOC, `${label}: ${p.path} 单篇 chars=${p.chars} 超 MAX_PER_DOC=${SC.MAX_PER_DOC}`)
    } else {
      assert.equal(p.chars, 0, `${label}: ${p.path} 未展开（${p.coverage}）但 chars=${p.chars}（必须为 0）`)
    }
  }

  assert.equal(ctx.totalChars, ctx.manifestChars + ctx.bodyChars + ctx.hitChars,
    `${label}: totalChars 必须等于三段之和`)
  assert.ok(ctx.totalChars <= SC.MAX_CONTEXT_CHARS,
    `${label}: totalChars=${ctx.totalChars} 超上限 ${SC.MAX_CONTEXT_CHARS}`)
  assert.ok(ctx.block.length <= SC.MAX_CONTEXT_CHARS + 800,
    `${label}: block=${ctx.block.length} 明显越过上限 ${SC.MAX_CONTEXT_CHARS}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 块内内容抽取：把 block 里「某一篇」真正给出去的正文/片段原文取回来
//   · 正文段头：`\n=== <path>（正文来源 <src>[；全文 N 字，已截断至 M 字]） ===\n`
//   · 命中段头：`\n--- <path>[ 第 N 页] ---\n`
//   —— 与 t9 的断言方式无关：这里按**块里实际出现的字**反推该篇字数。
// ─────────────────────────────────────────────────────────────────────────────

const NEXT_SECTION_MARKERS = [
  '\n\n=== ',                                    // 下一段正文（bodyParts 以 '\n' join，段头自带 '\n'）
  '\n\n--- ',                                    // 下一条命中片段（同上）
  '\n【范围内检索命中（带页码）】',              // 正文段 → 命中段
  '\n本次提问的范围是',                          // 专题范围尾句
  '\n（当前阅读的是',                            // 单篇范围尾句
]

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const NOTE_RE = /^（本问题在该文中无关键词命中，以下是[^）]*）\n/

/** 返回 { kind: 'body'|'hit', content } 或 null（该篇在块里没有段落）。 */
function sectionOf(block, path) {
  const bodyRe = new RegExp(`\\n=== ${escapeRe(path)}（正文来源 [^）]+） ===\\n`)
  const hitRe = new RegExp(`\\n--- ${escapeRe(path)}(?: 第 \\d+ 页)? ---\\n`)
  let m = bodyRe.exec(block)
  let kind = 'body'
  if (!m) { m = hitRe.exec(block); kind = 'hit' }
  if (!m) return null
  const start = m.index + m[0].length
  let end = block.length
  for (const mk of NEXT_SECTION_MARKERS) {
    const j = block.indexOf(mk, start)
    if (j >= 0 && j < end) end = j
  }
  let content = block.slice(start, end)
  if (kind === 'body') content = content.replace(NOTE_RE, '') // 说明句不是「该篇的内容」
  return { kind, content }
}

/** 逐篇对账：给了内容的篇，块内该篇内容长度 === papers[].chars；没给的篇，块里不得出现它的段落。 */
function assertPerPaperBlock(ctx, label) {
  for (const p of ctx.papers) {
    const sec = sectionOf(ctx.block, p.path)
    if (p.coverage === 'full' || p.coverage === 'truncated') {
      assert.ok(sec, `${label}: ${p.path} 标 ${p.coverage}、chars=${p.chars}，但块里找不到该篇的正文/片段段落`)
      assert.equal(sec.content.length, p.chars,
        `${label}: ${p.path} chars=${p.chars} 与块内该篇实际内容长度 ${sec.content.length} 不符`)
    } else {
      assert.equal(sec, null, `${label}: ${p.path} 标 ${p.coverage}（未展开），块里却出现了它的段落（长度 ${sec?.content.length}）`)
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// R4-1 【维护者点名的误报形态】专题范围 + 检索无命中 + 短正文（整篇都给完了）
//        ⇒ coverage=full、truncated 不增、chars=正文长度、文案说「全文」而不是「开头片段」
// ═════════════════════════════════════════════════════════════════════════════

test('R4-1 短正文无命中但整篇纳入 ⇒ full、truncated=0、chars=正文长度、文案「全文」', (t) => {
  const { root, data } = newLib('dpr-r4-short-')
  try {
    const body = 'SHORT-R4-BODY ' + 'x'.repeat(204) // 218 字，远小于 MAX_PER_DOC
    putPaper(data, 'Short', 'P', body)
    const cur = L.resolvePaper(data, { topic: 'Short', name: 'P' })
    const ctx = build(data, cur, { kind: 'topic', topic: 'Short' }, 'zzz-no-such-token-r4')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} truncated=${ctx.truncated} body=${body.length}`)

    // 前提：整篇正文确实进了 block（否则本用例空转）
    assert.equal(ctx.block.includes(body), true, '前提不成立：整篇正文没有全部进 block，本用例无意义')
    // ← 基线在此处红：coverage='truncated'、truncated=1、chars=235（把「以下是开头片段」说明句也算进去）
    assert.equal(p.coverage, 'full', `整篇正文都给完了，必须标 full（维护者指的误报）：实际 ${p.coverage}`)
    assert.equal(ctx.truncated, 0, `没有发生截断，truncated 必须为 0：实际 ${ctx.truncated}`)
    assert.equal(p.chars, body.length, `chars 必须只是正文实际字数 ${body.length}：实际 ${p.chars}`)
    assert.match(ctx.block, /以下是全文/, '整篇给完时提示文案必须说「全文」')
    assert.doesNotMatch(ctx.block, /以下是开头片段/, '整篇给完时不得再说「开头片段」')
    assert.equal(countOccurrences(ctx.block, '无关键词命中'), 1, '无命中说明句在该篇只应出现一次')

    assertLedger(ctx, 'R4-1', 1)
    assertPerPaperBlock(ctx, 'R4-1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// R4-2 【反证】同一分支里真的截断了 ⇒ truncated、chars=实际纳入字数、被切掉的尾部不得进块
// ═════════════════════════════════════════════════════════════════════════════

test('R4-2 无命中且正文超单篇上限 ⇒ 真截断：truncated、chars=8000、块内无尾部标记', (t) => {
  const { root, data } = newLib('dpr-r4-long-')
  try {
    const tailMark = 'TAIL-R4-2-MUST-NOT-APPEAR'
    const body = 'A'.repeat(SC.MAX_PER_DOC) + tailMark + 'B'.repeat(1_991) // 10000+ 字
    putPaper(data, 'Long', 'Q', body)
    const cur = L.resolvePaper(data, { topic: 'Long', name: 'Q' })
    const ctx = build(data, cur, { kind: 'topic', topic: 'Long' }, 'zzz-no-such-token-r4')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} truncated=${ctx.truncated} body=${body.length}`)

    assert.equal(p.coverage, 'truncated', `正文确实被切掉了，必须标 truncated：实际 ${p.coverage}`)
    assert.equal(ctx.truncated, 1, `truncated 台账必须为 1：实际 ${ctx.truncated}`)
    assert.equal(p.chars, SC.MAX_PER_DOC, `chars 必须是实际纳入的 ${SC.MAX_PER_DOC} 字：实际 ${p.chars}`)
    assert.equal(ctx.block.includes('A'.repeat(SC.MAX_PER_DOC)), true, '纳入的前 8000 字必须在块里')
    assert.equal(ctx.block.includes(tailMark), false, '被切掉的尾部（含标记词）不得进块 —— 否则 chars 与块内不一致')
    assert.match(ctx.block, /以下是开头片段/, '真截断时必须显式说「开头片段」')
    assert.match(ctx.block, /无关键词命中/, '无命中必须显式标注')

    assertLedger(ctx, 'R4-2', 1)
    assertPerPaperBlock(ctx, 'R4-2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// R4-3 【命中分支·完整纳入】命中片段短于 1200 上限 ⇒ full、chars = 片段正文长度
//        基线把「（第 ? 页）」标签也算进 chars ⇒ 本用例在基线红
// ═════════════════════════════════════════════════════════════════════════════

test('R4-3 有命中且片段完整纳入 ⇒ full、chars=片段正文长度（不含页码标签）', (t) => {
  const { root, data } = newLib('dpr-r4-hitfull-')
  try {
    const body = 'R4-3-HIT-TOKEN ' + 'y'.repeat(300) // 314 字 < chunkText 默认 1500 ⇒ 整篇一个 chunk
    putPaper(data, 'Hits', 'R', body)
    const chunk0 = SRCH.chunkText(body)[0].text
    const cur = L.resolvePaper(data, { topic: 'Hits', name: 'R' })
    const ctx = build(data, cur, { kind: 'topic', topic: 'Hits' }, 'r4-3-hit-token')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} chunk0=${chunk0.length} hitChars=${ctx.hitChars}`)

    assert.equal(chunk0.length, body.length, '前提：整篇正文就是一个 chunk')
    assert.ok(ctx.hitChars > 0, '前提：必须真的有命中片段（否则本用例空转）')
    assert.equal(ctx.block.includes(chunk0), true, '前提：片段正文确实进块了')
    assert.equal(p.coverage, 'full', `片段完整纳入必须标 full：实际 ${p.coverage}`)
    assert.equal(ctx.truncated, 0, `没有截断，truncated 必须为 0：实际 ${ctx.truncated}`)
    assert.equal(p.chars, chunk0.length, `chars 必须是片段正文长度 ${chunk0.length}（不得含页码标签）：实际 ${p.chars}`)

    assertLedger(ctx, 'R4-3', 1)
    assertPerPaperBlock(ctx, 'R4-3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// R4-4 【命中分支·真截断】chunk 1500 字 > 1200 片段上限 ⇒ truncated、chars=1200、逐字对账
// ═════════════════════════════════════════════════════════════════════════════

test('R4-4 命中片段被 1200 上限切过 ⇒ truncated、chars=1200、块内正好 1200 字', (t) => {
  const { root, data } = newLib('dpr-r4-hitslice-')
  try {
    const body = 'R4-4-HIT-TOKEN ' + 'z'.repeat(3_000) // 单段 3014 字 ⇒ chunkText 硬切 1500
    putPaper(data, 'Hits', 'S', body)
    const chunk0 = SRCH.chunkText(body)[0].text
    const cur = L.resolvePaper(data, { topic: 'Hits', name: 'S' })
    const ctx = build(data, cur, { kind: 'topic', topic: 'Hits' }, 'r4-4-hit-token')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} chunk0=${chunk0.length} hitChars=${ctx.hitChars}`)

    assert.equal(chunk0.length, 1_500, '前提：chunkText 硬切出 1500 字块，1200 上限才会生效')
    assert.equal(p.coverage, 'truncated', `片段被 1200 上限切过，必须标 truncated：实际 ${p.coverage}`)
    assert.equal(ctx.truncated, 1, `truncated 台账必须为 1：实际 ${ctx.truncated}`)
    assert.equal(p.chars, 1_200, `chars 必须是实际纳入的 1200 字：实际 ${p.chars}`)
    assert.equal(ctx.block.includes(chunk0.slice(0, 1_200)), true, '纳入的 1200 字必须在块里')
    assert.equal(ctx.block.includes(chunk0.slice(0, 1_201)), false, '不得多给哪怕一个字（chars 与块内逐字一致）')

    assertLedger(ctx, 'R4-4', 1)
    assertPerPaperBlock(ctx, 'R4-4')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// R4-5 混合台账（12 篇：9 full / 2 truncated / 1 no-body）逐条对账 + 每篇 chars ↔ 块内字数
// ═════════════════════════════════════════════════════════════════════════════

test('R4-5 混合台账：full/truncated/no-body 并存时计数、明细、chars 与块内字数全部对得上', (t) => {
  const { root, data } = newLib('dpr-r4-mixed-')
  try {
    // 短正文（无命中）→ full；长正文（无命中）→ truncated；无正文 → no-body；短正文带命中词 → full
    for (let i = 1; i <= 4; i++) putPaper(data, 'Mix', `P${String(i).padStart(2, '0')}`, `m${i} ` + 's'.repeat(95))
    const longA = 'L'.repeat(9_000) + 'TAIL-R4-5-A' + 'M'.repeat(1_000)
    const longB = 'N'.repeat(9_000) + 'TAIL-R4-5-B' + 'O'.repeat(1_000)
    putPaper(data, 'Mix', 'P05', longA)
    putPaper(data, 'Mix', 'P06', longB)
    putPaper(data, 'Mix', 'P07', null)
    putPaper(data, 'Mix', 'P08', 'R4-5-MIX-TOKEN ' + 'y'.repeat(200)) // 命中，整篇一个 chunk ⇒ full
    for (let i = 9; i <= 12; i++) putPaper(data, 'Mix', `P${String(i).padStart(2, '0')}`, `m${i} ` + 's'.repeat(95))

    const cur = L.resolvePaper(data, { topic: 'Mix', name: 'P01' })
    const ctx = build(data, cur, { kind: 'topic', topic: 'Mix' }, 'r4-5-mix-token')
    t.diagnostic(`full=${ctx.full} truncated=${ctx.truncated} omitted=${ctx.omitted} total=${ctx.totalChars} ` +
      `coverage=${JSON.stringify(ctx.papers.map((p) => `${p.path}:${p.coverage}`))}`)

    assert.equal(ctx.papers.length, 12, '12 篇全在范围内，清单必须列全')
    assert.equal(ctx.full, 9, `短正文 8 篇 + 命中整篇 1 篇 ⇒ full 应为 9：实际 ${ctx.full}`)
    assert.equal(ctx.truncated, 2, `两篇长正文必须真截断 ⇒ truncated 应为 2：实际 ${ctx.truncated}`)
    assert.equal(ctx.omitted, 0, `预算充足时不该有 omitted：实际 ${ctx.omitted}`)
    assert.equal(ctx.papers.find((p) => p.path === 'Mix/P07').coverage, 'no-body', '无正文的篇必须标 no-body')
    // 真截断的两篇：尾部标记不得进块（chars 与块内一致的最强证据）
    assert.equal(ctx.block.includes('TAIL-R4-5-A'), false, '长正文 A 被切掉的尾部不得进块')
    assert.equal(ctx.block.includes('TAIL-R4-5-B'), false, '长正文 B 被切掉的尾部不得进块')

    assertLedger(ctx, 'R4-5', 12)
    assertPerPaperBlock(ctx, 'R4-5')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// R4-6 预算耗尽：truncated 与 omitted-no-room 并存，逐篇 chars 仍与块内一致、总量不越上限
// ═════════════════════════════════════════════════════════════════════════════

test('R4-6 预算耗尽：truncated/omitted-no-room 并存时 chars 逐篇自洽、总量不越 40000、omitted 提示只一次', (t) => {
  const { root, data } = newLib('dpr-r4-exhaust-')
  try {
    // 8 篇 × 10000 字（无命中）⇒ 单篇最多 8000，必然在 40000 预算内耗尽
    const tails = []
    for (let i = 1; i <= 8; i++) {
      const mark = `TAIL-R4-6-${i}`
      tails.push(mark)
      putPaper(data, 'Big', `P${i}`, 'E'.repeat(8_100) + mark + 'F'.repeat(1_890))
    }
    const cur = L.resolvePaper(data, { topic: 'Big', name: 'P1' })
    const ctx = build(data, cur, { kind: 'topic', topic: 'Big' }, 'zzz-no-such-token-r4')
    t.diagnostic(`full=${ctx.full} truncated=${ctx.truncated} omitted=${ctx.omitted} total=${ctx.totalChars} ` +
      `coverage=${JSON.stringify(ctx.papers.map((p) => `${p.path}:${p.coverage}`))}`)

    assert.equal(ctx.papers.length, 8, '8 篇必须全在 papers[] 里')
    assert.ok(ctx.truncated >= 4, `至少 4 篇能拿到满 8000 字的真截断：实际 ${ctx.truncated}`)
    assert.ok(ctx.omitted >= 1, `预算耗尽后必须如实 omitted-no-room（不许超预算硬塞）：实际 ${ctx.omitted}`)
    assert.equal(ctx.truncated + ctx.omitted, 8, '每篇只能是 truncated 或 omitted-no-room（本夹具无短正文）')
    for (const p of ctx.papers) {
      assert.ok(p.coverage === 'truncated' || p.coverage === 'omitted-no-room',
        `${p.path} 的 coverage 只能在这两者之一：${p.coverage}`)
    }
    // 被切掉的尾部标记：只有 full 才可能进块（本夹具没有 full）⇒ 一个都不许出现
    for (const mark of tails) {
      assert.equal(ctx.block.includes(mark), false, `被截断的 ${mark} 不得进块`)
    }
    // omitted 提示句只出现一次（维护者 G 点名过「两处重复输出」）
    assert.equal(countOccurrences(ctx.block, '因上下文上限未展开'), 1,
      `omitted 提示句必须只出现一次：实际 ${countOccurrences(ctx.block, '因上下文上限未展开')} 次`)

    assertLedger(ctx, 'R4-6', 8)
    assertPerPaperBlock(ctx, 'R4-6')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// R4-7 清单截断（MAX_MANIFEST）与论文 truncated 台账**分离**（t9 的语义收紧）
//        基线：manifest 超限 ⇒ truncated++ ⇒ 台账与 papers[].coverage 打架
// ═════════════════════════════════════════════════════════════════════════════

test('R4-7 清单被 MAX_MANIFEST 截断 ⇒ manifestTruncated=true，但论文 truncated 台账仍为 0', (t) => {
  const { root, data } = newLib('dpr-r4-manifest-')
  try {
    // 14 篇 × 116 字长名 × 6 个产物 ⇒ 清单必然超 2000 字；其中 2 篇超出 MAX_PAPERS_IN_SCOPE
    const longName = 'N' + 'x'.repeat(115)
    // 注意：**不能**写 `.mineru.md` / `.txt` —— 那是正文来源，会把本夹具变成「有正文」。
    const arts = ['.pages.json', '.transcript.json', '.mineru.json', '.embeddings.json']
    for (let i = 0; i < 14; i++) putPaper(data, 'Big', `${longName}${i}`, null, arts)
    for (let i = 0; i < 14; i++) writeFileSync(join(data, 'Big', `${longName}${i}`, `${longName}${i}.study.json`), '{"plan":[]}')
    const cur = L.resolvePaper(data, { topic: 'Big', name: `${longName}0` })
    const ctx = build(data, cur, { kind: 'topic', topic: 'Big' }, 'q')
    t.diagnostic(`manifestChars=${ctx.manifestChars} manifestTruncated=${ctx.manifestTruncated} ` +
      `truncated=${ctx.truncated} omitted=${ctx.omitted} papers=${ctx.papers.length}`)

    assert.equal(ctx.papers.length, 14, '14 篇必须全进 papers[]')
    assert.equal(ctx.manifestTruncated, true, `清单超 ${SC.MAX_MANIFEST} 字必须标 manifestTruncated：实际 ${ctx.manifestTruncated}`)
    assert.match(ctx.block, /清单已截断至上限/, '清清单截断必须在提示块里显式可见')
    assert.equal(ctx.truncated, 0, `清单截断不得算进论文 truncated 台账（基线会 +1）：实际 ${ctx.truncated}`)
    assert.equal(ctx.full, 0, `这些篇都没有正文，full 必须为 0：实际 ${ctx.full}`)
    assert.equal(ctx.omitted, 2, `超出 MAX_PAPERS_IN_SCOPE=12 的 2 篇必须如实 omitted：实际 ${ctx.omitted}`)
    assert.equal(ctx.papers.every((p) => p.coverage === 'no-body' || p.coverage === 'omitted-no-room'), true,
      '无正文的篇只能是 no-body / omitted-no-room')

    assertLedger(ctx, 'R4-7', 14)
    assertPerPaperBlock(ctx, 'R4-7')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// R4-8 同名论文（无法唯一定位）也必须进台账：三处对得上（papers/omittedNotes/提示块）
// ═════════════════════════════════════════════════════════════════════════════

test('R4-8 同名论文 skipped：omitted=2、omittedNotes 逐篇带原因、块内点名，均不静默丢', (t) => {
  const { root, data } = newLib('dpr-r4-dup-')
  try {
    putPaper(data, 'A', 'P', 'body one')
    putPaper(data, 'A/B', 'P', 'body two')
    const cur = L.resolvePaper(data, { topic: 'A/B', name: 'P' })
    const ctx = build(data, cur, { kind: 'topic', topic: 'A' }, 'body')
    t.diagnostic(`papers=${ctx.papers.length} omitted=${ctx.omitted} notes=${JSON.stringify(ctx.omittedNotes)}`)

    assert.equal(ctx.papers.length, 2, '两处同名论文都必须出现在明细里')
    assert.equal(ctx.omitted, 2, `两篇无法唯一定位 ⇒ omitted 必须为 2：实际 ${ctx.omitted}`)
    assert.equal(ctx.papers.filter((p) => p.coverage === 'omitted-duplicate').length, 2,
      '两篇都必须标 omitted-duplicate')
    assert.equal(ctx.omittedNotes.length, 2, `omittedNotes 必须逐篇给原因：实际 ${ctx.omittedNotes.length} 条`)
    for (const note of ctx.omittedNotes) assert.match(note, /同名/, `omittedNotes 必须说明同名原因：${note}`)
    assert.match(ctx.block, /同名论文在多处/, '提示块必须显式点名同名跳过')
    assert.equal(ctx.block.includes('A/P'), true)
    assert.equal(ctx.block.includes('A/B/P'), true)
    assert.equal(ctx.full, 0, `没有给正文，full 必须为 0：实际 ${ctx.full}`)
    assert.equal(ctx.truncated, 0, `没有截断，truncated 必须为 0：实际 ${ctx.truncated}`)

    assertLedger(ctx, 'R4-8', 2)
    assertPerPaperBlock(ctx, 'R4-8')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 基线模式提示（跑基线对照时把本文件放在 pr8-fixes 里、用 R4_REPO 指过去即可）：
if (BASELINE_MODE) {
  test('R4-0 基线模式自检', (t) => {
    t.diagnostic(`R4_REPO 模式：目标工作树 = ${TARGET}（期望行为断言红 = 基线确有该缺陷；绿 = 基线无此缺陷）`)
    assert.ok(true)
  })
}
