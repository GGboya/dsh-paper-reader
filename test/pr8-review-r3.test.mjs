// test/pr8-review-r3.test.mjs — REV3（t6）对 IMP3（t3）D / E / G(host 次级) 的**独立对抗探针**。
//
// 独立性声明（团队 profile 硬规则：评审必须自己构造证据）：
//   · 不 import 实现方 `test/pr8-clear-migrate.test.mjs`；临时库结构、会话 mock、坏日志构造、
//     「阶段 1 被打断」的现场（空目录 / 标记 + 半截产物）全部由本评审**手工构造**（不跑实现方构造函数）。
//   · 只 import `dist/*.js`；库一律 `mkdtemp`，`DSH_HOME` 指向临时目录；迁移日志写在临时 HOME 下。
//   · 同一份探针可跑 **fdb45f2 基线**：`R3_REPO=/abs/.worktrees/pr8-baseline node --test test/pr8-review-r3.test.mjs`
//     ⇒ 缺陷条目应红；修复后应绿。
//
// 覆盖（docs/pr8-maintainer-review.md：必修 D、必修 E、G 的 host 次级两条）：
//   D1  /topic/clear 的占用巡检遍历整棵子树（子专题论文有活跃会话 ⇒ 整次拒绝、零回收站写入）
//   D2  /topic/clear-plan 的 papers 含子树论文且与 papersCount 严格一致
//   D3  子专题论文「生成中译文」⇒ 清空 409 translation-busy（真实 busy 状态，非 mock 文案）
//   E1  CLI `--rollback` 对坏 JSONL（首行/中间行/尾行截断）必须非 0 退出且指出坏行；完好日志不回归
//       + 路由 `/migrate-rollback` 对坏日志 409（不再 200「恢复 0 个文件」假成功）
//   E2  自己构造「mkdir 论文目录后、.pdf 复制前被杀」现场（空目录 / 标记+半截产物）⇒ 复跑真的迁完；
//       别人的非空异目录一字不动
//   E2b 真实中断（failAfterCopies=1）后复跑收敛
//   E3a /migrate 期间并发 GET 的响应性（写清测法与阈值）
//   E3b 在飞译文时 POST /migrate 409 busy（动文件之前拒绝）
//   G3  paper 范围 scopeBusy 提示真实触发（rename 在途）
//   G4  /migrate-rollback 的 logPath 前缀判定：`<logDir>-evil` 不得冒充 logDir 内文件
//
// 判读：本文件绿 = 修复在本评审自造场景下成立；红 = 消息带实际值/测量值。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 默认测当前修复树；`R3_REPO` 指向基线工作树时跑基线对照。 */
const TARGET = process.env.R3_REPO ? resolve(process.env.R3_REPO) : join(HERE, '..')
const BASELINE_MODE = Boolean(process.env.R3_REPO)
const REPO = TARGET
const dist = (m) => join(TARGET, 'dist', m)

// 迁移日志默认落 $DSH_HOME/.dsh-paper-reader/migration-logs：固定到临时目录，绝不碰真实 ~/.dsh
const HOME = mkdtempSync(join(tmpdir(), 'dpr-r3-home-'))
process.env.DSH_HOME = HOME

const M = await import(pathToFileURL(dist('migrate.js')).href)
const L = await import(pathToFileURL(dist('library.js')).href)
const T = await import(pathToFileURL(dist('translate.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

const MIGRATING_MARKER = '.migration-v1.inprogress' // 与实现同名的**数据文件**；探针只用字符串
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ═════════════════════════════════════════════════════════════════════════════
// 夹具
// ═════════════════════════════════════════════════════════════════════════════

function newLib(prefix = 'dpr-r3-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const data = join(root, 'data')
  mkdirSync(data, { recursive: true })
  return { root, data }
}

/** 新布局论文：`<data>/<topic>/<name>/<name>.pdf`（可带 txt）。 */
function putPaper(data, topic, name, body = `body:${topic}/${name}`) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), `pdf:${topic}/${name}`)
  writeFileSync(join(dir, `${name}.txt`), body)
  return dir
}

