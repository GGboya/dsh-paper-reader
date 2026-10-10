// test/reader-ux-t8.test.mjs — t8 修复的验收用例（t7 收口评审的 3 条 low）。
//
// 覆盖：
//   U1 R7-F1 删除成功响应的 sessions 不再带 unknown 键（走 toWire，对外 {total,running}）
//   U2 R7-F2 未知内部错误兜底：真的落一条脱敏日志（无绝对路径、无凭据）
//   U3 R7-F3 附带 errText 为 busy / session-unknown 提供 zh/en 文案（非裸机器码）
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。
// 破坏性用例一律在**临时库**里做（绝不动 ~/.dsh-paper-reader/data）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
const HOME = mkdtempSync(join(tmpdir(), 'dpr-t8-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(dist('host.js'))

/* ── host 路由挂到真实 http server ───────────────────────────────────────── */
let spec = null
const makeCtx = (over = {}) => ({
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => undefined },
  sessionController: { list: async () => ({ items: [] }) },
  workspaceController: { create: async () => ({ workspace: { workspaceId: 'w' } }) },
  workspaceRegistry: {},
  effect: (fn) => fn(),
  ...over,
})
async function boot(over = {}) {
  registerRoutes(makeCtx(over), { dataDir: DATA })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const api = async (p, opts) => {
    const r = await fetch(base + p, opts)
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, body, text }
  }
  const postJson = (p, obj) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
  return { srv, api, postJson }
}

const DATA = mkdtempSync(join(tmpdir(), 'dpr-t8-data-'))

function scaffold(topic, name) {
  const dir = join(DATA, topic)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), '%PDF-1.4\n')
  writeFileSync(join(dir, `${name}.txt`), 'cache')
  return dir
}

/* ── U1 R7-F1：删除成功响应 sessions 走 toWire，不带 unknown 键 ─────────── */
test('U1 删除成功响应的 sessions 形状固定为 {total,running}（不带 unknown 键）', async () => {
  const topic = 'u1'
  scaffold(topic, 'P')
  const s = await boot()
  try {
    const r = await s.postJson('/api/library/paper/delete', { topic, name: 'P' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(Object.keys(r.body.sessions).sort(), ['running', 'total'], `sessions 键集合应为 {total,running}：${JSON.stringify(r.body.sessions)}`)
    assert.equal(r.body.sessions.total, 0)
    assert.equal(r.body.sessions.running, 0)
  } finally { s.srv.close() }
})

/* ── U2 R7-F2：兜底错误真的落日志，且日志脱敏（无绝对路径、无凭据） ────── */
test('U2 未知内部错误：真的落一条脱敏日志（无绝对路径、无 Bearer/sk-* 凭据）', async () => {
  const topic = 'u2'
  scaffold(topic, 'P')
  // 注入一个错误：message 同时含绝对路径（DATA）与两种凭据形态（sk-* 与 Bearer）
  const token = 'sk-secret-1234567890'
  const bearer = 'abcdef1234'
  const s = await boot({
    sessionController: {
      list: async () => ({ items: [] }),
      create: async () => ({}),
      prompt: async () => { throw new Error(`ENOENT: open ${join(DATA, topic, 'secret.key')}, token=${token}, Authorization: Bearer ${bearer}`) },
    },
  })
  const logs = []
  const origErr = console.error
  console.error = (...a) => { logs.push(a.map(String).join(' ')) }
  try {
    const r = await s.postJson('/api/ask', { topic, name: 'P', question: 'hi' })
    assert.equal(r.status, 500, r.text)
    assert.equal(r.body.code, 'internal')
  } finally {
    console.error = origErr
    s.srv.close()
  }
  const joined = logs.join('\n')
  assert.ok(logs.length > 0, '错误路径必须真的落一条日志')
  assert.match(joined, /\[dsh-paper-reader\] route error/, '日志应带插件前缀（证明是兜底分支写的）')
  assert.ok(!joined.includes(DATA), `日志不得泄露绝对路径：${joined}`)
  assert.ok(!joined.includes(token), `日志不得泄露 sk-* 凭据：${joined}`)
  assert.ok(!joined.includes(bearer), `日志不得泄露 Bearer 凭据：${joined}`)
})

/* ── U3 R7-F3 附带：errText 为 busy / session-unknown 提供 zh/en 文案 ───── */
function dictValue(src, name, key) {
  const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n    \\}`).exec(src)
  assert.ok(m, `未找到 ${name} 字典`)
  const km = new RegExp(`${key}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`).exec(m[1])
  return km ? km[1] : undefined
}

test('U3 errText 为 busy / session-unknown 提供 zh/en 人类可读文案（非裸机器码）', () => {
  const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  // errText 的 switch 里两个新分支（走 t()，不落默认 err.message 兜底）
  assert.match(client, /case 'busy':\s*return t\('delBusy'\)/, 'errText 必须有 busy 分支')
  assert.match(client, /case 'session-unknown':\s*return t\('delSessionUnknown'\)/, 'errText 必须有 session-unknown 分支')
  for (const key of ['delBusy', 'delSessionUnknown']) {
    const zh = dictValue(client, 'zh', key)
    const en = dictValue(client, 'en', key)
    assert.ok(zh && zh.length > 0, `${key} 的 zh 文案缺失`)
    assert.ok(en && en.length > 0, `${key} 的 en 文案缺失`)
    // 人类可读：不得是裸机器码本身
    assert.notEqual(zh, 'busy')
    assert.notEqual(zh, 'session-unknown')
    assert.notEqual(en, 'busy')
    assert.notEqual(en, 'session-unknown')
    // zh 含中文、en 含拉丁字母（证明各自是真文案而非回显 code）
    assert.match(zh, /[\u4e00-\u9fff]/, `${key} 的 zh 文案应含中文：${zh}`)
    assert.match(en, /[A-Za-z]/, `${key} 的 en 文案应含拉丁字母：${en}`)
  }
})
