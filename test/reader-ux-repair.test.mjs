// test/reader-ux-repair.test.mjs — t6 合并修复的验收用例（两轮 findings：t3 的 F1/F2/F3/O2 + t4 的 R4-F1~F4）。
//
// 覆盖：
//   T1 rename 的 `$` 替换模式注入（不许产生孤儿文件）
//   T2 回收站目录创建失败 → 有 code、不泄露绝对路径、零 unlink
//   T3 文献 `.pdf` 是符号链接 → 404（不是 500），库外内容无损
//   T4 `/api/transcribe` 的 path 边界（≥6 种恶意输入）+ 库内绝对路径仍可用
//   T5 upload 的 topic 边界（≥6 种恶意输入，含符号链接专题）
//   T6 确认弹窗「不删清单」与 delete-plan 同源（静态断言）
//   T7 会话查证 fail-closed（查不到就拒绝，503 + code=session-unknown）
//   T8 契约 R5 并发互斥：同一篇文献在途时第二个请求 409 busy
//   T9 上一轮不变式复跑：穿越输入全 4xx、`.pdf` 最后移、回收站可恢复、零 unlink
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。
// 破坏性用例一律在**临时库**里做（绝不动 ~/.dsh-paper-reader/data）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
const HOME = mkdtempSync(join(tmpdir(), 'dpr-repair-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(dist('host.js'))
const { renamedName, newTrashBundle, ManageError } = await import(dist('library-manage.js'))

/** 零依赖 PDF；行数够多时 pdfjs 转录能过 1000 字符门槛。 */
function buildPdf(pages) {
  const objs = [null, null]
  const pn = []
  const cn = []
  for (let i = 0; i < pages.length; i++) { pn.push(objs.length + 1); objs.push(null); cn.push(objs.length + 1); objs.push(null) }
  const fn = objs.length + 1
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const set = (n, b) => { objs[n - 1] = b }
  set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  set(2, `<< /Type /Pages /Kids [${pn.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  for (let i = 0; i < pages.length; i++) {
    set(pn[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${cn[i]} 0 R /Resources << /Font << /F1 ${fn} 0 R >> >> >>`)
    let s = ''
    let y = 740
    for (const [size, text] of pages[i]) {
      s += `BT /F1 ${size} Tf 72 ${y} Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET\n`
      y -= size + 14
    }
    set(cn[i], `<< /Length ${s.length} >>\nstream\n${s}endstream`)
  }
  let out = '%PDF-1.4\n'
  const off = []
  for (let i = 0; i < objs.length; i++) { off.push(out.length); out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n` }
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of off) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const lineTag = (i) => Array.from({ length: 4 + (i % 4) }, (_, k) => String.fromCharCode(97 + ((i * 7 + k) % 26))).join('')
const lines = (prefix, count) => Array.from({ length: count }, (_, i) => [12, `${prefix} sentence ${lineTag(i)} with enough extractable text to exceed the one thousand character threshold reliably.`])
const PDF_TEXT = () => buildPdf([[[22, 'Repair Fixture'], ...lines('Page one', 14), [12, 'Page one keyword locality here.']]])

/* ── 递归快照：路径 → size|mtimeMs（用于证明「盘上零变化」） ────────────────── */
function snap(dir) {
  const out = {}
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      let st
      try { st = lstatSync(p) } catch { continue }
      out[p] = `${st.isSymbolicLink() ? 'L' : st.isDirectory() ? 'D' : 'F'}:${st.size}:${st.mtimeMs}`
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p)
    }
  }
  walk(dir)
  return out
}
const diffSnap = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])

/* ── host 路由挂到真实 http server ───────────────────────────────────────── */
let spec = null
let sessionImpl = async () => ({ items: [] })
const makeCtx = (over = {}) => ({
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => undefined },
  sessionController: { list: (req, sig) => sessionImpl(req, sig) },
  workspaceController: {},
  workspaceRegistry: {},
  effect: (fn) => fn(),
  ...over,
})
async function boot(over = {}) {
  registerRoutes(makeCtx(over), { dataDir: DATA })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const api = async (p, opts) => {
    const r = await fetch(base + p, opts)
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, body, text }
  }
  const postJson = (p, obj) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
  return { srv, base, api, postJson }
}

const DATA = mkdtempSync(join(tmpdir(), 'dpr-repair-data-'))
const OUTSIDE = mkdtempSync(join(tmpdir(), 'dpr-repair-out-'))
let LIVE = null
await (async () => { LIVE = await boot() })()
const api = (p, o) => LIVE.api(p, o)
const postJson = (p, o) => LIVE.postJson(p, o)

/** 在临时库里造一篇「10 个产物」的文献。 */
function scaffold(topic, name) {
  const dir = join(DATA, topic)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), PDF_TEXT())
  for (const s of ['.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json']) writeFileSync(join(dir, name + s), 'x')
  writeFileSync(join(dir, `${name}-zh.pdf`), 'zh')
  writeFileSync(join(dir, `${name}-dual.pdf`), 'dual')
  writeFileSync(join(dir, `${name}.txt.tmp-1234-abcd1234`), 'tmp')
  return dir
}

/* ── T1 rename 的 `$` 替换模式（t3-F2：唯一会造孤儿文件的缺陷） ───────────── */
test('T1 rename：newName 含 $&/$`/$\' 不被替换模式展开——stem 一致、响应与磁盘一致、能按新名删除', async () => {
  // 纯函数层
  assert.equal(renamedName('P.mineru.json', 'P', "X$&Y"), "X$&Y.mineru.json")
  assert.equal(renamedName("A$'B.pdf", 'P', "X$&Y"), "A$'B.pdf", '前缀不匹配时原样返回，不做替换')

  for (const newName of ["Strange$&Name", "Strange$'Name", 'Strange$`Name', 'Strange$1Name']) {
    const topic = `t1-${newName.replace(/[^A-Za-z]/g, '')}`
    const dir = scaffold(topic, 'Plain')
    const r = await postJson('/api/library/paper/rename', { topic, name: 'Plain', newName })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.to, newName)
    // (a) 10 个产物的**后缀集合**必须与改名前一模一样（即 stem 唯一 = newName；无孤儿、无缺失）
    const files = readdirSync(dir).sort()
    const expected = ['-dual.pdf', '-zh.pdf', '.embeddings.json', '.mineru.json', '.mineru.md', '.pages.json', '.pdf', '.transcript.json', '.txt', '.txt.tmp-1234-abcd1234'].sort()
    assert.deepEqual(
      files.map((f) => f.slice(newName.length)).sort(),
      expected,
      `产物后缀集合必须与改名前一致（stem 全等于 newName）：实际 ${JSON.stringify(files)}`,
    )
    for (const f of files) assert.ok(f.startsWith(newName), `${f} 的 stem 不是 newName`)
    // (b) 响应 to 与磁盘一致
    assert.ok(existsSync(join(dir, `${newName}.pdf`)))
    // (c) 能再按新名正常删除（无孤儿）
    const del = await postJson('/api/library/paper/delete', { topic, name: newName })
    assert.equal(del.status, 200, del.text)
    assert.equal(del.body.moved.length, 10, `应移走全部 10 个产物：${JSON.stringify(del.body.moved)}`)
    assert.equal(del.body.moved[del.body.moved.length - 1], `${newName}.pdf`, '.pdf 必须最后移')
    assert.deepEqual(readdirSync(dir), [], '专题目录里不应留下任何孤儿文件')
  }
})

/* ── T2 回收站目录创建失败：有 code、不泄露绝对路径、零 unlink ────────────── */
test('T2 回收站不可创建：500 + code=trash-move-failed、响应不含绝对路径、文件一个不少', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root 会绕过权限/类型检查，本用例无意义')
  // 用「.trash 是普通文件」精确注入 mkdir 失败（比权限更稳，不受 umask 影响）
  const tmp = mkdtempSync(join(tmpdir(), 'dpr-repair-trash-'))
  const dataDir = join(tmp, 'data')
  mkdirSync(join(dataDir, 't'), { recursive: true })
  writeFileSync(join(dataDir, 't', 'p.pdf'), PDF_TEXT())
  writeFileSync(join(dataDir, 't', 'p.txt'), 'cache')
  writeFileSync(join(dataDir, '.trash'), 'blocker') // ← 不是目录
  const saved = spec
  try {
    registerRoutes(makeCtx(), { dataDir })
    const srv = createServer((req, res) => spec.handler(req, res))
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
    const before = snap(dataDir)
    const res = await fetch(`${base}/api/library/paper/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 't', name: 'p' }),
    })
    const text = await res.text()
    const body = JSON.parse(text)
    assert.equal(res.status, 500, text)
    assert.equal(body.code, 'trash-move-failed', `必须有机器可读 code（S15）：${text}`)
    assert.ok(!text.includes(dataDir), `响应体不得含 dataDir 绝对路径：${text.slice(0, 200)}`)
    assert.ok(!/\/tmp\/dpr-repair-trash-/.test(text), '响应体不得含任何临时绝对路径')
    // 零 unlink：两个文件都还在
    assert.ok(existsSync(join(dataDir, 't', 'p.pdf')), '.pdf 必须仍在')
    assert.ok(existsSync(join(dataDir, 't', 'p.txt')), '.txt 必须仍在')
    assert.deepEqual(diffSnap(before, snap(dataDir)), [], '失败时盘上零变化')
    srv.close()
  } finally {
    spec = saved
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('T2b newTrashBundle：.trash 存在但不是目录 → ManageError(trash-move-failed) 且 extra.trashRel 是相对路径', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dpr-repair-bundle-'))
  try {
    writeFileSync(join(tmp, '.trash'), 'blocker')
    let err = null
    try { newTrashBundle(tmp) } catch (e) { err = e }
    assert.ok(err instanceof ManageError)
    assert.equal(err.code, 'trash-move-failed')
    assert.equal(err.status, 500)
    assert.ok(String(err.extra.trashRel).startsWith('.trash'))
    assert.ok(!err.message.includes(tmp), '文案不得含绝对路径')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

/* ── T3 符号链接 `.pdf` → 404 ────────────────────────────────────────────── */
test('T3 文献 .pdf 本身是符号链接：delete / delete-plan 都 404（不是 500），库外内容无损', async () => {
  const dir = join(DATA, 't3')
  mkdirSync(dir, { recursive: true })
  const secret = join(OUTSIDE, 'secret-repair.txt')
  writeFileSync(secret, 'precious-repair')
  symlinkSync(secret, join(dir, 'Linked.pdf'))
  writeFileSync(join(dir, 'Linked.txt'), 'cache')
  const plan = await api('/api/library/paper/delete-plan?topic=t3&name=Linked')
  assert.equal(plan.status, 404, `符号链接 .pdf 应判 404：${plan.status} ${plan.text}`)
  assert.equal(plan.body.code, 'not-found')
  const del = await postJson('/api/library/paper/delete', { topic: 't3', name: 'Linked' })
  assert.equal(del.status, 404, `应 404 而非 500：${del.status} ${del.text}`)
  assert.equal(del.body.code, 'not-found')
  assert.ok(!del.text.includes(DATA), '响应体不得含 dataDir 绝对路径')
  // 库外目标与链接本身都无损
  assert.equal(readFileSync(secret, 'utf8'), 'precious-repair')
  assert.ok(lstatSync(join(dir, 'Linked.pdf')).isSymbolicLink(), '链接本身必须还在')
})

/* ── T4 /api/transcribe 的 path 边界 ─────────────────────────────────────── */
test('T4 transcribe：≥6 种恶意 path 全 4xx 带 code、库内外快照零变化；库内绝对路径仍可用', async () => {
  const dir = join(DATA, 't4')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Good.pdf'), PDF_TEXT())
  const evilTarget = join(OUTSIDE, 'evil.pdf')
  writeFileSync(evilTarget, PDF_TEXT())
  symlinkSync(evilTarget, join(dir, 'LinkOut.pdf')) // 库内符号链接 → 库外
  const b4 = { data: snap(DATA), out: snap(OUTSIDE) }
  const bad = [
    join(OUTSIDE, 'evil.pdf'),            // 库外绝对路径
    join(DATA, '..', 'evil.pdf'),         // 相对拼接逃逸
    '../../../etc/passwd',                // 相对穿越
    '/etc/passwd',                        // 绝对路径
    join(dir, 'LinkOut.pdf'),             // 库内符号链接指向库外
    'bad\u0000.pdf',                      // 空字节
    '..%2f..%2fetc%2fpasswd',             // 编码形态（原样字符串）
  ]
  for (const path of bad) {
    const r = await postJson('/api/transcribe', { path, source: 'pdfjs' })
    assert.ok(r.status >= 400 && r.status < 500, `恶意 path 应 4xx：${path} → ${r.status} ${r.text}`)
    assert.ok(['escape-rejected', 'not-found', 'bad-name'].includes(r.body.code), `必须带机器可读 code：${r.text}`)
    assert.ok(!r.text.includes(DATA), '响应体不得含 dataDir 绝对路径')
    assert.ok(!r.text.includes(OUTSIDE), '响应体不得含库外绝对路径')
  }
  assert.deepEqual(diffSnap(b4.data, snap(DATA)), [], 'dataDir 必须零变化')
  assert.deepEqual(diffSnap(b4.out, snap(OUTSIDE)), [], '库外目录必须零变化')
  // 库内绝对路径（合法）仍应可用——path 只是「必须落在库内」，不是一律拒绝
  const ok = await postJson('/api/transcribe', { path: join(dir, 'Good.pdf'), source: 'pdfjs' })
  assert.equal(ok.status, 200, `库内绝对路径应可用：${ok.status} ${ok.text}`)
  assert.equal(ok.body.producer, 'pdfjs')
})

/* ── T5 upload 的 topic 边界 ────────────────────────────────────────────── */
test('T5 upload：≥6 种恶意 topic 全 4xx 带 code、快照零变化；符号链接专题被拒；合法上传仍可用', async () => {
  // 符号链接专题：指向库外
  try { symlinkSync(OUTSIDE, join(DATA, 'link-topic')) } catch { /* 已存在 */ }
  const before = snap(DATA)
  const beforeOut = snap(OUTSIDE)
  const evil = ['..', '../x', '/abs-topic', 'a/b', 'a\\b', '.hidden-topic', 'x\u0000topic', 'a..b']
  for (const topic of evil) {
    const r = await api('/api/library/upload', {
      method: 'POST',
      headers: { 'x-dpr-topic': encodeURIComponent(topic), 'x-dpr-name': encodeURIComponent('u.pdf'), 'content-type': 'application/pdf' },
      body: Buffer.alloc(200, 1),
    })
    assert.equal(r.status, 400, `恶意 topic 应 400：${topic} → ${r.status} ${r.text}`)
    assert.ok(['bad-name', 'escape-rejected'].includes(r.body.code), `必须带机器可读 code：${r.text}`)
  }
  const linkUp = await api('/api/library/upload', {
    method: 'POST',
    headers: { 'x-dpr-topic': encodeURIComponent('link-topic'), 'x-dpr-name': encodeURIComponent('u.pdf'), 'content-type': 'application/pdf' },
    body: Buffer.alloc(200, 1),
  })
  assert.equal(linkUp.status, 400, `符号链接专题应被拒：${linkUp.status} ${linkUp.text}`)
  assert.equal(linkUp.body.code, 'escape-rejected')
  assert.deepEqual(diffSnap(before, snap(DATA)), [], '恶意上传不得改动 dataDir')
  assert.deepEqual(diffSnap(beforeOut, snap(OUTSIDE)), [], '库外目录必须零变化')
  // 合法上传
  const ok = await api('/api/library/upload', {
    method: 'POST',
    headers: { 'x-dpr-topic': encodeURIComponent('ok-topic'), 'x-dpr-name': encodeURIComponent('My Paper.pdf'), 'content-type': 'application/pdf' },
    body: PDF_TEXT(),
  })
  assert.equal(ok.status, 200, ok.text)
  assert.equal(ok.body.name, 'My Paper')
  assert.ok(existsSync(join(DATA, 'ok-topic', 'My Paper.pdf')))
})

/* ── T6 弹窗「不删清单」与 delete-plan 同源 ─────────────────────────────── */
test('T6 确认弹窗的「不会删除」清单由服务端 plan.notDeleted 派生（不再硬编码漂移）', () => {
  const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  assert.match(client, /delDlg\.plan\.notDeleted/, '必须用 delete-plan 返回的 notDeleted')
  assert.ok(!/notDeleted: t\('delNotDeleted'\)\s*,/.test(client), '不得再只写硬编码 i18n（应只作为专题兜底）')
  // 同源证据：服务端 notDeleted 文案与客户端展示用的同一份数据
  const lm = readFileSync(join(ROOT, '..', 'src', 'library-manage.ts'), 'utf8')
  assert.match(lm, /notDeleted: \[/, '服务端必须提供 notDeleted 清单')
  assert.match(client, /\.join\(' · '\)/, '弹窗按服务端数组渲染')
})

/* ── T7 会话查证 fail-closed ─────────────────────────────────────────────── */
test('T7 会话查不到 → 破坏性操作 fail-closed（503 session-unknown），文件零变化；查得到则放行', async () => {
  const dir = join(DATA, 't7')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'P.pdf'), PDF_TEXT())
  writeFileSync(join(dir, 'P.txt'), 'cache')
  // ① 会话服务不可用（没有 list）
  const s1 = await boot({ sessionController: {} })
  try {
    const r = await s1.postJson('/api/library/paper/delete', { topic: 't7', name: 'P' })
    assert.equal(r.status, 503, `fail-closed 应 503：${r.status} ${r.text}`)
    assert.equal(r.body.code, 'session-unknown')
    assert.ok(existsSync(join(dir, 'P.pdf')), '被拒时不得动文件')
    const ren = await s1.postJson('/api/library/paper/rename', { topic: 't7', name: 'P', newName: 'Q' })
    assert.equal(ren.status, 503)
    assert.equal(ren.body.code, 'session-unknown')
  } finally { s1.srv.close() }
  // ② 会话查询抛异常 → 同样 fail-closed
  const s2 = await boot()
  sessionImpl = async () => { throw new Error('session service down') }
  try {
    const r = await s2.postJson('/api/library/paper/delete', { topic: 't7', name: 'P' })
    assert.equal(r.status, 503)
    assert.equal(r.body.code, 'session-unknown')
  } finally { sessionImpl = async () => ({ items: [] }); s2.srv.close() }
  // ③ 查得到且无运行中会话 → 正常放行
  assert.equal((await postJson('/api/library/paper/delete', { topic: 't7', name: 'P' })).status, 200)
})

/* ── T8 契约 R5：并发互斥 ────────────────────────────────────────────────── */
test('T8 在途守卫：同一篇文献并发删除/重命名 → 一个 200、另一个 409 busy（不出现中间态）', async () => {
  const topic = 't8'
  for (let i = 0; i < 3; i++) scaffold(topic, `P${i}`)
  // 会话查询注入真实延时 → 第一个请求会在守卫内跨多个 macrotask，第二个请求必落在在途窗口内
  sessionImpl = async () => { await new Promise((r) => setTimeout(r, 25)); return { items: [] } }
  let a, b
  try {
    [a, b] = await Promise.all([
      postJson('/api/library/topic/rename', { name: topic, newName: 't8-renamed' }),
      postJson('/api/library/topic/rename', { name: topic, newName: 't8-renamed' }),
    ])
  } finally { sessionImpl = async () => ({ items: [] }) }
  const codes = [a, b].map((r) => `${r.status}:${r.body.code ?? '-'}`).sort()
  assert.deepEqual(codes, ['200:-', '409:busy'], `必须恰好一个成功、一个 busy：${JSON.stringify(codes)}`)
  const loser = [a, b].find((r) => r.status === 409)
  assert.equal(loser.body.code, 'busy')
  assert.equal(readdirSync(DATA).filter((n) => n.startsWith('t8')).length, 1, '改名后只应存在一个专题目录')
})

/* ── T9 上一轮不变式复跑 ─────────────────────────────────────────────────── */
test('T9 不变式未回退：穿越输入全 4xx、`.pdf` 最后移、回收站可恢复、库外零变化', async () => {
  const dir = scaffold('t9', 'Victim')
  const sentinelOut = join(OUTSIDE, 't9-sentinel.txt')
  writeFileSync(sentinelOut, 'untouched')
  const beforeOut = snap(OUTSIDE)
  // 结构性穿越防护仍然三层：词汇层 / 专题层 / path 层
  for (const body of [
    { topic: 't9', name: '../../etc/passwd' }, { topic: 't9', name: '/etc/passwd' },
    { topic: '..', name: 'Victim' }, { topic: 't9', name: 'a/b' },
    { topic: 't9', name: 'a\\b' }, { topic: 't9', name: 'Victim', path: '/etc/passwd' },
  ]) {
    const r = await postJson('/api/library/paper/delete', body)
    assert.equal(r.status, 400, `应 400：${JSON.stringify(body)} → ${r.status}`)
    assert.ok(['bad-name', 'escape-rejected'].includes(r.body.code))
  }
  const symTopic = join(DATA, 't9-link')
  symlinkSync(OUTSIDE, symTopic)
  const symRes = await postJson('/api/library/paper/delete', { topic: 't9-link', name: 'x' })
  assert.equal(symRes.status, 400)
  assert.equal(symRes.body.code, 'escape-rejected')
  rmSync(symTopic, { force: true })
  // 真删除：`.pdf` 最后移 + 回收站可恢复
  const del = await postJson('/api/library/paper/delete', { topic: 't9', name: 'Victim' })
  assert.equal(del.status, 200, del.text)
  assert.equal(del.body.moved[del.body.moved.length - 1], 'Victim.pdf', '`.pdf` 必须最后移')
  const bundle = join(DATA, '.trash', String(del.body.trashRel).replace(/^\.trash[\\/]/, ''))
  assert.ok(existsSync(join(bundle, 'manifest.json')))
  assert.ok(existsSync(join(bundle, 'Victim.pdf')), '回收站里应能找到被删的 PDF（可恢复）')
  assert.deepEqual(readdirSync(dir), [])
  assert.deepEqual(diffSnap(beforeOut, snap(OUTSIDE)), [], '库外目录零变化')
  assert.equal(readFileSync(sentinelOut, 'utf8'), 'untouched')
})

test.after(() => {
  LIVE?.srv?.close()
  for (const p of [HOME, DATA, OUTSIDE]) rmSync(p, { recursive: true, force: true })
})
