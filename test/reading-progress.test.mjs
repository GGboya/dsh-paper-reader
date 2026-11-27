// test/reading-progress.test.mjs — 侧栏每篇论文的阅读进度 + 专题→论文层级。
//
// 交互契约（维护者复审）：紧凑一行标题 + 右侧百分比；不画标题下方的进度条，不做重复信息弹窗。
// 百分比 = 当前页 / 总页数，回看前文会下降；未读不画空条，末页绿色完成；层级用 VSCode 式浅灰竖线。
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
  vm.runInContext(`${CLIENT}\n;globalThis.__pure = { progress: dprReadingProgress, legacy: dprReadingPositionLegacy };`, ctx, { filename: 'client-reading-progress.js' })
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

test('P3 行尾已有百分比时不提供重复信息的悬停弹窗', () => {
  assert.ok(!CLIENT.includes('dprReadingProgressTipPosition'))
  assert.ok(!CLIENT.includes('progressTip'))
  assert.ok(!CLIENT.includes('dpr-progress-tooltip'))
  assert.ok(!CLIENT.includes('showProgressTip'))
  assert.ok(!CLIENT.includes('onMouseEnter'))
})

test('S1 阅读器落盘 {p,r,n,u} 并广播；宿主只接受本插件 iframe 的合法进度消息', () => {
  assert.match(READER, /const pos = \{ \.\.\.livePos\(\), n: pdfDoc\.numPages, u: Date\.now\(\) \}/)
  assert.match(READER, /postToParent\(\{ type: 'dpr:reading-progress', topic: current\.topic, name: current\.name, \.\.\.pos \}\)/)
  assert.match(CLIENT, /if \(!win \|\| e\.source !== win\) return/)
  assert.match(CLIENT, /d\.type === 'dpr:reading-progress'[\s\S]{0,300}dprReadingProgress\(d\)/)
  assert.match(CLIENT, /new CustomEvent\('dpr:reading-progress'/)
  assert.match(CLIENT, /window\.addEventListener\('storage', onStorage\)/, '其它同源标签页改进度也要刷新')
})

test('S2 紧凑 UI 落在论文行：只保留行尾百分比与末页完成态，不做悬停弹窗', () => {
  assert.match(CLIENT, /paperItem: \{ minHeight: '24px', padding: '1px 4px 1px 14px'/)
  assert.ok(!CLIENT.includes('dpr-progress-track'), '用户明确不要标题下方的进度条')
  assert.ok(!CLIENT.includes('dpr-progress-fill'), '不再渲染进度条填充')
  assert.match(CLIENT, /className: 'dpr-progress-pct'/)
  assert.match(CLIENT, /complete \? h\(LibraryIcon, \{ name: 'check', size: 11 \}\)/)
  assert.match(CLIENT, /else if \(dprReadingPositionLegacy\(raw\)\)/, '旧位置必须进入“续读”分支')
  assert.match(CLIENT, /legacy \? t\('progressLegacyShort'\)/)
  assert.ok(!CLIENT.includes('dpr-active:before'), '当前论文只用背景选中，不显示短蓝色指示条')
  assert.ok(!CLIENT.includes('onMouseEnter'), '悬停不再触发任何状态更新或布局测量')
  assert.match(CLIENT, /'aria-label': `\$\{p\.name\} · \$\{progressState\}/, '读屏仍能拿到页码与百分比')
})

test('S3 专题→论文采用 VSCode 式浅灰层级竖线，不画短横线或蓝色当前指示条', () => {
  assert.match(CLIENT, /items: \{ position: 'relative', marginLeft: '16px', paddingLeft: '3px', borderLeft: '1px solid var\(--dsw-alias-border-l2, #e5e8eb\)' \}/)
  assert.ok(!CLIENT.includes('.dpr-paper-row::after'), '不要每篇论文前的短横线')
  assert.match(CLIENT, /paperItem: \{[^\n]*padding: '1px 4px 1px 14px'/)
  assert.match(CLIENT, /treeScroll: \{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto'/)
  assert.ok(!/overscrollBehavior: 'contain'/.test(CLIENT))
})

test('D1 中英 README / features 都说明进度含义、无重复弹窗与本地存储边界', () => {
  for (const file of ['README.md', 'docs/features.md']) {
    const text = readFileSync(join(REPO, file), 'utf8')
    assert.match(text, /当前页|当前位置/, `${file} 要说明百分比按当前位置`)
    assert.match(text, /不.*弹窗|无.*弹窗|不额外占高|紧凑/, `${file} 要说明紧凑、无重复弹窗`)
  }
  for (const file of ['README_EN.md', 'docs/features_EN.md']) {
    const text = readFileSync(join(REPO, file), 'utf8')
    assert.match(text, /current page|current position/i, `${file} must define the percentage`)
    assert.match(text, /no .*popup|without .*popup|compact/i, `${file} must mention compact presentation without redundant popups`)
  }
})
