// test/library-traversal.test.mjs — 文献管理 CRUD 路径穿越修复的回归测试（零依赖，node:test）。
//
// 覆盖（对照 t10 acceptance）：
//   · deleteTopic / deletePaper / renameTopic 越界输入被拒，库外零变化（递归快照逐字节比对）
//   · 符号链接指向库外被 realpath 层拒绝
//   · 合法删除/重命名（中文专题、空格、-/_/. 名、大小写改名、精确 stem）零回归
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。
// 破坏性用例一律在 mkdtemp 临时目录里做，绝不触碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-t10-home-')) // 隔离 agent preset 安装，不碰真实 home
const L = await import(dist('library.js'))
const { registerRoutes } = await import(dist('host.js'))

/** 递归快照：相对路径 → 内容/类型。用于证明「盘上零变化」。 */
function snap(dir) {
  const out = {}
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { out[r] = '[dir]'; walk(p, r) }
      else if (e.isSymbolicLink()) { out[r] = '[symlink]' }
      else { out[r] = readFileSync(p, 'utf8') }
    }
  }
  walk(dir, '')
  return out
}

/** 临时工作区：parent/data（文献库）+ parent/sentinel（库外哨兵）。 */
function workspace() {
  const parent = mkdtempSync(join(tmpdir(), 'dpr-t10-'))
  const data = join(parent, 'data')
  const sentinel = join(parent, 'sentinel')
  mkdirSync(data, { recursive: true })
  mkdirSync(sentinel, { recursive: true })
  return { parent, data, sentinel }
}

test('deleteTopic：越界/非法 topic 全部拒绝，库外与兄弟专题零变化', () => {
  const { parent, data, sentinel } = workspace()
  writeFileSync(join(sentinel, 'keep.txt'), 'KEEP-1')
  mkdirSync(join(data, 'topicA'), { recursive: true })
  writeFileSync(join(data, 'topicA', 'P.pdf'), 'P')
  const before = snap(parent)
  const evil = ['../sentinel', '../../..', 'a/../b', '/absolute/path/here', '.', '..', '', 'a\\b', '..\\sentinel']
  for (const t of evil) {
    assert.throws(() => L.deleteTopic(data, t), /名字|路径/, `deleteTopic(${JSON.stringify(t)}) 应被拒`)
  }
  assert.deepEqual(snap(parent), before, '所有被拒操作后库外/库内都不得变化')
})

test('deletePaper：越界 topic 与越界 name 拒绝，库外零变化', () => {
  const { parent, data, sentinel } = workspace()
  writeFileSync(join(sentinel, 'Victim.pdf'), 'V1')
  writeFileSync(join(sentinel, 'Victim.txt'), 'V2')
  mkdirSync(join(data, 'topicA'), { recursive: true })
  const before = snap(parent)
  assert.throws(() => L.deletePaper(data, '../sentinel', 'Victim'), /名字|路径/)
  assert.throws(() => L.deletePaper(data, 'topicA', '../x'), /名字|路径/)
  assert.deepEqual(snap(parent), before)
})

test('renameTopic：越界 from 与越界 to 拒绝，库外零变化', () => {
  const { parent, data, sentinel } = workspace()
  writeFileSync(join(sentinel, 'keep.txt'), 'KEEP')
  mkdirSync(join(data, 'topicA'), { recursive: true })
  const before = snap(parent)
  assert.throws(() => L.renameTopic(data, '../sentinel', 'hijacked'), /名字|路径/)
  assert.throws(() => L.renameTopic(data, 'topicA', '../evil'), /名字|路径/)
  assert.deepEqual(snap(parent), before)
})

test('符号链接逃逸被 realpath 层拒绝，库外零变化', () => {
  const { parent, data, sentinel } = workspace()
  writeFileSync(join(sentinel, 'Victim.pdf'), 'V1')
  writeFileSync(join(sentinel, 'Victim.txt'), 'V2')
  symlinkSync(sentinel, join(data, 'evil')) // data/evil → 库外 sentinel
  const before = snap(parent)
  assert.throws(() => L.deleteTopic(data, 'evil'), /路径越界/, 'deleteTopic 对库外符号链接专题应拒')
  assert.throws(() => L.deletePaper(data, 'evil', 'Victim'), /路径越界/, 'deletePaper 对库外符号链接专题应拒')
  assert.throws(() => L.renameTopic(data, 'evil', 'hijacked'), /路径越界/, 'renameTopic 对库外符号链接专题应拒')
  assert.deepEqual(snap(parent), before)
})

test('正常功能零回归：中文专题、空格与 .-_ 名、大小写改名、精确 stem', () => {
  const { data } = workspace()
  const topic = '默认专题'
  const dir = join(data, topic)
  mkdirSync(dir, { recursive: true })
  for (const name of ['Attention', 'Attention Is All You Need']) {
    for (const suf of ['.pdf', '.txt', '.pages.json', '-zh.pdf', '-dual.pdf', '.study.json']) {
      writeFileSync(join(dir, name + suf), `${name}${suf}`)
    }
  }
  // 精确 stem：删 Attention 不误删兄弟文献 Attention Is All You Need
  const deleted = L.deletePaper(data, topic, 'Attention').sort()
  assert.deepEqual(deleted, [
    'Attention-dual.pdf', 'Attention-zh.pdf', 'Attention.pages.json', 'Attention.pdf', 'Attention.study.json', 'Attention.txt',
  ].sort())
  assert.ok(existsSync(join(dir, 'Attention Is All You Need.pdf')), '兄弟文献不得被误删')
  assert.ok(existsSync(join(dir, 'Attention Is All You Need.txt')))

  // 中文专题改名
  L.renameTopic(data, topic, '默认专题 2')
  assert.ok(existsSync(join(data, '默认专题 2', 'Attention Is All You Need.pdf')))
  assert.ok(!existsSync(join(data, topic)))

  // 含空格 / - / _ / . 的文献名改名
  const r1 = L.renamePaper(data, '默认专题 2', 'Attention Is All You Need', 'Renamed-2.0_new')
  assert.ok(r1.length >= 1)
  assert.ok(existsSync(join(data, '默认专题 2', 'Renamed-2.0_new.pdf')))

  // 大小写改名（Linux 大小写敏感）
  writeFileSync(join(data, '默认专题 2', 'CaseA.pdf'), 'case')
  const r2 = L.renamePaper(data, '默认专题 2', 'CaseA', 'casea')
  assert.ok(r2.includes('CaseA.pdf'))
  assert.ok(existsSync(join(data, '默认专题 2', 'casea.pdf')))
})

test('路由层：越界 topic 返回 400 可读文案，且不泄露 dataDir 绝对路径', async () => {
  const { parent, data, sentinel } = workspace()
  writeFileSync(join(sentinel, 'keep.txt'), 'KEEP')
  const before = snap(parent)
  let spec = null
  const ctx = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {},
    workspaceRegistry: {},
    effect: (fn) => fn(),
  }
  registerRoutes(ctx, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
    const r = await fetch(base + '/api/library/delete-topic', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '../sentinel' }),
    })
    const body = await r.json()
    assert.equal(r.status, 400, `越界请求应 400 而非 500：${r.status} ${JSON.stringify(body)}`)
    assert.match(body.error ?? '', /名字|路径/, '错误文案应可读')
    assert.ok(!JSON.stringify(body).includes(data), '响应不得泄露 dataDir 绝对路径')
  } finally { srv.close() }
  assert.deepEqual(snap(parent), before, '被拒请求后库外不得有任何变化')
})
