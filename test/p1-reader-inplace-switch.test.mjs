// test/p1-reader-inplace-switch.test.mjs — 论文切换「不再整页重载阅读器」的契约（P1 性能）。
//
// 守什么：
//   · 宿主侧：iframe 的 src 只定稿一次（换论文走 postMessage），三种回退必须留全
//     （未握手 / 原地换失败 → 改 src 重新导航），否则用户会遇到「点了没反应」。
//   · 阅读器侧：dpr:open 只认同源 + 父窗口；同一篇只跳页不重开；不同的论文才 openPaper；
//     握手消息 dpr:ready 必须在首屏后发给父页面。
//
// 怎么守：宿主侧做源码结构断言（src 必须来自 state、握手分支必须存在），阅读器侧把
// `宿主原地换文献（P1）` 源码段**整段抽出来真跑**（假 window/location/openPaper）。
// 标记被重构掉 → A0 直接报错指认，不会静默漏守。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeEol } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT = normalizeEol(readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8'))
const READER = normalizeEol(readFileSync(join(ROOT, '..', 'reader', 'index.html'), 'utf8'))

const START = '/* ================= 宿主原地换文献（P1） ================='
const END_MARK = [
  '  queuedOpenRequest = { topic, name, page, q };',
  '  drainOpenQueue();',
  '});',
].join('\n')

/** 抽出阅读器侧 P1 源码段（含 window message 监听）。找不到就大声失败。 */
function handlerSource() {
  const start = READER.indexOf(START)
  const end = READER.indexOf(END_MARK)
  assert.ok(start >= 0, 'reader/index.html 必须有「宿主原地换文献（P1）」源码段')
  assert.ok(end > start, 'reader/index.html 的 P1 源码段必须保留 dpr:open 消息处理（重构后请同步本测试）')
  return READER.slice(start, end + END_MARK.length)
}

/** 在假环境里跑抽取出来的源码，返回触发器与记录。 */
async function makeEnv({ current = null, openingPaper = false, parentIsSelf = false } = {}) {
  const calls = { open: [], jump: [], posted: [] }
  const listeners = []
  const parent = { postMessage: (msg, targetOrigin) => calls.posted.push({ msg, targetOrigin }) }
  const win = {
    parent: parentIsSelf ? undefined : parent,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn) },
  }
  if (parentIsSelf) win.parent = win
  const location = { origin: 'http://127.0.0.1:3080' }
  // openPaper 返回 Promise（权当真的异步打开）；失败场景由 reject 模拟
  let openImpl = async (...args) => { calls.open.push(args) }
  const openPaper = (...args) => openImpl(...args)
  const jumpTo = (...args) => { calls.jump.push(args) }
  const body = `${handlerSource()}
return { queued: () => queuedOpenRequest }`
  // 失败回退会把 dpr.last 还原：抽出来的源码用到 localStorage，这里给个内存桩
  const store = new Map()
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
  const api = new Function('window', 'location', 'openPaper', 'jumpTo', 'current', 'openingPaper', 'console', 'localStorage', body)(
    win, location, openPaper, jumpTo, current, openingPaper, { error: () => {} }, localStorage,
  )
  // 监听器由假 window 收走：fire 在测试作用域里派发，避免 Function 沙箱里引用不到闭包
  const fire = (e) => { for (const fn of listeners) fn(e) }
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  return { calls, api, fire, flush, parent, store, setOpen: (fn) => { openImpl = fn }, origin: location.origin }
}

/** 构造一条 message 事件；source 默认是该环境的父窗口（和真实 iframe 一致）。 */
const msg = (env, data, over = {}) => ({
  origin: over.origin ?? env.origin,
  source: over.source ?? env.parent,
  data,
})

