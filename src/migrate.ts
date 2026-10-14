// migrate.ts — 旧布局（平铺）→ 新布局（按论文分文件夹）的**一次性幂等迁移**。
//
// 冻结方案：docs/darkmode-subtopic-plan.md §B1.2。口径（逐条都对应验收项）：
//   · **先复制后删**：阶段 1 只 copyFile，源文件在阶段 2 校验通过前一直完好 ⇒ 中途被杀/断电
//     「源还在」（任何时刻至少有一份完整可读的产物），不会出现「产物分裂在两个位置且都像真的」；
//   · **幂等**：目标已存在且 size（+ sha256）一致 ⇒ 记 `alreadyDone`，跳过复制但仍参与清源；
//   · **可复跑**：论文目录**不递归**（结构不变量）⇒ 第二次规划 `moves.length === 0`，绝不产生 X/X/X.pdf；
//   · **零丢失**：只 unlink 那些「目标已校验一致」的源文件；孤儿（不匹配任何论文 stem）**原地不动**；
//   · **可回滚**：日志逐条记录 from/to；回滚按倒序把 to 搬回 from，再自底向上 rmdir 空目录；
//   · 日志/报告**放在 dataDir 之外**（默认 `$DSH_HOME/.dsh-paper-reader/migration-logs/`），
//     否则它们自己会变成需要额外规则处理的「第 17 个文件」。
//
// 本模块不依赖 Cordis，可直接被测试 import（dist/migrate.js）。

import {
  constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync, rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, isPaperDir, isPaperPDF, resolveDataDir } from './library.ts'
import { matchArtifactName, PAPER_STEM_SUFFIXES, TRASH_DIR } from './library-manage.ts'

export const DONE_MARKER = '.migration-v1.done'
/** 有跳过项时写的**部分完成**标记（队长裁定 1：绝不写「全部完成」的假成功标记）。 */
export const PARTIAL_MARKER = '.migration-v1.partial.json'
/** 允许「论文名 → 目录名」的长度上限（validateEntryName 是 120；目录名留余量到 100，与 §B2.5 一致）。 */
const MAX_PAPER_DIR_NAME = 100

export type MigrationClass = 'move' | 'already-done' | 'orphan' | 'hidden' | 'conflict' | 'quarantine' | 'symlink'

export interface MigrationEntry {
  /** 相对 dataDir 的源路径（`专题/论文.pdf`） */
  from: string
  /** 相对 dataDir 的目标路径（`专题/论文/论文.pdf`） */
  to: string
  bytes: number
  symlink: boolean
}

export interface MigrationPlan {
  dataDir: string
  generatedAt: string
  /** 待迁移（源已存在、目标无同内容副本） */
  moves: MigrationEntry[]
  /** 已迁移（目标已有同 size/hash 的副本）——跳过复制，但参与清源 */
  alreadyDone: MigrationEntry[]
  /** 不匹配任何论文 stem、也不是目录：**原地不动**，只报告 */
  orphans: string[]
  /** 以 `.` 开头：不动、不阻塞 */
  hidden: string[]
  /** 目标目录名被**非目录**占据：中止该论文，不动任何东西 */
  conflicts: Array<{ paper: string; target: string; reason: string }>
  /** 能识别成论文但**建不出**同名目录（前导点/保留名/超长） */
  quarantine: Array<{ paper: string; reason: string }>
  /** 读不进去的子树（无权限 / IO 错误）：单列，绝不假装「库里只有这些」 */
  unreadable: Array<{ dir: string; cause: string }>
  /** 已存在的论文目录（已迁移完成，跳过） */
  paperDirs: string[]
  totals: { papers: number; files: number; bytes: number; needBytes: number }
  doneMarker: string | null
  /** 上一次运行留下的**部分完成**标记（有跳过项时才有；内容是 {partial, skipped[]}） */
  partialMarker: string | null
}

export interface MigrationLogEntry {
  from: string
  to: string
  bytes: number
  sha256: string
  at: string
}

export interface MigrationResult {
  ok: true
  copied: number
  /** 「已完成（同内容副本已在论文夹里，只清了源）」的条目数 */
  skipped: number
  removed: number
  dirsRemoved: string[]
  logPath: string
  /** 仅在**零跳过**时给出完成标记路径；有跳过项时为空字符串（改写 `.partial` 标记） */
  doneMarker: string
  studyRewrites: number
  /** 有跳过项 = true（本次**不是**整体完成；用户须看 skippedPapers） */
  partial: boolean
  /** 被跳过的论文 / 未处理的子树（不合规名 / 冲突 / 读不进去）：源文件一律原地未动 */
  skippedPapers: Array<{ paper: string; code: string; reason: string }>
  /** 本次**未处理**的子树（权限/IO）：成功响应里显式提示，别让用户以为全迁完了 */
  unreadable: Array<{ dir: string; cause: string }>
  aborted?: false
}

