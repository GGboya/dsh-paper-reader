// test/darkmode-subtopic-features.test.mjs — 批次「深色模式 + 文献库结构改造」的**新行为**用例集。
//
// 为什么单独一个文件（t6 的由来）：t2 把四条功能实现了、既有 477 例全绿，但**一条新行为用例都没有**，
// 于是「实现是否真的按冻结方案工作」没有任何靶子。本文件给每条新行为一条**可区分**用例，
// 并配 `test/mutation-probe.mjs` 的变异验证（把实现改回缺陷态 → 这里对应用例必须变红）。
//
// 覆盖（与验收清单逐条对应）：
//   A. 深色：配置规范化/持久化、四级降级链（跟随 dsh / 浅色不生效 / 强制）、阅读器 CSS 契约
//      （滤镜只挂 canvas、绝不挂 .page/.textLayer/.eqLayer）、跨文档只有一个 storage 监听
//   B. 按论文分文件夹：新布局读写/列表/删除/改名 + 旧布局兼容读（已裁定的偏离，含「文件夹赢」）
//   C. 迁移：干跑=执行、幂等、复跑 moves=0&copied=0、无 X/X/X、回滚还原、中断不丢源、孤儿不动
//   D. 嵌套子专题：多层创建/改名/移动/子树清空、.trash 保护、非递归 rmdir 不变量
//   E. 按范围提问：单篇/专题子树、上下文只含该范围、五个上限生效、显式截断标注
//   F. t2 自查修掉的 4 个真实缺陷各自的回归用例
//
// 只 import dist/*.js（跑前 `npm run build`）；破坏性实验一律 mkdtemp 临时库，绝不碰真实文献库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeEol, extractModuleScript } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')

/**
 * 实测能力：本平台的文件系统是否**真的表达 POSIX mode 位**（chmod 0o600 后 stat 能否读回 0o600）。
 *   · POSIX（ext4/APFS）→ true；
 *   · Windows/NTFS → **false**（chmod 只映射「只读位」，`statSync().mode` 对普通文件恒为 0o666）。
 * 为什么需要它：PR #8 的 Windows CI（job 115752032053）在 A2 上报 `438 !== 384`，即 **0o666 !== 0o600** ——
 * 这不是行尾问题（384=0o600、438=0o666），而是「NTFS 不表达 mode 位」这个平台事实。硬编码断言 0600
 * 在 Windows 上**永远不会成立**；正确做法是按实测能力分支（而不是 t.skip、也不是把断言删掉）。
 */
const posixModeBits = (() => {
  const d = mkdtempSync(join(tmpdir(), 'dpr-modeprobe-'))
  try {
    const f = join(d, 'f')
    writeFileSync(f, 'x')
    chmodSync(f, 0o600)
    return (statSync(f).mode & 0o777) === 0o600
  } finally { rmSync(d, { recursive: true, force: true }) }
})()
const dist = (m) => join(ROOT, '..', 'dist', m)

const HOME = mkdtempSync(join(tmpdir(), 'dpr-t6-home-'))
process.env.DSH_HOME = HOME                       // 主题配置落在临时 HOME，绝不碰真实 ~/.dsh
const L = await import(pathToFileURL(dist('library.js')).href)
const M = await import(pathToFileURL(dist('library-manage.js')).href)
const MG = await import(pathToFileURL(dist('migrate.js')).href)
const SC = await import(pathToFileURL(dist('scope.js')).href)
const TC = await import(pathToFileURL(dist('theme-config.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

const { html: READER_HTML } = (() => {
  const raw = normalizeEol(readFileSync(join(REPO, 'reader', 'index.html'), 'utf8'))
  return { html: raw, script: extractModuleScript(raw, { where: 'reader/index.html' }) }
})()
const SCRIPT_SRC = extractModuleScript(READER_HTML, { where: 'reader/index.html' })

/** 临时库：`<data>/T/<论文>/<论文>.pdf` 新布局。 */
function newLib() {
  const root = mkdtempSync(join(tmpdir(), 'dpr-t6-'))
  const data = join(root, 'data')
  const home = join(root, 'home')
  mkdirSync(data, { recursive: true })
  mkdirSync(home, { recursive: true })
  return { root, data, home }
}

/** 新布局落一篇论文 + 任意产物。 */
function putPaper(data, topic, name, extra = ['.txt']) {
  const dir = join(data, topic, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.pdf'), `pdf:${topic}/${name}`)
  for (const s of extra) writeFileSync(join(dir, name + s), `body ${topic}/${name}`)
  return dir
}

/** 旧布局（平铺）落一篇论文 —— 迁移的输入。 */
function putFlatPaper(data, topic, name, extra = ['.txt']) {
  mkdirSync(join(data, topic), { recursive: true })
  writeFileSync(join(data, topic, name + '.pdf'), `pdf:${name}`)
  for (const s of extra) writeFileSync(join(data, topic, name + s), `body ${name}`)
}

async function boot(data) {
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const get = async (p) => {
    const r = await fetch(base + p)
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt }
  }
  const postJson = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt }
  }
  const postRaw = async (p, buf, headers) => {
    const r = await fetch(base + p, { method: 'POST', headers, body: buf })
    const txt = await r.text()
    let body = null
    try { body = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { status: r.status, body, txt }
  }
  return { srv, get, postJson, postRaw }
}

/* ═══════════════════════════════════════════════════════════════════════════
   A. 深色模式
   ═══════════════════════════════════════════════════════════════════════════ */

test('A1 主题配置：非法值一律回落默认；四档强度曲线与方案 §A2.1 表逐字一致', () => {
  assert.deepEqual(TC.normalizeThemeConfig(null), TC.THEME_DEFAULTS)
  assert.deepEqual(TC.normalizeThemeConfig({ pdfTheme: 'purple', pdfDarkStrength: 9, pdfDarkChrome: 'yes' }), TC.THEME_DEFAULTS)
  assert.equal(TC.THEME_DEFAULTS.pdfTheme, 'follow', '默认必须是 follow（用户原话「dsh 为深色时把 PDF 也变深色」）')
  assert.equal(TC.THEME_DEFAULTS.pdfDarkStrength, 1)
  assert.equal(TC.THEME_DEFAULTS.pdfDarkChrome, true)
  // 四档 = [1/1] [0.92/0.95] [0.85/0.9] [0.8/0.85]（实测白底 [0,0,0]/[6,6,6]/[13,13,13]/[19,19,19]）
  assert.deepEqual(TC.DARK_PRESETS.map((p) => [p.brightness, p.contrast]), [[1, 1], [0.92, 0.95], [0.85, 0.9], [0.8, 0.85]])
  for (const s of [0, 1, 2, 3]) {
    const c = TC.resolveDarkCurve({ pdfTheme: 'follow', pdfDarkStrength: s, pdfDarkChrome: true })
    assert.equal(c.brightness, TC.DARK_PRESETS[s].brightness, `强度 ${s} 的 brightness`)
  }
  // 高级滑杆优先于档位；越界（<0.5 / >1）视为非法 → 回落档位
  const adv = TC.resolveDarkCurve({ pdfTheme: 'dark', pdfDarkStrength: 3, pdfDarkChrome: true, pdfDarkAdvanced: { brightness: 0.7, contrast: 0.8 } })
  assert.deepEqual(adv, { brightness: 0.7, contrast: 0.8 })
  assert.deepEqual(TC.normalizeThemeConfig({ pdfDarkAdvanced: { brightness: 0.2, contrast: 0.8 } }).pdfDarkAdvanced, undefined)
  assert.throws(() => TC.validateThemePatch({ pdfDarkAdvanced: { brightness: 1.4, contrast: 0.8 } }), /brightness/)
  assert.throws(() => TC.validateThemePatch({ pdfTheme: 'purple' }), /pdfTheme/)
})

test('A2 主题配置持久化：写盘 → 回读 → DELETE 回落默认（重启后仍在）', async () => {
  const { home } = newLib()
  assert.deepEqual(await TC.readThemeConfig(home), TC.THEME_DEFAULTS, '没配过 = 默认')
  await TC.writeThemeConfig({ pdfTheme: 'dark', pdfDarkStrength: 3, pdfDarkChrome: false }, home)
  const back = await TC.readThemeConfig(home)
  assert.deepEqual(back, { pdfTheme: 'dark', pdfDarkStrength: 3, pdfDarkChrome: false }, '重启后必须原样读回')
  const cfgPath = TC.themeConfigPath(home)
  assert.equal(existsSync(cfgPath), true, '配置文件必须真的落在预期路径（平台无关）')
  if (posixModeBits) {
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600, '配置文件必须 0600（本机实测 chmod 生效）')
    // 「已存在的宽权限文件必须被收紧」——这正是 writeThemeConfig 里那句显式 chmod 存在的理由
    // （writeFile 的 mode 只在**新建**时生效）。这条在 POSIX 上平台无关地证明「每次写都收紧」。
    chmodSync(cfgPath, 0o666)
    await TC.writeThemeConfig({ pdfTheme: 'dark', pdfDarkStrength: 3, pdfDarkChrome: false }, home)
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600, '重写已存在的宽权限文件必须收紧回 0600')
  } else {
    // 本平台不表达 POSIX mode 位（典型 win32）：断言 mode === 0o600 是**跨平台不可能成立**的。
    // 换成平台无关的**等价强度**断言：① 文件确实在预期路径；② 写入路径**确实请求**了 0600
    // （源码级断言：防止有人以「反正 Windows 不生效」为由把 chmod 删掉，那样 Unix 上就真的不收紧）；
    // ③ 实测记录本平台的实际 mode（若哪天 Windows 行为变了，这条会先报出来，而不是被静默跳过）。
    assert.match(readFileSync(join(REPO, 'src', 'theme-config.ts'), 'utf8'),
      /mode: 0o600[\s\S]{0,200}chmod\(file, 0o600\)/,
      '写入路径必须同时用 writeFile 的 mode 与显式 chmod 请求 0600')
    assert.equal(statSync(cfgPath).mode & 0o777, 0o666, '实测：NTFS 上普通文件 mode 恒为 0o666（不是 0o600）')
  }
  await TC.clearThemeConfig(home)
  assert.deepEqual(await TC.readThemeConfig(home), TC.THEME_DEFAULTS, '清掉后回落默认 follow')
})

test('A3 路由 /api/theme/config：GET 回生效值+曲线、POST 校验后落盘、非法值 400、DELETE 回落', async () => {
  const { data, home } = newLib()
  const { srv, get, postJson } = await boot(data)
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home                       // 路由内部按 dshHome() 解析
  try {
    const g0 = await get('/api/theme/config')
    assert.equal(g0.status, 200)
    assert.equal(g0.body.pdfTheme, 'follow')
    assert.deepEqual(g0.body.curve, { brightness: 0.92, contrast: 0.95 }, '默认强度档的曲线')
    const bad = await postJson('/api/theme/config', { pdfTheme: 'rainbow' })
    assert.equal(bad.status, 400, '非法模式必须 400，绝不半截生效')
    assert.equal((await get('/api/theme/config')).body.pdfTheme, 'follow', '被拒后配置未变')
    const ok = await postJson('/api/theme/config', { pdfTheme: 'dark', pdfDarkStrength: 2 })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.curve, { brightness: 0.85, contrast: 0.9 }, '响应直接回新曲线（阅读器据此写 CSS 变量）')
    assert.equal(existsSync(join(home, '.dsh-paper-reader', 'theme.json')), true, '必须落盘')
    const noop = await postJson('/api/theme/config', {})
    assert.equal(noop.status, 200, '空补丁 = 无操作（合法）')
    assert.equal((await get('/api/theme/config')).body.pdfTheme, 'dark', '无操作不得改值')
  } finally { process.env.DSH_HOME = prevHome; srv.close() }
})

test('A4 路由 DELETE /api/theme/config 回落默认（用真实 DELETE 方法）', async () => {
  const { data, home } = newLib()
  let spec = null
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await TC.writeThemeConfig({ pdfTheme: 'off', pdfDarkStrength: 0, pdfDarkChrome: false }, home)
    const del = await fetch(base + '/api/theme/config', { method: 'DELETE' })
    assert.equal(del.status, 200)
    const body = await del.json()
    assert.equal(body.pdfTheme, 'follow', 'DELETE = 回落默认（不是 404）')
    assert.deepEqual(await TC.readThemeConfig(home), TC.THEME_DEFAULTS)
  } finally { process.env.DSH_HOME = prevHome; srv.close() }
})

