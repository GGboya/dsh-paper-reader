// test/katex-bubble-render.test.mjs — 划词译文气泡里的**公式渲染**（vendored KaTeX，离线）
//
// 被钉住的契约（docs 之外由本文件独立构造证据）：
//   1. 译文里的 `$…$` / `$$…$$` 必须**真的渲染成数学**（真实 KaTeX，不是打桩），其余文字仍走 textContent；
//   2. **绝不 innerHTML 模型输出**：渲染路径只允许 textContent + KaTeX 自建 DOM（用例直接数 innerHTML 写入次数）；
//   3. 渲染失败必须**降级**：该段退回原始 LaTeX 文本，并在 #tr-note 如实提示第几个失败（绝不留白）；
//   4. 气泡既有契约不变：内部零 button、#tr-note 仍是纯文本。
//
// 独立构造证据：本文件自带最小 DOM stub（不复用别的测试文件的 harness），真实 KaTeX 从
// reader/vendor/katex/katex.min.js 现场加载 —— 与浏览器同一个文件、同一套参数。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { extractModuleScript } from './reader-script.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const KATEX_JS = join(REPO, 'reader', 'vendor', 'katex', 'katex.min.js')
const KATEX_CSS = join(REPO, 'reader', 'vendor', 'katex', 'katex.min.css')

/** 真实 vendored KaTeX：它要在**同一个** vm 上下文里拿 document 建节点，故每次 harness 绑定当次 doc。 */
const KCTX = (() => {
  const c = { console, setTimeout, clearTimeout }
  c.globalThis = c; c.window = c; c.self = c
  vm.createContext(c)
  vm.runInContext(readFileSync(KATEX_JS, 'utf8'), c)
  return c
})()

/** 最小 DOM stub：够 KaTeX.render（createElement/createElementNS/createTextNode + compatMode）与
 *  本功能（textContent/appendChild/classList）用；**innerHTML 写入会被记数**（契约 2 的证据）。 */
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(), nodeType: 1, id: '', dataset: {}, children: [], childNodes: [],
    _classes: new Set(), _handlers: {}, _innerHTMLWrites: 0, _text: '',
    style: { setProperty(k, v) { this[k] = v }, removeProperty(k) { delete this[k] }, getPropertyValue: (k) => el.style[k] ?? '' },
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      contains: (c) => el._classes.has(c),
      toggle: (c, on) => (on ? el._classes.add(c) : el._classes.delete(c)),
    },
    // DocumentFragment（nodeType 11）在 appendChild 时要**展平**（真实 DOM 语义；KaTeX 用它建子树）
    appendChild(c) {
      if (c && c.nodeType === 11) { for (const k of c.children.slice()) el.appendChild(k); c.children = []; return c }
      el.children.push(c); el.childNodes.push(c); c.parentNode = el; c.parentElement = el; return c
    },
    append(...cs) { cs.forEach((c) => el.appendChild(c)) },
    insertBefore(c) { return el.appendChild(c) },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c },
    remove() { const p = el.parentNode; if (p) p.children = p.children.filter((x) => x !== el) },
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    focus() {}, blur() {}, select() {}, click() { if (typeof el.onclick === 'function') el.onclick() },
    addEventListener(t, h) { (el._handlers[t] ||= []).push(h) },
    removeEventListener(t, h) { if (el._handlers[t]) el._handlers[t] = el._handlers[t].filter((x) => x !== h) },
    dispatchEvent() { return true },
    querySelector() { return null }, querySelectorAll() { return [] },
    closest() { return null }, contains() { return false }, scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    getContext() { return {} }, clientHeight: 0, clientWidth: 0, scrollTop: 0, scrollHeight: 0, offsetTop: 0, offsetHeight: 0,
  }
  // textContent：读 = 自身文本 + 全部后代文本（真实 DOM 语义）；写 = 先清空子节点
  Object.defineProperty(el, 'textContent', {
    get: () => (el.children.length ? el.children.map((c) => c.textContent ?? '').join('') : el._text),
    set: (v) => { el.children = []; el.childNodes = []; el._text = v == null ? '' : String(v) },
  })
  Object.defineProperty(el, 'className', {
    get: () => [...el._classes].join(' '),
    set: (v) => { el._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)) },
  })
  let inner = ''
  Object.defineProperty(el, 'innerHTML', {
    get: () => inner,
    set: (v) => { inner = v; el._innerHTMLWrites += 1; if (v === '') { el.children = []; el.childNodes = [] } },
  })
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null })
  Object.defineProperty(el, 'parentNode', { get: () => el._parent ?? null, set: (v) => { el._parent = v } })
  return el
}

