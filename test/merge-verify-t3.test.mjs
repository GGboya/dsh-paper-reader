// test/merge-verify-t3.test.mjs — t3「独立验证」的复现用例：**翻页模式 × 公式热区**（全新渲染路径）
//
// 为什么单独一份、而不并入既有用例（方法独立性）：
//   既有 reader-ux 系列与实现方 t2 的用例都用**手写 viewport stub**（{width:612*scale}）。
//   本文件用**真实 pdf.js（pdfjs-dist，项目依赖）**对真实形状的 PDF 页调用 getViewport({scale})，
//   期望矩形由本文件**独立复算**（bbox/1000 × viewport），再用「DOM 上真实落下去的 .eq-box 的几何中心」
//   反查 hitTestFormula 闭环。bbox/LaTeX 夹具逐字取自真实 MinerU 产物（见 FIXTURE 里的 sha256/来源）。
//
// 覆盖：
//   R1 翻页模式：① 热区层存在（结构）② bbox→viewport 独立复算（scale 1.0 / 1.5）③ 中心自命中闭环
//   R2 换页清理：旧页几何与悬停态必须作废（防命中整体偏移）
//   R3 切回滚动模式：全量页、每页一层、`paged` 类摘除、几何与命中仍正确
//   R4 划词 vs 点击（两种模式）：热区**内部**起手拖选 → 引用文字；零位移点击 → 引用 LaTeX（紧凑形）
//   R5 译文视图（-zh/-dual）在两种模式下关热区
//   R6 结构契约：pointer-events:none、唯一铺层点在 paintPage、DOM id 与脚本引用配对、热区层不是 textLayer 容器
//   R7 变异自检：R1/R2/R6 的断言对**注入缺陷**敏感（不是恒真断言）
//
// 只 import dist/*.js 与 reader/index.html；不写任何文献库文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeEol, extractModuleScript } from './reader-script.mjs'
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
// 行尾归一化后再取脚本：Windows 检出是 CRLF，按 LF 写死的正则会 `null[1]` 崩掉整个文件
// （main 的守卫 C4/C5 口径，见 test/reader-script.mjs）
const READER_HTML = normalizeEol(readFileSync(join(ROOT, '..', 'reader', 'index.html'), 'utf8'))
const SCRIPT_SRC = extractModuleScript(READER_HTML, { where: 'reader/index.html' })

const { buildFormulaIndex, compactLatex } = await import(pathToFileURL(dist('formulas.js')).href)

