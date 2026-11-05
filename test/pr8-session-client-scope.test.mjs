// test/pr8-session-client-scope.test.mjs — PR #8 维护者评审「A / G / H + scope 码点截断」的可区分靶子。
//
// 每一条都对应 @GGboya 评审原文里的一句断言（docs/pr8-maintainer-review.md）：
//   A  会话 id 与嵌套专题不兼容（paperFromSessionId / parseDprSession 按第一个 `/` 切）
//       + 子专题论文的 ⓘ「对话还停在另一篇」永远常亮
//   G1 专题范围提问的命中片段不计预算（12 篇×3 命中 ⇒ totalChars 72574 > 40000）、omitted 句重复
//   G2 多篇同名论文静默消失（无 omitted 标注）；kind:'topic' 指向不存在的专题仍 200 假成功
//   GC scope.ts 5 处码元截断切开代理对（U+1D400；孤立代理项进会话历史 ⇒ 整条会话 400）
//   H1 祖先专题改名只按精确相等更新 cur/dpr.last/closed（读 A/B 时改名 A→X/A 后 iframe 仍持 A/B）
//   H2 openDelete 的 clear-vs-delete 只数直接论文（论文全在子专题 ⇒ 没有 UI 路径到 /topic/clear）
//   H3 doDeleteTopic 的 clearEndpoint 重试是死代码（api() 没把 clearEndpoint 挂到 Error 上）
//
// 约定：只 import dist/*.js（跑前 `npm run build`）；破坏性实验一律 mkdtemp 临时库 + 临时 DSH_HOME，
// 绝不碰真实文献库 / 真实 ~/.dsh。客户端纯函数用「真执行 lib/client.js 顶层」的方式测（不是 grep）。
//
// 修复前（fdb45f2 基线）本文件必须红；修复后必须绿。证据见
// docs/evidence/pr8-session-client-scope.md。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

// 配置类端点可能读 $DSH_HOME：换成临时目录，红线「不碰真实 ~/.dsh」
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-pr8-scs-home-'))

const L = await import(pathToFileURL(dist('library.js')).href)
const M = await import(pathToFileURL(dist('library-manage.js')).href)
const SC = await import(pathToFileURL(dist('scope.js')).href)
const TOOLS = await import(pathToFileURL(dist('tools.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// ═══════════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════════

function newLib(prefix = 'dpr-pr8-scs-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局落一篇论文（`<data>/<topic>/<name>/<name>.pdf`）。 */
function putPaper(data, topic, name, extra = ['.txt']) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.pdf'), `pdf:${topic}/${name}`)
  for (const s of extra) writeFileSync(join(dir, name + s), `body ${topic}/${name}`)
  return dir
}

function sessionIdOf(path, n = 1) {
  return `dpr-${Buffer.from(path, 'utf8').toString('base64url')}-${n}`
}

/** 孤立代理项检测：返回所有「落单」的 UTF-16 索引（高代理后必须紧跟低代理，反之亦然）。 */
function loneSurrogateIndexes(s) {
  const bad = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (n >= 0xdc00 && n <= 0xdfff) i++
      else bad.push(i)
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bad.push(i)
    }
  }
  return bad
}

async function bootAsk(data, { prompt } = {}) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {
      list: async () => ({ items: [] }),
      create: async () => ({}),
      prompt: prompt ?? (async () => {}),
    },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const postJson = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt }
  }
  return { srv, postJson }
}

// ═══════════════════════════════════════════════════════════════════════════
// 客户端（lib/client.js）：真执行顶层，取纯函数
// ═══════════════════════════════════════════════════════════════════════════

function loadClientPure() {
  let loaded = null
  const ctx = { window: { __ModuleLoader__: { load: (m) => { loaded = m } } }, console, atob }
  vm.createContext(ctx)
  vm.runInContext(
    readFileSync(join(REPO, 'lib', 'client.js'), 'utf8') + `
;globalThis.__dpr = {
  parseDprSession: typeof parseDprSession === 'function' ? parseDprSession : null,
  dprSessionStale: typeof dprSessionStale === 'function' ? dprSessionStale : null,
  dprReprefixTopic: typeof dprReprefixTopic === 'function' ? dprReprefixTopic : null,
  dprRekeyTopicState: typeof dprRekeyTopicState === 'function' ? dprRekeyTopicState : null,
  dprTopicPaperCount: typeof dprTopicPaperCount === 'function' ? dprTopicPaperCount : null,
  dprApiError: typeof dprApiError === 'function' ? dprApiError : null,
  dprClearRetryNeeded: typeof dprClearRetryNeeded === 'function' ? dprClearRetryNeeded : null,
};`,
    ctx, { filename: 'client-pr8-inline.js' },
  )
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须通过 __ModuleLoader__.load 注册模块')
  return ctx.__dpr
}

