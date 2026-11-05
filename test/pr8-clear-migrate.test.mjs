// test/pr8-clear-migrate.test.mjs — 上游 PR #8 维护者评审「必修 D / E」+「应修 G 的 host 侧两条」的可区分用例。
//
// 覆盖（逐条对应 docs/pr8-maintainer-review.md）：
//   D1 /topic/clear 的会话/译文占用巡检只遍历根层 → 子专题论文被照删（改为遍历整棵单元树）
//   D2 /topic/clear-plan 的 papers 清单只含根层 → 确认框看不到子专题论文（清单含子树、与 papersCount 一致）
//   E1 readMigrationLog 整包 JSON.parse → 坏行让 --rollback 静默「已回滚 0 个文件」exit 0（逐行报错）
//   E2 阶段 1 mkdir 后被打断 → 半成品目录在复跑时被判 dir-other、该篇永久跳过（保守识别并续跑）
//   E3 /migrate 同步跑全量复制+双 sha256 → 冻住事件循环；且没有对在飞转录/译文加 busy 门
//   G3 paper 范围的 scopeBusy 用 `\0` key 和 `/` 路径比对 → 提示永远不触发
//   G4 回滚日志路径前缀判断缺分隔符 → `/a/bc` 冒充 `/a/b` 的子路径
//
// 约定：只 import dist/*.js（跑前 build）；破坏性实验一律 mkdtemp 临时库；不碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

