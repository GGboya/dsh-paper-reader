// translation-follow.test.mjs — 全文翻译默认跟随 Harness + 可选专用端点覆盖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (name) => join(ROOT, '..', 'dist', name)
const { currentHarnessModel, openHarnessTranslationBridge } = await import(pathToFileURL(dist('harness-translate.js')).href)
const { translateSelection, TranslateSelectionCache } = await import(pathToFileURL(dist('translate-selection.js')).href)
const CFG = await import(pathToFileURL(dist('translate-config.js')).href)
const TR = await import(pathToFileURL(dist('translate.js')).href)
const OPT = await import(pathToFileURL(dist('translation-options.js')).href)
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('等待条件超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function fakeLlm(reply = '你好') {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'zai-coding-cn', name: '智谱' }],
    stream: async function* (options) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: reply.slice(0, 1) }
      yield { type: 'text-delta', index: 0, text: reply.slice(1) }
      // block-end 不得与已经收到的 delta 重复拼接。
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('H1 划词翻译经临时本地端点走 Harness，消息/用量映射正确且不重复文本', async () => {
  const llm = fakeLlm()
  const bridge = await openHarnessTranslationBridge(llm, { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-flash' })
  try {
    assert.match(bridge.endpoint.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    const result = await translateSelection(bridge.endpoint, 'hello', { cache: new TranslateSelectionCache(), log: () => {} })
    assert.equal(result.translation, '你好')
    assert.equal(result.model, 'deepseek-flash')
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].provider, 'deepseek-official')
    assert.equal(llm.calls[0].model, 'deepseek-flash')
    assert.match(llm.calls[0].system, /professional/)
    assert.equal(llm.calls[0].messages.at(-1).content[0].text, 'hello')
    assert.equal(typeof llm.calls[0].maxTokens, 'number')
  } finally { await bridge.close() }
  await assert.rejects(fetch(bridge.endpoint.baseUrl + '/chat/completions'), '关闭后临时端口不得继续服务')
})

test('H2 每次打开桥都固定当时选择；只读 currentSelection，不需要 Harness Key', async () => {
  let selected = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const defaults = { currentSelection: () => ({ ...selected }) }
  const llm = fakeLlm()
  assert.deepEqual(currentHarnessModel(defaults, llm), { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-flash' })
  selected = { provider: 'zai-coding-cn', model: 'glm-5.3-flash' }
  assert.deepEqual(currentHarnessModel(defaults, llm), { provider: 'zai-coding-cn', providerName: '智谱', model: 'glm-5.3-flash' })
  const bridge = await openHarnessTranslationBridge(llm, currentHarnessModel(defaults, llm))
  try {
    const r = await fetch(bridge.endpoint.baseUrl + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.endpoint.apiKey}` },
      body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'test' }] }),
    })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.model, 'glm-5.3-flash')
    assert.equal(body.usage.total_tokens, 9)
    assert.equal(llm.calls[0].provider, 'zai-coding-cn')
  } finally { await bridge.close() }
})

test('H3 临时端点鉴权、上游错误与取消边界', async () => {
  const llm = {
    listProviders: () => [],
    stream: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', status: 429 } } } },
  }
  const bridge = await openHarnessTranslationBridge(llm, { provider: 'p', providerName: 'P', model: 'm' })
  try {
    const unauth = await fetch(bridge.endpoint.baseUrl + '/chat/completions', { method: 'POST' })
    assert.equal(unauth.status, 401)
    const failed = await fetch(bridge.endpoint.baseUrl + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.endpoint.apiKey}` },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'test' }] }),
    })
    assert.equal(failed.status, 429)
    assert.equal((await failed.json()).error.message, 'rate limited')
  } finally { await bridge.close() }
  await bridge.close() // 幂等
})

