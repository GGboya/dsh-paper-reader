// test/embed-search.test.mjs — 嵌入模型检索 + 折叠三项（查询侧归一化 / F-R1 / F-R2）的测试。
//
// 全部用本地 mock 嵌入服务（node:http，无新依赖、无真实服务商 key）。只 import dist/*.js。
// 跑前先 `npm run build`。
//
// 覆盖：
//   A 配置：embed.json 0600 / 优先级 file > profile > env / enabled 三件套 / DELETE 回落
//   B 客户端：批量、维度与形状校验、NaN 拒绝、错误脱敏（不泄露 key）
//   C 缓存：键 {model, dimensions, 内容哈希}、命中零分块请求、重复查询零请求、换模型/改文本重算
//   D 混合召回：语义候选确实改变结果、RRF 融合保护关键词强命中、未配置时与纯关键词一致
//   E 降级：端点不可达 / HTTP 错误 / 维度不匹配 / 非数值 → 如实标降级且不抛错
//   F 惰性：转录用例里零嵌入请求（transcribe.ts 不碰嵌入）
//   G 折叠项 1：查询侧归一化（Q_{t} → Q_t，两种写法命中同一页；x_{ij}/x_{t-1} 不动；pdfjs 无新行为）
//   H 折叠项 2/3：F-R1 精确白名单 + 多参数命令全组保护；F-R2 跳过 \text{} 组内部

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

// $DSH_HOME 指向临时目录：embed.json 落在这里，绝不碰用户真实 home。
const HOME = mkdtempSync(join(tmpdir(), 'dpr-embed-home-'))
process.env.DSH_HOME = HOME
delete process.env.DSH_EMBED_API_KEY

const embed = await import(dist('embed.js'))
const econf = await import(dist('embed-config.js'))
const search = await import(dist('search.js'))
const mineru = await import(dist('mineru.js'))
const { registerRoutes } = await import(dist('host.js'))
const { registerTools } = await import(dist('tools.js'))

const {
  EmbedError, EMBED_DEFAULTS, chunkSetHash, cosineSimilarity, embeddingsPathFor, embeddingsUrl,
  embeddingRecall, embeddingRecallFor, ensureChunkVectors, fuseHybridCandidates,
  readEmbedCache, requestEmbeddings, validateEmbeddings, embedQuery, clearEmbedQueryMemo,
} = embed
const { embedConfigPath, readEmbedConfig, writeEmbedConfig, clearEmbedConfig, resolveEmbedConfig, testEmbedEndpoint } = econf
const { chunkText, searchChunks, searchChunksMulti, queryVariants, queryVariantsFor, compactQuery } = search
const { compressMathSpaces, normalizeMathBraces } = mineru

/** 确定性的分块（避免依赖 chunkText 的边界，测试只关心嵌入链路）。 */
function mkChunks(texts) {
  let at = 0
  return texts.map((text, i) => {
    const c = { index: i + 1, start: at, end: at + text.length, text }
    at = c.end + 2
    return c
  })
}

function tempDir(prefix = 'dpr-embed-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** mock 嵌入端点：把文本映射成确定性向量（词袋计数），并统计请求。 */
function startEmbedServer(opts = {}) {
  const state = { requests: 0, batches: 0, singles: 0, inputs: [], bodies: [], fail: null, dim: opts.dim ?? 3 }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      state.requests++
      const body = Buffer.concat(chunks).toString('utf8')
      state.bodies.push({ url: req.url, auth: req.headers.authorization, body })
      if (state.fail) {
        res.writeHead(state.fail.status ?? 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: state.fail.message ?? 'boom' }))
        return
      }
      const parsed = JSON.parse(body)
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      if (inputs.length === 1) state.singles++
      else state.batches++
      state.inputs.push(...inputs)
      const data = inputs.map((t, index) => ({ object: 'embedding', index, embedding: opts.vectorFor ? opts.vectorFor(t, state.dim) : bagVector(t, state.dim) }))
      if (opts.rawData) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: opts.rawData(data, inputs) }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', model: parsed.model, data }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.url = `http://127.0.0.1:${server.address().port}/v1`
      state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) })
      resolve(state)
    })
  })
}

/** 词袋向量（确定性、量纲小）：维度 0=语义组 A，1=语义组 B，2=其它。 */
function bagVector(text, dim = 3) {
  const t = String(text).toLowerCase()
  const groupA = (t.match(/locality|temporal|checkpoint|world model/g) || []).length
  const groupB = (t.match(/reward|policy|planning/g) || []).length
  const other = t.length % 7
  const v = [groupA, groupB, other]
  while (v.length < dim) v.push(0)
  return v.slice(0, dim)
}

const REQ = (url, model = 'mock-embed-3') => ({ baseUrl: url, apiKey: 'sk-test-key-123456', model })

function writeCacheTree(dir, { text, producer = 'mineru-local', pages = [{ page: 1, start: 0, end: text.length }] } = {}) {
  const topic = join(dir, '默认专题')
  mkdirSync(topic, { recursive: true })
  const base = join(topic, 'paper')
  writeFileSync(base + '.txt', text, 'utf8')
  writeFileSync(base + '.pages.json', JSON.stringify({ pageCount: 1, pages }), 'utf8')
  writeFileSync(base + '.transcript.json', JSON.stringify({ v: 1, producer, createdAt: 'x', text: { chars: text.length, pageCount: 1 } }), 'utf8')
  return { topic: '默认专题', name: 'paper', txtPath: base + '.txt', cachePath: base + '.embeddings.json' }
}

// ── A. 配置范式（embed.json / 优先级 / enabled / 0600 / DELETE 回落）────────