export interface MigrationAbort {
  ok: false
  /** 已完成复制（源此时仍完好）的条目 */
  done: MigrationLogEntry[]
  /** 尚未处理的条目（**阶段 1** 的视角） */
  remaining: MigrationEntry[]
  /** **阶段 2 已经删掉的源**（相对 dataDir）——复跑时这些条目已经收敛，其余仍待收口 */
  unlinked: string[]
  error: string
  logPath: string
}

export function migrationLogDir(home: string = dshHome()): string {
  return join(home, '.dsh-paper-reader', 'migration-logs')
}

/** 本次运行的日志路径（时间戳 + pid，便于并发区分）。 */
export function newMigrationLogPath(home: string = dshHome()): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(migrationLogDir(home), `migrate-${stamp}-${process.pid}.jsonl`)
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 读链接指向；读不到返回 null（用于「链接 ↔ 链接 是否同一份」的判定，不抛）。 */
function readlinkOf(file: string): string | null {
  try {
    return readlinkSync(file)
  } catch {
    return null
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return -1
  }
}

/**
 * 论文名能否当目录名（建不出同名目录才进 quarantine，绝不硬来）。
 *
 * **队长裁定 2**：迁移是**搬运已有数据**，不是重新命名 —— 前导点（`.hidden`）、`.trash` 这类
 * 「能存在于盘上但不符合新命名规则」的既有名字一律**保留原名**迁移（否则那篇数据会被永久丢下、
 * 对插件不可见）。只有真的建不出目录的情况才 quarantine：过长 / 含分隔符或 NUL / `.`、`..`。
 */
function paperDirNameError(name: string): string | null {
  if (!name) return '空名'
  if (name === '.' || name === '..') return '非法名（. / ..）'
  if (name.length > MAX_PAPER_DIR_NAME) return `过长（${name.length} > ${MAX_PAPER_DIR_NAME}）`
  if (/[\\/]/.test(name) || name.includes('\u0000')) return '含分隔符/控制字符'
  return null
}

/**
 * 阶段 0：**只读预检**（绝不写盘），产出人类可读报告 + 机器可读 JSON。
 * 遍历规则：论文目录**不递归**（结构不变量，防复跑套娃）；一级/中间目录是专题，继续递归。
 */
