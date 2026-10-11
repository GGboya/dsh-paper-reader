// test/library-clear-and-busy.test.mjs — PR #5 整改第二批（上游评审必修 3 + 评论第 10 条 + 应修 7）。
//
//   A. Windows 文件占用语义（必修 3）：EBUSY/EPERM → 409 file-busy；失败即**回滚**已移动的文件；
//      回滚自身失败时如实报 rollbackFailed（绝不静默、绝不把散落状态说成成功）。
//      注入 renameImpl 是 Linux 上验证 Windows errno 语义的唯一办法（t1 方案 §3）。
//   B. 非空专题「批量清空」（产品决策第 10 条）：topic/clear-plan + topic/clear——逐篇列清单、
//      一次确认、逐篇走同一套回收站、仍受会话/翻译前置 409、失败**整体回滚**并如实报。
//   C. MinerU 激活门槛文案（应修 7）：设置卡片人话 + 两份 README 三步指引（不夸大），
//      以及 README 版本标签（1.4.0）不再残留旧版本号。
//
// 只 import dist/*.js（跑前 `npm run build`）；破坏性实验一律在 mkdtemp 临时库，绝不碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(ROOT, '..', 'dist', m)
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-t3-home-')) // 隔离 agent preset 安装

const {
  ManageError, clearTopic, listArtifacts, moveToTrash, newTrashBundle, planPaperDelete,
  planTopicClear, renamePaper, renameTopic, resolveExistingTopicDir,
} = await import(pathToFileURL(dist('library-manage.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 递归快照（相对路径 → 类型/内容）；默认跳过 `.trash`（回收站是本轮的「操作区」，单独断言）。 */
function snap(dir, { skipTrash = true } = {}) {
  const out = {}
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipTrash && rel === '' && e.name === '.trash') continue
      const p = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { out[r] = '[dir]'; walk(p, r) } else if (e.isSymbolicLink()) { out[r] = `[symlink]` } else { out[r] = readFileSync(p, 'utf8') }
    }
  }
  walk(dir, '')
  return out
}

const catchErr = (fn) => { try { fn(); return null } catch (e) { return e } }

/** 临时文献库 + 一篇多产物文献（P.pdf / P.txt / P.pages.json → 顺序：pages.json、txt、pdf）。 */
function tmpTopic(name = 'T', paper = 'P', suffixes = ['.pdf', '.txt', '.pages.json']) {
  const root = mkdtempSync(join(tmpdir(), 'dpr-t3-'))
  const data = join(root, 'data')
  const topicDir = join(data, name)
  mkdirSync(topicDir, { recursive: true })
  for (const s of suffixes) writeFileSync(join(topicDir, paper + s), 'x' + paper + s)
  return { root, data, topicDir, name, paper }
}

/**
 * 注入式 rename：前向（topic → bundle）第 `failAt` 次抛 `code`；
 * `failRollback` 时反向（bundle → topic）也抛 `rollbackCode`。
 */
