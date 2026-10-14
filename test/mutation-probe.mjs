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
    from: '        if (isPaperDir(join(dir, e.name))) {\n          paperDirs.push(relPath)',
    to: '        if (false) {\n          paperDirs.push(relPath)',
    why: '唯一的结构不变量（论文目录不递归）失守 ⇒ 复跑产生 X/X/X.pdf 套娃' },
  { id: 'C-already-done-not-detected', file: 'src/migrate.ts', needsBuild: true, pattern: 'C5 ',
    from: '          if (sameEntry) {', to: '          if (false) {',
    why: '已完成判定失效（同内容副本不再认作 alreadyDone）⇒ 中断后复跑无法收敛、只剩冲突' },
  { id: 'C-deletes-source-while-copying', file: 'src/migrate.ts', needsBuild: true, pattern: 'C5 ',
    from: '        copyImpl(fromAbs, toAbs)', to: '        copyImpl(fromAbs, toAbs); unlinkSync(fromAbs)',
    why: '先复制后删的次序被破坏（中途被杀 = 源已丢）' },
  { id: 'C-rollback-noop', file: 'src/migrate.ts', needsBuild: true, pattern: 'C4 ',
    from: '    renameSync(toAbs, fromAbs)', to: '    void toAbs',
    why: '回滚不搬回原位（日志形同虚设）',
    preload: 'unlinkSync' },
  { id: 'R1-quarantine-aborts-library', file: 'src/migrate.ts', needsBuild: true, pattern: 'C12 ',
    from: '  const plan = planMigration(root, home)\n  // 队长裁定 1',
    to: '  const plan = planMigration(root, home)\n  if (plan.quarantine.length > 0) throw new MigrationError(\'migrate-conflict\', \'整库中止（缺陷态）\')\n  // 队长裁定 1',
    why: '裁定 1（整库中止不可接受）：一篇坏名字直接让整个库迁不了' },
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
  // ── H 队长裁定与 t4 评审的 blocker/medium（F-A/F-B/F-C + 裁定 1/2）──
  { id: 'HA-symlink-bypasses-conflict', file: 'src/migrate.ts', needsBuild: true, pattern: 'C10 ',
    from: '        if (targetIsFile || targetIsLink) {',
    to: '        if (targetIsFile && !st.isSymbolicLink()) {',
    why: 'F-A：符号链接源绕过冲突判定 ⇒ 阶段 1 把论文夹里的常规文件覆盖成链接（内容不可恢复）' },
  { id: 'HB-subtopic-dir-conflict', file: 'src/migrate.ts', needsBuild: true, pattern: 'C11 ',
    from: "      if (targetKind === 'dir-other') {", to: '      if (false) {',
    why: 'F-B：把同名平铺论文塞进已有子专题目录 ⇒ 该目录同时是专题与论文（子专题内论文从列表/树消失、clearTopic 永久 409）' },
  { id: 'HC-pdfPath-new-layout-only', file: 'src/host.ts', needsBuild: true, pattern: 'C14 ',
    from: '      const papers = listPapers(dataDir).map((p) => ({ ...p, pdfPath: paperPdfPath(dataDir, p.topic, p.name) }))',
    to: "      const papers = listPapers(dataDir).map((p) => ({ ...p, pdfPath: join(dataDir, p.topic, p.name, p.name + '.pdf') }))",
    why: 'F-C：pdfPath 写死新布局 ⇒ 未迁移旧库的平铺论文 pdfPath 指向不存在的路径（影响用户当前在用的库）' },
  { id: 'R1-silent-skip', file: 'src/migrate.ts', needsBuild: true, pattern: 'C12 ',
    from: '  const skippedPapers = [\n    ...plan.quarantine.map((q) => ({ paper: q.paper, code: \'migrate-quarantine\', reason: q.reason })),',
    to: '  const skippedPapers = [\n    ...([] as Array<{ paper: string; reason: string }>).map((q) => ({ paper: q.paper, code: \'migrate-quarantine\', reason: q.reason })),',
    why: '裁定 1（静默跳过不可接受）：跳过项不记账 ⇒ 会写「全部完成」标记、用户以为迁完了' },
  { id: 'R1-false-success-marker', file: 'src/migrate.ts', needsBuild: true, pattern: 'C12 ',
    from: '    if (partial) {', to: '    if (false) {',
    why: '裁定 1（不许假成功）：有跳过项也写 .done 完成标记' },
  { id: 'R2-hidden-paper-skipped', file: 'src/migrate.ts', needsBuild: true, pattern: 'C13 ',
    from: '      if (isPaperPDF(e.name)) byStem.set(e.name.slice(0, -4), [])',
    to: '      if (isPaperPDF(e.name) && !e.name.startsWith(\'.\')) byStem.set(e.name.slice(0, -4), [])',
    why: '裁定 2：前导点的隐藏论文被当成「隐藏条目」跳过 ⇒ 用户盘上已有数据被丢下（对插件永久不可见）' },
  // ── G t3 独立验证的必修项（F1/F1b/F2/F3/F4/F5）──
  { id: 'F1-stem-only-from-flat-pdf', file: 'src/migrate.ts', needsBuild: true, pattern: 'C7 ',
    from: '          byStem.set(e.name, [])\n          continue',
    to: '          void e.name\n          continue',
    why: 'F1/F1b：只从「仍存在的平铺 <名>.pdf」推导 stem ⇒ 阶段 2 中断后同篇残留被判 orphan（永远留在旧布局）' },
  { id: 'F1b-no-unlinked-report', file: 'src/migrate.ts', needsBuild: true, pattern: 'C7b ',
    from: '      unlinked.push(e.from)', to: '      void e.from',
    why: 'F1b：阶段 2 中断时不报「哪些源已删」（可复跑判断失去依据）' },
  { id: 'F2-silent-overwrite', file: 'src/migrate.ts', needsBuild: true, pattern: 'C8 ',
    from: '            : (!targetIsLink && sizeOf(toAbs) === st.size && sha256Of(toAbs) === sha256Of(fromAbs))',
    to: '            : (!targetIsLink && sizeOf(toAbs) === st.size)',
    why: 'F2：只比 size 不比内容 ⇒ 同名不同内容被静默覆盖（与裁定的「文件夹赢」相反）' },
  { id: 'F3-flat-trash-bundle', file: 'src/library-manage.ts', needsBuild: true, pattern: 'C9 ',
    from: '  const sub = { abs: join(bundle.abs, plan.name), rel: join(bundle.rel, plan.name) }',
    to: '  const sub = { abs: bundle.abs, rel: bundle.rel }',
    why: 'F3：单篇删除的回收站不保留论文名层级（与 clearTopic 口径不一致）' },
  { id: 'F4-single-segment-to', file: 'src/host.ts', needsBuild: true, pattern: 'D7 ',
    from: '      const toPath = badTopicPath(res, rawTo, false)',
    to: '      const toPath = badEntry(res, rawTo) ? null : String(rawTo ?? "")',
    why: 'F4：`to` 退回单段校验 ⇒ 「移动到另一父」必然 400（UI 不可用）' },
  { id: 'F4-encoded-not-rejected', file: 'src/library.ts', needsBuild: true, pattern: 'D7 ',
    from: '  if (dec === raw) return null\n  if (dec.includes(\'\\u0000\'))',
    to: '  if (true) return null\n  if (dec.includes(\'\\u0000\'))',
    why: 'F4 负向：编码变形（%2E%2E%2F）不再被拒（全靠词法层则放过「解码后才是分隔符」的输入）' },
  { id: 'F5-negative-wording', file: 'lib/client.js', needsBuild: false, pattern: 'A10 ',
    from: '论文里的图片/照片会明显褪色偏色',
    to: '论文里的图片/照片会变负片',
    why: 'F5：文案退回不准确的「变负片」（实测是褪色偏色，纯红 [255,0,0] → [229,134,134]）' },
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
