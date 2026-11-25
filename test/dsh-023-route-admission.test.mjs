// test/dsh-023-route-admission.test.mjs —— dsh 0.2.3 路由准入迁移的回归护栏。
//
// 背景（issue：升级 dsh 0.2.3-alpha.2 后「上传失败: HTTP 400」）：
//   dsh 0.2.3-alpha.2 删除了 `connection.requestRejection`（官方 upgrade-guide
//   「Token Provider 与路由准入迁移」：改用 `admit`，准入前移到 webServer 的 `auth`
//   策略，默认 `required`）。插件原先在 handler 第一行直接调用它，于是抛 TypeError，
//   而 `dsh-host-webserver` 会把 handler 抛出的异常兜底成 **空 body 的 400**
//   （`res.writeHead(400); res.end()`），前端 `r.json()` 解析失败 → 只剩「HTTP 400」。
//
// 这里同时钉住三件事：
//   1) 0.2.3 形态（无 requestRejection + 有准入 Peer）照常放行；
//   2) 0.2.3 形态拿不到 Peer 时 fail-closed 成 503（可读原因），且 **handler 绝不抛**；
//   3) 0.2.2 形态（有 requestRejection）401/403 语义不变。
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = (m) => join(ROOT, 'dist', m)
const HOME = mkdtempSync(join(tmpdir(), 'dpr-adm-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

/** 足以通过 `buf.length < 100` 的下限判定的最小 PDF 载荷。 */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'latin1',
)

/**
 * 起一个「按宿主语义」的小服务器：
 *  - 第三个参数是准入 Peer（0.2.3 的 handler 签名）；
 *  - handler 抛异常时**复刻** dsh-host-webserver 的兜底：`writeHead(400); res.end()`
 *    （空 body），并把异常记下来，供断言「没有走兜底」。
 */
async function serve({ connection, withPeer, dataDir }) {
  let spec = null
  const ctx = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    ...(connection === undefined ? {} : { connection }),
    sessionController: {}, workspaceController: {}, workspaceRegistry: {},
    effect: (fn) => fn(),
  }
  registerRoutes(ctx, { dataDir })
  const peer = withPeer ? { signal: new AbortController().signal } : undefined
  const thrown = []
  const srv = createServer((req, res) => {
    try {
      spec.handler(req, res, peer)
    } catch (err) {
      thrown.push(err)
      res.writeHead(400) // ← 宿主兜底：空 body 400
      res.end()
    }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${srv.address().port}/paper-reader`
  return { srv, origin, thrown, get spec() { return spec } }
}

function dataDirWithTopic() {
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-adm-data-'))
  mkdirSync(join(DATA, 'demo'), { recursive: true })
  return DATA
}

test('0.2.3 形态：注册项显式声明 auth=required（准入前移到宿主）', async () => {
  const DATA = dataDirWithTopic()
  const app = await serve({ connection: {}, withPeer: true, dataDir: DATA })
  try {
    assert.equal(app.spec.auth, 'required')
  } finally {
    app.srv.close()
    rmSync(DATA, { recursive: true, force: true })
  }
})

test('0.2.3 形态：没有 requestRejection 也能正常读文献库（不再抛 TypeError）', async () => {
  const DATA = dataDirWithTopic()
  const app = await serve({ connection: {}, withPeer: true, dataDir: DATA })
  try {
    const r = await fetch(`${app.origin}/api/library`)
    assert.equal(r.status, 200, `应 200，实际 ${r.status}`)
    assert.deepEqual((await r.json()).topics, ['demo'])
    assert.deepEqual(app.thrown, [], 'handler 抛异常会被宿主兜底成空 body 400')
  } finally {
    app.srv.close()
    rmSync(DATA, { recursive: true, force: true })
  }
})

test('0.2.3 形态：上传 PDF 正常落盘（HTTP 400 的直接回归点）', async () => {
  const DATA = dataDirWithTopic()
  const app = await serve({ connection: {}, withPeer: true, dataDir: DATA })
  try {
    const r = await fetch(`${app.origin}/api/library/upload`, {
      method: 'POST',
      headers: {
        'x-dpr-topic': encodeURIComponent('demo'),
        'x-dpr-name': encodeURIComponent('Paper One.pdf'),
        'content-type': 'application/pdf',
      },
      body: PDF,
    })
    const text = await r.text()
    assert.equal(r.status, 200, `上传应 200，实际 ${r.status} ${text}`)
    const body = JSON.parse(text)
    assert.deepEqual(body, { ok: true, topic: 'demo', name: 'Paper One', bytes: PDF.length })
    assert.ok(existsSync(join(DATA, 'demo', 'Paper One', 'Paper One.pdf')))
    assert.deepEqual(app.thrown, [])
  } finally {
    app.srv.close()
    rmSync(DATA, { recursive: true, force: true })
  }
})

test('0.2.3 形态：拿不到准入 Peer 时 fail-closed 成 503（绝不裸奔、绝不抛）', async () => {
  const DATA = dataDirWithTopic()
  const app = await serve({ connection: {}, withPeer: false, dataDir: DATA })
  try {
    const r = await fetch(`${app.origin}/api/library`)
    assert.equal(r.status, 503, `应 503，实际 ${r.status}`)
    const body = await r.json()
    assert.equal(body.code, 'unauthenticated')
    assert.match(body.error, /准入/)
    // 关键：不是宿主兜底的空 body 400
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.deepEqual(app.thrown, [])
  } finally {
    app.srv.close()
    rmSync(DATA, { recursive: true, force: true })
  }
})

test('0.2.3 形态：connection 服务整个缺失也不抛（旧测试壳 / 加载失败的宿主）', async () => {
  const DATA = dataDirWithTopic()
  const app = await serve({ connection: undefined, withPeer: false, dataDir: DATA })
  try {
    const r = await fetch(`${app.origin}/api/library`)
    assert.equal(r.status, 503)
    assert.equal((await r.json()).code, 'unauthenticated')
    assert.deepEqual(app.thrown, [])
  } finally {
    app.srv.close()
    rmSync(DATA, { recursive: true, force: true })
  }
})

test('0.2.2 形态：自己校验的 401/403 语义不变（老宿主不回归）', async () => {
  const DATA = dataDirWithTopic()
  let rejection = 401
  const app = await serve({
    connection: { requestRejection: () => rejection },
    withPeer: false, // 老宿主不传 Peer，靠 requestRejection 自己校验
    dataDir: DATA,
  })
  try {
    let r = await fetch(`${app.origin}/api/library`)
    assert.equal(r.status, 401)
    assert.equal((await r.json()).error, 'unauthorized')

    rejection = 403
    r = await fetch(`${app.origin}/api/library/upload`, {
      method: 'POST',
      headers: {
        'x-dpr-topic': encodeURIComponent('demo'),
        'x-dpr-name': encodeURIComponent('Blocked.pdf'),
        'content-type': 'application/pdf',
      },
      body: PDF,
    })
    assert.equal(r.status, 403)
    assert.equal((await r.json()).error, 'forbidden')
    assert.ok(!existsSync(join(DATA, 'demo', 'Blocked')), '被拦的请求不能落盘')

    rejection = undefined
    r = await fetch(`${app.origin}/api/library`)
    assert.equal(r.status, 200)
    assert.deepEqual(app.thrown, [])
  } finally {
    app.srv.close()
    rmSync(DATA, { recursive: true, force: true })
  }
})
