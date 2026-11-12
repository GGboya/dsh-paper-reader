// test/triple-click-paragraph.test.mjs —— 三击选段的段落识别算法（issue #22-3 与追加反馈）。
//
// 守什么：dprPickParagraph 是阅读器三击选段的核心（纯函数：span 盒数组 + 点击点 → 段落
// 首尾 span）。v1.12.0 初版有两个跨栏 bug，本文件用合成的双栏 / 对照版几何把两个根因
// 钉死，防止回退：
//
//   ① 归行只看 top：双栏同一行的左右栏 top 相同，被并成一条横贯全页的「行」，
//      扩段时它与谁都水平重叠 ⇒ 整页串联 ⇒ 撞 60 行上限退回单行。
//      症状：双栏论文「有时候一行、有时候超长一段」；babeldoc 对照版「三击没用」。
//   ② 扩段只看数组相邻行：(t,l) 排序里双栏的相邻项恰是另一栏，正确分行后逐相邻扩
//      立刻断掉 ⇒ 永远只选一行。
//
// 阈值依据（真浏览器实测 GFS 双栏 + babeldoc 对照版的 textLayer 盒）：词距 ≤ 2×行高
// （≈2% 页宽），双栏栏沟 ≈ 4% 页宽，对照版栏沟 ≥ 27% 页宽。gapX = max(2×行高, 3% 页宽)
// 落在词距与栏沟之间——改阈值前先在真浏览器里重测这两份分布（页边注 ≈2.6% 页宽的间隙
// 会被并入行，可接受：它不影响扩段的栏区间）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readReaderScript } from './reader-script.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const { script: READER } = readReaderScript(join(ROOT, '..', 'reader', 'index.html'))

/** 从阅读器脚本里抠出 dprPickParagraph 源码并在隔离作用域里实例化（与 DOM 无关的纯函数）。 */
function pickFn() {
  const at = READER.indexOf('function dprPickParagraph(')
  assert.notEqual(at, -1, 'reader 脚本里找不到 dprPickParagraph：三击选段算法被移走了？')
  const end = READER.indexOf('\n}', at)
  assert.notEqual(end, -1, 'dprPickParagraph 源码截取失败（花括号配对假定被打破），需同步更新本测试')
  // eslint-disable-next-line no-new-func
  return new Function(READER.slice(at, end + 2) + '\nreturn dprPickParagraph;')()
}
const dprPickParagraph = pickFn()

/** 造一个 span 盒。id 只用于断言，算法不读它。 */
const span = (id, l, t, r2, b) => ({ s: { id }, l, t, r2, b })

/** 标准双栏页几何（px，1.5× 缩放的 GFS 量级）：左栏 [81,420]、右栏 [500,834]、页宽 918。
    lineH=行盒高（≈字号），行距 = 1.25×行高（行间隙 0.25×行高 < 0.45 阈值 ⇒ 段内相连），
    段距 = 额外空一行（间隙 ≈ 1.5×行高 > 0.45 ⇒ 段间断开）。 */
const LINE_H = 14, LINE_STEP = 17.5, PARA_STEP = LINE_STEP + LINE_H * 1.2
function column(col, lines, { lineWords = 3 } = {}) {
  // col: 'L' | 'R'；返回展开后的 span 盒（每行 3 个词，词间隙 8px < gapX）
  const l0 = col === 'L' ? 81 : 500, w = 100
  const out = []
  let y = 100
  for (const line of lines) {
    if (line.paraBreak) y += LINE_H * 1.2   // paraBreak = 本行是新段首，行前空出段间隙
    for (let k = 0; k < lineWords; k++) {
      out.push(span(`${line.id}#${k}`, l0 + k * (w + 8), y, l0 + k * (w + 8) + w, y + LINE_H))
    }
    y += LINE_STEP
  }
  return out
}

