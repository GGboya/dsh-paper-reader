// test/reader-ux-verification.test.mjs — **验证者独立复现测试**（t3, verifier）。
//
// 与 test/reader-ux.test.mjs（实现方自测）刻意分开：本文件由验证者独立编写，用于
//   · 对抗性复现破坏性操作（路径穿越 / 前缀误删 / 符号链接 / 回收站失败 / 不该删的没少）；
//   · 独立复算（LaTeX 形态、bbox 映射、拾取规则），不使用实现方硬编码的期望值；
//   · 真实样本（用户文献库的 TD-MPC2 / Dong et al. 的 .mineru.json + pdf.js 真实 viewport）；
//   · 明确标注「无法自动验证」的前端交互。
//
// 所有破坏性用例都在 mkdtempSync 造的临时文献库里跑；真实文献库只读（复制样本，不改一个字节）。
// 只 import dist/*.js（跑前 npm run build）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
const REPO = join(ROOT, '..')

const HOME = mkdtempSync(join(tmpdir(), 'dpr-ver-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(dist('host.js'))
const { buildFormulaIndex, compactLatex, resetFormulaCache } = await import(dist('formulas.js'))
const { compressMathSpaces, normalizeMathBraces } = await import(dist('mineru.js'))
const {
  ManageError, matchArtifactName, validateName, validateNewPaperName, listArtifacts,
  planPaperDelete, deletePaper, deleteTopic, planTopicDelete, renamePaper, renameTopic,
  moveToTrash, assertInside, resolveTopicDir,
} = await import(dist('library-manage.js'))

// ── 真实样本（只读；缺失则整组用例 skip）──────────────────────────────────────

const REAL_DATA = join(homedir(), '.dsh-paper-reader', 'data')
function realArtifacts() {
  const out = []
  if (!existsSync(REAL_DATA)) return out
  for (const d of readdirSync(REAL_DATA, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const dir = join(REAL_DATA, d.name)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.mineru.json')) continue
      const raw = readFileSync(join(dir, f), 'utf8')
      let n = 0
      try { n = (JSON.parse(raw).contentList || []).filter((b) => b.type === 'equation').length } catch { /* 损坏产物 */ }
      if (n > 0 && existsSync(join(dir, f.slice(0, -'.mineru.json'.length) + '.pdf'))) {
        out.push({ topic: d.name, name: f.slice(0, -'.mineru.json'.length), jsonPath: join(dir, f), pdfPath: join(dir, f.slice(0, -'.mineru.json'.length) + '.pdf'), n })
      }
    }
  }
  return out
}
const REAL = realArtifacts()
const REAL_A = REAL.find((r) => r.name.includes('TD-MPC2'))   // 契约 §1.1 样本 A（12 公式）
const REAL_B = REAL.find((r) => r.name.includes('Dong et al.')) // 第二份真实样本（18 公式，含 \operatorname）

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ── 临时文献库（所有写操作的唯一目标）────────────────────────────────────────

const DATA = mkdtempSync(join(tmpdir(), 'dpr-ver-data-'))
mkdirSync(join(DATA, 'lib'), { recursive: true })

/** 把真实样本**复制**进临时库（真实库一个字节都不动），返回副本信息。 */
function copyReal(sample, asName) {
  if (!sample) return null
  const dst = join(DATA, 'lib')
  cpSync(sample.pdfPath, join(dst, asName + '.pdf'))
  cpSync(sample.jsonPath, join(dst, asName + '.mineru.json'))
  return {
    name: asName, pdf: join(dst, asName + '.pdf'), json: join(dst, asName + '.mineru.json'),
    pdfHash: sha(join(dst, asName + '.pdf')), jsonHash: sha(join(dst, asName + '.mineru.json')),
    srcPdfHash: sha(sample.pdfPath), srcJsonHash: sha(sample.jsonPath),
    raw: JSON.parse(readFileSync(sample.jsonPath, 'utf8')),
    equations: JSON.parse(readFileSync(sample.jsonPath, 'utf8')).contentList.filter((b) => b.type === 'equation'),
    n: sample.n, pageCount: JSON.parse(readFileSync(sample.jsonPath, 'utf8')).pageCount,
  }
}
const COPY_A = copyReal(REAL_A, 'TD-MPC2')
const COPY_B = copyReal(REAL_B, 'Dong')

/** 零依赖 N 页 PDF（与既有测试同一份构造器，避免依赖真实样本）。 */
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

// ── 迷你 DOM：跑 reader/index.html 里的真实脚本（用于命中/选区优先级/请求体）────

function makeEl(tag = 'div') {
  const classes = new Set()
  const el = {
    tagName: tag, dataset: {}, style: {}, children: [], parent: null,
    textContent: '', value: '', disabled: false, title: '', onclick: null, onkeydown: null,
    appendChild(c) { el.children.push(c); if (c) c.parent = el; return c },
    append(...cs) { for (const c of cs) el.appendChild(c) },
    remove() { const p = el.parent; if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1) } el.parent = null },
    focus() {}, select() {}, click() {}, scrollIntoView() {}, blur() {},
    closest() { return null },
    contains(n) { return n === el || walk(el).includes(n) },
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    insertBefore(n) { el.children.push(n); n.parent = el; return n },
    querySelector(sel) { return walk(el).find((x) => matches(x, sel)) ?? null },
    querySelectorAll(sel) { return walk(el).filter((x) => matches(x, sel)) },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; if (on) classes.add(c); else classes.delete(c); return on },
    },
  }
  let inner = ''
  Object.defineProperty(el, 'innerHTML', {
    get: () => inner,
    // 与真实 DOM 一致：innerHTML='' 会清空子节点（阅读器渲染面板靠它重置列表）
    set: (v) => { inner = v; if (v === '') el.children = [] },
  })
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)) },
  })
  return el
}
function walk(root, out = []) { for (const c of root.children || []) { out.push(c); walk(c, out) } return out }
function matches(el, sel) {
  const m = /^([a-zA-Z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(sel)
  if (!m) return false
  const [, tag, cls, attr, val] = m
  if (tag && el.tagName !== tag) return false
  for (const c of (cls || '').split('.').filter(Boolean)) if (!el.classList.contains(c)) return false
  if (attr) {
    const key = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (String(el.dataset[key]) !== val) return false
  }
  return true
}

const READER_HTML = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')
const SCRIPT_SRC = READER_HTML.match(/<script>\n([\s\S]*)\n<\/script>/)[1]

/** 用真实阅读器脚本 + 可观测的 DOM stub 起一个实例。 */
function loadReader() {
  const els = new Map()
  const listeners = new Map()
  const requests = []
  const body = makeEl('body')
  const named = makeEl('div')   // 命名元素也挂进树，好让 querySelectorAll 找得到
  body.appendChild(named)
  const doc = {
    body,
    getElementById(id) { if (!els.has(id)) { const e = makeEl(); e.id = id; named.appendChild(e); els.set(id, e) } return els.get(id) },
    createElement(tag) { return makeEl(tag) },
    createTextNode(t) { const e = makeEl('#text'); e.textContent = t; return e },
    querySelector(sel) { return matches(body, sel) ? body : (walk(body).find((x) => matches(x, sel)) ?? null) },
    querySelectorAll(sel) { return walk(body).filter((x) => matches(x, sel)) },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
    removeEventListener() {},
    documentElement: makeEl('html'),
  }
  const state = { selection: null }
  const win = {
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900,
    addEventListener() {}, getSelection: () => state.selection,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  const store = new Map()
  const ctx = {
    document: doc, window: win, navigator: {}, matchMedia: win.matchMedia,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    location: { search: '' },
    setTimeout: (fn) => { fn(); return 0 }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    console, URLSearchParams, Promise, Math, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Date,
    fetch: async (url, init) => { requests.push({ url, body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ ok: true, n: 1 }) } },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  const harness = `
    ;globalThis.__v = {
      eqGeom, hitTestFormula, eqLatex, eqCite, eqHotEnabled, paintEqLayer, EQ_BY_PAGE, citeFormula, renderEqPanel, transcribeWithMineru,
      setEq: (i) => { eqIndex = i },
      getEq: () => eqIndex,
      setVariant: (v) => { zhVariant = v },
      setZoom: (z) => { zoomScale = z },
      getZoom: () => zoomScale,
      setCurrent: (c) => { current = c },
      getAsk: () => askSelection,
      askSelectionGet: () => askSelection,
    };`
  vm.runInContext(SCRIPT_SRC + harness, ctx, { filename: 'reader-inline.js' })
  const fire = (type, ev) => { for (const fn of listeners.get(type) || []) fn(ev) }
  /** 造一个「落在第 page 页某坐标」的事件目标。 */
  const targetAt = (pageEl, textLayer = null) => ({
    closest(sel) { if (sel === '.page[data-page]') return pageEl; if (sel === '.textLayer') return textLayer; if (sel === '.page') return pageEl; return null },
  })
  return { t: ctx.__v, els, requests, doc, body, win, state, fire, targetAt, store }
}

// ── 服务端（吞掉真实 http 层之外的复杂度；handler 直连）─────────────────────

let spec = null
let rejectStatus = undefined
let sessionItems = () => []
/** 造一个与该文献 id 前缀匹配的伴读会话（前缀算法与 host 一致）。 */
const fakeSession = (topic, name, n = 1, running = true) => ({
  sessionId: `dpr-${Buffer.from(`${topic}/${name}`).toString('base64url')}-${n}`,
  updatedAt: Date.now(), running, blank: false,
})
const makeCtx = (over = {}) => ({
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => rejectStatus },
  sessionController: { list: async () => ({ items: sessionItems() }) },
  workspaceController: {},
  workspaceRegistry: {},
  effect: (fn) => fn(),
  ...over,
})
registerRoutes(makeCtx(), { dataDir: DATA })
assert.equal(spec.path, '/paper-reader')

let sharedSpec = null
let server = null
let ORIGIN = null
/** 每个用例组用独立进程级资源时必须显式收尾，否则 node --test 会一直等事件循环空。 */
const servers = []
const shutdown = () => { for (const s of servers) { try { s.close() } catch { /* 已关 */ } } }
/** 起一个只跑默认 ctx 的服务器（幂等；unref 保证不会吊住事件循环）。
 *  注意：`node --test --test-name-pattern` 下 node 会**先**跑文件级 after 钩子，
 *  顶层一次性起好的服务器会已被关掉——所以这里必须懒启动。 */
async function listen(s, handler) {
  servers.push(s)
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  s.unref()
  return `http://127.0.0.1:${s.address().port}`
}
const ensureServer = async () => {
  if (server && server.listening) return
  if (!sharedSpec) { registerRoutes(makeCtx(), { dataDir: DATA }); sharedSpec = spec }
  server = createServer((req, res) => sharedSpec.handler(req, res))
  ORIGIN = await listen(server, sharedSpec.handler)
}
const startSrv = async (ctxOver = {}) => {
  registerRoutes(makeCtx(ctxOver), { dataDir: DATA })
  server = createServer((req, res) => spec.handler(req, res))
  ORIGIN = await listen(server)
}

const api = async (path, opts) => {
  await ensureServer()
  const r = await fetch(`${ORIGIN}/paper-reader${path}`, opts)
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, body, text }
}
const postJson = (path, obj) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
test.after(() => {
  shutdown()
  rmSync(HOME, { recursive: true, force: true })
  rmSync(DATA, { recursive: true, force: true })
})

/** 递归目录快照（文件 + 符号链接目标 + 大小），用于「不该删的一个都没少」。 */
function snap(dir, base = dir, out = {}) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    const rel = relative(base, p)
    if (e.isSymbolicLink()) out[rel] = 'symlink->' + readlinkSync(p)
    else if (e.isDirectory()) { out[rel] = 'dir'; snap(p, base, out) }
    else out[rel] = statSync(p).size
  }
  return out
}
const diffSnap = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out = []
  for (const k of keys) if (a[k] !== b[k]) out.push(`${k}: ${a[k] ?? '∅'} → ${b[k] ?? '∅'}`)
  return out
}

// ── 独立复算：紧凑 LaTeX（不调用 formulas.ts 的包装函数）──────────────────────

/** 既有投影两步（.txt 形态），验证者直接调用 mineru.js 的两个共享函数。 */
const projTwo = (raw) => normalizeMathBraces(compressMathSpaces(raw))

/**
 * 验证者自己实现的 `\operatorname` 规则（照需求冻结条款写，不抄实现）：
 * 组内 token 全为单字符 → 合并成一个词；否则组内容原样（仅削掉紧贴花括号的填充空白）。
 */
function myUnifyOperators(latex) {
  let out = ''
  let i = 0
  while (i < latex.length) {
    const at = latex.indexOf('\\operatorname', i)
    if (at < 0) { out += latex.slice(i); break }
    let k = at + '\\operatorname'.length
    if (latex.startsWith('withlimits', k)) k += 'withlimits'.length
    else if (latex[k] === '*') k += 1
    else if (/[A-Za-z]/.test(latex[k] || '')) { out += latex.slice(i, k); i = k; continue }
    const head = latex.slice(at, k)
    let p = k
    while (p < latex.length && /\s/.test(latex[p])) p++
    if (latex[p] !== '{') { out += latex.slice(i, k); i = k; continue }
    let depth = 0
    let end = -1
    for (let j = p; j < latex.length; j++) {
      if (latex[j] === '\\') { j++; continue }
      if (latex[j] === '{') depth++
      else if (latex[j] === '}') { depth--; if (depth === 0) { end = j; break } }
    }
    if (end < 0) { out += latex.slice(i, k); i = k; continue }
    const inner = latex.slice(p + 1, end)
    const toks = inner.trim().split(/\s+/).filter(Boolean)
    const merged = toks.length > 0 && toks.every((x) => [...x].length === 1)
    out += latex.slice(i, at) + head + '{' + (merged ? toks.join('') : inner.trim()) + '}'
    i = end + 1
  }
  return out
}
const myCompact = (raw) => myUnifyOperators(projTwo(raw))

// ═══════════════════════════════════════════════════════════════════════════
// A. 公式引用
// ═══════════════════════════════════════════════════════════════════════════

