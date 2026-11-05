// test/pr8-platform-guards.test.mjs — REV1（t4）两条低危观察的平台守卫用例（t11）。
//
// ① create-topic / renameTopic 没有「仅大小写不同」碰撞检查（与 upload B4 口径不一致）：
//    ext4 上并存 `CaseTopic`+`casetopic`；APFS/NTFS 上 200 但其实是既有目录别名（假成功）。
// ② C4 的「同 inode 视为同一文件」例外没有 ino 有效性守卫：exFAT/FAT/部分 SMB 上 stat().ino 恒 0，
//    任何已存在的目标文件都会被判「同一文件」⇒ 冲突预检被绕过 ⇒ renameSync 静默覆盖。
//
// 约定：只 import dist/*.js（跑前 build）；破坏性实验用 mkdtemp 临时库；平台期望按 fs-probe 实测分支。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { caseInsensitiveFs } from './fs-probe.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

const M = await import(pathToFileURL(dist('library-manage.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// 主题配置 / preset 等会写 $DSH_HOME；固定到临时目录，绝不碰真实 ~/.dsh。
const HOME = mkdtempSync(join(tmpdir(), 'dpr-pg-home-'))
process.env.DSH_HOME = HOME

function newLib() {
  const root = mkdtempSync(join(tmpdir(), 'dpr-pg-'))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

function putPaper(data, topic, name) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.pdf'), `pdf:${name}`)
  writeFileSync(join(dir, name + '.txt'), `txt:${name}`)
  return dir
}

/** 库内快照（相对路径 → 文件内容 / 'dir'）：断言「被拒的操作零改动」。 */
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

async function boot(dataDir) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }), create: async () => ({}) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const parse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const t = await r.text()
    return { status: r.status, body: parse(t), txt: t }
  }
  return { srv, post }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ② C4 平台守卫：同 inode 例外必须有 ino/dev 有效性守卫
   ═══════════════════════════════════════════════════════════════════════════ */

test('C4-ino 纯函数：两侧 ino/dev 都有效且同目录项才放行；ino=0（exFAT/FAT）一律冲突', () => {
  const sameFileForRename = M.sameFileForRename
  assert.equal(typeof sameFileForRename, 'function', '必须导出可单测的纯函数 sameFileForRename')
  const id = (ino, dev = 7) => ({ ino, dev })
  // 假 stat，不依赖真实 exFAT（acceptance 指定的四组 + 额外方向）
  assert.equal(sameFileForRename(id(0), id(0)), false, 'ino=0/0（exFAT：任何文件都像同一文件）不得放行')
  assert.equal(sameFileForRename(id(0), id(123)), false, 'ino=0/123 不得放行')
  assert.equal(sameFileForRename(id(123), id(0)), false, 'ino=123/0 不得放行（双向守卫）')
  assert.equal(sameFileForRename(id(123), id(123)), true, 'ino=123/123 且同一目录项 → 放行（大小写-only 改名的合法路径）')
  assert.equal(sameFileForRename(id(123), id(123), true), true)
  assert.equal(sameFileForRename(id(123), id(123), false), false, '同 inode 但不同目录项（hardlink/别名）必须冲突')
  assert.equal(sameFileForRename(id(123), id(456)), false, 'ino=123/456 → 冲突')
  assert.equal(sameFileForRename(id(123, 0), id(123, 0)), false, 'dev=0 也要保守判冲突（宁误报，不放行覆盖）')
})

test('C4 接线：renamePaper 逐文件预检必须调用 sameFileForRename（不许再裸比 ino）', () => {
  const src = readFileSync(join(REPO, 'src', 'library-manage.ts'), 'utf8')
  const start = src.indexOf('逐文件冲突预检')
  assert.ok(start > 0, '找不到 C4 预检注释（源码结构变了要同步本用例）')
  const end = src.indexOf('① 目录整体改名', start)
  assert.ok(end > start)
  const seg = src.slice(start, end)
  assert.match(seg, /sameFileForRename\(srcStat, targetStat, sameEntry\)/, '预检必须走纯函数（ino/dev 守卫）')
  assert.match(seg, /realpathSync\(srcAbs\) === realpathSync\(dstAbs\)/, '例外还必须要求「同一目录项」')
  assert.ok(!/targetStat\.ino === srcStat\.ino/.test(seg), '绝不能再裸比 ino（ino=0 平台会误放行覆盖）')
})