test('A1 配置：write→read→clear，0600；enabled 需要 baseUrl+model+apiKey 三件套', async () => {
  const dir = tempDir()
  const path = embedConfigPath(dir)
  assert.equal(path, join(dir, '.dsh-paper-reader', 'embed.json'))
  await writeEmbedConfig({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-abc', model: 'm' }, dir)
  assert.equal(statSync(path).mode & 0o777, 0o600, '必须 0600')
  const back = await readEmbedConfig(dir)
  assert.equal(back.baseUrl, 'http://127.0.0.1:9/v1')
  assert.equal(back.apiKey, 'sk-abc')
  assert.equal(back.model, 'm')
  const resolved = await resolveEmbedConfig(undefined, dir)
  assert.equal(resolved.source, 'file')
  assert.equal(resolved.enabled, true)
  // 缺任一项 → 不启用（默认关闭）
  await writeEmbedConfig({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }, dir)
  assert.equal((await resolveEmbedConfig(undefined, dir)).enabled, false)
  await clearEmbedConfig(dir)
  assert.equal(existsSync(path), false)
  assert.equal((await readEmbedConfig(dir)), null)
  rmSync(dir, { recursive: true, force: true })
})

test('A2 配置优先级：file > profile > 环境变量 DSH_EMBED_API_KEY', async () => {
  const dir = tempDir()
  const profile = { baseUrl: 'http://profile/v1', apiKey: 'sk-profile', model: 'p-model' }
  process.env.DSH_EMBED_API_KEY = 'sk-env'
  try {
    const envOnly = await resolveEmbedConfig(profile, dir)
    assert.equal(envOnly.cfg.apiKey, 'sk-profile', 'profile 优先于 env')
    assert.equal(envOnly.source, 'profile')
    await writeEmbedConfig({ apiKey: 'sk-file' }, dir)
    const fileWins = await resolveEmbedConfig(profile, dir)
    assert.equal(fileWins.cfg.apiKey, 'sk-file', '文件优先于 profile')
    assert.equal(fileWins.cfg.baseUrl, 'http://profile/v1', '逐字段回落 profile')
    assert.equal(fileWins.source, 'file')
    await clearEmbedConfig(dir)
    const envFallback = await resolveEmbedConfig(undefined, dir)
    assert.equal(envFallback.cfg.apiKey, 'sk-env')
    assert.equal(envFallback.source, 'env')
    assert.equal(envFallback.enabled, false, '只有 key、缺 baseUrl/model → 仍默认关闭')
  } finally {
    delete process.env.DSH_EMBED_API_KEY
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A3 预检：三项缺失 / 端点不可达 / 正常端点（返回维度）', async () => {
  assert.equal((await testEmbedEndpoint({})).ok, false)
  const dead = await testEmbedEndpoint({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm', timeoutMs: 800 })
  assert.equal(dead.ok, false)
  const srv = await startEmbedServer()
  try {
    const ok = await testEmbedEndpoint(REQ(srv.url))
    assert.equal(ok.ok, true)
    assert.match(ok.detail, /维度 3/)
  } finally {
    await srv.close()
  }
})

test('A4 路由：GET 只回掩码、POST 预检失败不落盘成功才落盘、DELETE 回落', async () => {
  const home = tempDir('dpr-embed-routes-home-')
  const data = tempDir('dpr-embed-routes-data-')
  const srv = await startEmbedServer()
  let spec = null
  const ctx = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {},
    workspaceController: {},
    workspaceRegistry: {},
    effect: (fn) => fn(),
  }
  const prevHome = process.env.DSH_HOME
  try {
    // 用临时 HOME 重建一次路由（config 的 embed 走 profile 通道）
    process.env.DSH_HOME = home
    const { registerRoutes: register } = await import(dist('host.js'))
    register(ctx, { dataDir: data })
    const server = createServer((req, res) => spec.handler(req, res))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}/paper-reader`
    try {
      const get0 = await (await fetch(`${base}/api/embed/config`)).json()
      assert.equal(get0.hasApiKey, false)
      assert.equal(get0.enabled, false)
      // 预检失败（key 错不到哪去，这里用不可达端点）→ 400 且不落盘
      const bad = await fetch(`${base}/api/embed/config`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-dead-key-123', model: 'm' }),
      })
      assert.equal(bad.status, 400)
      assert.equal(existsSync(join(home, '.dsh-paper-reader', 'embed.json')), false, '预检失败不得落盘')
      // 预检通过 → 200 且落盘；GET 只回掩码
      const ok = await fetch(`${base}/api/embed/config`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: srv.url, apiKey: 'sk-real-key-abcdef', model: 'mock-embed-3' }),
      })
      assert.equal(ok.status, 200)
      const get1 = await (await fetch(`${base}/api/embed/config`)).json()
      assert.equal(get1.enabled, true)
      assert.equal(get1.hasApiKey, true)
      assert.equal(get1.apiKeyHint, 'sk-…cdef')
      assert.equal(JSON.stringify(get1).includes('sk-real-key-abcdef'), false, '明文 key 不回传')
      // DELETE → 回落（文件没了）
      const del = await fetch(`${base}/api/embed/config`, { method: 'DELETE' })
      assert.equal(del.status, 200)
      assert.equal(existsSync(join(home, '.dsh-paper-reader', 'embed.json')), false)
      assert.equal((await (await fetch(`${base}/api/embed/config`)).json()).enabled, false)
    } finally {
      await new Promise((r) => server.close(r))
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    registerRoutes // 保持引用（首轮注册仅用于确认模块可加载）
    await srv.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
})

// ── B. 客户端：批量 / 形状 / 非数值 / 脱敏 ───────────────────────────────

test('B1 客户端：按 batchSize 分批提交，顺序与条数保持', async () => {
  const srv = await startEmbedServer()
  try {
    const chunks = chunkText(Array.from({ length: 5 }, (_, i) => `paragraph ${i} locality temporal`).join('\n\n'), 40)
    const { vectors, dimensions, fromCache } = await ensureChunkVectors({
      cachePath: join(tempDir(), 'x.embeddings.json'),
      chunks,
      req: REQ(srv.url),
      batchSize: 2,
    })
    assert.equal(vectors.length, chunks.length)
    assert.equal(dimensions, 3)
    assert.equal(fromCache, false)
    assert.equal(srv.requests, Math.ceil(chunks.length / 2), '请求数 = ceil(分块数 / batchSize)')
    assert.equal(srv.inputs.length, chunks.length)
    assert.deepEqual(srv.inputs, chunks.map((c) => c.text), '提交的就是分块文本本身（顺序一致）')
    assert.equal(srv.bodies[0].auth, 'Bearer sk-test-key-123456')
    assert.match(srv.bodies[0].url, /\/v1\/embeddings$/)
  } finally {
    await srv.close()
  }
})

test('B2 形状校验：条数不符 / 非数组 / 维度不一致 / NaN 都必须拒绝', () => {
  assert.throws(() => validateEmbeddings([{ embedding: [1, 2] }], 2, 'x'), EmbedError)
  assert.throws(() => validateEmbeddings('nope', 1, 'x'), EmbedError)
  assert.throws(() => validateEmbeddings([{ embedding: [1, 2] }, { embedding: [1, 2, 3] }], 2, 'x'), /维度不一致/)
  assert.throws(() => validateEmbeddings([{ embedding: [1, Number.NaN] }], 1, 'x'), /非数值/)
  assert.throws(() => validateEmbeddings([{ embedding: [1, Number.POSITIVE_INFINITY] }], 1, 'x'), /非数值/)
  assert.throws(() => validateEmbeddings([{ embedding: [1, 'x'] }], 1, 'x'), /非数值/)
  assert.throws(() => validateEmbeddings([{ embedding: [] }], 1, 'x'), /维度为 0/)
  assert.deepEqual(validateEmbeddings([[1, 2]], 1, 'x'), [[1, 2]], '直接给数组的形状也接受')
})

test('B3 错误脱敏：端点回显 Authorization 时 key 不出现在错误里', async () => {
  const srv = await startEmbedServer()
  srv.fail = { status: 401, message: 'Bad key: Bearer sk-test-key-123456' }
  try {
    await assert.rejects(
      () => requestEmbeddings(REQ(srv.url), ['hi']),
      (err) => {
        assert.ok(err instanceof EmbedError)
        assert.equal(err.message.includes('sk-test-key-123456'), false, `错误里不得出现明文 key：${err.message}`)
        assert.match(err.message, /HTTP 401/)
        return true
      },
    )
  } finally {
    await srv.close()
  }
})

test('B4 embeddingsUrl：根路径拼 /embeddings，已带 /embeddings 不重复拼', () => {
  assert.equal(embeddingsUrl('http://x/v1'), 'http://x/v1/embeddings')
  assert.equal(embeddingsUrl('http://x/v1/'), 'http://x/v1/embeddings')
  assert.equal(embeddingsUrl('http://x/v1/embeddings'), 'http://x/v1/embeddings')
})

// ── C. 缓存：键控 / 零请求 / 失效重算 ───────────────────────────────────

test('C1 缓存：首次计算落盘，第二次命中且**零分块请求**；重复查询零请求（查询向量备忘）', async () => {
  const dir = tempDir()
  const chunks = chunkText(Array.from({ length: 4 }, (_, i) => `paragraph ${i} reward policy`).join('\n\n'), 40)
  const cachePath = join(dir, 'p.embeddings.json')
  const srv = await startEmbedServer()
  try {
    clearEmbedQueryMemo()
    const first = await ensureChunkVectors({ cachePath, chunks, req: REQ(srv.url), batchSize: 2 })
    assert.equal(first.fromCache, false)
    const batchRequests = srv.requests
    assert.ok(batchRequests > 0)
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    assert.equal(cache.v, 1)
    assert.equal(cache.model, 'mock-embed-3')
    assert.equal(cache.dimensions, 3)
    assert.equal(cache.contentHash, chunkSetHash(chunks, 1500))
    assert.equal(cache.baseUrl, srv.url, 'F-E2：缓存必须记下产出向量的端点')
    assert.equal(cache.vectors.length, chunks.length)
    assert.equal(JSON.stringify(cache).includes('sk-test-key'), false, '缓存不得含 key')

    // 第二次：缓存命中 → 一条请求都不发
    const before = srv.requests
    const second = await ensureChunkVectors({ cachePath, chunks, req: REQ(srv.url), batchSize: 2 })
    assert.equal(second.fromCache, true)
    assert.equal(srv.requests, before, '缓存命中必须零网络请求')

    // 整条检索链路走两遍：第一遍算查询向量，第二遍（同查询）连查询向量都命中备忘 → 零请求
    const r1 = await embeddingRecallFor({ configured: true, cachePath, chunks, pages: null, query: 'locality', req: REQ(srv.url), chunkSize: 1500 })
    assert.equal(r1.used, true)
    const afterFirstSearch = srv.requests
    const r2 = await embeddingRecallFor({ configured: true, cachePath, chunks, pages: null, query: 'locality', req: REQ(srv.url), chunkSize: 1500 })
    assert.equal(r2.used, true)
    assert.equal(srv.requests, afterFirstSearch, '同一查询重复检索：分块与查询向量都命中缓存 → 零请求')
    assert.deepEqual(r2.hits.map((h) => h.chunk.index), r1.hits.map((h) => h.chunk.index))
  } finally {
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C2 缓存失效：换模型 / 改文本（内容哈希）/ 分块大小变化 → 重算；维度不符 → 重算', async () => {
  const dir = tempDir()
  const chunks = chunkText(Array.from({ length: 3 }, (_, i) => `para ${i} locality`).join('\n\n'), 40)
  const cachePath = join(dir, 'p.embeddings.json')
  const srv = await startEmbedServer()
  try {
    await ensureChunkVectors({ cachePath, chunks, req: REQ(srv.url, 'model-a'), batchSize: 4 })
    let n = srv.requests
    // 换模型 → 重算（键含 model）
    await ensureChunkVectors({ cachePath, chunks, req: REQ(srv.url, 'model-b'), batchSize: 4 })
    assert.ok(srv.requests > n, '换模型必须重算')
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).model, 'model-b')
    // 改分块大小 → 内容哈希变 → 重算
    n = srv.requests
    const other = chunkText(chunks.map((c) => c.text).join('\n\n'), 20)
    await ensureChunkVectors({ cachePath, chunks: other, chunkSize: 20, req: REQ(srv.url, 'model-b'), batchSize: 4 })
    assert.ok(srv.requests > n, '分块大小变化必须重算')
    // .txt 变化（内容哈希变）→ 重算
    n = srv.requests
    const changed = chunkText('completely different text about planning and reward', 40)
    await ensureChunkVectors({ cachePath, chunks: changed, req: REQ(srv.url, 'model-b'), batchSize: 4 })
    assert.ok(srv.requests > n, '.txt 变化必须重算')
    // 维度不符：查询向量维度（4）与缓存记录（3）不一致 → 判定失效重算
    const srv4 = await startEmbedServer({ dim: 4 })
    try {
      n = srv4.requests
      const res = await ensureChunkVectors({ cachePath, chunks: changed, req: REQ(srv4.url, 'model-b'), expectedDimensions: 4, batchSize: 4 })
      assert.equal(res.dimensions, 4)
      assert.ok(srv4.requests > n, '维度不符必须重算')
      assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).dimensions, 4)
    } finally {
      await srv4.close()
    }
  } finally {
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C3 不得产生半截缓存：第二批失败 → 抛错且不写缓存文件', async () => {
  const dir = tempDir()
  const chunks = mkChunks(['para zero', 'para one', 'para two', 'para three'])
  const cachePath = join(dir, 'p.embeddings.json')
  const srv = await startEmbedServer()
  let served = 0
  try {
    // 第一批成功、第二批 500
    const server = createServer((req, res) => {
      served++
      const c = []
      req.on('data', (x) => c.push(x))
      req.on('end', () => {
        if (served === 1) {
          const parsed = JSON.parse(Buffer.concat(c).toString('utf8'))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: parsed.input.map((t, index) => ({ index, embedding: bagVector(t) })) }))
        } else {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'boom' }))
        }
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${server.address().port}/v1`
    try {
      await assert.rejects(() => ensureChunkVectors({ cachePath, chunks, req: REQ(url), batchSize: 2 }), EmbedError)
      assert.equal(existsSync(cachePath), false, '整体失败不得留下半截缓存')
    } finally {
      await new Promise((r) => server.close(r))
    }
  } finally {
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C4 F-E2：缓存键含 baseUrl —— 换端点（同 model 名同维度）必须重算，不得静默复用旧向量', async () => {
  const dir = tempDir()
  const chunks = mkChunks(['alpha locality', 'beta reward'])
  const cachePath = join(dir, 'p.embeddings.json')
  const srvA = await startEmbedServer({ dim: 3 })
  const srvB = await startEmbedServer({ dim: 3 })
  try {
    clearEmbedQueryMemo()
    assert.notEqual(srvA.url, srvB.url)
    // 端点 A 先算并落盘
    const a1 = await ensureChunkVectors({ cachePath, chunks, req: REQ(srvA.url), batchSize: 4 })
    assert.equal(a1.fromCache, false)
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).baseUrl, srvA.url)
    const aReqs = srvA.requests
    // 同端点再来一次：命中缓存（零请求）——证明加了 baseUrl 也没破坏命中
    assert.equal((await ensureChunkVectors({ cachePath, chunks, req: REQ(srvA.url), batchSize: 4 })).fromCache, true)
    assert.equal(srvA.requests, aReqs)
    // 换端点 B（model 名与维度都一样）：**不得复用 A 的向量**
    const beforeB = srvB.requests
    const b1 = await ensureChunkVectors({ cachePath, chunks, req: REQ(srvB.url), batchSize: 4 })
    assert.equal(b1.fromCache, false, '换端点必须重算')
    assert.ok(srvB.requests > beforeB, '新端点必须真的收到请求')
    assert.equal(srvA.requests, aReqs, '不该回头再打旧端点')
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).baseUrl, srvB.url)
    // 切回 A：键又变了 → 再次重算（仅 baseUrl 变化即触发重算）
    const beforeA2 = srvA.requests
    const a2 = await ensureChunkVectors({ cachePath, chunks, req: REQ(srvA.url), batchSize: 4 })
    assert.equal(a2.fromCache, false, '仅改 baseUrl 即触发重算')
    assert.ok(srvA.requests > beforeA2)
    // 检索侧同样成立：此时缓存属于 A，用 B 检索不得拿 A 的向量冒充
    const rB = await embeddingRecallFor({ configured: true, cachePath, chunks, pages: null, query: 'locality', req: REQ(srvB.url) })
    assert.equal(rB.fromCache, false, '端点与缓存不符时必须重算')
    assert.equal(rB.used, true)
    // 用当前缓存对应的端点（B，上一句已把 B 的向量写回）→ 命中
    const rB2 = await embeddingRecallFor({ configured: true, cachePath, chunks, pages: null, query: 'locality', req: REQ(srvB.url) })
    assert.equal(rB2.fromCache, true, '同一端点第二次检索命中缓存')
  } finally {
    await srvA.close()
    await srvB.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── D. 混合召回：融合与保护 ─────────────────────────────────────────────

test('D1 语义召回改变结果：关键词命中不到、语义相近的片段被捞回来', () => {
  const chunks = mkChunks([
    'Locality of reference matters for cache performance and temporal reuse.',
    'The reward function of the policy is learned by planning in latent space.',
  ])
  const pages = [{ page: 1, start: 0, end: chunks[1].end }]
  // 关键词：'checkpoint' 一个都不命中（构造「关键词失手」场景）
  assert.equal(searchChunks(chunks, pages, 'checkpoint', 5).length, 0)
  // 语义：mock 向量把 'checkpoint' 映射到「局部性/时序」那一组，于是第 0 块被召回
  const qv = [1, 0, 0] // 'checkpoint' 在 mock 里映射到「局部性/时序」那一维
  const vectors = chunks.map((c) => bagVector(c.text))
  const sem = embeddingRecall(chunks, pages, qv, vectors, 5)
  assert.ok(sem.length > 0, '语义召回必须有候选')
  assert.equal(sem[0].chunk.index, 1, '与 locality/temporal 最像的块排第一')
  // 融合后：关键词 0 命中、语义有命中 → 结果集从空变成非空（召回确实改变）
  const fused = fuseHybridCandidates([], sem, 3)
  assert.equal(fused.length, 1)
  assert.equal(fused[0].chunk.index, 1)
})

test('D2 融合（重叠形态）：两列都命中的片段排最前、同分时关键词优先（不构成一般性保证，见 D4）', () => {
  const mk = (index, score) => ({ chunk: { index, start: index, end: index + 1, text: `c${index}` }, score, page: 1 })
  const keyword = [mk(1, 90), mk(2, 40)]
  const semantic = [mk(3, 0.9), mk(4, 0.8), mk(1, 0.7)]
  const fused = fuseHybridCandidates(keyword, semantic, 4)
  const order = fused.map((h) => h.chunk.index)
  assert.equal(order[0], 1, '关键词第 1 + 语义命中 → 排第一')
  assert.ok(order.includes(2), '关键词第 2 仍在结果里（没被语义噪声挤掉）')
  assert.ok(order.includes(3) && order.includes(4), '语义候选也被并入')
  // 关键词-only 时融合不改变既有排序
  const kwOnly = fuseHybridCandidates(keyword, [], 2).map((h) => h.chunk.index)
  assert.deepEqual(kwOnly, [1, 2])
})

test('D4 F-E1：5 条关键词命中 + 5 条不相交语义候选、k=5 的实际结果（RRF 固有语义，**不是 bug**）', () => {
  // 这是 RRF（Reciprocal Rank Fusion，k=60）按名次融合的固有形态，本轮由队长裁定**不改算法**、
  // 只把行为如实固定下来（无真实嵌入可调参，改融合策略等于引入不可验证的行为）：
  //   - 只吃名次、不看分数大小；两列候选**交替占用** top-k 名额；
  //   - 「关键词优先」只在精确同分时生效（同分时关键词那列排前）；
  //   - 于是关键词第 4、5 名会被语义第 1、2 名挤出 top-5（评分 90 的高分并不能保住它）。
  // 这不等于「嵌入替代关键词」：关键词检索仍在跑并持续贡献候选（此处占住 top-5 里的 3 个名额）。
  const mk = (index, score) => ({ chunk: { index, start: index, end: index + 1, text: `c${index}` }, score, page: 1 })
  const keyword = [mk(1, 90), mk(2, 80), mk(3, 70), mk(4, 60), mk(5, 50)]
  const semantic = [mk(11, 0.9), mk(12, 0.8), mk(13, 0.7), mk(14, 0.6), mk(15, 0.5)]
  const fused = fuseHybridCandidates(keyword, semantic, 5)
  assert.deepEqual(fused.map((h) => h.chunk.index), [1, 2, 3, 11, 12], '实际（文档序）：关键词前三 + 语义前二')
  assert.equal(fused.length, 5)
  // 名次融合的两条可观测性质（与上面的结果互为印证）
  const overlap = fuseHybridCandidates([mk(1, 5)], [mk(1, 0.1)], 1)
  assert.deepEqual(overlap.map((h) => h.chunk.index), [1], '两列都命中的片段获得两份贡献 → 排最前')
  const tie = fuseHybridCandidates([mk(7, 1)], [mk(9, 0.99)], 2)
  assert.deepEqual(tie.map((h) => h.chunk.index), [7, 9], '精确同分时关键词那列优先（此处名字次相同）')
})

test('D3 未配置嵌入：configured=false、零请求、结果与纯关键词逐字节一致', async () => {
  const srv = await startEmbedServer()
  const dir = tempDir()
  const text = 'Alpha keyword locality.\n\nBeta checkpoint.\n\nGamma locality again.'
  const chunks = chunkText(text, 30)
  const pages = [{ page: 1, start: 0, end: text.length }]
  try {
    const before = srv.requests
    const r = await embeddingRecallFor({ configured: false, cachePath: join(dir, 'p.embeddings.json'), chunks, pages, query: 'locality' })
    assert.equal(r.configured, false)
    assert.equal(r.used, false)
    assert.equal(r.degraded, null)
    assert.deepEqual(r.hits, [])
    assert.equal(srv.requests, before, '默认关闭：一条请求都不发')
    // 纯关键词路径与 searchChunks 完全一致（searchChunksMulti 单写法直通）
    const direct = searchChunks(chunks, pages, 'locality', 5)
    const viaMulti = searchChunksMulti(chunks, pages, ['locality'], 5)
    assert.deepEqual(viaMulti, direct)
  } finally {
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── E. 降级：如实标注、不抛错 ───────────────────────────────────────────

test('E1 端点不可达 / HTTP 错误 / 非数值 → degraded 有原因、hits 为空、不抛错', async () => {
  const dir = tempDir()
  const text = 'Alpha locality.\n\nBeta checkpoint.'
  const chunks = chunkText(text, 30)
  const cachePath = join(dir, 'p.embeddings.json')

  clearEmbedQueryMemo()
  const dead = await embeddingRecallFor({
    configured: true, cachePath, chunks, pages: null, query: 'x',
    req: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-key-abcdefg', model: 'm', timeoutMs: 800 },
  })
  assert.equal(dead.used, false)
  assert.match(dead.degraded, /请求失败/)
  assert.equal(dead.hits.length, 0)

  const srv = await startEmbedServer()
  srv.fail = { status: 503, message: 'service unavailable' }
  try {
    clearEmbedQueryMemo()
    const degraded = await embeddingRecallFor({ configured: true, cachePath, chunks, pages: null, query: 'x', req: REQ(srv.url) })
    assert.equal(degraded.used, false)
    assert.match(degraded.degraded, /HTTP 503/)
    assert.equal(existsSync(cachePath), false, '失败不得留下缓存')
  } finally {
    await srv.close()
  }

  const nan = await startEmbedServer({ rawData: (data) => data.map((d) => ({ ...d, embedding: [Number.NaN, 0, 0] })) })
  try {
    clearEmbedQueryMemo()
    const bad = await embeddingRecallFor({ configured: true, cachePath, chunks, pages: null, query: 'x', req: REQ(nan.url) })
    assert.equal(bad.used, false)
    assert.match(bad.degraded, /非数值/)
    assert.equal(existsSync(cachePath), false)
  } finally {
    await nan.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── F. 惰性：转录路径零嵌入请求 ─────────────────────────────────────────

test('F1 惰性：transcribe 模块不引用嵌入（静态保证），且嵌入只在检索函数里发生', () => {
  const transcribe = readFileSync(join(ROOT, '..', 'dist', 'transcribe.js'), 'utf8')
  assert.equal(/embed(e|-)?/i.test(transcribe.replace(/embedding[s]?\s*=/g, '')), false, 'transcribe 不得引用嵌入模块')
  assert.equal(transcribe.includes('embeddings'), false, 'transcribe 里不应出现 embeddings 字样')
  const tools = readFileSync(join(ROOT, '..', 'dist', 'tools.js'), 'utf8')
  assert.ok(tools.includes('embeddingRecallFor'), '嵌入只在 search_paper 的 execute 里惰性触发')
})

// ── G. 折叠项 1：查询侧 LaTeX 归一化 ────────────────────────────────────

test('G1 查询归一化：Q_{t} → Q_t；反例（x_{ij}、x_{t-1}）与纯散文不动', () => {
  assert.equal(compactQuery('Q_{t}'), 'Q_t')
  assert.equal(compactQuery('q(x_{t})'), 'q(x_t)')
  assert.equal(compactQuery('\\alpha^{2}'), '\\alpha^2')
  assert.equal(compactQuery('x_{ij}'), null)
  assert.equal(compactQuery('x_{t-1}'), null)
  assert.equal(compactQuery('^{K \\times K}'), null)
  assert.equal(compactQuery('diffusion model'), null)
  assert.equal(compactQuery('locality'), null)
  assert.deepEqual(queryVariants('Q_{t}'), ['Q_{t}', 'Q_t'], '原写法永远保留 → 不会丢命中')
  assert.deepEqual(queryVariants('locality'), ['locality'])
})

test('G2 来源门控：MinerU 论文追加紧凑写法，pdfjs/未知来源保持原样（不引入新行为）', () => {
  assert.deepEqual(queryVariantsFor('mineru-local', 'Q_{t}'), ['Q_{t}', 'Q_t'])
  assert.deepEqual(queryVariantsFor('mineru-cloud', 'Q_{t}'), ['Q_{t}', 'Q_t'])
  assert.deepEqual(queryVariantsFor('pdfjs', 'Q_{t}'), ['Q_{t}'])
  assert.deepEqual(queryVariantsFor(null, 'Q_{t}'), ['Q_{t}'])
  assert.deepEqual(queryVariantsFor('pdfjs', 'locality'), ['locality'])
})

test('G3 端到端：投影产物里只有 Q_t，查询 Q_{t} 与 Q_t 命中同一页', () => {
  const projected = 'The transition matrix $Q_t$ is crucial to the discrete diffusion model.' // 投影产物=紧凑写法
  const chunks = chunkText(projected, 200)
  const pages = [{ page: 7, start: 0, end: projected.length }]
  assert.equal(searchChunks(chunks, pages, 'Q_{t}', 5).length, 0, '改造后带花括号写法在紧凑语料里本来 0 命中')
  assert.ok(searchChunks(chunks, pages, 'Q_t', 5).length > 0)
  for (const q of ['Q_{t}', 'Q_t']) {
    const hits = searchChunksMulti(chunks, pages, queryVariants(q), 5)
    assert.ok(hits.length > 0, `${q} 必须命中`)
    assert.equal(hits[0].page, 7, `${q} 命中同一页`)
  }
})

test('G4 经 search_paper 内部链路的真源文件：MinerU 缓存 → Q_{t} 查询命中', async () => {
  const dir = tempDir()
  const text = 'The transition matrix $Q_t$ is crucial to the discrete diffusion model. ' + 'filler '.repeat(160)
  const ref = writeCacheTree(dir, { text, producer: 'mineru-local', pages: [{ page: 4, start: 0, end: text.length }] })
  try {
    const cached = readFileSync(ref.txtPath, 'utf8')
    const chunks = chunkText(cached, 1500)
    const pages = JSON.parse(readFileSync(join(dir, '默认专题', 'paper.pages.json'), 'utf8')).pages
    const producer = JSON.parse(readFileSync(join(dir, '默认专题', 'paper.transcript.json'), 'utf8')).producer
    assert.deepEqual(queryVariantsFor(producer, 'Q_{t}'), ['Q_{t}', 'Q_t'])
    const hits = searchChunksMulti(chunks, pages, queryVariantsFor(producer, 'Q_{t}'), 5)
    assert.ok(hits.length > 0)
    assert.equal(hits[0].page, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── H. 折叠项 2/3：F-R1 白名单与多参数命令；F-R2 \text{} 组 ──────────────

test('H1 F-R1：\\textcolor 两组都保护；前缀同形的非正文命令不被卷进来', () => {
  const pipe = (s) => normalizeMathBraces(compressMathSpaces(s))
  assert.equal(pipe('$\\textcolor{red}{hello world}$'), '$\\textcolor{red}{hello world}$', '第二组空格必须保留')
  assert.equal(pipe('$\\textcolor{red}{h e l l o   w o r l d}$'), '$\\textcolor{red}{h e l l o   w o r l d}$')
  assert.equal(pipe('$\\textcolor { red } { h e l l o   w o r l d }$'), '$\\textcolor{ red } { h e l l o   w o r l d }$')
  // 前缀同形但不是正文命令：不能被当成 \text
  assert.equal(pipe('$\\textwidth = 5$'), '$\\textwidth=5$', '\\textwidth 是长度，不保护参数')
  assert.equal(pipe('$\\textstyle { x _ { t } }$'), '$\\textstyle{x_t}$', '\\textstyle 不保护')
  // \text 家族的正文空格仍必须保留（含 \textbf/\textsf/\texttt）
  for (const cmd of ['text', 'textrm', 'textnormal', 'textsf', 'texttt', 'textbf', 'mbox', 'hbox', 'operatorname']) {
    assert.equal(pipe(`$\\${cmd}{hello world}$`), `$\\${cmd}{hello world}$`, `\\${cmd} 必须保护组内空格`)
  }
})

test('H2 F-R2：区间扫描跳过 \\text{} 组内部，内层 $ 不再切断区间', () => {
  const pipe = (s) => normalizeMathBraces(compressMathSpaces(s))
  assert.equal(pipe('$\\text{costs $5}$'), '$\\text{costs $5}$', '内层 $ 不该把区间切断')
  assert.equal(pipe('$\\text{a $ b} + x _ { t }$'), '$\\text{a $ b}+x_t$')
  assert.equal(pipe('$$\\text{price $5} = n$$'), '$$\\text{price $5}=n$$')
  // 未保护的普通区间行为不变
  assert.equal(pipe('$x _ { t }$'), '$x_t$')
  assert.equal(pipe('It costs $5 today'), 'It costs $5 today')
})

test('H4 F-V2：多参数命令按**声明组数**保护全部参数组（三参数的第三组正文也必须保留空格）', () => {
  const pipe = (s) => normalizeMathBraces(compressMathSpaces(s))
  // 三参数：\fcolorbox{边框色}{底色}{正文}
  assert.equal(pipe('$\\fcolorbox{red}{blue}{keep me}$'), '$\\fcolorbox{red}{blue}{keep me}$')
  assert.equal(pipe('$\\fcolorbox{red}{blue}{k e e p   m e}$'), '$\\fcolorbox{red}{blue}{k e e p   m e}$')
  assert.equal(pipe('$\\fcolorbox { red } { blue } { keep me }$'), '$\\fcolorbox{ red } { blue } { keep me }$')
  // 正文组里的嵌套保护命令照旧生效
  assert.equal(pipe('$\\fcolorbox{red}{blue}{hello \\text{a b} world}$'), '$\\fcolorbox{red}{blue}{hello \\text{a b} world}$')
  // 两参数命令不回归
  assert.equal(pipe('$\\colorbox{yellow}{keep me}$'), '$\\colorbox{yellow}{keep me}$')
  assert.equal(pipe('$\\textcolor{red}{hello world}$'), '$\\textcolor{red}{hello world}$')
  // F-R2 在命令组变多后同样生效：内层 `$` 不当定界符
  assert.equal(pipe('$\\fcolorbox{red}{blue}{costs $5}$'), '$\\fcolorbox{red}{blue}{costs $5}$')
})

test('H5 F-V2 风险边界：命令之后**独立的组**不得被当成参数而受保护（贪心读组会踩这个坑）', () => {
  const pipe = (s) => normalizeMathBraces(compressMathSpaces(s))
  // 声明的参数组只有前 N 组；紧随其后的 `{normal text}` 是独立组 → 空格照常压掉
  assert.equal(pipe('$\\textcolor{red}{hello world} {normal text}$'), '$\\textcolor{red}{hello world}{normaltext}$')
  assert.equal(pipe('$\\fcolorbox{red}{blue}{keep me} {normal text}$'), '$\\fcolorbox{red}{blue}{keep me}{normaltext}$')
  assert.equal(pipe('$\\text{hello world} {normal text}$'), '$\\text{hello world}{normaltext}$')
  // 独立组里即便有连续空格 / 制表 / 换行也一并压掉（证明它真的走了普通路径）
  assert.equal(pipe('$\\textcolor{red}{a b} {c    \t\n d}$'), '$\\textcolor{red}{a b}{cd}$')
  // 参数组与独立组之间隔着其它 token 时同样成立
  assert.equal(pipe('$\\textcolor{red}{a b} + {c d}$'), '$\\textcolor{red}{a b}+{cd}$')
})

test('H3 幂等：两步归一化重复作用不再变化（含 F-R1/F-R2 用例）', () => {
  const pipe = (s) => normalizeMathBraces(compressMathSpaces(s))
  for (const s of [
    '$\\textcolor{red}{hello world}$', '$\\text{costs $5}$', '$x _ { t - 1 }$',
    '$\\mathbb { R } ^ { K \\times K }$', '$\\text{hello world} + x _ { t }$', 'plain prose stays',
  ]) {
    const once = pipe(s)
    assert.equal(pipe(once), once, `幂等失败：${s}`)
  }
})

// ── I. 设置面板：卡片 + zh/en 文案齐全（静态核对，UI 不走 DOM 测试）─────────

test('I1 设置面板：嵌入卡片指向 /embed/config，zh/en 文案 key 齐全且各自有定义', () => {
  const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  assert.ok(client.includes("path: '/embed/config'"), '必须新增嵌入端点卡片')
  assert.ok(client.includes("baseUrlPlaceholder: 'https://api.openai.com/v1'"))
  for (const key of ['setEmbedTitle', 'setEmbedDesc']) {
    const uses = client.split(`t('${key}')`).length - 1
    const defs = client.split(`${key}:`).length - 1
    assert.equal(uses, 1, `${key} 应被卡片引用一次`)
    assert.equal(defs, 2, `${key} 必须在 zh 与 en 两份文案里都有定义`)
  }
  // 隐私提示必须出现在两份 README（同时覆盖文案齐全性）
  const zh = readFileSync(join(ROOT, '..', 'README.md'), 'utf8')
  const en = readFileSync(join(ROOT, '..', 'README_EN.md'), 'utf8')
  assert.match(zh, /两类文本都会发送到你配置的那个端点[\s\S]{0,400}检索时的查询文本/)
  assert.match(en, /two kinds of text are sent to the endpoint you configure[\s\S]{0,400}query text of every search/)
  for (const kw of [/DSH_EMBED_API_KEY/, /embeddings\.json/, /batchSize/, /非目标|Non-goals/]) {
    assert.match(zh, kw, `README.md 缺 ${kw}`)
    assert.match(en, kw, `README_EN.md 缺 ${kw}`)
  }
})

// ── J. 工具层端到端：search_paper 的真实 glue（默认关闭 / 混合召回 / 降级 / 来源门控）──

/** 注册工具并取出 search_paper；dataDir 里放一篇带缓存的论文（含 dummy PDF，走缓存命中）。 */
function makeSearchTool(dataDir, pluginConfig) {
  const tools = {}
  const ctx = { tools: { register: (t) => { tools[t.name] = t } }, logger: { info: () => {}, warn: () => {} } }
  registerTools(ctx, { dataDir, ...pluginConfig })
  return tools.search_paper
}

function seedPaper(dir, text, producer) {
  const ref = writeCacheTree(dir, { text, producer, pages: [{ page: 3, start: 0, end: text.length }] })
  writeFileSync(join(dir, '默认专题', 'paper.pdf'), '', 'utf8') // locate() 只要求 PDF 存在
  return join(dir, '默认专题', 'paper.pdf')
}

test('J1 工具层：未配置嵌入 → 结果与纯关键词逐字节一致（默认关闭的硬约束）', async () => {
  const dir = tempDir()
  const text = 'Alpha locality matters.\n\nBeta checkpoint saves.\n\nGamma locality again. ' + 'filler '.repeat(120)
  const pdf = seedPaper(dir, text, 'mineru-local')
  try {
    const tool = makeSearchTool(dir, {})
    const out = await tool.execute({ path: pdf, query: 'locality', k: 3 }, {})
    const chunks = chunkText(text, 1500)
    const expected = searchChunks(chunks, null, 'locality', 3) // 单写法直通 searchChunks
    assert.deepEqual(out.hits.map((h) => h.chunk), expected.map((h) => h.chunk.index))
    assert.equal(out.embedding.configured, false)
    assert.equal(out.embedding.used, false)
    assert.equal(out.embedding.degraded, null)
    assert.equal(out.compactQuery, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('J2 工具层：配了 mock 端点 → 语义召回并入结果、缓存命中零分块请求、重复查询零请求', async () => {
  const dir = tempDir()
  // 关键词 'checkpoint' 在语料里一次都不出现，但 mock 向量把它映射到「局部性/时序」那一维
  const text = 'Locality of reference speeds up cache reuse.\n\nThe reward of the policy is learned by planning. ' + 'filler '.repeat(200)
  const pdf = seedPaper(dir, text, 'mineru-local')
  const srv = await startEmbedServer()
  try {
    const tool = makeSearchTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-tool-key-123456', model: 'mock-embed-3' } })
    const keywordOnly = searchChunks(chunkText(text, 1500), null, 'checkpoint', 3)
    assert.equal(keywordOnly.length, 0, '前提：关键词确实一个都不命中')
    const out = await tool.execute({ path: pdf, query: 'checkpoint', k: 3 }, {})
    assert.equal(out.embedding.configured, true)
    assert.equal(out.embedding.used, true, '语义召回必须把候选捞回来')
    assert.equal(out.embedding.degraded, null)
    assert.ok(out.hits.length > 0, '关键词 0 命中时嵌入召回改变结果集')
    assert.ok(existsSync(embeddingsPathFor(join(dir, '默认专题', 'paper.txt'))), '首次检索才落缓存（惰性）')
    const afterFirst = srv.requests
    const out2 = await tool.execute({ path: pdf, query: 'checkpoint', k: 3 }, {})
    assert.equal(out2.embedding.fromCache, true)
    assert.equal(srv.requests, afterFirst, '缓存命中 + 同查询备忘 → 零请求')
    assert.deepEqual(out2.hits.map((h) => h.chunk), out.hits.map((h) => h.chunk))
  } finally {
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('J3 工具层：端点挂了 → 不抛错、关键词结果照常、degraded 如实标注', async () => {
  const dir = tempDir()
  const text = 'Alpha locality matters.\n\nBeta locality again. ' + 'filler '.repeat(120)
  const pdf = seedPaper(dir, text, 'mineru-local')
  try {
    const tool = makeSearchTool(dir, {
      embed: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-dead-key-12345', model: 'm', timeoutMs: 700 },
    })
    const out = await tool.execute({ path: pdf, query: 'locality', k: 3 }, {})
    assert.equal(out.embedding.configured, true)
    assert.equal(out.embedding.used, false)
    assert.match(out.embedding.degraded, /请求失败/)
    const keyword = searchChunks(chunkText(text, 1500), null, 'locality', 3)
    assert.deepEqual(out.hits.map((h) => h.chunk), keyword.map((h) => h.chunk.index), '仍返回关键词结果')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('J4 工具层：来源门控 —— pdfjs 论文的 Q_{t} 查询不做归一化（不引入新行为）', async () => {
  const dirM = tempDir()
  const dirP = tempDir()
  const text = 'The transition matrix $Q_t$ is crucial. ' + 'filler '.repeat(200)
  const pdfM = seedPaper(dirM, text, 'mineru-local')
  const pdfP = seedPaper(dirP, text, 'pdfjs')
  try {
    const tool = makeSearchTool(dirM, {})
    const mineru = await tool.execute({ path: pdfM, query: 'Q_{t}', k: 3 }, {})
    assert.equal(mineru.compactQuery, 'Q_t', 'MinerU 来源：追加紧凑写法')
    assert.ok(mineru.hits.length > 0, '两种写法命中同一页')
    const toolP = makeSearchTool(dirP, {})
    const pdfjs = await toolP.execute({ path: pdfP, query: 'Q_{t}', k: 3 }, {})
    assert.equal(pdfjs.compactQuery, null, 'pdfjs 来源：不归一化')
    assert.equal(pdfjs.hits.length, 0, '与改造前一致：照旧搜不到')
  } finally {
    rmSync(dirM, { recursive: true, force: true })
    rmSync(dirP, { recursive: true, force: true })
  }
})
