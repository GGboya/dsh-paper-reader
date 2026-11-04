// test/opencode-session.test.mjs — OpenCode Go 适配：端点识别 + x-opencode-session 会话头。
//
// 背景：OpenCode Go 要求客户端在每次推理请求里带稳定的会话 ID（x-opencode-session），
// 文档：https://opencode.ai/v2/docs/console/go/ 。本仓库有三条会打 LLM 的链路：
//   ① 设置保存前的连接预检（translate-config.testTranslateEndpoint）
//   ② 划词翻译（translate-selection.translateSelection）
//   ③ 整篇译文（babeldoc 驱动脚本，ID 走 DPR_OPENCODE_SESSION 环境变量）
// 三条都必须带；非 opencode.ai 端点一条都不能多带。
//
// 全程本地 mock（注入 fetchImpl / 替换 globalThis.fetch），零外网、零费用。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

const HOME = mkdtempSync(join(tmpdir(), 'dpr-opencode-home-'))
process.env.DSH_HOME = HOME

const oc = await import(pathToFileURL(dist('opencode.js')).href)
const { isOpenCodeEndpoint, openCodeSessionHeaders, openCodeDriverEnv, openCodeSessionId } = oc
const { OPENCODE_SESSION_HEADER, OPENCODE_DRIVER_SESSION_ENV } = oc
const { translateSelection, TranslateSelectionCache } = await import(pathToFileURL(dist('translate-selection.js')).href)
const { testTranslateEndpoint } = await import(pathToFileURL(dist('translate-config.js')).href)

const OC_URL = 'https://opencode.ai/inference/go/openai/v1'
const SESSION_FILE = join(HOME, '.dsh-paper-reader', 'opencode-session.json')

/* ══════════ A. 端点识别 ══════════ */

test('A1 isOpenCodeEndpoint：只认 opencode.ai 及其子域', () => {
  for (const url of [
    OC_URL,
    OC_URL + '/',
    'https://opencode.ai/inference/go/v1',
    'HTTPS://OPENCODE.AI/inference/go/openai/v1',
    'https://api.opencode.ai/v1',
    'https://opencode.ai./v1',
    `  ${OC_URL}  `,
  ]) {
    assert.equal(isOpenCodeEndpoint(url), true, `应识别为 OpenCode：${url}`)
  }
  for (const url of [
    'https://api.deepseek.com/v1',
    'https://open.bigmodel.cn/api/paas/v4',
    'https://api.kimi.com/coding/v1',
    'http://127.0.0.1:8000/v1',
    // 仿冒/越界：host 不是 opencode.ai 就不算（含 userinfo 与后缀拼接两种常见形式）
    'https://opencode.ai.evil.example/v1',
    'https://opencode.ai@evil.example/v1',
    'https://evil.example/opencode.ai/inference/go/openai/v1',
    'not a url',
    '',
  ]) {
    assert.equal(isOpenCodeEndpoint(url), false, `不应识别为 OpenCode：${url}`)
  }
  assert.equal(isOpenCodeEndpoint(null), false)
  assert.equal(isOpenCodeEndpoint(undefined), false)
})

test('A2 会话头/驱动环境变量：只在 OpenCode 端点且拿到 ID 时出现', () => {
  assert.deepEqual(openCodeSessionHeaders(OC_URL, 'ses-123'), { [OPENCODE_SESSION_HEADER]: 'ses-123' })
  assert.deepEqual(openCodeSessionHeaders(OC_URL, ''), {})
  assert.deepEqual(openCodeSessionHeaders('https://api.deepseek.com/v1', 'ses-123'), {})
  assert.deepEqual(openCodeDriverEnv(OC_URL, 'ses-123'), { [OPENCODE_DRIVER_SESSION_ENV]: 'ses-123' })
  assert.deepEqual(openCodeDriverEnv('https://api.deepseek.com/v1', 'ses-123'), {})
  assert.deepEqual(openCodeDriverEnv(OC_URL, ''), {})
  assert.equal(OPENCODE_SESSION_HEADER, 'x-opencode-session')
  assert.equal(OPENCODE_DRIVER_SESSION_ENV, 'DPR_OPENCODE_SESSION')
})

/* ══════════ B. 会话 ID 的稳定性与隐私 ══════════ */