test('H4 空库默认跟随；切自定义再切回不删除配置；显式 profile 仍兼容', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dpr-harness-follow-store-'))
  try {
    assert.equal((await CFG.resolveTranslateEndpoint(undefined, home)).source, 'harness')
    const saved = await CFG.saveTranslateEndpoint(
      { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'secret', model: 'deepseek-chat' },
      { id: 'new', provider: 'deepseek', home },
    )
    assert.equal((await CFG.resolveTranslateEndpoint(undefined, home)).source, 'file')
    await CFG.selectTranslateEndpoint('harness', home)
    assert.equal((await CFG.resolveTranslateEndpoint(undefined, home)).source, 'harness')
    assert.equal((await CFG.readTranslateEndpointStore(home)).endpoints.length, 1, '切回跟随不得删除自定义配置')
    assert.equal((await CFG.readTranslateEndpointStore(home)).endpoints[0].provider, 'deepseek')
    const profile = { baseUrl: 'https://profile.invalid/v1', apiKey: 'p', model: 'profile-model' }
    await CFG.selectTranslateEndpoint('profile', home)
    assert.equal((await CFG.resolveTranslateEndpoint(profile, home)).source, 'profile')
    assert.equal((await CFG.resolveTranslateEndpoint(undefined, home, saved.id)).source, 'file')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('H5 自动模型列表过滤非聊天模型，Anthropic 使用原生 models 鉴权头', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ data: [
      { id: 'claude-opus-5-5' }, { id: 'text-embedding-3-large' }, { id: 'claude-sonnet-5-5' }, { id: 'whisper-1' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const result = await CFG.listTranslateModels({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'test-secret' }, fetchImpl)
  assert.equal(result.ok, true)
  assert.deepEqual(result.models, ['claude-opus-5-5', 'claude-sonnet-5-5'])
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models')
  assert.equal(calls[0].options.headers['x-api-key'], 'test-secret')
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01')
  const missing = await CFG.listTranslateModels({ baseUrl: 'https://example.invalid/v1', apiKey: '' }, fetchImpl)
  assert.equal(missing.ok, false)
  assert.match(missing.detail, /API Key/)
})

test('H6 设置页与阅读器都有跟随入口，客户端仍可重复导入', () => {
  const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  for (const marker of ['data-dpr-translate-settings', 'data-dpr-translate-follow', 'data-dpr-translate-custom', 'data-dpr-translate-provider', 'data-dpr-translate-key', 'data-dpr-translate-model']) {
    assert.ok(client.includes(marker), `缺少 ${marker}`)
  }
  assert.ok(client.includes("body: JSON.stringify({ id: 'harness' })"), '恢复跟随必须走独立选择路由')
  assert.ok(client.includes("api('/translate/models'"), 'Key 自动获取模型必须接真实后端')
  const reader = readFileSync(join(ROOT, '..', 'reader', 'index.html'), 'utf8')
  assert.ok(reader.includes("e.source === 'harness'"), '阅读器生成选择器必须认识 Harness 来源')
  assert.ok(reader.includes('e.composedPath()'), '厂商/模型重绘后必须按原事件路径判断浮层外点击')
  assert.ok(reader.includes('positionCfgPop()'), '展开自定义后必须重新约束浮层位置，避免底部超出视口')
  for (const icon of ['deepseek.svg', 'openai.svg', 'anthropic.svg', 'gemini.svg', 'zhipu.svg', 'kimi.svg', 'opencode.svg']) {
    assert.ok(existsSync(join(ROOT, '..', 'reader', 'vendor', icon)), `厂商图标必须随包提供：${icon}`)
  }
  assert.ok(client.includes('data-dpr-provider-icon'), 'dsh 设置页必须使用真实厂商图标')
  assert.ok(reader.includes('dataset.cfgProviderIcon'), '阅读器设置必须使用同一套厂商图标')
  assert.ok(reader.includes('data-cfg-option="splitTokens"') && reader.includes('data-cfg-option="maxOutputTokens"') && reader.includes('data-cfg-option="qps"'), '高级设置必须提供真实翻译参数')
  assert.ok(reader.includes('id="cfg-endpoints"'), '已保存端点管理必须独立于翻译参数')
  assert.ok(client.includes('data-dpr-translate-option') && client.includes('data-dpr-translate-options-save'), 'dsh 设置页必须复用同一套翻译参数')
  const host = readFileSync(join(ROOT, '..', 'src', 'host.ts'), 'utf8')
  assert.ok(host.includes('openHarnessTranslationBridge'), '宿主必须接临时 Harness 翻译桥')
  const index = readFileSync(join(ROOT, '..', 'src', 'index.ts'), 'utf8')
  assert.ok(index.includes("'agentDefaultModel', 'llm'"), '插件必须声明 Harness 模型服务依赖')
})

test('H7 BabelDOC 完成后释放临时端点资源', { skip: process.platform === 'win32' && 'POSIX 假 babeldoc' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dpr-harness-hooks-'))
  const dataDir = join(root, 'data')
  const oldEnsure = process.env.DPR_SKIP_ENGINE_ENSURE
  process.env.DPR_SKIP_ENGINE_ENSURE = '1'
  const ref = { topic: 'tx', name: 'paper', pdfPath: join(dataDir, 'paper.pdf') }
  let finished = 0
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(ref.pdfPath, '%PDF-fake')
    const bin = join(root, '.venv-pdf2zh', 'bin', 'babeldoc')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, `#!/bin/sh
case "$1" in
  --version) exit 0 ;;
  --help) echo "--no-watermark"; exit 0 ;;
esac
out=""
files=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --files) files="$2"; shift 2 ;;
    *) shift ;;
  esac
done
stem=$(basename "$files" .pdf)
printf '%%PDF-fake' > "$out/$stem.zh-CN.mono.pdf"
`)
    chmodSync(bin, 0o755)
    const r = await TR.startTranslation(ref, dataDir, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }, { onFinish: () => { finished += 1 } })
    assert.equal(r.started, true)
    await until(() => finished === 1)
    assert.equal(existsSync(join(dataDir, 'paper-zh.pdf')), true)
    assert.equal(TR.zhStatus(ref).busy, false)
  } finally {
    if (oldEnsure === undefined) delete process.env.DPR_SKIP_ENGINE_ENSURE
    else process.env.DPR_SKIP_ENGINE_ENSURE = oldEnsure
    rmSync(root, { recursive: true, force: true })
  }
})

