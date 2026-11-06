// test/pdf-cache.test.mjs — PDF 传输缓存与阅读器文档生命周期（性能修复）。
//
// 守三件事：
//   1. /api/pdf 带 ETag/Last-Modified；客户端 If-None-Match 命中时 304，不再重传整份 PDF；
//      文件 mtime/size 变化（重新翻译）后 ETag 必须变化，不能回旧译文。
//   2. 阅读器 loadPdf 换文档时释放旧 PDFDocumentProxy；并发加载只允许最后一个生效，
//      晚到的旧请求必须自行 destroy（否则 worker/页面缓存泄漏，切换越用越卡）。
//   3. 原文/译文双视图缓存：预加载后切换不再 getDocument/不重画；切回原文恢复公式几何。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { readReaderScript } from './reader-script.mjs'

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

const SCRIPT = readReaderScript(join(REPO, 'reader', 'index.html')).script

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    dataset: {}, children: [], className: '', classes: new Set(),
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
  let innerHtml = ''
  Object.defineProperty(el, 'innerHTML', {
    get: () => innerHtml,
    set: (v) => { innerHtml = v; if (v === '') el.children = [] },
  })
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
      activateView, preloadView, resetViewCache, saveActiveView, attachView,
      getActiveKey: () => activeKey, getViewCache: () => viewCache, getViewDocs: () => viewDocs,
      setView: (v) => { viewMode = v }, setVariant: (v) => { zhVariant = v },
      setCurrent: (c) => { current = c }, setPageMode: (m) => { pageMode = m },
      setEq: (i) => { eqIndex = i }, renderAllPages, renderPaged, rerender,
      setZoom: (z) => { zoomScale = z }, setFit: (v) => { fitMode = v },
      getChildren: () => $('pdf-pages').children,
      getEqByPage: () => EQ_BY_PAGE,
      renderLazy, getLazyView: () => lazyView, ensureLazyPage,
    };`, ctx, { filename: 'reader-inline.js' })
  ctx.__t.setEnsure(async () => {})
  return { t: ctx.__t, doc, ctx }
}

function stubDoc(name, log, pages = 2) {
  return {
    numPages: pages,
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
  const { t: T } = loadReaderWithDocs(({ url }) => ({ promise: Promise.resolve(docs[url]), destroy: async () => log.push('task-destroy:' + url) }))
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
  const { t: T } = loadReaderWithDocs(getDocument)
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

/* ══════════ 阅读器：双视图缓存 / 无缝切换 ══════════ */

function prepReader(getDocument, docs) {
  const r = loadReaderWithDocs(getDocument)
  const { t: T, doc } = r
  doc.getElementById('pdf-pane').clientHeight = 800
  doc.getElementById('pdf-pane').clientWidth = 1000
  doc.getElementById('pdf-pane-zh').clientHeight = 800
  doc.getElementById('pdf-pane-zh').clientWidth = 1000
  T.setEnsure(async () => {})
  T.setCurrent({ topic: 't', name: 'p' })
  T.setVariant(null)
  T.setView('orig')
  T.setPageMode('scroll')
  T.setFit(false)
  T.setZoom(1)
  T.setEq({ source: 'none', reason: null, bboxSpace: 'normalized-1000', equations: [] })
  T.setPdfDoc(docs.orig)
  return r
}

test('V1 预加载译文后切换：不重新 getDocument/不重画，节点原样换入', async () => {
  const log = []
  const docs = { orig: stubDoc('orig', log), zh: stubDoc('zh', log) }
  let loads = 0
  const getDocument = ({ url }) => {
    loads++
    const key = String(url).includes('variant=zh') ? 'zh' : 'orig'
    return { promise: Promise.resolve(docs[key]), destroy: async () => log.push('task-destroy:' + key) }
  }
  const { t: T } = prepReader(getDocument, docs)
  T.setEq({
    source: 'mineru-local', reason: null, bboxSpace: 'normalized-1000',
    equations: [{ id: 'e1', index: 1, page: 1, latex: '\\alpha', bbox: [10, 10, 50, 50] }],
  })
  T.setFit(false)
  await T.renderAllPages()          // 首帧原文
  const beforeNodes = T.getChildren().length
  assert.equal(beforeNodes, 2, '原文应渲染 2 页')
  assert.equal(T.getEqByPage().get(1)?.length, 1, '原文首帧应写入公式几何')
  await T.preloadView('zh')          // 空闲预渲染译文（此时原文仍是活动视图）
  assert.ok(T.getViewCache().has('zh'), '预加载完成后必须有 zh 缓存')
  assert.equal(loads, 1, '预加载只 getDocument 一次')
  assert.equal(T.getEqByPage().get(1)?.length, 1, '预渲染译文不得清掉原文列的公式几何')

  assert.equal(await T.activateView('zh'), true)
  assert.equal(T.getActiveKey(), 'zh')
  assert.equal(T.getPdfDoc(), docs.zh)
  assert.equal(T.getChildren().length, 2, '应换上预加载的 2 个页节点')
  assert.equal(loads, 1, '切换不得再 getDocument')
  assert.equal(T.getEqByPage().size, 0, '译文视图不得命中原文公式几何')

  assert.equal(await T.activateView('orig'), true)
  assert.equal(T.getActiveKey(), 'orig')
  assert.equal(T.getPdfDoc(), docs.orig)
  assert.equal(T.getChildren().length, beforeNodes, '切回原文必须恢复原节点')
  assert.equal(T.getEqByPage().get(1)?.length, 1, '切回原文必须恢复公式几何')
  assert.equal(loads, 1, '来回切换都不得重新加载')
})

test('V2 未预加载时首次切换加载并渲染；之后来回切换零加载', async () => {
  const log = []
  const docs = { orig: stubDoc('orig', log), zh: stubDoc('zh', log) }
  let loads = 0
  const getDocument = ({ url }) => {
    loads++
    const key = String(url).includes('variant=zh') ? 'zh' : 'orig'
    return { promise: Promise.resolve(docs[key]), destroy: async () => log.push('task-destroy:' + key) }
  }
  const { t: T } = prepReader(getDocument, docs)
  T.setFit(false)
  await T.renderAllPages()
  assert.equal(await T.activateView('zh'), true)
  assert.equal(loads, 1, '首次切译文只加载一次')
  assert.equal(T.getActiveKey(), 'zh')
  assert.equal(T.getChildren().length, 2)
  await T.activateView('orig')
  await T.activateView('zh')
  assert.equal(loads, 1, '缓存命中后不得重新加载')
})

test('V3 resetViewCache 只释放非活动文档（GC），活动文档留给 loadPdf/调用方', async () => {
  const log = []
  const docs = { orig: stubDoc('orig', log), zh: stubDoc('zh', log) }
  const getDocument = ({ url }) => {
    const key = String(url).includes('variant=zh') ? 'zh' : 'orig'
    return { promise: Promise.resolve(docs[key]), destroy: async () => log.push('destroy:' + key) }
  }
  const { t: T } = prepReader(getDocument, docs)
  T.setFit(false)
  await T.renderAllPages()
  await T.activateView('zh') // 保存 orig、加载 zh
  assert.equal(T.getActiveKey(), 'zh')
  await T.resetViewCache()
  assert.ok(log.includes('destroy:orig'), '非活动的原文文档必须被释放')
  assert.ok(!log.includes('destroy:zh'), '活动文档不得被 reset 误释放（由调用方负责）')
  assert.equal(T.getActiveKey(), 'zh', 'reset 只清缓存，不擅自改活动视图')
})

test('V4 长文档滚动模式懒渲染：只画当前页，进入视口补画，远离释放', async () => {
  const log = []
  const docs = { orig: stubDoc('orig', log, 16), zh: stubDoc('zh', log, 16) }
  const r = prepReader(({ url }) => ({ promise: Promise.resolve(String(url).includes('variant=zh') ? docs.zh : docs.orig), destroy: async () => {} }), docs)
  const { t: T, ctx } = r
  ctx.IntersectionObserver = class {
    constructor(fn) { (ctx.__ios ||= []).push(fn) }
    observe() {} unobserve() {} disconnect() {}
  }
  T.setFit(false)
  T.setZoom(1)
  await T.renderLazy()
  const lv = T.getLazyView()
  assert.ok(lv, '必须建立懒视图')
  assert.equal(lv.pages.size, 16, '所有页都应有占位节点')
  const kids = T.getChildren()
  assert.equal(kids.length, 16)
  assert.ok(kids[0].children.length > 0, '当前页必须已画')
  assert.equal(kids[1].children.length, 0, '视口外页面保持占位（不铺 canvas/TextLayer）')
  assert.equal(kids[1].dataset.rendered, '0')

  // 模拟第 2 页进入视口：补画（第 0 个 observer 是懒渲染的，第 1 个是当前页探测）
  ctx.__ios[0]([{ target: kids[1], isIntersecting: true, intersectionRatio: 1 }])
  for (let i = 0; i < 20 && kids[1].children.length === 0; i++) await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 10)) // 等 paintPage 收尾（painting 标记清除）
  assert.ok(kids[1].children.length > 0, '进入视口后必须补画该页')
  assert.equal(kids[1].dataset.rendered, '1')

  // 模拟第 2 页远离视口：释放 canvas/TextLayer，恢复占位
  ctx.__ios[0]([{ target: kids[1], isIntersecting: false, intersectionRatio: 0 }])
  assert.equal(kids[1].children.length, 0, '远离视口后必须释放该页')
  assert.equal(kids[1].dataset.rendered, '0')
})

test('V5 懒渲染视图也能进双视图缓存：预加载/切回不重新加载，目标页已画', async () => {
  const log = []
  const docs = { orig: stubDoc('orig', log, 16), zh: stubDoc('zh', log, 16) }
  let loads = 0
  const r = prepReader(({ url }) => {
    loads++
    return { promise: Promise.resolve(String(url).includes('variant=zh') ? docs.zh : docs.orig), destroy: async () => {} }
  }, docs)
  const { t: T, ctx } = r
  ctx.IntersectionObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} }
  T.setFit(false)
  T.setZoom(1)
  await T.renderLazy()
  T.saveActiveView()
  await T.preloadView('zh')
  assert.ok(T.getViewCache().has('zh'))
  assert.equal(loads, 1)
  assert.equal(await T.activateView('zh'), true)
  assert.equal(T.getActiveKey(), 'zh')
  assert.equal(T.getChildren().length, 16)
  assert.ok(T.getChildren()[0].children.length > 0, '缓存里的当前页必须已画')
  assert.equal(loads, 1, '切译文不得重新 getDocument')
  assert.equal(await T.activateView('orig'), true)
  assert.equal(T.getActiveKey(), 'orig')
  assert.equal(T.getChildren().length, 16)
  assert.ok(T.getChildren()[0].children.length > 0, '切回原文当前页必须已画')
  assert.equal(loads, 1)
})

/* V6 回归：空闲译文预取用的是隐藏容器，但 renderLazy/teardownLazy 操作的是全局 lazyView。
   修前 preloadView 的 finally 无条件 teardownLazy()，把可见原文视图的懒渲染器拆掉且不重建，
   于是长文档（≥ LAZY_MIN_PAGES）滚动模式滚过首屏后永远停在空白等高占位 —— 真机实测复现。 */
test('V6 空闲译文预取不得拆掉可见视图的懒渲染器（长文档滚过首屏仍能补画）', async () => {
  const log = []
  const docs = { orig: stubDoc('orig', log, 16), zh: stubDoc('zh', log, 16) }
  const r = prepReader(({ url }) => ({
    promise: Promise.resolve(String(url).includes('variant=zh') ? docs.zh : docs.orig),
    destroy: async () => {},
  }), docs)
  const { t: T, ctx } = r
  const ios = (ctx.__ios = [])
  ctx.IntersectionObserver = class {
    constructor(fn) { ios.push(fn) }
    observe() {} unobserve() {} disconnect() {}
  }
  T.setFit(false)
  T.setZoom(1)
  await T.renderLazy()
  const before = T.getLazyView()
  assert.ok(before, '先要有可见视图的懒渲染器')

  await T.preloadView('zh')

  const after = T.getLazyView()
  assert.ok(after, '预取结束后可见视图的懒渲染器必须还在（否则滚过首屏即空白）')
  assert.equal(after.container, before.container, '恢复的必须是可见容器，不是预取的隐藏容器')
  assert.equal(after.token, T.getRenderToken(), 'token 必须跟上 renderToken，否则 ensureLazyPage 全部早退')

  // 预取之后滚到远端页：仍必须能补画
  await T.ensureLazyPage(16)
  const kids = T.getChildren()
  assert.equal(kids.length, 16)
  assert.ok(kids[15].children.length > 0, '预取之后远端页仍必须能补画（这正是修前的空白页）')
})