export function planMigration(dataDir: string, home: string = dshHome()): MigrationPlan {
  const root = resolveDataDir(dataDir)
  const moves: MigrationEntry[] = []
  const alreadyDone: MigrationEntry[] = []
  const orphans: string[] = []
  const hidden: string[] = []
  const conflicts: MigrationPlan['conflicts'] = []
  const quarantine: MigrationPlan['quarantine'] = []
  const unreadable: MigrationPlan['unreadable'] = []
  const paperDirs: string[] = []

  const walk = (rel: string) => {
    const dir = rel ? join(root, rel) : root
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      // 无权限/IO 错误的子树**单列 unreadable**（不静默当作「什么都没有」）：本次不处理它，
      // 但报告与成功响应里都要显式提示「有子树未处理」。
      // R2-2：**根也要进 unreadable**。chmod 300（可写可进、不可读）时 readdir 会失败，
      // 若只记 `rel`（根为 ''）就会漏掉 ⇒ plan.moves=0 / unreadable=[] ⇒ 写 .done = **假成功**
      //（论文其实全在旧布局，用户却看到「迁移完成」）。根用 '.' 表示。
      unreadable.push({ dir: rel || '.', cause: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      return
    }
    // 本层收集「论文 stem → 命中文件」。stem 有三个来源（并集）：
    //   ① 平铺的 `<名>.pdf`（**含前导点**——队长裁定 2：隐藏论文也要迁移，保留原名）
    //   ② 已存在的论文文件夹 `<名>/`（F1/F1b：阶段 2 中断后平铺 pdf 可能已被删）
    //   ③ 隐藏的论文文件夹 `.hidden/`（同上）
    const byStem = new Map<string, string[]>()
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        // 结构不变量（**唯一**的「论文目录不递归」判定点）：目录内有 `<目录名>.pdf` ⇒ 论文目录，
        // 登记 stem 供 F1/F1b 的残留收口用，然后**绝不递归进去**（否则复跑会产生 X/X/X.pdf 套娃）。
        if (isPaperDir(join(dir, e.name))) {
          paperDirs.push(relPath)
          byStem.set(e.name, [])
          continue
        }
        if (e.name.startsWith('.')) {
          hidden.push(relPath)     // `.trash` / `.pdf2zh-tmp` 等隐藏**非论文**目录：不动、不阻塞
          continue
        }
        walk(relPath)
        continue
      }
      if (isPaperPDF(e.name)) byStem.set(e.name.slice(0, -4), [])
    }
    for (const e of entries) {
      if (e.isDirectory()) continue
      let matched = false
      for (const stem of byStem.keys()) {
        if (matchArtifactName(stem, e.name)) {
          byStem.get(stem)!.push(e.name)
          matched = true
          break
        }
      }
      if (matched) continue
      const relPath = rel ? `${rel}/${e.name}` : e.name
      // 没匹配上任何论文 stem 的隐藏名（.DS_Store 等）→ hidden（不动、不阻塞）；其余 → orphan（原地不动）
      if (e.name.startsWith('.')) hidden.push(relPath)
      else orphans.push(relPath)
    }
    for (const [stem, files] of byStem) {
      const targetRel = rel ? `${rel}/${stem}` : stem
      const targetAbs = join(root, targetRel)
      const bad = paperDirNameError(stem)
      if (bad) {
        quarantine.push({ paper: targetRel, reason: bad })
        continue
      }
      let targetKind: 'none' | 'file' | 'dir-paper' | 'dir-other' = 'none'
      try {
        const tst = lstatSync(targetAbs)
        targetKind = tst.isDirectory() ? (isPaperDir(targetAbs) ? 'dir-paper' : 'dir-other') : 'file'
      } catch { targetKind = 'none' }
      if (targetKind === 'file') {
        conflicts.push({ paper: targetRel, target: targetRel, reason: '目标名被文件占据' })
        continue
      }
      if (targetKind === 'dir-other') {
        // F-B：目标是**已存在的目录，但不是这篇论文的文件夹**（典型：同名子专题）⇒ 绝不能把平铺论文塞进去。
        // 塞进去会让该目录同时是「专题」与「论文」：listPapers/listTopicTree 不再递归、子专题里原有论文
        // 从列表与树里消失（文件还在盘上、用户却看不到）、clearTopic 永久 409。干跑就要报警。
        conflicts.push({ paper: targetRel, target: targetRel, reason: '目标名已被子专题目录占据（会把子专题变成论文、子专题内论文从列表/树里消失）' })
        continue
      }
      for (const f of files) {
        const fromRel = rel ? `${rel}/${f}` : f
        const toRel = `${targetRel}/${f}`
        let st
        try {
          st = lstatSync(join(root, fromRel))
        } catch {
          continue
        }
        const entry: MigrationEntry = { from: fromRel, to: toRel, bytes: st.size, symlink: st.isSymbolicLink() }
        const toAbs = join(root, toRel)
        const fromAbs = join(root, fromRel)
        // 目标占位判定：**只要目标已存在就绝不进 moves**（比「只判常规文件」更严：已存在的链接/目录
        // 同样不能交给阶段 1 —— 复制会**跟随链接写到库外**、目录会 EISDIR）。
        //   · 目标是常规文件：内容相同（size+sha256）⇒ alreadyDone；不同 ⇒ conflict（先报告、零改动、源不动）
        //   · 目标是符号链接：与源是同一份链接 ⇒ alreadyDone；否则 ⇒ conflict
        //   · 目标既不是常规文件也不是链接（目录/设备…）⇒ conflict
        // 只有**目标不存在**才进 moves。
        let targetKind: 'none' | 'file' | 'link' | 'other' = 'none'
        try {
          const tst = lstatSync(toAbs)
          targetKind = tst.isSymbolicLink() ? 'link' : tst.isFile() ? 'file' : 'other'
        } catch { targetKind = 'none' }
        if (targetKind === 'none') {
          moves.push(entry)
        } else {
          const sameEntry = targetKind === 'file'
            ? (!st.isSymbolicLink() && sizeOf(toAbs) === st.size && sha256Of(toAbs) === sha256Of(fromAbs))
            : targetKind === 'link'
              ? (st.isSymbolicLink() && readlinkOf(fromAbs) === readlinkOf(toAbs))   // 链接 ↔ 链接：同目标 = 同一份
              : false
          if (sameEntry) {
            alreadyDone.push(entry)
          } else {
            // F2/F-A：目标已存在且与源不是同一份 ⇒ **绝不静默覆盖**（与裁定的「文件夹赢」相反、且是静默数据替换）。
            // 判冲突：先报告、源一律不动；该篇本次不迁移（队长裁定 1：跳过该篇继续，绝不整库中止）。
            const why = targetKind === 'file'
              ? (st.isSymbolicLink()
                ? '论文夹内已有同名常规文件，与符号链接源不是同一份（绝不覆盖）'
                : '论文夹内已有同名文件且内容不同（文件夹赢：不覆盖、不删源）')
              : targetKind === 'link'
                ? '论文夹内已有同名符号链接，与源不是同一份（绝不覆盖）'
                : '目标已存在且既不是常规文件也不是符号链接（绝不覆盖）'
            conflicts.push({ paper: targetRel, target: toRel, reason: why })
          }
        }
      }
    }
  }
  walk('')

  const all = [...moves, ...alreadyDone]
  const bytes = all.reduce((n, e) => n + e.bytes, 0)
  const markerPath = join(root, DONE_MARKER)
  return {
    dataDir: root,
    generatedAt: new Date().toISOString(),
    moves,
    alreadyDone,
    orphans,
    hidden,
    conflicts,
    quarantine,
    unreadable,
    paperDirs,
    totals: {
      papers: new Set(all.map((e) => dirname(e.to))).size,
      files: all.length,
      bytes,
      // 需要额外占用的空间 ≈ 复制总量 × 1.2（方案 §B1.2 阶段 0.4）
      needBytes: Math.ceil(moves.reduce((n, e) => n + e.bytes, 0) * 1.2),
    },
    doneMarker: existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
    partialMarker: existsSync(join(root, PARTIAL_MARKER)) ? readFileSync(join(root, PARTIAL_MARKER), 'utf8') : null,
  }
}

