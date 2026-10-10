// test/mineru-verify.test.mjs — 独立验证者补充的复现测试（t3）。
//
// 与 t2 自带测试的区别（不是重复，而是补口子）：
//  1) 路由鉴权：t2 的 routes 测试注入的 requestRejection 恒为 undefined，
//     这里注入 401/403，断言 /api/mineru/* 与 /api/transcribe 真的被围栏拦住。
//  2) 页码映射：这里直接 fetch 真实 MinerU 的 /file_parse（不经过插件代码）拿 content_list，
//     自己推导 page_idx，再与插件产物对照 —— 独立信源交叉核对。
//  3) 云端序列：断言请求顺序与 PUT 不带 Content-Type（t2 的用例只断言最终产物）。
//  4) 投影规则：按 §7.4 表格的独立预期断言表格/公式/未知块/缺 page_idx。
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。
// 真实本地 MinerU 不可达时 live 用例自动 skip，整体仍 exit 0。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = (m) => join(ROOT, 'dist', m)

const HOME = mkdtempSync(join(tmpdir(), 'dpr-verify-home-'))
process.env.DSH_HOME = HOME

const mineru = await import(dist('mineru.js'))
const mcfg = await import(dist('mineru-config.js'))
const tscribe = await import(dist('transcribe.js'))
const library = await import(dist('library.js'))
const search = await import(dist('search.js'))

// ── 零依赖 2 页 PDF（每页 >1000 字符；每页唯一关键词）────────────────────
function buildPdf(pages) {
  const objects = []
  const pageObjNums = []
  objects[0] = null
  objects[1] = null
  const contentObjNums = []
  for (let i = 0; i < pages.length; i++) {
    const pn = objects.length + 1
    objects.push(null)
    pageObjNums.push(pn)
    const cn = objects.length + 1
    objects.push(null)
    contentObjNums.push(cn)
  }
  const fontNum = objects.length + 1
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const set = (n, b) => { objects[n - 1] = b }
  set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  set(2, `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  for (let i = 0; i < pages.length; i++) {
    set(pageObjNums[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNums[i]} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`)
    let s = ''
    let y = 740
    for (const [size, text] of pages[i]) {
      s += `BT /F1 ${size} Tf 72 ${y} Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET\n`
      y -= size + 14
    }
    set(contentObjNums[i], `<< /Length ${s.length} >>\nstream\n${s}endstream`)
  }
  let out = '%PDF-1.4\n'
  const off = []
  for (let i = 0; i < objects.length; i++) { off.push(out.length); out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const x = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of off) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const tag = (i) => Array.from({ length: 4 + (i % 4) }, (_, k) => String.fromCharCode(97 + ((i * 7 + k) % 26))).join('')
const filler = (prefix, n) => Array.from({ length: n }, (_, i) => [12, `${prefix} sentence ${tag(i)} with enough extractable text to exceed the one thousand character threshold reliably.`])
const PDF = buildPdf([
  [[22, 'Verify Fixture One'], ...filler('Page one', 9), [12, 'Page-one token alphamarker sits only on the first page.'], ...filler('Page one tail', 4)],
  [[20, 'Verify Fixture Two'], ...filler('Page two', 8), [12, 'Page-two token zetamarker42 sits only on the second page.'], [12, 'Page two also mentions backup task and checkpoint.'], ...filler('Page two tail', 5)],
])

// ── 最小 ZIP 构造（stored + deflate 两种）────────────────────────────────
function crc32(buf) {
  let c = ~0
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) }
  return ~c >>> 0
}
function zipEntries(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.from(data, 'utf8')
    const body = deflate ? deflateRawSync(raw) : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, body)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(deflate ? 8 : 0, 10)
    cd.writeUInt32LE(crc32(raw), 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))
    offset += 30 + nameBuf.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, eocd])
}

// ── 通用 mock 服务 ───────────────────────────────────────────────────────
function startServer(handler) {
  return new Promise((r) => { const srv = createServer(handler); srv.listen(0, '127.0.0.1', () => r(srv)) })
}
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))) })
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const localOpts = (port, extra = {}) => ({
  baseUrl: `http://127.0.0.1:${port}`, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto',
  serverUrl: '', langList: ['ch'], imageAnalysis: false, requestTimeoutMs: 3000, pollIntervalMs: 20, noResponseTimeoutMs: 4000, jobTimeoutMs: 8000,
  pdfBytes: PDF, fileName: 'fixture.pdf', ...extra,
})

