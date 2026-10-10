// test/library-topic-symmetry.test.mjs — PR-1 最后一轮（t7）：R12 专题侧创建/删除对称 + R14 from 放宽断言。
//
//   R12：POST /api/library/topic 改用 validateEntryName（与 rename 的 to 侧一致），
//        使「能创建的必然能删除/改名」；超长/前导点/控制字符/NUL 创建被拒且无磁盘残留。
//   R14：补一条用例钉住 rename 的 from 走 boundary（已有「丑名字」文献仍能改名）。
//
// 只 import dist/*.js（跑前 `npm run build`）；破坏性实验一律 mkdtemp 临时库，不碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-t7-home-'))
const L = await import(dist('library.js'))
const { registerRoutes } = await import(dist('host.js'))

/** 临时工作区：parent/data（文献库，含专题 T 与文献 P）。 */
function workspace() {
  const parent = mkdtempSync(join(tmpdir(), 'dpr-t7-'))
  const data = join(parent, 'data')
  mkdirSync(data, { recursive: true })
  mkdirSync(join(data, 'T'), { recursive: true })
  writeFileSync(join(data, 'T', 'P.pdf'), 'P-PDF')
  writeFileSync(join(data, 'T', 'P.txt'), 'P-TXT')
  return { parent, data }
}

async function boot(w) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: w.data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const postJson = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt }
  }
  const postRaw = async (p, body, headers) => {
    const r = await fetch(base + p, { method: 'POST', headers, body })
    const txt = await r.text()
    let json = null
    try { json = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body: json, txt }
  }
  const get = async (p) => {
    const r = await fetch(base + p)
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt }
  }
  return { srv, postJson, postRaw, get }
}

// ═══════════════════════════════════════════════════════════════════════════
// R12：专题创建/删除对称
// ═══════════════════════════════════════════════════════════════════════════

test('R12：专题创建/删除对称——合法专题（含中文）创建后逐个删除；被拒创建不产生磁盘残留', async () => {
  const w = workspace()
  const { srv, postJson, get } = await boot(w)
  try {
    // ① 合法专题：创建 → 列表可见 → 删除 → 磁盘消失
    const okTopics = ['默认专题', 'Topic A', 'normal-topic']
    for (const t of okTopics) {
      const c = await postJson('/api/library/topic', { name: t })
      assert.equal(c.status, 200, `create ${t} 应 200：${c.status} ${c.txt}`)
      assert.ok(existsSync(join(w.data, t)), `create ${t} 后目录应存在`)
    }
    // 列表可见
    const list = await get('/api/library')
    assert.equal(list.status, 200)
    for (const t of okTopics) assert.ok(list.body.topics.includes(t), `专题 ${t} 应在 topics 列表里`)
    // 逐个删除
    for (const t of okTopics) {
      const d = await postJson('/api/library/delete-topic', { topic: t })
      assert.equal(d.status, 200, `delete ${t} 应 200：${d.status} ${d.txt}`)
      assert.ok(!existsSync(join(w.data, t)), `delete ${t} 后目录应消失`)
    }

    // ② 被拒创建（超长/前导点/控制字符/NUL）不产生磁盘残留
    const badTopics = ['z'.repeat(200), '.dotTopic', 'a\u0001b', 'a\u0000b']
    for (const t of badTopics) {
      const c = await postJson('/api/library/topic', { name: t })
      assert.equal(c.status, 400, `create ${JSON.stringify(t.slice(0, 20))} 应 400：${c.status} ${c.txt}`)
      assert.ok(typeof c.body?.error === 'string' && c.body.error.length > 0, '文案可读')
      assert.ok(!existsSync(join(w.data, t)), `被拒创建 ${JSON.stringify(t.slice(0, 20))} 不得残留目录`)
    }
  } finally { srv.close() }
})

test('R12 附带：NUL 专题名创建返回 400 可读文案（不再 500）', async () => {
  const w = workspace()
  const { srv, postJson } = await boot(w)
  try {
    const r = await postJson('/api/library/topic', { name: 'a\u0000b' })
    assert.equal(r.status, 400, `NUL 专题名应 400：${r.status} ${r.txt}`)
    assert.match(r.body.error, /名字不能包含控制字符/, 'NUL 属边界类，应给可读文案')
    assert.ok(!existsSync(join(w.data, 'a\u0000b')), '不得残留目录')
  } finally { srv.close() }
})

// ═══════════════════════════════════════════════════════════════════════════
// R14：rename 的 from 走 boundary（已有「丑名字」文献仍能改名）
// ═══════════════════════════════════════════════════════════════════════════

test('R14：已有丑名字（前导点/控制字符）的文献仍能被改名（from 走 boundary）', async () => {
  const w = workspace()
  const { srv, postRaw, postJson } = await boot(w)
  const pdf = Buffer.from('X'.repeat(200))
  try {
    // 上传两个「丑名字」文献：前导点 + 非 NUL 控制字符
    const ugly = ['.hidden.pdf', 'a\u0001b.pdf']
    for (const n of ugly) {
      const up = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': 'T', 'x-dpr-name': encodeURIComponent(n) })
      assert.equal(up.status, 200, `upload ${JSON.stringify(n)} 应 200：${up.status} ${up.txt}`)
    }
    // 逐个改名：from 是丑名字（boundary 放行），to 是正常名字
    const pairs = [['.hidden', 'HiddenRenamed'], ['a\u0001b', 'CtrlRenamed']]
    for (const [from, to] of pairs) {
      const r = await postJson('/api/library/rename-paper', { topic: 'T', name: from, to })
      assert.equal(r.status, 200, `rename ${JSON.stringify(from)} → ${to} 应 200：${r.status} ${r.txt}`)
      assert.ok(existsSync(join(w.data, 'T', to + '.pdf')), `改名后 ${to}.pdf 应存在`)
      assert.ok(!existsSync(join(w.data, 'T', from + '.pdf')), `旧名 ${from}.pdf 应消失`)
    }
  } finally { srv.close() }
})

// 文献路径对称性端到端复核（上一轮 R7 已建立，这里再钉一次「上传→列表可见→删除→消失」）
test('R7 对称性复核：文献上传后列表可见、删除后磁盘消失', async () => {
  const w = workspace()
  const { srv, postRaw, get, postJson } = await boot(w)
  const pdf = Buffer.from('Y'.repeat(200))
  try {
    const name = 'SymmetryCheck.pdf'
    const up = await postRaw('/api/library/upload', pdf, { 'x-dpr-topic': 'T', 'x-dpr-name': name })
    assert.equal(up.status, 200, up.txt)
    const list = await get('/api/library')
    assert.ok(list.body.papers.some((p) => p.topic === 'T' && p.name === 'SymmetryCheck'), '上传后应列表可见')
    const del = await postJson('/api/library/delete-paper', { topic: 'T', name: 'SymmetryCheck' })
    assert.equal(del.status, 200, del.txt)
    assert.ok(!existsSync(join(w.data, 'T', 'SymmetryCheck.pdf')), '删除后磁盘应消失')
  } finally { srv.close() }
})
