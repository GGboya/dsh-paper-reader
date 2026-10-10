// test/mineru-offline.test.mjs — MinerU 接入的离线单元测试（不依赖真实 MinerU 服务）。
// 只 import dist/*.js（Node 22 无法直接跑 TS）。跑前先 `npm run build`。
// 覆盖：content_list 字符串解析与页码映射、缓存来源判定与向后兼容、配置优先级与掩码、
//       最小 ZIP 读取器、云端请求序列（mock HTTP）、错误与超时路径。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { deflateRawSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

const mineru = await import(dist('mineru.js'))
const mcfg = await import(dist('mineru-config.js'))
const tscribe = await import(dist('transcribe.js'))
const library = await import(dist('library.js'))
const search = await import(dist('search.js'))

const { projectContentList, parseContentListString, stripHtmlTags, extractZipEntries, pickZipMarkdown, pickZipContentList, asciiSanitize, parseLocalMineru, parseCloudMineru, MineruError } = mineru
const { resolveMineruConfig, readMineruConfig, writeMineruConfig, clearMineruConfig, mineruConfigPath, normalizeLocalBaseUrl, maskApiKey, mergeMineruBody, testMineruLocal, testMineruCloud, MINERU_DEFAULTS } = mcfg
const { transcribePaper, readTranscriptMeta, atomicTempPath, ShortTextError } = tscribe
const { resolvePaper } = library
const { chunkText, pageForOffset } = search

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dpr-mineru-test-'))
}

