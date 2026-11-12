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
function makeDom({ tracks, tabEl, fullscreen = false, intent = 0, nav = null, hdrRect = null, seatRect = null }) {
  const st = { tabEl } // 可变持有：C3 要中途撤掉锚点
  const center = { style: {} }
  const panel = { style: {} }
  const frameAttrs = fullscreen ? { 'data-rightbar-fullscreen': '' } : {}
  const frame = { attrs: frameAttrs, hasAttribute: (n) => Object.hasOwn(frameAttrs, n) }
  // 红绿灯避让（C10~）用：右栏页签条 + 宿主左上浮动控件（leadingSeat）
  const rect = (r) => () => ({ left: r[0], top: r[1], right: r[2], bottom: r[3], width: (r[2] || 0) - (r[0] || 0), height: (r[3] || 0) - (r[1] || 0) })
  const hdr = hdrRect ? { style: {}, getBoundingClientRect: rect(hdrRect) } : null
  const seat = seatRect ? { getBoundingClientRect: rect(seatRect) } : null
  const col = {
    style: {},
    parentElement: frame,
    previousElementSibling: center,
    querySelector: (sel) => {
      if (sel === '[data-sidebar-right-panel]') return panel
      if (sel === '[class*="tabHostHeader"]') return hdr
      return null
    },
  }
  const iframe = { style: {} }
  const document = {
    querySelector: (sel) => {
      if (sel === '[data-rightbar-col]') return col
      if (sel === '[data-dpr-tab]') return st.tabEl
      if (sel === '[class*="leadingSeat"]') return seat
      return null
    },
  }
  const getComputedStyle = (el) => ({
    gridTemplateColumns: el === frame ? tracks : '',
    getPropertyValue: () => '40', // --dsh-dockkit-dock-layer（全屏层级分支）
  })
  // P5 起 applySwap 还会读「换轨意图」两个模块级变量 + navigator（红绿灯避让的门控）：
  // 由调用方按场景注入；不传时用 Node 自带 navigator（非 Electron → 避让分支整体跳过）
  const applySwap = new Function('document', 'getComputedStyle', 'readerIframeEl', 'swapIntentAt', 'SWAP_INTENT_MS', 'navigator', APPLY_SRC + '\nreturn applySwap')(
    document, getComputedStyle, iframe, intent, 3000, nav ?? navigator,
  )
  return { st, col, center, panel, iframe, hdr, applySwap }
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

test('C7 (P5): 刚点论文（换轨意图新鲜）即便右栏轨还是 0 也先钉列——等轨撑开时已换好，无翻位', () => {
  const { col, center, applySwap } = makeDom({ tracks: '280px 1320px 0px', tabEl: null, intent: Date.now() })
  applySwap()
  assert.equal(col.style.gridColumn, '2', '意图期必须先占宽轨（否则 PDF 先画右边再跳左边）')
  assert.equal(center.style.gridColumn, '3')
})

test('C8 (P5): 意图过期（页签 3s 没出现）→ 回滚撤钉，绝不留宽轨空着/对话被挤窄', () => {
  const { col, center, applySwap } = makeDom({ tracks: '280px 1320px 0px', tabEl: null, intent: Date.now() - 5000 })
  applySwap()
  assert.equal(col.style.gridColumn, '', '意图过期必须恢复官方布局')
  assert.equal(center.style.gridColumn, '')
})

test('C9 (P5): 意图期内但官方其它右栏页签已在（轨宽≥50、无 dpr 页签）→ 仍然先钉（本插件页签马上要开）', () => {
  const { col, applySwap } = makeDom({ tracks: '56px 700px 280px', tabEl: null, intent: Date.now() })
  applySwap()
  assert.equal(col.style.gridColumn, '2')
})

/* ---------- C10~C12：macOS 桌面端红绿灯避让（issue #22 追问实测定位） ----------
   换位生效 + 侧栏收起时，右栏页签条被钉到窗口最左上（实测 left=1/top=0），原生红绿灯
   （≈x 0..70）浮在「论文 PDF」页签文字上；宿主自己的左上浮动控件（leadingSeat，实测
   x 88..152）已为红绿灯让位。避让 = 页签条补 padding-left 到 leadingSeat 右缘 +6。 */
const MAC_NAV = { userAgent: 'Mozilla/5.0 (Macintosh) … Electron/37.1 …', platform: 'MacIntel' }

test('C10: mac 桌面端 + 换位生效 + 页签条贴窗口左上 → padding 腾出红绿灯与浮动控件区', () => {
  // 实测几何：页签条 left=1 top=0；leadingSeat x∈[88,152] y=11 → 让位目标 152+6=158，pad=158-1
  const { hdr, applySwap } = makeDom({ tracks: '56px 700px 280px', tabEl: { style: {} }, nav: MAC_NAV, hdrRect: [1, 0, 705, 36], seatRect: [88, 11, 152, 40] })
  applySwap()
  assert.equal(hdr.style.paddingLeft, '157px', '页签条内容必须让位到 leadingSeat 右缘 +6')
})

test('C10b: mac 桌面端 + 侧栏展开（页签条远离左缘）→ 不加 padding', () => {
  const { hdr, applySwap } = makeDom({ tracks: '280px 700px 280px', tabEl: { style: {} }, nav: MAC_NAV, hdrRect: [381, 0, 1000, 36], seatRect: [88, 11, 152, 40] })
  applySwap()
  assert.equal(hdr.style.paddingLeft, '', '页签条不在红绿灯区，不得加 padding')
})

test('C10c: mac 桌面端 + leadingSeat 不在左上（宿主改版）→ 回落 76px 常量让位', () => {
  const { hdr, applySwap } = makeDom({ tracks: '56px 700px 280px', tabEl: { style: {} }, nav: MAC_NAV, hdrRect: [1, 0, 705, 36], seatRect: [900, 500, 960, 540] })
  applySwap()
  assert.equal(hdr.style.paddingLeft, '75px', '找不到左上浮动控件时按红绿灯常量 76px 让位')
})

test('C10d: mac 桌面端 + 撤换位（页签关了）→ padding 清掉', () => {
  const m = makeDom({ tracks: '56px 700px 0px', tabEl: null, nav: MAC_NAV, hdrRect: [1, 0, 705, 36], seatRect: [88, 11, 152, 40] })
  m.hdr.style.paddingLeft = '157px' // 先处于避让态
  m.applySwap()
  assert.equal(m.hdr.style.paddingLeft, '', '撤换位必须清掉避让 padding')
})

test('C11: 浏览器（非 Electron UA）→ 避让分支零行为，页签条不被碰', () => {
  const { hdr, applySwap } = makeDom({ tracks: '56px 700px 280px', tabEl: { style: {} }, nav: { userAgent: 'Mozilla/5.0 (Macintosh) Safari', platform: 'MacIntel' }, hdrRect: [1, 0, 705, 36], seatRect: [88, 11, 152, 40] })
  applySwap()
  assert.equal(hdr.style.paddingLeft, undefined, '浏览器没有左上原生控件，不得改页签条')
})

test('C12: Windows 桌面端（红绿灯在右侧）→ 同样零行为', () => {
  const { hdr, applySwap } = makeDom({ tracks: '56px 700px 280px', tabEl: { style: {} }, nav: { userAgent: 'Mozilla/5.0 (Windows) Electron/37', platform: 'Win32' }, hdrRect: [1, 0, 705, 36] })
  applySwap()
  assert.equal(hdr.style.paddingLeft, undefined, 'Win 端窗口控件在右上，左上无需避让')
})
