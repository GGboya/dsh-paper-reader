// tools.ts — 工具注册（Cordis 壳；核心逻辑在 library/transcribe/search 纯函数里）。

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { listPapers, listTopics, resolveDataDir, resolvePaper, type PaperRef } from './library.ts'
import { transcribePaper, readTranscript } from './transcribe.ts'
import { chunkText, searchChunks, formatHits } from './search.ts'
import { completeStep, formatStudy, readStudy, recordQuiz, setPlan } from './study.ts'

export interface PluginConfig {
  /** 文献库数据目录；默认 ~/.dsh-paper-reader/data */
  dataDir?: string
  /** 中文翻译（babeldoc）用的 OpenAI 兼容端点；不配则「生成中文版」不可用 */
  translate?: {
    baseUrl?: string
    apiKey?: string
    model?: string
  }
}

/** 文献定位参数（三工具共用的 args 子集）。 */
interface LocateArgs {
  path?: string
  topic?: string
  name?: string
}

const locateParams = {
  path: { type: 'string', description: 'PDF 绝对路径。与 topic+name 二选一。' },
  topic: { type: 'string', description: '专题名（文献库一级目录）。' },
  name: { type: 'string', description: '文献名（不带 .pdf 后缀）。省略时自动使用当前会话绑定的论文（伴读会话），只有查询别的论文才需要显式指定。' },
} as const

function locate(dataDir: string, args: LocateArgs, exec?: { agent?: { id?: string } }): PaperRef {
  const refArgs: { path?: string; topic?: string; name?: string } = {}
  if (args.path) refArgs.path = args.path
  if (args.topic) refArgs.topic = args.topic
  if (args.name) refArgs.name = args.name
  // 未指定论文时回退到「当前会话绑定的论文」：伴读会话 id 形如 dpr-<base64url(topic/name)>-N，
  // 工具执行上下文里的 agent.id 就是会话 id。直接在输入框提问（不经选中即问）时靠它定位。
  if (!refArgs.path && !refArgs.name) {
    const paper = paperFromSessionId(exec?.agent?.id)
    if (paper) return resolvePaper(dataDir, { topic: paper.topic, name: paper.name })
  }
  return resolvePaper(dataDir, refArgs)
}

/** 从伴读会话 id 反解论文（dpr-<base64url(topic/name)>[-N]）；非伴读会话返回 null。 */
export function paperFromSessionId(sessionId: string | undefined): { topic: string; name: string } | null {
  if (!sessionId?.startsWith('dpr-')) return null
  try {
    const body = sessionId.slice(4).replace(/-\d+$/, '')
    const decoded = Buffer.from(body, 'base64url').toString('utf8')
    const sep = decoded.indexOf('/')
    if (sep <= 0 || sep === decoded.length - 1) return null
    return { topic: decoded.slice(0, sep), name: decoded.slice(sep + 1) }
  } catch {
    return null
  }
}

