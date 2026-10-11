// library-manage.ts — 文献库的破坏性操作（删除 / 重命名）与配套的安全校验。
//
// 契约：docs/reader-ux-requirements.md §2。要点：
//   · 写路径**只接受** topic + name（不接受 path），逐条做路径穿越防护；
//   · 删除 = 精确 stem 匹配的产物清单，**移入 `<dataDir>/.trash/`**（可恢复），
//     移动失败绝不回退 unlink，`.pdf` 最后移（失败时文献仍在库里可见可用）；
//   · 删除专题只允许空目录，非递归语义（rmdir），隐藏条目进回收站而不是销毁；
//   · 重命名先校验全部前提再动手，中途失败 best-effort 回滚。
//
// 本模块不依赖 Cordis，可直接被测试 import（dist/library-manage.js）。

import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync, existsSync } from 'node:fs'
// 共享的**边界原语**（上游 #4 的路径穿越修复，逐字保留在 library.ts）：
// validateEntryName / validateEntryBoundary / realDataDir / assertInside。
// 注意口径（评审 F-F）：组合层**两套并存**——生产写路径用本模块的 resolveTopicDirChecked
// （在其上更严），#4 的 resolveSafeTopic 组合层只被 library.ts 的适配器（上游测试用）调用。
// 本模块**消费**它，不再自己重复一套词法/realpath 校验；我们的加严叠在其上（见下）。
import {
  assertInside as assertInsideShared,
  listPapers,
  realDataDir as realDataDirShared,
  validateEntryBoundary as validateBoundaryShared,
  validateEntryName,
} from './library.ts'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

// ── 错误 ─────────────────────────────────────────────────────────────────────

export type ManageCode =
  | 'bad-name'
  | 'bad-request'
  | 'not-found'
  | 'escape-rejected'
  | 'target-exists'
  | 'confirm-mismatch'
  | 'topic-not-empty'
  | 'session-running'
  | 'translation-busy'
  | 'trash-move-failed'
  | 'rename-partial'
  // 上游评审必修 3：Windows 的 EBUSY/EPERM（文件被阅读器/杀软/索引/同步盘占用）是高频道，
  // 必须给「文件被占用，关闭后重试」的 409（上游 fsError 的语义），而不是笼统的 500。
  | 'file-busy'
  // 契约 §5 R5 的并发互斥机器码字面为 `in-progress`；实现统一用更简洁的 `busy`（语义一致），
  // 已在 host.ts 的 withInflight 注释与前端 errText 对齐。见 src/host.ts。
  | 'busy'

/** HTTP 状态与机器可读 code 双携带；`extra` 会并入响应体（前端只认 code，不匹配中文）。 */
export class ManageError extends Error {
  readonly code: ManageCode
  readonly status: number
  readonly extra: Record<string, unknown>
  constructor(code: ManageCode, status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ManageError'
    this.code = code
    this.status = status
    this.extra = extra
  }
}

export function isManageError(e: unknown): e is ManageError {
  return e instanceof ManageError
}

// ── 名称校验 ────────────────────────────────────────────────────────────────

/** 回收站目录名（保留名；`listTopics` 因隐藏而跳过它，因此不会显示成专题）。 */
export const TRASH_DIR = '.trash'

/**
 * 命名规范类校验（创建 / 改名-to 用）——**复用上游 #4 的 `validateEntryName`**，
 * 只把 `string | null` 的形状映射成我们的 `ManageError('bad-name', 400, 文案)`；
 * 文案沿用 #4 原句（上游用例按正则断言：/名字过长/、/名字不能包含控制字符/…）。
 * 语义与 #4 完全一致：trim 后使用（`'  T  '` 落到 `T`）、长度 ≤ 120、拒绝全部 C0 控制字符
 * 与 DEL、拒绝前导点、拒绝 `/ \ ..`。
 */
export function validateName(raw: unknown, label: 'topic' | 'paper'): string {
  const what = label === 'topic' ? '专题名' : '文献名'
  if (typeof raw !== 'string') throw new ManageError('bad-name', 400, `${what}不能为空`)
  const err = validateEntryName(raw)
  if (err) throw new ManageError('bad-name', 400, err)
  return raw.trim()
}

/**
 * 边界类校验（删除 / 改名-from / 已存在条目用）——**复用上游 #4 的 `validateEntryBoundary`**
 * （空、`/ \`、`..`、NUL），并叠上我们的两条加严：`.trash` 是保留名、`basename` 必须一致。
 *
 * 与 `validateName`（命名规范类：长度、前导点、非 NUL 控制字符）的分工是 PR-1 的分层原则：
 * 命名规范只在**创建/改名**时强制（那是用户在新起一个名字）；删除/改名-from 作用于
 * **已存在**的条目，若也按命名规范卡，「创建时宽松、事后规范收紧」或历史遗留的名字
 * （前导点、超长、`\x01`）就会变成删不掉的孤儿。反之，upload 能落盘的名字都必须能删。
 *
 * 原样返回 raw（**不 trim**），与创建侧的 trim 语义分开：按字面名匹配磁盘条目。
 */
export function validateEntryBoundary(raw: unknown, label: 'topic' | 'paper'): string {
  const what = label === 'topic' ? '专题名' : '文献名'
  if (typeof raw !== 'string' || raw.length === 0) throw new ManageError('bad-name', 400, `${what}不能为空`)
  const err = validateBoundaryShared(raw)
  if (err) throw new ManageError('bad-name', 400, err)
  if (basename(raw) !== raw) throw new ManageError('bad-name', 400, `${what}非法`)
  // `.` / `..` 不是任何条目的名字（上游边界类只挡 `..`，`basename` 归一后是 `.` 的形态也一并挡掉；
  // 这是我们的加严——realpath 层随后还会拒 target === root，两道都在）。
  if (basename(raw) === '.' || basename(raw) === '..') throw new ManageError('bad-name', 400, `${what}非法`)
  // 回收站是插件自己的保留目录（listTopics 因隐藏而跳过它，用户也创建不了）：
  // 不允许把它当专题删掉/改名，否则回收站里的可恢复文件会被误销毁。
  if (raw === TRASH_DIR) throw new ManageError('bad-name', 400, `${what}是保留名，不能操作`)
  return raw
}

