// test/notes.test.mjs — 文献笔记的纯函数 + HTTP 路由 + 产物生命周期。
//
// 契约：docs/features.md「笔记」一节。覆盖四类回归：
//   A. notes.ts：路径约定、坏 JSON 容错、校验/截断、upsert/delete 语义
//   B. 原子落盘的临时名必须落在 library-manage 的 TMP_RE 里（中断残留能被回收）
//   C. host.ts 路由：GET 读回（B 阻断项的回归）、400/404、鉴权围栏
//   D. `.notes.json` 注册为文献产物：改名/删除跟着走，不再留孤儿
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

// $DSH_HOME 必须在 registerRoutes 之前指向临时目录（会写 agent preset / mineru.json）
const HOME = mkdtempSync(join(tmpdir(), 'dpr-notes-home-'))
process.env.DSH_HOME = HOME

const {
  MAX_NOTE_BODY, MAX_NOTES_PER_PAPER, NoteError, deleteNote, notesPathFor, readNotes,
  upsertNote, validateNoteInput, writeNotes,
} = await import(pathToFileURL(dist('notes.js')).href)
const {
  deletePaper, listArtifacts, matchArtifactName, renamePaper,
} = await import(pathToFileURL(dist('library-manage.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

const DATA = mkdtempSync(join(tmpdir(), 'dpr-notes-data-'))
mkdirSync(join(DATA, 'demo'), { recursive: true })
// resolvePaper 只要求文件存在；PDF 内容不参与笔记路由
writeFileSync(join(DATA, 'demo', 'paper.pdf'), '%PDF-1.4\n%%EOF\n')

let spec = null
let rejectStatus = undefined
const ctx = {
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => rejectStatus },
  sessionController: { list: async () => ({ items: [] }) },
  workspaceController: {},
  workspaceRegistry: {},
  effect: (fn) => fn(),
}
registerRoutes(ctx, { dataDir: DATA })
const server = createServer((req, res) => spec.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${server.address().port}`
const api = async (path, opts) => {
  const r = await fetch(`${ORIGIN}/paper-reader${path}`, opts)
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON 原样返回 */ }
  return { status: r.status, body, text }
}
const postJson = (path, obj) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
})
const postNote = (body) => postJson('/api/notes', body)

test.after(() => {
  server.close()
  rmSync(DATA, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
})

// ── A. notes.ts 纯函数 ──────────────────────────────────────────────────────

test('N1 notesPathFor：只替换 .pdf 后缀，落在同一专题目录', () => {
  const pdf = join(DATA, 'demo', 'Attention Is All You Need.pdf')
  assert.equal(notesPathFor(pdf), join(DATA, 'demo', 'Attention Is All You Need.notes.json'))
})

test('N2 readNotes：文件不存在 / 坏 JSON → 空文件；坏条目被过滤、好条目被规范化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-notes-read-'))
  try {
    const pdf = join(dir, 'p.pdf')
    assert.deepEqual(await readNotes(pdf), { v: 1, updated: null, notes: [] })

    writeFileSync(notesPathFor(pdf), '{ this is not json')
    assert.deepEqual(await readNotes(pdf), { v: 1, updated: null, notes: [] })

    writeFileSync(notesPathFor(pdf), JSON.stringify({
      v: 1,
      updated: '2026-01-02T03:04:05.000Z',
      notes: [
        { id: 'ok', quote: 'q'.repeat(2000), body: '  body  ', created: 'c', updated: 'u' },
        { id: '', body: 'no id' },
        { id: 'blank', body: '   ' },
        null,
        'nope',
        { id: 'x'.repeat(81), body: 'too long id' },
      ],
    }))
    const file = await readNotes(pdf)
    assert.equal(file.updated, '2026-01-02T03:04:05.000Z')
    assert.equal(file.notes.length, 1)
    assert.equal(file.notes[0].id, 'ok')
    assert.equal(file.notes[0].body, '  body  ', '读路径保留正文原样（只校验非空白）')
    assert.equal(file.notes[0].quote.length, 1200, '引用超长应截断到 MAX_QUOTE')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('N3 validateNoteInput：正文必填，id/quote/body 截断，非法 anchor 直接丢弃', () => {
  assert.throws(() => validateNoteInput(null), (e) => e instanceof NoteError && e.code === 'bad-note')
  assert.throws(() => validateNoteInput({ body: '   ' }), (e) => e.code === 'bad-note')

  const auto = validateNoteInput({ body: ' hello ', quote: 'q' })
  assert.match(auto.id, /^n-[a-z0-9]+-[a-z0-9]{6}$/)
  assert.equal(auto.body, 'hello')

  const long = validateNoteInput({
    id: 'i'.repeat(100),
    body: 'b'.repeat(MAX_NOTE_BODY + 50),
    quote: 'q'.repeat(5000),
  })
  assert.equal(long.id.length, 80)
  assert.equal(long.body.length, MAX_NOTE_BODY)
  assert.equal(long.quote.length, 1200)

  assert.deepEqual(
    validateNoteInput({ body: 'x', anchor: { page: 3, start: 10, end: 20, doc: 'zh' } }).anchor,
    { page: 3, start: 10, end: 20, doc: 'zh' },
  )
  for (const anchor of [
    { page: 0, start: 0, end: 1 },
    { page: 1, start: 5, end: 5 },
    { page: 1, start: 9, end: 3 },
    { page: 'x', start: 0, end: 1 },
  ]) {
    assert.equal(validateNoteInput({ body: 'x', anchor }).anchor, undefined, JSON.stringify(anchor))
  }
  // doc 非 orig/zh 时只丢 doc，不丢整个锚点
  assert.deepEqual(validateNoteInput({ body: 'x', anchor: { page: 1, start: 0, end: 1, doc: 'other' } }).anchor,
    { page: 1, start: 0, end: 1 })
})

test('N4 upsertNote / deleteNote：新建发 id、更新保 created、删除幂等、超上限报 too-many-notes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-notes-rw-'))
  try {
    const pdf = join(dir, 'p.pdf')
    const first = await upsertNote(pdf, { body: 'first', quote: 'q' })
    assert.equal(first.notes.length, 1)
    const id = first.notes[0].id
    assert.ok(id)

    const updated = await upsertNote(pdf, { id, body: 'second' })
    assert.equal(updated.notes.length, 1)
    assert.equal(updated.notes[0].body, 'second')
    assert.equal(updated.notes[0].created, first.notes[0].created, '更新必须保留 created')

    const gone = await deleteNote(pdf, id)
    assert.equal(gone.notes.length, 0)
    assert.equal((await deleteNote(pdf, id)).notes.length, 0, '删除不存在的 id 必须幂等')
    await assert.rejects(() => deleteNote(pdf, '  '), (e) => e.code === 'bad-note')

    const many = { v: 1, updated: null, notes: Array.from({ length: MAX_NOTES_PER_PAPER }, (_, i) => ({
      id: `n${i}`, body: 'x', quote: '', created: 'c', updated: 'u',
    })) }
    await writeNotes(pdf, many)
    await assert.rejects(
      () => upsertNote(pdf, { body: 'one too many' }),
      (e) => e.code === 'too-many-notes',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── B. 原子落盘 + 产物登记 ──────────────────────────────────────────────────

test('N5 writeNotes：原子落盘且临时名匹配 library-manage 的 TMP_RE，中断残留可被识别', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-notes-tmp-'))
  try {
    const pdf = join(dir, 'p.pdf')
    await writeNotes(pdf, { v: 1, updated: null, notes: [] })
    assert.ok(existsSync(notesPathFor(pdf)))
    assert.deepEqual(readdirSync(dir), ['p.notes.json'], '成功写入后不应留下临时文件')

    // 模拟写到一半被杀：临时名必须是 `<文献>.notes.json.tmp-<pid>-<hex>`，与 TMP_RE 一致
    const residue = 'p.notes.json.tmp-1234-deadbeef'
    writeFileSync(join(dir, residue), '{}')
    assert.ok(matchArtifactName('p', residue), '笔记临时文件必须被当作该文献的产物')
    const oldStyle = '.notes-tmp-1234-deadbeef'
    writeFileSync(join(dir, oldStyle), '{}')
    assert.ok(!matchArtifactName('p', oldStyle), '旧式隐藏 tmp 名不再是本模块的命名')
    const kinds = listArtifacts(dir, 'p').map((f) => [f.name, f.kind])
    assert.deepEqual(kinds, [['p.notes.json', 'note'], ['p.notes.json.tmp-1234-deadbeef', 'tmp']])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── C. HTTP 路由 ────────────────────────────────────────────────────────────

test('N6 GET /api/notes：新论文返回 200 空列表；保存后重开（新的 GET）能读回同一条', async () => {
  const empty = await api('/api/notes?topic=demo&name=paper')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { v: 1, updated: null, notes: [] })

  const saved = await postNote({
    topic: 'demo', name: 'paper', action: 'save',
    note: { body: '读回我', quote: 'selected text', anchor: { page: 1, start: 0, end: 13, doc: 'orig' } },
  })
  assert.equal(saved.status, 200)
  const id = saved.body.notes[0].id

  // 关键回归（B 阻断项）：阅读器重新打开时只发 GET；这里必须真的读到盘上的笔记
  const reopened = await api('/api/notes?topic=demo&name=paper')
  assert.equal(reopened.status, 200)
  assert.equal(reopened.body.notes.length, 1)
  assert.equal(reopened.body.notes[0].id, id)
  assert.equal(reopened.body.notes[0].body, '读回我')
  assert.deepEqual(reopened.body.notes[0].anchor, { page: 1, start: 0, end: 13, doc: 'orig' })
})

test('N7 GET /api/notes：路径参数被忽略（只认 topic+name），未知文献 404，非 GET/POST 404', async () => {
  const byPath = await api(`/api/notes?path=${encodeURIComponent(join(DATA, 'demo', 'paper.pdf'))}`)
  assert.equal(byPath.status, 404, '笔记路由不接受 path 直指任意 PDF')

  const missing = await api('/api/notes?topic=demo&name=no-such-paper')
  assert.equal(missing.status, 404)

  const put = await api('/api/notes?topic=demo&name=paper', { method: 'PUT' })
  assert.equal(put.status, 404)
})

test('N8 POST /api/notes：非法请求体 / 缺 topic+name / 空正文 / path 参数一律 400，且不落盘', async () => {
  const before = readdirSync(join(DATA, 'demo')).sort()
  const cases = [
    { body: { topic: 'demo', name: 'paper', action: 'save', note: { body: '   ' } }, code: 'bad-note' },
    { body: { topic: 'demo', name: 'paper', action: 'delete' }, code: 'bad-note' },
    { body: { name: 'paper', action: 'save', note: { body: 'x' } }, code: 'bad-request' },
    { body: { topic: 'demo', action: 'save', note: { body: 'x' } }, code: 'bad-request' },
    { body: { topic: 'demo', name: 'paper', action: 'save', note: { body: 'x' }, path: '/etc/passwd' }, code: 'escape-rejected' },
  ]
  for (const { body, code } of cases) {
    const r = await postNote(body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.body.code, code)
  }
  const raw = await api('/api/notes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
  })
  assert.equal(raw.status, 400)
  assert.deepEqual(readdirSync(join(DATA, 'demo')).sort(), before, '失败请求不得改动目录')
})

test('N9 鉴权围栏：GET 与 POST /api/notes 都被 connection.requestRejection 拦下', async () => {
  rejectStatus = 401
  try {
    const got = await api('/api/notes?topic=demo&name=paper')
    assert.equal(got.status, 401)
    const post = await postNote({ topic: 'demo', name: 'paper', action: 'save', note: { body: 'x' } })
    assert.equal(post.status, 401)
  } finally {
    rejectStatus = undefined
  }
})

// ── D. `.notes.json` 作为文献产物的生命周期 ────────────────────────────────

test('N10 listArtifacts：`.notes.json` 识别为 note，且排在 .pdf 之前', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-notes-list-'))
  try {
    writeFileSync(join(dir, 'p.pdf'), 'x')
    writeFileSync(join(dir, 'p.notes.json'), '{}')
    writeFileSync(join(dir, 'p.study.json'), '{}')
    const files = listArtifacts(dir, 'p')
    assert.deepEqual(files.map((f) => [f.name, f.kind]), [
      ['p.study.json', 'study'], ['p.notes.json', 'note'], ['p.pdf', 'pdf'],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('N11 renamePaper / deletePaper：笔记跟着改名、跟着进回收站（不再留孤儿）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dpr-notes-life-'))
  try {
    mkdirSync(join(root, 't'))
    writeFileSync(join(root, 't', 'p.pdf'), 'pdf')
    writeFileSync(join(root, 't', 'p.notes.json'), '{"v":1,"notes":[]}')
    writeFileSync(join(root, 't', 'q.pdf'), 'other')

    renamePaper(root, 't', 'p', 'p2')
    assert.ok(existsSync(join(root, 't', 'p2.notes.json')), '改名必须把笔记一起搬走')
    assert.ok(!existsSync(join(root, 't', 'p.notes.json')))
    assert.equal(listArtifacts(join(root, 't'), 'p2').find((f) => f.kind === 'note').name, 'p2.notes.json')

    const res = deletePaper(root, 't', 'p2')
    assert.ok(res.moved.includes('p2.notes.json'), '删除必须回收笔记')
    const bundle = join(root, '.trash', res.trashRel.replace(/^\.trash[\\/]/, ''))
    // PR#8 F3：回收站保留论文名层级 `<bundle>/<论文名>/<文件>`（manifest.trashSubdir 同口径）
    assert.ok(existsSync(join(bundle, 'p2', 'p2.notes.json')), '笔记应可在回收站恢复')
    assert.ok(existsSync(join(root, 't', 'q.pdf')), '别的文献不受影响')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('N12 命名撞车：同名笔记文件也算目标存在（不会静默覆盖）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dpr-notes-clash-'))
  try {
    mkdirSync(join(root, 't'))
    writeFileSync(join(root, 't', 'p.pdf'), 'x')
    writeFileSync(join(root, 't', 'p.notes.json'), '{}')
    writeFileSync(join(root, 't', 'q.pdf'), 'x')
    writeFileSync(join(root, 't', 'q.notes.json'), '{}')
    assert.throws(() => renamePaper(root, 't', 'p', 'q'), (e) => e.code === 'target-exists')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('N13 端到端：POST 保存 → 进程内直接 readNotes（模拟重启）→ GET 同一份数据', async () => {
  const saved = await postNote({
    topic: 'demo', name: 'paper', action: 'save',
    note: { body: '重启后还在', quote: 'q', anchor: { page: 2, start: 3, end: 9 } },
  })
  assert.equal(saved.status, 200)
  const fromDisk = await readNotes(join(DATA, 'demo', 'paper.pdf'))
  assert.ok(fromDisk.notes.some((n) => n.body === '重启后还在'))
  const viaHttp = await api('/api/notes?topic=demo&name=paper')
  assert.deepEqual(viaHttp.body.notes, fromDisk.notes)
  assert.equal(basename(notesPathFor(join(DATA, 'demo', 'paper.pdf'))), 'paper.notes.json')
  assert.match(readFileSync(notesPathFor(join(DATA, 'demo', 'paper.pdf')), 'utf8'), /重启后还在/)
})