function injector(bundleAbs, { failAt = 2, code = 'EBUSY', failRollback = false, rollbackCode = 'EPERM' } = {}) {
  let forward = 0
  return (from, to) => {
    const isForward = !bundleAbs || !from.startsWith(bundleAbs)
    if (isForward) {
      forward++
      if (forward === failAt) throw Object.assign(new Error(`${code}: injected`), { code })
    } else if (failRollback) {
      throw Object.assign(new Error(`${rollbackCode}: injected on rollback`), { code: rollbackCode })
    }
    renameSync(from, to)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 必修 3：Windows EBUSY/EPERM → 409 + 失败即回滚 + 回滚失败如实报
// ═══════════════════════════════════════════════════════════════════════════

test('A1 注入 EBUSY（Windows 占用）：409 file-busy，已移动的文件回滚，库内逐字节零变化', () => {
  const { data, topicDir } = tmpTopic()
  const before = snap(data)
  const files = listArtifacts(topicDir, 'P')
  assert.ok(files.length >= 3, '前置：至少 3 个产物')
  const bundle = newTrashBundle(data)
  const err = catchErr(() => moveToTrash(bundle, topicDir, files, injector(bundle.abs, { failAt: 2, code: 'EBUSY' })))

  assert.ok(err instanceof ManageError, `必须是 ManageError：${err}`)
  assert.equal(err.status, 409, '③ 必须回到上游的 409（旧行为是 trash-move-failed 500）')
  assert.equal(err.code, 'file-busy', '机器可读 code 必须是 file-busy')
  assert.equal(err.extra.busy, files[1].name, '必须指出被占用的是哪个文件')
  assert.equal(err.extra.cause, 'EBUSY')
  assert.deepEqual(err.extra.moved, [], '回滚成功后「仍在回收站」的清单必须为空（旧行为是散落状态）')
  assert.deepEqual(err.extra.rolledBack, [files[0].name], '先前已移动的那个文件必须被回滚')
  assert.deepEqual(err.extra.rollbackFailed, [])
  assert.deepEqual(err.extra.remaining, files.map((f) => f.name), '全部文件都回到「不在回收站」')
  assert.match(err.message, /文件被占用/, '文案要可执行（上游原话：关闭后重试）')
  assert.match(err.message, /关闭后重试/)
  assert.deepEqual(snap(data), before, '失败 = 库没变（逐字节）')
  assert.ok(!existsSync(join(bundle.abs, files[0].name)), '回滚后回收站里不留该文件')
  assert.ok(existsSync(join(topicDir, files[0].name)), '回滚后文件必须回到原处')
})

test('A2 注入 EPERM（同样算占用）：也是 409 file-busy（不是 500）', () => {
  const { data, topicDir } = tmpTopic()
  const bundle = newTrashBundle(data)
  const files = listArtifacts(topicDir, 'P')
  const err = catchErr(() => moveToTrash(bundle, topicDir, files, injector(bundle.abs, { failAt: 1, code: 'EPERM' })))
  assert.equal(err.status, 409)
  assert.equal(err.code, 'file-busy')
  assert.equal(err.extra.cause, 'EPERM')
  assert.deepEqual(err.extra.rolledBack, [], '第 1 个就失败 → 没有需要回滚的')
})

test('A3 非占用 errno（EACCES）：仍 500 trash-move-failed，但同样回滚且库内零变化', () => {
  const { data, topicDir } = tmpTopic()
  const before = snap(data)
  const files = listArtifacts(topicDir, 'P')
  const bundle = newTrashBundle(data)
  const err = catchErr(() => moveToTrash(bundle, topicDir, files, injector(bundle.abs, { failAt: 2, code: 'EACCES' })))
  assert.equal(err.status, 500)
  assert.equal(err.code, 'trash-move-failed')
  assert.deepEqual(err.extra.rolledBack, [files[0].name])
  assert.deepEqual(err.extra.moved, [])
  assert.deepEqual(snap(data), before, '400/500 都无所谓，库内必须零变化')
})

test('A4 真实的部分失败（不注入）：第 1 个已移动的文件被回滚，库内零变化', () => {
  const { data, topicDir } = tmpTopic()
  const before = snap(data)
  const files = listArtifacts(topicDir, 'P')
  const bundle = newTrashBundle(data)
  // 回收站里预置一个与第 2 个文件同名的**非空目录** → 第 2 次 rename 真失败（EISDIR/ENOTEMPTY）
  mkdirSync(join(bundle.abs, files[1].name), { recursive: true })
  writeFileSync(join(bundle.abs, files[1].name, 'blocker'), 'x')
  const err = catchErr(() => moveToTrash(bundle, topicDir, files))
  assert.ok(err instanceof ManageError)
  assert.equal(err.status, 500)
  assert.equal(err.code, 'trash-move-failed')
  assert.deepEqual(err.extra.rolledBack, [files[0].name], '旧行为：第 1 个文件留在回收站（散落状态）')
  assert.deepEqual(err.extra.moved, [], '新行为：回滚后回收站里没有本次移动的文件')
  assert.deepEqual(snap(data), before, '库内逐字节不变')
})

test('A5 回滚自身也失败：绝不静默——rollbackFailed 如实列出，文件仍在回收站（可恢复）', () => {
  const { data, topicDir } = tmpTopic()
  const files = listArtifacts(topicDir, 'P')
  const bundle = newTrashBundle(data)
  const err = catchErr(() => moveToTrash(bundle, topicDir, files, injector(bundle.abs, { failAt: 2, code: 'EBUSY', failRollback: true })))
  assert.equal(err.status, 409)
  assert.equal(err.code, 'file-busy', '占用语义优先（用户要的是「关掉程序再试」）')
  assert.deepEqual(err.extra.rollbackFailed, [files[0].name], '未能回滚的文件必须逐个报出')
  assert.deepEqual(err.extra.moved, [files[0].name], 'moved = 回滚后**真的还在回收站**的文件')
  assert.match(err.message, /未能回滚/, '文案必须降级成「未能回滚，请手动恢复」')
  assert.ok(err.message.includes(files[0].name), '文案要点名')
  assert.ok(existsSync(join(bundle.abs, files[0].name)), '未能回滚的文件一定在回收站里（绝不销毁）')
  assert.equal(readFileSync(join(bundle.abs, files[0].name), 'utf8'), 'xP' + files[0].name.slice(1), '内容逐字节完好（rename，不是 unlink）')
  assert.ok(err.extra.trashDir && err.extra.trashRel, '必须给出恢复线索')
  assert.ok(existsSync(String(err.extra.trashDir)))
})

test('A6 renamePaper 注入 EBUSY：409 file-busy + 已改名的文件回滚回原名', () => {
  const { data, topicDir } = tmpTopic()
  const before = snap(data)
  const err = catchErr(() => renamePaper(data, 'T', 'P', 'Q', injector('', { failAt: 2, code: 'EBUSY' })))
  assert.equal(err.status, 409)
  assert.equal(err.code, 'file-busy')
  assert.match(err.message, /未能回滚|已全部撤销/, '必须交代回滚结果')
  assert.deepEqual(snap(data), before, '改名失败 = 库没变')
})

test('A7 renameTopic 注入 EBUSY：409 file-busy + 目录名未变', () => {
  const { data } = tmpTopic('Old')
  const before = snap(data)
  const err = catchErr(() => renameTopic(data, 'Old', 'New', injector('', { failAt: 1, code: 'EBUSY' })))
  assert.equal(err.status, 409)
  assert.equal(err.code, 'file-busy')
  assert.deepEqual(snap(data), before)
  assert.ok(existsSync(join(data, 'Old')))
  assert.ok(!existsSync(join(data, 'New')))
})

test('A8 路由层把 ManageError 原样输出（file-busy 409 因此自动生效），且前端有可执行文案', () => {
  const host = readFileSync(join(REPO, 'src', 'host.ts'), 'utf8')
  // 唯一出口：不重写 status/code（本轮新增的 file-busy 走的就是这条通道）
  assert.match(host, /json\(res, err\.status, \{ error: err\.message, code: err\.code, \.\.\.err\.extra \}\)/,
    'manageFail 必须原样输出 ManageError 的 status 与 code')
  // Windows 真机占用无法在 Linux/CI 制造（注入是唯一办法）——路由级 409 由上面这条通道保证；
  // 前端文案要能落地「关掉占用程序再试」。
  const client = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(client, /case 'file-busy': return t\('delBusyFile'\)/, 'errText 必须有 file-busy 分支')
  assert.match(client, /delBusyFile: '文件被占用/, 'zh 文案必须存在')
  assert.match(client, /delBusyFile: 'File is in use/, 'en 文案必须存在')
})

// ═══════════════════════════════════════════════════════════════════════════
// B. 评论第 10 条：非空专题「批量清空」
// ═══════════════════════════════════════════════════════════════════════════

let sessionItems = () => []
let sessionDelayMs = 0

function boot(dataDir) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {
      list: async () => {
        if (sessionDelayMs > 0) await new Promise((r) => setTimeout(r, sessionDelayMs))
        return { items: sessionItems() }
      },
    },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir })
  const srv = createServer((req, res) => spec.handler(req, res))
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
    const call = async (method, p, body) => {
      const r = await fetch(base + p, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const txt = await r.text()
      let json = null
      try { json = JSON.parse(txt) } catch { /* 非 JSON */ }
      return { status: r.status, body: json, txt }
    }
    resolve({
      srv,
      get: (p) => call('GET', p),
      post: (p, b) => call('POST', p, b),
      raw: async (method, p, raw) => {
        const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: raw })
        const txt = await r.text()
        let json = null
        try { json = JSON.parse(txt) } catch { /* 非 JSON */ }
        return { status: r.status, body: json, txt }
      },
    })
  }))
}

