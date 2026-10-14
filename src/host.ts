// host.ts — webServer 路由：阅读器页面 + PDF 文件 + 转录数据接口 + 选中即问。
// 壳层代码：只做 HTTP ↔ 纯函数核心(library/transcribe)的转接。

import type { Context } from '@deepseek-ai/cordis'
import { createReadStream, existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join, resolve, sep } from 'node:path'
import type { PluginConfig } from './tools.ts'
import {
  listPapers,
  listTopicTree,
  listTopics,
  resolveDataDir,
  resolvePaper,
  resolveUploadTopic,
  validateEntryBoundary,
  validateEntryName,
  type PaperRef,
} from './library.ts'
import {
  ManageError,
  assertInside,
  clearTopic,
  planTopicClear,
  deletePaper,
  deleteTopic,
  isManageError,
  planPaperDelete,
  planTopicDelete,
  realDataDir,
  renamePaper,
  renameTopic,
  resolveTopicDir,
  validateName,
  validateTopicPath,
} from './library-manage.ts'
import { readFormulaIndex, readTextBlockIndex } from './formulas.ts'
import { buildScopeContext, type AskScope } from './scope.ts'
import {
  MAX_CHUNKS,
  MAX_LATEX_CHARS,
  MAX_TEXT_CHARS,
  MAX_TOTAL_CHARS,
  SelectionTranslateError,
  assembleSource,
  formulaStatusOf,
  translateSelection,
  type TranslateChunk,
} from './translate-selection.ts'
import { MineruError, sanitizeDetail } from './mineru.ts'
import { readTranscript, transcribePaper, ScannedPdfError, ShortTextError, type SourceArg } from './transcribe.ts'
import { pdfVariantPath, restartTranslation, startTranslation, zhStatus } from './translate.ts'
import {
  clearTranslateConfig,
  maskApiKey,
  readTranslateConfig,
  resolveTranslateEndpoint,
  testTranslateEndpoint,
  writeTranslateConfig,
} from './translate-config.ts'
import {
  clearTypesafeConfig,
  readTypesafeConfig,
  resolveTypesafeConfig,
  testTypesafeEndpoint,
  writeTypesafeConfig,
} from './typesafe-config.ts'
import {
  clearEmbedConfig,
  maskApiKey as maskEmbedApiKey,
  readEmbedConfig,
  resolveEmbedConfig,
  testEmbedEndpoint,
  writeEmbedConfig,
} from './embed-config.ts'
import {
  clearMineruConfig,
  mergeMineruBody,
  precheckMineruConfig,
  resolveMineruConfig,
  testMineruCloud,
  testMineruLocal,
  writeMineruConfig,
} from './mineru-config.ts'
import { installPaperPreset, PAPER_PRESET_ID } from './preset.ts'
import {
  MigrationAborted,
  MigrationError,
  formatMigrationReport,
  lastMigrationLog,
  migrationLogDir,
  planMigration,
  rollbackMigration,
  runMigration,
} from './migrate.ts'
import { noteOrigin } from './origin.ts'
import {
  clearThemeConfig,
  readThemeConfig,
  themePayload,
  validateThemePatch,
  writeThemeConfig,
} from './theme-config.ts'

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

/**
 * 错误文案判别：带 `.code` 的 Node errno 系统错误 → 固定中文文案（不回显原始错误，
 * 避免把 dataDir/目标绝对路径带进响应体）；不带 `.code` 的是我们自己抛的中文业务 Error
 * （专题不存在/已存在同名/名字不能包含… 等）→ 保留 `e.message`，用户仍能定位问题。
 */
function readableError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && code) return '系统错误，请稍后重试'
  return err instanceof Error ? err.message : String(err)
}

