// test/pdf-cache.test.mjs — PDF 传输缓存与阅读器文档生命周期（性能修复第一批）。
//
// 守两件事：
//   1. /api/pdf 带 ETag/Last-Modified；客户端 If-None-Match 命中时 304，不再重传整份 PDF；
//      文件 mtime/size 变化（重新翻译）后 ETag 必须变化，不能回旧译文。
//   2. 阅读器 loadPdf 换文档时释放旧 PDFDocumentProxy；并发加载只允许最后一个生效，
//      晚到的旧请求必须自行 destroy（否则 worker/页面缓存泄漏，切换越用越卡）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = (m) => join(REPO, 'dist', m)

async function bootRoutes(dataDir) {
  let spec = null
  const ctx = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }
  const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)
  registerRoutes(ctx, { dataDir })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  srv.unref?.()
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

test('H1 /api/pdf：ETag 命中 304；文件变化后 ETag 变化；download 头保留', async (t) => {
  const D = mkdtempSync(join(tmpdir(), 'dpr-pdf-cache-'))
  t.after(() => rmSync(D, { recursive: true, force: true }))
  mkdirSync(join(D, 'lib'), { recursive: true })
  const pdf = join(D, 'lib', 'paper.pdf')
  writeFileSync(pdf, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
  const zh = join(D, 'lib', 'paper-zh.pdf')
  writeFileSync(zh, '%PDF-1.4\nzh\n%%EOF\n')

  const { base, close } = await bootRoutes(D)
  t.after(close)
  const url = base + '/paper-reader/api/pdf?topic=lib&name=paper'

  const first = await fetch(url)
  assert.equal(first.status, 200)
  const etag = first.headers.get('etag')
  assert.ok(etag && /^".+"$/.test(etag), `必须返回强 ETag：${etag}`)
  assert.match(first.headers.get('cache-control') || '', /must-revalidate/, '缓存必须可复用但每次校验')
  assert.ok(first.headers.get('last-modified'), '必须带 Last-Modified')
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), readFileSync(pdf))

  // 条件请求：304、无 body
  const again = await fetch(url, { headers: { 'if-none-match': etag } })
  assert.equal(again.status, 304, 'If-None-Match 命中必须 304')
  assert.equal((await again.arrayBuffer()).byteLength, 0, '304 不得带 body')

  // 变体：-zh.pdf 同样带 ETag
  const zhRes = await fetch(url + '&variant=zh')
  assert.equal(zhRes.status, 200)
  assert.ok(zhRes.headers.get('etag'))

  // 文件变化（重新翻译）→ ETag 必须变化，旧 ETag 不能再 304
  const future = new Date(Date.now() + 5000)
  writeFileSync(pdf, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n% changed\n%%EOF\n')
  utimesSync(pdf, future, future)
  const changed = await fetch(url)
  assert.equal(changed.status, 200)
  const etag2 = changed.headers.get('etag')
  assert.notEqual(etag2, etag, 'mtime/size 变化后 ETag 必须变化')
  const stale = await fetch(url, { headers: { 'if-none-match': etag } })
  assert.equal(stale.status, 200, '旧 ETag 不得命中新文件')

  // download=1 仍要 attachment 头
  const dl = await fetch(url + '&download=1')
  assert.equal(dl.status, 200)
  assert.match(dl.headers.get('content-disposition') || '', /attachment/)
})

/* ══════════ 阅读器：loadPdf 的 GC / 并发顺序 ══════════ */

const SCRIPT = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')
  .replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  .match(/<script>\n([\s\S]*)\n<\/script>/)[1]

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], className: '', classes: new Set(),
    textContent: '', value: '', innerHTML: '',
    classList: {
      add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !el.classes.has(c) : on) el.classes.add(c); else el.classes.delete(c) },
      contains: (c) => el.classes.has(c),
    },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c },
    append(...cs) { cs.forEach((c) => el.appendChild(c)) },
    remove() {}, closest() { return null }, focus() {}, select() {}, click() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    contains() { return false }, scrollIntoView() {}, getContext() { return {} }, setAttribute() {},
  }
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null })
  Object.defineProperty(el, 'lastChild', { get: () => el.children[el.children.length - 1] ?? null })
  return el
}

