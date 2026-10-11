// test/windows-esm-guard.test.mjs —— Windows 兼容性的**静态守卫**（在 Linux 上跑即可挡住 Windows 上必崩的写法）
//
// 背景（CI run 38138025102 的 windows-latest 作业，22 个失败里有 15 个是「文件加载即崩」）：
//   ERR_UNSUPPORTED_ESM_URL_SCHEME: Only URLs with a scheme in: file, data, and node are supported…
//   On Windows, absolute paths must be valid file:// URLs. Received protocol 'd:'
// 也就是 `import(<裸文件系统路径>)`（例如 'D:\\…\\dist\\host.js'）——POSIX 上能跑、Windows 上必崩。
// 上游修过同一类（905dc59「test: 套件兼容 Windows —— import 走 pathToFileURL」）；这里把它固化成
// 可回归的静态断言：以后新写的用例再写裸路径，本机的 `npm test` 就会红，而不是等 CI。

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
// 扫描除自己以外的所有 test/*.mjs：本文件的正则字面量/提示文案里就带这些片段，扫自己必然误报。
const TEST_FILES = () =>
  readdirSync(join(REPO, 'test')).filter((f) => f.endsWith('.mjs') && f !== 'windows-esm-guard.test.mjs').sort()

// 用字符串拼正则，避免「守卫自己的源码」被自己扫到
const IMPORT_RE = new RegExp('await\\s+import\\s*\\(', 'g')
const SYMLINK_RE = new RegExp('\\bsymlinkSync\\s*\\(', 'g')
const DARWIN_RE = new RegExp("process\\.platform\\s*===?\\s*'darwin'", 'g')

/** 取 `(` 起点的平衡括号内文本（用于静态分析 import()/symlinkSync() 的实参）。 */
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

/** 顶层逗号数 + 1 = 实参个数（够用：我们的调用里没有嵌套逗号的类型参数）。 */
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

test('C1 所有动态 import() 都必须走 pathToFileURL（裸路径在 Windows 上是 ERR_UNSUPPORTED_ESM_URL_SCHEME）', () => {
  const offenders = []
  for (const f of TEST_FILES()) {
    const src = readFileSync(join(REPO, 'test', f), 'utf8')
    for (const m of src.matchAll(IMPORT_RE)) {
      const arg = balanced(src, m.index + m[0].length - 1).trim()
      // 允许：pathToFileURL(...) 包一层；或带 scheme 的字面量（'node:fs' / 'pdfjs-dist/…'）
      const ok = arg.startsWith('pathToFileURL(') || /^['"`]/.test(arg)
      if (!ok) offenders.push(`${f}: await import(${arg.split('\n')[0].slice(0, 70)}…)`)
    }
  }
  assert.deepEqual(offenders, [], `动态 import() 必须包 pathToFileURL（上游 905dc59 同款）：\n${offenders.join('\n')}`)
})

test('C2 symlinkSync 必须显式传第三个参数 type（Windows 需要 file/dir 明确指定，unix 会忽略）', () => {
  const offenders = []
  for (const f of TEST_FILES()) {
    const src = readFileSync(join(REPO, 'test', f), 'utf8')
    for (const m of src.matchAll(SYMLINK_RE)) {
      const arg = balanced(src, m.index + m[0].length - 1)
      if (argCount(arg) < 3) offenders.push(`${f}: symlinkSync(${arg.split('\n')[0].trim().slice(0, 70)}…)`)
    }
  }
  assert.deepEqual(offenders, [], `symlinkSync 缺 type 参数（Windows 上会按错误的链接类型建立）：\n${offenders.join('\n')}`)
})

test('C3 平台期望值不许硬编码 darwin（大小写敏感性等必须实测）', () => {
  const offenders = []
  for (const f of TEST_FILES()) {
    const src = readFileSync(join(REPO, 'test', f), 'utf8')
    for (const m of src.matchAll(DARWIN_RE)) {
      offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}: process.platform === 'darwin'`)
    }
  }
  assert.deepEqual(offenders, [], `平台期望值请用实测探针（test/fs-probe.mjs 的 caseInsensitiveFs）而不是硬编码 darwin：\n${offenders.join('\n')}`)
})
