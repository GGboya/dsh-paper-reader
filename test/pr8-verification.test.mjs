// test/pr8-verification.test.mjs — VER（t7）对 PR #8 维护者评审 A–H 修复的**独立验证探针**。
//
// 独立性声明（团队 profile：验证/评审不得采信实现方或评审方自述）：
//   · 本文件不 import 三个实现方用例（test/pr8-layout-collision / pr8-session-client-scope /
//     pr8-clear-migrate）与三份 reviewer 探针（test/pr8-review-r1/r2/r3）；夹具全部自造：
//     专题 `VerA`/`VerB/VerSubB`、论文 `VerPaper`、needle `verneedle-<i>-<k>`、坏日志注入行、
//     110 字专题 `Z×110`、码点样本 U+1D400。
//   · 只 import `dist/*.js`（跑前 `flock /tmp/dpr-pr8-build.lock -c 'npm run build'`）；`lib/client.js`
//     在 node:vm 里**真执行**取顶层纯函数，基线缺失的顶层函数从源码里抠函数体真执行（不是 grep）。
//   · 同一份探针可跑 **fdb45f2 基线**：
//       VER_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
//         node --test test/pr8-verification.test.mjs
//     缺陷条目应红（本探针自己跑出来的红，不是引用任何人的报告）。
//   · 破坏性实验全部 mkdtemp 临时库 + 临时 DSH_HOME（进程内设定），绝不碰真实文献库。
//
// 覆盖（docs/pr8-maintainer-review.md）：
//   A 会话 id 嵌套专题（tools.paperFromSessionId + 客户端 parseDprSession）
//   B 上传碰撞（同名子专题 / 同名论文目录 / 旧平铺产物）
//   C 目录-文件互踩（create-topic 落论文目录 / rename-topic 搬进论文目录 / create-topic 撞平铺 /
//     rename-paper 目标内残留不静默覆盖 / 平铺改名撞目录）
//   D 清空占用与确认清单（整棵子树）
//   E 迁移契约（坏 JSONL 回滚退出码 / 阶段 1 中断复跑）
//   F boundaryOnly 长度回归（110 字 legacy 专题可删可改名；创建侧仍拒）
//   G 范围预算与诚实性（≤40000 / omitted 一句 / 命名冲突如实 / 专题不存在 404 / 码点安全）
//   H 客户端嵌套追踪（前缀感知 rekey / 子树计数 / clearEndpoint 透传）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 默认测当前修复树；`VER_REPO` 指向基线工作树时跑基线对照。 */
const REPO = process.env.VER_REPO ? resolve(process.env.VER_REPO) : join(HERE, '..')
const BASELINE_MODE = Boolean(process.env.VER_REPO)
// Windows ESM guard（test/windows-esm-guard.test.mjs）：动态 import() 的实参必须**字面**包 pathToFileURL。
const dist = (m) => join(REPO, 'dist', m)

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-ver-home-'))
const HOME = process.env.DSH_HOME

const TOOLS = await import(pathToFileURL(dist('tools.js')).href)
const SC = await import(pathToFileURL(dist('scope.js')).href)
const L = await import(pathToFileURL(dist('library.js')).href)
const M = await import(pathToFileURL(dist('migrate.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// ── 夹具 ─────────────────────────────────────────────────────────────────────

function newLib(prefix = 'dpr-ver-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局论文 `<data>/<topic>/<name>/<name>.pdf`（可选 .txt 正文）。 */
function putPaper(data, topic, name, text = `ver-body:${topic}/${name}`) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), `ver-pdf:${topic}/${name}`)
  if (text !== null) writeFileSync(join(dir, `${name}.txt`), text)
  return dir
}

/** 旧布局平铺产物 `<data>/<topic>/<name><suffix>`。 */
function putFlat(data, topic, name, suffix, content = `ver-flat:${name}${suffix}`) {
  mkdirSync(join(data, topic), { recursive: true })
  writeFileSync(join(data, topic, `${name}${suffix}`), content)
}

/** 全库快照（相对路径 → 'dir' | 内容）：断言「被拒操作零改动」。 */
function snap(data) {
  const out = {}
  const walk = (dir, base) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      const rel = relative(base, p).split(sep).join('/')
      if (e.isDirectory()) { out[rel] = 'dir'; walk(p, base) } else out[rel] = readFileSync(p, 'utf8')
    }
  }
  if (existsSync(data)) walk(data, data)
  return out
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')
const sessionIdOf = (paperPath, n = 1) => `dpr-${b64url(paperPath)}-${n}`

/** 路由宿主（sessionController 桩；`onPrompt` 收 /api/ask 发出去的提示词）。 */
async function boot(data, { sessions = [], onPrompt = null } = {}) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {
      list: async () => ({ items: sessions.map((s) => ({ blank: false, updatedAt: 1, ...s })) }),
      create: async () => ({ id: 'ver-session' }),
      prompt: async (payload) => { onPrompt?.(payload) },
    },
    workspaceController: {},
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const parse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const get = async (p) => {
    const r = await fetch(base + p)
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  // body ≥100 字节：基线会在**消费 body 之后**才做碰撞相关的写盘，短 body 会先撞「文件内容为空」；
  // 修复树把碰撞预检放在消费 body 之前（所以同一请求在修复树是 409、不需要真读 body）。
  const upload = async (topic, filename, body = '%PDF-1.7\nver-upload\n' + 'v'.repeat(200)) => {
    const r = await fetch(base + '/api/library/upload', {
      method: 'POST',
      headers: { 'x-dpr-topic': encodeURIComponent(topic), 'x-dpr-name': encodeURIComponent(filename), 'content-type': 'application/pdf' },
      body,
    })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  return { get, post, upload, close: () => { srv.closeAllConnections?.(); srv.close() } }
}

/** 客户端：vm 真执行 lib/client.js，取顶层纯函数（基线缺失 ⇒ null）。 */
const CLIENT_SRC = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
function loadClient() {
  let loaded = null
  const ctx = { window: { __ModuleLoader__: { load: (m) => { loaded = m } } }, console, atob, btoa }
  vm.createContext(ctx)
  vm.runInContext(CLIENT_SRC + `
;globalThis.__verApi = {
  parseDprSession: typeof parseDprSession === 'function' ? parseDprSession : null,
  dprSessionStale: typeof dprSessionStale === 'function' ? dprSessionStale : null,
  dprReprefixTopic: typeof dprReprefixTopic === 'function' ? dprReprefixTopic : null,
  dprRekeyTopicState: typeof dprRekeyTopicState === 'function' ? dprRekeyTopicState : null,
  dprTopicPaperCount: typeof dprTopicPaperCount === 'function' ? dprTopicPaperCount : null,
  dprApiError: typeof dprApiError === 'function' ? dprApiError : null,
  dprClearRetryNeeded: typeof dprClearRetryNeeded === 'function' ? dprClearRetryNeeded : null,
};`, ctx, { filename: 'client-ver.js' })
  assert.ok(loaded && typeof loaded.factory === 'function', 'client.js 必须经 __ModuleLoader__.load 注册模块')
  return ctx.__verApi
}
const CLIENT = loadClient()

/** 从源码里抠出具名函数并真执行（基线把 parseDprSession 放在 load() 闭包内 ⇒ 顶层取不到）。 */
function extractFn(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src)
  if (!m) return null
  const start = m.index
  let i = src.indexOf('{', start)
  let depth = 0
  let mode = 'code'
  for (; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i++; continue }
      if (c === '/' && n === '*') { mode = 'block'; i++; continue }
      if (c === '"' || c === "'" || c === '`') { mode = c; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { i++; break } }
    } else if (mode === 'line') { if (c === '\n') mode = 'code' }
    else if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i++ } }
    else { if (c === '\\') i++; else if (c === mode) mode = 'code' }
  }
  const code = src.slice(start, i)
  const ctx = { atob, btoa, decodeURIComponent, encodeURIComponent, console }
  vm.createContext(ctx)
  vm.runInContext(`${code}\n;globalThis.__verFn = ${name};`, ctx, { filename: `client-${name}.js` })
  return typeof ctx.__verFn === 'function' ? ctx.__verFn : null
}

