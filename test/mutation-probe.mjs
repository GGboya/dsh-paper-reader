// test/mutation-probe.mjs —— 变异验证：把实现**改回缺陷态**，对应用例必须**变红**；再还原，必须回绿。
//
// 为什么要有它（t6 验收）：用例是否真的在守行为，不能靠读代码猜。这里逐条注入「方案里写明的缺陷」，
// 用 `node --test --test-name-pattern` 只跑**该缺陷对应的那条（那组）用例**，要求：
//   · 注入后 exit != 0（红）——否则该用例是空转；
//   · 还原后 exit == 0（绿）——证明注入与还原都干净（`git diff --quiet -- <file>` 复核）。
//
// 用法：node test/mutation-probe.mjs [--only <id 子串>] [--list]
// 依赖：跑前先 `npm run build`（脚本会在每次注入 src/ 后自动重建 dist）。
//
// 这是**证据工具**，不是 `npm test` 的一部分（名字不匹配 `test/*.test.mjs`，测试运行器不会自动捡它）。

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const FEAT = 'test/darkmode-subtopic-features.test.mjs'

/**
 * 每条 = 一个「方案里写明的缺陷」，注入后必须让 name 匹配的用例变红。
 * `needsBuild`：改了 src/ 就要重建 dist（测试 import 的是 dist）；改 reader/ 的静态资源不用。
 */