// ── 1. 本地轮询：202 → 200（结果键用提交响应的 file_names[0]）────────────
test('verify: 本地轮询 202 未就绪 → 200 完成，results 键取提交响应的 file_names[0]', async () => {
  let polls = 0
  const srv = await startServer(async (req, res) => {
    if (req.method === 'POST') { await readBody(req); return json(res, 202, { task_id: 'v1', status: 'pending', file_names: ['server-stem'] }) }
    polls++
    if (polls < 2) return json(res, 202, { status: 'processing' })
    return json(res, 200, { backend: 'pipeline', version: '3.4.5', results: { 'server-stem': { md_content: '# md', content_list: JSON.stringify([{ type: 'text', text: 'x'.repeat(1200), page_idx: 0 }]) } } })
  })
  const r = await mineru.parseLocalMineru(localOpts(srv.address().port))
  assert.equal(r.markdown, '# md')
  assert.equal(r.projection.pages.length, 1)
  assert.deepEqual(r.meta.observedStatuses, ['pending', 'processing'])
  assert.equal(r.meta.serverVersion, '3.4.5')
  assert.equal(polls, 2)
  srv.close()
})

test('verify: result 404 → 可读错误；409 → 解析失败（不是服务忙）', async () => {
  const mk = (status) => startServer(async (req, res) => {
    if (req.method === 'POST') { await readBody(req); return json(res, 202, { task_id: 'v2', file_names: ['p'] }) }
    return json(res, status, { detail: 'boom' })
  })
  const s404 = await mk(404)
  await assert.rejects(() => mineru.parseLocalMineru(localOpts(s404.address().port)), /已丢失该任务|404/)
  s404.close()
  const s409 = await mk(409)
  await assert.rejects(() => mineru.parseLocalMineru(localOpts(s409.address().port)), /解析失败（HTTP 409）/)
  s409.close()
})

test('verify: 密钥脱敏 —— 服务端把 key 回显在 409/401 体里，错误信息不含明文', async () => {
  const SECRET = 'verify-secret-key-31337'
  const srv = await startServer(async (req, res) => {
    if (req.method === 'POST') { await readBody(req); return json(res, 401, { error: `bad token ${SECRET}` }) }
    return json(res, 409, { detail: `failed with ${SECRET}` })
  })
  const err = await mineru.parseLocalMineru(localOpts(srv.address().port, { apiKey: SECRET })).then(() => null, (e) => e)
  assert.ok(err, '应当抛错')
  assert.ok(!err.message.includes(SECRET), `错误信息泄露了明文 key: ${err.message}`)
  srv.close()
})

// ── 2. 云端 mock：请求序列 + PUT 不带 Content-Type ──────────────────────
test('verify: 云端 v4 序列（申请→PUT 无 Content-Type→轮询→下载 zip），产物解析正确', async () => {
  const order = []
  const md = '# cloud\n\n' + 'cloud paragraph text. '.repeat(60)
  const cl = JSON.stringify([{ type: 'text', text: 'cloud page one '.repeat(40), page_idx: 0 }, { type: 'text', text: 'cloud page two '.repeat(40), page_idx: 1 }])
  const zip = zipEntries([{ name: 'out/full.md', data: md }, { name: 'out/x_content_list.json', data: cl, deflate: true }])
  let polls = 0
  const srv = await startServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/v4/file-urls/batch') { order.push('batch'); await readBody(req); return json(res, 200, { code: 0, data: { batch_id: 'bv', file_urls: [`http://127.0.0.1:${srv.address().port}/up`] } }) }
    if (p === '/up') { order.push(`put:${req.headers['content-type'] ?? 'none'}`); await readBody(req); res.writeHead(200); return res.end('ok') }
    if (p === '/v4/extract-results/batch/bv') {
      polls++
      order.push('poll')
      return json(res, 200, polls < 2 ? { code: 0, data: { extract_result: [{ state: 'running' }] } } : { code: 0, data: { extract_result: [{ state: 'done', full_zip_url: `http://127.0.0.1:${srv.address().port}/z` }] } })
    }
    if (p === '/z') { order.push('zip'); res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(zip) }
    json(res, 404, { code: -1 })
  })
  const r = await mineru.parseCloudMineru({ baseUrl: `http://127.0.0.1:${srv.address().port}/v4`, apiKey: 'tok', modelVersion: 'pipeline', pollIntervalMs: 20, zipTimeoutMs: 3000, pdfBytes: PDF, fileName: 'x.pdf' })
  assert.deepEqual(order.slice(0, 3), ['batch', 'put:none', 'poll'])
  assert.ok(order.includes('zip'))
  assert.equal(r.meta.api, 'v4')
  assert.equal(r.meta.batchId, 'bv')
  assert.equal(r.markdown, md)
  assert.deepEqual(r.projection.pages.map((p) => p.page), [1, 2])
  srv.close()
})

