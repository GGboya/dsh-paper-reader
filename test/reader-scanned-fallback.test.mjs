// test/reader-scanned-fallback.test.mjs — 扫描件不再硬走 pdf.js（issue #30-①）
//
// 用户实测：扫描版 PDF 的正文是 CCITT/JBIG2 图片，pdf.js 6 的这些解码器依赖 wasm；
// 缺 wasm 时页面 canvas 是白的、只剩 JPEG 图表，而且没有报错。现在的契约：
//   ① 打开文档后先探测文本层，前 3 页 + 中间 + 末页都没有文本 ⇒ 判定扫描件；
//   ② Web 与 Electron 同一条路：仍用 pdf.js 画页（纯 JS 图像解码），只加提示、不预取译文；
//   ③ 顶栏明确提示「扫描件：只能查看」，并禁用选词提问/笔记/查找/翻译入口；
//   ④ 换论文时必须撤掉兜底态，正常 PDF 仍走 pdf.js。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReaderScript } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const { html, script } = readReaderScript(join(ROOT, '..', 'reader', 'index.html'))

test('S1 扫描件判定：文本层探测覆盖前 3 页 + 中间 + 末页，且在首次渲染前执行', () => {
  assert.match(script, /async function docLooksScanned\(doc\)/)
  assert.match(script, /new Set\(\[1, 2, 3\]/)
  assert.match(script, /Math\.ceil\(doc\.numPages \/ 2\)/)
  assert.match(script, /probe\.add\(doc\.numPages\)/)
  const loadPdf = script.slice(script.indexOf('async function loadPdf('), script.indexOf('/* ── 单文档视图缓存'))
  assert.match(loadPdf, /const scanned = await docLooksScanned\(doc\)/)
  assert.ok(loadPdf.indexOf('docLooksScanned') < loadPdf.indexOf('await rerender()'), '扫描件判定必须在渲染之前')
})

test('S2 扫描件统一走 pdf.js + 明确提示（Web 与客户端同一条路）', () => {
  assert.doesNotMatch(html, /native-pdf|application\/pdf/, '不再使用浏览器原生 PDF 插件：Electron 桌面端默认 plugins:false')
  assert.match(html, /id="scan-banner"/)
  assert.match(html, /id="scan-title">扫描件：只能查看</)
  assert.match(script, /function enterScannedView\(url\)/)
  assert.match(script, /scannedPdfMode = true/)
  assert.match(script, /body\.classList\.add\('dpr-scan'\)/)
  assert.match(script, /扫描件：只能查看/)
  assert.match(script, /没有文本层，只能按原样查看/)
  // 查看态下这些入口不可用（CSS 隐藏 + 代码守卫，双保险）
  assert.match(html, /body\.dpr-scan #find-open, body\.dpr-scan #note-open/)
  assert.match(html, /body\.dpr-scan #zh-toggle, body\.dpr-scan #view-menu-btn/)
  assert.match(script, /if \(scannedPdfMode\) \{ toast\('扫描件没有文本层，只能查看；全文查找不可用'/)
  assert.match(script, /if \(on && scannedPdfMode\) \{ toast\('扫描件没有文本层，只能查看；笔记不可用'/)
  // 图像解码兜底：不依赖 wasm，也不依赖浏览器插件
  assert.match(script, /useWasm: false, wasmUrl: PR_ASSET_BASE \+ 'vendor\/'/)
  const loadPdf = script.slice(script.indexOf('async function loadPdf('), script.indexOf('/* ── 单文档视图缓存'))
  assert.match(loadPdf, /if \(scanned\) enterScannedView\(url\)/, '扫描件只打提示，仍继续用 pdf.js 渲染')
  assert.ok(loadPdf.indexOf('enterScannedView') < loadPdf.indexOf('await rerender()'), '提示必须在渲染前挂上')
})

test('S3 换论文/换视图撤掉查看态；扫描件不预取译文、不参与分屏', () => {
  assert.match(script, /function exitScannedView\(\)/)
  assert.match(script, /scannedPdfMode = false/)
  assert.match(script, /document\.body\.classList\.remove\('dpr-scan'\)/)
  assert.match(script, /if \(openingPaper \|\| scannedPdfMode\) return/)
  assert.match(script, /if \(scannedPdfMode\) return; \/\/ 扫描件只作查看，不参与分屏\/译文渲染/)
})

test('S4 ESP32 一类 TeX 中文 PDF：预定义 CMap 随包提供并接入 getDocument', () => {
  assert.match(script, /cMapUrl: PR_ASSET_BASE \+ 'vendor\/', cMapPacked: true/)
  assert.ok(existsSync(join(ROOT, '..', 'reader', 'vendor', 'Adobe-GB1-UCS2.bcmap')), '缺 Adobe-GB1-UCS2.bcmap：ESP32/Fandol 中文会整段消失')
  assert.ok(existsSync(join(ROOT, '..', 'reader', 'vendor', 'UniGB-UTF16-H.bcmap')), '缺 UniGB-UTF16-H.bcmap：CNKI 的 SimSun 预定义 CMap 字体画不出')
})

test('S5 文献库树自己滚动 + 行高收紧（issue #30-②）', () => {
  const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  assert.match(client, /treeScroll: \{ flex: '1 1 0', minHeight: 0, overflowY: 'auto'/)
  assert.match(client, /root: \{[^\n]*display: 'flex', flexDirection: 'column', height: '100%', maxHeight: '100%', minHeight: 0/)
  assert.match(client, /role: 'tree', style: S\.treeScroll/)
  assert.match(client, /item: \{[^\n]*minHeight: '24px'/)
  assert.match(client, /topicHead: \{[^\n]*minHeight: '24px'/)
})