const fakeSession = (topic, name, n = 1, running = true) => ({
  sessionId: `dpr-${Buffer.from(`${topic}/${name}`).toString('base64url')}-${n}`,
  updatedAt: Date.now(), running, blank: false,
})

/** 造一个 3 篇文献的专题（每篇 .pdf + .txt）。 */
function clearWorkspace(topic = '深度学习') {
  const root = mkdtempSync(join(tmpdir(), 'dpr-t3-clear-'))
  const data = join(root, 'data')
  const names = ['Paper One', 'Paper Two', 'Paper Three']
  mkdirSync(join(data, topic), { recursive: true })
  for (const n of names) {
    writeFileSync(join(data, topic, n + '.pdf'), `pdf:${n}`)
    writeFileSync(join(data, topic, n + '.txt'), `txt:${n}`)
  }
  return { root, data, topic, names }
}

test('B1 clear-plan：形状与 delete-plan 对齐（逐篇 files/totalBytes + sessions/translation），只读', async () => {
  const w = clearWorkspace()
  const { srv, get } = await boot(w.data)
  try {
    const before = snap(w.data)
    const r = await get(`/api/library/topic/clear-plan?topic=${encodeURIComponent(w.topic)}`)
    assert.equal(r.status, 200, r.txt)
    assert.equal(r.body.papersCount, 3)
    assert.equal(r.body.filesCount, 6)
    assert.ok(r.body.totalBytes > 0)
    assert.deepEqual(r.body.papers.map((p) => p.name).sort(), [...w.names].sort())
    for (const p of r.body.papers) {
      assert.ok(Array.isArray(p.files) && p.files.length === 2, `${p.name} 必须逐条列出产物`)
      assert.deepEqual(p.sessions, { total: 0, running: 0 })
      assert.deepEqual(p.translation, { busy: false, hasZh: false, hasDual: false })
    }
    assert.deepEqual(r.body.hidden, [])
    assert.equal(r.body.trashRoot, '.trash')
    assert.ok(Array.isArray(r.body.notDeleted) && r.body.notDeleted.length > 0)
    assert.equal(r.body.clearEndpoint, '/api/library/topic/clear')
    assert.deepEqual(snap(w.data), before, '预览必须只读')
    // path 参数一律拒（写路径只认 topic）
    const bad = await get(`/api/library/topic/clear-plan?topic=${encodeURIComponent(w.topic)}&path=/etc/passwd`)
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'escape-rejected')
    // 不存在的专题 → 404；符号链接专题 → 400（沿用既有加固）
    const missing = await get('/api/library/topic/clear-plan?topic=nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, 'not-found')
    symlinkSync(w.root, join(w.data, 'evil'))
    const link = await get('/api/library/topic/clear-plan?topic=evil')
    assert.equal(link.status, 400)
    assert.equal(link.body.code, 'escape-rejected')
  } finally { srv.close() }
})