/** 文献名不得以 pdf2zh 变体后缀结尾（否则 isPaperPDF 视其为非文献 → 从库里消失）。 */
export function validateNewPaperName(raw: unknown, current: string): string {
  const name = validateName(raw, 'paper')
  if (name === current) throw new ManageError('bad-request', 400, '新名称与原名称相同')
  if (/-(en|zh|dual)$/.test(name)) {
    throw new ManageError('bad-name', 400, '新名称不能以 -en/-zh/-dual 结尾（会被当作 pdf2zh 变体而从文献库隐藏）')
  }
  return name
}

// ── 路径解析与穿越防护 ───────────────────────────────────────────────────────

/**
 * target 必须落在 root 内（严格子路径），否则视为越界。
 * **复用上游 #4 的 `assertInside`**（带 sep 边界的严格前缀比较），并在其上叠我们的一条加严：
 * 上游允许 `target === root`（`target !== root && !startsWith`），我们**拒绝**——对
 * deleteTopic/rename 这类破坏性操作，把「库根目录本身」当专题名操作必须挡掉
 * （既有用例钉住：reader-ux-verification 的 VB5 ⑤）。
 */
export function assertInside(root: string, target: string): void {
  try {
    assertInsideShared(root, target)                     // 上游 #4 的严格子路径包含
  } catch {
    // 上游抛的是不带 .code 的普通 Error → 统一映射成带机器码的 ManageError（host 的错误通道认 code）
    throw new ManageError('escape-rejected', 400, '路径越界，已拒绝')
  }
  if (target === root) throw new ManageError('escape-rejected', 400, '路径越界，已拒绝')
}

/** 文献库根目录的真实路径（必须存在）——复用 #4 的 realpath 规范化，错误映射成我们的 404。 */
export function realDataDir(dataDir: string): string {
  try {
    return realDataDirShared(dataDir)
  } catch {
    throw new ManageError('not-found', 404, '文献库目录不存在')
  }
}

/** 解析专题目录的公共实现：`boundaryOnly` 选择词法校验的强度（见 validateEntryBoundary）。 */
function resolveTopicDirChecked(dataDir: string, topic: unknown, boundaryOnly: boolean): string {
  const name = boundaryOnly ? validateEntryBoundary(topic, 'topic') : validateName(topic, 'topic')
  const root = realDataDir(dataDir)
  const dir = join(root, name)
  let st
  try {
    st = lstatSync(dir)
  } catch {
    throw new ManageError('not-found', 404, `专题不存在：${name}`)
  }
  if (st.isSymbolicLink()) throw new ManageError('escape-rejected', 400, `路径越界：专题目录是符号链接，已拒绝：${name}`)
  if (!st.isDirectory()) throw new ManageError('not-found', 404, `专题不存在：${name}`)
  const real = realpathSync(dir)
  if (real !== dir) throw new ManageError('escape-rejected', 400, `路径越界：专题目录真实路径异常，已拒绝：${name}`)
  assertInside(root, real)
  return real
}

/** 解析专题目录（写入路径用）：必须存在、必须是真目录（不是符号链接）、必须落在 dataDir 内。 */
export function resolveTopicDir(dataDir: string, topic: unknown): string {
  return resolveTopicDirChecked(dataDir, topic, false)
}

/** 解析**已存在**的专题目录（删除 / 改名-from 用）：只做边界类校验，历史遗留的
 *  不规范名（前导点、超长、控制字符）同样能操作，避免「删不掉的孤儿」。 */
export function resolveExistingTopicDir(dataDir: string, topic: unknown): string {
  return resolveTopicDirChecked(dataDir, topic, true)
}

// ── 产物清单（精确 stem 匹配） ────────────────────────────────────────────────

// `.study.json` = 论文伴读的学习档案（阅读计划 / 检验成绩，src/study.ts 写在文献旁边；preset 的
// study_update 工具会真的写它）。上游 v1.3.0 的 PAPER_SIDECARS 覆盖了它、release note 也写明
// 「转录 / 译文 / 学习档案连带搬家」；整合时上游实现被我们的加固版整段替换，该后缀随之丢失
// （t4 评审 F1）。少它的后果：① 改名后档案仍挂旧名 → readStudy 找不到，用户以为进度全丢；
// ② 删除时不进回收站、moved/skipped 都不报告；③ 残留条目既不是文献也不是专题，任何 API 都
// 清不掉，永久阻塞删专题（409 topic-not-empty）。本次归位：改名连带、删除移入回收站。
export const PAPER_STEM_SUFFIXES = ['.pdf', '.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json', '.study.json'] as const
export const PDF2ZH_VARIANT_SUFFIXES = ['-en', '-zh', '-dual'] as const
/** atomicTempPath(): `${path}.tmp-${pid}-${uuid.slice(0,8)}`（src/transcribe.ts）。 */
const TMP_RE = /\.tmp-\d+-[0-9a-f]{8}$/

export type ArtifactKind = 'pdf' | 'cache' | 'mineru' | 'embed' | 'study' | 'variant' | 'tmp'

export interface ManagedFile {
  /** 文件名（不含目录） */
  name: string
  kind: ArtifactKind
  bytes: number
  /** 是否为符号链接（是则只移动链接本身） */
  symlink: boolean
}

