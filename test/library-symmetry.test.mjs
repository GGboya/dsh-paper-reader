// test/library-symmetry.test.mjs — PR-1 最后一轮回归（t5）：R7 创建/删除对称（校验分层）+ R8 + R11。
//
//   R7：upload 能创建的文献，delete 必须能删除（前导点/超长/非 NUL 控制字符/空格/连字符/中文）。
//       修法 = 校验分层：边界类（空/分隔符/../NUL）创建与删除都强制；命名规范类（长度/前导点）
//       只在创建/改名强制。绝不能用「收紧 upload」达成对称（那会让 >120 字符的真实标题无法上传）。
//   R8：畸形 JSON 请求体 → 400（与 R4 整包 null 同类）。
//   R11：workspace 注册失败的 console.warn 与 readableError 同口径脱敏，日志不含 dataDir。
//
// 只 import dist/*.js（跑前 `npm run build`）；破坏性实验一律 mkdtemp 临时库，不碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-t5-home-'))
const L = await import(dist('library.js'))
const { registerRoutes } = await import(dist('host.js'))

/** 临时工作区：parent/data（文献库，含专题 T 与文献 P）。 */
function workspace() {
  const parent = mkdtempSync(join(tmpdir(), 'dpr-t5-'))
  const data = join(parent, 'data')
  mkdirSync(data, { recursive: true })
  mkdirSync(join(data, 'T'), { recursive: true })
  writeFileSync(join(data, 'T', 'P.pdf'), 'P-PDF')
  writeFileSync(join(data, 'T', 'P.txt'), 'P-TXT')
  return { parent, data }
}

/** 启动路由（验证者同款最小 ctx）。 */
async function boot(w) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: w.data })
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
  const postRaw = async (p, body, headers) => {
    const r = await fetch(base + p, { method: 'POST', headers, body })
    const txt = await r.text()
    let json = null
    try { json = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body: json, txt }
  }
  return { srv, postJson, postRaw }
}

// ═══════════════════════════════════════════════════════════════════════════
// R7：创建与删除对称（分层）
// ═══════════════════════════════════════════════════════════════════════════

test('R7：upload 能创建的边界名字（控制字符/前导点/超长/空格连字符/中文）逐个删除必须成功', async () => {
  const w = workspace()
  const { srv, postRaw, postJson } = await boot(w)
  const pdf = Buffer.from('X'.repeat(200))
  const names = [
    'a\u0001b.pdf',          // 非 NUL 控制字符
    '.hidden.pdf',           // 前导点
    'x'.repeat(200) + '.pdf',// 200 字符超长（命名规范类）
    'My Paper-2.0_final.pdf',// 空格/连字符/下划线/点
    '中文论文.pdf',           // 中文
  ]
  try {
    // 上传全部成功（upload 只做边界类校验，不做命名规范类）
    for (const n of names) {
      const r = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': 'T', 'x-dpr-name': encodeURIComponent(n) })
      assert.equal(r.status, 200, `upload ${JSON.stringify(n.slice(0, 20))} 应 200：${r.status} ${r.txt}`)
      assert.ok(existsSync(join(w.data, 'T', n)), `upload 后 ${n.slice(0, 20)} 应落盘`)
    }
    // 逐个删除必须成功（delete 只做边界类校验）
    for (const n of names) {
      const stem = n.slice(0, -4)
      const r = await postJson('/api/library/delete-paper', { topic: 'T', name: stem })
      assert.equal(r.status, 200, `delete ${JSON.stringify(stem.slice(0, 20))} 应 200：${r.status} ${r.txt}`)
      assert.ok(!existsSync(join(w.data, 'T', n)), `delete 后 ${n.slice(0, 20)} 应消失`)
    }
  } finally { srv.close() }
})

