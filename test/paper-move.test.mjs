// test/paper-move.test.mjs — 论文跨专题移动 + 树行内联重命名。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const HOME = mkdtempSync(join(tmpdir(), 'dpr-paper-move-home-'))
process.env.DSH_HOME = HOME
const { movePaper } = await import(pathToFileURL(join(REPO, 'dist', 'library-manage.js')).href)
const { registerRoutes } = await import(pathToFileURL(join(REPO, 'dist', 'host.js')).href)
const roots = []
function newLibrary() {
  const root = mkdtempSync(join(tmpdir(), 'dpr-paper-move-'))
  roots.push(root)
  mkdirSync(join(root, 'A', 'P'), { recursive: true })
  mkdirSync(join(root, 'B'), { recursive: true })
  writeFileSync(join(root, 'A', 'P', 'P.pdf'), 'pdf')
  writeFileSync(join(root, 'A', 'P', 'P.txt'), 'text')
  writeFileSync(join(root, 'A', 'P', 'P.notes.json'), '{"v":1,"notes":[]}')
  return root
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
})

test('M1 新布局整目录移动：全部产物与目录内附加内容一起搬，源目录消失', () => {
  const root = newLibrary()
  mkdirSync(join(root, 'A', 'P', 'images'))
  writeFileSync(join(root, 'A', 'P', 'images', 'figure.png'), 'image')
  const r = movePaper(root, 'A', 'P', 'B')
  assert.equal(r.fromTopic, 'A')
  assert.equal(r.toTopic, 'B')
  assert.deepEqual(r.moved.sort(), ['P.notes.json', 'P.pdf', 'P.txt'])
  assert.ok(!existsSync(join(root, 'A', 'P')))
  assert.equal(readFileSync(join(root, 'B', 'P', 'P.txt'), 'utf8'), 'text')
  assert.equal(readFileSync(join(root, 'B', 'P', 'images', 'figure.png'), 'utf8'), 'image')
})

test('M2 旧平铺布局移动时收纳为论文文件夹，笔记不丢', () => {
  const root = newLibrary()
  writeFileSync(join(root, 'A', 'L.pdf'), 'legacy')
  writeFileSync(join(root, 'A', 'L.notes.json'), 'notes')
  movePaper(root, 'A', 'L', 'B')
  assert.ok(!existsSync(join(root, 'A', 'L.pdf')))
  assert.ok(!existsSync(join(root, 'A', 'L.notes.json')))
  assert.equal(readFileSync(join(root, 'B', 'L', 'L.pdf'), 'utf8'), 'legacy')
  assert.equal(readFileSync(join(root, 'B', 'L', 'L.notes.json'), 'utf8'), 'notes')
})

test('M3 同专题 / 目标碰撞 / 路径穿越全部在写入前拒绝', () => {
  const root = newLibrary()
  assert.throws(() => movePaper(root, 'A', 'P', 'A'), (e) => e.code === 'bad-request')
  assert.throws(() => movePaper(root, 'A', 'P', '../outside'), (e) => e.status === 400)
  mkdirSync(join(root, 'B', 'P'), { recursive: true })
  writeFileSync(join(root, 'B', 'P', 'P.pdf'), 'keep-target')
  assert.throws(() => movePaper(root, 'A', 'P', 'B'), (e) => e.code === 'target-exists')
  assert.equal(readFileSync(join(root, 'A', 'P', 'P.pdf'), 'utf8'), 'pdf')
  assert.equal(readFileSync(join(root, 'B', 'P', 'P.pdf'), 'utf8'), 'keep-target')
  rmSync(join(root, 'B', 'P'), { recursive: true })
  writeFileSync(join(root, 'B', 'P.pdf'), 'flat-target')
  assert.throws(() => movePaper(root, 'A', 'P', 'B'), (e) => e.code === 'target-exists')
  assert.equal(readFileSync(join(root, 'B', 'P.pdf'), 'utf8'), 'flat-target')
})

test('M4 旧布局移动中途 EBUSY：已移文件回滚，目标空目录收口', () => {
  const root = newLibrary()
  writeFileSync(join(root, 'A', 'L.pdf'), 'legacy')
  writeFileSync(join(root, 'A', 'L.txt'), 'text')
  let calls = 0
  const injected = (from, to) => {
    calls++
    if (calls === 2) { const e = new Error('busy'); e.code = 'EBUSY'; throw e }
    renameSync(from, to)
  }
  assert.throws(() => movePaper(root, 'A', 'L', 'B', injected), (e) => e.code === 'file-busy')
  assert.equal(readFileSync(join(root, 'A', 'L.pdf'), 'utf8'), 'legacy')
  assert.equal(readFileSync(join(root, 'A', 'L.txt'), 'utf8'), 'text')
  assert.ok(!existsSync(join(root, 'B', 'L')))
})

test('M5 HTTP move-paper 与别名：移动成功、detachedSessions 与非法目标响应', async () => {
  const root = newLibrary()
  writeFileSync(join(root, 'A', 'Q.pdf'), 'q')
  let spec
  const ctx = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }
  registerRoutes(ctx, { dataDir: root })
  const server = createServer((req, res) => spec.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/paper-reader${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))
    const moved = await post('/api/library/move-paper', { topic: 'A', name: 'P', toTopic: 'B' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.topic, 'B')
    assert.equal(moved.body.detachedSessions, 0)
    assert.ok(existsSync(join(root, 'B', 'P', 'P.pdf')))
    const alias = await post('/api/library/paper/move', { topic: 'A', name: 'Q', toTopic: 'B' })
    assert.equal(alias.status, 200, JSON.stringify(alias.body))
    assert.ok(existsSync(join(root, 'B', 'Q', 'Q.pdf')))
    const escaped = await post('/api/library/move-paper', { topic: 'A', name: 'P', toTopic: '../outside' })
    assert.equal(escaped.status, 400)
  } finally { server.close() }
})

test('M6 重命名在树行内联完成，论文菜单接入移动对话框', () => {
  const client = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(client, /function InlineRename\(/)
  assert.match(client, /'data-dpr-rename': ''/)
  assert.match(client, /e\.key === 'Enter'[\s\S]{0,100}void submit\(\)/)
  assert.match(client, /e\.key === 'Escape'[\s\S]{0,100}onCancel\(\)/)
  assert.doesNotMatch(client, /renaming && createPortal/, '重命名不得再弹 portal 对话框')
  assert.match(client, /setMovingPaper\(\{ topic: p\.topic, name: p\.name \}\)/)
  assert.match(client, /h\(MovePaperDialog,/)
  assert.match(client, /collectDestinationTopics\(node\.children\)/, '移动目标必须递归包含嵌套子专题')
  assert.match(client, /topics: destinationTopics/)
})