/* ── 夹具：真实 MinerU 产物的 equation（bbox + LaTeX 逐字），见 .probe/merge-verify/11-real-equation-fixture.json ── */
const FIXTURE = {
 "sha256": "30f78ea8d261cdc3a5ca5dff1869f3d2953e25c270de79b9a61beadeaccf3601",
 "source": "Hansen et al. - 2024 - TD-MPC2 ....mineru.json",
 "items": [
  {
   "type": "equation",
   "img_path": "images/47266377dfe59af4ed4c6da7e4e901ffa9b51199b56136712c3b5a2e59371cb0.jpg",
   "text": "$$\n\\pi ( \\mathbf { s } _ { t } ) = \\arg \\operatorname* { m a x } _ { \\mathbf { a } _ { t : t + H } } \\mathbb { E } \\left[ \\sum _ { i = 0 } ^ { H } \\gamma ^ { t + i } R ( \\mathbf { s } _ { t + i } , \\mathbf { a } _ { t + i } ) \\right] .\\tag{1}\n$$",
   "text_format": "latex",
   "bbox": [
    338,
    199,
    658,
    241
   ],
   "page_idx": 2
  },
  {
   "type": "equation",
   "img_path": "images/42d6609e0d01b036ebd315eae7e8819726b809fcb5f32f4fe77aaa5dde5bed56.jpg",
   "text": "$$\n{ \\begin{array} { r l l } { { \\mathrm { E n c o d e r } } } & { \\mathbf { z } = h ( \\mathbf { s } , \\mathbf { e } ) } & { { \\mathrm { : } } { \\mathrm { ~ N a p s ~ o b s e r v a t i o n s ~ t o ~ t h e i r ~ l a t e n t ~ r e p r e s e n t a t i o n s } } } \\\\ { { \\mathrm { L a t e n t ~ d y n a m i c s } } } & { \\mathbf { z } ^ { \\prime } = d ( \\mathbf { z } , \\mathbf { a } , \\mathbf { e } ) } & { { \\mathrm { : } } { \\mathrm { ~ N o d e l s ~ ( l a t e n t ) ~ f o r w a r d ~ d y n a m i c s } } } \\\\ { { \\mathrm { R e w a r d } } } & { \\hat { r } = R ( \\mathbf { z } , \\mathbf { a } , \\mathbf { e } ) } & { { \\mathrm { : } } { \\mathrm { ~ P r e d i c t s ~ r e w a r d ~ r ~ o f ~ a ~ t r a n s i t i o n } } } \\\\ { { \\mathrm { T e r m i n a l ~ v a l u e } } } & { { \\hat { q } } = Q ( \\mathbf { z } , \\mathbf { a } , \\mathbf { e } ) } & { { \\mathrm { : } } { \\mathrm { ~ P r e d i c t s ~ d i s c o u n t e d ~ s u m ~ o f ~ r e w a r d s ~ ( r e t u r n ) } } } \\\\ { { \\mathrm { P o l i c y ~ p r i o r } } } & { { \\hat { \\mathbf { a } } } = p ( \\mathbf { z } , \\mathbf { e } ) } & { { \\mathrm { : } } { \\mathrm { ~ P r e d i c t s ~ a c t i o n ~ a ^ * ~ t h a t ~ m a x i m i z e s ~ } } Q } \\end{array} }\\tag{2}\n$$",
   "text_format": "latex",
   "bbox": [
    199,
    820,
    776,
    893
   ],
   "page_idx": 2
  },
  {
   "type": "equation",
   "img_path": "images/f4fed7bc5e24dd5ed139eaa499b9fc64a06baa8b0cf8a3c13aa2f1f6d2a03953.jpg",
   "text": "$$\n\\mathcal { L } \\left( \\boldsymbol { \\theta } \\right) \\doteq \\underset { ( \\mathbf { s } , \\mathbf { a } , r , \\mathbf { s } ^ { \\prime } ) _ { 0 : \\boldsymbol { H } } \\sim \\mathcal { B } } { \\mathbb { E } } \\left[ \\sum _ { t = 0 } ^ { H } \\lambda ^ { t } \\left( \\underset { \\mathrm { J o i n : e n b e d d i n g ~ p r e d i c i o n } } { \\parallel \\mathbf { z } _ { t } ^ { \\prime } - \\mathbf { s g } ( h ( \\mathbf { s } _ { t } ^ { \\prime } ) ) \\parallel _ { 2 } ^ { 2 } } + \\underset { \\mathrm { R e w a r d ~ p r e d i c i o n } } { \\mathbf { C } \\mathbf { E } ( \\hat { r } _ { t } , r _ { t } ) } + \\underset { \\mathrm { V a l u e ~ p r e d i c i o n } } { \\mathbf { C } \\mathbf { E } ( \\hat { q } _ { t } , q _ { t } ) } \\right) \\right] ,\\tag{3}\n$$",
   "text_format": "latex",
   "bbox": [
    197,
    183,
    777,
    238
   ],
   "page_idx": 3
  },
  {
   "type": "equation",
   "img_path": "images/8a23051c5bc685d70aebd64306f89d8f4f619026f96d1400d1ea019eb88935ad.jpg",
   "text": "$$\n\\mathcal { L } _ { p } ( \\boldsymbol { \\theta } ) \\doteq \\underset { ( \\mathbf { s } , \\mathbf { a } ) _ { 0 } : \\boldsymbol { H } \\sim \\mathcal { B } } { \\mathbb { E } } \\left[ \\sum _ { t = 0 } ^ { H } \\lambda ^ { t } \\left[ \\alpha Q ( \\mathbf { z } _ { t } , p ( \\mathbf { z } _ { t } ) ) - \\beta \\mathcal { H } ( p ( \\cdot | \\mathbf { z } _ { t } ) ) \\right] \\right] , \\mathbf { z } _ { t + 1 } = d ( \\mathbf { z } _ { \\mathbf { t } } , \\mathbf { a } _ { \\mathbf { t } } ) , \\mathbf { z } _ { 0 } = h ( \\mathbf { s } _ { 0 } ) .\\tag{4}\n$$",
   "text_format": "latex",
   "bbox": [
    178,
    375,
    792,
    416
   ],
   "page_idx": 3
  },
  {
   "type": "equation",
   "img_path": "images/445530d5cea1a8a91f6b8f0eb78147adc06a5388afdfe9184b893f149a4c7986.jpg",
   "text": "$$\n\\mathbf { z } ^ { \\circ } \\doteq [ \\mathbf { g } _ { i } , \\ldots , \\mathbf { g } _ { L } ] , \\mathbf { g } _ { i } = \\frac { e ^ { \\mathbf { z } _ { i : i + V } / \\tau } } { \\sum _ { j = 1 } ^ { V } e ^ { \\mathbf { z } _ { i : i + V } / \\tau } } ,\\tag{5}\n$$",
   "text_format": "latex",
   "bbox": [
    352,
    636,
    642,
    672
   ],
   "page_idx": 3
  },
  {
   "type": "equation",
   "img_path": "images/6e1e76fe5f81e268b671e8e3ed411f5729c432838ff947f76294b4e8f4c2128c.jpg",
   "text": "$$\n\\mu ^ { * } , \\boldsymbol { \\sigma } ^ { * } = \\arg \\operatorname* { m a x } _ { ( \\mu , \\boldsymbol { \\sigma } ) } \\underset { ( \\mathbf { a } _ { t } , \\mathbf { a } _ { t + 1 } , \\ldots , \\mathbf { a } _ { t + H } ) \\sim \\mathcal { N } ( \\mu , \\boldsymbol { \\sigma } ^ { 2 } ) } { \\mathbb { E } } \\left[ \\gamma ^ { H } Q ( \\mathbf { z } _ { t + H } , \\mathbf { a } _ { t + H } ) + \\sum _ { h = t } ^ { H - 1 } \\gamma ^ { h } R ( \\mathbf { z } _ { h } , \\mathbf { a } _ { h } ) \\right] ,\\tag{6}\n$$",
   "text_format": "latex",
   "bbox": [
    194,
    886,
    781,
    928
   ],
   "page_idx": 3
  }
 ]
}

/** 由真实 equation 夹具拼出 /api/formulas 会返回给阅读器的那份索引（走真实服务端投射）。 */
function realIndex() {
  const contentList = FIXTURE.items.map((b, i) => ({
    type: 'equation', text: b.text, text_format: 'latex', bbox: b.bbox, page_idx: b.page_idx, img_path: `images/x${i}`,
  }))
  return buildFormulaIndex(JSON.stringify({ v: 1, producer: 'mineru-local', backend: 'pipeline', pageCount: 5, contentList }))
}

