// test/integration-upstream-merge.test.mjs — t2「与上游 a574288 整合」的回归用例。
//
// 整合把两处语义碰撞解决了，这里为**新产生的接口面**上锁（既有用例覆盖不到）：
//   G 组 · 文献管理：上游 v1.3.0 的 4 条路由名（对外规范）与我们分支的 4 条别名
//         共用同一批 handler —— 移入回收站可恢复、精确 stem、专题要 confirmName、
//         非空专题 409、上游 {topic,to} body 键兼容。
//   S 组 · 安全：**我自造**的越界矩阵（`../..`、`a/../../b`、绝对路径、`.`、NUL、
//         符号链接专题/文件）× 五条入口 → 全部 4xx，且库外哨兵目录字节级零变化。
//         （rebase 目标 a574288 不含 PR-1 的穿越修复，洞必须由整合后的实现自己堵。）
//   P 组 · PR-1 的三个收口（整合时一并带入）：创建/删除对称（创建走命名规范类）、
//         畸形 JSON 体 → 可读 4xx、历史遗留的不规范专题名仍可删除。
//   R 组 · 阅读器：翻页模式（上游重写的渲染循环）× 公式热区层（我们的）共存——
//         在 vm 里跑**真实** reader 脚本，断言 renderPaged 之后该页热区几何真的被铺上、
//         页节点上真的挂了 `.eqLayer`（这是唯一能在 CI 里防「翻页模式热区全哑」的手段）。
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。
// 破坏性用例一律在**临时库**里做（绝不动 ~/.dsh-paper-reader/data）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeEol, extractModuleScript } from './reader-script.mjs' // 行尾无关的 <script> 提取（Windows CRLF 检出）
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
const HOME = mkdtempSync(join(tmpdir(), 'dpr-merge-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)
const { resolveExistingTopicDir, validateEntryBoundary, validateName } = await import(pathToFileURL(dist('library-manage.js')).href)

/* ── fixture ─────────────────────────────────────────────────────────────── */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 1 /Root 1 0 R >>\n%%EOF\n', 'latin1')
const DATA = mkdtempSync(join(tmpdir(), 'dpr-merge-data-'))
const OUTSIDE = mkdtempSync(join(tmpdir(), 'dpr-merge-out-'))
// 库外哨兵：目录 + 文件（任何越界操作都会改到它们的 size/mtime，甚至删掉）
mkdirSync(join(OUTSIDE, 'sentinel-dir'), { recursive: true })
writeFileSync(join(OUTSIDE, 'sentinel.txt'), 'must stay byte-identical')
writeFileSync(join(OUTSIDE, 'sentinel-dir', 'inner.txt'), 'must stay')

/* ── host 挂到真实 http server（与既有 reader-ux 用例同一套 ctx 形状） ────── */
let spec = null
const makeCtx = (over = {}) => ({
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => undefined },
  sessionController: { list: async () => ({ items: [] }) },
  workspaceController: {}, workspaceRegistry: {},
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
  return { srv, api, postJson: (p, obj) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }) }
}
const LIVE = await boot()
LIVE.srv.unref?.() // 不要把事件循环钉住（否则 node --test 收尾要等到超时）
const api = (p, o) => LIVE.api(p, o)
const postJson = (p, o) => LIVE.postJson(p, o)

/* ── 递归快照：证明「库外零变化」 ─────────────────────────────────────────── */
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

/** 造一篇带**全部**派生产物的文献（含 -en/-zh/-dual 与 .tmp-*）。 */
function scaffold(topic, name) {
  const dir = join(DATA, topic)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), PDF)
  for (const s of ['.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json']) writeFileSync(join(dir, name + s), 'x')
  writeFileSync(join(dir, `${name}-en.pdf`), 'en')
  writeFileSync(join(dir, `${name}-zh.pdf`), 'zh')
  writeFileSync(join(dir, `${name}-dual.pdf`), 'dual')
  writeFileSync(join(dir, `${name}.pdf.tmp-4321-abcd1234`), 'tmp')
  return dir
}

/* ═══ G 组 · 上游路由名与我们别名共用加固实现 ═══════════════════════════════ */