test('A0 抽取标记仍在：宿主侧 src 定稿 + 阅读器侧 P1 源码段', () => {
  assert.match(CLIENT, /const \[src, setSrc\] = useState\(/, '宿主 ReaderOverlay 的 src 必须是 state（定稿后不再随 cur 变）')
  assert.match(CLIENT, /const bootSrc = src \|\| readerSrcOf\(cur\)/, 'iframe 必须用定稿的 bootSrc 渲染')
  assert.match(CLIENT, /d\.type === 'dpr:ready'/, '宿主必须处理阅读器握手')
  assert.match(CLIENT, /d\.type === 'dpr:open-failed'/, '宿主必须处理原地换失败回退')
  assert.match(CLIENT, /function sendReaderOpen\(c\)/, '宿主必须有 postMessage 发送口')
  assert.ok(handlerSource().length > 400, '阅读器 P1 源码段非空')
})

test('A1 阅读器：非本页面源的消息一律忽略（origin 校验）', async () => {
  const env = await makeEnv({ current: { topic: 'T', name: 'N1' } })
  env.fire(msg(env, { type: 'dpr:open', topic: 'T', name: 'N2' }, { origin: 'http://evil.example' }))
  await env.flush()
  assert.equal(env.calls.open.length, 0, '跨源消息不得触发 openPaper')
})

test('A2 阅读器：source 不是父窗口的消息忽略', async () => {
  const env = await makeEnv({ current: { topic: 'T', name: 'N1' } })
  env.fire(msg(env, { type: 'dpr:open', topic: 'T', name: 'N2' }, { source: 'SOMEONE' }))
  await env.flush()
  assert.equal(env.calls.open.length, 0, '非父窗口来源不得触发 openPaper')
})

test('A3 阅读器：消息体不合法（缺 topic/name、非 dpr:open）时什么都不做', async () => {
  const env = await makeEnv({ current: { topic: 'T', name: 'N1' } })
  env.fire(msg(env, { type: 'dpr:theme' }))
  env.fire(msg(env, { type: 'dpr:open', topic: '', name: 'N2' }))
  env.fire(msg(env, { type: 'dpr:open', topic: 'T' }))
  env.fire(msg(env, null))
  await env.flush()
  assert.equal(env.calls.open.length, 0)
  assert.equal(env.calls.jump.length, 0)
})

test('A4 阅读器：同一篇只跳页（等价旧 jumpPage 路径），绝不重开文档', async () => {
  const env = await makeEnv({ current: { topic: 'T', name: 'N1' } })
  env.fire(msg(env, { type: 'dpr:open', topic: 'T', name: 'N1', page: 7, q: 'foo' }))
  await env.flush()
  assert.deepEqual(env.calls.jump, [[7, 'foo']], '同篇消息必须转成 jumpTo(page, q)')
  assert.equal(env.calls.open.length, 0, '同篇不得重新 openPaper（那会重新拉 PDF）')
})

test('A5 阅读器：换到另一篇才 openPaper，并把 page/q 透传', async () => {
  const env = await makeEnv({ current: { topic: 'T', name: 'N1' } })
  env.fire(msg(env, { type: 'dpr:open', topic: 'T', name: 'N2', page: 3, q: 'bar' }))
  await env.flush()
  assert.deepEqual(env.calls.open, [['T', 'N2', { page: 3, q: 'bar' }]])
  assert.equal(env.calls.jump.length, 0)
})

test('A6 阅读器：打开期间到达的新请求只认最后一篇（不并发 openPaper）', async () => {
  const env = await makeEnv({ current: { topic: 'T', name: 'N1' }, openingPaper: true })
  env.fire(msg(env, { type: 'dpr:open', topic: 'T', name: 'N2' }))
  env.fire(msg(env, { type: 'dpr:open', topic: 'T', name: 'N3' }))
  await env.flush()
  assert.equal(env.calls.open.length, 0, '正在打开时不得并发 openPaper')
  assert.deepEqual(env.api.queued(), { topic: 'T', name: 'N3', page: 0, q: '' }, '队列里只保留最后一次请求')
})

test('A7 阅读器：原地换失败回 dpr:open-failed，并解除 openingPaper 卡死', async () => {
  const env = await makeEnv({ current: { topic: 'T', name: 'N1' } })
  env.setOpen(async () => { throw new Error('boom') })
  env.fire(msg(env, { type: 'dpr:open', topic: 'T', name: 'N2' }))
  await env.flush()
  const failed = env.calls.posted.filter((p) => p.msg && p.msg.type === 'dpr:open-failed')
  assert.equal(failed.length, 1, '失败必须通知宿主退回改 src 重载')
  assert.deepEqual(failed[0].msg, { type: 'dpr:open-failed', topic: 'T', name: 'N2' })
  assert.equal(failed[0].targetOrigin, env.origin, '只发给同源父窗口')
})

test('A8 阅读器：成功时回 dpr:opened，且握手消息 dpr:ready 在 bootstrap 收尾后发出', async () => {
  const env = await makeEnv({ current: { topic: 'T', name: 'N1' } })
  env.fire(msg(env, { type: 'dpr:open', topic: 'T', name: 'N2' }))
  await env.flush()
  const opened = env.calls.posted.filter((p) => p.msg && p.msg.type === 'dpr:opened')
  assert.equal(opened.length, 1)
  assert.match(READER, /\.finally\(\(\) => \{ postToParent\(\{ type: 'dpr:ready' \}\)/, 'bootstrap 收尾必须发 dpr:ready 握手')
})

test('A9 宿主：未握手时仍改 src（旧路径兜底），握手后才只发 postMessage', () => {
  // 结构契约：cur 变化的分支顺序 —— 先 ready+sendReaderOpen 成功则 return，否则落回改 src
  const start = CLIENT.indexOf('// cur 变化：握手了就 postMessage 原地换')
  assert.ok(start > 0, 'lib/client.js 的 cur 变化分支仍可定位')
  const block = CLIENT.slice(start, start + 900)
  assert.match(block, /if \(readyRef\.current && sendReaderOpen\(cur\)\) return/, '握手后换论文只能发消息，不得再改 src')
  assert.match(block, /setSrc\(\(prev\) => \(prev === want \? prev : want\)\)/, '未握手时必须退回改 src 整页导航')
  // 回退路径：dpr:open-failed → setSrc(...)（重新导航到当前论文）
  const fb = CLIENT.indexOf("if (d.type === 'dpr:open-failed')")
  assert.ok(fb > 0)
  assert.match(CLIENT.slice(fb, fb + 600), /setSrc\(readerSrcOf\(c\)\)/, '失败回退必须改 src 重新导航')
})
