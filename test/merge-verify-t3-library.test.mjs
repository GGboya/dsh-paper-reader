// test/merge-verify-t3-library.test.mjs — t3 独立验证：整合后**五条**文献管理入口的穿越防护与语义
//
// 与实现方 t2 用例的差别（方法独立性）：
//   · 快照是**逐文件 sha256 内容级**（不是 size+mtime）：库外哨兵与文献库本身都要字节级零变化；
//   · **规范化路由名**（/api/library/{delete,rename}-{topic,paper}，上游 UI 走的那套）与我们的别名
//     两侧都打同一套矩阵，且 409/503 语义在**规范化名**上单独验证（既有用例只覆盖别名）；
//   · 删除后**真的把回收站里的文件搬回去**，与删除前的 sha256 逐字节比对（可恢复性不靠"文件还在"）；
//   · 创建/删除对称性用「一批能创建的名字」闭环验证。
//
// 只 import dist/*.js；破坏性操作一律在 /tmp 临时库，绝不碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canStoreControlName, chmodBlocksRename } from './fs-probe.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
const HOME = mkdtempSync(join(tmpdir(), 'dpr-mv3-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

/* ── 夹具 ─────────────────────────────────────────────────────────────────── */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 1 /Root 1 0 R >>\n%%EOF\n', 'latin1')
const CANON = {
  deletePaper: '/api/library/delete-paper',
  renamePaper: '/api/library/rename-paper',
  deleteTopic: '/api/library/delete-topic',
  renameTopic: '/api/library/rename-topic',
  upload: '/api/library/upload',
}
const ALIAS = {
  deletePaper: '/api/library/paper/delete',
  renamePaper: '/api/library/paper/rename',
  deleteTopic: '/api/library/topic/delete',
  renameTopic: '/api/library/topic/rename',
}

let spec = null
const makeCtx = (over = {}) => ({
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => undefined },
  sessionController: { list: async () => ({ items: [] }) },
  workspaceController: {}, workspaceRegistry: {},
  effect: (fn) => fn(),
  ...over,
})
const servers = []
async function boot(dataDir, over = {}) {
  registerRoutes(makeCtx(over), { dataDir })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  srv.unref?.()
  servers.push(srv)
  return `http://127.0.0.1:${srv.address().port}/paper-reader`
}

/** 逐文件 sha256 快照（内容级；符号链接记 'L'）。 */
function snap(dir) {
  const out = {}
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) { out[p] = 'L'; continue }
      if (st.isDirectory()) { out[p] = 'D'; walk(p); continue }
      out[p] = 'F:' + createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}
const diffSnap = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])

/** 造一篇带全部派生产物的文献。 */
function scaffold(dataDir, topic, name) {
  const dir = join(dataDir, topic)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), PDF)
  for (const s of ['.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json']) writeFileSync(join(dir, name + s), `${name}${s} payload`)
  for (const v of ['-en', '-zh', '-dual']) writeFileSync(join(dir, `${name}${v}.pdf`), `${name}${v}`)
  writeFileSync(join(dir, `${name}.pdf.tmp-9988-aabbccdd`), 'tmp')
  return dir
}