/* ── 真实 pdf.js：真实 viewport 的**唯一**来源 ───────────────────────────────── */
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
/** 零依赖 N 页 letter(612×792) PDF。 */
function buildPdf(pages) {
  const objs = []; const pn = []; objs[0] = null; objs[1] = null; const cn = []
  for (let i = 0; i < pages; i++) { pn.push(objs.length + 1); objs.push(null); cn.push(objs.length + 1); objs.push(null) }
  const fn = objs.length + 1
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const set = (n, b) => { objs[n - 1] = b }
  set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  set(2, `<< /Type /Pages /Kids [${pn.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages} >>`)
  for (let i = 0; i < pages; i++) {
    set(pn[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${cn[i]} 0 R /Resources << /Font << /F1 ${fn} 0 R >> >> >>`)
    const s = `BT /F1 14 Tf 72 720 Td (merge-verify fixture page ${i + 1}) Tj ET\n`
    set(cn[i], `<< /Length ${s.length} >>\nstream\n${s}endstream`)
  }
  let out = '%PDF-1.4\n'; const off = []
  for (let i = 0; i < objs.length; i++) { off.push(out.length); out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n` }
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of off) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const REAL_DOC = await pdfjs.getDocument({ data: new Uint8Array(buildPdf(5)) }).promise

/* ── 自建 DOM stub（子节点真正连起来；选择器只实现阅读器用到的那几种） ────────── */
function parsePart(part) {
  const m = part.match(/^([a-zA-Z]*)((?:[.#][^.#\[]+|\[[^\]]+\])*)$/)
  if (!m) return null
  const o = { tag: m[1] ? m[1].toUpperCase() : null, id: null, classes: [], attrs: [] }
  for (const t of m[2].match(/[.#][^.#\[]+|\[[^\]]+\]/g) || []) {
    if (t[0] === '#') o.id = t.slice(1)
    else if (t[0] === '.') o.classes.push(t.slice(1))
    else {
      const a = t.slice(1, -1).split('=')
      o.attrs.push([a[0].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), a[1] ? a[1].replace(/^"|"$/g, '') : null])
    }
  }
  return o
}
function matchesPart(el, o) {
  if (!o) return false
  if (o.tag && el.tagName !== o.tag) return false
  if (o.id && el.id !== o.id) return false
  for (const c of o.classes) if (!el.classList.contains(c)) return false
  for (const [k, v] of o.attrs) {
    if (v === null) { if (el.dataset[k] === undefined) return false } else if (String(el.dataset[k]) !== v) return false
  }
  return true
}
const matchesSel = (el, sel) => sel.trim().split(/\s+/).every((p) => matchesPart(el, parsePart(p)))
const matchesLast = (el, sel) => { const p = sel.trim().split(/\s+/); return matchesPart(el, parsePart(p[p.length - 1])) }

function makeEl(tag, doc) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), id: '', dataset: {}, children: [],
    textContent: '', value: '', disabled: false, onclick: null, _classes: new Set(),
    style: { setProperty(k, v) { this[k] = v }, removeProperty(k) { delete this[k] }, getPropertyValue: () => '' },
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      toggle: (c, on) => { const v = on === undefined ? !el._classes.has(c) : on; if (v) el._classes.add(c); else el._classes.delete(c); return v },
      contains: (c) => el._classes.has(c),
    },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c },
    append(...cs) { cs.forEach((c) => el.appendChild(c)) },
    remove() { const p = el.parentNode; if (p) p.children = p.children.filter((x) => x !== el) },
    closest(sel) { let n = el; while (n) { if (matchesLast(n, sel)) return n; n = n.parentNode } return null },
    focus() { doc.activeElement = el }, blur() { doc.activeElement = null }, select() {}, click() { el.onclick && el.onclick() },
    addEventListener(t, h) { (el._handlers[t] ||= []).push(h) },
    removeEventListener(t, h) { if (el._handlers[t]) el._handlers[t] = el._handlers[t].filter((x) => x !== h) },
    _handlers: {},
    querySelector(s) { return doc.querySelectorAll(s).find((e) => el.contains(e)) ?? null },
    querySelectorAll(s) { return doc.querySelectorAll(s).filter((e) => el.contains(e)) },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    contains(o) { let n = o; while (n) { if (n === el) return true; n = n.parentNode } return false },
    scrollIntoView() {}, getContext() { return {} }, setAttribute(k, v) { if (k === 'class') el.className = v; else el.dataset[k] = v },
    get clientHeight() { return el._ch ?? 0 }, set clientHeight(v) { el._ch = v },
    get clientWidth() { return el._cw ?? 0 }, set clientWidth(v) { el._cw = v },
    scrollTop: 0, scrollHeight: 0,
  }
  Object.defineProperty(el, 'className', { get: () => [...el._classes].join(' '), set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)) } })
  Object.defineProperty(el, 'innerHTML', { get: () => el._html ?? '', set: (v) => { el._html = v; if (v === '') el.children = [] } })
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null })
  Object.defineProperty(el, 'lastChild', { get: () => el.children[el.children.length - 1] ?? null })
  Object.defineProperty(el, 'parentNode', { get: () => el._parent ?? null, set: (v) => { el._parent = v } })
  Object.defineProperty(el, 'parentElement', { get: () => el._parent ?? null })
  return el
}