function needClient(name) {
  const P = loadClientPure()
  assert.equal(typeof P[name], 'function',
    `lib/client.js 顶层必须有纯函数 ${name}（评审修复的落点；缺失说明测试是空转）`)
  return P[name]
}

function fakeLocalStorage(store) {
  return {
    get length() { return store.size },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
}

/** 取 `src[at]`（一个 `{`）起的配对代码块原文（跳过字符串/注释，避免被文案里的括号骗到）。 */
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

/** 真跑 client.js 里的 migrateLsKeys（改名搬家的唯一实现），在给定 localStorage 上执行。 */
function loadMigrateLsKeys(store) {
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const at = src.search(/function\s+migrateLsKeys\s*\(/)
  assert.ok(at >= 0, 'lib/client.js 里必须有 migrateLsKeys')
  const ctx = { localStorage: fakeLocalStorage(store), console }
  vm.createContext(ctx)
  vm.runInContext(
    src.slice(at, src.indexOf('{', at)) + braceBlock(src, src.indexOf('{', at)) + '\n;globalThis.__migrate = migrateLsKeys;',
    ctx, { filename: 'migrate-pr8-inline.js' },
  )
  assert.equal(typeof ctx.__migrate, 'function', 'migrateLsKeys 必须能被取到（否则本用例是空转）')
  return ctx.__migrate
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 会话 id 与嵌套专题
// ═══════════════════════════════════════════════════════════════════════════

test('A1 【评审 A】paperFromSessionId：嵌套专题按最后一个 / 切（A/B/P ⇒ topic=A/B）；扁平不回归；非法仍 null', () => {
  assert.equal(typeof TOOLS.paperFromSessionId, 'function', 'dist/tools.js 必须导出 paperFromSessionId')
  const deep = TOOLS.paperFromSessionId(sessionIdOf('A/B/P'))
  assert.deepEqual(deep, { topic: 'A/B', name: 'P' }, `深专题必须解成 topic=A/B / name=P：${JSON.stringify(deep)}`)
  assert.deepEqual(TOOLS.paperFromSessionId(sessionIdOf('A/B/C/P', 3)), { topic: 'A/B/C', name: 'P' }, '三层专题同理')
  // 扁平（不相对于改造前回归）
  assert.deepEqual(TOOLS.paperFromSessionId(sessionIdOf('T/P')), { topic: 'T', name: 'P' })
  // 非法 id：无 `/`、末尾 `/`、开头 `/`、非伴读前缀、undefined
  assert.equal(TOOLS.paperFromSessionId(sessionIdOf('P')), null, '无 / 必须 null')
  assert.equal(TOOLS.paperFromSessionId(sessionIdOf('A/B/')), null, '末尾 /（空 name）必须 null')
  assert.equal(TOOLS.paperFromSessionId(sessionIdOf('/P')), null, '开头 /（空 topic）必须 null')
  assert.equal(TOOLS.paperFromSessionId('sess-abc'), null, '非 dpr- 会话必须 null')
  assert.equal(TOOLS.paperFromSessionId(undefined), null)
})

test('A2 【评审 A】parseDprSession 同语义 + 子专题论文的 ⓘ「对话还停在另一篇」不再永远常亮', () => {
  const P = needClient('parseDprSession')
  const S = needClient('dprSessionStale')
  const deep = P(sessionIdOf('A/B/P', 2))
  assert.deepEqual({ ...deep }, { topic: 'A/B', name: 'P', n: 2 }, `parseDprSession 必须解出 topic=A/B：${JSON.stringify(deep)}`)
  assert.deepEqual({ ...P(sessionIdOf('T/P')) }, { topic: 'T', name: 'P', n: 1 }, '扁平不回归')
  assert.equal(P(sessionIdOf('P')), null)
  assert.equal(P(sessionIdOf('A/B/')), null)
  assert.equal(P('sess-abc'), null)
  assert.equal(P(undefined), null)

  // ⓘ 按钮的判定：会话绑定的论文 vs 阅读器当前论文。子专题论文两边相同 ⇒ **不得**判成「停在另一篇」。
  const viewed = { topic: 'A/B', name: 'P' }
  assert.equal(S(P(sessionIdOf('A/B/P')), viewed), false,
    '子专题论文：会话与阅读器是同一篇，⚠ 按钮必须不亮（评审 A 第二条）')
  assert.equal(S(P(sessionIdOf('A/B/Q')), viewed), true, '真的是另一篇时必须亮')
  assert.equal(S(P(sessionIdOf('A/B/P')), null), false, '阅读器没有当前论文时不提示')
  // 接线：SessionActions 的 mismatch 必须走纯函数（否则上面的函数只是摆设）
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(src, /const mismatch = dprSessionStale\(chatPaper, viewed\)/, 'mismatch 必须由 dprSessionStale 计算')
})

// ═══════════════════════════════════════════════════════════════════════════
// G1. 命中片段计预算 + omitted 句只出现一次
// ═══════════════════════════════════════════════════════════════════════════

/** 12 篇 × 每篇 3 个命中（每段 >1500 字 ⇒ chunkText 硬切成 1500 字块，块首带 token）。 */
function bigHitLib(paperCount = SC.MAX_PAPERS_IN_SCOPE) {
  const { root, data } = newLib('dpr-pr8-scs-hits-')
  for (let i = 0; i < paperCount; i++) {
    const name = `P${String(i).padStart(2, '0')}`
    putPaper(data, 'Big', name, [])
    const paras = ['a', 'b', 'c'].map((ch) => 'hit-token ' + ch.repeat(1600))
    writeFileSync(join(data, 'Big', name, name + '.txt'), paras.join('\n\n'))
  }
  const cur = L.resolvePaper(data, { topic: 'Big', name: 'P00' })
  return { root, data, cur }
}

test('G1 【评审 G】12 篇×3 命中的专题范围：命中片段计入预算，totalChars ≤ 40000；omitted 句只出现一次', (t) => {
  const { root, data, cur } = bigHitLib()
  try {
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Big' }, 'hit-token')
    t.diagnostic(`totalChars=${ctx.totalChars} manifest=${ctx.manifestChars} body=${ctx.bodyChars} hits=${ctx.hitChars} omitted=${ctx.omitted} block=${ctx.block.length}`)
    assert.ok(ctx.hitChars > 0, '必须真的有命中片段（否则预算断言是空转）')
    assert.ok(ctx.omitted > 0, '12 篇 × 3 命中必然超预算 ⇒ 必须有显式 omitted（不许超预算硬塞）')
    assert.ok(ctx.totalChars <= SC.MAX_CONTEXT_CHARS,
      `totalChars 必须 ≤ ${SC.MAX_CONTEXT_CHARS}（评审实测修复前 72574）：${ctx.totalChars}`)
    assert.ok(ctx.block.length <= SC.MAX_CONTEXT_CHARS + 800,
      `最终 block 也不得明显超上限（段标题/末尾说明的余量 400）：${ctx.block.length}`)
    assert.equal(ctx.totalChars, ctx.manifestChars + ctx.bodyChars + ctx.hitChars,
      'totalChars 的三个组成必须自洽（命中片段与正文都计费）')
    // omitted 提示句只出现一次（修复前 tail 与 block 各输出一遍）
    const omittedSentence = ctx.block.match(/另有 \d+ 篇因上下文上限未展开/g) ?? []
    assert.equal(omittedSentence.length, 1, `omitted 提示句必须只出现一次：${JSON.stringify(omittedSentence)}`)
    // 命中片段只在第 ③ 段出现一次（修复前正文=同一批命中再拼一遍，与第 ③ 段重复）
    assert.equal(ctx.bodyChars, 0,
      '专题范围有命中时正文段不得重复同一批片段（命中只在「检索命中」段输出一次，计入 hitChars）')
    const markers = ctx.block.match(/--- Big\/P\d+ ---/g) ?? []
    assert.ok(markers.length > 0, '第 ③ 段必须有带路径的命中片段')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// G2. 如实提示：同名论文 + 不存在的专题
// ═══════════════════════════════════════════════════════════════════════════

test('G2a 【评审 G】多篇同名论文不再静默消失：进 omitted 并带原因，结果里可机器读', () => {
  const { root, data } = newLib()
  try {
    putPaper(data, 'A', 'P')
    putPaper(data, 'A/B', 'P')
    const cur = L.resolvePaper(data, { topic: 'A/B', name: 'P' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'A' }, 'body')
    assert.deepEqual(ctx.papers.map((p) => p.path).sort(), ['A/B/P', 'A/P'],
      `两篇同名论文都必须出现在结果里（或被显式点名），绝不能静默少一篇：${JSON.stringify(ctx.papers.map((p) => p.path))}`)
    assert.ok(ctx.papers.every((p) => p.coverage === 'omitted-duplicate'),
      `同名冲突的两篇都要标 omitted-duplicate：${JSON.stringify(ctx.papers.map((p) => p.coverage))}`)
    assert.equal(ctx.omitted, 2, '两篇都要计入 omitted')
    assert.equal(ctx.omittedNotes.length, 2, '每篇都要有一句原因')
    for (const note of ctx.omittedNotes) assert.match(note, /同名论文在多处/, `原因必须说清是「同名论文在多处」：${note}`)
    assert.match(ctx.block, /同名论文在多处/, '提示里必须如实点名冲突（否则用户以为论文丢了）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('G2b 【评审 G】kind:"topic" 指向不存在的专题：模块层 404，路由层不许空 200 假成功', async () => {
  const { root, data } = newLib()
  const { srv, postJson } = await bootAsk(data)
  try {
    putPaper(data, 'A', 'P1')
    const cur = L.resolvePaper(data, { topic: 'A', name: 'P1' })

    // ① 模块层：明确的 not-found（不是「空的但看起来正常」的范围）
    assert.throws(
      () => SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'NoSuch' }, 'q'),
      (e) => e && e.code === 'not-found' && e.status === 404,
      '不存在的专题必须抛 code=not-found / status=404',
    )

    // ② 路由层：非 200；机器码 not-found（不再装配空范围 + 200）
    const r = await postJson('/api/ask', { topic: 'A', name: 'P1', question: 'q', scope: { kind: 'topic', topic: 'NoSuch' } })
    assert.equal(r.status, 404, `已改名/删除的专题必须 404，不得 200 假成功：${r.status} ${r.txt}`)
    assert.equal(r.body?.code, 'not-found', `响应必须带机器码 not-found：${r.txt}`)

    // ③ 正对照：范围里的专题**存在**时仍正常工作（证明上面不是把所有 topic 范围都拒了）
    const ok = await postJson('/api/ask', { topic: 'A', name: 'P1', question: 'q', scope: { kind: 'topic', topic: 'A' } })
    assert.equal(ok.status, 200, ok.txt)
    assert.equal(ok.body?.scope?.kind, 'topic', ok.txt)
  } finally {
    srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// GC. scope.ts 码点截断（U+1D400 跨切点不得产生孤立代理项）
// ═══════════════════════════════════════════════════════════════════════════

const BOLD_A = '\u{1D400}' // MATHEMATICAL BOLD CAPITAL A，占 2 个 UTF-16 码元

test('GC1 cutToCodePoint：切点落在代理对中间时少切 1 个码元（不越界、不留孤立代理项）', () => {
  assert.equal(typeof SC.cutToCodePoint, 'function', 'dist/scope.js 必须导出 cutToCodePoint')
  const cut = SC.cutToCodePoint
  // 'x' + N 个代理对：索引 7999 是高代理（奇数位）⇒ 必须退到 7999（丢掉那个高代理）
  const mixed = 'x' + BOLD_A.repeat(5000)
  const c = cut(mixed, 8000)
  assert.equal(c.length, 7999, `切点落在代理对中间必须少切 1 个码元：${c.length}`)
  assert.deepEqual(loneSurrogateIndexes(c), [], '结果不得含孤立代理项')
  assert.equal(JSON.parse(JSON.stringify(c)), c, 'JSON 往返不炸')
  // 纯代理对：limit=3 落在高代理上 ⇒ 2；limit=4 落在低代理（安全边界）⇒ 4
  assert.equal(cut(BOLD_A.repeat(5), 3).length, 2)
  assert.equal(cut(BOLD_A.repeat(5), 4).length, 4)
  // 不越界 / 原样返回 / 0 / 非有限值
  assert.equal(cut('abc', 5), 'abc')
  assert.equal(cut('abc', 0), '')
  assert.equal(cut(mixed, Number.MAX_SAFE_INTEGER), mixed)
  assert.equal(cut(mixed, Number.POSITIVE_INFINITY), mixed)
})

test('GC2 单篇范围正文截断（readText / body limit）：U+1D400 跨切点不留孤立代理项', () => {
  const { root, data } = newLib()
  try {
    const dir = putPaper(data, 'U', 'P', [])
    writeFileSync(join(dir, 'P.txt'), 'x' + BOLD_A.repeat(5000)) // 10001 码元 > MAX_PER_DOC
    const cur = L.resolvePaper(data, { topic: 'U', name: 'P' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'paper' }, 'q')
    assert.equal(ctx.papers[0].coverage, 'truncated', '超 MAX_PER_DOC 必须显式截断')
    assert.deepEqual(loneSurrogateIndexes(ctx.block), [],
      `截断后的正文不得含孤立代理项（切点 ${ctx.papers[0].chars}）`)
    assert.equal(JSON.parse(JSON.stringify(ctx.block)), ctx.block, 'prompt 片段必须能 JSON 往返')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('GC3 专题范围「无命中 ⇒ 开头片段」截断：U+1D400 跨切点不留孤立代理项', () => {
  const { root, data } = newLib()
  try {
    const dir = putPaper(data, 'U', 'P', [])
    writeFileSync(join(dir, 'P.txt'), 'z' + BOLD_A.repeat(5000))
    const cur = L.resolvePaper(data, { topic: 'U', name: 'P' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'U' }, 'no-such-token')
    assert.match(ctx.block, /无关键词命中/, '无命中必须显式标注（否则本用例可能是空转）')
    assert.deepEqual(loneSurrogateIndexes(ctx.block), [], '开头片段截断不得含孤立代理项')
    assert.equal(JSON.parse(JSON.stringify(ctx.block)), ctx.block, '必须能 JSON 往返')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('GC4 命中片段截断（chunk.text.slice(0,1200)）：U+1D400 跨切点不留孤立代理项', () => {
  const { root, data } = newLib()
  try {
    const dir = putPaper(data, 'U', 'P', [])
    // chunkText 硬切 1500：块内索引 1199 是高代理（token 10 + 'x' 1 + 代理对从 11 起）⇒ 1200 切点跨对
    writeFileSync(join(dir, 'P.txt'), 'hit-token ' + 'x' + BOLD_A.repeat(800))
    const cur = L.resolvePaper(data, { topic: 'U', name: 'P' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'U' }, 'hit-token')
    assert.match(ctx.block, /--- U\/P ---/, '必须有命中片段（否则本用例是空转）')
    assert.deepEqual(loneSurrogateIndexes(ctx.block), [],
      `命中片段 1200 截断不得切出孤立代理项（block.hitChars=${ctx.hitChars}）`)
    assert.equal(JSON.parse(JSON.stringify(ctx.block)), ctx.block, '必须能 JSON 往返')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// H1. 祖先专题改名：cur / dpr.last / closed 前缀感知
// ═══════════════════════════════════════════════════════════════════════════

test('H1a 【评审 H】dprReprefixTopic 前缀感知：A→X/A 时 A/B 跟着走，同级同前缀 AB 不被误伤', () => {
  const P = needClient('dprReprefixTopic')
  assert.equal(P('A/B', 'A', 'X/A'), 'X/A/B', '子专题路径整体换前缀')
  assert.equal(P('A', 'A', 'X/A'), 'X/A', '专题自身')
  assert.equal(P('A/B/C', 'A/B', 'X/A/B'), 'X/A/B/C', '多层改名')
  assert.equal(P('AB', 'A', 'X/A'), null, '`AB` 不是 `A` 的子路径（前缀判定必须带分隔符）')
  assert.equal(P('A/BC', 'A/B', 'X'), null, '`A/BC` 不是 `A/B` 的子路径')
  assert.equal(P('Other/P', 'A', 'X/A'), null, '无关专题不动')
  assert.equal(P(null, 'A', 'X/A'), null, '非法入参返回 null（不抛）')
})

test('H1b 【评审 H】专题改名后状态整体换前缀：cur / closed / dpr.last（含 migrateLsKeys 真执行）', () => {
  const P = needClient('dprRekeyTopicState')
  const st = {
    cur: { topic: 'A/B', name: 'P', n: 2 },
    closed: { 'A/B': false, AB: true, A: true },
    last: { topic: 'A/B', name: 'P' },
  }
  const out = P('A', 'X/A', st)
  assert.equal(out.cur.topic, 'X/A/B', 'cur（阅读器 iframe 身份）必须跟到 X/A/B')
  assert.equal(out.cur.name, 'P', '论文名不变')
  assert.equal(out.last.topic, 'X/A/B', 'dpr.last 也必须跟')
  assert.equal(st.cur.topic, 'A/B', '纯函数不得原地改入参')
  // 跨 realm（vm 里造的对象）→ 用 JSON 归一后再比，否则原型不同会让 deepStrictEqual 误报
  assert.deepEqual(JSON.parse(JSON.stringify(out.closed)), { 'X/A/B': false, AB: true, 'X/A': true },
    `折叠键必须整体换前缀且不误伤 AB：${JSON.stringify(out.closed)}`)

  // dpr.last / 按篇记忆键由 migrateLsKeys 真执行搬（不是只看源码）
  const store = new Map([
    ['dpr.last', JSON.stringify({ topic: 'A/B', name: 'P' })],
    ['dpr.variant.A/B/P', 'split'],
    ['dpr.sessionN.A/B/P', '3'],
    ['dpr.variant.AB/P', 'orig'],
  ])
  const migrate = loadMigrateLsKeys(store)
  migrate('A', 'X/A', null, null)
  assert.equal(JSON.parse(store.get('dpr.last')).topic, 'X/A/B', `dpr.last 必须跟到 X/A/B：${store.get('dpr.last')}`)
  assert.equal(store.get('dpr.variant.X/A/B/P'), 'split', '按篇记忆键搬到新前缀')
  assert.equal(store.get('dpr.sessionN.X/A/B/P'), '3')
  assert.equal(store.get('dpr.variant.AB/P'), 'orig', '同名前缀（AB）绝不能被搬')

  // 接线：doRename 必须用纯函数并把新身份派发给阅读器（否则 iframe 仍持 ?topic=A/B）
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(src, /const rekeyed = dprRekeyTopicState\(topic, to, \{ cur \}\)/, 'doRename 必须用 dprRekeyTopicState 重写 cur')
  assert.match(src, /detail: \{ topic: rekeyed\.cur\.topic, name: rekeyed\.cur\.name \}/, '必须把新身份经 dpr:paper 派发给阅读器')
  // 阅读器 iframe 的 src 由 ReaderOverlay 的 cur 决定；它跟随 dpr:paper 的 detail ⇒ 派发即让 iframe 换 ?topic=
  assert.match(src, /setCur\(\{ topic: e\.detail\.topic, name: e\.detail\.name/, 'ReaderOverlay 必须用 dpr:paper 的 detail 更新 iframe 身份')
  assert.match(src, /const rekeyed = dprRekeyTopicState\(topic, to, \{ closed: c \}\)\.closed/, '折叠键也必须前缀感知')
})

// ═══════════════════════════════════════════════════════════════════════════
// H2. openDelete 按子树计数
// ═══════════════════════════════════════════════════════════════════════════

test('H2 【评审 H】openDelete 的 clear-vs-delete 按子树计数：论文全在子专题也走 clear-plan', () => {
  const P = needClient('dprTopicPaperCount')
  const papers = [
    { topic: 'A/B', name: 'P' },
    { topic: 'A/B/C', name: 'Q' },
    { topic: 'AB', name: 'R' },
    { topic: 'Other', name: 'S' },
  ]
  assert.equal(P(papers, 'A'), 2, `A 的子树有 2 篇（只数直接论文 ⇒ 0，正是评审 H2 的缺陷）：${P(papers, 'A')}`)
  assert.equal(P(papers, 'A/B'), 2, 'A/B 子树含 A/B/C')
  assert.equal(P(papers, 'AB'), 1, 'AB 是同级同前缀名，不能被算进 A')
  assert.equal(P([], 'A'), 0)
  assert.equal(P(undefined, 'A'), 0, 'lib 还没加载时返回 0（不抛）')
  // 接线：openDelete 必须用子树计数（不是 p.topic === name）
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const at = src.indexOf('const openDelete = useCallback(')
  assert.ok(at >= 0, '必须找到 openDelete')
  const body = src.slice(at, at + braceBlock(src, src.indexOf('{', at)).length)
  assert.match(body, /dprTopicPaperCount\(lib\?\.papers, name\)/, 'openDelete 必须按子树计数')
  assert.ok(!/filter\(\(p\) => p\.topic === name\)/.test(body), '不得退回「只数直接论文」的旧写法')
})

// ═══════════════════════════════════════════════════════════════════════════
// H3. clearEndpoint 重试路径可达
// ═══════════════════════════════════════════════════════════════════════════

test('H3 【评审 H】doDeleteTopic 的 clearEndpoint 重试真实可达：api 错误透传 + 判据可达', async () => {
  const P = needClient('dprApiError')
  const R = needClient('dprClearRetryNeeded')

  // ① 服务端 409 topic-not-empty 的真实响应体（host.ts 会带 clearEndpoint）⇒ 错误必须带出来
  const body = {
    error: '专题内还有 1 个条目（1 篇文献），请用批量清空或先逐篇删除',
    code: 'topic-not-empty',
    entries: ['P/P.pdf'],
    papers: [{ topic: 'A/B', name: 'P' }],
    clearEndpoint: '/api/library/topic/clear',
    clearPlanEndpoint: '/api/library/topic/clear-plan',
  }
  const err = P(409, body)
  assert.equal(err.code, 'topic-not-empty')
  assert.equal(err.status, 409)
  assert.deepEqual(err.papers, body.papers, 'papers 仍要透传（既有行为不回归）')
  assert.equal(err.clearEndpoint, '/api/library/topic/clear', 'clearEndpoint 必须挂到 Error 上（否则重试是死代码）')
  assert.equal(err.clearPlanEndpoint, '/api/library/topic/clear-plan')
  assert.equal(R(err), true, '409 + clearEndpoint ⇒ 必须重试到「批量清空」中间态')
  // ② 负向：没有 clearEndpoint / 别的 code 都不重试
  assert.equal(R(P(409, { code: 'topic-not-empty' })), false)
  assert.equal(R(P(409, { code: 'other', clearEndpoint: '/x' })), false)
  assert.equal(R(null), false)

  // ③ 端到端：服务端起一个真实 409，把响应体交给客户端错误构造 + 判据（证明字段真的来自线上）
  const { root, data } = newLib()
  const { srv, postJson } = await bootAsk(data)
  try {
    putPaper(data, 'A/B', 'P')
    const r = await postJson('/api/library/delete-topic', { name: 'A', topic: 'A', confirmName: 'A' })
    assert.equal(r.status, 409, r.txt)
    assert.equal(r.body?.code, 'topic-not-empty', r.txt)
    assert.equal(r.body?.clearEndpoint, '/api/library/topic/clear', '服务端必须给清空入口')
    assert.equal(R(P(r.status, r.body)), true, '线上 409 响应必须能触发「改批清空」重试')
  } finally {
    srv.close()
    rmSync(root, { recursive: true, force: true })
  }

  // ④ 接线：api() 用 dprApiError 抛；doDeleteTopic 用纯函数判据
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(src, /throw dprApiError\(r\.status, body\)/, 'api() 必须经 dprApiError 抛错')
  const at = src.indexOf('const doDeleteTopic = useCallback(')
  assert.ok(at >= 0, '必须找到 doDeleteTopic')
  const fnBody = src.slice(at, at + braceBlock(src, src.indexOf('{', at)).length)
  assert.match(fnBody, /dprClearRetryNeeded\(e\)/, 'doDeleteTopic 必须用可达的判据重试（不是 e?.clearEndpoint 死代码）')
})
