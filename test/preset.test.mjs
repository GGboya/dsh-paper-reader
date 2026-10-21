// test/preset.test.mjs — 声明式论文伴读 preset 与「不默认套用」契约。
// 只 import dist/*.js（npm test 的 pretest 会先 build）；路由使用临时文献库与假 dsh 服务。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-preset-home-'))
const { registerRoutes } = await import(pathToFileURL(join(REPO, 'dist', 'host.js')).href)

test('preset：bundle 声明可选 agent-preset，并保留伴读门槛与压缩组', () => {
  const patch = readFileSync(join(REPO, 'cordis.patch.yml'), 'utf8')
  const host = readFileSync(join(REPO, 'src', 'host.ts'), 'utf8')
  const tools = readFileSync(join(REPO, 'src', 'tools.ts'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

  assert.match(patch, /id: preset-paper-reader\n\s+name: '@deepseek-ai\/dsh-agent-preset'/)
  assert.match(patch, /config:\n\s+id: paper-reader\n\s+name: 论文伴读/)
  assert.match(patch, /description: 可选的教练式论文伴读/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-persona'/)
  assert.match(patch, /complete: true/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-compaction-basic'/)
  assert.match(patch, /name: '@deepseek-ai\/dsh-compaction-tool-result-pruner'/)

  // 教学契约：先自己读和答；当前步未通过不能完成、不能预讲或推进下一步。
  assert.match(patch, /Stage gate \(non-negotiable\)/)
  assert.match(patch, /do NOT call complete_step/)
  assert.match(patch, /do NOT assign, preview, or explain the next step/)
  assert.match(patch, /require a fresh check answer/)
  assert.match(patch, /Quick Q&A never completes or advances a step/)
  assert.match(patch, /offer a short test-out check/)
  assert.match(patch, /selected this preset for a standalone dsh conversation/)
  assert.match(tools, /未通过不得调用/)

  // 预设只注册给 dsh 供用户选择；论文入口不得替用户默认套用。
  assert.doesNotMatch(host, /agentPreset/)

  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '>=0.2.0-rc.2 <0.3.0-0')
  assert.equal(pkg.devDependencies['@deepseek-ai/dsh-tools'], '0.2.0-rc.2')
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.ok(!pkg.files.includes('presets'))
  assert.ok(!existsSync(join(REPO, 'presets')), 'legacy presets 目录应已移除')
  assert.ok(!existsSync(join(REPO, 'src', 'preset.ts')), 'legacy 安装器应已移除')
  assert.ok(!existsSync(join(REPO, 'dist', 'preset.js')), 'clean build 不得残留旧 dist/preset.js')
})

function library() {
  const data = mkdtempSync(join(tmpdir(), 'dpr-preset-data-'))
  mkdirSync(join(data, 'T'), { recursive: true })
  writeFileSync(join(data, 'T', 'P.pdf'), 'PDF')
  return data
}

async function boot({ data, create, workspaceCreate }) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }), create },
    workspaceController: {
      create: workspaceCreate ?? (async () => ({ workspace: { workspaceId: 'ws-test' } })),
    },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  return {
    srv,
    newSession: async () => {
      const response = await fetch(base + '/api/sessions/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'T', name: 'P' }),
      })
      const text = await response.text()
      return { status: response.status, text }
    },
  }
}

test('preset：论文入口新建会话保持默认 agent（工作区路径）', async () => {
  const data = library()
  const requests = []
  const { srv, newSession } = await boot({
    data,
    create: async (request) => { requests.push(request); return {} },
  })
  try {
    const result = await newSession()
    assert.equal(result.status, 200, result.text)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].workspaceId, 'ws-test')
    assert.match(requests[0].sessionId, /^dpr-/)
    assert.equal(requests[0].agentPreset, undefined)
  } finally {
    srv.close()
  }
})

test('preset：论文入口 cwd 回退同样保持默认 agent', async () => {
  const data = library()
  const requests = []
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  const { srv, newSession } = await boot({
    data,
    create: async (request) => { requests.push(request); return {} },
    workspaceCreate: async () => { throw new Error('workspace unavailable') },
  })
  try {
    const result = await newSession()
    assert.equal(result.status, 200, result.text)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].agentPreset, undefined)
    assert.equal(requests[0].cwd, join(data, 'T'))
    assert.equal(requests[0].workspaceId, undefined)
  } finally {
    console.warn = originalWarn
    srv.close()
  }
  assert.ok(warnings.some((line) => line.includes('workspace 注册失败')), 'workspace 回退仍应如实告警')
})