/** 起一个本地 HTTP mock，返回 { server, port, url }。 */
function startServer(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

/** 读请求体。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

// ── 1. content_list 字符串解析与页码映射（AC-B6 / AC-C2 / AC-C3）─────────

test('parseContentListString：content_list 是 JSON 字符串，parse 后为数组', () => {
  const blocks = parseContentListString(JSON.stringify([{ type: 'text', text: 'a', page_idx: 0 }]))
  assert.ok(Array.isArray(blocks))
  assert.equal(blocks.length, 1)
  assert.equal(parseContentListString(null), null)
  assert.throws(() => parseContentListString('not json'), MineruError)
  assert.throws(() => parseContentListString('{"a":1}'), MineruError)
})

test('projectContentList：按 page_idx 聚页，page=page_idx+1，页内/页间 \\n\\n，区间自洽', () => {
  const blocks = [
    { type: 'text', text: 'Page one heading', text_level: 1, page_idx: 0 },
    { type: 'text', text: 'Alpha keyword locality', page_idx: 0 },
    { type: 'text', text: 'Second page heading', page_idx: 1 },
    { type: 'text', text: 'Delta keyword checkpoint', page_idx: 1 },
  ]
  const p = projectContentList(blocks)
  assert.equal(p.pageCount, 2)
  assert.equal(p.pages.length, 2)
  assert.equal(p.pages[0].page, 1)
  assert.equal(p.pages[0].start, 0)
  assert.equal(p.pages[1].page, 2)

  // 区间自洽：升序、互不重叠、每个 span 恰好覆盖它自己那页的正文。
  // 注意**不要求** start === 上一页 end：页与页之间用 \n\n 连接，分隔符落在两个
  // span 之间的 2 字符间隙里。这是 v1.2.0 就有的既定语义——pdfjs 路径同样是
  // `start = buf.length + 2`（src/transcribe.ts 拼页逻辑）；search.pageForOffset
  // 对落进间隙的位置返回上一页，且 chunkText 按 \n\n 分段、chunk 起点不会落进间隙，
  // 所以间隙不影响页码映射。
  const SEP = 2 // '\n\n'
  const expectedPages = [
    'Page one heading\n\nAlpha keyword locality',
    'Second page heading\n\nDelta keyword checkpoint',
  ]
  assert.equal(p.text, expectedPages.join('\n\n'), '全文 = 各页正文用 \\n\\n 连接')
  for (let i = 0; i < p.pages.length; i++) {
    if (i > 0) {
      assert.ok(p.pages[i].page > p.pages[i - 1].page, '页码升序')
      assert.ok(p.pages[i].start >= p.pages[i - 1].end, '区间不重叠')
      assert.equal(p.pages[i].start, p.pages[i - 1].end + SEP, '页间间隙恰好是 \\n\\n 分隔符')
    }
    assert.equal(
      p.text.slice(p.pages[i].start, p.pages[i].end),
      expectedPages[i],
      `第 ${i + 1} 个 span 覆盖的正是它自己那页的正文`,
    )
  }
})

test('projectContentList：表格 HTML 剥标签且 caption/footnote 保留；公式 text 保留；未知 type 兜底', () => {
  const blocks = [
    { type: 'table', table_body: '<table><tr><td>c1</td><td>c2</td></tr></table>', table_caption: ['表 1 分类'], table_footnote: ['注：示例'], page_idx: 0 },
    { type: 'equation', text: '$E=mc^2$', page_idx: 0 },
    { type: 'mystery_block', text: 'unknown but has text', page_idx: 0 },
    { type: 'mystery_empty', foo: 'bar', page_idx: 0 },
  ]
  const p = projectContentList(blocks)
  const page1 = p.text.slice(0, p.pages[0].end)
  assert.match(page1, /表 1 分类/)
  assert.match(page1, /c1\s+c2/)
  assert.match(page1, /注：示例/)
  assert.match(page1, /\$E=mc\^2\$/)
  assert.match(page1, /unknown but has text/)
})

test('projectContentList：缺 page_idx 归到上一块页码并记 warning；首个缺则归第 1 页', () => {
  const blocks = [
    { type: 'text', text: 'first', page_idx: 0 },
    { type: 'text', text: 'no page idx' },
    { type: 'text', text: 'second page', page_idx: 1 },
  ]
  const warnings = []
  const p = projectContentList(blocks, warnings)
  assert.equal(p.pages[0].page, 1)
  assert.match(p.text.slice(0, p.pages[0].end), /no page idx/)
  assert.ok(warnings.some((w) => w.includes('page_idx')))
})

test('stripHtmlTags：标签替换成空格、解实体、折单行', () => {
  assert.equal(stripHtmlTags('<table><tr><td>a&amp;b</td><td>c</td></tr></table>'), 'a&b c')
})

// ── 2. 最小 ZIP 读取器（AC-G3）──────────────────────────────────────────

function crc32(buf) {
  // 读取器不校验 CRC，这里给占位 0 即可
  return 0
}

function makeZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    const comp = e.method === 8 ? deflateRawSync(data) : data
    const nameBuf = Buffer.from(e.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(e.method, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    // 本地头之后必须紧跟「条目名字节」，再是压缩数据：读取器按
    // localOffset + 30 + nameLen + extraLen 计算数据起点（ZIP 规范如此）。
    // 早前这里漏写了 nameBuf，导致读取器多跳 nameLen 个字节、解出乱码
    // （inflateRaw → "invalid stored block lengths"）。用 python3 zipfile
    // 交叉验证可复现：BadZipFile: File name in directory ... and header ... differ。
    localParts.push(local, nameBuf, comp)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(e.method, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += local.length + nameBuf.length + comp.length
  }
  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDir, eocd])
}

test('extractZipEntries：method 0（stored）与 method 8（deflate）都能解，条目名按后缀匹配', () => {
  const md = '# Hello MinerU'
  const cl = JSON.stringify([{ type: 'text', text: 'x', page_idx: 0 }])
  const zip = makeZip([
    { name: '论文_测试/full.md', data: md, method: 8 },
    { name: '论文_测试/content_list.json', data: cl, method: 0 },
  ])
  // fixture 自检（与被测实现无关，独立守住 makeZip 的结构正确性）：
  // 本地头 → 条目名 → 数据 的字节顺序必须成立，否则读取器按规范算出的数据起点会错位。
  const nm = Buffer.from('论文_测试/full.md', 'utf8')
  assert.equal(zip.readUInt32LE(0), 0x04034b50, '本地头签名')
  assert.equal(zip.readUInt16LE(26), nm.length, '本地头 nameLen')
  assert.deepEqual(zip.subarray(30, 30 + nm.length), nm, '本地头之后必须是条目名')
  assert.equal(zip.readUInt16LE(8), 8, '本地头 method=deflate')
  // 中央目录里的 localOffset 必须指回第一个本地头（offset 累加把 nameLen 算进去）
  const eocd = zip.length - 22
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, 'EOCD 签名')
  const cdOffset = zip.readUInt32LE(eocd + 16)
  assert.equal(zip.readUInt32LE(cdOffset + 42), 0, '第一个条目的 localOffset=0')
  const entries = extractZipEntries(zip)
  assert.equal(entries.length, 2)
  const mdEntry = pickZipMarkdown(entries)
  assert.ok(mdEntry)
  assert.equal(Buffer.from(mdEntry.data).toString('utf8'), md)
  const clEntry = pickZipContentList(entries)
  assert.ok(clEntry)
  assert.equal(Buffer.from(clEntry.data).toString('utf8'), cl)
})

test('asciiSanitize：非 ASCII → "_"，缓存仍按本地 stem（由 transcribe 层负责）', () => {
  assert.equal(asciiSanitize('论文 x.pdf'), '__ x.pdf')
  assert.equal(asciiSanitize('paper.pdf'), 'paper.pdf')
})

// ── 3. 配置优先级 / 掩码 / 规范化（AC-E1..E6）───────────────────────────

test('resolveMineruConfig：file > profile > env > 默认，逐字段；source 判定', async () => {
  const home = tempDir()
  await writeMineruConfig({
    mode: 'local',
    local: { ...MINERU_DEFAULTS.local, baseUrl: 'http://file.example' },
    cloud: { ...MINERU_DEFAULTS.cloud, apiKey: 'file-key-1234567890' },
  }, home)

  const profile = {
    mode: 'cloud',
    local: { ...MINERU_DEFAULTS.local, baseUrl: 'http://profile.example' },
    cloud: { ...MINERU_DEFAULTS.cloud, apiKey: 'profile-key-1234567890' },
  }
  const env = { MINERU_API_KEY: 'env-key-1234567890', DSH_MINERU_LOCAL_URL: 'http://env.example' }

  const r1 = await resolveMineruConfig(profile, home, env)
  assert.equal(r1.source, 'file')
  assert.equal(r1.config.mode, 'local')
  assert.equal(r1.config.local.baseUrl, 'http://file.example')
  assert.equal(r1.config.cloud.apiKey, 'file-key-1234567890')

  await clearMineruConfig(home)
  const r2 = await resolveMineruConfig(profile, home, env)
  assert.equal(r2.source, 'profile')
  assert.equal(r2.config.mode, 'cloud')
  assert.equal(r2.config.local.baseUrl, 'http://profile.example')
  assert.equal(r2.config.cloud.apiKey, 'profile-key-1234567890')

  const r3 = await resolveMineruConfig(undefined, home, env)
  assert.equal(r3.source, 'env')
  assert.equal(r3.config.mode, 'off') // env 不覆盖 mode，默认 off
  assert.equal(r3.config.local.baseUrl, 'http://env.example')
  assert.equal(r3.config.cloud.apiKey, 'env-key-1234567890')

  const r4 = await resolveMineruConfig(undefined, home, {})
  assert.equal(r4.source, 'none')
  assert.equal(r4.config.mode, 'off')
  assert.equal(r4.config.local.baseUrl, MINERU_DEFAULTS.local.baseUrl)

  // 边界：文件存在但不含任何已识别字段（{} 或无关字段）时，来源不能算 file（§10.3）。
  writeFileSync(mineruConfigPath(home), JSON.stringify({ foo: 1 }), 'utf8')
  const r5 = await resolveMineruConfig(profile, home, env)
  assert.equal(r5.source, 'profile')
  assert.equal(r5.config.mode, 'cloud')
  // 只写了 mode 也算已识别 → file
  writeFileSync(mineruConfigPath(home), JSON.stringify({ mode: 'local' }), 'utf8')
  const r6 = await resolveMineruConfig(profile, home, env)
  assert.equal(r6.source, 'file')
  assert.equal(r6.config.mode, 'local')
  rmSync(home, { recursive: true, force: true })
})

test('写配置权限 0600；maskApiKey 只露头 3 尾 4；apiKey 留空沿用', async () => {
  const home = tempDir()
  await writeMineruConfig({ ...MINERU_DEFAULTS, mode: 'local' }, home)
  const mode = statSync(mineruConfigPath(home)).mode & 0o777
  assert.equal(mode, 0o600)

  assert.equal(maskApiKey('short'), '••••')
  assert.equal(maskApiKey('sk-1234567890abcd'), 'sk-…abcd')

  const merged = mergeMineruBody(
    { ...MINERU_DEFAULTS, local: { ...MINERU_DEFAULTS.local, apiKey: 'existing-key' } },
    { mode: 'local', local: { baseUrl: 'http://127.0.0.1:8000', apiKey: '' } },
  )
  assert.equal(merged.local.apiKey, 'existing-key')
  assert.equal(merged.mode, 'local')
  rmSync(home, { recursive: true, force: true })
})

test('normalizeLocalBaseUrl：尾斜杠/带路径/非法值', () => {
  assert.equal(normalizeLocalBaseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
  assert.equal(normalizeLocalBaseUrl('http://127.0.0.1:8000/mineru/'), 'http://127.0.0.1:8000/mineru')
  assert.equal(normalizeLocalBaseUrl('not-a-url'), MINERU_DEFAULTS.local.baseUrl)
  assert.equal(normalizeLocalBaseUrl(''), MINERU_DEFAULTS.local.baseUrl)
})

test('testMineruLocal：不可达端口返回 ok=false', async () => {
  const r = await testMineruLocal('http://127.0.0.1:1', 500)
  assert.equal(r.ok, false)
})

// ── 4. 缓存来源判定与向后兼容（AC-C5..C9）───────────────────────────────

function makeRef(dir, name, txt, extra = {}) {
  const pdfPath = join(dir, `${name}.pdf`)
  writeFileSync(pdfPath, '%PDF-1.4\n%fake')
  writeFileSync(join(dir, `${name}.txt`), txt)
  if (extra.pages !== false) {
    writeFileSync(join(dir, `${name}.pages.json`), JSON.stringify(extra.pages || { pageCount: 1, pages: [{ page: 1, start: 0, end: txt.length }] }))
  }
  if (extra.transcript) {
    writeFileSync(join(dir, `${name}.transcript.json`), JSON.stringify(extra.transcript))
  }
  return resolvePaper(dir, { path: pdfPath })
}

const OFF = { config: MINERU_DEFAULTS, source: 'none' }

test('向后兼容：只有 .txt + .pages.json（无 transcript.json）→ legacy，auto 复用不重解析', async () => {
  const dir = tempDir()
  const txt = 'x'.repeat(1500)
  const ref = makeRef(dir, 'legacy', txt)
  const t = await transcribePaper(ref, { source: 'auto', mineru: OFF })
  assert.equal(t.source, 'cache')
  assert.equal(t.producer, 'legacy')
  assert.equal(t.backend, null)
  assert.equal(t.text, txt)
  assert.equal(readFileSync(ref.txtPath, 'utf8'), txt) // 未改写
  rmSync(dir, { recursive: true, force: true })
})

test('缓存命中：producer=mineru-local 且 source=mineru-local → 复用（mode=off 也命中）', async () => {
  const dir = tempDir()
  const txt = 'y'.repeat(1500)
  const ref = makeRef(dir, 'p', txt, {
    transcript: { v: 1, producer: 'mineru-local', text: { bytes: 1500, chars: 1500, pageCount: 1 }, engine: { backend: 'pipeline' } },
  })
  const t = await transcribePaper(ref, { source: 'mineru-local', mineru: OFF })
  assert.equal(t.source, 'cache')
  assert.equal(t.producer, 'mineru-local')
  assert.equal(t.backend, 'pipeline')
  rmSync(dir, { recursive: true, force: true })
})

test('来源不一致：producer=legacy 且 source=mineru-local → 重解析（不返回缓存）', async () => {
  const dir = tempDir()
  const txt = 'z'.repeat(1500)
  const ref = makeRef(dir, 'p', txt) // legacy
  // 指向不可达 MinerU：重解析会抛 MineruError，而不是返回缓存
  const cfg = { config: { ...MINERU_DEFAULTS, mode: 'local', local: { ...MINERU_DEFAULTS.local, baseUrl: 'http://127.0.0.1:1' } }, source: 'file' }
  await assert.rejects(() => transcribePaper(ref, { source: 'mineru-local', mineru: cfg }), MineruError)
  rmSync(dir, { recursive: true, force: true })
})

test('bytes 不一致 → 判定损坏并重解析（AC-C8）', async () => {
  const dir = tempDir()
  const txt = 'w'.repeat(1500)
  const ref = makeRef(dir, 'p', txt, {
    transcript: { v: 1, producer: 'mineru-local', text: { bytes: 9999, chars: 1500, pageCount: 1 }, engine: { backend: 'pipeline' } },
  })
  const cfg = { config: { ...MINERU_DEFAULTS, mode: 'local', local: { ...MINERU_DEFAULTS.local, baseUrl: 'http://127.0.0.1:1' } }, source: 'file' }
  await assert.rejects(() => transcribePaper(ref, { source: 'mineru-local', mineru: cfg }), MineruError)
  rmSync(dir, { recursive: true, force: true })
})

test('readTranscriptMeta：缺失 transcript.json 返回 null（上层归类 legacy）', async () => {
  const dir = tempDir()
  const ref = makeRef(dir, 'm', 'a'.repeat(1500))
  assert.equal(await readTranscriptMeta(ref), null)
  rmSync(dir, { recursive: true, force: true })
})

// ── 5. 本地 MinerU 客户端：异步轮询 202/200/409/404 + file_names 键（AC-B2..B5）──

test('parseLocalMineru：POST /tasks → 轮询 result，202→200，用 file_names[0] 当 results 键', async () => {
  const content = JSON.stringify([
    { type: 'text', text: 'locality keyword on page one', page_idx: 0 },
    { type: 'text', text: 'checkpoint keyword on page two', page_idx: 1 },
  ])
  let resultCalls = 0
  const { server, url } = await startServer(async (req, res) => {
    if (req.url === '/tasks' && req.method === 'POST') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['论文 测试 (v2)'] }))
      return
    }
    if (req.url === '/tasks/t1/result') {
      resultCalls++
      if (resultCalls === 1) {
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'processing', message: 'Task result is not ready yet' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ backend: 'pipeline', version: '3.4.5', results: { '论文 测试 (v2)': { md_content: '# md', content_list: content } } }))
      return
    }
    res.writeHead(404).end()
  })
  try {
    const r = await parseLocalMineru({
      baseUrl: url, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false,
      requestTimeoutMs: 5000, pollIntervalMs: 5, noResponseTimeoutMs: 5000, jobTimeoutMs: 5000,
      pdfBytes: new Uint8Array([1, 2, 3]), fileName: '论文 测试 (v2).pdf',
    })
    assert.equal(r.meta.kind, 'mineru-local')
    assert.equal(r.meta.backend, 'pipeline')
    assert.equal(r.markdown, '# md')
    assert.equal(r.blocks.length, 2)
    assert.equal(r.projection.pageCount, 2)
    assert.ok(r.meta.observedStatuses.includes('pending'))
    assert.ok(r.meta.observedStatuses.includes('processing'))
  } finally {
    server.close()
  }
})

test('parseLocalMineru：409 = 解析失败（不重试，不当作服务忙）', async () => {
  const { server, url } = await startServer(async (req, res) => {
    if (req.url === '/tasks') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['a'] }))
      return
    }
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Task execution failed', error: 'boom' }))
  })
  try {
    await assert.rejects(
      () => parseLocalMineru({ baseUrl: url, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false, requestTimeoutMs: 5000, pollIntervalMs: 5, noResponseTimeoutMs: 5000, jobTimeoutMs: 5000, pdfBytes: new Uint8Array([1]), fileName: 'a.pdf' }),
      (e) => e instanceof MineruError && e.status === 409,
    )
  } finally {
    server.close()
  }
})

test('parseLocalMineru：results 为空对象 → 抛可读错误', async () => {
  const { server, url } = await startServer(async (req, res) => {
    if (req.url === '/tasks') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['a'] }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ backend: 'pipeline', version: '3.4.5', results: {} }))
  })
  try {
    await assert.rejects(
      () => parseLocalMineru({ baseUrl: url, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false, requestTimeoutMs: 5000, pollIntervalMs: 5, noResponseTimeoutMs: 5000, jobTimeoutMs: 5000, pdfBytes: new Uint8Array([1]), fileName: 'a.pdf' }),
      (e) => e instanceof MineruError && /results/.test(e.message),
    )
  } finally {
    server.close()
  }
})

test('parseLocalMineru：任务丢失 404 → 可读错误', async () => {
  const { server, url } = await startServer(async (req, res) => {
    if (req.url === '/tasks') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['a'] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'Task not found' }))
  })
  try {
    await assert.rejects(
      () => parseLocalMineru({ baseUrl: url, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false, requestTimeoutMs: 5000, pollIntervalMs: 5, noResponseTimeoutMs: 5000, jobTimeoutMs: 5000, pdfBytes: new Uint8Array([1]), fileName: 'a.pdf' }),
      (e) => e instanceof MineruError && e.status === 404,
    )
  } finally {
    server.close()
  }
})

// ── 6. 云端 v4 请求序列（mock HTTP，AC-G1/G2/G4）──────────────────────────

test('parseCloudMineru：file-urls/batch → PUT(不带 Content-Type) → 轮询 → 下载 zip → 解 full.md/content_list', async () => {
  const seen = []
  const contentList = JSON.stringify([{ type: 'text', text: 'cloud keyword', page_idx: 0 }])
  const zip = makeZip([
    { name: 'paper/full.md', data: '# Cloud markdown', method: 8 },
    { name: 'paper/content_list.json', data: contentList, method: 0 },
  ])
  let pollCalls = 0
  const { server, port } = await startServer(async (req, res) => {
    const body = await readBody(req)
    seen.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body: body.toString('utf8') })
    if (req.url === '/file-urls/batch') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { batch_id: 'b1', file_urls: [`http://127.0.0.1:${port}/upload`] } }))
      return
    }
    if (req.url === '/upload' && req.method === 'PUT') {
      res.writeHead(200).end()
      return
    }
    if (req.url === '/extract-results/batch/b1') {
      pollCalls++
      if (pollCalls === 1) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { extract_result: [{ state: 'running' }] } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: `http://127.0.0.1:${port}/result.zip` }] } }))
      return
    }
    if (req.url === '/result.zip') {
      res.writeHead(200, { 'content-type': 'application/zip' })
      res.end(zip)
      return
    }
    res.writeHead(404).end()
  })
  try {
    const r = await parseCloudMineru({
      baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-cloud-token', modelVersion: 'pipeline', pollIntervalMs: 5, zipTimeoutMs: 5000,
      pdfBytes: new Uint8Array([1, 2, 3]), fileName: '论文 x.pdf',
    })
    assert.equal(r.meta.kind, 'mineru-cloud')
    assert.equal(r.meta.batchId, 'b1')
    assert.equal(r.markdown, '# Cloud markdown')
    assert.equal(r.blocks.length, 1)
    // PUT 不带 Content-Type（OSS 签名不含它，加了会 403）
    const put = seen.find((s) => s.method === 'PUT' && s.url === '/upload')
    assert.ok(put)
    assert.equal(put.contentType, undefined)
    // 上传文件名 ASCII 化
    const batch = seen.find((s) => s.url === '/file-urls/batch')
    assert.match(batch.body, /__ x\.pdf/)
  } finally {
    server.close()
  }
})

test('parseCloudMineru：batch 429 → 额度/限流错误', async () => {
  const { server, url } = await startServer(async (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, msg: 'rate limit exceeded' }))
  })
  try {
    await assert.rejects(
      () => parseCloudMineru({ baseUrl: url, apiKey: 'sk', modelVersion: 'pipeline', pollIntervalMs: 5, zipTimeoutMs: 5000, pdfBytes: new Uint8Array([1]), fileName: 'a.pdf' }),
      (e) => e instanceof MineruError && /额度|限流/.test(e.message),
    )
  } finally {
    server.close()
  }
})

test('parseCloudMineru：轮询 code=-60018（当日额度用尽）→ 致命错误', async () => {
  const { server, port } = await startServer(async (req, res) => {
    if (req.url === '/file-urls/batch') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { batch_id: 'b1', file_urls: [`http://127.0.0.1:${port}/upload`] } }))
      return
    }
    if (req.url === '/upload') { res.writeHead(200).end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: -60018, msg: 'quota' }))
  })
  try {
    await assert.rejects(
      () => parseCloudMineru({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk', modelVersion: 'pipeline', pollIntervalMs: 5, zipTimeoutMs: 5000, pdfBytes: new Uint8Array([1]), fileName: 'a.pdf' }),
      (e) => e instanceof MineruError && /额度/.test(e.message),
    )
  } finally {
    server.close()
  }
})

test('parseCloudMineru：轮询 state=failed → 可读错误', async () => {
  const { server, port } = await startServer(async (req, res) => {
    if (req.url === '/file-urls/batch') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { batch_id: 'b1', file_urls: [`http://127.0.0.1:${port}/upload`] } }))
      return
    }
    if (req.url === '/upload') { res.writeHead(200).end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { extract_result: [{ state: 'failed', err_msg: 'bad pdf' }] } }))
  })
  try {
    await assert.rejects(
      () => parseCloudMineru({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk', modelVersion: 'pipeline', pollIntervalMs: 5, zipTimeoutMs: 5000, pdfBytes: new Uint8Array([1]), fileName: 'a.pdf' }),
      (e) => e instanceof MineruError && /失败/.test(e.message),
    )
  } finally {
    server.close()
  }
})

// ── 6b. 失败信息不泄露 token（对抗性：服务端把 key 原样回显）──────────────

test('密钥不泄露：服务端把 token 回显在错误体里，报错文本必须已脱敏', async () => {
  const TOKEN = 'mineru-secret-TOKEN-XYZ123'
  // 云端：batch 接口 500 且把 token 原样回显
  const cloud = await startServer(async (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 500, msg: `upstream rejected Authorization: Bearer ${TOKEN} for key ${TOKEN}` }))
  })
  try {
    await assert.rejects(
      () => parseCloudMineru({ baseUrl: cloud.url, apiKey: TOKEN, modelVersion: 'pipeline', pollIntervalMs: 5, zipTimeoutMs: 5000, pdfBytes: new Uint8Array([1]), fileName: 'a.pdf' }),
      (e) => {
        assert.ok(e instanceof MineruError)
        assert.ok(!e.message.includes(TOKEN), `错误信息不得包含明文 token：${e.message}`)
        assert.match(e.message, /\[redacted\]/)
        return true
      },
    )
  } finally {
    cloud.server.close()
  }
  // 云端：轮询 state=failed 时服务端回显 token
  const cloud2 = await startServer(async (req, res) => {
    if (req.url === '/file-urls/batch') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { batch_id: 'b1', file_urls: [`http://127.0.0.1:${cloud2.port}/upload`] } }))
      return
    }
    if (req.url === '/upload') { res.writeHead(200).end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { extract_result: [{ state: 'failed', err_msg: `parse error, token=${TOKEN}` }] } }))
  })
  try {
    await assert.rejects(
      () => parseCloudMineru({ baseUrl: `http://127.0.0.1:${cloud2.port}`, apiKey: TOKEN, modelVersion: 'pipeline', pollIntervalMs: 5, zipTimeoutMs: 5000, pdfBytes: new Uint8Array([1]), fileName: 'a.pdf' }),
      (e) => {
        assert.ok(!e.message.includes(TOKEN), `错误信息不得包含明文 token：${e.message}`)
        return true
      },
    )
  } finally {
    cloud2.server.close()
  }
  // 本地：409 错误体回显本地 key
  const local = await startServer(async (req, res) => {
    if (req.url === '/tasks') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'completed', file_names: ['a'] }))
      return
    }
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: `task failed; api key was ${TOKEN}` }))
  })
  try {
    await assert.rejects(
      () => parseLocalMineru({
        baseUrl: local.url, apiKey: TOKEN, backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false,
        requestTimeoutMs: 5000, pollIntervalMs: 5, noResponseTimeoutMs: 5000, jobTimeoutMs: 5000,
        pdfBytes: new Uint8Array([1]), fileName: 'a.pdf',
      }),
      (e) => {
        assert.ok(e instanceof MineruError)
        assert.ok(!e.message.includes(TOKEN), `错误信息不得包含明文 token：${e.message}`)
        assert.match(e.message, /\[redacted\]/)
        return true
      },
    )
  } finally {
    local.server.close()
  }
})

// ── 6c. 富产物清理与失败不污染缓存（AC-C9 / AC-C4）───────────────────────

/** 零依赖 N 页 PDF（短行、正文 >1000 字符）——离线跑 pdfjs 路径用。 */
function buildPdf(pages) {
  const objs = []
  const pn = []
  objs[0] = null
  objs[1] = null
  const cn = []
  for (let i = 0; i < pages.length; i++) {
    pn.push(objs.length + 1); objs.push(null)
    cn.push(objs.length + 1); objs.push(null)
  }
  const fn = objs.length + 1
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const set = (n, b) => { objs[n - 1] = b }
  set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  set(2, `<< /Type /Pages /Kids [${pn.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  for (let i = 0; i < pages.length; i++) {
    set(pn[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${cn[i]} 0 R /Resources << /Font << /F1 ${fn} 0 R >> >> >>`)
    let s = ''
    let y = 740
    for (const [size, text] of pages[i]) {
      s += `BT /F1 ${size} Tf 72 ${y} Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET\n`
      y -= size + 14
    }
    set(cn[i], `<< /Length ${s.length} >>\nstream\n${s}endstream`)
  }
  let out = '%PDF-1.4\n'
  const off = []
  for (let i = 0; i < objs.length; i++) { off.push(out.length); out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n` }
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of off) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// 复用文件上方已声明的 OFF（{ config: MINERU_DEFAULTS, source: 'none' }）
//
// 每行必须带一个**字母**上的唯一标记：transcribe.ts 的页眉页脚启发式用
// norm()（剔掉数字与标点后小写）判断「同一行是否在页边缘反复出现」，
// 只靠编号区分的行（sentence number 0/1/2…）归一化后完全同形，会被整页剔除
// （真实 PDF 的行不会这样）。所以这里给每行嵌一个由下标派生的字母串。
const lineTag = (i) => Array.from({ length: 4 + (i % 4) }, (_, k) => String.fromCharCode(97 + ((i * 7 + k) % 26))).join('')
const pdfLines = (prefix, count) => Array.from({ length: count }, (_, i) => [12, `${prefix} sentence ${lineTag(i)} with enough extractable text to exceed the one thousand character threshold reliably.`])

test('AC-C9：非 MinerU 来源重写 .txt 成功后删除 MinerU 富产物（.mineru.md/.mineru.json）', async () => {
  const dir = tempDir()
  const pdfPath = join(dir, 'p.pdf')
  writeFileSync(pdfPath, buildPdf([
    [[22, 'Cleanup Fixture One'], ...pdfLines('Page one', 7)],
    [[20, 'Cleanup Fixture Two'], ...pdfLines('Page two', 8)],
  ]))
  const ref = resolvePaper(dir, { path: pdfPath })
  // 先摆一份「MinerU 产生的缓存」+ 富产物
  writeFileSync(ref.txtPath, 'x'.repeat(2000))
  writeFileSync(ref.pagesPath, JSON.stringify({ pageCount: 1, pages: [{ page: 1, start: 0, end: 2000 }] }))
  writeFileSync(ref.transcriptPath, JSON.stringify({ v: 1, producer: 'mineru-local', text: { bytes: 2000, chars: 2000, pageCount: 1 } }))
  writeFileSync(ref.mineruMdPath, '# fake mineru md')
  writeFileSync(ref.mineruJsonPath, JSON.stringify({ v: 1, contentList: [] }))

  const t = await transcribePaper(ref, { source: 'pdfjs', force: true, mineru: OFF })
  assert.equal(t.producer, 'pdfjs')
  assert.equal(t.source, 'local')
  assert.ok(t.chars > 1000)
  assert.equal(existsSync(ref.mineruMdPath), false, 'MinerU Md 富产物应被删除（避免与 .txt 不同源）')
  assert.equal(existsSync(ref.mineruJsonPath), false, 'MinerU content_list 富产物应被删除')
  assert.equal(JSON.parse(readFileSync(ref.transcriptPath, 'utf8')).producer, 'pdfjs')
  assert.equal(JSON.parse(readFileSync(ref.pagesPath, 'utf8')).pageCount, 2)
  rmSync(dir, { recursive: true, force: true })
})

test('AC-C4：MinerU 不可达 → 抛错且既有缓存与富产物字节级不变（不写半成品）', async () => {
  const dir = tempDir()
  const pdfPath = join(dir, 'p.pdf')
  // 注意形状：buildPdf 收的是「页数组的数组」，每页是 [size, text] 行数组
  writeFileSync(pdfPath, buildPdf([[ [18, 'Failure Fixture'], ...pdfLines('Only page', 12) ]]))
  const ref = resolvePaper(dir, { path: pdfPath })
  const cachedTxt = 'cached text '.repeat(150)
  writeFileSync(ref.txtPath, cachedTxt)
  writeFileSync(ref.pagesPath, JSON.stringify({ pageCount: 1, pages: [{ page: 1, start: 0, end: cachedTxt.length }] }))
  writeFileSync(ref.transcriptPath, JSON.stringify({ v: 1, producer: 'pdfjs', text: { bytes: Buffer.byteLength(cachedTxt, 'utf8'), chars: cachedTxt.length, pageCount: 1 } }))
  const before = readFileSync(ref.pagesPath, 'utf8')

  const dead = { config: { ...MINERU_DEFAULTS, mode: 'local', local: { ...MINERU_DEFAULTS.local, baseUrl: 'http://127.0.0.1:9', requestTimeoutMs: 3000 } }, source: 'file' }
  await assert.rejects(
    () => transcribePaper(ref, { source: 'mineru-local', force: true, mineru: dead }),
    (e) => e instanceof MineruError && /MinerU/.test(e.message),
  )
  assert.equal(readFileSync(ref.txtPath, 'utf8'), cachedTxt, '.txt 必须保持原样')
  assert.equal(readFileSync(ref.pagesPath, 'utf8'), before, '.pages.json 必须保持原样')
  assert.equal(existsSync(ref.mineruMdPath), false, '失败不得留下半成品富产物')
  assert.equal(existsSync(ref.mineruJsonPath), false, '失败不得留下半成品富产物')
  // 失败后仍能命中缓存（错误没有污染来源标记）
  const t = await transcribePaper(ref, { mineru: OFF })
  assert.equal(t.source, 'cache')
  assert.equal(t.producer, 'pdfjs')
  rmSync(dir, { recursive: true, force: true })
})

test('可超时：轮询到 jobTimeoutMs 上限即报超时（并说明 legacy 没有取消端点）', async () => {
  const { server, url } = await startServer(async (req, res) => {
    if (req.url === '/tasks') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['a'] }))
      return
    }
    // 一直「解析中」，永远不完成
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ task_id: 't1', status: 'processing' }))
  })
  try {
    await assert.rejects(
      () => parseLocalMineru({
        baseUrl: url, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false,
        requestTimeoutMs: 5000, pollIntervalMs: 20, noResponseTimeoutMs: 60000, jobTimeoutMs: 400,
        pdfBytes: new Uint8Array([1]), fileName: 'a.pdf',
      }),
      (e) => {
        assert.ok(e instanceof MineruError)
        assert.match(e.message, /超时/)
        // 本地 legacy API 没有取消端点，错误信息必须如实说明（§2.5 / 易踩坑 7）
        assert.match(e.message, /没有取消端点/)
        return true
      },
    )
  } finally {
    server.close()
  }
})

test('可中断：外部 AbortSignal 中止 → 抛「解析已取消」', async () => {
  const { server, url } = await startServer(async (req, res) => {
    if (req.url === '/tasks') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['a'] }))
      return
    }
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ task_id: 't1', status: 'processing' }))
  })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 60)
  try {
    await assert.rejects(
      () => parseLocalMineru({
        baseUrl: url, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false,
        requestTimeoutMs: 5000, pollIntervalMs: 300, noResponseTimeoutMs: 60000, jobTimeoutMs: 60000, signal: ac.signal,
        pdfBytes: new Uint8Array([1]), fileName: 'a.pdf',
      }),
      (e) => e instanceof MineruError && /已取消/.test(e.message),
    )
  } finally {
    server.close()
  }
})

// ── 8. t6 修复回归：F1（云端预检业务码）/ F4 / F6 / O2 / O3 / O4 / O7 ──────

test('F1：云端预检必须检查业务码——HTTP 200 + code=A0202/A0211 判 token 失效', async () => {
  const mockJson = (body, status = 200) => startServer(async (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  // token 失效码（大小写不敏感）→ ok=false 且给出 token 提示
  for (const code of ['A0202', 'A0211', 'a0202']) {
    const { server, url } = await mockJson({ code, msg: 'token error' })
    try {
      const r = await testMineruCloud(url, 'sk-bad-token')
      assert.equal(r.ok, false, `HTTP 200 + code=${code} 必须判失败（否则坏 token 假绿灯落盘）`)
      assert.match(String(r.detail), /token/)
      assert.match(String(r.detail), new RegExp(code.toUpperCase()))
    } finally { server.close() }
  }

  // 正常业务错误（预检打的就是不存在的批次）→ ok=true
  for (const body of [{ code: '-60012', msg: 'batch not found' }, { code: 0, data: null }, { msg: '批次不存在' }]) {
    const { server, url } = await mockJson(body)
    try {
      assert.equal((await testMineruCloud(url, 'sk-good')).ok, true, `应判成功：${JSON.stringify(body)}`)
    } finally { server.close() }
  }

  // 401/403 分支行为不变
  for (const status of [401, 403]) {
    const { server, url } = await mockJson({ detail: 'unauthorized' }, status)
    try {
      const r = await testMineruCloud(url, 'sk-bad')
      assert.equal(r.ok, false)
      assert.match(String(r.detail), new RegExp(`HTTP ${status}`))
    } finally { server.close() }
  }

  // 非 JSON 与空 key 仍然失败（原有判据不被削弱）
  const { server, url } = await startServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>proxy</html>')
  })
  try { assert.equal((await testMineruCloud(url, 'sk')).ok, false) } finally { server.close() }
  assert.equal((await testMineruCloud('http://127.0.0.1:9', '')).ok, false)
})

test('F4：md_content 正常但 content_list 缺失 → 报「未返回 content_list」而不是「过短」，且不写任何产物', async () => {
  const dir = tempDir()
  const pdfPath = join(dir, 'p.pdf')
  writeFileSync(pdfPath, buildPdf([[ [18, 'F4 Fixture'], ...pdfLines('Only page', 12) ]]))
  const ref = resolvePaper(dir, { path: pdfPath })
  const md = Array.from({ length: 20 }, (_, i) => `Markdown paragraph ${i} ${pdfLines('Md', 1)[0][1]}`).join('\n\n')
  const { server, url } = await startServer(async (req, res) => {
    if (req.url === '/tasks') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['a'] }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ backend: 'pipeline', version: '3.4.5', results: { a: { md_content: md, content_list: null } } }))
  })
  const cfg = { config: { ...MINERU_DEFAULTS, mode: 'local', local: { ...MINERU_DEFAULTS.local, baseUrl: url } }, source: 'file' }
  try {
    await assert.rejects(
      () => transcribePaper(ref, { source: 'mineru-local', mineru: cfg }),
      (e) => {
        assert.ok(e instanceof MineruError)
        assert.match(e.message, /content_list/)           // 说清是缺字段
        assert.ok(!/过短/.test(e.message), `不应把「缺 content_list」报成「过短」：${e.message}`)
        return true
      },
    )
    for (const p of [ref.txtPath, ref.pagesPath, ref.transcriptPath, ref.mineruMdPath, ref.mineruJsonPath]) {
      assert.equal(existsSync(p), false, `失败不得写产物：${p}`)
    }
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F6：atomicTempPath 带 pid + 随机后缀（唯一），且 MinerU 落盘后不留临时文件', async () => {
  const target = '/tmp/dpr-atomic-check.txt'
  const a = atomicTempPath(target)
  const b = atomicTempPath(target)
  assert.ok(a.startsWith(`${target}.tmp-${process.pid}-`), `临时名应含 pid：${a}`)
  assert.ok(b.startsWith(`${target}.tmp-${process.pid}-`), `临时名应含 pid：${b}`)
  assert.notEqual(a, b, '同一进程的两次调用必须不同名（否则并发写会互相覆盖）')
  assert.ok(a.length > `${target}.tmp-${process.pid}-`.length, '随机后缀不能为空')

  // 真实写盘路径：走 MinerU 落盘（5 次 atomicWrite）后目录里不能残留 *.tmp-*
  const dir = tempDir()
  const pdfPath = join(dir, 'p.pdf')
  writeFileSync(pdfPath, buildPdf([[ [18, 'F6 Fixture'], ...pdfLines('Only page', 12) ]]))
  const ref = resolvePaper(dir, { path: pdfPath })
  const longSentences = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} sentence ${tag}${i} with enough extractable text to exceed the one thousand character threshold reliably.`).join(' ')
  const contentList = JSON.stringify([
    { type: 'text', text: `Page one heading ${longSentences('alpha', 5)}`, page_idx: 0 },
    { type: 'text', text: longSentences('beta', 6), page_idx: 1 },
  ])
  const { server, url } = await startServer(async (req, res) => {
    if (req.url === '/tasks') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['a'] }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ backend: 'pipeline', version: '3.4.5', results: { a: { md_content: '# md\n\n' + longSentences('md', 10), content_list: contentList } } }))
  })
  const cfg = { config: { ...MINERU_DEFAULTS, mode: 'local', local: { ...MINERU_DEFAULTS.local, baseUrl: url } }, source: 'file' }
  try {
    const t = await transcribePaper(ref, { source: 'mineru-local', mineru: cfg })
    assert.equal(t.producer, 'mineru-local')
    assert.equal(t.pageCount, 2)
    const tmpLeftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(tmpLeftovers, [], `不能残留临时文件：${tmpLeftovers.join(', ')}`)
    for (const p of [ref.txtPath, ref.pagesPath, ref.transcriptPath, ref.mineruMdPath, ref.mineruJsonPath]) {
      assert.ok(existsSync(p), `产物应落盘：${p}`)
    }
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('O2/O3：mode=off 扫描件提示不再声称「尚未实现」并给出 MinerU 指引；ShortTextError.name 正确', async () => {
  const dir = tempDir()
  const pdfPath = join(dir, 'scan.pdf')
  // 文本层极少的 PDF → pdfjs 判为扫描件
  writeFileSync(pdfPath, buildPdf([[ [12, 'tiny text layer only'] ]]))
  const ref = resolvePaper(dir, { path: pdfPath })
  try {
    await assert.rejects(
      () => transcribePaper(ref, { source: 'pdfjs', mineru: OFF }),
      (e) => {
        assert.ok(e instanceof ShortTextError)
        assert.equal(e.name, 'ShortTextError', 'O3：name 必须是自身类名')
        assert.match(e.message, /扫描件/)
        assert.ok(!/尚未实现/.test(e.message), `O2：不应再声称「尚未实现」：${e.message}`)
        assert.match(e.message, /MinerU/)   // 给出可执行指引
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('O4/O7：Bearer 脱敏不吃相邻括号；短密钥按词边界脱敏且不误伤普通单词', async () => {
  const TOKEN_CHAR = '[A-Za-z0-9._~+/=@-]'
  /** 起一个本地 MinerU mock：/tasks 成功、result 恒 409 并回显给定 detail；返回抛出的错误消息。 */
  const messageOf = async (apiKey, detail) => {
    let msg = ''
    const { server, url } = await startServer(async (req, res) => {
      if (req.url === '/tasks') {
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ task_id: 't1', status: 'pending', file_names: ['a'] }))
        return
      }
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail }))
    })
    try {
      await parseLocalMineru({
        baseUrl: url, apiKey, backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false,
        requestTimeoutMs: 5000, pollIntervalMs: 5, noResponseTimeoutMs: 5000, jobTimeoutMs: 5000,
        pdfBytes: new Uint8Array([1]), fileName: 'a.pdf',
      }).then(() => { throw new Error('应当抛错') }, (e) => { msg = e instanceof Error ? e.message : String(e) })
    } finally {
      server.close()
    }
    return msg
  }


  // O4：服务端回显一个「不是本次 key」的 Bearer token（apiKey 为空 → 只能靠正则脱敏）
  const m1 = await messageOf('', 'upstream rejected (Bearer OTHERTOKEN123) for request 7')
  assert.ok(!m1.includes('OTHERTOKEN123'), `Bearer token 必须脱敏：${m1}`)
  assert.match(m1, /\(Bearer \[redacted\]\)/, `O4：相邻右括号必须保留：${m1}`)

  // O7：3 字符密钥作为独立词出现 → 脱敏
  const m2 = await messageOf('abc', 'key abc rejected')
  assert.ok(!new RegExp(`(?<!${TOKEN_CHAR})abc(?!${TOKEN_CHAR})`).test(m2), `短密钥不得泄露：${m2}`)
  assert.match(m2, /\[redacted\]/)

  // O7：短密钥不误伤包含它的普通单词（词边界才替换）
  const m3 = await messageOf('abc', 'token abcdefgh was fine')
  assert.match(m3, /abcdefgh/, `不得误伤普通单词：${m3}`)

  // O7：1 字符密钥同样按词边界处理
  const m4 = await messageOf('q', 'key q rejected; question stays')
  assert.ok(!/\bq\b/.test(m4), `1 字符密钥也不得泄露：${m4}`)
  assert.match(m4, /question/)

  // O7：长密钥（≥4 字符）仍走字面量全量替换——即使被拼进更长的串里也不泄露
  const m5 = await messageOf('LONGKEY-9876', 'echo xxLONGKEY-9876yy here')
  assert.ok(!m5.includes('LONGKEY-9876'), `长密钥不得泄露（含拼装形式）：${m5}`)
  assert.match(m5, /\[redacted\]/)
})

