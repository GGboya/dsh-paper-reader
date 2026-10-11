// library.ts — 文献库目录约定（纯函数，不依赖 Cordis）。
//
// 布局兼容 pdfqa 的 data/ 思路：
//   <dataDir>/<专题>/<文献>.pdf          原始 PDF
//   <dataDir>/<专题>/<文献>.txt          转录缓存（清洗后的全文文本）
//   <dataDir>/<专题>/<文献>.pages.json   页码偏移表（转录时生成，检索映射页码用）
// pdf2zh 的产物（-en / -zh / -dual）不算用户文献。
// （问答不落盘存档——会话持久化交给 dsh 自己；pdfqa 时代的 -qa/ 目录不再读写。）

import { readdirSync, existsSync, mkdirSync, statSync, realpathSync, lstatSync } from 'node:fs'
import { join, resolve, extname, basename, sep } from 'node:path'
import { homedir } from 'node:os'
// 破坏性原语与回收站实现（我们的加固层）：适配器只做「复用 #4 边界层 + 翻译签名/返回形状」，
// 真正的删除/改名永远只有 library-manage 一份实现。
import * as manage from './library-manage.ts'

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
  /** 来源标记 + 提交标记（MinerU 接入后新增；缺失=legacy） */
  transcriptPath: string
  /** MinerU Markdown 富产物 */
  mineruMdPath: string
  /** MinerU content_list 富产物 */
  mineruJsonPath: string
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
    transcriptPath: base + '.transcript.json',
    mineruMdPath: base + '.mineru.md',
    mineruJsonPath: base + '.mineru.json',
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


// ═══════════════════════════════════════════════════════════════════════════
// 边界校验层（词法 + realpath 子路径双层）—— **逐字复用上游 #4**
// （d8f24ec《fix(security)：路径穿越修复》）的实现，作为唯一实现：
//   · library-manage.ts 的破坏性原语消费它（命名规范 / 边界规范 / realpath 断言）；
//   · host.ts 的路由层消费它（badEntry 词法门 + upload 的 resolveUploadTopic）。
// PR #5 整合时我们曾用自己那套「整段替换」掉这一层，代价是丢掉 #4 的两处覆盖
// （悬空符号链接的写路径、trim 语义）与上游 35 个用例中的 29 个。按上游评审 A.1 的
// 要求「复用 #4 的边界校验层，在其上加回收站与交互层」，此处恢复为单一实现；
// 我们的加严（符号链接专题一律拒、`target === root` 拒绝、产物逐个 realpath 二次包含）
// 全部加在这一层**之上**（见 library-manage.ts），不替换、不旁路。
// ═══════════════════════════════════════════════════════════════════════════

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
export function realDataDir(dataDir: string): string {
  const abs = resolve(dataDir)
  if (!existsSync(abs)) throw new Error('文献库数据目录不存在')
  return realpathSync(abs)
}

/** target 必须落在 root 之内（严格子路径，不含 root 本身），否则视为越界。 */
export function assertInside(root: string, target: string): void {
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
  return {
    topic,
    name,
    pdfPath,
    txtPath: base + '.txt',
    pagesPath: base + '.pages.json',
    transcriptPath: base + '.transcript.json',
    mineruMdPath: base + '.mineru.md',
    mineruJsonPath: base + '.mineru.json',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 兼容适配器（薄壳）：只为上游 6 个 `library-*.test.mjs` 与老调用方保留上游的
// 函数签名 / 返回形状；底层永远是 library-manage 的加固实现
// （回收站可恢复 + 精确 stem + 非递归 rmdir；会话/翻译/在途 409 在路由层）。
// 每个适配器都**先过上面那一层**（词法 validateEntryName/validateEntryBoundary →
// realpath resolveSafeTopic），再交给加固层——顺序固定，两层的语义不互相替代。
// ═══════════════════════════════════════════════════════════════════════════

/** 边界层错误 → 带机器码的普通 Error（保留上游用例断言的 `e.message`）。 */
function boundaryError(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { code?: string }).code = message.includes('路径越界') ? 'escape-rejected' : 'bad-name'
  return err
}

/** 删除文献（上游签名）：词法-边界层 + realpath 层 → 加固层移入 `.trash/`；返回被移动的文件名清单。 */
export function deletePaper(dataDir: string, topic: string, name: string): string[] {
  const errName = validateEntryBoundary(name)
  if (errName) throw boundaryError(errName)
  const topicName = topic.trim()
  resolveSafeTopic(dataDir, topicName)          // realpath 第二层：专题必须落在 dataDir 内
  return manage.deletePaper(dataDir, topicName, name).moved
}

/** 删除专题（上游签名）：仅空专题；隐藏条目进回收站；非递归 rmdir（绝无 rm -rf）。 */
export function deleteTopic(dataDir: string, topic: string): void {
  const err = validateEntryName(topic)
  if (err) throw boundaryError(err)
  const topicName = topic.trim()
  resolveSafeTopic(dataDir, topicName)
  manage.deleteTopic(dataDir, topicName)        // 非空 → 抛 409 topic-not-empty（我们的产品决策）
}

/** 重命名专题（上游签名）：`to` 走命名规范层，`from` 走 realpath 层。 */
export function renameTopic(dataDir: string, from: string, to: string): void {
  const err = validateEntryName(to)
  if (err) throw boundaryError(err)
  const fromName = from.trim()
  const toName = to.trim()
  if (fromName === toName) return
  resolveSafeTopic(dataDir, fromName)
  manage.renameTopic(dataDir, fromName, toName)
}

/**
 * 重命名文献（上游签名）：返回**改名前的**文件名清单（上游用例据此断言，如 `['CaseA.pdf']`）。
 * `from` 走边界层（历史丑名也能改），`to` 走命名规范层；产物清单由加固层的精确 stem 匹配给出。
 */
export function renamePaper(dataDir: string, topic: string, from: string, to: string): string[] {
  const errTo = validateEntryName(to)
  if (errTo) throw boundaryError(errTo)
  const errFrom = validateEntryBoundary(from)
  if (errFrom) throw boundaryError(errFrom)
  const topicName = topic.trim()
  const fromName = from.trim()
  const toName = to.trim()
  if (fromName === toName) return []
  resolveSafeTopic(dataDir, topicName)
  const topicDir = manage.resolveExistingTopicDir(dataDir, topicName)
  const before = manage.listArtifacts(topicDir, fromName).map((f) => f.name)
  manage.renamePaper(dataDir, topicName, fromName, toName)
  return before
}