/**
 * 精确匹配：`<paperName><已知后缀>` 或 `<paperName>-en|-zh|-dual.pdf` 或上述 + `.tmp-…`。
 * 刻意**不用** startsWith —— 删 `Attention` 绝不能连带删 `Attention Is All You Need.pdf`。
 */
export function matchArtifactName(paperName: string, entry: string): boolean {
  let base = entry
  const m = TMP_RE.exec(entry)
  if (m) base = entry.slice(0, m.index)
  for (const s of PAPER_STEM_SUFFIXES) if (base === paperName + s) return true
  for (const v of PDF2ZH_VARIANT_SUFFIXES) if (base === paperName + v + '.pdf') return true
  return false
}

function kindOf(paperName: string, entry: string): ArtifactKind {
  const isTmp = TMP_RE.test(entry)
  let base = entry
  if (isTmp) base = entry.slice(0, TMP_RE.exec(entry)!.index)
  if (base === paperName + '.pdf') return isTmp ? 'tmp' : 'pdf'
  for (const v of PDF2ZH_VARIANT_SUFFIXES) if (base === paperName + v + '.pdf') return isTmp ? 'tmp' : 'variant'
  if (base === paperName + '.mineru.json' || base === paperName + '.mineru.md') return isTmp ? 'tmp' : 'mineru'
  if (base === paperName + '.embeddings.json') return isTmp ? 'tmp' : 'embed'
  if (base === paperName + '.study.json') return isTmp ? 'tmp' : 'study'
  return isTmp ? 'tmp' : 'cache'
}

/** 枚举某文献在专题目录里的产物（只看文件；目录一律忽略）。 */
export function listArtifacts(topicDir: string, paperName: string): ManagedFile[] {
  const out: ManagedFile[] = []
  for (const e of readdirSync(topicDir, { withFileTypes: true })) {
    if (e.isDirectory()) continue
    if (!matchArtifactName(paperName, e.name)) continue
    const p = join(topicDir, e.name)
    let st
    try {
      st = lstatSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) continue
    out.push({ name: e.name, kind: kindOf(paperName, e.name), bytes: st.size, symlink: st.isSymbolicLink() })
  }
  // 阅读序稳定输出：先变体/缓存，`.pdf` 最后（删除与重命名都靠这个顺序；study 也要排在 .pdf 前）
  const order: ArtifactKind[] = ['variant', 'mineru', 'embed', 'study', 'cache', 'tmp', 'pdf']
  return out.sort((a, b) => (order.indexOf(a.kind) - order.indexOf(b.kind)) || a.name.localeCompare(b.name))
}

/** 校验每个目标文件都不越界（符号链接只校验链接自身所在目录）。 */
export function assertArtifactsContained(dataDir: string, topicDir: string, files: ManagedFile[]): void {
  const root = realDataDir(dataDir)
  const realTopic = realpathSync(topicDir)
  if (realTopic !== resolve(topicDir)) throw new ManageError('escape-rejected', 400, '专题目录真实路径异常，已拒绝')
  assertInside(root, realTopic)
  for (const f of files) {
    const p = join(topicDir, f.name)
    if (basename(p) !== f.name || dirname(p) !== topicDir) {
      throw new ManageError('escape-rejected', 400, `文件名非法：${f.name}`)
    }
    if (!f.symlink) {
      // 普通文件：再确认一次真实路径仍在库内（防守硬链接/替换竞态）
      let real: string
      try {
        real = realpathSync(p)
      } catch {
        continue
      }
      assertInside(root, real)
    }
    // 符号链接：只移动链接本身，绝不对 readlink 目标动手 —— 不跟随即安全
  }
}

// ── 回收站 ──────────────────────────────────────────────────────────────────

export interface TrashResult {
  /** 相对 dataDir 的回收站目录（UI 展示用，不含机器上的绝对路径） */
  trashRel: string
  /**
   * 回收站的**绝对路径** —— 冻结契约（docs/reader-ux-requirements.md §2）里的 trashDir 字段。
   * S15 口径（「响应不泄露服务端路径」）的边界在这里：**错误响应**一律不含绝对路径
   * （文案脱敏，见 host 的 stripAbsPaths），而这个**成功响应**里的字段是刻意保留的
   * 「恢复线索」——用户/脚本据此直接去回收站把文件移回来（t4 评审 O4）。
   */
  trashDir: string
  moved: string[]
}

function trashStamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/**
 * 准备一个回收站目录。**失败也要有机器可读 code**（t3-F1 / R4-F1）：
 * 以前 mkdir 的原生错误会冒泡到 host 的外层兜底 → 500 无 code，且 `EACCES: … '/abs/path'`
 * 直接把 dataDir 的绝对路径写进响应体（违反本模块自述的 S15）。这里统一转成 ManageError，
 * 文案只描述现象，绝对路径只出现在 `trashRel`（相对 dataDir，UI 展示用）。
 */
export function newTrashBundle(dataDir: string): { abs: string; rel: string } {
  const root = realDataDir(dataDir)
  const rel = join('.trash', `${trashStamp()}-${randomBytes(3).toString('hex')}`)
  const abs = join(root, rel)
  try {
    mkdirSync(abs, { recursive: true, mode: 0o700 })
  } catch (err) {
    throw new ManageError('trash-move-failed', 500, '无法准备回收站目录，已取消删除（未删除任何文件；请检查文献库目录是否可写）', {
      trashRel: rel,
      cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
    })
  }
  return { abs, rel }
}

/** 可注入的 rename 实现（仅测试用）：EBUSY/EPERM 在 Linux 上造不出来，注入是跨平台可验证的唯一办法。 */
export type RenameImpl = (from: string, to: string) => void