test('B2 clear：一次确认批量清空 → 逐篇进回收站、专题目录消失、响应可审计', async () => {
  const w = clearWorkspace()
  const { srv, post, get } = await boot(w.data)
  try {
    const r = await post('/api/library/topic/clear', { topic: w.topic, confirmName: w.topic })
    assert.equal(r.status, 200, r.txt)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.cleared, 3)
    assert.equal(r.body.movedFiles, 6)
    assert.deepEqual(r.body.movedHidden, [])
    assert.equal(r.body.archivedSessionsNote, true)
    assert.equal(r.body.detachedSessions, 0)
    assert.ok(!existsSync(join(w.data, w.topic)), '清空后专题目录必须删除（非递归 rmdir）')
    const bundle = String(r.body.trashDir)
    assert.ok(bundle.startsWith(join(w.data, '.trash')), `回收站必须在库内：${bundle}`)
    assert.ok(existsSync(join(bundle, 'manifest.json')), 'bundle 根必须有总清单')
    for (const n of w.names) {
      assert.ok(existsSync(join(bundle, n, n + '.pdf')), `${n}.pdf 必须在该篇子目录里（可恢复）`)
      assert.ok(existsSync(join(bundle, n, n + '.txt')))
      assert.ok(existsSync(join(bundle, n, 'manifest.json')), `${n} 必须有 manifest.json`)
    }
    assert.equal((await get('/api/library')).body.topics.includes(w.topic), false, '库里不得再列出已清空专题')
  } finally { srv.close() }
})