/** 用 DOM stub 跑**真实阅读器脚本**（同 reader-ux.test.mjs 的口径），并额外提供父文档/matchMedia/localStorage。 */
function loadReaderTheme({ hostDark = false, hostSource = null, prefersDark = false, mirror = null, parentThrows = false } = {}) {
  const mkEl = () => ({
    style: { setProperty() {} }, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    textContent: '', value: '', innerHTML: '', children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] ?? null },
    hasAttribute(k) { return k in this.attrs },
    appendChild() {}, append() {}, remove() {}, focus() {}, select() {}, click() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    contains() { return false }, scrollIntoView() {}, closest() { return null },
  })
  const parentBody = mkEl()
  if (hostDark) parentBody.setAttribute('data-ds-dark-theme', '')
  const parentHtml = mkEl()
  if (hostSource) parentHtml.setAttribute('data-ds-theme-source', hostSource)
  const store = new Map(mirror ? Object.entries(mirror) : [])
  const doc = {
    documentElement: mkEl(),
    getElementById(id) { if (!this._els) this._els = new Map(); if (!this._els.has(id)) this._els.set(id, mkEl()); return this._els.get(id) },
    createElement() { return mkEl() }, querySelector() { return null }, querySelectorAll() { return [] },
    body: mkEl(), addEventListener() {},
  }
  const parent = { document: parentThrows ? null : { body: parentBody, documentElement: parentHtml } }
  if (parentThrows) Object.defineProperty(parent, 'document', { get() { throw new Error('SecurityError: cross-origin') } })
  const win = {
    devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900, parent,
    addEventListener() {}, getSelection: () => null,
    matchMedia: () => ({ matches: prefersDark, addEventListener() {}, removeEventListener() {} }),
  }
  const ctx = {
    document: doc, window: win, navigator: {}, location: { search: '' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i], get length() { return store.size } },
    matchMedia: win.matchMedia, MutationObserver: undefined, JSON, Promise, Math, Object, Array, Number, String, Boolean, Error, RegExp, Date, URLSearchParams, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.reject(new Error('no network in test')),
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(SCRIPT_SRC + `
    ;globalThis.__t = {
      effectivePdfTheme, hostThemeSource, applyPdfTheme, setThemeLocal, syncThemeControls,
      getTheme: () => ({ ...dprTheme }), askScopeMode, setAskScopeMode, attr: () => document.documentElement.getAttribute('data-dpr-pdf'),
      chrome: () => document.documentElement.getAttribute('data-dpr-chrome'),
      vars: () => ({ b: document.documentElement.style.setProperty.calls }),
    };`, ctx, { filename: 'reader-inline.js' })
  return { t: ctx.__t, ctx, store }
}

test('A5 深色四级降级链：跟随 dsh（① body 属性 ② html 来源 ③ prefers-color-scheme ④ 全失败→亮色）', () => {
  // ① 宿主 body[data-ds-dark-theme] —— 最权威
  assert.equal(loadReaderTheme({ hostDark: true }).t.effectivePdfTheme(), 'dark')
  // ② 宿主 html[data-ds-theme-source]
  assert.equal(loadReaderTheme({ hostSource: 'dark' }).t.effectivePdfTheme(), 'dark')
  // ②' source 明确为 light 时**不得**被 prefers-color-scheme 翻成深色（来源比 OS 偏好权威）
  assert.equal(loadReaderTheme({ hostSource: 'light', prefersDark: true }).t.effectivePdfTheme(), 'light')
  // ③ 读不到宿主（跨源/沙箱）⇒ 退到自身 prefers-color-scheme
  assert.equal(loadReaderTheme({ prefersDark: true }).t.effectivePdfTheme(), 'dark')
  // ③' 跨源抛异常也不许冒泡，且判亮色（宁可该黑没黑，绝不误黑）
  assert.equal(loadReaderTheme({ parentThrows: true, prefersDark: false }).t.effectivePdfTheme(), 'light')
  assert.equal(loadReaderTheme({ parentThrows: true }).t.hostThemeSource(), null)
  // ④ 全失败 ⇒ 亮色
  assert.equal(loadReaderTheme({}).t.effectivePdfTheme(), 'light')
})

test('A6 深色开关：强制深色/强制浅色/关闭优先于宿主；「关闭」在深色 dsh 下必须不生效', () => {
  const forced = loadReaderTheme({ hostSource: 'light', mirror: { 'dpr.pdfThemeCfg': JSON.stringify({ mode: 'dark' }) } })
  assert.equal(forced.t.effectivePdfTheme(), 'dark', '强制深色要压过宿主浅色')
  const off = loadReaderTheme({ hostDark: true, mirror: { 'dpr.pdfThemeCfg': JSON.stringify({ mode: 'off' }) } })
  assert.equal(off.t.effectivePdfTheme(), 'light', '「关闭」在深色 dsh 下也必须保持原色（用户可一键绕过）')
  const light = loadReaderTheme({ hostDark: true, mirror: { 'dpr.pdfThemeCfg': JSON.stringify({ mode: 'light' }) } })
  assert.equal(light.t.effectivePdfTheme(), 'light')
})

test('A7 首帧判定与偏好持久化：localStorage 镜像在脚本一开头就被读（无白闪的同步路径）', () => {
  const dark = loadReaderTheme({ mirror: { 'dpr.pdfTheme': 'dark' } })
  assert.equal(dark.t.attr(), 'dark', '镜像说 dark ⇒ 首帧属性必须已经是 dark（不等网络）')
  const follow = loadReaderTheme({ hostDark: true })
  assert.equal(follow.t.attr(), 'dark', 'follow + 宿主深色 ⇒ 首帧就是 dark')
  const none = loadReaderTheme({})
  assert.equal(none.t.attr(), 'light', '什么都读不到 ⇒ 亮色（绝不误黑）')
  // 切换后要写镜像（下次开页才有无网络首帧判定的依据）
  const { t, store } = loadReaderTheme({})
  t.setThemeLocal({ mode: 'dark', strength: 2, chrome: false })
  assert.equal(store.get('dpr.pdfTheme'), 'dark')
  const mir = JSON.parse(store.get('dpr.pdfThemeCfg'))
  assert.deepEqual({ mode: mir.mode, strength: mir.strength, chrome: mir.chrome }, { mode: 'dark', strength: 2, chrome: false })
  assert.equal(t.attr(), 'dark')
  assert.equal(t.chrome(), 'off', 'pdfDarkChrome=false ⇒ 只反 PDF，不动阅读器 UI')
})

