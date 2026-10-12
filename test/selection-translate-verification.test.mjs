// test/selection-translate-verification.test.mjs — t3 独立验证的**补充复现测试**（审查方产出）
//
// 与 test/selection-translate.test.mjs（实现方自测）的分工：
//   · 这里只固定「评审自己构造并亲自复现过」的事实：真实 .mineru.json 夹具、真实 PDF 的页数、
//     以及 t3 报告里两个缺陷的**最小复现**（缺陷用例显式 skip，附带原因；修复后应把它们启用）。
//   · 不 import 网络、不起浏览器、不写任何文献库文件；只用本机真实产物（缺失则 skip）。
//
// 复现命令：npm run build && node --test test/selection-translate-verification.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = (m) => join(REPO, 'dist', m)

const { assembleSource, alignSelectionToBlock, stripJunk, formulaStatusOf, normForAlign } = await import(pathToFileURL(dist('translate-selection.js')).href)
const { compactLatex, buildTextBlockIndex, buildFormulaIndex } = await import(pathToFileURL(dist('formulas.js')).href)

const LIB = join(homedir(), '.dsh-paper-reader', 'data', '默认专题')
const DONG = 'Dong et al. - 2026 - Language-Conditioned World Modeling for Visual Navigation'
const HAS_DONG = existsSync(join(LIB, DONG + '.mineru.json'))
const stripWs = (s) => s.replace(/\s+/g, '')

/* ══ 1. 真实产物夹具：独立算出「该页含 $ 的 text 块」并按阅读序取用 ══════════ */
const dongRaw = HAS_DONG ? readFileSync(join(LIB, DONG + '.mineru.json'), 'utf8') : null

/** 本脚本自己的块表（按 contentList 顺序 + page_idx 缺失沿用上一块），与实现方的索引无关 */
function myBlocks(pageNo) {
  const parsed = JSON.parse(dongRaw)
  const out = []
  let last = 0
  for (const b of parsed.contentList) {
    if (typeof b.page_idx === 'number') last = b.page_idx
    if (b.type !== 'text' || typeof b.text !== 'string' || !b.text.includes('$')) continue
    if (last + 1 === pageNo) out.push(compactLatex(b.text))
  }
  return out
}
const page5Blocks = HAS_DONG ? myBlocks(5) : []
const page6Blocks = HAS_DONG ? myBlocks(6) : []

/* ══ 2. 组装链路：真机里实测到的三个选区形态（V1 亲自复现过，见 docs/selection-translate-verification.md） ══ */
test('V1 行内单公式：/Conditions on navigation action ˆat/ → 公式被替换为紧凑 LaTeX（真实块夹具）', { skip: !HAS_DONG }, () => {
  const r = assembleSource([{ page: 5, kind: 'text', text: 'conditions on navigation action ˆat' }], buildTextBlockIndex(dongRaw))
  assert.equal(r.source, 'conditions on navigation action $\\hat{a}_t$')
  assert.equal(r.applied, 1)
})

test('V2 行内多公式（跨两行、同一块）：4 个公式按序替换，正文逐字来自块（真实块夹具）', { skip: !HAS_DONG }, () => {
  const text = 'Given current observations encoded as VAE latents,LCVN-WM Fθ conditions on navigation action ˆatwhere t denotes timestep, instruction I, and timeshift ts to predict the next state ˆst+1:'
  const r = assembleSource([{ page: 5, kind: 'text', text }], buildTextBlockIndex(dongRaw))
  assert.equal(
    r.source,
    'Given current observations encoded as VAE latents, LCVN-WM $F_\\theta$ conditions on navigation action $\\hat{a}_t$ where t denotes timestep, instruction I, and time shift $t_s$ to predict the next state $\\widehat s_{t+1}\\mathrm{:}$',
  )
  assert.deepEqual(r.source.match(/\$[^$]*\$/g), page5Blocks[0].match(/\$[^$]*\$/g))
})

test('V3 display 公式：formula chunk → `$紧凑LaTeX$`，乱码字符不进请求体', { skip: !HAS_DONG }, () => {
  const idx = buildFormulaIndex(dongRaw)
  const eq = idx.equations.find((e) => e.page === 6 && e.latex.includes('tag{4}') === false && e.latex.includes('\\begin{array}'))
  assert.ok(eq, '第 6 页应有一个 array 型 display 公式')
  const latex = eq.latex.replace(/^\s*\$\$?/, '').replace(/\$\$?\s*$/, '').trim()
  const garbled = 'ˆsπt+1 ∼ Fθ (ˆsπt+1 | st, ˆat, Iclip, ts), (4)'   // 真实文本层乱码（含 \u0000 等）
  const r = assembleSource([{ page: 6, kind: 'formula', latex }, { page: 6, kind: 'text', text: ' (4)' }], buildTextBlockIndex(dongRaw))
  assert.ok(r.source.startsWith('$' + latex + '$'), 'display 公式原样包 $…$')
  assert.ok(!r.source.includes('ˆsπt+1'), '乱码字形不得进入请求体')
})