/** 旧布局平铺论文：`<data>/<topic>/<name><suffix>`。 */
function putFlat(data, topic, name, suffix, content = `flat:${name}${suffix}`) {
  mkdirSync(join(data, topic), { recursive: true })
  writeFileSync(join(data, topic, `${name}${suffix}`), content)
}

/** 全库快照（相对路径 → 'dir' | 文件内容）：断言「被拒操作零改动」/「别人的目录一字未动」。
 *  `ignore`：忽略的前缀（例如 `.pdf2zh-tmp`，它由**前置的**翻译任务自己创建，不是被拒操作写的）。 */
function snap(data, ignore = []) {
  const out = {}
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      const rel = relative(data, p).split(sep).join('/')
      if (ignore.some((ig) => rel === ig || rel.startsWith(ig + '/'))) continue
      if (e.isDirectory()) { out[rel] = 'dir'; walk(p) } else out[rel] = readFileSync(p, 'utf8')
    }
  }
  walk(data)
  return out
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')
const sessionIdOf = (path, n = 1) => `dpr-${b64url(path)}-${n}`

/**
 * 路由宿主。`sessions` 是 sessionController.list 的返回条目（形如
 * `{sessionId, running, blank, updatedAt}`）；`listDelayFirstMs` 把**第一次** list 卡住，
 * 用来把 rename 钉在 withInflight 里（G3 测法）。
 */
async function boot(data, { sessions = [], listDelayFirstMs = 0 } = {}) {
  let spec = null
  const state = { promptText: null }
  let firstList = true
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {
      list: async () => {
        if (firstList && listDelayFirstMs > 0) { firstList = false; await sleep(listDelayFirstMs) }
        else firstList = false
        return { items: sessions.map((s) => ({ blank: false, updatedAt: 1, ...s })) }
      },
      create: async () => ({}),
      prompt: async (payload) => { state.promptText = payload?.content?.[0]?.text ?? '' },
    },
    workspaceController: {},
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const parse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const get = async (p) => {
    const t0 = performance.now()
    const r = await fetch(base + p)
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt, start: t0, end: performance.now() }
  }
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const txt = await r.text()
    return { status: r.status, body: parse(txt), txt }
  }
  return { srv, get, post, state, close: () => { srv.closeAllConnections?.(); srv.close() } }
}

/** 跑迁移 CLI（独立进程；DSH_HOME 固定到本探针的临时 HOME）。 */
function runCli(args) {
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'migrate.js'), ...args], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: HOME },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ═════════════════════════════════════════════════════════════════════════════
// D. 清空占用与确认清单（整棵子树）
// ═════════════════════════════════════════════════════════════════════════════

