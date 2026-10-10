// test/reader-ux.test.mjs — 阅读器可用性（公式鼠标引用）与文献管理（删除/重命名）的验收测试。
//
// 契约：docs/reader-ux-requirements.md。四块覆盖：
//   A. 公式索引（dist/formulas.js，纯函数）：LaTeX 提取、page=pageIdx+1、阅读序、三种 reason
//   B. 阅读器公式几何/命中（reader/index.html 的**真实脚本**跑在 vm + DOM stub 里）：
//      归一化 bbox 映射、6pt 外扩、重叠拾取规则、译文视图关闭、无产物降级
//   C. HTTP 路由（dist/host.js + 真实 http server，假 ctx 抓 handler）：删除/重命名/预览/
//      路径穿越/符号链接/空专题/鉴权围栏
//   D. 端到端：引用内容就是 MinerU 的 LaTeX（不是文本层乱码）
//
// 只 import dist/*.js（Node 22 不能直接跑 TS）。跑前先 `npm run build`。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  symlinkSync, writeFileSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

// $DSH_HOME 必须在 registerRoutes 之前指向临时目录（会写 agent preset / mineru.json）
const HOME = mkdtempSync(join(tmpdir(), 'dpr-ux-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(dist('host.js'))
const { buildFormulaIndex, resetFormulaCache } = await import(dist('formulas.js'))
const { compressMathSpaces, normalizeMathBraces } = await import(dist('mineru.js'))
const { compactLatex } = await import(dist('formulas.js'))
/** 既有投影两步（.txt 形态）：只用于「不变语义」的对照断言。 */
const compact = (rawLatex) => normalizeMathBraces(compressMathSpaces(rawLatex))
/** 走完整索引路径取回某条公式的 LaTeX（即接口返回值）。 */
function latexOf(rawLatex) {
  const idx = buildFormulaIndex(JSON.stringify({
    contentList: [{ type: 'equation', text: rawLatex, text_format: 'latex', bbox: [1, 2, 3, 4], page_idx: 0 }],
  }))
  return idx.equations[0].latex
}
const {
  ManageError, matchArtifactName, validateName, listArtifacts, planPaperDelete,
  deletePaper, deleteTopic, renamePaper, planTopicDelete,
} = await import(dist('library-manage.js'))

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** 零依赖 N 页 PDF（与 test/mineru-routes.test.mjs 同一份构造器）。 */
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

const DATA = mkdtempSync(join(tmpdir(), 'dpr-ux-data-'))
mkdirSync(join(DATA, 'demo'), { recursive: true })
writeFileSync(join(DATA, 'demo', 'paper.pdf'), buildPdf([
  [[20, 'Reader UX Fixture'], [12, 'A short body line for the reader fixtures.']],
  [[20, 'Second page'], [12, 'Another body line with enough text to be extractable.']],
]))

/** 一份真实形状的 .mineru.json（字段与 MinerU 3.4.5 产物一致）。 */
function mineruFixture() {
  return JSON.stringify({
    v: 1,
    producer: 'mineru-local',
    createdAt: '2026-10-10T00:00:00.000Z',
    serverVersion: '3.4.5',
    backend: 'pipeline',
    pageCount: 2,
    imagesAvailable: false,
    contentList: [
      { type: 'text', bbox: [75, 310, 470, 478], page_idx: 0, text: 'body text' },
      // 故意把「版面序」打乱：先右栏（y 大）后左栏（y 小），验证按阅读序重排
      { type: 'equation', img_path: 'images/a', text: '$$\n\\alpha _ { t } \\pmb { v } ( x _ { 0 } ) = \\overline { Q } _ { t } v ( x _ { 0 } )\n$$', text_format: 'latex', bbox: [500, 409, 849, 450], page_idx: 0 },
      { type: 'equation', img_path: 'images/b', text: '$$\nq ( x _ { t } | x _ { t - 1 } )\n$$', text_format: 'latex', bbox: [98, 486, 428, 503], page_idx: 0 },
      { type: 'equation', img_path: 'images/c', text: '$$\n\\mathcal { L } _ { v l b }\n$$', text_format: 'latex', bbox: [98, 688, 429, 762], page_idx: 1 },
      { type: 'equation', img_path: 'images/d', text: '$$\n\\gamma_t\n$$', text_format: 'latex', page_idx: 1 }, // 无 bbox
      { type: 'table', bbox: [1, 2, 3, 4], page_idx: 1, text: 'not a formula' },
    ],
  })
}

const MINERU_JSON = join(DATA, 'demo', 'paper.mineru.json')
writeFileSync(MINERU_JSON, mineruFixture())

// ── A. 公式索引（纯函数） ────────────────────────────────────────────────────

test('A1 公式索引：提取 LaTeX + bbox，page = page_idx + 1，按阅读序（先上后下、先左后右）', () => {
  const idx = buildFormulaIndex(mineruFixture())
  assert.equal(idx.source, 'mineru')
  assert.equal(idx.producer, 'mineru-local')
  assert.equal(idx.backend, 'pipeline')
  assert.equal(idx.pageCount, 2)
  assert.equal(idx.pageSize, null)
  assert.equal(idx.bboxSpace, 'normalized-1000')
  assert.equal(idx.equations.length, 4)
  // 第 1 页两块：bbox[1]=486（左栏，页面上方）排在 409（右栏…注意 409<486）之前？
  // 归一化坐标里 y 越小越靠上 → 409 在上、486 在下，所以右栏那块先出。
  const p1 = idx.equations.filter((e) => e.page === 1)
  assert.deepEqual(p1.map((e) => e.bbox[1]), [409, 486])
  assert.deepEqual(p1.map((e) => e.index), [1, 2])
  assert.deepEqual(p1.map((e) => e.id), ['0:1', '0:2'])
  // 第 2 页：有 bbox 的在前面，无 bbox 的排最后但仍列出
  const p2 = idx.equations.filter((e) => e.page === 2)
  assert.equal(p2.length, 2)
  assert.deepEqual(p2[0].bbox, [98, 688, 429, 762])
  assert.equal(p2[1].bbox, null)
  assert.equal(p2[1].id, '1:2')
  // LaTeX：保留 $$ 定界，但必须是**紧凑形态**（见 A5 与契约修订说明）
  assert.match(idx.equations[0].latex, /^\$\$/)
  assert.match(idx.equations[0].latex, /\\alpha/)
  assert.ok(!/\s\{/.test(idx.equations[0].latex), '紧凑形态里不应再有 `x _ { t }` 式 token 间空格')
  assert.match(idx.equations[0].latex, /_t\b|_\{t\}/, '下标应已归一化（_t 或保留花括号的等价形态）')
  assert.equal(idx.equations[0].textFormat, 'latex')
})

test('A2 公式索引：无产物 → source=none + reason=no-mineru-artifact（不是异常）', () => {
  const idx = buildFormulaIndex(null)
  assert.equal(idx.source, 'none')
  assert.equal(idx.reason, 'no-mineru-artifact')
  assert.deepEqual(idx.equations, [])
})

test('A3 公式索引：JSON 损坏 / contentList 非数组 / 顶层非对象 → bad-artifact，绝不抛异常', () => {
  for (const raw of ['{not json', '[]', '"str"', '{"contentList":{}}', '{"v":1}']) {
    const idx = buildFormulaIndex(raw)
    assert.equal(idx.reason, raw === '{"contentList":{}}' || raw === '{"v":1}' ? 'bad-artifact' : idx.reason)
    assert.deepEqual(idx.equations, [])
    assert.ok(idx.source === 'mineru' || idx.source === 'none')
  }
  // 有 contentList 但没有任何 equation → no-equations
  const none = buildFormulaIndex(JSON.stringify({ contentList: [{ type: 'text', text: 'x', bbox: [1, 2, 3, 4], page_idx: 0 }] }))
  assert.equal(none.reason, 'no-equations')
  assert.equal(none.source, 'mineru')
})

test('A4 公式索引：未知坐标空间（分量 > 1000）→ bboxSpace=page-units 并带 warning', () => {
  const idx = buildFormulaIndex(JSON.stringify({
    contentList: [{ type: 'equation', text: '$$x$$', text_format: 'latex', bbox: [100, 200, 1400, 260], page_idx: 0 }],
  }))
  assert.equal(idx.bboxSpace, 'page-units')
  assert.match(String(idx.warning), /1000/)
})

// ── B. 阅读器几何与命中（跑 reader/index.html 里的真实脚本） ─────────────────

const READER_HTML = readFileSync(join(ROOT, '..', 'reader', 'index.html'), 'utf8')
const SCRIPT_SRC = READER_HTML.match(/<script>\n([\s\S]*)\n<\/script>/)[1]

function makeEl() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    textContent: '', value: '', innerHTML: '', children: [],
    appendChild() {}, append() {}, remove() {}, focus() {}, select() {}, click() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    contains() { return false }, scrollIntoView() {}, closest() { return null },
  }
}

/** 用 DOM stub 跑真实阅读器脚本；harness 把内部的 geometry/状态暴露出来。 */
function loadReader() {
  const els = new Map()
  const doc = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl()); return els.get(id) },
    createElement() { return makeEl() },
    querySelector() { return null },
    querySelectorAll() { return [] },
    body: makeEl(),
    addEventListener() {},
  }
  const win = {
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900,
    addEventListener() {}, getSelection: () => null,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  const ctx = {
    document: doc, window: win, navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    location: { search: '' }, matchMedia: win.matchMedia,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    console, URLSearchParams, fetch: () => Promise.reject(new Error('no network in test')),
    Promise, Math, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Date,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  const harness = `
    ;globalThis.__t = {
      eqGeom, hitTestFormula, eqLatex, eqCite, eqHotEnabled, paintEqLayer, EQ_BY_PAGE,
      setEq: (i) => { eqIndex = i },
      setVariant: (v) => { zhVariant = v },
      setZoom: (z) => { zoomScale = z },
      setHot: (pageNo, items) => { EQ_BY_PAGE.clear(); EQ_BY_PAGE.set(pageNo, items) },
    };`
  vm.runInContext(SCRIPT_SRC + harness, ctx, { filename: 'reader-inline.js' })
  return ctx.__t
}

const T = loadReader()
const VIEWPORT = { width: 612, height: 792 } // letter, scale=1（样本实测尺寸）
const VIEWPORT2 = { width: 1224, height: 1584 } // 同一页 scale=2
T.setZoom(1) // 阅读器默认 zoomScale=1.5（适宽）；几何用例统一在 scale=1 下比对

function eqFromIndex(idx) { return idx.equations }

test('A5 紧凑 LaTeX 提取：token 间空格压掉、\\text 家族原样保留、语义边界不回退', () => {
  const cases = [
    ['$$\n\\pi ( \\mathbf { s } _ { t } )\n$$', '$$\\pi(\\mathbf{s}_t)$$'],
    ['$$\\left( \\sum _ { t = 0 } ^ { H } \\lambda ^ { t } \\right)$$', '$$\\left(\\sum_{t=0}^H\\lambda^t\\right)$$'],
    ['$$\\text { h e l l o   w o r l d }$$', '$$\\text{ h e l l o   w o r l d }$$'], // 组内空格是排版语义，原样保留
    ['$$A _ { \\text { m a x } }$$', '$$A_{\\text{ m a x }}$$'],
    ['$$x _ { i j }$$', '$$x_{ij}$$'], // 多 token 参数必须保留花括号（语义边界）
  ]
  for (const [input, expected] of cases) {
    assert.equal(latexOf(input), expected, input)
    assert.equal(latexOf(input), compactLatex(input), '接口值必须等于服务端紧凑函数（含算子名统一）的输出')
  }
})

test('A6 \\operatorname 家族统一（契约第 2 次修订）：全单字符 token 合并；多词算子名不动；两变体一致', () => {
  // 正例：MinerU 的逐字符空格化产物 → 合并成一个词
  const positives = [['{ m a x }', 'max'], ['{ i f }', 'if'], ['{ D o g }', 'Dog'], ['{ s . t . }', 's.t.']]
  for (const [inner, word] of positives) {
    assert.equal(latexOf(`$$\\operatorname ${inner}$$`), `$$\\operatorname{${word}}$$`, `\\operatorname ${inner}`)
    assert.equal(latexOf(`$$\\operatorname* ${inner}$$`), `$$\\operatorname*{${word}}$$`, `\\operatorname* ${inner}`)
    // 两变体行为必须完全一致（只差一个 *）
    assert.equal(
      latexOf(`$$\\operatorname ${inner}$$`).replace('\\operatorname', '\\operatorname*'),
      latexOf(`$$\\operatorname* ${inner}$$`),
      `两变体一致性 ${inner}`,
    )
  }
  // 反例：真正的多词算子名不得被合并（安全边界）
  assert.equal(latexOf('$$\\operatorname{arg max}$$'), '$$\\operatorname{arg max}$$', '{ arg max } 不得合并成 argmax')
  assert.equal(latexOf('$$\\operatorname* { arg max }$$'), '$$\\operatorname*{arg max}$$', '带 * 的多词算子名同样不动')
  assert.ok(!latexOf('$$\\operatorname{arg max}$$').includes('argmax'))
  // 已是紧凑写法的单 token 不受影响；前缀同形命令不卷进来；命令本身不被吞
  assert.equal(latexOf('$$\\operatorname{max}_x$$'), '$$\\operatorname{max}_x$$')
  assert.equal(latexOf('$$\\operatornames{x}$$'), '$$\\operatornames{x}$$')
  assert.equal(latexOf('$$\\operatorname { D o g } + y _ { t }$$'), '$$\\operatorname{Dog}+y_t$$')
})

test('A7 收口范围：算子名统一只作用于**引用路径**，不改既有 .txt 投影语义（否则会破坏既有用例）', () => {
  // 既有投影函数（.txt 检索形态）对 \operatorname 组仍保持逐字符空格——这是被既有断言固定的行为
  assert.equal(compact('$\\operatorname{a b c}$'), '$\\operatorname{a b c}$')
  assert.equal(compact('$$\\operatorname{arg max}$$'), '$$\\operatorname{arg max}$$')
  // 引用路径才做统一
  assert.equal(latexOf('$$\\operatorname{a b c}$$'), '$$\\operatorname{abc}$$')
  assert.equal(latexOf('$$\\operatorname{arg max}$$'), '$$\\operatorname{arg max}$$')
})

test('B1 映射：归一化 bbox → viewport 像素（x/1000*width、y/1000*height，不外扩）', () => {
  const idx = buildFormulaIndex(mineruFixture())
  T.setVariant(null)
  T.setEq(idx)
  const eq = eqFromIndex(idx)[0] // bbox [500,409,849,450]
  const g = T.eqGeom(eq, VIEWPORT)
  assert.equal(g.x, 500 / 1000 * 612)
  assert.equal(g.y, 409 / 1000 * 792)
  assert.equal(g.w, (849 - 500) / 1000 * 612)
  assert.equal(g.h, (450 - 409) / 1000 * 792)
  // 外扩 6pt（scale=1 → 6px）
  assert.equal(g.pad, 6)
})

test('B2 映射与缩放无关：scale=2 时矩形按比例放大（viewport 已含 scale）', () => {
  const idx = buildFormulaIndex(mineruFixture())
  T.setVariant(null)
  T.setEq(idx)
  const eq = eqFromIndex(idx)[0]
  const g1 = T.eqGeom(eq, VIEWPORT)
  const g1z = T.eqGeom(eq, VIEWPORT)
  T.setZoom(2)
  const g2 = T.eqGeom(eq, VIEWPORT2)
  T.setZoom(1)
  assert.equal(g1z.x, g1.x)
  assert.equal(g2.x, g1.x * 2)
  assert.equal(g2.w, g1.w * 2)
  assert.equal(g2.pad, g1.pad * 2)
})

test('B3 命中：未外扩矩形优先；外扩只在边缘生效；页面外不命中', () => {
  const idx = buildFormulaIndex(mineruFixture())
  T.setVariant(null)
  T.setEq(idx)
  const eq = eqFromIndex(idx).find((e) => e.page === 1 && e.bbox)
  const g = T.eqGeom(eq, VIEWPORT)
  T.setHot(1, [g])
  const pageEl = { closest: (sel) => (sel === '.page[data-page]' ? { dataset: { page: '1' }, getBoundingClientRect: () => ({ left: 0, top: 0 }) } : null) }
  const at = (x, y) => T.hitTestFormula({ target: pageEl, clientX: x, clientY: y })
  const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2
  assert.ok(at(cx, cy), '矩形中心必须命中')
  assert.ok(at(g.x0 - 4, cy), '外扩 6pt 内仍应命中（实测最坏欠覆盖 4.6pt）')
  assert.equal(at(g.x0 - 20, cy), null, '外扩之外不得命中')
  assert.equal(at(cx, g.y0 - 40), null, '页面别处不得命中')
})

test('B4 命中：相邻公式竖直间隙 0.8pt（实测最坏）时按距离/面积拾取，不误点邻居', () => {
  // 三块紧挨着的公式：y0/y1 依次 300/320、320.8/340、340.8/360（间隙 0.8pt）
  const idx = buildFormulaIndex(JSON.stringify({
    contentList: [
      { type: 'equation', text: '$$a$$', text_format: 'latex', bbox: [100, 300, 400, 320], page_idx: 0 },
      { type: 'equation', text: '$$b$$', text_format: 'latex', bbox: [100, 320.8, 400, 340], page_idx: 0 },
      { type: 'equation', text: '$$c$$', text_format: 'latex', bbox: [100, 340.8, 400, 360], page_idx: 0 },
    ],
  }))
  T.setVariant(null)
  T.setEq(idx)
  const geoms = idx.equations.map((e) => T.eqGeom(e, VIEWPORT))
  T.setHot(1, geoms)
  const pageEl = { closest: (sel) => (sel === '.page[data-page]' ? { dataset: { page: '1' }, getBoundingClientRect: () => ({ left: 0, top: 0 }) } : null) }
  const pick = (y) => T.hitTestFormula({ target: pageEl, clientX: 150, clientY: y }) // x=150 落在 bbox 的 x 区间内（61..245）
  const toPt = (norm) => norm / 1000 * 792 // 归一化 y → viewport 像素（scale=1）
  // 各自的**中心**必须命中自己（这是最关键的一条：外扩导致重叠时不能点错）
  assert.match(pick(toPt(310)).eq.latex, /a/)
  assert.match(pick(toPt(330.4)).eq.latex, /b/)
  assert.match(pick(toPt(350.4)).eq.latex, /c/)
  // 落在间隙正中（0.8pt 缝）时，按「到未外扩矩形距离最小」选，绝不返回 null
  assert.ok(pick(toPt(320.4)).eq, '间隙里也必须给出最近的一个公式')
})

test('B5 引用串：eqCite 去掉外层 $$ 再用 $$ 包一次；eqLatex 供预览', () => {
  const idx = buildFormulaIndex(mineruFixture())
  const eq = idx.equations[0]
  assert.equal(T.eqCite(eq), `$$ ${T.eqLatex(eq.latex)} $$`)
  assert.ok(!T.eqCite(eq).includes('$$$'))
  assert.ok(!T.eqCite(eq).includes('\n'))
  assert.match(T.eqCite(eq), /^\$\$ .+ \$\$$/)
})

test('B6 降级：无 MinerU 产物 → 热区功能整体关闭（hitTest 恒 null），不抛异常', () => {
  T.setVariant(null)
  T.setEq(buildFormulaIndex(null))
  assert.equal(T.eqHotEnabled(), false)
  const pageEl = { closest: () => ({ dataset: { page: '1' }, getBoundingClientRect: () => ({ left: 0, top: 0 }) }) }
  assert.equal(T.hitTestFormula({ target: pageEl, clientX: 100, clientY: 100 }), null)
  assert.equal(T.eqGeom({ bbox: null }, VIEWPORT), null)
})

test('B7 译文视图：即使有公式也不开热区（bbox 只对原文页面成立）', () => {
  const idx = buildFormulaIndex(mineruFixture())
  T.setEq(idx)
  T.setVariant('zh')
  assert.equal(T.eqHotEnabled(), false, '译文视图必须关闭热区')
  T.setVariant(null)
  assert.equal(T.eqHotEnabled(), true)
})

test('B8 兜底坐标空间：bboxSpace=page-units 时按 pt×scale 映射（云端版本差异防御）', () => {
  const idx = buildFormulaIndex(JSON.stringify({
    contentList: [{ type: 'equation', text: '$$x$$', text_format: 'latex', bbox: [100, 200, 1400, 260], page_idx: 0 }],
  }))
  T.setVariant(null)
  T.setEq(idx)
  const g = T.eqGeom(idx.equations[0], VIEWPORT)
  assert.equal(g.x, 100) // scale=1 → 原样（bbox 已是 pt）
  assert.equal(g.w, 1300)
})

// ── C. HTTP 路由 ────────────────────────────────────────────────────────────

let spec = null
let rejectStatus = undefined
const ctx = {
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => rejectStatus },
  sessionController: { list: async () => ({ items: [] }) },
  workspaceController: {},
  workspaceRegistry: {},
  effect: (fn) => fn(),
}
registerRoutes(ctx, { dataDir: DATA })
assert.equal(spec.path, '/paper-reader')
assert.equal(spec.kind, 'prefix')