test('P1 双栏：左栏段落三击只选左栏，右栏一个字都不带（根因①：同行跨栏不再误并）', () => {
  const items = [
    ...column('L', [
      { id: 'LA1' }, { id: 'LA2' }, { id: 'LA3' }, { id: 'LA4' },
      { id: 'LB1', paraBreak: true }, { id: 'LB2' }, { id: 'LB3' },
    ]),
    ...column('R', [
      { id: 'RA1' }, { id: 'RA2' }, { id: 'RA3' },
      { id: 'RB1', paraBreak: true }, { id: 'RB2' }, { id: 'RB3' }, { id: 'RB4' },
    ]),
  ].sort((a, b) => a.t - b.t || a.l - b.l)
  // 三击左栏第二段（LB2 行）
  const lb2 = items.find((it) => it.s.id === 'LB2#1')
  const pick = dprPickParagraph(items, (lb2.l + lb2.r2) / 2, (lb2.t + lb2.b) / 2, 918)
  assert.ok(pick, '命中行必须找到')
  assert.equal(pick.first.id, 'LB1#0', '段首 = 左栏第二段首行最左')
  assert.equal(pick.last.id, 'LB3#2', '段尾 = 左栏第二段末行最右')
})

test('P2 双栏：右栏段落同样成立（根因②：扩段跳过异栏行，不再只看数组相邻项）', () => {
  const items = [
    ...column('L', [{ id: 'LA1' }, { id: 'LA2' }, { id: 'LA3' }]),
    ...column('R', [{ id: 'RA1' }, { id: 'RA2' }, { id: 'RA3' }]),
  ].sort((a, b) => a.t - b.t || a.l - b.l)
  const ra3 = items.find((it) => it.s.id === 'RA3#1')
  const pick = dprPickParagraph(items, (ra3.l + ra3.r2) / 2, (ra3.t + ra3.b) / 2, 918)
  assert.ok(pick, '命中行必须找到')
  assert.equal(pick.first.id, 'RA1#0', '右栏段落从 RA1 选到 RA3——数组相邻项是左栏行，必须被跳过而不是截断')
  assert.equal(pick.last.id, 'RA3#2')
})

test('P3 对照版（babeldoc dual）：原文块与译文块同 top、栏沟宽，三击各自成段（issue #22「双语同页三击没用」）', () => {
  // 对照版几何：左块 [81,760]、右块 [1076,1756]，页宽 1836（实测 gfs-dual 量级）
  const L = [], R = []
  let y = 100
  for (let i = 0; i < 6; i++) {
    L.push(span(`EN${i}`, 81, y, 760, y + LINE_H))
    R.push(span(`ZH${i}`, 1076, y, 1756, y + LINE_H))
    y += LINE_STEP
  }
  // 译文块的独立第二段（原文块同高处是段落间隙）
  y += LINE_H * 1.2
  for (let i = 0; i < 3; i++) { R.push(span(`ZH2-${i}`, 1076, y, 1756, y + LINE_H)); y += LINE_STEP }
  const items = [...L, ...R].sort((a, b) => a.t - b.t || a.l - b.l)
  const zh1 = items.find((it) => it.s.id === 'ZH1')
  const pick = dprPickParagraph(items, (zh1.l + zh1.r2) / 2, (zh1.t + zh1.b) / 2, 1836)
  assert.ok(pick, '命中行必须找到')
  assert.equal(pick.first.id, 'ZH0', '译文第一段：ZH0..ZH5，原文块一个字不带')
  assert.equal(pick.last.id, 'ZH5')
})

test('P4 单栏：段内多行相连、段间断开（初版行为不回归）', () => {
  // p1 两行，p2 两行；段间隙 = PARA_STEP - LINE_H（> 0.45×行高）
  const p2t = 100 + LINE_STEP + PARA_STEP
  const items = [
    span('p1a', 81, 100, 500, 100 + LINE_H), span('p1b', 81, 100 + LINE_STEP, 420, 100 + LINE_STEP + LINE_H),
    span('p2a', 81, p2t, 480, p2t + LINE_H), span('p2b', 81, p2t + LINE_STEP, 300, p2t + LINE_STEP + LINE_H),
  ]
  const pick = dprPickParagraph(items, 300, p2t + LINE_STEP / 2, 918)
  assert.equal(pick.first.id, 'p2a', '命中第二段：只选 p2，不把 p1 连进来')
  assert.equal(pick.last.id, 'p2b')
})