test('H8 翻译参数校验、默认值与端点切换持久化', async () => {
  assert.deepEqual(OPT.sanitizeTranslationRunOptions(undefined), { splitTokens: 100000, maxOutputTokens: 32768, qps: 16 })
  assert.deepEqual(OPT.sanitizeTranslationRunOptions({ splitTokens: -5, maxOutputTokens: 999999, qps: 0 }), { splitTokens: 200, maxOutputTokens: 32768, qps: 1 })
  assert.throws(() => OPT.validateTranslationRunOptions({ splitTokens: '3000' }), /单段上下文上限/)
  assert.throws(() => OPT.validateTranslationRunOptions({ qps: 0 }), /并发请求数/)
  const home = mkdtempSync(join(tmpdir(), 'dpr-translation-options-'))
  try {
    const options = await CFG.writeTranslateRunOptions({ splitTokens: 1800, maxOutputTokens: 4096, qps: 4 }, home)
    assert.deepEqual(options, { splitTokens: 1800, maxOutputTokens: 4096, qps: 4 })
    await CFG.saveTranslateEndpoint({ baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' }, { id: 'new', home })
    await CFG.selectTranslateEndpoint('harness', home)
    const store = await CFG.readTranslateEndpointStore(home)
    assert.equal(store.activeId, 'harness')
    assert.deepEqual(store.options, options, '切端点不得重置运行参数')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('H9 翻译参数实际进入 BabelDOC 的 QPS 与驱动环境', { skip: process.platform === 'win32' && 'POSIX 假 babeldoc' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dpr-translation-options-launch-'))
  const dataDir = join(root, 'data')
  const capture = join(root, 'capture.json')
  const oldEnsure = process.env.DPR_SKIP_ENGINE_ENSURE
  process.env.DPR_SKIP_ENGINE_ENSURE = '1'
  process.env.DPR_TEST_OPTIONS_CAPTURE = capture
  const ref = { topic: 'tx', name: 'paper', pdfPath: join(dataDir, 'paper.pdf') }
  let finished = false
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(ref.pdfPath, '%PDF-fake')
    const bin = join(root, '.venv-pdf2zh', 'bin', 'babeldoc')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, `#!/bin/sh
case "$1" in
  --version) exit 0 ;;
  --help) echo "--no-watermark"; exit 0 ;;
esac
printf '%s' "{\\"split\\":\\"$DPR_SPLIT_TOKENS\\",\\"output\\":\\"$DPR_MAX_OUTPUT_TOKENS\\",\\"args\\":\\"$*\\"}" > "$DPR_TEST_OPTIONS_CAPTURE"
out=""
files=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --files) files="$2"; shift 2 ;;
    *) shift ;;
  esac
done
stem=$(basename "$files" .pdf)
printf '%%PDF-fake' > "$out/$stem.zh-CN.mono.pdf"
`)
    chmodSync(bin, 0o755)
    const started = await TR.startTranslation(
      ref, dataDir, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }, { onFinish: () => { finished = true } },
      { splitTokens: 1800, maxOutputTokens: 4096, qps: 4 },
    )
    assert.equal(started.started, true)
    await until(() => existsSync(capture))
    await until(() => finished)
    assert.equal(TR.zhStatus(ref).error, undefined)
    const seen = JSON.parse(readFileSync(capture, 'utf8'))
    assert.equal(seen.split, '1800')
    assert.equal(seen.output, '4096')
    assert.match(seen.args, /--qps 4(?: |$)/)
  } finally {
    if (oldEnsure === undefined) delete process.env.DPR_SKIP_ENGINE_ENSURE
    else process.env.DPR_SKIP_ENGINE_ENSURE = oldEnsure
    delete process.env.DPR_TEST_OPTIONS_CAPTURE
    rmSync(root, { recursive: true, force: true })
  }
})