test('B3 clear 的前置校验：confirmName 必需、空专题 400、缺字段 400（都不碰盘）', async () => {
  const w = clearWorkspace()
  mkdirSync(join(w.data, 'empty'), { recursive: true })
  const { srv, post, raw } = await boot(w.data)
  try {
    const before = snap(w.data)
    for (const body of [{ topic: w.topic }, { topic: w.topic, confirmName: 'nope' }, { topic: w.topic, confirmName: '' }]) {
      const r = await post('/api/library/topic/clear', body)
      assert.equal(r.status, 400, `${JSON.stringify(body)} 必须 400：${r.txt}`)
      assert.equal(r.body.code, 'confirm-mismatch', '手输专题名确认保留在清空这一步')
    }
    const empty = await post('/api/library/topic/clear', { topic: 'empty', confirmName: 'empty' })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.code, 'bad-request')
    assert.match(empty.body.error, /已为空/)
    for (const b of [null, { topic: 123, confirmName: 123 }, { path: '/etc/passwd', topic: w.topic, confirmName: w.topic }]) {
      const r = b === null ? await raw('POST', '/api/library/topic/clear', 'null') : await post('/api/library/topic/clear', b)
      assert.equal(r.status, 400, `${JSON.stringify(b)} 必须 400：${r.txt}`)
      assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0)
      assert.ok(!r.txt.includes(w.data), '不得泄露 dataDir')
    }
    const sym = await post('/api/library/topic/clear', { topic: '../' + w.topic, confirmName: '../' + w.topic })
    assert.equal(sym.status, 400)
    assert.deepEqual(snap(w.data), before, '被拒的请求绝不碰盘')
  } finally { srv.close() }
})

test('B4 clear 的会话前置：有运行中会话 → 409 session-running，且第一字节都没动', async () => {
  const w = clearWorkspace()
  const { srv, post } = await boot(w.data)
  try {
    sessionItems = () => [fakeSession(w.topic, w.names[1], 1, true)]
    const before = snap(w.data)
    const r = await post('/api/library/topic/clear', { topic: w.topic, confirmName: w.topic })
    assert.equal(r.status, 409, r.txt)
    assert.equal(r.body.code, 'session-running')
    assert.equal(r.body.sessions.running, 1)
    assert.deepEqual(snap(w.data), before, '前置拒绝 = 盘上零变化')
    // 只有非 running 的会话 → 不拦
    sessionItems = () => [fakeSession(w.topic, w.names[1], 1, false)]
    const del = await post('/api/library/topic/delete', { topic: w.topic, confirmName: w.topic })
    assert.equal(del.status, 409, '非空专题仍 409（批量清空是唯一的一次确认路径）')
    assert.equal(del.body.code, 'topic-not-empty')
    assert.equal(del.body.clearEndpoint, '/api/library/topic/clear', '409 必须给出下一步（clearEndpoint）')
  } finally { sessionItems = () => []; srv.close() }
})

test('B5 clear 的翻译前置：正在生成译文 → 409 translation-busy（payload 带将在清单里高亮的篇名）', async () => {
  // 造**真实** busy 状态：假 babeldoc（--version/--help 立刻返回，真被拉起时写 pid 后 sleep），
  // 不触发任何真实翻译、也不吃资源（照搬 VB8 的手法）。
  const TDATA = mkdtempSync(join(tmpdir(), 'dpr-t3-tx-'))
  const dataDir = join(TDATA, 'data')
  const pidFile = join(TDATA, 'pid')
  process.env.VB_TX_PIDFILE = pidFile
  const topic = 'tx'
  mkdirSync(join(dataDir, topic), { recursive: true })
  for (const n of ['paper', 'paper2']) {
    writeFileSync(join(dataDir, topic, n + '.pdf'), 'pdf:' + n)
    writeFileSync(join(dataDir, topic, n + '.txt'), 'txt:' + n)
  }
  const binPath = join(TDATA, '.venv-pdf2zh', 'bin', 'babeldoc')
  mkdirSync(join(TDATA, '.venv-pdf2zh', 'bin'), { recursive: true })
  writeFileSync(binPath, '#!/bin/sh\ncase "$1" in\n  --version) echo "babeldoc fake 1.0"; exit 0 ;;\n  --help) echo "--no-watermark --skip-figure-text"; exit 0 ;;\n  *) echo $$ > "$VB_TX_PIDFILE"; exec sleep 120 ;;\nesac\n')
  chmodSync(binPath, 0o755)
  const { srv, post } = await boot(dataDir)
  try {
    const { startTranslation } = await import(pathToFileURL(dist('translate.js')).href)
    const { resolvePaper } = await import(pathToFileURL(dist('library.js')).href)
    const ref = resolvePaper(dataDir, { topic, name: 'paper' })
    const started = await startTranslation(ref, dataDir, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' })
    assert.equal(started.started, true, JSON.stringify(started))
    // 只对**专题目录**做逐字节快照：翻译草稿目录 `.pdf2zh-tmp` 是那个假 babeldoc 进程自己
    // 惰性创建的，与本次清空请求无关（不把它算进不变量）。
    const before = snap(join(dataDir, topic))
    const r = await post('/api/library/topic/clear', { topic, confirmName: topic })
    assert.equal(r.status, 409, r.txt)
    assert.equal(r.body.code, 'translation-busy')
    assert.ok(Array.isArray(r.body.papers) && r.body.papers.includes('paper'), `payload 必须点名（UI 在清单里高亮）：${r.txt}`)
    assert.deepEqual(snap(join(dataDir, topic)), before, '前置拒绝 = 第一字节都没动')
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    }
    delete process.env.VB_TX_PIDFILE
    srv.close()
    rmSync(TDATA, { recursive: true, force: true })
  }
})