test('B1 同一 scope 跨调用稳定，不同 scope 不同；落盘只有 secret、不含 scope 明文', async () => {
  const a1 = await openCodeSessionId('paper:lib/attention')
  const a2 = await openCodeSessionId('paper:lib/attention')
  const b = await openCodeSessionId('paper:lib/bert')
  const c = await openCodeSessionId('translate-precheck:https://opencode.ai|m')
  assert.equal(a1, a2, '同一作用域必须稳定')
  assert.notEqual(a1, b, '不同论文必须不同 ID')
  assert.notEqual(a1, c)
  assert.match(a1, /^[0-9a-f]{32}$/)

  const raw = readFileSync(SESSION_FILE, 'utf8')
  assert.ok(!raw.includes('attention'), 'secret 文件不得包含作用域明文（论文名）')
  assert.ok(!raw.includes('paper:'), 'secret 文件不得包含作用域明文')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.v, 1)
  assert.match(parsed.secret, /^[0-9a-f]{64}$/)
  if (process.platform !== 'win32') {
    assert.equal(statSync(SESSION_FILE).mode & 0o777, 0o600, 'secret 必须 0600')
  }
})

test('B2 secret 持久：删掉进程缓存/重新读文件后仍得到同一 ID', async () => {
  const before = await openCodeSessionId('paper:lib/attention')
  const parsed = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
  // 直接按「secret + scope」复算：证明 ID 只由落盘 secret 与作用域决定（重启后 secret 不变 → ID 不变）
  const { createHash } = await import('node:crypto')
  const expected = createHash('sha256').update(parsed.secret).update('\0').update('paper:lib/attention', 'utf8').digest('hex').slice(0, 32)
  assert.equal(before, expected)
})

test('B3 secret 文件损坏/被删 → 重建（一次性失效，但绝不抛错）', async () => {
  const first = await openCodeSessionId('paper:lib/attention')
  rmSync(SESSION_FILE, { force: true })
  const second = await openCodeSessionId('paper:lib/attention')
  assert.notEqual(second, first)
  assert.match(second, /^[0-9a-f]{32}$/)
})

test('B5 损坏的 secret 文件会被覆盖修复（不会每次都退回进程内 secret）', async () => {
  writeFileSync(SESSION_FILE, '{ not json', 'utf8')
  const repaired = await openCodeSessionId('paper:lib/corrupt')
  const parsed = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
  assert.equal(parsed.v, 1)
  assert.match(parsed.secret, /^[0-9a-f]{64}$/)
  // 修复后应稳定（再调用一次得到同一个 ID）
  assert.equal(await openCodeSessionId('paper:lib/corrupt'), repaired)
})

test('B4 作用域哈希与端点无关：同一 scope 在显式 home 下与默认 home 一致', async () => {
  const other = mkdtempSync(join(tmpdir(), 'dpr-opencode-home2-'))
  const a = await openCodeSessionId('paper:lib/x', HOME)
  const b = await openCodeSessionId('paper:lib/x', HOME)
  const c = await openCodeSessionId('paper:lib/x', other)
  assert.equal(a, b)
  assert.notEqual(a, c, '不同 home（不同 secret）应得到不同 ID')
})

/* ══════════ C. 划词翻译链路 ══════════ */

function okResponse(content = '你好') {
  return { status: 200, ok: true, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) }
}

test('C1 translateSelection 对 OpenCode 端点带会话头（宿主传入的 ID 原样使用）', async () => {
  let seen = null
  const r = await translateSelection(
    { baseUrl: OC_URL, apiKey: 'sk-oc', model: 'glm-5.3-flash' },
    'hello world',
    {
      openCodeSessionId: 'ses-fixed-1',
      cache: new TranslateSelectionCache(),
      fetchImpl: async (_url, init) => { seen = init; return okResponse() },
    },
  )
  assert.equal(r.translation, '你好')
  assert.equal(seen.headers[OPENCODE_SESSION_HEADER], 'ses-fixed-1')
  assert.equal(seen.headers.authorization, 'Bearer sk-oc')
})

