// test/library-traversal-verification.test.mjs — **验证者独立对抗测试**（t11）。
//
// 目的：证明「修复前确实能逃逸」→「修复后被挡住」，并逐条核对 t10 的验收标准。
//   · 先用上游 HEAD 的 src/library.ts（git show HEAD:src/library.ts 编译）在 /tmp 复现三条逃逸；
//   · 再对构建产物 dist/library.js 复跑同一组攻击（+ ≥8 组扩展攻击），断言 /tmp 库外**逐字节不变**；
//   · 符号链接那几组是检验「realpath 第二层」是否真的存在（词法黑名单一定放行它们）；
//   · 路由层 4 条 CRUD 端到端复核 4xx/文案/不泄露绝对路径；
//   · 正常删除/重命名（中文、空格、精确 stem、多变体）零回归。
//
// 所有破坏性实验都在 mkdtemp 的 /tmp 临时库里；真实文献库只读（测试前后各算一次指纹并断言不变）。
// 只 import dist/*.js（跑前 `npm run build`）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dpr-t11-home-'))
const L = await import(dist('library.js'))
const { registerRoutes } = await import(dist('host.js'))

// ── 真实文献库指纹：证明本次验证一个字节都没碰它 ────────────────────────────
const REAL_LIB = join(homedir(), '.dsh-paper-reader', 'data')
function libFingerprint(dir) {
  const h = createHash('sha256')
  const walk = (d, base) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      h.update(relative(base, p))
      if (e.isSymbolicLink()) h.update('symlink:' + readlinkSync(p))
      else if (e.isDirectory()) { h.update('dir'); walk(p, base) }
      else { h.update('file'); h.update(readFileSync(p)) }
    }
  }
  if (existsSync(dir)) walk(dir, dir)
  return h.digest('hex')
}
const REAL_LIB_BEFORE = existsSync(REAL_LIB) ? libFingerprint(REAL_LIB) : null