/* ── 入口 1：越界矩阵（五入口 × 规范化名/别名），库外零变化 ─────────────────── */
test('V1 五入口 × 越界矩阵：规范化路由名与别名两侧全部 4xx，且库内容/库外哨兵字节级零变化', async () => {
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-mv3-data-'))
  const OUTSIDE = mkdtempSync(join(tmpdir(), 'dpr-mv3-out-'))
  mkdirSync(join(OUTSIDE, 'sentinel-dir'), { recursive: true })
  writeFileSync(join(OUTSIDE, 'sentinel.txt'), 'must stay byte-identical')
  writeFileSync(join(OUTSIDE, 'sentinel-dir', 'inner.txt'), 'must stay')
  scaffold(DATA, 'victim', 'Paper')
  scaffold(DATA, 'victim', 'Paper Long')
  const base = await boot(DATA)

  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, body, text }
  }
  const upload = async (topic, name) => {
    const r = await fetch(base + CANON.upload, {
      method: 'POST',
      headers: { 'x-dpr-topic': encodeURIComponent(topic), 'x-dpr-name': encodeURIComponent(name), 'content-type': 'application/pdf' },
      body: PDF,
    })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, body, text }
  }

  // 越界输入（我自造的一套）：**路径形状**的才进严格矩阵（含分隔符 / 就是 . 或 .. / 绝对路径 / NUL /
  // 空白 / 保留名 .trash）。URL 编码残留与裸控制字符不含分隔符，属"命名卫生"而非越界，
  // 放在 TOLERATED 里验证"要么被拒、要么可被同名删除（不留孤儿）"，见下。
  const EVIL = [
    '..', '../', '../../..', 'a/../../b', '....//....//etc', '/etc/passwd',
    join(OUTSIDE, 'sentinel.txt'), join(OUTSIDE, 'sentinel-dir'), OUTSIDE,
    'x\u0000y', 'a\\..\\..\\b', 'C:\\Windows', 'a/b', '.', '', '   ', '.trash', '.. ',
  ]
  const beforeOut = snap(OUTSIDE)
  const beforeData = snap(DATA)
  const rejected = []
  const assert4xx = (r, why) => {
    assert.ok(r.status >= 400 && r.status < 500, `${why} 必须 4xx，实得 ${r.status} ${r.text.slice(0, 200)}`)
    assert.ok(typeof r.body?.code === 'string' && r.body.code.length > 0, `${why} 必须带机器可读 code：${r.text.slice(0, 200)}`)
    assert.ok(!r.text.includes(OUTSIDE), `${why} 响应不得回显库外绝对路径`)
    rejected.push(why)
  }

  for (const x of EVIL) {
    for (const p of [CANON.deleteTopic, ALIAS.deleteTopic]) {
      assert4xx(await post(p, { topic: x, name: x, confirmName: x }), `${p} topic=${JSON.stringify(x)}`)
    }
    for (const p of [CANON.renameTopic, ALIAS.renameTopic]) {
      assert4xx(await post(p, { topic: x, name: x, to: 'zz', newName: 'zz' }), `${p} from=${JSON.stringify(x)}`)
    }
    for (const p of [CANON.deletePaper, ALIAS.deletePaper]) {
      assert4xx(await post(p, { topic: 'victim', name: x }), `${p} name=${JSON.stringify(x)}`)
      assert4xx(await post(p, { topic: x, name: 'Paper' }), `${p} topic=${JSON.stringify(x)}`)
    }
    for (const p of [CANON.renamePaper, ALIAS.renamePaper]) {
      assert4xx(await post(p, { topic: 'victim', name: 'Paper', to: x }), `${p} to=${JSON.stringify(x)}`)
      assert4xx(await post(p, { topic: x, name: 'Paper', to: 'ok' }), `${p} topic=${JSON.stringify(x)}`)
    }
    assert4xx(await upload(x, 'u.pdf'), `upload topic=${JSON.stringify(x)}`)
    assert4xx(await upload('victim', `${x}.pdf`), `upload name=${JSON.stringify(x)}`)
  }
  assert.ok(rejected.length >= 150, `越界矩阵规模（实测 ${rejected.length} 次拒绝）`)
  console.log(`  越界矩阵：${rejected.length} 次拒绝（每条 4xx + code），库/库外 sha256 零变化`)
  assert.deepEqual(diffSnap(beforeOut, snap(OUTSIDE)), [], '库外哨兵目录必须逐字节零变化')
  assert.deepEqual(diffSnap(beforeData, snap(DATA)), [], '被拒请求不得改动文献库')
  // 反证：正常请求仍能成功（矩阵不是"凡请求都拒"）
  const okDel = await post(CANON.deletePaper, { topic: 'victim', name: 'Paper' })
  assert.equal(okDel.status, 200, okDel.text)
})

