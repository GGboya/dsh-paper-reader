// test/reader-resume-position.test.mjs — 阅读位置记忆：每篇论文记住「读到哪」，切走再切回 / 关掉重开接着读。
//
// 背景：维护者反馈「看到一半切到另一篇，进度就丢了，切回去又从第一页开始」。根因不是回归——
// reader 的 openPaper 一直写死 `curPage = opts.page || 1`，按篇持久化的只有语言版本，从没有「读到哪」。
//
// 守什么：
//   P  把 reader「阅读位置记忆」源码段整段抽出来真跑：记什么（滚动 = 顶端页 + 页内比例；翻页 = 页号）、
//      什么时候不记（阅读器不可见 / 正在换文献）、怎么恢复（瞬时定位、分屏对齐、隐藏时先留着）、
//      换了论文的待恢复项必须作废。
//   S  结构断言：存位置发生在换论文之前（否则记的是新论文的第一页）；没带跳转页码才恢复；
//      首帧画完 / 补画完落地；页面卸载、转后台时落盘。
//   M  宿主侧：论文 / 专题改名时 `dpr.page.` 键跟着搬家（与语言版本记忆同一套）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReaderScript } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const { script: READER } = readReaderScript(join(REPO, 'reader', 'index.html'))
const CLIENT = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

const SECTION_START = '/* ================= 阅读位置记忆（按篇） ================='
const SECTION_END = "$('pdf-pane').addEventListener('scroll', schedulePosSave, { passive: true });"

/** 抽出阅读位置记忆源码段（找不到就大声失败，不会静默漏守）。 */
function sectionSource() {
  const start = READER.indexOf(SECTION_START)
  const end = READER.indexOf(SECTION_END)
  assert.ok(start >= 0, 'reader/index.html 必须有「阅读位置记忆（按篇）」源码段')
  assert.ok(end > start, '阅读位置记忆源码段必须以滚动监听收尾（重构后请同步本测试）')
  return READER.slice(start, end + SECTION_END.length)
}

/** 假环境：可控的状态 + 记录调用的桩。geometry = 页几何 [{page, offsetTop, offsetHeight}]。 */
function makeEnv({ geometry, scrollTop = 0, clientHeight = 600, state = {}, store: init = new Map() } = {}) {
  const calls = { ensureLazy: [], align: [], pager: 0, writes: [] }
  const winHandlers = new Map()
  const docHandlers = new Map()
  const document = { addEventListener: (t, h) => docHandlers.set(t, h), visibilityState: 'visible' }
  const pages = { children: (geometry ?? []).map((g) => ({ className: 'page', dataset: { page: String(g.page) }, offsetTop: g.offsetTop, offsetHeight: g.offsetHeight })) }
  const nodes = new Map((geometry ?? []).map((g) => [g.page, { offsetTop: g.offsetTop, offsetHeight: g.offsetHeight }]))
  const paneHandlers = new Map()
  const timers = []
  const pane = { scrollTop, clientHeight, addEventListener: (t, h) => paneHandlers.set(t, h) }
  const S = {
    pageMode: 'scroll', curPage: 1, current: { topic: 'T', name: 'A' }, pdfDoc: { numPages: (geometry ?? []).length },
    openingPaper: false, lazyView: null, viewMode: 'orig', ...state,
  }
  const store = init
  const body = `
let { pageMode, curPage, current, pdfDoc, openingPaper, lazyView, viewMode } = S;
${sectionSource()}
return {
  readPos, savePosNow, consumeRestore, schedulePosSave,
  set: (patch) => { ({ pageMode, curPage, current, pdfDoc, openingPaper, lazyView, viewMode } = { pageMode, curPage, current, pdfDoc, openingPaper, lazyView, viewMode, ...patch }) },
  pending: () => pendingRestore,
  arm: (r) => { pendingRestore = r },
  curPage: () => curPage,
}`
  const api = new Function('S', 'localStorage', '$', 'anchorOf', 'columnPages', 'origPageNode', 'ensureLazyPage', 'splitCols', 'alignSplit', 'updatePager', 'window', 'document', 'setTimeout', body)(
    S,
    { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); calls.writes.push(k) } },
    (id) => (id === 'pdf-pane' ? pane : pages),
    // 与 reader 里同名的纯函数：直接取真实现，不在这里另写一份
    anchorOfImpl, (box) => box.children.map((d) => ({ page: +d.dataset.page || 1, offsetTop: d.offsetTop, offsetHeight: d.offsetHeight })),
    (n) => nodes.get(n) ?? null,
    (n) => { calls.ensureLazy.push(n); return Promise.resolve() },
    () => [{ pane: 'orig-col' }, { pane: 'zh-col' }],
    (src) => calls.align.push(src.pane),
    () => { calls.pager++ },
    { addEventListener: (t, h) => winHandlers.set(t, h) },
    document,
    (fn, ms) => { timers.push({ fn, ms }); return timers.length }, // 假定时器：由用例决定什么时候到点
  )
  return { api, calls, store, pane, winHandlers, docHandlers, document, timers, paneHandlers, flush: () => { for (const t of timers.splice(0)) t.fn() } }
}

