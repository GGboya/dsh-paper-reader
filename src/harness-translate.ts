// harness-translate.ts — 把 Harness 当前模型临时适配成 BabelDOC 需要的 OpenAI 补全端点。
//
// 不读取、复制或修改 Harness 的凭据：每次请求直接走 ctx.llm，provider/model 来自
// agentDefaultModel.currentSelection()。HTTP 服务只监听 127.0.0.1 的随机端口，使用一次性
// 随机 token，并随一次划词翻译或一个 BabelDOC 任务关闭。

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { TranslateEndpoint } from './translate.ts'

export interface HarnessModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface AgentDefaultModelLike {
  currentSelection(): HarnessModelSelection
}

interface HarnessStreamChunk {
  type: string
  index?: number
  text?: string
  block?: { type?: string; text?: string }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  reason?: {
    kind?: string
    failure?: { message?: string; code?: string; status?: number }
  }
}

export interface HarnessLlmLike {
  listProviders(): Array<{ id: string; name: string }>
  stream(options: {
    provider: string
    model: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    system?: string
    temperature?: number
    maxTokens?: number
    stop?: string[]
    signal?: AbortSignal
  }): AsyncIterable<HarnessStreamChunk>
}

export interface HarnessTranslationBridge {
  endpoint: Required<TranslateEndpoint>
  provider: string
  providerName: string
  model: string
  close(): Promise<void>
}

export function currentHarnessModel(
  defaults: AgentDefaultModelLike | undefined,
  llm: HarnessLlmLike | undefined,
): { provider: string; providerName: string; model: string } | null {
  if (!defaults || !llm) return null
  const selected = defaults.currentSelection()
  if (!selected?.provider || !selected?.model) return null
  const provider = llm.listProviders().find((p) => p.id === selected.provider)
  if (!provider) return null
  return { provider: selected.provider, providerName: provider.name || selected.provider, model: selected.model }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length })
  res.end(data)
}

function openAiError(status: number, message: string): { error: { message: string; type: string } } {
  return { error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error' } }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of req) {
    const chunk = raw as Buffer
    size += chunk.length
    if (size > 4 * 1024 * 1024) throw new Error('请求体超过 4 MiB 限制')
    chunks.push(chunk)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new Error('消息 content 必须是文本')
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
      return (part as { text: string }).text
    }
    throw new Error('临时翻译适配只支持文本消息')
  }).join('')
}

function requestMessages(body: Record<string, unknown>): {
  system?: string
  messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
} {
  if (!Array.isArray(body['messages']) || body['messages'].length === 0) throw new Error('messages 不能为空')
  const system: string[] = []
  const messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }> = []
  for (const raw of body['messages']) {
    if (typeof raw !== 'object' || raw === null) throw new Error('消息必须是对象')
    const message = raw as { role?: unknown; content?: unknown }
    if (message.role === 'system' || message.role === 'developer') {
      system.push(textOf(message.content))
      continue
    }
    // BabelDOC 与划词翻译只发送 system/user；不悄悄把 assistant/tool 历史改成用户输入。
    if (message.role !== 'user') throw new Error('临时翻译适配只支持 system 与 user 消息')
    messages.push({ role: 'user', content: [{ type: 'text', text: textOf(message.content) }] })
  }
  if (!messages.length) throw new Error('至少需要一条 user 消息')
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages }
}

/** 为一次翻译操作开启临时本地端点；close() 必须且只需调用一次。 */
export async function openHarnessTranslationBridge(
  llm: HarnessLlmLike,
  selected: { provider: string; providerName: string; model: string },
): Promise<HarnessTranslationBridge> {
  const token = randomUUID()
  const controllers = new Set<AbortController>()
  let closing = false

  const server: Server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(pathname)) {
        sendJson(res, 404, openAiError(404, 'Not found'))
        return
      }
      if (closing || req.headers.authorization !== `Bearer ${token}`) {
        sendJson(res, 401, openAiError(401, 'Invalid translation bridge credential'))
        return
      }
      const controller = new AbortController()
      controllers.add(controller)
      res.on('close', () => { if (!res.writableEnded) controller.abort() })
      try {
        const body = await readJson(req)
        if (body['stream'] === true) throw new Error('临时翻译适配只支持非流式补全')
        if (typeof body['model'] === 'string' && body['model'] !== selected.model) throw new Error('请求模型与 Harness 当前选择不一致')
        const { system, messages } = requestMessages(body)
        const parts = new Map<number, string>()
        let finish = 'stop'
        let usage: HarnessStreamChunk['usage']
        let failure: { message?: string; code?: string; status?: number } | undefined
        for await (const chunk of llm.stream({
          provider: selected.provider,
          model: selected.model,
          messages,
          ...(system !== undefined ? { system } : {}),
          ...(typeof body['temperature'] === 'number' ? { temperature: body['temperature'] } : {}),
          ...(typeof body['max_tokens'] === 'number' ? { maxTokens: body['max_tokens'] } : {}),
          ...(typeof body['stop'] === 'string' ? { stop: [body['stop']] } : Array.isArray(body['stop']) ? { stop: body['stop'].filter((s): s is string => typeof s === 'string') } : {}),
          signal: controller.signal,
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.index === 'number' && typeof chunk.text === 'string') {
            parts.set(chunk.index, (parts.get(chunk.index) ?? '') + chunk.text)
          } else if (chunk.type === 'block-end' && typeof chunk.index === 'number' && chunk.block?.type === 'text' && !parts.has(chunk.index)) {
            parts.set(chunk.index, chunk.block.text ?? '')
          } else if (chunk.type === 'usage') {
            usage = chunk.usage
          } else if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
            finish = chunk.reason?.kind === 'max-tokens' ? 'length' : 'stop'
            break
          }
        }
        if (failure) {
          const err = new Error(failure.message || 'Harness 模型调用失败') as Error & { status?: number }
          if (typeof failure.status === 'number') err.status = failure.status
          throw err
        }
        const content = [...parts.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('')
        const promptTokens = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
        const completionTokens = usage?.outputTokens ?? 0
        sendJson(res, 200, {
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: selected.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: usage?.totalTokens ?? promptTokens + completionTokens,
            ...(usage?.cacheReadTokens ? { prompt_cache_hit_tokens: usage.cacheReadTokens } : {}),
          },
        })
      } catch (err) {
        if (res.writableEnded) return
        const aborted = controller.signal.aborted && !closing
        const status = aborted ? 499 : typeof (err as { status?: unknown }).status === 'number' ? Number((err as { status: number }).status) : 400
        const message = closing || controller.signal.aborted ? '翻译已取消' : err instanceof Error ? err.message : String(err)
        sendJson(res, status, openAiError(status, message.slice(0, 500)))
      } finally {
        controllers.delete(controller)
      }
    })().catch(() => {
      if (!res.writableEnded) sendJson(res, 500, openAiError(500, '临时翻译适配失败'))
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    server.close()
    throw new Error('无法分配本地翻译端口')
  }
  let closed = false
  return {
    endpoint: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: token, model: selected.model },
    provider: selected.provider,
    providerName: selected.providerName,
    model: selected.model,
    close: async () => {
      if (closed) return
      closed = true
      closing = true
      for (const controller of controllers) controller.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    },
  }
}
