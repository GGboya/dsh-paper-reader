// test/pr8-coverage-honesty.test.mjs — PR #8 评审 G 次级（coverage 误报）+ 台账自洽性。
//
// 维护者原话：「短正文全覆盖时 `coverage` 误报 `truncated`（scope.ts:253）」。
// 基线 fdb45f2 的触发条件（本文件 S1 逐字复现）：
//   专题范围（kind:'topic'）下，某篇**检索无命中**、正文很短（< MAX_PER_DOC 且预算充足）⇒
//   `pushWithLabel(..., 'truncated', ...)` + `truncated++` 是**无条件**的，于是「整篇正文都进了
//   上下文，却标已截断」——papers[0].coverage='truncated'、truncated=1、rec.chars 还把说明句
//   （「以下是开头片段」）的字数算进去了 ⇒ 统计与明细打架。
//
// 本文件同时给「台账 vs 明细」立一致性断言（评审这轮反复抓的就是这类自相矛盾）：
//   ctx.truncated === #(coverage==='truncated')、ctx.full === #(coverage==='full')、
//   ctx.omitted === #(coverage.startsWith('omitted'))、每篇 chars 与实际进块字数一致。
//
// 只 import dist/*.js（跑前 npm run build）；临时库一律 mkdtemp，绝不碰真实文献库/真实 ~/.dsh。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-cov-home-'))

const L = await import(pathToFileURL(dist('library.js')).href)
const SC = await import(pathToFileURL(dist('scope.js')).href)

function newLib(prefix = 'dpr-cov-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局落一篇论文：`<data>/<topic>/<name>/<name>.pdf`，可带正文（写 .txt）。 */
function putPaper(data, topic, name, body = null) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.pdf'), `pdf:${topic}/${name}`)
  if (body != null) writeFileSync(join(dir, name + '.txt'), body)
  return dir
}

/**
 * 台账 vs 明细：一条断言把「coverage 逐篇 / 计数 / chars / 预算」全部对账。
 * 所有用例都调它 ⇒ 只要任何一处统计与明细打架，用例就红。
 */