test('A8 阅读器 CSS 契约：滤镜只挂 canvas，绝不挂 .page/.textLayer/.eqLayer（选区与热区不被反色）', () => {
  // 断言的是**真实 CSS 规则**（不是注释）：取所有含 filter 的规则块
  const CSS = READER_HTML.replace(/\/\*[\s\S]*?\*\//g, '')   // 注释里有 .eqLayer/.textLayer 字样，必须剥掉再匹配规则
  const filterRules = [...CSS.matchAll(/([^{}]+)\{([^{}]*filter\s*:[^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }))
  assert.ok(filterRules.length >= 1, '必须有滤镜规则（否则深色没实现）')
  for (const r of filterRules) {
    assert.ok(/canvas/.test(r.sel), `滤镜必须挂在 canvas 上：${r.sel}`)
    assert.ok(!/\.page\s*\{|\.page\s*,|\.page$/.test(r.sel.replace(/canvas/g, '')), `绝不能直接挂 .page（会把热区描边与 ::selection 一起反转）：${r.sel}`)
    assert.ok(!/textLayer|eqLayer|eq-box/.test(r.sel), `绝不能挂文本层/热区层：${r.sel}`)
    assert.match(r.body, /invert\(1\)[\s\S]*hue-rotate\(180deg\)/, `必须是方案选定的 invert+hue-rotate 路线：${r.body}`)
    assert.match(r.body, /brightness\(var\(--dpr-dark-b/, '亮度必须可调（设置项要能改）')
    assert.match(r.body, /contrast\(var\(--dpr-dark-c/, '对比度必须可调')
  }
  // 深色下 .page 只换底色（页面本身变暗），不碰几何
  assert.match(CSS, /html\[data-dpr-pdf="dark"\]\s*\.page\s*\{[^}]*background\s*:\s*#1b1b1c/)
  // 首帧防白闪：判定完成前藏住页面区
  assert.match(CSS, /data-dpr-pdf="pending"[^}]*visibility:\s*hidden/)
  // dsh 主题接口名必须与一级来源一致（写错就永远读不到）
  assert.match(SCRIPT_SRC, /data-ds-dark-theme/)
  assert.match(SCRIPT_SRC, /data-ds-theme-source/)
  // 降级方向必须朝亮色：默认值 + catch 都落到 light
  assert.match(SCRIPT_SRC, /var mode = 'light'/)
})

test('A9 跨文档同步只有一个 window storage 监听（多处监听会回声/双写）', () => {
  const n = (SCRIPT_SRC.match(/addEventListener\('storage'/g) ?? []).length
  assert.equal(n, 1, `全脚本只允许一个 storage 监听，实测 ${n}`)
  // 那一个监听必须同时负责主题镜像与同步滚动（按 key 分派）
  const block = SCRIPT_SRC.slice(SCRIPT_SRC.indexOf("addEventListener('storage'"))
  assert.match(block.slice(0, 600), /THEME_MIRROR_KEY/, 'storage 入口必须处理主题镜像 key')
  assert.match(block.slice(0, 600), /SYNC_SCROLL_KEY/, 'storage 入口必须保留原有的同步滚动分支')
})

test('A10 图片代价如实写明（已知代价，不假装不存在）', () => {
  const client = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const zh = client.match(/const zh = \{([\s\S]*?)\n    \}/)?.[1] ?? ''
  const en = client.match(/const en = \{([\s\S]*?)\n    \}/)?.[1] ?? ''
  // F5：文案必须是**准确**的去饱和描述（实测纯红 [255,0,0] → [229,134,134]，不是真负片）
  assert.match(zh, /setThemeDesc: '[^']*褪色偏色/, 'zh 文案必须写明图片会褪色偏色（不是「变负片」）')
  assert.match(zh, /setThemeDesc: '[^']*不是真负片/, 'zh 文案必须点明「不是真负片」（诚实描述）')
  assert.match(zh, /setThemeDesc: '[^']*229,134,134/, 'zh 文案必须给出实测取值（可核对）')
  assert.match(en, /setThemeDesc: '[^']*desaturate/, 'en 文案必须写明 desaturate')
  assert.match(en, /setThemeDesc: '[^']*not a true negative/, 'en 文案必须点明 not a true negative')
  assert.match(zh, /setThemeDesc: '[^']*下载[^']*原文/, 'zh 文案必须说明下载/导出不受影响')
  assert.doesNotMatch(zh, /setThemeDesc: '[^']*会变负片/, '不得再声称「会变负片」（实测是褪色偏色）')
})

/* ═══════════════════════════════════════════════════════════════════════════
   B. 按论文分文件夹（新布局 + 已裁定的旧布局兼容读）
   ═══════════════════════════════════════════════════════════════════════════ */

test('B1 新布局读写：上传落 <topic>/<名>/<名>.pdf；resolvePaper/listPapers 的 topic 是**父级**', async () => {
  const { data } = newLib()
  const { srv, get, postRaw } = await boot(data)
  try {
    const up = await postRaw('/api/library/upload', Buffer.alloc(200, 1), { 'x-dpr-topic': 'T', 'x-dpr-name': 'Paper One.pdf', 'content-type': 'application/pdf' })
    assert.equal(up.status, 200, up.txt)
    assert.equal(existsSync(join(data, 'T', 'Paper One', 'Paper One.pdf')), true, '落点必须是论文文件夹')
    assert.equal(existsSync(join(data, 'T', 'Paper One.pdf')), false, '绝不再平铺到专题目录')
    const lib = await get('/api/library')
    assert.equal(lib.body.papers.length, 1)
    assert.equal(lib.body.papers[0].topic, 'T', 'topic 必须是论文目录的**父级**（协议不变：?topic=T&name=Paper One）')
    assert.equal(lib.body.papers[0].name, 'Paper One')
    assert.equal(lib.body.papers[0].legacy, undefined, '新布局不带 legacy 标记')
    assert.equal(lib.body.papers[0].pdfPath, join(data, 'T', 'Paper One', 'Paper One.pdf'))
    // tree 也要能表达嵌套
    assert.equal(lib.body.tree[0].path, 'T')
    assert.deepEqual(lib.body.tree[0].papers, ['Paper One'])
    // resolvePaper 能按 topic+name 找回
    const ref = L.resolvePaper(data, { topic: 'T', name: 'Paper One' })
    assert.equal(ref.pdfPath, join(data, 'T', 'Paper One', 'Paper One.pdf'))
    assert.equal(ref.txtPath, join(data, 'T', 'Paper One', 'Paper One.txt'))
  } finally { srv.close() }
})

test('B2 新布局删除/改名：论文文件夹整体消失/整体改名（含文件夹内文件名同步）', () => {
  const { data } = newLib()
  putPaper(data, 'T', 'Old', ['.pdf', '.txt', '.study.json'].filter((x) => x !== '.pdf'))
  const del0 = M.deletePaper(data, 'T', 'Old')
  assert.deepEqual(del0.moved.sort(), ['Old.pdf', 'Old.study.json', 'Old.txt'].sort(), '.pdf 也在里面')
  assert.equal(del0.dirRemoved, true, '论文文件夹必须被（非递归）收口掉')
  assert.equal(existsSync(join(data, 'T', 'Old')), false)

  putPaper(data, 'T', 'A')
  const r = M.renamePaper(data, 'T', 'A', 'B')
  assert.equal(r.to, 'B')
  assert.equal(existsSync(join(data, 'T', 'B', 'B.pdf')), true, '文件夹改名 + 内部文件名改名')
  assert.equal(existsSync(join(data, 'T', 'B', 'B.txt')), true)
  assert.equal(existsSync(join(data, 'T', 'A')), false)
  assert.equal(existsSync(join(data, 'T', 'B', 'A.pdf')), false, '不得留下旧名产物（否则是无法按名删除的孤儿）')
  assert.deepEqual(r.moved.sort(), ['B.pdf', 'B.txt'])
  assert.equal(L.listPapers(data, 'T').filter((p) => p.name === 'B').length, 1)
})

test('B3 旧布局兼容读（队长裁定的偏离）：平铺仍可列出/定位/删除，带 legacy 标记', async () => {
  const { data } = newLib()
  putFlatPaper(data, 'T', 'Legacy', ['.txt'])
  const papers = L.listPapers(data, 'T')
  assert.equal(papers.length, 1)
  assert.equal(papers[0].name, 'Legacy')
  assert.equal(papers[0].legacy, true, '旧布局必须被标记，UI/迁移据此提示')
  assert.equal(L.resolvePaper(data, { topic: 'T', name: 'Legacy' }).pdfPath, join(data, 'T', 'Legacy.pdf'), '定位回落平铺文件')
  const { srv, postJson } = await boot(data)
  try {
    const del = await postJson('/api/library/delete-paper', { topic: 'T', name: 'Legacy' })
    assert.equal(del.status, 200, del.txt)
    assert.equal(existsSync(join(data, 'T', 'Legacy.pdf')), false)
    assert.equal(existsSync(join(data, 'T', 'Legacy.txt')), false)
  } finally { srv.close() }
})

test('B4 「文件夹赢」是确定性优先级：同名平铺 + 文件夹并存时只列一次且解析到文件夹', () => {
  const { data } = newLib()
  putFlatPaper(data, 'T', 'Both', ['.txt'])
  putPaper(data, 'T', 'Both', ['.txt'])
  const papers = L.listPapers(data, 'T').filter((p) => p.name === 'Both')
  assert.equal(papers.length, 1, '绝不能同一篇报两次（二义性就是这个偏离要消除的东西）')
  assert.equal(papers[0].legacy, undefined, '文件夹赢 ⇒ 不是 legacy')
  assert.equal(L.resolvePaper(data, { topic: 'T', name: 'Both' }).pdfPath, join(data, 'T', 'Both', 'Both.pdf'))
  assert.equal(L.resolvePaper(data, { topic: 'T', name: 'Both' }).txtPath, join(data, 'T', 'Both', 'Both.txt'), '产物也走文件夹，不串到平铺那份')
})

/* ═══════════════════════════════════════════════════════════════════════════
   C. 迁移
   ═══════════════════════════════════════════════════════════════════════════ */

test('C1 干跑只读：planMigration 不改盘；报告含 6 类清单且与方案口径一致', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P1')
  putFlatPaper(data, 'T', 'P2')
  mkdirSync(join(data, 'T', 'Sub'), { recursive: true })
  putFlatPaper(data, 'T/Sub', 'P3')
  writeFileSync(join(data, 'T', 'note.md'), 'user note')       // 孤儿：不匹配任何论文 stem
  writeFileSync(join(data, 'T', '.DS_Store'), 'x')             // 隐藏：不动
  const before = readdirSync(data, { recursive: true }).sort()
  const plan = MG.planMigration(data, home)
  assert.deepEqual(readdirSync(data, { recursive: true }).sort(), before, '干跑必须零写盘')
  assert.equal(plan.moves.length, 6, `3 篇 × 2 个产物（.pdf + .txt）：${JSON.stringify(plan.moves.map((m) => m.from))}`)
  assert.deepEqual(plan.orphans, ['T/note.md'])
  assert.deepEqual(plan.hidden, ['T/.DS_Store'])
  assert.deepEqual(plan.conflicts, [])
  assert.deepEqual(plan.quarantine, [])
  const report = MG.formatMigrationReport(plan)
  assert.match(report, /待迁移：3 篇/)
  assert.match(report, /孤儿文件/)
  assert.match(report, /note\.md/, '报告必须点名孤儿（人要能核对）')
})

test('C2 执行：干跑的 moves 与磁盘真实变化逐条一致，且源文件按 size/sha256 校验后才删', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P1')
  putFlatPaper(data, 'T/Sub', 'P2')
  const plan = MG.planMigration(data, home)
  // 结构不变量：moves 只允许落在**不存在**的目标上（已存在的目标必须走 alreadyDone/conflict，
  // 否则阶段 1 会覆盖它 —— 这正是 F-A/F2 的祸根）
  for (const m of plan.moves) assert.equal(existsSync(join(data, m.to)), false, `moves 目标必须不存在：${m.to}`)
  const log = join(home, 'mig.log.jsonl')
  const res = MG.runMigration(data, { home, logPath: log })
  assert.equal(res.ok, true)
  assert.equal(res.copied, plan.moves.length, '复制数 = 干跑计划数')
  assert.equal(res.skipped, 0)
  assert.equal(res.removed, plan.moves.length, '源文件全部清掉（目标已校验一致）')
  for (const m of plan.moves) {
    assert.equal(existsSync(join(data, m.to)), true, `干跑说会到 ${m.to}`)
    assert.equal(existsSync(join(data, m.from)), false, `源必须被清掉 ${m.from}`)
  }
  const entries = MG.readMigrationLog(log)
  assert.equal(entries.length, plan.moves.length, '日志逐条可回滚')
  for (const e of entries) assert.match(e.sha256, /^[0-9a-f]{64}$/, '每条都要有 sha256 校验值')
  // 内容零变化：迁移后每个文件的内容 = 迁移前
  assert.equal(readFileSync(join(data, 'T', 'P1', 'P1.pdf'), 'utf8'), 'pdf:P1')
  assert.equal(readFileSync(join(data, 'T', 'Sub', 'P2', 'P2.txt'), 'utf8'), 'body P2')
  assert.equal(existsSync(join(data, MG.DONE_MARKER)), true, '完成标记必须写')
})

test('C3 幂等/复跑：第二次 moves=0 且 copied=0，绝不产生 X/X/X 套娃', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P1')
  putFlatPaper(data, 'T', 'P2')
  MG.runMigration(data, { home, logPath: join(home, 'a.jsonl') })
  const plan2 = MG.planMigration(data, home)
  assert.equal(plan2.moves.length, 0, '复跑规划必须为空（论文目录不递归的不变量）')
  assert.equal(plan2.alreadyDone.length, 0, '源已被清掉，没有「已完成待清源」的条目')
  const res2 = MG.runMigration(data, { home, logPath: join(home, 'b.jsonl') })
  assert.equal(res2.copied, 0)
  assert.equal(res2.removed, 0)
  assert.deepEqual(MG.planMigration(data, home).paperDirs.sort(), ['T/P1', 'T/P2'], '已迁移的论文文件夹要被识别出来（报告字段不能空）')
  // 套娃检测：任何形如 X/X/X 的路径都不许存在
  const all = readdirSync(data, { recursive: true }).map(String)
  for (const p of all) {
    const segs = p.split('/')
    assert.ok(!(segs.length >= 3 && segs.at(-1) === segs.at(-2)), `怀疑二次嵌套：${p}`)
  }
  assert.equal(existsSync(join(data, 'T', 'P1', 'P1', 'P1.pdf')), false, '绝不产生 X/X/X.pdf')
  assert.deepEqual(readdirSync(join(data, 'T', 'P1')).sort(), ['P1.pdf', 'P1.txt'])
})

test('C4 回滚：按日志倒序搬回原位，形状回到迁移前（含空目录收口）', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P1')
  putFlatPaper(data, 'T', 'P2', ['.txt', '.pages.json'])
  const before = readdirSync(data, { recursive: true }).sort()
  const res = MG.runMigration(data, { home, logPath: join(home, 'r.jsonl') })
  assert.equal(existsSync(join(data, 'T', 'P1.pdf')), false)
  const rb = MG.rollbackMigration(data, res.logPath)
  assert.equal(rb.restored, 5, 'P1(2) + P2(3) 个产物搬回原位')
  assert.deepEqual(readdirSync(data, { recursive: true }).filter((p) => !String(p).includes(MG.DONE_MARKER)).sort(), before.filter((p) => !String(p).includes(MG.DONE_MARKER)).sort())
  assert.equal(readFileSync(join(data, 'T', 'P2.pages.json'), 'utf8'), 'body P2')
  assert.equal(existsSync(join(data, 'T', 'P1')), false, '空的论文文件夹要被收口')
  assert.equal(existsSync(join(data, MG.DONE_MARKER)), false, '回滚后完成标记要清掉（库已回到旧布局）')
})

test('C5 可中断：复制到第 k 条被杀 ⇒ **源一个都不少**，日志可复跑/可回滚', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P1')
  putFlatPaper(data, 'T', 'P2')
  let aborted = null
  try {
    MG.runMigration(data, { home, logPath: join(home, 'i.jsonl'), failAfterCopies: 2 })
    assert.fail('注入的中断必须抛出 MigrationAborted')
  } catch (e) { aborted = e }
  assert.equal(aborted instanceof MG.MigrationAborted, true, `必须是可识别的中断类型：${aborted}`)
  assert.equal(aborted.detail.done.length, 2)
  assert.equal(aborted.detail.remaining.length, 2, '共 4 条 move，复制完 2 条后被杀')
  // 关键不变量：**阶段 2 没开始 ⇒ 源文件全部完好**
  assert.equal(existsSync(join(data, 'T', 'P1.pdf')), true)
  assert.equal(existsSync(join(data, 'T', 'P2.pdf')), true)
  assert.equal(readFileSync(join(data, 'T', 'P1.txt'), 'utf8'), 'body P1')
  // 副本已就位（先复制后删，任何时刻至少一份完整产物）
  assert.equal(existsSync(join(data, 'T', 'P1', 'P1.pdf')), true)
  // 复跑：已复制项变成 already-done（只清源），继续跑完
  const plan = MG.planMigration(data, home)
  assert.equal(plan.alreadyDone.length, 2)
  assert.equal(plan.moves.length, 2)
  const res = MG.runMigration(data, { home, logPath: join(home, 'i2.jsonl') })
  assert.equal(res.copied, 2)
  assert.equal(res.removed, 4, '2 个已完成 + 2 个新复制的源都要清掉')
  assert.equal(existsSync(join(data, 'T', 'P1.pdf')), false)
})