test('F-R2-1：云端预检非 JSON 分支必须脱敏——响应体回显 apiKey 时不得泄露（并保留诊断信息与截断长度）', async () => {
  const KEY = 'mineru-cloud-SECRET-ABCD1234'
  const html = '<!doctype html><html><body><h1>502 Bad Gateway</h1>'
    + `<p>upstream rejected Authorization: Bearer ${KEY}</p><p>debug dump: token=${KEY}</p></body></html>`
  const { server, url } = await startServer(async (_req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' })
    res.end(html)
  })
  try {
    const r = await testMineruCloud(url, KEY)
    assert.equal(r.ok, false, '非 JSON 仍判失败')
    assert.equal(r.detail.includes(KEY), false, `响应体回显的 apiKey 不得进入 detail：${r.detail}`)
    assert.match(r.detail, /响应不是 JSON/, '保留可读原因')
    assert.match(r.detail, /HTTP 502/, '保留 HTTP 状态码')
    assert.match(r.detail, /\[redacted\]/, '应有脱敏痕迹')
    assert.match(r.detail, /502 Bad Gateway/, '诊断所需的非敏感内容不得被吞掉')
  } finally {
    server.close()
  }

  // 截断长度不变：超长非 JSON 体只保留前 120 字符（脱敏后），更靠后的内容仍被截掉
  const tail = 'TAILMARKER-SHOULD-BE-CUT'
  const { server: s2, url: u2 } = await startServer(async (_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('X'.repeat(300) + tail)
  })
  try {
    const r2 = await testMineruCloud(u2, 'sk-good-key')
    assert.equal(r2.ok, false)
    assert.ok(r2.detail.includes('X'.repeat(120)), '前 120 字符应保留（截断长度不变）')
    assert.ok(!r2.detail.includes(tail), '超过 120 字符的内容仍应被截断')
  } finally {
    s2.close()
  }

  // 同文件第二处「响应体拼进错误」：testMineruLocal 的 !ok 分支（该处不发 apiKey，属统一模式加固）
  const { server: s3, url: u3 } = await startServer(async (_req, res) => {
    res.writeHead(500, { 'content-type': 'text/html' })
    res.end('<html><body>proxy error: Bearer LOCAL-ECHO-TOKEN-9999</body></html>')
  })
  try {
    const r3 = await testMineruLocal(u3, 2000)
    assert.equal(r3.ok, false)
    assert.equal(String(r3.detail).includes('LOCAL-ECHO-TOKEN-9999'), false, `本地预检错误也不得回显令牌：${r3.detail}`)
    assert.match(String(r3.detail), /HTTP 500/)
  } finally {
    s3.close()
  }

  // 变形回显也要堵住：URL 编码形式 / JSON 转义形式（评审第三轮会查这两个变形）
  const KEY_URL = 'a+b/c=1'
  const { server: s4, url: u4 } = await startServer(async (_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(`encoded echo: ${encodeURIComponent(KEY_URL)}`)
  })
  try {
    const r4 = await testMineruCloud(u4, KEY_URL)
    assert.equal(r4.detail.includes(encodeURIComponent(KEY_URL)), false, `URL 编码形式也不得泄露：${r4.detail}`)
    assert.equal(r4.detail.includes(KEY_URL), false, `原样形式也不得泄露：${r4.detail}`)
  } finally {
    s4.close()
  }

  const KEY_ESC = 'q"xyz'
  const jsonEscaped = KEY_ESC.replace(/[\\"]/g, (c) => `\\${c}`)
  const { server: s5, url: u5 } = await startServer(async (_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(`json echo: ${jsonEscaped}`)
  })
  try {
    const r5 = await testMineruCloud(u5, KEY_ESC)
    assert.equal(r5.detail.includes(jsonEscaped), false, `JSON 转义形式也不得泄露：${r5.detail}`)
  } finally {
    s5.close()
  }
})

// ── 7. 既有基线：chunkText / pageForOffset（AC-A3）────────────────────────

test('chunkText + pageForOffset 基线不回退', () => {
  const text = 'aa\n\nbb\n\ncc'
  const chunks = chunkText(text, 10)
  assert.ok(chunks.length >= 1)
  const pages = [{ page: 1, start: 0, end: 3 }, { page: 2, start: 3, end: text.length }]
  assert.equal(pageForOffset(pages, 1), 1)
  assert.equal(pageForOffset(pages, 5), 2)
  assert.equal(pageForOffset(null, 0), null)
})