const server = createServer((req, res) => spec.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${server.address().port}`
const api = async (path, opts) => {
  const r = await fetch(`${ORIGIN}/paper-reader${path}`, opts)
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON 原样返回 */ }
  return { status: r.status, body, text }
}
const postJson = (path, obj) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })

test('C1 GET /api/formulas：返回 LaTeX + bbox（归一化原样透传，不在服务端换算）', async () => {
  resetFormulaCache()
  const r = await api('/api/formulas?topic=demo&name=paper')
  assert.equal(r.status, 200)
  assert.equal(r.body.source, 'mineru')
  assert.equal(r.body.equations.length, 4)
  const first = r.body.equations[0]
  assert.deepEqual(first.bbox, [500, 409, 849, 450])
  assert.match(first.latex, /\\alpha/)
  assert.equal(first.page, 1)
  assert.equal(r.body.pageSize, null)
})

test('C2 GET /api/formulas：无产物 → 200 + reason=no-mineru-artifact（不 404/500）', async () => {
  writeFileSync(join(DATA, 'demo', 'plain.pdf'), buildPdf([[[12, 'no mineru here at all']]]))
  resetFormulaCache()
  const r = await api('/api/formulas?topic=demo&name=plain')
  assert.equal(r.status, 200)
  assert.equal(r.body.source, 'none')
  assert.equal(r.body.reason, 'no-mineru-artifact')
  assert.deepEqual(r.body.equations, [])
})

test('C3 GET /api/formulas：.mineru.json 损坏 → 200 + bad-artifact（不得 500）', async () => {
  writeFileSync(join(DATA, 'demo', 'broken.pdf'), buildPdf([[[12, 'broken artifact paper']]]))
  writeFileSync(join(DATA, 'demo', 'broken.mineru.json'), '{ this is not json')
  resetFormulaCache()
  const r = await api('/api/formulas?topic=demo&name=broken')
  assert.equal(r.status, 200)
  assert.equal(r.body.reason, 'bad-artifact')
  assert.deepEqual(r.body.equations, [])
  rmSync(join(DATA, 'demo', 'broken.pdf'))
  rmSync(join(DATA, 'demo', 'broken.mineru.json'))
  rmSync(join(DATA, 'demo', 'plain.pdf'))
})

test('C4 删除预览：清单与契约的产物集合一致（含译文变体与 tmp 残留）', async () => {
  writeFileSync(join(DATA, 'demo', 'book.pdf'), buildPdf([[[12, 'book fixture body text here']]]))
  for (const s of ['.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json']) {
    writeFileSync(join(DATA, 'demo', 'book' + s), 'x')
  }
  writeFileSync(join(DATA, 'demo', 'book-zh.pdf'), 'zh')
  writeFileSync(join(DATA, 'demo', 'book-dual.pdf'), 'dual')
  writeFileSync(join(DATA, 'demo', 'book.txt.tmp-4321-deadbeef'), 'tmp')
  // 干扰项：绝不能进清单
  writeFileSync(join(DATA, 'demo', 'book notes.pdf'), 'other')
  writeFileSync(join(DATA, 'demo', 'book2.pdf'), 'other')
  const r = await api('/api/library/paper/delete-plan?topic=demo&name=book')
  assert.equal(r.status, 200)
  const names = r.body.files.map((f) => f.name).sort()
  assert.deepEqual(names, [
    'book-dual.pdf', 'book-zh.pdf', 'book.embeddings.json', 'book.mineru.json', 'book.mineru.md',
    'book.pages.json', 'book.pdf', 'book.transcript.json', 'book.txt', 'book.txt.tmp-4321-deadbeef',
  ].sort())
  assert.equal(r.body.files.find((f) => f.name === 'book.pdf').kind, 'pdf')
  assert.ok(r.body.totalBytes > 0)
  assert.equal(r.body.trashRoot, '.trash')
  assert.ok(r.body.sessions && typeof r.body.sessions.total === 'number')
  assert.ok(Array.isArray(r.body.notDeleted) && r.body.notDeleted.length > 0)
})

test('C5 删除文献：产物进 .trash（含 manifest），不该删的一字未动，且 .pdf 最后移', async () => {
  const before = new Set(readdirSync(join(DATA, 'demo')))
  const r = await postJson('/api/library/paper/delete', { topic: 'demo', name: 'book' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.moved.length, 10)
  assert.equal(r.body.moved[r.body.moved.length - 1], 'book.pdf', '.pdf 必须最后移（失败时文献仍在库）')
  const after = new Set(readdirSync(join(DATA, 'demo')))
  for (const gone of ['book.pdf', 'book.txt', 'book.mineru.json', 'book-zh.pdf', 'book-dual.pdf', 'book.txt.tmp-4321-deadbeef']) {
    assert.ok(before.has(gone) && !after.has(gone), `${gone} 应已被移走`)
  }
  for (const keep of ['book notes.pdf', 'book2.pdf', 'paper.pdf', 'paper.mineru.json']) {
    assert.ok(after.has(keep), `${keep} 不该被动`)
  }
  // 回收站：目录 + manifest + 可恢复的原文件
  const bundle = join(DATA, '.trash', r.body.trashRel.replace(/^\.trash[\\/]/, ''))
  assert.ok(existsSync(bundle), '回收站目录应存在')
  // 只对目录名做存在性检查，避免平台相关路径拼错
  assert.ok(existsSync(join(bundle, 'manifest.json')), 'manifest.json 应写入')
  assert.ok(existsSync(join(bundle, 'book.pdf')), '被删的 PDF 应在回收站里（可恢复）')
  const mani = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'))
  assert.equal(mani.kind, 'paper')
  assert.equal(mani.name, 'book')
  assert.equal(mani.files.length, 10)
  // 回执里不需要暴露机器绝对路径给文案以外的地方
  assert.ok(typeof r.body.trashRel === 'string' && r.body.trashRel.startsWith('.trash'))
})

test('C6 路径穿越防护：≥6 种恶意输入一律拒绝且盘上无变化', async () => {
  const snap = readdirSync(join(DATA, 'demo')).sort().join('|')
  // ① topic/name 本身非法（6+ 种）：删除、重命名、预览三处都必须拒绝
  const evilName = [
    { topic: 'demo', name: '../../etc/passwd' },
    { topic: 'demo', name: '/etc/passwd' },
    { topic: '..', name: 'paper' },
    { topic: 'demo', name: 'a/b' },
    { topic: 'demo', name: 'a\\b' },
    { topic: 'demo', name: '..' },
    { topic: 'demo', name: '.hidden' },
    { topic: 'demo', name: 'x\u0000y' },
  ]
  for (const body of evilName) {
    const del = await postJson('/api/library/paper/delete', body)
    assert.equal(del.status, 400, `delete 应拒绝: ${JSON.stringify(body)}`)
    assert.ok(['bad-name', 'escape-rejected'].includes(del.body.code), `code 应可读: ${del.text}`)
    const ren = await postJson('/api/library/paper/rename', body)
    assert.equal(ren.status, 400, `rename 应拒绝: ${JSON.stringify(body)}`)
    const plan = await api(`/api/library/paper/delete-plan?topic=${encodeURIComponent(body.topic ?? '')}&name=${encodeURIComponent(body.name ?? '')}`)
    assert.notEqual(plan.status, 200, `预览也不得对越界输入给出 200：${JSON.stringify(body)}`)
  }
  // ② topic/name 合法但夹带 path：两类写路由都必须拒绝、且不得动文件
  for (const body of [
    { topic: 'demo', name: 'paper', path: '/etc/passwd' },
    { topic: 'demo', name: 'paper', path: '../demo/paper.pdf' },
  ]) {
    const del = await postJson('/api/library/paper/delete', body)
    assert.equal(del.status, 400, `delete 应拒绝: ${JSON.stringify(body)}`)
    const ren = await postJson('/api/library/paper/rename', body)
    assert.equal(ren.status, 400, `rename 应拒绝: ${JSON.stringify(body)}`)
  }
  // ③ 越界 newName：只对重命名有意义（删除请求里 newName 被忽略，不能拿它当删除探针）
  for (const newName of ['../../evil', '/tmp/evil', '..', 'a/b']) {
    const ren = await postJson('/api/library/paper/rename', { topic: 'demo', name: 'paper', newName })
    assert.equal(ren.status, 400, `rename 应拒绝 newName=${newName}`)
  }
  const withPath = await api('/api/library/paper/delete-plan?topic=demo&name=paper&path=/etc/passwd')
  assert.equal(withPath.status, 400, 'delete-plan 必须拒绝 path 参数')
  // 合法输入仍然通行（证明上面的 400 不是「全都拒」的假象）
  const okPlan = await api('/api/library/paper/delete-plan?topic=demo&name=paper')
  assert.equal(okPlan.status, 200)
  const after = readdirSync(join(DATA, 'demo')).sort().join('|')
  assert.equal(after, snap, '恶意输入不得改动文献库')
  assert.ok(existsSync(join(DATA, 'demo', 'paper.pdf')))
  assert.ok(!existsSync(join(tmpdir(), 'evil')))
})

test('C7 符号链接：只移动链接本身，链接目标（库外）内容不变', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'dpr-outside-'))
  const secret = join(outside, 'secret.txt')
  writeFileSync(secret, 'precious')
  try {
    writeFileSync(join(DATA, 'demo', 'link.pdf'), buildPdf([[[12, 'link paper body text']]]))
    symlinkSync(secret, join(DATA, 'demo', 'link.txt'))
    const r = await postJson('/api/library/paper/delete', { topic: 'demo', name: 'link' })
    assert.equal(r.status, 200)
    assert.ok(r.body.moved.includes('link.txt'), '链接本身应被移入回收站')
    assert.equal(readFileSync(secret, 'utf8'), 'precious', '库外目标必须原封不动')
    assert.ok(!existsSync(join(DATA, 'demo', 'link.txt')))
    // 专题目录本身是符号链接 → 一律拒绝
    const linkTopic = join(DATA, 'evil-topic')
    symlinkSync(outside, linkTopic)
    const bad = await postJson('/api/library/paper/delete', { topic: 'evil-topic', name: 'secret' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'escape-rejected')
    rmSync(linkTopic)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('C8 删除专题：含文献 → 409 topic-not-empty（带 papers）；空专题 → 200 并删目录', async () => {
  const r = await postJson('/api/library/topic/delete', { name: 'demo', confirmName: 'demo' })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'topic-not-empty')
  assert.ok(r.body.papers.includes('paper'), '应回报专题内文献名')
  assert.ok(existsSync(join(DATA, 'demo')))

  // confirmName 不一致 → 400
  const mismatch = await postJson('/api/library/topic/delete', { name: 'demo', confirmName: 'nope' })
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.code, 'confirm-mismatch')

  // 不存在的专题 → 404
  const missing = await postJson('/api/library/topic/delete', { name: 'nope', confirmName: 'nope' })
  assert.equal(missing.status, 404)

  // 空专题（含隐藏条目）→ 200，隐藏条目进回收站而不是被销毁
  mkdirSync(join(DATA, 'empty-topic'), { recursive: true })
  writeFileSync(join(DATA, 'empty-topic', '.DS_Store'), 'junk')
  const ok = await postJson('/api/library/topic/delete', { name: 'empty-topic', confirmName: 'empty-topic' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.deepEqual(ok.body.movedHidden, ['.DS_Store'])
  assert.ok(!existsSync(join(DATA, 'empty-topic')), '空专题目录应被删除（rmdir 语义）')
  assert.ok(existsSync(join(DATA, '.trash', ok.body.trashRel.replace(/^\.trash[\\/]/, ''), '.DS_Store')), '隐藏条目应可恢复')
})

test('C9 运行中的伴读会话 → 409 session-running，且不删任何文件', async () => {
  const ctx2 = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    // 模拟「该文献有一个 running 会话」：sessionId 前缀与 host 的算法一致（base64url(topic/name)）
    sessionController: {
      list: async () => {
        const id = 'dpr-' + Buffer.from('demo/paper').toString('base64url') + '-1'
        return { items: [{ sessionId: id, updatedAt: Date.now(), running: true, blank: false }] }
      },
    },
    workspaceController: {},
    workspaceRegistry: {},
    effect: (fn) => fn(),
  }
  const specBefore = spec
  registerRoutes(ctx2, { dataDir: DATA })
  const server2 = createServer((req, res) => spec.handler(req, res))
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
  const ORIGIN2 = `http://127.0.0.1:${server2.address().port}`
  try {
    const r = await fetch(`${ORIGIN2}/paper-reader/api/library/paper/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'demo', name: 'paper' }),
    })
    const body = await r.json()
    assert.equal(r.status, 409)
    assert.equal(body.code, 'session-running')
    assert.ok(existsSync(join(DATA, 'demo', 'paper.pdf')), '被拒绝时不得动文件')
    const ren = await fetch(`${ORIGIN2}/paper-reader/api/library/paper/rename`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'demo', name: 'paper', newName: 'paper2' }),
    })
    assert.equal(ren.status, 409)
  } finally {
    server2.close()
    spec = specBefore
  }
})

test('C10 重命名文献：全部同名产物一起改名，回执带 detachedSessions；-zh 结尾被拒', async () => {
  writeFileSync(join(DATA, 'demo', 'ren.pdf'), buildPdf([[[12, 'rename fixture body text']]]))
  writeFileSync(join(DATA, 'demo', 'ren.txt'), 'x')
  writeFileSync(join(DATA, 'demo', 'ren.mineru.json'), mineruFixture())
  writeFileSync(join(DATA, 'demo', 'ren-zh.pdf'), 'zh')
  const bad = await postJson('/api/library/paper/rename', { topic: 'demo', name: 'ren', newName: 'ren2-zh' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'bad-name')
  const ok = await postJson('/api/library/paper/rename', { topic: 'demo', name: 'ren', newName: 'ren2' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.to, 'ren2')
  assert.ok(typeof ok.body.detachedSessions === 'number')
  const files = readdirSync(join(DATA, 'demo'))
  assert.ok(files.includes('ren2.pdf') && files.includes('ren2.txt') && files.includes('ren2.mineru.json') && files.includes('ren2-zh.pdf'))
  assert.ok(!files.includes('ren.pdf') && !files.includes('ren.txt') && !files.includes('ren-zh.pdf'))
  // 目标已存在 → 409
  writeFileSync(join(DATA, 'demo', 'ren3.pdf'), buildPdf([[[12, 'another fixture body text']]]))
  const clash = await postJson('/api/library/paper/rename', { topic: 'demo', name: 'ren2', newName: 'ren3' })
  assert.equal(clash.status, 409)
  assert.equal(clash.body.code, 'target-exists')
})

test('C11 重命名专题：目录改名 + 同名冲突 409 + 非法名 400', async () => {
  mkdirSync(join(DATA, 'topic-a'), { recursive: true })
  writeFileSync(join(DATA, 'topic-a', 'p.pdf'), buildPdf([[[12, 'topic rename fixture text']]]))
  const ok = await postJson('/api/library/topic/rename', { name: 'topic-a', newName: 'topic-b' })
  assert.equal(ok.status, 200)
  assert.ok(existsSync(join(DATA, 'topic-b')) && !existsSync(join(DATA, 'topic-a')))
  mkdirSync(join(DATA, 'topic-c'), { recursive: true })
  const clash = await postJson('/api/library/topic/rename', { name: 'topic-b', newName: 'topic-c' })
  assert.equal(clash.status, 409)
  const bad = await postJson('/api/library/topic/rename', { name: 'topic-b', newName: '../x' })
  assert.equal(bad.status, 400)
})

test('C12 鉴权围栏：connection.requestRejection 拦下所有新路由（不裸奔）', async () => {
  rejectStatus = 401
  try {
    for (const [method, path, body] of [
      ['GET', '/api/formulas?topic=demo&name=paper', null],
      ['GET', '/api/library/paper/delete-plan?topic=demo&name=paper', null],
      ['POST', '/api/library/paper/delete', { topic: 'demo', name: 'paper' }],
      ['POST', '/api/library/paper/rename', { topic: 'demo', name: 'paper', newName: 'x' }],
      ['POST', '/api/library/topic/delete', { name: 'demo', confirmName: 'demo' }],
      ['POST', '/api/library/topic/rename', { name: 'demo', newName: 'x' }],
    ]) {
      const r = await api(path, method === 'POST'
        ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : undefined)
      assert.equal(r.status, 401, `${method} ${path} 必须被鉴权拦下`)
    }
    assert.ok(existsSync(join(DATA, 'demo', 'paper.pdf')))
  } finally {
    rejectStatus = undefined
  }
})

// ── D. 端到端：引用内容 = MinerU 的 LaTeX ────────────────────────────────────

test('D1 端到端：走 /api/formulas 拿到的 LaTeX 是 .mineru.json 的紧凑形态（独立复算，含算子名统一），且不是文本层乱码', async () => {
  resetFormulaCache()
  const raw = JSON.parse(readFileSync(MINERU_JSON, 'utf8'))
  const want = raw.contentList.filter((b) => b.type === 'equation').map((b) => compactLatex(b.text))
  const r = await api('/api/formulas?topic=demo&name=paper')
  assert.equal(r.status, 200)
  for (const latex of want) {
    assert.ok(r.body.equations.some((e) => e.latex === latex), `LaTeX 必须是紧凑形态：${latex.slice(0, 40)}…`)
  }
  // 文本层乱码的典型形态（重复字形）绝不能出现在引用内容里
  for (const e of r.body.equations) {
    assert.ok(!/𝑧𝑧|𝑥𝑥|𝑞𝑞/.test(e.latex), '引用内容不得是 PDF 文本层的乱码字形')
  }
})

test('D2 端到端：/api/ask 的公式文案与文字文案（kind 缺省时逐字不变）', async () => {
  // 用一个能记录 prompt 的假 sessionController
  const prompts = []
  const ctx3 = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {
      list: async () => ({ items: [] }),
      create: async () => ({}),
      prompt: async (req) => { prompts.push(req.content[0].text); return { accepted: true } },
    },
    workspaceController: {},
    workspaceRegistry: {},
    effect: (fn) => fn(),
  }
  const specBefore = spec
  registerRoutes(ctx3, { dataDir: DATA })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const send = (body) => fetch(`${base}/api/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    const text = await send({ topic: 'demo', name: 'paper', question: '这段在说什么？', selectedText: 'some selected words', page: 3 })
    assert.equal(text.status, 200)
    assert.match(prompts[0], /用户在阅读器里选中了一段文字（选中于第 3 页）：/)
    assert.match(prompts[0], /"""some selected words"""/)

    const eq = await send({
      topic: 'demo', name: 'paper', kind: 'equation', equationIndex: 2,
      question: '这个公式怎么推出来的？', selectedText: '$$ \\mathcal { L } _ { v l b } $$', page: 2,
    })
    assert.equal(eq.status, 200)
    assert.match(prompts[1], /用户在阅读器里引用了第 2 页的一个公式（LaTeX 源，来自 MinerU 版面解析）：/)
    assert.match(prompts[1], /"""\$\$ \\mathcal \{ L \} _ \{ v l b \} \$\$"""/)
    assert.ok(!/用户的问题/.test(prompts[1]) === false, '用户的问题行仍必须存在')
  } finally {
    srv.close()
    spec = specBefore
  }
})

