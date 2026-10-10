// test/translate-precheck-redaction.test.mjs — 翻译端点预检的错误文案脱敏回归（S1 / t12）。
//
// 背景：testTranslateEndpoint() 会把端点响应体片段拼进错误 detail 以便排查端点路径问题；
// 若端点回显 Authorization（调试模式 / 错误页 / 被劫持的自定义端点），翻译 API key 会出现在
// 错误文案里 → 进而在 HTTP 响应与浏览器设置浮层里显示。修法与 MinerU 的 F-R2-1 同款：
// 复用 mineru.ts 的 sanitizeDetail（含 URL 编码 / JSON 转义 / 短 key 词边界处理）。
//
// 只 import dist/*.js（Node 22 无法直接跑 TS）。跑前先 `npm run build`。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

const { testTranslateEndpoint, maskApiKey } = await import(dist('translate-config.js'))

/** 起一个本地 mock 端点，返回 { server, url }。 */
function startServer(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

/** 固定响应体 + 状态码的 mock 端点。 */
function fixedServer(status, body, contentType = 'application/json') {
  return startServer((_req, res) => {
    res.writeHead(status, { 'content-type': contentType })
    res.end(body)
  })
}

const KEY = 'sk-translate-SECRET-ABCD1234'

test('S1：HTTP 200 但响应不是补全结果时，错误文案脱敏且保留诊断价值', async () => {
  // 端点把 Authorization 回显在 body 里（非补全结果 JSON）
  const body = JSON.stringify({ code: 1001, success: false, received: `Bearer ${KEY}`, note: 'wrong path, want /api/paas/v4' })
  const { server, url } = await fixedServer(200, body)
  try {
    const r = await testTranslateEndpoint({ baseUrl: url, apiKey: KEY, model: 'glm-4' })
    assert.equal(r.ok, false, '没有 choices 必须判失败（否则 babeldoc 跑起来才炸）')
    assert.equal(r.detail.includes(KEY), false, `不得泄露 apiKey：${r.detail}`)
    // 诊断价值必须保留
    assert.match(r.detail, /HTTP 200 但响应不是补全结果/)
    assert.match(r.detail, /多半是端点路径不对，如智谱应为 \/api\/paas\/v4/)
    assert.match(r.detail, /wrong path, want \/api\/paas\/v4/, '非敏感响应片段仍应可见')
    assert.match(r.detail, /1001/, '业务码等排查信息仍应可见')
    assert.match(r.detail, /\[redacted\]/, '应有脱敏痕迹')
  } finally {
    server.close()
  }
})

test('S1：非 2xx 分支同样脱敏（保留状态码与非敏感片段）', async () => {
  const { server, url } = await fixedServer(500, `<html><body>upstream error: Authorization: Bearer ${KEY}</body></html>`, 'text/html')
  try {
    const r = await testTranslateEndpoint({ baseUrl: url, apiKey: KEY, model: 'glm-4' })
    assert.equal(r.ok, false)
    assert.equal(r.detail.includes(KEY), false, `不得泄露 apiKey：${r.detail}`)
    assert.match(r.detail, /^HTTP 500/, 'HTTP 状态码必须保留在最前')
    assert.match(r.detail, /upstream error/, '非敏感片段仍应可见')
  } finally {
    server.close()
  }
})

test('S1：变形回显（URL 编码 / JSON 转义）也不泄露', async () => {
  const urlKey = 'a+b/c=d'
  const { server: s1, url: u1 } = await fixedServer(200, `echo=${encodeURIComponent(urlKey)} not-a-completion`)
  try {
    const r1 = await testTranslateEndpoint({ baseUrl: u1, apiKey: urlKey, model: 'm' })
    assert.equal(r1.detail.includes(encodeURIComponent(urlKey)), false, `URL 编码形式不得泄露：${r1.detail}`)
    assert.equal(r1.detail.includes(urlKey), false, `原样形式不得泄露：${r1.detail}`)
    assert.match(r1.detail, /not-a-completion/)
  } finally {
    s1.close()
  }

  const escKey = 'sk"esc'
  const escaped = escKey.replace(/[\\"]/g, (c) => `\\${c}`)
  const { server: s2, url: u2 } = await fixedServer(200, `echo=${escaped} not-a-completion`)
  try {
    const r2 = await testTranslateEndpoint({ baseUrl: u2, apiKey: escKey, model: 'm' })
    assert.equal(r2.detail.includes(escKey), false, `JSON 转义形式不得泄露：${r2.detail}`)
    assert.match(r2.detail, /not-a-completion/)
  } finally {
    s2.close()
  }
})

test('S1：截断上限与诊断片段保持原样（前 200 字符保留、更靠后的内容仍被截掉）', async () => {
  const tail = 'TAILMARKER-SHOULD-BE-CUT'
  const { server, url } = await fixedServer(200, 'Y'.repeat(300) + tail)
  try {
    const r = await testTranslateEndpoint({ baseUrl: url, apiKey: KEY, model: 'm' })
    assert.equal(r.ok, false)
    assert.ok(r.detail.includes('Y'.repeat(200)), '前 200 字符应保留（截断上限不变）')
    assert.ok(!r.detail.includes(tail), '超过 200 字符的内容仍应被截断')
    assert.match(r.detail, /多半是端点路径不对/)
  } finally {
    server.close()
  }
})

test('S1：既有语义不回归——缺项判断、happy path、错误 cause 拼接', async () => {
  // 三项缺一 → 原有固定文案
  assert.deepEqual(await testTranslateEndpoint({ baseUrl: '', apiKey: 'k', model: 'm' }), { ok: false, detail: '端点配置不完整（需要 url + key + 模型）' })
  assert.deepEqual(await testTranslateEndpoint({ baseUrl: 'https://x', apiKey: '', model: 'm' }), { ok: false, detail: '端点配置不完整（需要 url + key + 模型）' })
  assert.deepEqual(await testTranslateEndpoint({ baseUrl: 'https://x', apiKey: 'k', model: '' }), { ok: false, detail: '端点配置不完整（需要 url + key + 模型）' })

  // happy path：有 choices → ok
  const { server: ok1, url: u1 } = await fixedServer(200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }))
  try {
    assert.equal((await testTranslateEndpoint({ baseUrl: u1, apiKey: KEY, model: 'm' })).ok, true)
  } finally {
    ok1.close()
  }

  // 不可达端点 → 仍走 catch 分支（err.message + cause），文案非空且可读
  const r = await testTranslateEndpoint({ baseUrl: 'http://127.0.0.1:1', apiKey: KEY, model: 'm' })
  assert.equal(r.ok, false)
  assert.ok(typeof r.detail === 'string' && r.detail.length > 0)
  assert.match(r.detail, /fetch failed|ECONNREFUSED|bad port/i, `应保留真实原因：${r.detail}`)

  // 401 + 明文错误体：状态码与可读信息保留，且不含 key
  const { server: s401, url: u401 } = await fixedServer(401, JSON.stringify({ error: { message: `invalid api key ${KEY}` } }))
  try {
    const r401 = await testTranslateEndpoint({ baseUrl: u401, apiKey: KEY, model: 'm' })
    assert.equal(r401.ok, false)
    assert.equal(r401.detail.includes(KEY), false, `不得泄露 apiKey：${r401.detail}`)
    assert.match(r401.detail, /^HTTP 401/)
    assert.match(r401.detail, /invalid api key/)
  } finally {
    s401.close()
  }
})

test('S1：脱敏不影响掩码展示（maskApiKey 未被改动）', () => {
  assert.equal(maskApiKey(KEY), `${KEY.slice(0, 3)}…${KEY.slice(-4)}`)
  assert.equal(maskApiKey('short'), '••••')
})
