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
    from: '  const plan = planMigration(root, home)\n  // E2：复跑前先清理',
    to: '  const plan = planMigration(root, home)\n  if (plan.quarantine.length > 0) throw new MigrationError(\'migrate-conflict\', \'整库中止（缺陷态）\')\n  // E2：复跑前先清理',
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
  // ── R1 REV1（t4 评审自己的对抗变异：把 IMP1 的 B/C/F 修复逐个改回缺陷态）──
  // 全部由 **test/pr8-review-r1.test.mjs**（评审自造探针）抓住；每条只回退一处修复。
  { id: 'R1-upload-target-collision-off', file: 'src/host.ts', needsBuild: true, testFile: 'test/pr8-review-r1.test.mjs', pattern: 'R1-B1 ',
    from: '        const targetPaperDir = join(dir, stem)',
    to: "        const targetPaperDir = join(dir, stem, '.r1-noop')",
    why: '上传不再检查 <topic>/<stem> 已存在 ⇒ 撞子专题/论文目录时 200 并吞数据（评审 B1/B2）' },
  { id: 'R1-upload-flat-collision-off', file: 'src/host.ts', needsBuild: true, testFile: 'test/pr8-review-r1.test.mjs', pattern: 'R1-B3 ',
    from: '        const flat = flatArtifactNames(dir, stem)',
    to: "        const flat = flatArtifactNames(dir, stem + '.r1-noop')",
    why: '上传不再检查同层旧平铺产物 ⇒ 文件夹优先规则永久遮蔽旧论文（评审 B3）' },
  { id: 'R1-create-topic-flat-off', file: 'src/host.ts', needsBuild: true, testFile: 'test/pr8-review-r1.test.mjs', pattern: 'R1-C2 ',
    from: '          const flat = flatArtifactNames(join(root, ...parentSegs), leaf)',
    to: "          const flat = flatArtifactNames(join(root, ...parentSegs), leaf + '.r1-noop')",
    why: 'create-topic 不再拒绝与旧平铺论文同名 ⇒ 旧论文不可见、delete-plan 404（评审 C2）' },
  { id: 'R1-rename-inner-clash-off', file: 'src/library-manage.ts', needsBuild: true, testFile: 'test/pr8-review-r1.test.mjs', pattern: 'R1-C4 ',
    from: '  if (innerClash.length > 0) {', to: '  if (innerClash.length > 0 && false) {',
    why: '新布局 renamePaper 丢掉目标目录内同名残留预检 ⇒ renameSync 静默覆盖（评审 C4）' },
  { id: 'R1-boundary-length-off', file: 'src/library-manage.ts', needsBuild: true, testFile: 'test/pr8-review-r1.test.mjs', pattern: 'R1-F1 ',
    from: '    if (!boundaryOnly && seg.trim().length > MAX_TOPIC_SEG) throw new ManageError',
    to: '    if (seg.trim().length > MAX_TOPIC_SEG) throw new ManageError',
    why: 'boundaryOnly 又施加创建侧每段长度上限 ⇒ 110 字 legacy 专题删不掉改不了名（评审 F1/F2）' },
  // ── R2 REV2（t5 评审自己的对抗变异：把 IMP2 的 A/G/H/码点修复逐个改回缺陷态）──
  // 全部由 **test/pr8-review-r2.test.mjs**（评审自造探针）抓住。
  { id: 'R2-tools-parse-first-slash', file: 'src/tools.ts', needsBuild: true, testFile: 'test/pr8-review-r2.test.mjs', pattern: 'R2-A1 ',
    from: "  const sep = decoded.lastIndexOf('/')", to: "  const sep = decoded.indexOf('/')",
    why: '会话 id 解论文退回「第一个 /」（A/B/P ⇒ A + B/P，深专题会话绑定全失效）' },
  { id: 'R2-client-parse-first-slash', file: 'lib/client.js', needsBuild: false, testFile: 'test/pr8-review-r2.test.mjs', pattern: 'R2-A2 ',
    from: "  const sep = decoded.lastIndexOf('/')", to: "  const sep = decoded.indexOf('/')",
    why: '客户端 parseDprSession 同退（子专题论文的 ⓘ 永远常亮）' },
  { id: 'R2-hits-not-counted-in-budget', file: 'src/scope.ts', needsBuild: true, testFile: 'test/pr8-review-r2.test.mjs', pattern: 'R2-G1 ',
    from: '        used += frag.length', to: '        used += 0',
    why: '命中片段不计入预算（基线口径：12 篇×3 命中 totalChars≈72k，超上限近一倍）' },
  { id: 'R2-cut-codepoint-off', file: 'src/scope.ts', needsBuild: true, testFile: 'test/pr8-review-r2.test.mjs', pattern: 'R2-GC',
    from: '  return text.slice(0, midPair ? n - 1 : n)', to: '  return text.slice(0, n)',
    why: '截断退回按码元切（U+1D400 跨切点留孤立代理项 ⇒ 整条会话 400）' },
  { id: 'R2-prefix-without-separator', file: 'lib/client.js', needsBuild: false, testFile: 'test/pr8-review-r2.test.mjs', pattern: 'R2-H1a ',
    from: "  if (path.startsWith(oldTopic + '/')) return newTopic + path.slice(oldTopic.length)",
    to: '  if (path.startsWith(oldTopic)) return newTopic + path.slice(oldTopic.length)',
    why: '改名前缀判定丢分隔符（A 改名误伤同级同前缀名 AB）' },
  // ── R3 REV3（t6 评审自己的对抗变异：把 IMP3 的 D/E/G 修复逐个改回缺陷态）──
  // 全部由 **test/pr8-review-r3.test.mjs**（评审自造探针）抓住。
  { id: 'R3-log-corrupt-swallowed', file: 'src/migrate.ts', needsBuild: true, testFile: 'test/pr8-review-r3.test.mjs', pattern: 'R3-E1',
    from: "      throw new MigrationError('migrate-log-corrupt', `迁移日志第 ${i + 1} 行不是合法 JSON（${(err as Error).message}）：${line.slice(0, 120)}`)",
    to: '      void err; return out',
    why: '坏 JSONL 又静默返回（基线口径：CLI 回滚「0 个文件」exit 0 / 路由 200 假成功）' },
  { id: 'R3-halfproduct-off', file: 'src/migrate.ts', needsBuild: true, testFile: 'test/pr8-review-r3.test.mjs', pattern: 'R3-E2 ',
    from: "function ownHalfProductKind(dir: string, stem: string): 'empty' | 'marked' | null {\n  let entries",
    to: "function ownHalfProductKind(dir: string, stem: string): 'empty' | 'marked' | null {\n  if (dir) return null\n  let entries",
    why: '不再识别阶段 1 半成品目录（空目录/带标记）⇒ 中断后该篇永远被 dir-other 跳过' },
  { id: 'R3-rollback-prefix-nosep', file: 'src/host.ts', needsBuild: true, testFile: 'test/pr8-review-r3.test.mjs', pattern: 'R3-G4 ',
    from: "      if (!relLog || relLog === '..' || relLog.startsWith('..' + sep) || isAbsolute(relLog)) {",
    to: '      if (!relLog || resolve(logPath).startsWith(resolve(logDir))) {',
    why: '回滚日志路径前缀缺分隔符（/a/bc 冒充 /a/b，兄弟目录的日志被执行）' },
  { id: 'R3-migrate-busy-gate-off', file: 'src/host.ts', needsBuild: true, testFile: 'test/pr8-review-r3.test.mjs', pattern: 'R3-D3',
    from: '          const busy = [...transcribing, ...translating]\n          if (busy.length > 0) {',
    to: '          const busy = [...transcribing, ...translating]\n          if (busy.length > 0 && false) {',
    why: '在飞转录/译文时 /migrate 不再拒绝（基线口径：200 直接搬文件）' },
  { id: 'R3-clear-subtree-off', file: 'src/host.ts', needsBuild: true, testFile: 'test/pr8-review-r3.test.mjs', pattern: 'R3-D1 ',
    from: '  const flattenClearPapers = (unit: TopicClearUnit): TopicClearPaperPlan[] => [\n    ...unit.papers,\n    ...unit.subtopics.flatMap((s) => flattenClearPapers(s)),\n  ]',
    to: '  const flattenClearPapers = (unit: TopicClearUnit): TopicClearPaperPlan[] => [...unit.papers]',
    why: '清空占用巡检退回只看根层（子专题论文带活跃会话/译文照删）' },
  // ── R5 REV5（t12 评审自己的对抗变异：把 IMP5 的 ino 守卫 / 大小写变体检查逐个改回缺陷态）──
  // 全部由 **test/pr8-review-r5.test.mjs**（评审自造探针）抓住。注意：R5-ADJ-RENAME-SELF 是评审的
  // finding（t11 把源自身的大小写改名也挡了），故意不被任何变异选中——变异只验证「修复行为本身」。
  { id: 'R5-ino-guard-off', file: 'src/library-manage.ts', needsBuild: true, testFile: 'test/pr8-review-r5.test.mjs', pattern: 'R5-INO ',
    from: '  if (src.ino === 0 || dst.ino === 0) return false',
    to: '  if (false) return false',
    why: 'ino===0 平台守卫失效（exFAT/FAT/SMB 上 ino=0 被误判同一文件 ⇒ C4 静默覆盖复活）' },
  { id: 'R5-same-entry-off', file: 'src/library-manage.ts', needsBuild: true, testFile: 'test/pr8-review-r5.test.mjs', pattern: 'R5-C4-HARDLINK',
    from: '  if (!sameEntry) return false',
    to: '  if (false) return false',
    why: '同 inode 但不同目录项（hardlink/别名）被放行 ⇒ 改名留下孤儿/覆盖别名' },
  { id: 'R5-create-topic-case-off', file: 'src/host.ts', needsBuild: true, testFile: 'test/pr8-review-r5.test.mjs', pattern: 'R5-CREATE-CASE',
    from: '        const caseClash = caseVariantCollisions(join(root, ...parentSegs), leaf)',
    to: "        const caseClash = caseVariantCollisions(join(root, ...parentSegs), leaf + '.r5-noop')",
    why: 'create-topic 不再拒仅大小写不同的同级对象（ext4 并存两个变体 / 不敏感盘 200 假成功）' },
  { id: 'R5-rename-topic-case-off', file: 'src/library-manage.ts', needsBuild: true, testFile: 'test/pr8-review-r5.test.mjs', pattern: 'R5-RENAME-REAL',
    // t14（R5-01 修复）把变体检查改成了 sameParent 条件 + 过滤自身的表达式，原锚点已不存在；
    // 这里把锚点改到该检查的**唯一出口**（caseClash 的 409 分支），语义不变：让 renameTopic 不再拒真实变体。
    from: '  if (caseClash.length > 0) {',
    to: '  if (caseClash.length > 0 && false) {',
    why: 'renameTopic 不再拒与**别的**同级对象仅大小写不同（静默制造近同名专题）' },
  // ── R4 REV4（t10 评审自己的对抗变异：把 t9 的 coverage/台账修复逐个改回缺陷态）──
  // 每条都必须由 **test/pr8-review-r4.test.mjs**（评审自造探针）抓住；最后一条额外核验
  // t9 自己的 `test/pr8-coverage-honesty.test.mjs` 不是空转（同一缺陷它也应红）。
  { id: 'R4-no-hit-always-truncated', file: 'src/scope.ts', needsBuild: true, testFile: 'test/pr8-review-r4.test.mjs', pattern: 'R4-1 ',
    from: "        setCov(rec, wholeBody ? 'full' : 'truncated', body.source, slice.length)",
    to: "        setCov(rec, 'truncated', body.source, slice.length)",
    why: '维护者点名的误报：短正文整篇纳入却无条件标 truncated（基线口径）' },
  { id: 'R4-chars-counts-note', file: 'src/scope.ts', needsBuild: true, testFile: 'test/pr8-review-r4.test.mjs', pattern: 'R4-1 ',
    from: "        setCov(rec, wholeBody ? 'full' : 'truncated', body.source, slice.length)",
    to: "        setCov(rec, wholeBody ? 'full' : 'truncated', body.source, text.length)",
    why: 'chars 把「以下是全文/开头片段」说明句也算进去（基线 chars=正文+24）' },
  { id: 'R4-hit-chars-includes-header', file: 'src/scope.ts', needsBuild: true, testFile: 'test/pr8-review-r4.test.mjs', pattern: 'R4-3 ',
    from: '        docChars += slice.length', to: '        docChars += frag.length',
    why: 'chars 把「--- 路径 第 N 页 ---」段标题也算进去（基线 chars=片段+页码标签）' },
  { id: 'R4-ledger-double-count', file: 'src/scope.ts', needsBuild: true, testFile: 'test/pr8-review-r4.test.mjs', pattern: 'R4-5 ',
    from: "    if (cov === 'full') full++", to: "    if (cov === 'full') full += 2",
    why: '台账计数与逐篇 coverage 不再同源（统计与明细打架）' },
  { id: 'R4-manifest-pollutes-truncated', file: 'src/scope.ts', needsBuild: true, testFile: 'test/pr8-review-r4.test.mjs', pattern: 'R4-7 ',
    from: '    manifestTruncated = true', to: '    manifestTruncated = true\n    truncated++',
    why: '清单截断又算进论文 truncated 台账（基线口径：台账与 coverage 打架）' },
  { id: 'R4-audit-impl-suite-not-vacuous', file: 'src/scope.ts', needsBuild: true, testFile: 'test/pr8-coverage-honesty.test.mjs', pattern: 'S1 ',
    from: "        setCov(rec, wholeBody ? 'full' : 'truncated', body.source, slice.length)",
    to: "        setCov(rec, 'truncated', body.source, slice.length)",
    why: '核验 t9 自己的 S1 不是空转（同一缺陷回退后它也必须红）' },
  // ── L t15（PR #8 macOS 红点：符号链接路径下入口判定失守）──
  { id: 'L1-guard-plain-resolve', file: 'src/migrate.ts', needsBuild: true, pattern: 'C23',
    from: `  try {
    const a = statSync(argv1)
    const b = statSync(self)
    // ino 为 0 的平台上（某些 Windows 文件系统）这条判据无意义，退回路径比较
    if (a.ino !== 0 && b.ino !== 0 && a.dev === b.dev && a.ino === b.ino) return true
  } catch { /* 目标不可达：继续按路径比 */ }
  const canon = (p: string): string => {
    try { return realpathSync(p) } catch { return resolve(p) }
  }
  return canon(argv1) === canon(self)`,
    to: `  return resolve(argv1) === resolve(self)`,
    why: 'macOS 形态：/var/folders→/private/var 符号链接下 import.meta.url 是真实路径、argv[1] 是符号路径 ⇒ 朴素比较失守 ⇒ CLI 静默零输出' },
  // ── K t13（PR #8 Windows CI 红点）──
  { id: 'K1-cli-guard-url-pathname', file: 'src/migrate.ts', needsBuild: true, pattern: 'C23',
    from: '  const self = fileURLToPath(metaUrl)',
    to: '  const self = new URL(metaUrl).pathname',
    why: 'win32 的 URL.pathname 形如 /D:/... ⇒ resolve 后判不出入口 ⇒ CLI 静默什么都不做（Windows CI 上 C22 拿到空 stdout）' },
  { id: 'K2-theme-no-tighten', file: 'src/theme-config.ts', needsBuild: true, pattern: 'A2 ',
    from: '  await writeFile(file, JSON.stringify(cfg, null, 2) + \'\\n\', { encoding: \'utf8\', mode: 0o600 })\n  await chmod(file, 0o600)',
    to: '  await writeFile(file, JSON.stringify(cfg, null, 2) + \'\\n\', { encoding: \'utf8\', mode: 0o600 })',
    why: '只靠 writeFile 的 mode（只在新建时生效）⇒ 已存在的宽权限配置文件不会被收紧；且跨平台断言失去源码级依据' },
  { id: 'K3-vb3-flat-collect', file: 'test/reader-ux-verification.test.mjs', needsBuild: false, testFile: 'test/reader-ux-verification.test.mjs', pattern: 'VB3',
    from: '  e.isDirectory() ? collectFileNames(join(abs, e.name)) : [e.name])',
    to: '  e.isDirectory() ? [e.name] : [e.name])',
    why: '非递归收集（缺陷态）：新布局下只看到论文目录名 p ⇒ 把「文件都在论文夹里」误判成「文件全丢了」' },
  // ── J t11（repair-round-3）验收点 ──
  { id: 'J-partial-not-cleared', file: 'src/migrate.ts', needsBuild: true, pattern: 'C19',
    from: '      rmSync(join(root, PARTIAL_MARKER), { force: true })\n      writeFileSync(join(root, DONE_MARKER), JSON.stringify(marker, null, 2) + \'\\n\', \'utf8\')',
    to: '      writeFileSync(join(root, DONE_MARKER), JSON.stringify(marker, null, 2) + \'\\n\', \'utf8\')',
    why: 'R2-1：全量成功后不清旧 .partial ⇒ 干跑报告永久谎报「上次有跳过项」（那份报告是用户点头前唯一要读的）' },
  { id: 'J-root-readdir-silent', file: 'src/migrate.ts', needsBuild: true, pattern: 'C20',
    from: '      unreadable.push({ dir: rel || \'.\', cause: (err as NodeJS.ErrnoException).code ?? \'unknown\' })',
    to: '      if (rel) unreadable.push({ dir: rel, cause: (err as NodeJS.ErrnoException).code ?? \'unknown\' })',
    why: 'R2-2：数据根读不进去被漏掉 ⇒ moves=0/unreadable=[] ⇒ 写 .done = 假成功（论文还在旧布局）' },
  { id: 'J-clearTopic-trash-left', file: 'src/library-manage.ts', needsBuild: true, pattern: 'C21',
    from: '        rmdirSync(join(realDataDir(dataDir), TRASH_DIR))',
    to: '        void TRASH_DIR',
    why: 'R2-3：clearTopic 失败后残留空的 .trash 根（第一轮 F-E）' },
  { id: 'J-cli-partial-exit0', file: 'src/migrate.ts', needsBuild: true, pattern: 'C22',
    from: '    return r.partial ? 2 : 0', to: '    return 0',
    why: 'CLI 退出码裁定：partial 返回 0 ⇒ 脚本化调用者无法区分「全迁完」与「有跳过项」' },
  { id: 'J-cli-hardfail-exit0', file: 'src/migrate.ts', needsBuild: true, pattern: 'C22',
    from: '    console.error(\'退出码 1：硬失败（库状态见日志与标记）\')\n    return 1',
    to: '    console.error(\'退出码 1：硬失败（库状态见日志与标记）\')\n    return 0',
    why: 'CLI 退出码裁定：硬失败返回 0 ⇒ 调用者把失败当成功' },
  { id: 'J-cli-usage-not-64', file: 'src/migrate.ts', needsBuild: true, pattern: 'C22',
    from: '      console.error(\'执行迁移需要显式 --yes（先人工核对上面的干跑报告）\')\n      return 64',
    to: '      console.error(\'执行迁移需要显式 --yes（先人工核对上面的干跑报告）\')\n      return 0',
    why: 'CLI 用法错误返回 0（而不是 64）⇒ 脚本化调用者把「没执行」当成功' },
  // ── I t9（repair-round-2）验收点 ──
  { id: 'I-no-COPYFILE-EXCL', file: 'src/migrate.ts', needsBuild: true, pattern: 'C18',
    from: '  const copyImpl = opts.copyImpl ?? ((from: string, to: string) => copyFileSync(from, to, fsConstants.COPYFILE_EXCL))',
    to: '  const copyImpl = opts.copyImpl ?? copyFileSync',
    why: '去掉结构护栏：默认复制不再 EXCL（判定层一旦回归就会静默覆盖已有常规文件）' },
  { id: 'I-rmSync-target-restored', file: 'src/migrate.ts', needsBuild: true, pattern: 'C18',
    from: '        const link = readlinkSync(fromAbs)\n        symlinkSync(link, toAbs)',
    to: '        const link = readlinkSync(fromAbs)\n        try { rmSync(toAbs, { force: true }) } catch { /* 不存在 */ }\n        symlinkSync(link, toAbs)',
    why: 'F-A 的祸根回归：符号链接分支先 rmSync(force) 目标（会删掉论文夹里的常规文件）' },
  { id: 'I-symlink-source-bypass', file: 'src/migrate.ts', needsBuild: true, pattern: 'C10 ',
    from: '        if (targetKind === \'none\') {', to: '        if (targetKind === \'none\' || st.isSymbolicLink()) {',
    why: 'F-A 原始缺陷：符号链接源绕过占位判定 ⇒ 阶段 1 覆盖论文夹里的常规文件' },
  { id: 'I-rollback-trash-kept', file: 'src/migrate.ts', needsBuild: true, pattern: 'C17 ',
    from: '  try {\n    rmdirSync(join(root, TRASH_DIR))\n  } catch { /* 非空 / 不存在 / 权限：留着无害（文案亦说明「失败会留下空回收站目录」） */ }',
    to: '  void TRASH_DIR',
    why: '回滚收尾不清空的回收站根（留一个空目录）' },
  { id: 'I-clearplan-single-segment', file: 'src/host.ts', needsBuild: true, testFile: 'test/library-traversal-verification.test.mjs', pattern: 'V12b',
    from: '      const topic = badTopicPath(res, rawTopic, true)\n      if (topic === null) return', to: '      const topic = rawTopic',
    why: 'clear-plan 的 topic 绕过路径门（topic 类路由分工被破坏）' },
  { id: 'I-paper-name-path-gate', file: 'src/host.ts', needsBuild: true, testFile: 'test/library-traversal-verification.test.mjs', pattern: 'V12b',
    from: '      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string }\n      if (badEntryBoundary(res, body.name)) return\n      if (rejectWritePath(body, res)) return\n      const topicPath = badTopicPath(res, body.topic, true)',
    to: '      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string }\n      if (badTopicPath(res, body.name, true) === null) return\n      if (rejectWritePath(body, res)) return\n      const topicPath = badTopicPath(res, body.topic, true)',
    why: '论文名类入参改走路径门（分工被破坏；路径门会放过 `a/b` 这类带分隔符的论文名）' },
  // ── H 队长裁定与 t4 评审的 blocker/medium（F-A/F-B/F-C + 裁定 1/2）──
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
    from: '            ? (!st.isSymbolicLink() && sizeOf(toAbs) === st.size && sha256Of(toAbs) === sha256Of(fromAbs))',
    to: '            ? (!st.isSymbolicLink() && sizeOf(toAbs) === st.size)',
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
function runTest(pattern, testFile = FEAT) {
  const r = sh('node', ['--test', `--test-name-pattern=${pattern}`, testFile])
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
    red = runTest(m.pattern, m.testFile ?? FEAT)
    if (red.code === 0) note.push('注入后仍全绿（用例空转）')
  } catch (e) { note.push(String(e.message)) } finally {
    writeFileSync(abs, original)
    if (m.needsBuild) build()
    green = runTest(m.pattern, m.testFile ?? FEAT)
    restoreDirty = !sameAs(abs, original)
  }
  const ok = red?.code !== 0 && green?.code === 0 && restoreDirty === false && note.length === 0
  results.push({ id: m.id, ok, red: red?.code, green: green?.code, dirty: restoreDirty, why: m.why, note: note.join(';') })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${m.id.padEnd(34)} 注入=${red?.code} 还原=${green?.code} diff=${restoreDirty ? 'Dirty' : 'clean'}${note.length ? `  ⚠ ${note.join('; ')}` : ''}  (${m.why})`)
}

const bad = results.filter((r) => !r.ok)
console.log(`\n# 变异验证：${results.length - bad.length}/${results.length} 通过${bad.length ? `；未通过：${bad.map((b) => b.id).join(', ')}` : ''}`)
process.exit(bad.length === 0 ? 0 : 1)