test('P5 整页误并兜底：>60 行连环时退回命中行（宁可少选不多选）', () => {
  const items = []
  let y = 100
  for (let i = 0; i < 80; i++) { items.push(span(`r${i}`, 81, y, 420, y + LINE_H)); y += LINE_STEP }
  const hit = items[40]
  const pick = dprPickParagraph(items, (hit.l + hit.r2) / 2, (hit.t + hit.b) / 2, 918)
  assert.equal(pick.first.id, 'r40', '超过 60 行视为整页误并：退回命中行')
  assert.equal(pick.last.id, 'r40')
})

test('P6 点在栏沟里：返回 null（放回原生行为，不误选）', () => {
  const items = [
    ...column('L', [{ id: 'LA1' }]), ...column('R', [{ id: 'RA1' }]),
  ].sort((a, b) => a.t - b.t || a.l - b.l)
  assert.equal(dprPickParagraph(items, 460, 107, 918), null, '栏沟点击不属于任何行盒')
})

test('P7 居中标题横跨全页且紧贴段落时不把段落 creep 到另一栏（栏区间取交集）', () => {
  // 标题 [200,700] 与左右两栏都有重叠、与段落行间隙 ≤ 阈值（会被并进段落）；
  // 并入后栏区间若取并集就会蔓延到右栏，取交集则不会
  const items = [
    span('title', 200, 100, 700, 114),
    span('LA1#0', 81, 115, 420, 129), span('LA1#1', 430, 115, 700, 129),
    span('LA2#0', 81, 132.5, 420, 146.5),
    span('RA1#0', 500, 115, 834, 129), span('RA2#0', 500, 132.5, 834, 146.5),
  ].sort((a, b) => a.t - b.t || a.l - b.l)
  const la2 = items.find((it) => it.s.id === 'LA2#0')
  const pick = dprPickParagraph(items, 250, (la2.t + la2.b) / 2, 918)
  assert.ok(pick)
  assert.equal(pick.last.id, 'LA2#0')
  assert.ok(!pick.first.id.startsWith('RA'),
    `段首不得落在右栏（实际 ${pick.first.id}）：并入居中标题后栏区间必须收缩为交集，而非并集蔓延`)
})

test('P8 结构守卫：mousedown 三击处理器必须调用 dprPickParagraph（算法与事件层不脱钩）', () => {
  assert.match(READER, /dprPickParagraph\(items, px, py, tlRect\.width\)/,
    '三击 mousedown 必须把 DOM 度量喂给 dprPickParagraph')
  assert.match(READER, /it\.l - ln\.r2 <= gapX/, '归行必须带水平相邻判据（根因①的修复本体）')
})

test('P9 气泡遮蔽回退：第 3 击被双击弹出的气泡挡住时，用首击落点继续（根因③）', () => {
  // 真浏览器实测：三击的第 3 次 mousedown 的 target 是气泡 div（双击选词后气泡恰好弹出
  // 在原位置），closest('.textLayer') 落空 → 静默退回原生行为（选中一个词，「三击没用」）。
  // 守卫三件套：记录首击落点、近距离+短间隔才回退、回退点与 textLayer 一起喂给算法。
  assert.match(READER, /dprLastTlHit = \{ x: e\.clientX, y: e\.clientY, at: Date\.now\(\), tl \}/,
    '必须在 mousedown 捕获阶段记录 textLayer 首击落点')
  assert.match(READER, /Date\.now\(\) - h\.at > 600/, '回退必须限短间隔（600ms 内才算同一次连击）')
  assert.match(READER, /Math\.abs\(h\.x - e\.clientX\) \+ Math\.abs\(h\.y - e\.clientY\) > 8/,
    '回退必须限近距离（8px 内才算同一落点，防止 reinterpret 别处的气泡点击）')
})