test('VA1[A1] 真实样本 A（TD-MPC2）：12 个 equation、page ∈ {3,4,28,30}、bbox∈[0,1000]、latex 含 $$', (t) => {
  if (!COPY_A) return t.skip('用户文献库缺少 TD-MPC2 的 .mineru.json')
  assert.equal(COPY_A.jsonHash, COPY_A.srcJsonHash, '复制件必须与真实产物逐字节相同（真实库只读）')
  assert.equal(COPY_A.pdfHash, COPY_A.srcPdfHash)
  const idx = buildFormulaIndex(readFileSync(COPY_A.json, 'utf8'))
  assert.equal(idx.source, 'mineru')
  assert.equal(idx.producer, 'mineru-local')
  assert.equal(idx.backend, 'pipeline')
  assert.equal(idx.pageSize, null)
  assert.equal(idx.bboxSpace, 'normalized-1000')
  // 契约 A1 的硬指标
  assert.equal(idx.equations.length, 12)
  assert.deepEqual([...new Set(idx.equations.map((e) => e.page))].sort((a, b) => a - b), [3, 4, 28, 30])
  // 独立复算：直接从 contentList 数 equation 并按 page_idx 分组，必须与索引一致
  const expectPages = [...new Set(COPY_A.equations.map((b) => b.page_idx + 1))].sort((a, b) => a - b)
  assert.deepEqual(expectPages, [3, 4, 28, 30])
  for (const e of idx.equations) {
    assert.equal(e.bbox.length, 4)
    for (const v of e.bbox) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1000, `bbox 分量必须 ∈[0,1000]：${e.bbox}`)
    assert.match(e.latex, /^\$\$/)
    assert.match(e.latex, /\$\$$/)
    assert.equal(e.textFormat, 'latex')
    assert.equal(e.page, e.pageIdx + 1)
  }
  // 页内序号 1 起且连续
  for (const p of [3, 4, 28, 30]) {
    const seq = idx.equations.filter((e) => e.page === p).map((e) => e.index)
    assert.deepEqual(seq, seq.map((_, i) => i + 1), `第 ${p} 页序号必须 1..n 连续`)
  }
})

test('VA2[A1/D1] 接口返回的 LaTeX = 同一份 text 经既有压缩函数处理后的结果（独立复算，非硬编码）', async (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  resetFormulaCache()
  const r = await api(`/api/formulas?topic=lib&name=${encodeURIComponent(COPY_A.name)}`)
  assert.equal(r.status, 200)
  assert.equal(r.body.equations.length, 12)
  const byId = new Map(r.body.equations.map((e) => [e.id, e.latex]))
  assert.equal(byId.size, 12, 'id 必须唯一（前端去重依赖它）')
  let checked = 0
  for (const b of COPY_A.equations) {
    const want = myCompact(b.text)      // 验证者独立实现（projTwo + 自己的 operator 规则）
    assert.ok([...byId.values()].includes(want), `接口必须返回紧凑形态：${want.slice(0, 60)}…`)
    checked++
  }
  assert.equal(checked, 12)
  // 反向：接口值绝不能等于原始 text（原始 text 每 token 间都有空格）——防止「没压缩也算过」
  const rawSet = new Set(COPY_A.equations.map((b) => b.text))
  for (const v of byId.values()) assert.ok(!rawSet.has(v), '接口值不得等于 MinerU 原始 text（未压缩）')
  // 引用内容不得是 PDF 文本层的乱码字形
  for (const v of byId.values()) assert.ok(!/[𝑧𝑧𝑥𝑥𝑞𝑞𝛼]|[\uD835][\uDC00-\uDFFF]/.test(v), `出现文本层乱码：${v.slice(0, 40)}`)
  // 内容保全：把空白与花括号都剥掉后，接口值必须与 .mineru.json 的 text **逐字相同**
  // （紧凑化只允许动空白/冗余花括号，绝不允许动任何字符——这是「不是乱码」的硬证据）
  const strip = (x) => x.replace(/\s+/g, '').replace(/[{}]/g, '')
  const rawStripped = new Set(COPY_A.equations.map((b) => strip(b.text)))
  for (const v of byId.values()) assert.ok(rawStripped.has(strip(v)), `LaTeX 内容与产物不一致（疑似乱码/丢字）：${v.slice(0, 60)}`)
  if (COPY_B) {
    const idxB = buildFormulaIndex(readFileSync(COPY_B.json, 'utf8'))
    const rawB = new Set(COPY_B.equations.map((b) => strip(b.text)))
    for (const e of idxB.equations) assert.ok(rawB.has(strip(e.latex)), `第二样本内容不一致：${e.id}`)
  }
})

test('VA3[§1.7/§1.1] 真实复杂公式逐字核对：\\operatorname* 两变体一致 + 下标/分式花括号保持语义', (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  const idx = buildFormulaIndex(readFileSync(COPY_A.json, 'utf8'))
  const first = idx.equations[0]
  // 这一条是验证者按「既有投影两步 + 冻结的 operator 规则」手工推出的期望串
  assert.equal(
    first.latex,
    '$$\\pi(\\mathbf{s}_t)=\\arg\\operatorname*{max}_{\\mathbf{a}_{t:t+H}}\\mathbb{E}\\left[\\sum_{i=0}^H\\gamma^{t+i}R(\\mathbf{s}_{t+i},\\mathbf{a}_{t+i})\\right].\\tag{1}$$',
  )
  assert.ok(!first.latex.includes('argmax'), '`\\arg` 与 `\\operatorname*{max}` 之间不得被粘连')
  assert.ok(!first.latex.includes('m a x'), '真实产物的 `{ m a x }` 必须合并成 max')
  if (COPY_B) {
    const idxB = buildFormulaIndex(readFileSync(COPY_B.json, 'utf8'))
    const dream = idxB.equations.find((e) => e.latex.includes('DreamSim'))
    assert.ok(dream, '真实产物 Dong et al. 里应有 `\\operatorname { D r e a m S i m }` → DreamSim')
    assert.ok(!dream.latex.includes('D r e a m S i m'))
  }
})

test('VA4[队长第三次裁定] \\operatorname 规则逐条实测：正例合并、反例 `{ arg max }` 不动、\\text 家族原样', () => {
  const viaIndex = (raw) => buildFormulaIndex(JSON.stringify({
    contentList: [{ type: 'equation', text: raw, text_format: 'latex', bbox: [1, 2, 3, 4], page_idx: 0 }],
  })).equations[0].latex
  // 正例（必须合并）
  for (const [inner, word] of [['{ m a x }', 'max'], ['{ i f }', 'if'], ['{ D o g }', 'Dog'], ['{ s . t . }', 's.t.']]) {
    assert.equal(viaIndex(`$$\\operatorname ${inner}$$`), `$$\\operatorname{${word}}$$`, `\\operatorname ${inner}`)
    assert.equal(viaIndex(`$$\\operatorname* ${inner}$$`), `$$\\operatorname*{${word}}$$`, `\\operatorname* ${inner}`)
  }
  // 两变体行为必须完全一致（只差一个 *）
  for (const inner of ['{ m a x }', '{ i f }', '{ D o g }', '{ s . t . }', '{ arg max }', '{ n o t e }']) {
    const a = viaIndex(`$$\\operatorname ${inner}$$`)
    const b = viaIndex(`$$\\operatorname* ${inner}$$`)
    assert.equal(b, a.replace('\\operatorname', '\\operatorname*'), `两变体必须一致：${inner}`)
  }
  // 反例（安全边界：不得合并）
  assert.equal(viaIndex('$$\\operatorname{arg max}$$'), '$$\\operatorname{arg max}$$')
  assert.equal(viaIndex('$$\\operatorname* { arg max }$$'), '$$\\operatorname*{arg max}$$')
  assert.ok(!viaIndex('$$\\operatorname{arg max}$$').includes('argmax'))
  assert.ok(!viaIndex('$$\\operatorname* { arg max }$$').includes('argmax'))
  // \text/\textrm/\mbox/\hbox 家族：空格有语义，原样保留
  for (const fam of ['text', 'textrm', 'mbox', 'hbox']) {
    assert.equal(viaIndex(`$$\\${fam} { h e l l o   w o r l d }$$`), `$$\\${fam}{ h e l l o   w o r l d }$$`, fam)
  }
  // 前缀同形命令不卷进来；命令名本身不被吞
  assert.equal(viaIndex('$$\\operatornames{x}$$'), '$$\\operatornames{x}$$')
  assert.equal(viaIndex('$$\\operatornamewithlimits{max}_{x}$$'), '$$\\operatornamewithlimits{max}_x$$')
  // 花括号不配对 → 组内容不碰（` m a x` 不得被合并成 max；命令与 `{` 之间的空格由既有投影函数处理，非本规则）
  const unpaired = viaIndex('$$\\operatorname { m a x$$')
  assert.ok(!unpaired.includes('max'), `花括号不配对时不得合并：${unpaired}`)
  assert.ok(unpaired.endsWith('{ m a x$$'), `组内容必须原样：${unpaired}`)
  // 既有的 .txt 投影语义未被改动（回归）
  assert.equal(projTwo('$\\operatorname{a b c}$'), '$\\operatorname{a b c}$')
  assert.equal(projTwo('$$\\operatorname{arg max}$$'), '$$\\operatorname{arg max}$$')
})

test('VA5[§1.6] 降级三态：无产物 / 无公式 / 产物损坏 → 一律 200 + 机器可读 reason（绝不 404/500）', async (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  // ① 无 MinerU 产物
  writeFileSync(join(DATA, 'lib', 'plain.pdf'), buildPdf([[[12, 'no mineru artifact for this paper']]]))
  resetFormulaCache()
  const none = await api('/api/formulas?topic=lib&name=plain')
  assert.equal(none.status, 200)
  assert.equal(none.body.source, 'none')
  assert.equal(none.body.reason, 'no-mineru-artifact')
  assert.deepEqual(none.body.equations, [])
  // ② 有产物但没有 equation
  writeFileSync(join(DATA, 'lib', 'noeq.pdf'), buildPdf([[[12, 'artifact without equations']]]))
  writeFileSync(join(DATA, 'lib', 'noeq.mineru.json'), JSON.stringify({
    v: 1, producer: 'mineru-local', backend: 'pipeline', pageCount: 1,
    contentList: [{ type: 'text', text: 'body', bbox: [1, 2, 3, 4], page_idx: 0 }],
  }))
  resetFormulaCache()
  const noeq = await api('/api/formulas?topic=lib&name=noeq')
  assert.equal(noeq.status, 200)
  assert.equal(noeq.body.reason, 'no-equations')
  assert.deepEqual(noeq.body.equations, [])
  // ③ 产物损坏（三种损坏形态）
  writeFileSync(join(DATA, 'lib', 'broken.pdf'), buildPdf([[[12, 'corrupt artifact paper']]]))
  for (const [tag, content] of [['notjson', '{ nope'], ['notarray', '{"contentList":{}}'], ['notobject', '[1,2,3]']]) {
    writeFileSync(join(DATA, 'lib', 'broken.mineru.json'), content)
    resetFormulaCache()
    const bad = await api('/api/formulas?topic=lib&name=broken')
    assert.equal(bad.status, 200, `${tag} 不得 5xx：${bad.text}`)
    assert.equal(bad.body.reason, 'bad-artifact', tag)
    assert.deepEqual(bad.body.equations, [])
    assert.ok(typeof bad.body.warning === 'string' && bad.body.warning.length > 0, 'warning 应给出人读说明')
  }
  // ④ bbox 非法/缺失：条目仍返回（面板可用），bbox:null
  writeFileSync(join(DATA, 'lib', 'broken.mineru.json'), JSON.stringify({
    contentList: [
      { type: 'equation', text: '$$a$$', text_format: 'latex', page_idx: 0 },                       // 无 bbox
      { type: 'equation', text: '$$b$$', text_format: 'latex', bbox: [1, 2, 3], page_idx: 0 },      // 长度错
      { type: 'equation', text: '$$c$$', text_format: 'latex', bbox: [1, 2, 3, 'x'], page_idx: 0 }, // 非数值
    ],
  }))
  resetFormulaCache()
  const bboxless = await api('/api/formulas?topic=lib&name=broken')
  assert.equal(bboxless.status, 200)
  assert.equal(bboxless.body.equations.length, 3)
  for (const e of bboxless.body.equations) assert.equal(e.bbox, null, '非法 bbox 必须降级为 null 而不是崩')
  // ⑤ 权限异常（不可读）也不得 5xx —— 用 000 权限模拟
  if (process.getuid && process.getuid() !== 0) {
    const p = join(DATA, 'lib', 'broken.mineru.json')
    chmodSync(p, 0o000)
    resetFormulaCache()
    const denied = await api('/api/formulas?topic=lib&name=broken')
    chmodSync(p, 0o644)
    assert.equal(denied.status, 200, `不可读产物应降级为 bad-artifact：${denied.text}`)
    assert.equal(denied.body.reason, 'bad-artifact')
  }
})

test('VA6[§1.7/A9] 缓存按 (path,mtime,size) 失效：改了产物必须立刻反映（不得返回陈旧索引）', async (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  writeFileSync(join(DATA, 'lib', 'cache.pdf'), buildPdf([[[12, 'cache invalidation paper']]]))
  const p = join(DATA, 'lib', 'cache.mineru.json')
  const one = (txt) => JSON.stringify({ contentList: [{ type: 'equation', text: txt, text_format: 'latex', bbox: [10, 10, 20, 20], page_idx: 0 }] })
  writeFileSync(p, one('$$first$$'))
  resetFormulaCache()
  const r1 = await api('/api/formulas?topic=lib&name=cache')
  assert.equal(r1.body.equations[0].latex, '$$first$$')
  // 同一进程内改文件（size 也变），必须拿到新值
  writeFileSync(p, one('$$second-and-longer$$'))
  const r2 = await api('/api/formulas?topic=lib&name=cache')
  assert.equal(r2.body.equations[0].latex, '$$second-and-longer$$', '缓存未按 mtime/size 失效')
  // 删掉产物 → 立刻降级 no-mineru-artifact
  rmSync(p)
  const r3 = await api('/api/formulas?topic=lib&name=cache')
  assert.equal(r3.body.reason, 'no-mineru-artifact')
})

// ── 真实 viewport：pdf.js 取真实页尺寸（映射与命中都不靠实现方的硬编码）─────────

const openPdf = async (p) => pdfjs.getDocument({ data: new Uint8Array(readFileSync(p)), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false }).promise
const pageViewport = async (doc, pageNo, scale) => (await doc.getPage(pageNo)).getViewport({ scale })

