import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CFG = await import(pathToFileURL(join(ROOT, '..', 'dist', 'translate-config.js')).href)
const TR = await import(pathToFileURL(join(ROOT, '..', 'dist', 'translate.js')).href)

const endpoint = (model, apiKey = `key-${model}`) => ({ baseUrl: 'https://example.invalid/v1', apiKey, model })

test('E1 旧单端点文件自动成为 legacy 项，读取与 profile 回落不变', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dpr-endpoints-legacy-'))
  try {
    const file = CFG.translateConfigPath(home)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(endpoint('legacy-model')), { mode: 0o600 })
    const store = await CFG.readTranslateEndpointStore(home)
    assert.equal(store.activeId, 'legacy')
    assert.equal(store.endpoints.length, 1)
    assert.equal(store.endpoints[0].model, 'legacy-model')
    assert.equal((await CFG.readTranslateConfig(home)).model, 'legacy-model')
    assert.equal((await CFG.resolveTranslateEndpoint(undefined, home)).source, 'file')
    const empty = mkdtempSync(join(tmpdir(), 'dpr-endpoints-empty-'))
    try {
      const profile = endpoint('profile-model')
      assert.equal((await CFG.resolveTranslateEndpoint(profile, empty)).endpoint.model, 'profile-model')
    } finally { rmSync(empty, { recursive: true, force: true }) }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('E2 多端点新增、更新、选择、删除；每次选择都严格生效', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dpr-endpoints-multi-'))
  try {
    const a = await CFG.saveTranslateEndpoint(endpoint('model-a', 'key-a'), { id: 'new', label: 'A', home })
    const b = await CFG.saveTranslateEndpoint(endpoint('model-b', 'key-b'), { id: 'new', label: 'B', home })
    let store = await CFG.readTranslateEndpointStore(home)
    assert.equal(store.endpoints.length, 2)
    assert.equal(store.activeId, b.id)
    assert.equal((await CFG.readTranslateConfig(home)).model, 'model-b')
    assert.equal((await CFG.resolveTranslateEndpoint(undefined, home, a.id)).endpoint.apiKey, 'key-a')
    assert.equal((await CFG.resolveTranslateEndpoint(undefined, home, a.id)).source, 'file')
    assert.equal((await CFG.resolveTranslateEndpoint(undefined, home, 'missing')).source, 'none')

    await CFG.selectTranslateEndpoint(a.id, home)
    assert.equal((await CFG.readTranslateConfig(home)).model, 'model-a')
    await CFG.saveTranslateEndpoint(endpoint('model-a2', 'key-a2'), { id: a.id, home })
    store = await CFG.readTranslateEndpointStore(home)
    assert.equal(store.endpoints.length, 2, '更新不得复制端点')
    assert.equal(store.endpoints.find((e) => e.id === a.id).label, 'A', '未改 label 时保留旧名称')

    const profile = endpoint('profile-model')
    await CFG.selectTranslateEndpoint('profile', home)
    assert.equal((await CFG.resolveTranslateEndpoint(profile, home)).endpoint.model, 'profile-model')
    await CFG.deleteTranslateEndpoint(a.id, home)
    store = await CFG.readTranslateEndpointStore(home)
    assert.deepEqual(store.endpoints.map((e) => e.model), ['model-b'])
    await CFG.deleteTranslateEndpoint(b.id, home)
    assert.equal((await CFG.resolveTranslateEndpoint(profile, home)).endpoint.model, 'profile-model')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('E4 UI 契约：busy 可取消、生成前选端点、无配置引导配置', () => {
  const html = readFileSync(join(ROOT, '..', 'reader', 'index.html'), 'utf8')
  for (const id of ['zh-cancel', 'generate-pop', 'generate-endpoint', 'cfg-saved', 'cfg-new', 'cfg-save-new']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`)
  }
  assert.match(html, /\.\.\.\(endpointId \? \{ endpointId \} : \{\}\)/, '生成请求必须带用户所选 endpointId')
  assert.match(html, /if \(!generateEndpoints\.length\) \{[\s\S]*?openCfgPop\(true\)/, '没有已保存端点时必须引导配置')
  assert.match(html, /api\('\/zh\/cancel'/, 'busy 取消必须调用真实服务端取消口')
})

test('E3 取消后立即可重试，旧任务回调不得覆盖新任务', { skip: process.platform === 'win32' && 'POSIX 假 babeldoc' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dpr-cancel-translation-'))
  const dataDir = join(root, 'data')
  const pidFile = join(root, 'pid')
  const oldEnsure = process.env.DPR_SKIP_ENGINE_ENSURE
  process.env.DPR_SKIP_ENGINE_ENSURE = '1'
  process.env.DPR_TEST_TX_PIDFILE = pidFile
  const ref = { topic: 'tx', name: 'paper', pdfPath: join(dataDir, 'paper.pdf') }
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(ref.pdfPath, '%PDF-fake')
    const bin = join(root, '.venv-pdf2zh', 'bin', 'babeldoc')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, '#!/bin/sh\ncase "$1" in\n  --version) exit 0 ;;\n  --help) echo "--no-watermark"; exit 0 ;;\n  *) echo $$ > "$DPR_TEST_TX_PIDFILE"; exec sleep 30 ;;\nesac\n')
    chmodSync(bin, 0o755)
    const ep = endpoint('m')
    assert.equal((await TR.startTranslation(ref, dataDir, ep)).started, true)
    const deadline = Date.now() + 3000
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    assert.ok(existsSync(pidFile), '假翻译进程必须已启动')
    assert.equal(TR.zhStatus(ref).busy, true)
    assert.equal(TR.cancelTranslation(ref), true)
    assert.equal(TR.zhStatus(ref).busy, false)
    assert.match(TR.zhStatus(ref).error, /已取消/)
    assert.equal(TR.cancelTranslation(ref), false, '重复取消不得误报成功')

    assert.equal((await TR.restartTranslation(ref, dataDir, ep)).started, true, '取消后必须能立即重试')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(TR.zhStatus(ref).busy, true, '旧任务的 close 回调不得把新任务清成失败/完成')
    assert.equal(TR.cancelTranslation(ref), true)
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    }
    if (oldEnsure === undefined) delete process.env.DPR_SKIP_ENGINE_ENSURE
    else process.env.DPR_SKIP_ENGINE_ENSURE = oldEnsure
    delete process.env.DPR_TEST_TX_PIDFILE
    rmSync(root, { recursive: true, force: true })
  }
})