/**
 * 移入回收站失败时的**结构化真相**（字段都会进**错误**响应体，绝不静默）：
 * `moved` 是「回滚后**仍留在回收站**」的文件；回滚成功的文件已回到原处，因此不计入 moved 而计入
 * `rolledBack`；`remaining` 是「回滚后不在回收站」的文件（从未移动 + 已回滚）。`rollbackFailed`
 * 非空时文案必须降级成「部分文件未能回滚，请到回收站手动恢复」——把散落状态如实说清楚，不粉饰。
 *
 * **不变量（F-G）**：错误响应体只带**相对**的 `trashRel`（+ 文件名），**绝不带绝对路径**；
 * 绝对 `trashDir` 只出现在 200 成功响应里（O4 裁定：成功响应里那是刻意的恢复线索，错误响应一律脱敏）。
 */
export interface MoveFailure {
  /** 命中 EBUSY/EPERM 的文件名（其它 errno 时缺省） */
  [key: string]: unknown
  busy?: string
  moved: string[]
  remaining: string[]
  rolledBack: string[]
  rollbackFailed: string[]
  trashRel: string
  cause: string
}

/**
 * 把一批文件移入回收站。失败时**不**回退 unlink，而是：
 *   ① 先做**反向回滚**——把本次已 rename 进回收站的文件 rename 回原位（rename，不是 unlink；
 *      契约禁的是「删失败就退回真删」，回滚不违反它），让「失败 = 库没变」成为默认结果；
 *   ② 再按 errno 分类：EBUSY/EPERM（Windows 文件占用）→ 409 `file-busy` 可执行文案；
 *      其它 errno → 500 `trash-move-failed`。两种情况都带 `MoveFailure` 全量字段。
 * 回滚本身也可能失败（例如目标同时被占用）：此时**不静默**——失败的文件仍在回收站里（可恢复），
 * 如实列进 `rollbackFailed` 并给**相对**的 `trashRel`，文案降级为「未能回滚，请到回收站手动恢复」。
 */
export function moveToTrash(
  bundle: { abs: string; rel: string },
  topicDir: string,
  files: ManagedFile[],
  renameImpl: RenameImpl = renameSync,
): TrashResult {
  const moved: string[] = []
  for (const f of files) {
    const from = join(topicDir, f.name)
    try {
      renameImpl(from, join(bundle.abs, f.name))
      moved.push(f.name)
    } catch (err) {
      const cause = (err as NodeJS.ErrnoException).code ?? 'unknown'
      const busy = cause === 'EBUSY' || cause === 'EPERM'
      // ① 反向回滚（best-effort，最近移动的先回；rename 回去，绝不 unlink）
      const rolledBack: string[] = []
      const rollbackFailed: string[] = []
      for (const name of [...moved].reverse()) {
        try {
          renameImpl(join(bundle.abs, name), join(topicDir, name))
          rolledBack.push(name)
        } catch {
          rollbackFailed.push(name)
        }
      }
      const inTrash = files.filter((x) => rollbackFailed.includes(x.name)).map((x) => x.name)
      const remaining = files.filter((x) => !inTrash.includes(x.name)).map((x) => x.name)
      const failure: MoveFailure = {
        ...(busy ? { busy: f.name } : {}),
        moved: inTrash,
        remaining,
        rolledBack,
        rollbackFailed,
        // F-G：只给相对路径——错误响应永不带服务端绝对路径
        trashRel: bundle.rel,
        cause,
      }
      const tail = rollbackFailed.length === 0
        ? '本次操作已全部撤销，文献库未改变'
        : `但 ${rollbackFailed.length} 个文件未能回滚（仍在回收站，可手动恢复）：${rollbackFailed.join('、')}`
      if (busy) {
        throw new ManageError('file-busy', 409,
          `文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；${tail}`, failure)
      }
      throw new ManageError('trash-move-failed', 500, `移入回收站失败；${tail}`, failure)
    }
  }
  return { trashRel: bundle.rel, trashDir: bundle.abs, moved }
}

// ── 删除文献 ────────────────────────────────────────────────────────────────

export interface PaperDeletePlan {
  topic: string
  name: string
  files: ManagedFile[]
  totalBytes: number
  /** 回收站根（相对 dataDir）——UI 只需要这个 */
  trashRoot: string
  notDeleted: string[]
}

export function planPaperDelete(dataDir: string, topic: unknown, name: unknown): PaperDeletePlan {
  // 词法层统一走**边界类**（PR-1 的既定分层，t4 评审 [2] 的裁定）：删除/rename-from 只挡
  // 空/分隔符/`..`/NUL/保留名 `.trash`，**不**挡命名规范（前导点、超长、控制字符）。
  // 理由（实测为真）：listPapers 不过滤隐藏文件 → 手工放进库的 `.hidden.pdf` 会出现在列表里
  // 却删不掉；pdfqa 旧库与手工整理都会产生这类条目。命名规范只在**创建 / 改名-to** 时强制
  // （validateName / validateNewPaperName），即「能创建的必然能删除」。
  // realpath 层由 resolveExistingTopicDir / assertArtifactsContained 兜底（与词法层无关）。
  const paperName = validateEntryBoundary(name, 'paper')
  const topicName = validateEntryBoundary(topic, 'topic')
  const topicDir = resolveExistingTopicDir(dataDir, topicName)
  const files = listArtifacts(topicDir, paperName)
  assertArtifactsContained(dataDir, topicDir, files)
  // `.pdf` 必须是**常规文件**：符号链接不是文献（listPapers 只看常规文件，故 resolvePaper 找不到它，
  // 以前会以「文献库中找不到」的普通 Error 冒泡成 500）。这里判 404，与「合法名 + 不存在文献」一致。
  if (!files.some((f) => f.kind === 'pdf' && !f.symlink)) {
    throw new ManageError('not-found', 404, `文献不存在：${paperName}.pdf`)
  }
  return {
    topic: topicName,
    name: paperName,
    files,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    trashRoot: '.trash',
    notDeleted: [
      // 明确「会话历史不删、学习档案文件会随文献进回收站」——原文案只说「会话历史不删」，
      // 用户会以为学习进度（<文献>.study.json）也留着；实际它是派生产物，和 .txt/译文一样被移走（可恢复）。
      '伴读会话历史（保存在 dsh 会话库里，不随文献删除；学习档案文件 <文献>.study.json 随文献移入回收站，可在回收站恢复）',
      '共享翻译环境（.venv-pdf2zh）与翻译草稿目录（.pdf2zh-tmp）',
      '专题目录本身（如需删除专题请另行操作）',
    ],
  }
}

