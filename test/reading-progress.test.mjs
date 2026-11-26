// test/reading-progress.test.mjs — 侧栏每篇论文的阅读进度 + 专题→论文层级。
//
// 交互契约（维护者在静态 mock 中选定）：一行标题 + 右侧百分比 + 2px 细线；
// 百分比 = 当前页 / 总页数，回看前文会下降；未读不画空条，末页绿色完成。
// 数据复用 dpr.page. 阅读位置（新增 n/u），不引入第二份进度存档。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const CLIENT = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
const READER = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')

function loadPure() {
  const ctx = { window: { __ModuleLoader__: { load: () => {} } }, console, atob }
  vm.createContext(ctx)
  vm.runInContext(`${CLIENT}\n;globalThis.__pure = { progress: dprReadingProgress, legacy: dprReadingPositionLegacy, tip: dprReadingProgressTipPosition };`, ctx, { filename: 'client-reading-progress.js' })
  return ctx.__pure
}
const pure = loadPure()
const clean = (v) => JSON.parse(JSON.stringify(v))

test('P1 进度只认当前页 + 总页数；旧版 {p,r} 可继续恢复位置但不伪造百分比', () => {
  assert.deepEqual(clean(pure.progress('{"p":7,"r":0.35,"n":13,"u":1764200000000}')), { p: 7, n: 13, u: 1764200000000, percent: 54 })
  assert.deepEqual(clean(pure.progress({ p: 11, n: 11, u: 0 })), { p: 11, n: 11, u: 0, percent: 100 })
  assert.deepEqual(clean(pure.progress({ p: 99, n: 20 })), { p: 20, n: 20, u: 0, percent: 100 }, 'PDF 换过、旧页码超界时夹到末页')
  assert.equal(pure.progress('{"p":7,"r":0.35}'), null, '旧存档缺总页数：不伪造百分比')
  assert.equal(pure.legacy('{"p":7,"r":0.35}'), true, '旧存档单独标成“续读”，不能误称未读')
  assert.equal(pure.legacy('{"p":7,"r":0.35,"n":13}'), false)
  assert.equal(pure.legacy('{"p":0}'), false)
  assert.equal(pure.legacy('{"p":7,"n":0}'), false, '坏总页数不是可识别的旧存档')
  for (const bad of [null, '', '{', '[]', '123', {}, { p: 0, n: 10 }, { p: 1.5, n: 10 }, { p: 1, n: 0 }, { p: 1, n: 2.5 }, { p: '1', n: 10 }]) {
    assert.equal(pure.progress(bad), null, `坏数据不得显示进度：${JSON.stringify(bad)}`)
  }
})

test('P2 百分比四舍五入，时间戳缺失或为坏值时安全降级为空', () => {
  assert.equal(pure.progress({ p: 1, n: 3 }).percent, 33)
  assert.equal(pure.progress({ p: 2, n: 3 }).percent, 67)
  assert.equal(pure.progress({ p: 1, n: 200 }).percent, 1)
  assert.equal(pure.progress({ p: 1, n: 3, u: -1 }).u, 0)
  assert.equal(pure.progress({ p: 1, n: 3, u: 'today' }).u, 0)
  assert.equal(pure.progress({ p: 1, n: 3, u: Infinity }).u, 0)
  assert.equal(pure.progress({ p: 1, n: 3, u: 8640000000000001 }).u, 0, '超出 Date 范围的时间不得进入 UI')
})

test('P3 悬停详情保持在视口内：默认下方，底部翻上方，左右夹取，坏几何不显示', () => {
  const viewport = { width: 1000, height: 800 }
  assert.deepEqual(clean(pure.tip({ left: 20, top: 100, bottom: 135 }, viewport)), { left: 40, top: 142, width: 236, placement: 'below' })
  assert.deepEqual(clean(pure.tip({ left: 20, top: 700, bottom: 735 }, viewport)), { left: 40, top: 589, width: 236, placement: 'above' })
  assert.equal(pure.tip({ left: 900, top: 100, bottom: 135 }, viewport).left, 756)
  const narrow = pure.tip({ left: 100, top: 20, bottom: 50 }, { width: 200, height: 300 })
  assert.equal(narrow.left, 8)
  assert.equal(narrow.width, 184)
  assert.equal(pure.tip(null, viewport), null)
  assert.equal(pure.tip({ left: NaN, top: 0, bottom: 1 }, viewport), null)
  assert.equal(pure.tip({ left: 0, top: 0, bottom: 1 }, { width: 0, height: 0 }), null)
})

