// host.ts — webServer 路由：阅读器页面 + PDF 文件 + 转录/存档数据接口 + 选中即问。
// 壳层代码：只做 HTTP ↔ 纯函数核心(library/transcribe/archive)的转接。

import type { Context } from '@deepseek-ai/cordis'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PluginConfig } from './tools.ts'
import { listPapers, listTopics, resolveDataDir, resolvePaper } from './library.ts'
import { readTranscript, transcribePaper } from './transcribe.ts'
import { pdfVariantPath, startTranslation, zhStatus } from './translate.ts'

type Req = import('node:http').IncomingMessage
type Res = import('node:http').ServerResponse

interface RouteSpec {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: Req, res: Res) => void
}
type WebServer = { register: (spec: RouteSpec) => () => void }

/** 选中即问注入 dsh 会话用的最小服务视图（官方 SessionController 的 create/prompt/follow）。 */
interface SessionControllerLike {
  create(request: { sessionId?: string; cwd?: string }): Promise<unknown>
  prompt(
    request: {
      sessionId: string
      content: Array<{ type: 'text'; text: string }>
      requestId: string
    },
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean }>
  /** 官方实时跟随：开场快照 + 持久事件流 + assistant-stream 增量帧（web 客户端同款） */
  follow(
    request: {
      address: { kind: 'session'; sessionId: string }
      maxMessages?: number
      assistantStream?: true
    },
    signal: AbortSignal,
  ): AsyncIterable<unknown>
  /** 会话列表（过滤出某文献的伴读会话用）。 */
  list(
    request: Record<string, never>,
    signal: AbortSignal,
  ): Promise<{ items: ReadonlyArray<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean }> }>
}

/** dsh web 的连接服务：Host/Origin 围栏 + 浏览器会话认证（token → cookie）。 */
interface ConnectionLike {
  /** undefined=放行；401/403=拒绝（与宿主 /api 通道同一套校验） */
  requestRejection(req: Req): number | undefined
}

function json(res: Res, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length })
  res.end(buf)
}

async function readBody(req: Req): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

