// test/mineru-math-spaces.test.mjs — 「投影阶段压缩数学区间空白」的边界测试。
//
// 背景：MinerU 的 LaTeX 在每个 token 之间都插空格（`x _ { t - 1 }`），而 search_paper 的
// 关键词检索是纯子串匹配（按空格切词 → indexOf 计数），于是 `x_{t-1}` 这类正常写法 0 命中。
// 修复只在 content_list → .txt 的投影阶段压缩 `$...$` / `$$...$$` 内部的空白。
//
// 只 import dist/*.js（Node 22 无法直接跑 TS）。跑前先 `npm run build`。
// fixture 全部取自真实 MinerU（本地 legacy /file_parse，backend=pipeline）对
// "Gu et al. - 2022 - Vector Quantized Diffusion Model for Text-to-Image Synthesis.pdf" 第 4 页的产出。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

const mineru = await import(dist('mineru.js'))
const search = await import(dist('search.js'))
const { compressMathSpaces, normalizeMathBraces, projectContentList } = mineru
const { chunkText, searchChunks } = search

/** 真实 MinerU 块（第 4 页，page_idx=3），text 与原样产出逐字节一致。 */
const REAL_BLOCKS = [
  {
    type: 'text',
    text:
      'To be more specific, consider a single image token $x _ { 0 } ^ { i }$ of $\\scriptstyle { \\mathbf { { \\mathit { x } } } } _ { 0 }$ at location $i ,$ which takes the index that specifies the entries in the codebook, $i . e . , x _ { 0 } ^ { i } \\in \\{ 1 , 2 , . . . , K \\}$ . Without introducing confusion, we omit superscripts i in the following description. We define the probabilities that $x _ { t - 1 }$ transits to $x _ { t }$ using the matrices $[ Q _ { t } ] _ { m n } = q ( x _ { t } = m | x _ { t - 1 } = n ) \\in$ $\\mathbb { R } ^ { K \\times K }$ . Then theforward Markov diffusion process for the whole token sequence can be written as,',
    page_idx: 3,
  },
  {
    type: 'equation',
    text:
      '$$\nq ( x _ { t } | x _ { t - 1 } ) = \\pmb { v } ^ { \\top } ( x _ { t } ) \\pmb { Q } _ { t } \\pmb { v } ( x _ { t - 1 } )\\tag{3}\n$$',
    page_idx: 3,
  },
  {
    type: 'text',
    text:
      '<sub>e</sub>rThe transition matrix $Q _ { t }$ is crucial to the discrete diffuo<sup>r</sup> c<sup>k</sup><sub>p</sub>ti n<sup>o</sup>sion model and should be carefully designed such that it is a<sup>n B</sup>A<sup>d</sup> a<sup>y</sup>not too difficult for the reverse network to recover the signal from noises.',
    page_idx: 3,
  },
  {
    type: 'equation',
    text:
      '$$\n\\begin{array} { r } { \\mathbf {  { Q } } _ { t } = \\left[ \\begin{array} { c c c c } { \\alpha _ { t } + \\beta _ { t } } & { \\beta _ { t } } & { \\cdots \\bullet } & { \\beta _ { t } } \\\\ { \\beta _ { t } } & { \\alpha _ { t } + \\beta _ { t } } & { \\cdots \\bullet } & { \\beta _ { t } } \\end{array} \\right] } \\end{array}\\tag{6}\n$$',
    page_idx: 3,
  },
]

// ── 1. 核心压缩（验收原例）───────────────────────────────────────────────

test('压缩：验收原例 x _ { t - 1 } → x_{t-1}、\\mathbb { R } ^ { K \\times K } → \\mathbb{R}^{K\\times K}', () => {
  assert.equal(compressMathSpaces('$x _ { t - 1 }$'), '$x_{t-1}$')
  assert.equal(compressMathSpaces('$\\mathbb { R } ^ { K \\times K }$'), '$\\mathbb{R}^{K\\times K}$')
  assert.equal(
    compressMathSpaces('$\\pmb { Q } _ { t } \\pmb { v } ( x _ { t - 1 } )$'),
    '$\\pmb{Q}_{t}\\pmb{v}(x_{t-1})$',
  )
})