// anchorOf 直接取 reader 里的真实现（不在这里手抄一份：抄本会悄悄漂移）
const ANCHOR_SRC = READER.slice(READER.indexOf('function anchorOf('), READER.indexOf('/** 纯函数：锚点 → 目标列 scrollTop'))
const anchorOfImpl = new Function(`${ANCHOR_SRC}\nreturn anchorOf`)()

const GEO = [1, 2, 3, 4].map((p) => ({ page: p, offsetTop: (p - 1) * 1000, offsetHeight: 1000 }))

// ═══════════════════════════════════════════════════════════════════════════
// P. 行为
// ═══════════════════════════════════════════════════════════════════════════

test('P0 阅读位置记忆源码段存在；anchorOf 取自 reader 源码本体且行为符合预期', () => {
  assert.ok(sectionSource().length > 1500, '阅读位置记忆源码段非空')
  assert.ok(ANCHOR_SRC.includes('return { page: page.page, ratio:'), '必须取到 reader 的 anchorOf 本体')
  assert.equal(anchorOfImpl([], 0), null)
  assert.deepEqual(anchorOfImpl(GEO, 2350), { page: 3, ratio: 0.35 })
  assert.deepEqual(anchorOfImpl(GEO, 99999), { page: 4, ratio: 96.999 }) // anchorOf 自己不夹比例：滚过头就是末页 + 超出的比例
  // ⇒ 所以 livePos 存盘前必须把比例夹到 [0, 1)（P2），readPos 读回时再夹一次（P1）
})

test('P1 readPos：只认 {p ≥ 1 的整数, r}；脏值一律当没有；页内比例夹到 [0, 1)', () => {
  const { api, store } = makeEnv()
  assert.equal(api.readPos('T', 'A'), null, '没存过')
  for (const bad of ['null', '{', '[]', '"x"', '{"p":0,"r":0}', '{"p":-3}', '{"p":1.5}', '{"p":"3"}', '123']) {
    store.set('dpr.page.T/A', bad)
    assert.equal(api.readPos('T', 'A'), null, `脏值 ${bad} 必须当没有`)
  }
  store.set('dpr.page.T/A', '{"p":3,"r":0.25}')
  assert.deepEqual(api.readPos('T', 'A'), { p: 3, r: 0.25 })
  store.set('dpr.page.T/A', '{"p":3}')
  assert.deepEqual(api.readPos('T', 'A'), { p: 3, r: 0 }, '缺比例按页顶')
  store.set('dpr.page.T/A', '{"p":3,"r":-0.5}')
  assert.deepEqual(api.readPos('T', 'A'), { p: 3, r: 0 })
  store.set('dpr.page.T/A', '{"p":3,"r":7}')
  assert.deepEqual(api.readPos('T', 'A'), { p: 3, r: 0.99 })
  store.set('dpr.page.T/A', '{"p":3,"r":"x"}')
  assert.deepEqual(api.readPos('T', 'A'), { p: 3, r: 0 })
  // 键按篇：不同专题 / 论文互不串
  assert.equal(api.readPos('T', 'B'), null)
  assert.equal(api.readPos('U', 'A'), null)
})