test('R7 分层证据：命名规范只在创建/改名强制，边界在创建与删除都强制', async () => {
  const w = workspace()
  const { srv, postRaw, postJson } = await boot(w)
  const pdf = Buffer.from('X'.repeat(200))
  try {
    // ① 命名规范类（长度/前导点）不挡 upload：200 字符与前导点都能上传
    const long = 'x'.repeat(200) + '.pdf'
    const upLong = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': 'T', 'x-dpr-name': long })
    assert.equal(upLong.status, 200, `200 字符标题应可上传：${upLong.status} ${upLong.txt}`)
    // ② 改名（起新名字）仍强制命名规范：to 121 字符 → 400
    const rTooLong = await postJson('/api/library/rename-paper', { topic: 'T', name: 'P', to: 'y'.repeat(121) })
    assert.equal(rTooLong.status, 400, `rename 到 121 字符应 400：${rTooLong.status} ${rTooLong.txt}`)
    assert.match(rTooLong.body.error, /名字过长/, '改名侧仍保留长度上限文案')
    // ③ 边界类（../NUL）在创建（upload 文件名）也强制：拒绝，不落盘
    for (const n of ['x..y.pdf', 'a\u0000b.pdf']) {
      const r = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': 'T', 'x-dpr-name': encodeURIComponent(n) })
      assert.equal(r.status, 400, `upload 文件名 ${JSON.stringify(n)} 应 400：${r.status} ${r.txt}`)
    }
    // ④ 边界类（../NUL）在删除也强制：直接落盘一个含 .. 的文件，delete 必须拒绝（不误删）
    writeFileSync(join(w.data, 'T', 'x..y.pdf'), 'EVIL')
    const rDel = await postJson('/api/library/delete-paper', { topic: 'T', name: 'x..y' })
    assert.equal(rDel.status, 400, `delete 含 .. 的名字应 400：${rDel.status} ${rDel.txt}`)
    assert.ok(existsSync(join(w.data, 'T', 'x..y.pdf')), '含 .. 的名字不得被删（边界类仍在删除侧强制）')
  } finally { srv.close() }
})

test('R7 primitive 层：deletePaper 直接删除前导点/超长/控制字符名（不依赖路由）', () => {
  const w = workspace()
  const dir = join(w.data, 'T')
  const names = ['a\u0001b', '.hidden', 'z'.repeat(200), 'My Paper-2.0_final', '中文文献']
  for (const n of names) writeFileSync(join(dir, n + '.pdf'), n)
  for (const n of names) {
    const deleted = L.deletePaper(w.data, 'T', n)
    assert.ok(deleted.includes(n + '.pdf'), `deletePaper(${JSON.stringify(n.slice(0, 20))}) 应删除本体`)
    assert.ok(!existsSync(join(dir, n + '.pdf')), `${n.slice(0, 20)} 应消失`)
  }
  // 边界类仍拒：NUL 与 .. 在 primitive 删除侧仍拒绝
  assert.throws(() => L.deletePaper(w.data, 'T', 'a\u0000b'), /名字不能包含控制字符/)
  assert.throws(() => L.deletePaper(w.data, 'T', 'x..y'), /名字不能包含 \/ \\ 或 \.\./)
})

// ═══════════════════════════════════════════════════════════════════════════
// R8：畸形 JSON 请求体 → 400
// ═══════════════════════════════════════════════════════════════════════════

test('R8：畸形 JSON 请求体 → 400（不再 500）', async () => {
  const w = workspace()
  const { srv, postRaw } = await boot(w)
  try {
    for (const route of ['delete-topic', 'rename-topic', 'delete-paper', 'rename-paper']) {
      const r = await postRaw(`/api/library/${route}`, '{bad json', { 'content-type': 'application/json' })
      assert.equal(r.status, 400, `${route} 畸形 JSON 应 400：${r.status} ${r.txt}`)
      assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0, `${route} 文案可读`)
      assert.ok(!r.txt.includes(w.data), `${route} 不得泄露 dataDir`)
    }
  } finally { srv.close() }
})

// ═══════════════════════════════════════════════════════════════════════════
// R11：workspace 注册失败日志与响应体同口径脱敏
// ═══════════════════════════════════════════════════════════════════════════

test('R11：workspace 注册失败日志不含 dataDir 绝对路径（与 readableError 同口径）', async () => {
  const w = workspace()
  const logs = []
  const origWarn = console.warn
  console.warn = (...a) => { logs.push(a.map(String).join(' ')) } // 捕获不转发，保持输出干净
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }), create: async () => ({}) },
    // create 抛一个带 code 的 errno 错误，其 message 里嵌入了 dataDir——模拟真实 workspace 注册失败
    workspaceController: { create: async () => { const e = new Error(`EACCES: permission denied, mkdir '${w.data}/T'`); e.code = 'EACCES'; throw e } },
    workspaceRegistry: { archivedSessionIds: [] },
    effect: (fn) => fn(),
  }, { dataDir: w.data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
    // sessions/new → createPaperSession → ensureTopicWorkspace → workspaceController.create 抛 EACCES → console.warn
    const r = await fetch(base + '/api/sessions/new', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'T', name: 'P' }),
    })
    const txt = await r.text()
    assert.ok(r.status < 500, `sessions/new 应回退成功（非 500）：${r.status} ${txt}`)
  } finally {
    console.warn = origWarn
    srv.close()
  }
  assert.ok(logs.length > 0, '应确实触发了 console.warn（否则本用例空转）')
  const leak = logs.filter((l) => l.includes(w.data))
  assert.equal(leak.length, 0, `workspace 注册失败日志不得含 dataDir 绝对路径：${leak.slice(0, 3)}`)
})
