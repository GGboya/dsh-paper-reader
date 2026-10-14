// test/darkmode-real-pdf.test.mjs — 深色模式的**真机证据**（真实 Chromium + 真实论文 PDF + 真实阅读器页面）。
//
// 为什么必须真机（t6 验收）：离屏夹具只能证明「CSS 写了」；本用例加载**真实 reader/index.html**、
// 用**真实 pdf.js** 渲染一篇**真实论文**，然后在**屏幕像素**上取色（亮/暗两态），并断言：
//   · 文字层 span 的文本与定位、编程式选区、公式热区盒、elementFromPoint 命中 —— 开暗后**逐字节不变**；
//   · 页面底色确实从「近白」变到「近黑」（不是靠肉眼）；
//   · 下载/导出不受影响（走服务端，客户端滤镜不参与 —— 这里用「PDF 字节与开关无关」的静态断言覆盖）。
//
// 依赖：playwright + chromium（本机已装）。**装不上就 skip**（理由写进 skip 消息，不是静默跳过）。
// 真实文献库**只读**：仅把样本 PDF copy 到临时目录，绝不写回。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { copyFileSync, createReadStream, existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')

async function loadPlaywright() {
  // CJS 包 + ESM interop：真正带 chromium 的那个对象可能是 default（实测 `import('playwright')` 下
  // `pw.chromium` 是 undefined、`pw.default.chromium` 才是 API）——两种形状都认。
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  for (const spec of ['playwright', '/home/vr/.local/lib/node_modules/playwright']) {
    try {
      const m = req(spec)
      if (m?.chromium) return m
      if (m?.default?.chromium) return m.default
    } catch { /* 试下一个 */ }
  }
  return null
}
async function loadSharp() {
  // sharp 是 CJS 包（ESM import 在本机解析不到）→ 走 createRequire 解析，再退到全局安装路径
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  for (const spec of ['sharp', '/home/vr/.local/lib/node_modules/sharp']) {
    try { const m = req(spec); return m.default ?? m } catch { /* 试下一个 */ }
  }
  return null
}

/** 找一篇**真实**论文（真实库只读；库不存在则退回仓库里的示例，再不行就 skip）。 */
function findRealPdf() {
  const lib = join(process.env.HOME ?? '', '.dsh-paper-reader', 'data')
  const out = []
  const walk = (dir, depth = 0) => {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (extname(e.name).toLowerCase() === '.pdf' && !/-en|-zh|-dual\.pdf$/i.test(e.name)) {
        try {
          const size = statSync(p).size
          if (size > 20_000 && size < 60_000_000) out.push({ path: p, size })
        } catch { /* 竞态 */ }
      }
    }
  }
  walk(lib)
  out.sort((a, b) => b.size - a.size)
  return out[0] ?? null
}

const pdf = findRealPdf()
const playwright = await loadPlaywright()
const sharp = await loadSharp()
const skipReason = !pdf ? '找不到真实论文 PDF（真实库为空）'
  : !playwright ? 'playwright 不可用（本机未装/浏览器未下载）'
    : !sharp ? 'sharp 不可用（无法直读 PNG 取色）'
      : null