function clientParseSession() {
  return CLIENT.parseDprSession ?? extractFn(CLIENT_SRC, 'parseDprSession')
}

/** 孤立代理项下标（UTF-16 码元扫描）。 */
function loneSurrogates(s) {
  const bad = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (n >= 0xdc00 && n <= 0xdfff) i++
      else bad.push(i)
    } else if (c >= 0xdc00 && c <= 0xdfff) bad.push(i)
  }
  return bad
}

const countOf = (hay, needle) => hay.split(needle).length - 1

// ═════════════════════════════════════════════════════════════════════════════
// A. 会话 id 与嵌套专题
// ═════════════════════════════════════════════════════════════════════════════

test('VER-A 嵌套专题会话 id：服务端 + 客户端都按最后一个 / 切（A/B/P ⇒ A/B + P）', (t) => {
  const sid = sessionIdOf('VerA/VerSubB/VerPaperC', 4)
  const srv = TOOLS.paperFromSessionId(sid)
  const parse = clientParseSession()
  const cli = typeof parse === 'function' ? parse(sid) : '（客户端无可执行 parseDprSession）'
  t.diagnostic(`tools=${JSON.stringify(srv)} client=${JSON.stringify(cli)}`)
  // ← 基线红：{topic:'VerA', name:'VerSubB/VerPaperC'}
  assert.deepEqual({ ...srv }, { topic: 'VerA/VerSubB', name: 'VerPaperC' },
    `服务端必须解出嵌套专题：实际 ${JSON.stringify(srv)}`)
  assert.deepEqual({ ...TOOLS.paperFromSessionId(sessionIdOf('SoloOnly/VerPaperD')) },
    { topic: 'SoloOnly', name: 'VerPaperD' }, '单层不回归')
  for (const bad of [sessionIdOf('NoSlashHere'), sessionIdOf('VerA/VerSubB/'), 'plain-session', undefined]) {
    assert.equal(TOOLS.paperFromSessionId(bad), null, `非法会话 id 必须 null：${JSON.stringify(bad)}`)
  }

  assert.equal(typeof parse, 'function', '客户端 parseDprSession 必须可执行（基线在 load() 闭包内，已从源码抠出）')
  // ← 基线红：{topic:'VerA', name:'VerSubB/VerPaperC'}
  assert.deepEqual({ ...cli }, { topic: 'VerA/VerSubB', name: 'VerPaperC', n: 4 },
    `客户端必须解出嵌套专题：实际 ${JSON.stringify(cli)}`)
})

// ═════════════════════════════════════════════════════════════════════════════
// B. 上传无碰撞检查（吞数据）
// ═════════════════════════════════════════════════════════════════════════════