test('B5b clear 的翻译前置：非 busy（无译文任务）时不拦；且 409 只来自 busy 而不是「凡有译文都拦」', async () => {
  const w = clearWorkspace()
  writeFileSync(join(w.data, w.topic, 'Paper One-zh.pdf'), 'zh') // 已有译文（非 busy）
  const { srv, post } = await boot(w.data)
  try {
    const r = await post('/api/library/topic/clear', { topic: w.topic, confirmName: w.topic })
    assert.equal(r.status, 200, `已完成的译文不该拦清空：${r.txt}`)
    assert.ok(!existsSync(join(w.data, w.topic)))
  } finally { srv.close() }
})

test('B6 clear 的隐藏条目：一并进回收站（不销毁），之后才 rmdir', async () => {
  const w = clearWorkspace('onlyhidden')
  writeFileSync(join(w.data, 'onlyhidden', '.DS_Store'), 'junk')
  mkdirSync(join(w.data, 'onlyhidden', '.git'), { recursive: true })
  writeFileSync(join(w.data, 'onlyhidden', '.git', 'HEAD'), 'ref: x')
  const { srv, post } = await boot(w.data)
  try {
    const r = await post('/api/library/topic/clear', { topic: 'onlyhidden', confirmName: 'onlyhidden' })
    assert.equal(r.status, 200, r.txt)
    assert.equal(r.body.cleared, 3)
    assert.ok(r.body.movedHidden.includes('.DS_Store'), `隐藏条目必须进回收站：${r.txt}`)
    assert.ok(!existsSync(join(w.data, 'onlyhidden')), '移完隐藏条目后目录必须能删掉（非递归 rmdir）')
    assert.ok(existsSync(join(String(r.body.trashDir), '.DS_Store')), '隐藏条目内容可恢复')
  } finally { srv.close() }
})

test('B7 clear 的在途互斥：同一专题并发清空 → 恰好一个 200、另一个 409 busy', async () => {
  const w = clearWorkspace()
  const { srv, post } = await boot(w.data)
  sessionDelayMs = 25 // 拉开在途窗口（会话查询在 withInflight 之内）
  try {
    const [a, b] = await Promise.all([
      post('/api/library/topic/clear', { topic: w.topic, confirmName: w.topic }),
      post('/api/library/topic/clear', { topic: w.topic, confirmName: w.topic }),
    ])
    const codes = [a, b].map((r) => `${r.status}:${r.body?.code ?? '-'}`).sort()
    assert.deepEqual(codes, ['200:-', '409:busy'], `必须恰好一个成功、一个 busy：${JSON.stringify(codes)}`)
    assert.ok(!existsSync(join(w.data, w.topic)), '成功那次必须把专题清干净')
  } finally { sessionDelayMs = 0; srv.close() }
})

