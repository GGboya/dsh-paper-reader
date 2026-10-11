// test/windows-esm-guard.test.mjs —— Windows 检出上的**静态 + 行为**守卫（在 Linux/macOS 上跑即可拦住 Windows 必崩的写法）
//
// 立这个守卫的直接原因：t10 修完 pathToFileURL 后，CI run 38139794817 的 windows 作业**仍然红**，
// 而本文件当时自称「裸路径 0 处」——**检查没检查到真正的问题**。复盘出三类盲区（本轮逐一修掉）：
//   A. **只看 `await import(`**：`const m = import(x)` / `Promise.all([import(a)])` 这种没有 await 的动态
//      import 完全扫不到。
//   B. **只扫 `test/*.mjs`（不递归）+ 排除自身**：`test/子目录/*.mjs` 与守卫自己都成了盲区；
//      而注释/字符串里的 `import(` 又会误报（于是当初干脆排除了自己）。
//   C. **只盯「动态 import 的路径形态」**：Windows 检出的另一类系统性差异是 **CRLF 行尾**
//      （core.autocrlf 默认把仓库文件写成 CRLF）。按 LF 写死的正则 `/<script>\n…/` 在 CRLF 上失配 →
//      顶层 `.match(...)[1]` 抛 `Cannot read properties of null` → 整个测试文件加载即崩。
//      本轮 CI 的 3 个红文件（integration-upstream-merge / reader-ux-verification / reader-ux）
//      全是这一处，上一版守卫对此**零覆盖**。
//
// 现在的覆盖：
//   C1 动态 import() 必须走 pathToFileURL（递归扫 test/、lib/，含 reader/*.html；注释与字符串先「代码化」）
//   C2 symlinkSync 必须显式传 type（Windows 需要 file/dir）
//   C3 平台期望值不得硬编码 darwin（大小写敏感性等必须实测）——**注意**：t12 把 C3 改成在
//      「抹掉字符串内容」的 codeOnly 上匹配 `'darwin'` 字面量之后，C3 静默变成了空转
//      （实测：注入 process.platform === 'darwin' 仍绿）。t13 用 scanSource().kinds 修好并覆盖三种引号。
//   C4 `reader/index.html` 的 <script> 提取必须与行尾无关（LF/CRLF/CR 三种都给同一份脚本）
//   C5 测试文件不得再手写按 LF 写死的 `<script>` 提取（必须走 test/reader-script.mjs）

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractModuleScript, normalizeEol } from './reader-script.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归列出目录下的文件（相对 REPO 的 POSIX 路径）。 */
function listFiles(rel, filter) {
  const out = []
  const walk = (dir, prefix) => {
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue
      const r = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), r)
      else if (filter(e.name)) out.push(r)
    }
  }
  walk(rel, rel)
  return out.sort()
}

const TEST_MJS = () => listFiles('test', (n) => n.endsWith('.mjs'))
const LIB_JS = () => listFiles('lib', (n) => n.endsWith('.js'))
const READER_HTML = () => listFiles('reader', (n) => n.endsWith('.html'))

/**
 * 长度保持的扫描：返回 `{ code, kinds }`。
 *   · `code`：注释与字符串/模板字面量的**内容**被抹成空格（保留引号与长度）⇒ 索引与原文 1:1 对齐；
 *   · `kinds[i]`：第 i 个字符属于 `'code'` / `'comment'` / `'string'`（字符串**含两端引号**）。
 *
 * 为什么要 `kinds`：`code` 把字符串内容抹掉了，所以「想知道某个**带引号的字面量**是不是真代码」
 * 不能用 `code` 去匹配（会永远匹配不到）——C3 就踩过这个坑：它要看 `'darwin'` 这个字面量，
 * 却拿着被抹空的 `code` 去匹配 ⇒ 规则静默变成空转（本轮 t13 实测：注入
 * `process.platform === 'darwin'` 时 C3 竟然仍是绿的）。现在 C3 用原文匹配 + `kinds` 过滤。
 */
export function scanSource(src) {
  const out = [...src]
  const kinds = new Array(src.length).fill('code')
  const blank = (from, to, kind) => {
    for (let k = from; k < to; k++) {
      if (src[k] !== '\n') out[k] = ' '
      if (k < kinds.length) kinds[k] = kind
    }
  }
  let i = 0
  while (i < src.length) {
    // HTML 注释（reader/*.html 里有 `<!-- … import() … -->` 的说明文字）也要抹掉
    if (src[i] === '<' && src.slice(i, i + 4) === '<!--') {
      const close = src.indexOf('-->', i + 4)
      const end = close === -1 ? src.length : close + 3
      blank(i, end, 'comment'); i = end; continue
    }
    if (src[i] === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      blank(i, end, 'comment'); i = end; continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? src.length : close + 2
      blank(i, end, 'comment'); i = end; continue
    }
    const q = src[i]
    if (q === "'" || q === '"' || q === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === q) { j++; break }
        if (src[j] === '\n' && q !== '`') break
        j++
      }
      // 引号本身也算「字符串」：C3 用 kinds 判断 `process.platform` 是否落在字符串/注释里
      blank(i, j, 'string')
      i = j; continue
    }
    i++
  }
  return { code: out.join(''), kinds }
}

/** 只要「代码化」后的文本（C1/C2/C5 用）。 */
export const codeOnly = (src) => scanSource(src).code