test('C4 行为：同 inode 但不同目录项（hardlink 现场）不再放行 —— 绝不静默覆盖/留孤儿', () => {
  const { data } = newLib()
  const dir = putPaper(data, 'T', 'Old')
  // hardlink：New.txt 与 Old.txt 指向同一个 inode，但是**两个不同的目录项**。
  // 这复现了「同 inode 例外过宽」的本质（exFAT 上 ino 恒 0 时任何条目都会撞上这个判据）。
  linkSync(join(dir, 'Old.txt'), join(dir, 'New.txt'))
  const ino = (p) => lstatSync(p).ino
  assert.equal(ino(join(dir, 'Old.txt')), ino(join(dir, 'New.txt')), '夹具：两者确实是同一 inode')
  const before = snap(data)
  assert.throws(
    () => M.renamePaper(data, 'T', 'Old', 'New'),
    (e) => e?.code === 'target-exists',
    '同 inode 但不同路径必须按冲突处理（409 target-exists）',
  )
  assert.deepEqual(snap(data), before, '被拒的改名必须零改动（目录名/文件/硬链接都原样）')
  assert.ok(existsSync(join(dir, 'Old.pdf')), '源论文目录原封不动')

  // 回归：把别名清掉后，正常改名仍要成功（两段式/回滚语义不回退）
  rmSync(join(dir, 'New.txt'))
  const r = M.renamePaper(data, 'T', 'Old', 'New')
  assert.equal(r.ok, true)
  assert.equal(r.to, 'New')
  assert.ok(existsSync(join(data, 'T', 'New', 'New.pdf')) && existsSync(join(data, 'T', 'New', 'New.txt')))
  assert.equal(existsSync(join(data, 'T', 'Old')), false)
})

/* ═══════════════════════════════════════════════════════════════════════════
   ① create-topic / renameTopic 的「仅大小写不同」碰撞
   ═══════════════════════════════════════════════════════════════════════════ */

