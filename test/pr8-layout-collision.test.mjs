// test/pr8-layout-collision.test.mjs — 上游 PR #8 维护者评审「必修 B / C / F」的可区分用例。
//
// 对应 docs/pr8-maintainer-review.md：
//   B. 上传无碰撞检查（会吞数据）：往已存在的子专题目录 / 论文目录 / 旧平铺论文同名上传。
//   C. 目录-文件互踩（造成 API 不可见且不可删的孤儿）：
//      C1 论文目录当专题父（create-topic / upload topic / renameTopic 三处同门）
//      C2 create-topic 与同层旧平铺论文同名
//      C3 renameLegacyPaper 撞上已存在目录
//      C4 新布局 renamePaper 目标目录内同名残留文件被静默覆盖
//   F. boundaryOnly（删除 / 改名-from / 清空）不再施加创建侧的新长度上限。
//
// 约定（与 docs/pr8-maintainer-review.md 的「本轮统一红线」一致）：
//   · 破坏性实验一律 mkdtemp 临时库，绝不碰真实文献库；
//   · 只 import dist/*.js（跑前必须 `npm run build`）；
//   · 每条用例在 fdb45f2 基线上必须**红**、修复后必须**绿**（红/绿实测见
//     docs/evidence/pr8-layout-collision.md）。
//
// 平台事实分支：大小写敏感性不硬编码平台名，用 test/fs-probe.mjs 的实测探针。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { caseInsensitiveFs } from './fs-probe.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

