// test/formula-search-cache.test.mjs — t2 验证补充：缓存语义 + 富产物字节保真 + pdfjs/mode=off 回归。
//
// 目的（验收第 6/7 条）：
//   1. 盘上旧 .txt（改造前的逐 token 写法）不会被自动改写；读缓存走原样返回。
//   2. 只有 force（或显式重新转录）才会用新投影覆盖，且覆盖后公式变可搜。
//   3. .mineru.md / .mineru.json 是 MinerU 原始响应原样（不经数学压缩、字节一致）。
//   4. pdfjs 路径与 mode=off 行为不变（不触发 MinerU、不产生富产物）。
//
// 只 import dist/*.js，跑前先 `npm run build`。MinerU 用本地 mock HTTP（不依赖 127.0.0.1:8000）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

const mcfg = await import(dist('mineru-config.js'))
const tscribe = await import(dist('transcribe.js'))
const library = await import(dist('library.js'))
const search = await import(dist('search.js'))
const { MINERU_DEFAULTS } = mcfg
const { transcribePaper, readTranscript } = tscribe
const { resolvePaper } = library
const { chunkText, searchChunks } = search

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

// 真实 MinerU 第 4 页形状的原文（逐 token 空格），取自验证者抓取的 content_list。
// 末尾补一个 >1000 字符的正文块：parseAndStoreMineru 有「投影文本 <1000 字符 = 疑似失败」的门槛。
const PROSE_FILLER = Array.from({ length: 8 }, (_, i) =>
  `Paragraph ${i + 1}: the transition matrix Q is crucial to the discrete diffusion model and should be carefully designed so that the reverse network can recover the signal from noises.`).join(' ')
const RAW_BLOCKS = [
  {
    type: 'text',
    text:
      'We define the probabilities that $x _ { t - 1 }$ transits to $x _ { t }$ using the matrices $[ Q _ { t } ] _ { m n } = q ( x _ { t } = m | x _ { t - 1 } = n ) \\in$ $\\mathbb { R } ^ { K \\times K }$ . Then theforward Markov diffusion process can be written as,',
    page_idx: 0,
  },
  {
    type: 'equation',
    text:
      '$$\nq ( x _ { t } | x _ { t - 1 } ) = \\pmb { v } ^ { \\top } ( x _ { t } ) \\pmb { Q } _ { t } \\pmb { v } ( x _ { t - 1 } )\\tag{3}\n$$',
    page_idx: 0,
  },
  { type: 'text', text: PROSE_FILLER, page_idx: 0 },
]
const RAW_CONTENT_LIST = JSON.stringify(RAW_BLOCKS)
const RAW_MARKDOWN = '# Page 4\n\nq ( x _ { t } | x _ { t - 1 } ) = \\pmb { v } ^ { \\top } ( x _ { t } ) \\pmb { Q } _ { t } \\pmb { v } ( x _ { t - 1 } )\n'

// 旧缓存（改造前投影产物：把原文 text 逐块用 \n\n 拼起来，未压缩）
const OLD_TXT = RAW_BLOCKS.map((b) => b.text).join('\n\n') + '\n\n' + 'Filler sentence to keep the cache above the one thousand byte validity threshold used by the reader. '.repeat(12)

function startMineruMock() {
  let parseCalls = 0
  const server = createServer((req, res) => {
    if (req.url === '/tasks' && req.method === 'POST') {
      parseCalls++
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['p'] }))
      return
    }
    if (req.url === '/tasks/t1/result') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ backend: 'pipeline', version: '3.4.5', results: { p: { md_content: RAW_MARKDOWN, content_list: RAW_CONTENT_LIST } } }))
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      calls: () => parseCalls,
    }))
  })
}

