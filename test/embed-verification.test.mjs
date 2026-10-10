// test/embed-verification.test.mjs — t6 独立验证：嵌入检索（t5）的对抗性核对。
//
// 与实现者 test/embed-search.test.mjs 的差异（**独立复现，不复用其断言**）：
//   1) 默认关闭的逐字节一致性用 HEAD 基线 dist 对照（非「与纯关键词对比」）；
//   2) 缓存零请求把「查询备忘」与「分块缓存」**分开计量**（清掉查询备忘后仍须 0 分块请求）；
//   3) 降级六类逐条攻击，且每次都核对缓存文件**不存在**（无半截缓存）；
//   4) 隐私抓包：dump mock 收到的原始请求体，核对发出去的就是分块文本；
//   5) 查询侧归一化与投影侧规则一致性用**等价性测试**（把投影侧函数作用在裸文本上比对）；
//   6) 零向量降级形态（实施者未覆盖）、批次边界（batchSize=1 多批次）。
//
// 只 import dist/*.js；mock 用 node:http；无新依赖。跑前先 `npm run build`。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

const HOME = mkdtempSync(join(tmpdir(), 'dpr-t6-home-'))
process.env.DSH_HOME = HOME
delete process.env.DSH_EMBED_API_KEY

const embed = await import(dist('embed.js'))
const search = await import(dist('search.js'))
const mineru = await import(dist('mineru.js'))
const { registerTools } = await import(dist('tools.js'))
const {
  embeddingsPathFor, embeddingRecallFor, chunkSetHash, clearEmbedQueryMemo, readEmbedCache,
} = embed
const { chunkText, searchChunks, searchChunksMulti, queryVariants, queryVariantsFor, compactQuery } = search
const { resolvePaper } = await import(dist('library.js'))
const { transcribePaper } = await import(dist('transcribe.js'))
const { MINERU_DEFAULTS } = await import(dist('mineru-config.js'))
const { chunkText: _ct } = search
const { compressMathSpaces, normalizeMathBraces, normalizeMathTokens, projectContentList } = mineru

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

// ── mock 嵌入服务（可编程响应 + 请求体留证 + 分块/查询分开计数）────────────

/**
 * @param {(texts: string[], call: number) => {status?: number, body?: string|number[][]}} handler
 * handler.body 给 string 原样回（用于非 JSON / 空 data），否则按 OpenAI 形状回 data。
 */