test('C6 冲突/需人工一律**先报告不执行**（绝不半途动数据）', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P1')
  mkdirSync(join(data, 'T'), { recursive: true })
  writeFileSync(join(data, 'T', 'P2'), 'a plain FILE where the paper folder should go') // 目标名被文件占据
  putFlatPaper(data, 'T', 'P2', ['-x']) // 让 P2 成为一篇论文（P2.pdf 存在），但目标目录名被文件占据
  const plan = MG.planMigration(data, home)
  assert.equal(plan.conflicts.length >= 1, true, `干跑必须报冲突：${JSON.stringify(plan)}`)
  assert.match(MG.formatMigrationReport(plan), /跳过该篇/, '干跑报告必须显著写出「跳过该篇」')
  // 队长裁定 1：**跳过该篇、继续迁移**（一篇冲突不许挡住整个库），但绝不允许「假成功」
  const res = MG.runMigration(data, { home, logPath: join(home, 'c.jsonl') })
  assert.equal(res.partial, true, '有跳过项 ⇒ 必须是 partial')
  assert.deepEqual(res.skippedPapers.map((x) => `${x.paper}:${x.code}`), ['T/P2:migrate-conflict'])
  assert.equal(existsSync(join(data, MG.DONE_MARKER)), false, '**绝不**写「全部完成」标记')
  const part = JSON.parse(readFileSync(join(data, MG.PARTIAL_MARKER), 'utf8'))
  assert.equal(part.partial, true)
  assert.deepEqual(part.skipped.map((x) => x.paper), ['T/P2'], '部分完成标记里必须有跳过清单')
  // 被跳过的那篇一个字都不许动；其余篇照常迁移
  assert.equal(readFileSync(join(data, 'T', 'P2'), 'utf8'), 'a plain FILE where the paper folder should go')
  assert.equal(existsSync(join(data, 'T', 'P2.pdf')), true, '被跳过篇的平铺源原地不动')
  assert.equal(existsSync(join(data, 'T', 'P1', 'P1.pdf')), true, '其余篇照常迁移')
})

/* ═══════════════════════════════════════════════════════════════════════════
   D. 嵌套子专题
   ═══════════════════════════════════════════════════════════════════════════ */

test('D1 任意层嵌套：建 3 层 + 列表返回相对路径 + tree 递归', async () => {
  const { data } = newLib()
  const { srv, postJson, get } = await boot(data)
  try {
    for (const p of ['A', 'A/B', 'A/B/C']) {
      const r = await postJson('/api/library/topic', { name: p })
      assert.equal(r.status, 200, `${p}: ${r.txt}`)
      assert.equal(r.body.topic, p)
      assert.equal(existsSync(join(data, ...p.split('/'))), true)
    }
    putPaper(data, 'A', 'P1')
    putPaper(data, 'A/B', 'P2')
    putPaper(data, 'A/B/C', 'P3')
    const list = L.listPapers(data, 'A').map((p) => `${p.topic}/${p.name}`)
    assert.deepEqual(list.sort(), ['A/B/C/P3', 'A/B/P2', 'A/P1'].sort(), '子树递归且路径是相对的')
    const lib = await get('/api/library')
    const node = lib.body.tree.find((n) => n.path === 'A')
    assert.deepEqual(node.papers, ['P1'], 'tree：本层论文')
    assert.deepEqual(node.children.map((c) => c.path), ['A/B'])
    assert.deepEqual(node.children[0].children[0].path, 'A/B/C')
    assert.deepEqual(node.children[0].children[0].papers, ['P3'])
  } finally { srv.close() }
})

test('D2 子专题改名 + 移动到另一父（to 是路径）+ 拒绝移动到自己子树', () => {
  const { data } = newLib()
  mkdirSync(join(data, 'A', 'B', 'C'), { recursive: true })
  putPaper(data, 'A/B', 'P')
  // 改名（同父）
  M.renameTopic(data, 'A/B', 'A/B2')
  assert.equal(existsSync(join(data, 'A', 'B2', 'P', 'P.pdf')), true)
  // 移动到另一父（整棵子树跟着走）
  M.renameTopic(data, 'A/B2', 'Moved')
  assert.equal(existsSync(join(data, 'Moved', 'P', 'P.pdf')), true, '子树整体移动')
  assert.equal(existsSync(join(data, 'A', 'B2')), false)
  // 移动到自己的子树 ⇒ 409 bad-request（否则目录会消失成孤儿）
  mkdirSync(join(data, 'X', 'Y'), { recursive: true })
  assert.throws(() => M.renameTopic(data, 'X', 'X/Y/X'), (e) => e.code === 'bad-request' && /自己的子/.test(e.message))
  assert.equal(existsSync(join(data, 'X', 'Y')), true, '被拒后目录完好')
})

test('D3 非递归 rmdir 不变量：含子专题/子条目的专题删除一律 409 且目录完好', async () => {
  const { data } = newLib()
  mkdirSync(join(data, 'T', 'Sub'), { recursive: true })
  putPaper(data, 'T/Sub', 'P')
  const plan = M.planTopicDelete(data, 'T')
  assert.deepEqual(plan.subtopics, ['Sub'], '子专题必须单列（UI 据此提示影响面）')
  assert.deepEqual(plan.papers, [], '本层没有直接论文（那篇在子专题里）—— 本层/子树必须分清')
  assert.deepEqual(plan.entries, ['Sub'])
  assert.equal(plan.entries.length > 0, true)
  assert.throws(() => M.deleteTopic(data, 'T'), (e) => e.code === 'topic-not-empty' && e.status === 409)
  assert.equal(existsSync(join(data, 'T', 'Sub', 'P', 'P.pdf')), true, '被拒后一个字都不许动')
  const { srv, postJson } = await boot(data)
  try {
    const r = await postJson('/api/library/delete-topic', { topic: 'T', confirmName: 'T' })
    assert.equal(r.status, 409, r.txt)
    assert.equal(r.body.code, 'topic-not-empty')
    assert.equal(r.body.clearEndpoint, '/api/library/topic/clear', 'UI 必须能据此进入清空中间态')
    assert.ok(!r.txt.includes(data), '错误响应不得泄露绝对路径')
  } finally { srv.close() }
})

test('D4 子树清空：后序遍历、回收站保留原始相对路径、每个子专题独立 bundle、最后整体消失', () => {
  const { data } = newLib()
  putPaper(data, 'A', 'P1')
  putPaper(data, 'A/B', 'P1')          // 同名论文在不同层：撞不撞车就看相对路径
  putPaper(data, 'A/B/C', 'P3')
  const plan = M.planTopicClear(data, 'A')
  assert.equal(plan.papersCount, 3, '合并总数含整棵子树')
  assert.deepEqual(plan.subtopics.map((s) => s.topic).sort(), ['A/B'])
  assert.deepEqual(plan.subtopics[0].subtopics.map((s) => s.topic), ['A/B/C'])
  const res = M.clearTopic(data, 'A')
  assert.equal(res.ok, true)
  assert.equal(res.cleared, 3)
  assert.equal(res.subtopicsCleared, 2)
  assert.equal(existsSync(join(data, 'A')), false, '整棵子树都要消失（后序 + 非递归 rmdir）')
  // 回收站里必须用**相对路径**保留结构，否则两份 P1 会撞名覆盖
  assert.equal(existsSync(join(data, res.trashRel, 'P1', 'P1.pdf')), true, '本层论文：<bundle>/P1/P1.pdf')
  // 每个专题单元一个独立 bundle：两份同名 P1.pdf 必须都活着（否则就是撞名覆盖 = 数据丢失）
  const bundleRoots = readdirSync(join(data, '.trash'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  const withP1 = bundleRoots.filter((b) => existsSync(join(data, '.trash', b, 'P1', 'P1.pdf')))
  assert.equal(withP1.length, 2, `两份同名 P1.pdf 必须各自留在自己的 bundle（实测 ${withP1.length} 个）`)
  const withP3 = bundleRoots.filter((b) => existsSync(join(data, '.trash', b, 'P3', 'P3.pdf')))
  assert.equal(withP3.length, 1, '子专题的论文也要保留相对路径')
})

test('D6 非递归收口：认不出的条目让清空失败（409），绝不 rm -rf 删掉用户的东西', () => {
  const { data } = newLib()
  putPaper(data, 'A', 'P')
  // `note.md` 既不是论文产物、也不是子专题 —— 清空会「漏掉」它，于是非递归 rmdir 必失败。
  // 这正是「绝不 rm -rf」红线**唯一可观测**的路径（本层全是可识别条目时，目录本来就空了、看不出差别）。
  writeFileSync(join(data, 'A', 'note.md'), 'user hand-written note')
  let err = null
  try { M.clearTopic(data, 'A') } catch (e) { err = e }
  assert.ok(err, '有认不出的条目时清空必须失败，而不是把 note.md 一起删掉')
  assert.equal(err.code, 'topic-not-empty')
  assert.equal(err.status, 409)
  assert.equal(readFileSync(join(data, 'A', 'note.md'), 'utf8'), 'user hand-written note', '用户的东西一个字都不能少')
  assert.equal(existsSync(join(data, 'A', 'P', 'P.pdf')), true, '失败即回滚：论文必须完好留在原处')
  assert.equal(existsSync(join(data, 'A', 'P', 'P.txt')), true)
})

test('D5 .trash 是保留名：每一层都不可创建/改名/删除（回收站不能变成可操作专题）', async () => {
  const { data } = newLib()
  mkdirSync(join(data, '.trash'), { recursive: true })
  writeFileSync(join(data, '.trash', 'manifest.json'), '{}')
  for (const bad of ['.trash', 'A/.trash', '.trash/B']) {
    assert.throws(() => M.validateTopicPath(bad, true), (e) => e.code === 'bad-name', `validateTopicPath(${bad}) 必须拒`)
    assert.throws(() => M.validateTopicPath(bad, false), (e) => e.code === 'bad-name', `命名规范类也必须拒 ${bad}`)
  }
  const { srv, postJson } = await boot(data)
  try {
    const del = await postJson('/api/library/delete-topic', { topic: '.trash', confirmName: '.trash' })
    assert.equal(del.status, 400, del.txt)
    assert.equal(del.body.code, 'bad-name')
    const ren = await postJson('/api/library/rename-topic', { topic: '.trash', to: 'not-trash' })
    assert.equal(ren.status, 400, ren.txt)
    const cr = await postJson('/api/library/topic', { name: '.trash' })
    assert.equal(cr.status, 400, cr.txt)
  } finally { srv.close() }
  assert.equal(existsSync(join(data, '.trash', 'manifest.json')), true, '回收站内容必须完好')
  assert.equal(existsSync(join(data, 'not-trash')), false)
})

/* ═══════════════════════════════════════════════════════════════════════════
   E. 按范围提问
   ═══════════════════════════════════════════════════════════════════════════ */

function scopeFixtures() {
  const { data } = newLib()
  const long = 'in-scope-token ' + 'x'.repeat(SC.MAX_PER_DOC + 500)
  const a = putPaper(data, 'A', 'P1', ['.txt'])
  writeFileSync(join(a, 'P1.txt'), long)
  const b = putPaper(data, 'A/B', 'P2', ['.txt'])
  writeFileSync(join(b, 'P2.txt'), 'child-paper-token ' + 'y'.repeat(500))
  const c = putPaper(data, 'Other', 'P9', ['.txt'])
  writeFileSync(join(c, 'P9.txt'), 'OUT-OF-SCOPE-TOKEN ' + 'z'.repeat(500))
  return { data }
}

test('E1 单篇范围：正文 = 该篇；超 MAX_PER_DOC 显式截断（不许静默）', () => {
  const { data } = scopeFixtures()
  const cur = L.resolvePaper(data, { topic: 'A', name: 'P1' })
  const ctx = SC.buildScopeContext(data, cur, { kind: 'paper' }, 'in-scope-token')
  assert.equal(ctx.scopePath, 'A/P1')
  assert.equal(ctx.papers.length, 1)
  assert.equal(ctx.papers[0].coverage, 'truncated', `超 8000 字必须标 truncated：${ctx.papers[0].coverage}`)
  assert.ok(ctx.bodyChars <= SC.MAX_PER_DOC + 400, `正文不得超过上限附近：${ctx.bodyChars}`)
  assert.match(ctx.block, /已截断/, '截断必须写进提示（可见）')
  assert.ok(!ctx.block.includes('OUT-OF-SCOPE-TOKEN'), '范围外论文一个字都不许出现')
  assert.ok(!ctx.block.includes('child-paper-token'), '同一专题下的别的论文也不许出现（单篇就是单篇）')
})

test('E2 专题子树范围：清单含整棵子树、正文走检索（不整塞）、范围外不出现', () => {
  const { data } = scopeFixtures()
  const cur = L.resolvePaper(data, { topic: 'A', name: 'P1' })
  const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'A' }, 'child-paper-token')
  assert.deepEqual(ctx.papers.map((p) => p.path).sort(), ['A/B/P2', 'A/P1'], '子树内两篇都在清单里')
  assert.match(ctx.block, /A\/B\/P2/, '清单一篇一行')
  assert.ok(!ctx.block.includes('OUT-OF-SCOPE-TOKEN'), '范围外（Other/P9）绝不出现')
  assert.ok(!ctx.block.includes('Other/P9'), '连路径都不许出现')
  assert.ok(ctx.bodyChars <= SC.MAX_PER_DOC * 2 + 800, '正文按每篇上限装配，不做全塞')
  assert.equal(ctx.totalChars <= SC.MAX_CONTEXT_CHARS, true, `总量不得超 ${SC.MAX_CONTEXT_CHARS}：${ctx.totalChars}`)
  assert.match(ctx.block, /本次提问的范围是 `A`（含子专题）/, '提示要写明范围（用户能从回答里回看）')
})