test('V4 token 与 .mineru.json 原文只差空白（压紧过程不篡改内容）', { skip: !HAS_DONG }, () => {
  const r = assembleSource([{ page: 5, kind: 'text', text: 'Given current observations encoded as VAE latents,LCVN-WM Fθ conditions' }], buildTextBlockIndex(dongRaw))
  const toks = r.source.match(/\$[^$]*\$/g) ?? []
  assert.ok(toks.length >= 1)
  const rawBlock = page5Blocks[0]
  for (const t of toks) assert.ok(stripWs(rawBlock).includes(stripWs(t.slice(1, -1))), `token ${t} 应能在块原文里找到（去空白后）`)
})

test('V5 组装文本不含 C0/C1、私用区、U+FFFD、走音符号（真实乱码夹具）', { skip: !HAS_DONG }, () => {
  const r = assembleSource([{ page: 5, kind: 'text', text: 'si=Encθ(oi)\u02c6st+1\u0000\u0010\u0011 \ufffd \ue000\ue001 where t denotes timestep' }], buildTextBlockIndex(dongRaw))
  const bad = [...r.source].filter((c) => {
    const n = c.codePointAt(0)
    return (n <= 0x1f && n !== 0x0a) || (n >= 0x7f && n <= 0x9f) || (n >= 0xe000 && n <= 0xf8ff) || n === 0xfffd || (n >= 0x300 && n <= 0x36f)
  })
  assert.deepEqual(bad, [])
})

test('V6 清洗边界：stripJunk 会吃掉 `^`（所以 LaTeX piece 必须绕开它），formula chunk 逐字保留', () => {
  // 这就是 assembleSource 必须「按 piece 分类清洗」的原因：整段过 stripJunk 会把 v^\top 毁成 v\top。
  assert.equal(stripJunk('a\u0000b^2 c'), 'ab2 c')
  const r = assembleSource([{ page: 1, kind: 'formula', latex: 'v^\\top x^2' }], null)
  assert.equal(r.source, '$v^\\top x^2$')
})

test('V7 无 MinerU 产物：原样返回 + formulaStatus=no-artifact（不假装还原）', () => {
  const r = assembleSource([{ page: 1, kind: 'text', text: 'E = mc2 and πθ(a|s)' }], buildTextBlockIndex(null))
  assert.equal(r.source, 'E = mc2 and πθ(a|s)')
  assert.equal(r.applied, 0)
  assert.equal(formulaStatusOf(r), 'no-artifact')
})

test('V8 极短选区（nf < 4）不对齐：原样返回且 skipped 计数', () => {
  const r = assembleSource([{ page: 1, kind: 'text', text: 'πθ' }], buildTextBlockIndex(JSON.stringify({ contentList: [{ type: 'text', page_idx: 0, text: 'we use $\\pi_\\theta$ here' }] })))
  assert.equal(r.source, 'πθ')
  assert.equal(r.applied, 0)
  assert.equal(r.skipped, 1)
  assert.equal(formulaStatusOf(r), 'unavailable')
})

test('V9 跨页：两个 page 的 text chunk 各自成段，页间插 \\n（A14 的组装侧）', { skip: !HAS_DONG }, () => {
  const a = assembleSource([
    { page: 5, kind: 'text', text: 'conditions on navigation action ˆat' },
    { page: 6, kind: 'text', text: 'where n denotes total trajectory length' },
  ], buildTextBlockIndex(dongRaw))
  assert.ok(a.source.includes('$\\hat{a}_t$'), '第 5 页的公式被还原')
  assert.ok(a.source.includes('where n denotes total trajectory length'), '第 6 页的正文保留')
  assert.equal(a.source.split('\n').length, 2, '页边界恰好一个 \\n')
})

test('V10 归一化只保留 [a-z0-9]+CJK（对口径的独立复算）', () => {
  assert.equal(normForAlign('F_\\theta$ (ˆa_t)').A, 'fthetaat')
})

/* ══ 3. 分屏的两个纯函数（从 reader 内联脚本里原样抽出后求值，不改源码） ══════ */
const READER = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')
const fnSrc = (name) => {
  const i = READER.indexOf(`function ${name}(`)
  assert.ok(i > 0, `reader/index.html 里应有 function ${name}`)
  let d = 0
  for (let j = READER.indexOf('{', i); j < READER.length; j++) {
    if (READER[j] === '{') d++
    else if (READER[j] === '}') { d--; if (d === 0) return READER.slice(i, j + 1) }
  }
  throw new Error('unbalanced')
}
const mkFn = (name) => new Function(`${fnSrc(name)}; return ${name}`)()

test('V11 anchorOf：顶部页号 + 页内比例（独立复算）', () => {
  const anchorOf = mkFn('anchorOf')
  const pages = [{ page: 1, offsetTop: 0, offsetHeight: 100 }, { page: 2, offsetTop: 100, offsetHeight: 200 }]
  assert.deepEqual(anchorOf(pages, 0), { page: 1, ratio: 0 })
  assert.deepEqual(anchorOf(pages, 150), { page: 2, ratio: 0.25 })
  assert.deepEqual(anchorOf(pages, 100), { page: 2, ratio: 0 })
  assert.deepEqual(anchorOf(pages, 999), { page: 2, ratio: 4.495 })
  assert.equal(anchorOf([], 0), null)
})