test('B8 clear 部分失败：整体回滚（含已完成篇）+ 如实报 cleared/failedPaper/rollbackFailed', async () => {
  const w = clearWorkspace()
  const before = snap(w.data)
  // 第 2 篇的第 2 次 rename 抛 EBUSY → 第 1 篇已清空，必须被回滚
  let forwards = 0
  const P2 = w.names[1]
  const inj = (from, to) => {
    if (from.includes(`${P2}${'/'}`) || to.includes(`${P2}${'/'}`)) {
      forwards++
      if (forwards === 2) throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' })
    }
    renameSync(from, to)
  }
  const err = catchErr(() => clearTopic(w.data, w.topic, inj))
  assert.ok(err instanceof ManageError, `必须抛 ManageError：${err}`)
  assert.equal(err.status, 409, '占用 → 409 file-busy')
  assert.equal(err.code, 'file-busy')
  assert.equal(err.extra.failedPaper, P2, '必须点名失败在第几篇')
  // listPapers 按文献名排序：'Paper One'、'Paper Three' 在 'Paper Two' 之前 → 两篇都被回滚
  assert.deepEqual([...err.extra.clearedBeforeRollback].sort(), ['Paper One', 'Paper Three'], '失败前已完成的两篇都要被回滚')
  assert.equal(err.extra.cleared, 0, '整体回滚后没有一篇处于「已清空」状态')
  assert.deepEqual(err.extra.rollbackFailed, [], '本次回滚干净')
  assert.deepEqual(err.extra.moved, [], '回收站里不应残留本次移动的文件')
  assert.ok(err.extra.trashDir && err.extra.trashRel, '恢复线索必须有')
  assert.deepEqual(snap(w.data), before, '失败 = 库内逐字节零变化（含已回滚的第 1 篇）')
})

test('B9 clear 的写路径加固不回退：符号链接专题拒删、别名路由与规范路由同源', async () => {
  const w = clearWorkspace()
  const { srv, post } = await boot(w.data)
  try {
    symlinkSync(w.root, join(w.data, 'evil-topic'))
    const r = await post('/api/library/topic/clear', { topic: 'evil-topic', confirmName: 'evil-topic' })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'escape-rejected')
    assert.ok(existsSync(join(w.data, 'evil-topic')), '只拒绝、不销毁链接本身')
    // 清空只走规范名（没有别名族）；delete-topic 的两种名字仍然都可用（t2 的兼容层）
    const alias = await post('/api/library/topic/delete', { topic: w.topic, confirmName: w.topic })
    assert.equal(alias.status, 409)
    assert.equal(alias.body.code, 'topic-not-empty')
  } finally { srv.close() }
})

test('B11 rmdir 只走非递归：移完后目录又非空 → 409 topic-not-empty + 整体回滚（绝无 rm -rf）', () => {
  const w = clearWorkspace()
  // 注入：最后一次前向 rename 之后，往专题目录里塞一个新文件（模拟竞态：清空过程中又来了东西）
  let forward = 0
  const inj = (from, to) => {
    renameSync(from, to)
    if (!from.startsWith(join(w.data, '.trash'))) {
      forward++
      if (forward === 6) writeFileSync(join(w.data, w.topic, 'appeared-late.txt'), 'late')
    }
  }
  const err = catchErr(() => clearTopic(w.data, w.topic, inj))
  assert.ok(err instanceof ManageError, `必须抛 ManageError：${err}`)
  assert.equal(err.status, 409, '非空 → 409（而不是 rm -rf 强删）')
  assert.equal(err.code, 'topic-not-empty')
  assert.equal(err.extra.cleared, 0, '整体回滚后没有一篇处于已清空状态')
  assert.deepEqual(err.extra.rollbackFailed, [], '本次回滚干净')
  assert.deepEqual(err.extra.moved, [], '回收站里不留本次移动的文件')
  assert.ok(existsSync(join(w.data, w.topic)), '专题目录必须还在（非递归 rmdir 失败了就是失败）')
  for (const n of w.names) {
    assert.ok(existsSync(join(w.data, w.topic, n + '.pdf')), `${n}.pdf 必须被回滚回原处`)
    assert.ok(existsSync(join(w.data, w.topic, n + '.txt')))
  }
  assert.ok(existsSync(join(w.data, w.topic, 'appeared-late.txt')), '竞态里出现的文件不是我们的，必须原样保留')
})