test('C2 未显式传 ID 时按 scope 派生：同端点两次请求会话头相同', async () => {
  const heads = []
  const deps = () => ({
    cache: new TranslateSelectionCache(),
    fetchImpl: async (_url, init) => { heads.push(init.headers); return okResponse() },
  })
  const ep = { baseUrl: OC_URL, apiKey: 'sk-oc', model: 'm' }
  await translateSelection(ep, 'first text', deps())
  await translateSelection(ep, 'second text', deps())
  assert.match(heads[0][OPENCODE_SESSION_HEADER], /^[0-9a-f]{32}$/)
  assert.equal(heads[0][OPENCODE_SESSION_HEADER], heads[1][OPENCODE_SESSION_HEADER], '同一端点必须稳定')
})

test('C3 非 OpenCode 端点绝不带会话头（行为与改造前一致）', async () => {
  let seen = null
  await translateSelection(
    { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', model: 'm' },
    'hello world',
    {
      cache: new TranslateSelectionCache(),
      fetchImpl: async (_url, init) => { seen = init; return okResponse() },
    },
  )
  assert.equal(seen.headers[OPENCODE_SESSION_HEADER], undefined)
  assert.equal(seen.headers.authorization, 'Bearer sk-ds')
})

test('C4 缓存命中时零请求（不因会话头破坏既有缓存语义）', async () => {
  let calls = 0
  const cache = new TranslateSelectionCache()
  const ep = { baseUrl: OC_URL, apiKey: 'sk-oc', model: 'm' }
  const deps = { cache, openCodeSessionId: 'ses-x', fetchImpl: async () => { calls++; return okResponse() } }
  await translateSelection(ep, 'same text', deps)
  const second = await translateSelection(ep, 'same text', deps)
  assert.equal(second.cached, true)
  assert.equal(calls, 1)
})

/* ══════════ D. 设置预检链路 ══════════ */

test('D1 testTranslateEndpoint 对 OpenCode 端点带会话头；非 OpenCode 端点不带', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers })
    return { ok: true, status: 200, text: async () => '{"choices":[]}' }
  }
  try {
    const ep = { baseUrl: OC_URL, apiKey: 'sk-oc', model: 'deepseek-v4.1-flash' }
    assert.equal((await testTranslateEndpoint(ep)).ok, true)
    assert.equal((await testTranslateEndpoint(ep)).ok, true)
    for (const req of seen) {
      assert.match(req.url, /\/chat\/completions$/)
      assert.match(req.headers[OPENCODE_SESSION_HEADER], /^[0-9a-f]{32}$/)
    }
    assert.equal(seen[0].headers[OPENCODE_SESSION_HEADER], seen[1].headers[OPENCODE_SESSION_HEADER], '同一端点预检必须稳定')

    seen.length = 0
    assert.equal((await testTranslateEndpoint({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'm' })).ok, true)
    assert.equal(seen[0].headers[OPENCODE_SESSION_HEADER], undefined)
  } finally {
    globalThis.fetch = original
  }
})

/* ══════════ E. 整篇译文（babeldoc 驱动）链路 ══════════ */

test('E1 驱动脚本确实把 DPR_OPENCODE_SESSION 加进 extra_headers，Node 侧确实把 env 传下去', () => {
  const driver = readFileSync(join(ROOT, '..', 'runtime', 'babeldoc-driver.py'), 'utf8')
  assert.ok(driver.includes('DPR_OPENCODE_SESSION'), '驱动必须读取 DPR_OPENCODE_SESSION')
  assert.ok(driver.includes('x-opencode-session'), '驱动必须写 x-opencode-session 头')
  assert.ok(/extra_headers\["x-opencode-session"\]\s*=\s*OPENCODE_SESSION/.test(driver))

  const translate = readFileSync(join(ROOT, '..', 'src', 'translate.ts'), 'utf8')
  assert.ok(translate.includes('openCodeDriverEnv(ep.baseUrl, ocSession)'), '整篇翻译必须把会话 ID 传给子进程')
  assert.ok(translate.includes('openCodeSessionId(`paper:'), '整篇翻译必须按论文派生稳定 ID')

  const host = readFileSync(join(ROOT, '..', 'src', 'host.ts'), 'utf8')
  assert.ok(host.includes('translateSelection(endpoint, asm.source, ocSession'), '划词路由必须把论文级 ID 传给翻译函数')
})
