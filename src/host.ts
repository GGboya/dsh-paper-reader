// host.ts — webServer 路由：阅读器页面 + PDF 文件 + 转录数据接口 + 选中即问。
// 壳层代码：只做 HTTP ↔ 纯函数核心(library/transcribe)的转接。

import type { Context } from '@deepseek-ai/cordis'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PluginConfig } from './tools.ts'
import { listPapers, listTopics, resolveDataDir, resolvePaper } from './library.ts'
import { readTranscript, transcribePaper } from './transcribe.ts'
import { pdfVariantPath, startTranslation, zhStatus } from './translate.ts'
import {
  clearTranslateConfig,
  maskApiKey,
  readTranslateConfig,
  resolveTranslateEndpoint,
  testTranslateEndpoint,
  writeTranslateConfig,
} from './translate-config.ts'
import { installPaperPreset, PAPER_PRESET_ID } from './preset.ts'

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
  create(request: { sessionId?: string; cwd?: string; workspaceId?: string; agentPreset?: string }): Promise<unknown>
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

/** 工作区服务：专题目录注册为 dsh 工作区（幂等），让原生输入框可用（否则会话无工作区，composer 锁定）。 */
interface WorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: { workspaceId: string }; created: boolean }>
}

/** 工作区注册表（dsh-workspace）：归档集 + 归档操作。空白草稿被放弃时归档 —— 官方删除语义（日志保留、全列表隐藏）。 */
interface WorkspaceRegistryLike {
  readonly archivedSessionIds: ReadonlyArray<string>
  archiveSession(sessionId: string): Promise<unknown>
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

/** header 元数据解码：客户端 encodeURIComponent 过（HTTP header 值不允许非 Latin-1，如中文文件名）；非字符串/未编码原样返回。 */
function decodeHdr(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

export function registerRoutes(ctx: Context, config: PluginConfig) {
  const ws = (ctx as unknown as { webServer: WebServer }).webServer
  const connection = (ctx as unknown as { connection: ConnectionLike }).connection
  const sessionController = (ctx as unknown as { sessionController: SessionControllerLike }).sessionController
  const workspaceController = (ctx as unknown as { workspaceController: WorkspaceControllerLike }).workspaceController
  const workspaceRegistry = (ctx as unknown as { workspaceRegistry?: WorkspaceRegistryLike }).workspaceRegistry
  const dataDir = resolveDataDir(config.dataDir)
  // dist/host.js → 包根/reader/index.html
  const readerHtml = new URL('../reader/index.html', import.meta.url)
  // 自带「论文伴读」agent preset → $DSH_HOME/.agent-presets/（实时扫描，免重启）；
  // 失败（旧版 dsh/无权限）则回退默认 preset，功能不受影响。
  const presetDir = installPaperPreset(new URL('../', import.meta.url))

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

  /** 扫描某文献的全部伴读会话（不过滤）：按 dsh 会话列表过滤 id 前缀；兼容 v1 无后缀旧会话=会话1。
   *  n 的分配必须基于这份全量扫描（含归档/空白）——用过滤后的列表算 maxN 会跟
   *  磁盘上已存在（可能还被别的进程 flock 着）的会话目录撞号，create 直接失败（实测）。 */
  const scanPaperSessions = async (ref: { topic: string; name: string }) => {
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

  /** 列表视图：过滤归档集；空白会话（从未提问）只保留最新一个——更早的空会话是被遗弃的
   *  「新建对话」，顺手真归档（官方语义：日志保留、所有列表隐藏），不只是从树上消失。 */
  const listPaperSessions = async (ref: { topic: string; name: string }) => {
    const archived = new Set(workspaceRegistry?.archivedSessionIds ?? [])
    const sorted = await scanPaperSessions(ref)
    const visible = sorted.filter((s) => !archived.has(s.sessionId))
    const newestBlank = [...visible].reverse().find((s) => s.blank)
    // 非最新的空白会话 = 被遗弃的草稿：后台归档（幂等；最新空白是活跃草稿，留给复用/显式归档）
    for (const s of visible) {
      if (s.blank && s !== newestBlank && !s.running) {
        workspaceRegistry?.archiveSession(s.sessionId).catch(() => {})
      }
    }
    return visible.filter((s) => !s.blank || s === newestBlank)
  }

  /** n → 实际 sessionId：旧格式存在时优先（历史不丢），否则新格式。全量扫描（含归档）。 */
  const sessionIdFor = async (ref: { topic: string; name: string }, n: number) => {
    const sessions = await scanPaperSessions(ref)
    const hit = sessions.find((s) => s.n === n)
    return hit?.sessionId ?? `${sessionPrefixFor(ref)}-${n}`
  }

  /** 专题目录 → dsh 工作区（幂等，进程内缓存）。会话挂到工作区后原生 composer 才可用。 */
  const workspaceCache = new Map<string, string>()
  const ensureTopicWorkspace = async (topic: string): Promise<string | undefined> => {
    const dir = join(dataDir, topic)
    const cached = workspaceCache.get(dir)
    if (cached) return cached
    try {
      const { workspace } = await workspaceController.create({ path: dir })
      workspaceCache.set(dir, workspace.workspaceId)
      return workspace.workspaceId
    } catch (err) {
      console.warn('[dsh-paper-reader] workspace 注册失败(回退 cwd 模式):', err)
      return undefined
    }
  }

  /** 创建/复用会话：优先挂工作区 + 论文伴读 preset；失败（preset 缺失或旧会话 preset 冲突）逐级回退。 */
  const createPaperSession = async (sessionId: string, topic: string) => {
    const workspaceId = await ensureTopicWorkspace(topic)
    const usePreset = (await presetDir) !== null
    if (workspaceId) {
      if (usePreset) {
        try {
          return await sessionController.create({ sessionId, workspaceId, agentPreset: PAPER_PRESET_ID })
        } catch { /* preset 未注册或旧会话属另一 preset → 去掉 preset 重试 */ }
      }
      try {
        return await sessionController.create({ sessionId, workspaceId })
      } catch { /* 工作区挂载失败则回退 */ }
    }
    return sessionController.create({ sessionId, cwd: join(dataDir, topic) })
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

    // 上传 PDF 到专题（raw body；文件名/专题走 header，避免 multipart 解析。
    // header 值不允许非 Latin-1 字符，中文一律 encodeURIComponent 编码传输，这里解码）
    if (sub === '/api/library/upload' && req.method === 'POST') {
      const topic = decodeHdr(req.headers['x-dpr-topic'])
      const filename = decodeHdr(req.headers['x-dpr-name'])
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

    // 新建伴读会话（会话N+1）。最新可见会话还是空白草稿时直接复用它——
    // 连点「新建」不再堆积空会话（毫无意义的点击什么都不存）。
    // n 用全量扫描分配（含归档/空白），绝不与磁盘上已有目录撞号。
    if (sub === '/api/sessions/new' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string }
      const ref = resolvePaper(dataDir, body)
      const visible = await listPaperSessions(ref)
      const newest = visible[visible.length - 1]
      if (newest && newest.blank && !newest.running) {
        json(res, 200, { ok: true, n: newest.n, sessionId: newest.sessionId, reused: true })
        return
      }
      const all = await scanPaperSessions(ref)
      const n = all.length ? all[all.length - 1]!.n + 1 : 1
      const sessionId = `${sessionPrefixFor(ref)}-${n}`
      await createPaperSession(sessionId, ref.topic)
      json(res, 200, { ok: true, n, sessionId })
      return
    }

    // 归档空白草稿（切换会话时客户端后台调用）：只接受该文献的空白会话，内容会话绝不归档
    if (sub === '/api/sessions/archive' && req.method === 'POST') {
      const body = (await readBody(req)) as { sessionId?: string; topic?: string; name?: string }
      const sessionId = body.sessionId ?? ''
      const ref = resolvePaper(dataDir, body)
      if (!sessionId.startsWith(sessionPrefixFor(ref) + '-') && sessionId !== sessionPrefixFor(ref)) {
        json(res, 400, { error: '会话不属于该文献' })
        return
      }
      if (!workspaceRegistry) {
        json(res, 503, { error: 'workspaceRegistry 服务不可用' })
        return
      }
      const sessions = await listPaperSessions(ref)
      const target = sessions.find((s) => s.sessionId === sessionId)
      if (!target || !target.blank || target.running) {
        json(res, 409, { error: '只允许归档无内容的空白会话' })
        return
      }
      await workspaceRegistry.archiveSession(sessionId)
      json(res, 200, { ok: true })
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

    // 启动后台翻译（幂等）。端点：UI 里填的 > profile 的 translate
    if (sub === '/api/zh/generate' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string }
      const ref = resolvePaper(dataDir, body)
      const { endpoint } = await resolveTranslateEndpoint(config.translate)
      const r = await startTranslation(ref, dataDir, endpoint)
      json(res, r.started ? 200 : 409, r)
      return
    }

    // ── 翻译端点配置（阅读器浮层的读写口）─────────────────────────────
    // GET 只回显掩码 key：明文永不离开服务端
    if (sub === '/api/translate/config' && req.method === 'GET') {
      const { endpoint, source } = await resolveTranslateEndpoint(config.translate)
      json(res, 200, {
        baseUrl: endpoint.baseUrl ?? '',
        model: endpoint.model ?? '',
        hasApiKey: Boolean(endpoint.apiKey),
        apiKeyHint: endpoint.apiKey ? maskApiKey(endpoint.apiKey) : '',
        source,
      })
      return
    }

    // POST：校验 → 预检 → 通了才落盘。key 填错在这里就拦下，
    // 不让它拖到 babeldoc 跑几分钟后才异步失败。
    if (sub === '/api/translate/config' && req.method === 'POST') {
      const body = (await readBody(req)) as { baseUrl?: string; apiKey?: string; model?: string }
      const baseUrl = body.baseUrl?.trim() ?? ''
      const model = body.model?.trim() ?? ''
      // key 留空 = 沿用已存的那把（明文不回传，前端无法预填）
      const prev = await readTranslateConfig()
      const apiKey = body.apiKey?.trim() || prev?.apiKey || ''
      if (!/^https?:\/\//i.test(baseUrl)) {
        json(res, 400, { error: '端点 URL 需要以 http:// 或 https:// 开头' })
        return
      }
      if (!model) {
        json(res, 400, { error: '模型名不能为空（如 deepseek-chat）' })
        return
      }
      if (!apiKey) {
        json(res, 400, { error: 'API Key 不能为空' })
        return
      }
      const test = await testTranslateEndpoint({ baseUrl, apiKey, model })
      if (!test.ok) {
        json(res, 400, { error: `连接测试失败：${test.detail ?? '未知原因'}` })
        return
      }
      await writeTranslateConfig({ baseUrl, apiKey, model })
      json(res, 200, { ok: true })
      return
    }

    // DELETE：清掉文件，回落到 profile 的 translate
    if (sub === '/api/translate/config' && req.method === 'DELETE') {
      await clearTranslateConfig()
      json(res, 200, { ok: true })
      return
    }

    if (sub === '/api/transcribe' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string }
      const ref = resolvePaper(dataDir, body)
      const t = await transcribePaper(ref)
      json(res, 200, { chars: t.chars, pageCount: t.pageCount, hasPageIndex: t.pages.length > 0, source: t.source })
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
      try {
        await createPaperSession(sessionId, ref.topic)
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
      if (body.fresh) {
        // 全量扫描分配（含归档/空白），避免与磁盘上已有会话目录撞号
        const all = await scanPaperSessions(ref)
        n = all.length ? all[all.length - 1]!.n + 1 : 1
      } else if (body.n && body.n > 0) n = body.n
      else n = existing.length ? existing[existing.length - 1]!.n : 1
      const sessionId = await sessionIdFor(ref, n)
      try {
        await createPaperSession(sessionId, ref.topic)
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
      lines.push(`用户的问题：${body.question}`)
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
