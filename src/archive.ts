// archive.ts — 问答 Markdown 存档（纯函数，不依赖 Cordis）。
// 每轮问答带时间戳追加到 <文献>-qa/<会话>.md，永久留存（兼容 pdfqa 布局）。

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PaperRef } from './library.ts'

export interface QaEntry {
  question: string
  answer: string
  /** 回答引用的页码（可选） */
  pages?: number[]
  /** 时间戳，默认当前 */
  time?: Date
}

function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 追加一轮问答到会话文件；文件不存在时先写标题头。返回文件路径。 */
export async function appendQa(ref: PaperRef, session: string, entry: QaEntry): Promise<string> {
  await mkdir(ref.qaDir, { recursive: true })
  const file = join(ref.qaDir, `${session}.md`)
  try {
    await readFile(file, 'utf8')
  } catch {
    await writeFile(file, `# ${ref.name} · ${session} 问答记录\n`, 'utf8')
  }
  const time = formatTime(entry.time ?? new Date())
  const pageLine = entry.pages && entry.pages.length > 0 ? `\n> 引用页码：${[...new Set(entry.pages)].sort((a, b) => a - b).join(', ')}\n` : ''
  const body = `\n## ${time}\n\n**Q:** ${entry.question}\n${pageLine}\n**A:** ${entry.answer}\n`
  await appendFile(file, body, 'utf8')
  return file
}

/** 读会话存档内容；不存在返回 null。 */
export async function readQa(ref: PaperRef, session: string): Promise<string | null> {
  try {
    return await readFile(join(ref.qaDir, `${session}.md`), 'utf8')
  } catch {
    return null
  }
}