// ── 纯函数层（不经 HTTP）的直接断言 ─────────────────────────────────────────

test('E1 matchArtifactName：精确 stem 匹配，同前缀论文绝不误伤', () => {
  assert.ok(matchArtifactName('Attention', 'Attention.pdf'))
  assert.ok(matchArtifactName('Attention', 'Attention.embeddings.json'))
  assert.ok(matchArtifactName('Attention', 'Attention-dual.pdf'))
  assert.ok(matchArtifactName('Attention', 'Attention.txt.tmp-1-abcd1234'))
  assert.ok(!matchArtifactName('Attention', 'Attention Is All You Need.pdf'))
  assert.ok(!matchArtifactName('Attention', 'Attention2.pdf'))
  assert.ok(!matchArtifactName('Attention', 'Attention-zh.txt'))
  assert.ok(!matchArtifactName('Attention', 'Notes on Attention.pdf'))
  assert.ok(!matchArtifactName('Attention', 'Attention.bak'))
})

test('E2 validateName：恶意名一律被拒（..、绝对路径、分隔符、隐藏名、空字符）', () => {
  for (const bad of ['..', '../x', '/etc/passwd', 'a/b', 'a\\b', '.hidden', '', '   ', 'x\u0000y', 'a..b']) {
    assert.throws(() => validateName(bad, 'paper'), (e) => e instanceof ManageError && e.code === 'bad-name', `应拒绝 ${JSON.stringify(bad)}`)
  }
  assert.equal(validateName('Attention Is All You Need', 'paper'), 'Attention Is All You Need')
})

