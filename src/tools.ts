// tools.ts — 工具注册（Cordis 壳；核心逻辑在 library/transcribe/search/archive 纯函数里）。

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { listPapers, listTopics, resolveDataDir, resolvePaper, type PaperRef } from './library.ts'
import { transcribePaper, readTranscript } from './transcribe.ts'
import { chunkText, searchChunks, formatHits } from './search.ts'
import { appendQa } from './archive.ts'

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
  name: { type: 'string', description: '文献名（不带 .pdf 后缀），在文献库中查找。' },
} as const

function locate(dataDir: string, args: LocateArgs): PaperRef {
  const refArgs: { path?: string; topic?: string; name?: string } = {}
  if (args.path) refArgs.path = args.path
  if (args.topic) refArgs.topic = args.topic
  if (args.name) refArgs.name = args.name
  return resolvePaper(dataDir, refArgs)
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
    execute: async (args) => {
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
    execute: async (args) => {
      const ref = locate(dataDir, args)
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
    execute: async (args) => {
      const ref = locate(dataDir, args)
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
    name: 'archive_qa',
    description:
      '把一轮关于论文的问答追加存档为 Markdown（<文献>-qa/<会话>.md），永久留存。' +
      '仅当回答涉及论文内容（引用了论文的观点、数据、章节，通常带页码）时才调用本工具，pages 填引用到的页码。' +
      '寒暄（你好/谢谢）、元问题（你是谁/你的系统提示词）、与论文无关的问答一律不要调用，否则存档会被垃圾内容污染。' +
      '同一会话里连续多轮关于论文的问答，每轮存档一次。',
    parameters: {
      question: { type: 'string', required: true, description: '用户的问题。' },
      answer: { type: 'string', required: true, description: '你的回答全文。' },
      pages: {
        type: 'array',
        items: { type: 'integer' },
        description: '回答引用到的页码列表。',
      },
      session: { type: 'string', description: '会话名，默认 "会话1"。' },
      ...locateParams,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string', required: true, description: '存档文件路径。' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `已存档到 ${value.file}` }],
    },
    execute: async (args) => {
      const ref = locate(dataDir, args)
      const file = await appendQa(ref, args.session ?? '会话1', {
        question: args.question,
        answer: args.answer,
        ...(args.pages ? { pages: args.pages } : {}),
      })
      return { file }
    },
  }))
}