export interface PaperDeleteResult {
  ok: true
  topic: string
  name: string
  moved: string[]
  skipped: ManagedFile[]
  trashDir: string
  trashRel: string
}

export function deletePaper(dataDir: string, topic: unknown, name: unknown, renameImpl?: RenameImpl): PaperDeleteResult {
  const plan = planPaperDelete(dataDir, topic, name)
  const topicDir = resolveExistingTopicDir(dataDir, plan.topic)
  const bundle = newTrashBundle(dataDir)
  const res = moveToTrash(bundle, topicDir, plan.files, renameImpl)
  writeManifest(bundle.abs, {
    v: 1,
    kind: 'paper',
    topic: plan.topic,
    name: plan.name,
    deletedAt: new Date().toISOString(),
    files: plan.files.map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes, symlink: f.symlink })),
  })
  return {
    ok: true,
    topic: plan.topic,
    name: plan.name,
    moved: res.moved,
    skipped: plan.files.filter((f) => !res.moved.includes(f.name)),
    trashDir: res.trashDir,
    trashRel: res.trashRel,
  }
}

function writeManifest(bundleAbs: string, manifest: Record<string, unknown>): void {
  try {
    writeFileSync(join(bundleAbs, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  } catch {
    // manifest 只是给人看的恢复线索；写不了不影响删除结果
  }
}

// ── 删除专题 ────────────────────────────────────────────────────────────────

export interface TopicDeletePlan {
  name: string
  /** 非隐藏条目（>0 ⇒ 拒绝删除） */
  entries: string[]
  papers: string[]
  /** 隐藏条目（.DS_Store 等）：不阻塞删除，但也不销毁 → 一并进回收站 */
  hidden: string[]
}

export function planTopicDelete(dataDir: string, name: unknown): TopicDeletePlan {
  // 删除专题同样只做边界类校验：隐藏名专题（历史遗留）必须能删，否则是删不掉的孤儿。
  const topic = validateEntryBoundary(name, 'topic')
  const topicDir = resolveExistingTopicDir(dataDir, topic)
  const all = readdirSync(topicDir, { withFileTypes: true })
  const visible = all.filter((e) => !e.name.startsWith('.'))
  const papers = visible.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).map((e) => e.name.slice(0, -4))
  return {
    name: topic,
    entries: visible.map((e) => e.name),
    papers,
    hidden: all.filter((e) => e.name.startsWith('.')).map((e) => e.name),
  }
}

export interface TopicDeleteResult {
  ok: true
  name: string
  movedHidden: string[]
  trashDir: string | null
  trashRel: string | null
}

export function deleteTopic(dataDir: string, name: unknown, renameImpl?: RenameImpl): TopicDeleteResult {
  const plan = planTopicDelete(dataDir, name)
  if (plan.entries.length > 0) {
    throw new ManageError('topic-not-empty', 409, `专题内还有 ${plan.entries.length} 个条目（${plan.papers.length} 篇文献），请先逐篇删除`, {
      entries: plan.entries,
      papers: plan.papers,
    })
  }
  const topicDir = resolveExistingTopicDir(dataDir, plan.name)
  let movedHidden: string[] = []
  let trashDir: string | null = null
  let trashRel: string | null = null
  if (plan.hidden.length > 0) {
    // 隐藏条目（.DS_Store 等）不阻塞删除，但也绝不静默销毁 → 进回收站后再 rmdir
    const files: ManagedFile[] = plan.hidden.map((h) => {
      let bytes = 0
      let symlink = false
      try {
        const st = lstatSync(join(topicDir, h))
        bytes = st.size
        symlink = st.isSymbolicLink()
      } catch { /* 竞态：已消失 */ }
      return { name: h, kind: 'tmp', bytes, symlink }
    })
    const bundle = newTrashBundle(dataDir)
    const res = moveToTrash(bundle, topicDir, files, renameImpl)
    movedHidden = res.moved
    trashDir = res.trashDir
    trashRel = res.trashRel
    writeManifest(bundle.abs, { v: 1, kind: 'topic-hidden', topic: plan.name, deletedAt: new Date().toISOString(), files })
  }
  try {
    rmdirSync(topicDir) // 非递归：非空即失败，绝不 rm -rf
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // 只有「目录非空」才是 topic-not-empty；EACCES/EBUSY 等 errno 如实上交，
    // 由 host 的错误通道给固定文案（上游 R1 ②：errno 不回显绝对路径、不谎报原因）。
    if (typeof code === 'string' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err
    throw new ManageError('topic-not-empty', 409, '专题目录仍非空，未删除', {
      entries: readdirSync(topicDir),
      movedHidden,
      // F-G：错误响应不带绝对路径（绝对 trashDir 只留给 200 成功响应）
      trashRel,
      cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
    })
  }
  return { ok: true, name: plan.name, movedHidden, trashDir, trashRel }
}

// ── 批量清空专题（上游评论第 10 条：非空专题删除的中间态）─────────────────────
// 产品决策（上游已定）：30 篇论文的专题 = 30 次删除确认太重。清空 = **一次确认**，逐篇走
// **同一套**回收站语义（精确 stem、`.pdf` 最后移、绝不 unlink）、仍受会话/翻译前置 409 约束。
// 手输专题名确认保留在清空这一步（不放松确认强度）。

export interface TopicClearPaperPlan {
  name: string
  files: ManagedFile[]
  totalBytes: number
}

export interface TopicClearPlan {
  topic: string
  /** 逐篇清单（复用 planPaperDelete 的产物形状：files 来自 listArtifacts 的精确 stem 匹配） */
  papers: TopicClearPaperPlan[]
  papersCount: number
  filesCount: number
  totalBytes: number
  /** 隐藏条目（.DS_Store 等）：不阻塞清空，但也不销毁 → 一并进回收站 */
  hidden: string[]
  trashRoot: string
  notDeleted: string[]
}

/** 清空预览（dry-run，只读）：逐篇列出将移入回收站的产物；不写盘。 */
export function planTopicClear(dataDir: string, topic: unknown): TopicClearPlan {
  const topicName = validateEntryBoundary(topic, 'topic')
  const topicDir = resolveExistingTopicDir(dataDir, topicName)
  const papers: TopicClearPaperPlan[] = []
  for (const p of listPapers(dataDir, topicName)) {
    const files = listArtifacts(topicDir, p.name)
    assertArtifactsContained(dataDir, topicDir, files)
    // 与 planPaperDelete 同口径：`.pdf` 必须是常规文件（符号链接不是文献）
    if (!files.some((f) => f.kind === 'pdf' && !f.symlink)) continue
    papers.push({ name: p.name, files, totalBytes: files.reduce((n, f) => n + f.bytes, 0) })
  }
  const all = readdirSync(topicDir, { withFileTypes: true })
  return {
    topic: topicName,
    papers,
    papersCount: papers.length,
    filesCount: papers.reduce((n, p) => n + p.files.length, 0),
    totalBytes: papers.reduce((n, p) => n + p.totalBytes, 0),
    hidden: all.filter((e) => e.name.startsWith('.')).map((e) => e.name),
    trashRoot: TRASH_DIR,
    notDeleted: [
      '伴读会话历史（保存在 dsh 会话库里，不随文献清空；学习档案文件 <文献>.study.json 属派生产物，随文献移入回收站，可在回收站恢复）',
      '共享翻译环境（.venv-pdf2zh）与翻译草稿目录（.pdf2zh-tmp）',
      '库外文件（清空只作用于该专题目录内）',
    ],
  }
}

export interface TopicClearResult {
  ok: true
  topic: string
  /** 实际清空的篇数 */
  cleared: number
  /** 实际移入回收站的文件数 */
  movedFiles: number
  /** 一并移入回收站的隐藏条目 */
  movedHidden: string[]
  trashDir: string
  trashRel: string
}

/**
 * 清空专题：**一次**回收站 bundle，每篇一个子目录 `<bundle>/<篇名>/<文件>`（避免同名产物跨篇撞名），
 * 每篇一份 manifest + bundle 根一份总清单；全部移完后把隐藏条目移入 bundle 根，最后**非递归**
 * `rmdir` 专题目录（绝无 rm -rf）。
 *
 * 原子性口径（**不是文件系统事务，是「失败即回滚」**）：
 *   ① 任何时候都不会 unlink 用户数据（只有我们自己的 manifest 会被清掉）；
 *   ② 任一步失败 → 先把**本次请求已移动的全部文件**（含已完成篇）rename 回原位（best-effort）；
 *   ③ 回滚失败的文件如实列进 `rollbackFailed`，且**一定**在回收站里（给 trashDir/trashRel 供手动恢复）。
 */
export function clearTopic(dataDir: string, topic: unknown, renameImpl: RenameImpl = renameSync): TopicClearResult {
  const plan = planTopicClear(dataDir, topic)
  // 空专题不属于「清空」的职责（删除专题才是）——把两件事分开，避免留下一个空目录
  if (plan.papersCount === 0) {
    throw new ManageError('bad-request', 400, '专题已为空，请用删除专题', { clearEndpoint: '/api/library/delete-topic' })
  }
  const topicDir = resolveExistingTopicDir(dataDir, plan.topic)
  const bundle = newTrashBundle(dataDir)
  const done: Array<{ paper: string; sub: { abs: string; rel: string }; moved: string[] }> = []
  const stamp = new Date().toISOString()
  let failedPaper = ''
  try {
    for (const p of plan.papers) {
      failedPaper = p.name
      const sub = { abs: join(bundle.abs, p.name), rel: join(bundle.rel, p.name) }
      mkdirSync(sub.abs, { recursive: true, mode: 0o700 })
      const res = moveToTrash(sub, topicDir, p.files, renameImpl)
      done.push({ paper: p.name, sub, moved: res.moved })
      writeManifest(sub.abs, {
        v: 1, kind: 'paper', topic: plan.topic, name: p.name, deletedAt: stamp,
        files: p.files.map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes, symlink: f.symlink })),
      })
    }
    // 隐藏条目：全部文献移完后进 bundle 根（隐藏名以 `.` 开头，不会与篇名子目录撞名）
    let movedHidden: string[] = []
    if (plan.hidden.length > 0) {
      failedPaper = `.hidden`
      const files: ManagedFile[] = plan.hidden.map((h) => {
        let bytes = 0
        let symlink = false
        try {
          const st = lstatSync(join(topicDir, h))
          bytes = st.size
          symlink = st.isSymbolicLink()
        } catch { /* 竞态：已消失 */ }
        return { name: h, kind: 'tmp' as const, bytes, symlink }
      })
      movedHidden = moveToTrash(bundle, topicDir, files, renameImpl).moved
    }
    writeManifest(bundle.abs, {
      v: 1, kind: 'topic-clear', topic: plan.topic, deletedAt: stamp,
      papers: plan.papers.map((p) => ({ name: p.name, files: p.files.map((f) => f.name) })),
      hidden: plan.hidden,
    })
    failedPaper = ''
    try {
      rmdirSync(topicDir) // 非递归：非空即失败，绝不 rm -rf
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (typeof code === 'string' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err
      throw new ManageError('topic-not-empty', 409, '专题目录仍非空，未删除', {
        entries: readdirSync(topicDir), cause: code,
      })
    }
    return {
      ok: true, topic: plan.topic, cleared: done.length,
      movedFiles: done.reduce((n, d) => n + d.moved.length, 0),
      movedHidden, trashDir: bundle.abs, trashRel: bundle.rel,
    }
  } catch (err) {
    // ── 失败即回滚：把本次请求**已移动的全部文件**rename 回原位（含已完成篇）──
    const base = isManageError(err) ? err.extra : {}
    const rolledBack: string[] = []
    const rollbackFailed: string[] = []
    for (const d of [...done].reverse()) {
      for (const name of [...d.moved].reverse()) {
        try {
          renameImpl(join(d.sub.abs, name), join(topicDir, name))
          rolledBack.push(`${d.paper}/${name}`)
        } catch {
          rollbackFailed.push(`${d.paper}/${name}`)
        }
      }
    }
    // 回滚干净 → 把本次创建的回收站子目录/根目录（此时只剩我们自己的 manifest）清掉，
    // 不给用户留一个空的「回收站记录」；清不掉也不影响结果（best-effort，不覆盖上面的错误）。
    if (rollbackFailed.length === 0) {
      for (const d of done) {
        try { rmSync(join(d.sub.abs, 'manifest.json'), { force: true }); rmdirSync(d.sub.abs) } catch { /* 留着无害 */ }
      }
      try { rmSync(join(bundle.abs, 'manifest.json'), { force: true }); rmdirSync(bundle.abs) } catch { /* 留着无害 */ }
    }
    const prevRolledBack = Array.isArray(base.rolledBack) ? (base.rolledBack as string[]) : []
    const prevFailed = Array.isArray(base.rollbackFailed) ? (base.rollbackFailed as string[]) : []
    const failedPaperRolledBack = prevRolledBack.map((n) => `${failedPaper || '?'}/${n}`)
    const failedPaperFailed = prevFailed.map((n) => `${failedPaper || '?'}/${n}`)
    const allRollbackFailed = [...failedPaperFailed, ...rollbackFailed]
    const totalProcessed = done.length + (failedPaper ? 1 : 0)
    const totalRolledBack = failedPaperRolledBack.length + rolledBack.length
    const tail = allRollbackFailed.length === 0
      ? `已处理 ${totalProcessed} 篇：本次已移动的文件已全部回滚，专题内容未改变`
      : `已处理 ${totalProcessed} 篇：${totalRolledBack} 个文件已回滚，但 ${allRollbackFailed.length} 个文件未能回滚（仍在回收站，可手动恢复）：${allRollbackFailed.join('、')}`
    // F-C：**有文件没回滚时绝不保留内层那句「…已全部撤销，文献库未改变」**——它只对失败的那一篇成立，
    // 拼到整体回滚结果上就自相矛盾。内层只保留「；」之前的可执行前缀（如「文件被占用…关闭后重试」），
    // 回滚结论一律由外层的 tail 单方面给出。
    const innerRaw = isManageError(err) ? err.message : '清空中断'
    const inner = allRollbackFailed.length === 0 ? innerRaw : (innerRaw.split('；')[0] || innerRaw)
    const message = `${inner}｜${tail}`
    // F-H：字段名要说清语义——`unprocessedPapers` 只列「这次压根没轮到」的篇；
    // 「用户数据还在回收站」的篇另给 `papersWithFilesInTrash`（回滚失败时唯一能自救的清单）。
    const unprocessedPapers = plan.papers
      .map((p) => p.name)
      .filter((n) => !done.some((d) => d.paper === n) && n !== failedPaper)
    const papersWithFilesInTrash = [...new Set(allRollbackFailed.map((n) => n.split('/')[0]))]
    throw new ManageError(
      isManageError(err) ? err.code : 'trash-move-failed',
      isManageError(err) ? err.status : 500,
      message,
      {
        ...base,
        // `cleared` = 本次**真正清空**（最终仍留在回收站）的篇数：失败即回滚 ⇒ 恒为 0
        cleared: 0,
        clearedBeforeRollback: done.map((d) => d.paper),
        failedPaper: failedPaper || null,
        rolledBack: [...failedPaperRolledBack, ...rolledBack],
        rollbackFailed: allRollbackFailed,
        moved: allRollbackFailed,
        unprocessedPapers,
        papersWithFilesInTrash,
        // F-G：错误响应只给相对路径（绝对 trashDir 只留在 200 成功响应）
        trashRel: bundle.rel,
      },
    )
  }
}