function makeDoc() {
  const els = new Map()
  const named = makeEl('div')
  const created = []
  const doc = {
    compatMode: 'CSS1Compat',           // KaTeX 在 quirks 模式拒绝渲染
    documentElement: makeEl('html'),
    createElement(tag) { const e = makeEl(tag); created.push(e); return e },
    createElementNS(_ns, tag) { const e = makeEl(tag); created.push(e); return e },
    createTextNode(t) { const n = makeEl('#text'); n.nodeType = 3; n.textContent = t; return n },
    createDocumentFragment() { const f = makeEl('#document-fragment'); f.nodeType = 11; return f },
    getElementById(id) { if (!els.has(id)) { const e = makeEl('div'); e.id = id; named.appendChild(e); els.set(id, e) } return els.get(id) },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener() {}, removeEventListener() {},
  }
  return { doc, els, created, named }
}

/** 载入真实 reader 脚本（同 window.katex = 真实 KaTeX），返回可徒手调用的渲染入口。 */
function loadReader({ katex } = {}) {
  const { doc, els, created } = makeDoc()
  KCTX.document = doc
  const win = {
    katex: katex === undefined ? KCTX.katex : katex,
    innerWidth: 1200, innerHeight: 900, addEventListener() {}, getSelection: () => null,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  const ctx = {
    document: doc, window: win, navigator: {}, location: { search: '' }, matchMedia: win.matchMedia,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, AbortController, console,
    URLSearchParams, Promise, Math, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Date, Set, Map,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } },
    pdfjsLib: { TextLayer: class { async render() {} }, GlobalWorkerOptions: {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ hasTranscript: false, pageCount: 0, pdfPath: '' }) }),
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  const harness = `;globalThis.__t = { splitTranslatedMath, trRenderBody, trComposeNote, showTrPop };`
  vm.runInContext(extractModuleScript(readFileSync(join(REPO, 'reader', 'index.html'), 'utf8'), { where: 'reader/index.html' }) + harness, ctx, { filename: 'reader-inline.js' })
  return { t: ctx.__t, doc, els, created, win }
}

/** 本机 Dong 那篇（Language-Conditioned World Modeling for Visual Navigation）MinerU 产物里
 *  **全部 18 个 equation 块**的原始 text（含 MinerU 自带的 $$…$$ 外壳），逐字取自该论文的 .mineru.json。 */