/** 人类可读的干跑报告（给人核对用；机器读的是上面的 JSON）。 */
export function formatMigrationReport(plan: MigrationPlan): string {
  const L: string[] = []
  L.push(`文献库：${plan.dataDir}`)
  L.push(`生成时间：${plan.generatedAt}`)
  L.push(`布局：旧（平铺）→ 新（按论文分文件夹）`)
  L.push(`待迁移：${plan.totals.papers} 篇 / ${plan.totals.files} 个文件 / ${plan.totals.bytes} 字节（需额外空间约 ${plan.totals.needBytes} 字节）`)
  L.push(`已完成（目标已有同内容副本，只清源）：${plan.alreadyDone.length} 个文件`)
  L.push(`已是论文文件夹（跳过）：${plan.paperDirs.length} 个`)
  if (plan.moves.length > 0) {
    L.push('')
    L.push('将移动：')
    for (const m of plan.moves) L.push(`  ${m.from}  →  ${m.to}`)
  }
  if (plan.orphans.length > 0) {
    L.push('')
    L.push(`孤儿文件（既不匹配任何论文也不是目录，**原地不动**）：${plan.orphans.length} 个`)
    for (const o of plan.orphans) L.push(`  ${o}`)
  }
  const skippedTotal = plan.conflicts.length + plan.quarantine.length + plan.unreadable.length
  if (plan.conflicts.length > 0) {
    L.push('')
    L.push(`⚠️ 冲突（本次**跳过该篇**、源文件原地不动，其余照常迁移）：${plan.conflicts.length} 个`)
    for (const c of plan.conflicts) L.push(`  ${c.paper}：${c.reason}`)
  }
  if (plan.quarantine.length > 0) {
    L.push('')
    L.push(`⚠️ 需人工（论文名建不出同名目录，本次**跳过该篇**、源文件原地不动）：${plan.quarantine.length} 个`)
    for (const q of plan.quarantine) L.push(`  ${q.paper}：${q.reason}`)
  }
  if (skippedTotal > 0) {
    L.push('')
    L.push(`注意：有 ${skippedTotal} 篇会被跳过 ⇒ 本次**不会**写「全部完成」标记，只会写 ${PARTIAL_MARKER}（含跳过清单）。`)
  }
  if (plan.unreadable.length > 0) {
    L.push('')
    L.push(`⚠️ 有 ${plan.unreadable.length} 棵子树**读不进去**（权限/IO），本次**未处理**：`)
    for (const u of plan.unreadable) L.push(`  ${u.dir}（${u.cause}）`)
    L.push('（请检查权限后重跑；这不会阻塞其它子树）')
  }
  if (plan.hidden.length > 0) {
    L.push('')
    L.push(`隐藏条目（不动、不阻塞）：${plan.hidden.length} 个`)
  }
  if (plan.doneMarker) L.push(`\n⚠️ 检测到完成标记 ${DONE_MARKER}：${plan.doneMarker.trim().slice(0, 200)}`)
  if (plan.partialMarker) L.push(`\n⚠️ 检测到**部分完成**标记 ${PARTIAL_MARKER}（上次有跳过项）：${plan.partialMarker.trim().slice(0, 300)}`)
  L.push('')
  L.push(plan.moves.length === 0
    ? (skippedTotal > 0
      ? `结论：可迁移的都已就位；但仍有 ${skippedTotal} 篇被跳过（见上），需人工处理后再跑（幂等：可安全重复运行）。`
      : '结论：无需迁移（幂等：可安全重复运行）。')
    : '结论：先人工核对本报告，再以 --apply 执行；执行前建议 `cp -a` 一份库快照到库外。')
  return L.join('\n')
}

function appendLog(logPath: string, entry: MigrationLogEntry): void {
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'a')
  try {
    appendFileSync(fd, JSON.stringify(entry) + '\n')
    fsyncSync(fd)                      // 每条落盘：被 kill 后日志仍能复跑/回滚
  } finally {
    closeSync(fd)
  }
}

export function readMigrationLog(logPath: string): MigrationLogEntry[] {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as MigrationLogEntry)
  } catch {
    return []
  }
}

/** 单次迁移的日志（进程内），供 rollbackMigration 在未显式给路径时使用。 */
let lastLogPath = ''

export function lastMigrationLog(): string {
  return lastLogPath
}