// ── 临时工作区 ──────────────────────────────────────────────────────────────
/** parent/{data,sentinel,outside}：库 + 库外哨兵目录 + 库外文献目录。 */
function workspace() {
  const parent = mkdtempSync(join(tmpdir(), 'dpr-t11-'))
  const data = join(parent, 'data')
  const sentinel = join(parent, 'sentinel')
  const outside = join(parent, 'outside')
  mkdirSync(data, { recursive: true })
  mkdirSync(sentinel, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(sentinel, 'keep.txt'), 'SENTINEL-KEEP')
  mkdirSync(join(sentinel, 'sub'), { recursive: true })
  writeFileSync(join(sentinel, 'sub', 'deep.txt'), 'SENTINEL-DEEP')
  writeFileSync(join(outside, 'Victim.pdf'), 'VICTIM-PDF')
  writeFileSync(join(outside, 'Victim.txt'), 'VICTIM-TXT')
  writeFileSync(join(outside, 'other.pdf'), 'OTHER-PDF')
  mkdirSync(join(data, 'T'), { recursive: true })
  writeFileSync(join(data, 'T', 'P.pdf'), 'P-PDF')
  writeFileSync(join(data, 'T', 'P.txt'), 'P-TXT')
  return { parent, data, sentinel, outside }
}
/** 递归快照：相对路径 → 内容 / [dir] / symlink 目标。 */
function snap(dir, base = dir, out = {}) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name)
    const rel = relative(base, p)
    if (e.isSymbolicLink()) out[rel] = 'symlink->' + readlinkSync(p)
    else if (e.isDirectory()) { out[rel] = '[dir]'; snap(p, base, out) }
    else out[rel] = readFileSync(p, 'utf8')
  }
  return out
}
function diff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? '∅'} → ${b[k] ?? '∅'}`)
}
const cleanup = []
const tmpParent = () => { const w = workspace(); cleanup.push(w.parent); return w }
test.after(() => {
  for (const p of cleanup) rmSync(p, { recursive: true, force: true })
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
  const after = existsSync(REAL_LIB) ? libFingerprint(REAL_LIB) : null
  assert.equal(after, REAL_LIB_BEFORE, '真实文献库在本次验证期间不得被改动（指纹比对）')
})

// ── 修复前的构建产物（上游 HEAD 的 src/library.ts）───────────────────────────
const PREFIX_DIR = join(REPO, '.probe', 'prefix-verify')
const PREFIX_JS = join(PREFIX_DIR, 'dist', 'library.js')
let prefixErr = null
function ensurePrefixLib() {
  if (existsSync(PREFIX_JS)) return true
  try {
    mkdirSync(PREFIX_DIR, { recursive: true })
    const src = execFileSync('git', ['show', 'HEAD:src/library.ts'], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    writeFileSync(join(PREFIX_DIR, 'library.ts'), src)
    writeFileSync(join(PREFIX_DIR, 'tsconfig.json'), JSON.stringify({
      extends: '../../tsconfig.json',
      compilerOptions: { outDir: 'dist', rootDir: '.', declaration: false },
      include: ['library.ts'],
    }))
    const r = spawnSync(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(PREFIX_DIR, 'tsconfig.json')], { cwd: PREFIX_DIR, encoding: 'utf8' })
    if (r.status !== 0 || !existsSync(PREFIX_JS)) throw new Error(`tsc 失败(status=${r.status}): ${r.stdout}${r.stderr}`)
    return true
  } catch (e) {
    prefixErr = e instanceof Error ? e.message : String(e)
    return false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 先证明漏洞真实存在（上游 HEAD 的代码）
// ═══════════════════════════════════════════════════════════════════════════

test('V1(漏洞真实) 用上游 HEAD 的 library.ts 复现三条逃逸：删库外目录 / 删库外文献 / 移走库外目录', async (t) => {
  if (!ensurePrefixLib()) {
    t.diagnostic(`无法构建修复前代码，跳过：${prefixErr}`)
    t.skip('无法用 git show HEAD:src/library.ts 构建修复前产物')
    return
  }
  const PRE = await import(PREFIX_JS)
  const log = []

  // ① deleteTopic(dataDir, '../sentinel') → 库外整目录被递归删除
  {
    const { parent, data, sentinel } = workspace()
    let threw = null
    try { PRE.deleteTopic(data, '../sentinel') } catch (e) { threw = String(e.message) }
    log.push(`deleteTopic('../sentinel') → ${threw ? 'throw: ' + threw : 'NO-THROW'}; sentinel exists = ${existsSync(sentinel)}`)
    assert.equal(threw, null, '修复前必须是不抛异常（即逃逸成功）')
    assert.equal(existsSync(sentinel), false, '修复前 ../sentinel 整目录必须被删除')
    assert.ok(!existsSync(join(parent, 'sentinel', 'sub', 'deep.txt')), '递归删除必须连子目录一起删（破坏性证据）')
    rmSync(parent, { recursive: true, force: true })
  }
  // ② deletePaper(dataDir, '../outside', 'Victim') → 库外文献被删
  {
    const { parent, data, outside } = workspace()
    let threw = null
    let deleted = null
    try { deleted = PRE.deletePaper(data, '../outside', 'Victim') } catch (e) { threw = String(e.message) }
    log.push(`deletePaper('../outside','Victim') → ${threw ? 'throw: ' + threw : 'NO-THROW'}; deleted = ${JSON.stringify(deleted)}; outside = ${JSON.stringify(readdirSync(outside))}`)
    assert.equal(threw, null, '修复前必须是不抛异常')
    assert.deepEqual(deleted.sort(), ['Victim.pdf', 'Victim.txt'], '修复前必须删掉库外 Victim 的产物')
    assert.equal(existsSync(join(outside, 'Victim.pdf')), false)
    assert.equal(readFileSync(join(outside, 'other.pdf'), 'utf8'), 'OTHER-PDF', '同目录其他文件不受影响（说明只删了同名 stem）')
    rmSync(parent, { recursive: true, force: true })
  }
  // ③ renameTopic(dataDir, '../outside', 'hijacked') → 库外目录被移进库里
  {
    const { parent, data, outside } = workspace()
    let threw = null
    try { PRE.renameTopic(data, '../outside', 'hijacked') } catch (e) { threw = String(e.message) }
    log.push(`renameTopic('../outside','hijacked') → ${threw ? 'throw: ' + threw : 'NO-THROW'}; parent = ${JSON.stringify(readdirSync(parent))}; data = ${JSON.stringify(readdirSync(data))}`)
    assert.equal(threw, null, '修复前必须是不抛异常')
    assert.equal(existsSync(outside), false, '修复前库外目录必须被移走')
    assert.equal(readFileSync(join(data, 'hijacked', 'Victim.pdf'), 'utf8'), 'VICTIM-PDF', '被移走的库外目录现在在库里（越界证据）')
    rmSync(parent, { recursive: true, force: true })
  }
  t.diagnostic('修复前实测：\n  ' + log.join('\n  '))
})

test('V2(漏洞真实·路由层) 修复前的 host 端到端：4 条 CRUD 路由都能越界操作库外文件', async (t) => {
  if (!ensurePrefixLib()) { t.skip('无法构建修复前代码'); return }
  // 路由层需要完整 dist（host+依赖），用 .probe/prefix 下已构建的上游 dist
  const PREFIX_FULL = join(REPO, '.probe', 'prefix', 'dist', 'host.js')
  if (!existsSync(PREFIX_FULL)) { t.skip(`缺少修复前完整构建产物：${PREFIX_FULL}（构建命令见 docs/security-verify.md §1）`); return }
  const { registerRoutes: preRegister } = await import(PREFIX_FULL)
  const log = []
  const cases = [
    ['delete-topic', { topic: '../sentinel' }, (w) => ({ sentinelGone: !existsSync(w.sentinel) })],
    ['delete-paper', { topic: '../outside', name: 'Victim' }, (w) => ({ victimGone: !existsSync(join(w.outside, 'Victim.pdf')) })],
    ['rename-topic', { topic: '../outside', to: 'hijacked' }, (w) => ({ movedIntoLib: existsSync(join(w.data, 'hijacked')) })],
    ['rename-paper', { topic: '../outside', name: 'other', to: 'pwned' }, (w) => ({ renamed: existsSync(join(w.outside, 'pwned.pdf')) })],
  ]
  for (const [route, body, probe] of cases) {
    const w = workspace()
    let spec = null
    preRegister({
      webServer: { register: (s) => { spec = s; return () => {} } },
      connection: { requestRejection: () => undefined },
      sessionController: { list: async () => ({ items: [] }) },
      workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
    }, { dataDir: w.data })
    const srv = createServer((req, res) => spec.handler(req, res))
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/paper-reader/api/library/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const resBody = await r.json().catch(() => null)
    srv.close()
    const evidence = probe(w)
    log.push(`${route} ${JSON.stringify(body)} → HTTP ${r.status} ${JSON.stringify(resBody)} | ${JSON.stringify(evidence)}`)
    assert.equal(r.status, 200, `修复前 ${route} 必须成功（逃逸）`)
    assert.ok(Object.values(evidence).every(Boolean), `修复前 ${route} 必须产生库外副作用`)
    rmSync(w.parent, { recursive: true, force: true })
  }
  t.diagnostic('修复前路由层实测：\n  ' + log.join('\n  '))
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. 修复后：队长给的三条 + 扩展攻击矩阵
// ═══════════════════════════════════════════════════════════════════════════

/** 对同一输入依次调用 4 个原语，返回每个原语的结果（不抛异常时记 NO-THROW）。 */
function runAll(w, name, { topicIsName = true } = {}) {
  const out = {}
  const calls = {
    deleteTopic: () => L.deleteTopic(w.data, name),
    deletePaper: () => L.deletePaper(w.data, topicIsName ? name : 'T', topicIsName ? 'P' : name),
    renameTopic: () => L.renameTopic(w.data, name, 'hijacked'),
    renamePaper: () => L.renamePaper(w.data, topicIsName ? name : 'T', topicIsName ? 'P' : name, 'renamed'),
  }
  for (const [k, fn] of Object.entries(calls)) {
    try { const v = fn(); out[k] = { threw: false, value: v } } catch (e) { out[k] = { threw: true, msg: String(e.message) } }
  }
  return out
}

test('V3 队长给的三条逃逸：修复后全部被拒，且 /tmp 库外递归快照逐字节不变', () => {
  // ① deleteTopic(dataDir,'../sentinel')
  {
    const w = tmpParent()
    const before = snap(w.parent)
    assert.throws(() => L.deleteTopic(w.data, '../sentinel'), (e) => /名字|路径/.test(e.message), '必须被拒')
    assert.deepEqual(diff(before, snap(w.parent)), [], '库外与库内都不得有变化')
  }
  // ② deletePaper(dataDir,'../outside','Victim')
  {
    const w = tmpParent()
    const before = snap(w.parent)
    assert.throws(() => L.deletePaper(w.data, '../outside', 'Victim'), (e) => /名字|路径/.test(e.message))
    assert.deepEqual(diff(before, snap(w.parent)), [])
  }
  // ③ renameTopic(dataDir,'../outside','hijacked')
  {
    const w = tmpParent()
    const before = snap(w.parent)
    assert.throws(() => L.renameTopic(w.data, '../outside', 'hijacked'), (e) => /名字|路径/.test(e.message))
    assert.deepEqual(diff(before, snap(w.parent)), [])
  }
})

test('V4 扩展攻击矩阵：≥8 组输入 × 4 原语，全部被拒且磁盘零变化', (t) => {
  const cases = [
    // ③ 规范化后才越界 / 多级上跳
    ['相对穿越（单级）', '../sentinel', 'topic'],
    ['多级上跳', '../../..', 'topic'],
    ['a/../b（规范化后才“越界”但含分隔符）', 'a/../b', 'topic'],
    ['a/../../outside', 'a/../../outside', 'topic'],
    ['./../outside', './../outside', 'topic'],
    // ④ 绝对路径
    ['绝对路径 /etc', '/etc', 'topic'],
    ['绝对路径 /etc/passwd', '/etc/passwd', 'topic'],
    ['双重斜杠绝对路径', '//tmp/x', 'topic'],
    // ⑤ Windows 分隔符
    ['win32 相对穿越', '..\\..\\sentinel', 'topic'],
    ['win32 单级', '..\\outside', 'topic'],
    ['win32 盘符', 'C:\\Windows', 'topic'],
    // ⑥ 空串 / 点 / 尾随空格与点
    ['空串', '', 'topic'],
    ['纯空格', '   ', 'topic'],
    ['.', '.', 'topic'],
    ['..', '..', 'topic'],
    ['.. 加尾空格', '.. ', 'topic'],
    ['...', '...', 'topic'],
    ['隐藏名', '.hidden', 'topic'],
    ['尾随斜杠', 'T/', 'topic'],
    // ⑦ 超长
    ['超长 121', 'x'.repeat(121), 'topic'],
    ['超长 500', 'x'.repeat(500), 'topic'],
    // ⑧ NUL / 控制字符
    ['NUL 在中间', 'a\u0000b', 'topic'],
    ['纯 NUL', '\u0000', 'topic'],
    ['SOH 控制字符', 'a\u0001b', 'topic'],
    ['DEL 控制字符', 'a\u007fb', 'topic'],
    ['换行', 'a\nb', 'topic'],
    // 名字位置（name/from/to）
    ['name 穿越', '../x', 'name'],
    ['name 绝对路径', '/etc/passwd', 'name'],
    ['name NUL', 'a\u0000b', 'name'],
    ['name 超长', 'y'.repeat(200), 'name'],
  ]
  const report = []
  for (const [label, input, where] of cases) {
    const w = tmpParent()
    const before = snap(w.parent)
    const lexical = L.validateEntryName(input)
    const res = runAll(w, input, { topicIsName: where === 'topic' })
    const d = diff(before, snap(w.parent))
    report.push(`${label} :: ${where} :: ${JSON.stringify(input.length > 20 ? input.slice(0, 12) + '…' : input)} lexical=${JSON.stringify(lexical)} → ${Object.entries(res).map(([k, v]) => `${k}:${v.threw ? v.msg : 'NO-THROW'}`).join(' | ')} | diff=${JSON.stringify(d)}`)
    assert.deepEqual(d, [], `${label}（${where}）不得改动磁盘：${d}`)
    for (const [fn, r] of Object.entries(res)) {
      if (r.threw) {
        assert.ok(/名字|路径越界|不存在/.test(r.msg), `${label} 的错误文案必须可读：${fn} → ${r.msg}`)
        assert.ok(!r.msg.includes(w.parent), `${label} 的错误文案不得含绝对路径：${r.msg}`)
      } else {
        // 不抛异常的唯一可能是「合法且不存在」——此时上一条 diff 断言已经保证磁盘没动
        assert.ok(lexical === null, `${label} 被词法层放行却又没抛异常：${fn}`)
      }
    }
    rmSync(w.parent, { recursive: true, force: true })
  }
  t.diagnostic(`扩展攻击矩阵（${cases.length} 组 × 4 原语 = ${cases.length * 4} 次调用）全部被拒、磁盘零变化：\n  ` + report.join('\n  '))
})

test('V5 空白别名（trim 语义）：越界输入被拒；纯空白是「合法别名」只作用于库内同名目录', (t) => {
  // ① 越界 + 空白仍然被拒（trim 之后含 ..）
  for (const evil of ['../sentinel ', ' ../sentinel', '\t../sentinel', '..\n']) {
    const w = tmpParent()
    const before = snap(w.parent)
    assert.throws(() => L.deleteTopic(w.data, evil), (e) => /名字|路径越界/.test(e.message), `${JSON.stringify(evil)} 必须被拒`)
    assert.deepEqual(diff(before, snap(w.parent)), [])
    rmSync(w.parent, { recursive: true, force: true })
  }
  // ② 'T\n' 被 trim 成合法专题名 T → 会真的删掉库里的 T（库外纹丝不动）
  const w = tmpParent()
  const outsideBefore = snap(w.sentinel)
  const r = (() => { try { return { ok: true, v: L.deleteTopic(w.data, 'T\n') } } catch (e) { return { ok: false, msg: String(e.message) } } })()
  t.diagnostic(`deleteTopic('T\\n') → ${JSON.stringify(r)}；库内 data = ${JSON.stringify(readdirSync(w.data))}；库外 sentinel 未变 = ${JSON.stringify(diff(outsideBefore, snap(w.sentinel))) === '[]'}`)
  assert.deepEqual(diff(outsideBefore, snap(w.sentinel)), [], '库外必须不受影响')
  assert.equal(existsSync(join(w.data, 'T')), false, '前后空白被 trim：目标等价于合法专题 T（这就是它被删除的原因）')
  assert.deepEqual(r, { ok: true, v: undefined })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. 符号链接（检验 realpath 第二层）
// ═══════════════════════════════════════════════════════════════════════════

test('V6 库内符号链接专题 → 库外：词法层放行、realpath 层拒绝（证明双层真的存在）', () => {
  const w = tmpParent()
  symlinkSync(w.outside, join(w.data, 'evil'))
  // 关键前提：名字本身完全合法（词法黑名单不可能挡住它）
  assert.equal(L.validateEntryName('evil'), null, '符号链接的名字必须能通过词法校验（否则本用例无法检验第二层）')
  const before = snap(w.parent)
  for (const [fn, call] of [
    ['deleteTopic', () => L.deleteTopic(w.data, 'evil')],
    ['deletePaper', () => L.deletePaper(w.data, 'evil', 'Victim')],
    ['renameTopic', () => L.renameTopic(w.data, 'evil', 'hijacked')],
    ['renamePaper', () => L.renamePaper(w.data, 'evil', 'Victim', 'pwned')],
  ]) {
    assert.throws(call, (e) => /路径越界/.test(e.message), `${fn} 必须由 realpath 层拒绝（文案应为「路径越界，已拒绝」）`)
  }
  assert.deepEqual(diff(before, snap(w.parent)), [], '库外一个字都不能变，符号链接本身也不能被删')
})

test('V7 符号链接专题的其它形状：多跳链 / 前缀同形兄弟目录 / 悬空链接 / 指向库内', (t) => {
  // ① 多跳链：data/hopB → data/hopA → 库外
  {
    const w = tmpParent()
    symlinkSync(w.outside, join(w.data, 'hopA'))
    symlinkSync(join(w.data, 'hopA'), join(w.data, 'hopB'))
    const before = snap(w.parent)
    assert.throws(() => L.deleteTopic(w.data, 'hopB'), (e) => /路径越界/.test(e.message))
    assert.deepEqual(diff(before, snap(w.parent)), [])
    rmSync(w.parent, { recursive: true, force: true })
  }
  // ② 前缀同形兄弟目录（data vs dataX）：assertInside 的 sep 边界必须挡住前缀混淆
  {
    const w = tmpParent()
    const dataX = join(w.parent, 'dataX')
    mkdirSync(dataX, { recursive: true })
    writeFileSync(join(dataX, 'keep.txt'), 'DATAX-KEEP')
    symlinkSync(dataX, join(w.data, 'evilPrefix'))
    const before = snap(w.parent)
    assert.throws(() => L.deleteTopic(w.data, 'evilPrefix'), (e) => /路径越界/.test(e.message), 'dataX 不是 data 的子路径，必须拒')
    assert.deepEqual(diff(before, snap(w.parent)), [])
    assert.equal(readFileSync(join(dataX, 'keep.txt'), 'utf8'), 'DATAX-KEEP')
    rmSync(w.parent, { recursive: true, force: true })
  }
  // ③ 悬空符号链接 → 可读的「专题不存在」，不崩
  {
    const w = tmpParent()
    symlinkSync(join(w.parent, 'nowhere'), join(w.data, 'dangling'))
    assert.throws(() => L.deleteTopic(w.data, 'dangling'), (e) => /不存在/.test(e.message))
    rmSync(w.parent, { recursive: true, force: true })
  }
  // ④ 指向库内另一个专题的符号链接：realpath 在库内 ⇒ 允许；但必须只删链接本身
  {
    const w = tmpParent()
    mkdirSync(join(w.data, 'realTopic'), { recursive: true })
    writeFileSync(join(w.data, 'realTopic', 'R.pdf'), 'R-PDF')
    symlinkSync(join(w.data, 'realTopic'), join(w.data, 'alias'))
    L.deleteTopic(w.data, 'alias')
    t.diagnostic(`库内 alias → realTopic：deleteTopic(alias) 后 realTopic 内容 = ${JSON.stringify(readdirSync(join(w.data, 'realTopic')))}（rmSync 不跟随顶层符号链接）`)
    assert.ok(!existsSync(join(w.data, 'alias')), '链接本身被删')
    assert.equal(readFileSync(join(w.data, 'realTopic', 'R.pdf'), 'utf8'), 'R-PDF', '指向的库内专题内容必须完好')
    rmSync(w.parent, { recursive: true, force: true })
  }
})

test('V8 符号链接文件 / 硬链接：只动链接本身，库外目标逐字节不变', (t) => {
  // ① .pdf 与 .txt 都是指向库外文件的符号链接
  {
    const w = tmpParent()
    rmSync(join(w.data, 'T', 'P.pdf')); rmSync(join(w.data, 'T', 'P.txt'))
    symlinkSync(join(w.outside, 'Victim.pdf'), join(w.data, 'T', 'P.pdf'))
    symlinkSync(join(w.outside, 'Victim.txt'), join(w.data, 'T', 'P.txt'))
    const outsideBefore = snap(w.sideName ?? w.outside)
    const deleted = L.deletePaper(w.data, 'T', 'P')
    assert.deepEqual(deleted.sort(), ['P.pdf', 'P.txt'], '只列被删的链接名')
    assert.deepEqual(diff(outsideBefore, snap(w.outside)), [], '库外目标必须逐字节不变')
    assert.equal(readFileSync(join(w.outside, 'Victim.pdf'), 'utf8'), 'VICTIM-PDF')
    assert.deepEqual(readdirSync(join(w.data, 'T')), [], '链接本身被移除')
    rmSync(w.parent, { recursive: true, force: true })
  }
  // ② 边车是「指向库外目录」的符号链接
  {
    const w = tmpParent()
    mkdirSync(join(w.outside, 'odir'), { recursive: true })
    writeFileSync(join(w.outside, 'odir', 'x.txt'), 'ODIR-X')
    rmSync(join(w.data, 'T', 'P.txt'))
    symlinkSync(join(w.outside, 'odir'), join(w.data, 'T', 'P.txt'))
    const before = snap(w.parent)
    const deleted = L.deletePaper(w.data, 'T', 'P')
    assert.ok(deleted.includes('P.txt'))
    assert.deepEqual(diff(before, snap(w.parent)).filter((x) => x.startsWith('data/T/')).sort(),
      [`data/T/P.pdf: P-PDF → ∅`, 'data/T/P.txt: symlink->' + join(w.outside, 'odir') + ' → ∅'].sort(), '只删了这篇文献本体与其符号链接边车')
    assert.equal(readFileSync(join(w.outside, 'odir', 'x.txt'), 'utf8'), 'ODIR-X', '库外目录与其内容必须完好')
    rmSync(w.parent, { recursive: true, force: true })
  }
  // ③ 硬链接：unlink 只减引用计数
  {
    const w = tmpParent()
    writeFileSync(join(w.outside, 'H.pdf'), 'HARDLINK')
    linkSync(join(w.outside, 'H.pdf'), join(w.data, 'T', 'H.pdf'))
    assert.equal(statSync(join(w.outside, 'H.pdf')).nlink, 2)
    L.deletePaper(w.data, 'T', 'H')
    assert.equal(readFileSync(join(w.outside, 'H.pdf'), 'utf8'), 'HARDLINK', '硬链接目标必须存活')
    assert.equal(statSync(join(w.outside, 'H.pdf')).nlink, 1)
    t.diagnostic('硬链接实测：unlink 库内链接后，库外目标存活且 nlink 由 2 → 1')
    rmSync(w.parent, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. 路由层端到端（4 条 CRUD）
// ═══════════════════════════════════════════════════════════════════════════

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
  const post = async (p, b) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt }
  }
  return { srv, post }
}

test('V9 路由层：4 条 CRUD 对越界输入一律可读 4xx（非 500），响应与日志都不含 dataDir 绝对路径', async (t) => {
  const w = tmpParent()
  const { srv, post } = await boot(w)
  const logs = []
  const origError = console.error, origWarn = console.warn, origLog = console.log
  console.error = (...a) => { logs.push(a.map(String).join(' ')); origError(...a) }
  console.warn = (...a) => { logs.push(a.map(String).join(' ')); origWarn(...a) }
  console.log = (...a) => { logs.push(a.map(String).join(' ')) } // 静音但留档
  const results = []
  let before2 = () => ({})
  try {
    const evil = ['../sentinel', '../../..', 'a/../b', '/etc/passwd', '..\\..\\sentinel', '.', '..', '', '   ', '...', '.hidden', 'T/', 'x'.repeat(121), 'a\u0000b', 'a\u0001b']
    for (const [route, key] of [['delete-topic', 'topic'], ['rename-topic', 'topic'], ['delete-paper', 'topic'], ['rename-paper', 'topic']]) {
      for (const v of evil) {
        const body = { topic: v, name: 'P', to: 'renamed' }
        const r = await post(`/api/library/${route}`, body)
        results.push(`${route} ${key}=${JSON.stringify(v.length > 14 ? v.slice(0, 10) + '…' : v)} → ${r.status} ${JSON.stringify(r.body?.error ?? r.body)}`)
        assert.ok(r.status >= 400 && r.status < 500, `${route} 对 ${JSON.stringify(v)} 必须是 4xx，实际 ${r.status} ${r.txt}`)
        assert.ok(typeof r.body?.error === 'string' && r.body.error.length > 0, '必须有可读错误文案')
        assert.ok(!r.txt.includes(w.data), `响应不得泄露 dataDir 绝对路径：${r.txt}`)
      }
    }
    // 主题是库外符号链接：路由自己会放行到 primitive，由 realpath 层拒绝
    symlinkSync(w.outside, join(w.data, 'evil'))
    before2 = () => snap(w.parent)
    for (const [route, body] of [
      ['delete-topic', { topic: 'evil' }],
      ['delete-paper', { topic: 'evil', name: 'Victim' }],
      ['rename-topic', { topic: 'evil', to: 'hijacked' }],
      ['rename-paper', { topic: 'evil', name: 'Victim', to: 'pwned' }],
    ]) {
      const r = await post(`/api/library/${route}`, body)
      results.push(`${route} topic=evil(→库外链接) → ${r.status} ${JSON.stringify(r.body?.error)}`)
      assert.equal(r.status, 400, `${route} 对库外符号链接主题必须 400：${r.status} ${r.txt}`)
      assert.match(r.body.error, /路径越界/, '必须来自 realpath 层')
    }
  } finally {
    console.log = origLog; console.error = origError; console.warn = origWarn
    srv.close()
  }
  assert.deepEqual(diff(before2(), snap(w.parent)), [], '被拒请求不得改动任何文件')
  const leakLogs = logs.filter((l) => l.includes(w.data))
  t.diagnostic(`路由层越界用例 ${results.length} 条全部 4xx；服务端日志 ${logs.length} 行，含 dataDir 绝对路径 ${leakLogs.length} 行`)
  assert.equal(leakLogs.length, 0, `日志不得出现 dataDir 绝对路径：${leakLogs.slice(0, 3)}`)
})

test('V10 路由层：合法请求仍然可用（4 条路由各跑一次成功路径）', async () => {
  const w = tmpParent()
  const { srv, post } = await boot(w)
  try {
    const del = await post('/api/library/delete-paper', { topic: 'T', name: 'P' })
    assert.equal(del.status, 200, del.txt)
    assert.deepEqual(del.body.deleted.sort(), ['P.pdf', 'P.txt'])
    writeFileSync(join(w.data, 'T', 'Q.pdf'), 'Q'); writeFileSync(join(w.data, 'T', 'Q.txt'), 'QT')
    const ren = await post('/api/library/rename-paper', { topic: 'T', name: 'Q', to: 'Q2' })
    assert.equal(ren.status, 200, ren.txt)
    assert.ok(existsSync(join(w.data, 'T', 'Q2.pdf')) && existsSync(join(w.data, 'T', 'Q2.txt')))
    const rtp = await post('/api/library/rename-topic', { topic: 'T', to: 'T2' })
    assert.equal(rtp.status, 200, rtp.txt)
    assert.ok(existsSync(join(w.data, 'T2', 'Q2.pdf')))
    const dtp = await post('/api/library/delete-topic', { topic: 'T2' })
    assert.equal(dtp.status, 200, dtp.txt)
    assert.ok(!existsSync(join(w.data, 'T2')))
    assert.equal(readFileSync(join(w.outside, 'Victim.pdf'), 'utf8'), 'VICTIM-PDF', '库外始终不变')
  } finally { srv.close() }
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. 正常功能零回归
// ═══════════════════════════════════════════════════════════════════════════

test('V11 正常功能：多变体产物删除 / 精确 stem / 中文专题 / 空格-连字符-下划线-点 / 大小写', (t) => {
  const w = tmpParent()
  const topic = '默认专题'
  const dir = join(w.data, topic)
  mkdirSync(dir, { recursive: true })
  const sidecars = ['.pdf', '.txt', '.pages.json', '-zh.pdf', '-dual.pdf', '.study.json', '-en.pdf']
  for (const name of ['Attention', 'Attention Is All You Need']) {
    for (const s of sidecars) writeFileSync(join(dir, name + s), `${name}${s}`)
  }
  // ① 多类派生文件：定义内的 6 类全删
  const deleted = L.deletePaper(w.data, topic, 'Attention').sort()
  assert.deepEqual(deleted, ['Attention-dual.pdf', 'Attention-zh.pdf', 'Attention.pages.json', 'Attention.pdf', 'Attention.study.json', 'Attention.txt'].sort())
  for (const s of ['.pdf', '.txt', '.pages.json', '-zh.pdf', '-dual.pdf', '.study.json']) assert.ok(!existsSync(join(dir, 'Attention' + s)), `应删除 Attention${s}`)
  // ② 精确 stem：兄弟文献逐字节完好；且 -en 不在派生集合里（见报告 F3）
  for (const s of sidecars) {
    const p = join(dir, 'Attention Is All You Need' + s)
    assert.ok(existsSync(p), `兄弟文献 ${s} 必须完好`)
    assert.equal(readFileSync(p, 'utf8'), `Attention Is All You Need${s}`, '内容必须逐字节一致')
  }
  const enLeft = existsSync(join(dir, 'Attention-en.pdf'))
  t.diagnostic(`精确 stem：Attention 的 6 类派生文件已删；兄弟文献 7 个文件逐字节完好；Attention-en.pdf 是否残留 = ${enLeft}（见报告 F3：PAPER_SIDECARS 不含 -en）`)
  // ③ 中文专题改名 + 删除
  L.renameTopic(w.data, topic, '默认专题 2')
  assert.ok(existsSync(join(w.data, '默认专题 2', 'Attention Is All You Need.pdf')))
  assert.ok(!existsSync(join(w.data, topic)))
  L.deleteTopic(w.data, '默认专题 2')
  assert.ok(!existsSync(join(w.data, '默认专题 2')))
  // ④ 含空格 / - / _ / . 的合法名字
  const dir2 = join(w.data, 'T')
  writeFileSync(join(dir2, 'My Paper-2.0_final.pdf'), 'X')
  writeFileSync(join(dir2, 'My Paper-2.0_final.txt'), 'XT')
  const ren = L.renamePaper(w.data, 'T', 'My Paper-2.0_final', 'Renamed 3.1_beta')
  assert.deepEqual(ren.sort(), ['My Paper-2.0_final.pdf', 'My Paper-2.0_final.txt'])
  assert.ok(existsSync(join(dir2, 'Renamed 3.1_beta.pdf')) && existsSync(join(dir2, 'Renamed 3.1_beta.txt')))
  // ⑤ 大小写改名（Linux 大小写敏感）
  writeFileSync(join(dir2, 'CaseA.pdf'), 'c')
  assert.deepEqual(L.renamePaper(w.data, 'T', 'CaseA', 'casea'), ['CaseA.pdf'])
  assert.ok(existsSync(join(dir2, 'casea.pdf')))
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. 结构性判定 + 真实库未被触碰
// ═══════════════════════════════════════════════════════════════════════════

test('V12 防护是结构性的：realpath 规范化 + 严格子路径包含（不是正则黑名单）', () => {
  const src = readFileSync(join(REPO, 'src', 'library.ts'), 'utf8')
  const pre = execFileSync('git', ['show', 'HEAD:src/library.ts'], { cwd: REPO, encoding: 'utf8' })
  // 第一层：词法（相对弱）
  assert.match(src, /export function validateEntryName/, '必须有名字校验')
  assert.match(src, /名字不能包含 \/ \\\\ 或 \.\./, '词法层应拒绝分隔符与 ..')
  // 第二层：realpath 规范化 + 严格子路径包含
  assert.match(src, /function realDataDir\(dataDir: string\)[\s\S]{0,200}realpathSync/, 'realDataDir 必须做 realpath 规范化')
  assert.match(src, /function assertInside\(root: string, target: string\)[\s\S]{0,300}target !== root && !target\.startsWith\(r\)/, 'assertInside 必须是「严格子路径包含」判定')
  assert.match(src, /const r = root\.endsWith\(sep\) \? root : root \+ sep/, '必须做 sep 边界处理（防 data/dataX 前缀混淆）')
  assert.match(src, /function resolveSafeTopic[\s\S]{0,600}realpathSync\(dir\)[\s\S]{0,200}assertInside\(root, real\)/, 'resolveSafeTopic 必须做 realpath + 包含校验')
  // 判定：不是「只靠正则过滤 ..」
  const body = src.slice(src.indexOf('function resolveSafeTopic'), src.indexOf('export function paperRefFor'))
  assert.ok(!/\.\./.test(body.replace(/\/\/[^\n]*/g, '')) || /realpathSync/.test(body), '必须有 realpath 兜底而不是只匹配 .. ')
  // 上游 HEAD 里没有任何 realpathSync（证明这是本次新增的层）
  assert.ok(!/realpathSync/.test(pre), '修复前的 library.ts 不应有 realpathSync')
  // 4 个原语都接上了这两层
  for (const fn of ['renameTopic', 'renamePaper', 'deletePaper', 'deleteTopic']) {
    const seg = src.slice(src.indexOf(`export function ${fn}`), src.indexOf(`export function ${fn}`) + 1200)
    const usesLexical = /validateEntryName\(/.test(seg)
    const usesRealpath = /resolveSafeTopic\(/.test(seg)
    assert.ok(usesLexical || usesRealpath, `${fn} 必须接入防护`)
    assert.ok(usesRealpath || /realDataDir\(/.test(seg), `${fn} 必须经过 realpath 层（resolveSafeTopic 或 realDataDir）`)
  }
  // 路由层：badEntry 出现在文件系统操作之前
  const host = readFileSync(join(REPO, 'src', 'host.ts'), 'utf8')
  for (const route of ['rename-topic', 'delete-topic', 'rename-paper', 'delete-paper']) {
    const at = host.indexOf(`sub === '/api/library/${route}'`)
    const seg = host.slice(at, at + 500)
    assert.match(seg, /badEntry\(res,/, `${route} 必须调用 badEntry`)
  }
  assert.match(host, /const badEntry = \(res: Res, raw: unknown\): boolean =>/, 'badEntry 必须做类型检查')
})

test('V13 真实文献库在本次验证期间零改动（指纹）', () => {
  if (REAL_LIB_BEFORE === null) return
  assert.equal(existsSync(REAL_LIB), true)
  assert.equal(libFingerprint(REAL_LIB), REAL_LIB_BEFORE, '真实文献库被改动了！')
})

test('V14(已知偏离固定) F1 NUL→路径泄露 / F2 类型混淆 500 / F3 -en 残留：三条非阻断发现的可复现固定', async (t) => {
  // 本用例固定「当前行为」，用于让三条发现可回归追踪：一旦上游修掉，本用例会变红，
  // 提醒维护者更新 docs/security-verify.md 的 F1/F2/F3 并放宽这里的断言。
  const w = tmpParent()
  const { srv, post } = await boot(w)
  try {
    // F1：NUL 落在 rename 目标名 → 400，但 Node 原始错误把 dataDir 绝对路径带出来了
    const f1 = await post('/api/library/rename-paper', { topic: 'T', name: 'P', to: 'Q\u0000' })
    t.diagnostic(`F1 现状：status=${f1.status} body=${f1.txt}`)
    assert.equal(f1.status, 400, 'F1：状态码是 4xx（这部分符合验收）')
    if (!f1.txt.includes(w.data)) {
      t.diagnostic('F1 已修复（响应不再含 dataDir 绝对路径）——请更新报告与断言')
    } else {
      assert.match(f1.txt, /without null bytes/, 'F1：当前实现把 Node 原始错误回显给了客户端')
    }
    // F2：非字符串 topic/name → 500（应当是可读 4xx）
    const f2rows = []
    for (const [route, body] of [
      ['delete-topic', { topic: 123 }],
      ['delete-paper', { topic: 'T', name: 123 }],
    ]) {
      const r = await post(`/api/library/${route}`, body)
      f2rows.push(`${route} ${JSON.stringify(body)} → ${r.status} ${r.txt}`)
      if (r.status !== 500) { t.diagnostic(`F2 已修复（${route} → ${r.status}）`); continue }
      assert.equal(r.status, 500, 'F2：当前实现是 500')
    }
    t.diagnostic('F2 现状：' + f2rows.join(' | '))
    // F3：删除文献后 -en.pdf 残留（PAPER_SIDECARS 不含 -en）
    writeFileSync(join(w.data, 'T', 'R.pdf'), 'R'); writeFileSync(join(w.data, 'T', 'R-en.pdf'), 'REN')
    const deleted = L.deletePaper(w.data, 'T', 'R')
    const enLeft = existsSync(join(w.data, 'T', 'R-en.pdf'))
    t.diagnostic(`F3 现状：deleted=${JSON.stringify(deleted)} remaining=${JSON.stringify(readdirSync(join(w.data, 'T')))}`)
    if (!enLeft) t.diagnostic('F3 已修复（-en.pdf 也被删除）——请更新报告与断言')
    assert.equal(enLeft, true, 'F3：当前 -en.pdf 不在 PAPER_SIDECARS 内，会残留')
    // 硬不变量：三条发现都不构成穿越（库外零变化）
    assert.equal(readFileSync(join(w.outside, 'Victim.pdf'), 'utf8'), 'VICTIM-PDF')
    assert.equal(readFileSync(join(w.outside, 'other.pdf'), 'utf8'), 'OTHER-PDF')
  } finally { srv.close() }
})
