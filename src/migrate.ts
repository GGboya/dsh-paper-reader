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
  copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync, rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { dshHome, isPaperDir, isPaperPDF, resolveDataDir } from './library.ts'
import { matchArtifactName, PAPER_STEM_SUFFIXES } from './library-manage.ts'

export const DONE_MARKER = '.migration-v1.done'
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
  /** 已存在的论文目录（已迁移完成，跳过） */
  paperDirs: string[]
  totals: { papers: number; files: number; bytes: number; needBytes: number }
  doneMarker: string | null
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
  skipped: number
  removed: number
  dirsRemoved: string[]
  logPath: string
  doneMarker: string
  studyRewrites: number
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

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return -1
  }
}

/** 论文名能否当目录名（建不出就进 quarantine，绝不硬来）。 */
function paperDirNameError(name: string): string | null {
  if (!name) return '空名'
  if (name.startsWith('.')) return '以 . 开头（隐藏/保留名）'
  if (name === '.trash') return '保留名'
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
  const paperDirs: string[] = []

  const walk = (rel: string) => {
    const dir = rel ? join(root, rel) : root
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // 论文目录：**到此为止**（它的内容已经在新布局里了）
    if (rel && isPaperDir(dir)) {
      paperDirs.push(rel)
      return
    }
    // 本层收集「论文 stem → 命中文件」；只有存在 `<stem>.pdf` 常规文件才算一篇平铺论文
    const byStem = new Map<string, string[]>()
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.name.startsWith('.')) {
        hidden.push(relPath)      // .trash / .DS_Store / .migration-log.json：不动、不阻塞
        continue
      }
      if (e.isDirectory()) {
        // F1/F1b：**已存在的论文文件夹**也算一个 stem。阶段 2 逐条删源时若在「某篇的 `<名>.pdf` 已删、
        // 同篇其余产物还在」处中断，只认平铺 pdf 会把那些产物误判成 orphan（永远留在旧布局 ⇒ 对插件等于消失）。
        if (isPaperDir(join(dir, e.name))) byStem.set(e.name, [])
        walk(relPath)
        continue
      }
      if (isPaperPDF(e.name)) byStem.set(e.name.slice(0, -4), [])
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isDirectory()) continue
      let matched = false
      for (const stem of byStem.keys()) {
        if (matchArtifactName(stem, e.name)) {
          byStem.get(stem)!.push(e.name)
          matched = true
          break
        }
      }
      // 孤儿（方案 §B1.2 六类清单）：既不匹配任何论文 stem、也不是目录 ⇒ **原地不动**，只报告
      if (!matched) orphans.push(rel ? `${rel}/${e.name}` : e.name)
    }
    for (const [stem, files] of byStem) {
      const targetRel = rel ? `${rel}/${stem}` : stem
      const targetAbs = join(root, targetRel)
      const bad = paperDirNameError(stem)
      if (bad) {
        quarantine.push({ paper: targetRel, reason: bad })
        continue
      }
      if (existsSync(targetAbs) && !lstatSync(targetAbs).isDirectory()) {
        conflicts.push({ paper: targetRel, target: targetRel, reason: '目标名被文件占据' })
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
        let targetIsFile = false
        try {
          targetIsFile = lstatSync(join(root, toRel)).isFile()
        } catch { /* 目标不存在 */ }
        if (!st.isSymbolicLink() && targetIsFile) {
          const toAbs = join(root, toRel)
          const fromAbs = join(root, fromRel)
          const sameSize = sizeOf(toAbs) === st.size
          // 「已完成」必须是**同内容**：size 相同还不够（内容不同 = 静默覆盖，正是 F2）
          const sameContent = sameSize && sha256Of(toAbs) === sha256Of(fromAbs)
          if (sameContent) {
            alreadyDone.push(entry)
          } else {
            // F2：目标已存在且内容不同 ⇒ **绝不静默覆盖**（那与队长裁定的「文件夹赢」相反，且是静默数据替换）。
            // 判冲突：先报告不执行（runMigration 见 conflicts 即中止），源一律不动。
            conflicts.push({ paper: targetRel, target: toRel, reason: '论文夹内已有同名文件且内容不同（文件夹赢：不覆盖、不删源）' })
          }
        } else {
          moves.push(entry)
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
    paperDirs,
    totals: {
      papers: new Set(all.map((e) => dirname(e.to))).size,
      files: all.length,
      bytes,
      // 需要额外占用的空间 ≈ 复制总量 × 1.2（方案 §B1.2 阶段 0.4）
      needBytes: Math.ceil(moves.reduce((n, e) => n + e.bytes, 0) * 1.2),
    },
    doneMarker: existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null,
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
  if (plan.conflicts.length > 0) {
    L.push('')
    L.push(`冲突（目标名被非目录占据，**中止该篇**）：${plan.conflicts.length} 个`)
    for (const c of plan.conflicts) L.push(`  ${c.paper}：${c.reason}`)
  }
  if (plan.quarantine.length > 0) {
    L.push('')
    L.push(`需人工（能识别成论文但建不出同名目录）：${plan.quarantine.length} 个`)
    for (const q of plan.quarantine) L.push(`  ${q.paper}：${q.reason}`)
  }
  if (plan.hidden.length > 0) {
    L.push('')
    L.push(`隐藏条目（不动、不阻塞）：${plan.hidden.length} 个`)
  }
  if (plan.doneMarker) L.push(`\n⚠️ 检测到完成标记 ${DONE_MARKER}：${plan.doneMarker.trim().slice(0, 200)}`)
  L.push('')
  L.push(plan.moves.length === 0
    ? '结论：无需迁移（幂等：可安全重复运行）。'
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
  if (plan.conflicts.length > 0 || plan.quarantine.length > 0) {
    // 结构性问题一律**先报告、不执行**（用户核对后再处理）
    throw new MigrationError('migrate-conflict', `有 ${plan.conflicts.length} 个冲突 / ${plan.quarantine.length} 个需人工条目，已中止（未改动任何文件）；请先看干跑报告`)
  }
  const logPath = opts.logPath ?? newMigrationLogPath(home)
  lastLogPath = logPath
  const useHash = opts.hash !== false
  const copyImpl = opts.copyImpl ?? copyFileSync
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
        // 符号链接：只搬链接本身（绝不跟随复制目标内容）
        const link = readlinkSync(fromAbs)
        try { rmSync(toAbs, { force: true }) } catch { /* 不存在 */ }
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
    const marker = { v: 1, at: new Date().toISOString(), copied: done.length, removed, logPath, dirsRemoved }
    writeFileSync(join(root, DONE_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8')
    return { ok: true, copied: done.length, skipped: plan.alreadyDone.length, removed, dirsRemoved, logPath, doneMarker: join(root, DONE_MARKER), studyRewrites }
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
  // 回滚完成后清掉完成标记（库已回到旧布局）
  try { rmSync(join(root, DONE_MARKER), { force: true }) } catch { /* 不存在 */ }
  return { ok: true, restored, dirsRemoved }
}

/**
 * CLI：`node dist/migrate.js [--data-dir <dir>] [--dry-run|--apply|--rollback [<log>]] [--yes] [--no-hash]`
 * 默认 **--dry-run**（只读）：绝不在没有显式 `--apply` 的情况下动用户数据。
 */
export function migrateMain(argv: string[] = process.argv.slice(2)): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const dataDir = arg('--data-dir')
  const mode = argv.includes('--apply') ? 'apply' : argv.includes('--rollback') ? 'rollback' : 'dry-run'
  const home = arg('--home')
  try {
    if (mode === 'rollback') {
      const logPath = arg('--rollback') ?? lastMigrationLog()
      if (!logPath) {
        console.error('回滚需要日志路径：--rollback <migration-log.jsonl>')
        return 2
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
      return 2
    }
    const r = runMigration(dataDir ?? resolveDataDir(), { hash: !argv.includes('--no-hash'), ...(home ? { home } : {}) })
    console.log(`迁移完成：复制 ${r.copied}，跳过 ${r.skipped}，删除源 ${r.removed}，删空目录 ${r.dirsRemoved.length}，重写学习档案 ${r.studyRewrites}。`)
    console.log(`日志：${r.logPath}`)
    return 0
  } catch (err) {
    if (err instanceof MigrationAborted) {
      console.error(err.message)
      console.error(`日志：${err.detail.logPath}`)
      return 3
    }
    if (err instanceof MigrationError) {
      console.error(`迁移失败（${err.code}）：${err.message}`)
      return 1
    }
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}

// 直接 `node dist/migrate.js` 时进入 CLI；被 import 时不执行。
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = migrateMain()
}

/** 供工具/测试判断「论文名 → 目录名」是否可用（与迁移预检同一套规则）。 */
export function paperDirNameProblem(name: string): string | null {
  return paperDirNameError(name)
}

export { PAPER_STEM_SUFFIXES, basename, relative }