test('E3 上限硬生效：MAX_PAPERS_IN_SCOPE / MAX_MANIFEST / MAX_CONTEXT_CHARS，且逐条显式标注', () => {
  const { data } = newLib()
  for (let i = 0; i < SC.MAX_PAPERS_IN_SCOPE + 3; i++) putPaper(data, 'Big', `P${String(i).padStart(2, '0')}`, [])
  const cur = L.resolvePaper(data, { topic: 'Big', name: 'P00' })
  const ctx = SC.buildScopeContext(data, cur, { kind: 'topic', topic: 'Big' }, 'anything')
  assert.equal(ctx.papers.length, SC.MAX_PAPERS_IN_SCOPE + 3, '清单要把范围里的论文列全（状态里标 omitted）')
  assert.equal(ctx.omitted, 3, `超出上限的必须标 omitted-no-room：${JSON.stringify(ctx.papers.map((p) => p.coverage))}`)
  assert.equal(ctx.papers.filter((p) => p.coverage === 'omitted-no-room').length, 3)
  assert.match(ctx.block, /另有 3 篇因上下文上限未展开/, '截断必须显式说明（用户知道为什么没答全）')
  assert.ok(ctx.manifestChars <= SC.MAX_MANIFEST + 80, `清单不得超上限：${ctx.manifestChars}`)
  assert.ok(ctx.totalChars <= SC.MAX_CONTEXT_CHARS, `总量不得超上限：${ctx.totalChars}`)
  assert.equal(SC.MAX_MANIFEST, 2000)
  assert.equal(SC.MAX_PAPERS_IN_SCOPE, 12)
  assert.equal(SC.MAX_HITS_PER_PAPER, 3)
})

