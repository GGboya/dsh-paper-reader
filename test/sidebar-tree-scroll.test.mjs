// test/sidebar-tree-scroll.test.mjs — 侧栏文献树的滚动：论文很多时树自己滚，下面的论文看得到、点得到。
//
// 背景（2026-11-25 用户反馈「论文一多，左侧看不到下面的论文」，维护者亲测确认）：
//   dsh 0.2.x 把侧栏槽放在一个按内容撑开的 flex 里，`height:100%` 解不出来，树被内容撑开、自己并不滚；
//   而它还带着 `overscroll-behavior: contain`，滚轮事件到一个不滚的滚动容器手上就被吞掉 ⇒ 外层宿主容器
//   也滚不动，最后一行远在屏幕外。这是 #32（桌面端树塌成 0 高）把 flex-basis 改成 auto 之后带出来的。
//
// 修法：树外面套一层「按实测限高」的容器——从插件根往上找裁切 / 滚动边界，量出树能用多高
// （顶层纯函数 dprTreeAvailableHeight）；树自己在里面滚，头部按钮固定，右侧是宿主全局样式的细滚动条。
//
// 修法里的两处坑（都是第一版实测踩到、自查才发现的，各有回归用例）：
//   · 「哪个祖先算硬边界」只看当下几何分不出来：按内容撑开的包裹层和「刚好装下」的确定高度容器都是「没溢出」。
//     第一版在宿主给确定高度时继续往上走，把滚动区外面的底栏也当成「后面的内容」扣掉（499 变 422）。
//     现在直接测因果：把我们收成 0 高再量一遍，高度没变的才是硬边界。
//   · 探针会让滚动容器暂时「不可滚」，浏览器趁机把 scrollTop 清零 ⇒ 每次重渲染列表跳回顶部。现在先存后还。
//
// 守什么：
//   T  dprTreeAvailableHeight 真执行：硬边界怎么认；下边界取最小的；到第一个硬边界为止给后面的兄弟留位置；
//      空间太小 / 没有硬边界 = 不限高。
//   S  结构：限高落在套出来的那一层（树元素本身不动，#32 的守卫还在）；不再写 contain；
//      两回探针 + 滚动位置先存后还；窗口缩放 / 宿主尺寸 / 宿主结构变化都会重量。
//   D  文档：两份功能文档都写到「论文很多时列表可滚动」。
//
// 真浏览器里的端到端行为（滚轮、拖滚动条、窗口变矮、折叠、窄栏）不在 Node 里守：那几项是 2026-11-25
// 在隔离实例上用 88 篇论文实测通过的，见 docs/features.md「文献管理细则」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { normalizeEol } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
// 行尾归一化：结构断言里有跨行匹配，Windows 检出成 CRLF 时也要能对上
const CLIENT = normalizeEol(readFileSync(join(REPO, 'lib', 'client.js'), 'utf8'))

/** 真执行 lib/client.js 顶层，取纯函数（与 pr8 系列测试同一个办法）。 */
function loadClient() {
  const ctx = { window: { __ModuleLoader__: { load: () => {} } }, console, atob }
  vm.createContext(ctx)
  vm.runInContext(`${CLIENT}\n;globalThis.__fn = typeof dprTreeAvailableHeight === 'function' ? dprTreeAvailableHeight : null;`, ctx, { filename: 'client-top-level.js' })
  return ctx.__fn
}
const avail = loadClient()

// 网页端 1400×860、88 篇论文时的真实祖先链（2026-11-25 实测）。h = 内容自然高度时的高，collapsedH = 我们被收成 0 高时的高。
const lv = (o) => ({ hasBox: true, h: NaN, collapsedH: NaN, bottom: NaN, afterBottom: -Infinity, borderB: 0, padB: 0, marginB: 0, ...o })
const CONTENTS = { hasBox: false, afterBottom: -Infinity } // display:contents：没有盒子
const REGION = lv({ h: 2509, collapsedH: 52, bottom: 2735 })   // 按内容撑开的区域（随我们的内容长）
const SCROLL = lv({ h: 669, collapsedH: 669, bottom: 777 })    // 宿主侧栏的滚动区：高度由它的父级定 ⇒ 第一个硬边界
const FIXED = (bottom, extra = {}) => lv({ h: bottom - 226, collapsedH: bottom - 226, bottom, ...extra }) // 高度固定的层（视口 / 外壳）
const NAT = { top: 270, rootBottom: 2735, rootPadBottom: 8, rootMarginBottom: 0 }
const WEB = { ...NAT, ancestors: [CONTENTS, REGION, SCROLL, FIXED(860, { padB: 6 }), { hasBox: false }, FIXED(860), FIXED(860), FIXED(860), { hasBox: false }, FIXED(860), FIXED(860), FIXED(860), FIXED(860)] }

