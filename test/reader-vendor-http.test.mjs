// test/reader-vendor-http.test.mjs — 阅读器静态资源**真发 HTTP** 取一遍（补 t18 的盲区）
//
// 为什么需要这个文件：t18 的守卫 R3 与 K6 都只看**磁盘**（readFileSync 灌 vm）⇒ 完全没发现
// 「KaTeX 放在子目录、而 `/paper-reader/vendor/*` 路由只服务扁平文件名」这件事：磁盘上文件齐全、
// 浏览器里三条 URL 全 400 ⇒ `window.katex` 不存在 ⇒ 每个数学段都降级（PR #7 的主因，见
// docs/pr7-render-diagnosis.md 的 P0）。本文件用**发行产物** `dist/host.js` 起真 http server，
// 把页面与 CSS 引到的每个资源逐个 GET，断言 200 + MIME + 内容真实。
//
// 同时钉住路由的**安全边界**（回归护栏）：嵌套路径、`..`、`%2e%2e%2f` 编码变形一律不得 200。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = (m) => join(REPO, 'dist', m)

/** 起一个真实的 host 路由服务器（与仓库既有路由用例同一手法：stub ctx + registerRoutes）。 */
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

test('V1 页面与 CSS 引到的每个 vendor 资源都必须真能 200（含 MIME）', async (t) => {
  // dataDir 必须放**系统临时目录**：路由会按需创建它，放 test/ 下会在仓库里留一个目录，
  // 而 reader-ux 的 VA16 会遍历 test/ 里的文件并 readFileSync（EISDIR，实测踩过）。
  const D = mkdtempSync(join(tmpdir(), 'dpr-vendor-http-'))
  t.after(() => rmSync(D, { recursive: true, force: true }))
  const { base, close } = await bootRoutes(D)
  try {
    // ① 阅读器页面：拿到它引的两个 KaTeX 资源（CSS + JS）
    const pageRes = await fetch(base + '/paper-reader/')
    assert.equal(pageRes.status, 200, '阅读器页面必须 200')
    const html = await pageRes.text()
    // 静态标签（katex js/css）+ 脚本里动态 import 的（pdf.js 走 import('/paper-reader/vendor/pdf.min.mjs')）
    const pageUrls = [...new Set([...html.matchAll(/<(?:link|script)[^>]*?(?:href|src)="(\/paper-reader\/vendor\/[^"]+)"/g)].map((m) => m[1])
      .concat([...html.matchAll(/['"](\/paper-reader\/vendor\/[\w.-]+)['"]/g)].map((m) => m[1])))]
    assert.ok(pageUrls.length >= 3, `页面必须至少引 3 个 vendor 资源（pdf.js ×2 + katex js/css）：${pageUrls}`)
    assert.ok(pageUrls.includes('/paper-reader/vendor/katex.min.js') && pageUrls.includes('/paper-reader/vendor/katex.min.css'),
      `KaTeX 必须以**扁平**路径引用（子目录会被路由 400）：${pageUrls}`)

    // ② 逐个取页面引的资源：200 + 非空
    for (const u of pageUrls) {
      const r = await fetch(base + u)
      assert.equal(r.status, 200, `${u} 必须 200（拿到 400/404 就会导致浏览器里 window.katex 不存在）`)
      const buf = Buffer.from(await r.arrayBuffer())
      assert.ok(buf.length > 100, `${u} 内容不像真资源（${buf.length} B）`)
    }

    // ③ KaTeX 的 JS/CSS 内容与 MIME 都要对（不是拿 200 的错误页糊弄）
    const js = await fetch(base + '/paper-reader/vendor/katex.min.js')
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8', 'KaTeX JS 必须是 text/javascript + charset')
    assert.match(await js.text(), /version:"0\.16\.22"/, 'KaTeX JS 里必须能读出 0.16.22')
    const css = await fetch(base + '/paper-reader/vendor/katex.min.css')
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8', 'KaTeX CSS 必须是 text/css + charset')
    const cssText = await css.text()

    // ④ CSS 里引到的**每个** woff2 字体都必须真能取到（离线渲染的前提），且 MIME 是字体
    const fonts = [...new Set([...cssText.matchAll(/url\(([A-Za-z0-9_.-]+\.woff2)\)/g)].map((m) => m[1]))]
    assert.ok(fonts.length >= 10, `CSS 必须引到一组字体（拿到 ${fonts.length} 个）`)
    for (const f of fonts) {
      const r = await fetch(base + '/paper-reader/vendor/' + f)
      assert.equal(r.status, 200, `字体 ${f} 必须 200（CSS 引了它，取不到就会退化成系统字体/乱码）`)
      assert.equal(r.headers.get('content-type'), 'font/woff2', `字体 ${f} 的 MIME 必须**恰好**是 font/woff2（二进制资源不得追加 charset）`)
      assert.ok(Buffer.from(await r.arrayBuffer()).length > 500, `字体 ${f} 内容太小`)
    }
  } finally { close() }
})

test('V2 路由安全边界：嵌套路径 / .. / 编码变形 一律不得 200（回归护栏）', async (t) => {
  const D = mkdtempSync(join(tmpdir(), 'dpr-vendor-http-'))
  t.after(() => rmSync(D, { recursive: true, force: true }))
  const { base, close } = await bootRoutes(D)
  try {
    // 子目录形态：正是 PR #7 的 P0（资源在子目录 ⇒ 400）—— 这里把「路由不接受子目录」钉住，
    // 这样一旦有人把 KaTeX 又放回子目录，本文件 + 守卫 R3 会一起红。
    const nested = await fetch(base + '/paper-reader/vendor/katex/katex.min.js')
    assert.equal(nested.status, 400, '子目录路径必须被路由拒绝（bad asset name）')
    // 穿越与编码变形：一律 4xx，绝不能 200 拿到源码
    // 注意：`fetch(base + p)` 会先做 URL 归一化（`..` 被吃掉、变成读页面），测不到服务端 ⇒ 这里用
    // 原始 socket 请求把**字面路径**发出去。
    const rawGet = (path) => new Promise((res) => {
      const req = httpRequest({ host: '127.0.0.1', port: Number(new URL(base).port), path, method: 'GET' }, (r) => {
        let body = ''
        r.on('data', (c) => { body += c })
        r.on('end', () => res({ status: r.statusCode, body }))
      })
      req.on('error', (e) => res({ status: 0, body: String(e) }))
      req.end()
    })
    for (const p of ['/paper-reader/vendor/%2e%2e%2fhost.js', '/paper-reader/vendor/..%2f..%2fpackage.json',
      '/paper-reader/vendor/sub%2Fkatex.min.js', '/paper-reader/vendor/%2E%2E%2Fkatex.min.js']) {
      const r = await rawGet(p)
      assert.ok(r.status >= 400 && r.status < 500, `${p} 必须是 4xx（拿到 ${r.status}；body=${r.body.slice(0, 60)}）`)
      assert.ok(!/export const|"version"/.test(r.body), `${p} 不得泄漏仓库内容：${r.body.slice(0, 80)}`)
    }
    // 未编码的 `..`/`.`：node 的 URL 解析**在 dispatch 之前**就把路径归一化掉了（实测返回阅读器页面），
    // 所以这里不断言状态码，只断言「没有得到 vendor 目录之外的文件内容」——不泄漏才是要点。
    for (const p of ['/paper-reader/vendor/..', '/paper-reader/vendor/.', '/paper-reader/vendor/../package.json']) {
      const r = await rawGet(p)
      assert.ok(!/export const|"name": "|"version": "1\./.test(r.body), `${p} 不得泄漏仓库文件：${r.body.slice(0, 80)}`)
    }
    // 正常扁平名（带查询串）仍然可用
    const ok = await fetch(base + '/paper-reader/vendor/katex.min.js?v=1')
    assert.equal(ok.status, 200, '扁平文件名 + 查询串必须仍然 200')
  } finally { close() }
})

test('V3 页面里 KaTeX 资源的 URL 形状与 host 白名单一致（静态核对，防再次放回子目录）', () => {
  const html = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')
  const urls = [...html.matchAll(/<(?:link|script)[^>]*?(?:href|src)="(\/paper-reader\/vendor\/[^"]+)"/g)].map((m) => m[1])
  assert.ok(urls.length > 0, '页面必须引 vendor 资源')
  for (const u of urls) {
    assert.match(u, /^\/paper-reader\/vendor\/[\w.-]+$/, `资源 URL 必须与路由白名单 ^[\\w.-]+$ 同形：${u}`)
  }
})
