// test/pr8-review-r1.test.mjs — REV1（t4）对 IMP1（t1）B/C/F 布局碰撞修复的**独立对抗探针**。
//
// 独立性声明（团队 profile 硬规则：评审必须自己构造证据）：
//   · 本文件不 import 实现方的 `test/pr8-layout-collision.test.mjs`，不复用它的夹具/期望值；
//     库名（Alpha/Gamma/…）、文件名（Paper/Flat/CaseRetained/…）、冲突残留内容全部本评审自造。
//   · 只 import `dist/*.js`；全部库用 `mkdtemp` 造，`DSH_HOME` 指向临时目录，绝不碰真实文献库/真实 ~/.dsh。
//   · 同一份探针可跑 **fdb45f2 基线**：`R1_REPO=/abs/.worktrees/pr8-baseline node --test test/pr8-review-r1.test.mjs`
//     ⇒ 缺陷条目应红（且红在**状态码/库结构**断言上），修复后应绿。基线的红不是引用 t1 的自述，
//     是本探针自己在基线上跑出来的。
//
// 覆盖（docs/pr8-maintainer-review.md 必修 B/C/F）：
//   B  上传碰撞：撞已存在子专题 / 论文目录 / 旧平铺产物 / 仅大小写不同；预检不消费请求体；正常上传回归。
//   C  目录-文件互踩：create-topic 祖先与目标 / upload topic / rename-topic 进论文目录；create-topic 撞平铺同名；
//      renameLegacyPaper 撞目录；新布局 renamePaper 目标内同名残留不静默覆盖。
//   F  boundaryOnly 长度回归：110 字 legacy 专题可删/可改名、221 字 legacy 路径可删；创建侧上限不变；
//      boundaryOnly **不得**放宽 `..` / 保留名 / 编码变形这类安全边界。
//   对抗面：`../`、编码变形、符号链接主题、符号链接论文目标（基线可能写穿到库外）、upload 名带 `..`。
//
// 判读：本文件绿 = 修复在本评审自造场景下成立；红 = 消息里带实际状态码/库快照差异，便于定位。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 默认测当前修复树；`R1_REPO` 指向基线工作树时跑基线对照。 */
const TARGET = process.env.R1_REPO ? resolve(process.env.R1_REPO) : join(HERE, '..')
const BASELINE_MODE = Boolean(process.env.R1_REPO)
const dist = (m) => join(TARGET, 'dist', m)

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-r1-home-'))
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// ── 平台事实：自己在临时目录实测大小写敏感性（不 import 实现方的 fs-probe，也不硬编码平台名） ──
function caseInsensitiveFs() {
  const d = mkdtempSync(join(tmpdir(), 'dpr-r1-case-'))
  try {
    writeFileSync(join(d, 'CaseProbe.txt'), 'x')
    return existsSync(join(d, 'caseprobe.txt'))
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}
const CASE_INSENSITIVE = caseInsensitiveFs()

// ── 临时库与夹具 ─────────────────────────────────────────────────────────────

function newLib(prefix = 'dpr-r1-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局论文：`<data>/<topic>/<name>/<name>.pdf`（可带正文 txt）。 */
function putPaper(data, topic, name, pdfBody = `pdf:${topic}/${name}`) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), pdfBody)
  writeFileSync(join(dir, `${name}.txt`), `body:${topic}/${name}`)
  return dir
}

/** 旧布局平铺论文产物：`<data>/<topic>/<name><suffix>`。 */
function putFlat(data, topic, name, suffix) {
  mkdirSync(join(data, topic), { recursive: true })
  writeFileSync(join(data, topic, `${name}${suffix}`), `flat:${name}${suffix}`)
}