// ── 重命名 ──────────────────────────────────────────────────────────────────

export interface RenameResult {
  ok: true
  moved: string[]
  from: string
  to: string
}

/**
 * 产物改名：**纯前缀拼接**，不能用 `String.replace(paperName, newName)`——
 * `newName` 里的 `$&` / `` $` `` / `$'` / `$1` 会被当成**替换模式**展开（t3-F2）：
 * 实测 10 个产物会得到各不相同的 stem、产生无法再按名删除的孤儿文件，且响应里的 `to`
 * 与磁盘不符。`listArtifacts` 保证 `f.name` 一定以 `paperName` 开头（精确 stem 匹配）。
 */
export function renamedName(fileName: string, paperName: string, newName: string): string {
  return fileName.startsWith(paperName) ? newName + fileName.slice(paperName.length) : fileName
}

/** 重命名文献：先校验全部目标，再逐个 rename；中途失败 best-effort 回滚。 */
export function renamePaper(dataDir: string, topic: unknown, name: unknown, newNameRaw: unknown, renameImpl: RenameImpl = renameSync): RenameResult {
  // rename-from（topic/name）只做边界类校验；改名**目标**名仍走命名规范类（validateNewPaperName）。
  const topicName = validateEntryBoundary(topic, 'topic')
  const paperName = validateEntryBoundary(name, 'paper')
  const topicDir = resolveExistingTopicDir(dataDir, topicName)
  const newName = validateNewPaperName(newNameRaw, paperName)
  const files = listArtifacts(topicDir, paperName)
  assertArtifactsContained(dataDir, topicDir, files)
  if (!files.some((f) => f.kind === 'pdf')) throw new ManageError('not-found', 404, `文献不存在：${paperName}.pdf`)

  // 目标名冲突预检（大小写-only 改名放行：同一文件）
  const clash: string[] = []
  for (const f of files) {
    const target = join(topicDir, renamedName(f.name, paperName, newName))
    if (!existsSync(target)) continue
    let same = false
    try {
      same = realpathSync(target) === realpathSync(join(topicDir, f.name))
    } catch { /* 目标不可读 → 视为冲突 */ }
    if (!same) clash.push(basename(target))
  }
  if (clash.length > 0) {
    throw new ManageError('target-exists', 409, `已存在同名文件：${clash.slice(0, 3).join(', ')}${clash.length > 3 ? ' …' : ''}`, { conflicts: clash })
  }

  const moved: Array<{ from: string; to: string }> = []
  for (const f of files) {
    const from = join(topicDir, f.name)
    const to = join(topicDir, renamedName(f.name, paperName, newName))
    if (from === to) continue
    try {
      renameImpl(from, to)
      moved.push({ from, to })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const busy = code === 'EBUSY' || code === 'EPERM'
      // 反向回滚（rename 回原名，绝不 unlink）；失败的文件如实记账，绝不静默
      const rolledBack: string[] = []
      const rollbackFailed: string[] = []
      for (const m of moved.reverse()) {
        try { renameImpl(m.to, m.from); rolledBack.push(basename(m.from)) } catch { rollbackFailed.push(basename(m.from)) }
      }
      const remaining = files.filter((f2) => !rollbackFailed.includes(f2.name)).map((f2) => f2.name)
      const tail = rollbackFailed.length === 0
        ? '本次改名已全部撤销，文献库未改变'
        : `但 ${rollbackFailed.length} 个文件未能回滚（仍在改名后的名字上，请手动检查）：${rollbackFailed.join('、')}`
      // EBUSY/EPERM（Windows 文件占用）→ 409 file-busy 可执行文案（上游必修 3 的语义）
      if (busy) {
        throw new ManageError('file-busy', 409, `文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；${tail}`, {
          busy: basename(from), moved: [], remaining, rolledBack, rollbackFailed, cause: code,
        })
      }
      // 其它 errno：回滚干净时原样上报（host 的错误通道给固定中文文案 400，不回显绝对路径）
      if (typeof code === 'string' && code && rollbackFailed.length === 0) throw err
      throw new ManageError('rename-partial', 500, `重命名中途失败；${tail}`, {
        moved: [], remaining, rolledBack, rollbackFailed, cause: code ?? 'unknown',
      })
    }
  }
  return { ok: true, moved: moved.map((m) => basename(m.to)), from: paperName, to: newName }
}

