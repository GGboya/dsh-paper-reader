// test/trash-bin.test.mjs — 回收站：列表 / 恢复 / 彻底删除 / 清空 + 侧栏入口。
//
// 背景：删除只是把文献移进 data/.trash/，此前界面上没有任何入口——确认框写着「可恢复」，
// 用户却不知道去哪恢复。本文件守住：
//   R  纯函数（dist/library-manage.js）：三种来源的包（单篇删除 / 清空专题 / 删专题带走的隐藏文件，
//      外加旧版插件的平铺布局）都能列出来；恢复不覆盖、不越界、不跟随符号链接；彻底删除只作用于
//      回收站内；失败如实上报。
//   H  HTTP 路由：响应形状、confirm 栅栏、错误响应不含绝对路径、恢复后历史会话重新挂回论文。
//   U  UI 静态契约 + 文档同步：侧栏有回收站按钮，面板走服务端接口，不可逆操作必须过确认框。
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。
// 所有写操作一律在**临时库**里做（绝不动 ~/.dsh-paper-reader/data）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const HOME = mkdtempSync(join(tmpdir(), 'dpr-trash-home-'))
process.env.DSH_HOME = HOME
const { deletePaper, clearTopic, deleteTopic, listTrash, restoreTrashItem, purgeTrashItem, emptyTrash } =
  await import(pathToFileURL(join(REPO, 'dist', 'library-manage.js')).href)
const { listPapers } = await import(pathToFileURL(join(REPO, 'dist', 'library.js')).href)
const { registerRoutes } = await import(pathToFileURL(join(REPO, 'dist', 'host.js')).href)

const isWin = process.platform === 'win32'
const roots = []
const outsides = []
test.after(() => {
  for (const r of [...roots, ...outsides, HOME]) rmSync(r, { recursive: true, force: true })
})

/** 临时库：专题 A 里有 P、Q 两篇（新布局），子专题 A/B 里有 R；T 是空专题。 */
function newLibrary() {
  const root = mkdtempSync(join(tmpdir(), 'dpr-trash-'))
  roots.push(root)
  for (const [topic, name, body] of [['A', 'P', 'pdf-P'], ['A', 'Q', 'pdf-Q'], ['A/B', 'R', 'pdf-R']]) {
    mkdirSync(join(root, topic, name), { recursive: true })
    writeFileSync(join(root, topic, name, `${name}.pdf`), body)
    writeFileSync(join(root, topic, name, `${name}.txt`), `text-${name}`)
    writeFileSync(join(root, topic, name, `${name}.notes.json`), `{"v":1,"notes":[{"q":"n-${name}"}]}`)
  }
  mkdirSync(join(root, 'T'), { recursive: true })
  return root
}

/** 库外目录（回收站里的符号链接指向它）：任何操作之后它都必须一字未动。 */
function newOutside() {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-trash-outside-'))
  outsides.push(dir)
  writeFileSync(join(dir, 'keep.txt'), 'outside-data')
  return dir
}