test('VER-B1 上传撞同名子专题 / 同名论文目录 ⇒ 409 且库结构不变（子专题论文仍可见）', async (t) => {
  const { root, data } = newLib('dpr-ver-b1-')
  putPaper(data, 'VerB/SubExist', 'InnerPaper', 'inner-body')
  putPaper(data, 'VerB/PaperExist', 'PaperExist')
  const s = await boot(data)
  try {
    const before = snap(data)
    const r1 = await s.upload('VerB', 'SubExist.pdf')
    const r2 = await s.upload('VerB', 'PaperExist.pdf')
    const lib = await s.get('/api/library')
    const names = (lib.body?.papers ?? []).map((p) => `${p.topic}/${p.name}`)
    t.diagnostic(`subtopic upload=${r1.status} body=${r1.txt.slice(0, 200)}`)
    t.diagnostic(`paper-dir upload=${r2.status} body=${r2.txt.slice(0, 160)} listed=${JSON.stringify(names)}`)
    // ← 基线红：200（子专题被变成论文目录 ⇒ InnerPaper 从列表消失）
    assert.equal(r1.status, 409, `上传到同名子专题必须 409：实际 ${r1.status} ${r1.txt}`)
    assert.equal(r1.body?.code, 'target-exists', `机器码 target-exists：${r1.txt}`)
    assert.deepEqual(snap(data), before, '被拒的上传必须零改动（逐字节）')

    // ← 基线红：200（覆盖/合并既有论文目录）
    assert.equal(r2.status, 409, `上传到同名论文目录必须 409：实际 ${r2.status} ${r2.txt}`)
    assert.deepEqual(snap(data), before, '被拒的上传必须零改动（逐字节）')
    assert.ok(names.includes('VerB/SubExist/InnerPaper'), `子专题里的论文必须仍可见：${JSON.stringify(names)}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('VER-B2 上传撞旧平铺产物 ⇒ 409；平铺学习进度不被文件夹规则遮蔽', async (t) => {
  const { root, data } = newLib('dpr-ver-b2-')
  putFlat(data, 'VerB2', 'FlatPaper', '.pdf', 'ver-flat-pdf')
  putFlat(data, 'VerB2', 'FlatPaper', '.study.json', '{"keep":"study-progress"}')
  const s = await boot(data)
  try {
    const before = snap(data)
    const r = await s.upload('VerB2', 'FlatPaper.pdf')
    t.diagnostic(`flat upload=${r.status} body=${r.txt.slice(0, 200)}`)
    // ← 基线红：200（建出 FlatPaper/ 后平铺产物被永久遮蔽：不可见、API 不可删）
    assert.equal(r.status, 409, `撞旧平铺论文必须 409：实际 ${r.status} ${r.txt}`)
    assert.deepEqual(snap(data), before, '平铺产物必须一字不差')
    const lib = await s.get('/api/library')
    const row = (lib.body?.papers ?? []).find((p) => p.name === 'FlatPaper')
    assert.ok(row, '平铺论文必须仍在列表里')
    assert.equal(readFileSync(join(data, 'VerB2', 'FlatPaper.study.json'), 'utf8'), '{"keep":"study-progress"}')
    const plan = await s.get('/api/library/paper/delete-plan?topic=VerB2&name=FlatPaper')
    assert.equal(plan.status, 200, `平铺论文的删除预览必须可达：${plan.status} ${plan.txt}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// C. 目录 / 文件互踩
// ═════════════════════════════════════════════════════════════════════════════

test('VER-C1 create-topic / rename-topic 拒绝论文目录当祖先或父；库结构零改动', async (t) => {
  const { root, data } = newLib('dpr-ver-c1-')
  putPaper(data, 'VerC', 'PaperAsParent') // ⇒ VerC/PaperAsParent/PaperAsParent.pdf（论文目录）
  putPaper(data, 'VerC', 'MoveMe')         // ⇒ VerC/MoveMe/MoveMe.pdf
  const s = await boot(data)
  try {
    const before = snap(data)
    const create = await s.post('/api/library/topic', { name: 'VerC/PaperAsParent/NewSub' })
    const move = await s.post('/api/library/rename-topic', { name: 'VerC/MoveMe', newName: 'VerC/PaperAsParent/MoveMe' })
    t.diagnostic(`create under paper=${create.status} body=${create.txt.slice(0, 200)}`)
    t.diagnostic(`rename into paper=${move.status} body=${move.txt.slice(0, 200)}`)
    // ← 基线红：200（新专题子树被论文目录截断 ⇒ 列表/树/范围全部看不见）
    assert.equal(create.status, 409, `论文目录不能当专题父：实际 ${create.status} ${create.txt}`)
    assert.deepEqual(snap(data), before, '被拒的 create-topic 零改动')

    // ← 基线红：200（搬进论文目录后整棵子树从 API 消失，且 clearTopic 永远 409）
    assert.equal(move.status, 409, `专题不能搬进论文目录：实际 ${move.status} ${move.txt}`)
    assert.deepEqual(snap(data), before, '被拒的 rename-topic 零改动')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('VER-C2 create-topic 撞旧平铺论文 ⇒ 409（否则平铺论文被遮蔽成不可见 + delete-plan 404）', async (t) => {
  const { root, data } = newLib('dpr-ver-c2-')
  putFlat(data, 'VerC2', 'FlatAsTopic', '.pdf', 'ver-flat-c2')
  putFlat(data, 'VerC2', 'FlatAsTopic', '.txt', 'ver-flat-c2-txt')
  const s = await boot(data)
  try {
    const before = snap(data)
    const r = await s.post('/api/library/topic', { name: 'VerC2/FlatAsTopic' })
    t.diagnostic(`create over flat=${r.status} body=${r.txt.slice(0, 200)}`)
    // ← 基线红：200
    assert.equal(r.status, 409, `同名平铺论文存在时不能建同名专题：实际 ${r.status} ${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的 create-topic 零改动')
    const plan = await s.get('/api/library/paper/delete-plan?topic=VerC2&name=FlatAsTopic')
    assert.equal(plan.status, 200, `平铺论文删除预览仍可用：${plan.status} ${plan.txt}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('VER-C3 rename-paper 论文目录内同名残留不得被静默覆盖（409 + 零改动）', async (t) => {
  const { root, data } = newLib('dpr-ver-c3-')
  const from = putPaper(data, 'VerC3/T', 'FromPaper', 'from-txt')
  writeFileSync(join(from, 'FromPaper.pdf'), 'from-pdf')
  // **源论文目录里**已有目标名文件（上次中断的残留 / 用户手放的同名文件）：
  // 两段式改名的第二步 FromPaper.txt→ToPaper.txt 会把它静默覆盖掉。
  writeFileSync(join(from, 'ToPaper.txt'), 'KEEP-RESIDUAL')
  const s = await boot(data)
  try {
    const before = snap(data)
    const r = await s.post('/api/library/rename-paper', { topic: 'VerC3/T', name: 'FromPaper', newName: 'ToPaper' })
    t.diagnostic(`rename over residual=${r.status} body=${r.txt.slice(0, 240)}`)
    // ← 基线红：200（renameSync 静默覆盖 ToPaper.txt，无 409、无回收站记录）
    assert.equal(r.status, 409, `目标内同名残留必须 409：实际 ${r.status} ${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名零改动（残留内容 KEEP-RESIDUAL 必须还在）')
    assert.equal(readFileSync(join(data, 'VerC3/T/FromPaper/ToPaper.txt'), 'utf8'), 'KEEP-RESIDUAL')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('VER-C4 平铺论文改名撞上同名子专题目录 ⇒ 409（不得迁移进目录后不可见/不可删）', async (t) => {
  const { root, data } = newLib('dpr-ver-c4-')
  putFlat(data, 'VerC4', 'LegacyName', '.pdf', 'ver-legacy-c4')
  putPaper(data, 'VerC4/ExistingDir', 'Nested')
  const s = await boot(data)
  try {
    const before = snap(data)
    const r = await s.post('/api/library/rename-paper', { topic: 'VerC4', name: 'LegacyName', newName: 'ExistingDir' })
    t.diagnostic(`legacy rename onto dir=${r.status} body=${r.txt.slice(0, 240)}`)
    // ← 基线红：200（平铺文件被挪进同名目录 ⇒ 从列表/API 消失）
    assert.equal(r.status, 409, `平铺改名撞目录必须 409：实际 ${r.status} ${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名零改动')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// D. 清空/删除的占用检查只看一层
// ═════════════════════════════════════════════════════════════════════════════

test('VER-D1 clear-plan 必须列出整棵子树的论文，且 papersCount 与清单严格一致', async (t) => {
  const { root, data } = newLib('dpr-ver-d1-')
  putPaper(data, 'VerD', 'RootPaper')
  putPaper(data, 'VerD/VerSubD', 'SubPaper')
  putPaper(data, 'VerD/VerSubD/Deep', 'DeepPaper')
  const s = await boot(data)
  try {
    const r = await s.get('/api/library/topic/clear-plan?topic=VerD')
    const listed = (r.body?.papers ?? []).map((p) => `${p.topic}/${p.name}`).sort()
    t.diagnostic(`plan=${r.status} listed=${JSON.stringify(listed)} papersCount=${r.body?.papersCount}`)
    assert.equal(r.status, 200, r.txt)
    // ← 基线红：只列根层 ["VerD/RootPaper"]，papersCount 却是 3（确认框说谎）
    assert.deepEqual(listed, ['VerD/RootPaper', 'VerD/VerSubD/Deep/DeepPaper', 'VerD/VerSubD/SubPaper'],
      `确认清单必须含子树论文：${JSON.stringify(listed)}`)
    assert.equal(r.body.papersCount, listed.length, 'papersCount 必须与清单一致')
    assert.equal(r.body.subtopicsCount >= 1, true, '必须报告子树单元')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('VER-D2 子专题论文有活跃会话 ⇒ 整次清空被拦（409 session-running）、零改动、零回收站', async (t) => {
  const { root, data } = newLib('dpr-ver-d2-')
  putPaper(data, 'VerD2', 'RootPaper')
  putPaper(data, 'VerD2/SubD', 'SubPaper')
  const s = await boot(data, { sessions: [{ sessionId: sessionIdOf('VerD2/SubD/SubPaper'), running: true }] })
  try {
    const before = snap(data)
    const r = await s.post('/api/library/topic/clear', { topic: 'VerD2', confirmName: 'VerD2' })
    t.diagnostic(`clear=${r.status} body=${r.txt.slice(0, 240)}`)
    // ← 基线红：200 cleared:2（子专题的活跃会话论文也进了回收站）
    assert.equal(r.status, 409, `子专题有在跑会话时必须拒绝清空：实际 ${r.status} ${r.txt}`)
    assert.equal(r.body?.code, 'session-running', `机器码 session-running：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的清空零改动（逐字节）')
    assert.equal(existsSync(join(data, '.trash')), false, '被拒的清空不得写回收站')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// E. 迁移工具自身契约
// ═════════════════════════════════════════════════════════════════════════════

/** 跑迁移 CLI（独立进程；DSH_HOME 固定到本探针临时 HOME）。 */
function runCli(args) {
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'migrate.js'), ...args], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: HOME },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('VER-E1 坏 JSONL（中间行被截断）⇒ --rollback 非 0 退出并指出坏行；完好日志仍能回滚', async (t) => {
  const { root, data } = newLib('dpr-ver-e1-')
  try {
    putFlat(data, 'VerE', 'MigA', '.pdf', 'ver-e-pdf')
    putFlat(data, 'VerE', 'MigA', '.txt', 'ver-e-txt')
    putFlat(data, 'VerE', 'MigB', '.pdf', 'ver-e-pdf-b')
    const run = M.runMigration(data, { home: HOME })
    assert.ok(run.logPath && existsSync(run.logPath), `迁移必须留下日志：${run.logPath}`)
    const lines = readFileSync(run.logPath, 'utf8').split('\n').filter(Boolean)
    assert.ok(lines.length >= 3, `至少 3 条日志（实际 ${lines.length}）`)
    // 模拟 SIGKILL 打断 append：第二条只落半行
    const corrupt = [...lines]
    corrupt[1] = corrupt[1].slice(0, Math.floor(corrupt[1].length / 2))
    const badPath = join(dirname(run.logPath), 'ver-corrupt-mid.jsonl')
    writeFileSync(badPath, corrupt.join('\n') + '\n')

    const bad = runCli(['--data-dir', data, '--rollback', badPath])
    t.diagnostic(`bad rollback code=${bad.code} stderr=${JSON.stringify((bad.stderr || bad.stdout).slice(0, 240))}`)
    // ← 基线红：exit 0 + stdout「已回滚 0 个文件」（静默空转的假成功）
    assert.notEqual(bad.code, 0, `坏日志回滚必须非 0 退出：实际 ${bad.code}；输出 ${bad.stdout}${bad.stderr}`)
    assert.match(`${bad.stderr}${bad.stdout}`, /第 2 行|migrate-log-corrupt/i,
      `必须指出坏行与机器码：${bad.stderr}${bad.stdout}`)
    assert.ok(!(bad.stdout + bad.stderr).includes('已回滚 0 个文件'), '不得再出现「已回滚 0 个文件」的假成功')

    // 正对照：同一份日志未损坏 ⇒ exit 0 且真的恢复文件
    const good = runCli(['--data-dir', data, '--rollback', run.logPath])
    t.diagnostic(`good rollback code=${good.code} out=${JSON.stringify(good.stdout.slice(0, 200))}`)
    assert.equal(good.code, 0, `完好日志回滚必须成功：${good.stderr}${good.stdout}`)
    assert.ok(existsSync(join(data, 'VerE', 'MigA.pdf')), '回滚必须把平铺 PDF 恢复回去')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('VER-E2a 维护者点名的现场：阶段 1 mkdir 后 / .pdf 复制前被中断（空论文目录）⇒ 复跑必须迁完', async (t) => {
  const { root, data } = newLib('dpr-ver-e2a-')
  try {
    putFlat(data, 'VerE2', 'ResumeMe', '.pdf', 'ver-e2-pdf')
    putFlat(data, 'VerE2', 'ResumeMe', '.txt', 'ver-e2-txt')
    // 精确复刻「mkdir 论文目录之后、复制 .pdf 之前被 SIGKILL」：目录在、里面什么都没有
    mkdirSync(join(data, 'VerE2', 'ResumeMe'), { recursive: true })
    const plan = M.planMigration(data, { home: HOME })
    const planMoves = (plan.moves ?? []).map((m) => m.from ?? m.paper)
    const resume = M.runMigration(data, { home: HOME })
    t.diagnostic(`plan moves=${JSON.stringify(planMoves)} conflicts=${JSON.stringify((plan.conflicts ?? []).map((c) => c.paper ?? c.path))} ` +
      `resume copied=${resume.copied} removed=${resume.removed} skipped=${JSON.stringify((resume.skippedPapers ?? []).map((x) => x.paper))}`)
    // ← 基线红：moves=[]、该篇被判 dir-other 冲突、copied=0（「每次复跑都被跳过」原样复现）
    assert.ok(resume.copied >= 2, `复跑必须把这篇迁完（copied ≥2）：实际 ${resume.copied}`)
    assert.ok(resume.removed >= 2, `平铺源必须删除（≥2）：实际 ${resume.removed}`)
    assert.equal(readFileSync(join(data, 'VerE2', 'ResumeMe', 'ResumeMe.pdf'), 'utf8'), 'ver-e2-pdf')
    assert.equal(readFileSync(join(data, 'VerE2', 'ResumeMe', 'ResumeMe.txt'), 'utf8'), 'ver-e2-txt')
    assert.equal(existsSync(join(data, 'VerE2', 'ResumeMe.pdf')), false, '平铺源必须已删')
    assert.equal(existsSync(join(data, 'VerE2', 'ResumeMe.txt')), false, '平铺源必须已删')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('VER-E2b 真实中断（failAfterCopies=1）⇒ 现场留下半成品标记，复跑收敛且清标记', async (t) => {
  const { root, data } = newLib('dpr-ver-e2b-')
  try {
    putFlat(data, 'VerE2B', 'KillMe', '.pdf', 'ver-e2b-pdf')
    putFlat(data, 'VerE2B', 'KillMe', '.txt', 'ver-e2b-txt')
    let aborted = null
    try {
      M.runMigration(data, { home: HOME, failAfterCopies: 1 })
    } catch (e) { aborted = e }
    const paperDir = join(data, 'VerE2B', 'KillMe')
    const marker = existsSync(join(paperDir, '.migration-v1.inprogress'))
    let resume = null
    try { resume = M.runMigration(data, { home: HOME }) } catch { /* 复跑失败由断言暴露 */ }
    t.diagnostic(`aborted=${aborted?.constructor?.name ?? 'none'} marker=${marker} ` +
      `resume=${resume ? `copied=${resume.copied} removed=${resume.removed} partial=${resume.partial}` : 'threw'}`)
    assert.ok(aborted, 'failAfterCopies=1 必须中断第一次运行')
    assert.equal(existsSync(paperDir), true, '中断后论文目录已存在')
    // ← 基线红：没有半成品标记概念（只有已复制的文件）。标记是「复跑据此识别」的显式契约。
    assert.equal(marker, true, '阶段 1/2 中断现场必须留下半成品标记')
    assert.ok(resume && resume.copied >= 1, `复跑必须继续迁完剩余文件（≥1）：实际 ${resume?.copied}`)
    assert.equal(readFileSync(join(paperDir, 'KillMe.pdf'), 'utf8'), 'ver-e2b-pdf')
    assert.equal(readFileSync(join(paperDir, 'KillMe.txt'), 'utf8'), 'ver-e2b-txt')
    assert.equal(existsSync(join(paperDir, '.migration-v1.inprogress')), false, '收敛后标记必须清掉')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('VER-E3a /migrate 不阻塞事件循环：迁移期间并发 GET 必须在迁移结束前返回', async (t) => {
  const { root, data } = newLib('dpr-ver-e3a-')
  const s = await boot(data)
  try {
    // 900 篇平铺论文 ⇒ 迁移要逐文件复制 + 双 sha256 + 删源，足够长到能测「是否让出事件循环」
    for (let i = 0; i < 900; i++) putFlat(data, 'VerE3', `Bulk${String(i).padStart(3, '0')}`, '.pdf', `ver-bulk-${i}`)
    let settled = false
    const t0 = performance.now()
    const migrateP = s.post('/api/library/migrate', { confirm: 'migrate-library' }).then((r) => { settled = true; return r })
    // 先等迁移**真的开始落盘**（第一篇被建目录/首个源被移动），再发 GET。
    // 为什么必须这样测：只看「POST 还没 settle」会误判——POST 的 handler 在 await readBody 时
    // 已经让出事件循环，GET 可能抢在**同步迁移开始之前**返回（实测基线也会因此假绿）。
    let started = false
    for (let i = 0; i < 400 && !settled; i++) {
      if (existsSync(join(data, 'VerE3', 'Bulk000'))) { started = true; break }
      await new Promise((r) => setTimeout(r, 5))
    }
    const t1 = performance.now()
    const get = await s.get('/api/library')
    const getElapsed = performance.now() - t1
    const settleAtGet = settled
    const mig = await migrateP
    const migElapsed = performance.now() - t0
    t.diagnostic(`started=${started} get=${get.status} getElapsed=${getElapsed.toFixed(1)}ms migElapsed=${migElapsed.toFixed(1)}ms settleAtGet=${settleAtGet} ` +
      `migrate=${mig.status} copied=${mig.body?.copied} removed=${mig.body?.removed}`)
    assert.equal(started, true, '必须先观察到迁移开始（Bulk000 目录出现），否则测量无意义')
    assert.equal(get.status, 200, `迁移期间读接口必须可用：${get.status} ${get.txt.slice(0, 160)}`)
    assert.equal(mig.status, 200, `迁移本身必须成功：${mig.status} ${mig.txt.slice(0, 200)}`)
    assert.ok(migElapsed > 60, `迁移耗时必须可测（>60ms）：实际 ${migElapsed.toFixed(1)}ms`)
    // ← 基线红：迁移体同步跑到底 ⇒ 这个 GET 只能等迁移结束后才被处理（settleAtGet=true）
    assert.equal(settleAtGet, false, 'GET 返回时迁移请求必须尚未结束（同步迁移会卡在这里）')
    assert.ok(getElapsed < Math.max(15, migElapsed / 2),
      `GET 必须在迁移结束前返回：get=${getElapsed.toFixed(1)}ms migrate=${migElapsed.toFixed(1)}ms`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('VER-E3b /migrate 对在飞译文有 busy 门（409 busy 点名论文）', async (t) => {
  const { root, data } = newLib('dpr-ver-e3b-')
  // 假 babeldoc：睡 2s 即「翻译进行中」（放在 data 同级的 .venv-pdf2zh/bin，与实现查找位一致）
  const binDir = join(root, '.venv-pdf2zh', 'bin')
  mkdirSync(binDir, { recursive: true })
  const fakeBin = join(binDir, 'babeldoc')
  writeFileSync(fakeBin, '#!/bin/sh\nsleep 2\n')
  chmodSync(fakeBin, 0o755)
  putPaper(data, 'VerE3B', 'BusyPaper', 'ver-busy-body')
  const TR = await import(pathToFileURL(dist('translate.js')).href)
  const ref = L.resolvePaper(data, { topic: 'VerE3B', name: 'BusyPaper' })
  const started = await TR.startTranslation(ref, data, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'ver-key', model: 'ver-model' })
  let busy = false
  for (let i = 0; i < 100 && !busy; i++) {
    busy = TR.zhStatus(ref).busy
    if (!busy) await new Promise((r) => setTimeout(r, 10))
  }
  const s = await boot(data)
  try {
    const r = await s.post('/api/library/migrate', { confirm: 'migrate-library' })
    t.diagnostic(`startTranslation=${JSON.stringify(started)} busy=${busy} migrate=${r.status} body=${r.txt.slice(0, 200)}`)
    assert.equal(busy, true, '假 babeldoc 在位时必须进入 busy 态（否则门禁测试没意义）')
    // ← 基线红：200（在飞译文论文被搬走，正在跑的任务失去工作目录）
    assert.equal(r.status, 409, `有译文在飞时 /migrate 必须 409：实际 ${r.status} ${r.txt}`)
    assert.equal(r.body?.code, 'busy', `机器码 busy：${r.txt}`)
    assert.ok((r.body?.papers ?? []).some((x) => String(x).includes('BusyPaper')), `必须点名在飞论文：${r.txt}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// F. boundaryOnly 长度回归
// ═════════════════════════════════════════════════════════════════════════════

const LONG_TOPIC = 'Z'.repeat(110) // 上一版允许 ≤120 段长；本分支创建侧上限 100

test('VER-F 110 字 legacy 专题可删可改名（boundaryOnly 不放宽安全边界；创建侧仍拒）', async (t) => {
  const { root, data } = newLib('dpr-ver-f-')
  // ① 空的长名专题：应可删
  mkdirSync(join(data, LONG_TOPIC), { recursive: true })
  // ② 带论文的长名专题：应可改名
  putPaper(data, `${LONG_TOPIC}2`, 'LongPaper')
  const s = await boot(data)
  try {
    const del = await s.post('/api/library/delete-topic', { name: LONG_TOPIC })
    const ren = await s.post('/api/library/rename-topic', { name: `${LONG_TOPIC}2`, newName: 'VerFShort' })
    const createLong = await s.post('/api/library/topic', { name: 'Y'.repeat(110) })
    t.diagnostic(`delete long=${del.status} body=${del.txt.slice(0, 200)}`)
    t.diagnostic(`rename long=${ren.status} body=${ren.txt.slice(0, 200)} create long=${createLong.status}`)
    // ← 基线红：400（validateTopicPath(boundaryOnly) 也卡 MAX_TOPIC_SEG=100 ⇒ 删不掉的孤儿）
    assert.equal(del.status, 200, `110 字空专题必须可删：实际 ${del.status} ${del.txt}`)
    assert.equal(existsSync(join(data, LONG_TOPIC)), false, '目录必须真的消失')

    // ← 基线红：400
    assert.equal(ren.status, 200, `110 字专题必须可改名：实际 ${ren.status} ${ren.txt}`)
    assert.equal(existsSync(join(data, 'VerFShort', 'LongPaper', 'LongPaper.pdf')), true, '改名后论文仍在')
    // 创建侧上限不变（创建 110 字仍拒）
    assert.equal(createLong.status, 400, `创建侧 110 字仍必须拒：实际 ${createLong.status} ${createLong.txt}`)

    // boundaryOnly 不放宽**安全边界**：上跳 / 编码变形一律 400。
    // （前导点属于「历史怪名」，boundary 模式应放行——不存在的条目自然是 404，不构成穿越。）
    for (const evil of ['../VerFEscape', 'VerF/../../VerFEscape', '%2e%2e%2fVerFEscape']) {
      const r = await s.post('/api/library/delete-topic', { name: evil })
      assert.equal(r.status, 400, `boundaryOnly 不得放行越界名 ${evil}：实际 ${r.status} ${r.txt}`)
      assert.equal(existsSync(join(root, 'VerFEscape')), false, '越界目标不得被创建/删除')
    }
    const dot = await s.post('/api/library/delete-topic', { name: '.hiddenTopic' })
    t.diagnostic(`delete dot-name=${dot.status}（boundary 模式放行历史怪名；不存在 ⇒ 404）`)
    assert.ok(dot.status === 404 || dot.status === 200, `前导点属于边界类，不得因命名规范 400：${dot.status}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// G. 范围提问的预算与诚实性
// ═════════════════════════════════════════════════════════════════════════════

/** 12 篇 × 3 个命中块（每块 >1500 字 ⇒ 被 chunkText 硬切，块首带唯一 needle）。 */
function bigHitLib() {
  const { root, data } = newLib('dpr-ver-g1-')
  for (let i = 0; i < 12; i++) {
    const name = `VerPaper${String(i).padStart(2, '0')}`
    putPaper(data, 'VerG', name, null)
    const paras = ['a', 'b', 'c'].map((ch) => `verneedle-${i}-${ch} ` + ch.repeat(1_600))
    writeFileSync(join(data, 'VerG', name, `${name}.txt`), paras.join('\n\n'))
  }
  return { root, data, cur: L.resolvePaper(data, { topic: 'VerG', name: 'VerPaper00' }) }
}

test('VER-G1 12 篇×3 命中：totalChars/block ≤ 40000、omitted 句只一次、命中片段不重复计费', async (t) => {
  const { root, data, cur } = bigHitLib()
  try {
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'VerG' }, 'verneedle')
    // 台账对账先算出来（基线第一条断言就红，后面的数字也要可见）
    const covs = ctx.papers.map((p) => p.coverage)
    const tally = { full: 0, truncated: 0, omitted: 0 }
    for (const c of covs) {
      if (c === 'full') tally.full++
      else if (c === 'truncated') tally.truncated++
      else tally.omitted++
    }
    t.diagnostic(`totalChars=${ctx.totalChars} block=${ctx.block.length} body=${ctx.bodyChars} hits=${ctx.hitChars} omitted=${ctx.omitted} truncated=${ctx.truncated} full=${ctx.full} tally=${JSON.stringify(tally)} needle0a=${countOf(ctx.block, 'verneedle-0-a ')} omittedSentence=${countOf(ctx.block, '因上下文上限未展开')}`)
    // ← 基线红：totalChars≈72k（命中片段不计预算、正文与命中重复同一段）
    assert.ok(ctx.totalChars <= 40000, `totalChars 必须 ≤ MAX_CONTEXT_CHARS=40000：实际 ${ctx.totalChars}`)
    assert.ok(ctx.block.length <= 40000, `block 长度必须 ≤ 40000：实际 ${ctx.block.length}`)
    assert.equal(ctx.totalChars, ctx.manifestChars + ctx.bodyChars + ctx.hitChars, '台账三段必须自洽')
    // omitted 提示句只出现一次（基线在 tail 与 block 各输出一遍）
    const omittedSentence = '因上下文上限未展开'
    assert.ok(countOf(ctx.block, omittedSentence) <= 1,
      `omitted 提示句最多一次：实际 ${countOf(ctx.block, omittedSentence)} 次`)
    // 同一命中片段只能出现一次（基线命中片段与正文重复同一段文本）
    assert.equal(countOf(ctx.block, 'verneedle-0-a '), 1, '同一命中片段只能出现一次（不得与正文重复）')
    assert.equal(countOf(ctx.block, 'verneedle-0-b '), 1, '同一篇的第二个片段也只能出现一次')
    // 台账与逐篇明细对账
    assert.equal(tally.full, ctx.full, 'full 统计 = 逐篇 coverage')
    assert.equal(tally.truncated, ctx.truncated, 'truncated 统计 = 逐篇 coverage（清单截断不得污染）')
    assert.equal(tally.omitted, ctx.omitted, 'omitted 统计 = 逐篇 coverage')
    assert.equal(ctx.papers.length, 12, '范围内的每一篇都要进 papers[]')
    assert.equal(tally.full + tally.truncated + tally.omitted, 12, '每篇必须有明确终态')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('VER-G5 同名论文出现在不同深度 ⇒ 如实进 omitted（不许静默消失）', async (t) => {
  const { root, data } = newLib('dpr-ver-g5-')
  try {
    putPaper(data, 'VerG5', 'SameName', 'same-root-body')
    putPaper(data, 'VerG5/Sub', 'SameName', 'same-sub-body')
    // 同名双份时 resolvePaper 会报「命中多篇」（已知设计），当前篇按精确路径构造
    const cur = L.paperRefFor(data, 'VerG5', 'SameName')
    const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'VerG5' }, 'body')
    const dups = ctx.papers.filter((p) => p.coverage === 'omitted-duplicate')
    const notes = Array.isArray(ctx.omittedNotes) ? ctx.omittedNotes : []
    t.diagnostic(`papers=${JSON.stringify(ctx.papers.map((p) => [p.path, p.coverage]))} omitted=${ctx.omitted} notes=${notes.length} blockMentions=${countOf(ctx.block, '同名')}`)
    // ← 基线红：逐篇 resolvePaper 撞「命中多篇」被 catch 静默吞掉 ⇒ 只剩 1 篇、omitted=0、无原因
    assert.equal(dups.length, 2, `两处同名论文都要进 omitted（带原因）：${JSON.stringify(dups)}`)
    assert.equal(ctx.omitted, 2, `omitted 必须记账：${ctx.omitted}`)
    assert.equal(notes.length, 2, `两条原因都要给出：${notes.length}`)
    assert.ok(countOf(ctx.block, '同名') >= 1, '范围块里必须点名「同名论文无法唯一定位」')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('VER-G2 scope.kind=topic 指向不存在的专题 ⇒ 不装配空范围（路由 404），正对照 200', async (t) => {
  const { root, data } = newLib('dpr-ver-g2-')
  putPaper(data, 'VerG2', 'OnlyPaper')
  let prompted = 0
  const s = await boot(data, { onPrompt: () => { prompted++ } })
  try {
    const bad = await s.post('/api/ask', {
      topic: 'VerG2', name: 'OnlyPaper', question: '这篇讲什么？',
      scope: { kind: 'topic', topic: 'VerGoneTopic' },
    })
    t.diagnostic(`ask missing topic=${bad.status} body=${bad.txt.slice(0, 200)} prompted=${prompted}`)
    // ← 基线红：200（装配出「空的但看起来正常」的范围；用户以为问过了）
    assert.equal(bad.status, 404, `不存在的专题必须 404：实际 ${bad.status} ${bad.txt}`)
    assert.equal(bad.body?.code, 'not-found', `机器码 not-found：${bad.txt}`)
    assert.equal(prompted, 0, '范围解析失败时不得把空范围提示词发给 agent')

    const good = await s.post('/api/ask', {
      topic: 'VerG2', name: 'OnlyPaper', question: '这篇讲什么？',
      scope: { kind: 'topic', topic: 'VerG2' },
    })
    t.diagnostic(`ask existing topic=${good.status}`)
    assert.equal(good.status, 200, `正对照必须 200：${good.status} ${good.txt}`)
    assert.equal(good.body?.scope?.path, 'VerG2')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('VER-G3 正文切点恰好落在代理对中间 ⇒ 输出不得含孤立代理项（U+1D400 现场）', async (t) => {
  const { root, data } = newLib('dpr-ver-g3-')
  const MATH_CHAR = '\u{1D400}' // 𝐀：UTF-16 两个码元
  // 让第 8000 个码元正好是代理对的前半（MAX_PER_DOC=8000 的切点）
  const body = 'x'.repeat(7999) + MATH_CHAR + 'y'.repeat(500)
  putPaper(data, 'VerG3', 'MathPaper', body)
  try {
    const cur = L.resolvePaper(data, { topic: 'VerG3', name: 'MathPaper' })
    const ctx = SC.buildScopeContext(data, cur, { kind: 'paper' }, 'verneedle-none')
    const lone = loneSurrogates(ctx.block)
    t.diagnostic(`block=${ctx.block.length} lone=${lone.length} at=${JSON.stringify(lone.slice(0, 5))} chars=${ctx.papers[0]?.chars}`)
    // ← 基线红：孤立代理项 1 个（slice 按码元切；该字符串进会话历史会让整条会话 400）
    assert.equal(lone.length, 0, `block 不得含孤立代理项：${JSON.stringify(lone)}`)
    // 数学字符要么整字出现、要么整字缺席（不得只剩半个）
    assert.ok(ctx.block.includes(MATH_CHAR) || !ctx.block.includes('\uD835'), '数学字符不得被劈开')
    assert.ok(ctx.totalChars <= 40000)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('VER-G4 cutToCodePoint 原语：语义（少切 1 个码元、不越界）与暴露面', (t) => {
  // ← 基线红：dist/scope.js 无 cutToCodePoint 导出（维护者要求 5 处截断统一走码点安全原语）
  assert.equal(typeof SC.cutToCodePoint, 'function', 'dist/scope.js 必须导出 cutToCodePoint（或等价回退）')
  const MATH_CHAR = '\u{1D400}'
  const s = 'ab' + MATH_CHAR + 'cd'
  assert.equal(SC.cutToCodePoint(s, 1), 'a')
  assert.equal(SC.cutToCodePoint(s, 2), 'ab')
  // 切点 = 3 落在代理对中间 ⇒ 少切 1（不给孤立代理项）
  assert.equal(SC.cutToCodePoint(s, 3), 'ab', `代理对中间必须退回一个码元：${JSON.stringify(SC.cutToCodePoint(s, 3))}`)
  assert.equal(SC.cutToCodePoint(s, 4), 'ab' + MATH_CHAR)
  assert.equal(SC.cutToCodePoint(s, 99), s, '超长不越界')
  assert.equal(SC.cutToCodePoint('', 3), '')
  assert.equal(loneSurrogates(SC.cutToCodePoint(s, 3)).length, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// H. 客户端嵌套结构追踪
// ═════════════════════════════════════════════════════════════════════════════

test('VER-H1 专题改名后的前缀感知重写：cur/last/折叠键跟随，A 与 AB 不误伤', (t) => {
  // ← 基线红：客户端无这些纯函数（缺陷内联在 load() 闭包里，按精确相等更新）
  assert.equal(typeof CLIENT.dprReprefixTopic, 'function', '客户端必须有 dprReprefixTopic（前缀 + 分隔符判定）')
  assert.equal(typeof CLIENT.dprRekeyTopicState, 'function', '客户端必须有 dprRekeyTopicState')
  assert.equal(CLIENT.dprReprefixTopic('VerA/Sub', 'VerA', 'X/VerA'), 'X/VerA/Sub')
  assert.equal(CLIENT.dprReprefixTopic('VerA', 'VerA', 'X/VerA'), 'X/VerA')
  assert.equal(CLIENT.dprReprefixTopic('VerAB', 'VerA', 'X/VerA'), null, '同前缀近名 VerAB 绝不误伤')
  assert.equal(CLIENT.dprReprefixTopic('VerA/Sub/Paper', 'X/Y', 'Z'), null)

  const out = CLIENT.dprRekeyTopicState('VerA', 'X/VerA', {
    cur: { topic: 'VerA/Sub', name: 'VerPaper' },
    closed: { 'VerA/Sub': true, VerAB: false },
    last: { topic: 'VerA/Sub', name: 'VerPaper' },
  })
  t.diagnostic(`rekeyed=${JSON.stringify(out)}`)
  // ← 基线红：cur 仍是 VerA/Sub（iframe 持旧 ?topic=VerA/Sub ⇒ 提问/翻译 404；刷新回落 papers[0]）
  assert.deepEqual({ ...out.cur }, { topic: 'X/VerA/Sub', name: 'VerPaper' })
  assert.deepEqual({ ...out.last }, { topic: 'X/VerA/Sub', name: 'VerPaper' })
  assert.deepEqual([...Object.keys(out.closed)].sort(), ['VerAB', 'X/VerA/Sub'])
})

test('VER-H2 子树计数与 clearEndpoint 透传：A 不只数直接论文；重试路径可达', (t) => {
  // ← 基线红：无 dprTopicPaperCount / dprApiError / dprClearRetryNeeded
  assert.equal(typeof CLIENT.dprTopicPaperCount, 'function', '客户端必须能数子树论文（否则没有 UI 路径到 /topic/clear）')
  assert.equal(typeof CLIENT.dprApiError, 'function', 'api() 必须走带机器码的 Error 构造')
  assert.equal(typeof CLIENT.dprClearRetryNeeded, 'function')

  const papers = [{ topic: 'VerA/Sub' }, { topic: 'VerA/Sub/Deep' }, { topic: 'VerAB' }, { topic: 'VerA' }]
  // VerA 直接 1 + 子树 2 = 3；VerAB 不算
  assert.equal(CLIENT.dprTopicPaperCount(papers, 'VerA'), 3, '必须按分隔符判定子树（VerAB 不算）')

  const err = CLIENT.dprApiError(409, { error: '专题内还有条目', code: 'topic-not-empty', clearEndpoint: '/api/library/topic/clear' })
  t.diagnostic(`err.code=${err.code} clearEndpoint=${err.clearEndpoint}`)
  // ← 基线红：clearEndpoint 没有挂到 Error 上 ⇒ doDeleteTopic 的 clear 重试是死代码
  assert.equal(err.clearEndpoint, '/api/library/topic/clear')
  assert.equal(CLIENT.dprClearRetryNeeded(err), true, '非空 + clearEndpoint ⇒ 走清空重试')
  assert.equal(CLIENT.dprClearRetryNeeded(CLIENT.dprApiError(409, { error: 'x', code: 'translation-busy' })), false,
    '其余错误不得误触发清空')
})

// 基线模式的提示（不改变断言，只是把「为什么这条在基线红」写进输出）
test('VER-Z 元信息：本次探针跑的是哪一棵树', (t) => {
  t.diagnostic(`repo=${REPO} baselineMode=${BASELINE_MODE}`)
  assert.ok(existsSync(join(REPO, 'dist', 'host.js')), 'dist 必须已 build')
})
