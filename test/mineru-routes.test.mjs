// test/mineru-routes.test.mjs — MinerU HTTP 路由层的端到端测试。
//
// 不依赖 Cordis：用一个假的 ctx（webServer.register / connection / effect）抓到
// host.js 注册的 /paper-reader 前缀 handler，再用真实的 http server 承载它，
// 于是可以真的发 HTTP 请求打这些路由。
// 只 import dist/*.js（Node 22 无法直接跑 TS）。跑前先 `npm run build`。
//
// 覆盖：GET/POST/DELETE /api/mineru/config（掩码、0600、预检失败不落盘）、
//       POST /api/mineru/test 与 GET /api/mineru/health（恒 200）、
//       POST /api/transcribe（source/producer/backend，错误信息不泄露 key）、
//       以及真实本地 MinerU 的 live 用例（不可达时 skip，整体 exit 0）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

// $DSH_HOME 必须在 registerRoutes 之前指向临时目录：它会往 $DSH_HOME 写
// 自带 agent preset 与 mineru.json，绝不能碰用户真实 home。
const HOME = mkdtempSync(join(tmpdir(), 'dpr-routes-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(dist('host.js'))
const { mineruConfigPath, writeMineruConfig, MINERU_DEFAULTS } = await import(dist('mineru-config.js'))
const { testMineruLocal } = await import(dist('mineru-config.js'))

const DATA = mkdtempSync(join(tmpdir(), 'dpr-routes-data-'))

/** 零依赖 N 页 PDF（短行 + 足够字符数，正文 >1000 字符）。 */
function buildPdf(pages) {
  const objs = []
  const pn = []
  objs[0] = null
  objs[1] = null
  const cn = []
  for (let i = 0; i < pages.length; i++) {
    pn.push(objs.length + 1); objs.push(null)
    cn.push(objs.length + 1); objs.push(null)
  }
  const fn = objs.length + 1
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const set = (n, b) => { objs[n - 1] = b }
  set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  set(2, `<< /Type /Pages /Kids [${pn.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  for (let i = 0; i < pages.length; i++) {
    set(pn[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${cn[i]} 0 R /Resources << /Font << /F1 ${fn} 0 R >> >> >>`)
    let s = ''
    let y = 740
    for (const [size, text] of pages[i]) {
      s += `BT /F1 ${size} Tf 72 ${y} Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET\n`
      y -= size + 14
    }
    set(cn[i], `<< /Length ${s.length} >>\nstream\n${s}endstream`)
  }
  let out = '%PDF-1.4\n'
  const off = []
  for (let i = 0; i < objs.length; i++) { off.push(out.length); out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n` }
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of off) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
// 每行带字母上的唯一标记：pdfjs 路径的页眉页脚启发式会剔除「归一化后同形」的边缘行，
// 只靠编号区分的行会被整页误剔（见 test/mineru-offline.test.mjs 的同名注释）。
const lineTag = (i) => Array.from({ length: 4 + (i % 4) }, (_, k) => String.fromCharCode(97 + ((i * 7 + k) % 26))).join('')
const lines = (prefix, count) => Array.from({ length: count }, (_, i) => [12, `${prefix} sentence ${lineTag(i)} with enough extractable text to exceed the one thousand character threshold reliably.`])

// ── 用假 ctx 抓 handler，再挂到真实 http server 上 ────────────────────────
let spec = null
const ctx = {
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => undefined },
  sessionController: {},
  workspaceController: {},
  workspaceRegistry: {},
  effect: (fn) => fn(),
}
registerRoutes(ctx, { dataDir: DATA })
assert.equal(spec.path, '/paper-reader')
assert.equal(spec.kind, 'prefix')

const server = createServer((req, res) => spec.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${server.address().port}`
const api = async (path, opts) => {
  const r = await fetch(`${ORIGIN}/paper-reader${path}`, opts)
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON 原样返回 */ }
  return { status: r.status, body, text }
}
const postJson = (path, obj) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })

// 文章放进库：<dataDir>/demo/paper.pdf
mkdirSync(join(DATA, 'demo'), { recursive: true })
writeFileSync(join(DATA, 'demo', 'paper.pdf'), buildPdf([
  [[22, 'Routes Fixture One'], ...lines('Page one', 6), [12, 'Page one keyword locality here.']],
  [[20, 'Routes Fixture Two'], ...lines('Page two', 10), [12, 'Page two keyword zetamarker42 here.'], ...lines('Page two tail', 5)],
]))

