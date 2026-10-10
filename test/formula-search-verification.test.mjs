// t2 独立验证：t1（LaTeX 空格压缩 + 单 token 花括号归一化）的边界攻击与端到端可搜性。
//
// 只 import dist/*.js，跑前先 `npm run build`。
// fixture 全部来自验证者自己抓取的真实 MinerU 产出（.probe/t2/raw-*），其中 CANONICAL_BLOCKS
// 的 4 个块与 /file_parse(start=3,end=3) 的原始 content_list 逐字节一致（见 docs/formula-search-verification.md §2）。
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

/** 真实 MinerU 第 4 页原文（page_idx=3）。与验证者抓取的原始 content_list 逐字节一致。 */
const CANONICAL_BLOCKS = [
  {
    type: 'text',
    text:
      '<sub>e</sub>rThe transition matrix $Q _ { t }$ is crucial to the discrete diffuo<sup>r</sup> c<sup>k</sup><sub>p</sub>ti n<sup>o</sup>sion model and should be carefully designed such that it is a<sup>n B</sup>A<sup>d</sup> a<sup>y</sup>not too difficult for the reverse network to recover the signal from noises.',
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
      'To be more specific, consider a single image token $x _ { 0 } ^ { i }$ of $\\scriptstyle { \\mathbf { { \\mathit { x } } } } _ { 0 }$ at location $i ,$ which takes the index that specifies the entries in the codebook, $i . e . , x _ { 0 } ^ { i } \\in \\{ 1 , 2 , . . . , K \\}$ . Without introducing confusion, we omit superscripts i in the following description. We define the probabilities that $x _ { t - 1 }$ transits to $x _ { t }$ using the matrices $[ Q _ { t } ] _ { m n } = q ( x _ { t } = m | x _ { t - 1 } = n ) \\in$ $\\mathbb { R } ^ { K \\times K }$ . Then theforward Markov diffusion process for the whole token sequence can be written as,',
    page_idx: 3,
  },
  {
    type: 'equation',
    text:
      '$$\n\\begin{array} { r } { \\mathbf {  { Q } } _ { t } = \\left[ \\begin{array} { c c c c } { \\alpha _ { t } + \\beta _ { t } } & { \\beta _ { t } } & { \\cdots \\bullet } & { \\beta _ { t } } \\\\ { \\beta _ { t } } & { \\alpha _ { t } + \\beta _ { t } } & { \\cdots \\bullet } & { \\beta _ { t } } \\end{array} \\right] } \\end{array}\\tag{6}\n$$',
    page_idx: 3,
  },
]

// ── 1. 验收查询的 before/after 对照（改造前基线用「未压缩的真实原文」构造）──────

test('可搜性：x_{t-1} / \\mathbb{R} / Q_t 在改造前 0 命中，改造后命中第 4 页', () => {
  const proj = projectContentList(structuredClone(CANONICAL_BLOCKS))
  // 改造前 = 未经压缩的原文（.probe/t2 抓取的原始 content_list 文本）
  const before = CANONICAL_BLOCKS.map((b) => b.text).join('\n\n')
  const beforeChunks = chunkText(before, 1500)
  const after = chunkText(proj.text, 1500)
  for (const q of ['x_{t-1}', '\\mathbb{R}', 'Q_t', 'q(x_t|x_{t-1})', '\\pmb{Q}_t', 'x_0^i']) {
    assert.equal(searchChunks(beforeChunks, null, q, 5).length, 0, `改造前 ${q} 应 0 命中`)
    const hits = searchChunks(after, proj.pages, q, 5)
    assert.ok(hits.length > 0, `改造后 ${q} 应命中`)
    assert.equal(hits[0].page, 4, `${q} 应命中第 4 页`)
  }
})

test('可搜性：带花括号的查询 Q_{t} 在改造后 0 命中（形态改为 Q_t，属已记录的取舍）', () => {
  const proj = projectContentList(structuredClone(CANONICAL_BLOCKS))
  const after = chunkText(proj.text, 1500)
  // 归一化把 `Q_{t}` 写成 `Q_t`，所以同一条查询再也搜不到（MinerU 一律产出 `Q_{t}`）
  assert.equal(searchChunks(after, proj.pages, 'Q_{t}', 5).length, 0)
  assert.ok(searchChunks(after, proj.pages, 'Q_t', 5).length > 0)
})