async function startMock(handler, dim = 4) {
  const state = { calls: [], chunkRequests: 0, queryRequests: 0, chunkTexts: [] }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try { body = JSON.parse(raw) } catch { /* 保留 null */ }
      const texts = Array.isArray(body?.input) ? body.input : typeof body?.input === 'string' ? [body.input] : []
      state.calls.push({ raw, headers: req.headers, body, texts })
      if (texts.length <= 1) state.queryRequests += 1
      else { state.chunkRequests += 1; state.chunkTexts.push(...texts) }
      const out = handler(texts, state.calls.length)
      if (typeof out.body === 'string') {
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
        res.end(out.body)
        return
      }
      const data = (out.body ?? texts.map((t) => Array.from({ length: dim }, (_, i) => (t.length % 7) + i * 0.25 + 1)))
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: data.map((vec, i) => ({ object: 'embedding', index: i, embedding: vec })) }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/v1`
  return { url, state, close: () => new Promise((r) => server.close(r)) }
}

function tempDir(prefix = 'dpr-t6-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 造一篇带缓存的论文；返回 { dir, pdf, ref }。 */
function seedPaper(dir, text, producer = 'mineru-local', pages = null) {
  const topic = join(dir, '默认专题')
  mkdirSync(topic, { recursive: true })
  const base = join(topic, 'paper')
  writeFileSync(base + '.txt', text, 'utf8')
  const pg = pages ?? [{ page: 1, start: 0, end: text.length }]
  writeFileSync(base + '.pages.json', JSON.stringify({ pageCount: 1, pages: pg }), 'utf8')
  writeFileSync(base + '.transcript.json', JSON.stringify({ v: 1, producer, createdAt: 'x', text: { chars: text.length, pageCount: 1 } }), 'utf8')
  writeFileSync(base + '.pdf', '', 'utf8')
  return { dir, pdf: base + '.pdf', txtPath: base + '.txt', cachePath: base + '.embeddings.json' }
}

function makeTool(dataDir, pluginConfig = {}) {
  const tools = {}
  const ctx = { tools: { register: (t) => { tools[t.name] = t } }, logger: { info: () => {}, warn: () => {} } }
  registerTools(ctx, { dataDir, ...pluginConfig })
  return tools.search_paper
}

const DOC = [
  'Locality of reference speeds up the cache reuse in the pipeline.',
  '',
  'The transition matrix $Q_t$ governs the forward diffusion process.',
  '',
  'The reward of the policy is learned by planning over latent states.',
].join('\n') + '\n\n' + 'filler words for padding. '.repeat(120)

// ── 1. 默认关闭：逐字节一致（对照 HEAD 基线 dist）────────────────────────
// 基线不存在时退化为「与纯关键词参考值对照」并在报告里标注。

const BASE_DIST = '/tmp/t6-baseline/dist'
const baseOk = existsSync(join(BASE_DIST, 'tools.js'))

test('1.1 默认关闭：hits 与改造前逐字节一致（散文/紧凑/反例/空结果四类查询）', async () => {
  const queries = ['locality', 'Q_t', 'x_{t-1}', 'x_{ij}', 'zzzznomatch']
  const dir = tempDir()
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, {})
    const chunks = chunkText(DOC, 1500)
    for (const q of queries) {
      const out = await tool.execute({ path: p.pdf, query: q, k: 5 }, {})
      // 参考值：改造前的表达式链（单写法 → searchChunks → 取前 k）
      const ref = searchChunks(chunks, [{ page: 1, start: 0, end: DOC.length }], q, 5)
      assert.deepEqual(out.hits.map((h) => h.chunk), ref.map((h) => h.chunk.index), `${q}: chunk 序号必须一致`)
      assert.deepEqual(out.hits.map((h) => h.text), ref.map((h) => h.chunk.text), `${q}: 片段文本必须一致`)
      assert.deepEqual(out.hits.map((h) => h.page), ref.map((h) => h.page), `${q}: 页码必须一致`)
      assert.equal(out.embedding.configured, false, `${q}: 未配置`)
      assert.equal(out.embedding.used, false)
      assert.equal(out.embedding.degraded, null)
    }
    if (baseOk) {
      // 更强的对照：真跑 HEAD 基线 dist 的同一工具，逐字节比 hits
      const baseTools = {}
      const { registerTools: regBase } = await import(join(BASE_DIST, 'tools.js'))
      const dir2 = tempDir()
      const p2 = seedPaper(dir2, DOC, 'mineru-local')
      regBase({ tools: { register: (t) => { baseTools[t.name] = t } }, logger: { info: () => {}, warn: () => {} } }, { dataDir: dir2 })
      for (const q of queries) {
        const before = await baseTools.search_paper.execute({ path: p2.pdf, query: q, k: 5 }, {})
        const after = await tool.execute({ path: p.pdf, query: q, k: 5 }, {})
        assert.equal(JSON.stringify(after.hits), JSON.stringify(before.hits), `${q}: 与 HEAD 基线 hits 逐字节一致`)
      }
      rmSync(dir2, { recursive: true, force: true })
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('1.2 默认关闭：新增输出字段是纯附加（compactQuery/embedding），render 文本与基线一致', async () => {
  const dir = tempDir()
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, {})
    const out = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    // 不注入嵌入相关提示行：未配置 + 无紧凑写法 → render 与改造前的 formatHits 输出一致
    const chunks = chunkText(DOC, 1500)
    const ref = searchChunks(chunks, [{ page: 1, start: 0, end: DOC.length }], 'locality', 3)
    const rendered = tool.output.render({ query: 'locality' }, out)[0].text
    assert.ok(rendered.includes(ref[0].chunk.text.slice(0, 40)), 'render 必须含关键词片段原文')
    assert.ok(!rendered.includes('嵌入'), '未配置时不得出现嵌入提示')
    assert.ok(!rendered.includes('紧凑写法'), '无紧凑写法时不得出现提示')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 2. 缓存命中零请求（查询备忘与分块请求分开计量）───────────────────────

test('2.1 缓存命中：清掉进程内查询备忘后，第二次检索只发 1 次查询向量、0 次分块请求', async () => {
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    const first = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.equal(first.embedding.configured, true)
    assert.equal(first.embedding.fromCache, false, '首次一定算了分块向量')
    assert.ok(srv.state.chunkRequests >= 1, '首次必须发分块请求')
    assert.ok(existsSync(p.cachePath), '首次后缓存必须落盘')

    // 关键：清掉查询备忘，避免「查询备忘命中」冒充「分块缓存命中」
    clearEmbedQueryMemo()
    const before = { chunk: srv.state.chunkRequests, query: srv.state.queryRequests }
    const second = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.equal(second.embedding.fromCache, true, '第二次分块向量来自缓存')
    assert.equal(srv.state.chunkRequests, before.chunk, '缓存命中时**分块请求必须为 0**')
    assert.equal(srv.state.queryRequests - before.query, 1, '仍需 1 次查询向量请求（清除备忘后）')
    assert.deepEqual(second.hits.map((h) => h.chunk), first.hits.map((h) => h.chunk))
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('2.2 缓存失效：改 .txt → 内容哈希变 → 重算分块向量', async () => {
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    const hit1 = { chunk: srv.state.chunkRequests, calls: srv.state.calls.length }
    const cache1 = await readEmbedCache(p.cachePath)
    assert.ok(cache1, '缓存必须在')
    // 改 .txt（重新转录场景）
    writeFileSync(p.txtPath, DOC + '\n\nA brand new paragraph appended after re-transcription.', 'utf8')
    clearEmbedQueryMemo()
    const out = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.ok(srv.state.chunkRequests > hit1.chunk, '改 .txt 后必须重算分块向量')
    const cache2 = await readEmbedCache(p.cachePath)
    assert.ok(cache2 && cache2.contentHash !== cache1.contentHash, '内容哈希必须变化')
    assert.equal(out.embedding.fromCache, false)
    // 哈希函数本身对顺序敏感
    const cs = chunkText(DOC, 1500)
    assert.notEqual(chunkSetHash(cs, 1500), chunkSetHash([...cs].reverse(), 1500))
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('2.3 缓存失效：换 model → 重算；形状不符的脏缓存 → 判无效重算（不抛错）', async () => {
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'model-A' } })
    const toolA = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'model-A' } })
    await toolA.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    const a = srv.state.chunkRequests
    const toolB = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'model-B' } })
    clearEmbedQueryMemo()
    await toolB.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.ok(srv.state.chunkRequests > a, '换 model 必须重算')
    // 脏缓存：维度不符
    const bad = await readEmbedCache(p.cachePath)
    assert.ok(bad)
    writeFileSync(p.cachePath, JSON.stringify({ ...bad, dimensions: 3, vectors: bad.vectors.map((v) => v.slice(0, 3)) }), 'utf8')
    const toolC = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'model-B' } })
    clearEmbedQueryMemo()
    const b = srv.state.chunkRequests
    const out = await toolC.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.ok(srv.state.chunkRequests > b, '维度不符的缓存必须判无效并重算')
    assert.equal(out.embedding.degraded, null, '重算成功，不应标降级')
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ── 3. 降级六类攻击：不抛错、关键词照常、无半截缓存 ──────────────────────

const DEGRADES = [
  ['端点 500', () => ({ status: 500, body: JSON.stringify({ error: { message: 'boom with sk-abcdefghijklmnop' } }) })],
  ['非 JSON 响应', () => ({ status: 200, body: '<html>not json</html>' })],
  ['空 data', () => ({ status: 200, body: JSON.stringify({ data: [] }) })],
  ['维度不符（含非数值）', () => ({ status: 200, body: JSON.stringify({ data: [{ embedding: [1, 'x'] }] }) })],
  ['NaN 向量', () => ({ status: 200, body: JSON.stringify({ data: [{ embedding: [Number.NaN, 1, 2, 3] }] }) })],
  ['查询向量正常、分块请求 500', (texts) => (texts.length <= 1 ? {} : { status: 503, body: '{"error":"chunk boom"}' })],
]

for (const [label, mk] of DEGRADES) {
  test(`3.x 降级：${label} → 不抛错、关键词结果照常、如实标降级、缓存不落盘`, async () => {
    const dir = tempDir()
    const srv = await startMock((texts) => mk(texts), 4)
    try {
      const p = seedPaper(dir, DOC, 'mineru-local')
      const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
      const out = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {}) // 不得抛
      assert.equal(out.embedding.configured, true, '配了就必须如实报 configured')
      assert.equal(out.embedding.used, false, `${label}: 不得声称用了语义召回`)
      assert.equal(typeof out.embedding.degraded, 'string', `${label}: 必须给出降级原因`)
      assert.ok(out.embedding.degraded.length > 0)
      // 关键词结果照常
      const chunks = chunkText(DOC, 1500)
      const ref = searchChunks(chunks, [{ page: 1, start: 0, end: DOC.length }], 'locality', 3)
      assert.deepEqual(out.hits.map((h) => h.chunk), ref.map((h) => h.chunk.index), `${label}: 关键词结果不受影响`)
      assert.equal(existsSync(p.cachePath), false, `${label}: 失败不得产生半截缓存`)
      // 错误文案不得泄露 apiKey
      assert.ok(!out.embedding.degraded.includes('sk-mock-123456'), `${label}: 降级原因不得泄露 key`)
    } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
  })
}

test('3.y 降级：超时（不响应）→ 不抛错、降级原因可读、无缓存', async () => {
  const dir = tempDir()
  const slow = createServer((req) => { req.on('data', () => {}); /* 永不响应 */ })
  await new Promise((r) => slow.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${slow.address().port}/v1`
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: url, apiKey: 'sk-mock-123456', model: 'mock-3', timeoutMs: 400 } })
    const t0 = Date.now()
    const out = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.ok(Date.now() - t0 < 10_000, '必须在超时预算内返回')
    assert.equal(out.embedding.used, false)
    assert.match(out.embedding.degraded, /超时|请求失败/)
    assert.equal(existsSync(p.cachePath), false)
  } finally { slow.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('3.z 降级：部分批次失败（batchSize=2，4 块 → 第 2 个批 500）→ 不抛错、缓存不落盘', async () => {
  const dir = tempDir()
  let chunkCall = 0
  const srv = await startMock((texts) => {
    if (texts.length <= 1) return {}
    chunkCall += 1
    return chunkCall === 2 ? { status: 500, body: '{"error":"second batch boom"}' } : {}
  }, 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3', batchSize: 2 } })
    const out = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.ok(srv.state.chunkRequests >= 2, `必须真的分成多个批，实际 ${srv.state.chunkRequests}`)
    assert.ok(srv.state.calls.some((c) => (c.body?.input ?? []).length === 2), '必须有双元素的分块批')
    assert.equal(out.embedding.used, false)
    assert.equal(typeof out.embedding.degraded, 'string')
    assert.equal(existsSync(p.cachePath), false, '部分批次成功后失败：整批作废，不得留半截缓存')
    const chunks = chunkText(DOC, 1500)
    assert.ok(chunks.length >= 4, `前提：至少 4 块，实际 ${chunks.length}`)
    const ref = searchChunks(chunks, [{ page: 1, start: 0, end: DOC.length }], 'locality', 3)
    assert.deepEqual(out.hits.map((h) => h.chunk), ref.map((h) => h.chunk.index))
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ── 4. 隐私：抓包核对请求体 + README 提示一致性 ─────────────────────────

test('4.1 隐私：发往端点的是分块文本原文（分批、无 apiKey、无 query 文本混入 chunk 批）', async () => {
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-privacy-key-9876', model: 'mock-3', batchSize: 2 } })
    await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    const chunks = chunkText(DOC, 1500)
    const chunkCalls = srv.state.calls.filter((c) => (c.body?.input ?? []).length > 1)
    assert.ok(chunkCalls.length >= 1, '必须有分块批')
    const sent = chunkCalls.flatMap((c) => c.body.input)
    assert.deepEqual(sent, chunks.map((c) => c.text), '发出去的必须**逐字节**是分块文本')
    // 查询向量以单元素 input 发出，不与分块混批
    const queryCalls = srv.state.calls.filter((c) => (c.body?.input ?? []).length === 1)
    assert.deepEqual(queryCalls.map((c) => c.body.input[0]), ['locality'])
    // 请求头带 Bearer，但请求体里不出现 key
    assert.equal(srv.state.calls[0].headers.authorization, 'Bearer sk-privacy-key-9876')
    for (const c of srv.state.calls) assert.ok(!c.raw.includes('sk-privacy-key-9876'), '请求体不得携带 apiKey')
    // model / encoding_format 如实发送
    assert.equal(srv.state.calls[0].body.model, 'mock-3')
    assert.equal(srv.state.calls[0].body.encoding_format, 'float')
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('4.2 隐私：README 提示与实际发送行为一致（分块文本 + 查询文本都外发）', async () => {
  const zh = readFileSync(join(ROOT, '..', 'README.md'), 'utf8')
  const en = readFileSync(join(ROOT, '..', 'README_EN.md'), 'utf8')
  const zhSec = zh.slice(zh.indexOf('嵌入'), zh.indexOf('嵌入') + 2600)
  // 事实：分块文本 + 查询文本 + 模型名都会发给端点
  assert.match(zhSec, /分块|片段/, 'zh README 必须说明发出的内容是分块文本')
  assert.match(zhSec, /查询/, 'zh README 必须说明查询文本也会外发')
  assert.match(en.slice(en.indexOf('Embedding'), en.indexOf('Embedding') + 2600), /chunk/i)
  // 缓存文件里不含查询文本（只有分块向量）——抓一个真实缓存核对
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    const raw = readFileSync(p.cachePath, 'utf8')
    assert.ok(!raw.includes('locality'), '缓存文件不得含查询文本')
    assert.ok(!raw.includes('sk-mock-123456'), '缓存文件不得含 apiKey')
    assert.ok(raw.includes('chunkSize') === false, '缓存不含分块原文（只存向量）')
    assert.ok(!raw.includes('Locality of reference'), '缓存不得含分块原文')
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ── 5. 查询侧归一化（折叠项 1）───────────────────────────────────────────

test('5.1 归一化规则与投影侧**等价**：normalizeMathTokens 逐字符等于裸文本上的投影侧归一化', () => {
  // 投影侧对 $...$ 内容跑两步：compressMathBody（压空白）+ normalizeMathBody（去花括号）；
  // 查询侧只跑 normalizeMathBody（**不动空白**，查询里的空格是词边界，不能压）。
  // 等价性因此只在「无空白的数学正文」上成立——这正是归一化关心的形状。
  const cases = ['Q_{t}', 'x_{ij}', 'x_{t-1}', 'x_{0}^{i}', '^{2}', '_{\\alpha}', 'x_{\\alpha}y', 'Q_{t}x_{ij}', 'plain']
  for (const s of cases) {
    assert.ok(!/\s/.test(s), `等价性样本不得含空白：${s}`)
    const viaTokens = normalizeMathTokens(s)
    const viaProjection = projectContentList([{ type: 'text', text: `$${s}$`, page_idx: 0 }]).text
    assert.equal(viaProjection, `$${viaTokens}$`, `${s}: 查询侧规则必须与投影侧一致`)
  }
  // 含空白的输入：查询侧**保留空白**（这是刻意的差异，不是漂移）
  assert.equal(normalizeMathTokens('Q_{t} and x_{ij}'), 'Q_t and x_{ij}')
  assert.equal(normalizeMathTokens('a b'), 'a b')
  assert.equal(normalizeMathTokens('Q_{t}'), 'Q_t')
  assert.equal(normalizeMathTokens('x_{ij}'), 'x_{ij}', '多 token 反例不归一化')
  assert.equal(normalizeMathTokens('x_{t-1}'), 'x_{t-1}')
  assert.equal(normalizeMathTokens('plain prose'), 'plain prose')
  assert.equal(compactQuery('plain prose'), null, '纯散文：无紧凑写法')
  assert.equal(compactQuery('Q_t'), null, '已紧凑：无变体')
  assert.deepEqual(queryVariants('Q_t'), ['Q_t'])
  assert.deepEqual(queryVariants('Q_{t}'), ['Q_{t}', 'Q_t'], '原查询永远保留')
})

test('5.2 两种写法命中同一页；反例不被归一化；纯散文零影响（工具层实测）', async () => {
  const dir = tempDir()
  try {
    const text = 'The transition matrix $Q_t$ governs the forward process.\n\n' + 'filler words for padding. '.repeat(120)
    const p = seedPaper(dir, text, 'mineru-local')
    const tool = makeTool(dir, {})
    const a = await tool.execute({ path: p.pdf, query: 'Q_t', k: 5 }, {})
    const b = await tool.execute({ path: p.pdf, query: 'Q_{t}', k: 5 }, {})
    assert.ok(a.hits.length > 0, 'Q_t 必须命中')
    assert.ok(b.hits.length > 0, 'Q_{t} 必须命中（本轮新增能力）')
    assert.equal(b.compactQuery, 'Q_t')
    assert.deepEqual(b.hits.map((h) => h.chunk), a.hits.map((h) => h.chunk), '两种写法命中同一片段')
    assert.deepEqual(b.hits.map((h) => h.page), a.hits.map((h) => h.page), '同一页')
    // 反例：多 token 参数不归一化
    for (const q of ['x_{ij}', 'x_{t-1}']) {
      const r = await tool.execute({ path: p.pdf, query: q, k: 5 }, {})
      assert.equal(r.compactQuery, null, `${q} 不得被归一化`)
    }
    // 纯散文：多写法路径不得改变结果集
    const chunks = chunkText(text, 1500)
    const plain = await tool.execute({ path: p.pdf, query: 'filler words', k: 5 }, {})
    assert.deepEqual(plain.hits.map((h) => h.chunk), searchChunks(chunks, [{ page: 1, start: 0, end: text.length }], 'filler words', 5).map((h) => h.chunk.index))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('5.3 来源门控：pdfjs 论文不做归一化（不引入新行为）', async () => {
  const dir = tempDir()
  try {
    const text = 'The transition matrix $Q_t$ governs the forward process.\n\n' + 'filler words for padding. '.repeat(120)
    const p = seedPaper(dir, text, 'pdfjs')
    const tool = makeTool(dir, {})
    const out = await tool.execute({ path: p.pdf, query: 'Q_{t}', k: 5 }, {})
    assert.equal(out.compactQuery, null)
    assert.equal(out.hits.length, 0, 'pdfjs 论文的 Q_{t} 照旧搜不到（与改造前一致）')
    assert.equal(searchChunksMulti(chunkText(text, 1500), null, queryVariantsFor('pdfjs', 'Q_{t}'), 5).length, 0)
    assert.equal(queryVariantsFor('mineru-local', 'Q_{t}').length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 6. F-R1：多参数命令全组保护 + 精确白名单 ──────────────────────────────

test('6.1 F-R1：\\textcolor{red}{hello world} 两组都原样；\\textwidth/\\textstyle 不误纳', () => {
  const proj = (s) => normalizeMathBraces(compressMathSpaces(s))
  assert.equal(proj('$\\textcolor{red}{hello world}$'), '$\\textcolor{red}{hello world}$')
  assert.equal(proj('$\\colorbox{yellow}{a b c}$'), '$\\colorbox{yellow}{a b c}$')
  // F-V2（验证者发现，low）已由 repair 轮修复：\fcolorbox 是**三参数**命令（框色/底色/正文），
  // 现在按 `TEXT_GROUP_COMMANDS_MULTI` 声明的组数保护**三组**，第三组（正文）的空格保留。
  // 原两条断言固定的是缺陷行为（第三组被压掉），此处按修复后的正确行为更新——不是放宽而是收紧。
  assert.equal(proj('$\\fcolorbox{red}{blue}{keep me}$'), '$\\fcolorbox{red}{blue}{keep me}$')
  assert.equal(proj('$\\fcolorbox{red}{blue}{a b c}$'), '$\\fcolorbox{red}{blue}{a b c}$')
  // 非正文命令：空白照旧压缩（不被误当 \text）
  assert.equal(proj('$\\textwidth + x _ { t }$'), '$\\textwidth+x_t$')
  assert.equal(proj('$\\textstyle x _ { t }$'), '$\\textstyle x_t$')
  // 原有白名单不回归
  for (const cmd of ['text', 'textrm', 'textnormal', 'textsf', 'texttt', 'mbox', 'hbox', 'fbox', 'operatorname', 'intertext']) {
    assert.equal(proj(`$\\${cmd}{a b c}$`), `$\\${cmd}{a b c}$`, `\\${cmd} 必须保留组内空格`)
  }
  // \textbf 被纳入白名单（实施者声明的取舍：与 \textsf 同族），此处如实记录实际行为
  assert.equal(proj('$\\textbf{a b c}$'), '$\\textbf{a b c}$')
  assert.equal(proj('$\\textit{a b c}$'), '$\\textit{a b c}$')
})

// ── 7. F-R2：定界符扫描跳过 \text{} 组内部 ───────────────────────────────

test('7.1 F-R2：组内 $ 不当定界符，\\text{costs $5}$ 整体保留', () => {
  const proj = (s) => normalizeMathBraces(compressMathSpaces(s))
  const s = '$\\text{costs $5}$'
  assert.equal(proj(s), s, '内层 $ 不得切开区间')
  // 组内 $ 与区间外的 $ 计数一致
  assert.equal((proj(s).match(/\$/g) ?? []).length, 3)
  // 组外的相邻区间仍能正确界定
  assert.equal(proj('a $x _ { t }$ $\\text{c $5}$ b'), 'a $x_t$ $\\text{c $5}$ b')
  // display 区间同样跳过
  assert.equal(proj('$$\\text{a $ b} + x _ { t }$$'), '$$\\text{a $ b}+x_t$$')
})

// ── 8. 零向量 / 无正相似度：不得把结果集改坏 ─────────────────────────────

test('8.1 所有嵌入为相同向量（相似度全 1）时，融合不丢关键词命中且仍返回 k 条', async () => {
  const dir = tempDir()
  const srv = await startMock((texts) => ({ body: texts.map(() => [1, 0, 0, 0]) }), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    const out = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.equal(out.embedding.used, true, '相似度 1 > 0，语义候选非空')
    const chunks = chunkText(DOC, 1500)
    const kw = searchChunks(chunks, [{ page: 1, start: 0, end: DOC.length }], 'locality', 3)
    for (const h of kw) assert.ok(out.hits.some((x) => x.chunk === h.chunk.index), '关键词命中不得被语义召回挤掉')
    assert.ok(out.hits.length <= 3, `k=3 不得超发，实际 ${out.hits.length}`)
    assert.ok(out.hits.every((h, i, a) => i === 0 || a[i - 1].chunk < h.chunk), '仍按原文顺序返回')
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('8.2 零向量（相似度全 0）→ 语义候选为空、结果等价纯关键词、不标降级', async () => {
  const dir = tempDir()
  const srv = await startMock((texts) => ({ body: texts.map(() => [0, 0, 0, 0]) }), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    const out = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.equal(out.embedding.configured, true)
    assert.equal(out.embedding.used, false, '零向量不得进候选')
    assert.equal(out.embedding.degraded, null, '调用成功不是降级')
    const chunks = chunkText(DOC, 1500)
    const kw = searchChunks(chunks, [{ page: 1, start: 0, end: DOC.length }], 'locality', 3)
    assert.deepEqual(out.hits.map((h) => h.chunk), kw.map((h) => h.chunk.index), '与纯关键词完全一致')
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ── 9. 回归：mode=off / 富产物字节保真 / 缓存语义不被嵌入污染 ────────────

test('9.1 回归：默认关闭时不得产生任何嵌入缓存文件', async () => {
  const dir = tempDir()
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, {})
    await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.equal(existsSync(embeddingsPathFor(p.txtPath)), false, '未配置时不得落 .embeddings.json')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('9.2 回归：嵌入路径不影响 .txt/.pages.json/.transcript.json 字节', async () => {
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const before = [p.txtPath, p.txtPath.replace(/\.txt$/, '.pages.json'), p.txtPath.replace(/\.txt$/, '.transcript.json')]
      .map((f) => sha(readFileSync(f, 'utf8')))
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    const after = [p.txtPath, p.txtPath.replace(/\.txt$/, '.pages.json'), p.txtPath.replace(/\.txt$/, '.transcript.json')]
      .map((f) => sha(readFileSync(f, 'utf8')))
    assert.deepEqual(after, before, '检索缓存不得改写转录产物')
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ── 10. 文档声明的事实核对（README 与实际行为）─────────────────────────

test('10.1 README 的「同一查询重复检索零请求」为真（含查询向量在内，总请求数 0）', async () => {
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    const baseline = srv.state.calls.length
    assert.ok(baseline >= 2, '首次至少 1 次查询 + 1 次分块')
    clearEmbedQueryMemo() // 只清进程内备忘 → 文档的另一条声明（缓存命中零分块请求）单独核算
    await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.equal(srv.state.chunkRequests, 1, '分块请求仍只有首次那一次')
    // 不清备忘（同一进程同一查询）→ 总请求零增长
    const before = srv.state.calls.length
    const out3 = await tool.execute({ path: p.pdf, query: 'locality', k: 3 }, {})
    assert.equal(srv.state.calls.length, before, '同一查询重复检索必须零请求（查询备忘 + 分块缓存）')
    assert.equal(out3.embedding.fromCache, true)
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('10.2 隐私提示与实测一致性：分块文本与**查询文本**都已声明外发（F-V1 已修）', async () => {
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    const p = seedPaper(dir, DOC, 'mineru-local')
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    await tool.execute({ path: p.pdf, query: 'reward of the policy', k: 3 }, {})
    const allSent = srv.state.calls.flatMap((c) => c.body.input)
    assert.ok(allSent.includes('reward of the policy'), '实测：查询文本确实会发往端点')
    const zh = readFileSync(join(ROOT, '..', 'README.md'), 'utf8')
    const en = readFileSync(join(ROOT, '..', 'README_EN.md'), 'utf8')
    const zhWarn = zh.slice(zh.indexOf('**隐私提示**'), zh.indexOf('**隐私提示**') + 300)
    const enWarn = en.slice(en.indexOf('**Privacy notice**'), en.indexOf('**Privacy notice**') + 300)
    assert.match(zhWarn, /分块文本/, 'zh 已声明分块文本外发')
    assert.match(enWarn, /chunk texts?/i, 'en 已声明分块文本外发')
    // F-V1（t6 发现、t8 集成轮修复）：两处隐私提示现在**必须**声明查询文本也会外发（实测会发；此前只写了①分块文本）
    assert.match(zhWarn, /查询文本/, 'F-V1 已修：zh 隐私提示必须声明「查询文本」也会外发')
    assert.match(enWarn, /query text/i, 'F-V1 已修：en 隐私提示必须声明 query text 也会外发')
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ── 11. 服务端预检（README 声明「保存前真打一发 /embeddings」）─────────────

test('11.1 预检：testEmbedEndpoint 真打端点，坏端点 ok=false 且错误可读', async () => {
  const { testEmbedEndpoint } = await import(dist('embed-config.js'))
  const good = await startMock(() => ({}), 4)
  const bad = await startMock(() => ({ status: 500, body: '{"error":"nope"}' }), 4)
  try {
    const a = await testEmbedEndpoint({ baseUrl: good.url, apiKey: 'sk-mock-123456', model: 'mock-3' })
    assert.equal(a.ok, true, '可用端点应通过预检')
    assert.ok(good.state.calls.length >= 1, '预检必须真的打端点')
    const b = await testEmbedEndpoint({ baseUrl: bad.url, apiKey: 'sk-mock-123456', model: 'mock-3' })
    assert.equal(b.ok, false)
    assert.equal(typeof b.detail, 'string')
    assert.ok(!b.detail.includes('sk-mock-123456'), '预检错误不得泄露 key')
    const dead = await testEmbedEndpoint({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-mock-123456', model: 'mock-3', timeoutMs: 400 })
    assert.equal(dead.ok, false)
  } finally { await good.close(); await bad.close() }
})

// ── 12. 惰性的功能性证据（队长补充要求）：真跑一次转录，数嵌入请求 ─────────

const LAZY_PDF = join(ROOT, '..', '.probe', 'fixture.pdf')

test('12.1 惰性：真跑一次 pdfjs 转录 → 嵌入端点请求数必须为 0', { skip: existsSync(LAZY_PDF) ? false : '样本 PDF 缺失' }, async () => {
  const dir = tempDir()
  const srv = await startMock(() => ({}), 4)
  try {
    // 用仓库内既有的可提取文本 PDF（.probe/fixture.pdf，1680 字符）；不用自造 PDF：
    // 自造 PDF 在 pdfjs `disableFontFace` 下多次得到 0 文本层（验证者已定位为合成 PDF 的字体问题，非产品缺陷）。
    const pdfPath = join(dir, 'lazy.pdf')
    copyFileSync(LAZY_PDF, pdfPath)
    const ref = resolvePaper(dir, { path: pdfPath })
    const cfg = { config: { ...MINERU_DEFAULTS, mode: 'off' }, source: 'none' }
    const t = await transcribePaper(ref, { source: 'auto', mineru: cfg })
    assert.equal(t.producer, 'pdfjs')
    assert.ok(t.chars >= 1000, `转录成功（${t.chars} 字符）`)
    assert.equal(srv.state.calls.length, 0, 'transcribe_pdf 阶段必须零嵌入请求（惰性）')
    assert.equal(existsSync(embeddingsPathFor(ref.txtPath)), false, '转录不得落嵌入缓存')

    // 紧接着做一次检索 → 这才第一次发请求（证明是「首次检索该论文才计算」）
    const tool = makeTool(dir, { embed: { baseUrl: srv.url, apiKey: 'sk-mock-123456', model: 'mock-3' } })
    const out = await tool.execute({ path: pdfPath, query: 'sentence', k: 3 }, {})
    assert.ok(srv.state.calls.length >= 1, '首次检索才发嵌入请求')
    assert.ok(existsSync(embeddingsPathFor(ref.txtPath)), '首次检索后缓存落盘')
    assert.equal(out.embedding.configured, true)
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('12.2 惰性：嵌入客户端只被检索路径引用（源码级核对，非仅结构声明）', async () => {
  const { readFileSync: rf, readdirSync: rd } = await import('node:fs')
  const srcDir = join(ROOT, '..', 'src')
  const importers = []
  for (const f of rd(srcDir).filter((x) => x.endsWith('.ts'))) {
    const body = rf(join(srcDir, f), 'utf8')
    if (/from '\.\/embed(\.ts)?'|from '\.\/embed-config(\.ts)?'/.test(body)) importers.push(f)
  }
  assert.deepEqual(importers.sort(), ['embed-config.ts', 'host.ts', 'tools.ts'].filter((f) => importers.includes(f)).sort())
  assert.ok(!importers.includes('transcribe.ts'), 'transcribe.ts 不得引用嵌入模块')
  // 检索路径（tools.ts）里 embeddingRecallFor 只出现在 search_paper 的 execute 内
  const tools = rf(join(srcDir, 'tools.ts'), 'utf8')
  const idx = [...tools.matchAll(/embeddingRecallFor\(/g)].map((m) => m.index)
  assert.equal(idx.length, 1, 'embeddingRecallFor 只应有一个调用点')
  const before = tools.slice(0, idx[0])
  assert.ok(before.lastIndexOf("name: 'search_paper'") > before.lastIndexOf("name: 'transcribe_pdf'"), '唯一调用点必须在 search_paper 之内')
})