test('压缩：连续空格、制表符与换行一并处理（含跨行区间）', () => {
  assert.equal(compressMathSpaces('$x _ { t }   =     n$'), '$x_{t}=n$')
  assert.equal(compressMathSpaces('$x _ { t }\t=\nn$'), '$x_{t}=n$')
  assert.equal(compressMathSpaces('$a _ { 1 } ,\n   b _ { 2 }$'), '$a_{1},b_{2}$')
  assert.equal(compressMathSpaces('$$\nq ( x _ { t } ) = n\n$$'), '$$q(x_{t})=n$$')
  assert.equal(compressMathSpaces('$$  \\alpha   \\beta  $$'), '$$\\alpha\\beta$$')
})

test('压缩：独立公式（MinerU 形如 $$\\n...\\n$$）与 \\tag 一起压缩', () => {
  const eq = REAL_BLOCKS[1].text
  assert.equal(
    compressMathSpaces(eq),
    '$$q(x_{t}|x_{t-1})=\\pmb{v}^{\\top}(x_{t})\\pmb{Q}_{t}\\pmb{v}(x_{t-1})\\tag{3}$$',
  )
})

test('压缩：控制字与字母之间保留一个空格（\\times K 不能变成未定义命令 \\timesK）', () => {
  assert.equal(compressMathSpaces('$K \\times K$'), '$K\\times K$')
  assert.equal(compressMathSpaces('$K   \\times   \\alpha$'), '$K\\times\\alpha$')
  // 控制字后面不是字母（{ _ ^ ( 等）→ 空格照样压掉
  assert.equal(compressMathSpaces('$\\sum _ { i = 1 } ^ { n } x _ { i }$'), '$\\sum_{i=1}^{n}x_{i}$')
  assert.equal(compressMathSpaces('$\\top ( x _ { t } )$'), '$\\top(x_{t})$')
})

// ── 2. \text{} 一族的空格必须原样保留 ───────────────────────────────────

test('\\text{}：内部空格逐字节保留（\text{hello world} 不得变成 \text{helloworld}）', () => {
  assert.equal(compressMathSpaces('$\\text{hello world}$'), '$\\text{hello world}$')
  assert.equal(
    compressMathSpaces('$\\text{the discrete diffusion  model} + x _ { t }$'),
    '$\\text{the discrete diffusion  model}+x_{t}$',
  )
  assert.equal(compressMathSpaces('$\\text{hello world}$ $\\text{a b}$'), '$\\text{hello world}$ $\\text{a b}$')
})

test('\\textrm / \\textnormal / \\mbox 内部的空格同样保留', () => {
  // 成组原样 = 连花括号内侧的空格也一字不动（MinerU 常写成 `\textrm { ... }`）
  assert.equal(compressMathSpaces('$\\textrm { h e l l o   w o r l d }$'), '$\\textrm{ h e l l o   w o r l d }$')
  assert.equal(compressMathSpaces('$\\textnormal{a b} + y _ { t }$'), '$\\textnormal{a b}+y_{t}$')
  assert.equal(compressMathSpaces('$\\mbox{a b} + y _ { t }$'), '$\\mbox{a b}+y_{t}$')
  assert.equal(compressMathSpaces('$\\operatorname{arg max} + y _ { t }$'), '$\\operatorname{arg max}+y_{t}$')
})

test('\\text{}：嵌套花括号按配对整组保留（含内部 \\} 转义）；花括号不配对时停止压缩', () => {
  assert.equal(compressMathSpaces('$\\text{a {b} c} x$'), '$\\text{a {b} c}x$')
  assert.equal(compressMathSpaces('$\\text{a \\} b} x$'), '$\\text{a \\} b}x$')
  // 未闭合的 \text{：命令名之后整段原样保留（宁可放弃压缩，也不冒险压掉正文空格）
  const broken = '$\\text{a b + x _ { t }$'
  assert.equal(compressMathSpaces(broken), broken)
})

test('\\mathrm / \\mathbf / \\pmb 等无空格语义的命令：内容压缩但命令本身不被损坏', () => {
  assert.equal(compressMathSpaces('$\\mathrm { d } x$'), '$\\mathrm{d}x$')
  assert.equal(compressMathSpaces('$\\mathbf { \\boldsymbol { x } } _ { t }$'), '$\\mathbf{\\boldsymbol{x}}_{t}$')
  assert.equal(compressMathSpaces('$\\scriptstyle { \\mathbf { { \\mathit { x } } } } _ { 0 }$'), '$\\scriptstyle{\\mathbf{{\\mathit{x}}}}_{0}$')
  assert.equal(compressMathSpaces('$\\begin{array} { c c } a & b \\\\ c & d \\end{array}$'), '$\\begin{array}{cc}a&b\\\\ c&d\\end{array}$')
})