function loadReader({ script = SCRIPT_SRC, storageInit = null } = {}) {
  const byId = new Map(); const created = []
  const doc = {
    activeElement: null, _handlers: {},
    getElementById(id) { if (!byId.has(id)) { const e = makeEl('div', doc); e.id = id; byId.set(id, e) } return byId.get(id) },
    createElement(tag) { const e = makeEl(tag, doc); created.push(e); return e },
    querySelector(s) { return doc.querySelectorAll(s)[0] ?? null },
    querySelectorAll(s) { return created.filter((e) => matchesSel(e, s)) },
    body: null, documentElement: null,
    addEventListener(t, h) { (doc._handlers[t] ||= []).push(h) },
    removeEventListener(t, h) { if (doc._handlers[t]) doc._handlers[t] = doc._handlers[t].filter((x) => x !== h) },
    dispatch(t, ev) { for (const h of doc._handlers[t] || []) h(ev) },
  }
  doc.body = makeEl('body', doc); doc.documentElement = makeEl('html', doc)
  const win = {
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900,
    addEventListener() {}, getSelection: () => null,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  const storage = new Map(storageInit ? Object.entries(storageInit) : []); const requests = []
  const ctx = {
    document: doc, window: win, navigator: {}, localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    location: { search: '' }, matchMedia: win.matchMedia,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, URLSearchParams, parseFloat, parseInt, isNaN,
    fetch: (url, opts = {}) => { requests.push({ url, body: opts.body }); return Promise.resolve({ ok: true, status: 200, json: async () => ({ n: 1, topics: [], papers: [] }) }) },
    Promise, Math, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Date, Set, Map,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } },
    pdfjsLib: { TextLayer: class { async render() {} }, GlobalWorkerOptions: {} },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  const pane = doc.getElementById('pdf-pane'); pane.clientHeight = 800; pane.clientWidth = 1000
  const harness = `
    ;globalThis.__t = {
      EQ_BY_PAGE, eqGeom, hitTestFormula, eqHotEnabled, clearEqGeometry,
      setEq: (i) => { eqIndex = i }, setVariant: (v) => { zhVariant = v },
      setZoom: (z) => { zoomScale = z }, setPageMode: (m) => { pageMode = m },
      setCurPage: (n) => { curPage = n }, setPdfDoc: (d) => { pdfDoc = d }, setCurrent: (c) => { current = c },
      getAskSelection: () => askSelection, getAskPop: () => askPop,
      renderPaged, renderAllPages, rerender,
    };`
  vm.runInContext(script + harness, ctx, { filename: 'reader-inline.js' })
  return { t: ctx.__t, doc, byId, created, win, requests }
}

/** 真实 pdf.js 页 → 阅读器要的形状（viewport 真的来自 pdf.js）。 */
const wrapPage = (p) => ({ getViewport: (o) => p.getViewport(o), render: () => ({ promise: Promise.resolve() }), getTextContent: () => p.getTextContent() })
const realDocStub = { numPages: REAL_DOC.numPages, getPage: async (n) => wrapPage(await REAL_DOC.getPage(Math.min(n, REAL_DOC.numPages))) }

const pagesIn = (R) => R.byId.get('pdf-pages').children.filter((c) => c.className === 'page')
const boxesOf = (page) => page.children.find((c) => c.className === 'eqLayer')?.children ?? []
const centerOf = (b) => ({ x: parseFloat(b.style.left) + parseFloat(b.style.width) / 2, y: parseFloat(b.style.top) + parseFloat(b.style.height) / 2 })

const IDX = realIndex()
const EQ_PAGES = [...new Set(IDX.equations.filter((e) => e.bbox).map((e) => e.page))].sort((a, b) => a - b)
const ex0y = (exp) => exp[0].vp.height - 2

/** 独立复算：bbox（页归一化 ×1000）→ 该页真实 viewport 下的 CSS 矩形（与实现无关）。 */
async function expectedRects(pageNo, scale) {
  const vp = (await REAL_DOC.getPage(pageNo)).getViewport({ scale })
  return IDX.equations.filter((e) => e.page === pageNo && e.bbox).map((e) => ({
    id: e.id, latex: e.latex,
    x0: e.bbox[0] / 1000 * vp.width, y0: e.bbox[1] / 1000 * vp.height,
    x1: e.bbox[2] / 1000 * vp.width, y1: e.bbox[3] / 1000 * vp.height, vp,
  }))
}
function bootReader({ mode = 'paged', scale = 1, page = null } = {}) {
  // 注意：pageMode 的**真实**初值来自 localStorage（reader:247），所以这里从存储注入，
  // 而不是加载后再改内部变量——后者测不到"模式切换记忆"。
  const R = loadReader({ storageInit: { 'dpr.pageMode': mode } })
  assert.equal(R.t.EQ_BY_PAGE.size, 0)
  R.t.setEq(IDX); R.t.setVariant(null); R.t.setZoom(scale)
  R.t.setPdfDoc(realDocStub)
  R.t.setCurrent({ topic: 'merge-verify', name: 'fixture' })
  if (page) R.t.setCurPage(page)
  return R
}

/* ═══ R1 · 翻页模式：热区层存在 + 坐标独立复算 + 命中闭环（两档缩放） ═══════════ */