/** 路由宿主：与 host 的注册契约一致（这只是启动机制，不是实现方断言）。 */
async function boot(data) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const base = `http://127.0.0.1:${port}/paper-reader`
  const parse = (txt) => { try { return JSON.parse(txt) } catch { return null } }
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
  const upload = async (topic, name, bytes = 200) => {
    const r = await fetch(base + '/api/library/upload', {
      method: 'POST',
      headers: {
        'x-dpr-topic': encodeURIComponent(topic),
        'x-dpr-name': encodeURIComponent(name),
        'content-type': 'application/pdf',
      },
      body: Buffer.alloc(bytes, 0x41),
    })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  /** 只发 header、**故意不发 body**：验证碰撞预检是否在消费请求体之前返回。 */
  const uploadHeadersOnly = (topic, name, timeoutMs = 1_500) => new Promise((resolveP) => {
    const started = Date.now()
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolveP({ ...v, elapsedMs: Date.now() - started }) } }
    const req = httpRequest({
      host: '127.0.0.1', port,
      path: '/paper-reader/api/library/upload', method: 'POST',
      headers: {
        'x-dpr-topic': encodeURIComponent(topic),
        'x-dpr-name': encodeURIComponent(name),
        'content-type': 'application/pdf',
        'content-length': '500',
      },
    })
    const timer = setTimeout(() => { req.destroy(); done({ status: null, txt: '' }) }, timeoutMs)
    req.on('response', (r) => {
      let txt = ''
      r.on('data', (c) => { txt += c })
      r.on('end', () => { clearTimeout(timer); done({ status: r.statusCode, txt }); req.destroy() })
    })
    req.on('error', () => { clearTimeout(timer); done({ status: null, txt: '' }) })
    req.flushHeaders() // 只把 header 发出去；不调用 end() ⇒ 服务端收不到 body
  })
  return { srv, get, post, upload, uploadHeadersOnly, close: () => { srv.closeAllConnections?.(); srv.close() } }
}

/** 库内结构快照（相对路径 → 'dir' | 文件内容）：用于断言「被拒的操作零改动」。 */
function snap(data) {
  const out = {}
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      const rel = relative(data, p).split(sep).join('/')
      if (e.isDirectory()) { out[rel] = 'dir'; walk(p) } else out[rel] = readFileSync(p, 'utf8')
    }
  }
  walk(data)
  return out
}

/** 列表 API 的 `topic/name` 视图（「数据是否可见」的权威口径）。 */
async function paperKeys(get) {
  const lib = await get('/api/library')
  assert.equal(lib.status, 200, `GET /api/library 必须 200：${lib.txt}`)
  return lib.body.papers.map((p) => `${p.topic}/${p.name}`).sort()
}

/** 找树里某路径的节点。 */
function treeNode(lib, path) {
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.path === path) return n
      const got = walk(n.children ?? [])
      if (got) return got
    }
    return null
  }
  return walk(lib.body.tree ?? [])
}

// ═════════════════════════════════════════════════════════════════════════════
// B. 上传碰撞（会吞数据 / 让子专题整体消失）
// ═════════════════════════════════════════════════════════════════════════════

