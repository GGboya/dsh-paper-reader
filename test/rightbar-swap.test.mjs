// test/rightbar-swap.test.mjs — applySwap 布局换位的判定契约（#10 回归守卫）。
//
// 守什么：
//   · 换位（rightbar 列 ↔ center 列互换）只在 **dpr 页签开着** 时发生——只看右栏轨宽
//     会让任何右侧栏页签（官方文件预览 / present 卡片）在普通会话里把对话挤到最右（#10）。
//   · 锚点消失带 1500ms 迟滞（=切换护栏窗口宽）：seat 重绑的空窗期锚点瞬时消失，追着
//     撤钉会复现当年修掉的「整屏闪」——迟滞期内换位必须保持。
//
// 怎么守：不重写实现，直接从 lib/client.js 抽出 setStyle+applySwap 真源码，在假 DOM 里
// 跑（同 reader-ux-verification 的「源码区段抽取 + 独立复算」套路）。改坏实现 → 对应
// 用例变红；抽取标记被重构掉 → C0 直接报错指认，不会静默漏守。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeEol } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT = normalizeEol(readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8'))

/* ---------- C0：抽取 setStyle + applySwap 真源码（标记被重构走就大声失败） ---------- */
const SRC_START = CLIENT.indexOf('const setStyle = (el, prop, val)')
const SRC_MID = CLIENT.indexOf('let lastPdfTabAt = 0')
const SRC_END = CLIENT.indexOf('const tick = () => {')
assert.ok(SRC_START >= 0 && SRC_END > SRC_START, 'lib/client.js 抽取标记 setStyle/tick 仍在')
assert.ok(SRC_MID > SRC_START && SRC_MID < SRC_END, 'lib/client.js 含 lastPdfTabAt 迟滞状态（重构后请同步本测试）')
const APPLY_SRC = CLIENT.slice(SRC_START, SRC_END)

/* ---------- 假 DOM：只实现 applySwap 用到的面 ---------- */
function makeDom({ tracks, tabEl, fullscreen = false }) {
  const st = { tabEl } // 可变持有：C3 要中途撤掉锚点
  const center = { style: {} }
  const panel = { style: {} }
  const frameAttrs = fullscreen ? { 'data-rightbar-fullscreen': '' } : {}
  const frame = { attrs: frameAttrs, hasAttribute: (n) => Object.hasOwn(frameAttrs, n) }
  const col = {
    style: {},
    parentElement: frame,
    previousElementSibling: center,
    querySelector: (sel) => (sel === '[data-sidebar-right-panel]' ? panel : null),
  }
  const iframe = { style: {} }
  const document = {
    querySelector: (sel) => {
      if (sel === '[data-rightbar-col]') return col
      if (sel === '[data-dpr-tab]') return st.tabEl
      return null
    },
  }
  const getComputedStyle = (el) => ({
    gridTemplateColumns: el === frame ? tracks : '',
    getPropertyValue: () => '40', // --dsh-dockkit-dock-layer（全屏层级分支）
  })
  const applySwap = new Function('document', 'getComputedStyle', 'readerIframeEl', APPLY_SRC + '\nreturn applySwap')(
    document, getComputedStyle, iframe,
  )
  return { st, col, center, panel, iframe, applySwap }
}

/* 行尾无关地确认锚点标记在 PdfTab 上（C6 源码契约） */
test('C6: PdfTab 锚点带 data-dpr-tab 标记，applySwap 引用它', () => {
  assert.match(CLIENT, /'data-dsh-surface': 'rightbar-tab-anchor',\s*\n\s*'data-dpr-tab': '1',/,
    'PdfTab 锚点必须携带 data-dpr-tab（applySwap 的换位依据）')
  assert.ok(APPLY_SRC.includes("querySelector('[data-dpr-tab]')"), 'applySwap 必须查询 [data-dpr-tab]')
  assert.ok(/Date\.now\(\) - lastPdfTabAt < 1500/.test(APPLY_SRC), '迟滞窗口必须 ≥ 切换护栏 1500ms')
})

test('C1 (#10): 普通会话右栏开着文件预览（轨宽 ≥50）但没有 dpr 页签 → 不换位', () => {
  const { col, center, panel, applySwap } = makeDom({ tracks: '56px 700px 280px', tabEl: null })
  applySwap()
  assert.equal(col.style.gridColumn, '', 'rightbar 列不得钉到第 2 轨')
  assert.equal(center.style.gridColumn, '', '对话列不得被挤到第 3 轨')
  assert.equal(panel.style.maxWidth, '', '面板宽度钳制不得生效')
})

test('C2: dpr 页签开着 + 轨宽 ≥50 → 换位（PDF 列居中、对话列居右）', () => {
  const { col, center, panel, applySwap } = makeDom({ tracks: '56px 700px 280px', tabEl: { style: {} } })
  applySwap()
  assert.equal(col.style.gridColumn, '2')
  assert.equal(center.style.gridColumn, '3')
  assert.equal(panel.style.maxWidth, '100%')
  assert.equal(panel.style.minWidth, '100%')
})

test('C3: 锚点消失的迟滞——护栏窗口内保持换位（不闪），过期后撤钉', () => {
  const realNow = Date.now
  try {
    let now = 1_000_000
    Date.now = () => now
    const dom = makeDom({ tracks: '56px 700px 280px', tabEl: { style: {} } })
    dom.applySwap() // 开着页签：记下 lastPdfTabAt
    dom.st.tabEl = null // seat 重绑空窗期：锚点消失
    now += 1000 // 护栏窗口（1500ms）内
    dom.applySwap()
    assert.equal(dom.col.style.gridColumn, '2', '护栏窗口内换位必须保持（否则整屏闪）')
    now += 1600 // 超过迟滞窗口：页签确实没了
    dom.applySwap()
    assert.equal(dom.col.style.gridColumn, '', '迟滞过期后必须撤钉恢复官方布局')
  } finally {
    Date.now = realNow
  }
})

test('C4: dpr 页签开着但右栏折叠（第 3 轨≈0）→ 不换位', () => {
  const { col, applySwap } = makeDom({ tracks: '56px 1000px 0px', tabEl: { style: {} } })
  applySwap()
  assert.equal(col.style.gridColumn, '')
})

test('C5: 全屏态优先于换位——不换位且阅读器层级抬到 dockLayer+2', () => {
  const { col, iframe, applySwap } = makeDom({ tracks: '56px 700px 280px', tabEl: { style: {} }, fullscreen: true })
  applySwap()
  assert.equal(col.style.gridColumn, '', '全屏时不做列换位')
  assert.equal(iframe.style.zIndex, '42', '全屏时阅读器 iframe 层级 = dockLayer(40)+2')
})