// ═══════════════════════════════════════════════════════════════════════════
// T. 纯函数
// ═══════════════════════════════════════════════════════════════════════════

test('T0 lib/client.js 顶层有 dprTreeAvailableHeight（纯函数，可在 Node 里直接跑）', () => {
  assert.equal(typeof avail, 'function')
})

test('T1 网页端实测：可用高度 = 滚动区的内容盒底 − 树顶 − 插件根的下内边距（1400×860 → 499，1280×600 → 239）', () => {
  assert.equal(avail(WEB), 777 - 270 - 8)
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, REGION, lv({ h: 409, collapsedH: 409, bottom: 517 }), ...WEB.ancestors.slice(3)] }), 517 - 270 - 8)
  assert.equal(avail({ ...WEB, rootPadBottom: 20 }), 777 - 270 - 20, '插件根的下内边距要扣掉')
})

test('T2 硬边界 = 高度不随我们的内容变的祖先（h 与 collapsedH 相同）', () => {
  // 按内容撑开的包裹层：哪怕带 overflow:hidden，也不是边界
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, lv({ h: 2517, collapsedH: 60, bottom: 2743 }), SCROLL, ...WEB.ancestors.slice(3)] }), 499)
  // 所有硬边界里取内容盒底最小的；边框、内边距都要扣
  assert.equal(avail({ ...WEB, ancestors: [...WEB.ancestors, lv({ h: 300, collapsedH: 300, bottom: 620, borderB: 4, padB: 8 })] }), 608 - 270 - 8)
  // 没量到 collapsedH 的层不能当成硬边界
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, REGION, lv({ h: 669, bottom: 777 }), ...WEB.ancestors.slice(3)] }), 860 - 6 - 270 - 8, '滚动区没量到 ⇒ 退到下一个硬边界（外壳，底 860 − 内边距 6）')
})

test('T2b 回归：宿主给了确定高度时，包裹层自己就是硬边界——不能再往上把滚动区外面的底栏扣掉', () => {
  // 把包裹层钉成 500px（实测）：它不随内容长 ⇒ 硬边界，底 726。滚动区此时没被撑溢出（669/669），再往外是 77px 高的底栏。
  const pinned = lv({ h: 500, collapsedH: 500, bottom: 726 })
  const ancestors = [CONTENTS, pinned, SCROLL, lv({ h: 669, collapsedH: 669, bottom: 777, afterBottom: 854 }), FIXED(860)]
  assert.equal(avail({ ...NAT, rootBottom: 726, ancestors }), 726 - 270 - 8, '正好是头部以下的剩余高度（实测 448）')
  assert.equal(avail({ ...NAT, rootBottom: 726, ancestors }), 448)
  // 第一版的错法（只认「正在溢出」的裁切祖先为硬边界）在这个场景里会把包裹层当成「随内容长」——
  // 两种摆法都和正确的 448 对不上：底栏挂在滚动区这一层 ⇒ 被当成「后面的内容」扣掉（371）；
  // 挂在更外一层 ⇒ 下边界错落到滚动区（499），树会溢出这个 500px 的槽。
  const naivePinned = lv({ h: 500, collapsedH: 0, bottom: 726 })
  const footerLevel = lv({ h: 669, collapsedH: 669, bottom: 777, afterBottom: 854 })
  assert.equal(avail({ ...NAT, rootBottom: 726, ancestors: [CONTENTS, naivePinned, footerLevel, FIXED(860)] }), 371)
  assert.equal(avail({ ...NAT, rootBottom: 726, ancestors: [CONTENTS, naivePinned, SCROLL, footerLevel, FIXED(860)] }), 499)
})