function assertLedger(ctx, label) {
  const count = (pred) => ctx.papers.filter(pred).length
  const omittedPapers = count((p) => typeof p.coverage === 'string' && p.coverage.startsWith('omitted'))
  assert.equal(ctx.truncated, count((p) => p.coverage === 'truncated'),
    `${label}: truncated 台账(${ctx.truncated}) 必须等于 coverage='truncated' 的篇数(${count((p) => p.coverage === 'truncated')})`)
  assert.equal(ctx.full, count((p) => p.coverage === 'full'),
    `${label}: full 台账(${ctx.full}) 必须等于 coverage='full' 的篇数(${count((p) => p.coverage === 'full')})`)
  assert.equal(ctx.omitted, omittedPapers,
    `${label}: omitted 台账(${ctx.omitted}) 必须等于 coverage='omitted-*' 的篇数(${omittedPapers})`)
  // 每篇都必须有确定的终态，不允许「留在占位 no-body 但其实给了正文」这种矛盾
  const known = new Set(['full', 'truncated', 'no-body', 'omitted-no-room', 'omitted-duplicate'])
  for (const p of ctx.papers) {
    assert.ok(known.has(p.coverage), `${label}: ${p.path} 的 coverage 非法：${p.coverage}`)
    if (p.coverage === 'full' || p.coverage === 'truncated') {
      assert.ok(p.chars > 0, `${label}: ${p.path} 已给内容，chars 必须 > 0：${p.chars}`)
      assert.ok(p.chars <= SC.MAX_PER_DOC, `${label}: ${p.path} 单篇 chars 不得超 MAX_PER_DOC：${p.chars}`)
    } else {
      assert.equal(p.chars, 0, `${label}: ${p.path} 未展开（${p.coverage}）chars 必须为 0：${p.chars}`)
    }
  }
  // 预算口径：总量自洽且不越上限
  assert.equal(ctx.totalChars, ctx.manifestChars + ctx.bodyChars + ctx.hitChars,
    `${label}: totalChars 必须等于三段之和`)
  assert.ok(ctx.totalChars <= SC.MAX_CONTEXT_CHARS,
    `${label}: totalChars 不得超 ${SC.MAX_CONTEXT_CHARS}：${ctx.totalChars}`)
  assert.ok(ctx.block.length <= SC.MAX_CONTEXT_CHARS + 800,
    `${label}: 最终 block 也不得明显超上限：${ctx.block.length}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// S1 【基线误报点】短正文 + 检索无命中 ⇒ 整篇纳入，必须 'full'（不是 'truncated'）
// ═══════════════════════════════════════════════════════════════════════════

test('S1 【基线误报】短正文无命中但整篇纳入 ⇒ coverage=full、truncated=0、chars=正文长度（基线标 truncated）', (t) => {
  const { root, data } = newLib('dpr-cov-short-')
  try {
    const body = 'SHORT-BODY ' + 'x'.repeat(200) // 211 字，远小于 MAX_PER_DOC
    putPaper(data, 'Short', 'P', body)
    const cur = L.resolvePaper(data, { topic: 'Short', name: 'P' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Short' }, 'no-such-token-anywhere')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} truncated=${ctx.truncated} body=${body.length}`)
    assert.equal(ctx.block.includes(body), true, '前提：整篇正文确实都进了上下文（否则本用例是空转）')
    // ← 基线在此断言处红：coverage='truncated' / truncated=1 / chars=235（把说明句也算进去了）
    assert.equal(p.coverage, 'full', `整篇正文都给了，必须标 full（基线误报 truncated）：${p.coverage}`)
    assert.equal(ctx.truncated, 0, `没有截断，truncated 必须为 0（基线为 1）：${ctx.truncated}`)
    assert.equal(p.chars, body.length, `chars 必须是正文实际字数 ${body.length}（基线把说明句算成 235）：${p.chars}`)
    assert.match(ctx.block, /以下是全文/, '整篇给完时提示文案必须诚实（不得仍说「开头片段」）')
    assert.doesNotMatch(ctx.block, /以下是开头片段/, '整篇给完时不得说「开头片段」')
    assertLedger(ctx, 'S1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// S2 【反证】无命中 + 长正文 ⇒ 真的截断，必须 'truncated'（防止把 full/truncated 弄反）
// ═══════════════════════════════════════════════════════════════════════════

test('S2 【反证】无命中且正文超 MAX_PER_DOC ⇒ 真截断：coverage=truncated、truncated=1、chars=8000', (t) => {
  const { root, data } = newLib('dpr-cov-long-')
  try {
    const body = 'A'.repeat(SC.MAX_PER_DOC) + 'B'.repeat(2000) // 10000 字
    putPaper(data, 'Long', 'Q', body)
    const cur = L.resolvePaper(data, { topic: 'Long', name: 'Q' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Long' }, 'no-such-token-anywhere')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} truncated=${ctx.truncated} block=${ctx.block.length}`)
    assert.equal(p.coverage, 'truncated', '正文被真的切掉了，必须标 truncated')
    assert.equal(ctx.truncated, 1, 'truncated 台账必须为 1')
    assert.equal(p.chars, SC.MAX_PER_DOC, `chars 必须是实际纳入的 ${SC.MAX_PER_DOC} 字：${p.chars}`)
    assert.equal(ctx.block.includes('A'.repeat(SC.MAX_PER_DOC)), true, '纳入的前 8000 字必须在块里')
    assert.equal(ctx.block.includes('A'.repeat(SC.MAX_PER_DOC + 1)), false, '不得多给哪怕一个字（chars 与块内一致）')
    assert.match(ctx.block, /以下是开头片段/, '真截断时必须说「开头片段」')
    assert.match(ctx.block, /无关键词命中/, '无命中必须显式标注（避免模型以为这是检索结果）')
    assertLedger(ctx, 'S2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// S3/S4 有命中的两种情形：完整纳入 → full；片段被 1200 截 → truncated
// ═══════════════════════════════════════════════════════════════════════════

test('S3 有命中且该篇正文只有一个 chunk（全部纳入）⇒ coverage=full、chars=正文长度', (t) => {
  const { root, data } = newLib('dpr-cov-hitfull-')
  try {
    const body = 'HIT-TOKEN ' + 'y'.repeat(300) // 310 字 < chunkText 默认 1500 ⇒ 整篇一个 chunk
    putPaper(data, 'Hits', 'R', body)
    const cur = L.resolvePaper(data, { topic: 'Hits', name: 'R' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Hits' }, 'hit-token')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} hitChars=${ctx.hitChars}`)
    assert.ok(ctx.hitChars > 0, '前提：必须有命中片段（否则本用例是空转）')
    assert.equal(ctx.block.includes(body), true, '整篇（=唯一 chunk）都进了块')
    assert.equal(p.coverage, 'full', `命中片段完整纳入必须标 full：${p.coverage}`)
    assert.equal(p.chars, body.length, `chars 必须是片段正文实际字数：${p.chars}`)
    assert.equal(ctx.truncated, 0, '没有截断')
    assertLedger(ctx, 'S3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S4 有命中但 1200 字片段上限生效 ⇒ coverage=truncated、chars=1200 且与块内逐字对得上', async (t) => {
  const { root, data } = newLib('dpr-cov-hitslice-')
  try {
    const body = 'HIT-TOKEN ' + 'z'.repeat(3000) // 单段 3010 字 ⇒ 硬切成 1500 字 chunk，chunk0 带 token
    putPaper(data, 'Hits', 'S', body)
    const { chunkText } = await import(pathToFileURL(dist('search.js')).href)
    const chunk0 = chunkText(body)[0].text
    const cur = L.resolvePaper(data, { topic: 'Hits', name: 'S' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Hits' }, 'hit-token')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} chunk0=${chunk0.length}`)
    assert.equal(chunk0.length, 1500, '前提：chunkText 硬切出 1500 字块（否则 1200 上限不生效）')
    assert.equal(p.coverage, 'truncated', '片段被 1200 上限切过，必须标 truncated')
    assert.equal(p.chars, 1200, `chars 必须是实际纳入的 1200 字：${p.chars}`)
    assert.equal(ctx.block.includes(chunk0.slice(0, 1200)), true, '纳入的 1200 字必须在块里')
    assert.equal(ctx.block.includes(chunk0.slice(0, 1201)), false, '不得多给一个字（chars 与块内一致）')
    assert.equal(ctx.truncated, 1)
    assertLedger(ctx, 'S4')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// S5 单篇范围的真截断（既有契约不回归）
// ═══════════════════════════════════════════════════════════════════════════

test('S5 单篇范围长正文 ⇒ truncated、chars=8000、truncated=1（paper 分支不回归）', (t) => {
  const { root, data } = newLib('dpr-cov-paper-')
  try {
    const body = 'C'.repeat(SC.MAX_PER_DOC) + 'D'.repeat(3000)
    putPaper(data, 'Paper', 'T', body)
    const cur = L.resolvePaper(data, { topic: 'Paper', name: 'T' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'paper' }, 'whatever')
    const p = ctx.papers[0]
    t.diagnostic(`coverage=${p.coverage} chars=${p.chars} truncated=${ctx.truncated}`)
    assert.equal(p.coverage, 'truncated')
    assert.equal(ctx.truncated, 1)
    assert.equal(p.chars, SC.MAX_PER_DOC)
    assert.equal(ctx.block.includes('C'.repeat(SC.MAX_PER_DOC)), true)
    assert.equal(ctx.block.includes('C'.repeat(SC.MAX_PER_DOC + 1)), false)
    assertLedger(ctx, 'S5')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// S6 混合台账：full / truncated / no-body / omitted-no-room 同时出现，逐条对账
// ═══════════════════════════════════════════════════════════════════════════

test('S6 混合台账：full+truncated+no-body 并存时计数与明细逐条对得上', (t) => {
  const { root, data } = newLib('dpr-cov-mixed-')
  try {
    // 预算充足（1 短 + 2 长 + 1 无正文），三种终态同场，不依赖目录枚举顺序
    putPaper(data, 'Mix', 'P1', 'short-body ' + 's'.repeat(80))
    putPaper(data, 'Mix', 'P2', 'A'.repeat(9000))
    putPaper(data, 'Mix', 'P3', 'B'.repeat(9000))
    putPaper(data, 'Mix', 'P4', null)
    const cur = L.resolvePaper(data, { topic: 'Mix', name: 'P1' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Mix' }, 'no-such-token-anywhere')
    t.diagnostic(`full=${ctx.full} truncated=${ctx.truncated} omitted=${ctx.omitted} ` +
      `coverage=${JSON.stringify(ctx.papers.map((p) => `${p.path}:${p.coverage}`))}`)
    assert.equal(ctx.papers.length, 4, '清单要把范围里的 4 篇列全')
    assert.equal(ctx.full, 1, '短正文那篇必须 full（基线误报点）')
    assert.equal(ctx.truncated, 2, '两篇长正文必须真截断（反证）')
    assert.equal(ctx.omitted, 0, '预算充足时不该有 omitted')
    assert.equal(ctx.papers.find((p) => p.path === 'Mix/P4').coverage, 'no-body', '无正文的篇必须标 no-body')
    assertLedger(ctx, 'S6')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S6b 预算耗尽台账：omitted-no-room 与 truncated 并存时计数与明细仍对得上', (t) => {
  const { root, data } = newLib('dpr-cov-exhaust-')
  try {
    // 7 篇 × 9000 字（无命中）⇒ 每篇最多 8000，必然在 40000 预算内耗尽
    for (let i = 1; i <= 7; i++) putPaper(data, 'Big', `P${i}`, 'A'.repeat(9000))
    const cur = L.resolvePaper(data, { topic: 'Big', name: 'P1' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Big' }, 'no-such-token-anywhere')
    t.diagnostic(`full=${ctx.full} truncated=${ctx.truncated} omitted=${ctx.omitted} total=${ctx.totalChars} ` +
      `coverage=${JSON.stringify(ctx.papers.map((p) => `${p.path}:${p.coverage}`))}`)
    assert.equal(ctx.papers.length, 7)
    assert.ok(ctx.truncated >= 4, `至少 4 篇真截断：${ctx.truncated}`)
    assert.ok(ctx.omitted >= 1, `预算耗尽后必须 omitted-no-room（不许超预算硬塞）：${ctx.omitted}`)
    assert.ok(ctx.omitted <= 7, 'omitted 不能超过总篇数')
    assertLedger(ctx, 'S6b')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// S7 同名论文（t2 的 skipped 契约）也必须进台账：omitted 与明细逐条对得上
// ═══════════════════════════════════════════════════════════════════════════

test('S7 同名论文 skipped：omitted=2 且两篇都以 omitted-duplicate 出现在明细里（台账同源）', () => {
  const { root, data } = newLib('dpr-cov-dup-')
  try {
    putPaper(data, 'A', 'P', 'body one')
    putPaper(data, 'A/B', 'P', 'body two')
    const cur = L.resolvePaper(data, { topic: 'A/B', name: 'P' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'A' }, 'body')
    assert.equal(ctx.omitted, 2)
    assert.equal(ctx.papers.filter((p) => p.coverage === 'omitted-duplicate').length, 2)
    assert.equal(ctx.full, 0)
    assert.equal(ctx.truncated, 0)
    assertLedger(ctx, 'S7')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// S8 清单截断单独记（manifestTruncated），不得污染 truncated 台账
// ═══════════════════════════════════════════════════════════════════════════

test('S8 清单被 MAX_MANIFEST 截断 ⇒ manifestTruncated=true，但 truncated 台账仍与 papers[].coverage 对得上', (t) => {
  const { root, data } = newLib('dpr-cov-manifest-')
  try {
    // 12 篇 × 7 个产物 + 61 字长名 ⇒ 清单必然超 2000 字上限
    const longName = 'N' + 'x'.repeat(110)
    for (let i = 0; i < SC.MAX_PAPERS_IN_SCOPE; i++) {
      const dir = putPaper(data, 'Big', `${longName}${i}`, null)
      for (const s of ['.pages.json', '.transcript.json', '.mineru.json', '.embeddings.json']) {
        writeFileSync(join(dir, `${longName}${i}${s}`), 'x')
      }
    }
    const cur = L.resolvePaper(data, { topic: 'Big', name: `${longName}0` })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Big' }, 'q')
    t.diagnostic(`manifestChars=${ctx.manifestChars} manifestTruncated=${ctx.manifestTruncated} ` +
      `truncated=${ctx.truncated} papers=${ctx.papers.length}`)
    assert.equal(ctx.manifestTruncated, true, '清单超 2000 字必须标 manifestTruncated')
    assert.match(ctx.block, /清单已截断至上限/, '截断必须在提示里显式可见')
    assert.equal(ctx.papers.every((p) => p.coverage === 'no-body'), true, '这些篇都没正文')
    assert.equal(ctx.truncated, 0, `清单截断不得算进论文 truncated 台账（基线会 +1）：${ctx.truncated}`)
    assertLedger(ctx, 'S8')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