const SENTINEL = 'mineru-SENTINEL-KEY-1234'

test('GET /api/mineru/config：默认 mode=off，形状齐全，无明文 key 字段', async () => {
  const r = await api('/api/mineru/config')
  assert.equal(r.status, 200)
  assert.equal(r.body.mode, 'off')
  assert.equal(r.body.source, 'none')
  assert.equal(r.body.local.baseUrl, MINERU_DEFAULTS.local.baseUrl)
  assert.equal(r.body.local.backend, 'pipeline')
  assert.equal(r.body.local.hasApiKey, false)
  assert.equal(r.body.local.apiKeyHint, '')
  assert.equal(r.body.cloud.hasApiKey, false)
  // 响应里不允许出现任何明文 key 字段名以外的东西
  assert.ok(!/apiKey"\s*:/.test(r.text), '响应不得含明文 apiKey 字段')
})

test('POST /api/mineru/config：mode=off 无需预检即落盘（0600）；GET 掩码回显；明文 key 不出现', async () => {
  const r = await postJson('/api/mineru/config', {
    mode: 'off',
    local: { baseUrl: 'http://127.0.0.1:8000', backend: 'pipeline', parseMethod: 'auto', apiKey: SENTINEL },
    cloud: { apiKey: SENTINEL },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const file = mineruConfigPath(HOME)
  assert.ok(existsSync(file), 'mineru.json 应落盘')
  assert.equal(statSync(file).mode & 0o777, 0o600, 'mineru.json 必须是 0600')

  const g = await api('/api/mineru/config')
  assert.equal(g.status, 200)
  assert.equal(g.body.source, 'file')
  assert.equal(g.body.local.hasApiKey, true)
  assert.equal(g.body.cloud.hasApiKey, true)
  assert.equal(g.body.local.apiKeyHint, 'min…1234')
  assert.ok(!g.text.includes(SENTINEL), 'GET 响应不得出现明文 key')
})

test('POST /api/mineru/config：mode=local 且地址不可达 → 400，且不覆盖已落盘配置', async () => {
  const before = (await api('/api/mineru/config')).body
  const r = await postJson('/api/mineru/config', { mode: 'local', local: { baseUrl: 'http://127.0.0.1:9' } })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /连接测试失败/)
  const after = (await api('/api/mineru/config')).body
  assert.equal(after.mode, before.mode, '预检失败不得改动已生效配置')
  assert.equal(after.local.baseUrl, before.local.baseUrl)
})

test('POST /api/mineru/config：非法 mode → 400', async () => {
  const r = await postJson('/api/mineru/config', { mode: 'v1' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /off\/local\/cloud/)
})

test('POST /api/mineru/test 与 GET /api/mineru/health：不可达时仍 HTTP 200 且 reachable=false', async () => {
  const t = await postJson('/api/mineru/test', { mode: 'local', local: { baseUrl: 'http://127.0.0.1:9' } })
  assert.equal(t.status, 200)
  assert.equal(t.body.reachable, false)
  assert.ok(typeof t.body.error === 'string' && t.body.error.length > 0)

  // health 走生效配置（当前 mode=off）
  const h = await api('/api/mineru/health')
  assert.equal(h.status, 200)
  assert.equal(h.body.mode, 'off')
  assert.equal(h.body.reachable, false)

  // 显式 ?mode=local 但地址不可达 → 200 + reachable=false（便于 UI 展示）
  const h2 = await api('/api/mineru/health?mode=local')
  assert.equal(h2.status, 200)
  assert.equal(h2.body.mode, 'local')
})

test('POST /api/transcribe：source=pdfjs 时以 JSON 报告 producer/backend（非 MinerU 为 null）', async () => {
  const r = await postJson('/api/transcribe', { topic: 'demo', name: 'paper', source: 'pdfjs' })
  assert.equal(r.status, 200)
  assert.equal(r.body.source, 'local')
  assert.equal(r.body.producer, 'pdfjs')
  assert.equal(r.body.backend, null)
  assert.ok(r.body.chars > 1000)
  assert.equal(r.body.pageCount, 2)
  assert.equal(r.body.hasPageIndex, true)

  // 再打一次：命中缓存
  const again = await postJson('/api/transcribe', { topic: 'demo', name: 'paper' })
  assert.equal(again.status, 200)
  assert.equal(again.body.source, 'cache')
})

test('POST /api/transcribe：MinerU 失败 → 错误信息可读且不含明文 key（配置里的 key 被回显的场景）', async () => {
  // 直接落盘一份死地址 + sentinel key 的配置（绕过预检，模拟部署方 YAML/手改文件）
  await writeMineruConfig({
    mode: 'local',
    local: { ...MINERU_DEFAULTS.local, baseUrl: 'http://127.0.0.1:9', apiKey: SENTINEL, requestTimeoutMs: 3000 },
    cloud: { ...MINERU_DEFAULTS.cloud, apiKey: SENTINEL },
  }, HOME)
  const r = await postJson('/api/transcribe', { topic: 'demo', name: 'paper', source: 'mineru-local', force: true })
  assert.equal(r.status, 500)
  const text = r.text
  assert.ok(!text.includes(SENTINEL), '错误响应不得泄露明文 key')
  assert.match(text, /MinerU/)
  // 失败后缓存仍在（可继续命中）
  const ok = await postJson('/api/transcribe', { topic: 'demo', name: 'paper' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.source, 'cache')
})

test('F1 端到端：mode=cloud 且 token 触发业务码 A0202 → 400 且配置文件字节级不变（sha256 对照）', async () => {
  // 先落一份合法配置当「原配置文件」
  const r0 = await postJson('/api/mineru/config', { mode: 'off' })
  assert.equal(r0.status, 200)
  const file = mineruConfigPath(HOME)
  const before = createHash('sha256').update(readFileSync(file)).digest('hex')

  // mock 云端：HTTP 200 + 业务码 A0202（坏 token 的典型返回形态）
  const cloud = await new Promise((resolve) => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'A0202', msg: 'token error' }))
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }))
  })
  try {
    const r = await postJson('/api/mineru/config', { mode: 'cloud', cloud: { baseUrl: cloud.url, apiKey: 'bad-token-1234' } })
    assert.equal(r.status, 400, '业务码 A0202 必须被预检拦住')
    assert.match(String(r.body.error), /token/)
  } finally {
    cloud.srv.close()
  }

  const after = createHash('sha256').update(readFileSync(file)).digest('hex')
  assert.equal(after, before, '预检失败不得改动已落盘配置（sha256 必须一致）')
  assert.ok(!readFileSync(file, 'utf8').includes('bad-token-1234'), '坏 token 不得落盘')
})