/* ── 入口 1b：不含分隔符的"可疑字面名"——要么被拒，要么可被同名删除（不留孤儿） ── */
test('V1b 可疑字面名（URL 编码残留 / 裸控制字符）：不产生孤儿、库外仍零变化', async () => {
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-mv3-data1b-'))
  const OUTSIDE = mkdtempSync(join(tmpdir(), 'dpr-mv3-out1b-'))
  writeFileSync(join(OUTSIDE, 'sentinel.txt'), 'must stay')
  scaffold(DATA, 't', 'Paper')
  scaffold(DATA, 't', 'Bystander')
  const base = await boot(DATA)
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const text = await r.text(); let body = null
    try { body = JSON.parse(text) } catch { /* */ }
    return { status: r.status, body, text }
  }
  const beforeOut = snap(OUTSIDE)
  const report = []
  let i = 0
  for (const x of ['%2e%2e%2f', '..%2f..', 'x\u0001y', 'CON', 'a b']) {
    const from = `P${++i}`
    scaffold(DATA, 't', from)
    // 文献名侧：改名到一个字面名，若成功则必须能用同名删掉（创建/删除对称 → 不留孤儿）
    const r = await post(CANON.renamePaper, { topic: 't', name: from, to: x })
    report.push(`rename-paper ${from} → ${JSON.stringify(x)} : ${r.status}`)
    if (r.status === 200) {
      const d = await post(CANON.deletePaper, { topic: 't', name: x })
      report.push(`  delete-paper name=${JSON.stringify(x)} : ${d.status}`)
      assert.equal(d.status, 200, `改名成的字面名必须能删掉（否则是孤儿）：${d.text}`)
      assert.ok(!existsSync(join(DATA, 't', `${x}.pdf`)), '删掉后不得残留 .pdf')
    } else {
      assert.ok(r.status >= 400 && r.status < 500, `被拒必须是 4xx：${r.status}`)
      assert.ok(existsSync(join(DATA, 't', `${from}.pdf`)), '被拒时不得改动原文献')
    }
    // 专题侧：同一字面名要么被拒，要么用完能删（此处只记录，不作为判据）
    const t = await post(CANON.deleteTopic, { topic: x, confirmName: x })
    report.push(`  delete-topic topic=${JSON.stringify(x)} : ${t.status}`)
  }
  assert.deepEqual(diffSnap(beforeOut, snap(OUTSIDE)), [], '库外哨兵目录必须逐字节零变化')
  console.log('  可疑字面名观测：\n    ' + report.join('\n    '))
})

/* ── 入口 2：符号链接逃逸 ─────────────────────────────────────────────────── */
test('V2 符号链接：专题→库外目录、文献 .pdf→库外文件，五入口一律 4xx 且链接目标无损', async () => {
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-mv3-data2-'))
  const OUTSIDE = mkdtempSync(join(tmpdir(), 'dpr-mv3-out2-'))
  writeFileSync(join(OUTSIDE, 'sentinel.txt'), 'must stay')
  scaffold(DATA, 'vic', 'P')
  symlinkSync(OUTSIDE, join(DATA, 'evil'), 'dir')
  symlinkSync(join(OUTSIDE, 'sentinel.txt'), join(DATA, 'vic', 'link.pdf'), 'file')
  const base = await boot(DATA)
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const text = await r.text(); let body = null
    try { body = JSON.parse(text) } catch { /* */ }
    return { status: r.status, body, text }
  }
  const before = snap(OUTSIDE)
  const cases = [
    [CANON.deleteTopic, { topic: 'evil', confirmName: 'evil' }], [ALIAS.deleteTopic, { name: 'evil', confirmName: 'evil' }],
    [CANON.renameTopic, { topic: 'evil', to: 'x' }], [ALIAS.renameTopic, { name: 'evil', newName: 'x' }],
    [CANON.deletePaper, { topic: 'evil', name: 'sentinel' }], [CANON.deletePaper, { topic: 'vic', name: 'link' }],
    [CANON.renamePaper, { topic: 'vic', name: 'link', to: 'z' }],
  ]
  for (const [p, body] of cases) assert.ok((await post(p, body)).status >= 400, `${p} ${JSON.stringify(body)} 必须被拒`)
  const up = await fetch(base + CANON.upload, {
    method: 'POST',
    headers: { 'x-dpr-topic': encodeURIComponent('evil'), 'x-dpr-name': encodeURIComponent('u.pdf'), 'content-type': 'application/pdf' },
    body: PDF,
  })
  assert.ok(up.status >= 400, 'upload 到符号链接专题必须被拒')
  assert.deepEqual(diffSnap(before, snap(OUTSIDE)), [], '符号链接目标（库外）必须零变化')
  assert.ok(lstatSync(join(DATA, 'evil')).isSymbolicLink(), '链接本身必须还在（只拒绝、不销毁）')
})