test('E4 路由：不传 scope 时提示词与改造前逐字一致；传 topic 范围时只给范围内内容', async () => {
  const { data } = scopeFixtures()
  let spec = null
  const prompted = []
  registerRoutes({
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }), create: async () => ({}), prompt: async (r) => { prompted.push(r.content[0].text) } },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: data })
  const srv = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/paper-reader`
  const ask = async (body) => {
    const r = await fetch(base + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const txt = await r.text()
    let json = null
    try { json = JSON.parse(txt) } catch { /* */ }
    return { status: r.status, body: json, txt }
  }
  try {
    const plain = await ask({ topic: 'A', name: 'P1', question: '这张图说明了什么？' })
    assert.equal(plain.status, 200, plain.txt)
    const p0 = prompted.at(-1)
    assert.equal(p0,
      '[论文伴读] 文献：A/P1（同目录下，search_paper 可直接检索；回答注明页码）\n用户的问题：这张图说明了什么？',
      '不传 scope ⇒ 与改造前**逐字一致**（回归项 C2）')
    assert.equal(plain.body.scope, undefined, '不传 scope 时响应里不该多出 scope 字段')
    const scoped = await ask({ topic: 'A', name: 'P1', question: 'child-paper-token 讲了什么？', scope: { kind: 'topic', topic: 'A' } })
    assert.equal(scoped.status, 200, scoped.txt)
    const p1 = prompted.at(-1)
    assert.match(p1, /^\[论文伴读\] 文献：A\/P1（同目录下/, '既有首行保留')
    assert.match(p1, /【提问范围】A/, '范围块插在文献行之后、问题之前')
    assert.ok(p1.indexOf('【提问范围】') < p1.indexOf('用户的问题：'), '顺序：文献 → 范围 → 问题')
    assert.ok(!p1.includes('OUT-OF-SCOPE-TOKEN'), '范围外内容绝不进提示词')
    assert.equal(scoped.body.scope.kind, 'topic')
    assert.equal(scoped.body.scope.path, 'A')
    // 非法 scope：显式 400，不许静默降级
    const badKind = await ask({ topic: 'A', name: 'P1', question: 'q', scope: { kind: 'planet' } })
    assert.equal(badKind.status, 400, badKind.txt)
    const badTopic = await ask({ topic: 'A', name: 'P1', question: 'q', scope: { kind: 'topic', topic: '../etc' } })
    assert.equal(badTopic.status, 400, badTopic.txt)
  } finally { srv.close() }
})

/* ═══════════════════════════════════════════════════════════════════════════
   F. t2 自查修掉的 4 个真实缺陷 —— 每个一条回归靶子
   ═══════════════════════════════════════════════════════════════════════════ */

test('F1 【缺陷靶子】`.trash` 不得被当专题改名/删除（曾因逐段校验用了裸原语而放开）', () => {
  const { data } = newLib()
  mkdirSync(join(data, '.trash'), { recursive: true })
  writeFileSync(join(data, '.trash', 'keep.pdf'), 'trash payload')
  // 模块层：解析 + 改名 + 删除三条路径都必须拒
  assert.throws(() => M.resolveExistingTopicDir(data, '.trash'), (e) => e.code === 'bad-name', 'resolveExistingTopicDir 必须拒')
  assert.throws(() => M.renameTopic(data, '.trash', 'stolen'), (e) => e.code === 'bad-name', 'rename 必须拒')
  assert.throws(() => M.deleteTopic(data, '.trash'), (e) => e.code === 'bad-name', 'delete 必须拒')
  assert.throws(() => M.planTopicClear(data, '.trash'), (e) => e.code === 'bad-name', 'clear 必须拒')
  // 嵌套层：每一段都要查
  mkdirSync(join(data, 'A'), { recursive: true })
  assert.throws(() => M.renameTopic(data, 'A', 'A/.trash'), (e) => e.code === 'bad-name', '目标里出现 .trash 也要拒')
  assert.equal(existsSync(join(data, '.trash', 'keep.pdf')), true, '回收站内容一个字节都不许动')
  assert.equal(existsSync(join(data, 'stolen')), false)
})

test('F2 【缺陷靶子】listPapers 的 topic 是论文目录的**父级**（曾报成 T/P）', () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P')
  putPaper(data, 'T/Sub', 'Q')
  const got = L.listPapers(data).map((p) => `${p.topic}/${p.name}`).sort()
  assert.deepEqual(got, ['T/P', 'T/Sub/Q'], `topic 归属错了（协议 ?topic=&name= 会失配）：${JSON.stringify(L.listPapers(data))}`)
  for (const p of L.listPapers(data)) {
    assert.notEqual(p.topic, `${p.topic}/${p.name}`.slice(0, -1), 'topic 不得等于「路径去掉篇名」之外的写法')
  }
  // 协议闭环：用列表给的 (topic,name) 必须能解析回同一篇
  for (const p of L.listPapers(data)) {
    const ref = L.resolvePaper(data, { topic: p.topic, name: p.name })
    assert.equal(ref.name, p.name)
    assert.equal(existsSync(ref.pdfPath), true)
    assert.equal(ref.pdfPath.endsWith(join(p.topic, p.name, p.name + '.pdf')), true, `解析路径不符：${ref.pdfPath}`)
  }
})

test('F3 【缺陷靶子】`.hidden/` 这类前导点论文目录仍可见、可删（上传能创建的必须能删）', async () => {
  const { data } = newLib()
  const { srv, postRaw, postJson, get } = await boot(data)
  try {
    const up = await postRaw('/api/library/upload', Buffer.alloc(200, 1), { 'x-dpr-topic': 'T', 'x-dpr-name': encodeURIComponent('.hidden.pdf'), 'content-type': 'application/pdf' })
    assert.equal(up.status, 200, up.txt)
    assert.equal(existsSync(join(data, 'T', '.hidden', '.hidden.pdf')), true, '落点是隐藏名的论文文件夹')
    const lib = await get('/api/library')
    assert.deepEqual(lib.body.papers.map((p) => p.name), ['.hidden'], '隐藏名论文必须仍被列出（否则就是删不掉的孤儿）')
    const del = await postJson('/api/library/delete-paper', { topic: 'T', name: '.hidden' })
    assert.equal(del.status, 200, `能上传就必须能删：${del.txt}`)
    assert.equal(existsSync(join(data, 'T', '.hidden')), false)
  } finally { srv.close() }
})

test('F4 【缺陷靶子】论文名以 `.` 开头时删除不得重复搬同名产物（曾 500 回滚）', () => {
  const { data } = newLib()
  putPaper(data, 'T', '.dot', ['.txt'])
  // 该篇的产物 `.dot.pdf` 同时满足「隐藏条目」与「产物」两个谓词：实现必须去重
  const res = M.deletePaper(data, 'T', '.dot')
  assert.deepEqual(res.moved.sort(), ['.dot.pdf', '.dot.txt'].sort(), `每个产物恰好搬一次：${JSON.stringify(res.moved)}`)
  assert.equal(new Set(res.moved).size, res.moved.length, '绝不重复搬同一个文件')
  assert.equal(res.dirRemoved, true)
  assert.equal(existsSync(join(data, 'T', '.dot')), false)
  // 回收站里内容完好（不是被回滚掉的 500）
  assert.equal(existsSync(join(data, res.trashRel, '.dot', '.dot.pdf')), true, 'F3：回收站保留论文名层级')
  assert.equal(readFileSync(join(data, res.trashRel, '.dot', '.dot.pdf'), 'utf8'), 'pdf:T/.dot')
})

/* ═══════════════════════════════════════════════════════════════════════════
   G. t3 独立验证提的必修项（F1/F1b/F2/F3/F4）—— 每条都是可区分靶子
   ═══════════════════════════════════════════════════════════════════════════ */

test('C7 【F1/F1b 靶子】阶段 2 中断的崩溃现场可复跑收敛：同篇其余平铺产物必须收进论文夹（不许留 orphan）', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P', ['.txt', '.mineru.json', '.study.json'])
  // 确定性构造崩溃现场：阶段 1 已完成（论文夹里已有 P.pdf）、阶段 2 已把平铺 P.pdf 删掉，
  // 同篇的 .txt/.mineru.json/.study.json 还平铺着 —— 这正是 F1/F1b 的现场。
  mkdirSync(join(data, 'T', 'P'), { recursive: true })
  renameSync(join(data, 'T', 'P.pdf'), join(data, 'T', 'P', 'P.pdf'))
  const plan = MG.planMigration(data, home)
  assert.deepEqual(plan.orphans, [], `同篇产物不许被判成 orphan（否则永远留在旧布局 = 对插件等于消失）：${JSON.stringify(plan.orphans)}`)
  assert.deepEqual(plan.moves.map((m) => m.from).sort(), ['T/P.mineru.json', 'T/P.study.json', 'T/P.txt'])
  const res = MG.runMigration(data, { home, logPath: join(home, 'crash.jsonl') })
  assert.equal(res.copied, 3)
  assert.equal(existsSync(join(data, 'T', 'P', 'P.txt')), true, '必须收进论文夹')
  assert.equal(existsSync(join(data, 'T', 'P', 'P.study.json')), true)
  assert.equal(existsSync(join(data, 'T', 'P.txt')), false, '平铺残留必须被收口')
  assert.deepEqual(readdirSync(join(data, 'T')).sort(), ['P'], '崩溃现场复跑后应与「一次跑完」形状一致')
  assert.deepEqual(readdirSync(join(data, 'T', 'P')).sort(), ['P.mineru.json', 'P.pdf', 'P.study.json', 'P.txt'])
})

test('C7b 【F1b 靶子】阶段 2 在每个可能的位置中断：源零丢失、复跑收敛、不新增 orphan', () => {
  const expected = ['P1.mineru.json', 'P1.pdf', 'P1.txt', 'P2.pdf', 'P2.txt']
  // 逐个中断点扫（1..4）：不论阶段 2 停在哪个源之后，复跑都必须收敛成同一形状。
  // 其中至少有一个 n 会让「某篇的平铺 `<名>.pdf` 已被删、同篇其余产物还在」——正是 F1 的现场。
  for (const n of [1, 2, 3, 4]) {
    const { data, home } = newLib()
    putFlatPaper(data, 'T', 'P1', ['.txt', '.mineru.json'])
    putFlatPaper(data, 'T', 'P2', ['.txt'])
    let aborted = null
    try {
      MG.runMigration(data, { home, logPath: join(home, `s2-${n}.jsonl`), failBeforeUnlink: n })
      assert.fail(`failBeforeUnlink=${n} 必须抛出中断`)
    } catch (e) { aborted = e }
    assert.equal(aborted instanceof MG.MigrationAborted, true, `n=${n} 必须是可识别的中断：${aborted}`)
    assert.equal(aborted.detail.done.length, expected.length, `n=${n}：阶段 1 已全部复制完`)
    assert.equal(aborted.detail.unlinked.length, n, `n=${n}：阶段 2 恰好删了 ${n} 个源（如实上报）`)
    // 「先复制后删」的核心不变量：每个产物**至少**有一份完整副本（论文夹里或平铺处）
    for (const f of expected) {
      const inFolder = existsSync(join(data, 'T', 'P1', f)) || existsSync(join(data, 'T', 'P2', f))
      assert.ok(inFolder || existsSync(join(data, 'T', f)), `n=${n}：${f} 必须至少有一份完整副本（数据零丢失）`)
    }
    // F1/F1b 的判据：复跑不许把同篇残留判成 orphan
    const plan = MG.planMigration(data, home)
    assert.deepEqual(plan.orphans, [], `n=${n} 复跑不许新增 orphan：${JSON.stringify(plan.orphans)}`)
    const res = MG.runMigration(data, { home, logPath: join(home, `s2b-${n}.jsonl`) })
    assert.equal(res.ok, true, `n=${n} 复跑必须成功`)
    assert.deepEqual(readdirSync(join(data, 'T')).sort(), ['P1', 'P2'], `n=${n} 复跑必须收敛（平铺残留全部收口）`)
    assert.deepEqual(readdirSync(join(data, 'T', 'P1')).sort(), ['P1.mineru.json', 'P1.pdf', 'P1.txt'], `n=${n}`)
    assert.deepEqual(readdirSync(join(data, 'T', 'P2')).sort(), ['P2.pdf', 'P2.txt'], `n=${n}`)
    rmSync(join(data, '..'), { recursive: true, force: true })
  }
})

test('C8 【F2 靶子】同名并存且内容不同 ⇒ 判冲突、绝不覆盖、绝不删源（文件夹赢）', () => {
  const { data, home } = newLib()
  const FOLDER = 'FOLDER-VERSION-SHORT'
  const LEGACY = 'LEGACY-VERSION-MUCH-LONGER-BYTES-DIFFERENT'
  putPaper(data, 'T', 'A', [])
  writeFileSync(join(data, 'T', 'A', 'A.pdf'), FOLDER)
  writeFileSync(join(data, 'T', 'A.pdf'), LEGACY)
  const plan = MG.planMigration(data, home)
  assert.equal(plan.moves.length, 0, '内容不同 ⇒ 不许当成普通 move（那会在阶段 1 覆盖掉文件夹版）')
  assert.equal(plan.alreadyDone.length, 0, '内容不同 ⇒ 也不许当成 alreadyDone（那会静默删掉平铺源）')
  assert.equal(plan.conflicts.length, 1, `必须报冲突（先报告不执行）：${JSON.stringify(plan.conflicts)}`)
  assert.match(plan.conflicts[0].reason, /内容不同/)
  // 只看**用户数据**：`.migration-v1.partial.json` 是我们自己的记账产物（本次运行会新建）
  const userData = (d) => readdirSync(d, { recursive: true }).map(String).filter((k) => !k.includes('.migration-v1.')).sort()
  const before = userData(data)
  const res = MG.runMigration(data, { home, logPath: join(home, 'c8.jsonl') })
  assert.equal(res.partial, true)
  assert.deepEqual(res.skippedPapers.map((x) => x.paper), ['T/A'], '冲突篇被跳过')
  assert.deepEqual(userData(data), before, '冲突篇零改动（源与目标都不动）')
  assert.equal(existsSync(join(data, MG.DONE_MARKER)), false, '有跳过项时绝不写「全部完成」')
  assert.equal(existsSync(join(data, MG.PARTIAL_MARKER)), true, '要写部分完成标记 + 跳过清单')
  assert.equal(readFileSync(join(data, 'T', 'A', 'A.pdf'), 'utf8'), FOLDER, '文件夹那份一个字都不能变（文件夹赢）')
  assert.equal(readFileSync(join(data, 'T', 'A.pdf'), 'utf8'), LEGACY, '平铺源不许被删（不静默丢数据）')
  // 反向对照：内容**相同** ⇒ 认「已完成」（只清源），不算冲突
  writeFileSync(join(data, 'T', 'A.pdf'), FOLDER)
  const plan2 = MG.planMigration(data, home)
  assert.equal(plan2.conflicts.length, 0, '同内容不算冲突')
  assert.equal(plan2.alreadyDone.length, 1, '同内容 = 已完成（只清源）')
  assert.equal(plan2.moves.length, 0)

  // ── 第二个子例：**size 相同但内容不同**（只比 size 的实现会在这里静默丢数据）──
  const { data: d2, home: h2 } = newLib()
  const FOLDER_SAME = 'FOLDER-VERSION-A'   // 16 字节
  const LEGACY_SAME = 'LEGACY-VERSION-B'   // 16 字节（与上面**等长**、内容不同）
  putPaper(d2, 'T', 'A', [])
  writeFileSync(join(d2, 'T', 'A', 'A.pdf'), FOLDER_SAME)
  writeFileSync(join(d2, 'T', 'A.pdf'), LEGACY_SAME)
  assert.equal(FOLDER_SAME.length, LEGACY_SAME.length, '夹具前提：两个版本等长（只比 size 的实现看不出差别）')
  const plan3 = MG.planMigration(d2, h2)
  assert.equal(plan3.moves.length, 0)
  assert.equal(plan3.alreadyDone.length, 0, '等长但内容不同 ⇒ 绝不能当成「已完成」（那会静默删掉平铺源）')
  assert.equal(plan3.conflicts.length, 1, `等长不同内容也必须报冲突：${JSON.stringify(plan3)}`)
  const resB = MG.runMigration(d2, { home: h2, logPath: join(h2, 'c8b.jsonl') })
  assert.equal(resB.partial, true)
  assert.equal(readFileSync(join(d2, 'T', 'A.pdf'), 'utf8'), LEGACY_SAME, '平铺源不许被静默删除')
  assert.equal(readFileSync(join(d2, 'T', 'A', 'A.pdf'), 'utf8'), FOLDER_SAME)
})

test('C9 【F3 靶子】单篇删除的回收站保留论文名层级（与 clearTopic 的 <bundle>/<标签>/<文件> 一致）', () => {
  const { data } = newLib()
  putPaper(data, 'T', 'P', ['.txt'])
  const res = M.deletePaper(data, 'T', 'P')
  assert.equal(existsSync(join(data, res.trashRel, 'P', 'P.pdf')), true, '论文名层级：<bundle>/P/P.pdf')
  assert.equal(existsSync(join(data, res.trashRel, 'P', 'P.txt')), true)
  assert.equal(existsSync(join(data, res.trashRel, 'P.pdf')), false, '不应再平铺到 bundle 根')
  assert.equal(existsSync(join(data, res.trashRel, 'manifest.json')), true, 'bundle 根仍有清单（既有调用方读它）')
  assert.equal(existsSync(join(data, res.trashRel, 'P', 'manifest.json')), true, '论文层级也有就近的恢复线索')
  const mani = JSON.parse(readFileSync(join(data, res.trashRel, 'manifest.json'), 'utf8'))
  assert.equal(mani.trashSubdir, 'P')
  assert.equal(mani.relativeDir, 'T/P', '原始位置线索仍要在')
  // 失败（EBUSY 注入）⇒ 干净回滚且**不留空的回收站记录**
  putPaper(data, 'T', 'Q', [])
  const beforeTrash = new Set(readdirSync(join(data, '.trash')))
  const inj = () => { throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' }) }
  assert.throws(() => M.deletePaper(data, 'T', 'Q', inj), (e) => e.code === 'file-busy')
  assert.equal(existsSync(join(data, 'T', 'Q', 'Q.pdf')), true, '失败后文献原封不动')
  assert.deepEqual(readdirSync(join(data, '.trash')).filter((n) => !beforeTrash.has(n)), [], '失败的删除不留空的回收站记录')
})

test('C18 结构护栏：默认复制必须 COPYFILE_EXCL（结构上杜绝覆盖已有常规文件），符号链接分支不得 rmSync 目标', () => {
  // 只看**代码**：注释里正当地写着「绝不 rmSync(toAbs)」这句警告，不能把它当成违规
  const src = readFileSync(join(REPO, 'src', 'migrate.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.match(src, /COPYFILE_EXCL/, '默认复制必须带 EXCL：判定层再严也不如内核层兜底')
  assert.ok(!/rmSync\(toAbs/.test(src), '绝不 rmSync 目标（那会把论文夹里已有的条目删掉 —— F-A 的祸根）')
  const at = src.indexOf('if (m.symlink) {')
  const symBranch = src.slice(at, at + 500)
  assert.ok(!/rmSync\(/.test(symBranch), '符号链接分支不得「先删后建」')
  assert.match(symBranch, /symlinkSync\(link, toAbs\)/, '目标已存在时交给 symlinkSync 报 EEXIST（如实失败、不删源）')
})

test('C19 【R2-1 靶子】全量成功后必须清掉旧 .partial：干跑报告不得再谎报「上次有跳过项」', () => {
  const { data, home } = newLib()
  const longName = 'L'.repeat(120)
  putFlatPaper(data, 'T', longName, ['.txt'])          // 先制造一次「有跳过」的运行
  putFlatPaper(data, 'T', 'Good', ['.txt'])
  const r1 = MG.runMigration(data, { home, logPath: join(home, 'c19-1.jsonl') })
  assert.equal(r1.partial, true)
  assert.equal(existsSync(join(data, MG.PARTIAL_MARKER)), true, '第一次运行留下 .partial')
  assert.match(MG.formatMigrationReport(MG.planMigration(data, home)), /部分完成/, '报告如实报「上次有跳过项」')
  // 用户把那篇处理掉（这里模拟：移出库）→ 复跑全量成功
  rmSync(join(data, 'T', `${longName}.pdf`), { force: true })
  rmSync(join(data, 'T', `${longName}.txt`), { force: true })
  const r2 = MG.runMigration(data, { home, logPath: join(home, 'c19-2.jsonl') })
  assert.equal(r2.partial, false, '这次没有跳过项')
  assert.equal(existsSync(join(data, MG.DONE_MARKER)), true, '写 .done')
  assert.equal(existsSync(join(data, MG.PARTIAL_MARKER)), false, 'R2-1：旧的 .partial 必须被清掉（成对）')
  const plan = MG.planMigration(data, home)
  assert.equal(plan.partialMarker, null, 'plan 不许再看到 .partial')
  const report = MG.formatMigrationReport(plan)
  assert.ok(!/部分完成/.test(report), `报告不得再谎报「部分完成」：${report.match(/部分完成.{0,40}/)}`)
  assert.ok(!/会被跳过/.test(report), '报告不得再说「有 N 篇会被跳过」')
  assert.ok(!/跳过该篇/.test(report), '报告不得再提「跳过该篇」')
  assert.ok(!/部分完成标记/.test(report), '报告不得再提「部分完成标记」')
})

test('C20 【R2-2 靶子】数据根读不进去（chmod 300）也必须进 unreadable，且绝不写 .done', (t) => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P')            // 论文全在旧布局
  chmodSync(data, 0o300)                  // 可写可进、**不可读**
  let blocked = false
  try { readdirSync(data) } catch { blocked = true }
  if (!blocked) {
    chmodSync(data, 0o755)
    return t.skip('当前用户可无视 0o300（例如 root）：无法构造「数据根不可读」（显式跳过，不是静默通过）')
  }
  try {
    const plan = MG.planMigration(data, home)
    assert.deepEqual(plan.unreadable, [{ dir: '.', cause: 'EACCES' }], 'R2-2：根也要进 unreadable')
    assert.equal(plan.moves.length, 0, '读不进去 ⇒ 自然看不到任何可迁移项')
    assert.match(MG.formatMigrationReport(plan), /读不进去/, '报告必须显式提示根读不进去')
    const res = MG.runMigration(data, { home, logPath: join(home, 'c20.jsonl') })
    assert.equal(res.partial, true, 'R2-2：有 unreadable 就**绝不能**算全量完成')
    assert.equal(res.ok, true)
    assert.deepEqual(res.unreadable, [{ dir: '.', cause: 'EACCES' }])
    assert.equal(existsSync(join(data, MG.DONE_MARKER)), false, '绝不写 .done（否则是假成功：论文还在旧布局）')
  } finally { chmodSync(data, 0o755) }
  assert.equal(existsSync(join(data, MG.PARTIAL_MARKER)), true, '写 .partial 让用户知道没迁完')
})

test('C21 【R2-3 靶子】clearTopic 失败后 best-effort 清掉**空**的 .trash 根；非空一字不动', () => {
  // 失败现场：专题里有个「认不出」的可见文件 ⇒ 非递归 rmdir 必失败 ⇒ 回滚 + 收尾清理
  const { data } = newLib()
  putPaper(data, 'A', 'P')
  writeFileSync(join(data, 'A', 'note.md'), 'user note')
  let err = null
  try { M.clearTopic(data, 'A') } catch (e) { err = e }
  assert.ok(err && err.code === 'topic-not-empty')
  assert.equal(existsSync(join(data, '.trash')), false, 'R2-3：空回收站根应被 best-effort 收掉')
  // 非空：绝不删
  const { data: d2 } = newLib()
  putPaper(d2, 'A', 'P')
  writeFileSync(join(d2, 'A', 'note.md'), 'user note')
  mkdirSync(join(d2, '.trash', 'keepme'), { recursive: true })
  writeFileSync(join(d2, '.trash', 'keepme', 'payload.pdf'), 'recoverable')
  let err2 = null
  try { M.clearTopic(d2, 'A') } catch (e) { err2 = e }
  assert.ok(err2 && err2.code === 'topic-not-empty')
  assert.equal(readFileSync(join(d2, '.trash', 'keepme', 'payload.pdf'), 'utf8'), 'recoverable', '非空回收站一个字都不许动')
})

test('C22 【CLI 退出码】0=全迁完 / 2=部分完成 / 1=硬失败 / 64=用法错误（--help 写明）', async () => {
  const { spawnSync } = await import('node:child_process')
  const cli = (args, env = {}) => spawnSync(process.execPath, [join(REPO, 'dist', 'migrate.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  })
  // ① 全迁完 ⇒ 0
  const ok = newLib()
  putFlatPaper(ok.data, 'T', 'P')
  const r0 = cli(['--data-dir', ok.data, '--home', ok.home, '--apply', '--yes'])
  assert.equal(r0.status, 0, `全迁完必须 exit 0：${r0.stdout}${r0.stderr}`)
  assert.match(r0.stdout, /退出码 0/)
  assert.equal(existsSync(join(ok.data, MG.DONE_MARKER)), true)
  // ② 部分完成（有一篇不合规名）⇒ 2（脚本化调用者据此区分「没迁完」）
  const part = newLib()
  putFlatPaper(part.data, 'T', 'L'.repeat(120), ['.txt'])
  putFlatPaper(part.data, 'T', 'Good', ['.txt'])
  const r2 = cli(['--data-dir', part.data, '--home', part.home, '--apply', '--yes'])
  assert.equal(r2.status, 2, `部分完成必须 exit 2：${r2.stdout}${r2.stderr}`)
  assert.match(r2.stdout, /退出码 2/)
  assert.equal(existsSync(join(part.data, MG.DONE_MARKER)), false)
  // ③ 硬失败（悬空符号链接源：阶段 1 如实失败）⇒ 1
  const hard = newLib()
  putFlatPaper(hard.data, 'T', 'P', [])
  symlinkSync(join(hard.data, 'no-such-target'), join(hard.data, 'T', 'P.txt'), 'file')
  const r1 = cli(['--data-dir', hard.data, '--home', hard.home, '--apply', '--yes'])
  assert.equal(r1.status, 1, `硬失败必须 exit 1：${r1.stdout}${r1.stderr}`)
  assert.match(r1.stderr, /退出码 1/)
  assert.equal(existsSync(join(hard.data, MG.DONE_MARKER)), false)
  assert.equal(existsSync(join(hard.data, 'T', 'P.pdf')), true, '硬失败后源文件仍在（数据零丢失）')
  // ④ 用法错误（缺 --yes）⇒ 64；--help ⇒ 0 且写明四个码
  const usage = cli(['--data-dir', ok.data, '--apply'])
  assert.equal(usage.status, 64, `缺 --yes 必须 exit 64：${usage.stdout}${usage.stderr}`)
  const help = cli(['--help'])
  assert.equal(help.status, 0)
  for (const code of ['0', '1', '2', '64']) assert.match(help.stdout, new RegExp('^  ' + code + '\\s', 'm'), `--help 必须写明退出码 ${code}`)
})

test('C23 【Windows CI 根因】CLI 入口判定必须用 fileURLToPath：带空格/win32 路径下 URL.pathname 判不出入口', async () => {
  // win32 的 `new URL(import.meta.url).pathname` 形如 `/D:/a/b/dist/migrate.js`，`path.resolve()` 会拼成
  // `D:\D:\a\...` ⇒ 与 process.argv[1] 永不相等 ⇒ **CLI 静默什么都不做**（PR #8 Windows CI 上 C22 拿到
  // 空 stdout、`/退出码 0/` 匹配空串，就是这个）。同一缺陷在 POSIX 上也能复现：路径含空格/非 ASCII 时
  // pathname 是 %-转义形式（`%20`），同样判不出入口。所以这里用**带空格的目录**做本机判别。
  const dir = mkdtempSync(join(tmpdir(), 'dpr cli space '))
  try {
    cpSync(join(REPO, 'dist'), join(dir, 'dist'), { recursive: true })
    const r = spawnSync(process.execPath, [join(dir, 'dist', 'migrate.js'), '--help'], { encoding: 'utf8' })
    assert.equal(r.status, 0, `带空格路径下 CLI 必须正常跑：${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /退出码/,
      `入口判定必须在带空格（win32 同理）的路径下成立；拿到空输出=入口没判出来：${JSON.stringify(r.stdout)}`)
    // 反向对照：同一份 CLI 在**无空格**路径下当然也要正常（两条路径都必须成立）
    const plain = spawnSync(process.execPath, [join(REPO, 'dist', 'migrate.js'), '--help'], { encoding: 'utf8' })
    assert.match(plain.stdout, /退出码/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('D7 【F4 靶子】路由层支持多段 to（移动到另一父）；.. / 绝对路径 / 编码变形 / 超深 / NUL 一律拒', async () => {
  const { data } = newLib()
  const { srv, postJson } = await boot(data)
  try {
    for (const p of ['A', 'A/B', 'A/B/C']) assert.equal((await postJson('/api/library/topic', { name: p })).status, 200)
    putPaper(data, 'A/B/C', 'P')
    // ① 移动到另一父：必须成功（UI「移动到…」拼的正是这种多段 to）
    const mv = await postJson('/api/library/rename-topic', { topic: 'A/B/C', to: 'A/C2' })
    assert.equal(mv.status, 200, `移动到另一父必须 200：${mv.status} ${mv.text}`)
    assert.equal(mv.body.to, 'A/C2')
    assert.equal(existsSync(join(data, 'A', 'C2', 'P', 'P.pdf')), true, '整棵子树跟着走')
    assert.equal(existsSync(join(data, 'A', 'B', 'C')), false)
    assert.equal(existsSync(join(data, 'A', 'B')), true, '原父目录本身不受影响（只搬子树）')
    // ② 负向：越界/编码变形/超深/NUL 一律 4xx，且盘上零变化
    const before = readdirSync(data, { recursive: true }).sort()
    const deep = Array.from({ length: 17 }, (_, i) => `s${i}`).join('/')
    for (const bad of ['..', '../x', 'A/../../x', '/abs/here', 'A/%2E%2E%2Fx', deep, 'a\u0000b', '.hidden']) {
      const r = await postJson('/api/library/rename-topic', { topic: 'A/C2', to: bad })
      assert.ok(r.status >= 400 && r.status < 500, `to=${JSON.stringify(String(bad).slice(0, 18))} 必须 4xx：${r.status} ${r.text}`)
      assert.equal(r.body.code, 'bad-name', `必须带机器可读 code：${r.text}`)
      assert.ok(!r.txt.includes(data), '错误响应不得泄露绝对路径')
    }
    assert.deepEqual(readdirSync(data, { recursive: true }).sort(), before, '被拒的 to 不得改动文献库')
    assert.equal(existsSync(join(data, 'A', 'C2', 'P', 'P.pdf')), true, '源必须完好')
    // ③ 拒绝移入自身子树 ⇒ 409（不是 400：名字合法，语义非法）
    const self = await postJson('/api/library/rename-topic', { topic: 'A/C2', to: 'A/C2/Sub' })
    assert.equal(self.status, 409, self.text)
    assert.equal(self.body.code, 'bad-request')
  } finally { srv.close() }
})

test('C10 【F-A 靶子】符号链接源也要走占位判定（等长/不等长都判冲突）：绝不把论文夹里的常规文件换成链接', () => {
  const outside = mkdtempSync(join(tmpdir(), 'dpr-t9-out-'))
  try {
    const KEEP = 'REGULAR-FILE-IN-PAPER-FOLDER（不可恢复）'
    // 两种变体：源链接指向的外部文件与目标**不等长** / **等长**。
    // 等长那一种专门打「只比 size 的实现」——它会把链接源误判成 alreadyDone，然后静默删掉平铺源。
    for (const [label, outsideContent] of [['不等长', 'SHORT'], ['等长', 'X'.repeat(KEEP.length)]]) {
      const { data, home } = newLib()
      writeFileSync(join(outside, 'other.txt'), outsideContent)
      putPaper(data, 'T', 'A', [])
      writeFileSync(join(data, 'T', 'A', 'A.txt'), KEEP)
      symlinkSync(join(outside, 'other.txt'), join(data, 'T', 'A.txt'), 'file')
      const plan = MG.planMigration(data, home)
      assert.equal(plan.moves.some((m) => m.to.endsWith('A.txt')), false, `[${label}] 链接源绝不能被当成普通 move`)
      assert.equal(plan.alreadyDone.some((m) => m.to.endsWith('A.txt')), false, `[${label}] 常规文件与链接不可能「同内容」`)
      assert.equal(plan.conflicts.length, 1, `[${label}] 必须判冲突：${JSON.stringify(plan.conflicts)}`)
      assert.match(plan.conflicts[0].reason, /符号链接/)
      const userData = (d) => readdirSync(d, { recursive: true }).map(String).filter((k) => !k.includes('.migration-v1.')).sort()
      const before = userData(data)
      const res = MG.runMigration(data, { home, logPath: join(home, `c10-${label}.jsonl`) })
      assert.equal(res.partial, true, `[${label}] 有跳过项`)
      assert.deepEqual(userData(data), before, `[${label}] 冲突必须零改动`)
      assert.equal(readFileSync(join(data, 'T', 'A', 'A.txt'), 'utf8'), KEEP, `[${label}] 论文夹里那份常规文件逐字未变`)
      assert.equal(lstatSync(join(data, 'T', 'A.txt')).isSymbolicLink(), true, `[${label}] 链接源原地不动`)
      assert.equal(readFileSync(join(outside, 'other.txt'), 'utf8'), outsideContent, `[${label}] 库外目标不动`)
      assert.equal(existsSync(join(data, MG.DONE_MARKER)), false, `[${label}] 不写完成标记`)
      rmSync(join(data, '..'), { recursive: true, force: true })
    }
  } finally { rmSync(outside, { recursive: true, force: true }) }
})

test('C11 【F-B 靶子】平铺论文名 == 已有子专题名 ⇒ 判冲突（绝不把子专题变成论文）', () => {
  const { data, home } = newLib()
  putPaper(data, 'T/Sub', 'P')                    // 子专题 T/Sub 里有论文
  putFlatPaper(data, 'T', 'Sub')                  // 平铺论文也叫 Sub（会被搬进 T/Sub）
  const plan = MG.planMigration(data, home)
  assert.equal(plan.conflicts.length, 1, `干跑就要报警：${JSON.stringify(plan)}`)
  assert.match(plan.conflicts[0].reason, /子专题/)
  const userData = (d) => readdirSync(d, { recursive: true }).map(String).filter((k) => !k.includes('.migration-v1.')).sort()
  const before = userData(data)
  const res = MG.runMigration(data, { home, logPath: join(home, 'c11.jsonl') })
  assert.equal(res.partial, true)
  assert.deepEqual(userData(data), before, '冲突篇零改动（平铺源与子专题都不动）')
  // 关键后果：子专题里的论文必须**仍然可见**（列表 + 树），且清空计划仍能找到它
  assert.deepEqual(L.listPapers(data, 'T').map((p) => `${p.topic}/${p.name}`).sort(), ['T/Sub/P'])
  const node = L.listTopicTree(data, 'T')[0]
  assert.deepEqual(node.children.map((c) => c.path), ['T/Sub'], 'T/Sub 必须仍是子专题（不是被吞掉的论文目录）')
  assert.deepEqual(node.children[0].papers, ['P'], '子专题内的论文必须还在树里')
  assert.equal(node.papers.includes('Sub'), false, 'T/Sub 绝不能同时被当成论文')
  assert.equal(M.planTopicClear(data, 'T').papersCount, 1, '清空计划必须能找到子专题里的论文（不会永久 409）')
  assert.equal(existsSync(join(data, 'T', 'Sub.pdf')), true, '被跳过的平铺源原地不动')
})

test('C12 【裁定 1】不合规论文名 ⇒ 跳过该篇继续迁移；绝不假成功（不写 done、写 partial + 跳过清单）', () => {
  const { data, home } = newLib()
  const longName = 'L'.repeat(120)                 // > MAX_PAPER_DIR_NAME(100) ⇒ 建不出同名目录
  putFlatPaper(data, 'T', longName, ['.txt'])
  putFlatPaper(data, 'T', 'Good', ['.txt'])
  const plan = MG.planMigration(data, home)
  assert.equal(plan.quarantine.length, 1, `必须进 quarantine：${JSON.stringify(plan.quarantine)}`)
  assert.equal(plan.quarantine[0].reason.includes('过长'), true)
  assert.equal(plan.moves.length, 2, '好名字那篇照常规划（一篇坏名字不许挡住整库）')
  const report = MG.formatMigrationReport(plan)
  assert.match(report, /跳过该篇/, '干跑报告要显著列出跳过')
  assert.match(report, /不会.*写.*全部完成/, '干跑报告要明说不会写「全部完成」标记')
  const res = MG.runMigration(data, { home, logPath: join(home, 'c12.jsonl') })
  assert.equal(res.ok, true)
  assert.equal(res.copied, 2, '好名字那篇照常迁移（绝不是整库中止）')
  assert.equal(res.partial, true)
  assert.deepEqual(res.skippedPapers.map((x) => x.code), ['migrate-quarantine'])
  assert.equal(existsSync(join(data, MG.DONE_MARKER)), false, '**绝不**写「全部完成」标记（否则用户以为迁完了）')
  const part = JSON.parse(readFileSync(join(data, MG.PARTIAL_MARKER), 'utf8'))
  assert.equal(part.partial, true)
  assert.equal(part.skipped.length, 1)
  assert.match(part.skipped[0].paper, /L{120}$/)
  assert.equal(existsSync(join(data, 'T', 'Good', 'Good.pdf')), true)
  assert.equal(existsSync(join(data, 'T', `${longName}.pdf`)), true, '被跳过篇的源文件原地不动')
})

test('C13 【裁定 2】前导点的隐藏论文也纳入迁移并保留原名（用户盘上已有的数据不许被丢下）', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', '.hidden', ['.txt'])
  const plan = MG.planMigration(data, home)
  assert.deepEqual(plan.quarantine, [], '前导点不再是「不合规名」——迁移保留原名')
  assert.equal(plan.moves.length, 2, `隐藏论文也要迁移：${JSON.stringify(plan.moves)}`)
  assert.deepEqual(plan.moves.map((m) => m.to).sort(), ['T/.hidden/.hidden.pdf', 'T/.hidden/.hidden.txt'])
  assert.deepEqual(plan.hidden, [], '隐藏的**论文文件**不算「不动」的隐藏条目（只有非论文隐藏条目才是）')
  const res = MG.runMigration(data, { home, logPath: join(home, 'c13.jsonl') })
  assert.equal(res.partial, false, '没有跳过项 ⇒ 正常完成')
  assert.equal(existsSync(join(data, MG.DONE_MARKER)), true)
  assert.equal(existsSync(join(data, 'T', '.hidden', '.hidden.pdf')), true)
  // 迁移后必须仍然可见、可解析（否则就是「用户盘上已有数据被丢下」）
  assert.deepEqual(L.listPapers(data, 'T').map((p) => `${p.topic}/${p.name}`), ['T/.hidden'])
  assert.deepEqual(L.listTopicTree(data, 'T')[0].papers, ['.hidden'], '树里也要能看到')
  const ref = L.resolvePaper(data, { topic: 'T', name: '.hidden' })
  assert.equal(ref.pdfPath, join(data, 'T', '.hidden', '.hidden.pdf'))
  assert.equal(ref.txtPath, join(data, 'T', '.hidden', '.hidden.txt'))
})