export interface RunMigrationOptions {
  /** 日志路径（默认自动生成） */
  logPath?: string
  /** 校验用 sha256（默认 true；大库可关掉只比 size） */
  hash?: boolean
  /** 依赖注入：在复制第 N 个文件**之后**抛错，用于「可中断」验证 */
  failAfterCopies?: number
  /** 依赖注入：在阶段 2 删除第 N 个源之前抛错 */
  failBeforeUnlink?: number
  home?: string
  /** 复制实现（测试注错用） */
  copyImpl?: (from: string, to: string) => void
}

/**
 * 阶段 1 + 阶段 2：执行迁移。
 * · 阶段 1（只复制）任一条失败 ⇒ **停止，不删任何源**，抛 MigrationError 带 {done, remaining}；
 * · 阶段 2 只有「全部论文都复制且校验通过」之后才开始：逐条**再校验一次**，一致才 unlink 源。
 */
export function runMigration(dataDir: string, opts: RunMigrationOptions = {}): MigrationResult {
  const home = opts.home ?? dshHome()
  const root = resolveDataDir(dataDir)
  const plan = planMigration(root, home)
  // 队长裁定 1：不合规论文名（quarantine）与冲突一律**跳过该篇、继续迁移**——绝不整库中止
  //（一篇坏名字/一个冲突挡住整个库是不可接受的）；但绝不允许「假成功」：跳过项在这里记账，
  // 结束时报进 `skippedPapers`，且**只在零跳过时**写 `.migration-v1.done`，否则写 `.partial`。
  const skippedPapers = [
    ...plan.quarantine.map((q) => ({ paper: q.paper, code: 'migrate-quarantine', reason: q.reason })),
    ...plan.conflicts.map((c) => ({ paper: c.paper, code: 'migrate-conflict', reason: c.reason })),
    // 读不进去的子树：本次**未处理**（不是「迁移失败」，但也绝不能当成「已完成」）
    ...plan.unreadable.map((u) => ({ paper: u.dir, code: 'migrate-unreadable', reason: `子树读不进去（${u.cause}），本次未处理` })),
  ]
  const logPath = opts.logPath ?? newMigrationLogPath(home)
  lastLogPath = logPath
  const useHash = opts.hash !== false
  // COPYFILE_EXCL：目标已存在直接失败（结构上杜绝「覆盖已有常规文件」——判定层再严也不如内核层兜底）
  const copyImpl = opts.copyImpl ?? ((from: string, to: string) => copyFileSync(from, to, fsConstants.COPYFILE_EXCL))
  const done: MigrationLogEntry[] = []
  /** 阶段 2 已删掉的源（catch 里要如实上报，所以声明在 try 之外） */
  const unlinked: string[] = []
  const todo = [...plan.moves]
  try {
    // ── 阶段 1：只复制（源完好）──
    for (const [i, m] of todo.entries()) {
      const fromAbs = join(root, m.from)
      const toAbs = join(root, m.to)
      mkdirSync(dirname(toAbs), { recursive: true })
      if (m.symlink) {
        // 符号链接：只搬链接本身（绝不跟随复制目标内容）。
        // ⚠️ 这里**绝不**先 `rmSync(toAbs, {force:true})`：那会把目标处已有的条目删掉（正是 F-A 的祸根）。
        // 目标已存在时 `symlinkSync` 自己会 EEXIST 失败 ⇒ 如实报错、不删源，由上层复跑/人工处理。
        const link = readlinkSync(fromAbs)
        symlinkSync(link, toAbs)
        statSync(fromAbs)  // 悬空链接会抛：如实失败，不假装成功
      } else {
        copyImpl(fromAbs, toAbs)
      }
      // 立即校验（size 恒查；hash 默认查）——校验不通过视为复制失败，不写日志、不删源
      const fromSize = sizeOf(fromAbs)
      const toSize = sizeOf(toAbs)
      if (fromSize !== toSize) throw new MigrationError('migrate-verify-failed', `复制校验失败（size 不一致）：${m.from}`)
      const sha = m.symlink ? '' : sha256Of(toAbs)
      if (!m.symlink && useHash && sha256Of(fromAbs) !== sha) {
        throw new MigrationError('migrate-verify-failed', `复制校验失败（sha256 不一致）：${m.from}`)
      }
      const entry: MigrationLogEntry = { from: m.from, to: m.to, bytes: fromSize, sha256: sha, at: new Date().toISOString() }
      appendLog(logPath, entry)
      done.push(entry)
      if (opts.failAfterCopies !== undefined && done.length >= opts.failAfterCopies) {
        throw new MigrationError('migrate-interrupted', `注入中断：已复制 ${done.length} 个文件（源未删除）`)
      }
    }
    // 已完成（目标已有同内容副本）的条目：不动文件，但同样进入清源队列（先再校验一次）
    const toUnlink: MigrationLogEntry[] = [...done]
    for (const m of plan.alreadyDone) {
      const fromAbs = join(root, m.from)
      const toAbs = join(root, m.to)
      if (!existsSync(fromAbs)) continue
      const sameSize = sizeOf(fromAbs) === sizeOf(toAbs)
      const sameHash = !useHash || sha256Of(fromAbs) === sha256Of(toAbs)
      if (!sameSize || !sameHash) {
        throw new MigrationError('migrate-verify-failed', '已完成条目校验失败（目标副本与源不一致）：' + m.from)
      }
      toUnlink.push({ from: m.from, to: m.to, bytes: m.bytes, sha256: sha256Of(toAbs), at: new Date().toISOString() })
    }
    // ── 阶段 2：源已全部校验过 ⇒ 逐个删源（删前再校验一次，双保险）──
    let removed = 0
    for (const [i, e] of toUnlink.entries()) {
      const fromAbs = join(root, e.from)
      const toAbs = join(root, e.to)
      if (opts.failBeforeUnlink !== undefined && removed >= opts.failBeforeUnlink) {
        throw new MigrationError('migrate-interrupted', `注入中断：已删除 ${removed} 个源（其余源仍在，可复跑）`)
      }
      if (sizeOf(fromAbs) !== sizeOf(toAbs) || (useHash && e.sha256 && sha256Of(toAbs) !== e.sha256)) {
        throw new MigrationError('migrate-verify-failed', `清源前校验失败，已停止删源：${e.from}`)
      }
      try {
        unlinkSync(fromAbs)
      } catch (err) {
        throw new MigrationError('migrate-unlink-failed', `删除源文件失败（目标副本完好，数据不丢）：${e.from}：${(err as Error).message}`)
      }
      removed++
      unlinked.push(e.from)
      void i
    }
    // 自底向上 rmdir 空目录（**非递归**，空即删，绝不 rm -rf）
    const dirsRemoved = removeEmptyDirs(root, touchedDirs(toUnlink.map((e) => e.from)))
    // study.json 的 paper 字段重写（`<旧专题>/<篇名>` → `<新专题>/<篇名>`）
    const studyRewrites = rewriteStudyPointers(root, plan)
    const partial = skippedPapers.length > 0
    const marker = { v: 1, at: new Date().toISOString(), copied: done.length, removed, logPath, dirsRemoved, partial, skipped: skippedPapers }
    if (partial) {
      // 有跳过项 ⇒ **绝不**写「全部完成」标记（用户会以为迁完了）
      writeFileSync(join(root, PARTIAL_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8')
    } else {
      // R2-1：全量成功必须**清掉旧的 .partial** —— 否则跳过项修好之后，每次干跑报告都会
      // 永久谎报「上次有跳过项」，而那份报告正是用户点头迁移前唯一要读的东西（谎报=欺骗用户）。
      // 顺序刻意是「先清 .partial、再写 .done」：中途死掉时两个标记都不在 ⇒ 报告只会保守地说
      // 「没有完成标记」，绝不会出现「.done 与 .partial 同时在场」的谎报（复跑幂等，会重新写）。
      rmSync(join(root, PARTIAL_MARKER), { force: true })
      writeFileSync(join(root, DONE_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8')
    }
    return {
      ok: true, copied: done.length, skipped: plan.alreadyDone.length, removed, dirsRemoved, logPath,
      doneMarker: partial ? '' : join(root, DONE_MARKER), studyRewrites, partial, skippedPapers,
      unreadable: plan.unreadable,
    }
  } catch (err) {
    if (err instanceof MigrationError && err.code === 'migrate-interrupted') {
      const doneSet = new Set(done.map((d) => d.from))
      throw new MigrationAborted({ ok: false, done, remaining: todo.filter((m) => !doneSet.has(m.from)), unlinked, error: err.message, logPath })
    }
    throw err
  }
}

/** 迁移的结构化错误（带机器码，路由层可直接映射 409/500）。 */
export class MigrationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
  }
}

/** 中断：**源文件完好**，日志里记着已复制项，可复跑/可回滚。 */
export class MigrationAborted extends Error {
  readonly code = 'migrate-aborted'
  readonly detail: MigrationAbort
  constructor(detail: MigrationAbort) {
    super(`迁移中断：${detail.error}（已复制 ${detail.done.length} 个文件，**未删除任何源**，可安全复跑）`)
    this.name = 'MigrationAborted'
    this.detail = detail
  }
}

/** 自底向上删除**空**目录（含嵌套）；绝不递归删除非空目录。返回被删掉的相对路径。 */
/** 日志条目必须是**安全的相对路径**（回滚会按它 rename；绝不接受 `..`/绝对路径，防日志被篡改后逃逸）。 */
export function safeRel(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false
  if (p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:/.test(p)) return false
  const parts = p.split('/')
  return parts.every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

export function touchedDirs(relFiles: string[]): Set<string> {
  const out = new Set<string>()
  for (const f of relFiles) {
    let d = dirname(f)
    while (d && d !== '.') { out.add(d); d = dirname(d) }
  }
  return out
}

export function removeEmptyDirs(root: string, only?: Set<string>): string[] {
  const removed: string[] = []
  const walk = (rel: string) => {
    const dir = rel ? join(root, rel) : root
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      walk(rel ? `${rel}/${e.name}` : e.name)
    }
    if (!rel || (only && !only.has(rel))) return
    try {
      rmdirSync(dir)
      removed.push(rel)
    } catch { /* 非空或权限：保留 */ }
  }
  walk('')
  return removed
}

/**
 * 迁移后重写 `study.json` 的 paper 字段（`<旧专题>/<篇名>` → `<新专题>/<篇名>`）。
 * 容错：文件缺失/损坏一律跳过（绝不因为一个损坏的档案让整次迁移失败）。
 */
export function rewriteStudyPointers(root: string, plan: MigrationPlan): number {
  // 映射的是**论文路径**（`<专题路径>/<篇名>`），不是目录：布局迁移里目录变了但「专题路径/篇名」不变，
  // 因此这里通常是恒等映射（不写盘）；真正会变的是「专题改名/移动」那类操作。
  const renames = new Map<string, string>()
  for (const e of [...plan.moves, ...plan.alreadyDone]) {
    const stem = basename(e.to)
    const oldTopic = dirname(e.from)
    const newTopic = dirname(e.to)
    if (oldTopic === newTopic) continue
    const oldPaper = oldTopic === '.' ? stem : `${oldTopic}/${stem}`
    const newPaper = newTopic === '.' ? stem : `${newTopic}/${stem}`
    renames.set(oldPaper, newPaper)
  }
  let n = 0
  const walk = (rel: string) => {
    const dir = rel ? join(root, rel) : root
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(rel ? `${rel}/${e.name}` : e.name)
        continue
      }
      if (!e.name.endsWith('.study.json')) continue
      const file = join(dir, e.name)
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as { paper?: string }
        if (typeof data.paper !== 'string') continue
        const next = renames.get(data.paper)
        if (!next || next === data.paper) continue
        data.paper = next
        writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
        n++
      } catch { /* 损坏的档案：跳过，不阻塞迁移 */ }
    }
  }
  walk('')
  return n
}