/* ── 入口 3：回收站可恢复 + .pdf 最后移 + 精确 stem + manifest ─────────────── */
test('V3 删除语义：整批产物进 .trash、.pdf 最后移、manifest 可读、**搬回来逐字节等于删除前**', async () => {
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-mv3-data3-'))
  scaffold(DATA, 't', 'Attention')
  scaffold(DATA, 't', 'Attention Is All You Need')
  scaffold(DATA, 't', 'Attention2')
  const base = await boot(DATA)
  const before = snap(join(DATA, 't'))
  const r = await fetch(base + CANON.deletePaper, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 't', name: 'Attention' }),
  })
  const body = await r.json()
  assert.equal(r.status, 200, JSON.stringify(body))
  assert.equal(body.moved[body.moved.length - 1], 'Attention.pdf', '`.pdf` 必须最后移（失败时文献仍在库里可见）')
  assert.ok(body.moved.includes('Attention-dual.pdf') && body.moved.includes('Attention.mineru.json'), '派生产物整批移走')
  assert.ok(body.moved.some((f) => f.includes('.tmp-')), '在途临时文件也要移走')
  // 精确 stem：同前缀的其他文献一个字节都不许变
  // 快照 key 是**绝对路径**：win32 上是反斜杠，原先写死 '/' 的正则在 Windows 上永不命中 ⇒ 过滤不掉
  // 本文件的产物、断言必红（CI run 38193897047 的 V3）。改用 basename（跨平台且更严格）。
  const isAttention = (p) => /^Attention([.-]|$)/.test(String(p).split(/[\\/]/).pop())
  // 回归护栏：过滤器不得依赖路径分隔符（快照 key 在 win32 上是反斜杠。CI run 38193897047 的 V3 就是
  // 写死 '/' 的版本在 Windows 上永不命中）。这两行在任何平台都能把「改回写死 '/'」的变异判红。
  assert.ok(isAttention('C:\\data\\t\\Attention-dual.pdf'), 'isAttention 必须认 win32 反斜杠绝对路径')
  assert.ok(!isAttention('C:\\data\\t\\Attention Is All You Need.pdf'), '同前缀的其它文献不得被误过滤')
  assert.ok(!isAttention('/data/t/Attention2.mineru.json'), 'Attention2 不得被误过滤')
  const afterRest = Object.fromEntries(Object.entries(snap(join(DATA, 't'))).filter(([k]) => !isAttention(k)))
  const beforeRest = Object.fromEntries(Object.entries(before).filter(([k]) => !isAttention(k)))
  assert.deepEqual(afterRest, beforeRest, '精确 stem：不得连带 Attention Is All You Need / Attention2')
  // 回收站 + manifest
  const trash = join(DATA, body.trashRel)
  assert.ok(existsSync(join(trash, 'manifest.json')), '回收站必须有 manifest.json')
  const manifest = JSON.parse(readFileSync(join(trash, 'manifest.json'), 'utf8'))
  assert.ok(Array.isArray(manifest.files ?? manifest.moved ?? Object.values(manifest)) || typeof manifest === 'object', 'manifest 必须可读')
  for (const f of body.moved) assert.ok(existsSync(join(trash, f)), `${f} 必须真的在回收站里`)
  // **搬回来**（恢复）后必须与删除前逐字节一致
  const restored = {}
  for (const f of body.moved) {
    const src = join(trash, f)
    const dst = join(DATA, 't', f)
    renameSync(src, dst)
    restored[join(DATA, 't', f)] = 'F:' + createHash('sha256').update(readFileSync(dst)).digest('hex')
  }
  for (const [p, h] of Object.entries(restored)) assert.ok(before[p] === h || before[p + '.pdf'] === h, `恢复后的 ${p} 必须与删除前逐字节一致`)
  assert.equal(Object.keys(before).length, Object.keys(snap(join(DATA, 't'))).length, '恢复后文件集合与删除前一致')
})

