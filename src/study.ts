// study.ts — 学习档案（纯函数，不依赖 Cordis）。
// 每篇论文一个 <文献>.study.json，存在文献旁边：阅读计划（分步状态）+ 历次检验分数。
// 这是结构化状态（教学进度），不是会话流水——dsh 的会话存储替代不了，agent 经工具读写。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PaperRef } from './library.ts'

export interface PlanStep {
  id: number
  /** 这一步做什么：读哪几页 / 理解哪个概念 / 回答哪个思考题 */
  title: string
  status: 'pending' | 'current' | 'done'
  /** 完成时的点评/小结（老师写） */
  note?: string
}

export interface QuizRecord {
  /** ISO 时间 */
  time: string
  score: number
  total: number
  /** 这次检验考了什么、学生薄弱点在哪 */
  summary?: string
}

export interface StudyRecord {
  paper: string // topic/name
  plan: PlanStep[]
  quizzes: QuizRecord[]
}

export function studyPathFor(ref: PaperRef): string {
  return ref.pdfPath.slice(0, -4) + '.study.json'
}

/** 读学习档案；不存在或损坏返回 null。 */
export async function readStudy(ref: PaperRef): Promise<StudyRecord | null> {
  try {
    const raw = await readFile(studyPathFor(ref), 'utf8')
    const data = JSON.parse(raw) as StudyRecord
    if (!Array.isArray(data.plan) || !Array.isArray(data.quizzes)) return null
    return data
  } catch {
    return null
  }
}

async function writeStudy(ref: PaperRef, record: StudyRecord): Promise<string> {
  const file = studyPathFor(ref)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return file
}

/** 制定/重置阅读计划：第一步置为 current，其余 pending。 */
export async function setPlan(ref: PaperRef, steps: string[]): Promise<StudyRecord> {
  if (steps.length === 0) throw new Error('计划不能为空')
  const prev = await readStudy(ref)
  const record: StudyRecord = {
    paper: `${ref.topic}/${ref.name}`,
    plan: steps.map((title, i) => ({ id: i + 1, title, status: i === 0 ? 'current' : 'pending' })),
    quizzes: prev?.quizzes ?? [], // 重新制定计划不清历史成绩
  }
  await writeStudy(ref, record)
  return record
}

/** 完成某一步（可附点评），并把下一步置为 current。 */
export async function completeStep(ref: PaperRef, stepId: number, note?: string): Promise<StudyRecord> {
  const record = await readStudy(ref)
  if (!record) throw new Error('还没有学习计划，先用 action=set_plan 制定')
  const step = record.plan.find((s) => s.id === stepId)
  if (!step) throw new Error(`计划里没有第 ${stepId} 步（共 ${record.plan.length} 步）`)
  step.status = 'done'
  if (note) step.note = note
  // 归一化：current 只能有一个（第一个未完成的步骤），其余一律 pending。
  // 补记/乱序完成时否则会出现多个 current（先 complete 2 再 complete 1：1 曾滞留 current）。
  let firstOpen = true
  for (const s of record.plan) {
    if (s.status === 'done') continue
    if (firstOpen) { s.status = 'current'; firstOpen = false } else s.status = 'pending'
  }
  await writeStudy(ref, record)
  return record
}

/** 记录一次检验成绩。 */
export async function recordQuiz(ref: PaperRef, score: number, total: number, summary?: string): Promise<StudyRecord> {
  if (total <= 0 || score < 0 || score > total) throw new Error(`分数不合法：${score}/${total}`)
  const record = (await readStudy(ref)) ?? { paper: `${ref.topic}/${ref.name}`, plan: [], quizzes: [] }
  record.quizzes.push({ time: new Date().toISOString(), score, total, ...(summary ? { summary } : {}) })
  await writeStudy(ref, record)
  return record
}

/** 给老师/用户看的进度摘要。 */
export function formatStudy(record: StudyRecord | null): string {
  if (!record) return '还没有学习记录。'
  const lines: string[] = []
  if (record.plan.length) {
    lines.push('阅读计划：')
    for (const s of record.plan) {
      const mark = s.status === 'done' ? '✅' : s.status === 'current' ? '▶️' : '⬜'
      lines.push(`  ${mark} ${s.id}. ${s.title}${s.note ? `（${s.note}）` : ''}`)
    }
  } else {
    lines.push('（尚未制定阅读计划）')
  }
  if (record.quizzes.length) {
    lines.push('检验记录：')
    for (const q of record.quizzes) {
      const pct = Math.round((q.score / q.total) * 100)
      lines.push(`  · ${q.time.slice(0, 16).replace('T', ' ')} — ${q.score}/${q.total}（${pct} 分）${q.summary ? `：${q.summary}` : ''}`)
    }
  }
  return lines.join('\n')
}