const DONG_EQUATIONS = [
  "$$\n\\begin{array} { r } { s _ { i } = \\mathrm { E n c } _ { \\theta } \\left( o _ { i } \\right) \\quad \\hat { s } _ { t + 1 } \\sim F _ { \\theta } \\left( \\hat { s } _ { t + 1 } ~ | ~ \\hat { \\mathbf { s } } _ { t } , \\hat { a } _ { t } , I , t _ { s } \\right) , } \\end{array}\\tag{1}\n$$",
  "$$\n\\hat { s } _ { t - m } ^ { ( \\ell _ { m } ) } = \\sqrt { \\alpha \\ell _ { m } } \\hat { s } _ { t - m } + \\sqrt { 1 - \\alpha _ { \\ell _ { m } } } \\epsilon _ { m } ,\\tag{2}\n$$",
  "$$\n\\mathcal { L } _ { \\mathrm { K L } } = D _ { \\mathrm { K L } } \\Big ( q _ { \\mathrm { e x p e r t } } ( z _ { \\mathrm { e x p e r t } } \\mid s _ { t : n } , I _ { c l i p } )\n$$",
  "$$\n\\parallel q _ { \\mathrm { l e a r n e r } } ( z _ { \\mathrm { p l a n } } \\mid s _ { t } , I _ { c l i p } ) \\biggl ) ,\\tag{3}\n$$",
  "$$\n\\begin{array} { r } { \\hat { s } _ { t + 1 } ^ { \\pi } \\sim F _ { \\theta } ( \\hat { s } _ { t + 1 } ^ { \\pi } \\mid \\mathbf { s } _ { t } , \\hat { a } _ { t } , I _ { c l i p } , t _ { s } ) , } \\end{array}\\tag{4}\n$$",
  "$$\nr _ { t } ^ { \\mathrm { i n t } } ( s _ { t + 1 } ^ { E } , \\hat { s } _ { t + 1 } ^ { \\pi } ) = \\frac { s _ { t + 1 } ^ { E } \\cdot \\hat { s } _ { t + 1 } ^ { \\pi } } { \\operatorname* { m a x } ( \\lVert s _ { t + 1 } ^ { E } \\rVert , \\lVert \\hat { s } _ { t + 1 } ^ { \\pi } \\rVert ) ^ { 2 } } \\mathrm { ~ , ~ }\\tag{5}\n$$",
  "$$\nv _ { \\psi } ( s _ { t } , I _ { c l i p } , z _ { \\mathrm { p l a n } } ) \\approx \\mathbb { E } _ { \\pi _ { \\theta } , p _ { \\phi } } \\left[ \\sum _ { k = t } ^ { t + H - 1 } \\gamma ^ { k - t } r _ { k } ^ { \\mathrm { i n t } } \\right] ,\\tag{6}\n$$",
  "$$\n\\mathcal { L } ( \\psi ) = \\mathbb { E } _ { \\pi _ { \\theta } , p _ { \\phi } } \\left[ \\sum _ { k = t } ^ { t + H - 1 } \\frac { 1 } { 2 } \\big ( v _ { \\psi } \\big ( \\hat { s } _ { k } , I _ { c l i p } , z _ { \\mathrm { p l a n } } \\big ) - \\mathrm { s g } ( V _ { k } ^ { \\lambda } ) \\big ) ^ { 2 } \\right] ,\\tag{7}\n$$",
  "$$\n\\mathcal { L } ( \\theta ) = \\mathbb { E } _ { \\pi _ { \\theta } , p _ { \\phi } } \\left[ \\sum _ { k = t } ^ { t + H - 1 } \\left( - V _ { k } ^ { \\lambda } + \\alpha _ { 1 } \\mathcal { L } _ { \\mathrm { K L } } ^ { k } + \\alpha _ { 2 } \\mathcal { L } _ { \\mathrm { i n s } } ^ { k } \\right) \\right] .\\tag{8}\n$$",
  "$$\n\\hat { a } _ { t + 1 } \\sim \\pi _ { \\theta } \\big ( \\hat { a } _ { t + 1 } \\mid s _ { t + 1 } , I _ { c l i p } , z _ { \\mathrm { p l a n } } \\big ) \\ .\\tag{9}\n$$",
  "$$\n\\begin{array} { r } { \\big ( \\hat { a } _ { t + 1 } , \\hat { o } _ { t + 1 } \\big ) \\ : = \\ : G _ { \\theta } \\big ( \\hat { o } _ { t } , \\hat { a } _ { t } , I , o _ { s } \\big ) , } \\end{array}\\tag{10}\n$$",
  "$$\n\\begin{array} { r } { \\mathcal { L } _ { \\mathrm { j o i n t } } = \\mathcal { L } _ { \\mathrm { p l a n } } + \\lambda \\mathcal { L } _ { \\mathrm { i m a g i n e } } , } \\end{array}\\tag{11}\n$$",
  "$$\n\\begin{array} { r } { \\mathcal { L } _ { \\mathrm { j o i n t } } = \\mathcal { L } _ { \\mathrm { p l a n } } + \\lambda \\mathcal { L } _ { \\mathrm { i m a g i n e } } , } \\end{array}\\tag{A1}\n$$",
  "$$\n\\mathcal { L } _ { \\mathrm { p l a n } } = \\frac { 1 } { 3 } { \\sum } _ { d \\in \\{ x , y , \\phi \\} } \\Bigl ( - \\log P ( b _ { d } ^ { * } | s _ { j } \\in \\mathcal { B } _ { d } ) \\Bigr ) + \\mathcal { L } _ { \\mathrm { t e x t } } ,\\tag{A2}\n$$",
  "$$\n\\boldsymbol { \\mathcal { L } } _ { \\mathrm { i m a g i n e } } = \\frac { 1 } { m } \\sum _ { j = 1 } ^ { m } \\sum _ { k = 1 } ^ { K } \\lVert \\mathbf { u } _ { j } - \\mathbf { c } _ { k } \\rVert ^ { 2 } \\boldsymbol { \\cdot } P ( s _ { j } = \\mathbf { c } _ { k } ) , ( \\mathrm { A 3 } )\n$$",
  "$$\n\\mathrm { S R } = \\frac { 1 } { N } \\sum _ { i = 1 } ^ { N } \\mathbf { 1 } \\Big [ d \\Big ( \\hat { p } _ { T } ^ { ( i ) } , p _ { g } ^ { ( i ) } \\Big ) < \\bar { s } \\Big ] .\\tag{A4}\n$$",
  "$$\n\\mathrm { S S I M @ } n = \\mathrm { S S I M } \\big ( o _ { t + n } , \\hat { o } _ { t + n } ^ { ( n ) } \\big ) ,\\tag{A5}\n$$",
  "$$\n\\operatorname { D r e a m S i m } ( I _ { 1 : N } , T ) { = } \\frac { 1 } { N } { \\sum _ { i = 1 } ^ { N } } \\frac { \\langle f _ { \\mathrm { i m g } } ( I _ { i } ) , f _ { \\mathrm { t e x t } } ( T ) \\rangle } { \\left\\| f _ { \\mathrm { i m g } } ( I _ { i } ) \\right\\| \\cdot \\left\\| f _ { \\mathrm { t e x t } } ( T ) \\right\\| }  .\\tag{A6}\n$$",
]