// ── 2. \text{} 保护（验收第 3 条）────────────────────────────────────────

test('\\text{} 保护：\\text{hello world} / \\text{a b c} / \\textrm{...} 内部空格原样保留', () => {
  const cases = [
    ['$\\text{hello world}$', '$\\text{hello world}$'],
    ['$\\text{a b c}$', '$\\text{a b c}$'],
    ['$\\textrm{hello world}$', '$\\textrm{hello world}$'],
    ['$\\textnormal{x y z}$', '$\\textnormal{x y z}$'],
    ['$\\mbox{keep this}$', '$\\mbox{keep this}$'],
    ['$A_{\\text{max is it}} B$', '$A_{\\text{max is it}}B$'],
    ['$$\\text{display mode text}$ $x _ { t }$', '$$\\text{display mode text}$ $x_t$'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(normalizeMathBraces(compressMathSpaces(input)), expected, input)
  }
})

test('\\text{} 保护：组内的 _ / ^ 不归一化（那是正文）', () => {
  assert.equal(normalizeMathBraces('$\\text{a_b c} x_{t}$'), '$\\text{a_b c} x_t$')
  assert.equal(normalizeMathBraces('$\\text{a^{b}}$'), '$\\text{a^{b}}$')
})

test('\\text{} 保护：花括号不配对时停止压缩、不吞内容', () => {
  const s = '$\\text{hello world and $x _ { t }$'
  const out = compressMathSpaces(s)
  assert.ok(out.includes('hello world and'), out)
})

test('\\text{} 保护：经 projectContentList 全链路（投影）仍然保留内部空格', () => {
  const p = projectContentList([
    { type: 'equation', text: '$$\n\\text{hello world} + x _ { t }\n$$', page_idx: 0 },
    { type: 'text', text: 'Prose keeps $\\textrm{a b c}$ groups intact while $y _ { t }$ is normalized.', page_idx: 0 },
  ])
  assert.ok(p.text.includes('\\text{hello world}+x_t'), p.text)
  assert.ok(p.text.includes('\\textrm{a b c}'), p.text)
  assert.ok(p.text.includes('$y_t$'), p.text)
})

test('\\mathrm / \\mathbf / \\pmb 内容不被损坏（命令本身仍在）', () => {
  const cases = [
    ['$\\mathrm { a r g m i n }$', '$\\mathrm{argmin}$'],
    ['$\\mathbf { s g }$', '$\\mathbf{sg}$'],
    ['$\\pmb { Q } _ { t }$', '$\\pmb{Q}_t$'],
    ['$\\boldsymbol { \\theta }$', '$\\boldsymbol{\\theta}$'],
    ['$\\overline { { \\alpha } } _ { t }$', '$\\overline{{\\alpha}}_t$'],
  ]
  for (const [input, expected] of cases) {
    const out = normalizeMathBraces(compressMathSpaces(input))
    assert.equal(out, expected, input)
    // 命令名本身绝不能被黏成 `\mathrmargmin`
    assert.ok(!/\\[A-Za-z]+[a-z]{3,}[A-Za-z]/.test(out.replace(/\\[A-Za-z]+/g, '|')), out)
  }
})

// ── 3. 孤立 $ 误伤（最高风险）─────────────────────────────────────────────

test('孤立 $：价格文本 `costs $5 and $10` 不被当数学区间', () => {
  const s = 'The GPU costs $5 and the board costs $10 per unit. That is all.'
  assert.equal(compressMathSpaces(s), s)
  assert.equal(normalizeMathBraces(compressMathSpaces(s)), s)
  // 即使出现在同一段、且被 $ 包住的正文也不该丢空格
  const s2 = 'It costs $5 now and $10 later. The quick brown fox jumps over the lazy dog.'
  assert.equal(compressMathSpaces(s2), s2)
})

test('孤立 $：正则以 $ 结尾 / 变量名 $HOME / shell $PATH 不被当数学区间', () => {
  for (const s of [
    'Use the pattern ^[a-z]$ to anchor a line end.',
    'The regex /^foo$/ matches.',
    'Set $HOME then run $PATH lookups.',
    'Prices: $1, $2 or $3 each.',
  ]) {
    assert.equal(compressMathSpaces(s), s, s)
  }
})

test('孤立 $：未闭合区间（只有开头 $）整段原样', () => {
  const s = 'This paragraph has a stray $x _ { t } and no closing delimiter at all.'
  assert.equal(compressMathSpaces(s), s)
})

test('孤立 $：$$ 出现在非公式上下文（空行隔开）时被整段当独立区间压缩', () => {
  const s = 'line one ends\n\n$$\nnot math\n$$\n\nplain prose after'
  // 实测：`$$` 成对被判为独立区间，区间内空白被压掉（此处 `not math` → `notmath`）。
  // 判定规则与 pandoc tex_math_dollars 同源：只看定界符形状，不校验内容是不是数学。
  assert.equal(compressMathSpaces(s), 'line one ends\n\n$$notmath$$\n\nplain prose after')
})

test('孤立 $：转义 \\$ 既不是定界符也不开启区间', () => {
  const s = 'Escaped \\$ signs stay \\$ and $x _ { t }$ inside math is compressed.'
  // 第一步只压空白：\$ 保持转义、区间内 `x _ { t }` → `x_{t}`（花括号由第二步处理）
  assert.equal(compressMathSpaces(s), 'Escaped \\$ signs stay \\$ and $x_{t}$ inside math is compressed.')
  assert.equal(normalizeMathBraces(compressMathSpaces(s)), 'Escaped \\$ signs stay \\$ and $x_t$ inside math is compressed.')
  const onlyEscaped = 'No math here: \\$5 and \\$10 costs.'
  assert.equal(compressMathSpaces(onlyEscaped), onlyEscaped)
})

test('孤立 $：跨空行的「区间」被判为误配对，整段放弃', () => {
  const s = '$start\n\nstill going$ plain tail'
  assert.equal(compressMathSpaces(s), s)
})

test('连续多个公式相邻：`\\in$ $\\mathbb{R}$` 形状能正确切开', () => {
  const s = 'x \\in$ $\\mathbb { R } ^ { K \\times K }$ tail'
  assert.equal(compressMathSpaces(s), 'x \\in$ $\\mathbb{R}^{K\\times K}$ tail')
})

test('孤立 $：一段正文里同时出现 $变量 与 $正文 时，行内界定会跨过正文（已知取舍，实测取证）', () => {
  // 开定界符 `$x _ { t }` 之后的第一个 `$` 前面是 `b `（空白），所以闭定界符判定为 `$1`……
  // 实际配到的是 `$x _ { t }$ b $`，中间的 ` b ` 被当作区间内容压掉。
  const s = 'a $x _ { t }$ b $1 and $2 c $y _ { t }$ d'
  assert.equal(compressMathSpaces(s), 'a $x_{t}$ b $1 and $2 c $y_{t}$ d')
  // $ 数量不变，但 ` b ` 落在区间内（已被压成一个空格）
  assert.equal((compressMathSpaces(s).match(/\$/g) ?? []).length, (s.match(/\$/g) ?? []).length)
})

// ── 4. 非数学文本零变化 ─────────────────────────────────────────────────

test('非数学文本：无 $ 的论文正文逐字节不变（含多段、表格、列表）', () => {
  const blocks = [
    { type: 'text', text: 'Plain paragraph one with no math and  double  spaces.', page_idx: 0 },
    { type: 'text', text: 'Paragraph two\twith\ttabs and a trailing backslash \\ here.', page_idx: 0 },
    { type: 'table', table_caption: ['表 1 数据'], table_body: '<table><tr><td>a</td><td>b</td></tr></table>', page_idx: 0 },
    { type: 'list', list_items: ['item one', 'item two'], page_idx: 0 },
  ]
  const p = projectContentList(structuredClone(blocks))
  const expected = [
    'Plain paragraph one with no math and  double  spaces.',
    'Paragraph two\twith\ttabs and a trailing backslash \\ here.',
    '表 1 数据\na b',
    'item one\nitem two',
  ].join('\n\n')
  assert.equal(p.text, expected)
})

test('非数学文本：裸 LaTeX（不在 $ 区间内）不动', () => {
  const p = projectContentList([
    { type: 'text', text: 'The formula E = mc^2 and Q_{t} without dollars stay put.', page_idx: 0 },
  ])
  assert.equal(p.text, 'The formula E = mc^2 and Q_{t} without dollars stay put.')
})

test('非数学文本：块对象本身不被改写（写进 .mineru.json 的必须是原文）', () => {
  const blocks = structuredClone(CANONICAL_BLOCKS)
  const snapshot = structuredClone(CANONICAL_BLOCKS)
  projectContentList(blocks)
  assert.deepEqual(blocks, snapshot)
})

// ── 5. 端到端：投影 → chunkText → searchChunks（search_paper 内部链路）──────

test('端到端：投影产物经 chunkText+searchChunks 后公式查询命中原文片段', () => {
  const proj = projectContentList(structuredClone(CANONICAL_BLOCKS))
  const chunks = chunkText(proj.text, 1500)
  for (const q of ['x_{t-1}', 'Q_t', '\\mathbb{R}']) {
    const hits = searchChunks(chunks, proj.pages, q, 5)
    assert.ok(hits.length > 0, q)
    assert.ok(hits.every((h) => h.page === 4), `${q} 应全部落在第 4 页`)
  }
})

// ── 6. 花括号归一化的语义边界 ────────────────────────────────────────────

test('归一化边界：单 token 去壳 / 多 token 与空参数保留 / 语义守卫', () => {
  const projectMath = (s) => normalizeMathBraces(compressMathSpaces(s))
  assert.equal(projectMath('$Q_{t}$'), '$Q_t$')
  assert.equal(projectMath('$x^{2}$'), '$x^2$')
  assert.equal(projectMath('$\\mathbb{R}^{K \\times K}$'), '$\\mathbb{R}^{K\\times K}$')
  assert.equal(projectMath('$x_{t-1}$'), '$x_{t-1}$')
  assert.equal(projectMath('$x_{ij}$'), '$x_{ij}$')
  assert.equal(projectMath('$x_{}$'), '$x_{}$')
  assert.equal(projectMath('$x_{\\alpha}y$'), '$x_{\\alpha}y$') // \alphay 会变未定义命令
  assert.equal(projectMath('$x_{\\alpha}\\beta$'), '$x_\\alpha\\beta$')
})

test('控制字黏连守卫（验证者补充变体）：\\alpha 后跟字母/数字/命令/括号/正文的各种形状', () => {
  const projectMath = (s) => normalizeMathBraces(compressMathSpaces(s))
  // 必须保留花括号：去壳会与紧跟的字母黏成未定义命令
  assert.equal(projectMath('$x _ { \\alpha } y$'), '$x_{\\alpha}y$')
  assert.equal(projectMath('$x_{\\alpha}y$'), '$x_{\\alpha}y$')
  assert.equal(projectMath('$x _ { \\top } y$'), '$x_{\\top}y$')
  assert.equal(projectMath('$x _ { \\alpha } y _ { t }$'), '$x_{\\alpha}y_t$')
  assert.equal(projectMath('$a _ { \\alpha } y$'), '$a_{\\alpha}y$')
  // 可以安全去壳：后面是数字 / 命令 / 括号 / 控制符号 / 区间结尾
  assert.equal(projectMath('$x _ { \\alpha } 0$'), '$x_\\alpha0$')
  assert.equal(projectMath('$x _ { \\alpha } \\beta$'), '$x_\\alpha\\beta$')
  assert.equal(projectMath('$x _ { \\alpha } ( t )$'), '$x_\\alpha(t)$')
  assert.equal(projectMath('$x_{\\alpha}\\,y$'), '$x_\\alpha\\,y$')
  assert.equal(projectMath('$f _ { \\theta } ( x )$'), '$f_\\theta(x)$')
  // 组内空白不影响判定（MinerU 逐 token 写法）
  assert.equal(projectMath('$R ^ { \\alpha } K$'), '$R^{\\alpha}K$')
})

test('语义边界反例（验证者补充）：多 token / 空组 / 控制符号 / 双下标一律保留花括号', () => {
  const projectMath = (s) => normalizeMathBraces(compressMathSpaces(s))
  for (const s of ['$x_{ij}$', '$x_{10}$', '$x_{t-1}$', '$x^{K \\times K}$', '$x_{}$', '$x_{\\%}$', '$x_{_}$', '$x_{y_{t}}$']) {
    const out = projectMath(s)
    assert.ok(out.includes('{'), `${s} → ${out} 必须至少保留外层花括号`)
    assert.equal((out.match(/\{/g) ?? []).length, (out.match(/\}/g) ?? []).length, `${s} 花括号必须配平`)
  }
  // 只有内层单 token 归一时，外层必须留住
  assert.equal(projectMath('$x_{y_{t}}$'), '$x_{y_t}$')
})