test('R1 翻页模式：热区层存在、bbox→viewport 独立复算（scale 1.0/1.5）、盒子中心自命中', async () => {
  assert.ok(EQ_PAGES.length >= 2, '夹具必须覆盖至少两页（真实产物有 bbox 的页）')
  for (const scale of [1.0, 1.5]) {
    for (const pageNo of EQ_PAGES) {
      const R = bootReader({ mode: 'paged', scale, page: pageNo })
      await R.t.renderPaged()
      const live = pagesIn(R)
      assert.equal(live.length, 1, `翻页模式只渲染 curPage 一页（scale=${scale}）`)
      const page = live[0]
      assert.equal(+page.dataset.page, pageNo)
      assert.ok(page.children.some((c) => c.className === 'eqLayer'), `scale=${scale} 页 ${pageNo} 必须铺上 .eqLayer（H1：翻页模式热区全哑）`)
      assert.equal(page.children.filter((c) => c.className === 'eqLayer').length, 1, '只许一层（重复铺会覆盖 EQ_BY_PAGE）')
      assert.equal(page.children[page.children.length - 1].className, 'eqLayer', '热区层追加在 textLayer 之后')
      assert.equal(page.children[0].tagName, 'CANVAS', 'canvas 仍是 firstChild（paintPage 的取值前提）')
      assert.equal(R.t.EQ_BY_PAGE.size, 1, 'EQ_BY_PAGE 只含当前页')

      const boxes = boxesOf(page)
      const exp = await expectedRects(pageNo, scale)
      assert.equal(boxes.length, exp.length, `scale=${scale} 页 ${pageNo} 热区盒数 = 有 bbox 的公式数`)
      for (const ex of exp) {
        const b = boxes.find((x) => x.dataset.eqId === ex.id)
        assert.ok(b, `缺 eq-box ${ex.id}`)
        assert.ok(Math.abs(parseFloat(b.style.left) - Math.max(0, ex.x0)) < 1e-6, `${ex.id} left 必须 = bbox[0]/1000×viewport.width`)
        assert.ok(Math.abs(parseFloat(b.style.top) - Math.max(0, ex.y0)) < 1e-6, `${ex.id} top 必须 = bbox[1]/1000×viewport.height`)
        assert.ok(Math.abs(parseFloat(b.style.width) - Math.max(1, Math.min(ex.vp.width, ex.x1) - Math.max(0, ex.x0))) < 1e-6, `${ex.id} width 必须按 bbox 宽度复算`)
        assert.ok(Math.abs(parseFloat(b.style.height) - Math.max(1, Math.min(ex.vp.height, ex.y1) - Math.max(0, ex.y0))) < 1e-6, `${ex.id} height 必须按 bbox 高度复算`)
        // 闭环：DOM 盒子的几何中心 → hitTestFormula 必须命中同一条
        const c = centerOf(b)
        assert.equal(R.t.hitTestFormula({ target: page.children[0], clientX: c.x, clientY: c.y })?.eq?.id, ex.id,
          `scale=${scale} 页 ${pageNo} ${ex.id} 盒子中心(${c.x.toFixed(1)},${c.y.toFixed(1)}) 必须自命中`)
      }
      assert.equal(R.t.hitTestFormula({ target: page.children[0], clientX: 2, clientY: ex0y(exp) }), null, '远离公式处不得误命中')
    }
  }
})

test('R2 翻页模式：换页后上一页几何与悬停态必须作废（防命中整体偏移）', async () => {
  const [p1, p2] = EQ_PAGES
  const R = bootReader({ mode: 'paged', scale: 1, page: p1 })
  await R.t.renderPaged()
  const page1 = pagesIn(R)[0]
  const b1 = boxesOf(page1)[0]
  const c1 = centerOf(b1)
  assert.equal(R.t.hitTestFormula({ target: page1.children[0], clientX: c1.x, clientY: c1.y })?.eq?.id, b1.dataset.eqId, '换页前可命中')
  assert.ok(R.t.EQ_BY_PAGE.has(p1))
  R.t.setCurPage(p2)
  await R.t.renderPaged()
  assert.ok(!R.t.EQ_BY_PAGE.has(p1), '换页后旧页几何必须被清掉（clearEqGeometry）')
  assert.ok(R.t.EQ_BY_PAGE.has(p2))
  assert.equal(pagesIn(R).length, 1, '换页后 DOM 仍只有一页')
  assert.ok(!R.byId.get('pdf-pages').children.includes(page1), '旧页节点已从容器摘除')
  assert.equal(R.t.hitTestFormula({ target: page1.children[0], clientX: c1.x, clientY: c1.y }), null, '旧页/旧坐标不得再命中')
  const page2 = pagesIn(R)[0]
  const exp2 = await expectedRects(p2, 1)
  assert.equal(boxesOf(page2).length, exp2.length, '新页热区按新页 bbox 重铺')
})

/* ═══ R3 · 切回滚动模式：与改造前一致 ═══════════════════════════════════════ */

test('R3 切回滚动模式：全量页 + 每页一层热区 + 摘掉 paged 类 + 几何/命中仍正确', async () => {
  const R = bootReader({ mode: 'paged', scale: 1, page: EQ_PAGES[0] })
  await R.t.renderPaged()
  const container = R.byId.get('pdf-pages')
  assert.ok(container.classList.contains('paged'), '翻页模式：#pdf-pages 带 paged 类')
  R.t.setPageMode('scroll')
  await R.t.renderAllPages()
  assert.ok(!container.classList.contains('paged'), '切回滚动必须摘掉 paged 类（H3：否则单页布局样式残留）')
  assert.equal(pagesIn(R).length, REAL_DOC.numPages, '滚动模式渲染全量页')
  for (const p of pagesIn(R)) assert.equal(p.children.filter((c) => c.className === 'eqLayer').length, 1, '每页各一层 .eqLayer')
  assert.equal(R.t.EQ_BY_PAGE.size, REAL_DOC.numPages, 'EQ_BY_PAGE 覆盖全部页（无公式的页为空数组）')
  let hit = 0
  for (const pageNo of EQ_PAGES) {
    const page = pagesIn(R).find((p) => +p.dataset.page === pageNo)
    const boxes = boxesOf(page)
    const exp = await expectedRects(pageNo, 1)
    assert.equal(boxes.length, exp.length, `页 ${pageNo} 热区盒数`)
    for (const ex of exp) {
      const b = boxes.find((x) => x.dataset.eqId === ex.id)
      assert.ok(b, `页 ${pageNo} 缺 ${ex.id}`)
      assert.ok(Math.abs(parseFloat(b.style.left) - Math.max(0, ex.x0)) < 1e-6, `页 ${pageNo} ${ex.id} 几何复算`)
      const c = centerOf(b)
      assert.equal(R.t.hitTestFormula({ target: page.children[0], clientX: c.x, clientY: c.y })?.eq?.id, ex.id, `页 ${pageNo} ${ex.id} 中心自命中`)
      hit++
    }
  }
  assert.ok(hit >= FIXTURE.items.length, `滚动模式全部公式独立复算+自命中（命中 ${hit} 条）`)
  assert.equal(boxesOf(pagesIn(R).find((p) => !EQ_PAGES.includes(+p.dataset.page))).length, 0, '无公式的页：铺了层但层里没有盒子')
})