test('C14 【F-C 靶子】未迁移旧库的 /api/library 必须给出**存在的** pdfPath（不能写死新布局）', async () => {
  const { data } = newLib()
  putFlatPaper(data, 'T', 'Flat', ['.txt'])
  const { srv, get } = await boot(data)
  try {
    const lib = await get('/api/library')
    const p = lib.body.papers.find((x) => x.name === 'Flat')
    assert.ok(p, `列表里必须有那篇平铺论文：${JSON.stringify(lib.body.papers)}`)
    assert.equal(p.pdfPath, join(data, 'T', 'Flat.pdf'), '旧布局 ⇒ pdfPath 指向平铺文件')
    assert.equal(existsSync(p.pdfPath), true, '**pdfPath 必须真实存在**（写死新布局会指向不存在的路径）')
    // 新布局（论文夹）同样正确
    putPaper(data, 'T', 'Folder')
    const lib2 = await get('/api/library')
    const p2 = lib2.body.papers.find((x) => x.name === 'Folder')
    assert.equal(p2.pdfPath, join(data, 'T', 'Folder', 'Folder.pdf'))
    assert.equal(existsSync(p2.pdfPath), true)
    // 同名并存（平铺 + 论文夹）⇒ 文件夹赢，pdfPath 指向论文夹里那份（同样真实存在）
    putFlatPaper(data, 'T', 'Folder')
    const lib3 = await get('/api/library')
    const p3 = lib3.body.papers.filter((x) => x.name === 'Folder')
    assert.equal(p3.length, 1, '同名并存只列一次')
    assert.equal(p3[0].pdfPath, join(data, 'T', 'Folder', 'Folder.pdf'), '文件夹赢')
    assert.equal(existsSync(p3[0].pdfPath), true)
    // 三种布局的 pdfPath 都必须真实存在（写死任何一种布局都会让另一种指向不存在）
    for (const p of lib3.body.papers) assert.equal(existsSync(p.pdfPath), true, `${p.topic}/${p.name} 的 pdfPath 必须存在`)
  } finally { srv.close() }
})