test('P2 滚动模式记「视口顶端所在页 + 页内比例」（不是观察器回写的 curPage）；翻页模式只记页号', () => {
  let env = makeEnv({ geometry: GEO, scrollTop: 2350, state: { curPage: 1 } })
  env.api.savePosNow()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 3, r: 0.35 }, '顶端在第 3 页 35% 处——与 curPage 的旧值无关')
  env = makeEnv({ geometry: GEO, scrollTop: 0, state: { curPage: 2 } })
  env.api.savePosNow()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 1, r: 0 })
  env = makeEnv({ geometry: GEO, scrollTop: 2350, state: { curPage: 4, pageMode: 'paged' } })
  env.api.savePosNow()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 4, r: 0 }, '翻页模式：页号 + 比例 0')
})

test('P3 不该记的时候不记：还没打开文献 / 没有文档 / 正在换文献 / 滚动模式下阅读器不可见——不许拿坏数据覆盖好数据', () => {
  const before = '{"p":3,"r":0.35}'
  for (const [what, opts] of [
    ['没打开文献', { geometry: GEO, scrollTop: 0, state: { current: null } }],
    ['文档未就绪', { geometry: GEO, scrollTop: 0, state: { pdfDoc: null } }],
    ['正在换文献', { geometry: GEO, scrollTop: 0, state: { openingPaper: true } }],
    ['滚动模式下不可见', { geometry: GEO, scrollTop: 0, clientHeight: 0 }],
  ]) {
    const env = makeEnv({ ...opts, store: new Map([['dpr.page.T/A', before]]) })
    env.api.savePosNow()
    assert.equal(env.store.get('dpr.page.T/A'), before, `${what}：不得写`)
    assert.deepEqual(env.calls.writes, [], `${what}：一次写都不该有`)
  }
  // 翻页模式下不可见也记：页号不依赖滚动位置，是可信的
  const env = makeEnv({ geometry: GEO, scrollTop: 0, clientHeight: 0, state: { pageMode: 'paged', curPage: 4 } })
  env.api.savePosNow()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 4, r: 0 })
})

test('P4 滚动模式恢复：瞬时定位到「同一页 + 同一页内比例」，懒渲染补画该页，分屏时另一列跟着对齐', () => {
  let env = makeEnv({ geometry: GEO, scrollTop: 0, state: { lazyView: {} } })
  env.api.arm({ key: 'T/A', p: 3, r: 0.35 })
  env.api.consumeRestore()
  assert.equal(env.pane.scrollTop, 2350, 'offsetTop(2000) + 0.35 × 1000')
  assert.equal(env.api.pending(), null, '落地后销账')
  assert.deepEqual(env.calls.ensureLazy, [3], '目标页若还是占位要补画')
  assert.deepEqual(env.calls.align, [], '非分屏不对齐')
  assert.ok(env.calls.pager >= 1, '页码控件要刷新')
  // 分屏
  env = makeEnv({ geometry: GEO, scrollTop: 0, state: { viewMode: 'split' } })
  env.api.arm({ key: 'T/A', p: 2, r: 0.6 })
  env.api.consumeRestore()
  assert.equal(env.pane.scrollTop, 1600)
  assert.deepEqual(env.calls.align, ['orig-col'], '分屏：以原文列为基准对齐另一列')
  // 页号超出文档页数 ⇒ 夹到末页；不足 1 ⇒ 夹到第 1 页
  env = makeEnv({ geometry: GEO })
  env.api.arm({ key: 'T/A', p: 99, r: 0.1 })
  env.api.consumeRestore()
  assert.equal(env.pane.scrollTop, 3100, '夹到末页（第 4 页）后再按比例定位')
  env.api.arm({ key: 'T/A', p: 0, r: 0 })
  env.api.consumeRestore()
  assert.equal(env.pane.scrollTop, 0)
})