/** 目录快照：相对路径 → 内容（符号链接记目标路径），用于「一字未动」断言。 */
function snapshot(dir) {
  const out = {}
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = lstatSync(a)
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(a)}`
      else if (st.isDirectory()) { out[r] = 'dir'; walk(a, r) }
      else out[r] = readFileSync(a, 'utf8')
    }
  }
  walk(dir, '')
  return out
}

const trashDir = (root) => join(root, '.trash')
const bundleOf = (root) => {
  const names = existsSync(trashDir(root)) ? readdirSync(trashDir(root)) : []
  assert.equal(names.length, 1, `应恰好一个包，实际：${names.join(', ')}`)
  return names[0]
}
/** 清空专题后，同时装着 P 与 Q 的那个包（子专题 B 另有一个包）。 */
const bundleWith = (root, ...papers) => readdirSync(trashDir(root))
  .find((b) => papers.every((p) => existsSync(join(trashDir(root), b, p))))

const withCode = (c) => (e) => e.code === c
const skipSymlink = (t) => { if (isWin) t.skip('Windows 上建符号链接需要特权') }
const posixNonRoot = (t) => { if (isWin || process.getuid?.() === 0) t.skip('需要 POSIX 且非 root') }

/** 负载 JSON 里绝不能出现库目录（字面路径与真实路径两种形态都不行）。 */
function assertNoAbsPath(payload, root) {
  const text = JSON.stringify(payload)
  assert.ok(!text.includes(root), `不得带服务端绝对路径：${text}`)
  assert.ok(!text.includes(realpathSync(root)), `不得带服务端真实绝对路径：${text}`)
}

/** 旧版插件的回收站布局：文件直接平放在包根，清单 kind:'paper' 且没有 trashSubdir。 */
function legacyBundle(root, stamp, name, files) {
  const b = join(trashDir(root), stamp)
  mkdirSync(b, { recursive: true })
  for (const [file, body] of files) writeFileSync(join(b, file), body)
  writeFileSync(join(b, 'manifest.json'), JSON.stringify({ v: 1, kind: 'paper', topic: 'A', name, deletedAt: '2025-01-01T00:00:00.000Z' }))
  return b
}

// ═══════════════════════════════════════════════════════════════════════════
// R. 纯函数
// ═══════════════════════════════════════════════════════════════════════════

test('R1 空回收站：没有 .trash / 空目录都列成空清单；只剩我们自己清单的空包顺手收掉', () => {
  const root = newLibrary()
  assert.deepEqual(listTrash(root), { items: [], count: 0, totalBytes: 0 })
  const b1 = join(trashDir(root), '20260101T000000Z-abc123')
  mkdirSync(b1, { recursive: true })
  assert.deepEqual(listTrash(root), { items: [], count: 0, totalBytes: 0 })
  assert.ok(!existsSync(b1), '空包应被收掉')
  const b2 = join(trashDir(root), '20260101T000001Z-def456')
  mkdirSync(b2, { recursive: true })
  writeFileSync(join(b2, 'manifest.json'), '{"v":1,"kind":"paper","topic":"A","name":"Gone"}')
  assert.deepEqual(listTrash(root), { items: [], count: 0, totalBytes: 0 })
  assert.ok(!existsSync(trashDir(root)), '回收站空了连根一起收掉')
})

test('R2 单篇删除 → 一条论文条目：id / 原专题 / 恢复位置 / 体量都对，且不含服务端绝对路径', () => {
  const root = newLibrary()
  deletePaper(root, 'A', 'P')
  const bundle = bundleOf(root)
  const l = listTrash(root)
  assert.equal(l.count, 1)
  const it = l.items[0]
  assert.equal(it.kind, 'paper')
  assert.equal(it.id, `${bundle}/P`)
  assert.deepEqual([it.topic, it.name, it.target], ['A', 'P', 'A/P'])
  assert.equal(it.blocked, null)
  assert.equal(it.files, 3, 'P.pdf / P.txt / P.notes.json；我们自己写的清单不算')
  assert.ok(it.deletedAt && Number.isFinite(Date.parse(it.deletedAt)))
  assert.equal(it.totalBytes, 5 + 6 + readFileSync(join(trashDir(root), bundle, 'P', 'P.notes.json'), 'utf8').length)
  assert.equal(l.totalBytes, it.totalBytes)
  assertNoAbsPath(l, root)
})

test('R3 清空专题（含子专题与隐藏条目）/ 删专题带走的隐藏文件：子树里每篇各一条，其余内容合并成「其它」条目', () => {
  const root = newLibrary()
  writeFileSync(join(root, 'A', '.DS_Store'), 'ds-a')
  writeFileSync(join(root, 'A', 'B', '.DS_Store'), 'ds-b')
  clearTopic(root, 'A')
  writeFileSync(join(root, 'T', '.DS_Store'), 'ds-t')
  deleteTopic(root, 'T')
  const l = listTrash(root)
  const papers = l.items.filter((x) => x.kind === 'paper').map((x) => `${x.topic}/${x.name}`).sort()
  assert.deepEqual(papers, ['A/B/R', 'A/P', 'A/Q'])
  const others = l.items.filter((x) => x.kind === 'other')
  assert.deepEqual(others.map((x) => x.topic).sort(), ['A', 'A/B', 'T'])
  for (const o of others) {
    assert.equal(o.blocked, null)
    assert.equal(o.files, 1)
    assert.equal(o.totalBytes, 4)
  }
  assert.equal(l.count, 6)
  // 同一次清空进来的 5 条时间戳相同：论文排在前面、「其它」（.DS_Store）排在后面——用户要找回的是论文
  const cleared = l.items.filter((x) => x.topic === 'A' || x.topic === 'A/B')
  assert.deepEqual(cleared.map((x) => x.kind), ['paper', 'paper', 'paper', 'other', 'other'], '同一时刻进来的：论文在前、「其它」在后')
  assertNoAbsPath(l, root)
})

test('R4 恢复单篇删除的论文：回到原位、逐字节一致；回收站条目消失，包与 .trash 根一并收掉', () => {
  const root = newLibrary()
  const before = snapshot(join(root, 'A', 'P'))
  deletePaper(root, 'A', 'P')
  assert.ok(!listPapers(root).some((p) => p.name === 'P'))
  const id = listTrash(root).items[0].id
  const r = restoreTrashItem(root, id)
  assert.deepEqual(r, { ok: true, id, kind: 'paper', topic: 'A', name: 'P', dirRel: 'A/P', topicRecreated: false })
  assert.deepEqual(snapshot(join(root, 'A', 'P')), before)
  assert.deepEqual(listTrash(root).items, [])
  assert.ok(!existsSync(trashDir(root)), '最后一个条目恢复后 .trash 根应被收掉')
  assert.ok(listPapers(root).some((p) => p.topic === 'A' && p.name === 'P'))
})

test('R5 旧平铺布局删掉的论文：恢复后收进论文文件夹（新写入一律落文件夹），笔记跟着回来', () => {
  const root = newLibrary()
  writeFileSync(join(root, 'A', 'L.pdf'), 'legacy')
  writeFileSync(join(root, 'A', 'L.notes.json'), '{"v":1,"notes":[]}')
  deletePaper(root, 'A', 'L')
  const r = restoreTrashItem(root, listTrash(root).items[0].id)
  assert.equal(r.dirRel, 'A/L')
  assert.equal(readFileSync(join(root, 'A', 'L', 'L.pdf'), 'utf8'), 'legacy')
  assert.equal(readFileSync(join(root, 'A', 'L', 'L.notes.json'), 'utf8'), '{"v":1,"notes":[]}')
  assert.ok(!existsSync(join(root, 'A', 'L.pdf')))
  const hit = listPapers(root).find((p) => p.name === 'L')
  assert.deepEqual([hit.topic, hit.legacy ?? false], ['A', false])
})

test('R6 原专题已删除：恢复时重建专题目录并如实回报 topicRecreated', () => {
  const root = newLibrary()
  clearTopic(root, 'A')
  assert.ok(!existsSync(join(root, 'A')))
  const it = listTrash(root).items.find((x) => x.kind === 'paper' && x.name === 'P')
  const r = restoreTrashItem(root, it.id)
  assert.equal(r.topicRecreated, true)
  assert.equal(readFileSync(join(root, 'A', 'P', 'P.pdf'), 'utf8'), 'pdf-P')
  assert.ok(!existsSync(join(root, 'A', 'B')), '只重建原专题这一层，不凭空造出别的子专题')
})

test('R7 恢复不覆盖：同名论文目录 / 旧平铺产物 / 仅大小写不同的变体 ⇒ 409 target-exists，库与回收站一字未动', () => {
  // ① 同名论文目录
  let root = newLibrary()
  deletePaper(root, 'A', 'P')
  let id = listTrash(root).items[0].id
  mkdirSync(join(root, 'A', 'P'))
  writeFileSync(join(root, 'A', 'P', 'P.pdf'), 'new-paper')
  let libBefore = snapshot(join(root, 'A'))
  let trashBefore = snapshot(trashDir(root))
  assert.throws(() => restoreTrashItem(root, id), (e) => e.code === 'target-exists' && e.status === 409 && e.extra.conflicts.includes('P'))
  assert.deepEqual(snapshot(join(root, 'A')), libBefore)
  assert.deepEqual(snapshot(trashDir(root)), trashBefore)
  // ② 旧平铺产物（文件夹优先规则会把它永久遮蔽）
  root = newLibrary()
  deletePaper(root, 'A', 'P')
  id = listTrash(root).items[0].id
  writeFileSync(join(root, 'A', 'P.pdf'), 'flat')
  libBefore = snapshot(join(root, 'A'))
  trashBefore = snapshot(trashDir(root))
  assert.throws(() => restoreTrashItem(root, id), (e) => e.code === 'target-exists' && e.extra.conflicts.includes('P.pdf'))
  assert.deepEqual(snapshot(join(root, 'A')), libBefore)
  assert.deepEqual(snapshot(trashDir(root)), trashBefore)
  // ③ 仅大小写不同（大小写不敏感的盘上会互相吞掉）
  root = newLibrary()
  deletePaper(root, 'A', 'P')
  id = listTrash(root).items[0].id
  mkdirSync(join(root, 'A', 'p'))
  writeFileSync(join(root, 'A', 'p', 'p.pdf'), 'lower')
  libBefore = snapshot(join(root, 'A'))
  assert.throws(() => restoreTrashItem(root, id), withCode('target-exists'))
  assert.deepEqual(snapshot(join(root, 'A')), libBefore)
  assert.equal(listTrash(root).count, 1, '恢复被拒后条目必须还在')
})

test('R8 不能一键恢复的条目如实标出 blocked，恢复 ⇒ 409 restore-blocked 且一个字节不动', () => {
  // ① 清单被改成越界路径
  let root = newLibrary()
  deletePaper(root, 'A', 'P')
  let bundle = bundleOf(root)
  const evil = { v: 1, kind: 'paper', topic: '../../outside', name: 'P', deletedAt: '2026-11-24T00:00:00.000Z' }
  writeFileSync(join(trashDir(root), bundle, 'manifest.json'), JSON.stringify(evil))
  writeFileSync(join(trashDir(root), bundle, 'P', 'manifest.json'), JSON.stringify(evil))
  let it = listTrash(root).items[0]
  assert.equal(it.blocked, 'bad-topic')
  assert.throws(() => restoreTrashItem(root, it.id), (e) => e.code === 'restore-blocked' && e.status === 409 && e.extra.reason === 'bad-topic')
  assert.ok(!existsSync(join(root, '..', 'outside')), '越界目标不得被创建')
  assert.ok(existsSync(join(trashDir(root), bundle, 'P', 'P.pdf')), '文件仍在回收站')
  // ② 缺 PDF（恢复回去不会被认成文献，会变成一个「子专题」）
  root = newLibrary()
  deletePaper(root, 'A', 'P')
  bundle = bundleOf(root)
  rmSync(join(trashDir(root), bundle, 'P', 'P.pdf'))
  it = listTrash(root).items[0]
  assert.equal(it.blocked, 'incomplete')
  assert.throws(() => restoreTrashItem(root, it.id), (e) => e.code === 'restore-blocked' && e.extra.reason === 'incomplete')
  assert.ok(!existsSync(join(root, 'A', 'P')))
  // ③ 专题路径夹在论文目录里（listPapers 在论文目录处停止递归，放进去就消失）
  root = newLibrary()
  deletePaper(root, 'A', 'Q')
  bundle = bundleOf(root)
  for (const f of [join(trashDir(root), bundle, 'manifest.json'), join(trashDir(root), bundle, 'Q', 'manifest.json')]) {
    const m = JSON.parse(readFileSync(f, 'utf8'))
    m.topic = 'A/P'
    writeFileSync(f, JSON.stringify(m))
  }
  it = listTrash(root).items[0]
  assert.equal(it.blocked, 'bad-topic')
  assert.throws(() => restoreTrashItem(root, it.id), withCode('restore-blocked'))
  assert.deepEqual(readdirSync(join(root, 'A', 'P')).sort(), ['P.notes.json', 'P.pdf', 'P.txt'], '现有论文目录里不得多出东西')
})

test('R9 id 校验：非法 400、不存在 404；符号链接的包与符号链接的回收站根一律拒绝，库外一字未动', (t) => {
  const root = newLibrary()
  deletePaper(root, 'A', 'P')
  const bundle = bundleOf(root)
  for (const bad of ['', '..', '../P', 'a/b/c', 'a\\b', '.', null, undefined, 42, `${bundle}/..`, `${bundle}/P/`]) {
    assert.throws(() => restoreTrashItem(root, bad), (e) => e.code === 'bad-request' && e.status === 400, `id=${String(bad)}`)
    assert.throws(() => purgeTrashItem(root, bad), (e) => e.code === 'bad-request' && e.status === 400, `purge id=${String(bad)}`)
  }
  assert.throws(() => restoreTrashItem(root, 'nope'), (e) => e.code === 'not-found' && e.status === 404)
  assert.throws(() => restoreTrashItem(root, `${bundle}/nope`), (e) => e.code === 'not-found' && e.status === 404)
  assert.equal(listTrash(root).count, 1, '被拒的请求不动回收站')
  skipSymlink(t)
  // 包是指向库外目录的符号链接
  const outside = newOutside()
  rmSync(trashDir(root), { recursive: true, force: true })
  symlinkSync(outside, join(trashDir(root)), 'dir')
  assert.throws(() => listTrash(root), withCode('escape-rejected'))
  assert.throws(() => restoreTrashItem(root, `${bundle}/P`), withCode('escape-rejected'))
  assert.throws(() => purgeTrashItem(root, `${bundle}/P`), withCode('escape-rejected'))
  assert.throws(() => emptyTrash(root), withCode('escape-rejected'))
  assert.deepEqual(readdirSync(outside), ['keep.txt'], '库外目录不得被读写')
  // 回收站根是真的、里面有一个指向库外的包（符号链接）
  rmSync(trashDir(root), { recursive: true, force: true })
  mkdirSync(trashDir(root))
  symlinkSync(outside, join(trashDir(root), bundle), 'dir')
  assert.deepEqual(listTrash(root).items, [], '符号链接的包不列')
  assert.throws(() => restoreTrashItem(root, `${bundle}/P`), withCode('escape-rejected'))
  emptyTrash(root)
  assert.ok(!existsSync(trashDir(root)), '唯一的条目是个链接 ⇒ 摘掉链接后回收站空了，连根收掉')
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside-data', '链接指向的库外内容一字未动')
})

test('R10 彻底删除一条：只删这一条，同包其它条目不受影响；包里只剩清单时连包一起收掉', () => {
  const root = newLibrary()
  clearTopic(root, 'A')
  const bundle = bundleWith(root, 'P', 'Q')
  assert.ok(bundle, '清空后应有一个同时装着 P 与 Q 的包')
  let ids = listTrash(root).items.map((x) => x.id)
  assert.equal(ids.length, 3, `P、Q 在同一个包里，子专题 B 的 R 在另一个包：${ids}`)
  assert.ok(ids.includes(`${bundle}/P`) && ids.includes(`${bundle}/Q`))
  assert.ok(ids.some((x) => x.endsWith('/R') && !x.startsWith(`${bundle}/`)))
  assert.deepEqual(purgeTrashItem(root, `${bundle}/P`), { ok: true, id: `${bundle}/P` })
  assert.ok(!existsSync(join(trashDir(root), bundle, 'P')))
  ids = listTrash(root).items.map((x) => x.id)
  assert.ok(ids.includes(`${bundle}/Q`), `同包的另一篇还在：${ids}`)
  assert.equal(ids.length, 2, `另一个包（子专题 B 的 R）不受影响：${ids}`)
  purgeTrashItem(root, `${bundle}/Q`)
  assert.ok(!existsSync(join(trashDir(root), bundle)), '包里只剩清单 ⇒ 连包一起收掉')
  assert.equal(listTrash(root).items.length, 1)
  assert.throws(() => purgeTrashItem(root, `${bundle}/Q`), withCode('not-found'), '已删掉的再删是 404')
})

test('R11 清空回收站：全部删除并收掉 .trash 根；没有回收站时也是成功；符号链接只删链接本身', (t) => {
  const root = newLibrary()
  assert.deepEqual(emptyTrash(root), { ok: true, purged: 0, failed: [] }, '没有回收站 = 已经是空的')
  deletePaper(root, 'A', 'P')
  deletePaper(root, 'A', 'Q')
  const stray = join(trashDir(root), '20260101T000000Z-zzz999')
  mkdirSync(stray, { recursive: true })
  writeFileSync(join(trashDir(root), 'stray.txt'), '散落文件')
  const outside = newOutside()
  if (!isWin) symlinkSync(outside, join(stray, 'link'), 'dir')
  const r = emptyTrash(root)
  assert.deepEqual(r, { ok: true, purged: 4, failed: [] }) // 两个论文包 + 散落目录 + 散落文件
  assert.ok(!existsSync(trashDir(root)))
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside-data', '链接指向的库外内容一字未动')
  assert.ok(existsSync(join(root, 'A', 'B', 'R', 'R.pdf')), '只动回收站，库里的其它文献不受影响')
})

test('R12 清空时有包删不掉：其余照删，failed 如实列出（只有包名与 errno，无绝对路径）', (t) => {
  posixNonRoot(t)
  const root = newLibrary()
  deletePaper(root, 'A', 'P')
  const locked = bundleOf(root)
  deletePaper(root, 'A', 'Q')
  chmodSync(join(trashDir(root), locked), 0o500)
  let r
  try { r = emptyTrash(root) } finally { chmodSync(join(trashDir(root), locked), 0o700) }
  assert.equal(r.purged, 1, '能删的那个包照删')
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].id, locked)
  assert.ok(['EACCES', 'EPERM', 'ENOTEMPTY'].includes(r.failed[0].cause), `应为权限类 errno：${r.failed[0].cause}`)
  assertNoAbsPath(r, root)
  assert.ok(existsSync(trashDir(root)), '有没删掉的包 ⇒ 回收站根保留')
})

test('R13 「其它」条目：隐藏文件回到原专题目录（专题已删则重建）；原位置已有同名文件 ⇒ 409 不覆盖', () => {
  let root = newLibrary()
  writeFileSync(join(root, 'A', '.DS_Store'), 'ds-a')
  clearTopic(root, 'A')
  const other = listTrash(root).items.find((x) => x.kind === 'other' && x.topic === 'A')
  const r = restoreTrashItem(root, other.id)
  assert.deepEqual(r, { ok: true, id: other.id, kind: 'other', topic: 'A', name: null, dirRel: null, topicRecreated: true })
  assert.equal(readFileSync(join(root, 'A', '.DS_Store'), 'utf8'), 'ds-a')
  assert.ok(!existsSync(join(root, 'A', 'P')), '只恢复「其它」条目自己那几个文件')
  // 原专题已有同名条目
  root = newLibrary()
  writeFileSync(join(root, 'A', '.DS_Store'), 'old-ds')
  clearTopic(root, 'A')
  mkdirSync(join(root, 'A'), { recursive: true })
  writeFileSync(join(root, 'A', '.DS_Store'), 'new-ds')
  const o2 = listTrash(root).items.find((x) => x.kind === 'other' && x.topic === 'A')
  const before = snapshot(join(root, 'A'))
  assert.throws(() => restoreTrashItem(root, o2.id), (e) => e.code === 'target-exists' && e.extra.conflicts.includes('.DS_Store'))
  assert.deepEqual(snapshot(join(root, 'A')), before)
})

test('R14 旧版插件的回收站布局（文件直接平放在包根、清单没有 trashSubdir）：列成一条论文条目，可恢复也可彻底删除', () => {
  let root = newLibrary()
  legacyBundle(root, '20250101T000000Z-old001', 'L', [['L.pdf', 'old-pdf'], ['L.txt', 'old-txt']])
  let l = listTrash(root)
  assert.equal(l.count, 1)
  assert.deepEqual([l.items[0].kind, l.items[0].id, l.items[0].topic, l.items[0].name, l.items[0].files, l.items[0].blocked],
    ['paper', '20250101T000000Z-old001', 'A', 'L', 2, null])
  const r = restoreTrashItem(root, l.items[0].id)
  assert.deepEqual([r.dirRel, r.topicRecreated], ['A/L', false])
  assert.equal(readFileSync(join(root, 'A', 'L', 'L.pdf'), 'utf8'), 'old-pdf')
  assert.equal(readFileSync(join(root, 'A', 'L', 'L.txt'), 'utf8'), 'old-txt')
  assert.ok(!existsSync(join(root, 'A', 'L', 'manifest.json')), '我们的清单不跟着进库')
  assert.deepEqual(listTrash(root).items, [])
  root = newLibrary()
  legacyBundle(root, '20250101T000000Z-old002', 'L', [['L.pdf', 'old-pdf']])
  purgeTrashItem(root, '20250101T000000Z-old002')
  assert.ok(!existsSync(trashDir(root)))
})

test('R15 没有清单的包：列成「其它」条目并标明不能一键恢复（不知道原位置）；恢复 409，彻底删除可用', () => {
  const root = newLibrary()
  const b = join(trashDir(root), '20250101T000000Z-noman')
  mkdirSync(join(b, 'X'), { recursive: true })
  writeFileSync(join(b, 'X', 'X.pdf'), 'x')
  const l = listTrash(root)
  assert.equal(l.count, 1)
  assert.deepEqual([l.items[0].kind, l.items[0].topic, l.items[0].blocked, l.items[0].files], ['other', null, 'no-manifest', 1])
  assert.throws(() => restoreTrashItem(root, l.items[0].id), (e) => e.code === 'restore-blocked' && e.extra.reason === 'no-manifest')
  assert.ok(existsSync(join(b, 'X', 'X.pdf')), '被拒的恢复不动文件')
  purgeTrashItem(root, l.items[0].id)
  assert.ok(!existsSync(trashDir(root)))
})

test('R16 整目录恢复中途被占用（EBUSY）⇒ 409 file-busy：文件仍在回收站且仍可恢复，库里没有半成品、不留空专题', () => {
  const busy = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e }
  // ① 专题还在
  let root = newLibrary()
  deletePaper(root, 'A', 'P')
  let id = listTrash(root).items[0].id
  assert.throws(() => restoreTrashItem(root, id, busy), withCode('file-busy'))
  assert.ok(!existsSync(join(root, 'A', 'P')), '库里不得留下半成品')
  // 摘清单发生在 rename 之前 ⇒ 失败后条目必须还能靠包根清单认出来
  assert.deepEqual(listTrash(root).items.map((x) => [x.id, x.blocked]), [[id, null]])
  assert.ok(existsSync(join(trashDir(root), id.split('/')[0], 'P', 'P.pdf')), '文件仍在回收站')
  // ② 专题已被删除：失败后重建的目录要收掉
  root = newLibrary()
  clearTopic(root, 'A')
  id = listTrash(root).items.find((x) => x.kind === 'paper' && x.name === 'P').id
  assert.throws(() => restoreTrashItem(root, id, busy), withCode('file-busy'))
  assert.ok(!existsSync(join(root, 'A')), '没搬成就不留一个空的重建专题')
})

test('R17 旧版平铺条目逐个搬：中途被占用 ⇒ 已搬的放回回收站、空目标目录收掉；回滚自身也失败 ⇒ restore-partial 如实点名', () => {
  const errno = (code) => { const e = new Error(code); e.code = code; throw e }
  let root = newLibrary()
  legacyBundle(root, '20250101T000000Z-old003', 'L', [['L.pdf', 'old-pdf'], ['L.txt', 'old-txt']])
  let calls = 0
  const busyAt2 = (from, to) => { if (++calls === 2) errno('EBUSY'); renameSync(from, to) }
  assert.throws(() => restoreTrashItem(root, '20250101T000000Z-old003', busyAt2), withCode('file-busy'))
  assert.deepEqual(readdirSync(join(trashDir(root), '20250101T000000Z-old003')).sort(), ['L.pdf', 'L.txt', 'manifest.json'])
  assert.ok(!existsSync(join(root, 'A', 'L')), '空的目标目录被收掉')
  assert.equal(listTrash(root).count, 1)
  // 回滚自身失败：文件留在目标里，必须如实点名（不谎报「未生效」）
  root = newLibrary()
  legacyBundle(root, '20250101T000000Z-old004', 'L', [['L.pdf', 'old-pdf'], ['L.txt', 'old-txt']])
  calls = 0
  const partial = (from, to) => { calls++; if (calls === 2) errno('EBUSY'); if (calls === 3) errno('EPERM'); renameSync(from, to) }
  // 目录读取顺序因文件系统而异 ⇒ 第一个被搬走、随后没能放回的可能是任一文件：按实际点名的那一个核对
  const outcome = (() => { try { restoreTrashItem(root, '20250101T000000Z-old004', partial); return null } catch (e) { return e } })()
  assert.equal(outcome?.code, 'restore-partial')
  assert.equal(outcome?.status, 500)
  assert.deepEqual(outcome?.extra?.rollbackFailed?.length, 1)
  const stranded = outcome.extra.rollbackFailed[0]
  assert.ok(stranded === 'L.pdf' || stranded === 'L.txt', `点名必须是那两个文件之一：${stranded}`)
  assert.equal(readFileSync(join(root, 'A', 'L', stranded), 'utf8'), stranded === 'L.pdf' ? 'old-pdf' : 'old-txt', '未能放回的文件留在目标里（如实，不谎报未生效）')
  assert.ok(existsSync(join(trashDir(root), '20250101T000000Z-old004', stranded === 'L.pdf' ? 'L.txt' : 'L.pdf')), '另一个文件已放回回收站')
})

test('R18 回收站里的符号链接：体量只按链接自身计、绝不跟随；恢复与彻底删除都不动链接指向的库外文件', (t) => {
  skipSymlink(t)
  const root = newLibrary()
  const outside = newOutside()
  writeFileSync(join(outside, 'big.bin'), Buffer.alloc(300000))
  deletePaper(root, 'A', 'P')
  symlinkSync(join(outside, 'big.bin'), join(trashDir(root), bundleOf(root), 'P', 'P.link.bin'), 'file')
  let it = listTrash(root).items[0]
  assert.equal(it.files, 4)
  assert.ok(it.totalBytes < 300000, '不得把链接目标的大小算进来')
  restoreTrashItem(root, it.id)
  assert.ok(lstatSync(join(root, 'A', 'P', 'P.link.bin')).isSymbolicLink(), '链接原样跟着论文回来')
  // 再删一次，往回收站里的论文目录放一个链接，然后彻底删除：库外文件必须还在
  deletePaper(root, 'A', 'P')
  symlinkSync(join(outside, 'big.bin'), join(trashDir(root), bundleOf(root), 'P', 'P.link.bin'), 'file')
  it = listTrash(root).items[0]
  purgeTrashItem(root, it.id)
  assert.ok(!existsSync(trashDir(root)))
  assert.equal(readFileSync(join(outside, 'big.bin')).length, 300000, '彻底删除绝不跟随符号链接')
})

test('R19 原专题目录被换成指向库外的符号链接 ⇒ blocked（bad-topic），恢复被拒且库外一字未动', (t) => {
  skipSymlink(t)
  const root = newLibrary()
  deletePaper(root, 'A', 'P')
  renameSync(join(root, 'A'), join(root, 'A.real'))
  const outside = newOutside()
  symlinkSync(outside, join(root, 'A'), 'dir')
  const it = listTrash(root).items[0]
  assert.equal(it.blocked, 'bad-topic')
  assert.throws(() => restoreTrashItem(root, it.id), withCode('restore-blocked'))
  assert.deepEqual(readdirSync(outside), ['keep.txt'])
})

// ═══════════════════════════════════════════════════════════════════════════
// H. HTTP 路由
// ═══════════════════════════════════════════════════════════════════════════

let spec = null
const b64 = (s) => Buffer.from(s).toString('base64url')
async function boot(dataDir, sessionItems = [], workspaceRegistry = {}) {
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: sessionItems }) },
    workspaceController: {}, workspaceRegistry, effect: (fn) => fn(),
  }, { dataDir })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const call = async (p, opts) => {
    const r = await fetch(base + p, opts)
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, body, text }
  }
  const post = (p, obj) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
  return { srv, call, post }
}

test('H1 HTTP：GET /library/trash 列清单；restore 之后文献回到文献库，历史伴读会话重新挂回（会话 id 内嵌 topic/name）', async () => {
  const root = newLibrary()
  const sid = (n) => `dpr-${b64('A/P')}-${n}`
  // 这篇文献名下有 4 个会话：1 个有内容的、最新的空白草稿（树上保留）、被顶替的旧空白草稿（树上不显示）、已归档的（树上不显示）
  const sessions = [
    { sessionId: sid(1), updatedAt: 1, running: false, blank: false },
    { sessionId: sid(2), updatedAt: 2, running: false, blank: true },
    { sessionId: sid(3), updatedAt: 3, running: false, blank: false },
    { sessionId: sid(4), updatedAt: 4, running: false, blank: true },
  ]
  const { srv, call, post } = await boot(root, sessions, { archivedSessionIds: [sid(3)], archiveSession: async () => {} })
  try {
    const empty = await call('/api/library/trash')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { items: [], count: 0, totalBytes: 0 })
    assert.equal((await call('/api/sessions?topic=A&name=P')).body.sessions.filter((s) => s.n === 1).length, 1)
    assert.equal((await post('/api/library/delete-paper', { topic: 'A', name: 'P' })).status, 200)
    const list = await call('/api/library/trash')
    assert.equal(list.body.items.length, 1)
    const id = list.body.items[0].id
    const restored = await post('/api/library/trash/restore', { id })
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    // sessions 与侧栏树同一份口径（GET /api/sessions 的条数）：归档的、被顶替的空白草稿不算
    assert.deepEqual(
      (({ ok, kind, topic, name, dirRel, topicRecreated, sessions }) => ({ ok, kind, topic, name, dirRel, topicRecreated, sessions }))(restored.body),
      { ok: true, kind: 'paper', topic: 'A', name: 'P', dirRel: 'A/P', topicRecreated: false, sessions: { total: 2, running: 0 } })
    assert.ok(existsSync(join(root, 'A', 'P', 'P.pdf')))
    const listed = (await call('/api/sessions?topic=A&name=P')).body.sessions
    assert.equal(listed.filter((s) => s.n === 1).length, 1, '恢复后历史会话重新挂回这篇文献')
    assert.equal(listed.length, restored.body.sessions.total, '提示里的数量必须等于树上接着显示的条数')
    assert.deepEqual(listed.map((s) => s.n), [1, 4])
    assertNoAbsPath(list.body, root)
    assertNoAbsPath(restored.body, root)
  } finally { srv.close() }
})

test('H2 HTTP：purge 删一条；empty 必须带 confirm=empty-trash（否则 400 且一个字节没动）', async () => {
  const root = newLibrary()
  deletePaper(root, 'A', 'P')
  deletePaper(root, 'A', 'Q')
  const { srv, call, post } = await boot(root)
  try {
    let items = (await call('/api/library/trash')).body.items
    assert.equal(items.length, 2)
    assert.deepEqual((await post('/api/library/trash/purge', { id: items[0].id })).body, { ok: true, id: items[0].id })
    items = (await call('/api/library/trash')).body.items
    assert.equal(items.length, 1)
    const before = snapshot(trashDir(root))
    for (const body of [{}, { confirm: 'empty' }, { confirm: 'EMPTY-TRASH' }]) {
      const refused = await post('/api/library/trash/empty', body)
      assert.equal(refused.status, 400, JSON.stringify(body))
      assert.equal(refused.body.code, 'confirm-mismatch')
    }
    assert.deepEqual(snapshot(trashDir(root)), before, '缺 confirm 时一个字节都不能动')
    assert.deepEqual((await post('/api/library/trash/empty', { confirm: 'empty-trash' })).body, { ok: true, purged: 1, failed: [] })
    assert.ok(!existsSync(trashDir(root)))
    assert.deepEqual((await call('/api/library/trash')).body, { items: [], count: 0, totalBytes: 0 })
  } finally { srv.close() }
})

test('H3 HTTP 错误通道：非法 id 400 / 不存在 404 / 原位置被占 409 / 不能恢复 409，响应里都不含服务端绝对路径', async () => {
  const root = newLibrary()
  deletePaper(root, 'A', 'P')
  mkdirSync(join(root, 'A', 'P'))
  writeFileSync(join(root, 'A', 'P', 'P.pdf'), 'new')
  const { srv, call, post } = await boot(root)
  try {
    const real = realpathSync(root)
    const clean = (r) => assert.ok(!r.text.includes(root) && !r.text.includes(real), `响应不得含服务端绝对路径：${r.text}`)
    for (const [path, body, status, code] of [
      ['/api/library/trash/restore', { id: '../x' }, 400, 'bad-request'],
      ['/api/library/trash/restore', { id: 'nope' }, 404, 'not-found'],
      ['/api/library/trash/restore', {}, 400, 'bad-request'],
      ['/api/library/trash/purge', { id: '' }, 400, 'bad-request'],
      ['/api/library/trash/purge', { id: 'nope' }, 404, 'not-found'],
    ]) {
      const r = await post(path, body)
      assert.deepEqual([r.status, r.body.code], [status, code], `${path} ${JSON.stringify(body)}`)
      clean(r)
    }
    const id = (await call('/api/library/trash')).body.items[0].id
    const clash = await post('/api/library/trash/restore', { id })
    assert.deepEqual([clash.status, clash.body.code], [409, 'target-exists'])
    assert.equal(readFileSync(join(root, 'A', 'P', 'P.pdf'), 'utf8'), 'new', '现有文献不得被覆盖')
    rmSync(join(trashDir(root), id.split('/')[0], 'P', 'P.pdf'))
    const blocked = await post('/api/library/trash/restore', { id })
    assert.deepEqual([blocked.status, blocked.body.code, blocked.body.reason], [409, 'restore-blocked', 'incomplete'])
    clean(clash)
    clean(blocked)
  } finally { srv.close() }
})

// ═══════════════════════════════════════════════════════════════════════════
// U. UI 静态契约 + 文档同步
// ═══════════════════════════════════════════════════════════════════════════

test('U1 UI 静态契约：侧栏头部有回收站按钮；面板只走服务端接口；彻底删除与清空必须过确认框', () => {
  const client = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const has = (re, what) => assert.ok(re.test(client), `lib/client.js 缺：${what}`) // 用 ok(match)：失败时不把整个文件当 actual 打出来
  has(/'data-dpr-trash-btn': ''/, '侧栏头部的回收站按钮')
  has(/function TrashDialog\(/, '回收站面板组件')
  for (const p of ['/library/trash', '/library/trash/restore', '/library/trash/purge', '/library/trash/empty']) {
    has(new RegExp(`api\\('${p.replaceAll('/', '\\/')}'`), `面板对 ${p} 的调用`)
  }
  has(/confirm: 'empty-trash'/, '清空的 confirm 栅栏')
  has(/body: JSON\.stringify\(\{ id: item\.id \}\)/, '恢复只传条目 id——专题名/论文名一律由服务端重新读盘判定')
  // 彻底删除 / 清空只能作为确认框的 onConfirm 出现（定义 1 处 + 确认框引用 1 处），不许直接挂在行内按钮上
  for (const fn of ['doPurge', 'doEmpty']) {
    assert.equal([...client.matchAll(new RegExp(`\\b${fn}\\b`, 'g'))].length, 2, `${fn} 应恰好出现 2 次（定义 + 确认框 onConfirm）`)
    has(new RegExp(`onConfirm: [^\\n]*\\b${fn}\\b`), `${fn} 必须由确认框触发`)
  }
  has(/h\(ConfirmDelete,/, '不可逆操作必须复用页内确认框（Electron 无 window.confirm）')
  assert.ok(!/window\.(confirm|prompt)\s*\(/.test(client), '不得使用 window.confirm/prompt')
})

test('U2 文档同步：不再写「没有恢复界面」；两份 README 与两份功能文档都交代了回收站入口', () => {
  for (const f of ['docs/features.md', 'docs/features_EN.md', 'README.md', 'README_EN.md']) {
    // 先去掉 Markdown 加粗符号：文档里写的是「**回收站**按钮」，不能因为强调符号就判成没写入口
    const text = readFileSync(join(REPO, f), 'utf8').replaceAll('**', '')
    assert.ok(!/(无一键恢复 UI|No auto-cleanup or one-click restore UI)/.test(text), `${f} 仍写着没有恢复界面`)
    // 光出现「回收站」三个字不算——删除那条 bullet 本来就有；要求真的写到「按钮」这个入口
    assert.match(text, /回收站[^。\n]{0,12}按钮|[Tt]rash button/, `${f} 必须交代回收站入口（按钮）`)
  }
  // 需求文档：把「一键恢复 UI = 后续可选项」的旧决策更新掉，避免后人按旧结论行事
  const req = readFileSync(join(REPO, 'docs', 'reader-ux-requirements.md'), 'utf8')
  assert.ok(!/一键恢复 UI = 后续可选项/.test(req), 'docs/reader-ux-requirements.md 仍把回收站界面列为未做')
})