const L = await import(pathToFileURL(dist('library.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// 主题配置等会写 $DSH_HOME；测试期间固定到临时目录，绝不碰真实 ~/.dsh。
const HOME = mkdtempSync(join(tmpdir(), 'dpr-lc-home-'))
process.env.DSH_HOME = HOME

/** 临时库：`<root>/data` 是文献库根。 */
function newLib() {
  const root = mkdtempSync(join(tmpdir(), 'dpr-lc-'))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局落一篇论文：`<data>/<topic>/<name>/<name>.pdf`。 */
function putPaper(data, topic, name, extra = ['.txt']) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.pdf'), `pdf:${topic}/${name}`)
  for (const s of extra) writeFileSync(join(dir, name + s), `body:${topic}/${name}`)
  return dir
}

/** 旧布局（未迁移）平铺落一篇论文：`<data>/<topic>/<name>.pdf`。 */
function putFlatPaper(data, topic, name, extra = ['.txt']) {
  mkdirSync(join(data, topic), { recursive: true })
  writeFileSync(join(data, topic, name + '.pdf'), `flatpdf:${name}`)
  for (const s of extra) writeFileSync(join(data, topic, name + s), `flatbody:${name}`)
}

/** 启动路由（与 test/darkmode-subtopic-features.test.mjs 的 boot 同构）。 */
async function boot(data) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const parse = (txt) => {
    try { return JSON.parse(txt) } catch { return null }
  }
  const get = async (p) => {
    const r = await fetch(base + p)
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  const postJson = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  const postRaw = async (p, buf, headers) => {
    const r = await fetch(base + p, { method: 'POST', headers, body: buf })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  const upload = (topic, name) => postRaw('/api/library/upload', Buffer.alloc(200, 1), {
    'x-dpr-topic': encodeURIComponent(topic),
    'x-dpr-name': encodeURIComponent(name),
    'content-type': 'application/pdf',
  })
  return { srv, get, postJson, postRaw, upload }
}

/** 库内结构快照（相对路径 → 文件内容 / 'dir'）：断言「被拒的操作零改动」。 */
function snap(data) {
  const out = {}
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      const rel = relative(data, p).split(sep).join('/')
      if (e.isDirectory()) { out[rel] = 'dir'; walk(p) } else out[rel] = readFileSync(p, 'utf8')
    }
  }
  walk(data)
  return out
}

/** 论文视图：`topic/name` 列表（列表 API 的唯一权威口径）。 */
async function paperKeys(get) {
  const lib = await get('/api/library')
  return lib.body.papers.map((p) => `${p.topic}/${p.name}`)
}

/* ═══════════════════════════════════════════════════════════════════════════
   B. 上传碰撞（会吞数据）
   ═══════════════════════════════════════════════════════════════════════════ */

test('B1 上传目标与已存在**子专题**同名 → 409，子专题及其论文仍可见（不得变成论文目录）', async () => {
  const { data } = newLib()
  putPaper(data, 'T/Sub', 'P')            // 子专题 T/Sub，其下论文 P
  const before = snap(data)
  const { srv, upload, get } = await boot(data)
  try {
    const up = await upload('T', 'Sub.pdf')
    assert.equal(up.status, 409, `必须 409（否则子专题被变成论文目录、其下论文整体消失）：${up.txt}`)
    assert.deepEqual(snap(data), before, '被拒的上传不得改动文献库')
    assert.equal(existsSync(join(data, 'T', 'Sub', 'Sub.pdf')), false, '子专题目录里绝不许出现同名 PDF')
    // 列表 / 树 / 范围清空计划都必须仍能看到子专题里的论文
    assert.deepEqual(await paperKeys(get), ['T/Sub/P'], '子专题里的论文必须仍被列表')
    const lib = await get('/api/library')
    const node = lib.body.tree[0]
    assert.deepEqual(node.children.map((c) => c.path), ['T/Sub'], 'T/Sub 必须仍是子专题')
    assert.deepEqual(node.children[0].papers, ['P'], '子专题内的论文必须还在树里')
    assert.equal(node.papers.includes('Sub'), false, 'T/Sub 绝不能同时被当成论文')
    assert.equal(L.listPapers(data, 'T').length, 1, 'listPapers 必须仍能列出子专题论文')
  } finally { srv.close() }
})

test('B2 上传目标与已存在**论文目录**同名 → 409，绝不覆盖/合并', async () => {
  const { data } = newLib()
  const dir = putPaper(data, 'T', 'P')
  const before = snap(data)
  const { srv, upload } = await boot(data)
  try {
    const up = await upload('T', 'P.pdf')
    assert.equal(up.status, 409, `必须 409（论文目录已存在，不得覆盖）：${up.txt}`)
    assert.deepEqual(snap(data), before, '不得覆盖论文目录里的任何产物')
    assert.equal(readFileSync(join(dir, 'P.pdf'), 'utf8'), 'pdf:T/P', 'P.pdf 内容必须原样')
  } finally { srv.close() }
})

test('B3 同层已有同名**旧平铺论文**产物（.pdf/.txt/.study.json/.embeddings.json）→ 409；新名字上传仍 200', async () => {
  for (const suffix of ['.pdf', '.txt', '.study.json', '.embeddings.json']) {
    const { data } = newLib()
    mkdirSync(join(data, 'T'), { recursive: true })
    const flat = join(data, 'T', `Flat${suffix}`)
    writeFileSync(flat, suffix === '.pdf' ? 'legacy pdf' : `legacy ${suffix}`)
    const before = snap(data)
    const { srv, upload, get } = await boot(data)
    try {
      const up = await upload('T', 'Flat.pdf')
      assert.equal(up.status, 409, `同层已有 Flat${suffix} 时必须 409（否则旧平铺论文被文件夹规则永久遮蔽）：${up.txt}`)
      assert.deepEqual(snap(data), before, `被拒的上传（${suffix}）不得改动文献库`)
      assert.equal(existsSync(join(data, 'T', 'Flat')), false, '不得创建同名论文文件夹')
      assert.ok(existsSync(flat), `旧平铺产物 Flat${suffix} 必须原地不动`)
      // 只残留一个后缀也要能挡住；同时确认干净名字仍能上传（不是把所有上传都拒了）
      const ok = await upload('T', 'Fresh.pdf')
      assert.equal(ok.status, 200, `干净名字必须仍能上传：${ok.txt}`)
      assert.equal(existsSync(join(data, 'T', 'Fresh', 'Fresh.pdf')), true, '落点仍是 <topic>/<stem>/<name>.pdf')
      assert.ok((await paperKeys(get)).includes('T/Fresh'))
    } finally { srv.close() }
  }
})

test('B4 仅大小写不同的同名目标 → 409 且错误文案点名冲突对象（平台事实分支，不硬编码跳过）', async () => {
  // 实测本平台文件系统是否大小写不敏感（不要用 process.platform 猜）。
  const insensitive = caseInsensitiveFs()
  const { data } = newLib()
  putPaper(data, 'T', 'Paper')                                   // 论文目录 T/Paper
  writeFileSync(join(data, 'T', 'Flat.pdf'), 'legacy flat')      // 旧平铺论文 T/Flat.pdf
  const before = snap(data)
  const { srv, upload } = await boot(data)
  try {
    const dirClash = await upload('T', 'paper.pdf')
    assert.equal(dirClash.status, 409,
      `${insensitive ? '大小写不敏感' : '大小写敏感'}盘上仅大小写不同的同名论文目录都必须 409：${dirClash.txt}`)
    assert.match(dirClash.txt, /Paper/, `错误文案必须点名冲突对象 Paper：${dirClash.txt}`)
    const fileClash = await upload('T', 'flat.pdf')
    assert.equal(fileClash.status, 409,
      `${insensitive ? '大小写不敏感' : '大小写敏感'}盘上仅大小写不同的同名平铺论文都必须 409：${fileClash.txt}`)
    assert.match(fileClash.txt, /Flat\.pdf/, `错误文案必须点名冲突对象 Flat.pdf：${fileClash.txt}`)
    assert.deepEqual(snap(data), before, '被拒的上传不得改动文献库（不得静默吞掉大小写变体）')
    if (!insensitive) {
      // 平台事实：ext4 这类大小写敏感盘上两个名字本可共存；我们仍选择 409 以保持跨平台确定性，
      // 但必须确认「没有创建出小写变体」——即不存在静默吞掉（这是评审 B 的真正风险）。
      assert.equal(existsSync(join(data, 'T', 'paper')), false, '大小写敏感盘上也绝不许创建小写变体目录')
      assert.equal(existsSync(join(data, 'T', 'flat.pdf')), false, '大小写敏感盘上也绝不许创建小写变体文件')
    }
  } finally { srv.close() }
})

test('B5 回归：正常新上传仍 200，落点 <topic>/<stem>/<name>.pdf（含自动建子专题）', async () => {
  const { data } = newLib()
  const { srv, upload, get } = await boot(data)
  try {
    const up = await upload('T/NewSub', 'Paper One.pdf')
    assert.equal(up.status, 200, up.txt)
    assert.equal(existsSync(join(data, 'T', 'NewSub', 'Paper One', 'Paper One.pdf')), true, '落点必须是论文文件夹')
    assert.equal(existsSync(join(data, 'T', 'NewSub', 'Paper One.pdf')), false, '绝不平铺到专题目录')
    assert.deepEqual(await paperKeys(get), ['T/NewSub/Paper One'])
    const lib = await get('/api/library')
    assert.equal(lib.body.tree[0].children[0].path, 'T/NewSub')
    assert.deepEqual(lib.body.tree[0].children[0].papers, ['Paper One'])
  } finally { srv.close() }
})

test('B6 碰撞校验发生在**消费请求体之前**（一个字节都不发也能立刻拿到 409）', async () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P')
  const { srv } = await boot(data)
  const port = srv.address().port
  try {
    const res = await new Promise((resolve, reject) => {
      let timer = null
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/paper-reader/api/library/upload',
        method: 'POST',
        headers: {
          'x-dpr-topic': 'T',
          'x-dpr-name': 'P.pdf',
          'content-type': 'application/pdf',
          'content-length': '400',          // 声明了 body 却**故意不发**
        },
      }, (r) => {
        let txt = ''
        r.on('data', (c) => { txt += c })
        r.on('end', () => { clearTimeout(timer); req.destroy(); resolve({ status: r.statusCode, txt }) })
      })
      timer = setTimeout(() => {
        req.destroy()
        reject(new Error('服务端没有在消费请求体之前返回（碰撞校验被放到了读 body 之后）'))
      }, 3000)
      req.on('error', (e) => { clearTimeout(timer); reject(e) })
      // 只发 header、不发 body：Node 默认要等 write/end 才发 header，这里显式 flush。
      // 只有「碰撞校验在读 body 之前」才可能拿到响应。
      req.flushHeaders()
      // 不调用 req.end()：body 永远不发送。
    })
    assert.equal(res.status, 409, `必须在不读 body 的情况下 409：${res.txt}`)
    assert.match(res.txt, /P/, `错误文案要点名冲突对象：${res.txt}`)
  } finally { srv.close() }
})