test('C16 【unreadable 靶子】读不进去的子树单列 unreadable：本次未处理、成功响应显式提示、不写完成标记', (t) => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'Good')
  mkdirSync(join(data, 'T', 'locked'), { recursive: true })
  writeFileSync(join(data, 'T', 'locked', 'x.pdf'), 'x')
  chmodSync(join(data, 'T', 'locked'), 0o000)
  let blocked = false
  try { readdirSync(join(data, 'T', 'locked')) } catch { blocked = true }
  if (!blocked) {
    chmodSync(join(data, 'T', 'locked'), 0o755)
    return t.skip('当前用户可无视 0o000（例如 root）：无法构造 unreadable 子树（显式跳过，不是静默通过）')
  }
  try {
    const plan = MG.planMigration(data, home)
    assert.deepEqual(plan.unreadable, [{ dir: 'T/locked', cause: 'EACCES' }], '读不进去的子树必须单列')
    assert.match(MG.formatMigrationReport(plan), /读不进去/, '报告必须显式提示未处理')
    const res = MG.runMigration(data, { home, logPath: join(home, 'c16.jsonl') })
    assert.equal(res.partial, true, '有未处理的子树 ⇒ 不是整体完成')
    assert.deepEqual(res.unreadable, [{ dir: 'T/locked', cause: 'EACCES' }])
    assert.ok(res.skippedPapers.some((x) => x.code === 'migrate-unreadable'), '成功响应里要显式提示未处理')
    assert.equal(existsSync(join(data, MG.DONE_MARKER)), false, '绝不写「全部完成」标记')
    assert.equal(existsSync(join(data, MG.PARTIAL_MARKER)), true)
    assert.equal(existsSync(join(data, 'T', 'Good', 'Good.pdf')), true, '其它子树照常迁移（不被一棵读不进去的子树挡住）')
  } finally { chmodSync(join(data, 'T', 'locked'), 0o755) }
})

test('C17 【回滚收尾】best-effort 清掉**空**的 .trash 根；非空的 .trash 一个字都不动', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P')
  mkdirSync(join(data, '.trash'), { recursive: true })
  const res = MG.runMigration(data, { home, logPath: join(home, 'c17.jsonl') })
  MG.rollbackMigration(data, res.logPath)
  assert.equal(existsSync(join(data, '.trash')), false, '空的回收站根应被 best-effort 清掉（不留空目录）')
  // 非空：绝不删（那是用户可恢复的数据）
  const { data: d2, home: h2 } = newLib()
  putFlatPaper(d2, 'T', 'P')
  mkdirSync(join(d2, '.trash', 'keepme'), { recursive: true })
  writeFileSync(join(d2, '.trash', 'keepme', 'payload.pdf'), 'recoverable-data')
  const r2 = MG.runMigration(d2, { home: h2, logPath: join(h2, 'c17b.jsonl') })
  MG.rollbackMigration(d2, r2.logPath)
  assert.equal(readFileSync(join(d2, '.trash', 'keepme', 'payload.pdf'), 'utf8'), 'recoverable-data', '非空回收站不许被清')
})

test('F5 【不变量】迁移与 legacy 兼容的边界：迁移后 legacy 标记消失、旧路径不再可见', () => {
  const { data, home } = newLib()
  putFlatPaper(data, 'T', 'P')
  assert.equal(L.listPapers(data, 'T')[0].legacy, true)
  MG.runMigration(data, { home, logPath: join(home, 'm.jsonl') })
  const after = L.listPapers(data, 'T')
  assert.equal(after.length, 1)
  assert.equal(after[0].legacy, undefined, '迁移完成后就该只剩新布局（legacy 只是过渡态）')
  assert.equal(L.resolvePaper(data, { topic: 'T', name: 'P' }).pdfPath, join(data, 'T', 'P', 'P.pdf'))
})
