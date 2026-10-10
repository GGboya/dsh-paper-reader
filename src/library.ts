// library.ts — 文献库目录约定（纯函数，不依赖 Cordis）。
//
// 布局兼容 pdfqa 的 data/ 思路：
//   <dataDir>/<专题>/<文献>.pdf          原始 PDF
//   <dataDir>/<专题>/<文献>.txt          转录缓存（清洗后的全文文本）
//   <dataDir>/<专题>/<文献>.pages.json   页码偏移表（转录时生成，检索映射页码用）
// pdf2zh 的产物（-en / -zh / -dual）不算用户文献。
// （问答不落盘存档——会话持久化交给 dsh 自己；pdfqa 时代的 -qa/ 目录不再读写。）

import { readdirSync, existsSync, mkdirSync, statSync, renameSync, rmSync, realpathSync, lstatSync } from 'node:fs'
import { join, resolve, extname, basename, sep } from 'node:path'
import { homedir } from 'node:os'

export interface PaperRef {
  /** 专题名（dataDir 下一级目录）；path 直指时为其所在目录名 */
  topic: string
  /** 文献名（去掉 .pdf 后缀） */
  name: string
  /** PDF 绝对路径 */
  pdfPath: string
  /** 转录缓存路径 */
  txtPath: string
  /** 页码偏移表路径 */
  pagesPath: string
}

const PDF2ZH_SUFFIXES = ['-en', '-zh', '-dual']

/** 判定是否为用户文献：排除 pdf2zh 的中间/产出文件。 */
export function isPaperPDF(filename: string): boolean {
  if (!filename.toLowerCase().endsWith('.pdf')) return false
  const stem = filename.slice(0, -extname(filename).length)
  return !PDF2ZH_SUFFIXES.some((s) => stem.endsWith(s))
}

/** dsh home：$DSH_HOME > ~/.dsh（与 dsh-home-paths 的解析顺序一致）。 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv || join(homedir(), '.dsh')
}

/** 解析数据目录：显式配置 > 环境变量 > 默认 ~/.dsh-paper-reader/data */
export function resolveDataDir(configured?: string): string {
  const dir = configured ?? process.env['DSH_PAPER_READER_DATA'] ?? join(homedir(), '.dsh-paper-reader', 'data')
  const abs = resolve(dir)
  mkdirSync(abs, { recursive: true })
  return abs
}