/** 重命名专题：目录整体 rename（专题为空时才允许？——不：目录改名与内容无关，非空也可改）。 */
export function renameTopic(dataDir: string, name: unknown, newNameRaw: unknown, renameImpl: RenameImpl = renameSync): RenameResult {
  // from 侧是已存在目录 → 边界类（历史遗留名也能改名）；to 侧是新名字 → 命名规范类。
  const topic = validateEntryBoundary(name, 'topic')
  const newTopic = validateName(newNameRaw, 'topic')
  if (newTopic === topic) throw new ManageError('bad-request', 400, '新名称与原名称相同')
  const dir = resolveExistingTopicDir(dataDir, topic)
  const root = realDataDir(dataDir)
  const target = join(root, newTopic)
  if (existsSync(target)) throw new ManageError('target-exists', 409, `已存在同名专题：${newTopic}`)
  assertInside(root, target)
  try {
    renameImpl(dir, target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Windows 文件占用（EBUSY/EPERM）→ 409 file-busy 可执行文案（上游必修 3）。
    if (code === 'EBUSY' || code === 'EPERM') {
      throw new ManageError('file-busy', 409, '文件被占用（可能正在阅读器或其他程序中打开），关闭后重试；本次改名未生效', {
        busy: newTopic, cause: code,
      })
    }
    // 其它 errno（ENAMETOOLONG/EACCES…）带上原始 .code 上交：host 的错误通道给固定中文文案 400，
    // 绝不把绝对路径回显给客户端。非 errno 才归为 rename-partial。
    if (typeof code === 'string' && code) throw err
    throw new ManageError('rename-partial', 500, '重命名专题失败', {})
  }
  return { ok: true, moved: [], from: topic, to: newTopic }
}
