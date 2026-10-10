// test/mineru-live.test.mjs — 真实本地 MinerU 集成测试（127.0.0.1:8000）。
// /health 不可达时整组 skip 且 exit 0；不并行打多个任务（服务端 max_concurrent_requests=3）。
// 只 import dist/*.js，跑前先 `npm run build`。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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

const { parseLocalMineru, parseLocalMineruSync } = mineru
const { testMineruLocal, MINERU_DEFAULTS } = mcfg
const { transcribePaper, readPages } = tscribe
const { resolvePaper } = library
const { pageForOffset } = search

const BASE = 'http://127.0.0.1:8000'

// 端口预检：不可达则所有 live 用例 skip（exit 0）。
let reachable = false
try {
  reachable = (await testMineruLocal(BASE, 2000)).ok
} catch { reachable = false }
const skipMsg = reachable ? false : 'local MinerU not reachable at 127.0.0.1:8000'

// 零依赖 N 页文本 PDF 生成器（照 .probe/gen.mjs 思路，正文加长到 ≥1000 字符）。
function buildPdf(pages) {
  const objects = []
  const pageObjNums = []
  objects[0] = null
  objects[1] = null
  const contentObjNums = []
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(objects.length + 1); objects.push(null)
    contentObjNums.push(objects.length + 1); objects.push(null)
  }
  const fontNum = objects.length + 1
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const set = (n, body) => { objects[n - 1] = body }
  set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  set(2, `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  for (let i = 0; i < pages.length; i++) {
    set(pageObjNums[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNums[i]} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`)
    let s = ''
    let y = 720
    for (const [size, text] of pages[i]) {
      s += `BT /F1 ${size} Tf 72 ${y} Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET\n`
      y -= size + 14
    }
    set(contentObjNums[i], `<< /Length ${s.length} >>\nstream\n${s}endstream`)
  }
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefPos = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function longLines(prefix, count) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push([12, `${prefix} sentence number ${i} with enough extractable text to exceed the one thousand character threshold reliably.`])
  }
  return out
}

const PAGE2_KEYWORD = 'zetamarker42'
const page1 = [
  [22, 'MinerU Live Integration Fixture'],
  ...longLines('Page one', 10),
]
const page2 = [
  [20, 'Second Page Heading'],
  [12, `This is page two with keyword ${PAGE2_KEYWORD} on it.`],
  ...longLines('Page two', 9),
]
const pdfBytes = buildPdf([page1, page2])

test('live: /health 预检可用（status=healthy，version 为字符串）', { skip: skipMsg }, async () => {
  const r = await testMineruLocal(BASE, 5000)
  assert.equal(r.ok, true)
  assert.equal(typeof r.version, 'string')
})

test('live: 异步链路 POST /tasks → 轮询 → result（content_list 是字符串，parse 后为数组）', { skip: skipMsg }, async () => {
  const r = await parseLocalMineru({
    baseUrl: BASE, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false,
    requestTimeoutMs: 60000, pollIntervalMs: 1000, noResponseTimeoutMs: 120000, jobTimeoutMs: 600000,
    pdfBytes, fileName: 'mineru-live-fixture.pdf',
  })
  assert.equal(r.meta.kind, 'mineru-local')
  assert.equal(r.meta.backend, 'pipeline')
  assert.ok(r.meta.observedStatuses.some((s) => s === 'pending' || s === 'processing'))
  assert.ok(Array.isArray(r.blocks))
  assert.ok(r.markdown.length > 0)
})

test('live: 同步 /file_parse 冒烟（md_content 字符串 + content_list 可 parse）', { skip: skipMsg }, async () => {
  const r = await parseLocalMineruSync({
    baseUrl: BASE, apiKey: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', serverUrl: '', langList: ['ch'], imageAnalysis: false,
    requestTimeoutMs: 60000, pollIntervalMs: 1000, noResponseTimeoutMs: 120000, jobTimeoutMs: 600000,
    pdfBytes, fileName: 'mineru-live-fixture.pdf',
  })
  assert.equal(typeof r.markdown, 'string')
  assert.ok(r.blocks.length >= 1)
})

test('live: transcribePaper(mode=local) 落盘缓存 + 页码映射（第 2 页关键词 → page 2）', { skip: skipMsg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-mineru-live-'))
  const pdfPath = join(dir, 'fixture.pdf')
  writeFileSync(pdfPath, pdfBytes)
  const ref = resolvePaper(dir, { path: pdfPath })
  const cfg = { config: { ...MINERU_DEFAULTS, mode: 'local' }, source: 'none' }

  const t = await transcribePaper(ref, { source: 'auto', mineru: cfg })
  assert.equal(t.producer, 'mineru-local')
  assert.equal(t.source, 'mineru-local')
  assert.ok(t.chars >= 1000)

  // 产物齐全
  for (const suffix of ['.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json']) {
    const p = pdfPath.slice(0, -4) + suffix
    assert.ok(readFileSync(p).length > 0, `${suffix} 应落盘`)
  }

  // 页码映射：第 2 页关键词 → page 2（pageForOffset 直接消费 pages.json）
  const txt = readFileSync(ref.txtPath, 'utf8')
  const pages = await readPages(ref)
  assert.ok(pages && pages.length >= 2)
  const offset = txt.indexOf(PAGE2_KEYWORD)
  assert.ok(offset >= 0, '第 2 页关键词应出现在转录文本中')
  assert.equal(pageForOffset(pages, offset), 2)

  // .transcript.json 来源标记
  const meta = JSON.parse(readFileSync(ref.transcriptPath, 'utf8'))
  assert.equal(meta.producer, 'mineru-local')
  assert.equal(meta.text.bytes, readFileSync(ref.txtPath).length)

  // .mineru.json 的 contentList 原样数组
  const mj = JSON.parse(readFileSync(ref.mineruJsonPath, 'utf8'))
  assert.ok(Array.isArray(mj.contentList))

  rmSync(dir, { recursive: true, force: true })
})