/** 起 mock + 临时库目录 + 一份 PDF 占位。 */
async function setup() {
  const mock = await startMineruMock()
  const dir = mkdtempSync(join(tmpdir(), 'dpr-formula-cache-'))
  const pdfPath = join(dir, 'paper.pdf')
  writeFileSync(pdfPath, '%PDF-1.4\n% only a placeholder for path resolution\n')
  const ref = resolvePaper(dir, { path: pdfPath })
  const cfg = {
    config: { ...MINERU_DEFAULTS, mode: 'local', local: { ...MINERU_DEFAULTS.local, baseUrl: mock.url, pollIntervalMs: 5, requestTimeoutMs: 5000, noResponseTimeoutMs: 5000, jobTimeoutMs: 5000 } },
    source: 'none',
  }
  const cleanup = () => { mock.server.close(); rmSync(dir, { recursive: true, force: true }) }
  return { doc: mock, dir, pdfPath, ref, cfg, cleanup }
}

// ── 1. 旧缓存不被自动改写 ────────────────────────────────────────────────

test('缓存：盘上旧 .txt（逐 token 写法）在 source=auto 下原样返回，不被自动改写', async () => {
  const s = await setup()
  try {
    writeFileSync(s.ref.txtPath, OLD_TXT, 'utf8')
    const before = sha(readFileSync(s.ref.txtPath, 'utf8'))
    const t = await transcribePaper(s.ref, { source: 'auto', mineru: s.cfg })
    assert.equal(t.source, 'cache')
    assert.equal(t.text, OLD_TXT, '读缓存必须原样返回')
    assert.equal(sha(readFileSync(s.ref.txtPath, 'utf8')), before, '.txt 不得被改写')
    assert.equal(s.doc.calls(), 0, 'source=auto 命中缓存时不得调用 MinerU')
    // 旧缓存里公式仍不可搜（改造前形态）
    assert.equal(searchChunks(chunkText(t.text, 1500), t.pages, 'x_{t-1}', 5).length, 0)
  } finally { s.cleanup() }
})

test('缓存：source=mineru-local 但缓存是 legacy（无 .transcript.json）时判定 stale 并重新解析', async () => {
  const s = await setup()
  try {
    writeFileSync(s.ref.txtPath, OLD_TXT, 'utf8')
    const t = await transcribePaper(s.ref, { source: 'mineru-local', mineru: s.cfg })
    assert.equal(s.doc.calls(), 1, '显式来源与缓存 producer 不匹配 → 必须重新解析')
    assert.equal(t.producer, 'mineru-local')
    const written = readFileSync(s.ref.txtPath, 'utf8')
    assert.notEqual(written, OLD_TXT)
    // 覆盖后可搜（第 1 页）
    const hits = searchChunks(chunkText(written, 1500), t.pages, 'x_{t-1}', 5)
    assert.ok(hits.length > 0)
    assert.equal(hits[0].page, 1)
  } finally { s.cleanup() }
})

test('缓存：force=true 用新投影覆盖旧 .txt，公式由 0 命中变为命中（实现者「需 force 重新转录」的说法成立）', async () => {
  const s = await setup()
  try {
    writeFileSync(s.ref.txtPath, OLD_TXT, 'utf8')
    // 先确认旧缓存不可搜
    const cached = await readTranscript(s.ref)
    assert.equal(searchChunks(chunkText(cached.text, 1500), cached.pages, 'x_{t-1}', 5).length, 0)
    const t = await transcribePaper(s.ref, { force: true, source: 'auto', mineru: s.cfg })
    assert.equal(s.doc.calls(), 1)
    assert.equal(t.producer, 'mineru-local')
    const written = readFileSync(s.ref.txtPath, 'utf8')
    assert.ok(written.includes('$x_{t-1}$'), written.slice(0, 300))
    assert.ok(written.includes('[Q_t]_{mn}') || written.includes('Q_t'), written.slice(0, 300))
    for (const q of ['x_{t-1}', 'Q_t', '\\mathbb{R}']) {
      assert.ok(searchChunks(chunkText(written, 1500), t.pages, q, 5).length > 0, q)
    }
  } finally { s.cleanup() }
})