test('P5 首帧不可见时先留着不动（那时滚动位置不可信），可见后 / 补画出页节点后再落地', () => {
  // ① 阅读器收起着：不定位、不清账
  let env = makeEnv({ geometry: GEO, scrollTop: 0, clientHeight: 0 })
  env.api.arm({ key: 'T/A', p: 3, r: 0.35 })
  env.api.consumeRestore()
  assert.equal(env.pane.scrollTop, 0)
  assert.deepEqual(env.api.pending(), { key: 'T/A', p: 3, r: 0.35 }, '待恢复项必须留着')
  // ② 面板出来了、页节点也在：补画完成的那一拍（rerender 的 done）落地
  env.pane.clientHeight = 600
  env.api.consumeRestore()
  assert.equal(env.pane.scrollTop, 2350)
  assert.equal(env.api.pending(), null)
  // ③ 可见、页号也在范围内，但那个页节点还没画出来：同样留着，下一次渲染完成再试
  env = makeEnv({ geometry: [GEO[0], GEO[2], GEO[3]], scrollTop: 0 }) // 缺第 2 页的节点
  env.api.arm({ key: 'T/A', p: 2, r: 0.4 })
  env.api.consumeRestore()
  assert.deepEqual(env.api.pending(), { key: 'T/A', p: 2, r: 0.4 }, '页节点缺失时不得把待恢复项丢掉')
  assert.equal(env.pane.scrollTop, 0, '也不得瞎滚')
  // ④ 记忆的页已经超出文档页数（PDF 换过）：夹到末页落地，不留悬案
  env = makeEnv({ geometry: GEO.slice(0, 2), scrollTop: 0 })
  env.api.arm({ key: 'T/A', p: 4, r: 0.5 })
  env.api.consumeRestore()
  assert.equal(env.api.pending(), null)
  assert.equal(env.pane.scrollTop, 1500, '末页（第 2 页）50% 处')
})

test('P6 翻页模式：首帧由 openPaper 直接画在记忆页上，这里只销账——不许再改 curPage（隐藏期间用户翻过的页才算数）', () => {
  const env = makeEnv({ geometry: GEO, state: { pageMode: 'paged', curPage: 7 } })
  env.api.arm({ key: 'T/A', p: 3, r: 0.9 })
  env.api.consumeRestore()
  assert.equal(env.api.pending(), null)
  assert.equal(env.api.curPage(), 7, '不得把用户翻到的页改回记忆页')
  assert.equal(env.pane.scrollTop, 0, '翻页模式不碰滚动')
})

test('P7 换了论文：上一篇留下的待恢复项必须作废，不会错落到新论文上', () => {
  const env = makeEnv({ geometry: GEO, scrollTop: 0 })
  env.api.arm({ key: 'T/OLD', p: 3, r: 0.35 })
  env.api.set({ current: { topic: 'T', name: 'NEW' } })
  env.api.consumeRestore()
  assert.equal(env.api.pending(), null)
  assert.equal(env.pane.scrollTop, 0, '新论文不得被滚到旧论文的位置')
  // 文档还没就绪：留着（马上就有），不丢
  env.api.arm({ key: 'T/NEW', p: 2, r: 0 })
  env.api.set({ pdfDoc: null })
  env.api.consumeRestore()
  assert.deepEqual(env.api.pending(), { key: 'T/NEW', p: 2, r: 0 })
  env.api.set({ pdfDoc: { numPages: 4 } })
  env.api.consumeRestore()
  assert.equal(env.pane.scrollTop, 1000)
})