test('create-topic 大小写变体 → 409 点名磁盘真名（ext4 不再并存 / 不敏感盘不再 200 假成功）', async () => {
  const insensitive = caseInsensitiveFs()
  const { data } = newLib()
  mkdirSync(join(data, 'Alpha', 'CaseTopic'), { recursive: true })
  const before = snap(data)
  const { srv, post } = await boot(data)
  try {
    const r = await post('/api/library/topic', { name: 'Alpha/casetopic' })
    assert.equal(r.status, 409, `仅大小写不同的同级目录必须 409：${r.txt}`)
    assert.equal(r.body.code, 'target-exists', r.txt)
    assert.deepEqual(r.body.conflicts, ['CaseTopic'], `conflicts 必须点名磁盘真名：${r.txt}`)
    assert.match(r.body.error, /CaseTopic/, `错误文案必须点名磁盘真名：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的创建不得改动文献库')
    const names = readdirSync(join(data, 'Alpha'))
    assert.deepEqual(
      names.filter((n) => n.toLowerCase() === 'casetopic'),
      ['CaseTopic'],
      `盘上不得再出现第二个大小写变体：${names.join(',')}`,
    )
    if (insensitive) {
      // 平台事实（不硬编码平台名）：不敏感盘上两个拼写本来就是同一个目录别名（旧实现 200 假成功）。
      assert.equal(realpathSync(join(data, 'Alpha', 'casetopic')), realpathSync(join(data, 'Alpha', 'CaseTopic')))
    } else {
      // 平台事实：敏感盘上旧行为会并存两个目录；我们仍统一拒绝（与 upload B4 口径一致，避免分裂）。
      assert.equal(existsSync(join(data, 'Alpha', 'casetopic')), false)
    }
    // 根层（parentSegs 为空）同样生效：RootCase 已存在时建 rootcase 也必须 409
    mkdirSync(join(data, 'RootCase'), { recursive: true })
    const rootVariant = await post('/api/library/topic', { name: 'rootcase' })
    assert.equal(rootVariant.status, 409, `根层的大小写变体同样必须 409：${rootVariant.txt}`)
    assert.deepEqual(rootVariant.body.conflicts, ['RootCase'], rootVariant.txt)
    // 回归：精确同名仍幂等 200（重复创建不能被误判成冲突）
    const exact = await post('/api/library/topic', { name: 'Alpha/CaseTopic' })
    assert.equal(exact.status, 200, exact.txt)
  } finally { srv.close() }
})

test('renameTopic 同父级 self case-only → 200 且目录真的换大小写（不敏感盘按平台事实保持 409）', async () => {
  // R5-01（t12 评审）：同父级把 CaseTopic 改成 casetopic 改的是**同一个目录项**，没有真实碰撞。
  // 旧实现把它也算进 caseVariantCollisions（返回源目录自己）⇒ 409，等于把「mac/win 大小写改名被拒」
  // 这条已知限制扩大到 ext4，属无收益的能力回退。现在仅在同父级时豁免源条目自身。
  const insensitive = caseInsensitiveFs()
  const { data } = newLib()
  mkdirSync(join(data, 'CaseTopic'), { recursive: true })
  const { srv, post } = await boot(data)
  try {
    const r = await post('/api/library/rename-topic', { topic: 'CaseTopic', to: 'casetopic' })
    if (insensitive) {
      // 已知限制（维护者记录，本轮不做两步 rename 绕解）：不敏感盘上 existsSync(target) 命中同一目录
      // 的别名 ⇒ 仍 409。平台事实由 fs-probe 实测，不硬编码平台名、不 skip。
      assert.equal(r.status, 409, `不敏感盘上 self case-only 保持 409（已知限制）：${r.txt}`)
      const names = readdirSync(data).filter((n) => n.toLowerCase() === 'casetopic')
      assert.equal(names.length, 1, `不得出现第二个目录：${names.join(',')}`)
      assert.equal(names[0], 'CaseTopic', '源目录必须仍在（同一个目录项）')
    } else {
      assert.equal(r.status, 200, `同父级 self case-only 改名必须是 200（基线行为）：${r.txt}`)
      assert.equal(r.body.to, 'casetopic', r.txt)
      assert.deepEqual(readdirSync(data), ['casetopic'], '磁盘上的目录名必须真的换了大小写')
      assert.equal(existsSync(join(data, 'casetopic')), true)
    }
  } finally { srv.close() }
})

test('renameTopic 与「别的同级对象」仅大小写不同 → 仍 409 并点名磁盘真名', async () => {
  const { data } = newLib()
  mkdirSync(join(data, 'Other'), { recursive: true })
  mkdirSync(join(data, 'casetopic'), { recursive: true })
  const before = snap(data)
  const { srv, post } = await boot(data)
  try {
    // 源是 Other，目标 CaseTopic；同级已有 casetopic —— 这是**真实碰撞**，不能被源条目豁免吞掉。
    const r = await post('/api/library/rename-topic', { topic: 'Other', to: 'CaseTopic' })
    assert.equal(r.status, 409, `真实同级大小写变体必须 409：${r.txt}`)
    assert.equal(r.body.code, 'target-exists', r.txt)
    assert.deepEqual(r.body.conflicts, ['casetopic'], `conflicts 必须点名磁盘真名：${r.txt}`)
    assert.match(r.body.error, /casetopic/, r.txt)
    assert.deepEqual(snap(data), before, '被拒的改名不得改动文献库')
    assert.ok(existsSync(join(data, 'Other')) && existsSync(join(data, 'casetopic')), '两个源/目标同级目录都必须原样')
  } finally { srv.close() }
})

test('renameTopic 跨父级移动仍 200（自身豁免只在同父级生效）', async () => {
  const { data } = newLib()
  mkdirSync(join(data, 'A', 'Move'), { recursive: true })
  mkdirSync(join(data, 'B'), { recursive: true })
  const { srv, post } = await boot(data)
  try {
    const r = await post('/api/library/rename-topic', { topic: 'A/Move', to: 'B/Move' })
    assert.equal(r.status, 200, `跨父级移动必须 200：${r.txt}`)
    assert.ok(existsSync(join(data, 'B', 'Move')), '目标父级下出现 Move')
    assert.equal(existsSync(join(data, 'A', 'Move')), false, '源父级下消失')
    // 再回归一次：改成真正不同的名字仍 200（本用例覆盖 Move 之外的普通改名不受影响）
    const ren = await post('/api/library/rename-topic', { topic: 'B/Move', to: 'B/Moved' })
    assert.equal(ren.status, 200, ren.txt)
    assert.ok(existsSync(join(data, 'B', 'Moved')))
  } finally { srv.close() }
})
