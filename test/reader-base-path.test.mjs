// test/reader-base-path.test.mjs —— 阅读器在**子路径反代**下必须能用（fnOS / nginx sub-path）。
//
// 守什么：`/paper-reader` 挂在哪个路径下由部署环境决定，插件不能假定它在域名根。
// 反代把 dsh web 挂到子路径时（fnOS 应用中心是 /app/<应用名>），以域名根为基准的
// 绝对路径会打到代理根、被别的应用接管并**返回 HTML**，两类症状都由此而来：
//
//   ① fetch('/paper-reader/api') → r.json() 解析 HTML 失败 ⇒ 文献库静默空白、上传 403
//   ② import('/paper-reader/vendor/pdf.min.mjs') → 浏览器按 MIME 拒绝执行 ES 模块
//      （Failed to fetch dynamically imported module）
//
// ② 尤其隐蔽：反代通常会给页面注入 fetch/XHR/属性改写钩子，但**改不到**原生模块
// 动态 import 与 Worker 的 workerSrc（它们不经过 fetch），只能由页面自己算对基址。
// 本文件同时守两侧：基址派生必须在两种部署下都正确，且不能再出现写死的绝对 path。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { readReaderScript, normalizeEol } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const READER_PATH = join(ROOT, '..', 'reader', 'index.html')
const CLIENT = normalizeEol(readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8'))
const { script: READER } = readReaderScript(READER_PATH)

/** 取出 PR_ASSET_BASE / PR_API_BASE 的定义段（到深色首帧判定之前）。 */
const BASE_DEF_END = '/* 深色首帧判定'
function baseDefSource() {
  const at = READER.indexOf(BASE_DEF_END)
  assert.notEqual(at, -1, 'reader 脚本里找不到「深色首帧判定」锚点 ⇒ 基址定义段无法定位，守卫需同步更新')
  const def = READER.slice(0, at)
  assert.match(def, /PR_ASSET_BASE/, '基址常量 PR_ASSET_BASE 必须定义在脚本最前面')
  return def
}

/** 在假 location 里跑基址定义段，取回两个常量。 */
function deriveFor(href) {
  const box = { location: { href }, URL }
  vm.createContext(box)
  vm.runInContext(baseDefSource() + '\n;globalThis.__R = { asset: PR_ASSET_BASE, api: PR_API_BASE };', box)
  return box.__R
}

test('B1 基址在「根路径直连」与「子路径反代」两种部署下都指向 /paper-reader/', () => {
  const cases = [
    // 子路径反代（fnOS 应用中心）：这正是本守卫要防回归的场景
    { href: 'https://host/app/fn-deepseek-harness/paper-reader/?topic=a&name=b',
      asset: 'https://host/app/fn-deepseek-harness/paper-reader/',
      api: 'https://host/app/fn-deepseek-harness/paper-reader/api' },
    { href: 'https://host/app/fn-deepseek-harness/paper-reader',
      asset: 'https://host/app/fn-deepseek-harness/paper-reader/',
      api: 'https://host/app/fn-deepseek-harness/paper-reader/api' },
    // 根路径直连：行为必须与改动前一致，不能回归
    { href: 'http://127.0.0.1:3080/paper-reader/', asset: 'http://127.0.0.1:3080/paper-reader/',
      api: 'http://127.0.0.1:3080/paper-reader/api' },
    { href: 'http://127.0.0.1:3080/paper-reader', asset: 'http://127.0.0.1:3080/paper-reader/',
      api: 'http://127.0.0.1:3080/paper-reader/api' },
  ]
  for (const c of cases) {
    const got = deriveFor(c.href)
    assert.equal(got.asset, c.asset, `PR_ASSET_BASE 解析错误：${c.href}`)
    assert.equal(got.api, c.api, `PR_API_BASE 解析错误：${c.href}`)
  }
})

test('B2 阅读器脚本不得再出现写死的 /paper-reader 绝对 path（import / fetch / workerSrc / 图标）', () => {
  // <link href> 与 <script src> 是解析期资源，反代会改写它们，保持绝对路径是对的，故排除。
  const offenders = []
  const pats = [
    { name: '动态 import', re: /import\s*\(\s*['"`]\/paper-reader\// },
    { name: 'fetch', re: /fetch\s*\(\s*['"`]\/paper-reader\// },
    { name: 'workerSrc', re: /workerSrc\s*=\s*['"`]\/paper-reader\// },
    { name: '模板字符串 URL', re: /`\/paper-reader\// },
    { name: '图标 src', re: /\.src\s*=\s*['"`]\/paper-reader\// },
  ]
  for (const p of pats) {
    const m = READER.match(p.re)
    if (m) offenders.push(`${p.name}: ${READER.slice(m.index, m.index + 60).split('\n')[0]}`)
  }
  assert.deepEqual(offenders, [],
    `阅读器不得写死 /paper-reader 绝对路径（子路径反代下会被别的应用接管）：\n${offenders.join('\n')}`)
})

test('B3 pdf.js 与 worker 必须走 PR_ASSET_BASE 派生（bridge 改不到原生模块加载）', () => {
  assert.match(READER, /import\(PR_ASSET_BASE \+ ['"`]vendor\/pdf\.min\.mjs/,
    'pdf.js 必须用 PR_ASSET_BASE 拼接加载')
  assert.match(READER, /workerSrc = PR_ASSET_BASE \+ ['"`]vendor\/pdf\.worker\.min\.mjs/,
    'workerSrc 必须用 PR_ASSET_BASE 拼接')
})

test('B4 宿主客户端（lib/client.js）的 dprBase() 必须能从 pathname 里截出反代前缀', () => {
  const start = CLIENT.indexOf('function dprBase()')
  assert.notEqual(start, -1, 'lib/client.js 里找不到 dprBase()：宿主侧路径自适配被移除了？')
  const src = CLIENT.slice(start, CLIENT.indexOf('\n    }', start) + 6)
  const run = (pathname) => {
    const box = { location: { pathname } }
    vm.createContext(box)
    vm.runInContext(src + '\n;globalThis.__b = dprBase();', box)
    return box.__b
  }
  assert.equal(run('/app/fn-deepseek-harness/paper-reader/'), '/app/fn-deepseek-harness/paper-reader',
    '子路径反代下必须带上前缀')
  assert.equal(run('/app/fn-deepseek-harness/'), '/paper-reader', '非阅读器页面回落到根路径')
  assert.equal(run('/paper-reader/'), '/paper-reader', '根路径直连不得回归')
  assert.equal(run('/'), '/paper-reader', '根路径直连不得回归')
})

test('B5 宿主客户端不得再直接 fetch 写死的 /paper-reader/api', () => {
  const offenders = []
  for (const m of CLIENT.matchAll(/fetch\(\s*['"`]\/paper-reader\//g)) {
    offenders.push(CLIENT.slice(Math.max(0, m.index - 30), m.index + 50).split('\n').pop())
  }
  assert.deepEqual(offenders, [],
    `lib/client.js 的请求必须走 dprBase()（子路径反代下会拿到 HTML）：\n${offenders.join('\n')}`)
})
