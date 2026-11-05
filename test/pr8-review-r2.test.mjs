// test/pr8-review-r2.test.mjs — REV2（t5）对 IMP2（t2）A / G / H + scope 码点截断的**独立对抗探针**。
//
// 独立性声明（团队 profile 硬规则：评审必须自己构造证据）：
//   · 不 import 实现方 `test/pr8-session-client-scope.test.mjs`；夹具（专题/论文名、正文、needle、
//     残留键、偏移量）与断言全部由本评审重造，不复用实现方断言。
//   · 只 import `dist/*.js`（跑前 `npm run build`）；客户端 `lib/client.js` 用 vm **真执行**（只 stub
//     `window.__ModuleLoader__.load`，与仓库既有 `test/library-clear-and-busy.test.mjs` 同法），
//     不是 grep。全部库用 `mkdtemp`，`DSH_HOME` 指向临时目录。
//   · 同一份探针可跑 **fdb45f2 基线**：`R2_REPO=/abs/.worktrees/pr8-baseline node --test test/pr8-review-r2.test.mjs`
//     ⇒ 缺陷条目应红；修复后应绿。基线红是本探针自己跑出来的。
//
// 覆盖（docs/pr8-maintainer-review.md：必修 A、应修 G、应修 H、维护者「已修好」第 1 条码点截断）：
//   A1/A2  会话 id 嵌套专题：tools.paperFromSessionId + client.parseDprSession 都按最后一个 '/' 切
//   G1     专题范围命中片段计入预算（12 篇 × 3 命中 ≤ 40000）、正文不重复、omitted 句只一次
//   G2a    同名论文多命中如实进 omitted（不许静默消失）
//   G2b    kind:'topic' 指向不存在专题 ⇒ 模块层 404 + 路由层 404（不许空范围 200）
//   GC1-5  U+1D400 代理对恰好跨切点：单篇正文 8000 / 无命中开头片段 8000 / 命中 1200 /
//          清单 MAX_MANIFEST / helper 语义 —— 输出无孤立代理项、文档字符不劈开、JSON 往返不炸
//   H1a/b/c 前缀感知改名：dprReprefixTopic / dprRekeyTopicState / migrateLsKeys 的 dpr.last
//   H2     子树计数（A 与 AB 不互串）⇒ 论文全在子专题时 clear 路径可得
//   H3     clearEndpoint 透传到 Error，重试判据可达（用**真实 409 响应体**验证）
//   H4     改名后的身份能直接拼出可用的请求路径（服务端 200），旧路径 404
//
// 判读：本文件绿 = 修复在本评审自造场景下成立；红 = 消息带实际值。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 默认测当前修复树；`R2_REPO` 指向基线工作树时跑基线对照。 */
const TARGET = process.env.R2_REPO ? resolve(process.env.R2_REPO) : join(HERE, '..')
const BASELINE_MODE = Boolean(process.env.R2_REPO)
const dist = (m) => join(TARGET, 'dist', m)
const CLIENT_SRC = readFileSync(join(TARGET, 'lib', 'client.js'), 'utf8')

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-r2-home-'))

const TOOLS = await import(pathToFileURL(dist('tools.js')).href)
const SC = await import(pathToFileURL(dist('scope.js')).href)
const L = await import(pathToFileURL(dist('library.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// ═════════════════════════════════════════════════════════════════════════════
// 夹具 / 工具
// ═════════════════════════════════════════════════════════════════════════════

function newLib(prefix = 'dpr-r2-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局落一篇论文；`body` 写 `<name>.txt`（正文来源），可指定额外产物后缀。 */
function putPaper(data, topic, name, body = null, extra = ['.pdf', '.txt']) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), `pdf:${topic}/${name}`)
  if (body != null) writeFileSync(join(dir, `${name}.txt`), body)
  for (const s of extra) if (s !== '.txt') writeFileSync(join(dir, `${name}${s}`), 'x')
  return dir
}

/** 伴读会话 id（host 的格式：`dpr-<base64url(topic/name)>-<n>`）。 */
function sessionIdOf(path, n = 1) {
  return `dpr-${Buffer.from(path, 'utf8').toString('base64url')}-${n}`
}

/** 孤立代理项：返回落单的 UTF-16 下标（合法的代理对会被整体跳过）。 */
function loneSurrogates(s) {
  const bad = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n2 = s.charCodeAt(i + 1)
      if (n2 >= 0xdc00 && n2 <= 0xdfff) i++
      else bad.push(i)
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bad.push(i)
    }
  }
  return bad
}

const MATH_A = '\u{1D400}' // 𝐀：UTF-16 代理对（2 个码元）