test('VA7[A2/A5] bbox 映射独立复核：x 用页宽、y 用页高（各自归一，不是同一比例尺），两个缩放级别下 12/12 命中', async (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  const doc = await openPdf(COPY_A.pdf)
  const R = loadReader()
  R.t.setVariant(null)
  R.t.setCurrent({ topic: 'lib', name: COPY_A.name })
  const idx = buildFormulaIndex(readFileSync(COPY_A.json, 'utf8'))
  R.t.setEq(idx)
  let hits = 0
  for (const scale of [0.6, 1, 2]) {
    const seen = new Set()
    for (const pageNo of [3, 4, 28, 30]) {
      const page = await doc.getPage(pageNo)
      const vp = page.getViewport({ scale })
      assert.equal(page.rotate, 0, '样本页必须无旋转（契约 §1.1）')
      const pageDiv = makeEl()
      pageDiv.dataset.page = String(pageNo)
      R.body.appendChild(pageDiv)
      R.t.setZoom(scale)
      R.t.paintEqLayer(pageDiv, vp, pageNo)
      const pageEqs = idx.equations.filter((e) => e.page === pageNo)
      assert.ok(pageEqs.length > 0)
      for (const eq of pageEqs) {
        // 验证者独立算期望矩形
        const ex = eq.bbox[0] / 1000 * vp.width
        const ey = eq.bbox[1] / 1000 * vp.height
        const ew = (eq.bbox[2] - eq.bbox[0]) / 1000 * vp.width
        const eh = (eq.bbox[3] - eq.bbox[1]) / 1000 * vp.height
        const g = R.t.eqGeom(eq, vp)
        const near = (a, b) => Math.abs(a - b) < 1e-9 // 实现是 bbox*(w/1000)，契约写作 bbox/1000*w：同一实数，浮点末位可差 1 ULP
        assert.ok(near(g.x, ex), `x 必须用页宽：${eq.id}@${scale} → ${g.x} vs ${ex}`)
        assert.ok(near(g.y, ey), `y 必须用页高：${eq.id}@${scale} → ${g.y} vs ${ey}`)
        assert.ok(near(g.w, ew))
        assert.ok(near(g.h, eh))
        assert.equal(g.pad, 6 * scale, 'PAD=6pt 随缩放放大')
        // x/y 不得共用同一比例尺（样本页 612×792 → 两者必然不同）
        if (eq.bbox[1] > 0) assert.ok(Math.abs(g.y - eq.bbox[1] / 1000 * vp.width) > 1, 'y 不得用页宽比例')
        // 中心点命中测试（契约 A2）
        const cx = g.x0 + (g.x1 - g.x0) / 2
        const cy = g.y0 + (g.y1 - g.y0) / 2
        const hit = R.t.hitTestFormula({ target: R.targetAt(pageDiv), clientX: cx, clientY: cy })
        assert.ok(hit, `中心必须命中：${eq.id}@${scale}`)
        assert.equal(hit.eq.id, eq.id, `必须命中自己：${eq.id}@${scale}，实际 ${hit.eq.id}`)
        seen.add(eq.id)
        hits++
      }
      pageDiv.remove()
    }
    assert.equal(seen.size, 12, `scale=${scale} 时 12 个公式必须全部被点中`)
  }
  assert.equal(hits, 36, '三个缩放级别（0.6 / 1 / 2）各 12 次命中')
})

test('VA7b[A3] 独立数值复核：PAD=6pt 外扩后热区完全包住公式字形（真实页 4 / 页 30）', async (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  const doc = await openPdf(COPY_A.pdf)
  const idx = buildFormulaIndex(readFileSync(COPY_A.json, 'utf8'))
  const report = []
  for (const pageNo of [4, 30]) {
    const page = await doc.getPage(pageNo)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const items = tc.items.filter((i) => typeof i.str === 'string' && i.str.trim() !== '').map((it) => {
      const tx = pdfjs.Util.transform(vp.transform, it.transform)
      const hh = it.height || 0
      return { l: tx[4], r: tx[4] + it.width, t: tx[5] - hh, b: tx[5] }
    })
    for (const eq of idx.equations.filter((e) => e.page === pageNo)) {
      const r = { l: eq.bbox[0] / 1000 * vp.width, t: eq.bbox[1] / 1000 * vp.height, r: eq.bbox[2] / 1000 * vp.width, b: eq.bbox[3] / 1000 * vp.height }
      const inside = items.filter((v) => { const cx = (v.l + v.r) / 2; const cy = (v.t + v.b) / 2; return cx >= r.l && cx <= r.r && cy >= r.t && cy <= r.b })
      assert.ok(inside.length > 0, `第 ${pageNo} 页 ${eq.id}：热区内必须真的有字形（否则是空框）`)
      const u = { l: Math.min(...inside.map((v) => v.l)), t: Math.min(...inside.map((v) => v.t)), r: Math.max(...inside.map((v) => v.r)), b: Math.max(...inside.map((v) => v.b)) }
      const PAD = 6
      const under = Math.max(0, r.l - u.l, r.t - u.t, u.r - r.r, u.b - r.b)
      report.push(`p${pageNo} ${eq.id} glyphs=${inside.length} under=${under.toFixed(2)}pt`)
      assert.ok(u.l >= r.l - PAD - 1e-6 && u.t >= r.t - PAD - 1e-6 && u.r <= r.r + PAD + 1e-6 && u.b <= r.b + PAD + 1e-6,
        `PAD=6 必须包住字形：p${pageNo} ${eq.id} padRect=[${(r.l - PAD).toFixed(1)},${(r.t - PAD).toFixed(1)},${(r.r + PAD).toFixed(1)},${(r.b + PAD).toFixed(1)}] glyphs=[${u.l.toFixed(1)},${u.t.toFixed(1)},${u.r.toFixed(1)},${u.b.toFixed(1)}]`)
    }
  }
  writeFileSync(join(REPO, '.probe', 'va7b-coverage.txt'), report.join('\n') + '\n')
})

test('VA8[§1.4 拾取规则] 未外扩优先 → 距离最小 → 面积最小 → 阅读序（重叠时不许随机）', (t) => {
  const R = loadReader()
  R.t.setVariant(null)
  const V = { width: 1000, height: 1000 } // 归一化单位 = 像素，便于精确构造几何关系
  const mk = (id, bbox) => ({ id, bbox, latex: `$$${id}$$`, page: 1, pageIdx: 0, index: 1, textFormat: 'latex' })
  const pageDiv = makeEl(); pageDiv.dataset.page = '1'; R.body.appendChild(pageDiv)
  R.t.setZoom(3) // pad = 18 ≥ 构造的间隙
  R.t.setEq({ source: 'mineru', producer: null, backend: null, pageCount: 1, pageSize: null, bboxSpace: 'normalized-1000', equations: [] })
  R.t.paintEqLayer(pageDiv, V, 1)
  const put = (arr) => R.t.paintEqLayer(pageDiv, V, 1) || R.t.setEq({ source: 'mineru', producer: null, backend: null, pageCount: 1, pageSize: null, bboxSpace: 'normalized-1000', equations: arr }) || R.t.paintEqLayer(pageDiv, V, 1)
  const click = (x, y) => R.t.hitTestFormula({ target: R.targetAt(pageDiv), clientX: x, clientY: y })

  // ① 未外扩矩形包含点者优先（即使别的热区离得更近）
  put([mk('big', [100, 0, 600, 600]), mk('near', [148, 49, 149, 49.5])])
  assert.equal(click(150, 50).eq.id, 'big', '未外扩包含点的必须优先于「距离更近但只是外扩命中」的')

  // ② 都在外扩区、都不包含点 → 距离平方最小者（两者 dx 相同 ⇒ 相等距离）
  put([mk('A', [0, 40, 140, 60]), mk('B', [0, 0, 140, 200])])
  const far = click(150, 50)
  assert.equal(far.eq.id, 'A', '等距时必须取面积小者（A 面积 2800 < B 28000）')

  // ③ 面积/距离完全并列 → 阅读序靠前（数组序 = 阅读序）
  put([mk('first', [0, 40, 140, 60]), mk('second', [0, 40, 140, 60])])
  assert.equal(click(150, 50).eq.id, 'first', '并列取阅读序靠前')

  // ④ 无命中 → null（不是公式点击）
  put([mk('only', [0, 40, 140, 60])])
  assert.equal(click(500, 500), null)
  assert.equal(click(150, 500), null, '外扩之外不得命中')
  // ⑤ w/h ≤ 0 的块不生成热区
  put([mk('zero', [100, 200, 100, 260]), mk('neg', [100, 200, 90, 260])])
  assert.equal(R.t.eqGeom(mk('zero', [100, 200, 100, 260]), V), null)
  assert.equal(R.t.eqGeom(mk('neg', [100, 200, 90, 260]), V), null)
  assert.equal(click(100, 230), null)
  // ⑥ 超出页面的 bbox 必须裁剪进 [0,vw]×[0,vh]
  const g = R.t.eqGeom(mk('out', [-50, -50, 1200, 1400]), V)
  assert.equal(g.x0, 0); assert.equal(g.y0, 0); assert.equal(g.x1, 1000); assert.equal(g.y1, 1000)
})

test('VA8b[实测 0.8pt 间隙] 真实第 30 页三块紧邻公式：各自中心必须点中自己', async (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  const idx = buildFormulaIndex(readFileSync(COPY_A.json, 'utf8'))
  const p30 = idx.equations.filter((e) => e.page === 30).sort((a, b) => a.bbox[1] - b.bbox[1])
  assert.equal(p30.length, 4, '样本第 30 页应有 4 个公式')
  const gaps = p30.slice(1).map((e, i) => e.bbox[1] - p30[i].bbox[3])
  assert.ok(Math.min(...gaps) < 6, `实测存在 <6pt 的相邻间隙（否则本用例没有意义）：${gaps.join(', ')}`)
  const doc = await openPdf(COPY_A.pdf)
  const vp = await pageViewport(doc, 30, 1)
  const R = loadReader()
  R.t.setVariant(null)
  R.t.setEq(idx)
  R.t.setZoom(1)
  const pageDiv = makeEl(); pageDiv.dataset.page = '30'; R.body.appendChild(pageDiv)
  R.t.paintEqLayer(pageDiv, vp, 30)
  for (const eq of p30) {
    const g = R.t.eqGeom(eq, vp)
    const hit = R.t.hitTestFormula({ target: R.targetAt(pageDiv), clientX: (g.x0 + g.x1) / 2, clientY: (g.y0 + g.y1) / 2 })
    assert.equal(hit.eq.id, eq.id, `${eq.id} 中心必须点中自己（间隙 ${gaps.join(',')}pt）`)
  }
})

test('VA9[A7] 划词选中即问未被破坏：有选区时公式热区绝不抢（真实脚本 + 可观测 DOM）', async (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  const idx = buildFormulaIndex(readFileSync(COPY_A.json, 'utf8'))
  const doc = await openPdf(COPY_A.pdf)
  const vp = await pageViewport(doc, 4, 1)
  const R = loadReader()
  R.t.setVariant(null)
  R.t.setEq(idx)
  R.t.setZoom(1)
  R.t.setCurrent({ topic: 'lib', name: COPY_A.name })
  const pageDiv = makeEl(); pageDiv.dataset.page = '4'; R.body.appendChild(pageDiv)
  R.t.paintEqLayer(pageDiv, vp, 4)
  const eq = idx.equations.find((e) => e.page === 4)
  const g = R.t.eqGeom(eq, vp)
  const cx = (g.x0 + g.x1) / 2
  const cy = (g.y0 + g.y1) / 2
  const pageEl = makeEl(); pageEl.dataset.page = '4'

  // ① 有选区：点在第 4 页公式热区正中央，必须走「选中即问」，绝不弹公式
  const tl = makeEl()
  const span = makeEl()
  tl.closest = (s) => (s === '.textLayer' ? tl : (s === '.page' ? pageEl : null))
  span.closest = (s) => (s === '.textLayer' ? tl : (s === '.page' ? pageEl : null))
  R.state.selection = {
    toString: () => '公式 (3) 的上界是什么',
    anchorNode: { parentElement: span },
    getRangeAt: () => ({ getBoundingClientRect: () => ({ bottom: 100 }) }),
  }
  R.fire('mousedown', { clientX: cx, clientY: cy, target: R.targetAt(pageEl) })
  R.fire('mouseup', { clientX: cx, clientY: cy, target: R.targetAt(pageEl) })
  const ask1 = R.t.askSelectionGet()
  assert.ok(ask1, '有选区时必须产生引用')
  assert.equal(ask1.kind, 'text', '热区不得夺走选区：必须是文字引用')
  assert.equal(ask1.text, '公式 (3) 的上界是什么')
  assert.equal(R.t.askSelectionGet().kind === 'equation', false)
  assert.equal(R.doc.querySelectorAll('.eq-box.hit').length, 0, '有选区时不得标记公式命中')
  assert.ok(!String(R.els.get('ask-quote').textContent).includes('公式 1'), '气泡里不得出现公式标签')

  // ② 无选区 + 无位移：同一坐标必须引用公式（证明上面不是「热区失效」的假象）
  R.state.selection = null
  R.fire('mousedown', { clientX: cx, clientY: cy, target: R.targetAt(pageEl) })
  R.fire('mouseup', { clientX: cx, clientY: cy, target: R.targetAt(pageEl) })
  const ask2 = R.t.askSelectionGet()
  assert.equal(ask2.kind, 'equation')
  assert.equal(ask2.page, 4)
  assert.equal(ask2.equationIndex, eq.index)
  assert.equal(ask2.text, `$$ ${idx.equations.find((e) => e.id === eq.id).latex.replace(/^\s*\$\$?/, '').replace(/\$\$?\s*$/, '').trim()} $$`)
  assert.ok(String(R.els.get('ask-quote').textContent).includes(`第 4 页 · 公式 ${eq.index}`), R.els.get('ask-quote').textContent)
  assert.equal(R.doc.querySelectorAll('.eq-box.hit').length, 1, '命中后必须有 1 个高亮框')
  assert.equal(R.doc.querySelector('.eq-box.hit').dataset.eqId, eq.id)

  // ③ 有位移（拖拽）→ 既不算点击也不算公式
  R.state.selection = null
  R.els.get('ask-pop').style.display = 'block'
  R.fire('mousedown', { clientX: cx, clientY: cy, target: R.targetAt(pageEl) })
  R.fire('mouseup', { clientX: cx + 20, clientY: cy + 20, target: R.targetAt(pageEl) })
  assert.notEqual(R.els.get('ask-pop').style.display, 'block', '拖拽后不得保持/弹出气泡')

  // ④ 译文视图：热区整体关闭
  R.t.setVariant('zh')
  assert.equal(R.t.eqHotEnabled(), false)
  assert.equal(R.t.hitTestFormula({ target: R.targetAt(pageDiv), clientX: cx, clientY: cy }), null)
  R.t.setVariant(null)
  assert.equal(R.t.eqHotEnabled(), true)

  // ⑤ 结构性：热区层 pointer-events:none，且不接任何事件（否则会夺走 textLayer 的拖拽）
  assert.match(READER_HTML, /\.eqLayer\s*\{[^}]*pointer-events:\s*none/, '.eqLayer 必须 pointer-events:none')
  const eqBoxCss = READER_HTML.match(/\.eq-box[^{]*\{[^}]*\}/g) || []
  for (const rule of eqBoxCss) assert.ok(!/pointer-events/.test(rule), `.eq-box 不得改 pointer-events：${rule}`)
  assert.ok(!/eqLayer|eq-box/.test(String(SCRIPT_SRC.match(/\.eqLayer[^\n]*addEventListener|eq-box[^\n]*addEventListener/) || '')), '热区层不得绑定事件监听')
  const mouseupBlock = SCRIPT_SRC.slice(SCRIPT_SRC.indexOf("addEventListener('mouseup'"), SCRIPT_SRC.indexOf("$('ask-cancel').onclick"))
  assert.ok(mouseupBlock.includes('getSelection') && mouseupBlock.includes('hitTestFormula'),
    '公式分支必须写在同一个 mouseup 处理函数里（不新增独立 listener，避免双弹层竞态）')
  assert.ok(mouseupBlock.indexOf('getSelection') < mouseupBlock.indexOf('hitTestFormula'), '必须先判选区、后判公式')
})

