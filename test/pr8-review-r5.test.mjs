// test/pr8-review-r5.test.mjs — REV5（t12）对 IMP5（t11）C4 ino 守卫 + 大小写变体碰撞的**独立对抗探针**。
//
// 独立性声明（团队 profile 硬规则：评审必须自己构造证据）：
//   · 不 import 实现方 `test/pr8-platform-guards.test.mjs`；假 stat 矩阵、真实残留文件、hardlink 现场、
//     create/rename 的大小写场景、跨父级移动、三处口径对照全部由本评审自造。
//   · 只 import `dist/*.js`；库一律 `mkdtemp`，`DSH_HOME` 指向临时目录。
//   · 同一份探针可跑基线：`R5_REPO=/abs/.worktrees/pr8-baseline node --test test/pr8-review-r5.test.mjs`
//     ⇒ C4 静默覆盖 / create-topic 大小写假成功等缺陷应红（基线缺少 `sameFileForRename`，不是「跳过」）。
//
// 覆盖：
//   R5-INO   假 stat 直接打纯函数 sameFileForRename（0/0、0/1、0/123、123/0、123/123、123/456、sameEntry=false）
//   R5-C4    真实场景：目标残留文件存在 ⇒ 409 且内容不被覆盖；hardlink（同 inode 不同目录项）⇒ 仍 409；
//            合法的大小写-only 论文改名仍放行
//   R5-CASE  create-topic / renameTopic 的「仅大小写不同」同级碰撞 ⇒ 409 + 点名磁盘真名；精确同名仍幂等 200；
//            与 upload 三处口径对照；跨父级移动不受影响
//   R5-ADJ   【专项裁决】renameTopic 把**源自身**改成不同大小写（同父级、无其它碰撞）应仍可改名；
//            若被 t11 的变体检查挡住（409），属于对 Linux 的能力回退 ⇒ medium finding
//
// 判读：本文件绿 = 修复成立；红 = 消息带实际状态码/库快照差异。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { caseInsensitiveFs } from './fs-probe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = process.env.R5_REPO ? resolve(process.env.R5_REPO) : join(HERE, '..')
const BASELINE_MODE = Boolean(process.env.R5_REPO)
const dist = (m) => join(TARGET, 'dist', m)

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-r5-home-'))
const M = await import(pathToFileURL(dist('library-manage.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

const CASE_INSENSITIVE = caseInsensitiveFs()

// ── 夹具 ─────────────────────────────────────────────────────────────────────
function newLib(prefix = 'dpr-r5-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局论文 `<data>/<topic>/<name>/<name>.pdf`（+txt）。 */
function putPaper(data, topic, name) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), `pdf:${topic}/${name}`)
  writeFileSync(join(dir, `${name}.txt`), `body:${topic}/${name}`)
  return dir
}

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

async function boot(data) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }), create: async () => ({}), prompt: async () => {} },
    workspaceController: {},
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const parse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  const upload = async (topic, name) => {
    const r = await fetch(base + '/api/library/upload', {
      method: 'POST',
      headers: { 'x-dpr-topic': encodeURIComponent(topic), 'x-dpr-name': encodeURIComponent(name), 'content-type': 'application/pdf' },
      body: Buffer.alloc(200, 0x41),
    })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  return { srv, post, upload, close: () => { srv.closeAllConnections?.(); srv.close() } }
}

// ═════════════════════════════════════════════════════════════════════════════
// R5-INO：假 stat 直接打纯函数（不依赖真实 exFAT）
// ═════════════════════════════════════════════════════════════════════════════

