// library.ts — 文献库目录约定（纯函数，不依赖 Cordis）。
//
// 布局兼容 pdfqa 的 data/ 思路：
//   <dataDir>/<专题>/<文献>.pdf          原始 PDF
//   <dataDir>/<专题>/<文献>.txt          转录缓存（清洗后的全文文本）
//   <dataDir>/<专题>/<文献>.pages.json   页码偏移表（转录时生成，检索映射页码用）
// pdf2zh 的产物（-en / -zh / -dual）不算用户文献。
// （问答不落盘存档——会话持久化交给 dsh 自己；pdfqa 时代的 -qa/ 目录不再读写。）

import { readdirSync, existsSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs'
import { join, resolve, extname, basename } from 'node:path'
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
  if (name.startsWith('.')) return '名字不能以 . 开头'
  return null
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

/** 改名专题（目录 rename）。from 不存在 / to 已存在 / 名字非法 → throw 中文 Error。
 *  已知局限：大小写不敏感文件系统（macOS/Windows）上纯大小写改名会被「目标已存在」
 *  拒绝——不做临时名两跳绕过，保持简单。 */
export function renameTopic(dataDir: string, from: string, to: string): void {
  const err = validateEntryName(to)
  if (err) throw new Error(err)
  if (to.trim() === from) return
  const src = join(dataDir, from)
  if (!existsSync(src)) throw new Error(`专题不存在: ${from}`)
  const dst = join(dataDir, to.trim())
  if (existsSync(dst)) throw new Error(`已存在同名专题: ${to.trim()}`)
  renameSync(src, dst)
}

/** 改名文献：连带派生文件（转录/页码索引/译文/学习档案）逐个跟随，不存在的跳过。
 *  返回实际改名的文件名清单（含 .pdf 本体）。 */
export function renamePaper(dataDir: string, topic: string, from: string, to: string): string[] {
  const err = validateEntryName(to)
  if (err) throw new Error(err)
  to = to.trim()
  if (to === from) return []
  const dir = join(dataDir, topic)
  if (!existsSync(join(dir, from + '.pdf'))) throw new Error(`文献不存在: ${topic}/${from}`)
  if (existsSync(join(dir, to + '.pdf'))) throw new Error(`已存在同名文献: ${to}`)
  const renamed: string[] = []
  for (const suf of PAPER_SIDECARS) {
    const src = join(dir, from + suf)
    if (!existsSync(src)) continue
    renameSync(src, join(dir, to + suf))
    renamed.push(from + suf)
  }
  return renamed
}

/** 删除文献及其全部派生文件。返回实际删除的文件名清单。 */
export function deletePaper(dataDir: string, topic: string, name: string): string[] {
  const dir = join(dataDir, topic)
  const pdfPath = join(dir, name + '.pdf')
  if (!existsSync(pdfPath)) throw new Error(`文献不存在: ${topic}/${name}`)
  const deleted: string[] = []
  for (const f of derivedFilesFor(pdfPath)) {
    if (!existsSync(f)) continue
    rmSync(f)
    deleted.push(basename(f))
  }
  return deleted
}

/** 删除专题（递归，含其下全部文献与派生文件）。 */
export function deleteTopic(dataDir: string, topic: string): void {
  const dir = join(dataDir, topic)
  if (!existsSync(dir)) throw new Error(`专题不存在: ${topic}`)
  rmSync(dir, { recursive: true, force: true })
}
