// test/library-pr1-completion.test.mjs — PR-1 补全回归（t3）：R2 upload 的 topic 穿越 + R1 错误通道脱敏 + R4/R5。
//
//   R2：POST /api/library/upload 的 x-dpr-topic 与其余 CRUD 同强度校验（validateEntryName + realpath 子路径）。
//   R1：fsError 与外层兜底对带 .code 的 errno 错误只回固定中文文案，业务错误（无 code）保持可读。
//   R4：整包 body=null → 400（不再 500）。
//   R5：F2 回归网补全——to 缺失/字段缺失/布尔值。
//
// 只 import dist/*.js（跑前 `npm run build`）；破坏性实验一律 mkdtemp 临时库，不碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-t3-home-')) // 隔离 agent preset 安装，不碰真实 home
const L = await import(dist('library.js'))
const { registerRoutes } = await import(dist('host.js'))

/** 临时工作区：parent/data（文献库，含专题 T 与文献 P）+ parent/outside（库外哨兵）。 */
function workspace() {
  const parent = mkdtempSync(join(tmpdir(), 'dpr-t3-'))
  const data = join(parent, 'data')
  const outside = join(parent, 'outside')
  mkdirSync(data, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'keep.txt'), 'KEEP-OUTSIDE')
  mkdirSync(join(outside, 'sub'), { recursive: true })
  writeFileSync(join(outside, 'sub', 'deep.txt'), 'KEEP-DEEP')
  mkdirSync(join(data, 'T'), { recursive: true })
  writeFileSync(join(data, 'T', 'P.pdf'), 'P-PDF')
  writeFileSync(join(data, 'T', 'P.txt'), 'P-TXT')
  return { parent, data, outside }
}