test('G1 上游 delete-paper / 我们的 paper/delete 别名：一批产物全进回收站，`.pdf` 最后移，可恢复', async () => {
  scaffold('g1', 'Paper One')
  scaffold('g1', 'Paper One Is Long') // 必须不被连带
  const dir = join(DATA, 'g1')
  const before = readdirSync(dir).sort()

  // 上游对外路径 + 上游 body 键 {topic,name}
  const r = await postJson('/api/library/delete-paper', { topic: 'g1', name: 'Paper One' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.name, 'Paper One')
  assert.ok(r.body.moved.length >= 10, `派生产物必须整批入回收站：${JSON.stringify(r.body.moved)}`)
  assert.equal(r.body.moved[r.body.moved.length - 1], 'Paper One.pdf', '`.pdf` 必须最后移（失败时文献仍在库里可见）')
  for (const s of ['.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json', '-en.pdf', '-zh.pdf', '-dual.pdf']) {
    assert.ok(r.body.moved.includes('Paper One' + s), `缺 ${s}：${JSON.stringify(r.body.moved)}`)
  }
  assert.ok(r.body.moved.some((f) => f.includes('.tmp-')), '在途临时文件也要移走（否则回收站外残留孤儿）')

  // 精确 stem：`Paper One Is Long` 一个字节都不能变
  const after = readdirSync(dir).sort().filter((f) => f.startsWith('Paper One Is Long'))
  const beforeLong = before.filter((f) => f.startsWith('Paper One Is Long'))
  assert.deepEqual(after, beforeLong, '精确 stem 匹配：不得连带同名前缀的其他文献')

  // 可恢复：回收站里真有这些文件 + manifest.json
  const trash = join(DATA, r.body.trashRel)
  assert.ok(existsSync(trash), '回收站目录必须存在')
  assert.ok(r.body.moved.every((f) => existsSync(join(trash, f))), '响应里 moved 的每个文件都要真的在回收站里')
  assert.ok(existsSync(join(trash, 'manifest.json')), '回收站必须有可读的 manifest.json')
  assert.ok(!existsSync(join(dir, 'Paper One.pdf')), '原件必须已移走')

  // 我们的别名路径 + body 键 {topic,name} 等价
  const r2 = await postJson('/api/library/paper/delete', { topic: 'g1', name: 'Paper One Is Long' })
  assert.equal(r2.status, 200, r2.text)
  assert.equal(r2.body.moved[r2.body.moved.length - 1], 'Paper One Is Long.pdf')
})

test('G2 上游 rename-paper {topic,name,to} 与别名 {..,newName}：全部产物一起改名，响应带 detachedSessions', async () => {
  scaffold('g2', 'Old Name')
  const up = await postJson('/api/library/rename-paper', { topic: 'g2', name: 'Old Name', to: 'New Name' })
  assert.equal(up.status, 200, up.text)
  assert.equal(up.body.to, 'New Name')
  assert.equal(typeof up.body.detachedSessions, 'number', '会话解挂数必须回给前端（改名的已知代价要说清）')
  assert.ok(existsSync(join(DATA, 'g2', 'New Name.mineru.json')), '.mineru.json 必须跟着改名')
  assert.ok(existsSync(join(DATA, 'g2', 'New Name-dual.pdf')), '-dual 变体必须跟着改名')
  assert.ok(!existsSync(join(DATA, 'g2', 'Old Name.pdf')))

  // 别名 + 我们的 body 键
  const alias = await postJson('/api/library/paper/rename', { topic: 'g2', name: 'New Name', newName: 'Third Name' })
  assert.equal(alias.status, 200, alias.text)
  assert.equal(alias.body.to, 'Third Name')
  // -zh/-dual/-en 结尾的新名必须被拒（会被 isPaperPDF 当成译文变体而从库里消失）
  const bad = await postJson('/api/library/paper/rename', { topic: 'g2', name: 'Third Name', to: 'Broken-zh' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'bad-name')
})

test('G3 上游 rename-topic/delete-topic：confirmName 必需、非空专题 409、空专题进回收站语义', async () => {
  mkdirSync(join(DATA, 'g3-empty'), { recursive: true })
  scaffold('g3-full', 'P')
  assert.equal((await postJson('/api/library/rename-topic', { topic: 'g3-empty', to: 'g3-renamed' })).status, 200)
  assert.ok(existsSync(join(DATA, 'g3-renamed')) && !existsSync(join(DATA, 'g3-empty')))
  // 响应带 topic（上游 UI/文档的读法）+ from/to（我们的）
  const ren = await postJson('/api/library/rename-topic', { topic: 'g3-renamed', to: 'g3-again' })
  assert.equal(ren.status, 200, ren.text)
  assert.equal(ren.body.topic, 'g3-again')

  // 删除专题：confirmName 是**可选**栅栏——给了就必须完全一致（400 confirm-mismatch）；
  // 没给也照走全部前置：空专题免确认（上游 delete-topic {topic} 的契约：无数据可毁），非空一律 409。
  mkdirSync(join(DATA, 'g3-noconfirm'), { recursive: true })
  const noConfirm = await postJson('/api/library/delete-topic', { topic: 'g3-noconfirm' })
  assert.equal(noConfirm.status, 200, `空专题免确认（上游契约）：${noConfirm.text}`)
  assert.ok(!existsSync(join(DATA, 'g3-noconfirm')), '空专题按上游契约被删除')
  const mismatch = await postJson('/api/library/delete-topic', { topic: 'g3-again', confirmName: 'nope' })
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.code, 'confirm-mismatch')
  // 非空专题：409 topic-not-empty（比上游「一点递归删光」更保守，是有意差异）
  const full = await postJson('/api/library/delete-topic', { topic: 'g3-full', confirmName: 'g3-full' })
  assert.equal(full.status, 409)
  assert.equal(full.body.code, 'topic-not-empty')
  assert.ok(existsSync(join(DATA, 'g3-full', 'P.pdf')), '被拒时一个文件都不能动')
  // 空专题：200（别名路径同款）
  const ok = await postJson('/api/library/topic/delete', { name: 'g3-again', confirmName: 'g3-again' })
  assert.equal(ok.status, 200, ok.text)
  assert.ok(!existsSync(join(DATA, 'g3-again')))
})

/* ═══ S 组 · 自造越界矩阵 × 五条入口（库外零变化） ═══════════════════════════ */

test('S1 五条入口 × 越界输入一律 4xx 带 code；库外哨兵目录字节级零变化', async () => {
  scaffold('s1', 'Victim')
  const outsideSnap = snap(OUTSIDE)
  const dataSnap = snap(DATA)
  // 绝对路径目标：指向库外哨兵（若实现有洞，这些会被删/被改名/被写）
  const ABS = join(OUTSIDE, 'sentinel.txt')
  const ABSDIR = join(OUTSIDE, 'sentinel-dir')
  const evil = ['../../..', '../', 'a/../../b', '..', '.', '', '  ', '/etc/passwd', ABS, ABSDIR, 'x\u0000y', 'a/b', 'a\\b', '....//....//etc']
  const rejected = []
  const ok4xx = (r, why) => {
    assert.ok(r.status >= 400 && r.status < 500, `${why} 必须 4xx：${r.status} ${r.text}`)
    assert.ok(typeof r.body?.code === 'string' && r.body.code.length > 0, `${why} 必须带机器可读 code：${r.text}`)
    assert.ok(!r.text.includes(OUTSIDE), `${why} 响应不得回显库外绝对路径：${r.text}`)
    rejected.push(`${why} → ${r.status}/${r.body.code}`)
  }
  for (const x of evil) {
    ok4xx(await postJson('/api/library/delete-topic', { topic: x, confirmName: x }), `delete-topic ${JSON.stringify(x)}`)
    ok4xx(await postJson('/api/library/topic/delete', { name: x, confirmName: x }), `topic/delete ${JSON.stringify(x)}`)
    ok4xx(await postJson('/api/library/rename-topic', { topic: x, to: 'zz' }), `rename-topic(from) ${JSON.stringify(x)}`)
    ok4xx(await postJson('/api/library/topic/rename', { name: x, newName: 'zz' }), `topic/rename(from) ${JSON.stringify(x)}`)
    ok4xx(await postJson('/api/library/delete-paper', { topic: 's1', name: x }), `delete-paper(name) ${JSON.stringify(x)}`)
    ok4xx(await postJson('/api/library/paper/delete', { topic: x, name: 'Victim' }), `paper/delete(topic) ${JSON.stringify(x)}`)
    ok4xx(await postJson('/api/library/rename-paper', { topic: 's1', name: 'Victim', to: x }), `rename-paper(to) ${JSON.stringify(x)}`)
    // upload：x-dpr-topic 与文件名两侧
    ok4xx(await api('/api/library/upload', {
      method: 'POST',
      headers: { 'x-dpr-topic': encodeURIComponent(x), 'x-dpr-name': encodeURIComponent('u.pdf'), 'content-type': 'application/pdf' },
      body: PDF,
    }), `upload(topic) ${JSON.stringify(x)}`)
    // 文件名侧：带 .pdf 后缀才走到名字校验（否则先被「只支持 PDF 文件」挡下，属于另一条判据）
    ok4xx(await api('/api/library/upload', {
      method: 'POST',
      headers: { 'x-dpr-topic': encodeURIComponent('s1'), 'x-dpr-name': encodeURIComponent(`${x}.pdf`), 'content-type': 'application/pdf' },
      body: PDF,
    }), `upload(name) ${JSON.stringify(x)}`)
  }
  assert.ok(rejected.length >= 90, `自造矩阵至少要有 90 次拒绝（实测 ${rejected.length}）`)
  assert.deepEqual(diffSnap(outsideSnap, snap(OUTSIDE)), [], '库外哨兵目录必须零变化')
  assert.deepEqual(diffSnap(dataSnap, snap(DATA)), [], '被拒的请求不得改动文献库本身')
})

test('S2 符号链接逃逸：专题 → 库外目录、文件名 → 库外文件，全部拒绝且链接目标无损', async () => {
  try { symlinkSync(OUTSIDE, join(DATA, 'evil-topic'), 'dir') } catch { /* 已存在 */ }
  try { symlinkSync(join(OUTSIDE, 'sentinel.txt'), join(DATA, 's1', 'linked.pdf'), 'file') } catch { /* 已存在 */ }
  const outsideSnap = snap(OUTSIDE)
  const cases = [
    ['delete-topic', { topic: 'evil-topic', confirmName: 'evil-topic' }],
    ['topic/delete', { name: 'evil-topic', confirmName: 'evil-topic' }],
    ['rename-topic', { topic: 'evil-topic', to: 'moved' }],
    ['topic/rename', { name: 'evil-topic', newName: 'moved' }],
    ['delete-paper', { topic: 'evil-topic', name: 'sentinel' }],
    ['paper/delete', { topic: 'evil-topic', name: 'sentinel' }],
    ['rename-paper', { topic: 'evil-topic', name: 'sentinel', to: 'x' }],
    ['delete-paper', { topic: 's1', name: 'linked' }],   // 文献 .pdf 是符号链接 → 不是文献（404）
    ['paper/delete', { topic: 's1', name: 'linked' }],
  ]
  for (const [path, body] of cases) {
    const r = await postJson('/api/library/' + path, body)
    assert.ok(r.status >= 400 && r.status < 500, `${path} ${JSON.stringify(body)} 必须 4xx：${r.status} ${r.text}`)
    assert.ok(['bad-name', 'bad-request', 'escape-rejected', 'not-found'].includes(r.body?.code), `code 应可读：${r.text}`)
  }
  // upload 到符号链接专题也必须被拒（不能让写落到库外）
  const up = await api('/api/library/upload', {
    method: 'POST',
    headers: { 'x-dpr-topic': encodeURIComponent('evil-topic'), 'x-dpr-name': encodeURIComponent('u.pdf'), 'content-type': 'application/pdf' },
    body: PDF,
  })
  assert.equal(up.status, 400)
  assert.ok(['bad-name', 'escape-rejected'].includes(up.body.code), up.text)
  assert.deepEqual(diffSnap(outsideSnap, snap(OUTSIDE)), [], '符号链接目标（库外）必须零变化')
  assert.ok(lstatSync(join(DATA, 'evil-topic')).isSymbolicLink(), '专题符号链接本身必须还在（只拒绝、不销毁）')
  assert.ok(existsSync(join(OUTSIDE, 'sentinel.txt')))
})

/* ═══ P 组 · PR-1 的三个收口（整合时一并带入） ══════════════════════════════ */

test('P1 创建/删除对称：能创建的必然能删除；命名不规范的创建一律 4xx', async () => {
  // ⚠️ `a/b` 不再是非法输入（topic 升级为相对路径，逐段校验）——它现在要求父目录已存在
  for (const bad of ['.hidden', 'a'.repeat(300), 'x\u0000y', '..', '']) {
    const r = await postJson('/api/library/topic', { name: bad })
    assert.ok(r.status >= 400 && r.status < 500, `创建 ${JSON.stringify(bad)} 必须 4xx：${r.status} ${r.text}`)
    assert.equal(r.body.code, 'bad-name')
  }
  // 路径语义（方案 §B2.2）：mkdir(recursive) 天然建多级 ⇒ 一次可建 `A/B`
  const nested = await postJson('/api/library/topic', { name: 'a/b' })
  assert.equal(nested.status, 200, `多级子专题可一次创建：${nested.status} ${nested.text}`)
  assert.equal(nested.body.topic, 'a/b')
  assert.ok(existsSync(join(DATA, 'a', 'b')), 'a/b 必须真的落盘')
  const ok = await postJson('/api/library/topic', { name: 'p1-ok' })
  assert.equal(ok.status, 200, ok.text)
  // 能创建的（含中文 / 空格 / 点号）必然能删除
  for (const name of ['p1-ok', '点号.名', 'with space']) {
    await postJson('/api/library/topic', { name })
    const d = await postJson('/api/library/delete-topic', { topic: name, confirmName: name })
    assert.equal(d.status, 200, `能创建的 ${JSON.stringify(name)} 必须能删除：${d.text}`)
  }
})

test('P2 畸形 JSON 体 / 非对象体 → 可读 4xx（不是外层兜底的 500）', async () => {
  for (const raw of ['{ not json', 'null', '"str"', '[1,2]', '']) {
    const r = await api('/api/library/delete-paper', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })
    assert.ok(r.status >= 400 && r.status < 500, `畸形体 ${JSON.stringify(raw)} 必须 4xx（不是 500）：${r.status} ${r.text}`)
    assert.equal(typeof r.body?.code, 'string', `必须带机器可读 code：${r.text}`)
    assert.ok(!/at .*\.js:\d+/.test(r.text), `响应不得含堆栈：${r.text}`)
  }
})