test('T3 到第一个硬边界为止，给「排在我们祖先后面的兄弟」留位置；再往上的与我们无关；空白不算', () => {
  // 包裹层里排在插件后面还有一行（底 2795，比插件根的底 2735 低 60）
  const withRow = { ...WEB, ancestors: [CONTENTS, lv({ ...REGION, afterBottom: 2795, marginB: 60 }), lv({ ...SCROLL, afterBottom: 2895 }), ...WEB.ancestors.slice(3)] }
  assert.equal(avail(withRow), 499 - 60 - 100, '两层各让出一段：60 + 100（上一层的外边距边缘 2795 → 这一层后面的兄弟 2895）')
  // 硬边界之外的层即使带着「后面的兄弟」也不算（底栏在滚动区外面）
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, REGION, SCROLL, lv({ ...FIXED(860), afterBottom: 5000 })] }), 499)
  // 后面的兄弟不比我们低（父容器比内容高、下面只是空白）：不算，树不该白白变矮
  assert.equal(avail({ ...WEB, rootBottom: 2000, ancestors: [CONTENTS, lv({ ...REGION, bottom: 2000, afterBottom: 1900 }), SCROLL] }), 499)
  // 没有盒子的层（display:contents）：它后面的兄弟并入下一个有盒子的层
  assert.equal(avail({ ...WEB, ancestors: [{ hasBox: false, afterBottom: 2795 }, REGION, SCROLL] }), 499 - 60)
  assert.equal(avail({ ...WEB, ancestors: [{ hasBox: false, afterBottom: 2795 }, { hasBox: false, afterBottom: 2895 }, REGION, SCROLL] }), 499 - 160, '连续两层都没有盒子：取最低处')
  assert.equal(avail({ ...WEB, ancestors: [null, { hasBox: false }, null, REGION, SCROLL] }), 499, '脏数据')
})

test('T4 不限高（返回 0）：没有硬边界、空间连几行都放不下、入参是坏的', () => {
  assert.equal(avail({ ...WEB, ancestors: [] }), 0)
  // 整页都随内容长（普通网页）：没有哪一层的高度是固定的 ⇒ 交给页面滚
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, REGION, lv({ h: 2627, collapsedH: 170, bottom: 2735 }), lv({ h: 2851, collapsedH: 394, bottom: 2959 })] }), 0)
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, REGION, lv({ h: 100, collapsedH: 100, bottom: 370 })] }), 0, '只剩 92px，不足 96px')
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, REGION, lv({ h: 104, collapsedH: 104, bottom: 374 })] }), 96, '正好 96px 可以')
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, REGION, lv({ h: 100, collapsedH: 100, bottom: 370 })] }, 60), 92, 'minHeight 可调')
  assert.equal(avail(null), 0)
  assert.equal(avail('garbage'), 0)
  assert.equal(avail({ ...WEB, top: NaN }), 0, '树顶没量到 ⇒ 这次量不作数')
  assert.equal(avail({ ...NAT }), 0, '缺 ancestors')
})

test('T5 稳定性：入参全部来自「自然高度」那次探针，所以同一份几何量两遍结果一样（不会随当前限高抖）', () => {
  // 树刚被限到 499 之后再量：探针①照样读到 2509 / 2735，探针②照样读到 52 ⇒ 与首次完全相同的输入
  assert.equal(avail(WEB), avail({ ...WEB }))
  // 反例：如果有人拿「受限之后」的高度冒充自然高度（包裹层 551 / 收起 52），它仍被判成随内容长 ⇒ 结论不变
  assert.equal(avail({ ...WEB, ancestors: [CONTENTS, lv({ h: 551, collapsedH: 52, bottom: 735 }), SCROLL, ...WEB.ancestors.slice(3)] }), 499)
})

// ═══════════════════════════════════════════════════════════════════════════
// S. 结构
// ═══════════════════════════════════════════════════════════════════════════

function blockAt(marker) {
  const at = CLIENT.indexOf(marker)
  assert.ok(at >= 0, `lib/client.js 缺：${marker}`)
  const open = CLIENT.indexOf('{', at)
  let depth = 0
  for (let i = open; i < CLIENT.length; i++) {
    if (CLIENT[i] === '{') depth++
    else if (CLIENT[i] === '}') { depth--; if (depth === 0) return CLIENT.slice(at, i + 1) }
  }
  assert.fail(`lib/client.js 的 ${marker} 没有闭合`)
}