test('K1 真实 KaTeX 跑通论文里全部 18 个 equation（$$…$$ 独立成行）', () => {
  assert.equal(DONG_EQUATIONS.length, 18, '夹具必须是那篇论文的全部 18 个 equation')
  const R = loadReader()
  const before = [...R.els.values(), ...R.created].reduce((a, e) => a + (e._innerHTMLWrites || 0), 0)
  DONG_EQUATIONS.forEach((raw, i) => {
    const failed = R.t.trRenderBody(raw)
    assert.deepEqual([...failed], [], `第 ${i + 1} 个 equation 渲染失败：${raw.slice(0, 80)}`)
    const segs = R.els.get('tr-body').children
    assert.equal(segs.length, 1, `第 ${i + 1} 个 equation 应该正好一段（display 公式）`)
    assert.ok(segs[0]._classes.has('tr-math-block'), `第 ${i + 1} 个 equation 必须是块级数学段`)
    assert.ok(segs[0].children.length > 0, `第 ${i + 1} 个 equation 渲染后不得留白（空元素）`)
    const rendered = segs[0].children.map((c) => String(c.className)).join(' ')
    assert.ok(/katex/.test(rendered), `第 ${i + 1} 个 equation 必须产出 KaTeX DOM：${rendered.slice(0, 60)}`)
  })
  const after = [...R.els.values(), ...R.created].reduce((a, e) => a + (e._innerHTMLWrites || 0), 0)
  assert.equal(after - before, 0, '渲染 18 个公式期间绝不允许写 innerHTML')
})