test('P3 历史遗留的不规范专题名仍可删除；`.trash` 是保留名（不能当专题删/改名）', async (t) => {
  // 直接落盘造两个「写入路径造不出来」的专题目录（前导点 / 控制字符）
  mkdirSync(join(DATA, '.legacy'), { recursive: true })
  // Win32 路径层禁止 0x00-0x1F 控制字符出现在文件名里（落盘即 EINVAL）→ 控制字符那半段是 unix 专属。
  // Windows 上只跳过这半段（显式记一条 diagnostic），其余断言照跑 —— 上游 905dc59 的同款口径。
  const ctrlTopic = process.platform === 'win32' ? null : 'weird\u0001name'
  if (ctrlTopic) mkdirSync(join(DATA, ctrlTopic), { recursive: true })
  else t.diagnostic('win32：Win32 路径层不允许 0x01 控制字符落盘，跳过「控制字符专题名」半段')
  const d1 = await postJson('/api/library/delete-topic', { topic: '.legacy', confirmName: '.legacy' })
  assert.equal(d1.status, 200, `历史遗留的 .legacy 专题必须能删：${d1.text}`)
  assert.ok(!existsSync(join(DATA, '.legacy')))
  if (ctrlTopic) {
    const d2 = await postJson('/api/library/delete-topic', { topic: ctrlTopic, confirmName: ctrlTopic })
    assert.equal(d2.status, 200, `含控制字符的历史专题也必须能删：${d2.text}`)
  }
  // 边界类校验仍要挡住会逃逸的名字（不因放开命名规范而放开安全边界）
  for (const x of ['..', 'a/../b', '/abs', 'x\u0000y', '.', '']) {
    assert.throws(() => validateEntryBoundary(x, 'topic'), (e) => e?.code === 'bad-name', `边界类必须拒绝 ${JSON.stringify(x)}`)
  }
  assert.throws(() => resolveExistingTopicDir(DATA, '.trash'), (e) => e?.code === 'bad-name', '.trash 是保留名')
  mkdirSync(join(DATA, '.trash'), { recursive: true })
  const trashRes = await postJson('/api/library/delete-topic', { topic: '.trash', confirmName: '.trash' })
  assert.equal(trashRes.status, 400)
  assert.equal(trashRes.body.code, 'bad-name')
  assert.ok(existsSync(join(DATA, '.trash')), '回收站目录本身绝不能被「当专题删掉」')
  rmSync(join(DATA, '.trash'), { recursive: true, force: true })
})

