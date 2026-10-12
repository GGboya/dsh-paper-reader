// test/reader-render-guard.test.mjs — 静态守卫：译文气泡的**公式渲染路径**
//
// 与 main 上那批守卫（windows-esm-guard / reader-script）同风格：扫源码、可本机跑、有变异验证。
// 钉住三条不可退化的契约：
//   R1 气泡渲染路径（showTrPop / trRenderBody / renderMathSegment / splitTranslatedMath / trComposeNote）
//      **不得出现 innerHTML**（译文是模型输出，当不可信数据；文本段一律 textContent，数学段交 KaTeX 建 DOM）。
//   R2 KaTeX 必须按契约参数调用：trust:false、throwOnError:false（真渲染）、strict:'ignore'，
//      并且**探测那次**必须是 throwOnError:true，否则渲染失败抓不住、降级逻辑就成空转。
//   R3 KaTeX 是本地 vendored 资源：页面用 /paper-reader/vendor/katex/… 引（不得引 CDN），文件真实存在。
//   R4 版本/许可证可追溯：NOTICE 与 vendored JS 的版本一致、LICENSE 是 MIT。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeEol, extractModuleScript } from './reader-script.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = normalizeEol(readFileSync(join(REPO, 'reader', 'index.html'), 'utf8'))
const SCRIPT = extractModuleScript(HTML, { where: 'reader/index.html' })
const KATEX_DIR = join(REPO, 'reader', 'vendor', 'katex')

/** 取出一个顶层函数的源码（按大括号配对，字符串/注释/模板串原样保留）。 */
function fnSource(src, name) {
  const at = src.search(new RegExp(`\\nfunction\\s+${name}\\s*\\(`))
  assert.ok(at >= 0, `源码里找不到 function ${name}()（守卫要跟着改，别静默失效）`)
  const start = src.indexOf('{', at)
  let depth = 0
  let i = start
  let kind = 'code'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (kind === 'code') {
      if (c === '/' && n === '/') { kind = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { kind = 'block'; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { kind = c; i += 1; continue }
      if (c === '{') depth += 1
      else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(at, i + 1) }
    } else if (kind === 'line') {
      if (c === '\n') kind = 'code'
    } else if (kind === 'block') {
      if (c === '*' && n === '/') { kind = 'code'; i += 2; continue }
    } else {           // 字符串/模板串
      if (c === '\\') { i += 2; continue }
      if (c === kind) kind = 'code'
    }
    i += 1
  }
  throw new Error(`function ${name}() 的大括号没有闭合`)
}

const RENDER_FNS = ['showTrPop', 'trRenderBody', 'renderMathSegment', 'splitTranslatedMath', 'trComposeNote']

test('R1 气泡渲染路径不得出现 innerHTML（模型输出不可信）', () => {
  const offenders = []
  for (const name of RENDER_FNS) {
    const body = fnSource(SCRIPT, name)
    if (/\.innerHTML\b|\[['"]innerHTML['"]\]/.test(body)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些函数里出现了 innerHTML：${offenders.join(', ')}`)
  // 正对照：同文件里别处确实有 innerHTML（不然这条守卫可能是空转）——限定在页代码里找一处已知用法
  assert.match(SCRIPT, /container\.innerHTML\s*=\s*''/, '正对照失败：守卫的扫描目标可能已经不是页代码')
})

test('R2 KaTeX 调用参数必须是契约参数（且探测那次必须 throwOnError:true）', () => {
  const body = fnSource(SCRIPT, 'renderMathSegment')
  // 每个调用取「到分号为止」的实参文本（比整段正则稳）
  const stmt = (call) => {
    const at = body.indexOf(call)
    assert.ok(at >= 0, `renderMathSegment 里找不到 ${call}`)
    const end = body.indexOf(';', at)
    assert.ok(end > at, `${call} 的语句没有分号结尾`)
    return body.slice(at, end)
  }
  assert.equal((body.match(/k\.renderToString\(/g) ?? []).length, 1, '探测调用必须恰有一次')
  assert.equal((body.match(/k\.render\(/g) ?? []).length, 1, '真渲染调用必须恰有一次')
  const probe = stmt('k.renderToString(')
  const real = stmt('k.render(')
  for (const opts of [probe, real]) {
    assert.match(opts, /trust:\s*false/, `必须 trust:false（不产原始 HTML）：${opts}`)
    assert.match(opts, /strict:\s*'ignore'/, `必须 strict:'ignore'：${opts}`)
  }
  assert.match(real, /throwOnError:\s*false/, `真渲染必须 throwOnError:false：${real}`)
  assert.match(probe, /throwOnError:\s*true/, `探测必须 throwOnError:true（否则抓不住失败、降级成空转）：${probe}`)
  // 文本段必须走 textContent（只允许给新建元素赋 textContent）
  const renderBody = fnSource(SCRIPT, 'trRenderBody')
  assert.match(renderBody, /el\.textContent\s*=\s*seg\.text/, '文本段必须 textContent')
})

test('R3 KaTeX 必须是本地 vendored 资源（离线，不得引 CDN）', () => {
  const tags = HTML.match(/<(?:link|script)[^>]*katex[^>]*>/g) ?? []
  assert.equal(tags.length, 2, `页面应当恰好引 2 个 KaTeX 资源（CSS + JS）：${tags.join(' | ')}`)
  for (const tag of tags) {
    assert.ok(tag.includes('/paper-reader/vendor/katex/'), `KaTeX 资源必须走本地路径：${tag}`)
    assert.ok(!/https?:\/\//.test(tag), `不得引 CDN：${tag}`)
  }
  for (const f of ['katex.min.js', 'katex.min.css', 'LICENSE', 'NOTICE.md']) {
    assert.ok(existsSync(join(KATEX_DIR, f)), `缺文件 reader/vendor/katex/${f}`)
  }
  assert.ok(statSync(join(KATEX_DIR, 'katex.min.js')).size > 100_000, 'katex.min.js 体积异常（可能是占位文件）')
  const css = readFileSync(join(KATEX_DIR, 'katex.min.css'), 'utf8')
  const missing = [...css.matchAll(/url\(fonts\/([A-Za-z0-9_.-]+\.woff2)\)/g)]
    .map((m) => m[1])
    .filter((f) => !existsSync(join(KATEX_DIR, 'fonts', f)))
  assert.deepEqual(missing, [], `CSS 引用的字体必须都在（离线渲染要用）：${missing.join(', ')}`)
})

test('R4 版本与许可证可追溯（NOTICE 与 vendored JS 一致、LICENSE 是 MIT）', () => {
  const js = readFileSync(join(KATEX_DIR, 'katex.min.js'), 'utf8')
  const m = js.match(/version:"(\d+\.\d+\.\d+)"/)
  assert.ok(m, 'katex.min.js 里读不到版本号')
  const notice = readFileSync(join(KATEX_DIR, 'NOTICE.md'), 'utf8')
  assert.ok(notice.includes(m[1]), `NOTICE.md 的版本必须与 vendored JS 一致（JS=${m[1]}）`)
  assert.ok(notice.includes('registry.npmjs.org/katex') && notice.includes('sha256'), 'NOTICE 必须写明来源 URL 与校验值')
  const lic = readFileSync(join(KATEX_DIR, 'LICENSE'), 'utf8')
  assert.match(lic, /MIT License/, 'LICENSE 必须是 KaTeX 的 MIT 全文')
  assert.match(lic, /Khan Academy/, 'LICENSE 必须保留上游版权声明')
})