/* ═══════════════════════════════════════════════════════════════════════════
   C1. 论文目录不能当专题父（create-topic / upload topic / renameTopic 三处同门）
   ═══════════════════════════════════════════════════════════════════════════ */

test('C1a create-topic：祖先段是论文目录 → 409（不得在其下建子专题）', async () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P')               // T/P 是论文目录
  const before = snap(data)
  const { srv, postJson, get } = await boot(data)
  try {
    const r = await postJson('/api/library/topic', { name: 'T/P/New' })
    assert.equal(r.status, 409, `祖先段 T/P 是论文目录，必须 409：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的创建不得改动文献库')
    assert.deepEqual(await paperKeys(get), ['T/P'], '论文 T/P 必须仍在列表里')
  } finally { srv.close() }
})

test('C1b upload：topic 解析到论文目录 → 409（不得把新论文塞进论文目录）', async () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P')
  const before = snap(data)
  const { srv, upload, get } = await boot(data)
  try {
    const up = await upload('T/P', 'X.pdf')
    assert.equal(up.status, 409, `topic=T/P 是论文目录，上传必须 409：${up.txt}`)
    assert.deepEqual(snap(data), before, '被拒的上传不得改动文献库')
    assert.equal(existsSync(join(data, 'T', 'P', 'X')), false, '不得在论文目录里建新论文文件夹')
    assert.deepEqual(await paperKeys(get), ['T/P'], '论文 T/P 必须仍可见')
  } finally { srv.close() }
})

test('C1c renameTopic：目标父级是论文目录 → 409（不得把子专题树搬进论文目录）', async () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P')               // 论文目录 T/P
  mkdirSync(join(data, 'A', 'B'), { recursive: true })
  writeFileSync(join(data, 'A', 'B', 'B.pdf'), 'inside A/B')   // 让 A 有内容，证明搬家失败后仍在
  const before = snap(data)
  const { srv, postJson } = await boot(data)
  try {
    const r = await postJson('/api/library/rename-topic', { topic: 'A', to: 'T/P/A' })
    assert.equal(r.status, 409, `目标父级 T/P 是论文目录，必须 409：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
    assert.ok(existsSync(join(data, 'A', 'B', 'B.pdf')), '源子树必须原样留在原地')
    assert.equal(existsSync(join(data, 'T', 'P', 'A')), false, '绝不许把子专题树搬进论文目录')
  } finally { srv.close() }
})

