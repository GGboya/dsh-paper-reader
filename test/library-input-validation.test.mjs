// test/library-input-validation.test.mjs — PR-1 收口回归（F1 错误信息泄露绝对路径 / F2 非字符串入参 500）。
//
// F1：NUL/控制字符进入 to/topic/name 时，之前 400 但响应体把 Node 原始错误（ERR_INVALID_ARG_VALUE）
//      连同 dataDir 绝对路径一起回显。修复 = validateEntryName 词法层拒绝控制字符，400 可读文案，
//      请求到不了文件系统。本用例同时断言响应体与拦截到的日志都不含 dataDir 绝对路径。
// F2：topic/name 传非字符串（123/{}／[]/null）之前落到 500（body.topic?.trim is not a function）。
//      修复 = 四条 CRUD 路由的前置校验做 typeof 检查，与 to 的 badEntry 行为一致。
//
// 只 import dist/*.js（跑前 `npm run build`）；破坏性实验一律在 mkdtemp 临时库，不碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-t1-home-')) // 隔离 agent preset 安装，不碰真实 home
const { registerRoutes } = await import(dist('host.js'))

/** 临时工作区：parent/data（文献库，含专题 T 与文献 P）+ parent/sentinel（库外哨兵）。 */
function workspace() {
  const parent = mkdtempSync(join(tmpdir(), 'dpr-t1-'))
  const data = join(parent, 'data')
  const sentinel = join(parent, 'sentinel')
  mkdirSync(data, { recursive: true })
  mkdirSync(sentinel, { recursive: true })
  writeFileSync(join(sentinel, 'keep.txt'), 'KEEP')
  mkdirSync(join(data, 'T'), { recursive: true })
  writeFileSync(join(data, 'T', 'P.pdf'), 'P-PDF')
  writeFileSync(join(data, 'T', 'P.txt'), 'P-TXT')
  return { parent, data, sentinel }
}

/** 启动路由（复用验证者同款最小 ctx），返回 { srv, post }。 */
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
  const post = async (p, b) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt }
  }
  return { srv, post }
}

test('F1：NUL/控制字符进入 to/topic/name 一律 400 可读文案，响应体与日志都不含 dataDir 绝对路径', async () => {
  const w = workspace()
  const { srv, post } = await boot(w)
  const logs = []
  const orig = { error: console.error, warn: console.warn, log: console.log }
  console.error = (...a) => { logs.push(a.map(String).join(' ')); orig.error(...a) }
  console.warn = (...a) => { logs.push(a.map(String).join(' ')); orig.warn(...a) }
  console.log = (...a) => { logs.push(a.map(String).join(' ')) } // 静音但留档，用来查日志泄露
  try {
    const cases = [
      ['rename-paper', { topic: 'T', name: 'P', to: 'Q\u0000' }],
      ['rename-topic', { topic: 'T', to: 'Q\u0000' }],
      ['rename-paper', { topic: 'T', name: 'P', to: 'Q\u0001' }],
      ['rename-topic', { topic: 'T', to: 'Q\u007f' }],
      ['delete-paper', { topic: 'T', name: 'P\u0000' }],
      ['delete-topic', { topic: 'T\u0000' }],
    ]
    for (const [route, body] of cases) {
      const r = await post(`/api/library/${route}`, body)
      assert.equal(r.status, 400, `${route} ${JSON.stringify(body)} 应 400，实际 ${r.status} ${r.txt}`)
      assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0, `${route} 错误文案必须可读`)
      assert.ok(!r.txt.includes(w.data), `${route} 响应体不得泄露 dataDir 绝对路径：${r.txt}`)
    }
    const leak = logs.filter((l) => l.includes(w.data))
    assert.equal(leak.length, 0, `日志不得出现 dataDir 绝对路径：${leak.slice(0, 3)}`)
  } finally {
    console.error = orig.error; console.warn = orig.warn; console.log = orig.log
    srv.close()
  }
  // 被拒后库外/库内逐字节不变（请求没碰到文件系统）
  assert.equal(readFileSync(join(w.sentinel, 'keep.txt'), 'utf8'), 'KEEP')
  assert.ok(existsSync(join(w.data, 'T')), '专题 T 不得被改名/删除')
  assert.equal(readFileSync(join(w.data, 'T', 'P.pdf'), 'utf8'), 'P-PDF')
  assert.equal(readFileSync(join(w.data, 'T', 'P.txt'), 'utf8'), 'P-TXT')
})

test('F2：四条路由 × 4 种非字符串入参一律 400 可读文案（非 500），不触碰文件系统', async () => {
  const nonStrings = [123, {}, [], null]
  // 每条路由把「会触发旧 bug」的字段分别替换成非字符串，其余字段保持合法。
  const validBody = {
    'delete-topic': { topic: 'T' },
    'rename-topic': { topic: 'T', to: 'T2' },
    'delete-paper': { topic: 'T', name: 'P' },
    'rename-paper': { topic: 'T', name: 'P', to: 'P2' },
  }
  const routes = [
    ['delete-topic', ['topic']],
    ['rename-topic', ['topic']],
    ['delete-paper', ['topic', 'name']],
    ['rename-paper', ['topic', 'name']],
  ]
  let count = 0
  for (const [route, fields] of routes) {
    for (const field of fields) {
      for (const v of nonStrings) {
        const w = workspace()
        const { srv, post } = await boot(w)
        const body = { ...validBody[route], [field]: v }
        const r = await post(`/api/library/${route}`, body)
        srv.close()
        count++
        assert.equal(r.status, 400, `${route} ${JSON.stringify(body)} 应 400，实际 ${r.status} ${r.txt}`)
        assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0, `${route} 错误文案必须可读（不是内部错误）`)
        assert.ok(!r.txt.includes('is not a function'), `${route} 不得回显内部 TypeError：${r.txt}`)
        assert.ok(!r.txt.includes(w.data), `${route} 不得泄露 dataDir：${r.txt}`)
        // 不触碰文件系统：库外哨兵与库内文献都原样
        assert.equal(readFileSync(join(w.sentinel, 'keep.txt'), 'utf8'), 'KEEP', `${route} ${JSON.stringify(body)} 不得碰库外`)
        assert.ok(existsSync(join(w.data, 'T')), `${route} ${JSON.stringify(body)} 不得改/删专题`)
        assert.equal(readFileSync(join(w.data, 'T', 'P.pdf'), 'utf8'), 'P-PDF')
        assert.equal(readFileSync(join(w.data, 'T', 'P.txt'), 'utf8'), 'P-TXT')
      }
    }
  }
  assert.equal(count, 24, '应覆盖 4 路由（topic 路由各 4、paper 路由 topic/name 各 4）= 24 次')
})