test('R5-INO sameFileForRename 假 stat 矩阵：任一侧 ino/dev=0 ⇒ 冲突；两侧有效且同 dev+ino+同目录项才放行', (t) => {
  assert.equal(typeof M.sameFileForRename, 'function', 'dist/library-manage.js 必须导出纯函数 sameFileForRename（基线缺失）')
  const f = (ino, dev) => ({ ino, dev })
  const cases = [
    { a: f(0, 0), b: f(0, 0), sameEntry: true, want: false, why: '双侧 ino=0（exFAT 典型）⇒ 必须冲突' },
    { a: f(0, 1), b: f(0, 1), sameEntry: true, want: false, why: '双侧 ino=0 但 dev 有效（exFAT/SMB 常是 ino=0、dev=卷序列）⇒ 必须冲突' },
    { a: f(0, 1), b: f(123, 1), sameEntry: true, want: false, why: '一侧 ino=0 ⇒ 必须冲突' },
    { a: f(123, 1), b: f(123, 0), sameEntry: true, want: false, why: '一侧 dev=0 ⇒ 必须冲突' },
    { a: f(123, 1), b: f(123, 1), sameEntry: true, want: true, why: '两侧非 0 且同 dev+ino+同目录项 ⇒ 同一文件（大小写-only 改名放行）' },
    { a: f(123, 1), b: f(123, 1), sameEntry: false, want: false, why: '同 inode 但不同目录项（hardlink/别名）⇒ 必须冲突' },
    { a: f(123, 1), b: f(456, 1), sameEntry: true, want: false, why: '同 dev 不同 ino ⇒ 冲突' },
    { a: f(123, 1), b: f(123, 2), sameEntry: true, want: false, why: '同 ino 不同 dev ⇒ 冲突' },
  ]
  for (const c of cases) {
    const got = M.sameFileForRename(c.a, c.b, c.sameEntry)
    t.diagnostic(`ino ${c.a.ino}/${c.b.ino} dev ${c.a.dev}/${c.b.dev} sameEntry=${c.sameEntry} => ${got}`)
    assert.equal(got, c.want, `${c.why}（实际 ${got}）`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// R5-C4：真实残留文件 / hardlink / 合法大小写改名
// ═════════════════════════════════════════════════════════════════════════════

test('R5-C4-REAL 目标目录内已有同名残留文件 ⇒ renamePaper 409 且残留内容未被覆盖（基线 200 静默覆盖）', (t) => {
  const { root, data } = newLib('dpr-r5-c4-')
  try {
    const dir = putPaper(data, 'T', 'Old')
    writeFileSync(join(dir, 'New.txt'), 'RESIDUAL-MUST-SURVIVE')
    const before = snap(data)
    // ← 基线在此红：renamePaper 返回 OK 并把 New.txt 覆盖
    assert.throws(
      () => M.renamePaper(data, 'T', 'Old', 'New'),
      (e) => e && e.code === 'target-exists' && e.status === 409,
      '目标目录内已有 New.txt（不同文件）时必须 409，不得静默覆盖',
    )
    t.diagnostic(`snap unchanged=${JSON.stringify(snap(data)) === JSON.stringify(before)}`)
    assert.deepEqual(snap(data), before, '被拒的改名必须零改动')
    assert.equal(readFileSync(join(dir, 'New.txt'), 'utf8'), 'RESIDUAL-MUST-SURVIVE', '残留文件内容绝不许被覆盖')
    assert.equal(existsSync(join(data, 'T', 'New')), false, '不得先把目录改名再失败')

    // 清掉残留后同名改名必须成功（防「一律拒绝」的假修复）
    rmSync(join(dir, 'New.txt'))
    const ok = M.renamePaper(data, 'T', 'Old', 'New')
    assert.equal(ok.ok, true)
    assert.equal(existsSync(join(data, 'T', 'New', 'New.pdf')), true)
    assert.equal(existsSync(join(data, 'T', 'New', 'New.txt')), true)
    assert.equal(existsSync(join(data, 'T', 'Old')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R5-C4-HARDLINK 同 inode 的两个不同目录项（hardlink）⇒ 仍必须 409（守卫方向不许反）', (t) => {
  const { root, data } = newLib('dpr-r5-hl-')
  try {
    const dir = putPaper(data, 'T', 'Old')
    // 同 inode、不同目录项：只比 ino 的实现会误判「同一文件」而放行
    try { linkSync(join(dir, 'Old.txt'), join(dir, 'New.txt')) } catch (e) {
      t.diagnostic(`hardlink 不可用，跳过该场景（原因：${e.message}）`)
      return
    }
    const before = snap(data)
    // ← 基线在此红：没有逐文件预检 ⇒ 200，New/ 里留下孤儿 Old.txt
    assert.throws(
      () => M.renamePaper(data, 'T', 'Old', 'New'),
      (e) => e && e.code === 'target-exists' && e.status === 409,
      '同 inode 但不同目录项（hardlink）必须判冲突（realpath 不同 ⇒ 不是同一次改名）',
    )
    assert.deepEqual(snap(data), before, '被拒的改名必须零改动')
    assert.equal(readFileSync(join(dir, 'New.txt'), 'utf8'), 'body:T/Old', '别名文件内容必须原样')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R5-C4-CASEONLY 合法的大小写-only 论文改名仍放行（不得被 C4 守卫误伤）', (t) => {
  const { root, data } = newLib('dpr-r5-c4case-')
  try {
    putPaper(data, 'T', 'OldName')
    const r = M.renamePaper(data, 'T', 'OldName', 'oldname')
    assert.equal(r.ok, true, '大小写-only 改名是合法操作（同一次改名映射回自身），必须放行')
    assert.equal(existsSync(join(data, 'T', 'oldname', 'oldname.pdf')), true, `落点必须是新大小写：${JSON.stringify(readdirSync(join(data, 'T')))}`)
    assert.equal(existsSync(join(data, 'T', 'OldName')), false, '旧名目录必须消失')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// R5-CASE：create-topic / renameTopic 的大小写变体碰撞
// ═════════════════════════════════════════════════════════════════════════════

test('R5-CREATE-CASE 已存在仅大小写不同的同级专题 ⇒ 409 + 点名磁盘真名；不建第二个变体', async (t) => {
  const { root, data } = newLib('dpr-r5-cc-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/CaseTopic', 'P')
    const before = snap(data)
    const r = await s.post('/api/library/topic', { name: 'Alpha/casetopic' })
    t.diagnostic(`create case-variant => ${r.status} ${r.txt.slice(0, 160)}`)
    // ← 基线在此红：200，盘上并存 CaseTopic + casetopic
    assert.equal(r.status, 409, `仅大小写不同的同级专题已存在时必须 409：${r.status} ${r.txt}`)
    assert.equal(r.body?.code, 'target-exists', r.txt)
    assert.deepEqual(r.body?.conflicts, ['CaseTopic'], `conflicts 必须点名磁盘真名：${r.txt}`)
    assert.match(r.txt, /CaseTopic/, `错误文案必须点名磁盘真名：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的创建不得改动文献库')
    if (CASE_INSENSITIVE) {
      // 不敏感盘：两个拼写本来就是同一个目录别名（旧实现的 200 是假成功）
      assert.equal(realpathSync(join(data, 'Alpha', 'casetopic')), realpathSync(join(data, 'Alpha', 'CaseTopic')),
        '不敏感盘上 casetopic 与 CaseTopic 必须是同一目录实体')
    } else {
      assert.equal(existsSync(join(data, 'Alpha', 'casetopic')), false, '敏感盘上绝不许建出第二个大小写变体')
    }
    // 精确同名仍幂等 200（不能把重复创建误判成冲突）
    const again = await s.post('/api/library/topic', { name: 'Alpha/CaseTopic' })
    assert.equal(again.status, 200, `精确同名的重复创建必须幂等 200：${again.status} ${again.txt}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R5-RENAME-REAL renameTopic 目标与**别的**同级对象仅大小写不同 ⇒ 409 点名真名（基线 200）', async (t) => {
  const { root, data } = newLib('dpr-r5-rr-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/casetopic', 'P')   // 磁盘真名是小写
    putPaper(data, 'Alpha/Other', 'Q')
    const before = snap(data)
    const r = await s.post('/api/library/rename-topic', { name: 'Alpha/Other', to: 'Alpha/CaseTopic' })
    t.diagnostic(`rename real collision => ${r.status} ${r.txt.slice(0, 160)}`)
    // ← 基线在此红：200（ext4 上建出第三个近同名目录）
    assert.equal(r.status, 409, `目标与同级对象仅大小写不同 ⇒ 必须 409：${r.status} ${r.txt}`)
    assert.deepEqual(r.body?.conflicts, ['casetopic'], `conflicts 必须点名磁盘真名 casetopic：${r.txt}`)
    assert.match(r.txt, /casetopic/, `错误文案必须点名磁盘真名：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R5-CROSS-PARENT 跨父级移动（改大小写、目标父级里没有源）不受变体检查影响 ⇒ 200', async (t) => {
  const { root, data } = newLib('dpr-r5-xp-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/CaseTopic', 'P')
    mkdirSync(join(data, 'Alpha', 'Sub'), { recursive: true })
    const r = await s.post('/api/library/rename-topic', { name: 'Alpha/CaseTopic', to: 'Alpha/Sub/casetopic' })
    t.diagnostic(`cross-parent => ${r.status} ${r.txt.slice(0, 160)}`)
    assert.equal(r.status, 200, `跨父级移动到空目标必须成功：${r.status} ${r.txt}`)
    assert.equal(existsSync(join(data, 'Alpha', 'Sub', 'casetopic', 'P', 'P.pdf')), true, '目标目录必须在')
    assert.equal(existsSync(join(data, 'Alpha', 'CaseTopic')), false, '源目录必须搬走')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R5-CONSISTENCY upload / create-topic / renameTopic 对**真实**大小写变体的口径一致（三处都 409 且点名真名）', async (t) => {
  const { root, data } = newLib('dpr-r5-cons-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/CaseTopic', 'P')
    putPaper(data, 'Alpha/Victim', 'V')
    const before = snap(data)
    const up = await s.upload('Alpha', 'casetopic.pdf')
    const cr = await s.post('/api/library/topic', { name: 'Alpha/casetopic' })
    const rn = await s.post('/api/library/rename-topic', { name: 'Alpha/Victim', to: 'Alpha/casetopic' })
    t.diagnostic(`upload=${up.status} create=${cr.status} rename=${rn.status}`)
    // ← 基线在此红：三处全是 200（分属不同缺陷）
    assert.equal(up.status, 409, `upload 必须拒大小写变体：${up.status} ${up.txt}`)
    assert.equal(cr.status, 409, `create-topic 必须拒大小写变体：${cr.status} ${cr.txt}`)
    assert.equal(rn.status, 409, `renameTopic 必须拒大小写变体：${rn.status} ${rn.txt}`)
    for (const r of [up, cr, rn]) assert.match(r.txt, /CaseTopic/, `三处错误都必须点名磁盘真名 CaseTopic：${r.txt}`)
    assert.deepEqual(snap(data), before, '三处被拒都不得改动文献库')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// R5-ADJ：专项裁决 —— renameTopic 把「源自身」改成不同大小写（同父级、无其它碰撞）
// ═════════════════════════════════════════════════════════════════════════════

test('R5-ADJ-RENAME-SELF 同一父级下把专题自身改成不同大小写 ⇒ 应仍可改名（不得被自己的变体挡住）', async (t) => {
  const { root, data } = newLib('dpr-r5-adj-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/CaseTopic', 'P')   // 同级没有其它大小写变体
    const r = await s.post('/api/library/rename-topic', { name: 'Alpha/CaseTopic', to: 'Alpha/casetopic' })
    t.diagnostic(`self case-only rename => ${r.status} ${r.txt.slice(0, 200)}（平台大小写不敏感=${CASE_INSENSITIVE}）`)
    if (CASE_INSENSITIVE) {
      // macOS/Windows 的**既有**平台限制（维护者「其它 / 不阻塞，记录在案」）：目标路径 resolve 到同一目录，
      // 旧实现 existsSync(target) 即拒；t14 明确保留该限制（不做两步 rename），属已知债、非本轮回归。
      assert.equal(r.status, 409, `不敏感盘上 self-case 改名仍按既有平台限制 409：${r.status} ${r.txt}`)
    } else {
      // ext4：这是**合法**改名（真实生效）。t11 曾误判 409（R5-01 能力回退），t14 已修 ⇒ 必须 200。
      assert.equal(r.status, 200,
        `同一父级下把专题自身改成不同大小写是合法改名，不应被自己的变体检查挡住：${r.status} ${r.txt}`)
      assert.equal(existsSync(join(data, 'Alpha', 'casetopic', 'P', 'P.pdf')), true,
        `改名必须真实生效：${JSON.stringify(readdirSync(join(data, 'Alpha')))}`)
      assert.equal(existsSync(join(data, 'Alpha', 'CaseTopic')), false, '旧大小写目录必须消失')
    }
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// R5-ADV：t14 修复的「排除自身」必须只排自身，不能放松对**别的**同级变体的 409
// ═════════════════════════════════════════════════════════════════════════════

test('R5-ADV-DOUBLE-VARIANT 同父级同时存在源与另一个大小写变体 ⇒ 改名为第三个拼写仍 409 且点名真名', async (t) => {
  if (CASE_INSENSITIVE) { t.diagnostic('不敏感盘上无法并存两个大小写变体目录，跳过该构造（平台事实）'); return }
  const { root, data } = newLib('dpr-r5-adv1-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/CaseTopic', 'P')   // 源
    putPaper(data, 'Alpha/CASETOPIC', 'Q')   // 另一个变体（不同目录项）
    const before = snap(data)
    const r = await s.post('/api/library/rename-topic', { name: 'Alpha/CaseTopic', to: 'Alpha/casetopic' })
    t.diagnostic(`double-variant => ${r.status} ${r.txt.slice(0, 200)}`)
    // 排除自身后仍必须看到 CASETOPIC（不是自己）⇒ 409 且点名它
    assert.equal(r.status, 409, `除自身外的同级变体必须仍 409：${r.status} ${r.txt}`)
    assert.deepEqual(r.body?.conflicts, ['CASETOPIC'], `conflicts 必须点名真名 CASETOPIC：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R5-ADV-CROSS-PARENT-VARIANT 跨父级移动：目标父级里的同名变体不得被「排除自身」放过 ⇒ 409', async (t) => {
  const { root, data } = newLib('dpr-r5-adv2-')
  const s = await boot(data)
  try {
    putPaper(data, 'A/CaseTopic', 'P')     // 源（在 A 下）
    putPaper(data, 'B/CaseTopic', 'Q')     // 目标父级 B 里的同名目录（不是源）
    mkdirSync(join(data, 'B'), { recursive: true })
    const before = snap(data)
    const r = await s.post('/api/library/rename-topic', { name: 'A/CaseTopic', to: 'B/casetopic' })
    t.diagnostic(`cross-parent-variant => ${r.status} ${r.txt.slice(0, 200)}`)
    // 跨父级不豁免：B/CaseTopic（别的目录项）与目标 B/casetopic 仅大小写不同 ⇒ 必须 409
    assert.equal(r.status, 409, `跨父级时目标父级的同名变体必须仍 409：${r.status} ${r.txt}`)
    assert.deepEqual(r.body?.conflicts, ['CaseTopic'], `conflicts 必须点名 B/CaseTopic 的真名：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R5-ADV-TARGET-IS-OTHER-ENTRY 源与「目标名」是两个不同目录项 ⇒ 不得因排除自身而静默合并', async (t) => {
  const { root, data } = newLib('dpr-r5-adv3-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/CaseTopic', 'P')   // 源
    putPaper(data, 'Alpha/casetopic', 'Q')   // 已存在的目标名（不同目录项）
    const before = snap(data)
    const r = await s.post('/api/library/rename-topic', { name: 'Alpha/CaseTopic', to: 'Alpha/casetopic' })
    t.diagnostic(`target-is-other-entry => ${r.status} ${r.txt.slice(0, 200)}`)
    assert.equal(r.status, 409, `目标名已存在（不同目录项）时必须 409，不得合并/覆盖：${r.status} ${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名必须零改动（两个目录都还在）')
    assert.equal(existsSync(join(data, 'Alpha', 'CaseTopic', 'P', 'P.pdf')), true)
    assert.equal(existsSync(join(data, 'Alpha', 'casetopic', 'Q', 'Q.pdf')), true)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R5-ADV-NOT-PREFIX 排除自身必须按精确名/同一目录项，不能按前缀放宽', async (t) => {
  if (CASE_INSENSITIVE) { t.diagnostic('不敏感盘上无法构造前缀近名变体，跳过（平台事实）'); return }
  const { root, data } = newLib('dpr-r5-adv4-')
  const s = await boot(data)
  try {
    putPaper(data, 'Alpha/Move', 'P')        // 源
    putPaper(data, 'Alpha/MoveBar', 'Q')     // 前缀近名（不是自身）
    const before = snap(data)
    const r = await s.post('/api/library/rename-topic', { name: 'Alpha/Move', to: 'Alpha/movebar' })
    t.diagnostic(`not-prefix => ${r.status} ${r.txt.slice(0, 200)}`)
    // 目标 movebar 与 MoveBar 仅大小写不同 ⇒ 必须 409（若用前缀排除自身就会误放行）
    assert.equal(r.status, 409, `前缀近名变体必须仍 409（排除自身只能按精确名/同一目录项）：${r.status} ${r.txt}`)
    assert.deepEqual(r.body?.conflicts, ['MoveBar'], `conflicts 必须点名 MoveBar：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// 基线模式自检
if (BASELINE_MODE) {
  test('R5-0 基线模式自检', (t) => {
    t.diagnostic(`R5_REPO 模式：目标树 = ${TARGET}；平台大小写敏感 = ${!CASE_INSENSITIVE}`)
    assert.ok(true)
  })
}