/** 列出专题（一级子目录，跳过隐藏目录）。 */
export function listTopics(dataDir: string): string[] {
  if (!existsSync(dataDir)) return []
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/** 列出某专题下的文献名（不含后缀）；topic 省略时跨全部专题。 */
export function listPapers(dataDir: string, topic?: string): Array<{ topic: string; name: string }> {
  const topics = topic ? [topic] : listTopics(dataDir)
  const out: Array<{ topic: string; name: string }> = []
  for (const t of topics) {
    const dir = join(dataDir, t)
    if (!existsSync(dir)) continue
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && isPaperPDF(e.name)) {
        out.push({ topic: t, name: e.name.slice(0, -4) })
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function refFor(topic: string, name: string, pdfPath: string): PaperRef {
  const base = pdfPath.slice(0, -extname(pdfPath).length)
  return {
    topic,
    name,
    pdfPath,
    txtPath: base + '.txt',
    pagesPath: base + '.pages.json',
  }
}

/**
 * 解析文献：三种方式
 *  1. path 绝对/相对路径直指 PDF
 *  2. topic + name 在专题目录里找 <name>.pdf
 *  3. 只有 name 时跨专题找，同名多篇报歧义
 */
export function resolvePaper(
  dataDir: string,
  args: { path?: string; topic?: string; name?: string },
): PaperRef {
  if (args.path) {
    const abs = resolve(args.path)
    if (!existsSync(abs)) throw new Error(`PDF 不存在: ${abs}`)
    const name = basename(abs, extname(abs))
    return refFor(basename(join(abs, '..')), name, abs)
  }
  if (!args.name) throw new Error('需要 path 或 name 参数定位文献')
  const name = args.name.replace(/\.pdf$/i, '')
  const candidates = listPapers(dataDir, args.topic).filter((p) => p.name === name)
  if (candidates.length === 0) {
    const hint = listPapers(dataDir).map((p) => `${p.topic}/${p.name}`).join(', ')
    throw new Error(`文献库中找不到 "${name}"。现有文献: ${hint || '(空)'}`)
  }
  if (candidates.length > 1) {
    throw new Error(`"${name}" 命中多篇: ${candidates.map((c) => c.topic).join(', ')}，请用 topic 参数限定`)
  }
  const hit = candidates[0]!
  return refFor(hit.topic, hit.name, join(dataDir, hit.topic, hit.name + '.pdf'))
}

/** 转录缓存是否可用（存在且非空）。 */
export function transcriptCached(ref: PaperRef): boolean {
  try {
    return statSync(ref.txtPath).size > 1000
  } catch {
    return false
  }
}

// ================= 库管理：改名/删除（纯文件系统操作，供 host 路由调用） =================

/** 名字校验（专题/文献共用）。合法返回 null，否则返回中文错误文案。 */
export function validateEntryName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '名字不能为空'
  if (name.length > 120) return '名字过长（最多 120 个字符）'
  if (/[\\/]|\.\./.test(name)) return '名字不能包含 / \\ 或 ..'
  if (/[\u0000-\u001f\u007f]/.test(name)) return '名字不能包含控制字符'
  if (name.startsWith('.')) return '名字不能以 . 开头'
  return null
}

/**
 * 边界类名字校验（删除/改名-from 用）：只挡安全边界——空、分隔符/..、NUL。
 * 与 validateEntryName 的分工：命名规范类（长度上限、前导点、非 NUL 控制字符）只在创建/改名时
 * 强制（那是用户在起名字）；删除是对已存在文件的操作——upload 能创建的名字（前导点、超长、
 * \x01 等控制字符）必须能删，否则会成为无法清理的孤儿。NUL 必须挡：它会让 Node fs 抛
 * ERR_INVALID_ARG_VALUE 并把绝对路径带进错误文案（错误回显卫生）。
 */
export function validateEntryBoundary(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '名字不能为空'
  if (/[\\/]|\.\./.test(name)) return '名字不能包含 / \\ 或 ..'
  if (name.includes('\u0000')) return '名字不能包含控制字符'
  return null
}

// ================= 路径穿越防护（词法 + realpath 子路径双层） =================
// 这些 CRUD 原语以前只对 `to` 做过校验，`topic`/`name`/`from` 直接 `join(dataDir, x)`：
// `../sentinel` 这类输入会让 rmSync/renameSync 作用于 dataDir 之外的目录（可递归强制删除）。
// 这里补两层结构性防护：① 词法层（validateEntryName 拒绝 / \ .. 与隐藏名）；② realpath
// 层（目标目录的 real 路径必须落在 dataDir 的 real 路径之内，挡住 `..` 之外的符号链接逃逸）。

/** dataDir 的 real 绝对路径（resolve + realpath，去符号链接与 `..`）。目录缺失时给无路径文案。 */
function realDataDir(dataDir: string): string {
  const abs = resolve(dataDir)
  if (!existsSync(abs)) throw new Error('文献库数据目录不存在')
  return realpathSync(abs)
}

/** target 必须落在 root 之内（严格子路径，不含 root 本身），否则视为越界。 */
function assertInside(root: string, target: string): void {
  const r = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(r)) throw new Error('路径越界，已拒绝')
}

/**
 * 安全解析专题目录：词法校验 + realpath 严格子路径包含。
 * 返回可直接 rename/delete 的目录路径（join 后的路径，非 realpath——顶层符号链接对
 * rmSync/renameSync 只操作链接本身，不跟随，语义保持不变）。任何调用方（不只路由）
 * 传入越界 topic 都会被拒：`..`、绝对路径、`a/../b`、指向库外的符号链接等。
 */
function resolveSafeTopic(dataDir: string, topic: string): string {
  const err = validateEntryName(topic)
  if (err) throw new Error(err)
  const root = realDataDir(dataDir)
  const dir = join(root, topic.trim())
  if (!existsSync(dir)) throw new Error(`专题不存在: ${topic.trim()}`)
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    throw new Error(`专题不存在: ${topic.trim()}`)
  }
  assertInside(root, real)
  return dir
}

/**
 * 安全解析「待创建」的专题目录（upload 用）：词法校验 + realpath 严格子路径包含。
 * 与 resolveSafeTopic 不同：专题可以尚不存在（upload 会 mkdir 创建），但已存在的条目
 * （目录/文件/符号链接）仍必须 realpath 落在 dataDir 之内——挡住「data/evil → 库外」这类
 * 符号链接逃逸写。返回可直接 mkdir/writeFile 的目录路径（join 后的路径，非 realpath）。
 */
export function resolveUploadTopic(dataDir: string, topic: string): string {
  const err = validateEntryName(topic)
  if (err) throw new Error(err)
  const root = realDataDir(dataDir)
  const dir = join(root, topic.trim())
  let exists = false
  try {
    lstatSync(dir) // lstat 不跟随符号链接：悬空链接也算「已存在」，交给 realpath 兜底
    exists = true
  } catch {
    exists = false
  }
  if (!exists) return dir // 尚不存在：mkdir(recursive) 会创建真实目录（词法层已保证无分隔符/../隐藏名）
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    throw new Error(`专题不存在: ${topic.trim()}`)
  }
  assertInside(root, real)
  return dir
}