test('P8 页面卸载 / 转后台时落盘；保持可见时不写', () => {
  const env = makeEnv({ geometry: GEO, scrollTop: 1250 })
  const onHide = env.winHandlers.get('pagehide')
  const onVis = env.docHandlers.get('visibilitychange')
  assert.equal(typeof onHide, 'function', 'pagehide 要监听（关标签页 / 退出应用）')
  assert.equal(typeof onVis, 'function', 'visibilitychange 要监听（切到后台）')
  env.document.visibilityState = 'visible'
  onVis()
  assert.equal(env.store.get('dpr.page.T/A'), undefined, '可见时不写')
  env.document.visibilityState = 'hidden'
  onVis()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 2, r: 0.25 }, '转后台：落盘')
  env.store.clear()
  env.pane.scrollTop = 3100
  onHide()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 4, r: 0.1 }, '页面卸载：落盘')
})

test('P9 阅读过程中顺手落盘（节流）：连着滚很多次也只在停顿后写一次，写的是最新位置；不可见时到点也不写', () => {
  const env = makeEnv({ geometry: GEO, scrollTop: 0 })
  const onScroll = env.paneHandlers.get('scroll')
  assert.equal(typeof onScroll, 'function', '滚动要挂上节流落盘')
  for (const y of [300, 600, 900, 1200, 1500]) { env.pane.scrollTop = y; onScroll(); onScroll() }
  assert.equal(env.timers.length, 1, '节流：已经排着队就不再排')
  assert.equal(env.timers[0].ms, 400)
  assert.equal(env.calls.writes.length, 0, '到点之前不写')
  env.flush()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 2, r: 0.5 }, '写的是到点那一刻的位置')
  env.pane.scrollTop = 2500
  onScroll()
  env.flush()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 3, r: 0.5 }, '下一次滚动 → 再写一次')
  // 排队期间面板没了布局：到点也不写，旧存档原样保留（不许拿 scrollTop=0 把进度冲掉）
  env.pane.clientHeight = 0
  env.pane.scrollTop = 0
  onScroll()
  env.flush()
  assert.deepEqual(JSON.parse(env.store.get('dpr.page.T/A')), { p: 3, r: 0.5 })
})

// ═══════════════════════════════════════════════════════════════════════════
// S. 结构
// ═══════════════════════════════════════════════════════════════════════════

function openPaperSource() {
  const start = READER.indexOf('async function openPaper(')
  assert.ok(start >= 0, 'reader 必须有 openPaper')
  return READER.slice(start, READER.indexOf('async function refreshZhState', start))
}

test('S1 存位置发生在换论文之前：savePosNow() 排在 current 换人与第一处 await 之前（否则记的是新论文的第一页）', () => {
  const open = openPaperSource()
  const atSave = open.indexOf('savePosNow();')
  const atCurrent = open.indexOf('current = { topic, name };')
  const atFirstAwait = open.indexOf('await ')
  assert.ok(atSave > 0, 'openPaper 开头必须先存上一篇的阅读位置')
  assert.ok(atCurrent > atSave, '存位置必须在 current 换人之前')
  assert.ok(atFirstAwait > atSave, '存位置必须是同步的、排在第一处 await 之前')
})