const L = await import(pathToFileURL(dist('library.js')).href)
const M = await import(pathToFileURL(dist('library-manage.js')).href)
const MG = await import(pathToFileURL(dist('migrate.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// $DSH_HOME 固定到临时目录（迁移日志默认落在这里；绝不碰真实 ~/.dsh）。
const HOME = mkdtempSync(join(tmpdir(), 'dpr-cm-home-'))
process.env.DSH_HOME = HOME

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function newLib() {
  const root = mkdtempSync(join(tmpdir(), 'dpr-cm-'))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局落一篇论文：`<data>/<topic>/<name>/<name>.pdf`（+ 默认 .txt）。 */
function putPaper(data, topic, name, extra = ['.txt']) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.pdf'), `pdf:${topic}/${name}`)
  for (const s of extra) writeFileSync(join(dir, name + s), `body:${topic}/${name}`)
  return dir
}

/** 旧布局（平铺）落一篇论文：`<data>/<topic>/<name>.pdf`（+ 默认 .txt）。 */
function putFlatPaper(data, topic, name, extra = ['.txt']) {
  mkdirSync(join(data, topic), { recursive: true })
  writeFileSync(join(data, topic, name + '.pdf'), `flatpdf:${name}`)
  for (const s of extra) writeFileSync(join(data, topic, name + s), `flatbody:${name}`)
}

/** 库内快照（相对路径 → 文件内容 / 'dir'）。 */
function snap(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const rel = relative(dir, p).split(sep).join('/')
      if (e.isDirectory()) { out[rel] = 'dir'; walk(p) } else out[rel] = readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

/** 某篇论文的伴读会话 id（与 host.ts 的 sessionPrefixFor 同构）。 */
function sessionFor(topic, name, running = true) {
  return {
    sessionId: `dpr-${Buffer.from(`${topic}/${name}`).toString('base64url')}-1`,
    running,
    blank: false,
    updatedAt: Date.now(),
  }
}

/** 启动路由。`list` 可自定义（用于 G3 的「在途操作」时序）；`prompts` 收集 /api/ask 注入的提示词。 */
async function boot(dataDir, opts = {}) {
  const prompts = []
  const items = opts.items ?? (() => [])
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {
      list: opts.list ?? (async () => ({ items: items() })),
      create: async () => ({}),
      prompt: async (req) => { prompts.push(req.content[0]?.text ?? ''); return { accepted: true } },
    },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const parse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const get = async (p) => { const r = await fetch(base + p); const t = await r.text(); return { status: r.status, body: parse(t), txt: t } }
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const t = await r.text()
    return { status: r.status, body: parse(t), txt: t }
  }
  return { srv, get, post, prompts }
}

/** 假 babeldoc：--version/--help 立刻返回，真被拉起时写 pid 后 sleep（保持真实 busy 状态）。 */
function fakeBabeldoc(root) {
  const pidFile = join(root, 'tx.pid')
  process.env.VB_TX_PIDFILE = pidFile
  const binDir = join(root, '.venv-pdf2zh', 'bin')
  mkdirSync(binDir, { recursive: true })
  const binPath = join(binDir, 'babeldoc')
  writeFileSync(binPath, '#!/bin/sh\ncase "$1" in\n  --version) echo "babeldoc fake 1.0"; exit 0 ;;\n  --help) echo "--no-watermark --skip-figure-text"; exit 0 ;;\n  *) echo $$ > "$VB_TX_PIDFILE"; exec sleep 120 ;;\nesac\n')
  chmodSync(binPath, 0o755)
  return {
    pidFile,
    cleanup: () => {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim())
        if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
      }
      delete process.env.VB_TX_PIDFILE
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   D. 清空/删除的占用检查只看一层
   ═══════════════════════════════════════════════════════════════════════════ */

test('D1 /topic/clear：子专题里有活跃会话 → 409，整次清空被拒且零回收站写入', async () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P1')          // 根层 1 篇（无会话）
  putPaper(data, 'T/Sub', 'P2')      // 子专题 1 篇（有活跃会话）
  const before = snap(data)
  const { srv, post } = await boot(data, { items: () => [sessionFor('T/Sub', 'P2', true)] })
  try {
    const r = await post('/api/library/topic/clear', { topic: 'T', confirmName: 'T' })
    assert.equal(r.status, 409, `子专题论文有活跃会话时必须拦住整次清空：${r.txt}`)
    assert.equal(r.body.code, 'session-running', r.txt)
    assert.deepEqual(snap(data), before, '被拒的清空必须零改动')
    assert.equal(existsSync(join(data, '.trash')), false, '不得产生任何回收站写入')
    assert.ok(existsSync(join(data, 'T', 'P1', 'P1.pdf')) && existsSync(join(data, 'T', 'Sub', 'P2', 'P2.pdf')), '两篇都必须还在')
  } finally { srv.close() }
})

test('D2 /topic/clear-plan：papers 清单含整棵子树的论文，papersCount 与清单一致，subtopics 汇总保留', async () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P1')
  putPaper(data, 'T/Sub', 'P2')
  putPaper(data, 'T/Sub/Deep', 'P3')
  const { srv, get } = await boot(data)
  try {
    const r = await get('/api/library/topic/clear-plan?topic=T')
    assert.equal(r.status, 200, r.txt)
    const listed = r.body.papers.map((p) => `${p.topic}/${p.name}`).sort()
    assert.deepEqual(listed, ['T/P1', 'T/Sub/Deep/P3', 'T/Sub/P2'], `确认框必须逐篇列出子树论文：${r.txt}`)
    assert.equal(r.body.papersCount, listed.length, 'papersCount 必须与清单一致（旧实现只数根层却报子树总数）')
    assert.equal(r.body.papersCount, 3)
    assert.equal(r.body.subtopics.length, 1, 'subtopics 汇总仍保留')
    assert.equal(r.body.subtopics[0].topic, 'T/Sub')
    assert.equal(r.body.subtopics[0].papersCount, 2, '子专题汇总的篇数含更深层')
    // 逐篇仍带 sessions/translation（确认框高亮“第 N 篇正在翻译”靠它）
    for (const p of r.body.papers) assert.ok(p.sessions && p.translation, `逐篇字段缺失：${JSON.stringify(p)}`)
  } finally { srv.close() }
})

test('D3 /topic/clear：子专题里有生成中译文 → 409 translation-busy（子树巡检）', async (t) => {
  if (process.platform === 'win32') {
    // 与既有 VB8/B5 同一平台限制：假 babeldoc 的 `#!/bin/sh` 与 translate.ts 的 win32 候选不匹配。
    // 按未验证登记，不做永真断言（不是「跳过糊绿灯」：本用例在 POSIX 上真实拉起假 babeldoc）。
    return t.skip('win32：假 babeldoc 解释器形态不可用（本机与 CI 均未跑过 win32）——未验证')
  }
  const { root, data } = newLib()
  putPaper(data, 'T', 'P1')
  putPaper(data, 'T/Sub', 'P2')
  const fake = fakeBabeldoc(root)
  const { srv, post } = await boot(data)
  try {
    const { startTranslation, zhStatus } = await import(pathToFileURL(dist('translate.js')).href)
    const ref = L.resolvePaper(data, { topic: 'T/Sub', name: 'P2' })
    const started = await startTranslation(ref, data, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' })
    assert.equal(started.started, true, JSON.stringify(started))
    assert.equal(zhStatus(ref).busy, true, '前置：翻译必须处于真实 busy 状态')
    const before = snap(join(data, 'T'))
    const r = await post('/api/library/topic/clear', { topic: 'T', confirmName: 'T' })
    assert.equal(r.status, 409, `子专题论文正在生成译文时必须拦住整次清空：${r.txt}`)
    assert.equal(r.body.code, 'translation-busy', r.txt)
    assert.ok(Array.isArray(r.body.papers) && r.body.papers.includes('T/Sub/P2'), `payload 必须点名子专题那篇：${r.txt}`)
    assert.deepEqual(snap(join(data, 'T')), before, '被拒的清空必须零改动')
  } finally { srv.close(); fake.cleanup(); rmSync(join(root, 'data', '..', '.venv-pdf2zh'), { recursive: true, force: true }) }
})

/* ═══════════════════════════════════════════════════════════════════════════
   E1. 迁移日志坏行：不再静默假成功
   ═══════════════════════════════════════════════════════════════════════════ */

test('E1 坏行日志：readMigrationLog 逐行报错；CLI --rollback 非 0 且指出行号；完好日志回滚不回归', () => {
  const { data, root } = newLib()
  const home = join(root, 'home'); mkdirSync(home, { recursive: true })
  putFlatPaper(data, 'T', 'P1')
  putFlatPaper(data, 'T', 'P2')
  const good = join(home, 'good.jsonl')
  const res = MG.runMigration(data, { home, logPath: good })
  assert.equal(res.ok, true)
  assert.equal(MG.readMigrationLog(good).length, 4, '完好日志 4 条（2 篇 × pdf+txt）')

  const cli = (args) => spawnSync(process.execPath, [join(REPO, 'dist', 'migrate.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: HOME },
  })
  // ① 完好日志回滚：不回归（exit 0 + 真的搬回原位）
  const ok = cli(['--data-dir', data, '--home', home, '--rollback', good, '--yes'])
  assert.equal(ok.status, 0, `完好日志回滚必须成功：${ok.stdout}${ok.stderr}`)
  assert.match(ok.stdout, /已回滚 4 个文件/)
  assert.ok(existsSync(join(data, 'T', 'P1.pdf')), '回滚后平铺源必须回来')

  // ② 坏行（SIGKILL 打断 append 的典型现场）：有效行 + 截断行
  putFlatPaper(data, 'T', 'P3')
  const good3 = join(home, 'good3.jsonl')
  MG.runMigration(data, { home, logPath: good3 })
  const corrupt = join(home, 'corrupt.jsonl')
  writeFileSync(corrupt, readFileSync(good3, 'utf8') + '{"from":"T/P3.txt","to":"T/P3/P3.tx')
  assert.throws(
    () => MG.readMigrationLog(corrupt),
    (e) => e?.code === 'migrate-log-corrupt' && /第 \d+ 行/.test(e.message) && /JSON/.test(e.message),
    '函数层：坏行必须带行号与原因抛 migrate-log-corrupt',
  )
  const bad = cli(['--data-dir', data, '--home', home, '--rollback', corrupt, '--yes'])
  assert.notEqual(bad.status, 0, `坏行日志的 --rollback 必须非 0：stdout=${bad.stdout} stderr=${bad.stderr}`)
  assert.match(bad.stderr, /第 \d+ 行/, `错误必须指出坏行行号：${bad.stderr}`)
  assert.match(bad.stderr, /JSON/, `错误必须说明原因：${bad.stderr}`)
  assert.ok(!/已回滚 0 个文件/.test(bad.stdout), '不得再打印「已回滚 0 个文件」装作成功')

  // ③ 日志根本不可读（路径不存在）：同样必须显式失败，而不是 0 个文件 exit 0
  const missing = cli(['--data-dir', data, '--home', home, '--rollback', join(home, 'no-such.jsonl'), '--yes'])
  assert.notEqual(missing.status, 0, `不存在的日志必须非 0：${missing.stdout}${missing.stderr}`)
  assert.match(missing.stderr, /不可读|no-such/, missing.stderr)
})

test('E1b /migrate-rollback：坏行日志 → 409 migrate-log-corrupt（不再 200 假成功）', async () => {
  const { data } = newLib()
  // 注意：/migrate-rollback 只接受 $DSH_HOME 下 migration-logs 目录内的日志（G4 的边界检查）。
  const logDir = MG.migrationLogDir()
  mkdirSync(logDir, { recursive: true })
  putFlatPaper(data, 'T', 'P1')
  const good = join(logDir, 'ok.jsonl')
  MG.runMigration(data, { home: HOME, logPath: good })
  const corrupt = join(logDir, 'bad.jsonl')
  writeFileSync(corrupt, '{"from":"T/P1.pdf","to":"T/P1/P1.pdf"}\n{"from": BROKEN\n')
  const { srv, post } = await boot(data)
  try {
    const r = await post('/api/library/migrate-rollback', { confirm: 'rollback-library', logPath: corrupt })
    assert.equal(r.status, 409, `坏行日志必须 409：${r.txt}`)
    assert.equal(r.body.code, 'migrate-log-corrupt')
    assert.match(r.body.error, /第 2 行/, r.txt)
  } finally { srv.close() }
})

/* ═══════════════════════════════════════════════════════════════════════════
   E2. 阶段 1 中断后的半成品目录：不再永久跳过
   ═══════════════════════════════════════════════════════════════════════════ */

test('E2 阶段 1 在 mkdir 后、复制前被打断 → 复跑识别半成品并完成迁移（别人的非空异目录仍不动）', () => {
  const { data, root } = newLib()
  const home = join(root, 'home'); mkdirSync(home, { recursive: true })

  // ── 场景 A：mkdir 完成后、第一个 copy 就被杀（目录空 / 至多带半成品标记）──
  putFlatPaper(data, 'T', 'P1')
  assert.throws(
    () => MG.runMigration(data, { home, logPath: join(home, 'a1.jsonl'), copyImpl: () => { throw new Error('SIGKILL 模拟：mkdir 后、复制前') } }),
    /SIGKILL/,
  )
  assert.equal(existsSync(join(data, 'T', 'P1')), true, '中断现场：论文目录已建出来')
  assert.equal(existsSync(join(data, 'T', 'P1', 'P1.pdf')), false, '中断现场：产物还没复制')
  const planAfterKill = MG.planMigration(data, home)
  assert.ok((planAfterKill.halfProducts ?? []).includes('T/P1'), `干跑必须识别出自己上次的半成品：${JSON.stringify(planAfterKill.halfProducts)}`)
  const resumed = MG.runMigration(data, { home, logPath: join(home, 'a2.jsonl') })
  assert.equal(resumed.copied, 2, `复跑必须真的迁移该篇（不是 skipped）：${JSON.stringify(resumed.skippedPapers)}`)
  assert.equal(resumed.removed, 2)
  assert.equal(resumed.partial, false, '复跑应完整成功（无跳过项）')
  assert.equal(readFileSync(join(data, 'T', 'P1', 'P1.pdf'), 'utf8'), 'flatpdf:P1')
  assert.equal(readFileSync(join(data, 'T', 'P1', 'P1.txt'), 'utf8'), 'flatbody:P1')
  assert.equal(existsSync(join(data, 'T', 'P1.pdf')), false, '源必须被清掉')
  const left = readdirSync(join(data, 'T', 'P1')).sort()
  assert.deepEqual(left, ['P1.pdf', 'P1.txt'], `成功后不得残留半成品标记：${left.join(',')}`)

  // ── 场景 B：copy 写了一半被杀（目录里有 partial 文件 + 标记）──
  const b = newLib()
  const bhome = join(b.root, 'home'); mkdirSync(bhome, { recursive: true })
  putFlatPaper(b.data, 'T', 'P2')
  assert.throws(
    () => MG.runMigration(b.data, {
      home: bhome, logPath: join(bhome, 'b1.jsonl'),
      copyImpl: (_from, to) => { writeFileSync(to, 'PARTIAL'); throw new Error('SIGKILL 模拟：写了一半') },
    }),
    /SIGKILL/,
  )
  assert.equal(readFileSync(join(b.data, 'T', 'P2', 'P2.pdf'), 'utf8'), 'PARTIAL')
  assert.ok((MG.planMigration(b.data, bhome).halfProducts ?? []).includes('T/P2'))
  const rb = MG.runMigration(b.data, { home: bhome, logPath: join(bhome, 'b2.jsonl') })
  assert.equal(rb.copied, 2, `半成品文件必须按可续处理：${JSON.stringify(rb.skippedPapers)}`)
  assert.equal(readFileSync(join(b.data, 'T', 'P2', 'P2.pdf'), 'utf8'), 'flatpdf:P2', 'partial 必须被我们自己的完整副本替换')
  assert.deepEqual(readdirSync(join(b.data, 'T', 'P2')).sort(), ['P2.pdf', 'P2.txt'])

  // ── 场景 C：别人的非空异目录（含陌生文件）绝不被当成半成品、也不被删 ──
  const c = newLib()
  const chome = join(c.root, 'home'); mkdirSync(chome, { recursive: true })
  putFlatPaper(c.data, 'T', 'Other')
  mkdirSync(join(c.data, 'T', 'Other'), { recursive: true })
  writeFileSync(join(c.data, 'T', 'Other', 'note.md'), 'USER-DATA-MUST-SURVIVE')
  const planC = MG.planMigration(c.data, chome)
  assert.ok(!(planC.halfProducts ?? []).includes('T/Other'), '带陌生文件的目录绝不能判成半成品')
  assert.ok(planC.conflicts.some((x) => x.paper === 'T/Other'), '仍按 dir-other 冲突报告')
  const rc = MG.runMigration(c.data, { home: chome, logPath: join(chome, 'c1.jsonl') })
  assert.equal(rc.copied, 0, '冲突篇不得被迁移')
  assert.equal(rc.partial, true)
  assert.equal(readFileSync(join(c.data, 'T', 'Other', 'note.md'), 'utf8'), 'USER-DATA-MUST-SURVIVE', '陌生文件一个字都不能动')
  assert.ok(existsSync(join(c.data, 'T', 'Other.pdf')), '平铺源也必须原地不动')
  assert.deepEqual(readdirSync(join(c.data, 'T', 'Other')), ['note.md'])
})

/* ═══════════════════════════════════════════════════════════════════════════
   E3. /migrate：不阻塞事件循环 + 在飞转录/译文的 busy 门
   ═══════════════════════════════════════════════════════════════════════════ */

test('E3a /migrate 执行期间事件循环不被同步阻塞：另一个请求能在迁移完成前得到响应', async () => {
  const { data } = newLib()
  // 足够多的文件让同步实现可测量地阻塞事件循环（每个文件 copy + 双 sha256 + 日志 fsync）。
  for (let i = 0; i < 360; i++) putFlatPaper(data, 'T', `P${String(i).padStart(3, '0')}`, ['.txt', '.pages.json'])
  const { srv, get, post } = await boot(data)
  try {
    const migP = post('/api/library/migrate', { confirm: 'migrate-library' })
    // 迁移开始后 10ms 再发一个只读请求；同步实现里这个 timer 根本轮不到（事件循环被占死），
    // 要等整个迁移跑完才可能触发 ⇒ gStart 会晚于 migEnd。
    await sleep(10)
    const gStart = Date.now()
    const lib = await get('/api/library')
    const gEnd = Date.now()
    const mig = await migP
    const migEnd = Date.now()
    assert.equal(lib.status, 200)
    assert.equal(mig.status, 200, mig.txt)
    assert.ok(migEnd - gStart > 30, `迁移必须仍在进行才测得出来（migration 剩余 ${migEnd - gStart}ms）`)
    assert.ok(gEnd < migEnd, `读请求必须在迁移完成之前得到响应：get ${gEnd}ms / migration done ${migEnd}ms`)
    assert.ok(migEnd - gEnd > 10, `读请求返回时迁移应仍在进行：剩余 ${migEnd - gEnd}ms`)
  } finally { srv.close() }
})

test('E3b /migrate 的 busy 门：有生成中译文 → 409 busy 且不执行迁移', async (t) => {
  if (process.platform === 'win32') {
    return t.skip('win32：假 babeldoc 解释器形态不可用（本机与 CI 均未跑过 win32）——未验证')
  }
  const { root, data } = newLib()
  putPaper(data, 'T', 'P')
  const fake = fakeBabeldoc(root)
  const { srv, post } = await boot(data)
  try {
    const { startTranslation } = await import(pathToFileURL(dist('translate.js')).href)
    const ref = L.resolvePaper(data, { topic: 'T', name: 'P' })
    const started = await startTranslation(ref, data, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' })
    assert.equal(started.started, true, JSON.stringify(started))
    // 只对论文专题目录做快照：翻译流水线会惰性创建 `.pdf2zh-tmp` 之类的草稿目录（与迁移无关）。
    const before = snap(join(data, 'T'))
    const r = await post('/api/library/migrate', { confirm: 'migrate-library' })
    assert.equal(r.status, 409, `有在飞译文时必须 409：${r.txt}`)
    assert.equal(r.body.code, 'busy')
    assert.match(r.body.error, /转录|译文/, '文案必须可执行（说清在等什么）')
    assert.deepEqual(snap(join(data, 'T')), before, 'busy 门必须在动任何文件之前拒绝')
    assert.equal(existsSync(join(data, MG.DONE_MARKER)), false, '不得写完成标记')
  } finally { srv.close(); fake.cleanup(); rmSync(join(root, '.venv-pdf2zh'), { recursive: true, force: true }) }
})

/* ═══════════════════════════════════════════════════════════════════════════
   G 次级（host 侧两条）
   ═══════════════════════════════════════════════════════════════════════════ */

test('G3 paper 范围的 scopeBusy 提示能真实触发（inflight key 与 scopePath 的匹配修对）', async () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P')
  let calls = 0
  const { srv, post, prompts } = await boot(data, {
    list: async () => {
      calls++
      // 只让**第一个**会话查询（删除/改名在途操作的前置检查）变慢：在这段时间里 inflight 有 key；
      // 之后的 /api/ask 自己的会话查询立即返回，于是它能在操作仍在途时读到 busy 提示。
      if (calls === 1) await sleep(400)
      return { items: [] }
    },
  })
  try {
    const renP = post('/api/library/rename-paper', { topic: 'T', name: 'P', to: 'P2' })
    await sleep(60)                                  // 让 rename 进入 withInflight 并卡在会话前置上
    const ask = await post('/api/ask', { topic: 'T', name: 'P', question: '这篇讲了什么？', scope: { kind: 'paper' } })
    assert.equal(ask.status, 200, ask.txt)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /正在被修改/, `scopeBusy 提示必须真实出现：${JSON.stringify(prompts[0].slice(-160))}`)
    const ren = await renP
    assert.equal(ren.status, 200, ren.txt)
  } finally { srv.close() }
})

test('G4 回滚日志路径前缀判定：`<logDir>-evil` 不再被 `<logDir>` 误判通过', async () => {
  const { data } = newLib()
  const logDir = MG.migrationLogDir()          // host 用的正是默认 dshHome() 下的这个目录
  mkdirSync(logDir, { recursive: true })
  putFlatPaper(data, 'T', 'P1')
  const goodLog = join(logDir, 'ok.jsonl')
  MG.runMigration(data, { home: HOME, logPath: goodLog })

  // 只差一个分隔符的兄弟目录：旧 startsWith(`/.../migration-logs`) 会放它过去。
  const evilDir = logDir + '-evil'
  mkdirSync(evilDir, { recursive: true })
  const evilLog = join(evilDir, 'x.jsonl')
  writeFileSync(evilLog, '{"from":"T/P1.pdf","to":"T/P1/P1.pdf"}\n')

  const { srv, post } = await boot(data)
  try {
    const bad = await post('/api/library/migrate-rollback', { confirm: 'rollback-library', logPath: evilLog })
    assert.equal(bad.status, 400, `兄弟目录必须被拒：${bad.txt}`)
    assert.equal(bad.body.code, 'escape-rejected')
    // 正向对照：目录内的合法日志仍能回滚（新判据不能把正常路径也挡掉）
    const ok = await post('/api/library/migrate-rollback', { confirm: 'rollback-library', logPath: goodLog })
    assert.equal(ok.status, 200, ok.txt)
    assert.ok(ok.body.restored >= 1)
    assert.ok(existsSync(join(data, 'T', 'P1.pdf')), '合法日志必须真的搬回平铺源')
  } finally { srv.close() }
})