// ── 2. .mineru.md / .mineru.json 字节保真 ────────────────────────────────

test('富产物：.mineru.md / .mineru.json 与 MinerU 原始响应逐字节一致（未被数学压缩）', async () => {
  const s = await setup()
  try {
    await transcribePaper(s.ref, { source: 'mineru-local', mineru: s.cfg })
    const md = readFileSync(s.ref.mineruMdPath, 'utf8')
    assert.equal(md, RAW_MARKDOWN, '.mineru.md 必须是 md_content 原样')
    const mj = JSON.parse(readFileSync(s.ref.mineruJsonPath, 'utf8'))
    assert.deepEqual(mj.contentList, RAW_BLOCKS, '.mineru.json 的 contentList 必须是原始块数组')
    // 原始块里的逐 token 写法一字未动
    assert.equal(mj.contentList[0].text, RAW_BLOCKS[0].text)
    assert.ok(mj.contentList[0].text.includes('x _ { t - 1 }'))
    // 而 .txt 是同一次转录的压缩投影 → 两个产物必然不同源（设计如此）
    const txt = readFileSync(s.ref.txtPath, 'utf8')
    assert.notEqual(txt, RAW_BLOCKS.map((b) => b.text).join('\n\n'))
    assert.ok(txt.includes('x_{t-1}'))
  } finally { s.cleanup() }
})

test('富产物：产物文件集合与顺序（.mineru.md/.mineru.json/.pages.json/.txt/.transcript.json）齐全', async () => {
  const s = await setup()
  try {
    await transcribePaper(s.ref, { source: 'mineru-local', mineru: s.cfg })
    const files = readdirSync(s.dir).filter((f) => f.startsWith('paper.') && !f.endsWith('.tmp') && !f.includes('.tmp-')).sort()
    assert.deepEqual(files, ['paper.mineru.json', 'paper.mineru.md', 'paper.pages.json', 'paper.pdf', 'paper.transcript.json', 'paper.txt'])
  } finally { s.cleanup() }
})

// ── 3. pdfjs / mode=off 回归 ────────────────────────────────────────────

test("回归：producer=pdfjs 的缓存走 pdfjs 分支——不被数学压缩、不被改写、不调 MinerU", async () => {
  const s = await setup()
  try {
    const PDFJS_TXT = [
      'Plain pdfjs transcript with no dollar signs at all.',
      'It must come back byte-for-byte.',
    ].join('\n\n') + '\n\n' + 'Filler '.repeat(140)
    writeFileSync(s.ref.txtPath, PDFJS_TXT, 'utf8')
    writeFileSync(s.ref.pagesPath, JSON.stringify({ pageCount: 1, pages: [{ page: 1, start: 0, end: PDFJS_TXT.length }] }), 'utf8')
    writeFileSync(s.ref.transcriptPath, JSON.stringify({ v: 1, producer: 'pdfjs', text: { bytes: Buffer.byteLength(PDFJS_TXT, 'utf8'), chars: PDFJS_TXT.length, pageCount: 1 } }), 'utf8')
    const before = sha(readFileSync(s.ref.txtPath, 'utf8'))

    for (const mineru of [
      { config: { ...MINERU_DEFAULTS, mode: 'off' }, source: 'none' },
      { config: { ...MINERU_DEFAULTS, mode: 'local', local: { ...MINERU_DEFAULTS.local, baseUrl: s.doc.url } }, source: 'none' },
    ]) {
      const t = await transcribePaper(s.ref, { source: 'auto', mineru })
      assert.equal(t.producer, 'pdfjs')
      assert.equal(t.source, 'cache')
      assert.equal(t.text, PDFJS_TXT, 'pdfjs 产物必须原样返回')
      assert.equal(sha(readFileSync(s.ref.txtPath, 'utf8')), before, '.txt 不得被改写')
    }
    assert.equal(s.doc.calls(), 0, 'source=auto 命中 pdfjs 缓存时不得调用 MinerU')
    assert.equal(existsSync(s.ref.mineruMdPath), false, 'pdfjs 缓存不得长出 MinerU 富产物')
    assert.equal(existsSync(s.ref.mineruJsonPath), false)
  } finally { s.cleanup() }
})