test('S2 没带跳转页码才恢复（引文跳转以跳转为准）；翻页模式首帧直接画在记忆页上；首帧画完落地', () => {
  const open = openPaperSource()
  assert.match(open, /const resume = opts\.page \? null : readPos\(topic, name\);/, '带页码 = 引文跳转，不恢复')
  assert.match(open, /curPage = opts\.page \|\| \(resume \? resume\.p : 1\);/, '页码：跳转页 > 记忆页 > 第一页')
  assert.match(open, /if \(opts\.page\) jumpTo\(opts\.page, opts\.q\);[^\n]*\n\s+else consumeRestore\(\);/, '首帧画完后恢复位置')
  assert.match(READER, /function rerender\(\) \{[\s\S]{0,400}consumeRestore\(\);/, '补画（rerender 完成）时也要落地——首帧可能因悬浮层隐藏被跳过')
  // 调用点不得反向改回「换论文从第一页开始」
  assert.ok(!/curPage = opts\.page \|\| 1\b/.test(READER), '不得再写死「换论文从第一页开始」')
})

test('S3 三条入口都把「没带页码」如实传到 openPaper：原地切换、整页回退、重启后的首屏', () => {
  // 宿主 → 阅读器的原地切换：page 为 0 表示「普通打开」
  assert.match(CLIENT, /win\.postMessage\(\{ type: 'dpr:open', topic: c\.topic, name: c\.name, page: c\.page \|\| 0, q: c\.q \|\| '' \}/)
  // 阅读器消息处理：page 0 → undefined（不带页码），只有引文跳转才带页码
  assert.match(READER, /queuedOpenRequest = \{ topic, name, page, q \};/)
  assert.match(READER, /openPaper\(req\.topic, req\.name, \{ page: req\.page \|\| undefined, q: req\.q \|\| undefined \}\)/)
  // 首屏 bootstrap：URL 没带 page 时同样是「不带页码」
  assert.match(READER, /await openPaper\(target\.topic, target\.name, \{ page: pPage, q: pQ \}\);/)
})

test('S4 页码一变（翻页 / 滚动跨页 / 跳转）都会经过 updatePager ⇒ 在那里顺手落盘', () => {
  const start = READER.indexOf('function updatePager() {')
  assert.ok(start >= 0, 'reader 必须有 updatePager')
  const body = READER.slice(start, READER.indexOf('\n}', start))
  assert.match(body, /schedulePosSave\(\);/, 'updatePager 末尾要触发节流落盘')
})

test('D1 文档同步：两份 README 与两份功能文档都交代了「记住读到哪」', () => {
  const zh = /记住读到哪|记住每篇论文读到哪/
  const en = /remembers where you stopped/
  for (const [f, re] of [['README.md', zh], ['README_EN.md', en], ['docs/features.md', zh], ['docs/features_EN.md', en]]) {
    const text = readFileSync(join(REPO, f), 'utf8').replaceAll('**', '')
    assert.match(text, re, `${f} 必须写到阅读位置记忆`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// M. 宿主侧：改名 / 移动时阅读位置跟着搬家
// ═══════════════════════════════════════════════════════════════════════════

function migrateLsKeys(store) {
  const start = CLIENT.indexOf('function migrateLsKeys(')
  assert.ok(start >= 0, 'lib/client.js 必须有 migrateLsKeys')
  const end = CLIENT.indexOf('\n    }\n', start)
  const localStorage = {
    get length() { return store.size },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
  return new Function('localStorage', `${CLIENT.slice(start, end + 6)}\nreturn migrateLsKeys`)(localStorage)
}

test('M1 论文改名 / 专题改名：dpr.page. 键与语言版本、会话序号一起搬家；全局键不动', () => {
  const store = new Map([
    ['dpr.page.T1/P1', '{"p":7,"r":0.4}'], ['dpr.variant.T1/P1', 'zh'], ['dpr.sessionN.T1/P1', '2'],
    ['dpr.page.T1X/P9', '{"p":2,"r":0}'], ['dpr.syncScroll', '0'],
  ])
  const migrate = migrateLsKeys(store)
  migrate('T1', 'T2', 'P1', 'P2')
  assert.equal(store.get('dpr.page.T2/P2'), '{"p":7,"r":0.4}', '论文改名：阅读位置跟到新名字')
  assert.equal(store.has('dpr.page.T1/P1'), false, '旧键删除')
  assert.equal(store.get('dpr.variant.T2/P2'), 'zh')
  migrate('T2', 'X/T2', null, null)
  assert.equal(store.get('dpr.page.X/T2/P2'), '{"p":7,"r":0.4}', '专题改名：整棵前缀的阅读位置一起搬')
  assert.equal(store.has('dpr.page.T2/P2'), false)
  assert.equal(store.get('dpr.page.T1X/P9'), '{"p":2,"r":0}', '同前缀的别的专题（T1X）不得被误伤')
  assert.equal(store.get('dpr.syncScroll'), '0', '全局键不动')
})