// ── 3. 区间界定：转义 \$、孤立 $、未闭合区间 ────────────────────────────

test('定义域：转义 \\$ 不是定界符', () => {
  assert.equal(compressMathSpaces('price \\$5 and \\$10'), 'price \\$5 and \\$10')
  assert.equal(compressMathSpaces('regex /^\\$/ matches'), 'regex /^\\$/ matches')
  assert.equal(compressMathSpaces('$a\\$b$'), '$a\\$b$')
  assert.equal(compressMathSpaces('$x _ { 1 } \\$ y _ { 2 }$'), '$x_{1}\\$y_{2}$')
})

test('定义域：孤立 $ 不当区间开始（价格 / 变量名 / 正则场景）', () => {
  assert.equal(compressMathSpaces('It costs $5 today'), 'It costs $5 today')
  assert.equal(compressMathSpaces('from $5 to $10 per unit'), 'from $5 to $10 per unit')
  assert.equal(compressMathSpaces('use $HOME and $PATH in the shell'), 'use $HOME and $PATH in the shell')
  assert.equal(compressMathSpaces('total $1 , 000 for the rest'), 'total $1 , 000 for the rest')
  assert.equal(compressMathSpaces('the regex ^[a-z]$ matches'), 'the regex ^[a-z]$ matches')
  assert.equal(compressMathSpaces('a dollar sign $ alone'), 'a dollar sign $ alone')
})

test('定义域：未闭合的 $ / $$ 不压缩（宁可少压也不把正文当数学）', () => {
  assert.equal(compressMathSpaces('$unclosed x _ { t } here'), '$unclosed x _ { t } here')
  assert.equal(compressMathSpaces('$$ a  b'), '$$ a  b')
  assert.equal(compressMathSpaces('an equation follows $$\n\\alpha   \\beta'), 'an equation follows $$\n\\alpha   \\beta')
})

test('定义域：跨空行的「区间」判定为误配对，整段放弃', () => {
  const s = '$a\n\nb c d$'
  assert.equal(compressMathSpaces(s), s)
})

test('定义域：MinerU 的相邻区间（\\in$ $\\mathbb { R } ...$）第二个 $ 才是开定界符', () => {
  assert.equal(
    compressMathSpaces('$( x _ { t } = m ) \\in$ $\\mathbb { R } ^ { K \\times K }$ .'),
    '$(x_{t}=m)\\in$ $\\mathbb{R}^{K\\times K}$ .',
  )
})

// ── 4. 区间外逐字节不变 ────────────────────────────────────────────────

test('非数学文本逐字节不变（无 $ 走快路径；有 $ 但无有效区间也一字不改）', () => {
  const prose =
    'Mask-and-replace diffusion strategy. To solve the above issues of uniform diffusion, we draw inspiration\n' +
    'from mask language modeling [11] and propose to corrupt the tokens; 100% > 99.9% != 1/3, {a_b} [c^d].'
  assert.equal(compressMathSpaces(prose), prose)

  // 真实论文里出没的「$ 不是数学」形状：货币、环境变量、行尾正则、单个美元符号
  for (const proseWithDollar of [
    'costs $5 for setup and $10 for the rest',
    'uses $HOME and $PATH from the env',
    'the regex ^[a-z]$ is fine',
    'a lone $ sign',
    'total $1 , 000 and stops there',
  ]) {
    assert.equal(compressMathSpaces(proseWithDollar), proseWithDollar)
  }
})

test('区间外的 $ 数量与内容都不变（压缩只动区间内部）', () => {
  const s = 'Before $x _ { t }$ middle stays   as-is $y _ { t }$ after keeps 2 spaces'
  const out = compressMathSpaces(s)
  assert.equal(out, 'Before $x_{t}$ middle stays   as-is $y_{t}$ after keeps 2 spaces')
  assert.equal((out.match(/\$/g) ?? []).length, (s.match(/\$/g) ?? []).length)
})

// ── 5. 投影链路（blockToText / projectContentList）─────────────────────