test('R3-D1 子专题论文有活跃会话 ⇒ 清空被拒（409 session-running）、零改动、零回收站写入', async (t) => {
  const { root, data } = newLib('dpr-r3-d1-')
  // 根层 1 篇 + 子专题 1 篇；会话 mock 只给子专题那篇一个 running 会话
  putPaper(data, 'T', 'P1')
  putPaper(data, 'T/Sub', 'P2')
  const s = await boot(data, { sessions: [{ sessionId: sessionIdOf('T/Sub/P2'), running: true }] })
  try {
    const before = snap(data)
    const r = await s.post('/api/library/topic/clear', { topic: 'T', confirmName: 'T' })
    t.diagnostic(`clear=${r.status} body=${r.txt.slice(0, 220)}`)
    // ← 基线在此红：200 cleared:2（子专题论文被搬进回收站）
    assert.equal(r.status, 409, `子专题论文有活跃会话时必须拦住整次清空：实际 ${r.status} ${r.txt}`)
    assert.equal(r.body?.code, 'session-running', `机器码必须 session-running：${r.txt}`)
    assert.deepEqual(snap(data), before, '被拒的清空必须零改动（逐字节）')
    assert.equal(existsSync(join(data, '.trash')), false, '被拒的清空不得写入回收站')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('R3-D2 clear-plan 的 papers 含子树论文，且 papersCount 与清单严格一致', async (t) => {
  const { root, data } = newLib('dpr-r3-d2-')
  putPaper(data, 'T', 'P1')
  putPaper(data, 'T/Sub', 'P2')
  putPaper(data, 'T/Sub/Deep', 'P3')
  const s = await boot(data)
  try {
    const r = await s.get('/api/library/topic/clear-plan?topic=T')
    t.diagnostic(`plan=${r.status} papers=${JSON.stringify(r.body?.papers?.map((p) => `${p.topic}/${p.name}`))} count=${r.body?.papersCount}`)
    assert.equal(r.status, 200, r.txt)
    const keys = (r.body.papers ?? []).map((p) => `${p.topic}/${p.name}`).sort()
    // ← 基线在此红：只列 ["T/P1"]，但 papersCount=3
    assert.deepEqual(keys, ['T/P1', 'T/Sub/Deep/P3', 'T/Sub/P2'],
      `确认清单必须列出整棵子树的论文：${JSON.stringify(keys)}`)
    assert.equal(r.body.papersCount, keys.length,
      `papersCount(${r.body.papersCount}) 必须与清单条数(${keys.length}) 一致（不许自相矛盾）`)
    assert.ok((r.body.subtopics ?? []).some((x) => x.topic === 'T/Sub'), 'subtopics 汇总必须保留')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ── 真实「生成中译文」busy：假 babeldoc（--version/--help 立即返回，真正拉起时 sleep 30）────
function installFakeBabeldoc(pidFile) {
  const dir = join(dirname(pidFile), '.venv-pdf2zh', 'bin')
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'babeldoc')
  // 用数组拼脚本（避免 JS 模板字符串把 shell 的 ${...} 当成插值）
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "fake-babeldoc 0.0.0"; exit 0 ;;',
    '  --help) echo "--files --output --openai-base-url --openai-api-key --openai-model"; exit 0 ;;',
    'esac',
    'out=""; files=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --output) out="$2"; shift 2 ;;',
    '    --files) files="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'sleep 3',
    'stem=$(basename "$files" .pdf)',
    'if [ -n "$out" ]; then : > "$out/$stem.zh-CN.mono.pdf"; : > "$out/$stem.zh-CN.dual.pdf"; fi',
    'exit 0',
    '',
  ].join('\n')
  writeFileSync(bin, script)
  chmodSync(bin, 0o755)
  return bin
}

async function startFakeTranslation(data, ref, root) {
  const pidFile = join(root, 'fake-babeldoc.pid')
  process.env.R3_FAKE_BABELDOC_PID = pidFile
  installFakeBabeldoc(pidFile)
  const r = await T.startTranslation(ref, data, { baseUrl: 'http://fake.invalid', apiKey: 'k', model: 'm' })
  assert.equal(r.started, true, `假 babeldoc 必须能启动翻译任务：${JSON.stringify(r)}`)
  for (let i = 0; i < 100 && !T.zhStatus(ref).busy; i++) await sleep(20)
  assert.equal(T.zhStatus(ref).busy, true, '前提：翻译任务必须真的处于 busy（否则本用例空转）')
  // 等 `.pdf2zh-tmp` 真的建出来（launch 的 mkdir 在 busy 之后），再做「零改动」快照
  for (let i = 0; i < 100 && !existsSync(join(data, '.pdf2zh-tmp')); i++) await sleep(20)
  assert.equal(existsSync(join(data, '.pdf2zh-tmp')), true, '前提：翻译 scratch 目录必须已建出')
  return {
    async stop() {
      for (let i = 0; i < 250 && T.zhStatus(ref).busy; i++) await sleep(20)
    },
  }
}

test('R3-D3/E3b 子专题论文生成中译文 ⇒ 清空 409 translation-busy；在飞译文时 /migrate 409 busy（零改动）', async (t) => {
  const { root, data } = newLib('dpr-r3-d3-')
  putPaper(data, 'T', 'P1')
  const subDir = putPaper(data, 'T/Sub', 'P2', 'P2-body')
  const s = await boot(data)
  const ref = L.paperRefFor(data, 'T/Sub', 'P2')
  let fake = null
  try {
    fake = await startFakeTranslation(data, ref, root)
    const before = snap(data, ['.pdf2zh-tmp'])
    // E3b：迁移会搬动全库文件，必须先被 busy 门拦住
    const mig = await s.post('/api/library/migrate', { confirm: 'migrate-library' })
    t.diagnostic(`migrate=${mig.status} body=${mig.txt.slice(0, 180)}`)
    // ← 基线在此红：200（迁移照跑）
    assert.equal(mig.status, 409, `在飞译文时 /migrate 必须 409（动文件之前拒绝）：${mig.status} ${mig.txt}`)
    assert.equal(mig.body?.code, 'busy', `机器码必须 busy：${mig.txt}`)
    assert.ok((mig.body?.papers ?? []).some((p) => p === 'T/Sub/P2'), `busy 文案必须点名在飞论文：${mig.txt}`)
    assert.deepEqual(snap(data, ['.pdf2zh-tmp']), before, '被拒的迁移不得改动任何文件（翻译 scratch 是前置任务的，不计）')

    // D3：清空必须同样被译文 busy 拦住，且点名子专题论文
    const clear = await s.post('/api/library/topic/clear', { topic: 'T', confirmName: 'T' })
    t.diagnostic(`clear=${clear.status} body=${clear.txt.slice(0, 220)}`)
    // ← 基线在此红：200 cleared:2
    assert.equal(clear.status, 409, `生成中译文时必须拦住清空：${clear.status} ${clear.txt}`)
    assert.equal(clear.body?.code, 'translation-busy', `机器码必须 translation-busy：${clear.txt}`)
    assert.ok((clear.body?.papers ?? []).includes('T/Sub/P2'), `必须点名子专题论文：${clear.txt}`)
    assert.deepEqual(snap(data, ['.pdf2zh-tmp']), before, '被拒的清空必须零改动（含不写 .trash；翻译 scratch 不计）')
    assert.equal(existsSync(join(data, '.trash')), false, '被拒的清空不得写入回收站')
  } finally {
    await fake?.stop()
    s.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// E1. 坏 JSONL：CLI 必须非 0 退出并指出坏行；完好日志不回归
// ═════════════════════════════════════════════════════════════════════════════

test('R3-E1 坏日志（首行/中间行/尾行截断）⇒ CLI --rollback 非 0 退出且指出行号；好日志回归', async (t) => {
  const { root, data } = newLib('dpr-r3-e1-')
  try {
    putFlat(data, 'T', 'A', '.pdf', 'A-pdf')
    putFlat(data, 'T', 'A', '.txt', 'A-txt')
    putFlat(data, 'T', 'B', '.pdf', 'B-pdf')
    putFlat(data, 'T', 'B', '.txt', 'B-txt')
    const mig = M.runMigration(data, { home: HOME })
    assert.equal(mig.partial, false, `前提：先做一次完整迁移以产出真实日志：${JSON.stringify(mig).slice(0, 200)}`)
    const goodLines = readFileSync(mig.logPath, 'utf8').split('\n').filter((l) => l.trim())
    assert.ok(goodLines.length >= 4, `前提：日志至少 4 条：${goodLines.length}`)

    const logDir = mkdtempSync(join(tmpdir(), 'dpr-r3-e1-logs-'))
    const mk = (name, lines) => { const p = join(logDir, name); writeFileSync(p, lines.join('\n') + '\n'); return p }
    const cases = [
      { name: 'first.jsonl', lines: ['{"this is": "not a valid entry"', ...goodLines], bad: 1, why: '首行坏' },
      { name: 'middle.jsonl', lines: [goodLines[0], '{"from":"T/B.txt","to":', ...goodLines.slice(1)], bad: 2, why: '中间行截断' },
      { name: 'tail.jsonl', lines: [...goodLines, '{"from":"T/C.pdf","to":'], bad: goodLines.length + 1, why: '尾行截断' },
    ]
    const migratedSnap = snap(data)
    for (const c of cases) {
      const logPath = mk(c.name, c.lines)
      const r = runCli(['--data-dir', data, '--rollback', logPath])
      t.diagnostic(`${c.why}: exit=${r.code} stderr=${r.stderr.trim().slice(0, 140)}`)
      // ← 基线在此红：exit 0、stdout「已回滚 0 个文件」
      assert.notEqual(r.code, 0, `${c.why}：坏日志回滚必须非 0 退出（基线假成功 exit 0）：stdout=${r.stdout}`)
      assert.match(r.stderr, new RegExp(`第 ${c.bad} 行`), `${c.why}：错误必须指出坏行行号（第 ${c.bad} 行）：${r.stderr}`)
      assert.match(r.stderr, /migrate-log-corrupt/, `${c.why}：必须带 migrate-log-corrupt 机器码：${r.stderr}`)
      assert.deepEqual(snap(data), migratedSnap, `${c.why}：坏日志失败路径不得改动文献库`)
    }

    // 完好日志：不回归（exit 0、真的搬回平铺源）
    const okLog = mk('good.jsonl', goodLines)
    const ok = runCli(['--data-dir', data, '--rollback', okLog])
    t.diagnostic(`good: exit=${ok.code} stdout=${ok.stdout.trim()}`)
    assert.equal(ok.code, 0, `完好日志回滚必须 exit 0：${ok.stderr}`)
    assert.match(ok.stdout, new RegExp(`已回滚 ${goodLines.length} 个文件`), `必须真的回滚全部条目：${ok.stdout}`)
    assert.equal(existsSync(join(data, 'T', 'A.pdf')), true, '平铺源必须被搬回')
    assert.equal(existsSync(join(data, 'T', 'B.txt')), true, '平铺源必须被搬回')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R3-E1b 路由 /migrate-rollback 对坏行日志 409（不再 200「恢复 0 个文件」）', async (t) => {
  const { root, data } = newLib('dpr-r3-e1b-')
  const s = await boot(data)
  try {
    putFlat(data, 'T', 'A', '.pdf', 'A-pdf')
    putFlat(data, 'T', 'A', '.txt', 'A-txt')
    M.runMigration(data, { home: HOME })
    const logDir = M.migrationLogDir(HOME)
    mkdirSync(logDir, { recursive: true })
    const badPath = join(logDir, 'review-bad.jsonl')
    writeFileSync(badPath, '{"from":"T/A.pdf","to":"T/A/A.pdf"}\n{oops\n')
    const before = snap(data)
    const r = await s.post('/api/library/migrate-rollback', { confirm: 'rollback-library', logPath: badPath })
    t.diagnostic(`rollback=${r.status} body=${r.txt.slice(0, 200)}`)
    // ← 基线在此红：200 {"ok":true,"restored":0}
    assert.equal(r.status, 409, `坏行日志必须 409，不得 200 假成功：${r.status} ${r.txt}`)
    assert.equal(r.body?.code, 'migrate-log-corrupt', `机器码必须 migrate-log-corrupt：${r.txt}`)
    assert.match(r.txt, /第 2 行/, `错误必须指出坏行行号：${r.txt}`)
    assert.deepEqual(snap(data), before, '失败路径不得改动文献库')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// E2. 阶段 1 中断现场（本评审手工构造）⇒ 复跑真的迁完；别人的非空异目录一字不动
// ═════════════════════════════════════════════════════════════════════════════

test('R3-E2 手工构造「mkdir 后 / 复制中被杀」现场：复跑迁完、标记清除、异目录零改动、复跑幂等', async (t) => {
  const { root, data } = newLib('dpr-r3-e2-')
  try {
    // 论文 A：目录已建、还没写标记就被杀（空目录）
    putFlat(data, 'T', 'HalfA', '.pdf', 'A-pdf')
    putFlat(data, 'T', 'HalfA', '.txt', 'A-txt')
    mkdirSync(join(data, 'T', 'HalfA'), { recursive: true })
    // 论文 B：目录 + 标记 + 复制了一半的产物
    putFlat(data, 'T', 'HalfB', '.pdf', 'B-pdf')
    putFlat(data, 'T', 'HalfB', '.txt', 'B-full-txt')
    mkdirSync(join(data, 'T', 'HalfB'), { recursive: true })
    writeFileSync(join(data, 'T', 'HalfB', MIGRATING_MARKER), '')
    writeFileSync(join(data, 'T', 'HalfB', 'HalfB.txt'), 'B-PARTIAL-HALF')
    // 别人的非空异目录：同名平铺论文 + 陌生文件
    putFlat(data, 'T', 'Other', '.pdf', 'Other-pdf')
    mkdirSync(join(data, 'T', 'Other'), { recursive: true })
    writeFileSync(join(data, 'T', 'Other', 'note.md'), 'KEEP-ME')

    const plan = M.planMigration(data, HOME)
    const run = M.runMigration(data, { home: HOME })
    t.diagnostic(`copied=${run.copied} removed=${run.removed} partial=${run.partial} half=${JSON.stringify(plan.halfProducts)}`)

    // 行为优先：两篇半成品必须真的迁完、复跑不留残渣
    // ← 基线在此红：copied=0，两篇仍 conflict
    assert.ok(run.copied >= 4, `半成品目录必须被识别并续跑（复制 ≥4 个文件）：实际 ${run.copied}`)
    assert.equal(run.removed, 4, `平铺源必须删除 4 个：实际 ${run.removed}`)
    assert.equal(readFileSync(join(data, 'T', 'HalfA', 'HalfA.pdf'), 'utf8'), 'A-pdf')
    assert.equal(readFileSync(join(data, 'T', 'HalfA', 'HalfA.txt'), 'utf8'), 'A-txt')
    assert.equal(readFileSync(join(data, 'T', 'HalfB', 'HalfB.pdf'), 'utf8'), 'B-pdf')
    assert.equal(readFileSync(join(data, 'T', 'HalfB', 'HalfB.txt'), 'utf8'), 'B-full-txt', '半截产物必须被源文件替换')
    assert.equal(existsSync(join(data, 'T', 'HalfB', MIGRATING_MARKER)), false, '完成后必须清掉半成品标记')
    assert.equal(existsSync(join(data, 'T', 'HalfA.pdf')), false, '平铺源必须已删')
    assert.equal(existsSync(join(data, 'T', 'HalfB.txt')), false, '平铺源必须已删')

    // 台账字段：两篇半成品必须在 plan.halfProducts 里（修复新增字段；基线无此概念）
    assert.ok(Array.isArray(plan.halfProducts), 'plan 必须报告 halfProducts（半成品识别是显式台账）')
    assert.deepEqual([...plan.halfProducts].sort(), ['T/HalfA', 'T/HalfB'], `halfProducts 必须点名两篇：${JSON.stringify(plan.halfProducts)}`)

    // 别人的非空异目录：一个字节都不许动、仍按冲突报告
    assert.equal(readFileSync(join(data, 'T', 'Other', 'note.md'), 'utf8'), 'KEEP-ME', '别人的非空异目录绝不许动')
    assert.equal(existsSync(join(data, 'T', 'Other.pdf')), true, '冲突篇的平铺源必须原地不动')
    assert.ok(run.skippedPapers.some((p) => String(p.paper).includes('Other')), `冲突篇必须进入 skippedPapers：${JSON.stringify(run.skippedPapers)}`)

    // 复跑幂等：不再复制/删除，也不再有半成品。
    // 注意：别人的异目录仍是 conflict ⇒ run2.partial 仍为 true 是**正确**的（如实报告未处理子树），
    // 这里只断言「不再搬任何文件」与「不再识别出半成品」。
    const run2 = M.runMigration(data, { home: HOME })
    assert.equal(run2.copied, 0, `复跑不得再复制：${run2.copied}`)
    assert.equal(run2.removed, 0, `复跑不得再删除：${run2.removed}`)
    const plan2 = M.planMigration(data, HOME)
    assert.deepEqual(plan2.halfProducts, [], '复跑不得再识别出半成品')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R3-E2b 真实中断（failAfterCopies=1）→ 现场可见标记 → 复跑收敛', async (t) => {
  const { root, data } = newLib('dpr-r3-e2b-')
  try {
    // 只放一篇：failAfterCopies=1 后「哪一篇被建了目录」是确定的（不受 readdir 顺序影响）
    putFlat(data, 'T', 'KillMe', '.pdf', 'K-pdf')
    putFlat(data, 'T', 'KillMe', '.txt', 'K-txt')
    let aborted = null
    try {
      M.runMigration(data, { home: HOME, failAfterCopies: 1 })
    } catch (e) { aborted = e }
    t.diagnostic(`aborted=${aborted?.constructor?.name ?? 'none'}`)
    // ← 基线在此红：没有「半成品标记」概念（目录里只有 copy 出来的文件）
    assert.ok(aborted, 'failAfterCopies=1 必须中断第一次运行')
    const killDir = join(data, 'T', 'KillMe')
    assert.equal(existsSync(killDir), true, '中断后论文目录应已存在')
    assert.equal(existsSync(join(killDir, MIGRATING_MARKER)), true,
      '阶段 1 中断现场必须留下半成品标记（复跑据此识别，而不是靠猜）')

    const resume = M.runMigration(data, { home: HOME })
    t.diagnostic(`resume copied=${resume.copied} removed=${resume.removed} partial=${resume.partial}`)
    assert.ok(resume.copied >= 1, `复跑必须继续迁完剩余文件（≥1）：实际 ${resume.copied}`)
    assert.equal(resume.partial, false, `复跑必须收敛（partial=false）：${resume.partial}`)
    assert.equal(readFileSync(join(data, 'T', 'KillMe', 'KillMe.pdf'), 'utf8'), 'K-pdf')
    assert.equal(readFileSync(join(data, 'T', 'KillMe', 'KillMe.txt'), 'utf8'), 'K-txt')
    assert.equal(existsSync(join(data, 'T', 'KillMe', MIGRATING_MARKER)), false, '收敛后标记必须清掉')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// E3a. /migrate 期间并发读请求的响应性（可测的测量方法与阈值写在此处）
// ═════════════════════════════════════════════════════════════════════════════

test('R3-E3a /migrate 期间并发 GET 必须能在迁移结束前返回（测法与阈值见注释）', async (t) => {
  const { root, data } = newLib('dpr-r3-e3a-')
  const s = await boot(data)
  try {
    // 300 篇平铺论文 × 3 个产物 = 900 个文件（copy + 双 sha256 + 日志 fsync 足以产生可观测耗时）
    for (let i = 0; i < 300; i++) {
      const name = `M${String(i).padStart(3, '0')}`
      const payload = `${name}:` + 'x'.repeat(1_200)
      putFlat(data, 'T', name, '.pdf', payload)
      putFlat(data, 'T', name, '.txt', payload + '-txt')
      putFlat(data, 'T', name, '.study.json', '{"plan":[]}')
    }
    // 测法：t0 发 /migrate；15ms 后发 GET /api/library（记 gStart）；迁移响应记 migEnd。
    //   · 修复后：GET 在迁移**仍在进行**时完成 ⇒ gEnd < migEnd - 10 且 migEnd - gStart > 30
    //   · 基线（同步复制）：事件循环被占满，timer/GET 只能等迁移跑完 ⇒ 上面两条不成立
    const mig = s.post('/api/library/migrate', { confirm: 'migrate-library' })
    await sleep(15)
    const g = await s.get('/api/library')
    const migR = await mig
    const migEnd = performance.now()
    const gEnd = g.end
    t.diagnostic(`GET=${g.status} gStart=${Math.round(g.start)} gEnd=${Math.round(gEnd)} migEnd=${Math.round(migEnd)} remaining@GETdone=${Math.round(migEnd - gEnd)} migratedFiles=${migR.body?.copied}`)
    assert.equal(migR.status, 200, `迁移必须成功：${migR.status} ${migR.txt.slice(0, 160)}`)
    assert.ok((migR.body?.copied ?? 0) >= 900, `前提：迁移确实复制了 900 个文件：${migR.body?.copied}`)
    assert.equal(g.status, 200, `迁移期间 GET 必须 200：${g.status}`)
    // ← 基线在此红：GET 只能排在迁移之后
    assert.ok(migEnd - g.start > 30, `GET 发出时迁移必须仍在进行（migEnd-gStart>30ms）：${Math.round(migEnd - g.start)}ms`)
    assert.ok(gEnd < migEnd - 10, `GET 必须在迁移结束前返回（gEnd<migEnd-10ms）：gEnd=${Math.round(gEnd)} migEnd=${Math.round(migEnd)}`)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// G3. paper 范围的 scopeBusy 提示真实触发（rename 在途）
// ═════════════════════════════════════════════════════════════════════════════

test('R3-G3 paper 范围提问在 rename 在途时必须出现「正在被修改」提示（基线死代码）', async (t) => {
  const { root, data } = newLib('dpr-r3-g3-')
  // 第一次 sessionController.list 卡 400ms ⇒ rename-paper 停在 withInflight 里
  const s = await boot(data, { listDelayFirstMs: 400 })
  try {
    putPaper(data, 'T', 'P', 'P-body')
    const rename = s.post('/api/library/rename-paper', { topic: 'T', name: 'P', to: 'Q' })
    await sleep(60) // 确保 rename 已进入 handler 并持有 inflight
    const ask = await s.post('/api/ask', { topic: 'T', name: 'P', question: 'q', scope: { kind: 'paper' } })
    const prompt = s.state.promptText ?? ''
    t.diagnostic(`ask=${ask.status} promptHasHint=${prompt.includes('正在被修改')}`)
    assert.equal(ask.status, 200, `ask 本身必须成功（读路径不阻塞）：${ask.status} ${ask.txt}`)
    // ← 基线在此红：prompt 全文无「正在被修改」（key 是 \0 分隔，scopePath 是 / 分隔，includes 永不命中）
    assert.equal(prompt.includes('正在被修改'), true,
      `paper 范围的 busy 提示必须真实触发（基线是死代码）：\n${prompt.slice(0, 400)}`)
    assert.match(prompt, /本次只给了 \d+ 篇/, '提示文案必须含「本次只给了 N 篇」')
    const r = await rename
    assert.equal(r.status, 200, `rename 必须完成：${r.status} ${r.txt}`)
    assert.equal(existsSync(join(data, 'T', 'Q', 'Q.pdf')), true, 'rename 必须真的完成')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// ═════════════════════════════════════════════════════════════════════════════
// G4. /migrate-rollback 的 logPath 必须在日志目录内（/a/bc 不得冒充 /a/b）
// ═════════════════════════════════════════════════════════════════════════════

test('R3-G4 logPath 前缀判定：<logDir>-evil 必须 400；目录内日志正常回滚', async (t) => {
  const { root, data } = newLib('dpr-r3-g4-')
  const s = await boot(data)
  try {
    // 构造可回滚现场：论文目录里有产物、平铺源不存在
    putPaper(data, 'T', 'P1', 'p1-body')
    const entry = JSON.stringify({ from: 'T/P1.pdf', to: 'T/P1/P1.pdf', bytes: 7, sha256: '', at: '2026-10-26T00:00:00.000Z' })
    const logDir = M.migrationLogDir(HOME)
    mkdirSync(logDir, { recursive: true })
    const evilDir = `${logDir}-evil`
    mkdirSync(evilDir, { recursive: true })
    const evilLog = join(evilDir, 'x.jsonl')
    writeFileSync(evilLog, entry + '\n')
    const goodLog = join(logDir, 'good.jsonl')
    writeFileSync(goodLog, entry + '\n')

    const before = snap(data)
    const evil = await s.post('/api/library/migrate-rollback', { confirm: 'rollback-library', logPath: evilLog })
    t.diagnostic(`evil=${evil.status} body=${evil.txt.slice(0, 160)}`)
    // ← 基线在此红：200 {"ok":true,"restored":1}（真的执行了兄弟目录的日志）
    assert.equal(evil.status, 400, `日志目录外的文件必须 400：${evil.status} ${evil.txt}`)
    assert.equal(evil.body?.code, 'escape-rejected', `机器码必须 escape-rejected：${evil.txt}`)
    assert.deepEqual(snap(data), before, '被拒的回滚不得改动文献库')

    // 正向对照：目录内日志仍正常
    const good = await s.post('/api/library/migrate-rollback', { confirm: 'rollback-library', logPath: goodLog })
    t.diagnostic(`good=${good.status} body=${good.txt.slice(0, 160)}`)
    assert.equal(good.status, 200, `目录内日志必须正常回滚：${good.status} ${good.txt}`)
    assert.equal(good.body?.restored, 1, `必须真的回滚 1 个文件：${good.txt}`)
    assert.equal(existsSync(join(data, 'T', 'P1.pdf')), true, '平铺源必须被搬回')
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

// 基线模式自检（让「基线 N 红」的计数可解释）
if (BASELINE_MODE) {
  test('R3-0 基线模式自检', (t) => {
    t.diagnostic(`R3_REPO 模式：目标树 = ${TARGET}`)
    assert.ok(true)
  })
}