/**
 * 回滚：按日志**倒序**把 `to` 搬回 `from`（若 `from` 已存在则跳过——说明那份源从未被删），
 * 再自底向上 rmdir 空目录。幂等：可重复运行。
 */
export function rollbackMigration(dataDir: string, logPath: string): { ok: true; restored: number; dirsRemoved: string[] } {
  const root = resolveDataDir(dataDir)
  const entries = readMigrationLog(logPath).filter((e) => safeRel(e.from) && safeRel(e.to))
  let restored = 0
  for (const e of [...entries].reverse()) {
    const fromAbs = join(root, e.from)
    const toAbs = join(root, e.to)
    if (existsSync(fromAbs) || !existsSync(toAbs)) continue   // 源还在 / 副本没了 ⇒ 无需回滚这一条
    mkdirSync(dirname(fromAbs), { recursive: true })
    renameSync(toAbs, fromAbs)
    restored++
  }
  // 候选目录要同时含**源**与**副本**的父目录：迁移时新建的论文文件夹（`T/P1/`）在搬回后是空的，
  // 不收口就会在库里留下一堆空目录（实测：回滚后形状与迁移前不一致）。
  const dirsRemoved = removeEmptyDirs(root, touchedDirs([...entries.map((e) => e.from), ...entries.map((e) => e.to)]))
  // 回滚收尾：best-effort 清掉**空**的回收站根（迁移不用回收站；只是别留空目录）。
  // 非空的 `.trash` 一律不动 —— 那是用户可恢复的数据。
  try {
    rmdirSync(join(root, TRASH_DIR))
  } catch { /* 非空 / 不存在 / 权限：留着无害（文案亦说明「失败会留下空回收站目录」） */ }
  // 回滚完成后清掉完成/部分完成标记（库已回到旧布局）
  try { rmSync(join(root, DONE_MARKER), { force: true }) } catch { /* 不存在 */ }
  try { rmSync(join(root, PARTIAL_MARKER), { force: true }) } catch { /* 不存在 */ }
  return { ok: true, restored, dirsRemoved }
}