test('B10 UI 静态契约：非空专题走 clear-plan → clear、清单来自服务端、手输专题名保留、无原生弹窗', () => {
  const client = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(client, /\/library\/topic\/clear-plan\?topic=/, '非空专题必须先拿服务端清空清单')
  assert.match(client, /api\('\/library\/topic\/clear'/, '确认后必须打规范名 /library/topic/clear')
  assert.match(client, /clearEndpoint/, '服务端 409 的下一步指引要被 UI 用上（竞态时改走清空）')
  assert.match(client, /delTopicClearConfirm/, '确认按钮文案必须存在')
  assert.match(client, /plan\.papers\.map/, '确认框清单必须逐篇来自服务端返回的 papers')
  assert.match(client, /requireText: delDlg\.kind === 'paper' \? undefined : delDlg\.name/, '手输专题名确认保留在清空/删除这一步')
  assert.ok(!/window\.(confirm|prompt)\s*\(/.test(client), '不得使用 window.confirm/prompt（Electron 不支持）')
  assert.match(client, /createPortal\(/, '弹窗必须走页内 portal')
  // 清空确认框要能提示「会被服务端拦下」的篇名（translation.busy / sessions.running）
  assert.match(client, /clearBlockedNames/)
  assert.match(client, /delTopicClearBlocked/)
})

// ═══════════════════════════════════════════════════════════════════════════
// C. 应修 7：MinerU 激活门槛文案（设置卡片 + 两份 README 三步指引）+ 版本标签
// ═══════════════════════════════════════════════════════════════════════════

test('C1 设置卡片：MinerU 描述有「什么时候需要 + 配好后入口在哪」的人话，并按模式给取舍', () => {
  const client = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  for (const k of ['setMineruWhy', 'setMineruWhyLocal', 'setMineruWhyCloud', 'setMineruOffHint']) {
    assert.ok(new RegExp(`t\\('${k}'\\)`).test(client), `${k} 必须在卡片里真的被引用（不是死键）`)
  }
  // 卡片里三句人话：scan/formula 场景、配置后入口（重新转录按钮）、关闭时的边界
  assert.match(client, /setMineruWhy: '[^']*扫描版/, 'zh 人话要提到扫描版（用户能对上号）')
  assert.match(client, /setMineruWhy: '[^']*重新转录/, '要说清配好之后入口出现在哪')
  assert.match(client, /setMineruOffHint: '[^']*pdf\.js/, '「关闭」时要如实说明 pdf.js 能做什么')
  assert.match(client, /setMineruWhy: 'Scanned PDFs unreadable/, 'en 同步')
})

test('C2 两份 README：云端三步指引 + 公式/扫描件两类场景各一句；不夸大', () => {
  for (const f of ['README.md', 'README_EN.md']) {
    const t = readFileSync(join(REPO, f), 'utf8')
    assert.match(t, /mineru\.net/, `${f} 必须给出注册地址`)
    const steps = t.match(/^\d\. .*$/gm) || []
    assert.ok(steps.length >= 3, `${f} 三步指引必须是真的编号列表：${JSON.stringify(steps.slice(0, 4))}`)
    assert.match(t, /API (管理|management)/i, `${f} 必须说明 token 在站内哪里创建`)
    assert.match(t, /MinerU (解析后端|parser)/, `${f} 必须给出粘贴位置（设置卡片）`)
    // 两类受益场景各一句（按语言各自的说法断言）
    assert.match(t, /公式/, `${f} 缺「公式引用」场景一句`)
    assert.match(t, /公式引用[^\n]*LaTeX|LaTeX[^\n]*cited/, `${f} 公式场景要说到 LaTeX 才能点着引用`)
    const scanWord = f === 'README.md' ? /扫描/ : /scanned/i
    assert.match(t, scanWord, `${f} 缺「扫描版」场景一句`)
    // 不夸大：明确 pdf.js 路径不受影响、云端尚未端到端实测
    assert.match(t, /pdf\.js/, `${f} 必须如实说明不配置时的能力（pdf.js）`)
    assert.match(t, /(尚未端到端实测|not been end-to-end tested)/, `${f} 必须保留「云端未实测」的诚实声明`)
  }
})

test('C3 README 版本标签已同步到 1.4.0（不再残留 1.5.0/1.6.0）', () => {
  for (const f of ['README.md', 'README_EN.md']) {
    const t = readFileSync(join(REPO, f), 'utf8')
    assert.ok(!/1\.5\.0|1\.6\.0/.test(t), `${f} 残留旧版本号：${(t.match(/1\.[56]\.0/g) || []).join(', ')}`)
    assert.match(t, /v1\.4\.0|@1\.4\.0/, `${f} 必须出现 v1.4.0 / @1.4.0`)
  }
})