const MUTATIONS = [
  // ── A 深色 ──
  { id: 'A-default-not-follow', file: 'src/theme-config.ts', needsBuild: true, pattern: 'A1 ',
    from: "  pdfTheme: 'follow',", to: "  pdfTheme: 'light',", why: '默认不是 follow（用户要的「dsh 深色时 PDF 也深」失效）' },
  { id: 'A-mode-validation-off', file: 'src/theme-config.ts', needsBuild: true, pattern: 'A1 ',
    from: "  if (rec['pdfTheme'] !== undefined && !THEME_MODES.includes(rec['pdfTheme'] as PdfTheme)) {",
    to: "  if (false) {", why: '非法模式不再 400，静默回落' },
  { id: 'A-config-mode-0644', file: 'src/theme-config.ts', needsBuild: true, pattern: 'A2 ',
    from: '  await chmod(file, 0o600)', to: '  await chmod(file, 0o644)', why: '配置文件权限放宽' },
  { id: 'A-follow-ignores-host', file: 'reader/index.html', needsBuild: false, pattern: 'A5 ',
    from: '  if (host) return host;', to: '  if (host && false) return host;', why: 'follow 不再看宿主主题（深色不生效）' },
  { id: 'A-fallback-to-dark', file: 'reader/index.html', needsBuild: false, pattern: 'A5 ',
    from: "  if (__dprDarkMq && __dprDarkMq.matches) return 'dark';\n  return 'light';",
    to: "  if (__dprDarkMq && __dprDarkMq.matches) return 'dark';\n  return 'dark';",
    why: '降级方向朝深色（该黑没黑 vs 误黑：方案要求绝不误黑）' },
  { id: 'A-preferscolor-always-light', file: 'reader/index.html', needsBuild: false, pattern: 'A5 ',
    from: "  if (__dprDarkMq && __dprDarkMq.matches) return 'dark';", to: "  if (__dprDarkMq && false) return 'dark';",
    why: '丢掉 prefers-color-scheme 那一级（OS 深色时 PDF 不变）' },
  { id: 'A-filter-on-page', file: 'reader/index.html', needsBuild: false, pattern: 'A8 ',
    from: 'html[data-dpr-pdf="dark"] #pdf-pages .page > canvas,', to: 'html[data-dpr-pdf="dark"] #pdf-pages .page,',
    why: '滤镜挂到 .page（会把热区描边与选区一起反转 —— 方案里的红线）' },
  { id: 'A-second-storage-listener', file: 'reader/index.html', needsBuild: false, pattern: 'A9 ',
    from: "window.addEventListener('message', (e) => {", to: "window.addEventListener('storage', () => {});\nwindow.addEventListener('message', (e) => {",
    why: '再挂一份 storage 监听（跨文档回声/双写）' },
  // ── B 布局 ──
  { id: 'B-topic-attribution', file: 'src/library.ts', needsBuild: true, pattern: 'F2 ',
    from: '      if (isPaperDir(child)) {\n        out.push({ topic: rel, name: e.name })',
    to: '      if (isPaperDir(child)) {\n        out.push({ topic: `${rel}/${e.name}`, name: e.name })',
    why: 't2 自查修掉的缺陷：topic 报成 T/P（?topic=&name= 全失配）' },
  { id: 'B-folder-does-not-win', file: 'src/library.ts', needsBuild: true, pattern: 'B4 ',
    from: '        if (existsSync(join(dir, stem))) continue   // 论文文件夹赢（确定性优先级）',
    to: '        if (false) continue', why: '平铺与文件夹并存时不再「文件夹赢」（同一篇报两次 = 二义）' },
  { id: 'B-legacy-read-removed', file: 'src/library-manage.ts', needsBuild: true, pattern: 'B3 ',
    from: '  if (pst && pst.isFile()) return topicDir', to: '  if (pst && pst.isFile() && false) return topicDir',
    why: '旧布局不再可读（队长裁定的偏离被回退）' },
  { id: 'B-hidden-paper-dir-invisible', file: 'src/library.ts', needsBuild: true, pattern: 'F3 ',
    from: '      if (isPaperDir(child)) {\n        out.push({ topic: rel, name: e.name })',
    to: '      if (isPaperDir(child) && !e.name.startsWith(".")) {\n        out.push({ topic: rel, name: e.name })',
    why: 't2 自查修掉的缺陷：`.hidden/` 不可见 ⇒ 能上传不能删' },
  // ── C 迁移 ──
  { id: 'C-recurses-into-paper-dir', file: 'src/migrate.ts', needsBuild: true, pattern: 'C3 ',
    from: '    if (rel && isPaperDir(dir)) {', to: '    if (false) {',
    why: '论文目录不递归的不变量被去掉 ⇒ 复跑产生 X/X/X.pdf 套娃' },
  { id: 'C-already-done-not-detected', file: 'src/migrate.ts', needsBuild: true, pattern: 'C5 ',
    from: '        if (!st.isSymbolicLink() && existsSync(join(root, toRel)) && sizeOf(join(root, toRel)) === st.size) {',
    to: '        if (false) {', why: '已完成判定失效 ⇒ 中断后复跑把副本再复制一遍' },
  { id: 'C-deletes-source-while-copying', file: 'src/migrate.ts', needsBuild: true, pattern: 'C5 ',
    from: '        copyImpl(fromAbs, toAbs)', to: '        copyImpl(fromAbs, toAbs); unlinkSync(fromAbs)',
    why: '先复制后删的次序被破坏（中途被杀 = 源已丢）' },
  { id: 'C-rollback-noop', file: 'src/migrate.ts', needsBuild: true, pattern: 'C4 ',
    from: '    renameSync(toAbs, fromAbs)', to: '    void toAbs',
    why: '回滚不搬回原位（日志形同虚设）',
    preload: 'unlinkSync' },
  { id: 'C-conflict-still-runs', file: 'src/migrate.ts', needsBuild: true, pattern: 'C6 ',
    from: '  if (plan.conflicts.length > 0 || plan.quarantine.length > 0) {', to: '  if (false) {',
    why: '冲突/需人工不再「先报告不执行」⇒ 半途动数据' },
  // ── D 子专题 ──
  { id: 'D-trash-topic-allowed', file: 'src/library-manage.ts', needsBuild: true, pattern: 'F1 ',
    from: "    if (boundaryOnly) validateEntryBoundary(seg, 'topic')\n    else validateName(seg, 'topic')",
    to: "    if (boundaryOnly) { if (seg === '.trash') continue; validateEntryBoundary(seg, 'topic') }\n    else validateName(seg, 'topic')",
    why: 't2 自查修掉的缺陷：逐段校验放宽 ⇒ `.trash` 变成可改名/可删的「专题」' },
  { id: 'D-recursive-rmdir', file: 'src/library-manage.ts', needsBuild: true, pattern: 'D6 ',
    from: '      try {\n        rmdirSync(topicDir) // 非递归：非空即失败，绝不 rm -rf',
    to: '      try {\n        rmSync(topicDir, { recursive: true, force: true }) // 非递归：非空即失败，绝不 rm -rf',
    note: '(锚点是 clearTopic 里那一处——deleteTopic 的 rmdir 被前置 entries 检查挡住 ⇒ 打它测不出差别)',
    why: '非递归 rmdir 不变量被破坏（非空专题被递归删掉）' },
  { id: 'D-subtree-not-recursive', file: 'src/library-manage.ts', needsBuild: true, pattern: 'D4 ',
    from: '      subtopics.push(planClearUnit(dataDir, `${topicPath}/${e.name}`, rel ? `${rel}/${e.name}` : e.name))',
    to: '      void e.name', why: '清空计划不递归子树 ⇒ 子专题里的论文不在清单里（漏清）' },
  // 注：曾想用 `p.rel → p.name` 做「回收站不保留相对路径」的变异，但本夹具里每个单元的 p.rel 恒等于
  // p.name（论文目录名 = 论文名），两者行为完全一致 ⇒ 打不出差别。如实删掉，只留下面这条**结构级**变异：
  // 把「每个专题单元一个独立 bundle」改成「整棵子树共用一个 bundle」，同名产物才会真的撞车。
  { id: 'D-single-bundle-for-subtree', file: 'src/library-manage.ts', needsBuild: true, pattern: 'D4 ',
    from: '      const bundle = newTrashBundle(dataDir)\n      currentBundle = bundle',
    to: '      const bundle = doneBundles.length > 0 ? { abs: doneBundles[0]!.abs, rel: doneBundles[0]!.rel } : newTrashBundle(dataDir)\n      currentBundle = bundle',
    why: '整棵子树共用一个 bundle（跨层同名产物撞名覆盖 = 数据丢失）' },
  // ── E 范围 ──
  { id: 'E-paper-scope-no-default', file: 'src/scope.ts', needsBuild: true, pattern: 'E1 ',
    from: '    if (args.topic === undefined && args.name === undefined) return [current]', to: '    if (false) return [current]',
    why: '「本篇」范围不带 topic/name 时不再回落当前论文' },
  { id: 'E-topic-scope-ignores-scope', file: 'src/scope.ts', needsBuild: true, pattern: 'E2 ',
    from: '  const list = listPapers(dataDir, scope.topic)', to: '  const list = listPapers(dataDir)',
    why: '专题范围退化成全库 ⇒ 范围外内容泄露进提示词（正是「只给该范围」要挡的）' },
  { id: 'E-papers-not-listed', file: 'src/scope.ts', needsBuild: true, pattern: 'E3 ',
    from: "    papers.push({ topic: ref.topic, name: ref.name, path: label, pages, artifacts, study, coverage: 'no-body', source: null, chars: 0 })",
    to: '    void label', why: '范围内每一篇不再进 papers[]（统计/覆盖率只覆盖被省略的那几篇）' },
  { id: 'E-paper-cap-removed', file: 'src/scope.ts', needsBuild: true, pattern: 'E1 ',
    from: '        const limit = Math.max(0, Math.min(MAX_PER_DOC, budget() - 200))', to: '        const limit = body.text.length',
    why: '单篇正文上限被去掉（超长文档直接全塞）' },
  // ── F 其余自查缺陷 ──
  { id: 'F-hidden-dup-sweep', file: 'src/library-manage.ts', needsBuild: true, pattern: 'F4 ',
    from: "    ? managedEntries(paperDirAbs, (n) => n.startsWith('.') && !artifactNames.has(n))",
    to: "    ? managedEntries(paperDirAbs, (n) => n.startsWith('.'))",
    why: 't2 自查修掉的缺陷：隐藏条目与产物清单重复 ⇒ 点开头论文名删除时 500 回滚' },
]

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
if (args.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.id}\t${m.file}\t${m.pattern}\t${m.why}`)
  process.exit(0)
}

function sh(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { cwd: REPO, encoding: 'utf8', ...opts })
}
function build() {
  const r = sh('npm', ['run', 'build'])
  if (r.status !== 0) throw new Error(`build 失败：${r.stdout}${r.stderr}`)
}
function runTest(pattern) {
  const r = sh('node', ['--test', `--test-name-pattern=${pattern}`, FEAT])
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
function sameAs(abs, original) {
  return readFileSync(abs, 'utf8') === original
}

build()
const results = []
for (const m of MUTATIONS) {
  if (only && !m.id.includes(only)) continue
  const abs = join(REPO, m.file)
  const original = readFileSync(abs, 'utf8')
  const hits = original.split(m.from).length - 1
  if (hits !== 1) {
    results.push({ id: m.id, ok: false, note: `锚点命中 ${hits} 次（应恰好 1 次）——变异脚本与实现漂移，必须修脚本而不是跳过` })
    console.log(`FAIL ${m.id}: 锚点命中 ${hits} 次`)
    continue
  }
  const mutated = original.replace(m.from, m.to)
  const note = []
  let red = null
  let green = null
  let restoreDirty = null
  try {
    writeFileSync(abs, mutated)
    if (m.needsBuild) build()
    red = runTest(m.pattern)
    if (red.code === 0) note.push('注入后仍全绿（用例空转）')
  } catch (e) { note.push(String(e.message)) } finally {
    writeFileSync(abs, original)
    if (m.needsBuild) build()
    green = runTest(m.pattern)
    restoreDirty = !sameAs(abs, original)
  }
  const ok = red?.code !== 0 && green?.code === 0 && restoreDirty === false && note.length === 0
  results.push({ id: m.id, ok, red: red?.code, green: green?.code, dirty: restoreDirty, why: m.why, note: note.join(';') })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${m.id.padEnd(34)} 注入=${red?.code} 还原=${green?.code} diff=${restoreDirty ? 'Dirty' : 'clean'}${note.length ? `  ⚠ ${note.join('; ')}` : ''}  (${m.why})`)
}

const bad = results.filter((r) => !r.ok)
console.log(`\n# 变异验证：${results.length - bad.length}/${results.length} 通过${bad.length ? `；未通过：${bad.map((b) => b.id).join(', ')}` : ''}`)
process.exit(bad.length === 0 ? 0 : 1)