/**
 * CLI：`node dist/migrate.js [--data-dir <dir>] [--dry-run|--apply|--rollback [<log>]] [--yes] [--no-hash]`
 * 默认 **--dry-run**（只读）：绝不在没有显式 `--apply` 的情况下动用户数据。
 */
/**
 * 迁移 CLI。**退出码（队长裁定，脚本化调用者据此分支）**：
 *   · **0** = 全部迁移完成（没有跳过项/冲突/未处理子树）
 *   · **2** = **部分完成**：有跳过项（不合规名 / 冲突 / 读不进去的子树）或运行被中断
 *           ⇒ 库已部分迁移、源文件未丢，处理完那些篇再跑一次即可（幂等）
 *   · **1** = **硬失败**：迁移过程出错（校验失败 / IO 错误…），库状态由日志与标记如实反映
 *   · **64** = 用法错误（缺 `--yes` / 回滚缺日志路径 / 未知参数）
 * `--dry-run`（默认）永远返回 0（它只是打印报告，不改任何东西）。
 */
export function migrateMain(argv: string[] = process.argv.slice(2)): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const dataDir = arg('--data-dir')
  const mode = argv.includes('--apply') ? 'apply' : argv.includes('--rollback') ? 'rollback' : 'dry-run'
  const home = arg('--home')
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  try {
    if (mode === 'rollback') {
      const logPath = arg('--rollback') ?? lastMigrationLog()
      if (!logPath) {
        console.error('回滚需要日志路径：--rollback <migration-log.jsonl>')
        return 64
      }
      const r = rollbackMigration(dataDir ?? resolveDataDir(), logPath)
      console.log(`已回滚 ${r.restored} 个文件；删除空目录 ${r.dirsRemoved.length} 个。`)
      return 0
    }
    const plan = planMigration(dataDir ?? resolveDataDir(), home ?? dshHome())
    console.log(formatMigrationReport(plan))
    if (mode === 'dry-run') return 0
    if (!argv.includes('--yes')) {
      console.error('执行迁移需要显式 --yes（先人工核对上面的干跑报告）')
      return 64
    }
    const r = runMigration(dataDir ?? resolveDataDir(), { hash: !argv.includes('--no-hash'), ...(home ? { home } : {}) })
    if (r.partial) {
      console.log(`⚠️ 部分完成：复制 ${r.copied}，删除源 ${r.removed}；**跳过 ${r.skippedPapers.length} 篇**（源文件原地未动）：`)
      for (const sp of r.skippedPapers) console.log(`   · ${sp.paper}：${sp.reason}（${sp.code}）`)
      console.log('   未写「全部完成」标记；处理完这些篇再跑一次即可（幂等）。')
    } else {
      console.log(`迁移完成：复制 ${r.copied}，跳过 ${r.skipped}，删除源 ${r.removed}，删空目录 ${r.dirsRemoved.length}，重写学习档案 ${r.studyRewrites}。`)
    }
    console.log(`日志：${r.logPath}`)
    console.log(r.partial ? '退出码 2：部分完成（有跳过项/未处理的子树）' : '退出码 0：全部迁移完成')
    return r.partial ? 2 : 0
  } catch (err) {
    if (err instanceof MigrationAborted) {
      console.error(err.message)
      console.error(`日志：${err.detail.logPath}`)
      console.error('退出码 2：运行被中断（部分完成，源文件未丢；可安全复跑）')
      return 2
    }
    if (err instanceof MigrationError) {
      console.error(`迁移失败（${err.code}）：${err.message}`)
      return 1
    }
    console.error(err instanceof Error ? err.message : String(err))
    console.error('退出码 1：硬失败（库状态见日志与标记）')
    return 1
  }
}