/* ═══════════════════════════════════════════════════════════════════════════
   C2. create-topic 与同层旧平铺论文同名
   ═══════════════════════════════════════════════════════════════════════════ */

test('C2 create-topic 名与同层旧平铺论文同名 → 409（不得产生被遮蔽的不可见论文）', async () => {
  const { data } = newLib()
  putFlatPaper(data, 'T', 'Foo')         // 旧布局平铺论文 T/Foo.pdf
  const before = snap(data)
  const { srv, postJson, get } = await boot(data)
  try {
    const r = await postJson('/api/library/topic', { name: 'T/Foo' })
    assert.equal(r.status, 409, `同层已有旧平铺论文 Foo.pdf，建同名目录必须 409：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的创建不得改动文献库')
    assert.equal(existsSync(join(data, 'T', 'Foo')), false, '不得创建同名目录')
    assert.deepEqual(await paperKeys(get), ['T/Foo'], '旧平铺论文必须仍然可见（不得被文件夹规则遮蔽）')
    // 计划删除也必须仍能找到它（评审点名的 planPaperDelete 404 不得出现）
    const plan = await get(`/api/library/paper/delete-plan?topic=${encodeURIComponent('T')}&name=${encodeURIComponent('Foo')}`)
    assert.equal(plan.status, 200, `旧平铺论文的删除计划必须可用（不能被 404）：${plan.txt}`)
  } finally { srv.close() }
})

/* ═══════════════════════════════════════════════════════════════════════════
   C3. renameLegacyPaper 目标与已存在目录同名
   ═══════════════════════════════════════════════════════════════════════════ */

test('C3 旧平铺论文改名撞上已存在目录 → 409 target-exists（不得改名后不可见不可删）', async () => {
  const { data } = newLib()
  putFlatPaper(data, 'T', 'old')
  mkdirSync(join(data, 'T', 'new', 'Inner'), { recursive: true })
  writeFileSync(join(data, 'T', 'new', 'Inner', 'Inner.pdf'), 'subtopic paper')
  const before = snap(data)
  const { srv, postJson, get } = await boot(data)
  try {
    const r = await postJson('/api/library/rename-paper', { topic: 'T', name: 'old', to: 'new' })
    assert.equal(r.status, 409, `目标已存在目录 T/new，平铺改名必须 409：${r.txt}`)
    assert.equal(r.body.code, 'target-exists', `机器码必须是 target-exists：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
    assert.equal(existsSync(join(data, 'T', 'new.pdf')), false, '绝不许只把平铺 old.pdf 改成 new.pdf（会被目录遮蔽）')
    assert.deepEqual((await paperKeys(get)).sort(), ['T/new/Inner', 'T/old'], '旧平铺论文与新子专题都必须仍可见')
  } finally { srv.close() }
})

/* ═══════════════════════════════════════════════════════════════════════════
   C4. 新布局 renamePaper：目标目录内同名残留文件不得被静默覆盖
   ═══════════════════════════════════════════════════════════════════════════ */

test('C4 新布局改名：目标名残留文件 → 409，无静默覆盖、无回收站记录；清掉残留后可正常改名', async () => {
  const { data } = newLib()
  const dir = putPaper(data, 'T', 'Old', ['.txt'])
  writeFileSync(join(dir, 'New.txt'), 'LEFTOVER-MUST-SURVIVE')   // 目标名的残留文件（非旧名产物）
  const before = snap(data)
  const { srv, postJson } = await boot(data)
  try {
    const r = await postJson('/api/library/rename-paper', { topic: 'T', name: 'Old', to: 'New' })
    assert.equal(r.status, 409, `目标目录内已有 New.txt，必须 409 而不是静默覆盖：${r.txt}`)
    assert.equal(r.body.code, 'target-exists', r.txt)
    assert.deepEqual(snap(data), before, '被拒的改名必须零改动（目录名与所有文件都原样）')
    assert.equal(readFileSync(join(dir, 'New.txt'), 'utf8'), 'LEFTOVER-MUST-SURVIVE', '残留文件内容绝不许被覆盖')
    assert.equal(existsSync(join(data, 'T', 'New')), false, '不得先把目录改名再失败')
    assert.equal(existsSync(join(data, '.trash')), false, '失败路径不得留下回收站记录')

    // 清掉残留 → 正常改名必须成功，且产物跟随（回滚/两段式语义保持）
    rmSync(join(dir, 'New.txt'))
    const ok = await postJson('/api/library/rename-paper', { topic: 'T', name: 'Old', to: 'New' })
    assert.equal(ok.status, 200, `无冲突时必须成功：${ok.txt}`)
    assert.equal(existsSync(join(data, 'T', 'New', 'New.pdf')), true)
    assert.equal(existsSync(join(data, 'T', 'New', 'New.txt')), true)
    assert.equal(existsSync(join(data, 'T', 'Old')), false)
  } finally { srv.close() }
})

/* ═══════════════════════════════════════════════════════════════════════════
   F. boundaryOnly 长度回归（legacy 怪名字必须保持可删/可改名；创建侧仍按新上限）
   ═══════════════════════════════════════════════════════════════════════════ */

test('F1 110 字 legacy 专题名：可删除（不再 400），创建侧仍按 100 字上限拒绝', async () => {
  const long110 = 'L'.repeat(110)
  const { data } = newLib()
  mkdirSync(join(data, long110), { recursive: true })   // 上一版（上限 120）能创建的历史专题
  const { srv, postJson, upload } = await boot(data)
  try {
    // 创建侧保持新上限：110 > 100 ⇒ 400
    const created = await postJson('/api/library/topic', { name: long110 })
    assert.equal(created.status, 400, `创建侧仍必须按 100 字上限拒绝：${created.txt}`)
    assert.equal(created.body.code, 'bad-name')
    // 删除侧（boundaryOnly）不施加新上限：110 字 legacy 专题必须能删
    const del = await postJson('/api/library/delete-topic', { topic: long110 })
    assert.equal(del.status, 200, `110 字 legacy 专题必须能删（boundaryOnly 不卡新长度上限）：${del.txt}`)
    assert.equal(existsSync(join(data, long110)), false, '专题目录必须真的被删掉')
    // 上传侧（创建语义）仍不该接受 110 字新专题名
    const up = await upload(long110, 'x.pdf')
    assert.ok(up.status >= 400 && up.status < 500, `上传到 110 字新专题名必须 4xx：${up.txt}`)
  } finally { srv.close() }
})

test('F2 110 字 legacy 专题名：可作为 rename-from 改名（不再 400）', async () => {
  const long110 = 'R'.repeat(110)
  const { data } = newLib()
  mkdirSync(join(data, long110), { recursive: true })
  const { srv, postJson } = await boot(data)
  try {
    const r = await postJson('/api/library/rename-topic', { topic: long110, to: 'short-name' })
    assert.equal(r.status, 200, `110 字 legacy 专题必须能改名（rename-from 走边界类）：${r.txt}`)
    assert.equal(existsSync(join(data, 'short-name')), true, '目标目录必须出现')
    assert.equal(existsSync(join(data, long110)), false, '旧目录必须消失')
  } finally { srv.close() }
})

test('F3 boundaryOnly 也不误伤超过 MAX_TOPIC_PATH(200) 的已存在 legacy 路径', async () => {
  // 手工造出的历史嵌套路径：两段各 110 字 ⇒ 221 > 200。旧版本无嵌套概念，但「已存在的必须可删」
  // 是不变量；创建侧仍然拒绝这种超长路径。
  const a = 'A'.repeat(110)
  const b = 'B'.repeat(110)
  const { data } = newLib()
  mkdirSync(join(data, a, b), { recursive: true })
  const { srv, postJson } = await boot(data)
  try {
    const created = await postJson('/api/library/topic', { name: `${a}/${b}` })
    assert.equal(created.status, 400, `创建侧仍必须拒绝 >200 的路径：${created.txt}`)
    const del = await postJson('/api/library/delete-topic', { topic: `${a}/${b}` })
    assert.equal(del.status, 200, `boundaryOnly 下已存在的超长 legacy 路径必须可删：${del.txt}`)
    assert.equal(existsSync(join(data, a, b)), false, '目标目录必须真的被删掉')
  } finally { srv.close() }
})