test('RD1 真机取色 + 文字层/选区/热区/命中在开暗后不变（真实 Chromium + 真实论文）', { skip: skipReason ?? false }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'dpr-dark-real-'))
  const sample = join(work, 'paper.pdf')
  copyFileSync(pdf.path, sample)                    // 真实库只读：只复制出来
  t.diagnostic(`样本：${pdf.path}（${(pdf.size / 1048576).toFixed(2)} MiB）`)

  // 真实阅读器页面 + 最小 API（返回真实 PDF 字节、篇元信息、一条公式热区、单位主题配置）
  const readerHtml = (await import('node:fs')).readFileSync(join(REPO, 'reader', 'index.html'), 'utf8').replaceAll('__DPR_VERSION__', 'v-test')
  let themeMode = 'light'
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/paper-reader/' || u.pathname === '/paper-reader') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(readerHtml); return
    }
    if (u.pathname.startsWith('/paper-reader/vendor/')) {
      const f = join(REPO, 'reader', 'vendor', u.pathname.slice('/paper-reader/vendor/'.length))
      if (!existsSync(f)) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/javascript' }); createReadStream(f).pipe(res); return
    }
    if (u.pathname === '/ctl/theme') { themeMode = u.searchParams.get('mode') ?? 'light'; json(res, { ok: true, mode: themeMode }); return }
    if (u.pathname === '/paper-reader/api/library') {
      json(res, { dataDir: work, topics: ['RT'], papers: [{ topic: 'RT', name: 'paper', pdfPath: sample }], tree: [{ name: 'RT', path: 'RT', papers: ['paper'], children: [] }] })
      return
    }
    if (u.pathname === '/paper-reader/api/paper') { json(res, { pageCount: 3, hasTranscript: true, pdfPath: sample }); return }
    if (u.pathname === '/paper-reader/api/pdf') {
      const st = statSync(sample)
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': st.size }); createReadStream(sample).pipe(res); return
    }
    if (u.pathname === '/paper-reader/api/formulas') {
      // 一条 bbox 覆盖页面左上区域的公式：只要渲染出来，就能拿它做「热区盒不变」的断言
      json(res, { source: 'mineru', producer: 'mineru-local', backend: 'pipeline', pageCount: 3, bboxSpace: 'normalized-1000',
        equations: [{ id: '0:1', page: 1, pageIdx: 0, index: 1, bbox: [120, 150, 420, 220], latex: 'E = mc^2', textFormat: 'latex' }] })
      return
    }
    if (u.pathname === '/paper-reader/api/zh') { json(res, { zh: false, dual: false, busy: false }); return }
    if (u.pathname === '/paper-reader/api/theme/config') {
      json(res, { pdfTheme: themeMode, pdfDarkStrength: 1, pdfDarkChrome: true, curve: { brightness: 0.92, contrast: 0.95 }, source: 'file' }); return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const browser = await playwright.chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(base + '/paper-reader/?topic=RT&name=paper', { waitUntil: 'load' })
    await page.waitForSelector('#pdf-pages .page canvas', { timeout: 30_000 })
    await page.waitForSelector('#pdf-pages .textLayer span', { timeout: 30_000 })

    const probe = async () => page.evaluate(() => {
      const pane = document.getElementById('pdf-pages')
      const first = pane.querySelector('.page')
      const canvas = first.querySelector('canvas')
      const spans = [...first.querySelectorAll('.textLayer span')]
      const geom = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 } }
      // 文本 + 定位摘要（相对页面，避免滚动差异）：只取前 40 个 span，够做「逐字节不变」的判据
      const spanDigest = spans.slice(0, 40).map((s) => `${s.textContent}|${s.style.left}|${s.style.top}|${s.style.fontSize}|${s.style.getPropertyValue('--scale-x')}`).join('\n')
      const boxes = [...first.querySelectorAll('.eqLayer .eq-box')].map((b) => `${b.style.left}|${b.style.top}|${b.style.width}|${b.style.height}`)
      // 编程式选区（真实 Range）
      let sel = null
      if (spans.length >= 3) {
        const range = document.createRange()
        range.setStart(spans[1].firstChild ?? spans[1], 0)
        range.setEnd(spans[2].firstChild ?? spans[2], Math.min(5, (spans[2].textContent ?? '').length))
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(range)
        const r = range.getBoundingClientRect()
        sel = { text: range.toString(), rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
        s.removeAllRanges()
      }
      // elementFromPoint 命中：取第一个 span 的中心
      const sr = spans[0].getBoundingClientRect()
      const hit = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2)
      return {
        mode: document.documentElement.getAttribute('data-dpr-pdf'),
        chrome: document.documentElement.getAttribute('data-dpr-chrome'),
        page: geom(first), canvas: geom(canvas), canvasBacking: `${canvas.width}x${canvas.height}`,
        spanCount: spans.length, spanDigest, boxes, sel,
        hit: hit ? `${hit.tagName}.${hit.className}` : null,
        canvasBox: (() => { const r = canvas.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })(),
        filter: getComputedStyle(canvas).filter,
      }
    })

    /** 取屏幕上某个点的像素（1×1 截图直读，不靠肉眼）。 */
    const pixelAt = async (x, y) => {
      const buf = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } })
      const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
      return [data[0], data[1], data[2]]
    }

    const light = await probe()
    assert.equal(light.mode, 'light', `light 模式的属性：${light.mode}`)
    assert.ok(light.spanCount > 20, `真实论文必须抽出文本层（实测 ${light.spanCount} 个 span）`)
    const c = light.canvasBox
    const pLightCorner = await pixelAt(c.x + 12, c.y + 12)
    const pLightMid = await pixelAt(c.x + c.w * 0.5, c.y + c.h * 0.45)
    assert.ok(pLightCorner[0] >= 240 && pLightCorner[1] >= 240, `亮色下页面底色应近白，实测 ${pLightCorner}`)

    // 切到深色（走真实配置路由 + 重新加载 ⇒ 覆盖首帧判定与运行时两条路径）
    await fetch(`${base}/ctl/theme?mode=dark`)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('#pdf-pages .page canvas', { timeout: 30_000 })
    await page.waitForSelector('#pdf-pages .textLayer span', { timeout: 30_000 })
    const dark = await probe()
    assert.equal(dark.mode, 'dark', `dark 模式的属性：${dark.mode}`)
    assert.match(dark.filter, /invert\(1\)/, `canvas 上必须真的挂上滤镜：${dark.filter}`)
    assert.match(dark.filter, /hue-rotate\(180deg\)/, `必须色相回正（保色相族）：${dark.filter}`)
    const c2 = dark.canvasBox
    const pDarkCorner = await pixelAt(c2.x + 12, c2.y + 12)
    const pDarkMid = await pixelAt(c2.x + c2.w * 0.5, c2.y + c2.h * 0.45)
    assert.ok(pDarkCorner[0] <= 40 && pDarkCorner[1] <= 40 && pDarkCorner[2] <= 40, `深色下页面底色应近黑，实测 ${pDarkCorner}`)
    t.diagnostic(`取色（屏幕像素）：亮 角${pLightCorner} 中${pLightMid} → 暗 角${pDarkCorner} 中${pDarkMid}`)

    // ── 不变量：开暗后几何/文字层/选区/热区/命中**逐字节不变** ──
    assert.deepEqual({ w: dark.page.w, h: dark.page.h }, { w: light.page.w, h: light.page.h }, '页面盒不得因滤镜改变')
    assert.deepEqual(dark.canvas, light.canvas, 'canvas 的 CSS 尺寸不得改变')
    assert.equal(dark.canvasBacking, light.canvasBacking, 'canvas 后备像素尺寸不得改变（滤镜是合成期效果）')
    assert.equal(dark.spanCount, light.spanCount, '文字层 span 数不得改变')
    assert.equal(dark.spanDigest, light.spanDigest, '文字层 span 的文本与定位必须逐字节不变（选区/跳转都靠它）')
    assert.deepEqual(dark.boxes, light.boxes, '公式热区盒必须逐字节不变（命中判定靠坐标）')
    assert.deepEqual(dark.sel, light.sel, '编程式选区的文本与矩形必须不变')
    assert.equal(dark.hit, light.hit, 'elementFromPoint 命中元素必须不变（拖选仍落在 textLayer 上）')
    assert.ok(!dark.hit?.includes('eq-box'), '热区层不许夺走命中（pointer-events 仍是 none）')
    assert.equal(errors.length, 0, `页面不得有 JS 错误：${errors.join(' | ')}`)
  } finally {
    await browser.close()
    srv.close()
  }
})

test('RD2 下载/导出不受客户端滤镜影响：下载走服务端字节流，绝不把加滤镜的画布当导出源', async () => {
  const { normalizeEol, extractModuleScript } = await import('./reader-script.mjs')
  const html = normalizeEol((await import('node:fs')).readFileSync(join(REPO, 'reader', 'index.html'), 'utf8'))
  const script = extractModuleScript(html, { where: 'reader/index.html' })
  // 下载按钮走 /api/pdf（服务端直接吐原始字节；滤镜是客户端合成期效果，字节里没有它）
  assert.match(script, /\/paper-reader\/api\/pdf\?/, '下载必须走服务端 PDF 字节流')
  // 绝不能把画布内容当导出源（那会把反色后的像素导出去）
  assert.ok(!/toDataURL|toBlob\s*\(/.test(script), '不得用 canvas.toDataURL/toBlob 作为导出路径')
  assert.ok(!/\/api\/pdf[^\n]*filter/.test(script), '下载 URL 不得掺入客户端滤镜参数')
})