test('DELETE /api/mineru/config：清除自填配置并回落（文件删除）', async () => {
  const d = await api('/api/mineru/config', { method: 'DELETE' })
  assert.equal(d.status, 200)
  assert.equal(d.body.ok, true)
  assert.ok(!existsSync(mineruConfigPath(HOME)))
  const g = await api('/api/mineru/config')
  assert.equal(g.body.mode, MINERU_DEFAULTS.mode)
})

test('未知 /api/mineru/* 子路由 → 404', async () => {
  const r = await api('/api/mineru/nope')
  assert.equal(r.status, 404)
})

// ── live：真实本地 MinerU（不可达则 skip，整体仍 exit 0）──────────────────

const BASE = 'http://127.0.0.1:8000'
const live = (await testMineruLocal(BASE, 2000)).ok ? false : 'local MinerU not reachable at 127.0.0.1:8000'

test('live: POST /api/mineru/config(mode=local) 预检通过并落盘；health 报出服务版本', { skip: live }, async () => {
  const r = await postJson('/api/mineru/config', { mode: 'local', local: { baseUrl: BASE, backend: 'pipeline' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const h = await api('/api/mineru/health')
  assert.equal(h.status, 200)
  assert.equal(h.body.reachable, true)
  assert.equal(h.body.mode, 'local')
  assert.equal(typeof h.body.version, 'string')
  assert.ok(h.body.version.length > 0)
})

test('live: POST /api/transcribe(source=mineru-local) 落盘 MinerU 缓存并报告 backend', { skip: live }, async () => {
  const r = await postJson('/api/transcribe', { topic: 'demo', name: 'paper', source: 'mineru-local', force: true })
  assert.equal(r.status, 200)
  assert.equal(r.body.source, 'mineru-local')
  assert.equal(r.body.producer, 'mineru-local')
  assert.equal(r.body.backend, 'pipeline')
  assert.ok(r.body.chars > 1000)
  // MinerU 富产物也落盘
  for (const suffix of ['.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json']) {
    assert.ok(existsSync(join(DATA, 'demo', 'paper' + suffix)), `${suffix} 应落盘`)
  }
})

test.after(() => {
  server.close()
  rmSync(HOME, { recursive: true, force: true })
  rmSync(DATA, { recursive: true, force: true })
})