/* ═══ R 组 · 翻页模式 × 公式热区（真实阅读器脚本，vm 内可观测） ═══════════════ */

// 行尾归一化后再取脚本（Windows 检出是 CRLF）——见 test/reader-script.mjs 的说明。
const READER_HTML = normalizeEol(readFileSync(join(ROOT, '..', 'reader', 'index.html'), 'utf8'))
const SCRIPT_SRC = extractModuleScript(READER_HTML, { where: 'reader/index.html' })

/** DOM stub：让孩子节点真正连起来（paintPage 靠 firstChild/lastChild 取 canvas/textLayer）。 */
function makeEl(tag = 'div') {
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' }
  const el = {
    tagName: tag.toUpperCase(), style, dataset: {}, children: [], className: '', classes: new Set(),
    textContent: '', value: '', innerHTML: '',
    classList: {
      add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !el.classes.has(c) : on) el.classes.add(c); else el.classes.delete(c) },
      contains: (c) => el.classes.has(c),
    },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c },
    append(...cs) { cs.forEach((c) => el.appendChild(c)) },
    remove() { const p = el.parentNode; if (p) p.children = p.children.filter((x) => x !== el) },
    closest(sel) {
      let n = el
      while (n) {
        if (sel === '.page[data-page]' && n.className === 'page' && n.dataset.page !== undefined) return n
        n = n.parentNode
      }
      return null
    },
    focus() {}, select() {}, click() {}, addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    contains() { return false }, scrollIntoView() {},
    getContext() { return {} },
    setAttribute() {}, setProperty() {},
  }
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null })
  Object.defineProperty(el, 'lastChild', { get: () => el.children[el.children.length - 1] ?? null })
  return el
}

/** 跑真实阅读器脚本，并把渲染链路与状态暴露出来；`created` 记录所有 createElement 结果。 */
function loadReader() {
  const els = new Map()
  const created = []
  const doc = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id) },
    createElement(tag) { const e = makeEl(tag); created.push(e); return e },
    querySelector() { return null }, querySelectorAll() { return [] },
    body: makeEl(), addEventListener() {}, removeEventListener() {},
    documentElement: makeEl(),
  }
  const win = {
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900,
    addEventListener() {}, getSelection: () => null,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  let textLayers = 0
  let textLayerHook = null
  const ctx = {
    document: doc, window: win, navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '' }, matchMedia: win.matchMedia,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    console, URLSearchParams, fetch: () => Promise.reject(new Error('no network in test')),
    Promise, Math, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Date, Set, Map,
    // observePages 用（滚动模式的当前页探测）
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } },
    // pdf.js 只需要 TextLayer 类（paintPage 用它渲染文本层）
    pdfjsLib: { TextLayer: class { async render() { textLayers++; if (textLayerHook) textLayerHook() } } },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  const harness = `
    ;globalThis.__t = {
      EQ_BY_PAGE, paintEqLayer, hitTestFormula, eqGeom, paintPage, makePageNode,
      token: () => renderToken, bumpToken: () => ++renderToken,
      setEq: (i) => { eqIndex = i }, setVariant: (v) => { zhVariant = v },
      setZoom: (z) => { zoomScale = z }, setPageMode: (m) => { pageMode = m },
      setCurPage: (n) => { curPage = n }, setPdfDoc: (d) => { pdfDoc = d },
      renderPaged, renderAllPages, rerender,
    };`
  vm.runInContext(SCRIPT_SRC + harness, ctx, { filename: 'reader-inline.js' })
  return { t: ctx.__t, els, created, textLayers: () => textLayers, setTextLayerHook: (f) => { textLayerHook = f } }
}