test('回归：mode=off 命中已有缓存 → 原样返回，不做任何数学处理', async () => {
  const s = await setup()
  try {
    writeFileSync(s.ref.txtPath, OLD_TXT, 'utf8')
    writeFileSync(s.ref.pagesPath, JSON.stringify({ pageCount: 1, pages: [{ page: 1, start: 0, end: OLD_TXT.length }] }), 'utf8')
    const off = { config: { ...MINERU_DEFAULTS, mode: 'off' }, source: 'none' }
    const t = await transcribePaper(s.ref, { source: 'auto', mineru: off })
    assert.equal(t.source, 'cache')
    assert.equal(t.text, OLD_TXT)
    assert.equal(s.doc.calls(), 0)
  } finally { s.cleanup() }
})

// ── 4. 真实论文单页端到端（本地 MinerU + 一篇含公式的真实论文 PDF）────────────
// 样本通过环境变量 DPR_SAMPLE_PDF 提供（指向任意含公式的 PDF）；未设置、文件不存在
// 或本地 MinerU 不可达时 skip（exit 0），避免 CI 噪声。
//   DPR_SAMPLE_PDF=/path/to/paper.pdf node --test "test/*.test.mjs"

const GU_PDF = process.env.DPR_SAMPLE_PDF ?? ''
const guAvailable = GU_PDF !== '' && existsSync(GU_PDF)
const realSkip = guAvailable ? false : '未设置 DPR_SAMPLE_PDF（或该文件不存在）'

test('端到端（真实 PDF）：单页 MinerU /file_parse → 投影 → chunkText/searchChunks 命中公式', { skip: realSkip }, async () => {
  try {
    const { parseLocalMineruSync } = await import(dist('mineru.js'))
    const buf = readFileSync(GU_PDF)
    const r = await parseLocalMineruSync({
      baseUrl: 'http://127.0.0.1:8000', apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto',
      serverUrl: '', langList: ['ch'], imageAnalysis: false,
      requestTimeoutMs: 60000, pollIntervalMs: 1000, noResponseTimeoutMs: 120000, jobTimeoutMs: 120000,
      pdfBytes: new Uint8Array(buf), fileName: 'gu.pdf',
    })
    const txt = r.projection.text
    const chunks = chunkText(txt, 1500)
    assert.ok(r.projection.pages.length >= 4, '整篇解析应至少覆盖到第 4 页')
    for (const q of ['x_{t-1}', '\\mathbb{R}', 'Q_t', 'q(x_t|x_{t-1})']) {
      const hits = searchChunks(chunks, r.projection.pages, q, 8)
      assert.ok(hits.length > 0, `${q} 应命中（真实 PDF 端到端）`)
      assert.ok(hits.some((h) => h.page === 4), `${q} 应至少命中一个第 4 页片段，实际 ${JSON.stringify(hits.map((h) => h.page))}`)
    }
    // 富产物（写进 .mineru.json 的块）保持 MinerU 原样：逐 token 写法仍在，且本身不可搜
    const rawText = r.blocks.map((b) => b.text).filter((x) => typeof x === 'string').join('\n\n')
    assert.ok(rawText.includes('x _ { t - 1 }'), '富产物里的公式必须保持 MinerU 原样')
    assert.equal(searchChunks(chunkText(rawText, 1500), null, 'x_{t-1}', 5).length, 0, '改造前基线：同一段文本 0 命中')
  } catch (err) {
    if (/fetch failed|ECONNREFUSED|not reachable|HTTP 4|HTTP 5/.test(String(err))) return
    throw err
  }
})