test('投影：真实 MinerU 块 → .txt 可搜；非数学片段逐字节不变；块对象不被改写', () => {
  const blocks = structuredClone(REAL_BLOCKS)
  const snapshot = structuredClone(REAL_BLOCKS)
  const proj = projectContentList(blocks)

  // 原始块（会原样写进 .mineru.json）不被压缩改写
  assert.deepEqual(blocks, snapshot)
  // 数学区间内已压空白 + 单 token 花括号已归一化（多 token 参数的括号保留）
  assert.ok(proj.text.includes('$x_{t-1}$'), proj.text.slice(0, 400))
  assert.ok(proj.text.includes('$\\mathbb{R}^{K\\times K}$'))
  assert.ok(
    proj.text.includes('$$q(x_t|x_{t-1})=\\pmb{v}^\\top(x_t)\\pmb{Q}_t\\pmb{v}(x_{t-1})\\tag{3}$$'),
    proj.text.slice(0, 900),
  )
  assert.ok(proj.text.includes('$Q_t$'))
  assert.ok(proj.text.includes('$x_0^i$'))
  // 区间外逐字节保留（含 HTML 上下标与错别字）
  assert.ok(proj.text.includes('To be more specific, consider a single image token '))
  assert.ok(proj.text.includes(' . Then theforward Markov diffusion process'))
  assert.ok(proj.text.includes('discrete diffuo<sup>r</sup> c<sup>k</sup><sub>p</sub>ti n<sup>o</sup>sion model'))
  // 页码仍按 page_idx+1 聚页
  assert.deepEqual(proj.pages.map((p) => p.page), [4])
})

test('投影：无公式块（含裸 LaTeX `E = mc^2`）保持原样 —— 不在 $ 区间内的文本不动', () => {
  const p = projectContentList([
    { type: 'text', text: 'P1 heading', page_idx: 0 },
    { type: 'equation', text: 'E = mc^2', page_idx: 0 },
    { type: 'table', table_caption: ['表 1'], table_body: '<table><tr><td>a</td><td>b</td></tr></table>', page_idx: 0 },
  ])
  assert.ok(p.text.includes('E = mc^2'), p.text)
  assert.ok(p.text.includes('表 1'))
  assert.ok(p.text.includes('a b'))
  assert.equal(p.text, 'P1 heading\n\nE = mc^2\n\n表 1\na b')
})