/** 构造文献引用（不做存在性校验；给只按路径判定的调用方用，如翻译 busy 检查）。 */
export function paperRefFor(dataDir: string, topic: string, name: string): PaperRef {
  const pdfPath = join(dataDir, topic, name + '.pdf')
  const base = pdfPath.slice(0, -'.pdf'.length)
  return { topic, name, pdfPath, txtPath: base + '.txt', pagesPath: base + '.pages.json' }
}

/** 文献的全部关联文件后缀（含本体 .pdf）：转录缓存 + 页码索引 + babeldoc 译文 + 学习档案。
 *  命名与 translate.ts（-zh/-dual）和 study.ts（.study.json）的产物规则一致。 */
const PAPER_SIDECARS = ['.pdf', '.txt', '.pages.json', '-zh.pdf', '-dual.pdf', '.study.json']

/** 某文献的全部关联文件路径（存在与否由调用方自查）。 */
export function derivedFilesFor(pdfPath: string): string[] {
  const stem = pdfPath.slice(0, -'.pdf'.length)
  return PAPER_SIDECARS.map((s) => stem + s)
}

/** 改名专题（目录 rename）。from/to 非法（含越界）→ throw；from 不存在 / to 已存在 → throw 中文 Error。
 *  已知局限：大小写不敏感文件系统（macOS/Windows）上纯大小写改名会被「目标已存在」
 *  拒绝——不做临时名两跳绕过，保持简单。 */
export function renameTopic(dataDir: string, from: string, to: string): void {
  const err = validateEntryName(to)
  if (err) throw new Error(err)
  if (to.trim() === from.trim()) return
  const src = resolveSafeTopic(dataDir, from)          // 词法 + realpath 子路径校验 from
  const dst = join(realDataDir(dataDir), to.trim())
  if (existsSync(dst)) throw new Error(`已存在同名专题: ${to.trim()}`)
  renameSync(src, dst)
}

/** 改名文献：连带派生文件（转录/页码索引/译文/学习档案）逐个跟随，不存在的跳过。
 *  返回实际改名的文件名清单（含 .pdf 本体）。topic/from/to 非法（含越界）→ throw。 */
export function renamePaper(dataDir: string, topic: string, from: string, to: string): string[] {
  const errTo = validateEntryName(to)
  if (errTo) throw new Error(errTo)
  const errFrom = validateEntryBoundary(from)
  if (errFrom) throw new Error(errFrom)
  const toTrim = to.trim()
  const fromTrim = from.trim()
  if (toTrim === fromTrim) return []
  const dir = resolveSafeTopic(dataDir, topic)          // 词法 + realpath 子路径校验 topic
  if (!existsSync(join(dir, fromTrim + '.pdf'))) throw new Error(`文献不存在: ${topic.trim()}/${fromTrim}`)
  if (existsSync(join(dir, toTrim + '.pdf'))) throw new Error(`已存在同名文献: ${toTrim}`)
  const renamed: string[] = []
  for (const suf of PAPER_SIDECARS) {
    const src = join(dir, fromTrim + suf)
    if (!existsSync(src)) continue
    renameSync(src, join(dir, toTrim + suf))
    renamed.push(fromTrim + suf)
  }
  return renamed
}

/** 删除文献及其全部派生文件。返回实际删除的文件名清单。topic/name 非法（含越界）→ throw。 */
export function deletePaper(dataDir: string, topic: string, name: string): string[] {
  const errName = validateEntryBoundary(name)
  if (errName) throw new Error(errName)
  const dir = resolveSafeTopic(dataDir, topic)          // 词法 + realpath 子路径校验 topic
  const nameTrim = name.trim()
  const pdfPath = join(dir, nameTrim + '.pdf')
  if (!existsSync(pdfPath)) throw new Error(`文献不存在: ${topic.trim()}/${nameTrim}`)
  const deleted: string[] = []
  for (const f of derivedFilesFor(pdfPath)) {
    if (!existsSync(f)) continue
    rmSync(f)
    deleted.push(basename(f))
  }
  return deleted
}

/** 删除专题（递归，含其下全部文献与派生文件）。topic 非法（含越界）→ throw（不触碰库外）。 */
export function deleteTopic(dataDir: string, topic: string): void {
  const dir = resolveSafeTopic(dataDir, topic)
  rmSync(dir, { recursive: true, force: true })
}
