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

import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync, existsSync } from 'node:fs'
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

/**
 * 「文件被占用」类 errno（Windows 上阅读器/其他程序正打开着目标文件时，
 * rename 会失败于 EBUSY 或 EPERM）。
 *
 * 用途：上游 v1.3.0 的 `fsError` 把这两个 errno 映射成 **HTTP 409 + 可读文案**（可重试），
 * 我们的加固实现把它们包成 `trash-move-failed`(500) / `rename-partial`(500)（t4 评审 O6 指出的
 * 行为变化）。409 才是「换一下再试就行」的正确语义，故 host 的 `manageFail` 用本判据把它补回来；
 * 判据独立成函数是为了可单测（Linux CI 上造不出真实 EBUSY）。
 */
export function isBusyErrno(cause: unknown): boolean {
  return cause === 'EBUSY' || cause === 'EPERM'
}

// ── 名称校验 ────────────────────────────────────────────────────────────────

/** 回收站目录名（保留名；`listTopics` 因隐藏而跳过它，因此不会显示成专题）。 */
export const TRASH_DIR = '.trash'

/** 与 host 的「新建专题」校验保持同一口径：拒绝 `/`、`\`、`..`；另加隐藏名与长度上限。 */
export function validateName(raw: unknown, label: 'topic' | 'paper'): string {
  const what = label === 'topic' ? '专题名' : '文献名'
  if (typeof raw !== 'string' || raw.length === 0) throw new ManageError('bad-name', 400, `${what}不能为空`)
  if (raw.length > 255) throw new ManageError('bad-name', 400, `${what}过长（>255）`)
  if (raw.trim().length === 0) throw new ManageError('bad-name', 400, `${what}不能只有空白`)
  if (raw === '.' || raw === '..') throw new ManageError('bad-name', 400, `${what}非法`)
  if (/[/\\\u0000]/.test(raw)) throw new ManageError('bad-name', 400, `${what}不能包含 / \\ 或空字符`)
  if (raw.includes('..')) throw new ManageError('bad-name', 400, `${what}不能包含 ..`)
  if (raw.startsWith('.')) throw new ManageError('bad-name', 400, `${what}不能以 . 开头`)
  if (basename(raw) !== raw) throw new ManageError('bad-name', 400, `${what}非法`)
  return raw
}

/**
 * 边界类校验（删除 / 改名-from / 已存在条目用）：只挡**安全边界**——空、路径分隔符、`..`、NUL。
 *
 * 与 `validateName`（命名规范类：长度、前导点、控制字符）的分工是 PR-1 的分层原则：
 * 命名规范只在**创建/改名**时强制（那是用户在新起一个名字）；删除/改名-from 作用于
 * **已存在**的条目，若也按命名规范卡，「创建时宽松、事后规范收紧」或历史遗留的名字
 * （前导点、超长、`\x01`）就会变成删不掉的孤儿。反之，凡是能通过写入路径（upload /
 * 新建专题，都走 `validateName`）落到盘上的名字，都能被这里放行 → 创建/删除对称。
 *
 * 原样返回 raw（**不 trim**），与 `validateName` 一致：保证按字面名匹配磁盘条目。
 */