/** 取 `(` 起点的平衡括号内文本（用**原文**，因为要检查实参是不是 pathToFileURL/字面量）。 */
function balanced(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return src.slice(openIdx + 1)
}

/** 顶层逗号数 + 1 = 实参个数。 */
const argCount = (arg) => {
  let depth = 0
  let n = 1
  for (const c of arg) {
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) n++
  }
  return n
}

test('C1 动态 import() 必须走 pathToFileURL（Windows 上裸路径 = ERR_UNSUPPORTED_ESM_URL_SCHEME）', () => {
  const offenders = []
  for (const rel of [...TEST_MJS(), ...LIB_JS(), ...READER_HTML()]) {
    const src = readFileSync(join(REPO, rel), 'utf8')
    const code = codeOnly(src)
    // `(?<![.\w])import\s*\(`：排除 `import.meta`、`obj.import(`；静态 `import x from` 没有括号，不会命中。
    // 注意**不再要求 await**（盲区 A）：`const m = import(x)` / `Promise.all([import(a)])` 同样要扫到。
    for (const m of code.matchAll(/(?<![.\w])import\s*\(/g)) {
      const arg = balanced(src, m.index + m[0].length - 1).trim()
      if (arg === '') continue // 空实参不是调用（HTML 注释/说明文字里的 `import()` 字面量）
      // 允许：pathToFileURL(...) 包一层；或字面量（'node:fs'、'pdfjs-dist/…'；
      // reader/*.html 里 `import('/paper-reader/vendor/…')` 是**浏览器 URL**，按页面 origin 解析，不是文件系统路径）
      const ok = arg.startsWith('pathToFileURL(') || /^['"`]/.test(arg)
      if (!ok) offenders.push(`${rel}: ${'import(' + arg.split('\n')[0].slice(0, 70)}…)`)
    }
  }
  assert.deepEqual(offenders, [], `动态 import() 必须包 pathToFileURL（上游 905dc59 同款）：\n${offenders.join('\n')}`)
})

test('C2 symlinkSync 必须显式传第三个参数 type（Windows 需要 file/dir 明确指定，unix 会忽略）', () => {
  const offenders = []
  for (const rel of [...TEST_MJS(), ...LIB_JS()]) {
    const src = readFileSync(join(REPO, rel), 'utf8')
    for (const m of codeOnly(src).matchAll(/\bsymlinkSync\s*\(/g)) {
      const arg = balanced(src, m.index + m[0].length - 1)
      if (argCount(arg) < 3) offenders.push(`${rel}: symlinkSync(${arg.split('\n')[0].trim().slice(0, 70)}…)`)
    }
  }
  assert.deepEqual(offenders, [], `symlinkSync 缺 type 参数（Windows 上会按错误的链接类型建立）：\n${offenders.join('\n')}`)
})

test('C3 平台期望值不许硬编码 darwin（大小写敏感性等必须实测）', () => {
  const offenders = []
  // 三种引号形态都算（t11 点名的收窄项：旧写法只认单引号）。
  // 匹配**原文**（`'darwin'` 是字符串字面量，在 codeOnly 里已被抹空 ⇒ 用它会永远匹配不到，
  // 规则会静默空转），再用 `kinds[m.index]` 排除「注释/字符串里提到 darwin」的假阳性
  // （例如本守卫自己的提示文案、以及别的测试里示意性写法）。
  for (const rel of TEST_MJS()) {
    const src = readFileSync(join(REPO, rel), 'utf8')
    const { kinds } = scanSource(src)
    for (const m of src.matchAll(/process\.platform\s*===?\s*(['"`])darwin\1/g)) {
      if (kinds[m.index] !== 'code') continue
      offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}: ${m[0]}`)
    }
  }
  assert.deepEqual(offenders, [], `平台期望值请用实测探针（test/fs-probe.mjs 的 caseInsensitiveFs）而不是硬编码 darwin：\n${offenders.join('\n')}`)
})

test('C4 reader/index.html 的 <script> 提取必须与行尾无关（Windows 检出是 CRLF）', () => {
  const html = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')
  const lf = normalizeEol(html)
  const script = extractModuleScript(html)
  assert.ok(script.length > 1000, `取到的阅读器脚本不能是空壳（${script.length} 字符）`)
  assert.equal(extractModuleScript(lf), script, 'LF 与原始行尾必须取到同一份脚本')
  assert.equal(extractModuleScript(lf.replaceAll('\n', '\r\n')), script, 'CRLF（Windows 检出）必须取到同一份脚本')
  assert.equal(extractModuleScript(lf.replaceAll('\n', '\r')), script, '落单 CR 也必须能取到')
  // 反例：真的没有 <script> 时必须抛可读错误，而不是静默 undefined 让调用方 `.match(...)[1]` 崩
  assert.throws(() => extractModuleScript('<html><body>no script here</body></html>'), /找不到 <script>/)
})

test('C5 测试文件不得再手写按 LF 写死的 <script> 提取（必须走 test/reader-script.mjs）', () => {
  const offenders = []
  for (const rel of TEST_MJS().filter((f) => f.endsWith('.test.mjs'))) {
    const code = codeOnly(readFileSync(join(REPO, rel), 'utf8'))
    if (/match\(\s*\/<script>/.test(code)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `按 LF 写死的 <script> 正则在 CRLF 检出上会 null[1] 崩掉整个文件（CI 38139794817）；请用 extractModuleScript()：\n${offenders.join('\n')}`)
})