const pageNodes = (R) => R.created.filter((e) => e.className === 'page')
const eqLayers = (R) => R.created.filter((e) => e.className === 'eqLayer')

test('R1 翻页模式：renderPaged 真的把「该页」的公式热区铺上去（防 H1：热区全哑）', (t) => {
  const R = loadReader()
  const T = R.t
  // 该脚本在 vm 里跑：若上游的 #ver DOM 被弄丢（`getElementById('ver').textContent`），这里会直接抛
  assert.ok(R.els.get('ver'), '阅读器必须仍有 #ver 节点（Host 注入 __DPR_VERSION__ 用）')
  const MADE = [null, null, null, null]
  for (let i = 1; i <= 3; i++) MADE[i] = { calls: 0 }
  T.setPdfDoc({
    numPages: 3,
    getPage: async (i) => ({
      getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale, scale }),
      render: () => { MADE[i].calls++; return { promise: Promise.resolve() } },
      getTextContent: async () => ({ items: [] }),
    }),
  })
  T.setVariant(null)
  T.setZoom(1)
  T.setEq({
    source: 'mineru-local', reason: null, bboxSpace: 'normalized-1000',
    equations: [
      { id: 'p2-a', index: 1, page: 2, latex: '\\alpha', bbox: [100, 100, 300, 200] },
      { id: 'p2-b', index: 2, page: 2, latex: '\\beta', bbox: [500, 400, 800, 600] },
      { id: 'p3-a', index: 3, page: 3, latex: '\\gamma', bbox: [10, 10, 90, 90] },
    ],
  })

  return (async () => {
    T.setPageMode('paged')
    T.setCurPage(2)
    await T.renderPaged()
    assert.equal(MADE[2].calls, 1, '翻页模式只渲染 curPage 一页')
    assert.equal(MADE[1].calls + MADE[3].calls, 0, '翻页模式不得顺带渲染别页')
    const items = T.EQ_BY_PAGE.get(2)
    assert.ok(Array.isArray(items), '翻页模式下 EQ_BY_PAGE 必须写入该页几何（否则命中测试恒空）')
    assert.equal(items.length, 2, `第 2 页有 2 条公式，热区几何必须 2 条：${JSON.stringify(items)}`)
    assert.equal(T.EQ_BY_PAGE.get(3), undefined, '未渲染的页不得有几何')
    // 几何本身：bbox 归一化 × viewport（612×792，scale 1）
    const g = items.find((x) => x.eq.id === 'p2-a')
    assert.equal(g.x0, 100 * 0.612)
    assert.equal(g.y0, 100 * 0.792)
    // 热区层真的挂在该页节点上（pointer-events:none 的覆盖层，不是抢鼠标的层）
    const page = pageNodes(R).pop()
    assert.ok(page.children.some((c) => c.className === 'eqLayer'), '页节点上必须挂 .eqLayer')
    assert.equal(eqLayers(R).length, 1)
    assert.equal(page.children.filter((c) => c.className === 'eqLayer').length, 1, '只许铺一层（重复铺会覆盖 EQ_BY_PAGE）')
    // 文本层容器必须是 textLayer（不是热区层）——写错会让文本层错位、划词失效
    assert.equal(R.textLayers(), 1, 'TextLayer 必须渲染一次')

    // 换页：旧页几何必须作废（否则命中整体偏移）
    T.setCurPage(3)
    await T.renderPaged()
    assert.equal(T.EQ_BY_PAGE.get(2), undefined, '换页后上一页几何必须作废（clearEqGeometry）')
    assert.equal(T.EQ_BY_PAGE.get(3).length, 1)

    // 缩放后重渲（翻页模式下走 rerender() = renderPaged，不得渲染全量页）——按**增量**计
    const base = MADE.map((m) => (m ? m.calls : 0))
    T.setZoom(2)
    await T.rerender()
    assert.equal(MADE[3].calls - base[3], 1, 'rerender() 在翻页模式只该重渲当前页')
    assert.equal((MADE[1].calls - base[1]) + (MADE[2].calls - base[2]), 0, 'rerender() 在翻页模式不得渲染别页（H4）')
    const g2 = T.EQ_BY_PAGE.get(3)[0]
    assert.equal(g2.x0, 10 * 1.224, '缩放后几何随新 viewport 重算（612*2/1000）')
    t.diagnostic(`翻页模式热区：页 2 = 2 条、页 3 = 1 条；换页/缩放后几何均正确`)
  })()
})

test('R2 滚动模式不回归：renderAllPages 每页都铺热区，且 `.paged` 类被摘掉', () => {
  const R = loadReader()
  const T = R.t
  T.setPdfDoc({
    numPages: 3,
    getPage: async () => ({
      getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale, scale }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: async () => ({ items: [] }),
    }),
  })
  T.setVariant(null)
  T.setZoom(1)
  T.setEq({
    source: 'mineru-local', reason: null, bboxSpace: 'normalized-1000',
    equations: [
      { id: 'a', index: 1, page: 1, latex: 'a', bbox: [10, 10, 20, 20] },
      { id: 'b', index: 2, page: 3, latex: 'b', bbox: [30, 30, 40, 40] },
    ],
  })
  return (async () => {
    T.setPageMode('scroll')
    await T.renderAllPages()
    assert.equal(pageNodes(R).length, 3, '滚动模式渲染全量页')
    // 热区层是**每页一层**（层里放 .eq-box；没有公式的页层是空的），三页各一层
    assert.equal(eqLayers(R).length, 3, '每页各挂一层 .eqLayer')
    for (const page of pageNodes(R)) {
      assert.equal(page.children.filter((c) => c.className === 'eqLayer').length, 1, '每页只许一层（重铺会覆盖 EQ_BY_PAGE）')
    }
    assert.equal(T.EQ_BY_PAGE.get(1).length, 1)
    assert.equal(T.EQ_BY_PAGE.get(2).length, 0, '无公式的页：几何为空数组')
    assert.equal(T.EQ_BY_PAGE.get(3).length, 1)
    const container = R.els.get('pdf-pages')
    assert.equal(container.classes.has('paged'), false, '滚动模式必须摘掉 .paged（否则单页布局类残留）')
  })()
})