test('S1 阅读器落盘 {p,r,n,u} 并广播；宿主只接受本插件 iframe 的合法进度消息', () => {
  assert.match(READER, /const pos = \{ \.\.\.livePos\(\), n: pdfDoc\.numPages, u: Date\.now\(\) \}/)
  assert.match(READER, /postToParent\(\{ type: 'dpr:reading-progress', topic: current\.topic, name: current\.name, \.\.\.pos \}\)/)
  assert.match(CLIENT, /if \(!win \|\| e\.source !== win\) return/)
  assert.match(CLIENT, /d\.type === 'dpr:reading-progress'[\s\S]{0,300}dprReadingProgress\(d\)/)
  assert.match(CLIENT, /new CustomEvent\('dpr:reading-progress'/)
  assert.match(CLIENT, /window\.addEventListener\('storage', onStorage\)/, '其它同源标签页改进度也要刷新')
})

test('S2 选定的细线 UI 落在论文行：百分比、2px 轨道、末页完成态、键盘可触发的详情浮层', () => {
  assert.match(CLIENT, /paperItem: \{ minHeight: '35px'/)
  assert.match(CLIENT, /progressTrack: \{[^\n]*height: '2px'/)
  assert.match(CLIENT, /className: 'dpr-progress-pct'/)
  assert.match(CLIENT, /className: 'dpr-progress-fill'/)
  assert.match(CLIENT, /complete \? h\(LibraryIcon, \{ name: 'check', size: 11 \}\)/)
  assert.match(CLIENT, /else if \(dprReadingPositionLegacy\(raw\)\)/, '旧位置必须进入“续读”分支')
  assert.match(CLIENT, /legacy \? t\('progressLegacyShort'\)/)
  assert.match(CLIENT, /onMouseEnter: \(e\) => \{ if \(!renamingThisPaper\) showProgressTip/)
  assert.match(CLIENT, /onFocus: \(e\) => \{ if \(e\.target === e\.currentTarget && !renamingThisPaper\) showProgressTip/)
  assert.match(CLIENT, /'data-dpr-progress-tooltip': progressTip\.key/)
  assert.match(CLIENT, /window\.addEventListener\('scroll', close, true\)/, '树滚动时固定浮层必须关闭，不能停在旧位置')
  assert.match(CLIENT, /'aria-label': `\$\{p\.name\} · \$\{progressState\}/, '读屏能拿到页码与百分比')
})

test('S3 专题→论文补竖线 + 短横线，且不改变树的滚动契约', () => {
  assert.match(CLIENT, /items: \{[^\n]*borderLeft: '1px solid var\(--dsw-alias-border-l1, #d0d7de\)'/)
  assert.match(CLIENT, /'\.dpr-paper-row::after\{content:"";position:absolute;left:-5px;top:50%;width:9px;border-top:1px solid/)
  assert.match(CLIENT, /treeScroll: \{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto'/)
  assert.ok(!/overscrollBehavior: 'contain'/.test(CLIENT))
})

test('D1 中英 README / features 都说明进度含义、悬停详情与本地存储边界', () => {
  for (const file of ['README.md', 'docs/features.md']) {
    const text = readFileSync(join(REPO, file), 'utf8')
    assert.match(text, /当前页|当前位置/, `${file} 要说明百分比按当前位置`)
    assert.match(text, /悬停/, `${file} 要说明悬停详情`)
  }
  for (const file of ['README_EN.md', 'docs/features_EN.md']) {
    const text = readFileSync(join(REPO, file), 'utf8')
    assert.match(text, /current page|current position/i, `${file} must define the percentage`)
    assert.match(text, /hover/i, `${file} must mention hover details`)
  }
})