test('verify: ZIP 读取器 —— stored 与 deflate 各一条，根目录/子目录都能按后缀取到', () => {
  const entries = mineru.extractZipEntries(zipEntries([
    { name: 'full.md', data: 'A'.repeat(100) },
    { name: 'nested/dir/content_list.json', data: '[]', deflate: true },
  ]))
  assert.equal(entries.length, 2)
  assert.equal(mineru.pickZipMarkdown(entries).name, 'full.md')
  assert.equal(mineru.pickZipContentList(entries).name, 'nested/dir/content_list.json')
  assert.equal(entries[1].data.toString('utf8'), '[]')
})

// ── 3. 投影规则（§7.4 的独立预期）───────────────────────────────────────
test('verify: 投影规则 —— 表格剥标签保 caption/footnote、公式保留、未知 type 兜底、缺 page_idx 归上一块', () => {
  const blocks = [
    { type: 'text', text: 'P1 heading', page_idx: 0 },
    { type: 'table', table_caption: ['表 1'], table_body: '<table><tr><td>a</td><td>b</td></tr></table>', table_footnote: ['注'], page_idx: 0 },
    { type: 'equation', text: 'E = mc^2', page_idx: 1 },
    { type: 'mystery_block', text: 'unknown text', page_idx: 1 },
    { type: 'mystery_empty', other: 1 },
    { type: 'text', text: 'missing idx' },
  ]
  const p = mineru.projectContentList(blocks)
  assert.deepEqual(p.pages.map((s) => s.page), [1, 2])
  const page1 = p.text.slice(p.pages[0].start, p.pages[0].end)
  assert.ok(page1.includes('表 1') && page1.includes('a b') && page1.includes('注'))
  assert.ok(!page1.includes('<td>'), 'HTML 标签应被剥掉')
  const page2 = p.text.slice(p.pages[1].start, p.pages[1].end)
  assert.ok(page2.includes('E = mc^2'))
  assert.ok(page2.includes('unknown text'))
  assert.ok(page2.includes('missing idx'))
  assert.ok(!page2.includes('mystery_empty'))
  assert.ok(p.warnings.some((w) => w.includes('page_idx')), JSON.stringify(p.warnings))
  // 页间恰好 2 字符间隙（与 pdfjs 路径同语义）
  assert.equal(p.pages[1].start - p.pages[0].end, 2)
})

