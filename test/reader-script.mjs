// test/reader-script.mjs —— 从 `reader/index.html` 取出模块脚本源码（**非测试文件**：不匹配 test/*.test.mjs）
//
// 为什么要单独抽出来（CI run 38139794817 的三个红点都是这一类）：
//   Windows 的 Git 默认把仓库文件 checkout 成 **CRLF**（`core.autocrlf=true` 的默认行为），
//   而 `READER_HTML.match(/<script>\n([\s\S]*)\n<\/script>/)[1]` 是按 **LF** 写死的正则 →
//   在 CRLF 检出上 `match()` 返回 null → `.match(...)[1]` 抛
//   `TypeError: Cannot read properties of null (reading '1')`，
//   而且这行在**模块顶层**，于是整个测试文件在加载阶段就崩（用例都没跑）。
// 本机可用「把工作树转成 CRLF」精确复现（见守卫 C4：同一份 HTML 的 LF/CRLF/CR 三种行尾都必须能取出脚本）。
//
// 约定：测试文件**不再各自手写** `<script>` 正则（守卫 C5 会拦），统一走这里。

import { readFileSync } from 'node:fs'

/** 行尾归一化：CRLF / 落单的 CR → LF。对本来就用 LF 的文件是 no-op。 */
export const normalizeEol = (s) => s.replaceAll('\r\n', '\n').replaceAll('\r', '\n')

/**
 * 取第一个 `<script>`…`</script>` 之间的源码。
 * 匹配不到时抛**可读**错误（带上文件名与提示），而不是静默返回 undefined 让调用方 `.match(...)[1]` 崩。
 */
export function extractModuleScript(html, { where = 'reader/index.html' } = {}) {
  const m = normalizeEol(html).match(/<script>\n([\s\S]*)\n<\/script>/)
  if (!m) throw new Error(`${where}: 找不到 <script>…</script> 包裹的模块脚本（行尾已归一化仍不匹配 ⇒ 页面结构变了）`)
  return m[1]
}

/** 便捷入口：读文件 → 归一化 HTML + 脚本源码（HTML 也返回，因为多处断言直接读 HTML 源码）。 */
export function readReaderScript(absPath) {
  const html = normalizeEol(readFileSync(absPath, 'utf8'))
  return { html, script: extractModuleScript(html, { where: absPath }) }
}