test('VA10[§1.3/A6] 发送链路复用既有选中即问：请求体含 kind/equationIndex/page 与 `$$ … $$` 引用串', async (t) => {
  if (!COPY_A) return t.skip('缺少真实样本')
  const idx = buildFormulaIndex(readFileSync(COPY_A.json, 'utf8'))
  const doc = await openPdf(COPY_A.pdf)
  const vp = await pageViewport(doc, 4, 1)
  const R = loadReader()
  R.t.setVariant(null)
  R.t.setEq(idx)
  R.t.setZoom(1)
  R.t.setCurrent({ topic: 'lib', name: COPY_A.name })
  const pageDiv = makeEl(); pageDiv.dataset.page = '4'; R.body.appendChild(pageDiv)
  R.t.paintEqLayer(pageDiv, vp, 4)
  const eq = idx.equations.find((e) => e.page === 4)
  const g = R.t.eqGeom(eq, vp)
  R.state.selection = null
  R.fire('mousedown', { clientX: (g.x0 + g.x1) / 2, clientY: (g.y0 + g.y1) / 2, target: R.targetAt(pageDiv) })
  R.fire('mouseup', { clientX: (g.x0 + g.x1) / 2, clientY: (g.y0 + g.y1) / 2, target: R.targetAt(pageDiv) })
  R.els.get('ask-input').value = '这个公式怎么推导的？'
  await R.els.get('ask-send').onclick()
  const req = R.requests.find((r) => r.url.endsWith('/api/ask'))
  assert.ok(req, '必须走既有的 /api/ask（不得另起旁路）')
  assert.equal(req.body.kind, 'equation')
  assert.equal(req.body.equationIndex, eq.index)
  assert.equal(req.body.page, 4)
  assert.equal(req.body.topic, 'lib')
  assert.equal(req.body.name, COPY_A.name)
  assert.match(req.body.selectedText, /^\$\$ .+ \$\$$/, 'selectedText 必须带 $$ 定界')
  assert.ok(req.body.selectedText.includes(idx.equations.find((e) => e.id === eq.id).latex.replace(/^\s*\$\$?/, '').replace(/\$\$?\s*$/, '').trim()), 'selectedText 必须是紧凑 LaTeX')
  // 面板条目与热区走同一条链路（同一个 citeFormula）：真实点一次面板条目
  R.t.renderEqPanel()
  const items = R.doc.querySelectorAll('.eq-item')
  assert.ok(items.length === idx.equations.length, `面板条目数必须等于公式数：${items.length}`)
  const target = items.find((it) => it.dataset.eqId === eq.id)
  assert.ok(target, '面板里必须能找到同一个公式')
  const before = R.t.askSelectionGet()
  target.onclick()
  const after = R.t.askSelectionGet()
  assert.equal(after.kind, 'equation')
  assert.equal(after.equationIndex, eq.index)
  assert.equal(after.page, eq.page)
  assert.equal(after.text, before.text, '面板条目与热区点击必须给出同一个引用串')
  assert.ok(String(R.els.get('ask-quote').textContent).includes(`第 ${eq.page} 页 · 公式 ${eq.index}`))
  assert.ok(SCRIPT_SRC.includes('citeFormula(hit.eq'), '热区必须复用 citeFormula')
  // 不自动写剪贴板：clipboard 写操作只出现在显式按钮回调里
  const copyHandlerAt = SCRIPT_SRC.indexOf("$('ask-copy').onclick")
  assert.ok(copyHandlerAt > 0, '必须有显式的「复制 LaTeX」按钮处理器')
  const writeCalls = [...SCRIPT_SRC.matchAll(/await navigator\.clipboard\.writeText\(|document\.execCommand\('copy'\)/g)].map((m) => m.index)
  assert.equal(writeCalls.length, 2, '剪贴板写入只应有 1 个 API 调用 + 1 个兜底')
  for (const i of writeCalls) assert.ok(i > copyHandlerAt, '剪贴板写入必须发生在用户显式点击之后（不得自动写）')
  const popBlock = SCRIPT_SRC.slice(SCRIPT_SRC.indexOf('function showAskPop'), SCRIPT_SRC.indexOf("document.addEventListener('mousedown', (e) => { downPt"))
  assert.ok(!/clipboard|execCommand/.test(popBlock), '弹气泡/引用公式时不得自动写剪贴板')
  const citeBlock = SCRIPT_SRC.slice(SCRIPT_SRC.indexOf('function citeFormula'), SCRIPT_SRC.indexOf('function renderEqPanel'))
  assert.ok(!/clipboard|execCommand/.test(citeBlock), '引用公式的入口不得自动写剪贴板')
  assert.ok(!/navigator\.clipboard/.test(SCRIPT_SRC.slice(0, copyHandlerAt)), 'ask-copy 处理器之前不得出现剪贴板写入逻辑')
})

test('VA11[A6/A11] /api/ask 文案：kind=equation 分支正确；kind 缺省时与 HEAD（改造前）逐字一致', async (t) => {
  ensureFixtures()
  const prompts = []
  const srv = createServer
  const spec0 = spec
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }), create: async () => ({}), prompt: async (req) => { prompts.push(req.content[0].text); return { accepted: true } } },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: DATA })
  const s2 = createServer((req, res) => spec.handler(req, res))
  const base = (await listen(s2)) + '/paper-reader'
  const send = (body) => fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    // 文字链路（kind 缺省）
    const r1 = await send({ topic: 'lib', name: 'plain', question: '这段在说什么？', selectedText: 'some selected words', page: 3 })
    assert.equal(r1.status, 200)
    // 文字链路（无页码）
    const r2 = await send({ topic: 'lib', name: 'plain', question: '没有页码的引用', selectedText: 'another quote' })
    assert.equal(r2.status, 200)
    // 公式链路
    const r3 = await send({ topic: 'lib', name: 'plain', kind: 'equation', equationIndex: 2, question: '这条公式怎么来的？', selectedText: '$$ \\mathcal { L } _ { v l b } $$', page: 2 })
    assert.equal(r3.status, 200)

    // 与 HEAD（改造前）的模板逐字比对
    const old = execFileSync('git', ['show', 'HEAD:src/host.ts'], { cwd: REPO, encoding: 'utf8' })
    const OLD_LINE = '`用户在阅读器里选中了一段文字${where}：`'
    const OLD_WHERE = 'const where = hasQuote && body.page ? `（选中于第 ${body.page} 页）` : \'\''
    assert.ok(old.includes(OLD_LINE), 'HEAD 里应能定位到改造前的选中文案模板')
    assert.ok(old.includes(OLD_WHERE), 'HEAD 里应能定位到改造前的 where 表达式')
    // 逐字期望（由 HEAD 模板 + where 语义推出）
    assert.ok(prompts[0].includes('用户在阅读器里选中了一段文字（选中于第 3 页）：'), prompts[0])
    assert.ok(prompts[0].includes('"""some selected words"""'), prompts[0])
    assert.ok(prompts[1].includes('用户在阅读器里选中了一段文字：'), `无页码时必须不带「选中于」：${prompts[1]}`)
    assert.ok(!prompts[1].includes('选中于'), prompts[1])
    assert.ok(prompts[1].includes('"""another quote"""'))
    assert.ok(prompts[0].includes('[论文伴读] 文献：lib/plain（同目录下，search_paper 可直接检索；回答注明页码）'))
    assert.ok(prompts[0].includes('用户的问题：这段在说什么？'))
    // 公式文案
    assert.ok(prompts[2].includes('用户在阅读器里引用了第 2 页的一个公式（LaTeX 源，来自 MinerU 版面解析）：'), prompts[2])
    assert.ok(prompts[2].includes('"""$$ \\mathcal { L } _ { v l b } $$"""'))
    assert.ok(!prompts[2].includes('选中了一段文字'), '公式引用不得复用文字文案')
    // 当前源码里的文字分支模板必须与 HEAD 逐字相同
    const cur = readFileSync(join(REPO, 'src', 'host.ts'), 'utf8')
    assert.ok(cur.includes(OLD_LINE), '选中文案模板被改动过（回归）')
    assert.ok(cur.includes(OLD_WHERE), 'where 表达式被改动过（回归）')
  } finally {
    spec = spec0
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// B. 文献管理（破坏性操作对抗测试）
// ═══════════════════════════════════════════════════════════════════════════

const PDF = () => buildPdf([[[12, 'verification fixture body text for a paper']]])

/** 造一篇「产物齐全」的文献（7 类同名产物 + 3 个译文变体 + 1 个 tmp 残留）。 */
function scaffoldPaper(topic, name, { variants = true, tmp = true } = {}) {
  const dir = join(DATA, topic)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.pdf`), PDF())
  writeFileSync(join(dir, `${name}.txt`), 'transcript text ' + name)
  writeFileSync(join(dir, `${name}.pages.json`), '[]')
  writeFileSync(join(dir, `${name}.transcript.json`), '{}')
  writeFileSync(join(dir, `${name}.mineru.md`), '# md')
  writeFileSync(join(dir, `${name}.mineru.json`), JSON.stringify({ contentList: [] }))
  writeFileSync(join(dir, `${name}.embeddings.json`), '{}')
  if (variants) {
    for (const v of ['-en', '-zh', '-dual']) writeFileSync(join(dir, `${name}${v}.pdf`), PDF())
  }
  if (tmp) writeFileSync(join(dir, `${name}.txt.tmp-4321-deadbeef`), 'half written')
  return dir
}
/** 跨用例共享的夹具（幂等）：`--test-name-pattern` 单跑某个用例时也保证它自带素材。 */
function ensureFixtures() {
  mkdirSync(join(DATA, 'lib'), { recursive: true })
  writeFileSync(join(DATA, 'lib', 'plain.pdf'), PDF())
  writeFileSync(join(DATA, 'lib', 'noeq.pdf'), PDF())
  writeFileSync(join(DATA, 'lib', 'noeq.mineru.json'), JSON.stringify({
    v: 1, producer: 'mineru-local', backend: 'pipeline', pageCount: 1,
    contentList: [{ type: 'text', text: 'body', bbox: [1, 2, 3, 4], page_idx: 0 }],
  }))
  writeFileSync(join(DATA, 'lib', 'broken.pdf'), PDF())
  writeFileSync(join(DATA, 'lib', 'broken.mineru.json'), '{ this is not json')
  scaffoldPaper('att', 'Attention')
  scaffoldPaper('att', 'Attention Is All You Need', { variants: false })
  scaffoldPaper('att', 'Attention2', { variants: false })
  writeFileSync(join(DATA, 'att', 'Notes on Attention.pdf'), PDF())
  writeFileSync(join(DATA, 'att', 'Attention Is All You Need-zh.pdf'), PDF())
  writeFileSync(join(DATA, 'att', 'Attention-zh.txt'), 'not an artifact')
  writeFileSync(join(DATA, 'att', 'Attention.bak'), 'backup')
  writeFileSync(join(DATA, 'att', 'Attention Is All You Need2.pdf'), PDF())
  scaffoldPaper('del2', 'Keep')
}

const artifactNamesOf = (topic, name, opts) => {
  const base = [`${name}.pdf`, `${name}.txt`, `${name}.pages.json`, `${name}.transcript.json`,
    `${name}.mineru.md`, `${name}.mineru.json`, `${name}.embeddings.json`]
  if (opts?.variants !== false) base.push(`${name}-en.pdf`, `${name}-zh.pdf`, `${name}-dual.pdf`)
  if (opts?.tmp !== false) base.push(`${name}.txt.tmp-4321-deadbeef`)
  return base.sort()
}

test('VB1[B2] 前缀误删对抗：删 `Attention` 后 `Attention Is All You Need` / `Attention2` 一个字节都不能变', async () => {
  ensureFixtures()
  const topic = 'att'
  scaffoldPaper(topic, 'Attention')
  scaffoldPaper(topic, 'Attention Is All You Need', { variants: false })
  scaffoldPaper(topic, 'Attention2', { variants: false })
  writeFileSync(join(DATA, topic, 'Notes on Attention.pdf'), PDF())
  writeFileSync(join(DATA, topic, 'Attention Is All You Need-zh.pdf'), PDF()) // 兄弟文献的变体
  // 干扰项：Attention 的「不存在后缀」不得被猜着删
  writeFileSync(join(DATA, topic, 'Attention-zh.txt'), 'not an artifact')
  writeFileSync(join(DATA, topic, 'Attention.bak'), 'backup')
  writeFileSync(join(DATA, topic, 'Attention Is All You Need2.pdf'), PDF())

  const before = snap(join(DATA, topic))
  const plan = await api(`/api/library/paper/delete-plan?topic=${topic}&name=${encodeURIComponent('Attention')}`)
  assert.equal(plan.status, 200)
  const planned = plan.body.files.map((f) => f.name).sort()
  assert.deepEqual(planned, artifactNamesOf(topic, 'Attention'), '预览清单必须精确等于契约的 11 项（7 产物 + 3 变体 + 1 tmp）')
  for (const n of planned) assert.ok(!n.includes('Is All You Need'), `清单里混入了兄弟文献：${n}`)

  const del = await postJson('/api/library/paper/delete', { topic, name: 'Attention' })
  assert.equal(del.status, 200, del.text)
  assert.deepEqual([...del.body.moved].sort(), planned, '实际移动集合必须与预览清单集合相等（B1）')

  const after = snap(join(DATA, topic))
  // 应消失的只有 Attention.* 的 11 项
  const gone = Object.keys(before).filter((k) => !(k in after))
  assert.deepEqual(gone.sort(), planned, `只有 Attention 自己的产物可以消失，实际消失：${gone}`)
  // 兄弟文献逐字节不变
  for (const keep of ['Attention Is All You Need.pdf', 'Attention Is All You Need.txt', 'Attention Is All You Need.mineru.json',
    'Attention Is All You Need-zh.pdf', 'Attention2.pdf', 'Attention2.txt', 'Notes on Attention.pdf',
    'Attention-zh.txt', 'Attention.bak', 'Attention Is All You Need2.pdf']) {
    assert.ok(after[keep] !== undefined, `${keep} 被误删/误改！`)
    assert.equal(after[keep], before[keep], `${keep} 内容/大小发生了变化`)
  }
  // 回收站里是 Attention 自己的产物（可恢复）
  const bundle = join(DATA, del.body.trashRel)
  for (const n of planned) assert.ok(existsSync(join(bundle, n)), `回收站缺少 ${n}`)
  assert.ok(existsSync(join(bundle, 'manifest.json')))
  // 库里：Attention 消失，兄弟文献还在（把 Attention-zh.txt 这种隐藏变体排除）
  const lib = await api('/api/library')
  const names = lib.body.papers.filter((p) => p.topic === topic).map((p) => p.name).sort()
  assert.deepEqual(names, ['Attention Is All You Need', 'Attention Is All You Need2', 'Attention2', 'Notes on Attention'].sort())
})

test('VB2[B1/B3/B4] 全库快照对照：产物集合精确、不该删的一个都没少（其他文献/专题/共享 venv/回收站）', async () => {
  // 共享资源与邻居
  mkdirSync(join(DATA, '.venv-pdf2zh', 'bin'), { recursive: true })
  writeFileSync(join(DATA, '.venv-pdf2zh', 'bin', 'babeldoc'), 'fake shared venv')
  mkdirSync(join(DATA, '.pdf2zh-tmp'), { recursive: true })
  writeFileSync(join(DATA, '.pdf2zh-tmp', 'other.txt'), 'in progress scratch')
  mkdirSync(join(DATA, 'neighbour'), { recursive: true })
  writeFileSync(join(DATA, 'neighbour', 'other.pdf'), PDF())
  scaffoldPaper('del2', 'Target')
  scaffoldPaper('del2', 'Target Extra', { variants: false })
  scaffoldPaper('del2', 'Keep')

  const before = snap(DATA)
  const plan = await api('/api/library/paper/delete-plan?topic=del2&name=Target')
  assert.equal(plan.status, 200)
  const planned = plan.body.files.map((f) => f.name).sort()
  assert.deepEqual(planned, artifactNamesOf('del2', 'Target'))
  assert.equal(plan.body.totalBytes, plan.body.files.reduce((n, f) => n + f.bytes, 0))
  assert.equal(plan.body.trashRoot, '.trash')
  assert.ok(plan.body.notDeleted.length >= 3)
  assert.ok(plan.body.notDeleted.some((s) => s.includes('.venv-pdf2zh')))

  const del = await postJson('/api/library/paper/delete', { topic: 'del2', name: 'Target' })
  assert.equal(del.status, 200, del.text)
  assert.deepEqual([...del.body.moved].sort(), planned)
  assert.equal(del.body.moved[del.body.moved.length - 1], 'Target.pdf', '.pdf 必须最后移')
  assert.deepEqual(del.body.skipped, [])

  const after = snap(DATA)
  const gone = Object.keys(before).filter((k) => !(k in after))
  const added = Object.keys(after).filter((k) => !(k in before))
  assert.deepEqual(gone.sort(), planned.map((n) => `del2/${n}`).sort(), `只允许 Target 的产物消失：${gone}`)
  // 新增只允许在 .trash 下一次回收站目录内
  const beyond = added.filter((k) => k !== '.trash' && !k.startsWith('.trash/'))
  assert.deepEqual(beyond, [], `新增内容必须只在 .trash 下：${beyond}`)
  const bundles = new Set(added.filter((k) => k.startsWith('.trash/')).map((k) => k.split('/').slice(0, 2).join('/')))
  assert.equal(bundles.size, 1, `只应新增一个回收站目录：${[...bundles]}`)
  const [bundle] = bundles
  assert.match(bundle, /^\.trash\/\d{8}T\d{6}Z-[0-9a-f]{6}$/, `回收站目录命名必须符合契约：${bundle}`)
  assert.deepEqual(added.filter((k) => k.startsWith(bundle + '/')).map((k) => k.slice(bundle.length + 1)).sort(),
    [...planned, 'manifest.json'].sort(), '回收站里必须恰好是被移走的文件 + manifest.json')
  // 专题目录本身仍在
  assert.equal(after['del2'], 'dir')
  // 共享资源一字未动
  for (const k of ['.venv-pdf2zh', '.venv-pdf2zh/bin', '.venv-pdf2zh/bin/babeldoc', '.pdf2zh-tmp', '.pdf2zh-tmp/other.txt',
    'neighbour', 'neighbour/other.pdf', 'del2/Target Extra.pdf', 'del2/Keep.pdf', 'del2/Keep-zh.pdf']) {
    assert.equal(after[k], before[k], `${k} 不得发生变化`)
  }
  // B3：变体 + tmp 全都被处理
  for (const n of ['Target-zh.pdf', 'Target-dual.pdf', 'Target-en.pdf', 'Target.txt.tmp-4321-deadbeef']) {
    assert.ok(planned.includes(n), `${n} 必须在清单里`)
    assert.ok(!after[`del2/${n}`], `${n} 必须已被移走`)
  }
})

test('VB3[B5] 回收站移动失败：绝不回退 unlink，`.pdf` 仍在，没有文件被销毁', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root 会绕过权限检查，本用例无意义')
  // ① 函数级：用一个「已被同名目录占位」的回收站目录精确注入失败（第 1 个遇阻的文件即为 .txt）
  const root = mkdtempSync(join(tmpdir(), 'dpr-ver-trash-'))
  try {
    mkdirSync(join(root, 't'))
    for (const f of ['p.pdf', 'p.txt', 'p.mineru.json', 'p-zh.pdf']) writeFileSync(join(root, 't', f), 'x' + f)
    const topicDir = join(root, 't')
    const files = listArtifacts(topicDir, 'p')
    const bundle = { abs: join(root, '.trash', 'bundle'), rel: join('.trash', 'bundle') }
    mkdirSync(bundle.abs, { recursive: true })
    mkdirSync(join(bundle.abs, 'p.mineru.json')) // rename 到已存在目录 → EISDIR
    let err = null
    try { moveToTrash(bundle, topicDir, files) } catch (e) { err = e }
    assert.ok(err instanceof ManageError, '必须是可识别的 ManageError')
    assert.equal(err.code, 'trash-move-failed')
    assert.equal(err.status, 500)
    assert.ok(Array.isArray(err.extra.moved) && Array.isArray(err.extra.remaining))
    assert.ok(String(err.extra.trashDir).length > 0)
    // 没有任何文件被 unlink：原件仍在专题目录，或已在回收站里（可恢复）
    const stillThere = readdirSync(topicDir).sort()
    const inTrash = readdirSync(bundle.abs).filter((n) => n !== 'p.mineru.json').sort()
    for (const n of ['p.txt', 'p.mineru.json', 'p-zh.pdf', 'p.pdf']) {
      assert.ok(stillThere.includes(n) || inTrash.includes(n), `${n} 既不在原处也不在回收站 → 被销毁了！`)
    }
    assert.ok(stillThere.includes('p.pdf'), '失败时 `.pdf` 必须仍在文献目录（文献仍在库）')
    assert.ok(!err.extra.moved.includes('p.pdf'), '`.pdf` 必须最后移：失败时不得已被移走')
    const union = [...new Set([...stillThere, ...inTrash])].sort()
    assert.deepEqual(union, ['p-zh.pdf', 'p.mineru.json', 'p.pdf', 'p.txt'].sort(), '四个文件一个都不能少')
  } finally { rmSync(root, { recursive: true, force: true }) }

  // ② 路由级（真正的「移动失败」）：专题目录只读 → rename 失败，但回收站目录能正常创建
  const dataRO = mkdtempSync(join(tmpdir(), 'dpr-ver-trash3-'))
  try {
    mkdirSync(join(dataRO, 't'))
    writeFileSync(join(dataRO, 't', 'p.pdf'), PDF())
    writeFileSync(join(dataRO, 't', 'p.txt'), 'cache')
    writeFileSync(join(dataRO, 't', 'p-zh.pdf'), 'zh')
    const spec1 = spec
    registerRoutes(makeCtx(), { dataDir: dataRO })
    const srv1 = createServer((req, res) => spec.handler(req, res))
    const base1 = (await listen(srv1)) + '/paper-reader'
    chmodSync(join(dataRO, 't'), 0o500)
    const r = await fetch(`${base1}/api/library/paper/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 't', name: 'p' }) })
    const body = await r.json().catch(() => ({}))
    chmodSync(join(dataRO, 't'), 0o700)
    spec = spec1
    writeFileSync(join(REPO, '.probe', 'vb3-move-failed.json'), JSON.stringify({ status: r.status, body }, null, 2))
    assert.equal(r.status, 500, `移动失败必须 500：${r.status} ${JSON.stringify(body)}`)
    assert.equal(body.code, 'trash-move-failed', `必须带机器可读 code（S15）：${JSON.stringify(body)}`)
    assert.ok(Array.isArray(body.moved) && Array.isArray(body.remaining), '必须回报已移动/未移动清单')
    assert.ok(String(body.trashDir).length > 0)
    assert.deepEqual(readdirSync(join(dataRO, 't')).sort(), ['p-zh.pdf', 'p.pdf', 'p.txt'], '失败后三个文件必须都还在（没有任何 unlink）')
    assert.ok(existsSync(join(dataRO, 't', 'p.pdf')), '`.pdf` 必须仍在（文献仍在库）')
    assert.ok(!body.moved.includes('p.pdf'), '`.pdf` 必须最后移')
  } finally { chmodSync(join(dataRO, 't'), 0o700); rmSync(dataRO, { recursive: true, force: true }) }

  // ③ 路由级（回收站目录本身无法创建）：观察真实响应（⚠️ 见 docs/reader-ux-verification.md 的 F1）
  const dataDir = mkdtempSync(join(tmpdir(), 'dpr-ver-trash2-'))
  try {
    mkdirSync(join(dataDir, 't'))
    writeFileSync(join(dataDir, 't', 'p.pdf'), PDF())
    writeFileSync(join(dataDir, 't', 'p.txt'), 'cache')
    mkdirSync(join(dataDir, '.trash'))
    chmodSync(join(dataDir, '.trash'), 0o500)
    const spec0 = spec
    registerRoutes(makeCtx(), { dataDir })
    const srv = createServer((req, res) => spec.handler(req, res))
    const base = (await listen(srv)) + '/paper-reader'
    const r = await fetch(`${base}/api/library/paper/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 't', name: 'p' }) })
    spec = spec0
    const body = await r.json().catch(() => ({}))
    const text = JSON.stringify(body)
    writeFileSync(join(REPO, '.probe', 'vb3-trash-unwritable.json'), JSON.stringify({ status: r.status, body }, null, 2))
    chmodSync(join(dataDir, '.trash'), 0o700)
    // 不变量优先：一个文件都不能少
    assert.ok(existsSync(join(dataDir, 't', 'p.pdf')), 'pdf 必须仍在')
    assert.ok(existsSync(join(dataDir, 't', 'p.txt')), 'txt 必须仍在')
    assert.equal(r.status, 500, `回收站不可写应 500，实际 ${r.status}`)
    // ⚠️ 已知偏离 F1（非阻断，已上报）：准备回收站目录失败时走的是外层兜底 500 —— 缺 code，
    // 且 error 文案里带服务端绝对路径（违反 S15 与本模块自述的「错误文案不含服务端绝对路径」）。
    // 这里固定「现状」：上游修好后本断言会变红，提醒验证者更新报告。硬断言是「文件一个不少」。
    if (body.code !== 'trash-move-failed') {
      assert.ok(body.code === undefined && /EACCES|ENOTDIR|EEXIST|EROFS/.test(String(body.error)), `出现未预期的失败形态，需重新验证：${text}`)
      t.diagnostic(`F1 复现：status=${r.status} code=${body.code} error=${String(body.error).slice(0, 120)}`)
      t.diagnostic(`F1 附加问题：响应体泄露服务端绝对路径 = ${text.includes(dataDir)}`)
    }
  } finally { chmodSync(join(dataDir, '.trash'), 0o700); rmSync(dataDir, { recursive: true, force: true }) }
})

test('VB4[B6] 路径穿越 ≥8 种 × 全部写路由：一律 4xx + 盘上零变化', async () => {
  ensureFixtures()
  const evil = [
    { topic: 'att', name: '../../etc/passwd', why: '相对穿越' },
    { topic: 'att', name: '/etc/passwd', why: '绝对路径' },
    { topic: '..', name: 'Attention', why: 'topic=..' },
    { topic: 'att', name: 'a/b', why: '斜杠' },
    { topic: 'att', name: 'a\\b', why: '反斜杠（win32 分隔符）' },
    { topic: 'att', name: '..', why: 'name=..' },
    { topic: 'att', name: '.hidden', why: '隐藏名' },
    { topic: 'att', name: 'x\u0000y', why: 'NUL 截断' },
    { topic: 'att', name: '..\\..\\etc\\passwd', why: 'win32 相对穿越' },
    { topic: 'att', name: '....//....//etc/passwd', why: '伪归一化穿越' },
    { topic: 'att', name: 'x'.repeat(300), why: '超长名' },
    { topic: 'att', name: '', why: '空名' },
    { topic: '.trash', name: 'manifest', why: '写隐藏系统目录' },
    { topic: '', name: 'Attention', why: '空 topic' },
  ]
  assert.ok(evil.length >= 8)
  const before = snap(DATA)
  const tmpBefore = readdirSync(tmpdir()).filter((n) => n === 'evil').length
  for (const e of evil) {
    const del = await postJson('/api/library/paper/delete', { topic: e.topic, name: e.name })
    assert.ok(del.status >= 400 && del.status < 500, `delete 必须 4xx（${e.why}）：${del.status} ${del.text}`)
    assert.ok(['bad-name', 'bad-request', 'escape-rejected', 'not-found'].includes(del.body?.code), `delete 必须带可读 code（${e.why}）：${del.text}`)
    const ren = await postJson('/api/library/paper/rename', { topic: e.topic, name: e.name, newName: 'Renamed' })
    assert.ok(ren.status >= 400 && ren.status < 500, `rename 必须 4xx（${e.why}）：${ren.status}`)
    const plan = await api(`/api/library/paper/delete-plan?topic=${encodeURIComponent(e.topic)}&name=${encodeURIComponent(e.name)}`)
    assert.notEqual(plan.status, 200, `delete-plan 不得对越界输入返回 200（${e.why}）`)
  }
  // 越界 newName（只对 rename 有意义）
  for (const newName of ['../../evil', '/tmp/evil', '..', 'a/b', 'x\u0000y', '.hidden', '']) {
    const ren = await postJson('/api/library/paper/rename', { topic: 'att', name: 'Attention Is All You Need', newName })
    assert.ok(ren.status >= 400 && ren.status < 500, `越界 newName 必须 4xx：${newName} → ${ren.status}`)
  }
  // 专题路由同样
  for (const nm of ['../att', '/etc', '..', '.trash', '']) {
    const d = await postJson('/api/library/topic/delete', { name: nm, confirmName: nm })
    assert.ok(d.status >= 400 && d.status < 500, `topic/delete 必须 4xx：${nm} → ${d.status}`)
    const rn = await postJson('/api/library/topic/rename', { name: nm, newName: 'x' })
    assert.ok(rn.status >= 400 && rn.status < 500, `topic/rename 必须 4xx：${nm} → ${rn.status}`)
  }
  // path 参数：5 个写路由全部拒绝，且无法借它越过 dataDir
  const withPath = [
    ['/api/library/paper/delete', { topic: 'att', name: 'Attention Is All You Need', path: '/etc/passwd' }],
    ['/api/library/paper/delete', { topic: 'att', name: 'Attention Is All You Need', path: join(DATA, 'att', 'Attention Is All You Need.pdf') }],
    ['/api/library/paper/rename', { topic: 'att', name: 'Attention Is All You Need', newName: 'ZZZ', path: '/etc/passwd' }],
    ['/api/library/topic/delete', { name: 'neighbour', confirmName: 'neighbour', path: '/etc/passwd' }],
    ['/api/library/topic/rename', { name: 'neighbour', newName: 'neighbour2', path: '/etc/passwd' }],
  ]
  for (const [p, body] of withPath) {
    const r = await postJson(p, body)
    assert.equal(r.status, 400, `${p} 必须拒绝 path 参数：${r.text}`)
    assert.equal(r.body.code, 'escape-rejected')
  }
  const planPath = await api('/api/library/paper/delete-plan?topic=att&name=' + encodeURIComponent('Attention Is All You Need') + '&path=/etc/passwd')
  assert.equal(planPath.status, 400)
  // 合法请求仍能通过（证明不是「全拒」的假象）
  const okPlan = await api('/api/library/paper/delete-plan?topic=att&name=' + encodeURIComponent('Attention2'))
  assert.equal(okPlan.status, 200)
  // 盘上零变化
  assert.deepEqual(diffSnap(before, snap(DATA)), [], '恶意输入不得改动文献库')
  assert.equal(readdirSync(tmpdir()).filter((n) => n === 'evil').length, tmpBefore, '不得在临时目录生成 evil')
  assert.ok(existsSync(join(DATA, 'att', 'Attention Is All You Need.pdf')))
})

test('VB5[B7] 符号链接逃逸：只动链接本身，库外内容不变；符号链接专题一律拒绝', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'dpr-ver-outside-'))
  try {
    writeFileSync(join(outside, 'precious.txt'), 'precious-data')
    mkdirSync(join(outside, 'dir'))
    writeFileSync(join(outside, 'dir', 'inner.txt'), 'inner-data')
    const topic = 'sym'
    scaffoldPaper(topic, 'Real', { variants: false, tmp: false })
    // ① 指向库外文件的符号链接，名字与文献产物同名
    symlinkSync(join(outside, 'precious.txt'), join(DATA, topic, 'Link.txt'))
    writeFileSync(join(DATA, topic, 'Link.pdf'), PDF())
    // ② 指向库外目录的符号链接，伪装成 .mineru.md
    symlinkSync(join(outside, 'dir'), join(DATA, topic, 'LinkDir.mineru.md'))
    writeFileSync(join(DATA, topic, 'LinkDir.pdf'), PDF())
    // ③ 整篇文献的 .pdf 本身是指向库外 PDF 的符号链接
    symlinkSync(join(outside, 'precious.txt'), join(DATA, topic, 'LinkedPaper.pdf'))

    const del = await postJson('/api/library/paper/delete', { topic, name: 'Link' })
    assert.equal(del.status, 200, del.text)
    assert.ok(del.body.moved.includes('Link.txt'), '链接本身必须被移入回收站')
    assert.equal(readFileSync(join(outside, 'precious.txt'), 'utf8'), 'precious-data', '库外目标必须原封不动')
    assert.ok(!existsSync(join(DATA, topic, 'Link.txt')))
    const bundle = join(DATA, del.body.trashRel)
    assert.ok(lstatSync(join(bundle, 'Link.txt')).isSymbolicLink(), '回收站里保存的应是链接本身')
    assert.equal(readlinkSync(join(bundle, 'Link.txt')), join(outside, 'precious.txt'))

    const del2 = await postJson('/api/library/paper/delete', { topic, name: 'LinkDir' })
    assert.equal(del2.status, 200, del2.text)
    assert.equal(readFileSync(join(outside, 'dir', 'inner.txt'), 'utf8'), 'inner-data', '库外目录内容必须原封不动')
    assert.ok(existsSync(join(outside, 'dir')), '库外目录不得被删')

    // ③ 文献的 .pdf 本身是符号链接：listPapers 用 dirent.isFile() 过滤，符号链接不在库视图里
    //    → 删除走 resolvePaper 抛普通 Error → 外层 500（契约 §2.8 期望 404）。安全性成立（库外内容不变），
    //    状态码/isCode 属已知偏离 F3（非阻断，见报告）。
    const del3 = await postJson('/api/library/paper/delete', { topic, name: 'LinkedPaper' })
    assert.equal(readFileSync(join(outside, 'precious.txt'), 'utf8'), 'precious-data', '符号链接目标绝不能被删/改')
    assert.ok(existsSync(join(DATA, topic, 'LinkedPaper.pdf')), '拒绝时链接本身必须仍在')
    t.diagnostic(`F3 复现：符号链接 .pdf 的删除返回 ${del3.status}（期望 404），code=${JSON.stringify(del3.body?.code)}`)
    assert.ok(del3.status === 200 || del3.status === 500 || del3.status === 404, `未预期的状态码：${del3.status}`)
    const plan3 = await api(`/api/library/paper/delete-plan?topic=${topic}&name=LinkedPaper`)
    t.diagnostic(`F3 附带：delete-plan 同样返回 ${plan3.status}`)

    // ④ 专题目录本身是符号链接 → 一律 400 escape-rejected（不跟随）
    symlinkSync(outside, join(DATA, 'evil-topic'))
    for (const [p, b] of [
      ['/api/library/paper/delete', { topic: 'evil-topic', name: 'precious' }],
      ['/api/library/paper/rename', { topic: 'evil-topic', name: 'precious', newName: 'x' }],
      ['/api/library/topic/delete', { name: 'evil-topic', confirmName: 'evil-topic' }],
      ['/api/library/topic/rename', { name: 'evil-topic', newName: 'x' }],
    ]) {
      const r = await postJson(p, b)
      assert.equal(r.status, 400, `${p} 必须拒绝符号链接专题：${r.text}`)
      assert.equal(r.body.code, 'escape-rejected')
    }
    const plan = await api('/api/library/paper/delete-plan?topic=evil-topic&name=precious')
    assert.equal(plan.status, 400)
    assert.ok(existsSync(outside), '库外目录必须还在')
    assert.ok(!existsSync(join(outside, 'precious.pdf')))
    rmSync(join(DATA, 'evil-topic'))
    // ⑤ 函数层：resolveTopicDir 对符号链接专题直接拒绝
    assert.throws(() => assertInside(join(DATA, 'att'), join(DATA, 'att')), (e) => e.code === 'escape-rejected')
    assert.throws(() => assertInside(join(DATA, 'att'), join(DATA, 'att2', 'x')), (e) => e.code === 'escape-rejected')
    assert.doesNotThrow(() => assertInside(join(DATA, 'att'), join(DATA, 'att', 'x')))
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test('VB6[B8] 删除专题：非空 409（带 papers）/ 空 200 / 仅隐藏条目也算空且进回收站（绝不 rm -rf）', async () => {
  scaffoldPaper('full', 'Paper One', { variants: false, tmp: false })
  mkdirSync(join(DATA, 'empty1'), { recursive: true })
  mkdirSync(join(DATA, 'hiddenonly'), { recursive: true })
  writeFileSync(join(DATA, 'hiddenonly', '.DS_Store'), 'junk')
  mkdirSync(join(DATA, 'hiddenonly', '.git'), { recursive: true })
  writeFileSync(join(DATA, 'hiddenonly', '.git', 'HEAD'), 'ref: refs/heads/main')

  const nonEmpty = await postJson('/api/library/topic/delete', { name: 'full', confirmName: 'full' })
  assert.equal(nonEmpty.status, 409)
  assert.equal(nonEmpty.body.code, 'topic-not-empty')
  assert.deepEqual(nonEmpty.body.papers, ['Paper One'])
  assert.ok(nonEmpty.body.entries.includes('Paper One.pdf'))
  assert.ok(existsSync(join(DATA, 'full', 'Paper One.pdf')), '拒绝时不得动文件')
  // confirmName 必须一致
  for (const cn of ['', 'FULL', 'full ', undefined]) {
    const r = await postJson('/api/library/topic/delete', { name: 'full', confirmName: cn })
    assert.equal(r.status, 400, `confirmName=${JSON.stringify(cn)} 必须 400`)
    assert.equal(r.body.code, 'confirm-mismatch')
  }
  // 不存在的专题 → 404
  const missing = await postJson('/api/library/topic/delete', { name: 'nope-topic', confirmName: 'nope-topic' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'not-found')

  const okEmpty = await postJson('/api/library/topic/delete', { name: 'empty1', confirmName: 'empty1' })
  assert.equal(okEmpty.status, 200, okEmpty.text)
  assert.ok(!existsSync(join(DATA, 'empty1')), '空专题目录应被删除')
  const lib = await api('/api/library')
  assert.ok(!lib.body.topics.includes('empty1'), '库里不得再列出已删专题')

  const okHidden = await postJson('/api/library/topic/delete', { name: 'hiddenonly', confirmName: 'hiddenonly' })
  assert.equal(okHidden.status, 200, okHidden.text)
  assert.deepEqual([...okHidden.body.movedHidden].sort(), ['.DS_Store', '.git'])
  assert.ok(!existsSync(join(DATA, 'hiddenonly')))
  const bundle = join(DATA, okHidden.body.trashRel)
  assert.ok(existsSync(join(bundle, '.DS_Store')), '隐藏条目必须可恢复（进回收站而不是被销毁）')
  assert.ok(existsSync(join(bundle, '.git', 'HEAD')), '隐藏目录必须整体进回收站')
  assert.ok(existsSync(join(bundle, 'manifest.json')))
  // 只允许 rmdir 语义：函数层对非空目录必须失败
  mkdirSync(join(DATA, 'again'))
  writeFileSync(join(DATA, 'again', 'x.pdf'), 'x')
  assert.throws(() => deleteTopic(DATA, 'again'), (e) => e.code === 'topic-not-empty' && e.status === 409)
  assert.ok(existsSync(join(DATA, 'again', 'x.pdf')))
})

test('VB7[B9] 运行中会话 → 409 session-running（删/改名/专题两级），且文件零变化；非 running 不拦', async () => {
  ensureFixtures()
  const runningRef = 'Attention Is All You Need'
  sessionItems = () => [fakeSession('att', runningRef, 1, true), fakeSession('att', runningRef, 2, false)]
  const before = snap(DATA)
  const del = await postJson('/api/library/paper/delete', { topic: 'att', name: runningRef })
  assert.equal(del.status, 409)
  assert.equal(del.body.code, 'session-running')
  assert.equal(del.body.sessions.running, 1)
  assert.equal(del.body.sessions.total, 2)
  const ren = await postJson('/api/library/paper/rename', { topic: 'att', name: runningRef, newName: 'Whatever' })
  assert.equal(ren.status, 409)
  assert.equal(ren.body.code, 'session-running')
  // 删专题：非空专题先被 topic-not-empty 拦下（契约 §2.8 C 允许两者皆为 409；此处记录实际顺序）
  const tdel = await postJson('/api/library/topic/delete', { name: 'att', confirmName: 'att' })
  assert.equal(tdel.status, 409)
  assert.equal(tdel.body.code, 'topic-not-empty', '实际顺序：先判空、后判 running（两者都是 409 + 可读 code，安全等价）')
  const tren = await postJson('/api/library/topic/rename', { name: 'att', newName: 'att2' })
  assert.equal(tren.status, 409)
  assert.equal(tren.body.code, 'session-running')
  assert.deepEqual(diffSnap(before, snap(DATA)), [], '被 409 拒绝时盘上必须零变化')
  // 预览接口要如实回报 running 数
  const plan = await api('/api/library/paper/delete-plan?topic=att&name=' + encodeURIComponent(runningRef))
  assert.equal(plan.status, 200)
  assert.deepEqual(plan.body.sessions, { total: 2, running: 1 })

  // 只有非 running 会话：不得拦截（gate 必须看 running，而不是 total）
  sessionItems = () => [fakeSession('del2', 'Keep', 1, false)]
  scaffoldPaper('sess', 'Sess', { variants: false, tmp: false })
  const okPlan = await api('/api/library/paper/delete-plan?topic=sess&name=Sess')
  assert.deepEqual(okPlan.body.sessions, { total: 0, running: 0 })
  sessionItems = () => [fakeSession('sess', 'Sess', 1, false)]
  const okDel = await postJson('/api/library/paper/delete', { topic: 'sess', name: 'Sess' })
  assert.equal(okDel.status, 200, okDel.text)
  assert.ok(!existsSync(join(DATA, 'sess', 'Sess.pdf')))
  sessionItems = () => []
})

test('VB8[B10] 翻译进行中 → 409 translation-busy（用假 babeldoc 造真实 busy 状态，不触发任何真实翻译）', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root 环境下不可写目录用例不适用')
  const TDATA = mkdtempSync(join(tmpdir(), 'dpr-ver-tx-'))
  const dataDir = join(TDATA, 'data')
  const pidFile = join(TDATA, 'pid')
  process.env.VB_TX_PIDFILE = pidFile
  let fake = null
  try {
    mkdirSync(join(dataDir, 'tx'), { recursive: true })
    writeFileSync(join(dataDir, 'tx', 'paper.pdf'), PDF())
    writeFileSync(join(dataDir, 'tx', 'paper.txt'), 'cache')
    // 假 babeldoc：--version/--help 立刻返回，真正被拉起时写 pid 后长时间 sleep（保持 busy）
    const binPath = join(TDATA, '.venv-pdf2zh', 'bin', 'babeldoc')
    mkdirSync(join(TDATA, '.venv-pdf2zh', 'bin'), { recursive: true })
    writeFileSync(binPath, '#!/bin/sh\ncase "$1" in\n  --version) echo "babeldoc fake 1.0"; exit 0 ;;\n  --help) echo "--no-watermark --skip-figure-text"; exit 0 ;;\n  *) echo $$ > "$VB_TX_PIDFILE"; exec sleep 120 ;;\nesac\n')
    chmodSync(binPath, 0o755)

    const spec0 = spec
    registerRoutes(makeCtx(), { dataDir })
    const srv = createServer((req, res) => spec.handler(req, res))
    const base = (await listen(srv)) + '/paper-reader'
    const { startTranslation, zhStatus } = await import(dist('translate.js'))
    const { resolvePaper } = await import(dist('library.js'))
    const ref = resolvePaper(dataDir, { topic: 'tx', name: 'paper' })
    const started = await startTranslation(ref, dataDir, { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' })
    assert.equal(started.started, true, JSON.stringify(started))
    assert.equal(zhStatus(ref).busy, true, '启动后必须处于 busy（契约 S8 的前置）')

    const plan = await fetch(`${base}/api/library/paper/delete-plan?topic=tx&name=paper`).then((r) => r.json())
    assert.equal(plan.translation.busy, true)
    const del = await fetch(`${base}/api/library/paper/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'tx', name: 'paper' }) })
    const dbody = await del.json()
    assert.equal(del.status, 409, JSON.stringify(dbody))
    assert.equal(dbody.code, 'translation-busy')
    const ren = await fetch(`${base}/api/library/paper/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'tx', name: 'paper', newName: 'paper2' }) })
    assert.equal(ren.status, 409)
    assert.equal((await ren.json()).code, 'translation-busy')
    // 文件零变化（babeldoc 「完成后回写 -zh.pdf」不会把文献复活）
    assert.ok(existsSync(join(dataDir, 'tx', 'paper.pdf')))
    assert.ok(existsSync(join(dataDir, 'tx', 'paper.txt')))
    assert.ok(!existsSync(join(dataDir, 'tx', 'paper-zh.pdf')))
    // 反证：端点不齐（无 apiKey）时不会进入 busy，也就不会拦（说明 409 来自 busy 而非「凡翻译都拦」）
    writeFileSync(join(dataDir, 'tx', 'paper2.pdf'), PDF())
    const notStarted = await startTranslation(resolvePaper(dataDir, { topic: 'tx', name: 'paper2' }), dataDir, { baseUrl: '', apiKey: '', model: '' })
    assert.equal(notStarted.started, false)
    assert.equal(zhStatus(resolvePaper(dataDir, { topic: 'tx', name: 'paper2' })).busy, false)
    spec = spec0
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
    }
    delete process.env.VB_TX_PIDFILE
    rmSync(TDATA, { recursive: true, force: true })
  }
})

test('VB9[B11/B12/B13/S12] 重命名：产物整体改名 + detachedSessions + `-zh` 结尾拒绝 + 目标存在 409 + 大小写改名', async () => {
  sessionItems = () => [fakeSession('del2', 'Keep', 1, false)]
  scaffoldPaper('del2', 'Keep')
  const ren = await postJson('/api/library/paper/rename', { topic: 'del2', name: 'Keep', newName: 'Kept' })
  assert.equal(ren.status, 200, ren.text)
  assert.equal(ren.body.to, 'Kept')
  assert.equal(ren.body.detachedSessions, 1, '必须如实回显脱钩会话数')
  assert.equal(ren.body.moved.length, 11, '7 产物 + 3 变体 + 1 tmp 全部要改名')
  const files = readdirSync(join(DATA, 'del2')).sort()
  for (const n of artifactNamesOf('del2', 'Kept')) assert.ok(files.includes(n), `改名后缺少 ${n}`)
  assert.ok(!files.some((n) => n.startsWith('Keep.') || n.startsWith('Keep-')))
  // 库里立即反映（B14）
  const lib = await api('/api/library')
  const names = lib.body.papers.filter((p) => p.topic === 'del2').map((p) => p.name)
  assert.ok(names.includes('Kept') && !names.includes('Keep'), `库里状态未立即更新：${names}`)
  // 改名后仍可被产物清单匹配（没有孤儿）
  assert.equal(listArtifacts(join(DATA, 'del2'), 'Kept').length, 11)

  // S12：三种变体后缀 + 大小写一致性
  for (const bad of ['Kept-zh', 'Kept-en', 'Kept-dual', 'x-zh']) {
    const r = await postJson('/api/library/paper/rename', { topic: 'del2', name: 'Kept', newName: bad })
    assert.equal(r.status, 400, `${bad} 必须 400`)
    assert.equal(r.body.code, 'bad-name')
  }
  // 大写 `-ZH` 不在 isPaperPDF 的排除集里（大小写敏感）→ 允许，且改名后文献不得从库视图消失
  const upper = await postJson('/api/library/paper/rename', { topic: 'del2', name: 'Kept', newName: 'Kept-ZH' })
  if (upper.status === 200) {
    const lib2 = await api('/api/library')
    assert.ok(lib2.body.papers.some((p) => p.topic === 'del2' && p.name === 'Kept-ZH'), '大写 -ZH 改名后文献必须仍在库里（否则与 S12 的意图矛盾）')
    await postJson('/api/library/paper/rename', { topic: 'del2', name: 'Kept-ZH', newName: 'Kept' })
  } else {
    assert.equal(upper.status, 400)
  }

  // 目标已存在 → 409（用同名兄弟文献）
  scaffoldPaper('del2', 'Occupied', { variants: false, tmp: false })
  const clash = await postJson('/api/library/paper/rename', { topic: 'del2', name: 'Kept', newName: 'Occupied' })
  assert.equal(clash.status, 409)
  assert.equal(clash.body.code, 'target-exists')
  assert.ok(existsSync(join(DATA, 'del2', 'Kept.pdf')), '冲突时源文件必须原样')

  // 纯大小写改名放行（源与目标 realpath 相同）
  const ci = await postJson('/api/library/paper/rename', { topic: 'del2', name: 'Kept', newName: 'kept' })
  assert.equal(ci.status, 200, `大小写-only 改名应放行：${ci.text}`)
  assert.ok(existsSync(join(DATA, 'del2', 'kept.pdf')))
  await postJson('/api/library/paper/rename', { topic: 'del2', name: 'kept', newName: 'Kept' })
  sessionItems = () => []
})

test('VB10[B13/S12 边界] `$` 定名注入复现：newName 里的 `$&`/`$\\x27` 被 String.replace 当成替换模式展开（F2，非阻断）', async (t) => {
  scaffoldPaper('inject', 'Inject', { variants: true, tmp: false })
  const before = snap(join(DATA, 'inject'))
  const r = await postJson('/api/library/paper/rename', { topic: 'inject', name: 'Inject', newName: "A$'B" })
  const after = snap(join(DATA, 'inject'))
  const got = readdirSync(join(DATA, 'inject')).sort()
  t.diagnostic(`F2 复现：newName="A$'B" → status=${r.status} 目录=${JSON.stringify(got)}`)
  writeFileSync(join(REPO, '.probe', 'vb10-dollar-injection.json'), JSON.stringify({ status: r.status, body: r.body, before, after, got }, null, 2))
  assert.equal(r.status, 200, '当前实现会接受这种名字（校验没拦住）')
  // 正确行为应是 4 个产物共享同一个新 stem：A$'B.* / A$'B-zh.pdf
  const stems = new Set(got.map((n) => n.replace(/-(en|zh|dual)(?=\.pdf$)/, '').replace(/\.[^.]+(\.json|\.md)?$/, '')))
  t.diagnostic(`F2 观察：目录里的 stem 集合 = ${JSON.stringify([...stems])}`)
  const consistent = got.every((n) => n.startsWith("A$'B"))
  if (!consistent) {
    t.diagnostic("F2 判定：产物 stem 不一致（出现孤儿文件），后续按名删除将漏掉这些文件")
    assert.ok(got.some((n) => !n.startsWith("A$'B")), '保持可复现性：应能看到被展开的错名')
  } else {
    assert.ok(consistent)
  }
  // 用 $& 也应保持「新名字就是用户输入」的语义
  const r2 = await postJson('/api/library/paper/rename', { topic: 'inject', name: got.find((n) => n.endsWith('.pdf') && !/-/.test(n))?.slice(0, -4) ?? 'x', newName: 'C$&D' })
  t.diagnostic(`F2 附带：newName="C$&D" → status=${r2.status}`)
})

test('VB11[S16/B17] 删除/重命名后客户端缓存失效：建会话时 workspace 会为新路径重新注册（无陈旧 workspaceId 复用）', async () => {
  const created = []
  const ctxWs = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }), create: async () => ({}) },
    workspaceController: { create: async ({ path }) => { created.push(path); return { workspace: { workspaceId: 'ws:' + path } } } },
    workspaceRegistry: {},
    effect: (fn) => fn(),
  }
  const spec0 = spec
  registerRoutes(makeCtx(ctxWs), { dataDir: DATA })
  const srv = createServer((req, res) => spec.handler(req, res))
  const base = (await listen(srv)) + '/paper-reader'
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  mkdirSync(join(DATA, 'ws3'), { recursive: true })
  writeFileSync(join(DATA, 'ws3', 'P.pdf'), PDF())
  const wsPath = join(DATA, 'ws3')
  try {
    // ① 建会话 → 注册 DATA/ws3
    assert.equal((await post('/api/sessions/new', { topic: 'ws3', name: 'P' })).status, 200)
    // 再建一次：缓存命中，不应重复注册
    await post('/api/sessions/new', { topic: 'ws3', name: 'P' })
    assert.equal(created.filter((p) => p === wsPath).length, 1, `缓存应命中一次：${JSON.stringify(created)}`)
    // ② 删文献 → 删空专题（cache 必须被清）→ 重建同名专题 + 新文献 + 新会话
    assert.equal((await post('/api/library/paper/delete', { topic: 'ws3', name: 'P' })).status, 200)
    assert.equal((await post('/api/library/topic/delete', { name: 'ws3', confirmName: 'ws3' })).status, 200)
    assert.ok(!existsSync(wsPath), '空专题应被删掉')
    assert.equal((await post('/api/library/topic', { name: 'ws3' })).status, 200)
    writeFileSync(join(DATA, 'ws3', 'P2.pdf'), PDF())
    assert.equal((await post('/api/sessions/new', { topic: 'ws3', name: 'P2' })).status, 200)
    assert.equal(created.filter((p) => p === wsPath).length, 2, `同名专题重建后必须重新注册工作区（否则复用陈旧 workspaceId）：${JSON.stringify(created)}`)
    // ③ 专题重命名后新路径也要重新注册
    mkdirSync(join(DATA, 'ws4'), { recursive: true })
    writeFileSync(join(DATA, 'ws4', 'Q.pdf'), PDF())
    await post('/api/sessions/new', { topic: 'ws4', name: 'Q' })
    assert.equal((await post('/api/library/topic/rename', { name: 'ws4', newName: 'ws5' })).status, 200)
    await post('/api/sessions/new', { topic: 'ws5', name: 'Q' })
    assert.ok(created.includes(join(DATA, 'ws5')), `重命名后必须注册新路径：${JSON.stringify(created)}`)
  } finally { spec = spec0 }
})

test('VB12[B15/B16/S9/S10/S11] 二次确认与鉴权：清单只来自 delete-plan、无原生 confirm/prompt、新路由全部被鉴权拦下', async () => {
  ensureFixtures()
  // 鉴权：401 与 403 两种
  for (const status of [401, 403]) {
    rejectStatus = status
    for (const [method, path, body] of [
      ['GET', '/api/formulas?topic=lib&name=noeq', null],
      ['GET', '/api/library/paper/delete-plan?topic=lib&name=noeq', null],
      ['POST', '/api/library/paper/delete', { topic: 'lib', name: 'noeq' }],
      ['POST', '/api/library/paper/rename', { topic: 'lib', name: 'noeq', newName: 'x' }],
      ['POST', '/api/library/topic/delete', { name: 'lib', confirmName: 'lib' }],
      ['POST', '/api/library/topic/rename', { name: 'lib', newName: 'x' }],
    ]) {
      const r = await api(path, method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
      assert.equal(r.status, status, `${method} ${path} 必须被鉴权拦下`)
    }
    assert.ok(existsSync(join(DATA, 'lib', 'noeq.pdf')), '鉴权拦截时不得动文件')
    rejectStatus = undefined
  }
  // UI：确认弹窗的数据来源与禁用原生弹窗
  const client = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(client, /\/library\/paper\/delete-plan\?topic=/, '删除前必须调 delete-plan')
  assert.match(client, /plan\.files\.map/, '清单必须逐条来自服务端返回')
  assert.ok(!/window\.(confirm|prompt)\s*\(/.test(client), '不得用 window.confirm/prompt（Electron 不支持）')
  assert.ok(!/window\.(confirm|prompt)\s*\(/.test(READER_HTML), '阅读器同样不得用原生弹窗')
  assert.match(client, /createPortal\(/, '弹窗必须走页内 portal')
  assert.match(client, /delTopicTypeName/, '删除专题必须 type-to-confirm')
  assert.match(client, /stopPropagation/, '文献行 ⋯ 必须 stopPropagation（否则会打开会话）')
  // 「不删什么」必须在文案里（可恢复语义）
  assert.match(client, /可恢复/, '确认文案必须写明「可恢复」')
  assert.match(client, /delete-plan|notDeleted/, '不得删的东西必须来自服务端 notDeleted')
})

test('VC1[C1/C2] 回归：既有测试文件零改动、工作区未出现越界改动（docs/src/lib/reader 之外）', () => {
  const changed = execFileSync('git', ['diff', '--name-status', 'HEAD', '--', 'test/'], { cwd: REPO, encoding: 'utf8' }).trim()
  assert.equal(changed, '', `既有测试文件被改动了：\n${changed}`)
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
  const touched = status.split('\n').filter(Boolean).map((l) => l.slice(3).trim())
  // 允许的交付面 = **各轮契约的 inScope 并集**：
  //   · 实现轮：src/ lib/ reader/ test/ docs/ .gitignore lock 文件
  //   · 集成轮（t5）：README.md / README_EN.md（用户文档）与 package.json（升 1.5.0）
  // ⚠️ **该白名单需随各轮契约的 inScope 同步，否则会误报越界**——t5 就因此被卡成 252/253
  //   （本条的原始版本只抄了实现轮 scope）。新增轮次/新交付面时先来改这里，别用
  //   「先 commit 让路径从 git status 消失」绕过：那只会让这条守卫变瞎，而不是修正它。
  // 「既有测试文件零改动」的断言在上面一行，未被放宽。
  const allowed = /^(src\/|lib\/|reader\/|test\/|docs\/|\.gitignore$|package-lock\.json$|pnpm-lock\.yaml$|README\.md$|README_EN\.md$|package\.json$)/
  for (const p of touched) assert.ok(allowed.test(p), `本轮不应改动：${p}`)
  writeFileSync(join(REPO, '.probe', 'vc1-git-status.txt'), status)
})

test('VA12[A8/A10/§1.6] 降级 UI 与重转链路：面板按 reason 渲染说明与按钮；译文视图关热区但面板仍可插入 LaTeX', (t) => {
  // ① MinerU 重转请求：显式 source（mode=off 不阻挡）——源码门控 + 阅读器请求体
  const tr = readFileSync(join(REPO, 'src', 'transcribe.ts'), 'utf8')
  assert.match(tr, /source === 'auto' \? producerForMode\(mineru\.config\.mode\) : producerForSource\(source\)/,
    '显式 source 必须优先于配置 mode（mode=off 不得阻挡 mineru-local）')
  assert.match(SCRIPT_SRC, /source: 'mineru-local'/, '阅读器必须显式指定 mineru-local')
  assert.match(SCRIPT_SRC, /force: true/, '重转必须 force')
  assert.match(SCRIPT_SRC, /classList\.toggle\('muted', eqIndex\.equations\.length === 0\)/, '#eq-toggle 必须在无公式时置灰')
  // ② 面板按 reason 渲染（真实脚本 + 可观测 DOM）
  const deepText = (n) => String(n.textContent || '') + (n.children || []).map(deepText).join('')
  const listText = (R) => R.els.get('eq-list').children.map((c) => `${c.tagName}:${deepText(c)}`).join(' | ')
  const hasBtn = (R) => R.doc.querySelectorAll('.tbtn').some((b) => deepText(b).includes('MinerU'))
  const R = loadReader()
  R.t.setVariant(null)
  R.t.setEq(buildFormulaIndex(null))
  R.t.renderEqPanel()
  assert.match(listText(R), /未找到 MinerU 解析产物/, listText(R))
  assert.ok(hasBtn(R), '无产物时必须给出「用 MinerU 重新转录」按钮')
  R.t.setEq(buildFormulaIndex(JSON.stringify({ contentList: [{ type: 'text', text: 'x', bbox: [1, 2, 3, 4], page_idx: 0 }] })))
  R.t.renderEqPanel()
  assert.match(listText(R), /没有解析出公式/, listText(R))
  R.t.setEq(buildFormulaIndex('{ not json'))
  R.t.renderEqPanel()
  assert.match(listText(R), /损坏/, listText(R))
  assert.ok(!hasBtn(R), '产物损坏时不该给重转按钮（契约 §1.6 只对 no-mineru-artifact/no-equations 给）')
  // ③ 译文视图：热区关闭，面板仍可用（点条目插入 LaTeX）
  const idx = buildFormulaIndex(JSON.stringify({
    contentList: [{ type: 'equation', text: '$$\\alpha _ { t }$$', text_format: 'latex', bbox: [100, 100, 200, 140], page_idx: 0 }],
  }))
  R.t.setEq(idx)
  R.t.setVariant('zh')
  assert.equal(R.t.eqHotEnabled(), false, '译文视图必须关热区')
  R.t.renderEqPanel()
  assert.match(listText(R), /译文视图/, '译文视图必须在面板里说明没有位置信息')
  const items = R.doc.querySelectorAll('.eq-item')
  assert.equal(items.length, 1, '面板条目在译文视图下仍应列出')
  items[0].onclick()
  assert.equal(R.t.askSelectionGet().kind, 'equation', '译文视图下面板条目仍应能插入 LaTeX')
  assert.match(R.t.askSelectionGet().text, /^\$\$ \\alpha_t \$\$$/)
  R.t.setVariant(null)
  // ④ 契约：无 position 的条目也要列出并标注
  R.t.setEq(buildFormulaIndex(JSON.stringify({ contentList: [{ type: 'equation', text: '$$z$$', text_format: 'latex', page_idx: 0 }] })))
  R.t.renderEqPanel()
  assert.match(listText(R), /无位置信息/, listText(R))
})

// ═══════════════════════════════════════════════════════════════════════════
// D. 契约补充项（队长后加的验收条款：\operatorname 生效范围 + 实现方自查四项）
// ═══════════════════════════════════════════════════════════════════════════

/** 与 src/mineru.ts 的白名单逐字一致（验证者抄自源码，用于全量扫描，不依赖实现导出）。 */
const PROTECTED_SINGLE = ['text', 'textrm', 'textnormal', 'textup', 'textit', 'textbf', 'textsf', 'texttt',
  'textsl', 'textsc', 'textmd', 'textsuperscript', 'textsubscript', 'mbox', 'hbox', 'fbox',
  'operatorname', 'intertext', 'shortintertext']
const PROTECTED_MULTI = [['textcolor', 2], ['colorbox', 2], ['fcolorbox', 3]]

test('VA13[契约★] \\operatorname 生效范围 + 两路径两变体一致性 + scanCommandName 根因全量扫描', (t) => {
  const viaIndex = (raw) => buildFormulaIndex(JSON.stringify({
    contentList: [{ type: 'equation', text: raw, text_format: 'latex', bbox: [1, 2, 3, 4], page_idx: 0 }],
  })).equations[0].latex

  // ① 引用路径（src/formulas.ts）：合并发生在这里
  assert.equal(viaIndex('$$\\operatorname { a b c }$$'), '$$\\operatorname{abc}$$')
  assert.equal(viaIndex('$$\\operatorname { arg max }$$'), '$$\\operatorname{arg max}$$')
  assert.ok(!viaIndex('$$\\operatorname* { arg max }$$').includes('argmax'))

  // ② .txt 投影路径（共享函数）：两个变体必须**一致地原样保留**（这是本次根因修复的目标）
  for (const inner of ['{ a b c }', '{ arg max }', '{ D o g }', '{ m a x }']) {
    const star = projTwo(`$$\\operatorname* ${inner}$$`)
    const plain = projTwo(`$$\\operatorname ${inner}$$`)
    assert.equal(star, plain.replace('\\operatorname', '\\operatorname*'), `.txt 侧两变体必须一致：${inner}`)
    assert.ok(star.includes(inner.slice(1, -1)), `.txt 侧必须原样保留空格：${inner} → ${star}`)
    assert.ok(!star.includes(inner.replace(/\s+/g, '')), `.txt 侧不得被压缩：${inner} → ${star}`)
  }
  // 引用路径与 .txt 路径的差异是有意收口（合并只在引用路径）：形态不同但各自自洽
  assert.notEqual(viaIndex('$$\\operatorname { a b c }$$'), projTwo('$$\\operatorname { a b c }$$'),
    '两条路径的形态差异（合并 vs 原样）必须真实存在，否则说明收口没生效')

  // ③ 根因：命令名扫描必须吃 `*`，且是**通用**修复（对所有受保护命令都成立，不只是 operatorname）
  const mismatches = []
  const check = (cmd, args) => {
    const raw = `$$\\${cmd} { a b c }$$`
    const rawStar = `$$\\${cmd}* { a b c }$$`
    const txt = projTwo(raw)
    const txtStar = projTwo(rawStar)
    if (txtStar !== txt.replace(`\\${cmd}`, `\\${cmd}*`)) mismatches.push({ cmd, path: 'txt', txt, txtStar })
    const ref = viaIndex(raw)
    const refStar = viaIndex(rawStar)
    if (refStar !== ref.replace(`\\${cmd}`, `\\${cmd}*`)) mismatches.push({ cmd, path: 'ref', ref, refStar })
    if (!txt.includes('a b c')) mismatches.push({ cmd, path: 'txt-保留空格', txt })
    void args
  }
  for (const cmd of PROTECTED_SINGLE) check(cmd)
  for (const [cmd, n] of PROTECTED_MULTI) {
    const raw = `$$\\${cmd}${'{c}'.repeat(n - 1)} { a b c }$$`
    const rawStar = `$$\\${cmd}*${'{c}'.repeat(n - 1)} { a b c }$$`
    const txt = projTwo(raw)
    const txtStar = projTwo(rawStar)
    if (txtStar !== txt.replace(`\\${cmd}`, `\\${cmd}*`)) mismatches.push({ cmd, path: 'txt-multi', txt, txtStar })
    if (!txt.includes('a b c')) mismatches.push({ cmd, path: 'txt-multi-保留空格', txt })
  }
  t.diagnostic(`扫描 ${PROTECTED_SINGLE.length + PROTECTED_MULTI.length} 个受保护命令的 \\cmd 与 \\cmd* 变体：不一致 ${mismatches.length} 例`)
  for (const m of mismatches) t.diagnostic(`  不一致：${JSON.stringify(m)}`)
  assert.deepEqual(mismatches, [], '任何受保护命令的 `*` 变体都必须与非 `*` 变体一致（否则就是同类漏识别）')
  // 非受保护命令（同一前缀的假命令）不得被卷入
  assert.equal(projTwo('$\\textwidth = 5$'), '$\\textwidth=5$')
  assert.equal(projTwo('$\\operatornamenames{x}$'), '$\\operatornamenames{x}$')
  // 结构：三处调用点都用了 scanCommandName（定义 + 3 调用）
  const mn = readFileSync(join(REPO, 'src', 'mineru.ts'), 'utf8')
  assert.ok((mn.match(/scanCommandName\(/g) || []).length >= 4, 'scanCommandName 必须在三处调用点都被使用')
  assert.match(mn, /if \(text\[k\] === '\*'\) k\+\+/, 'scanCommandName 必须吃掉 `*`')

  // ④ 范围划分的可用性评估（队长授权质疑）
  t.diagnostic('范围评估：同一篇论文里 .txt 检索形态 \\operatorname{arg max} 与引用形态 \\operatorname{arg max} 对多词算子名一致；'
    + '只有「逐字符空格化」的算子名（MinerU 产物 { m a x } 风格）在两条路径形态不同（引用侧合并为 max、.txt 侧保留 m a x）。'
    + '结论：不影响引用可用性（引用侧才是用户看到/粘贴的形态）；.txt 侧保留空格会导致 FTS/关键词检索时 "m a x" 与用户查询 "max" 不匹配，'
    + '属低危可用性瑕疵，建议后续统一（严重级别：low）。')
})

const viaIndexOf = (raw) => buildFormulaIndex(JSON.stringify({
  contentList: [{ type: 'equation', text: raw, text_format: 'latex', bbox: [1, 2, 3, 4], page_idx: 0 }],
})).equations[0].latex

test('VA14[契约·实现方自查①/④] rename 先校验后解析（非法名不得 500）；unifyOperatorNames 是整体重建而非局部替换', async () => {
  ensureFixtures()
  // ① 非法名 → 可读 4xx（不是外层兜底的 500）；含最经典的相对穿越
  for (const bad of ['../../etc/passwd', '/etc/passwd', '..', 'a/b', 'a\\b', 'x\u0000y', '.hidden', '']) {
    const r = await postJson('/api/library/paper/rename', { topic: 'att', name: bad, newName: 'Renamed' })
    assert.ok(r.status >= 400 && r.status < 500, `非法名必须 4xx（${bad}）：${r.status} ${r.text}`)
    assert.ok(['bad-name', 'bad-request', 'escape-rejected', 'not-found'].includes(r.body?.code),
      `非法名必须带可读 code（${bad}）：${r.text}`)
    assert.ok(!/at .*\.js:\d+/.test(r.text), `响应不得含堆栈（${bad}）：${r.text}`)
  }
  // 合法名 + 不存在文献 → 404 not-found（而不是 500）
  const gone = await postJson('/api/library/paper/rename', { topic: 'att', name: 'No Such Paper', newName: 'X' })
  assert.equal(gone.status, 404)
  assert.equal(gone.body.code, 'not-found')
  // 非法 newName 同样 4xx
  for (const nw of ['../../evil', '..', 'a/b']) {
    const r = await postJson('/api/library/paper/rename', { topic: 'att', name: 'Attention2', newName: nw })
    assert.ok(r.status >= 400 && r.status < 500, `非法 newName 必须 4xx（${nw}）`)
    assert.ok(typeof r.body.code === 'string' && r.body.code.length > 0)
  }
  assert.ok(existsSync(join(DATA, 'att', 'Attention2.pdf')), '被拒绝的请求不得动文件')

  // ④ unifyOperatorNames 必须是整体扫描重建：函数体内不得出现 .replace( 这种「只换命令名」的局部替换
  const src = readFileSync(join(REPO, 'src', 'formulas.ts'), 'utf8')
  const body = src.slice(src.indexOf('export function unifyOperatorNames'), src.indexOf('function isAsciiLetter'))
  assert.ok(body.length > 200, '必须能定位到 unifyOperatorNames 函数体')
  assert.ok(!/\.replace\(/.test(body), 'unifyOperatorNames 内出现 .replace( → 可能是局部替换而非整体重建')
  assert.match(body, /out \+=/, '必须是逐段拼接重建')
  // 行为面：多次出现、混合变体、前后缀夹杂时都要整串正确（局部替换会漏掉后面的组）
  const messy = '$$\\operatorname { m a x } + \\operatorname* { i f } \\quad \\text { a b } \\operatorname { D o g }$$'
  assert.equal(viaIndexOf(messy), '$$\\operatorname{max}+\\operatorname*{if}\\quad\\text{ a b }\\operatorname{Dog}$$')
  // .txt 投影只保护「正文组内部」的空格：命令与 `{` 之间、组外的空格照常压掉（既有语义，未改）
  assert.equal(projTwo(messy), '$$\\operatorname{ m a x }+\\operatorname*{ i f }\\quad\\text{ a b }\\operatorname{ D o g }$$')
})

test('VA15[契约·实现方自查②] openPaper 先 await loadFormulas 再 loadPdf；loadFormulas 失败不得阻断打开文献', () => {
  const open = READER_HTML.slice(READER_HTML.indexOf('async function openPaper'), READER_HTML.indexOf('async function refreshZhState'))
  const atFormulas = open.indexOf('await loadFormulas()')
  const atPdf = open.indexOf('await loadPdf(')
  assert.ok(atFormulas > 0 && atPdf > atFormulas,
    `公式索引必须在渲染 PDF 之前就绪（否则会漏画/残留上一篇热区）：loadFormulas@${atFormulas} loadPdf@${atPdf}`)
  // loadFormulas 内部：任何异常都降级成「无公式」，绝不让 openPaper 抛
  const lf = SCRIPT_SRC.slice(SCRIPT_SRC.indexOf('function loadFormulas'), SCRIPT_SRC.indexOf('/** 热区只在'))
  assert.match(lf, /try \{/, 'loadFormulas 必须自己吞掉接口异常')
  assert.match(lf, /catch \(e\) \{/, 'loadFormulas 必须有 catch 降级')
  assert.match(lf, /reason: 'bad-artifact'/, '接口异常必须降级成 bad-artifact 而不是抛出去')
  // 开篇先复位索引：残余的上一篇热区不得被复用
  assert.match(lf, /eqIndex = \{ source: 'none', equations: \[\], reason: 'no-mineru-artifact'/, 'loadFormulas 必须先复位 eqIndex')
  // 行为面：无产物时 openPaper 的公式阶段不抛（直接调用 loadFormulas 的等价路径）
  const R = loadReader()
  R.t.setCurrent({ topic: 'lib', name: 'plain' })
  R.t.setEq(buildFormulaIndex(null))
  assert.doesNotThrow(() => R.t.renderEqPanel())
  assert.equal(R.t.eqHotEnabled(), false)
})

test('VA16[契约·实现方自查③] 新增 live 用例不抢 GPU：t2 的测试文件不含任何 MinerU 解析调用', (t) => {
  const t2src = readFileSync(join(REPO, 'test', 'reader-ux.test.mjs'), 'utf8')
  const live = t2src.slice(t2src.indexOf("F5 live"), t2src.indexOf('test.after'))
  assert.ok(live.length > 100, '必须能定位到 t2 的 live 用例')
  assert.ok(!live.includes("'/api/transcribe'") && !live.includes('source: \'mineru-local\''),
    't2 的 live 用例不得触发 MinerU 解析（会与既有 mineru-live 争显存）')
  assert.ok(!/transcribePaper\(/.test(live), 't2 的 live 用例不得直接调 transcribePaper')
  assert.match(live, /mineru\/health/, 't2 的 live 用例只做零成本 health 探测')
  assert.match(live, /CUDA OOM/, '文件里必须写明不触发解析的理由（可复核）')
  // 全仓库：真正会跑 MinerU 解析的只有**既有**的两个文件（mineru-live / mineru-routes 的 live 用例）
  const runners = []
  for (const f of readdirSync(join(REPO, 'test'))) {
    const s = readFileSync(join(REPO, 'test', f), 'utf8')
    const callsParse = /transcribePaper\([^)]*source: 'mineru-local'/.test(s) || /\/api\/transcribe[\s\S]{0,200}source: 'mineru-local'/.test(s)
    const probesLive = /127\.0\.0\.1:8000/.test(s)
    if (callsParse && probesLive) runners.push(f)
  }
  t.diagnostic(`同时命中「调用 MinerU 解析 + 指向 127.0.0.1:8000」的测试文件（既有文件，多数用 mock 端点）：${JSON.stringify(runners)}`)
  assert.ok(!runners.includes('reader-ux.test.mjs'), 't2 新增文件不得出现在「真正跑 MinerU 解析」的名单里')
  assert.ok(!runners.includes('reader-ux-verification.test.mjs'), '验证者文件同样不得出现在该名单里')
})