export function registerRoutes(ctx: Context, config: PluginConfig) {
  const ws = (ctx as unknown as { webServer: WebServer }).webServer
  const connection = (ctx as unknown as { connection: ConnectionLike }).connection
  const sessionController = (ctx as unknown as { sessionController: SessionControllerLike }).sessionController
  const dataDir = resolveDataDir(config.dataDir)
  // dist/host.js → 包根/reader/index.html
  const readerHtml = new URL('../reader/index.html', import.meta.url)

  const locate = (url: URL) => {
    const path = url.searchParams.get('path') ?? undefined
    const topic = url.searchParams.get('topic') ?? undefined
    const name = url.searchParams.get('name') ?? undefined
    const args: { path?: string; topic?: string; name?: string } = {}
    if (path) args.path = path
    if (topic) args.topic = topic
    if (name) args.name = name
    return resolvePaper(dataDir, args)
  }

  /** 每篇文献的伴读会话 id（确定性，重启/刷新后可续）；n 支持同文献多会话（会话1/2/…）。 */
  const sessionPrefixFor = (ref: { topic: string; name: string }) =>
    `dpr-${Buffer.from(`${ref.topic}/${ref.name}`).toString('base64url')}`

  /** 列出某文献的全部伴读会话（按 dsh 会话列表过滤 id 前缀；兼容 v1 无后缀旧会话=会话1）。 */
  const listPaperSessions = async (ref: { topic: string; name: string }) => {
    const prefix = sessionPrefixFor(ref)
    const all = await sessionController.list({}, AbortSignal.timeout(15_000))
    const out: Array<{ n: number; sessionId: string; running: boolean; blank: boolean; updatedAt: number }> = []
    for (const s of all.items) {
      if (s.sessionId === prefix) {
        out.push({ n: 1, sessionId: s.sessionId, running: s.running, blank: s.blank, updatedAt: s.updatedAt }) // 旧格式 → 会话1
        continue
      }
      if (s.sessionId.startsWith(prefix + '-')) {
        const n = +s.sessionId.slice(prefix.length + 1) || 0
        if (n > 0) out.push({ n, sessionId: s.sessionId, running: s.running, blank: s.blank, updatedAt: s.updatedAt })
      }
    }
    // 同 n 去重（旧格式与新格式并存时旧格式让位）；按 n 排序
    const byN = new Map<number, (typeof out)[number]>()
    for (const s of out) byN.set(s.n, s)
    return [...byN.values()].sort((a, b) => a.n - b.n)
  }

  /** n → 实际 sessionId：旧格式存在时优先（历史不丢），否则新格式。 */
  const sessionIdFor = async (ref: { topic: string; name: string }, n: number) => {
    const sessions = await listPaperSessions(ref)
    const hit = sessions.find((s) => s.n === n)
    return hit?.sessionId ?? `${sessionPrefixFor(ref)}-${n}`
  }

  const dispatch = async (req: Req, res: Res, url: URL) => {
    const sub = url.pathname.slice('/paper-reader'.length) // '' | '/' | '/api/...'

    if ((sub === '' || sub === '/') && req.method === 'GET') {
      const html = await readFile(readerHtml)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length })
      res.end(html)
      return
    }

    if (sub === '/api/library' && req.method === 'GET') {
      json(res, 200, { dataDir, topics: listTopics(dataDir), papers: listPapers(dataDir) })
      return
    }

    // 新建专题（目录）
    if (sub === '/api/library/topic' && req.method === 'POST') {
      const body = (await readBody(req)) as { name?: string }
      const name = body.name?.trim()
      if (!name || /[/\\]|\.\./.test(name)) {
        json(res, 400, { error: '专题名不能为空，且不能包含 / \\ ..' })
        return
      }
      await mkdir(join(dataDir, name), { recursive: true })
      json(res, 200, { ok: true, topic: name })
      return
    }

    // 上传 PDF 到专题（raw body；文件名/专题走 header，避免 multipart 解析）
    if (sub === '/api/library/upload' && req.method === 'POST') {
      const topic = req.headers['x-dpr-topic']
      const filename = req.headers['x-dpr-name']
      if (typeof topic !== 'string' || typeof filename !== 'string' || !topic.trim() || !filename.trim()) {
        json(res, 400, { error: '缺少 x-dpr-topic / x-dpr-name 头' })
        return
      }
      if (!filename.toLowerCase().endsWith('.pdf')) {
        json(res, 400, { error: '只支持 PDF 文件' })
        return
      }
      const safeName = filename.replaceAll('/', '_').replaceAll('\\', '_')
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const buf = Buffer.concat(chunks)
      if (buf.length < 100) {
        json(res, 400, { error: '文件内容为空' })
        return
      }
      const dir = join(dataDir, topic.trim())
      await mkdir(dir, { recursive: true })
      const target = join(dir, safeName)
      await writeFile(target, buf)
      json(res, 200, { ok: true, topic: topic.trim(), name: safeName.slice(0, -4), bytes: buf.length })
      return
    }

    // 新建伴读会话（会话N+1）
    if (sub === '/api/sessions/new' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string }
      const ref = resolvePaper(dataDir, body)
      const existing = await listPaperSessions(ref)
      const n = existing.length ? existing[existing.length - 1]!.n + 1 : 1
      const sessionId = await sessionIdFor(ref, n)
      await sessionController.create({ sessionId, cwd: join(dataDir, ref.topic) })
      json(res, 200, { ok: true, n, sessionId })
      return
    }

    if (sub === '/api/paper' && req.method === 'GET') {
      const ref = locate(url)
      const t = await readTranscript(ref)
      const st = await stat(ref.pdfPath)
      json(res, 200, {
        topic: ref.topic,
        name: ref.name,
        pdfBytes: st.size,
        hasTranscript: t !== null,
        chars: t?.text.length ?? 0,
        hasPageIndex: (t?.pages?.length ?? 0) > 0,
        pageCount: t?.pages?.length ?? null,
      })
      return
    }

    if (sub === '/api/pdf' && req.method === 'GET') {
      const ref = locate(url)
      const pdfPath = pdfVariantPath(ref, url.searchParams.get('variant'))
      const st = await stat(pdfPath) // 变体不存在时 404/500 由外层兜底
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': st.size,
        'cache-control': 'no-cache', // 切换文献/重新生成后必须拿到新的
      })
      createReadStream(pdfPath).pipe(res)
      return
    }

    // 中文版状态：zh=纯中文 dual=中英对照 busy=翻译中
    if (sub === '/api/zh' && req.method === 'GET') {
      json(res, 200, zhStatus(locate(url)))
      return
    }

    // 启动后台翻译（幂等）
    if (sub === '/api/zh/generate' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string }
      const ref = resolvePaper(dataDir, body)
      const r = await startTranslation(ref, dataDir, config.translate ?? {})
      json(res, r.started ? 200 : 409, r)
      return
    }

    if (sub === '/api/transcribe' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string }
      const ref = resolvePaper(dataDir, body)
      const t = await transcribePaper(ref)
      json(res, 200, { chars: t.chars, pageCount: t.pageCount, hasPageIndex: t.pages.length > 0, source: t.source })
      return
    }

    if (sub === '/api/qa' && req.method === 'GET') {
      const ref = locate(url)
      let entries: string[] = []
      try {
        const files = (await readdir(ref.qaDir)).filter((f) => f.endsWith('.md')).sort()
        const all: string[] = []
        for (const f of files) {
          const md = await readFile(join(ref.qaDir, f), 'utf8')
          // 每轮问答是一个 "## <时间>" 小节（回答内部的 ## 标题不算）,新→旧排
          const parts = md.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter((s) => /^## \d{4}-/.test(s))
          all.push(...parts)
        }
        entries = all.reverse()
      } catch { /* 无存档目录 */ }
      json(res, 200, { entries })
      return
    }

    // 文献的伴读会话列表（多会话：会话1/会话2/…）
    if (sub === '/api/sessions' && req.method === 'GET') {
      const ref = locate(url)
      const sessions = await listPaperSessions(ref)
      json(res, 200, { sessions, latest: sessions.length ? sessions[sessions.length - 1]!.n : 1 })
      return
    }

    // 实时会话流（SSE）：桥接官方 sessionController.follow —— 阅读器右侧就是真正的 dsh 会话
    if (sub === '/api/session/follow' && req.method === 'GET') {
      const ref = locate(url)
      const sessions = await listPaperSessions(ref)
      const nParam = +(url.searchParams.get('n') ?? 0) || 0
      // 未指定时进最新会话；全新文献进会话1
      const n = nParam > 0 ? nParam : sessions.length ? sessions[sessions.length - 1]!.n : 1
      const sessionId = await sessionIdFor(ref, n)
      const cwd = join(dataDir, ref.topic)
      try {
        await sessionController.create({ sessionId, cwd })
      } catch { /* 已存在则复用；失败由 follow 报错 */ }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      res.write(`event: meta\ndata: ${JSON.stringify({ n, sessionId })}\n\n`)
      const ac = new AbortController()
      req.on('close', () => ac.abort())
      try {
        const frames = sessionController.follow(
          { address: { kind: 'session', sessionId }, maxMessages: 200, assistantStream: true },
          ac.signal,
        )
        for await (const frame of frames) {
          if (ac.signal.aborted) break
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: String(err instanceof Error ? err.message : err) })}\n\n`)
        }
      }
      if (!res.writableEnded) res.end()
      return
    }

    if (sub === '/api/ask' && req.method === 'POST') {
      const body = (await readBody(req)) as {
        topic?: string; name?: string; path?: string
        question: string; selectedText?: string; page?: number | null
        n?: number // 会话序号（会话1/会话2/…）；缺省进最新
        fresh?: boolean // true=强制新建一个会话（新建对话）
      }
      if (!body.question?.trim()) {
        json(res, 400, { error: 'question 不能为空' })
        return
      }
      const sc = sessionController
      if (!sc) {
        json(res, 503, { error: '当前 profile 没有 sessionController 服务，无法注入会话（headless?）' })
        return
      }
      const ref = resolvePaper(dataDir, body)
      const existing = await listPaperSessions(ref)
      let n: number
      if (body.fresh) n = existing.length ? existing[existing.length - 1]!.n + 1 : 1
      else if (body.n && body.n > 0) n = body.n
      else n = existing.length ? existing[existing.length - 1]!.n : 1
      const sessionId = await sessionIdFor(ref, n)
      const cwd = join(dataDir, ref.topic)
      try {
        await sc.create({ sessionId, cwd })
      } catch { /* 已存在则复用 */ }
      const hasQuote = typeof body.selectedText === 'string' && body.selectedText.trim() !== ''
      const where = hasQuote && body.page ? `（选中于第 ${body.page} 页）` : ''
      const lines = [
        `[论文伴读] 文献：${ref.topic}/${ref.name}（同目录下，search_paper 可直接检索；回答注明页码）`,
      ]
      if (hasQuote) {
        lines.push(
          `用户在阅读器里选中了一段文字${where}：`,
          `"""${body.selectedText!.trim()}"""`,
        )
      }
      lines.push(
        `用户的问题：${body.question}`,
        `仅当回答涉及论文内容（引用论文观点/数据/章节）时，才用 archive_qa 存档（topic="${ref.topic}" name="${ref.name}" session="会话${n}"），pages 填引用页码；寒暄、元问题（如"你是谁/你的提示词"）、与论文无关的内容一律不要存档。`,
      )
      const prompt = lines.join('\n')
      await sc.prompt({
        sessionId,
        content: [{ type: 'text', text: prompt }],
        requestId: randomUUID(),
      }, AbortSignal.timeout(30_000))
      json(res, 200, { ok: true, sessionId, n })
      return
    }

    json(res, 404, { error: 'not found: ' + url.pathname })
  }

  ctx.effect(() => {
    const dispose = ws.register({
      kind: 'prefix',
      path: '/paper-reader',
      handler: (req, res) => {
        // 认证+Host 围栏（与宿主 /api 通道同一套校验）：插件路由不在宿主 index
        // 鉴权路径上，必须自己校验。本路由暴露 PDF 读取和会话注入，不能裸奔。
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        dispatch(req, res, url).catch((err) => {
          if (!res.headersSent) json(res, 500, { error: String(err instanceof Error ? err.message : err) })
          else res.end()
        })
      },
    })
    console.log('[dsh-paper-reader] routes registered under /paper-reader')
    return dispose
  })
}