/* ═══ R4 · 划词优先 / 公式引用（翻页 + 滚动） ═══════════════════════════════ */

async function selectionScenario(mode) {
  const pageNo = EQ_PAGES[0]
  const R = bootReader({ mode, scale: 1, page: pageNo })
  if (mode === 'paged') await R.t.renderPaged(); else await R.t.renderAllPages()
  const page = pagesIn(R).find((p) => +p.dataset.page === pageNo)
  const box = boxesOf(page)[0]
  const c = centerOf(box)
  const tl = page.children.find((x) => x.className === 'textLayer')
  const span = makeEl('span', R.doc); tl.appendChild(span)

  // (a) 在热区内部起手拖选正文 → 引用**文字**
  R.win.getSelection = () => ({ toString: () => 'selected body text inside the hotspot', anchorNode: span, getRangeAt: () => ({ getBoundingClientRect: () => ({ bottom: 100 }) }) })
  R.doc.dispatch('mousedown', { target: span, clientX: c.x, clientY: c.y })
  R.doc.dispatch('mouseup', { target: span, clientX: c.x + 40, clientY: c.y + 6 })
  await new Promise((r) => setTimeout(r, 30))
  const sel = R.t.getAskSelection()
  assert.equal(sel?.kind, 'text', `${mode}: 热区内拖选必须是文字引用（A7）`)
  assert.equal(sel?.text, 'selected body text inside the hotspot')
  assert.equal(R.byId.get('ask-pop').style.display, 'block', `${mode}: 划词浮层可见`)

  // (b) 零位移点击（无选区）→ 引用公式，载荷是紧凑 LaTeX
  R.win.getSelection = () => null
  R.doc.dispatch('mousedown', { target: page.children[0], clientX: c.x, clientY: c.y })
  R.doc.dispatch('mouseup', { target: page.children[0], clientX: c.x, clientY: c.y })
  await new Promise((r) => setTimeout(r, 30))
  const eqSel = R.t.getAskSelection()
  assert.equal(eqSel?.kind, 'equation', `${mode}: 零位移点击热区 → 公式引用`)
  const fx = FIXTURE.items.find((b) => compactLatex(b.text) === IDX.equations.find((e) => e.index === eqSel.equationIndex)?.latex)
  assert.ok(fx, `${mode}: 引用的公式必须来自真实 MinerU 夹具`)
  const compactStripped = compactLatex(fx.text).replace(/^\s*\$\$?/, '').replace(/\$\$?\s*$/, '').trim()
  assert.equal(eqSel.latex, compactStripped, `${mode}: selectedText 里的 LaTeX 是「原文 → 紧凑函数 → 去 $$」的形态`)
  assert.equal(eqSel.text, `$$ ${compactStripped} $$`, `${mode}: 引用串形态 '$$ <紧凑 LaTeX> $$'`)
  assert.ok(!/\{\s+\w\s+\}/.test(eqSel.latex), `${mode}: 不得保留 MinerU 逐字符空格形态`)
  R.byId.get('ask-input').value = '解释一下'
  const before = R.requests.length
  await R.byId.get('ask-send').onclick()
  const body = JSON.parse(R.requests.slice(before).find((q) => String(q.url).includes('/api/ask')).body)
  assert.equal(body.selectedText, eqSel.text, `${mode}: 进 /api/ask 的 selectedText 与引用串一致`)
  assert.equal(body.kind, 'equation')
  assert.equal(body.equationIndex, eqSel.equationIndex)

  // (c) 位移 >4px 且无选区 → 不当作公式点击
  R.win.getSelection = () => null
  R.t.getAskPop().style.display = 'none'
  R.doc.dispatch('mousedown', { target: page.children[0], clientX: c.x, clientY: c.y })
  R.doc.dispatch('mouseup', { target: page.children[0], clientX: c.x + 40, clientY: c.y + 30 })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(R.t.getAskPop().style.display, 'none', `${mode}: 拖拽（>4px）不得被误判成公式点击`)
  return R
}

test('R4 划词优先：翻页模式与滚动模式下，热区内部起手拖选仍引用文字、点击才引用 LaTeX', async () => {
  await selectionScenario('paged')
  await selectionScenario('scroll')
})

/* ═══ R5 · 译文视图关热区（两种模式） ═══════════════════════════════════════ */

test('R5 译文视图（-zh/-dual）：两种模式下都不铺热区、命中恒 null，切回原文恢复', async () => {
  for (const mode of ['paged', 'scroll']) {
    const R = bootReader({ mode, scale: 1, page: EQ_PAGES[0] })
    if (mode === 'paged') await R.t.renderPaged(); else await R.t.renderAllPages()
    const pick = () => (mode === 'paged' ? pagesIn(R)[0] : pagesIn(R).find((p) => +p.dataset.page === EQ_PAGES[0]))
    R.t.setVariant('zh'); await R.t.rerender()
    assert.ok(!pick().children.some((c) => c.className === 'eqLayer'), `${mode}: 译文视图不得铺热区层`)
    assert.equal(R.t.hitTestFormula({ target: pick().children[0], clientX: 100, clientY: 100 }), null, `${mode}: 译文视图命中恒 null`)
    R.t.setVariant('dual'); await R.t.rerender()
    assert.ok(!pick().children.some((c) => c.className === 'eqLayer'), `${mode}: 中英对照同样关热区`)
    R.t.setVariant(null); await R.t.rerender()
    assert.ok(pick().children.some((c) => c.className === 'eqLayer'), `${mode}: 切回原文热区恢复`)
    const b = boxesOf(pick())[0]; const c = centerOf(b)
    assert.equal(R.t.hitTestFormula({ target: pick().children[0], clientX: c.x, clientY: c.y })?.eq?.id, b.dataset.eqId, `${mode}: 恢复后仍可命中`)
  }
})