export function registerTools(ctx: Context, config: PluginConfig) {
  const dataDir = resolveDataDir(config.dataDir)

  ctx.tools.register(defineTool({
    name: 'list_papers',
    description:
      '列出文献库里的专题和文献。当用户提到某篇论文但你不知道它是否在库中、或用户问"我有哪些论文"时使用。',
    parameters: {
      topic: { type: 'string', description: '只看某个专题；省略则列出全部。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dataDir: { type: 'string', required: true, description: '文献库根目录。' },
          topics: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: '专题列表。',
          },
          papers: {
            type: 'array',
            required: true,
            items: { type: 'string', description: '形如 专题/文献名' },
            description: '文献列表。',
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.papers.length === 0
            ? `文献库为空（${value.dataDir}）。把 PDF 放进 <专题>/ 目录即可。`
            : `文献库（${value.dataDir}）：\n${value.papers.map((p) => `- ${p}`).join('\n')}`,
        },
      ],
    },
    execute: async (args, exec) => {
      const papers = listPapers(dataDir, args.topic).map((p) => `${p.topic}/${p.name}`)
      return { dataDir, topics: listTopics(dataDir), papers }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'transcribe_pdf',
    description:
      '把一篇 PDF 论文转录为纯文本（本地 PyMuPDF 提取，带页码索引），结果落盘缓存。' +
      '读一篇新论文的第一步：先转录，再用 search_paper 检索。已有缓存时秒回。',
    parameters: {
      ...locateParams,
      force: { type: 'boolean', description: '忽略缓存重新转录。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paper: { type: 'string', required: true },
          txtPath: { type: 'string', required: true, description: '转录文本路径。' },
          chars: { type: 'integer', required: true },
          pageCount: { type: 'integer', required: true },
          hasPageIndex: { type: 'boolean', required: true, description: '是否有页码索引（检索结果能否带页码）。' },
          source: { type: 'string', required: true, enum: ['cache', 'local'] },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `已转录《${value.paper}》：${value.chars} 字符，${value.pageCount} 页` +
            `（${value.source === 'cache' ? '缓存复用' : '本地提取'}${value.hasPageIndex ? '，含页码索引' : '，无页码索引'}）。` +
            `接下来可用 search_paper 检索具体内容。`,
        },
      ],
    },
    execute: async (args, exec) => {
      const ref = locate(dataDir, args, exec)
      const t = await transcribePaper(ref, { force: args.force === true })
      return {
        paper: `${ref.topic}/${ref.name}`,
        txtPath: ref.txtPath,
        chars: t.chars,
        pageCount: t.pageCount,
        hasPageIndex: t.pages.length > 0,
        source: t.source,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'search_paper',
    description:
      '在论文全文中按关键词检索相关片段，返回带页码的原文片段。' +
      '当需要论文的具体内容（定义、算法步骤、章节细节、数据）时使用，基于检索到的原文回答并注明页码。' +
      '关键词建议：用论文中的英文术语、章节号（如 "Section 3.1"）或概念名，不要用完整长句；找不到时换同义词或更短的词重试。' +
      '论文未转录时会自动先转录。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词，如 "backup task" 或 "locality"。' },
      k: { type: 'integer', description: '返回片段数量，默认 5，最多 8。' },
      ...locateParams,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paper: { type: 'string', required: true },
          query: { type: 'string', required: true },
          totalChunks: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                chunk: { type: 'integer', required: true },
                page: {
                  oneOf: [{ type: 'integer' }, { type: 'null' }],
                  required: true,
                  description: '片段起始页码；无页码索引时为 null。',
                },
                text: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: formatHits(
            value.hits.map((h) => ({
              chunk: { index: h.chunk, start: 0, end: 0, text: h.text },
              score: 0,
              page: h.page,
            })),
            value.totalChunks,
            value.query,
          ),
        },
      ],
    },
    execute: async (args, exec) => {
      const ref = locate(dataDir, args, exec)
      let cached = await readTranscript(ref)
      if (!cached) {
        await transcribePaper(ref)
        cached = await readTranscript(ref)
      }
      if (!cached) throw new Error('转录失败，无法检索')
      const chunks = chunkText(cached.text, 1500)
      const k = Math.max(1, Math.min(args.k ?? 5, 8))
      const hits = searchChunks(chunks, cached.pages, args.query, k)
      return {
        paper: `${ref.topic}/${ref.name}`,
        query: args.query,
        totalChunks: chunks.length,
        hits: hits.map((h) => ({ chunk: h.chunk.index, page: h.page, text: h.chunk.text })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'study_progress',
    description:
      '读取一篇论文的学习档案：分步阅读计划（每步状态）和历次检验成绩。' +
      '开始伴读、或用户想继续学习/查看进度时先调用；没有记录时返回空，此时应制定计划（study_update 的 set_plan）。',
    parameters: { ...locateParams },
    output: {
      schema: {
        type: 'object',
        properties: {
          paper: { type: 'string', required: true },
          hasRecord: { type: 'boolean', required: true },
          plan: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['pending', 'current', 'done'] },
                note: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          quizzes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                time: { type: 'string', required: true },
                score: { type: 'integer', required: true },
                total: { type: 'integer', required: true },
                summary: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `《${value.paper}》学习档案：\n` + formatStudy(
            value.hasRecord ? { paper: value.paper, plan: value.plan, quizzes: value.quizzes } : null,
          ),
        },
      ],
    },
    execute: async (args, exec) => {
      const ref = locate(dataDir, args, exec)
      const record = await readStudy(ref)
      return {
        paper: `${ref.topic}/${ref.name}`,
        hasRecord: record !== null,
        plan: record?.plan ?? [],
        quizzes: record?.quizzes ?? [],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'study_update',
    description:
      '更新一篇论文的学习档案（老师用）：' +
      'set_plan=制定阅读计划（steps 为 3~6 个分步标题，会重置计划但保留历史成绩）；' +
      'complete_step=学生完成某一步（step_id + 可选 note 点评，自动推进到下一步）；' +
      'record_quiz=记录一次检验成绩（score/total + 可选 summary 薄弱点小结）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['set_plan', 'complete_step', 'record_quiz'] },
      steps: { type: 'array', items: { type: 'string' }, description: 'set_plan 用：分步标题列表，如 "读摘要与引言（第 1 页），说出论文要解决的问题"。' },
      step_id: { type: 'integer', description: 'complete_step 用：完成的步骤号。' },
      note: { type: 'string', description: 'complete_step 用：对学生这一步表现的点评。' },
      score: { type: 'integer', description: 'record_quiz 用：得分。' },
      total: { type: 'integer', description: 'record_quiz 用：满分。' },
      summary: { type: 'string', description: 'record_quiz 用：本次检验小结（考点/薄弱点）。' },
      ...locateParams,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paper: { type: 'string', required: true },
          summary: { type: 'string', required: true, description: '更新后的档案摘要。' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `《${value.paper}》档案已更新：\n${value.summary}` }],
    },
    execute: async (args, exec) => {
      const ref = locate(dataDir, args, exec)
      let record
      if (args.action === 'set_plan') {
        if (!args.steps?.length) throw new Error('set_plan 需要 steps')
        record = await setPlan(ref, args.steps)
      } else if (args.action === 'complete_step') {
        if (!args.step_id) throw new Error('complete_step 需要 step_id')
        record = await completeStep(ref, args.step_id, args.note)
      } else {
        if (args.score === undefined || args.total === undefined) throw new Error('record_quiz 需要 score 和 total')
        record = await recordQuiz(ref, args.score, args.total, args.summary)
      }
      return { paper: `${ref.topic}/${ref.name}`, summary: formatStudy(record) }
    },
  }))
}