/* ── 入口 4：409/503 在**规范化路由名**上也成立 ────────────────────────────── */
test('V4 规范化路由名上的 409/503：运行中会话、无法确认的会话状态、翻译中', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root 环境下不可写目录用例不适用')
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-mv3-data4-'))
  scaffold(DATA, 'sess', 'S')
  scaffold(DATA, 'sess2', 'S2')
  const running = [{ id: 'x1', topic: 'sess', name: 'S', status: 'running' }]
  void running
  // 与该文献 id 前缀匹配的会话（前缀算法与 host 一致；见 sessionPrefixFor）
  const fakeSession = (topic, name, n = 1, isRunning = true) => ({
    sessionId: `dpr-${Buffer.from(`${topic}/${name}`).toString('base64url')}-${n}`,
    updatedAt: Date.now(), running: isRunning, blank: false,
  })
  let sessions = [fakeSession('sess', 'S', 1, true), fakeSession('sess', 'S', 2, false)]
  let mode = 'running'
  const base = await boot(DATA, {
    sessionController: {
      list: async () => {
        if (mode === 'throw') throw new Error('controller down')
        return { items: mode === 'running' ? sessions : [] }
      },
    },
  })
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const text = await r.text(); let body = null
    try { body = JSON.parse(text) } catch { /* */ }
    return { status: r.status, body, text }
  }
  const before = snap(DATA)
  const del = await post(CANON.deletePaper, { topic: 'sess', name: 'S' })
  assert.equal(del.status, 409); assert.equal(del.body.code, 'session-running')
  assert.equal(del.body.sessions.running, 1, '响应要如实回报 running 数')
  const ren = await post(CANON.renamePaper, { topic: 'sess', name: 'S', to: 'X' })
  assert.equal(ren.status, 409); assert.equal(ren.body.code, 'session-running')
  const tdel = await post(CANON.deleteTopic, { topic: 'sess', confirmName: 'sess' })
  assert.equal(tdel.status, 409)
  assert.ok(['topic-not-empty', 'session-running'].includes(tdel.body.code), `专题删除被拒：${tdel.text}`)
  const tren = await post(CANON.renameTopic, { topic: 'sess', to: 'sess-x' })
  assert.equal(tren.status, 409); assert.equal(tren.body.code, 'session-running')
  assert.deepEqual(diffSnap(before, snap(DATA)), [], '被 409 拒绝时盘上必须零变化')

  // 会话状态无法确认 → 503 session-unknown（宁可拒绝也不误删）
  mode = 'throw'
  const unknown = await post(CANON.deletePaper, { topic: 'sess2', name: 'S2' })
  assert.equal(unknown.status, 503, unknown.text)
  assert.equal(unknown.body.code, 'session-unknown')

  // 翻译进行中 → 409 translation-busy（假 babeldoc 造真 busy，不做任何真实翻译）
  mode = 'none'
  const TX = mkdtempSync(join(tmpdir(), 'dpr-mv3-tx-'))
  const txData = join(TX, 'data')
  const pidFile = join(TX, 'pid')
  process.env.MV3_TX_PIDFILE = pidFile
  mkdirSync(join(txData, 'tx'), { recursive: true })
  writeFileSync(join(txData, 'tx', 'paper.pdf'), PDF)
  writeFileSync(join(txData, 'tx', 'paper.txt'), 'cache')
  const binPath = join(TX, '.venv-pdf2zh', 'bin', 'babeldoc')
  mkdirSync(join(TX, '.venv-pdf2zh', 'bin'), { recursive: true })
  // 假 babeldoc：`sleep 30`（不是 120）是**兜底**——pidfile 竞态导致 kill 打空时，文件也能在 30s 内
  // 自行退出（< 60s 的 --test-timeout），不会像 CI run 38193897047 的 macOS 那样整文件超时。
  writeFileSync(binPath, '#!/bin/sh\ncase "$1" in\n  --version) echo "babeldoc fake 1.0"; exit 0 ;;\n  --help) echo "--no-watermark --skip-figure-text"; exit 0 ;;\n  *) echo $$ > "$MV3_TX_PIDFILE"; exec sleep 30 ;;\nesac\n')
  chmodSync(binPath, 0o755)
  const txBase = await boot(txData)
  const { startTranslation, zhStatus } = await import(pathToFileURL(dist('translate.js')).href)
  const { resolvePaper } = await import(pathToFileURL(dist('library.js')).href)
  const ref = resolvePaper(txData, { topic: 'tx', name: 'paper' })
  const started = await startTranslation(ref, txData, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' })
  assert.equal(started.started, true, JSON.stringify(started))
  assert.equal(zhStatus(ref).busy, true)
  const txPost = async (p, obj) => {
    const r = await fetch(txBase + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const text = await r.text(); let body = null
    try { body = JSON.parse(text) } catch { /* */ }
    return { status: r.status, body, text }
  }
  const tdel2 = await txPost(CANON.deletePaper, { topic: 'tx', name: 'paper' })
  assert.equal(tdel2.status, 409, tdel2.text); assert.equal(tdel2.body.code, 'translation-busy')
  const tren2 = await txPost(CANON.renamePaper, { topic: 'tx', name: 'paper', to: 'paper2' })
  assert.equal(tren2.status, 409, tren2.text); assert.equal(tren2.body.code, 'translation-busy')
  assert.ok(existsSync(join(txData, 'tx', 'paper.pdf')), '被拒后文献仍在')
  assert.ok(!existsSync(join(txData, 'tx', 'paper-zh.pdf')), '不得产出译文')
  // 「制造翻译中」这条路在**本平台能否真的跑起来**是平台能力，实测决定（不硬编码平台）：
  //   · POSIX：产品按 <dataDir>/../.venv-pdf2zh/bin/babeldoc 找到我们造的 sh 假引擎并执行 → 会留下
  //     `sleep` 子进程（macOS 上那个 pidfile 竞态就是它撑住 event loop）；
  //   · Win32：产品按 venv 约定只找 `Scripts/babeldoc.exe`（真实 PE），我们的 sh 脚本**既不在它的搜索位、
  //     也无法执行** ⇒ 根本没有子进程要清，产品停在引擎解析/自动安装阶段（`busy` 仍为真 —— CI run
  //     38195117216 的 windows 实测就是这个状态；t17 加的「必须留下 pidfile」断言在那里恒假，本次修）。
  //     注意：`src/translate.ts` 里 `findBabeldoc` 的引擎路径是**产品约定**，且该文件携带用户未提交的
  //     NO_PROXY 修复（本任务 Out-of-scope），所以不去给产品加注入 seam，改用实测能力 + 等价断言。
  const canRunFakeEngine = spawnSync(binPath, ['--version'], { encoding: 'utf8' }).status === 0
  if (canRunFakeEngine) {
    // 等 pidfile 出现再 kill：脚本「先写 pid 再 exec sleep」，但 spawn→shell→落盘要几毫秒；macOS 上这个
    // 竞态会让 kill 打空 → sleep 子进程留下来把整个文件的 event loop 撑到 60s 超时（CI run 38193897047
    // 的 macOS「所有子用例 ok 但文件 timeout」正是它）。这里轮询最多 5s。
    const killTxChild = () => {
      if (!existsSync(pidFile)) return false
      const pid = readFileSync(pidFile, 'utf8').trim()
      if (!/^\d+$/.test(pid)) return false
      try { process.kill(+pid, 'SIGKILL') } catch { /* 已退出 */ }
      return true
    }
    const deadline = Date.now() + 5000
    while (!killTxChild() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    assert.ok(existsSync(pidFile), '假 babeldoc 必须已启动并写下 pid（否则上面的 busy 断言无从谈起）')
  } else {
    t.diagnostic('本平台执行不了假引擎（Win32 按 Scripts/babeldoc.exe 找真实可执行文件）⇒ 无 sleep 子进程可清；'
      + '改为验同一条「翻译中」语义：busy 一直为真、再次删除仍 409 translation-busy、文件零改动')
    assert.equal(zhStatus(ref).busy, true, '等价断言：此刻必须仍是「翻译中」')
    const again = await txPost(CANON.deletePaper, { topic: 'tx', name: 'paper' })
    assert.equal(again.status, 409, again.text)
    assert.equal(again.body.code, 'translation-busy')
    assert.equal(zhStatus(ref).busy, true, '等价断言：被拒之后仍是「翻译中」（没被误清）')
    assert.ok(existsSync(join(txData, 'tx', 'paper.pdf')), '等价断言：被拒之后文献本体仍在、零改动')
  }
})

// 文件级兜底：任何用例失败都不许把翻译子进程留下撑住 event loop
test.after(() => {
  const pidFile = process.env.MV3_TX_PIDFILE
  if (!pidFile || !existsSync(pidFile)) return
  const pid = readFileSync(pidFile, 'utf8').trim()
  if (/^\d+$/.test(pid)) { try { process.kill(+pid, 'SIGKILL') } catch { /* 已退出 */ } }
})

/* ── 入口 5：创建/删除对称 + 畸形体 + 历史遗留名（PR-1 三处收口） ──────────── */
test('V5 创建/删除对称（规范化路由名）、畸形 JSON 体 4xx、历史遗留专题名可删，`.trash` 是保留名', async (t) => {
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-mv3-data5-'))
  const base = await boot(DATA)
  const post = async (p, obj, raw) => {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: raw !== undefined ? raw : JSON.stringify(obj),
    })
    const text = await r.text(); let body = null
    try { body = JSON.parse(text) } catch { /* */ }
    return { status: r.status, body, text }
  }
  // 畸形体：一律可读 4xx，不能是外层兜底 500，不能带堆栈
  for (const raw of ['{ not json', 'null', '"str"', '[1,2]', '', 'undefined']) {
    for (const p of [CANON.deletePaper, CANON.deleteTopic, CANON.renamePaper, CANON.renameTopic]) {
      const r = await post(p, null, raw)
      assert.ok(r.status >= 400 && r.status < 500, `${p} 畸形体 ${JSON.stringify(raw)} → ${r.status}（必须 4xx）`)
      assert.ok(typeof r.body?.code === 'string', `${p} 必须带 code：${r.text.slice(0, 120)}`)
      assert.ok(!/at .*\.js:\d+/.test(r.text), '响应不得含堆栈')
    }
  }
  // 命名不规范的创建一律 4xx；**凡能创建的必然能删掉**（对称性）
  for (const bad of ['.hidden', 'a'.repeat(300), 'x\u0000y', 'a/b', '..', '', '   ']) {
    const r = await post('/api/library/topic', { name: bad })
    assert.ok(r.status >= 400 && r.status < 500, `创建 ${JSON.stringify(bad)} 必须 4xx`)
    assert.equal(r.body.code, 'bad-name')
  }
  const created = ['sym-a', '点号.名', 'with space', 'UPPER_case-1', '中文专题']
  for (const name of created) {
    const c = await post('/api/library/topic', { name })
    assert.equal(c.status, 200, `创建 ${JSON.stringify(name)}：${c.text}`)
    const d = await post(CANON.deleteTopic, { topic: name, confirmName: name })
    assert.equal(d.status, 200, `能创建的 ${JSON.stringify(name)} 必须能用规范化路由名删掉：${d.text}`)
    assert.ok(!existsSync(join(DATA, name)))
  }
  // 历史遗留（写入路径造不出来）的专题名必须能删；`.trash` 不能当专题删/改名
  mkdirSync(join(DATA, '.legacy'), { recursive: true })
  // 0x00-0x1F 能否落在文件名里是**文件系统能力**（Win32 路径层直接 ENOENT）→ 实测决定跑不跑这半段，
  // 不硬编码平台（CI run 38193897047 的 V5 就是这条 mkdir 报 ENOENT）。
  const ctrlName = canStoreControlName(DATA) ? 'weird\u0001name' : null
  if (ctrlName) mkdirSync(join(DATA, ctrlName), { recursive: true })
  else t.diagnostic('本机文件系统禁止 0x01 出现在文件名里（Win32 路径层）→ 跳过「控制字符历史专题名」半段，其余断言照跑')
  assert.equal((await post(CANON.deleteTopic, { topic: '.legacy', confirmName: '.legacy' })).status, 200)
  if (ctrlName) assert.equal((await post(CANON.deleteTopic, { topic: ctrlName, confirmName: ctrlName })).status, 200)
  mkdirSync(join(DATA, '.trash'), { recursive: true })
  const tr = await post(CANON.deleteTopic, { topic: '.trash', confirmName: '.trash' })
  assert.equal(tr.status, 400); assert.equal(tr.body.code, 'bad-name')
  assert.ok(existsSync(join(DATA, '.trash')), '回收站目录本身绝不能被当专题删掉')
  // 非空专题：409 topic-not-empty，且 confirmName 必须一致（UI 两段式确认接的是我们的删除计划）
  scaffold(DATA, 'nonempty', 'P')
  // confirmName 在 delete-topic 上是**可选**栅栏（契约：host.ts:688-698）：给了才校验一致性；
  // 没给就照走全部前置 → 非空专题一律 409 topic-not-empty（我们的加固，比上游「一点递归删光」保守）。
  // 重排到合并后的 main 时这里是本功能唯一一处与现行契约不符的期望值（旧写成 400 confirm-mismatch）。
  const noConfirm = await post(CANON.deleteTopic, { topic: 'nonempty' })
  assert.equal(noConfirm.status, 409, noConfirm.text); assert.equal(noConfirm.body.code, 'topic-not-empty')
  assert.ok(existsSync(join(DATA, 'nonempty', 'P.pdf')), '被拒时一个文件都不能动')
  const mismatch = await post(CANON.deleteTopic, { topic: 'nonempty', confirmName: 'NonEmpty' })
  assert.equal(mismatch.status, 400); assert.equal(mismatch.body.code, 'confirm-mismatch')
  assert.ok(existsSync(join(DATA, 'nonempty', 'P.pdf')), '被拒时一个文件都不能动')
  const nonEmpty = await post(CANON.deleteTopic, { topic: 'nonempty', confirmName: 'nonempty' })
  assert.equal(nonEmpty.status, 409); assert.equal(nonEmpty.body.code, 'topic-not-empty')
  assert.ok(existsSync(join(DATA, 'nonempty', 'P.pdf')), '被拒时一个文件都不能动')
})