// ── 4. 路由鉴权（t2 未覆盖的分支）──────────────────────────────────────
test('verify: /api/mineru/* 与 /api/transcribe 经过 connection.requestRejection（401/403 被拦）', async () => {
  const { registerRoutes } = await import(dist('host.js'))
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-verify-data-'))
  mkdirSync(join(DATA, 'demo'), { recursive: true })
  writeFileSync(join(DATA, 'demo', 'paper.pdf'), PDF)
  let rejection
  let spec = null
  const ctx = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => rejection },
    sessionController: {}, workspaceController: {}, workspaceRegistry: {},
    effect: (fn) => fn(),
  }
  registerRoutes(ctx, { dataDir: DATA })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${srv.address().port}/paper-reader`
  try {
    rejection = 401
    let r = await fetch(`${origin}/api/mineru/config`)
    assert.equal(r.status, 401)
    assert.equal((await r.json()).error, 'unauthorized')
    r = await fetch(`${origin}/api/mineru/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"off"}' })
    assert.equal(r.status, 401)
    rejection = 403
    r = await fetch(`${origin}/api/mineru/health`)
    assert.equal(r.status, 403)
    assert.equal((await r.json()).error, 'forbidden')
    r = await fetch(`${origin}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"topic":"demo","name":"paper"}' })
    assert.equal(r.status, 403)
    // 放行后能正常读配置
    rejection = undefined
    r = await fetch(`${origin}/api/mineru/config`)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).mode, 'off')
  } finally {
    srv.close()
    rmSync(DATA, { recursive: true, force: true })
  }
})

// ── 5. live：真实本地 MinerU 端到端 + 独立 curl 交叉核对页码 ─────────────
const BASE = 'http://127.0.0.1:8000'
const reach = await mcfg.testMineruLocal(BASE, 3000)
const skipLive = reach.ok ? false : 'local MinerU not reachable at 127.0.0.1:8000'

test('verify(live): transcribePaper 端到端，pages.json 为 1/2 页且每页切片自洽，元数据与 /health 一致', { skip: skipLive }, async () => {
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-verify-live-'))
  mkdirSync(join(DATA, 'demo'), { recursive: true })
  writeFileSync(join(DATA, 'demo', 'paper.pdf'), PDF)
  const ref = library.resolvePaper(DATA, { topic: 'demo', name: 'paper' })
  const out = await tscribe.transcribePaper(ref, {
    source: 'mineru-local', force: true,
    mineru: { config: { ...mcfg.MINERU_DEFAULTS, mode: 'local' }, source: 'file' },
  })
  assert.equal(out.producer, 'mineru-local')
  assert.equal(out.backend, 'pipeline')
  assert.ok(out.chars > 1000)
  const txt = readFileSync(ref.txtPath, 'utf8')
  const pagesJson = JSON.parse(readFileSync(ref.pagesPath, 'utf8'))
  assert.deepEqual(pagesJson.pages.map((s) => s.page), [1, 2])
  assert.equal(pagesJson.pageCount, 2)
  assert.ok(txt.length > 0)
  for (const s of pagesJson.pages) {
    assert.ok(s.end > s.start, `span 必须非空: ${JSON.stringify(s)}`)
    assert.ok(txt.slice(s.start, s.end).length > 0)
  }
  assert.ok(existsSync(ref.mineruMdPath) && existsSync(ref.mineruJsonPath))
  const meta = JSON.parse(readFileSync(ref.transcriptPath, 'utf8'))
  assert.equal(meta.producer, 'mineru-local')
  const health = await (await fetch(`${BASE}/health`)).json()
  assert.equal(meta.engine.serverVersion, health.version)
  assert.equal(meta.engine.backend, 'pipeline')
  assert.equal(meta.text.bytes, Buffer.byteLength(txt, 'utf8'))
  rmSync(DATA, { recursive: true, force: true })
})

test('verify(live): 页码映射用独立信源核对 —— 直接打 /file_parse 拿 content_list 自己推导 page_idx', { skip: skipLive }, async () => {
  // 1) 独立信源：不经过插件，直接 POST /file_parse
  const form = new FormData()
  form.append('files', new Blob([PDF], { type: 'application/pdf' }), 'fixture.pdf')
  form.append('return_md', 'true')
  form.append('return_content_list', 'true')
  form.append('backend', 'pipeline')
  form.append('lang_list', 'ch')
  const raw = await (await fetch(`${BASE}/file_parse`, { method: 'POST', body: form })).json()
  const key = raw.file_names[0]
  const blocks = JSON.parse(raw.results[key].content_list)
  const byPage = new Map()
  for (const b of blocks) {
    const t = typeof b.text === 'string' ? b.text : Array.isArray(b.list_items) ? b.list_items.join('\n') : ''
    if (!t.trim()) continue
    const arr = byPage.get(b.page_idx) ?? []
    arr.push(t)
    byPage.set(b.page_idx, arr)
  }
  const indepPage = (kw) => [...byPage.keys()].filter((idx) => byPage.get(idx).join('\n\n').includes(kw)).map((idx) => idx + 1)

  // 2) 插件产物
  const DATA = mkdtempSync(join(tmpdir(), 'dpr-verify-map-'))
  mkdirSync(join(DATA, 'demo'), { recursive: true })
  writeFileSync(join(DATA, 'demo', 'paper.pdf'), PDF)
  const ref = library.resolvePaper(DATA, { topic: 'demo', name: 'paper' })
  await tscribe.transcribePaper(ref, { source: 'mineru-local', force: true, mineru: { config: { ...mcfg.MINERU_DEFAULTS, mode: 'local' }, source: 'file' } })
  const txt = readFileSync(ref.txtPath, 'utf8')
  const pages = JSON.parse(readFileSync(ref.pagesPath, 'utf8')).pages
  const spanPage = (pos) => pages.find((s) => pos >= s.start && pos < s.end)?.page ?? null

  const cases = [
    ['alphamarker', 1],
    ['zetamarker42', 2],
    ['backup task', 2],
    ['checkpoint', 2],
  ]
  for (const [kw, expected] of cases) {
    assert.deepEqual(indepPage(kw), [expected], `独立 content_list 推导 ${kw} 应在第 ${expected} 页`)
    const pos = txt.indexOf(kw)
    assert.ok(pos >= 0, `插件 .txt 应包含 ${kw}`)
    assert.equal(spanPage(pos), expected, `插件 span 映射 ${kw} 应为第 ${expected} 页`)
    assert.equal(search.pageForOffset(pages, pos), expected, `pageForOffset(${kw}) 应为第 ${expected} 页`)
  }
  rmSync(DATA, { recursive: true, force: true })
})

test.after(() => { rmSync(HOME, { recursive: true, force: true }) })