test('V12 syncTargetOf：页数相同走同页号；页数不同按比例映射并置 mismatch（独立复算）', () => {
  const syncTargetOf = mkFn('syncTargetOf')
  const target = [{ page: 1, offsetTop: 0, offsetHeight: 120 }, { page: 2, offsetTop: 120, offsetHeight: 80 }]
  assert.deepEqual(syncTargetOf({ page: 2, ratio: 0.5 }, target, 2), { top: 160, mismatch: false })
  const m = syncTargetOf({ page: 1, ratio: 0.5 }, target, 3)
  assert.equal(m.mismatch, true)
  assert.equal(m.top, 60)
})

/* ══ 4. 真实 PDF 的变体页数（分屏同步的前提；B9 的夹具口径） ═══════════════ */
test('V13 本机真实产物：原文 / -zh / -dual 页数与页面尺寸（-dual 恰 2× 页宽）', { skip: !existsSync(join(LIB, DONG + '-zh.pdf')) }, async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const stat = async (p) => {
    const doc = await getDocument({ data: new Uint8Array(readFileSync(p)) }).promise
    const vp = (await doc.getPage(1)).getViewport({ scale: 1 })
    return { pages: doc.numPages, w: vp.width, h: vp.height }
  }
  const o = await stat(join(LIB, DONG + '.pdf'))
  const z = await stat(join(LIB, DONG + '-zh.pdf'))
  assert.deepEqual([o.pages, o.w, o.h], [19, 612, 792])
  assert.deepEqual([z.pages, z.w, z.h], [19, 612, 792])
  if (existsSync(join(LIB, DONG + '-dual.pdf'))) {
    const d = await stat(join(LIB, DONG + '-dual.pdf'))
    assert.deepEqual([d.pages, d.w], [19, 1224])
  }
})

/* ══ 5. 原 t3 缺陷（attempt 2 复验：修复后已启用，全部通过） ══════════════
   attempt 1 时这两条以 skip 记录「应有行为」；修复 commit（src/translate-selection.ts 12:59、
   reader/index.html 12:58）后它们转为**必须通过**的回归用例：任何一次回退都会让全量测试变红。 */

test('R2-F1 行内对齐不得丢掉跨度前的正文词（原 t3 F1，已修复）', { skip: !HAS_DONG }, () => {
  const block = page6Blocks.find((b) => b.startsWith('where $\\mathbf{s}_t'))
  assert.ok(block, '第 6 页应有以 `where $\\mathbf{s}_t` 开头的 text 块')
  const r = alignSelectionToBlock('where st = [st, st−1, ..., st−k] denotes the sequence', block)
  assert.equal(r.applied, 1)
  assert.ok(r.text.startsWith('where '), `还原结果必须以块里的 "where" 开头，实际=${r.text}`)
  assert.ok(r.text.includes('denotes the sequence'), `尾部正文也必须保留，实际=${r.text}`)
  assert.ok(r.text.includes('$\\mathbf{s}_t='), `公式仍要还原成紧凑 LaTeX，实际=${r.text}`)
})

test('R2-F1b 带 display 公式编号前缀的同一形态（原 t3 S6 真机形态）', { skip: !HAS_DONG }, () => {
  const block = page6Blocks.find((b) => b.startsWith('where $\\mathbf{s}_t'))
  const r = alignSelectionToBlock(' (4)where st = [st, st−1, ..., st−k] denotes the sequence', block)
  assert.equal(r.applied, 1)
  assert.ok(r.text.startsWith('where '), `实际=${r.text}`)
})

test('R2-F2 选区所属段落不在候选集里时不得被别的段落接走（原 t3 F2，已修复）', { skip: !HAS_DONG }, () => {
  // 该段落（During training, an expert encoder … while a learner encoder …）的块在**第 5 页**（跨页段落），
  // 第 6 页候选块里没有它 ⇒ 必须原样返回（applied=0），而不是吐出别段落的 "expert and learner encoders"。
  const r = assembleSource([{ page: 6, kind: 'text', text: ', while a learner encoder' }], buildTextBlockIndex(dongRaw))
  assert.equal(r.source, ', while a learner encoder')
  assert.equal(r.applied, 0)
})

test('R2-F2b 短碎片不得被错配（原 t3 F2 的同型反例，已修复）', { skip: !HAS_DONG }, () => {
  const idx = buildTextBlockIndex(dongRaw)
  for (const frag of [', while a learner encoder', 'During', 'training,', 'forcing (DF) (Chen et al., 2024; Song et al., 2025) to']) {
    const r = assembleSource([{ page: 6, kind: 'text', text: frag }], idx)
    assert.equal(r.source, frag, `短/跨页碎片 ${JSON.stringify(frag)} 必须原样返回`)
    assert.equal(r.applied, 0)
  }
})