export function validateEntryBoundary(raw: unknown, label: 'topic' | 'paper'): string {
  const what = label === 'topic' ? '专题名' : '文献名'
  if (typeof raw !== 'string' || raw.length === 0) throw new ManageError('bad-name', 400, `${what}不能为空`)
  if (raw.trim().length === 0) throw new ManageError('bad-name', 400, `${what}不能只有空白`)
  if (/[/\\\u0000]/.test(raw)) throw new ManageError('bad-name', 400, `${what}不能包含 / \\ 或空字符`)
  if (raw.includes('..')) throw new ManageError('bad-name', 400, `${what}不能包含 ..`)
  if (raw === '.') throw new ManageError('bad-name', 400, `${what}非法`)
  if (basename(raw) !== raw) throw new ManageError('bad-name', 400, `${what}非法`)
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

/** target 必须落在 root 内（严格子路径），否则视为越界。 */
export function assertInside(root: string, target: string): void {
  const r = root.endsWith(sep) ? root : root + sep
  if (target === root || !target.startsWith(r)) {
    throw new ManageError('escape-rejected', 400, '路径越出文献库根目录，已拒绝')
  }
}

/** 文献库根目录的真实路径（必须存在）。 */
export function realDataDir(dataDir: string): string {
  try {
    return realpathSync(dataDir)
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
  if (st.isSymbolicLink()) throw new ManageError('escape-rejected', 400, `专题目录是符号链接，拒绝操作：${name}`)
  if (!st.isDirectory()) throw new ManageError('not-found', 404, `专题不存在：${name}`)
  const real = realpathSync(dir)
  if (real !== dir) throw new ManageError('escape-rejected', 400, `专题目录真实路径异常，拒绝操作：${name}`)
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

/**
 * 把一批文件移入回收站。失败时**不**回退 unlink：抛 trash-move-failed 并带上
 * 已移动/未移动清单，由调用方原样回报给用户（回收站里的文件可人工恢复）。
 */
export function moveToTrash(bundle: { abs: string; rel: string }, topicDir: string, files: ManagedFile[]): TrashResult {
  const moved: string[] = []
  for (const f of files) {
    const from = join(topicDir, f.name)
    try {
      renameSync(from, join(bundle.abs, f.name))
      moved.push(f.name)
    } catch (err) {
      const remaining = files.filter((x) => !moved.includes(x.name)).map((x) => x.name)
      throw new ManageError('trash-move-failed', 500, '移入回收站失败，未删除任何文件（已移动的文件都在回收站里，可人工恢复）', {
        moved,
        remaining,
        trashDir: bundle.abs,
        trashRel: bundle.rel,
        cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
      })
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
  // 词法层分两档（见 validateEntryBoundary 的分工说明）：
  //   · 文献名 = 命名规范类（validateName）——写入路径（upload / rename 的 to 侧）都走它，
  //     「能创建的必然能删除」已由同一口径闭合；且既有断言明确要求 `.hidden`/超长名在
  //     删除·改名路由上被拒 400（reader-ux C6 / VA14 / VB4），不能放行。
  //   · 专题名 = 边界类——只挡空/分隔符/`..`/NUL/保留名（`.trash`），让历史遗留的
  //     不规范专题目录（`.legacy`、含 `\x01`）仍可被删除，不产生「删不掉的孤儿」。
  // realpath 层由 resolveExistingTopicDir / assertArtifactsContained 兜底（与词法层无关）。
  const paperName = validateName(name, 'paper')
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

export function deletePaper(dataDir: string, topic: unknown, name: unknown): PaperDeleteResult {
  const plan = planPaperDelete(dataDir, topic, name)
  const topicDir = resolveExistingTopicDir(dataDir, plan.topic)
  const bundle = newTrashBundle(dataDir)
  const res = moveToTrash(bundle, topicDir, plan.files)
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

export function deleteTopic(dataDir: string, name: unknown): TopicDeleteResult {
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
    const res = moveToTrash(bundle, topicDir, files)
    movedHidden = res.moved
    trashDir = res.trashDir
    trashRel = res.trashRel
    writeManifest(bundle.abs, { v: 1, kind: 'topic-hidden', topic: plan.name, deletedAt: new Date().toISOString(), files })
  }
  try {
    rmdirSync(topicDir) // 非递归：非空即失败，绝不 rm -rf
  } catch (err) {
    throw new ManageError('topic-not-empty', 409, '专题目录仍非空，未删除', {
      entries: readdirSync(topicDir),
      movedHidden,
      trashDir,
      trashRel,
      cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
    })
  }
  return { ok: true, name: plan.name, movedHidden, trashDir, trashRel }
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
export function renamePaper(dataDir: string, topic: unknown, name: unknown, newNameRaw: unknown): RenameResult {
  // 文献名/新名 = 命名规范类（与写入路径同口径）；专题选择子 = 边界类（同 planPaperDelete）。
  const topicName = validateEntryBoundary(topic, 'topic')
  const paperName = validateName(name, 'paper')
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
      renameSync(from, to)
      moved.push({ from, to })
    } catch (err) {
      for (const m of moved.reverse()) {
        try { renameSync(m.to, m.from) } catch { /* 回滚失败：如实报告 */ }
      }
      throw new ManageError('rename-partial', 500, '重命名中途失败，已尝试回滚；请检查文献库', {
        moved: moved.map((m) => basename(m.to)),
        remaining: files.filter((f2) => !moved.some((m) => basename(m.to) === renamedName(f2.name, paperName, newName))).map((f2) => f2.name),
        cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
      })
    }
  }
  return { ok: true, moved: moved.map((m) => basename(m.to)), from: paperName, to: newName }
}

/** 重命名专题：目录整体 rename（专题为空时才允许？——不：目录改名与内容无关，非空也可改）。 */
export function renameTopic(dataDir: string, name: unknown, newNameRaw: unknown): RenameResult {
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
    renameSync(dir, target)
  } catch (err) {
    throw new ManageError('rename-partial', 500, '重命名专题失败', { cause: (err as NodeJS.ErrnoException).code ?? 'unknown' })
  }
  return { ok: true, moved: [], from: topic, to: newTopic }
}