function loadReaderWithDocs(getDocument) {
  const els = new Map()
  const doc = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id) },
    createElement(tag) { return makeEl(tag) }, querySelector() { return null }, querySelectorAll() { return [] },
    body: makeEl(), addEventListener() {}, removeEventListener() {}, documentElement: makeEl(),
  }
  const win = {
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900,
    addEventListener() {}, getSelection: () => null,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  const ctx = {
    document: doc, window: win, navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '' }, matchMedia: win.matchMedia,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    console, URLSearchParams, fetch: () => Promise.reject(new Error('no network in test')),
    Promise, Math, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Date, Set, Map,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } },
    pdfjsLib: { TextLayer: class { async render() {} }, GlobalWorkerOptions: {}, getDocument },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(SCRIPT + `
    ;globalThis.__t = {
      loadPdf, setEnsure: (f) => { ensurePdfjs = f },
      setPdfDoc: (d) => { pdfDoc = d }, getPdfDoc: () => pdfDoc,
      getFindDoc: () => find.doc, destroyPdfDoc,
      getLoadSeq: () => pdfLoadSeq, getRenderToken: () => renderToken,
    };`, ctx, { filename: 'reader-inline.js' })
  ctx.__t.setEnsure(async () => {})
  return ctx.__t
}

function stubDoc(name, log) {
  return {
    numPages: 2,
    destroy: async () => { log.push('destroy:' + name) },
    getPage: async () => ({
      getViewport: ({ scale }) => ({ width: 100 * scale, height: 100 * scale, scale }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: async () => ({ items: [] }),
    }),
  }
}

test('R1 loadPdf 换文档时释放旧 PDFDocumentProxy（GC）', async () => {
  const log = []
  const docs = { u1: stubDoc('d1', log), u2: stubDoc('d2', log) }
  const T = loadReaderWithDocs(({ url }) => ({ promise: Promise.resolve(docs[url]), destroy: async () => log.push('task-destroy:' + url) }))
  T.setPdfDoc(null)
  assert.equal(await T.loadPdf('u1', { deferRender: true }), true)
  assert.equal(T.getPdfDoc(), docs.u1)
  assert.equal(await T.loadPdf('u2', { deferRender: true }), true)
  assert.equal(T.getPdfDoc(), docs.u2, '新文档必须生效')
  assert.notEqual(T.getFindDoc(), docs.u1, 'find 索引不得继续指向已释放的旧文档')
  assert.deepEqual(log, ['destroy:d1'], '旧文档必须被 destroy，且只 destroy 一次')
})

test('R2 loadPdf 并发：晚到的旧请求自行销毁，不覆盖新文档', async () => {
  const log = []
  const resolvers = {}
  const docs = { a: stubDoc('a', log), b: stubDoc('b', log) }
  const getDocument = ({ url }) => {
    let resolve
    const promise = new Promise((r) => { resolve = r })
    resolvers[url] = resolve
    return { promise, destroy: async () => log.push('task-destroy:' + url) }
  }
  const T = loadReaderWithDocs(getDocument)
  T.setPdfDoc(null)
  const pa = T.loadPdf('a', { deferRender: true })
  const pb = T.loadPdf('b', { deferRender: true })
  for (let i = 0; i < 20 && (!resolvers.a || !resolvers.b); i++) await new Promise((r) => setTimeout(r, 0))
  // 后发的 b 先完成，a 晚到
  resolvers.b(docs.b)
  assert.equal(await pb, true)
  resolvers.a(docs.a)
  assert.equal(await pa, false, '晚到的旧请求必须返回 false')
  assert.equal(T.getPdfDoc(), docs.b, '旧文档不得覆盖新文档')
  assert.ok(log.includes('task-destroy:a'), '晚到的旧任务必须自行 destroy')
  assert.ok(!log.includes('destroy:b'), '当前文档不得被旧请求误释放')
})