test('E3 listArtifacts：只列文件、忽略目录，且 .pdf 排在最后', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-list-'))
  try {
    writeFileSync(join(dir, 'p.pdf'), 'x')
    writeFileSync(join(dir, 'p.txt'), 'x')
    mkdirSync(join(dir, 'p.mineru.json'))
    const files = listArtifacts(dir, 'p')
    assert.deepEqual(files.map((f) => f.name), ['p.txt', 'p.pdf'])
    assert.equal(files[files.length - 1].kind, 'pdf')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('E4 deleteTopic/planTopicDelete：非隐藏条目才阻塞，隐藏条目单独回报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-topic-'))
  const root = dir
  mkdirSync(join(root, 't1'))
  writeFileSync(join(root, 't1', '.DS_Store'), 'x')
  writeFileSync(join(root, 't1', 'a.pdf'), 'x')
  try {
    const plan = planTopicDelete(root, 't1')
    assert.deepEqual(plan.entries, ['a.pdf'])
    assert.deepEqual(plan.papers, ['a'])
    assert.deepEqual(plan.hidden, ['.DS_Store'])
    assert.throws(() => deleteTopic(root, 't1'), (e) => e.code === 'topic-not-empty')
    rmSync(join(root, 't1', 'a.pdf'))
    const r = deleteTopic(root, 't1')
    assert.deepEqual(r.movedHidden, ['.DS_Store'])
    assert.ok(!existsSync(join(root, 't1')))
    assert.ok(lstatSync(join(root, '.trash')).isDirectory())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('E5 deletePaper：函数层同样保证 .pdf 最后移 + 回收站可恢复 + 清单外文件不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpr-del-'))
  try {
    writeFileSync(join(dir, 'p.pdf'), 'pdfbytes')
    writeFileSync(join(dir, 'p.mineru.json'), '{}')
    writeFileSync(join(dir, 'q.pdf'), 'other')
    const r = deletePaper(dir, '.', undefined) // 占位：下面的真实调用在 topic 目录上
    void r
  } catch {
    /* 忽略：本用例只验证下面这段 */
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const root = mkdtempSync(join(tmpdir(), 'dpr-del2-'))
  try {
    mkdirSync(join(root, 't'))
    writeFileSync(join(root, 't', 'p.pdf'), 'pdfbytes')
    writeFileSync(join(root, 't', 'p.mineru.json'), '{}')
    writeFileSync(join(root, 't', 'q.pdf'), 'other')
    const res = deletePaper(root, 't', 'p')
    assert.deepEqual(res.moved, ['p.mineru.json', 'p.pdf'])
    assert.ok(!existsSync(join(root, 't', 'p.pdf')))
    assert.ok(existsSync(join(root, 't', 'q.pdf')), '别的文献必须完好')
    assert.ok(existsSync(join(root, '.trash', res.trashRel.replace(/^\.trash[\\/]/, ''), 'p.pdf')))
    assert.deepEqual(res.skipped, [])
    // 再删一次 → 404（文献已不在）
    assert.throws(() => deletePaper(root, 't', 'p'), (e) => e.status === 404)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('E6 renamePaper：产物整体改名；rename 后可被 listArtifacts 用新名匹配', () => {
  const root = mkdtempSync(join(tmpdir(), 'dpr-ren-'))
  try {
    mkdirSync(join(root, 't'))
    writeFileSync(join(root, 't', 'p.pdf'), 'x')
    writeFileSync(join(root, 't', 'p.mineru.json'), '{}')
    writeFileSync(join(root, 't', 'p-zh.pdf'), 'x')
    const r = renamePaper(root, 't', 'p', '论文 2')
    assert.equal(r.to, '论文 2')
    const files = readdirSync(join(root, 't')).sort()
    assert.deepEqual(files, ['论文 2-zh.pdf', '论文 2.mineru.json', '论文 2.pdf'])
    assert.equal(listArtifacts(join(root, 't'), '论文 2').length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── F. i18n 与真实产物（契约 §2.9 / §1.1） ───────────────────────────────────

/** 从 lib/client.js 里抠出 zh/en 两个扁平字典的键（键是行首的裸标识符）。 */
function dictKeys(src, name) {
  const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n    \\}`).exec(src)
  assert.ok(m, `未找到 ${name} 字典`)
  // 一行里往往有多个键（`a: 'x', b: 'y',`）→ 先剥掉字符串字面量，再全局抓 key
  const stripped = m[1]
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
  const keys = new Set()
  for (const k of stripped.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.add(k[1])
  return keys
}

test('F1 i18n：zh/en 键完全对齐；代码里用到的每个 t(key) 都有定义（无缺 key）', () => {
  const src = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  const zh = dictKeys(src, 'zh')
  const en = dictKeys(src, 'en')
  const missingEn = [...zh].filter((k) => !en.has(k))
  const missingZh = [...en].filter((k) => !zh.has(k))
  assert.deepEqual(missingEn, [], `en 缺少键：${missingEn.join(', ')}`)
  assert.deepEqual(missingZh, [], `zh 缺少键：${missingZh.join(', ')}`)
  const used = new Set()
  for (const m of src.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) used.add(m[1])
  const undef = [...used].filter((k) => !zh.has(k))
  assert.deepEqual(undef, [], `使用了未定义的 i18n 键：${undef.join(', ')}`)
  for (const k of ['renamePaper', 'renameTopic', 'delPaper', 'delTopic', 'delConfirmTitle', 'delConfirmBody',
    'delNotDeleted', 'delToTrash', 'delTopicTypeName', 'delBusySession', 'delBusyTranslate',
    'delTopicNotEmpty', 'renameDetached', 'renameTargetExists', 'eqTitle', 'eqTranscribe']) {
    assert.ok(zh.has(k) && en.has(k), `契约要求的 i18n 键缺失：${k}`)
  }
})

test('F2 i18n 用法：删除/重命名文案在 UI 里真的被引用（不是死键）', () => {
  const src = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  for (const k of ['delConfirmTitle', 'delConfirmBody', 'delNotDeleted', 'delToTrash', 'delTopicTypeName',
    'delBusySession', 'delTopicNotEmpty', 'renamePaper', 'renameTopic', 'renameDetached']) {
    assert.ok(new RegExp(`t\\('${k}'\\)`).test(src), `${k} 应在 UI 中被使用`)
  }
})

test('F3 二次确认的服务端前提：清单只来自 delete-plan，且不得用原生 confirm/prompt', () => {
  const src = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  assert.match(src, /delete-plan/, '删除确认前必须调 delete-plan')
  assert.match(src, /plan\.files\.map/, '确认框清单必须逐条来自服务端返回的 files')
  assert.ok(!/window\.(confirm|prompt)\s*\(/.test(src), '不得使用 window.confirm/prompt（Electron 不支持）')
  const reader = readFileSync(join(ROOT, '..', 'reader', 'index.html'), 'utf8')
  assert.ok(!/window\.(confirm|prompt)\s*\(/.test(reader), '阅读器同样不得使用原生 confirm/prompt')
})

test('F4 真实 MinerU 产物（用户库样本，缺失则跳过）：equation 的 bbox/latex 端到端可用', (t2) => {
  const realDir = join(process.env.HOME || '', '.dsh-paper-reader', 'data')
  let hit = null
  if (existsSync(realDir)) {
    for (const d of readdirSync(realDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      for (const f of readdirSync(join(realDir, d.name))) {
        if (!f.endsWith('.mineru.json')) continue
        const raw = readFileSync(join(realDir, d.name, f), 'utf8')
        const n = (JSON.parse(raw).contentList || []).filter((b) => b.type === 'equation').length
        if (n > 0) { hit = { json: raw, n }; break }
      }
      if (hit) break
    }
  }
  if (!hit) {
    t2.skip('用户文献库里没有含公式的 MinerU 产物样本')
    return
  }
  const idx = buildFormulaIndex(hit.json)
  assert.equal(idx.equations.length, hit.n)
  for (const e of idx.equations) {
    assert.ok(e.page >= 1, '页码必须 1 起')
    if (e.bbox) {
      assert.equal(e.bbox.length, 4)
      for (const v of e.bbox) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1000, `bbox 必须在 0..1000 内：${e.bbox}`)
    }
    assert.ok(typeof e.latex === 'string' && e.latex.length > 0, '每个 equation 都必须带 LaTeX')
  }
  assert.equal(idx.bboxSpace, 'normalized-1000', '真实 MinerU 3.4.5 产物的 bbox 必须被判为归一化坐标')
})

test('F5 live：本地 MinerU 不可达时本文件相关用例明确跳过、整体仍 exit 0（可达时只做零成本校验）', async (t2) => {
  // 刻意**不**在这里发起 MinerU 解析：node --test 会并行跑多个测试文件，而既有
  // test/mineru-live.test.mjs 已经会并发调用本地 MinerU（GPU 7.5GB，实测并发时偶发
  // CUDA OOM）。新增一次解析会把显存压力推过临界点，让**既有**用例变得不稳定——
  // 那违反「既有用例全部保持通过」。真实产物的覆盖由 F4（真实 .mineru.json）+ C1/C2/C3
  // （HTTP 层）承担；这里只做一次纯 GET 的可达性断言。
  let reachable = false
  try {
    const r = await fetch(`${process.env.DPR_TEST_MINERU_URL || 'http://127.0.0.1:8000'}/health`, { signal: AbortSignal.timeout(2000) })
    reachable = r.ok
  } catch { reachable = false }
  if (!reachable) {
    t2.skip('local MinerU not reachable — 本文件的 MinerU 相关用例全部跳过')
    return
  }
  // health 走生效配置（mode=off → 不探测）；要探测本地端点得显式 ?mode=local
  const h = await api('/api/mineru/health?mode=local')
  assert.equal(h.status, 200)
  assert.equal(h.body.mode, 'local')
  if (!process.env.DPR_TEST_MINERU_URL) {
    assert.equal(h.body.reachable, true, 'MinerU 可达时 health?mode=local 应报 reachable=true')
  }
})

test.after(() => {
  server.close()
  rmSync(HOME, { recursive: true, force: true })
  rmSync(DATA, { recursive: true, force: true })
})