/** CLI 用法与**退出码**说明（`--help` 打印；也是脚本化调用者的契约文档）。 */
export const USAGE = `用法：node dist/migrate.js [--data-dir <目录>] [--home <dsh home>] [--dry-run|--apply|--rollback <日志>] [--yes] [--no-hash]

  --dry-run（默认）  只打印干跑报告，**不改任何东西**
  --apply --yes      执行迁移（必须先人工核对干跑报告）
  --rollback <日志>  按日志回滚到迁移前
  --help             打印本说明

退出码：
  0   全部迁移完成（无跳过项/冲突/未处理子树）
  2   部分完成：有跳过项（不合规论文名 / 冲突 / 读不进去的子树）或运行被中断
      —— 库已部分迁移、源文件未丢，处理完那些篇再跑一次即可（幂等）
  1   硬失败：迁移过程出错（校验失败 / IO 错误…）
  64  用法错误（缺 --yes / 回滚缺日志路径）
注意：「--dry-run」永远返回 0（它只是报告）；「--apply」后请按退出码分支，不要只看 stdout。`

// 直接 `node dist/migrate.js` 时进入 CLI；被 import 时不执行。
// ⚠️ 必须用 `fileURLToPath`（平台感知）而不是 `new URL(import.meta.url).pathname`：
//   · win32：pathname 形如 `/D:/a/b/dist/migrate.js`，`path.resolve()` 会拼成 `D:\D:\a\...` ⇒ 永不相等
//     ⇒ CLI **静默什么都不做**（PR #8 Windows CI 上 C22 拿到空 stdout 就是这个）；
//   · 任何平台：路径里有空格/非 ASCII 时 pathname 是 %-转义形式（`%20`），同样判不出。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = migrateMain()
}

/** 供工具/测试判断「论文名 → 目录名」是否可用（与迁移预检同一套规则）。 */
export function paperDirNameProblem(name: string): string | null {
  return paperDirNameError(name)
}

export { PAPER_STEM_SUFFIXES, basename, relative }