test('R3 结构保证（静态）：热区层 pointer-events:none、唯一铺层点在 paintPage、全量重渲走 rerender()', () => {
  assert.match(READER_HTML, /\.eqLayer \{[^}]*pointer-events: none/, '.eqLayer 必须仍是 pointer-events:none（不得改成抢 textLayer 拖拽选区的覆盖层）')
  const body = (name) => {
    const i = SCRIPT_SRC.indexOf(`function ${name}(`)
    assert.ok(i > 0, `缺少 ${name}`)
    // 从函数头到下一个顶层 `}` 行（缩进 0 的收尾）
    const end = SCRIPT_SRC.indexOf('\n}\n', i)
    return SCRIPT_SRC.slice(i, end)
  }
  const paint = body('paintPage')
  assert.ok(/paintEqLayer\(div, viewport/.test(paint), '唯一铺层点必须在 paintPage 里（滚动/翻页共用）')
  const paged = body('renderPaged')
  assert.ok(/paintPage\(/.test(paged), 'renderPaged 必须走 paintPage（热区随页铺）')
  assert.ok(!/paintEqLayer\(/.test(paged), 'renderPaged 不得自己再铺一层（会画两层并覆盖 EQ_BY_PAGE）')
  assert.ok(/clearEqGeometry\(\)/.test(paged), 'renderPaged 换页时必须清旧几何')
  assert.ok(/container\.classList\.add\('paged'\)/.test(paged))
  const all = body('renderAllPages')
  assert.ok(/container\.classList\.remove\('paged'\)/.test(all), '滚动模式必须摘掉 .paged')
  assert.ok(/clearEqGeometry\(\)/.test(all), 'renderAllPages 重建页节点时必须清旧几何')
  assert.ok(!/container: tl/.test(all), 'renderAllPages 循环体不得残留对 tl 的引用（会 ReferenceError，第一页就白屏）')
  assert.ok(!/paintEqLayer\(/.test(all), 'renderAllPages 不得自己铺层（改由 paintPage 统一铺）')
  // MinerU 重转：必须走 rerender()，否则翻页模式被拉回全量页（H4 / L6）
  const trIdx = SCRIPT_SRC.indexOf('async function transcribeWithMineru')
  assert.ok(trIdx > 0, '缺少 transcribeWithMineru')
  const tr = SCRIPT_SRC.slice(trIdx, SCRIPT_SRC.indexOf('\n}\n', trIdx))
  assert.ok(/await rerender\(\)/.test(tr), 'transcribeWithMineru 必须用 rerender()（按当前模式重渲）')
  assert.ok(!/renderAllPages\(\)/.test(tr), 'transcribeWithMineru 不得用 renderAllPages()（翻页模式会被拉回全量页）')
  // 顶栏 DOM 与脚本引用必须配对（任一 $('x') 为 null → 脚本开头即死）
  const ids = new Set([...READER_HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  const used = new Set()
  for (const m of SCRIPT_SRC.matchAll(/\$\(\s*.([A-Za-z0-9_-]+).\s*\)/g)) used.add(m[1])
  for (const m of SCRIPT_SRC.matchAll(/getElementById\(\s*.([A-Za-z0-9_-]+).\s*\)/g)) used.add(m[1])
  const missing = [...used].filter((x) => !ids.has(x))
  assert.deepEqual(missing, [], `脚本引用了不存在的 DOM id（会整个阅读器白屏）：${missing}`)
})

test('R4 翻页模式的几何→命中链（模拟 V-P1/V-P2/V-P3）：换页/缩放后命中跟着走，译文视图关热区', () => {
  const R = loadReader()
  const T = R.t
  T.setPdfDoc({
    numPages: 3,
    getPage: async () => ({
      getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale, scale }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: async () => ({ items: [] }),
    }),
  })
  T.setVariant(null)
  T.setZoom(1)
  T.setEq({
    source: 'mineru-local', reason: null, bboxSpace: 'normalized-1000',
    equations: [
      { id: 'p2-a', index: 1, page: 2, latex: '\\alpha', bbox: [100, 100, 300, 200] },
      { id: 'p3-a', index: 2, page: 3, latex: '\\gamma', bbox: [500, 500, 600, 600] },
    ],
  })
  // 事件桩：target = 该页里的 canvas，closest('.page[data-page]') 由 stub 逐级上溯
  const hitOn = (page, x, y) => T.hitTestFormula({ target: page.children[0], clientX: x, clientY: y })
  return (async () => {
    T.setPageMode('paged')
    T.setCurPage(2)
    await T.renderPaged()
    const p2 = pageNodes(R).pop()
    assert.equal(+p2.dataset.page, 2)
    // scale 1 下 p2-a 的 viewport 矩形：x 61.2..183.6、y 79.2..158.4
    assert.equal(hitOn(p2, 100, 100)?.eq?.id, 'p2-a', '矩形内必须命中')
    assert.equal(hitOn(p2, 185, 100)?.eq?.id, 'p2-a', '6pt 外扩内仍应命中（最近的）')
    assert.equal(hitOn(p2, 5, 700), null, '远离所有矩形 → 不是公式点击（不误报）')

    // 换页：新页命中新页的公式；旧页节点已被卸载，几何已作废 → 必须返回 null（否则点旧位置会误中）
    T.setCurPage(3)
    await T.renderPaged()
    const p3 = pageNodes(R).pop()
    assert.equal(+p3.dataset.page, 3)
    assert.equal(hitOn(p3, 340, 430)?.eq?.id, 'p3-a', 'bbox [500,500,600,600] → x 306..367.2、y 396..475.2')
    assert.equal(hitOn(p2, 100, 100), null, '换页后旧页不得再命中（EQ_BY_PAGE 已作废）')

    // 缩放两档后（V-P2）：新位置命中、旧位置不命中
    T.setZoom(2)
    await T.rerender()
    const p3z = pageNodes(R).pop()
    assert.equal(+p3z.dataset.page, 3)
    assert.equal(hitOn(p3z, 680, 860)?.eq?.id, 'p3-a', 'scale 2：x 612..734.4、y 792..950.4')
    assert.equal(hitOn(p3z, 340, 430), null, '缩放后旧坐标不得命中')

    // 译文视图（V-P3）：不铺热区层、命中恒 null；切回原文恢复
    T.setVariant('zh')
    await T.rerender()
    assert.equal(eqLayers(R).filter((e) => e.parentNode === pageNodes(R).pop()).length, 0, '译文视图不铺热区层')
    assert.equal(hitOn(pageNodes(R).pop(), 680, 860), null, '译文视图下不命中（bbox 只对原文页成立）')
    T.setVariant(null)
    await T.rerender()
    assert.equal(hitOn(pageNodes(R).pop(), 680, 860)?.eq?.id, 'p3-a', '切回原文后热区恢复')
  })()
})

test('G4 .study.json（t4-F1 回归）：改名连带、删除进回收站、清空后专题可删、kind 归类', async () => {
  scaffold('g4', 'Study Paper')
  writeFileSync(join(DATA, 'g4', 'Study Paper.study.json'), JSON.stringify({ plan: [], quizzes: [] }))
  // ① 改名连带（旧名不残留 → 不留孤儿）
  const ren = await postJson('/api/library/rename-paper', { topic: 'g4', name: 'Study Paper', to: 'Renamed' })
  assert.equal(ren.status, 200, ren.text)
  assert.ok(ren.body.moved.includes('Renamed.study.json'), `moved 必须报告 .study.json：${JSON.stringify(ren.body.moved)}`)
  assert.ok(existsSync(join(DATA, 'g4', 'Renamed.study.json')), '改名必须连带 .study.json（否则学习档案变孤儿、readStudy 找不到）')
  assert.ok(!existsSync(join(DATA, 'g4', 'Study Paper.study.json')), '旧名不得残留')
  // ② 删除：.study.json 进回收站；`.pdf` 仍最后移
  const del = await postJson('/api/library/delete-paper', { topic: 'g4', name: 'Renamed' })
  assert.equal(del.status, 200, del.text)
  assert.ok(del.body.moved.includes('Renamed.study.json'), `moved 必须含 .study.json：${JSON.stringify(del.body.moved)}`)
  assert.equal(del.body.moved[del.body.moved.length - 1], 'Renamed.pdf', '`.pdf` 仍必须最后移')
  assert.ok(existsSync(join(DATA, del.body.trashRel, 'Renamed.study.json')), '.study.json 必须真的在回收站里')
  // ③ 清空后删专题不再 409（残留 .study.json 曾永久阻塞删专题）
  const td = await postJson('/api/library/delete-topic', { topic: 'g4', confirmName: 'g4' })
  assert.equal(td.status, 200, `删完文献后专题必须可删（残留 .study.json 曾 409）：${td.text}`)
  assert.ok(!existsSync(join(DATA, 'g4')))
  // ④ kind 归类：study（不是 cache），delete-plan 里可直接区分
  scaffold('g5', 'K Paper')
  writeFileSync(join(DATA, 'g5', 'K Paper.study.json'), '{}')
  const plan = await api(`/api/library/paper/delete-plan?topic=g5&name=${encodeURIComponent('K Paper')}`)
  assert.equal(plan.status, 200, plan.text)
  const study = plan.body.files.find((f) => f.name === 'K Paper.study.json')
  assert.equal(study?.kind, 'study', `kindOf 必须把 .study.json 归类为 study：${JSON.stringify(plan.body.files)}`)
  assert.ok(plan.body.totalBytes >= 2, 'study 文件字节数必须计入清单总量')
  assert.match(plan.body.notDeleted.join(' '), /\.study\.json/, 'notDeleted 必须明说学习档案文件的去向（会话历史不删、档案文件随文献进回收站）')
})

test('R5 paintPage 的 token 守卫（t4-O5）：TextLayer 期间被抢占不得写回旧几何', () => {
  const R = loadReader()
  const T = R.t
  T.setVariant(null)
  T.setZoom(1)
  T.setEq({
    source: 'mineru-local', reason: null, bboxSpace: 'normalized-1000',
    equations: [{ id: 's1', index: 1, page: 2, latex: 'x', bbox: [100, 100, 300, 200] }],
  })
  const viewport = { width: 612, height: 792, scale: 1 }
  const page = { render: () => ({ promise: Promise.resolve() }), getTextContent: async () => ({ items: [] }) }
  return (async () => {
    const div = T.makePageNode(2, viewport)
    // ① 完全过期的 token：早早返回，绝不铺层
    await T.paintPage(page, div, viewport, T.token() - 1)
    assert.equal(T.EQ_BY_PAGE.get(2), undefined, '过期 token 不得写入几何')
    // ② 真场景（t3-F1/t4-O5）：render/getTextContent 都通过后，TextLayer.render() 期间被
    //    另一路渲染抢占（token 推进）——收尾若照写，就会把这一档（旧）缩放的几何写回
    //    EQ_BY_PAGE，命中随之整体偏移。这里用钩子在同一 await 里推进 token 复现。
    R.setTextLayerHook(() => T.bumpToken())
    await T.paintPage(page, div, viewport, T.token()) // 传入时**有效**，在 TextLayer 期间才失效
    assert.equal(T.EQ_BY_PAGE.get(2), undefined, 'TextLayer 期间被抢占 → 不得写几何（O5）')
    // ③ 无抢占：正常铺层
    R.setTextLayerHook(null)
    await T.paintPage(page, div, viewport, T.token())
    assert.equal(T.EQ_BY_PAGE.get(2)?.length, 1, '无抢占时必须正常铺层')
  })()
})

test('O 组（t4 评审 O1/O2/O4）：死键回接、UI 走规范名、注释改正、trashDir 记契约字段（O6/O8 契约裁定仅记录）', () => {
  const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  const host = readFileSync(join(ROOT, '..', 'src', 'host.ts'), 'utf8')
  const lm = readFileSync(join(ROOT, '..', 'src', 'library-manage.ts'), 'utf8')
  // O1：delPaper/delTopic 必须真的被 UI 引用（契约冻结键不能是死键）
  assert.match(client, /t\('delPaper'\)/, 'delPaper 必须接回 UI（行内 🗑 的 tooltip）')
  assert.match(client, /t\('delTopic'\)/, 'delTopic 必须被引用')
  // O2：删除也走上游规范名（重命名本来就是规范名）；别名只在服务端保留
  assert.match(client, /'\/library\/delete-paper'/, '删除文献必须走规范名 /library/delete-paper')
  assert.match(client, /'\/library\/delete-topic'/, '删除专题必须走规范名 /library/delete-topic')
  assert.ok(!/api\('\/library\/paper\/delete'/.test(client), 'UI 不应再打别名族')
  assert.ok(!/api\('\/library\/topic\/delete'/.test(client), 'UI 不应再打别名族')
  assert.ok(!/体 \{topic, confirmName\}/.test(host), 'host.ts 的过时注释必须改正（上游 UI 只发 {topic}）')
  assert.match(host, /confirmName === topic\|name/, '注释必须说明加固语义额外要求 confirmName')
  // O4：trashDir 是契约内的成功响应字段（S15 只约束错误响应）
  assert.match(lm, /trashDir 字段/, 'trashDir 必须被明确记为契约字段并说明 S15 边界')
  assert.match(client, /delete-plan/, '删除清单仍来自服务端 delete-plan（我们的扩展路由，无上游对应者）')
})

test('Q1 命名规范 ≠ 路径边界（t4 评审 [3]③）：创建/改名-to 拒 .hidden/超长，删除/改名-from 放行', async () => {
  for (const bad of ['.hidden', 'a'.repeat(300)]) {
    const r = await postJson('/api/library/topic', { name: bad })
    assert.equal(r.status, 400, `创建专题 ${JSON.stringify(bad.slice(0, 12))} 必须 400（命名规范）`)
    assert.equal(r.body.code, 'bad-name')
  }
  scaffold('q1', 'Visible')
  writeFileSync(join(DATA, 'q1', '.hidden.pdf'), PDF)
  writeFileSync(join(DATA, 'q1', '.hidden.txt'), 'x')
  // 改名-to 仍按命名规范拒；改名-from 只做边界校验 → 放行（这才有「看得见就能删/能改」）
  const toBad = await postJson('/api/library/rename-paper', { topic: 'q1', name: 'Visible', to: '.hidden2' })
  assert.equal(toBad.status, 400, `rename-to '.hidden2' 必须 400（命名规范）`)
  assert.equal(toBad.body.code, 'bad-name')
  const renFrom = await postJson('/api/library/rename-paper', { topic: 'q1', name: '.hidden', to: 'hidden-ok' })
  assert.equal(renFrom.status, 200, `rename-from '.hidden' 必须放行（边界类）：${renFrom.text}`)
  assert.ok(existsSync(join(DATA, 'q1', 'hidden-ok.pdf')) && existsSync(join(DATA, 'q1', 'hidden-ok.txt')), '改名连带同名产物')
  assert.ok(!existsSync(join(DATA, 'q1', '.hidden.pdf')))
  // 超长名（>255）：Linux 单目录项上限 255 字节，**无法落盘**，故在**校验层**对照两档口径：
  // 命名规范类（写入路径）拒长度，边界类（删除/rename-from）不挡长度（PR-1 的分层）
  const longName = 'L'.repeat(300)
  assert.throws(() => validateName(longName, 'paper'), (e) => e?.code === 'bad-name', 'validateName 必须拒超长名（创建/改名-to）')
  assert.equal(validateEntryBoundary(longName, 'paper').length, 300, 'validateEntryBoundary 不挡长度（删除/rename-from）')
  // 边界类仍挡安全边界（不因放开命名规范而放开安全）
  for (const bad of ['..', 'a/../b', '/abs', 'x\u0000y', '.trash']) {
    assert.throws(() => validateEntryBoundary(bad, 'paper'), (e) => e?.code === 'bad-name', `边界类必须拒绝 ${JSON.stringify(bad)}`)
  }
  // 危险输入仍一律拒绝（边界类不因放开命名规范而放开安全边界）
  for (const bad of ['..', 'a/../b', '/abs', 'x\u0000y', '.', '', '../../etc/passwd']) {
    const r = await postJson('/api/library/delete-paper', { topic: 'q1', name: bad })
    assert.ok(r.status >= 400 && r.status < 500, `危险输入 ${JSON.stringify(bad)} 仍必须 4xx：${r.status}`)
    assert.ok(['bad-name', 'bad-request', 'escape-rejected', 'not-found'].includes(r.body.code), r.text)
  }
})

test('Q2 端到端（t4 评审 [3]④）：手工放入 .hidden.pdf → 库里列出 → 能删除 → 磁盘消失且进回收站', async () => {
  scaffold('q2', 'K')
  writeFileSync(join(DATA, 'q2', '.hidden.pdf'), PDF)
  const listed = (await api('/api/library')).body.papers.filter((p) => p.topic === 'q2').map((p) => p.name)
  assert.ok(listed.includes('.hidden'), `隐藏名文献必须能被列出：${JSON.stringify(listed)}`)
  const del = await postJson('/api/library/delete-paper', { topic: 'q2', name: '.hidden' })
  assert.equal(del.status, 200, `隐藏名文献必须能删：${del.text}`)
  assert.ok(del.body.moved.includes('.hidden.pdf'))
  assert.ok(!existsSync(join(DATA, 'q2', '.hidden.pdf')), '磁盘上必须消失')
  assert.ok(existsSync(join(DATA, del.body.trashRel, '.hidden.pdf')), '且必须进回收站（可恢复）')
})