async function readBody(req: Req): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  // 畸形 JSON / 整包 null / 非对象 → {}：路由据此给**可读 400**（原来是 JSON.parse 抛错 →
  // 外层兜底 500 internal，错误分类错误）。PR-1 的错误分类收口，rebase 时一并带入。
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
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
  const readerVendorDir = new URL('../reader/vendor/', import.meta.url)
  // 插件版本（读包根 package.json，注入阅读器顶栏——用户截图反馈时一眼可见）
  const pluginVersion = 'v' + (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
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
    try {
      return resolvePaper(dataDir, args)
    } catch {
      // 原先普通 Error 会冒泡成 500 且把「PDF 不存在: /abs/path」这类绝对路径写进响应体；
      // 这里统一成 404 + 只含名称的文案（读路径也一样，语义更准且不泄露服务端路径）。
      throw notFound(args.path ? '文献不存在（path 指向的文件不可用）' : `文献不存在：${args.topic ? `${args.topic}/` : ''}${args.name ?? ''}`)
    }
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
  /** 删/改/清空一个专题（可能是路径）后，把**整棵子树**的工作区缓存键清掉（方案 §B2.4）。 */
  const dropWorkspaceCache = (topicPath: string) => {
    const base = join(dataDir, ...topicPath.split('/').filter(Boolean))
    const prefix = base.endsWith(sep) ? base : base + sep
    for (const k of [...workspaceCache.keys()]) {
      if (k === base || k.startsWith(prefix)) workspaceCache.delete(k)
    }
  }
  const ensureTopicWorkspace = async (topic: string): Promise<string | undefined> => {
    const dir = join(dataDir, topic)
    const cached = workspaceCache.get(dir)
    if (cached) return cached
    try {
      const { workspace } = await workspaceController.create({ path: dir })
      workspaceCache.set(dir, workspace.workspaceId)
      return workspace.workspaceId
    } catch (err) {
      console.warn('[dsh-paper-reader] workspace 注册失败(回退 cwd 模式):', readableError(err))
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

  /* ── 破坏性操作（删除/重命名）的共用出口 ──────────────────────────────────
     契约：docs/reader-ux-requirements.md §2。错误文案一律不含服务端绝对路径；
     结构性字段（trashDir/trashRel）只在必须给用户恢复线索时出现（见 O4 说明）。 */
  const manageFail = (res: Res, err: unknown): boolean => {
    if (!isManageError(err)) return false
    json(res, err.status, { error: err.message, code: err.code, ...err.extra })
    return true
  }

  /**
   * errno 错误通道 —— **复用上游 #4 的 `fsError` 语义**：EBUSY/EPERM（文件被占用）→ 409 占用文案，
   * 其余 errno → 400 + 固定中文文案（`readableError` 对带 `.code` 的错误不回显原始 message，
   * 因此绝不泄露 dataDir/绝对路径）；不带 `.code` 的业务 Error 保留可读 message。
   * 说明（t4 评审 O6 的旧裁定在此被上游必修 3 推翻）：上游要求的正是这条通道，现予恢复。
   */
  const fsError = (res2: Res, err: unknown): boolean => {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'EBUSY' || e?.code === 'EPERM') {
      json(res2, 409, { error: '文件被占用（可能正在阅读器或其他程序中打开），关闭后重试', code: 'file-busy' })
      return true
    }
    json(res2, 400, { error: readableError(err) })
    return true
  }

  /** 破坏性路由的统一失败出口：我们的 ManageError 优先（status/code/extra），否则走 errno 通道。 */
  const libFail = (res2: Res, err: unknown): boolean => {
    if (isManageError(err)) return manageFail(res2, err)
    return fsError(res2, err)
  }

  /**
   * 某文献的伴读会话统计。**查不到就标 unknown**（不再吞成「0 个会话」）：
   * R4-F3 指出 fail-open 会削弱 S7「有运行中会话就拒绝」——会话服务不可用时无法证明「没有运行中会话」，
   * 破坏性操作据 unknown 走 fail-closed（见 requireSessionClear）。读路径不受影响（只有破坏性路由用它）。
   */
  /** 对外形状固定为 `{total, running}`（既有断言 deepEqual 它）；`unknown` 只在服务端内部用。 */
  const toWire = (i: { total: number; running: number }): { total: number; running: number } => ({ total: i.total, running: i.running })

  const sessionInfo = async (ref: { topic: string; name: string }): Promise<{ total: number; running: number; unknown: boolean }> => {
    if (typeof sessionController?.list !== 'function') return { total: 0, running: 0, unknown: true }
    try {
      const s = await scanPaperSessions(ref)
      return { total: s.length, running: s.filter((x) => x.running).length, unknown: false }
    } catch {
      return { total: 0, running: 0, unknown: true }
    }
  }

  /**
   * 破坏性操作的会话准入（**fail-closed**）：查不到会话状态就**拒绝**，不冒险动手。
   * 取向理由：删除会把产物搬进回收站、重命名会改会话工作区下的文件名；若此时真有会话在跑，
   * 破坏的是用户当前正在用的工作目录。代价是「会话服务抖动时可能白拒一次」，用户重试即可——
   * 可恢复性远好于误删。unknown 用 503 + code=session-unknown，running 用 409 + code=session-running。
   */
  const requireSessionClear = async (ref: { topic: string; name: string }, res: Res): Promise<boolean> => {
    const info = await sessionInfo(ref)
    if (info.unknown) {
      json(res, 503, { error: '暂时无法确认该文献的伴读会话状态，为避免误删已取消本次操作；请稍后重试', code: 'session-unknown' })
      return false
    }
    if (info.running > 0) {
      json(res, 409, { error: `该文献有 ${info.running} 个正在运行的伴读会话，请先结束后再操作`, code: 'session-running', sessions: toWire(info) })
      return false
    }
    return true
  }

  /** 专题级会话准入：该专题内任一篇文献会话状态不明/在跑 → 拒绝。 */
  const requireTopicSessionsClear = async (topic: string, res: Res): Promise<boolean> => {
    for (const p of listPapers(dataDir, topic)) {
      if (!(await requireSessionClear(p, res))) return false
    }
    return true
  }

  /**
   * 契约 R5「并发互斥」的最小在途守卫（R4-F2）：
   * 同一篇文献的删除/重命名在途时，第二个请求直接 409 `busy`（而不是让两个请求交错改同一批文件：
   * 实测后果是第二个请求拿到 404/500 的中间态）。进程内 Set 足够——本插件是单进程 ws 路由。
   * 机器码取 `busy` 而非契约 §5 R5 字面的 `in-progress`：两者语义完全一致（「有操作在途」），
   * `busy` 更短且与既有 `translation-busy`/`session-running` 的短词风格一致；前端 errText 已按 `busy` 对齐。
   */
  const inflight = new Set<string>()
  const withInflight = async (key: string, res: Res, fn: () => Promise<void>): Promise<void> => {
    if (inflight.has(key)) {
      json(res, 409, { error: '同一篇文献的另一个删除/重命名操作正在进行，请稍后重试', code: 'busy' })
      return
    }
    inflight.add(key)
    try {
      await fn()
    } finally {
      inflight.delete(key)
    }
  }

  /**
   * 该范围（或其子树）是否有写操作在途。读路径**不阻塞**（方案 §B3.2：fail-soft），
   * 只在提示里如实说「正在被修改，本次只给了 N 篇」。
   */
  const scopeBusy = (scopePath: string): boolean => {
    const needle = scopePath
    for (const k of inflight) {
      if (k.includes(needle)) return true
    }
    return false
  }

  /** 「文献不存在」的统一出口：404 + 不含服务端绝对路径的文案（原先普通 Error 会冒泡成 500 并带路径）。 */
  const notFound = (what: string) => new ManageError('not-found', 404, what)

  /**
   * **写路径**的文献定位（t3-O2：/api/transcribe 曾接受任意 `path` 并据此写盘）。
   * 规则与删除同级：只认 topic+name；给了 `path` 时其 **realpath 必须落在 dataDir 内**
   * （符号链接指向库外同样拒绝）。校验逻辑全部复用 library-manage 的既有实现，不另写一套。
   */
  const locateForWrite = (body: { topic?: string; name?: string; path?: string }, isUrlSearch = false): PaperRef => {
    void isUrlSearch
    if (body.path) {
      const abs = resolve(String(body.path))
      let real: string
      try {
        real = realpathSync(abs)
      } catch {
        throw notFound('文献不存在（path 指向的文件不可读）')
      }
      assertInside(realDataDir(dataDir), real) // 越界/符号链接逃逸 → 400 escape-rejected
      return resolvePaper(dataDir, { path: abs })
    }
    // exactOptionalPropertyTypes: true —— 不能把 undefined 直接挂到可选属性上
    const args: { topic?: string; name?: string } = {}
    if (body.topic !== undefined) args.topic = body.topic
    if (body.name !== undefined) args.name = body.name
    return resolvePaper(dataDir, args)
  }

  /** 破坏性路由用的文献定位：把 resolvePaper 的普通 Error 统一成 404（含符号链接 .pdf 的情况）。 */
  const resolveLibraryPaper = (topic: string, name: string): PaperRef => {
    try {
      return resolvePaper(dataDir, { topic, name })
    } catch {
      throw notFound(`文献不存在：${name}`)
    }
  }

  /**
   * 外层兜底文案脱敏：把任何**绝对路径**替换成 `<path>`。
   * 说明：这里没有采用「一律不回显 err.message」的极端做法——那会把 MinerU/转录等**可读的领域错误**
   * 一起变成不可读（既有测试明确断言这些文案要含 `MinerU` 等关键词，不许放宽）。改为：领域错误保留可读文案、
   * 但**先剥掉绝对路径**；未知内部错误则只给通用文案。两种情况都带机器可读 `code:'internal'`。
   */
  const stripAbsPaths = (msg: string): string => msg.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"“”（）()]+)+/g, '<path>')

  /** 破坏性路由的统一前置检查：拒绝 path 参数（写路径只认 topic+name）。 */
  const rejectWritePath = (body: { path?: unknown }, res: Res): boolean => {
    if (body.path === undefined || body.path === null || body.path === '') return false
    json(res, 400, { error: '删除/重命名不接受 path 参数，请用 topic + name', code: 'escape-rejected' })
    return true
  }

  const dispatch = async (req: Req, res: Res, url: URL) => {
    const sub = url.pathname.slice('/paper-reader'.length) // '' | '/' | '/api/...'

    if ((sub === '' || sub === '/') && req.method === 'GET') {
      // no-cache：桌面端 webview 无法强刷（README 里浏览器 Cmd+Shift+R 的建议对桌面端
      // 无效），不带缓存头时升级插件后用户会一直看到缓存的旧阅读器页面（实测空白 bug
      // 「修了还在」正是这个）。版本号注入供用户截图反馈时一眼对版本。
      const html = (await readFile(readerHtml)).toString('utf8').replaceAll('__DPR_VERSION__', pluginVersion)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-cache',
      })
      res.end(html)
      return
    }

    // 阅读器静态资源（本地 vendor 的 pdf.js 等；拒绝路径穿越）
    if (sub.startsWith('/vendor/') && req.method === 'GET') {
      const name = sub.slice('/vendor/'.length)
      if (!/^[\w.-]+$/.test(name)) {
        json(res, 400, { error: 'bad asset name' })
        return
      }
      const mime: Record<string, string> = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json',
        // 字体（vendored KaTeX 的 woff2 就靠这条；不给对 MIME 时某些浏览器会拒绝 @font-face）
        '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }
      try {
        const body = await readFile(new URL(name, readerVendorDir))
        const ext = name.slice(name.lastIndexOf('.'))
        const type = mime[ext] ?? 'application/octet-stream'
        // 只有文本类才追加 charset：给 font/woff2 这类二进制资源加 `; charset=utf-8` 是错的
        // （实测 font/woff2 被浏览器按未知类型处理的风险；见 test/reader-vendor-http.test.mjs）
        const texty = type.startsWith('text/') || type === 'application/json'
        res.writeHead(200, { 'content-type': texty ? type + '; charset=utf-8' : type, 'content-length': body.length, 'cache-control': 'no-cache' })
        res.end(body)
      } catch {
        json(res, 404, { error: 'not found' })
      }
      return
    }

    if (sub === '/api/library' && req.method === 'GET') {
      const papers = listPapers(dataDir).map((p) => ({ ...p, pdfPath: join(dataDir, p.topic, p.name, p.name + '.pdf') }))
      // topics 保持「一级子目录」语义（既有调用方/测试），新增 tree = 完整嵌套树（子专题 UI 用）
      json(res, 200, { dataDir, topics: listTopics(dataDir), papers, tree: listTopicTree(dataDir) })
      return
    }

    // 新建专题（目录）。校验与 upload / rename 的 to 侧同一套（validateName：边界 + 命名规范），
    // 保证「能创建的必然能删除/改名」（PR-1 的创建/删除对称原则；创建走 inline 正则时，
    // `.hidden`/超长/含控制字符的名字都能被创建，却是删不掉的孤儿）。
    if (sub === '/api/library/topic' && req.method === 'POST') {
      const body = (await readBody(req)) as { name?: string }
      try {
        // name 是**相对路径**（`A` / `A/B`）：逐段词法校验 + 「已存在的祖先必须是库内真目录」。
        // mkdir(recursive) 天然能一次建多级（方案 §B2.2「天然建多级」）；这里挡的是父链里**已存在**的那几段
        // ——符号链接 / 指向库外的段一律拒（不隐式穿越），不存在的段交给 mkdir 创建。
        const name = validateTopicPath(body.name, false)
        const root = realDataDir(dataDir)
        const segs = name.split('/')
        for (let i = 1; i < segs.length; i++) {
          if (!existsSync(join(root, ...segs.slice(0, i)))) break
          resolveTopicDir(dataDir, segs.slice(0, i).join('/'))
        }
        const dir = join(root, ...segs)
        // 已存在 → 必须是真目录且不是符号链接（与 upload 同一条链路）；不存在 → 词法层已保证不越界
        if (existsSync(dir)) resolveTopicDir(dataDir, name)
        else assertInside(root, dir)
        await mkdir(dir, { recursive: true })
        json(res, 200, { ok: true, topic: name })
      } catch (err) {
        if (!manageFail(res, err)) throw err
      }
      return
    }

    // 上传 PDF 到专题（raw body；文件名/专题走 header，避免 multipart 解析。
    // header 值不允许非 Latin-1 字符，中文一律 encodeURIComponent 编码传输，这里解码）
    if (sub === '/api/library/upload' && req.method === 'POST') {
      const topic = decodeHdr(req.headers['x-dpr-topic'])
      const filename = decodeHdr(req.headers['x-dpr-name'])
      if (typeof topic !== 'string' || typeof filename !== 'string' || !topic.trim() || !filename.trim()) {
        json(res, 400, { error: '缺少 x-dpr-topic / x-dpr-name 头', code: 'bad-request' })
        return
      }
      // 词法层：topic 是**相对路径**，逐段同强度校验（../ / \ 隐藏名 控制字符 超长 空串/层级上限）
      let topicPath: string
      try {
        topicPath = validateTopicPath(topic, false)
      } catch (err) { if (!manageFail(res, err)) throw err; return }
      if (!filename.toLowerCase().endsWith('.pdf')) {
        json(res, 400, { error: '只支持 PDF 文件', code: 'bad-request' })
        return
      }
      const safeName = filename.replaceAll('/', '_').replaceAll('\\', '_')
      // 文件名走**边界类**（上游 #4 口径）：前导点 / 超长 / 非 NUL 控制字符都能上传，
      // 与删除侧对称——upload 能落盘的名字必须能被删（library-symmetry R7/R14）。
      const stem = safeName.slice(0, -4)
      const errStem = validateEntryBoundary(stem)
      if (errStem) { json(res, 400, { error: errStem, code: 'bad-name' }); return }
      // realpath 子路径层（上游 #4 的 resolveUploadTopic）：`data/<topic> → 库外` 与**悬空**符号
      // 链接都在这里被挡（悬空链接 lstat 算存在、realpath 失败 → 400 可读文案，而不是 mkdir 抛 ENOENT 的 500）。
      // 顺序：目标目录的全部校验都在**读 body 之前**——越界目标不消费请求体、不碰盘。
      let dir: string
      try {
        dir = resolveUploadTopic(dataDir, topicPath)
      } catch (err) { json(res, 400, { error: readableError(err), code: 'escape-rejected' }); return }
      // 我们的加严：上游放行「real 落在库内」的符号链接专题，我们一律拒（评审 §B 点名表扬）。
      try {
        if (existsSync(dir)) resolveTopicDir(dataDir, topicPath)
        else assertInside(realDataDir(dataDir), dir)
      } catch (err) {
        if (libFail(res, err)) return
        throw err
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const buf = Buffer.concat(chunks)
      if (buf.length < 100) {
        json(res, 400, { error: '文件内容为空', code: 'bad-request' })
        return
      }
      try {
        // 新布局（方案 §B1.3 #20）：先建**论文文件夹** `<topicDir>/<论文名>/`，PDF 落在里面
        await mkdir(join(dir, stem), { recursive: true })
        await writeFile(join(dir, stem, safeName), buf)
      } catch (err) { fsError(res, err); return }
      json(res, 200, { ok: true, topic: topicPath, name: stem, bytes: buf.length })
      return
    }

    /* ── 路由名兼容层 ─────────────────────────────────────────────────────
       上游 v1.3.0（614b935）为文献库自建了 4 条 CRUD 路由
       `/api/library/{delete,rename}-{topic,paper}` —— **对外规范路径**（上游 UI / 文档 / 上游用例
       都走它们）。我们分支的 `/api/library/{topic,paper}/{delete,rename}` 保留为别名。
       两族共用同一批 handler，底层永远是 library-manage 的加固实现（回收站可恢复 / 精确 stem /
       realpath 三层穿越防护 / 会话·翻译·在途 409 / 删除计划）；上游那份带穿越洞的第二实现
       （rmSync(recursive) 且 topic 未校验）已整段删除 —— 任何时刻只有一份实现。
       body 键也做兼容：topic ?? name、newName ?? to。 */

    /** 非法/越界名字 → 400 可读文案（词法层复用上游 #4 的 validateEntryName；realpath 层由 primitive 兜底）。
     *  放在任何文件系统操作之前：越界输入不会碰到盘。返回 true 表示已响应。 */
    const badEntry = (res: Res, raw: unknown): boolean => {
      const err = typeof raw === 'string' ? validateEntryName(raw) : '名字不能为空'
      if (!err) return false
      json(res, 400, { error: err, code: 'bad-name' })
      return true
    }

    /** 删除 / 改名-from 用（上游 #4 的分层）：只做边界类校验（空、分隔符、`..`、NUL），不卡命名规范。 */
    const badEntryBoundary = (res: Res, raw: unknown): boolean => {
      const err = typeof raw === 'string' ? validateEntryBoundary(raw) : '名字不能为空'
      if (!err) return false
      json(res, 400, { error: err, code: 'bad-name' })
      return true
    }

    /**
     * 专题**路径**的入参门（方案 §B2.2）：topic 升级为相对路径（`A` / `A/B`）后，**全部** topic
     * 入参统一走这里——先逐段词法校验、再解析真目录，禁止保留两套并存的入参语义
     * （否则会出现「同一个 topic 在 clear-plan 能过、在 clear 过不了」的不对称）。
     */
    const badTopicPath = (res: Res, raw: unknown, boundaryOnly: boolean): string | null => {
      try {
        return validateTopicPath(raw, boundaryOnly)
      } catch (err) {
        if (!manageFail(res, err)) throw err
        return null
      }
    }

    // 删除预览（dry-run）：确认弹窗的文件清单必须来自这里，不许前端自己拼
    if (sub === '/api/library/paper/delete-plan' && req.method === 'GET') {
      const topic = url.searchParams.get('topic') ?? ''
      const name = url.searchParams.get('name') ?? ''
      if (url.searchParams.get('path')) {
        json(res, 400, { error: '不接受 path 参数，请用 topic + name', code: 'escape-rejected' })
        return
      }
      try {
        const plan = planPaperDelete(dataDir, topic, name)
        const ref = resolveLibraryPaper(plan.topic, plan.name)
        const sessions = await sessionInfo(ref)
        const zh = zhStatus(ref)
        json(res, 200, {
          topic: plan.topic,
          name: plan.name,
          files: plan.files,
          totalBytes: plan.totalBytes,
          trashRoot: plan.trashRoot,
          sessions: toWire(sessions),
          translation: { busy: zh.busy, hasZh: zh.zh, hasDual: zh.dual },
          notDeleted: plan.notDeleted,
        })
      } catch (err) {
        if (!libFail(res, err)) throw err
      }
      return
    }

    // 删除文献：产物移入 <dataDir>/.trash/（可恢复）。规范名 = 上游 /api/library/delete-paper，
    // 别名 = /api/library/paper/delete。词法门走 badEntry(topic) + badEntryBoundary(name)。
    if ((sub === '/api/library/delete-paper' || sub === '/api/library/paper/delete') && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string }
      if (badEntryBoundary(res, body.name)) return
      if (rejectWritePath(body, res)) return
      const topicPath = badTopicPath(res, body.topic, true)
      if (topicPath === null) return
      await withInflight(`${topicPath}\u0000${String(body.name ?? '')}`, res, async () => {
        try {
          const plan = planPaperDelete(dataDir, body.topic, body.name)
          const ref = resolveLibraryPaper(plan.topic, plan.name)
          const sessions = await sessionInfo(ref)          // 全部前提先校验，再动手
          if (!(await requireSessionClear(ref, res))) return
          if (zhStatus(ref).busy) {
            throw new ManageError('translation-busy', 409, '该文献正在生成译文，请等待完成后再删除', {})
          }
          const r = deletePaper(dataDir, plan.topic, plan.name)
          // `deleted` = 上游字段名（上游用例断言），`moved` = 我们的；同源同义
          json(res, 200, { ...r, deleted: r.moved, sessions: toWire(sessions) })
        } catch (err) {
          if (!libFail(res, err)) throw err
        }
      })
      return
    }

    // 重命名文献：全部同名产物一起改名（含译文变体），`.pdf` 最后移。
    // 规范名 = /api/library/rename-paper（上游 UI 与用例），别名 = /api/library/paper/rename。
    if ((sub === '/api/library/rename-paper' || sub === '/api/library/paper/rename') && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; newName?: string; to?: string; path?: string }
      const rawTo = body.newName ?? body.to
      if (badEntryBoundary(res, body.name) || badEntry(res, rawTo)) return
      if (rejectWritePath(body, res)) return
      const topicPath = badTopicPath(res, body.topic, true)
      if (topicPath === null) return
      await withInflight(`${topicPath}\u0000${String(body.name ?? '')}`, res, async () => {
        try {
          // 先校验名称/越界/存在（planPaperDelete 内部做全套检查）——不能先 resolvePaper：
          // 非法名会在那里抛出非 ManageError 的普通错误，被外层记成 500。
          const plan = planPaperDelete(dataDir, body.topic, body.name)
          const ref = resolveLibraryPaper(plan.topic, plan.name)
          const sessions = await sessionInfo(ref)
          if (!(await requireSessionClear(ref, res))) return
          if (zhStatus(ref).busy) {
            throw new ManageError('translation-busy', 409, '该文献正在生成译文，请等待完成后再重命名', {})
          }
          const r = renamePaper(dataDir, ref.topic, ref.name, rawTo)
          // 会话 id 内嵌 topic/name → 改名后旧会话不再出现在该文献的列表里（不删除，如实回显）
          json(res, 200, { ...r, name: r.to, detachedSessions: sessions.total })
        } catch (err) {
          if (!libFail(res, err)) throw err
        }
      })
      return
    }

    // 删除专题：仅空专题（非隐藏条目为 0），非递归语义；隐藏条目进回收站而不是销毁。
    // 规范名 = /api/library/delete-topic；上游 UI 只发 {topic}（没有确认字段），我们的 UI 发
    // {name, confirmName} 两段式确认。confirmName 语义（本文件）：
    //   · 给了就必须与专题名完全一致（confirmName === topic|name，否则 400 confirm-mismatch）；
    //   · 没给也照走全部前置——**空专题免确认**（上游契约，没有数据可毁），
    //     非空专题一律 409 topic-not-empty（我们的加固，比上游「一点递归删光」保守）。
    if ((sub === '/api/library/delete-topic' || sub === '/api/library/topic/delete') && req.method === 'POST') {
      const body = (await readBody(req)) as { name?: string; topic?: string; confirmName?: string; path?: string }
      const rawName = typeof body.topic === 'string' && body.topic ? body.topic : body.name
      if (typeof rawName !== 'string' || rawName.length === 0) { badEntry(res, rawName); return }
      const topicPath = badTopicPath(res, rawName, true)
      if (topicPath === null) return
      // 词法门两段式（4 条路由都必须在文件系统操作之前过 badEntry，见 upstream V12 的结构性断言）：
      // ① badEntry（上游 #4 的 validateEntryName）挡**类型 / 空值**——非字符串、空串在任何模式下都非法；
      // ② 命名规范类（长度/前导点/非 NUL 控制字符）只对「创建 / 改名-to」强制；删除/改名-from
      //    走 badEntryBoundary（分层理由见其定义：历史遗留的不规范名必须能清掉，否则是删不掉的孤儿）。
      if (rejectWritePath(body, res)) return
      await withInflight(`topic\u0000${topicPath}`, res, async () => {
        try {
          const name = topicPath
          // confirmName 是**可选**栅栏：给了就必须一致（400 confirm-mismatch）；没给也照走全部前置——
          // 空专题免确认（上游 delete-topic {topic} 契约：没有数据可毁），非空专题一律
          // 409 topic-not-empty（我们的加固，比上游「一点递归删光」保守，见 docs/reader-ux-requirements.md）。
          if (body.confirmName !== undefined && body.confirmName !== name) {
            throw new ManageError('confirm-mismatch', 400, '需要 confirmName 与 name 完全一致才允许删除专题', {})
          }
          const plan = planTopicDelete(dataDir, name)     // 全部前提先校验，再动手
          if (plan.entries.length > 0) {
            // clearEndpoint：非空专题的「下一步」——UI 据此进入**批量清空**中间态（上游评论第 10 条）
            throw new ManageError('topic-not-empty', 409, `专题内还有 ${plan.entries.length} 个条目（${plan.papers.length} 篇文献），请用批量清空或先逐篇删除`, {
              entries: plan.entries,
              papers: plan.papers,
              clearEndpoint: '/api/library/topic/clear',
              clearPlanEndpoint: '/api/library/topic/clear-plan',
            })
          }
          if (!(await requireTopicSessionsClear(plan.name, res))) return
          let busy = 0
          for (const p of listPapers(dataDir, plan.name)) {
            if (zhStatus(resolveLibraryPaper(p.topic, p.name)).busy) busy++
          }
          if (busy > 0) throw new ManageError('translation-busy', 409, '该专题有正在生成译文的文献，请等待完成后再删除', {})
          const r = deleteTopic(dataDir, plan.name)
          dropWorkspaceCache(plan.name)  // 清掉指向已删目录（含子树）的工作区缓存
          json(res, 200, { ...r, archivedSessionsNote: true })
        } catch (err) {
          if (!libFail(res, err)) throw err
        }
      })
      return
    }

    // 重命名专题：目录整体改名（历史会话不删除，但不再出现在该专题下）
    if ((sub === '/api/library/rename-topic' || sub === '/api/library/topic/rename') && req.method === 'POST') {
      const body = (await readBody(req)) as { name?: string; topic?: string; newName?: string; to?: string; path?: string }
      const rawName = typeof body.topic === 'string' && body.topic ? body.topic : body.name
      const rawTo = body.newName ?? body.to
      if (typeof rawName !== 'string' || rawName.length === 0) { badEntry(res, rawName); return }
      // from 侧同 delete-topic：先挡类型/空值，命名规范只在改名**目标**（to）上强制
      // ——这样「历史遗留的怪名专题 → 改成规范名」这条路不被自己的校验堵死。
      const topicPath = badTopicPath(res, rawName, true)
      if (topicPath === null) return
      if (badEntry(res, rawTo)) return
      if (rejectWritePath(body, res)) return
      await withInflight(`topic\u0000${topicPath}`, res, async () => {
        try {
          const name = topicPath
          const plan = planTopicDelete(dataDir, name)      // 复用同一个「存在且合法」校验
          if (!(await requireTopicSessionsClear(plan.name, res))) return
          let busy = 0
          let detached = 0
          for (const p of listPapers(dataDir, plan.name)) {
            const ref = resolveLibraryPaper(p.topic, p.name)
            const s = await sessionInfo(ref)
            if (s.unknown) {
              json(res, 503, { error: '暂时无法确认该专题的伴读会话状态，为避免误删已取消本次操作；请稍后重试', code: 'session-unknown' })
              return
            }
            detached += s.total
            if (zhStatus(ref).busy) busy++
          }
          if (busy > 0) throw new ManageError('translation-busy', 409, '该专题有正在生成译文的文献，请等待完成后再重命名', {})
          const r = renameTopic(dataDir, plan.name, rawTo)
          dropWorkspaceCache(plan.name)
          // 响应补 `topic`（上游 UI/文档读法）——我们的 RenameResult 用 from/to
          json(res, 200, { ...r, topic: r.to, detachedSessions: detached })
        } catch (err) {
          if (!libFail(res, err)) throw err
        }
      })
      return
    }

    // 清空预览（dry-run，只读）：非空专题删除的**中间态**清单（上游评论第 10 条）。
    // 形状与 /api/library/paper/delete-plan 对齐（files/totalBytes/notDeleted），逐篇额外给
    // sessions/translation，让 UI 在用户点确认**之前**就能提示「第 7 篇正在翻译」。
    if (sub === '/api/library/topic/clear-plan' && req.method === 'GET') {
      const topic = url.searchParams.get('topic') ?? ''
      if (url.searchParams.get('path')) {
        json(res, 400, { error: '不接受 path 参数，请用 topic', code: 'escape-rejected' })
        return
      }
      try {
        const plan = planTopicClear(dataDir, topic)
        const papers = []
        for (const p of plan.papers) {
          const ref = resolveLibraryPaper(p.topic, p.name)
          const sessions = await sessionInfo(ref)
          const zh = zhStatus(ref)
          papers.push({
            name: p.name,
            topic: p.topic,
            files: p.files,
            totalBytes: p.totalBytes,
            sessions: toWire(sessions),
            translation: { busy: zh.busy, hasZh: zh.zh, hasDual: zh.dual },
          })
        }
        json(res, 200, {
          topic: plan.topic,
          papers,
          papersCount: plan.papersCount,
          filesCount: plan.filesCount,
          totalBytes: plan.totalBytes,
          hidden: plan.hidden,
          subtopics: plan.subtopics.map((s) => ({ topic: s.topic, papersCount: s.papersCount, filesCount: s.filesCount, totalBytes: s.totalBytes })),
          subtopicsCount: plan.subtopics.length,
          trashRoot: plan.trashRoot,
          notDeleted: plan.notDeleted,
          clearEndpoint: '/api/library/topic/clear',
        })
      } catch (err) {
        if (!libFail(res, err)) throw err
      }
      return
    }

    // 批量清空专题（一次确认、逐篇进回收站、失败即整体回滚）：`confirmName === topic` 是**必需**的
    // （手输专题名确认保留在清空这一步，不放松）。
    // 前置：全部校验完（存在性 / 非空 / 逐篇会话 / 逐篇翻译）才动一个字节；
    // 执行：withInflight（同一专题并发只放一个）+ library-manage.clearTopic（非递归 rmdir）。
    if (sub === '/api/library/topic/clear' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; confirmName?: string; path?: string }
      const rawTopic = typeof body.topic === 'string' && body.topic ? body.topic : body.name
      if (typeof rawTopic !== 'string' || rawTopic.length === 0) { badEntry(res, rawTopic); return }
      const topicPath = badTopicPath(res, rawTopic, true)
      if (topicPath === null) return
      if (rejectWritePath(body, res)) return
      if (typeof body.confirmName !== 'string' || body.confirmName.trim() !== topicPath) {
        json(res, 400, { error: '需要 confirmName 与专题名完全一致才允许清空', code: 'confirm-mismatch' })
        return
      }
      await withInflight(`topic\u0000${topicPath}`, res, async () => {
        try {
          const plan = planTopicClear(dataDir, topicPath)   // 存在性 404 / 越界 400 / 符号链接专题 400
          if (plan.papersCount === 0) {
            throw new ManageError('bad-request', 400, '专题已为空，请用删除专题', { clearEndpoint: '/api/library/delete-topic' })
          }
          let detached = 0
          const busyTrans: string[] = []
          for (const p of plan.papers) {
            // 逐篇用**它自己的**专题路径定位（子树清空时根 topic 不再是每篇的父级）
            const ref = resolveLibraryPaper(p.topic, p.name)
            if (!(await requireSessionClear(ref, res))) return   // unknown→503 / running→409（同一套 code）
            detached += (await sessionInfo(ref)).total
            if (zhStatus(ref).busy) busyTrans.push(p.name)
          }
          if (busyTrans.length > 0) {
            throw new ManageError('translation-busy', 409, `以下文献正在生成译文，请等待完成后再清空：${busyTrans.join('、')}`, { papers: busyTrans })
          }
          const r = clearTopic(dataDir, plan.topic)
          dropWorkspaceCache(plan.topic)     // 清掉指向已清空目录（含子树）的工作区缓存
          json(res, 200, { ...r, detachedSessions: detached, archivedSessionsNote: true })
        } catch (err) {
          if (!libFail(res, err)) throw err
        }
      })
      return
    }

    /* ── 布局迁移（旧平铺 → 按论文分文件夹）：方案 §B1.2 的只读预检 + 显式执行 + 回滚 ──
       铁律：默认**只读**；执行必须带 confirm=migrate-library（UI/CLI 先让人核对干跑报告）；
       回滚日志必须在我们的 migration-logs 目录内（不认任意路径，防被当成任意文件读写口）。 */
    if (sub === '/api/library/migrate-plan' && req.method === 'GET') {
      try {
        const plan = planMigration(dataDir)
        json(res, 200, { ok: true, plan, report: formatMigrationReport(plan) })
      } catch (err) {
        if (!libFail(res, err)) throw err
      }
      return
    }

    if (sub === '/api/library/migrate' && req.method === 'POST') {
      const body = (await readBody(req)) as { confirm?: string }
      if (body.confirm !== 'migrate-library') {
        json(res, 400, { error: '需要 confirm=migrate-library 才允许执行迁移（请先 GET /api/library/migrate-plan 人工核对报告）', code: 'confirm-mismatch' })
        return
      }
      await withInflight('migrate\u0000library', res, async () => {
        try {
          const r = runMigration(dataDir)
          json(res, 200, r)
        } catch (err) {
          if (err instanceof MigrationAborted) {
            json(res, 409, { ...err.detail, error: err.message, code: err.code })
            return
          }
          if (err instanceof MigrationError) {
            json(res, 409, { error: err.message, code: err.code })
            return
          }
          if (!libFail(res, err)) throw err
        }
      })
      return
    }

    if (sub === '/api/library/migrate-rollback' && req.method === 'POST') {
      const body = (await readBody(req)) as { confirm?: string; logPath?: string }
      if (body.confirm !== 'rollback-library') {
        json(res, 400, { error: '需要 confirm=rollback-library 才允许回滚', code: 'confirm-mismatch' })
        return
      }
      const logDir = migrationLogDir()
      const logPath = body.logPath?.trim() || lastMigrationLog()
      if (!logPath) {
        json(res, 400, { error: '没有可用的迁移日志（请在 body 里给 logPath）', code: 'bad-request' })
        return
      }
      if (!resolve(logPath).startsWith(resolve(logDir))) {
        json(res, 400, { error: 'logPath 必须是迁移日志目录内的文件', code: 'escape-rejected' })
        return
      }
      await withInflight('migrate\u0000library', res, async () => {
        try {
          const r = rollbackMigration(dataDir, logPath)
          json(res, 200, r)
        } catch (err) {
          if (!libFail(res, err)) throw err
        }
      })
      return
    }

    // 公式索引：MinerU content_list 的 equation 块（LaTeX + bbox），供阅读器画热区/列表面板
    if (sub === '/api/formulas' && req.method === 'GET') {
      const ref = locate(url) // 只读路径，沿用 path/topic/name 三种定位
      json(res, 200, await readFormulaIndex(ref))
      return
    }

    /* ── 划词翻译（公式保留，契约 docs/selection-translate-requirements.md §3.9）─────
       客户端只送「按页 + 按 display 归属切好的 chunk」；行内公式的还原（选区文本 ↔ MinerU
       text 块对齐）在服务端做，所以请求体里**没有任何矩形/bbox/pageSize**。
       本接口只读（不写盘）⇒ 定位沿用 /api/formulas 的读路径语义，不做写路径边界。
       API key 只存在于本进程：请求体只有 model（客户端从 /api/zh 拿到的 apiKeyHint 仅用于展示），
       响应体与错误文案一律不带 key。 */
    if (sub === '/api/translate-selection' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: unknown; name?: unknown; path?: unknown; chunks?: unknown }
      const bad = (msg: string, code = 'bad-request') => json(res, 400, { error: msg, code })

      if (!Array.isArray(body.chunks)) return bad('chunks 必须是数组')
      if (body.chunks.length < 1 || body.chunks.length > MAX_CHUNKS) {
        return bad(`chunks 数量必须在 1~${MAX_CHUNKS} 之间（收到 ${body.chunks.length}）`, 'too-large')
      }
      const chunks: TranslateChunk[] = []
      let total = 0
      for (const raw of body.chunks) {
        if (typeof raw !== 'object' || raw === null) return bad('chunks 的每一项必须是对象')
        const c = raw as { page?: unknown; kind?: unknown; text?: unknown; latex?: unknown }
        const page = c.page
        if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return bad('chunk.page 必须是 ≥1 的整数')
        const text = typeof c.text === 'string' ? c.text : ''
        const latex = typeof c.latex === 'string' ? c.latex : ''
        if (c.kind === 'formula') {
          if (!latex) return bad('formula chunk 的 latex 不能为空')
          if (latex.length > MAX_LATEX_CHARS) return bad(`latex 超过 ${MAX_LATEX_CHARS} 字符`, 'too-large')
          total += latex.length
          chunks.push({ page, kind: 'formula', latex })
          continue
        }
        if (c.kind !== 'text') return bad("chunk.kind 必须为 'text' 或 'formula'")
        if (text.length > MAX_TEXT_CHARS) return bad(`text 超过 ${MAX_TEXT_CHARS} 字符`, 'too-large')
        total += text.length
        chunks.push({ page, kind: 'text', text })
      }
      if (total === 0) return bad('选区为空')
      if (total > MAX_TOTAL_CHARS) return bad(`选区总长超过 ${MAX_TOTAL_CHARS} 字符`, 'too-large')

      let ref: PaperRef
      try {
        const args: { path?: string; topic?: string; name?: string } = {}
        if (typeof body.path === 'string' && body.path) args.path = body.path
        else {
          if (typeof body.topic !== 'string' || typeof body.name !== 'string' || !body.topic || !body.name) {
            return bad('必须提供 topic + name（或 path）')
          }
          args.topic = body.topic
          args.name = body.name
        }
        ref = resolvePaper(dataDir, args)
      } catch {
        throw notFound('文献不存在（划词翻译需要先能定位到该文献）')
      }

      const { endpoint, source } = await resolveTranslateEndpoint(config.translate)
      if (source === 'none') {
        json(res, 503, { error: '未配置翻译端点：在阅读器里点 ⚙ 填写（OpenAI 兼容端点即可）', code: 'no-endpoint' })
        return
      }
      const index = await readTextBlockIndex(ref)
      const asm = assembleSource(chunks, index)
      try {
        const r = await translateSelection(endpoint, asm.source)
        json(res, 200, {
          translation: r.translation,
          model: r.model,
          cached: r.cached,
          formulaTotal: r.formulaTotal,
          formulaKept: r.formulaKept,
          formulaLost: r.formulaLost,
          formulaApplied: asm.applied,
          formulaSkipped: asm.skipped,
          formulaStatus: formulaStatusOf(asm),
          hasBlockIndex: asm.hasBlockIndex,
          ms: r.ms,
        })
      } catch (err) {
        if (!(err instanceof SelectionTranslateError)) throw err
        json(res, err.status, {
          error: err.message,
          code: err.code,
          ...(err.upstreamStatus !== null ? { upstreamStatus: err.upstreamStatus } : {}),
        })
      }
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
        pdfPath: ref.pdfPath,
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
      // download=1 → 附件下载（导出译文/原文）；文件名即磁盘名 <名>.pdf / -zh.pdf / -dual.pdf
      const headers: Record<string, string | number> = {
        'content-type': 'application/pdf',
        'content-length': st.size,
        'cache-control': 'no-cache', // 切换文献/重新生成后必须拿到新的
      }
      if (url.searchParams.get('download') === '1') {
        const name = basename(pdfPath)
        headers['content-disposition'] =
          `attachment; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`
      }
      res.writeHead(200, headers)
      createReadStream(pdfPath).pipe(res)
      return
    }

    // 中文版状态：zh=纯中文 dual=中英对照 busy=翻译中。
    // 顺带返回生效端点的脱敏信息，让 UI 能回答「正在用哪个模型/key 翻」——key 只给掩码。
    if (sub === '/api/zh' && req.method === 'GET') {
      const { endpoint, source } = await resolveTranslateEndpoint(config.translate)
      json(res, 200, {
        ...zhStatus(locate(url)),
        model: endpoint.model ?? null,
        apiKeyHint: endpoint.apiKey ? maskApiKey(endpoint.apiKey) : null,
        endpointSource: source,
      })
      return
    }

    // 启动后台翻译（幂等；force=true 为重翻：先删已有译文再启动）。端点：UI 里填的 > profile 的 translate
    if (sub === '/api/zh/generate' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string; force?: boolean }
      let ref: PaperRef
      try {
        // 同样写盘（<文献>-zh.pdf 落在 PDF 旁边）→ 与 transcribe 同一套 path 边界约束
        ref = locateForWrite(body)
      } catch (err) {
        if (manageFail(res, err)) return
        throw err
      }
      const { endpoint } = await resolveTranslateEndpoint(config.translate)
      const r = body.force
        ? await restartTranslation(ref, dataDir, endpoint)
        : await startTranslation(ref, dataDir, endpoint)
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

    // ── Jev/TypeSafe 端点配置（设置面板的读写口）─────────────────────────
    // 与翻译配置同一套约定：GET 只回显掩码 key；POST 预检通过才落盘；DELETE 回落
    if (sub === '/api/typesafe/config' && req.method === 'GET') {
      const { cfg, source } = await resolveTypesafeConfig(config.typesafe)
      json(res, 200, {
        baseUrl: cfg.baseUrl ?? '',
        model: cfg.model ?? '',
        hasApiKey: Boolean(cfg.apiKey),
        apiKeyHint: cfg.apiKey ? maskApiKey(cfg.apiKey) : '',
        source,
      })
      return
    }

    // POST：baseUrl/model 可空（SDK 有默认值）；key 留空 = 沿用已存的那把。
    // 校验 → 预检 → 通了才落盘：重排失败会静默降级，key 填错很难察觉，这里先拦。
    if (sub === '/api/typesafe/config' && req.method === 'POST') {
      const body = (await readBody(req)) as { baseUrl?: string; apiKey?: string; model?: string }
      const baseUrl = body.baseUrl?.trim() ?? ''
      const model = body.model?.trim() ?? ''
      const prev = await readTypesafeConfig()
      const apiKey = body.apiKey?.trim() || prev?.apiKey || ''
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        json(res, 400, { error: '端点 URL 需要以 http:// 或 https:// 开头（留空用官方默认）' })
        return
      }
      if (!apiKey) {
        json(res, 400, { error: 'API Key 不能为空' })
        return
      }
      const test = await testTypesafeEndpoint({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) })
      if (!test.ok) {
        json(res, 400, { error: `连接测试失败：${test.detail ?? '未知原因'}` })
        return
      }
      await writeTypesafeConfig({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) })
      json(res, 200, { ok: true })
      return
    }

    // DELETE：清掉文件，回落到 profile 的 typesafe / 环境变量
    if (sub === '/api/typesafe/config' && req.method === 'DELETE') {
      await clearTypesafeConfig()
      json(res, 200, { ok: true })
      return
    }

    /* ── 阅读器深色模式配置（方案 §A2.3）：设置面板卡片与阅读器 ⚙ 浮层**共用同一个后端配置** ──
       无密钥 ⇒ GET 直接回生效值 + 实测曲线（前端据此算 CSS 变量）；POST 严格校验后落盘；
       DELETE 回落默认（follow）。 */
    if (sub === '/api/theme/config' && req.method === 'GET') {
      const cfg = await readThemeConfig()
      json(res, 200, { ...themePayload(cfg), source: 'file' })
      return
    }

    if (sub === '/api/theme/config' && req.method === 'POST') {
      const body = (await readBody(req)) as Record<string, unknown>
      let next
      try {
        const prev = await readThemeConfig()
        next = validateThemePatch({ ...prev, ...(body as Record<string, unknown>) })
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : '配置非法', code: 'bad-request' })
        return
      }
      await writeThemeConfig(next)
      json(res, 200, { ok: true, ...themePayload(next) })
      return
    }

    if (sub === '/api/theme/config' && req.method === 'DELETE') {
      await clearThemeConfig()
      json(res, 200, { ok: true, ...themePayload(await readThemeConfig()) })
      return
    }

    // ── 嵌入模型端点配置（设置面板第三张端点卡片）─────────────────────────
    // 与 translate/typesafe 完全同一套约定：GET 只回掩码 key；POST 预检通过才落盘；DELETE 回落。
    if (sub === '/api/embed/config' && req.method === 'GET') {
      const { cfg, source, enabled } = await resolveEmbedConfig(config.embed)
      json(res, 200, {
        baseUrl: cfg.baseUrl ?? '',
        model: cfg.model ?? '',
        hasApiKey: Boolean(cfg.apiKey),
        apiKeyHint: cfg.apiKey ? maskEmbedApiKey(cfg.apiKey) : '',
        enabled,
        source,
      })
      return
    }

    // POST：baseUrl/model/key 三项齐全是启用条件；key 留空 = 沿用已存的那把。
    // 校验 → 预检（真打一发 /embeddings）→ 通了才落盘：嵌入失败是静默降级，填错很难察觉。
    if (sub === '/api/embed/config' && req.method === 'POST') {
      const body = (await readBody(req)) as { baseUrl?: string; apiKey?: string; model?: string }
      const baseUrl = body.baseUrl?.trim() ?? ''
      const model = body.model?.trim() ?? ''
      const prev = await readEmbedConfig()
      const apiKey = body.apiKey?.trim() || prev?.apiKey || ''
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        json(res, 400, { error: '端点 URL 需要以 http:// 或 https:// 开头' })
        return
      }
      if (!model) {
        json(res, 400, { error: '嵌入模型名不能为空' })
        return
      }
      if (!apiKey) {
        json(res, 400, { error: 'API Key 不能为空' })
        return
      }
      const test = await testEmbedEndpoint({ baseUrl, apiKey, model })
      if (!test.ok) {
        json(res, 400, { error: `连接测试失败：${test.detail ?? '未知原因'}` })
        return
      }
      await writeEmbedConfig({ baseUrl, apiKey, model })
      json(res, 200, { ok: true })
      return
    }

    // DELETE：清掉文件，回落到 profile 的 embed / 环境变量
    if (sub === '/api/embed/config' && req.method === 'DELETE') {
      await clearEmbedConfig()
      json(res, 200, { ok: true })
      return
    }

    // ── MinerU 解析后端配置（设置面板第三张卡片的读写口）────────────────────
    // 与 translate/typesafe 同一套约定：GET 只回显掩码 key；POST 预检通过才落盘；DELETE 回落。
    const MINERU_SOURCES = new Set(['auto', 'pdfjs', 'mineru-local', 'mineru-cloud'])

    if (sub === '/api/mineru/config' && req.method === 'GET') {
      const { config: cfg, source } = await resolveMineruConfig(config.mineru)
      json(res, 200, {
        mode: cfg.mode,
        source,
        local: {
          baseUrl: cfg.local.baseUrl,
          backend: cfg.local.backend,
          effort: cfg.local.effort,
          parseMethod: cfg.local.parseMethod,
          langList: cfg.local.langList,
          hasApiKey: Boolean(cfg.local.apiKey),
          apiKeyHint: cfg.local.apiKey ? maskApiKey(cfg.local.apiKey) : '',
        },
        cloud: {
          baseUrl: cfg.cloud.baseUrl,
          modelVersion: cfg.cloud.modelVersion,
          hasApiKey: Boolean(cfg.cloud.apiKey),
          apiKeyHint: cfg.cloud.apiKey ? maskApiKey(cfg.cloud.apiKey) : '',
        },
      })
      return
    }

    // POST：校验 → 预检 → 通了才落盘。key 留空沿用已存值（明文不回传，前端无法预填）。
    if (sub === '/api/mineru/config' && req.method === 'POST') {
      const body = (await readBody(req)) as { mode?: string; local?: Record<string, unknown>; cloud?: Record<string, unknown> }
      if (body.mode !== undefined && body.mode !== 'off' && body.mode !== 'local' && body.mode !== 'cloud') {
        json(res, 400, { error: 'mode 只能是 off/local/cloud' })
        return
      }
      const prev = await resolveMineruConfig(config.mineru)
      const next = mergeMineruBody(prev.config, body)
      const test = await precheckMineruConfig(next)
      if (!test.ok) {
        json(res, 400, { error: test.detail ?? '连接测试失败' })
        return
      }
      await writeMineruConfig(next)
      json(res, 200, { ok: true })
      return
    }

    // DELETE：清掉文件，回落到 profile 的 mineru / 环境变量
    if (sub === '/api/mineru/config' && req.method === 'DELETE') {
      await clearMineruConfig()
      json(res, 200, { ok: true })
      return
    }

    // 连通性预检（不落盘）：设置面板「测试连接」按钮用；HTTP 恒 200，便于 UI 展示。
    if (sub === '/api/mineru/test' && req.method === 'POST') {
      const body = (await readBody(req)) as { mode?: string; local?: Record<string, unknown>; cloud?: Record<string, unknown> }
      const prev = await resolveMineruConfig(config.mineru)
      const next = mergeMineruBody(prev.config, body)
      const test = await precheckMineruConfig(next)
      if (test.ok) json(res, 200, { reachable: true, mode: next.mode })
      else json(res, 200, { reachable: false, mode: next.mode, error: test.detail ?? '连接测试失败' })
      return
    }

    // 健康探针：GET /api/mineru/health（可选 ?mode=local|cloud，默认按生效 mode）
    if (sub === '/api/mineru/health' && req.method === 'GET') {
      const modeParam = url.searchParams.get('mode')
      const mode = modeParam === 'local' || modeParam === 'cloud' ? modeParam : (await resolveMineruConfig(config.mineru)).config.mode
      if (mode === 'off') {
        json(res, 200, { reachable: false, mode: 'off', error: 'MinerU 未启用（mode=off）' })
        return
      }
      if (mode === 'local') {
        const { config: cfg } = await resolveMineruConfig(config.mineru)
        const t = await testMineruLocal(cfg.local.baseUrl)
        if (!t.ok) {
          json(res, 200, { reachable: false, mode: 'local', error: t.detail ?? '不可达' })
          return
        }
        const h = t.health ?? {}
        json(res, 200, {
          reachable: true,
          mode: 'local',
          status: h['status'] ?? 'healthy',
          version: t.version ?? '',
          protocolVersion: h['protocol_version'] ?? null,
          queuedTasks: h['queued_tasks'] ?? 0,
          processingTasks: h['processing_tasks'] ?? 0,
        })
        return
      }
      const { config: cfg } = await resolveMineruConfig(config.mineru)
      const t = await testMineruCloud(cfg.cloud.baseUrl, cfg.cloud.apiKey)
      if (t.ok) json(res, 200, { reachable: true, mode: 'cloud' })
      else json(res, 200, { reachable: false, mode: 'cloud', error: t.detail ?? '不可达' })
      return
    }

    if (sub === '/api/transcribe' && req.method === 'POST') {
      const body = (await readBody(req)) as { topic?: string; name?: string; path?: string; force?: boolean; source?: string }
      let ref: PaperRef
      try {
        // t3-O2：这条路由会**写盘**（<文献>.txt 等落在 PDF 旁边），所以 path 必须受与删除同级的边界约束
        ref = locateForWrite(body)
      } catch (err) {
        if (manageFail(res, err)) return
        throw err
      }
      const mineru = await resolveMineruConfig(config.mineru)
      const source: SourceArg = MINERU_SOURCES.has(body.source ?? 'auto') ? (body.source as SourceArg) : 'auto'
      const t = await transcribePaper(ref, { force: body.force === true, source, mineru })
      json(res, 200, { chars: t.chars, pageCount: t.pageCount, hasPageIndex: t.pages.length > 0, source: t.source, producer: t.producer, backend: t.backend })
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
        kind?: 'text' | 'equation' // 引用类型（equation = MinerU LaTeX 公式引用）
        equationIndex?: number      // 页内公式序号（仅 equation 时有意义）
        n?: number // 会话序号（会话1/会话2/…）；缺省进最新
        fresh?: boolean // true=强制新建一个会话（新建对话）
        // 提问范围（方案 §B3）：缺省 = 当前论文（与改造前**逐字一致**）
        scope?: { kind?: string; topic?: string; name?: string }
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
      // ── 范围（方案 §B3.1）：缺省/无效一律按「当前论文」；给了非法结构则显式 400 ──
      let scope: AskScope | null = null
      if (body.scope !== undefined && body.scope !== null) {
        const raw = body.scope
        if (typeof raw !== 'object') { json(res, 400, { error: 'scope 必须是对象', code: 'bad-request' }); return }
        if (raw.kind === 'paper') {
          const args: { topic?: string; name?: string } = {}
          if (raw.topic !== undefined) args.topic = raw.topic
          if (raw.name !== undefined) args.name = raw.name
          if (body.topic === undefined && args.topic === undefined && args.name === undefined) {
            json(res, 400, { error: 'scope.kind=paper 需要 topic/name（或省略 scope 用当前论文）', code: 'bad-request' })
            return
          }
          scope = { kind: 'paper', ...args }
        } else if (raw.kind === 'topic') {
          try {
            scope = { kind: 'topic', topic: validateTopicPath(raw.topic, false) }
          } catch (err) {
            if (!manageFail(res, err)) throw err
            return
          }
        } else {
          json(res, 400, { error: "scope.kind 只能是 'paper' 或 'topic'", code: 'bad-request' })
          return
        }
      }
      const hasQuote = typeof body.selectedText === 'string' && body.selectedText.trim() !== ''
      // 公式引用（kind='equation'）：引用内容来自 MinerU 的 LaTeX，不是文本层乱码（契约 §1.3）；
      // 非公式路径的文案必须与改造前逐字一致（回归项 A11）。
      const isEquation = body.kind === 'equation'
      const where = hasQuote && body.page ? `（选中于第 ${body.page} 页）` : ''
      const lines = [
        `[论文伴读] 文献：${ref.topic}/${ref.name}（同目录下，search_paper 可直接检索；回答注明页码）`,
      ]
      if (hasQuote) {
        lines.push(
          isEquation
            ? `用户在阅读器里引用了${body.page ? `第 ${body.page} 页的` : ''}一个公式（LaTeX 源，来自 MinerU 版面解析）：`
            : `用户在阅读器里选中了一段文字${where}：`,
          `"""${body.selectedText!.trim()}"""`,
        )
      }
      // 范围块：**追加**（不传 scope 时这段完全不存在 ⇒ 既有文案逐字不变，回归项 C2）
      let scopeInfo: Record<string, unknown> | null = null
      if (scope) {
        try {
          const ctx = buildScopeContext(dataDir, ref, scope, body.question)
          lines.push(ctx.block)
          if (scopeBusy(ctx.scopePath)) {
            lines.push(`（提示：该范围内的目录正在被修改，本次只给了 ${ctx.papers.length - ctx.omitted} 篇）`)
          }
          scopeInfo = {
            kind: scope.kind,
            path: ctx.scopePath,
            papers: ctx.papers.length - ctx.omitted,
            omitted: ctx.omitted,
            truncated: ctx.truncated,
            chars: ctx.totalChars,
            coverage: ctx.papers.map((p) => ({ path: p.path, coverage: p.coverage })),
          }
        } catch (err) {
          if (isManageError(err)) { libFail(res, err); return }
          // 读路径 fail-soft：范围装配失败不阻断提问，降级成「只说范围、不给内容」并如实标注
          lines.push(`【提问范围】${scope.kind === 'topic' ? scope.topic : '当前论文'}（范围内容装配失败，已在无范围内容的情况下提问）`)
          scopeInfo = { kind: scope.kind, path: scope.kind === 'topic' ? scope.topic : `${ref.topic}/${ref.name}`, degraded: true }
        }
      }
      lines.push(`用户的问题：${body.question}`)
      const prompt = lines.join('\n')
      await sc.prompt({
        sessionId,
        content: [{ type: 'text', text: prompt }],
        requestId: randomUUID(),
      }, AbortSignal.timeout(30_000))
      json(res, 200, { ok: true, sessionId, n, ...(scopeInfo ? { scope: scopeInfo } : {}) })
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
        // 借浏览器请求的 Host 头记录服务 origin（工具结果里的 readerUrl 链接基址靠它拼）
        noteOrigin(req.headers.host)
        const url = new URL(req.url ?? '/', 'http://x')
        dispatch(req, res, url).catch((err) => {
          if (res.headersSent) { res.end(); return }
          // ① 域内可识别错误（ManageError）：用它的状态码/机器码/结构化字段
          if (isManageError(err)) {
            json(res, err.status, { error: err.message, code: err.code, ...err.extra })
            return
          }
          // ② MinerU / 转录的**领域错误**：保留可读文案（既有测试明确断言这些文案含 `MinerU` 等关键词，
          //    不许为了让文案变得「绝对安全」而把它们一起打哑），但先剥掉任何绝对路径。
          // ③ 其余未知内部错误：不回显 err.message（原生 fs 错误常带绝对路径），只给通用文案。
          //    两种情况都带 machine-readable code:'internal'。
          const known = err instanceof MineruError || err instanceof ShortTextError || err instanceof ScannedPdfError
          const raw = err instanceof Error ? err.message : String(err)
          // R7-F2：兜底文案承诺「详见服务端日志」，这里必须真的落一条日志。双重脱敏：
          // stripAbsPaths 剥绝对路径、sanitizeDetail 剥凭据（Bearer / sk-* / ?token=），绝不把路径或密钥写进日志。
          console.error('[dsh-paper-reader] route error:', sanitizeDetail(stripAbsPaths(raw)))
          json(res, 500, { error: known ? stripAbsPaths(raw) : '内部错误（详见服务端日志）', code: 'internal' })
        })
      },
    })
    console.log('[dsh-paper-reader] routes registered under /paper-reader')
    return dispose
  })
}