/** 取 `src[at]`（必须是 `{`）起的配对代码块原文；跳过字符串/模板/注释里的括号。 */
function braceBlock(src, at) {
  assert.equal(src[at], '{', 'braceBlock 必须从 { 开始')
  let depth = 0
  let i = at
  let kind = 'code'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (kind === 'code') {
      if (c === '/' && n === '/') { kind = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { kind = 'block'; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { kind = c; i += 1; continue }
      if (c === '{') depth += 1
      else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(at, i + 1) }
    } else if (kind === 'line') {
      if (c === '\n') kind = 'code'
    } else if (kind === 'block') {
      if (c === '*' && n === '/') { kind = 'code'; i += 2; continue }
    } else {
      if (c === '\\') { i += 2; continue }
      if (c === kind) kind = 'code'
    }
    i += 1
  }
  throw new Error('braceBlock: 代码块没有闭合')
}

/** 从 client.js 源码里抠出一个具名函数并在 vm 里执行（用于**基线**里内联函数的真执行）。 */
function extractFunction(src, name) {
  const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`))
  if (at < 0) return null
  const bodyStart = src.indexOf('{', at)
  const code = src.slice(at, bodyStart) + braceBlock(src, bodyStart)
  const ctx = { atob, btoa, decodeURIComponent, encodeURIComponent, console }
  vm.createContext(ctx)
  vm.runInContext(`${code}\n;globalThis.__fn = ${name};`, ctx, { filename: `client-${name}-inline.js` })
  return typeof ctx.__fn === 'function' ? ctx.__fn : null
}

/** 真执行 lib/client.js 顶层，取修复方新增的纯函数（基线里这些函数在闭包内 ⇒ null）。 */
function loadClient() {
  let loaded = null
  const ctx = { window: { __ModuleLoader__: { load: (m) => { loaded = m } } }, console, atob }
  vm.createContext(ctx)
  vm.runInContext(CLIENT_SRC + `
;globalThis.__dpr = {
  parseDprSession: typeof parseDprSession === 'function' ? parseDprSession : null,
  dprSessionStale: typeof dprSessionStale === 'function' ? dprSessionStale : null,
  dprReprefixTopic: typeof dprReprefixTopic === 'function' ? dprReprefixTopic : null,
  dprRekeyTopicState: typeof dprRekeyTopicState === 'function' ? dprRekeyTopicState : null,
  dprTopicPaperCount: typeof dprTopicPaperCount === 'function' ? dprTopicPaperCount : null,
  dprApiError: typeof dprApiError === 'function' ? dprApiError : null,
  dprClearRetryNeeded: typeof dprClearRetryNeeded === 'function' ? dprClearRetryNeeded : null,
};`, ctx, { filename: 'client-r2.js' })
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须通过 __ModuleLoader__.load 注册模块')
  return ctx.__dpr
}
const CLIENT = loadClient()

/** 客户端纯函数：修复树直接取顶层导出；基线缺失时对 parseDprSession 退化为「抠源码真执行」。 */
function clientFn(name) {
  if (typeof CLIENT[name] === 'function') return CLIENT[name]
  if (name === 'parseDprSession') return extractFunction(CLIENT_SRC, name)
  return null
}

/** 服务端路由（ask 需要 sessionController 桩；与仓库既有测试同法，不是实现方断言）。 */
async function boot(data) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {
      list: async () => ({ items: [] }),
      create: async () => ({}),
      prompt: async () => {},
    },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const parse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const get = async (p) => { const r = await fetch(base + p); const txt = await r.text(); return { status: r.status, body: parse(txt), txt } }
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  return { srv, get, post, close: () => { srv.closeAllConnections?.(); srv.close() } }
}

/** 造 12 篇 × 每篇 3+ 个命中块的专题（每段 >1500 字 ⇒ chunkText 硬切 1500 块，块首带 needle）。 */
function bigHitLib(paperCount = SC.MAX_PAPERS_IN_SCOPE) {
  const { root, data } = newLib('dpr-r2-hits-')
  for (let i = 0; i < paperCount; i++) {
    const name = `Q${String(i).padStart(2, '0')}`
    putPaper(data, 'Big', name, null, ['.pdf'])
    // 每篇的 token 唯一（r2needle-<i>-<ch>）⇒ 「同一片段只出现一次」的断言不会被跨篇同文本干扰
    const paras = ['x', 'y', 'z'].map((ch) => `r2needle-${i}-${ch} ` + ch.repeat(1_600))
    writeFileSync(join(data, 'Big', name, name + '.txt'), paras.join('\n\n'))
  }
  const cur = L.resolvePaper(data, { topic: 'Big', name: 'Q00' })
  return { root, data, cur }
}

// ═════════════════════════════════════════════════════════════════════════════
// A. 会话 id 与嵌套专题
// ═════════════════════════════════════════════════════════════════════════════

test('R2-A1 paperFromSessionId：A/B/P ⇒ topic=A/B,name=P（扁平不回归、非法仍 null）', (t) => {
  assert.equal(typeof TOOLS.paperFromSessionId, 'function', 'dist/tools.js 必须导出 paperFromSessionId')
  const deep = TOOLS.paperFromSessionId(sessionIdOf('TopicA/SubB/PaperC', 3))
  t.diagnostic(`deep=${JSON.stringify(deep)}`)
  // ← 基线在此红：{topic:'TopicA', name:'SubB/PaperC'}
  assert.deepEqual({ ...deep }, { topic: 'TopicA/SubB', name: 'PaperC' },
    `嵌套专题必须按最后一个 / 切（A/B/P）：实际 ${JSON.stringify(deep)}`)
  assert.deepEqual({ ...TOOLS.paperFromSessionId(sessionIdOf('L1/L2/L3/L4', 7)) },
    { topic: 'L1/L2/L3', name: 'L4' }, '更深路径同理')
  assert.deepEqual({ ...TOOLS.paperFromSessionId(sessionIdOf('Solo/Only')) }, { topic: 'Solo', name: 'Only' }, '扁平不回归')
  for (const bad of [sessionIdOf('NoSlash'), sessionIdOf('A/B/'), sessionIdOf('/P'), 'sess-xyz', undefined]) {
    assert.equal(TOOLS.paperFromSessionId(bad), null, `非法会话 id 必须 null：${JSON.stringify(bad)}`)
  }
})

test('R2-A2 parseDprSession 同语义；子专题论文的 ⓘ 不判成「停在另一篇」（基线 parse 取第一个 /）', (t) => {
  const parse = clientFn('parseDprSession')
  assert.equal(typeof parse, 'function', 'lib/client.js 里必须能执行到 parseDprSession（基线可抠源码）')
  const deep = parse(sessionIdOf('TopicA/SubB/PaperC', 2))
  t.diagnostic(`parse=${JSON.stringify(deep)}`)
  // ← 基线在此红：{topic:'TopicA', name:'SubB/PaperC'}
  assert.deepEqual({ ...deep }, { topic: 'TopicA/SubB', name: 'PaperC', n: 2 },
    `parseDprSession 必须解出 topic=TopicA/SubB：实际 ${JSON.stringify(deep)}`)
  assert.deepEqual({ ...parse(sessionIdOf('Flat/Paper')) }, { topic: 'Flat', name: 'Paper', n: 1 }, '扁平不回归')
  assert.equal(parse(sessionIdOf('OnlyName')), null, '无 / 必须 null')
  assert.equal(parse(sessionIdOf('A/B/')), null, '末尾 / 必须 null')

  // ⓘ 判定：会话绑定的论文 vs 阅读器当前论文。基线的内联判定就是逐字段精确比较（评审原文），
  // 这里只在「修复方没有提供纯函数」时按同一表达式派生，修复方提供时直接调生产函数。
  const staleOf = typeof CLIENT.dprSessionStale === 'function'
    ? CLIENT.dprSessionStale
    : (chat, viewed) => !!(chat && viewed && viewed.topic && (chat.topic !== viewed.topic || chat.name !== viewed.name))
  const viewed = { topic: 'TopicA/SubB', name: 'PaperC' }
  // ← 基线在此红：parse 得到的 topic/name 与 viewed 不等 ⇒ true（⚠ 永远常亮）
  assert.equal(staleOf(parse(sessionIdOf('TopicA/SubB/PaperC')), viewed), false,
    '会话与阅读器是同一篇（子专题）⇒ 不得判成「停在另一篇」')
  assert.equal(staleOf(parse(sessionIdOf('TopicA/SubB/Other')), viewed), true, '真的是另一篇时必须判 true')
  assert.equal(staleOf(parse(sessionIdOf('TopicA/SubB/PaperC')), null), false, '阅读器无当前论文时不提示')
})

// ═════════════════════════════════════════════════════════════════════════════
// G1. 专题范围预算与诚实性
// ═════════════════════════════════════════════════════════════════════════════

test('R2-G1 12 篇×3 命中：totalChars ≤ 40000、命中只出现一次、omitted 句只一次', (t) => {
  const { root, data, cur } = bigHitLib()
  try {
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Big' }, 'r2needle')
    t.diagnostic(`totalChars=${ctx.totalChars} manifest=${ctx.manifestChars} body=${ctx.bodyChars} hits=${ctx.hitChars} omitted=${ctx.omitted} block=${ctx.block.length}`)
    assert.ok(ctx.hitChars > 0, '前提：必须真的有命中片段（否则本用例空转）')
    assert.ok(ctx.omitted > 0, '12 篇 × 3 命中必然超预算 ⇒ 必须有显式 omitted（不许超预算硬塞）')
    // ← 基线在此红：totalChars ≈ 72k
    assert.ok(ctx.totalChars <= SC.MAX_CONTEXT_CHARS,
      `totalChars 必须 ≤ ${SC.MAX_CONTEXT_CHARS}（维护者实测修复前 72574）：实际 ${ctx.totalChars}`)
    assert.ok(ctx.block.length <= SC.MAX_CONTEXT_CHARS + 800,
      `最终 block 也不得明显越上限：实际 ${ctx.block.length}`)
    assert.equal(ctx.totalChars, ctx.manifestChars + ctx.bodyChars + ctx.hitChars,
      'totalChars 必须等于三段之和（命中与正文都计费）')
    // 命中片段只在第 ③ 段出现一次：正文段不得重复同一批命中文本
    assert.equal(ctx.bodyChars, 0, `专题范围有命中时正文段不得重复命中文本：bodyChars=${ctx.bodyChars}`)
    const omittedSentences = ctx.block.match(/另有 \d+ 篇因上下文上限未展开/g) ?? []
    assert.equal(omittedSentences.length, 1, `omitted 提示句必须只出现一次：${JSON.stringify(omittedSentences)}`)
    const markers = ctx.block.match(/--- Big\/Q\d+ ---/g) ?? []
    assert.ok(markers.length >= 12, `第 ③ 段必须逐篇给出带路径的命中：${markers.length}`)
    // 每篇命中片段的内容在 block 里只出现一次（不因「正文副本 + 命中」重复计数）
    const firstPaperPara = 'r2needle-0-x ' + 'x'.repeat(1_600)
    const firstSlice = firstPaperPara.slice(0, 1_200)
    assert.equal(ctx.block.split(firstSlice).length - 1, 1,
      '同一条命中片段正文在 block 里必须恰好出现一次（不得正文/命中两段各一份）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// G2. 如实提示：同名论文 / 不存在的专题
// ═════════════════════════════════════════════════════════════════════════════

test('R2-G2a 同名论文多命中：两篇都进 papers[] 且 omitted-duplicate + 逐条原因（不许静默少一篇）', (t) => {
  const { root, data } = newLib('dpr-r2-dup-')
  try {
    putPaper(data, 'Dup', 'Same', 'dup-body-one r2needle')
    putPaper(data, 'Dup/Nested', 'Same', 'dup-body-two r2needle')
    const cur = L.resolvePaper(data, { topic: 'Dup/Nested', name: 'Same' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Dup' }, 'r2needle')
    const paths = ctx.papers.map((p) => p.path).sort()
    t.diagnostic(`papers=${JSON.stringify(paths)} omitted=${ctx.omitted} notes=${JSON.stringify(ctx.omittedNotes)}`)
    // ← 基线在此红：只乘一篇（另一篇被 resolvePaper 的 catch 静默吞掉）
    assert.deepEqual(paths, ['Dup/Nested/Same', 'Dup/Same'], `两篇同名论文都必须出现在结果里：${JSON.stringify(paths)}`)
    assert.equal(ctx.papers.every((p) => p.coverage === 'omitted-duplicate'), true,
      `同名冲突的两篇都必须标 omitted-duplicate：${JSON.stringify(ctx.papers.map((p) => p.coverage))}`)
    assert.equal(ctx.omitted, 2, `两篇都要计入 omitted：实际 ${ctx.omitted}`)
    assert.equal(ctx.omittedNotes.length, 2, `每篇都要有一句原因：实际 ${ctx.omittedNotes.length}`)
    for (const note of ctx.omittedNotes) assert.match(note, /同名论文在多处/, `原因必须说清同名冲突：${note}`)
    assert.match(ctx.block, /同名论文在多处/, '提示里必须如实点名冲突（否则用户以为论文丢了）')
    assert.equal(ctx.block.includes('Dup/Same'), true)
    assert.equal(ctx.block.includes('Dup/Nested/Same'), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R2-G2b kind:"topic" 指向不存在专题：模块层 404；路由层不许空范围 200；存在专题正对照 200', async (t) => {
  const { root, data } = newLib('dpr-r2-404-')
  const s = await boot(data)
  try {
    putPaper(data, 'Real', 'P1', 'body')
    const cur = L.resolvePaper(data, { topic: 'Real', name: 'P1' })
    // ← 基线在此红：buildScopeContext 不抛错，装配出空范围
    assert.throws(
      () => SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Ghost' }, 'q'),
      (e) => e && e.code === 'not-found' && e.status === 404,
      '不存在的专题必须抛 code=not-found / status=404（不许「空的但看起来正常」）',
    )
    const r = await s.post('/api/ask', { topic: 'Real', name: 'P1', question: 'q', scope: { kind: 'topic', topic: 'Ghost' } })
    t.diagnostic(`route status=${r.status} body=${r.txt.slice(0, 160)}`)
    // ← 基线在此红：200
    assert.equal(r.status, 404, `已改名/删除的专题必须 404，不得 200 假成功：${r.status} ${r.txt}`)
    assert.equal(r.body?.code, 'not-found', `响应必须带机器码 not-found：${r.txt}`)
    // 正对照：存在的专题仍 200（证明不是把所有 topic 范围都拒了）
    const ok = await s.post('/api/ask', { topic: 'Real', name: 'P1', question: 'q', scope: { kind: 'topic', topic: 'Real' } })
    assert.equal(ok.status, 200, ok.txt)
    assert.equal(ok.body?.scope?.kind, 'topic', ok.txt)
    assert.equal(ok.body?.scope?.degraded, undefined, '存在的专题不得走降级分支')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// GC. U+1D400 代理对恰好跨切点（不得留孤立代理项）
// ═════════════════════════════════════════════════════════════════════════════

/** 把 𝐀 的高代理放在 `cut-1`（即朴素 slice(0,cut) 会切开它）。 */
function pairAt(text, cut) {
  return text.slice(0, cut - 1) + MATH_A + text.slice(cut - 1)
}

test('R2-GC1 单篇范围正文截断（8000）：𝐀 跨切点 ⇒ 输出无孤立代理项、字符不劈开、JSON 往返不炸', (t) => {
  const { root, data } = newLib('dpr-r2-gc1-')
  try {
    // 前 7999 字普通字符 ⇒ 高代理落在下标 7999（朴素 slice(0,8000) 正好切开）
    const body = pairAt('W'.repeat(7_999), 8_000) + 'R'.repeat(2_000)
    putPaper(data, 'PaperScope', 'OnlyOne', body)
    const cur = L.resolvePaper(data, { topic: 'PaperScope', name: 'OnlyOne' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'paper' }, 'q')
    t.diagnostic(`block=${ctx.block.length} lone=${loneSurrogates(ctx.block).length} hasMath=${ctx.block.includes(MATH_A)}`)
    // ← 基线在此红：high surrogate 留在块尾
    assert.deepEqual(loneSurrogates(ctx.block), [], '截断后的正文不得含孤立代理项（切点 8000）')
    assert.equal(ctx.block.includes(MATH_A), false, '切点上的字符必须整字丢弃，不得只留半个代理对')
    assert.equal(ctx.block.includes('W'.repeat(7_999)), true, '切点之前的正文必须在块里')
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.block)), ctx.block, 'JSON 往返必须不自炸')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R2-GC2 专题范围「无命中 ⇒ 开头片段」截断（8000）：同样不得切出孤立代理项', (t) => {
  const { root, data } = newLib('dpr-r2-gc2-')
  try {
    const body = pairAt('V'.repeat(7_999), 8_000) + 'U'.repeat(2_000)
    putPaper(data, 'TopicScope', 'NoHit', body)
    const cur = L.resolvePaper(data, { topic: 'TopicScope', name: 'NoHit' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'TopicScope' }, 'zzz-no-such-needle')
    t.diagnostic(`block=${ctx.block.length} lone=${loneSurrogates(ctx.block).length} coverage=${ctx.papers[0]?.coverage}`)
    assert.ok(ctx.papers[0]?.coverage === 'truncated' || ctx.papers[0]?.coverage === 'full', '前提：该篇确有展开')
    // ← 基线在此红
    assert.deepEqual(loneSurrogates(ctx.block), [], '无命中开头片段的截断不得切开代理对')
    assert.equal(ctx.block.includes(MATH_A), false, '切点上的字符必须整字丢弃')
    assert.equal(ctx.block.includes('V'.repeat(7_999)), true)
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.block)), ctx.block, 'JSON 往返必须不自炸')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R2-GC3 命中片段 1200 截断：𝐀 跨切点 ⇒ 输出无孤立代理项', (t) => {
  const { root, data } = newLib('dpr-r2-gc3-')
  try {
    // chunk0 前 1199 码元 = 'r2hit ' (6) + 'T'*1193 ⇒ 高代理落在 1199，1200 切点正好劈开
    const body = 'r2hit ' + 'T'.repeat(1_193) + MATH_A + 'S'.repeat(400)
    putPaper(data, 'HitScope', 'H', body)
    const cur = L.resolvePaper(data, { topic: 'HitScope', name: 'H' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'HitScope' }, 'r2hit')
    t.diagnostic(`hitChars=${ctx.hitChars} block=${ctx.block.length} lone=${loneSurrogates(ctx.block).length}`)
    assert.ok(ctx.hitChars > 0, '前提：确实有命中片段')
    assert.equal(ctx.papers[0]?.coverage, 'truncated', '前提：1200 上限确实生效')
    // ← 基线在此红
    assert.deepEqual(loneSurrogates(ctx.block), [], '命中片段 1200 截断不得切出孤立代理项')
    assert.equal(ctx.block.includes(MATH_A), false, '切点上的字符必须整字丢弃')
    assert.equal(ctx.block.includes('r2hit ' + 'T'.repeat(1_193)), true, '切点之前的命中片段正文必须在块里')
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.block)), ctx.block, 'JSON 往返必须不自炸')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R2-GC4 清单 MAX_MANIFEST 截断：多个偏移下都不得切出孤立代理项', (t) => {
  // 论文名全由 𝐀 组成 ⇒ 清单里连续的代理对；用 topic 名长度做偏移，使 2000 的切点落在不同奇偶
  for (const pad of [0, 1, 2]) {
    const { root, data } = newLib('dpr-r2-gc4-')
    try {
      const topic = 'M' + 'x'.repeat(pad)
      const art = ['.pdf', '.pages.json', '.transcript.json', '.mineru.json', '.embeddings.json']
      // 名字用 45 个 𝐀（90 码元 / 180 字节；再拼产物后缀仍 < NAME_MAX=255）；产物多列 ⇒ 清单必超 2000
      for (let i = 0; i < SC.MAX_PAPERS_IN_SCOPE; i++) {
        putPaper(data, topic, MATH_A.repeat(45) + String(i), null, art)
      }
      const cur = L.resolvePaper(data, { topic, name: MATH_A.repeat(45) + '0' })
      const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic }, 'q')
      const lone = loneSurrogates(ctx.block)
      t.diagnostic(`pad=${pad} manifestChars=${ctx.manifestChars} block=${ctx.block.length} lone=${lone.length}`)
      assert.match(ctx.block, /清单已截断至上限/, `pad=${pad}: 前提：清单必须确实被截断`)
      assert.deepEqual(lone, [], `pad=${pad}: 清单截断不得切出孤立代理项`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('R2-GC5 cutToCodePoint 原语语义：代理对只在整字边界切（helper 必须由本树提供）', () => {
  assert.equal(typeof SC.cutToCodePoint, 'function', 'dist/scope.js 必须导出 cutToCodePoint（等价回退原语）')
  const s = `ab${MATH_A}cd`
  // 𝐀 占下标 2..3；n=3 落在代理对中间 ⇒ 必须少切 1 个码元
  assert.equal(SC.cutToCodePoint(s, 3), 'ab', '切在代理对中间必须整字丢弃（不得留孤立高代理）')
  assert.equal(SC.cutToCodePoint(s, 4), `ab${MATH_A}`, '切在代理对之后必须保留整字')
  assert.equal(SC.cutToCodePoint(s, 5), `ab${MATH_A}c`, '常规切点不受影响')
  assert.equal(SC.cutToCodePoint(s, 0), '', 'limit=0 ⇒ 空串')
  assert.equal(SC.cutToCodePoint(s, 99), s, 'limit 超长 ⇒ 原样返回')
  for (const n of [1, 2, 3, 4, 5]) {
    const out = SC.cutToCodePoint(s, n)
    assert.deepEqual(loneSurrogates(out), [], `cutToCodePoint(${n}) 不得产生孤立代理项`)
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out, 'JSON 往返必须不自炸')
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// H. 客户端嵌套结构追踪
// ═════════════════════════════════════════════════════════════════════════════

test('R2-H1a dprReprefixTopic：前缀感知且带分隔符（A 改名不误伤 AB）', (t) => {
  const P = CLIENT.dprReprefixTopic
  assert.equal(typeof P, 'function', 'lib/client.js 顶层必须有 dprReprefixTopic（基线缺失）')
  t.diagnostic(`A/B→${P('A/B', 'A', 'X/A')} AB→${P('AB', 'A', 'X/A')}`)
  assert.equal(P('A/B', 'A', 'X/A'), 'X/A/B', '子专题必须整体换前缀')
  assert.equal(P('A', 'A', 'X/A'), 'X/A', '精确相等必须换')
  assert.equal(P('A/B/C', 'A/B', 'Y'), 'Y/C', '深层前缀同理')
  assert.equal(P('AB', 'A', 'X/A'), null, '同级同前缀名 AB 绝不能被误伤（必须带分隔符判定）')
  assert.equal(P('A2/B', 'A', 'X/A'), null, '前缀相似但不是子路径不得改写')
  assert.equal(P('', 'A', 'X/A'), null)
})

test('R2-H1b dprRekeyTopicState：cur / 折叠键 / dpr.last 整体换前缀，AB 不动', (t) => {
  const R = CLIENT.dprRekeyTopicState
  assert.equal(typeof R, 'function', 'lib/client.js 顶层必须有 dprRekeyTopicState（基线缺失）')
  const state = {
    cur: { topic: 'A/B', name: 'P' },
    closed: { 'A/B': true, AB: true, Z: true },
    last: { topic: 'A/B', name: 'P', n: 3 },
  }
  const out = R('A', 'X/A', state)
  t.diagnostic(`cur=${JSON.stringify(out.cur)} closed=${JSON.stringify(out.closed)} last=${JSON.stringify(out.last)}`)
  assert.deepEqual({ ...out.cur }, { topic: 'X/A/B', name: 'P' }, '阅读器 iframe 的 cur.topic 必须换前缀')
  assert.deepEqual({ ...out.last }, { topic: 'X/A/B', name: 'P', n: 3 }, 'dpr.last.topic 必须换前缀（否则刷新丢阅读位置）')
  assert.deepEqual({ ...out.closed }, { 'X/A/B': true, AB: true, Z: true }, '折叠键按前缀重写，AB/Z 不动')
  // 不改的状态：cur 不在被改名专题下时必须原样（同一引用也说明没白改）
  const untouched = { cur: { topic: 'Other/P', name: 'Q' }, closed: { AB: true }, last: null }
  const out2 = R('A', 'X/A', untouched)
  assert.deepEqual({ ...out2.cur }, { topic: 'Other/P', name: 'Q' })
  assert.deepEqual({ ...out2.closed }, { AB: true })
  assert.equal(out2.last, null)
})

test('R2-H1c migrateLsKeys：dpr.last 的 topic 也是路径（A→X/A 时 A/B 跟到 X/A/B；AB 不动）', (t) => {
  const src = CLIENT_SRC
  const at = src.search(/function\s+migrateLsKeys\s*\(/)
  assert.ok(at >= 0, 'lib/client.js 里必须有 migrateLsKeys')
  const fnSrc = src.slice(at, src.indexOf('{', at)) + braceBlock(src, src.indexOf('{', at))
  const store = new Map()
  const localStorage = {
    get length() { return store.size },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
  const ctx = { localStorage, console }
  vm.createContext(ctx)
  vm.runInContext(fnSrc + '\n;globalThis.__migrate = migrateLsKeys;', ctx, { filename: 'migrate-r2-inline.js' })
  const migrate = ctx.__migrate
  store.set('dpr.last', JSON.stringify({ topic: 'A/B', name: 'P', n: 2 }))
  store.set('dpr.variant.A/B/P-en', 'zh')
  migrate('A', 'X/A', null, null)
  const last = JSON.parse(store.get('dpr.last'))
  t.diagnostic(`dpr.last=${JSON.stringify(last)} keys=${JSON.stringify([...store.keys()])}`)
  // ← 基线在此红：dpr.last 仍是 A/B（精确相等判定）
  assert.deepEqual(last, { topic: 'X/A/B', name: 'P', n: 2 }, 'dpr.last.topic 必须跟前缀搬到 X/A/B（基线按精确相等 ⇒ 丢阅读位置）')
  assert.equal(store.get('dpr.variant.X/A/B/P-en'), 'zh', '论文级本地记忆也必须跟到新路径')
  assert.equal(store.has('dpr.variant.A/B/P-en'), false, '旧键必须删除')

  // A 与 AB：改名 A 不能动 AB 的 last
  store.clear()
  store.set('dpr.last', JSON.stringify({ topic: 'AB', name: 'Q', n: 1 }))
  migrate('A', 'X/A', null, null)
  assert.deepEqual(JSON.parse(store.get('dpr.last')), { topic: 'AB', name: 'Q', n: 1 }, 'AB 的 dpr.last 绝不能被 A 的改名误伤')
})

test('R2-H2 dprTopicPaperCount：按子树计数且 A 不含 AB（论文全在子专题 ⇒ clear 路径可得）', async (t) => {
  const C = CLIENT.dprTopicPaperCount
  assert.equal(typeof C, 'function', 'lib/client.js 顶层必须有 dprTopicPaperCount（基线缺失）')
  const papers = [
    { topic: 'A', name: 'direct' },
    { topic: 'A/B', name: 'nested' },
    { topic: 'A/B/C', name: 'deep' },
    { topic: 'AB', name: 'sibling' },
    { topic: 'A2', name: 'similar' },
  ]
  t.diagnostic(`count(A)=${C(papers, 'A')} count(A/B)=${C(papers, 'A/B')} count(AB)=${C(papers, 'AB')}`)
  assert.equal(C(papers, 'A'), 3, 'A 必须数整棵子树（A + A/B + A/B/C），不得漏子专题')
  assert.equal(C(papers, 'A/B'), 2, '子专题自身 + 更深层')
  assert.equal(C(papers, 'AB'), 1, 'AB 只能数自己（A 与 AB 不互串）')
  assert.equal(C(papers, 'A2'), 1)
  assert.equal(C([], 'A'), 0)
  assert.equal(C(papers, ''), 0)

  // 论文**全在子专题**的专题：UI 判据 n>0 ⇒ 走 clear-plan；并由服务端证明这条路真的可达
  const { root, data } = newLib('dpr-r2-h2-')
  const s = await boot(data)
  try {
    putPaper(data, 'OnlySub/Branch', 'Deep', 'body')
    const lib = await s.get('/api/library')
    assert.equal(lib.status, 200, lib.txt)
    const n = C(lib.body.papers, 'OnlySub')
    assert.ok(n > 0, `「论文全在子专题」的专题必须数出 >0 篇：${n}`)
    const plan = await s.get('/api/library/topic/clear-plan?topic=OnlySub')
    assert.equal(plan.status, 200, `按子树计数后必须能拿到 clear-plan（UI 的 clear 路径）：${plan.txt}`)
    assert.equal(plan.body.papers.length, 1, `clear-plan 必须列出子专题里的论文：${plan.txt}`)
    assert.equal(plan.body.papers[0].topic, 'OnlySub/Branch')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R2-H3 dprApiError 透传 clearEndpoint + dprClearRetryNeeded 判据可达（真实 409 响应体）', async (t) => {
  const E = CLIENT.dprApiError
  const need = CLIENT.dprClearRetryNeeded
  assert.equal(typeof E, 'function', 'lib/client.js 顶层必须有 dprApiError（基线 api() 没挂 clearEndpoint）')
  assert.equal(typeof need, 'function', 'lib/client.js 顶层必须有 dprClearRetryNeeded')
  const { root, data } = newLib('dpr-r2-h3-')
  const s = await boot(data)
  try {
    putPaper(data, 'FullSub/Branch', 'P', 'body')   // FullSub 本身没有直接论文
    const del = await s.post('/api/library/delete-topic', { name: 'FullSub' })
    t.diagnostic(`delete-topic=${del.status} body=${del.txt.slice(0, 220)}`)
    assert.equal(del.status, 409, `非空专题必须 409：${del.txt}`)
    assert.equal(del.body?.code, 'topic-not-empty', del.txt)
    assert.equal(typeof del.body?.clearEndpoint, 'string', '服务端 409 必须给出清空端点（UI 重试的「下一步」）')

    const err = E(del.status, del.body)
    assert.equal(err.code, 'topic-not-empty')
    assert.equal(err.status, 409)
    assert.equal(err.clearEndpoint, del.body.clearEndpoint, 'clearEndpoint 必须透传到 Error（否则重试是死代码）')
    assert.equal(need(err), true, '真实 409 ⇒ 重试判据必须为 true（H3 的死代码被接通）')

    // 判据负向：别的错误不重试；缺 clearEndpoint 也不重试
    assert.equal(need({ code: 'topic-not-empty' }), false)
    assert.equal(need({ code: 'file-busy', clearEndpoint: '/x' }), false)
    assert.equal(need(null), false)

    // 「重试」后的下一步真的可达：clear-plan 能列出子专题论文（与 H2 的 UI 路径闭合）
    const plan = await s.get(`/api/library/topic/clear-plan?topic=${encodeURIComponent('FullSub')}`)
    assert.equal(plan.status, 200, plan.txt)
    assert.equal(plan.body.papers.length, 1, plan.txt)
    assert.equal(plan.body.papers[0].topic, 'FullSub/Branch')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R2-H4 改名后的身份能拼出可用请求路径（X/A/B 200，旧 A/B 404）', async (t) => {
  const R = CLIENT.dprRekeyTopicState
  assert.equal(typeof R, 'function', 'lib/client.js 顶层必须有 dprRekeyTopicState')
  const { root, data } = newLib('dpr-r2-h4-')
  const s = await boot(data)
  try {
    putPaper(data, 'X/A/B', 'P', 'body')   // 模拟 A→X/A 改名后的库
    const rekeyed = R('A', 'X/A', { cur: { topic: 'A/B', name: 'P' }, closed: {}, last: null })
    assert.deepEqual({ ...rekeyed.cur }, { topic: 'X/A/B', name: 'P' })
    const topic = rekeyed.cur.topic
    const plan = await s.get(`/api/library/paper/delete-plan?topic=${encodeURIComponent(topic)}&name=${encodeURIComponent(rekeyed.cur.name)}`)
    t.diagnostic(`new-path status=${plan.status} old-path ...`)
    assert.equal(plan.status, 200, `iframe 换前缀后的请求路径必须可用：${plan.txt}`)
    assert.equal(plan.body.topic, 'X/A/B')
    const old = await s.get('/api/library/paper/delete-plan?topic=A%2FB&name=P')
    assert.equal(old.status, 404, `旧路径 A/B 必须 404（正是修复前的现象）：${old.status} ${old.txt}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// 基线模式自检（让「基线 N 红」的计数可解释）
if (BASELINE_MODE) {
  test('R2-0 基线模式自检', (t) => {
    t.diagnostic(`R2_REPO 模式：目标树 = ${TARGET}（行为断言红 = 基线确有该缺陷）`)
    assert.ok(true)
  })
}