/* ── 入口 6：移动失败时不销毁数据（「失败不回退 unlink」） ──────────────────── */
test('V6 回收站移动失败：报错且**一个文件都不少**（绝不回退成 unlink 销毁）', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root 环境下目录只读无效')
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-mv3-data6-'))
  scaffold(DATA, 'ro', 'Locked')
  const base = await boot(DATA)
  const before = snap(join(DATA, 'ro'))
  // 注入方式按**本机实测**能力选（不硬编码平台）：
  //   · chmod 0o555 真能挡住 rename 的平台（POSIX）：保留「中途失败」这条真实路径（原断言不变）；
  //   · chmod 只映射只读位、挡不住 rename 的平台（Windows，CI run 38193897047 的 V6 就是它）：
  //     换成**平台中立**注入 —— 把 `.trash` 写成普通文件，bundle 的 mkdir 必然 ENOTDIR 失败。
  const chmodBlocks = chmodBlocksRename(DATA)
  if (chmodBlocks) chmodSync(join(DATA, 'ro'), 0o555) // 目录不可写 → rename 进回收站必然失败
  else {
    t.diagnostic('本机 chmod 不阻止 rename（Windows 只读位语义）→ 改用「.trash 是普通文件」的平台中立注入')
    writeFileSync(join(DATA, '.trash'), 'not-a-directory')
  }
  try {
    const r = await fetch(base + CANON.deletePaper, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'ro', name: 'Locked' }),
    })
    const text = await r.text()
    assert.ok(r.status >= 400, `移动失败必须报错而不是假装成功：${r.status} ${text.slice(0, 160)}`)
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON 时上面的断言已经说话 */ }
    assert.equal(body?.code, 'trash-move-failed', `失败必须带机器可读 code：${text.slice(0, 200)}`)
  } finally {
    if (chmodBlocks) chmodSync(join(DATA, 'ro'), 0o755)
  }
  assert.deepEqual(diffSnap(before, snap(join(DATA, 'ro'))), [], '失败路径上任何文件都不许消失/被改（不得回退成 unlink）')
  assert.ok(existsSync(join(DATA, 'ro', 'Locked.pdf')), '文献本体必须还在')
})