/** 递归快照：相对路径 → 内容 / [dir] / symlink 目标（用于证明库外逐字节不变）。 */
function snap(dir, base = dir, out = {}) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name)
    const rel = relative(base, p)
    if (e.isSymbolicLink()) out[rel] = 'symlink->' + readlinkSync(p)
    else if (e.isDirectory()) { out[rel] = '[dir]'; snap(p, base, out) }
    else out[rel] = readFileSync(p, 'utf8')
  }
  return out
}
function diff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? '∅'} → ${b[k] ?? '∅'}`)
}

/** 启动路由（验证者同款最小 ctx），返回 { srv, postJson, postRaw }。 */
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
  const call = async (p, body, headers) => {
    const r = await fetch(base + p, { method: 'POST', headers, body })
    const txt = await r.text()
    let json = null
    try { json = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body: json, txt }
  }
  const postJson = (p, obj) => call(p, JSON.stringify(obj), { 'content-type': 'application/json' })
  const postRaw = (p, body, headers) => call(p, body, headers)
  return { srv, postJson, postRaw }
}

// ═══════════════════════════════════════════════════════════════════════════
// R2：upload 的 x-dpr-topic 穿越
// ═══════════════════════════════════════════════════════════════════════════

test('R2：upload 的 x-dpr-topic 越界/符号链接全部 4xx，库外递归快照逐字节不变；合法上传仍 200', async () => {
  const w = workspace()
  const { srv, postRaw } = await boot(w)
  const pdf = Buffer.from('X'.repeat(200)) // ≥100 字节才不触发「文件内容为空」
  const outsideBefore = snap(w.outside)
  try {
    // 词法层：../ 绝对路径 a/../b（同 CRUD 一套 validateEntryName）
    for (const topic of ['../outside', '../../..', '/etc/passwd', 'a/../b', '.', '..', '.hidden', 'x'.repeat(121)]) {
      const r = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': topic, 'x-dpr-name': 'Injected.pdf' })
      assert.ok(r.status >= 400 && r.status < 500, `upload topic=${JSON.stringify(topic)} 应 4xx，实际 ${r.status} ${r.txt}`)
      assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0, `upload topic=${JSON.stringify(topic)} 文案可读`)
      assert.ok(!r.txt.includes(w.data), `upload topic=${JSON.stringify(topic)} 不得泄露 dataDir`)
    }
    // 空串 → 4xx（缺少头）
    const rEmpty = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': '', 'x-dpr-name': 'Injected.pdf' })
    assert.equal(rEmpty.status, 400, rEmpty.txt)
    // NUL（R3：经 URL 编码后由 decodeHdr 还原为 \u0000）→ 400 可读，不碰 fs
    const rNul = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': 'T%00x', 'x-dpr-name': 'Injected.pdf' })
    assert.equal(rNul.status, 400, rNul.txt)
    assert.match(rNul.body.error, /名字不能包含控制字符/)
    assert.ok(!rNul.txt.includes(w.data), 'upload NUL 不得泄露 dataDir')
    // realpath 层：data/evil → 库外 outside
    symlinkSync(w.outside, join(w.data, 'evil'))
    const rLink = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': 'evil', 'x-dpr-name': 'Injected.pdf' })
    assert.equal(rLink.status, 400, `符号链接 topic 应 400：${rLink.status} ${rLink.txt}`)
    assert.match(rLink.body.error, /路径越界/, '必须来自 realpath 层')
  } finally { srv.close() }
  // 库外一个字节都不能变（上述被拒的请求都不得到达文件系统）
  assert.deepEqual(diff(outsideBefore, snap(w.outside)), [], '库外内容递归快照必须逐字节不变')

  // 合法上传仍 200，写进目标专题（ASCII 与中文专题名各一）
  const { srv: srv2, postRaw: postRaw2 } = await boot(w)
  try {
    const ok1 = await postRaw2('/api/library/upload', pdf, { 'x-dpr-topic': 'T', 'x-dpr-name': 'Legit.pdf' })
    assert.equal(ok1.status, 200, ok1.txt)
    assert.equal(ok1.body.name, 'Legit')
    assert.equal(readFileSync(join(w.data, 'T', 'Legit.pdf'), 'utf8'), 'X'.repeat(200))

    const zhTopic = encodeURIComponent('默认专题')
    const ok2 = await postRaw2('/api/library/upload', pdf, { 'x-dpr-topic': zhTopic, 'x-dpr-name': encodeURIComponent('中文.pdf') })
    assert.equal(ok2.status, 200, ok2.txt)
    assert.equal(ok2.body.topic, '默认专题')
    assert.equal(ok2.body.name, '中文')
    assert.equal(readFileSync(join(w.data, '默认专题', '中文.pdf'), 'utf8'), 'X'.repeat(200))
  } finally { srv2.close() }
})

// ═══════════════════════════════════════════════════════════════════════════
// R1：错误通道脱敏（errno 只回固定中文文案；业务错误保持可读）
// ═══════════════════════════════════════════════════════════════════════════

test('R1：errno 错误（ENAMETOOLONG/EACCES）不回显绝对路径，业务错误保持可读', async () => {
  const w = workspace()
  const { srv, postJson } = await boot(w)
  const logs = []
  const orig = { error: console.error, warn: console.warn, log: console.log }
  console.error = (...a) => { logs.push(a.map(String).join(' ')); orig.error(...a) }
  console.warn = (...a) => { logs.push(a.map(String).join(' ')); orig.warn(...a) }
  console.log = (...a) => { logs.push(a.map(String).join(' ')) } // 静音留档，查日志泄露
  let lockedDir = null
  try {
    // ① ENAMETOOLONG：to 为 86 个中文（258 字节 > 255，字符数 86 ≤ 120）
    const r1 = await postJson('/api/library/rename-topic', { topic: 'T', to: '名'.repeat(86) })
    assert.equal(r1.status, 400, `ENAMETOOLONG 应 400：${r1.status} ${r1.txt}`)
    assert.equal(r1.body.error, '系统错误，请稍后重试', 'errno 错误只回固定中文文案')
    assert.ok(!r1.txt.includes(w.data), 'ENAMETOOLONG 不得泄露 dataDir')

    // ② EACCES：嵌套目录 chmod 0500 后 delete-topic
    mkdirSync(join(w.data, 'T2', 'locked'), { recursive: true })
    writeFileSync(join(w.data, 'T2', 'locked', 'f.txt'), 'F')
    lockedDir = join(w.data, 'T2', 'locked')
    chmodSync(lockedDir, 0o500)
    const r2 = await postJson('/api/library/delete-topic', { topic: 'T2' })
    assert.equal(r2.status, 400, `EACCES 应 400：${r2.status} ${r2.txt}`)
    assert.equal(r2.body.error, '系统错误，请稍后重试', 'errno 错误只回固定中文文案')
    assert.ok(!r2.txt.includes(w.data), 'EACCES 不得泄露 dataDir')

    // ③ 业务错误必须原样可读（非 errno、无 .code）
    const biz = [
      ['/api/library/delete-topic', { topic: 'NoSuch' }, /专题不存在/],
      ['/api/library/delete-paper', { topic: 'T', name: 'NoSuch' }, /文献库中找不到/],
      ['/api/library/rename-topic', { topic: 'T', to: 'a/../b' }, /名字不能包含/],
      ['/api/library/rename-paper', { topic: 'T', name: 'P', to: 'Q\u0000' }, /名字不能包含控制字符/],
    ]
    for (const [p, body, re] of biz) {
      const r = await postJson(p, body)
      assert.equal(r.status, 400, `${p} ${JSON.stringify(body)} 应 400：${r.status} ${r.txt}`)
      assert.match(r.body.error, re, `${p} 业务文案应可读：${r.body.error}`)
    }
  } finally {
    if (lockedDir) chmodSync(lockedDir, 0o700) // 恢复权限，便于清理
    console.error = orig.error; console.warn = orig.warn; console.log = orig.log
    srv.close()
  }
  const leak = logs.filter((l) => l.includes(w.data))
  assert.equal(leak.length, 0, `日志不得出现 dataDir 绝对路径：${leak.slice(0, 3)}`)
  rmSync(w.parent, { recursive: true, force: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// R4：整包 body=null → 400
// ═══════════════════════════════════════════════════════════════════════════

test('R4：整包 JSON null → 四条路由一律 400（不再 500）', async () => {
  const routes = ['delete-topic', 'rename-topic', 'delete-paper', 'rename-paper']
  for (const route of routes) {
    const w = workspace()
    const { srv, postRaw } = await boot(w)
    const r = await postRaw(`/api/library/${route}`, 'null', { 'content-type': 'application/json' })
    srv.close()
    assert.equal(r.status, 400, `${route} body=null 应 400：${r.status} ${r.txt}`)
    assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0, `${route} 文案可读`)
    assert.ok(!r.txt.includes(w.data), `${route} 不得泄露 dataDir`)
    // 不触碰文件系统
    assert.ok(existsSync(join(w.data, 'T', 'P.pdf')))
    assert.ok(existsSync(join(w.data, 'T', 'P.txt')))
    assert.equal(readFileSync(join(w.outside, 'keep.txt'), 'utf8'), 'KEEP-OUTSIDE')
    rmSync(w.parent, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// R5：F2 回归网补全——to 缺失/字段缺失/布尔值
// ═══════════════════════════════════════════════════════════════════════════

test('R5：F2 回归网补全——to 非字符串/缺失、字段缺失、布尔值一律 400', async () => {
  const cases = []
  // to 非字符串（含布尔）
  for (const v of [123, {}, [], null, true, false]) {
    cases.push(['rename-topic', { topic: 'T', to: v }])
    cases.push(['rename-paper', { topic: 'T', name: 'P', to: v }])
  }
  // to 缺失
  cases.push(['rename-topic', { topic: 'T' }])
  cases.push(['rename-paper', { topic: 'T', name: 'P' }])
  // 字段整体缺失
  cases.push(['delete-topic', {}])
  cases.push(['rename-topic', {}])
  cases.push(['delete-paper', {}])
  cases.push(['rename-paper', {}])
  // topic/name 布尔
  cases.push(['delete-topic', { topic: true }])
  cases.push(['rename-topic', { topic: false, to: 'X' }])
  cases.push(['delete-paper', { topic: true, name: 'P' }])
  cases.push(['delete-paper', { topic: 'T', name: false }])
  cases.push(['rename-paper', { topic: false, name: 'P', to: 'X' }])
  cases.push(['rename-paper', { topic: 'T', name: true, to: 'X' }])

  for (const [route, body] of cases) {
    const w = workspace()
    const { srv, postJson } = await boot(w)
    const r = await postJson(`/api/library/${route}`, body)
    srv.close()
    assert.equal(r.status, 400, `${route} ${JSON.stringify(body)} 应 400：${r.status} ${r.txt}`)
    assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0, `${route} 文案可读`)
    assert.ok(!r.txt.includes('is not a function'), `${route} 不得回显内部 TypeError`)
    assert.ok(!r.txt.includes(w.data), `${route} 不得泄露 dataDir`)
    // 不触碰文件系统
    assert.ok(existsSync(join(w.data, 'T', 'P.pdf')), `${route} ${JSON.stringify(body)} 不得动库内`)
    assert.ok(existsSync(join(w.data, 'T', 'P.txt')))
    assert.equal(readFileSync(join(w.outside, 'keep.txt'), 'utf8'), 'KEEP-OUTSIDE')
    rmSync(w.parent, { recursive: true, force: true })
  }
})
