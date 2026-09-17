// library.ts — 文献库目录约定（纯函数，不依赖 Cordis）。
//
// 布局兼容 pdfqa 的 data/ 思路：
//   <dataDir>/<专题>/<文献>.pdf          原始 PDF
//   <dataDir>/<专题>/<文献>.txt          转录缓存（清洗后的全文文本）
//   <dataDir>/<专题>/<文献>.pages.json   页码偏移表（转录时生成，检索映射页码用）
//   <dataDir>/<专题>/<文献>-qa/<会话>.md 问答存档
// pdf2zh 的产物（-en / -zh / -dual）不算用户文献。

import { readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
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
  /** 问答存档目录 */
  qaDir: string
}

const PDF2ZH_SUFFIXES = ['-en', '-zh', '-dual']

/** 判定是否为用户文献：排除 pdf2zh 的中间/产出文件。 */
export function isPaperPDF(filename: string): boolean {
  if (!filename.toLowerCase().endsWith('.pdf')) return false
  const stem = filename.slice(0, -extname(filename).length)
  return !PDF2ZH_SUFFIXES.some((s) => stem.endsWith(s))
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
    qaDir: base + '-qa',
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