test('投影：不含任何 $ 的论文产物与改造前逐字节一致（回归）', () => {
  const prose = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: plain text with no math at all.`).join('\n\n')
  const p = projectContentList([{ type: 'text', text: prose, page_idx: 0 }])
  assert.equal(p.text, prose)
})

// ── 6. 端到端：投影产物 → chunkText → searchChunks（search_paper 的真实链路）──

test('端到端：真实论文第 4 页投影后，x_{t-1} / \\mathbb{R} / Q_t / q(x_t|x_{t-1}) 都能命中第 4 页', () => {
  const proj = projectContentList(structuredClone(REAL_BLOCKS))
  // 改造前（未归一化）的同一段文本：这些查询全部 0 命中
  const before = REAL_BLOCKS.map((b) => b.text).join('\n\n')
  const chunks = chunkText(proj.text, 1500)
  const beforeChunks = chunkText(before, 1500)
  for (const q of ['x_{t-1}', '\\mathbb{R}', 'Q_t', 'q(x_t|x_{t-1})', '\\pmb{Q}_t', 'x_0^i']) {
    assert.equal(searchChunks(beforeChunks, null, q, 3).length, 0, `改造前 ${q} 应 0 命中`)
    const hits = searchChunks(chunks, proj.pages, q, 3)
    assert.ok(hits.length > 0, `改造后 ${q} 应有命中`)
    assert.equal(hits[0].page, 4, `${q} 应命中原页（第 4 页）`)
    assert.ok(hits[0].chunk.text.includes(q), `${q} 应对得上原文`)
  }
})

// ── 7. 单 token 下标/上标花括号归一化（验收第 2/3 条）────────────────────

/** 投影链路的真实两步顺序：先压空白，再归一化花括号。 */
const projectMath = (s) => normalizeMathBraces(compressMathSpaces(s))

test('归一化正例：单 token 参数去花括号（Q_{t}→Q_t、^{2}→^2、_{\\alpha}→_\\alpha）', () => {
  assert.equal(normalizeMathBraces('$Q_{t}$'), '$Q_t$')
  assert.equal(normalizeMathBraces('$x_{t}$'), '$x_t$')
  assert.equal(normalizeMathBraces('$x^{2}$'), '$x^2$')
  assert.equal(normalizeMathBraces('$v_{\\alpha}$'), '$v_\\alpha$')
  assert.equal(normalizeMathBraces('$v^{\\top}$'), '$v^\\top$')
  assert.equal(normalizeMathBraces('$x_{0}^{i}$'), '$x_0^i$')
  // MinerU 的逐 token 空格写法经两步后同样是可搜形态
  assert.equal(projectMath('$\\pmb { Q } _ { t } \\pmb { v } ( x _ { t } )$'), '$\\pmb{Q}_t\\pmb{v}(x_t)$')
  assert.equal(projectMath('$q ( x _ { t } | x _ { t - 1 } )$'), '$q(x_t|x_{t-1})$')
})

test('归一化反例（语义边界，比正例更重要）：多 token / 空参数必须保留花括号', () => {
  // x_ij ≠ x_{ij}：前者只把 i 当下标、j 落回正文字号
  assert.equal(normalizeMathBraces('$x_{ij}$'), '$x_{ij}$')
  assert.equal(normalizeMathBraces('$x_{t-1}$'), '$x_{t-1}$')
  assert.equal(normalizeMathBraces('$x^{K \\times K}$'), '$x^{K \\times K}$')
  assert.equal(normalizeMathBraces('$x_{10}$'), '$x_{10}$') // x_10 只把 1 当下标
  assert.equal(normalizeMathBraces('$x_{\\alpha\\beta}$'), '$x_{\\alpha\\beta}$')
  assert.equal(normalizeMathBraces('$x_{}$'), '$x_{}$')
  // 控制符号（非控制字）不去壳：`_{\{}` 会变成不合法的 `_\{}`
  assert.equal(normalizeMathBraces('$x_{\\%}$'), '$x_{\\%}$')
  // 单字符 `_` 去壳会得到双下标 `x__`，语义不同
  assert.equal(normalizeMathBraces('$x_{_}$'), '$x_{_}$')
  // 压空白后仍是多 token（`1 2` → `{12}`）→ 保留括号，不能变成 `_12`
  assert.equal(projectMath('$x _ { 1 2 }$'), '$x_{12}$')
})

test('归一化：控制字参数后面紧跟字母时保留花括号（去壳会黏成未定义命令）', () => {
  // `x_{\alpha}y` 去壳 → `x_\alphay`（`\alphay` 未定义），必须保留
  assert.equal(normalizeMathBraces('$x_{\\alpha}y$'), '$x_{\\alpha}y$')
  assert.equal(projectMath('$R ^ { \\alpha } K$'), '$R^{\\alpha}K$')
  // 后面不是字母（`\`、空白、行尾/$）则可以安全去壳
  assert.equal(projectMath('$x _ { \\alpha } \\beta$'), '$x_\\alpha\\beta$')
  assert.equal(projectMath('$x _ { \\alpha } y$'), '$x_{\\alpha}y$')
  assert.equal(normalizeMathBraces('$x_{\\alpha}$'), '$x_\\alpha$')
  // 单字符参数不受这条约束（`x_ty` 里 `_t` 仍是单 token，`y` 不会黏进来）
  assert.equal(normalizeMathBraces('$x_{t}y$'), '$x_ty$')
})

test('归一化：\\text{} 组内不动、正文不动、组内递归归一化', () => {
  assert.equal(normalizeMathBraces('$\\text{a_b c} + x_{t}$'), '$\\text{a_b c} + x_t$')
  assert.equal(normalizeMathBraces('$\\text{a_b}$'), '$\\text{a_b}$')
  assert.equal(projectMath('$\\text{hello world} + x _ { t }$'), '$\\text{hello world}+x_t$')
  assert.equal(normalizeMathBraces('a_b and ^ caret outside math'), 'a_b and ^ caret outside math')
  // 组内递归：`x_{y_{t}}` 的外壳（多 token）保留，内层单 token 归一化
  assert.equal(normalizeMathBraces('$x_{y_{t}}$'), '$x_{y_t}$')
  assert.equal(projectMath('$\\sum _ { i = 1 } ^ { n } x _ { i }$'), '$\\sum_{i=1}^nx_i$')
})

test('归一化：只动 _ / ^ 的参数外壳，花括号配平与其它字符都不变', () => {
  const s = '$\\mathbb{R}^{K \\times K}$ prose stays $Q_{t}$ and \\% here'
  const out = normalizeMathBraces(s)
  assert.equal(out, '$\\mathbb{R}^{K \\times K}$ prose stays $Q_t$ and \\% here')
  assert.equal((out.match(/\{/g) ?? []).length, (out.match(/\}/g) ?? []).length, '花括号必须配平')
  const noBrace = '$\\alpha \\beta$ text'
  assert.equal(normalizeMathBraces(noBrace), noBrace, '没有 _/^ 的区间一字不改')
})