test('R1-B1 上传撞已存在子专题 ⇒ 409、库零改动、子专题论文仍可见（基线 200 吞掉子树）', async () => {
  const { root, data } = newLib('dpr-r1-b1-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/Sub', 'Paper')
    const before = snap(data)
    const r = await s.upload('Alpha', 'Sub.pdf')
    assert.equal(r.status, 409, `上传到同名子专题必须 409（否则子专题被变成论文目录、其下论文整体消失）：${r.txt}`)
    assert.equal(r.body.code, 'target-exists', `机器码必须是 target-exists：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的上传不得改动文献库（逐字节）')
    assert.equal(existsSync(join(data, 'Alpha', 'Sub', 'Sub.pdf')), false, '子专题目录里绝不许出现同名 PDF')
    assert.deepEqual(await paperKeys(s.get), ['Alpha/Sub/Paper'], '子专题里的论文必须仍被列表')
    const lib = await s.get('/api/library')
    const node = treeNode(lib, 'Alpha/Sub')
    assert.ok(node, '树里必须仍有 Alpha/Sub 节点')
    assert.deepEqual(node.papers, ['Paper'], '树里子专题的论文必须还在')
    assert.equal(node.papers.includes('Sub'), false, 'Alpha/Sub 绝不能同时被当成论文')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-B2 上传撞已存在论文目录 ⇒ 409、PDF 逐字节不被覆盖（基线 200 覆盖）', async () => {
  const { root, data } = newLib('dpr-r1-b2-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha', 'Paper', 'ORIGINAL-PDF-MUST-SURVIVE')
    const before = snap(data)
    const r = await s.upload('Alpha', 'Paper.pdf')
    assert.equal(r.status, 409, `上传到已存在论文目录必须 409（不得覆盖/合并）：${r.txt}`)
    assert.deepEqual(snap(data), before, '不得覆盖论文目录里的任何产物')
    assert.equal(readFileSync(join(data, 'Alpha', 'Paper', 'Paper.pdf'), 'utf8'), 'ORIGINAL-PDF-MUST-SURVIVE',
      'P.pdf 内容必须原样（不得被 200 的上传覆盖）')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-B3 上传撞同层旧平铺产物（.pdf/.txt/.study.json）⇒ 409 且不建论文文件夹', async () => {
  for (const suffix of ['.pdf', '.txt', '.study.json']) {
    const { root, data } = newLib('dpr-r1-b3-')
    const s = await boot(data)
    try {
      putFlat(data, 'Alpha', 'Flat', suffix)
      const before = snap(data)
      const r = await s.upload('Alpha', 'Flat.pdf')
      assert.equal(r.status, 409,
        `同层已有 Flat${suffix} 时必须 409（否则旧平铺论文被文件夹规则永久遮蔽）：${r.txt}`)
      assert.deepEqual(snap(data), before, `被拒的上传（${suffix}）不得改动文献库`)
      assert.equal(existsSync(join(data, 'Alpha', 'Flat')), false, '不得创建同名论文文件夹')
      assert.equal(existsSync(join(data, 'Alpha', 'Flat' + suffix)), true, `旧平铺产物 Flat${suffix} 必须原地不动`)
    } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
  }
})

test('R1-B4 上传仅大小写不同（论文目录 + 平铺文件）⇒ 409 且不创建小写变体（平台事实分支）', async (t) => {
  const { root, data } = newLib('dpr-r1-b4-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha', 'CaseRetained')
    putFlat(data, 'Alpha', 'FlatVariant', '.pdf')
    t.diagnostic(`平台大小写敏感：${!CASE_INSENSITIVE}`)
    const before = snap(data)

    const dirClash = await s.upload('Alpha', 'caseretained.pdf')
    assert.equal(dirClash.status, 409,
      `仅大小写不同的同名论文目录必须 409（大小写不敏感盘上会互相吞掉）：${dirClash.txt}`)
    assert.match(dirClash.txt, /CaseRetained/, `文案要点名磁盘上的真实冲突对象：${dirClash.txt}`)
    const fileClash = await s.upload('Alpha', 'flatvariant.pdf')
    assert.equal(fileClash.status, 409, `仅大小写不同的旧平铺论文必须 409：${fileClash.txt}`)
    assert.deepEqual(snap(data), before, '被拒的上传不得改动文献库（不得静默吞掉大小写变体）')
    if (!CASE_INSENSITIVE) {
      // 大小写敏感盘上「不创建小写变体」才是可观测的；不敏感盘上小写路径必然 resolve 到同一实体。
      assert.equal(existsSync(join(data, 'Alpha', 'caseretained')), false, '敏感盘上绝不许创建小写变体目录')
      assert.equal(existsSync(join(data, 'Alpha', 'flatvariant')), false, '敏感盘上绝不许创建小写变体目录')
    }
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-B5 回归：干净名字正常上传仍 200，落点是论文文件夹（修前修后都应绿）', async () => {
  const { root, data } = newLib('dpr-r1-b5-')
  const s = await boot(data)
  try {
    mkdirSync(join(data, 'Alpha'), { recursive: true })
    const r = await s.upload('Alpha', 'Fresh One.pdf')
    assert.equal(r.status, 200, `干净名字必须仍能上传：${r.txt}`)
    assert.equal(existsSync(join(data, 'Alpha', 'Fresh One', 'Fresh One.pdf')), true, '落点必须是 <topic>/<stem>/<name>.pdf')
    assert.equal(existsSync(join(data, 'Alpha', 'Fresh One.pdf')), false, '绝不平铺到专题目录')
    assert.deepEqual(await paperKeys(s.get), ['Alpha/Fresh One'])
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-B6 碰撞预检必须在消费请求体之前返回（只发 header 不发 body）', async () => {
  const { root, data } = newLib('dpr-r1-b6-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha', 'Paper')
    const r = await s.uploadHeadersOnly('Alpha', 'Paper.pdf', 1_500)
    assert.equal(r.status, 409,
      `只发 header 时也必须立刻 409（证明预检在 for-await body 之前）；实际 ${JSON.stringify({ status: r.status, elapsedMs: r.elapsedMs })}`)
    assert.ok(r.elapsedMs < 1_200, `必须在 1.2s 内返回（基线会在等 body 超时）：${r.elapsedMs}ms`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// C. 目录-文件互踩
// ═════════════════════════════════════════════════════════════════════════════

test('R1-C1a create-topic：祖先段是论文目录 ⇒ 409、零改动（基线 200 建出会消失的专题）', async () => {
  const { root, data } = newLib('dpr-r1-c1a-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha', 'Paper')
    const before = snap(data)
    const r = await s.post('/api/library/topic', { name: 'Alpha/Paper/NewTopic' })
    assert.equal(r.status, 409, `祖先段 Alpha/Paper 是论文目录，建专题必须 409：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的创建不得改动文献库')
    assert.deepEqual(await paperKeys(s.get), ['Alpha/Paper'], '论文 Alpha/Paper 必须仍在列表里')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-C1b upload：topic 落在论文目录里 ⇒ 409、不在论文目录内建文件夹（基线 200 消失）', async () => {
  const { root, data } = newLib('dpr-r1-c1b-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha', 'Paper')
    const before = snap(data)
    const r = await s.upload('Alpha/Paper', 'Intruder.pdf')
    assert.equal(r.status, 409, `topic=Alpha/Paper 是论文目录，上传必须 409：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的上传不得改动文献库')
    assert.equal(existsSync(join(data, 'Alpha', 'Paper', 'Intruder')), false, '不得在论文目录里建新论文文件夹')
    assert.deepEqual(await paperKeys(s.get), ['Alpha/Paper'], '论文 Alpha/Paper 必须仍可见')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-C1c rename-topic：目标父级是论文目录 ⇒ 409、子树原地不动（基线 200 后子树消失）', async () => {
  const { root, data } = newLib('dpr-r1-c1c-')
  const s = await boot(data)
  try {
    putPaper(data, 'Gamma/Child', 'Inside')
    putPaper(data, 'Alpha', 'Paper')
    const before = snap(data)
    const r = await s.post('/api/library/rename-topic', { name: 'Gamma', to: 'Alpha/Paper/Gamma' })
    assert.equal(r.status, 409, `目标父级 Alpha/Paper 是论文目录，改名必须 409：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
    assert.ok(existsSync(join(data, 'Gamma', 'Child', 'Inside', 'Inside.pdf')), '源子树必须原样留在原地')
    assert.equal(existsSync(join(data, 'Alpha', 'Paper', 'Gamma')), false, '绝不许把子专题树搬进论文目录')
    assert.deepEqual(await paperKeys(s.get), ['Alpha/Paper', 'Gamma/Child/Inside'], '两篇论文都必须仍可见')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-C2 create-topic：与同层旧平铺论文同名 ⇒ 409、旧论文仍可见且 delete-plan 可用（基线 200 后列表空）', async () => {
  const { root, data } = newLib('dpr-r1-c2-')
  const s = await boot(data)
  try {
    putFlat(data, 'Alpha', 'Legacy', '.pdf')
    const before = snap(data)
    const r = await s.post('/api/library/topic', { name: 'Alpha/Legacy' })
    assert.equal(r.status, 409, `同层已有旧平铺论文 Legacy.pdf，建同名目录必须 409：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的创建不得改动文献库')
    assert.equal(existsSync(join(data, 'Alpha', 'Legacy')), false, '不得创建同名目录')
    assert.deepEqual(await paperKeys(s.get), ['Alpha/Legacy'], '旧平铺论文必须仍然可见（不得被文件夹规则遮蔽）')
    const plan = await s.get('/api/library/paper/delete-plan?topic=Alpha&name=Legacy')
    assert.equal(plan.status, 200, `旧平铺论文的删除计划必须可用（不能被 404）：${plan.txt}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-C3 renameLegacyPaper：目标名已是目录 ⇒ 409 且平铺文件不被改名（基线 200 后不可见）', async () => {
  const { root, data } = newLib('dpr-r1-c3-')
  const s = await boot(data)
  try {
    putFlat(data, 'Alpha', 'oldone', '.pdf')
    putFlat(data, 'Alpha', 'oldone', '.txt')
    putPaper(data, 'Alpha/targetdir', 'Inner')
    const before = snap(data)
    const r = await s.post('/api/library/rename-paper', { topic: 'Alpha', name: 'oldone', to: 'targetdir' })
    assert.equal(r.status, 409, `目标已存在目录 Alpha/targetdir，平铺改名必须 409：${r.txt}`)
    assert.equal(r.body.code, 'target-exists', `机器码必须是 target-exists：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
    assert.equal(existsSync(join(data, 'Alpha', 'targetdir.pdf')), false, '绝不许只把平铺 oldone.pdf 改成 targetdir.pdf（会被目录遮蔽）')
    assert.deepEqual((await paperKeys(s.get)), ['Alpha/oldone', 'Alpha/targetdir/Inner'], '旧平铺论文与新子专题都必须仍可见')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-C4 renamePaper：目标目录内同名残留文件 ⇒ 409、内容不被覆盖、零改动（基线 200 静默覆盖）', async () => {
  const { root, data } = newLib('dpr-r1-c4-')
  const s = await boot(data)
  try {
    const dir = putPaper(data, 'Alpha', 'OldName')
    writeFileSync(join(dir, 'NewName.txt'), 'LEFTOVER-MUST-SURVIVE')
    const before = snap(data)
    const r = await s.post('/api/library/rename-paper', { topic: 'Alpha', name: 'OldName', to: 'NewName' })
    assert.equal(r.status, 409, `目标目录内已有 NewName.txt，必须 409 而不是静默覆盖：${r.txt}`)
    assert.equal(r.body.code, 'target-exists', r.txt)
    assert.deepEqual(snap(data), before, '被拒的改名必须零改动（目录名与所有文件都原样）')
    assert.equal(readFileSync(join(dir, 'NewName.txt'), 'utf8'), 'LEFTOVER-MUST-SURVIVE', '残留文件内容绝不许被覆盖')
    assert.equal(existsSync(join(data, 'Alpha', 'NewName')), false, '不得先把目录改名再失败')
    assert.equal(existsSync(join(data, '.trash')), false, '失败路径不得留下回收站记录')

    // 对照：清掉残留后同一改名必须成功（防止「一律拒绝」的假修复）
    rmSync(join(dir, 'NewName.txt'))
    const ok = await s.post('/api/library/rename-paper', { topic: 'Alpha', name: 'OldName', to: 'NewName' })
    assert.equal(ok.status, 200, `无冲突时必须成功：${ok.txt}`)
    assert.equal(existsSync(join(data, 'Alpha', 'NewName', 'NewName.pdf')), true)
    assert.equal(existsSync(join(data, 'Alpha', 'NewName', 'NewName.txt')), true)
    assert.equal(existsSync(join(data, 'Alpha', 'OldName')), false)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// F. boundaryOnly 长度回归（legacy 怪名字必须保持可删 / 可改名；创建侧上限不变）
// ═════════════════════════════════════════════════════════════════════════════

test('R1-F1 110 字 legacy 专题：delete 200 且真的删掉；创建侧仍 400；向该名字新建仍 4xx', async () => {
  const { root, data } = newLib('dpr-r1-f1-')
  const s = await boot(data)
  try {
    const long = 'L'.repeat(110)
    mkdirSync(join(data, long), { recursive: true })   // 空专题（非空专题按既有契约 409 topic-not-empty，本用例只测长度回归）

    const created = await s.post('/api/library/topic', { name: long })
    assert.equal(created.status, 400, `创建侧必须仍按 100 字上限拒绝（不得为修 F 放宽创建）：${created.txt}`)
    assert.equal(created.body.code, 'bad-name')
    const upNew = await s.upload(long, 'X.pdf')
    assert.ok(upNew.status >= 400 && upNew.status < 500, `上传到 110 字新专题名必须 4xx：${upNew.txt}`)

    const del = await s.post('/api/library/delete-topic', { name: long })
    assert.equal(del.status, 200, `110 字 legacy 专题必须能删（boundaryOnly 不卡新长度上限）：${del.txt}`)
    assert.equal(existsSync(join(data, long)), false, '专题目录必须真的被删掉')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-F2 110 字 legacy 专题可作为 rename-from ⇒ 200（基线 400：改不了名）', async () => {
  const { root, data } = newLib('dpr-r1-f2-')
  const s = await boot(data)
  try {
    const long = 'R'.repeat(110)
    mkdirSync(join(data, long), { recursive: true })
    const r = await s.post('/api/library/rename-topic', { name: long, to: 'short-after-review' })
    assert.equal(r.status, 200, `110 字 legacy 专题必须能改名（rename-from 走边界类）：${r.txt}`)
    assert.equal(existsSync(join(data, 'short-after-review')), true, '目标目录必须出现')
    assert.equal(existsSync(join(data, long)), false, '旧目录必须消失')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-F3 221 字（两段各 110）legacy 路径可删；同名创建仍 400（基线 400 删不掉）', async () => {
  const { root, data } = newLib('dpr-r1-f3-')
  const s = await boot(data)
  try {
    const a = 'A'.repeat(110)
    const b = 'B'.repeat(110)
    mkdirSync(join(data, a, b), { recursive: true })
    const created = await s.post('/api/library/topic', { name: `${a}/${b}` })
    assert.equal(created.status, 400, `创建侧必须仍拒绝 >200 的路径：${created.txt}`)
    const del = await s.post('/api/library/delete-topic', { name: `${a}/${b}` })
    assert.equal(del.status, 200, `boundaryOnly 下已存在的超长 legacy 路径必须可删：${del.txt}`)
    assert.equal(existsSync(join(data, a, b)), false, '目标目录必须真的被删掉')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R1-F4 boundaryOnly 绝不放宽安全边界：`..` / 编码变形 / `.trash` 保留名一律 400', async () => {
  const { root, data } = newLib('dpr-r1-f4-')
  const s = await boot(data)
  try {
    mkdirSync(join(data, 'Alpha', 'Sub'), { recursive: true })
    const cases = [
      { name: 'Alpha/../Alpha/Sub', why: '含 `..` 段' },
      { name: '../outside', why: '上跳' },
      { name: 'Alpha/%2e%2e%2foutside', why: '编码变形的上跳/分隔符' },
      { name: '.trash', why: '回收站保留名' },
    ]
    for (const c of cases) {
      const del = await s.post('/api/library/delete-topic', { name: c.name })
      assert.equal(del.status, 400, `delete-topic(${c.why}) 必须 400：${del.txt}`)
      const ren = await s.post('/api/library/rename-topic', { name: c.name, to: 'whatever' })
      assert.equal(ren.status, 400, `rename-topic(${c.why}) 必须 400：${ren.txt}`)
    }
    assert.ok(existsSync(join(data, 'Alpha', 'Sub')), '被拒操作不得删/动 Alpha/Sub')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// 对抗面：路径穿越 / 符号链接（基线可能把文件写穿到库外）
// ═════════════════════════════════════════════════════════════════════════════

test('R1-S1 上传目标的符号链接专题 / 符号链接论文目录 / `..` 与编码变形一律拒绝，库外零写入', async () => {
  const { root, data } = newLib('dpr-r1-s1-')
  const outside = mkdtempSync(join(tmpdir(), 'dpr-r1-outside-'))
  const s = await boot(data)
  try {
    mkdirSync(join(data, 'Alpha'), { recursive: true })
    // ① 专题本身是符号链接 → 库外
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outside, join(data, 'LinkedTopic'), 'dir')
    const viaTopic = await s.upload('LinkedTopic', 'Escaped.pdf')
    assert.ok(viaTopic.status >= 400, `符号链接专题必须被拒（不得写出库外）：${viaTopic.txt}`)
    assert.equal(existsSync(join(outside, 'Escaped', 'Escaped.pdf')), false, '库外绝不许出现上传文件')

    // ② 目标论文目录已存在且是符号链接 → 库外
    symlinkSync(outside, join(data, 'Alpha', 'SymLink'), 'dir')
    const viaPaper = await s.upload('Alpha', 'SymLink.pdf')
    assert.ok(viaPaper.status >= 400, `目标论文路径是符号链接时必须拒绝：${viaPaper.txt}`)
    assert.equal(existsSync(join(outside, 'SymLink.pdf')), false, '库外绝不许出现上传文件（不得写穿符号链接）')

    // ③ `..` / 绝对路径 / 编码变形
    const traversals = ['../escape', 'Alpha/../escape', 'Alpha/%2e%2e%2fescape', '/tmp/dpr-r1-absolute']
    for (const topic of traversals) {
      const r = await s.upload(topic, 'X.pdf')
      assert.ok(r.status >= 400 && r.status < 500, `topic=${topic} 必须 4xx：${r.txt}`)
    }
    // ④ 上传名里的 `..` 变体不得逃出专题目录
    for (const name of ['..pdf', '...pdf', '..\\..\\evil.pdf']) {
      const r = await s.upload('Alpha', name)
      assert.ok(r.status >= 400, `name=${JSON.stringify(name)} 必须被拒：${r.txt}`)
    }
    assert.equal(existsSync(join(data, 'escape')), false, '`..` 逃逸绝不能建出 data/escape')
    assert.equal(existsSync(join(data, '..', 'escape')), false, '绝不能写到 dataDir 之外')
    const outEntries = readdirSync(outside)
    assert.deepEqual(outEntries, [], `库外目录必须保持空：${outEntries.join(', ')}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('R1-S2 论文名只用边界类校验：前导点/超长名上传后必须仍可按名删（创建/删除对称）', async () => {
  const { root, data } = newLib('dpr-r1-s2-')
  const s = await boot(data)
  try {
    mkdirSync(join(data, 'Alpha'), { recursive: true })
    // 前导点论文名：upload 允许（边界类），删除侧也必须能按同一名字删（否则成孤儿）
    const up = await s.upload('Alpha', '.hidden.pdf')
    assert.equal(up.status, 200, `前导点论文名按既有边界语义允许上传：${up.txt}`)
    const dirs = readdirSync(join(data, 'Alpha'))
    const madeDir = dirs.find((d) => d === '.hidden' || d === '.hidden.pdf')
    assert.ok(madeDir, `必须真的落盘（实际目录：${dirs.join(',')}）`)
    const del = await s.post('/api/library/delete-paper', { topic: 'Alpha', name: '.hidden' })
    assert.equal(del.status, 200, `上传能创建的名字必须能被删（不许孤儿）：${del.txt}`)
    assert.equal(existsSync(join(data, 'Alpha', '.hidden')), false)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// 基线模式自检（只为让「基线 8 红」的计数可解释）
if (BASELINE_MODE) {
  test('R1-0 基线模式自检', (t) => {
    t.diagnostic(`R1_REPO 模式：目标树 = ${TARGET}（行为断言红 = 基线确有该缺陷）`)
    assert.ok(true)
  })
}