/* ═══ R6 · 结构契约（静态） ═══════════════════════════════════════════════ */

const fnBody = (name, script = SCRIPT_SRC) => {
  const i = script.indexOf(`function ${name}(`)
  assert.ok(i > 0, `缺少 ${name}`)
  return script.slice(i, script.indexOf('\n}\n', i))
}

/** 结构判据（对**任意** reader 源码生效，方便变异自检复用同一份判据）。 */
const checkLayerPointerEvents = (html) => {
  assert.match(html, /\.eqLayer \{[^}]*pointer-events: none/, '.eqLayer 必须是 pointer-events:none（不得夺走 textLayer 拖拽选区）')
  assert.ok(!/\.eq-box[^{]*\{[^}]*pointer-events:\s*auto/.test(html), '.eq-box 不得把 pointer-events 改回 auto')
}
const checkTranscribeRerender = (script) => {
  const tr = script.slice(script.indexOf('async function transcribeWithMineru'))
  assert.ok(tr.length > 0, '缺少 transcribeWithMineru')
  assert.match(tr.slice(0, tr.indexOf('\n}\n')), /await rerender\(\)/, 'transcribeWithMineru 必须按当前模式重渲（H4）')
}
const checkSolePaintPoint = (script) => {
  assert.match(fnBody('paintPage', script), /paintEqLayer\(div, viewport, \+div\.dataset\.page\)/, '唯一铺层点必须在 paintPage 里')
  assert.ok(!/paintEqLayer\(/.test(fnBody('renderPaged', script)), 'renderPaged 不得自己再铺一层')
  assert.ok(!/paintEqLayer\(/.test(fnBody('renderAllPages', script)), 'renderAllPages 不得自己铺层（旧调用点必须搬走）')
  assert.ok(!/container: tl/.test(fnBody('renderAllPages', script)), 'renderAllPages 不得残留对循环外 tl 的引用（会第一页就 ReferenceError）')
  assert.match(fnBody('renderPaged', script), /clearEqGeometry\(\)/, 'renderPaged 换页必须清几何')
  assert.match(fnBody('renderAllPages', script), /container\.classList\.remove\('paged'\)/, 'renderAllPages 必须摘掉 paged 类')
}

test('R6 结构契约：pointer-events:none、唯一铺层点在 paintPage、全量重渲走 rerender、DOM id 配对、热区层不夺文本层', () => {
  checkLayerPointerEvents(READER_HTML)
  checkSolePaintPoint(SCRIPT_SRC)
  checkTranscribeRerender(SCRIPT_SRC)
  // DOM id ↔ 脚本引用必须配对（任一为 null → 脚本开头即死、整页白屏）
  const ids = new Set([...READER_HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
  const used = new Set()
  for (const m of SCRIPT_SRC.matchAll(/\$\(\s*.([A-Za-z0-9_-]+).\s*\)/g)) used.add(m[1])
  for (const m of SCRIPT_SRC.matchAll(/getElementById\(\s*.([A-Za-z0-9_-]+).\s*\)/g)) used.add(m[1])
  assert.deepEqual([...used].filter((x) => !ids.has(x)), [], '脚本引用了不存在的 DOM id')
  // 翻页模式的 DOM 与键盘/翻页控件在位（上游特性）
  for (const id of ['pager', 'page-prev', 'page-input', 'page-total', 'page-next', 'mode-toggle', 'ver', 'dl-btn', 'pdf-path', 'eq-toggle', 'eq-panel']) {
    assert.ok(ids.has(id), `顶栏/翻页控件 #${id} 必须在位`)
  }
})

/* ═══ R8 · 翻页控件/状态/键盘（上游特性可用性，交互级） ═══════════════════ */

test('R8 翻页控件/状态/键盘：模式切换、页码输入、‹› 按钮禁用态、Space/←/→ 翻页、输入框不抢键', async () => {
  const R = bootReader({ mode: 'paged', scale: 1, page: 1 })
  const T = R.t
  const modeBtn = R.byId.get('mode-toggle')
  const next = R.byId.get('page-next')
  const prev = R.byId.get('page-prev')
  const input = R.byId.get('page-input')
  await T.renderPaged()
  assert.equal(modeBtn.textContent, '▣', '翻页模式下模式按钮显示 ▣')
  assert.ok(modeBtn.classList.contains('active'), '翻页模式下模式按钮 active')
  assert.equal(prev.disabled, true, '第一页时 ‹ 禁用')
  assert.equal(next.disabled, false, '第一页时 › 可用')
  assert.equal(input.value, 1, '页码输入框回写当前页')
  assert.equal(R.byId.get('page-total').textContent, '/ ' + REAL_DOC.numPages, '总页数显示')
  // › 按钮 → 下一页（走 goPage → renderPaged）
  await next.onclick()
  assert.equal(input.value, 2, '› 后页码 = 2')
  assert.equal(T.EQ_BY_PAGE.size, 1, '翻页后仍只有当前页几何')
  // ← 键盘翻页（target 不是输入框）
  let prevented = 0
  R.doc.dispatch('keydown', { target: { tagName: 'DIV' }, key: 'ArrowLeft', preventDefault: () => { prevented++ } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(input.value, 1, 'ArrowLeft 回到第 1 页')
  assert.ok(prevented >= 1, '翻页键必须 preventDefault（不滚动页面）')
  // Space 在输入框聚焦时不得翻页（U:776 的守卫）
  R.doc.dispatch('keydown', { target: { tagName: 'INPUT' }, key: ' ', preventDefault: () => { prevented++ } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(input.value, 1, '输入框里按 Space 不得翻页')
  // 键盘 Home/End
  R.doc.dispatch('keydown', { target: { tagName: 'DIV' }, key: 'End', preventDefault: () => {} })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(input.value, REAL_DOC.numPages, 'End 跳到末页')
  assert.equal(next.disabled, true, '末页时 › 禁用')
  // 模式切换 paged → scroll：全量页 + 摘掉 paged 类 + 按钮变 ≣
  await modeBtn.onclick()
  const container = R.byId.get('pdf-pages')
  assert.equal(container.classList.contains('paged'), false, '切回滚动后 paged 类摘掉')
  assert.equal(pagesIn(R).length, REAL_DOC.numPages, '切回滚动渲染全量页')
  assert.equal(modeBtn.textContent, '≣', '滚动模式按钮显示 ≣')
  assert.ok(!modeBtn.classList.contains('active'))
  assert.equal(prev.disabled, false, '滚动模式下 ‹ 不禁用（禁用只属于翻页模式）')
  assert.equal(next.disabled, false, '滚动模式下 › 不禁用')
  // 滚动模式键盘不翻页
  const before = input.value
  R.doc.dispatch('keydown', { target: { tagName: 'DIV' }, key: 'ArrowRight', preventDefault: () => {} })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(input.value, before, '滚动模式下键盘不翻页')
  // 再切回翻页：仍是单页渲染
  await modeBtn.onclick()
  assert.equal(container.classList.contains('paged'), true, '再切回翻页：paged 类回归')
  assert.equal(pagesIn(R).length, 1, '再切回翻页：只渲染一页')
})

/* ═══ R7 · 变异自检：断言必须对注入缺陷敏感 ═══════════════════════════════ */

test('R7 变异自检：把关键实现改坏，R1/R2/R6 的判据必须能抓到（断言不是恒真）', async () => {
  const mutate = (from, to) => {
    assert.ok(SCRIPT_SRC.includes(from), `变异锚点必须存在：${from}`)
    return SCRIPT_SRC.replace(from, to)
  }
  const detect = async (script, check) => { try { await check(script); return null } catch (e) { return e } }

  // M1：拿掉 paintPage 里的唯一铺层点 → 翻页模式必须"热区全哑"
  const m1 = await detect(mutate('  paintEqLayer(div, viewport, +div.dataset.page);\n', ''), async (script) => {
    const R = loadReader({ script }); R.t.setEq(IDX); R.t.setVariant(null); R.t.setZoom(1); R.t.setPageMode('paged')
    R.t.setPdfDoc(realDocStub); R.t.setCurPage(EQ_PAGES[0]); await R.t.renderPaged()
    assert.ok(pagesIn(R)[0].children.some((c) => c.className === 'eqLayer'), '铺层点被删后仍应失败')
  })
  assert.ok(m1, 'M1（删 paintEqLayer）必须被 R1 判据抓住')

  // M2：renderPaged 里不清几何 → 换页后旧页几何残留
  const m2 = await detect(mutate("  container.innerHTML = '';\n  clearEqGeometry(); // 同上：翻页模式下换页/缩放时，旧页几何与 hover 残留必须一起作废（否则命中整体偏移）\n", "  container.innerHTML = '';\n"), async (script) => {
    const R = loadReader({ script }); R.t.setEq(IDX); R.t.setVariant(null); R.t.setZoom(1); R.t.setPageMode('paged')
    R.t.setPdfDoc(realDocStub); R.t.setCurPage(EQ_PAGES[0]); await R.t.renderPaged()
    R.t.setCurPage(EQ_PAGES[1]); await R.t.renderPaged()
    assert.ok(!R.t.EQ_BY_PAGE.has(EQ_PAGES[0]), '未清几何时旧页仍应残留')
  })
  assert.ok(m2, 'M2（删 clearEqGeometry）必须被 R2 判据抓住')

  // M3：把热区层改回会抢鼠标的覆盖层 → 结构契约必须失败
  const EHR = '.eqLayer { position: absolute; inset: 0; pointer-events: none; z-index: 2; }'
  const AHR = '.eqLayer { position: absolute; inset: 0; pointer-events: auto; z-index: 2; }'
  assert.ok(READER_HTML.includes(EHR), 'M3 变异锚点必须存在于 reader/index.html 的 CSS 里')
  const m3 = await detect(READER_HTML.replace(EHR, AHR), async (html) => { checkLayerPointerEvents(html) })
  assert.ok(m3, 'M3（pointer-events:auto）必须被结构判据抓住')

  // M4：transcribeWithMineru 改回全量重渲 → 结构契约必须失败
  const m4 = await detect(mutate('    if (pdfDoc) await rerender();\n  } catch (e) {\n    toast(\'MinerU 转录失败', '    if (pdfDoc) await renderAllPages();\n  } catch (e) {\n    toast(\'MinerU 转录失败'), async (script) => { checkTranscribeRerender(script) })
  assert.ok(m4, 'M4（transcribeWithMineru 用 renderAllPages）必须被结构判据抓住')

  // M5：把唯一铺层点搬回 renderAllPages 的循环体（模拟"解冲突时选错落点"）→ 结构契约必须失败
  const m5 = await detect(mutate('  paintEqLayer(div, viewport, +div.dataset.page);\n', ''), async (script) => { checkSolePaintPoint(script) })
  assert.ok(m5, 'M5（拿掉 paintPage 里的唯一铺层点）必须被结构判据抓住')
})