test('K2 切段器：行内/独立/多行/转义美元号/未闭合/空公式', () => {
  const R = loadReader()
  const sp = (x) => JSON.parse(JSON.stringify(R.t.splitTranslatedMath(x)))   // 跨 realm 归一
  assert.deepEqual(sp('纯文字'), [{ kind: 'text', text: '纯文字' }])
  // 行内
  assert.deepEqual(sp('a $x_t$ b'), [
    { kind: 'text', text: 'a ' }, { kind: 'math', text: 'x_t', display: false }, { kind: 'text', text: ' b' }])
  // 独立成行（含换行）
  assert.deepEqual(sp('前\n$$\n\\frac{1}{2}\n$$\n后'), [
    { kind: 'text', text: '前\n' }, { kind: 'math', text: '\n\\frac{1}{2}\n', display: true }, { kind: 'text', text: '\n后' }])
  // 字面美元号 \$ 不是定界符
  assert.deepEqual(sp('价格 \\$5 与 $x$'), [
    { kind: 'text', text: '价格 $5 与 ' }, { kind: 'math', text: 'x', display: false }])
  // 未闭合 / 空公式 ⇒ 当普通文本，绝不产生「半个公式」
  assert.deepEqual(sp('a $x'), [{ kind: 'text', text: 'a $x' }])
  assert.deepEqual(sp('a $$b'), [{ kind: 'text', text: 'a $$b' }])
  assert.deepEqual(sp('a $$ $$ b'), [{ kind: 'text', text: 'a $$ $$ b' }])
  // 行内公式不跨行（避免把整段散文吞进公式）
  assert.deepEqual(sp('$a\nb$'), [{ kind: 'text', text: '$a\nb$' }])
})

test('K3 降级：非法 LaTeX 必须显示原始 LaTeX + #tr-note 如实提示（绝不留白）', () => {
  const R = loadReader()
  const note = R.t.trComposeNote('', R.t.trRenderBody('前 $\\frac{1}{$ 后'))
  assert.deepEqual([...R.t.trRenderBody('前 $\\frac{1}{$ 后')], [1], '非法公式必须被计入失败序号')
  const segs = R.els.get('tr-body').children
  assert.equal(segs.length, 3, '文本/公式/文本 三段都要在，绝不整段消失')
  assert.ok(segs[1]._classes.has('tr-math-fallback'), '失败段必须打上降级标记')
  assert.equal(segs[1].textContent, '$\\frac{1}{$', '失败段必须显示**原始 LaTeX**（可读可复制）')
  assert.ok(segs[1].textContent.trim().length > 0, '失败段不得空白')
  assert.equal(segs[0].textContent, '前 ')
  assert.equal(segs[2].textContent, ' 后')
  assert.match(note, /第 1 个公式未能渲染/, `提示必须点名第几个公式：${note}`)
})

test('K3b 混合：只有失败的那个被点名，其余照常渲染（不是整块降级）', () => {
  const R = loadReader()
  const failed = [...R.t.trRenderBody('$a$ 然后 $\\notacommand{$ 再 $b^2$')]
  assert.deepEqual(failed, [2], '只允许第 2 个公式失败')
  const segs = R.els.get('tr-body').children
  const math = segs.filter((e) => e._classes.has('tr-math'))
  assert.equal(math.length, 3)
  assert.ok(!math[0]._classes.has('tr-math-fallback'), '第 1 个公式必须渲染成功')
  assert.ok(math[1]._classes.has('tr-math-fallback'), '第 2 个公式必须降级')
  assert.ok(!math[2]._classes.has('tr-math-fallback'), '第 3 个公式必须渲染成功')
  const note = R.t.trComposeNote('公式未原样保留', failed)
  assert.match(note, /^公式未原样保留 第 2 个公式未能渲染/, `既有提示要保留、渲染失败要追加：${note}`)
})