test('S1 限高落在树外面套出来的那一层；树元素本身原样不动（#32 的守卫还在）', () => {
  const at = CLIENT.indexOf("'data-dpr-tree-max': treeMax || null")
  assert.ok(at > 0, 'lib/client.js 缺带 data-dpr-tree-max 的限高容器')
  const win = CLIENT.slice(at - 24, at + 420)
  assert.match(win, /ref: treeRef, 'data-dpr-tree-max': treeMax \|\| null,\s*style: \{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', \.\.\.\(treeMax \? \{ maxHeight: treeMax \+ 'px' \} : \{\}\) \},\s*\},\s*h\('div', \{ role: 'tree', style: S\.treeScroll/, '限高必须落在套出来的那层上，树元素紧随其后且原样用 S.treeScroll')
})

test('S2 不再写 overscroll-behavior: contain——它曾把滚轮事件拦在一个并不滚动的容器手上', () => {
  const sc = blockAt('treeScroll: {')
  assert.match(sc, /^treeScroll: \{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto'/, '#32 守卫要求的前缀不能动')
  assert.ok(!/overscrollBehavior: 'contain'/.test(CLIENT), '不得再出现 contain')
  assert.match(sc, /overscrollBehavior: 'auto'/)
})

test('S3 两回探针 + 滚动位置先存后还（都在同一帧内完成；finally 里还原，出错也不会把限高 / 位置丢掉）', () => {
  const measure = blockAt('const measureTree = useCallback(() => {')
  const at = (needle) => { const i = measure.indexOf(needle); assert.ok(i >= 0, `measureTree 缺：${needle}`); return i }
  const atKeep = at('scroller.scrollTop')
  const atNone = at("wrap.style.maxHeight = 'none'")
  const atTry = at('try {')
  const atNatural = at('const natural = read()')
  const atZero = at("wrap.style.maxHeight = '0px'")
  const atCollapsed = at('const collapsed = read()')
  const atFinally = at('} finally {')
  const atRestore = at('wrap.style.maxHeight = prev')
  assert.ok(atKeep < atNone, '探针之前先把树的滚动位置存下来')
  assert.ok(atNone < atTry && atTry < atNatural && atNatural < atZero && atZero < atCollapsed, '顺序：撤掉限高 → 读自然高度 → 收成 0 高 → 再读')
  assert.ok(atCollapsed < atFinally && atFinally < atRestore, 'finally 里还原限高')
  assert.match(measure.slice(atFinally), /wrap\.style\.maxHeight = prev\s*\n\s*if \(scroller\) scroller\.scrollTop = keep\s*\n\s*for \(const \[el, top\] of outerScroll\) el\.scrollTop = top/, '还原限高之后：先放回树的滚动位置，再放回外层滚动容器的')
  assert.match(measure, /collapsedH: collapsed\.levels\[i\] \? collapsed\.levels\[i\]\.h : NaN/, '第二回探针的高度按层对上，交给纯函数判硬边界')
  assert.match(measure, /dprTreeAvailableHeight\(\{\s*\n\s*top: natural\.treeTop, rootBottom: natural\.rootBottom,/, '树顶与插件根的底都取自「自然高度」那一回')
})

test('S4 窗口缩放、宿主改尺寸、宿主往侧栏里增删内容都会重量；卸载时全部清掉', () => {
  const effect = blockAt("React.useLayoutEffect(measureTree)\n      useEffect(() => {")
  assert.match(effect, /window\.addEventListener\('resize', schedule\)/)
  assert.match(effect, /new ResizeObserver\(schedule\)/)
  assert.match(effect, /new MutationObserver\(schedule\)/)
  assert.match(effect, /mo\.observe\(a, \{ childList: true, subtree: true \}\)/, '宿主在侧栏里增删内容时树顶会挪动，得跟着重量')
  assert.match(effect, /window\.removeEventListener\('resize', schedule\)/)
  assert.match(effect, /ro\.disconnect\(\)/)
  assert.match(effect, /mo\.disconnect\(\)/)
  assert.match(CLIENT.slice(CLIENT.indexOf('React.useLayoutEffect(measureTree)'), CLIENT.indexOf('React.useLayoutEffect(measureTree)') + 1800), /\}, \[measureTree, wide\]\)/, '展开 / 窄栏切换（wide 变化）后树重新挂载，监听要重接')
  assert.match(CLIENT, /React\.useLayoutEffect\(measureTree\)/, '每次渲染后都量一次：折叠展开、数据变化都会改树的位置或高度')
  // 兜底：宿主只改样式不动 DOM（既没有重渲染，根和滚动区的尺寸也没变）时没有任何事件可听——
  // 实测解除一个钉死的高度后限高停在旧值。页面可见时低频重量，最坏 5 秒自愈；隐藏时不白量。
  assert.match(effect, /setInterval\(\(\) => \{ if \(document\.visibilityState !== 'hidden'\) schedule\(\) \}, 5000\)/)
  assert.match(effect, /clearInterval\(timer\)/, '卸载时清掉')
})

// ═══════════════════════════════════════════════════════════════════════════
// D. 文档
// ═══════════════════════════════════════════════════════════════════════════

test('D1 两份功能文档都写到「论文很多时侧栏列表可滚动」', () => {
  assert.match(readFileSync(join(REPO, 'docs', 'features.md'), 'utf8'), /论文很多时[\s\S]{0,40}(滚动|滚动条)/)
  assert.match(readFileSync(join(REPO, 'docs', 'features_EN.md'), 'utf8'), /[Mm]any papers[\s\S]{0,80}scroll/)
})