test('K4 渲染参数契约 + 绝不 innerHTML（真实 KaTeX 与打桩两路都查）', () => {
  // ① 真实 KaTeX：渲染期间 innerHTML 写入次数必须为 0
  const R = loadReader()
  const before = [...R.els.values(), ...R.created].reduce((a, e) => a + (e._innerHTMLWrites || 0), 0)
  R.t.trRenderBody('译文 $x_t$ 与 $$\\mathbf{1}[d]$ 结束')
  const after = [...R.els.values(), ...R.created].reduce((a, e) => a + (e._innerHTMLWrites || 0), 0)
  assert.equal(after - before, 0, '真实 KaTeX 路径也不许写 innerHTML')

  // ② 打桩 KaTeX：核对三个契约参数，并证明 LaTeX 是**作为文本参数**交给渲染器的
  const calls = []
  const fake = {
    renderToString(tex, opts) { calls.push({ fn: 'renderToString', tex, opts }); return '<span class="katex"></span>' },
    render(tex, el, opts) { calls.push({ fn: 'render', tex, el, opts }); el.appendChild(makeEl('span')); el.children[0].className = 'katex' },
  }
  const R2 = loadReader({ katex: fake })
  assert.deepEqual([...R2.t.trRenderBody('A $x$ B')], [])
  assert.equal(calls.length, 2, '每个公式：探一次 renderToString + 真渲染一次 render')
  for (const c of calls) {
    assert.equal(c.opts.trust, false, '必须 trust:false（不产原始 HTML）')
    assert.equal(c.opts.strict, 'ignore', "必须 strict:'ignore'")
  }
  assert.equal(calls[1].opts.throwOnError, false, '真渲染必须 throwOnError:false（契约参数）')
  assert.equal(calls[0].opts.throwOnError, true, '探测那次必须 throwOnError:true，失败才能被我们抓住并降级')
  assert.equal(calls[1].tex, 'x')
  assert.equal(calls[1].el._classes.has('tr-math'), true)
})

test('K5 气泡既有契约不变：零 button、#tr-note 纯文本、#tr-status 仍走 textContent', () => {
  const R = loadReader()
  assert.deepEqual([...R.t.trRenderBody('译文 $x_t$ 与文字')], [])
  R.t.showTrPop('', '译文 $x_t$ 与文字', '')
  const body = R.els.get('tr-body')
  const note = R.els.get('tr-note')
  assert.equal(body.children.filter((e) => /BUTTON/i.test(e.tagName)).length, 0, '气泡正文零 button')
  assert.equal(note.children.length, 0, '#tr-note 必须是纯文本（不建子元素）')
  assert.equal(typeof note.textContent, 'string')
  // 失败时提示也只进 #tr-note，且 #tr-body 里没有警示符号（提示不混进正文）
  R.t.showTrPop('', '译文 $\\frac{1}{$', '')
  assert.ok(!String(R.els.get('tr-body').textContent).includes('⚠'), '#tr-body 里不得混入提示文案')
  assert.match(R.els.get('tr-note').textContent, /未能渲染/)
  assert.equal(R.els.get('tr-body').children.filter((e) => /BUTTON/i.test(e.tagName)).length, 0)
})

test('K6 vendored KaTeX 是离线资源：无 CDN、带版本/许可证、CSS 与字体齐备', () => {
  const html = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')
  assert.match(html, /<link rel="stylesheet" href="\/paper-reader\/vendor\/katex\/katex\.min\.css">/, '必须以本地路径引 CSS')
  assert.match(html, /<script src="\/paper-reader\/vendor\/katex\/katex\.min\.js"><\/script>/, '必须以本地路径引 JS')
  for (const tag of html.match(/<(?:link|script)[^>]*(?:katex)[^>]*>/g) ?? []) {
    assert.ok(!/https?:\/\//.test(tag), `KaTeX 资源不得引 CDN：${tag}`)
  }
  const js = readFileSync(KATEX_JS, 'utf8')
  const css = readFileSync(KATEX_CSS, 'utf8')
  assert.match(js, /version:"0\.16\.22"/, 'vendored JS 必须能读出 0.16.22')
  assert.ok(css.includes('fonts/KaTeX_'), 'CSS 必须引用同目录 fonts/')
  const noticeKind = readFileSync(join(REPO, 'reader', 'vendor', 'katex', 'NOTICE.md'), 'utf8')
  assert.match(noticeKind, /0\.16\.22/)
  assert.match(readFileSync(join(REPO, 'reader', 'vendor', 'katex', 'LICENSE'), 'utf8'), /MIT License/)
  for (const f of ['KaTeX_Main-Regular.woff2', 'KaTeX_Math-Italic.woff2', 'KaTeX_Size1-Regular.woff2']) {
    assert.ok(readFileSync(join(REPO, 'reader', 'vendor', 'katex', 'fonts', f)).length > 0, `缺字体 ${f}`)
  }
})
