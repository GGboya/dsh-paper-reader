// test/selection-translate.test.mjs — 划词翻译（公式保留）+ 中英文分屏对照 的零依赖用例。
//
// 契约：docs/selection-translate-requirements.md（冻结 v1）§3.3–§3.9（服务端）与 §4（分屏）。
// 只 import dist/*.js（跑前先 `npm run build`）+ vm 里跑**真实** reader 脚本。
//
// 覆盖（验收清单 A*/B* 里标「自动」的条目）：
//   · 两条公式还原路径：**display 的 bbox 中心点相交**（客户端 formulaBoxByCenter/buildChunks）
//     与**行内的文本对齐**（服务端 alignSelectionToBlock/assembleSource）
//   · 多公式、部分重叠、对齐失败、无产物降级、跨页
//   · 提示词逐字节契约、请求体字段集合、公式保全校验、缓存、失败分档
//   · UI 结构性断言：译文气泡存在且零按钮、.eqLayer 仍 pointer-events:none、
//     data-doc 作用域（中文列无热区/不污染 EQ_BY_PAGE）、模式切换的存储键
//
// 全部零网络（上游用本机 mock HTTP），不触碰真实文献库（真实样本只**只读**读取）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeEol, extractModuleScript } from './reader-script.mjs'
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

const {
  buildFormulaIndex, buildTextBlockIndex, compactLatex, resetFormulaCache,
} = await import(pathToFileURL(dist('formulas.js')).href)
const {
  CACHE_LIMIT, MIN_NORM, SELECTION_SYSTEM_PROMPT,
  SelectionTranslateError, TranslateSelectionCache,
  alignSelectionToBlock, assembleSource, buildRequestBody, clampMaxTokens, formulaStatusOf,
  formulaTokens, isLatexLikeFragment, normForAlign, selectionCache, selectionCacheKey,
  stripFence, stripJunk, stripPrefix, translateSelection, verifyFormulas,
} = await import(pathToFileURL(dist('translate-selection.js')).href)
const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

// 行尾归一化后再取脚本：Windows 检出是 CRLF，按 LF 写死的正则会 `null[1]` 崩掉整个文件
// （main 的守卫 C4/C5 口径，见 test/reader-script.mjs）
const READER_HTML = normalizeEol(readFileSync(join(REPO, 'reader', 'index.html'), 'utf8'))
const SCRIPT_SRC = extractModuleScript(READER_HTML, { where: 'reader/index.html' })

/* ══════════════════════════════════════════════════════════════════════════
   零依赖夹具：一份合成的 .mineru.json（3 个含行内公式的 text 块 + 1 个 equation）
   ══════════════════════════════════════════════════════════════════════════ */

const BLOCK_A = 'We define the probabilities that $x _ { t - 1 }$ transits to $x _ { t }$ using the matrices $[ Q _ { t } ] _ { m n } = q ( x _ { t } = m | x _ { t - 1 } = n ) \\in \\mathbb { R } ^ { K \\times K }$ . Then the forward Markov diffusion process can be written as,'
const BLOCK_B = 'The policy $\\pi _ { \\theta } ( a | s )$ maximises the objective $J ( \\theta )$ over the dataset.'
const BLOCK_C = 'On the next page, the value function $v _ { \\psi } ( s _ { t } , I )$ is learned by regression.'
/** display 公式：客户端的乱码字符**已经不在**请求体里，服务端只负责包 `$` */
const EQ_LATEX_RAW = '$$\nq ( x _ { t } | x _ { t - 1 } ) = v ^ { \\top } ( x _ { t } ) Q _ { t } v ( x _ { t - 1 } )\n$$'
const EQ_LATEX = compactLatex(EQ_LATEX_RAW)          // 与 buildFormulaIndex 的投影同款
const EQ_CITE = EQ_LATEX.replace(/^\s*\$\$?/, '').replace(/\$\$?\s*$/, '').trim()

/** 文本层里的退化形态（实测形态：下标拉平、π/θ 变字形、大括号变控制字符）。 */
const DEG_A = 'We define the probabilities that xt\u22121 transits to xt using the matrices [Qt]mn = q(xt = m|xt\u22121 = n) \u2208 RK\u00d7K. Then the forward Markov diffusion process can be written as,'
const DEG_B = 'The policy \u03c0\u03b8(a|s) maximises the objective J(\u03b8) over the dataset.'
const DEG_C = 'On the next page, the value function v\u03c8(st, I) is learned by regression.'
/** 含真实控制字符/私用区的乱码公式块（A2 的夹具）：doc 里实测出现 \u0000/\u0010/\u0011 与私用区 */
const JUNK_LINE = 'si=Enc\u03b8(oi)\u02c6st+1\u0000\u0010\u0011 \ufffd \ue000\ue001 where t denotes timestep'

const FIXTURE_CONTENT_LIST = [
  { type: 'text', page_idx: 0, bbox: [100, 200, 500, 260], text: BLOCK_A },
  { type: 'text', page_idx: 0, bbox: [100, 300, 500, 360], text: BLOCK_B },
  { type: 'equation', page_idx: 0, bbox: [150, 500, 400, 540], text: EQ_LATEX_RAW },
  { type: 'text', page_idx: 1, bbox: [100, 200, 500, 260], text: BLOCK_C },
  // 无 page_idx 的块：沿用上一个有页码的块（与既有投影口径一致）
  { type: 'text', bbox: [100, 400, 500, 460], text: 'The reward $r _ { t }$ is bounded.' },
]
const FIXTURE_JSON = JSON.stringify({ producer: 'mineru', backend: 'pipeline', pageCount: 2, contentList: FIXTURE_CONTENT_LIST })

const IDX = buildTextBlockIndex(FIXTURE_JSON)
const NO_ARTIFACT = buildTextBlockIndex(null)

/** 页面局部矩形（px）：中心点落在 equation 盒里 ⇔ 属于该公式。 */
const eqItem = (id, x0, y0, x1, y1) => ({
  eq: { id, page: 1, index: 0, latex: EQ_LATEX },
  x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, pad: 6,
})
const rect = (x0, y0, x1, y1) => [x0, y0, x1, y1]

/* ══════════════════════════════════════════════════════════════════════════
   A. 服务端：行内公式还原（文本对齐路径）
   ══════════════════════════════════════════════════════════════════════════ */

test('A3 行内还原：退化文本 ↔ 块文本对齐，产出带紧凑 LaTeX 的片段', () => {
  const rA = alignSelectionToBlock(DEG_A, IDX.blocks[0].text)
  assert.equal(rA.applied, 1, '同一行的退化文本必须能对齐回块文本')
  assert.ok(rA.text.includes('$x_{t-1}$'), `必须还原第一个公式：${rA.text}`)
  assert.ok(rA.text.includes('$x_t$'), '必须还原第二个公式')
  assert.ok(rA.text.includes('$[Q_t]_{mn}=q(x_t=m|x_{t-1}=n)\\in\\mathbb{R}^{K\\times K}$'), '必须还原第三个（含 \\in/\\mathbb）')
  assert.ok(rA.text.startsWith('We define the probabilities that '), '片段外正文必须保留')
  assert.ok(rA.score >= 0.75, `接受阈值：score=${rA.score}`)
  // 块文本**先过 compactLatex**（不是裸片段压缩）：块索引里已是紧凑形态
  const raw = alignSelectionToBlock(DEG_B, IDX.blocks[1].text)
  assert.ok(raw.text.includes('$\\pi_\\theta(a|s)$') && raw.text.includes('$J(\\theta)$'), `多公式：${raw.text}`)
})

test('A3-反面 对齐失败：与块文本无关的选区原样返回（applied=0，绝不猜）', () => {
  const r = alignSelectionToBlock('this sentence appears nowhere in the parsed block at all', IDX.blocks[0].text)
  assert.equal(r.applied, 0)
  assert.equal(r.text, 'this sentence appears nowhere in the parsed block at all', '失败必须原样返回，不得截断正文')
  // 极短选区：|nf| < 4 ⇒ skipped（A13 的判定依据）
  const s = alignSelectionToBlock('F', IDX.blocks[1].text)
  assert.equal(s.applied, 0)
  assert.equal(s.skipped, true)
  assert.equal(normForAlign('F').A.length, 1)
  assert.ok(MIN_NORM === 4)
})

test('A3-反面 落单 $ / 长度越界：宁可原样返回也不给半个公式', () => {
  // 长度保险：故意做一个「只匹配到很短的一小段」的选区（ratio 出界）
  const long = 'On the next page, the value function v\u03c8(st, I) is learned by regression and then a lot of unrelated trailing words are appended here to break the length guard completely'
  const r = alignSelectionToBlock(long, IDX.blocks[2].text)
  if (r.applied === 1) {
    assert.ok(!/[^$]\$[^$]*$/.test(r.text), `不得出现落单的 $：${r.text}`)
    assert.equal((r.text.match(/\$/g) || []).length % 2, 0, `$ 必须成对：${r.text}`)
  } else {
    assert.ok(r.score === null || r.score < 1, '拒绝时不得伪造 score')
  }
})

test('A4 四类选区：纯正文 / 纯行内 / 行内+display 混合 / 跨页（含跨块）', () => {
  // ① 纯正文：能对齐的散文逐字节原样，且**不得引入任何 $**
  const prose = assembleSource([{ page: 1, kind: 'text', text: 'Then the forward Markov diffusion process can be written as\n' }], IDX)
  assert.equal(prose.source, 'Then the forward Markov diffusion process can be written as', `纯正文必须原样：${JSON.stringify(prose.source)}`)
  assert.ok(!/\$/.test(prose.source))
  // ①' 与候选块无关的散文：对齐失败，同样不得引入 $
  const offBlock = assembleSource([{ page: 1, kind: 'text', text: 'This paragraph is not part of any parsed block at all\n' }], IDX)
  assert.equal(offBlock.applied, 0)
  assert.ok(!/\$/.test(offBlock.source), `对齐失败不得引入 $：${offBlock.source}`)

  // ② 纯行内公式：整行都靠行内还原，还原后带 $
  const inline = assembleSource([{ page: 2, kind: 'text', text: DEG_C }], IDX)
  assert.ok(inline.source.includes('$v_\\psi(s_t,I)$'), `纯行内：${inline.source}`)
  assert.equal(inline.applied, 1)

  // ③ 行内 + display 混合：同一个文本流里两处都是 $…$，display 段来自 equation 的 latex
  const mixed = assembleSource([
    { page: 1, kind: 'text', text: DEG_B + '\n' },
    { page: 1, kind: 'formula', latex: EQ_CITE },
  ], IDX)
  assert.ok(mixed.source.includes('$\\pi_\\theta(a|s)$'), `行内段来自对齐：${mixed.source}`)
  assert.ok(mixed.source.includes('$' + EQ_CITE + '$'), `display 段来自 equation 的 latex：${mixed.source}`)
  assert.equal(formulaTokens(mixed.source).length, 3, '两个行内 + 一个 display')

  // ④ 跨块（同页两个 text 块各自命中自己的块）+ 跨页（页间插 \n，行尾换行保留）
  const cross = assembleSource([
    { page: 1, kind: 'text', text: DEG_A + '\n' },
    { page: 1, kind: 'text', text: DEG_B + '\n' },
    { page: 2, kind: 'text', text: DEG_C },
  ], IDX)
  assert.equal(cross.applied, 3, '跨块/跨页各自命中自己的块')
  assert.ok(cross.source.includes('$\\pi_\\theta(a|s)$') && cross.source.includes('$x_{t-1}$'), `两块各自还原：${cross.source}`)
  assert.ok(cross.source.includes('$x_t$ using the matrices'), '行尾换行不得吃掉下一段')
  assert.ok(cross.source.includes('over the dataset\nOn the next page'), `页间必须有 \n：${JSON.stringify(cross.source)}`)
  assert.equal(formulaStatusOf(cross), 'applied')
  // 行结构：三行（三段各一行）——system 第 3 条要求保持行结构
  assert.equal(cross.source.split('\n').length, 3)
})

test('A2 组装文本不含乱码字符类（C0/C1、私用区、U+FFFD、走音符号）', () => {
  const junkRe = /[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd\u005e\u0060\u00b4\u02c6\u02dc\u0300-\u036f]/
  const out = assembleSource([
    { page: 1, kind: 'text', text: JUNK_LINE },
    { page: 1, kind: 'formula', latex: 'F_\\theta' },
  ], IDX)
  assert.ok(!junkRe.test(out.source), `组装文本里不得出现乱码字符类：${JSON.stringify(out.source)}`)
  assert.ok(!junkRe.test(out.source.replace(/\n/g, '')), '换行以外不得有一处乱码')
  // stripJunk 直测：逐类字符都能清掉，且空白折叠成一个空格
  assert.equal(stripJunk('a\u0000b\u0010c\u0011d\u007fe\u009ff\ue000g\ufffdh\u02c6i\u005ej\u0060k\u0301l'), 'abcdefghijkl')
  assert.equal(stripJunk('a   b\t\tc'), 'a b c')
  // 换行是结构（A14/system 第 3 条）：不得被折叠掉
  assert.equal(stripJunk('a  \n\n  b'), 'a\nb')
  assert.equal(stripJunk('  hi  '), 'hi')
})

test('A5 纯 display 选区：公式段整体来自 equation 的 latex，formulaTotal 由组装文本决定', () => {
  const out = assembleSource([{ page: 1, kind: 'formula', latex: EQ_CITE }], IDX)
  assert.equal(out.source, '$' + EQ_CITE + '$')
  assert.equal(out.textChunkCount, 0)
  assert.equal(formulaStatusOf(out), 'applied', 'textChunkCount===0 的纯 display 选区算 applied')
  // 组装阶段的 formulaTotal 不是缓存字段：由 verifyFormulas 从源文本现算
  const v = verifyFormulas(out.source, '中文译文 $' + EQ_CITE + '$')
  assert.deepEqual([v.total, v.kept, v.lost], [1, 1, 0])
})

test('A8/R16 无 MinerU 产物降级：文本原样下发 + hasBlockIndex=false + no-artifact', () => {
  const out = assembleSource([
    { page: 1, kind: 'text', text: DEG_A },
    { page: 1, kind: 'formula', latex: 'F_\\theta' },
  ], NO_ARTIFACT)
  assert.equal(out.hasBlockIndex, false)
  assert.equal(out.applied, 0)
  assert.ok(out.source.includes('DEG_A'.length ? 'xt\u22121' : ''), '无产物时退化文本原样下发（乱码可由 stripJunk 清掉，但不得编造公式）')
  assert.ok(!out.source.includes('$x_{t-1}$'), '不得编造公式')
  assert.equal(formulaStatusOf(out), 'no-artifact')
  // 损坏产物（contentList 不是数组）同样降级
  const bad = buildTextBlockIndex('{"contentList":"nope"}')
  assert.deepEqual([bad.source, bad.reason], ['none', 'bad-artifact'])
  assert.equal(formulaStatusOf(assembleSource([{ page: 1, kind: 'text', text: 'abc def ghi' }], bad)), 'no-artifact')
})

test('A13 极短选区：不对齐并回报 formulaSkipped（客户端据此出「选区太短」）', () => {
  const out = assembleSource([{ page: 1, kind: 'text', text: 'F' }], IDX)
  assert.equal(out.applied, 0)
  assert.equal(out.skipped, 1)
  assert.equal(formulaStatusOf(out), 'unavailable')
  const partial = assembleSource([
    { page: 1, kind: 'text', text: 'F' },
    { page: 1, kind: 'text', text: DEG_B },
  ], IDX)
  assert.equal(partial.applied, 1)
  assert.equal(partial.skipped, 1)
  assert.equal(formulaStatusOf(partial), 'partial')
})

test('A15 规模闸门：请求体校验上限与 clampMaxTokens 公式', () => {
  assert.equal(clampMaxTokens(10), 256)          // 下限
  assert.equal(clampMaxTokens(100), 256)         // ceil(150)=150 → 下限 256
  assert.equal(clampMaxTokens(1000), 1500)
  assert.equal(clampMaxTokens(100000), 4096)     // 上限
})

/* ══════════════════════════════════════════════════════════════════════════
   B. 服务端：提示词契约 / 请求体 / 公式保全 / 失败分档 / 缓存 / key 不泄漏
   ══════════════════════════════════════════════════════════════════════════ */

test('A6 提示词逐字节冻结 + 请求体字段集合 + thinking 判据', () => {
  const EXPECTED = [
    'You are a professional, authentic machine translation engine for academic papers.',
    'Translate the user\'s input into Simplified Chinese.',
    '',
    'Hard rules:',
    '1. Any content wrapped in $...$ is a LaTeX formula. Keep every formula EXACTLY as',
    '   given: do not translate it, do not rewrite or simplify it, do not change spaces,',
    '   braces, or backslashes, do not drop it, do not add any.',
    '2. Output the translation ONLY. No preamble, no explanation, no notes, no headings,',
    '   no Markdown code fences, no quotes around the whole output.',
    '3. Preserve the paragraph and line structure of the input. Never add content that is',
    '   not in the input.',
    '4. Translate terminology by field convention (policy -> 策略, world model -> 世界模型).',
    '   Keep model names, dataset names, method names and abbreviations (LCVN-WM, DiT, CLIP)',
    '   in the original form.',
    '5. If the input is already Chinese, return it as is.',
  ].join('\n')
  assert.equal(SELECTION_SYSTEM_PROMPT, EXPECTED, 'system 必须与 §3.6 逐字节相同')

  const src = 'translate $x_t$ here'
  const body = buildRequestBody('deepseek-chat', src, 'https://api.deepseek.com/v1')
  assert.deepEqual(Object.keys(body), ['model', 'messages', 'max_tokens', 'temperature', 'thinking'])
  assert.deepEqual(Object.keys(buildRequestBody('m', src, 'https://api.openai.com/v1')), ['model', 'messages', 'max_tokens', 'temperature'])
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.model, 'deepseek-chat')
  assert.equal(body.temperature, 0)
  assert.equal(body.max_tokens, clampMaxTokens(src.length))
  assert.deepEqual(body.messages, [
    { role: 'system', content: SELECTION_SYSTEM_PROMPT },
    { role: 'user', content: src },
  ])
  // 绝不发这些字段
  for (const k of ['response_format', 'reasoning', 'tools', 'top_p', 'stream']) {
    assert.ok(!(k in body), `请求体不得包含 ${k}`)
  }
})

test('A7 公式保全校验：丢一个 $…$ → formulaLost=1 且能指认是哪一段', () => {
  const src = 'a $x_t$ b $y_t$ c'
  const v = verifyFormulas(src, '甲 $x_t$ 乙 丙')     // 模型漏了 $y_t$
  assert.deepEqual([v.total, v.kept, v.lost], [2, 1, 1])
  assert.deepEqual(v.missing, ['$y_t$'])
  assert.deepEqual([...formulaTokens(src)], ['$x_t$', '$y_t$'])
  // 完整保留时 lost=0
  assert.equal(verifyFormulas(src, '甲 $x_t$ 乙 $y_t$ 丙').lost, 0)
})

test('A7-续 响应清洗：代码围栏与「译文：」前缀必须剥掉，不混进气泡正文', () => {
  assert.equal(stripFence('```\n你好 $x_t$\n```'), '你好 $x_t$')
  assert.equal(stripFence('```markdown\n你好\n```'), '你好')
  assert.equal(stripFence('你好'), '你好', '无围栏时原样')
  assert.equal(stripPrefix('译文：你好'), '你好')
  assert.equal(stripPrefix('翻译: 你好'), '你好')
  assert.equal(stripPrefix('Translation: hi'), 'hi')
  assert.equal(stripPrefix('你好：世界'), '你好：世界', '只剥行首的固定前缀')
})

test('A10 失败分档：401/403、429、5xx、超时、网络失败 → 错误码与上游状态码齐备', async () => {
  const ep = { baseUrl: 'https://example.invalid/v1', apiKey: 'sk-fake-key-0123456789', model: 'm' }
  const mk = (status, text) => async () => ({ status, ok: false, text: async () => text })
  const cases = [
    [mk(401, '{"error":"bad key"}'), 'upstream', 502, 401],
    [mk(403, 'forbidden'), 'upstream', 502, 403],
    [mk(429, 'rate limited'), 'upstream', 502, 429],
    [mk(500, 'boom'), 'upstream', 502, 500],
  ]
  for (const [fetchImpl, code, status, up] of cases) {
    const err = await translateSelection(ep, 'x', { fetchImpl, cache: new TranslateSelectionCache() }).catch((e) => e)
    assert.ok(err instanceof SelectionTranslateError, '必须抛 SelectionTranslateError')
    assert.equal(err.code, code)
    assert.equal(err.status, status)
    assert.equal(err.upstreamStatus, up)
    assert.ok(!err.message.includes('sk-fake-key-0123456789'), '错误文案不得含 key')
  }
  // 超时（AbortSignal 语义由注入的 fetch 模拟）
  const timeoutErr = await translateSelection(ep, 'x', {
    cache: new TranslateSelectionCache(),
    timeoutMs: 20,
    fetchImpl: () => new Promise((_, rej) => { const e = new Error('aborted'); e.name = 'TimeoutError'; rej(e) }),
  }).catch((e) => e)
  assert.equal(timeoutErr.code, 'timeout')
  assert.equal(timeoutErr.status, 504)
  // 网络失败
  const netErr = await translateSelection(ep, 'x', {
    cache: new TranslateSelectionCache(),
    fetchImpl: () => { const e = new Error('fetch failed'); e.cause = new Error('ECONNREFUSED'); throw e },
  }).catch((e) => e)
  assert.equal(netErr.code, 'network')
  assert.equal(netErr.status, 502)
  assert.match(netErr.message, /ECONNREFUSED/, '必须把 cause 带进文案（否则用户看不出原因）')
  // 端点不齐
  const noEp = await translateSelection({ baseUrl: '', apiKey: '', model: '' }, 'x', {}).catch((e) => e)
  assert.equal(noEp.code, 'no-endpoint')
  assert.equal(noEp.status, 503)
  // 响应不是补全结果 / content 为空
  const notJson = await translateSelection(ep, 'x', {
    cache: new TranslateSelectionCache(),
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => 'not json at all' }),
  }).catch((e) => e)
  assert.equal(notJson.code, 'upstream')
  const emptyContent = await translateSelection(ep, 'x', {
    cache: new TranslateSelectionCache(),
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{"choices":[{"message":{"content":"   "}}]}' }),
  }).catch((e) => e)
  assert.equal(emptyContent.code, 'upstream')
})

test('A10-续 唯一重试：HTTP 400 且体匹配 /temperature/ → 去掉 temperature 重发一次', async () => {
  const seen = []
  let first = true
  const fetchImpl = async (_url, init) => {
    seen.push(JSON.parse(init.body))
    if (first) { first = false; return { status: 400, ok: false, text: async () => '{"error":"unsupported parameter: temperature"}' } }
    return { status: 200, ok: true, text: async () => '{"choices":[{"message":{"content":"你好"}}]}' }
  }
  const r = await translateSelection({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, 'hello', { fetchImpl, cache: new TranslateSelectionCache() })
  assert.equal(r.translation, '你好')
  assert.equal(seen.length, 2, '只允许重发一次')
  assert.ok('temperature' in seen[0])
  assert.ok(!('temperature' in seen[1]), '重发时必须去掉 temperature')
  // 400 但不是 temperature 问题 → 不重试
  const seen2 = []
  const err = await translateSelection({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, 'hello', {
    cache: new TranslateSelectionCache(),
    fetchImpl: async (_u, init) => { seen2.push(1); return { status: 400, ok: false, text: async () => '{"error":"bad model"}' } },
  }).catch((e) => e)
  assert.equal(seen2.length, 1, '非 temperature 的 400 不得重试（避免重复计费）')
  assert.equal(err.upstreamStatus, 400)
})

test('A11 key 不泄漏：请求体/响应体/错误体都没有 key，日志白名单只有四个字段', async () => {
  const key = 'sk-leak-canary-abcdefghijklmnop'
  const logs = []
  const fetchImpl = async () => ({ status: 200, ok: true, text: async () => '{"choices":[{"message":{"content":"你好"}}]}' })
  const r = await translateSelection({ baseUrl: 'https://x/v1', apiKey: key, model: 'm' }, 'hello', {
    fetchImpl, cache: new TranslateSelectionCache(), log: (i) => logs.push(JSON.stringify(i)),
  })
  for (const field of [r.translation, r.model, JSON.stringify(r)]) assert.ok(!field.includes(key))
  assert.equal(logs.length, 1)
  assert.ok(!logs[0].includes(key) && !logs[0].includes('https://x/v1'), `日志只许白名单字段：${logs[0]}`)
  assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(), ['chars', 'model', 'ms', 'status'])
  // 上游错误回显 Authorization 也必须被脱敏
  const err = await translateSelection({ baseUrl: 'https://x/v1', apiKey: key, model: 'm' }, 'hello', {
    cache: new TranslateSelectionCache(),
    fetchImpl: async () => ({ status: 500, ok: false, text: async () => `authorization: Bearer ${key}` }),
  }).catch((e) => e)
  assert.ok(!err.message.includes(key), `上游回显的 key 必须被 sanitizeDetail 清掉：${err.message}`)
  // 源码级：新模块**恰好一处** console.log，且是白名单（model/status/ms/chars）；注释里也不许出现
  const src = readFileSync(join(REPO, 'src', 'translate-selection.ts'), 'utf8')
  const logCalls = [...src.matchAll(/console\.log\(/g)]
  assert.equal(logCalls.length, 1, '模块内只许有一处 console.log（白名单）')
  assert.ok(src.includes("console.log('[dsh-paper-reader] translate-selection', JSON.stringify(info))"))
  // 不得把端点对象/配置对象/密钥送进任何 console 调用
  for (const bad of ['console.log(endpoint', 'console.log(cfg', 'console.log(apiKey', 'console.log(key', 'console.error(']) {
    assert.ok(!src.includes(bad), `禁止打印端点/密钥：${bad}`)
  }
})

test('A12 缓存：同 model+源文本命中且不再调 fetch；换 model/文本不命中；LRU 上限生效', async () => {
  const cache = new TranslateSelectionCache()
  const key = 'sk-test'
  let calls = 0
  const fetchImpl = async () => { calls++; return { status: 200, ok: true, text: async () => '{"choices":[{"message":{"content":"译文 $x_t$"}}]}' } }
  const ep = { baseUrl: 'https://x/v1', apiKey: key, model: 'm' }
  const r1 = await translateSelection(ep, 'a $x_t$ b', { fetchImpl, cache, log: () => {} })
  const r2 = await translateSelection(ep, 'a $x_t$ b', { fetchImpl, cache, log: () => {} })
  assert.equal(calls, 1, '第二次必须命中缓存')
  assert.equal(r1.cached, false)
  assert.equal(r2.cached, true)
  assert.equal(r2.translation, r1.translation)
  assert.equal(r2.formulaLost, 0)
  await translateSelection({ ...ep, model: 'm2' }, 'a $x_t$ b', { fetchImpl, cache, log: () => {} })
  assert.equal(calls, 2, '换 model 必须不命中（R12 缓存串味）')
  await translateSelection(ep, 'different text', { fetchImpl, cache, log: () => {} })
  assert.equal(calls, 3, '换文本必须不命中')
  // 键不含 key、不含页码
  const k1 = selectionCacheKey('m', 'a $x_t$ b')
  assert.equal(k1, selectionCacheKey('m', 'a $x_t$ b'))
  assert.notEqual(k1, selectionCacheKey('m2', 'a $x_t$ b'))
  assert.equal(k1.length, 64, 'sha256 十六进制')
  // LRU：上限 200，最旧的被淘汰
  const lru = new TranslateSelectionCache()
  for (let i = 0; i < CACHE_LIMIT + 10; i++) lru.set('k' + i, 'v' + i)
  assert.equal(lru.size, CACHE_LIMIT)
  assert.equal(lru.get('k0'), undefined, '最旧的必须被淘汰')
  assert.equal(lru.get('k' + (CACHE_LIMIT + 9)), 'v' + (CACHE_LIMIT + 9))
  // 命中即刷新 LRU 顺序：get 过的键不会被下一次 set 淘汰
  const lru2 = new TranslateSelectionCache(2)
  lru2.set('a', '1'); lru2.set('b', '2'); lru2.get('a'); lru2.set('c', '3')
  assert.equal(lru2.get('a'), '1', '被访问过的键必须留下')
  assert.equal(lru2.get('b'), undefined)
})

/* ══════════════════════════════════════════════════════════════════════════
   C. 路由：POST /api/translate-selection（本机 mock 上游，零外网）
   ══════════════════════════════════════════════════════════════════════════ */

const HOME = mkdtempSync(join(tmpdir(), 'dpr-sel-home-'))
process.env.DSH_HOME = HOME
const DATA = mkdtempSync(join(tmpdir(), 'dpr-sel-data-'))
mkdirSync(join(DATA, 'lib'), { recursive: true })
writeFileSync(join(DATA, 'lib', 'paper.pdf'), '%PDF-1.4\n% placeholder\n')
writeFileSync(join(DATA, 'lib', 'paper.mineru.json'), FIXTURE_JSON, 'utf8')
writeFileSync(join(DATA, 'lib', 'bare.mineru.json'), JSON.stringify({ contentList: [{ type: 'text', page_idx: 0, text: BLOCK_B }] }), 'utf8')
writeFileSync(join(DATA, 'lib', 'bare.pdf'), '%PDF-1.4\n% placeholder\n')

/** 上游 mock：可切换成 401/429/500 或正常补全（ok = 回显源文本，顺带覆盖「译文：」前缀清洗）。 */
let upstreamMode = 'ok'
let upstreamSeen = []
const upstream = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    upstreamSeen.push({ url: req.url, auth: req.headers.authorization, body: raw })
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
    if (upstreamMode === 'ok') {
      const user = (JSON.parse(raw).messages || []).slice(-1)[0]?.content ?? ''
      return send(200, { choices: [{ message: { content: `译文：${user}` } }] })
    }
    if (upstreamMode === '401') return send(401, { error: `invalid key sk-upstream-canary-999` })
    if (upstreamMode === '429') return send(429, 'too many requests')
    if (upstreamMode === '500') return send(500, 'boom')
    return send(200, { choices: [] })
  })
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}/v1`

let spec = null
const TRANSLATE = { baseUrl: UPSTREAM, apiKey: 'sk-route-canary-abcdefghijklmnop', model: 'test-model' }
registerRoutes({
  webServer: { register: (s) => { spec = s; return () => {} } },
  connection: { requestRejection: () => undefined },
  sessionController: { list: async () => ({ items: [] }) },
  workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
}, { dataDir: DATA, translate: TRANSLATE })

let server = null
let ORIGIN = null
const ensureServer = async () => {
  if (server && server.listening) return
  server = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  server.unref()
  ORIGIN = `http://127.0.0.1:${server.address().port}/paper-reader`
}
const post = async (path, body) => {
  await ensureServer()
  const r = await fetch(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, body: parsed, text }
}
test.after(() => {
  try { server?.close() } catch { /* 已关 */ }
  try { upstream.close() } catch { /* 已关 */ }
  rmSync(HOME, { recursive: true, force: true })
  rmSync(DATA, { recursive: true, force: true })
})

test('A1/A5 路由 200：行内 + display 组装后送上游，响应字段齐备且不含 key', async () => {
  upstreamMode = 'ok'
  upstreamSeen = []
  selectionCache.clear()
  const r = await post('/api/translate-selection', {
    topic: 'lib', name: 'paper',
    chunks: [
      { page: 1, kind: 'text', text: DEG_A + ' \u0000\u0010\ufffd\ue000\n' },
      { page: 1, kind: 'formula', latex: EQ_CITE },
      { page: 2, kind: 'text', text: DEG_C },
    ],
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.model, 'test-model')
  assert.equal(r.body.cached, false)
  assert.equal(r.body.hasBlockIndex, true)
  assert.equal(r.body.formulaStatus, 'applied')
  assert.equal(r.body.formulaApplied, 2)
  assert.equal(r.body.formulaSkipped, 0)
  // BLOCK_A 有 3 个行内片段 + 1 个 display + BLOCK_C 的 1 个 = 5
  assert.equal(r.body.formulaTotal, 5)
  assert.equal(r.body.formulaKept, 5, 'mock 回显源文本 ⇒ 全部原样保留')
  assert.equal(r.body.formulaLost, 0)
  assert.ok(typeof r.body.ms === 'number')
  // 「译文：」前缀必须被剥掉（气泡正文是纯译文）
  assert.ok(r.body.translation.startsWith('We define the probabilities'), `前缀必须剥掉：${r.body.translation.slice(0, 20)}`)
  // 行结构保留：三行
  assert.equal(r.body.translation.split('\n').length, 3)
  // 上游收到的 user 消息：乱码已清、公式是单 $ 定界的紧凑 LaTeX
  const sent = JSON.parse(upstreamSeen[0].body)
  assert.equal(sent.messages[0].content, SELECTION_SYSTEM_PROMPT)
  const user = sent.messages[1].content
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd]/.test(user), `送上游的文本不得含乱码（换行除外）：${JSON.stringify(user)}`)
  assert.ok(user.includes('$' + EQ_CITE + '$'), 'display 段必须是紧凑 LaTeX')
  assert.ok(user.includes('$v_\\psi(s_t,I)$'), '第二页的行内公式必须被还原')
  assert.ok(user.includes('$x_{t-1}$') && user.includes('$[Q_t]_{mn}='), '第一页的三个行内公式都必须还原')
  assert.equal(sent.temperature, 0)
  assert.equal(sent.max_tokens, clampMaxTokens(user.length))
  // 响应/请求体里都没有 key（前端拿不到 baseUrl/key）
  const all = r.text + JSON.stringify(upstreamSeen[0].body)
  assert.ok(!all.includes(TRANSLATE.apiKey), '响应/上游请求体不得含 key')
  assert.ok(!r.text.includes(UPSTREAM), '响应不得带端点 URL')
  assert.ok(!Object.keys(r.body).some((k) => /key|baseUrl|endpoint/i.test(k)), `响应字段不得有 key/端点：${Object.keys(r.body)}`)
  // 上游收到的 Authorization 是本进程注入的（前端无从得知）
  assert.equal(upstreamSeen[0].auth, `Bearer ${TRANSLATE.apiKey}`)
  assert.equal(upstreamSeen[0].url, '/v1/chat/completions')
  // 缓存：同 model+源文本第二次请求必须命中且不再打上游
  const before = upstreamSeen.length
  const again = await post('/api/translate-selection', {
    topic: 'lib', name: 'paper',
    chunks: [
      { page: 1, kind: 'text', text: DEG_A + ' \u0000\u0010\ufffd\ue000\n' },
      { page: 1, kind: 'formula', latex: EQ_CITE },
      { page: 2, kind: 'text', text: DEG_C },
    ],
  })
  assert.equal(again.body.cached, true)
  assert.equal(upstreamSeen.length, before, '命中缓存不得再打上游')
})

test('A5-续 纯 display 选区：textChunkCount=0 ⇒ formulaTotal=0 且不含任何文本层字符', async () => {
  upstreamMode = 'ok'
  upstreamSeen = []
  const r = await post('/api/translate-selection', {
    topic: 'lib', name: 'paper',
    chunks: [{ page: 1, kind: 'formula', latex: EQ_CITE }],
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.formulaApplied, 0)
  assert.equal(r.body.formulaSkipped, 0)
  assert.equal(r.body.formulaStatus, 'applied')
  const user = JSON.parse(upstreamSeen[0].body).messages[1].content
  assert.equal(user, '$' + EQ_CITE + '$')
})

test('A8-续 bare 产物（有 text 块、无 equation）：hasBlockIndex=true，行内仍能还原', async () => {
  upstreamMode = 'ok'
  upstreamSeen = []
  const r = await post('/api/translate-selection', {
    topic: 'lib', name: 'bare',
    chunks: [{ page: 1, kind: 'text', text: DEG_B }],
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.hasBlockIndex, true, 'bare 产物也有块可查（R16）')
  assert.equal(r.body.formulaApplied, 1)
  assert.equal(r.body.formulaStatus, 'applied')
  const user = JSON.parse(upstreamSeen[0].body).messages[1].content
  assert.ok(user.includes('$\\pi_\\theta(a|s)$'), `bare 产物也必须走行内还原：${user}`)
})

test('A8-续 无产物：hasBlockIndex=false + formulaStatus=no-artifact（气泡据此如实提示）', async () => {
  upstreamMode = 'ok'
  upstreamSeen = []
  writeFileSync(join(DATA, 'lib', 'plain.pdf'), '%PDF-1.4\n% placeholder\n')
  const r = await post('/api/translate-selection', {
    topic: 'lib', name: 'plain',
    chunks: [{ page: 1, kind: 'text', text: JUNK_LINE }],
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.hasBlockIndex, false)
  assert.equal(r.body.formulaStatus, 'no-artifact')
  assert.equal(r.body.formulaApplied, 0)
  const user = JSON.parse(upstreamSeen[0].body).messages[1].content
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd]/.test(user), '即使无法还原也必须清掉乱码字符')
})

test('A10-续 路由错误面：上游 401/429/500 映射成 502 + upstreamStatus；文案已脱敏', async () => {
  for (const [mode, up] of [['401', 401], ['429', 429], ['500', 500], ['nocompletion', 200]]) {
    upstreamMode = mode
    selectionCache.clear()   // 否则同源文本会命中上一轮缓存（键不含文献名，见 A12）
    const r = await post('/api/translate-selection', {
      topic: 'lib', name: 'paper', chunks: [{ page: 2, kind: 'text', text: DEG_C }],
    })
    assert.equal(r.status, 502, `${mode} 必须映射成 502`)
    assert.equal(r.body.code, 'upstream')
    assert.equal(r.body.upstreamStatus, up)
    assert.ok(!r.text.includes(TRANSLATE.apiKey) && !r.text.includes('sk-upstream-canary-999'), `错误体不得含 key：${r.text}`)
  }
})

test('A9 未配置端点：503 no-endpoint（前端据此弹设置浮层并自动重试）', async () => {
  let spec2 = null
  registerRoutes({
    webServer: { register: (s) => { spec2 = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceController: {}, workspaceRegistry: {}, effect: (fn) => fn(),
  }, { dataDir: DATA })   // 没有 translate 配置，且 HOME 下没有 translate.json
  const s2 = createServer((req, res) => spec2.handler(req, res))
  await new Promise((r) => s2.listen(0, '127.0.0.1', r))
  s2.unref()
  const base = `http://127.0.0.1:${s2.address().port}/paper-reader`
  try {
    const r = await fetch(base + '/api/translate-selection', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'lib', name: 'paper', chunks: [{ page: 1, kind: 'text', text: DEG_B }] }),
    })
    const body = await r.json()
    assert.equal(r.status, 503)
    assert.equal(body.code, 'no-endpoint')
  } finally { s2.close() }
})

test('A15-续 路由入参校验：空 chunks / 超量 / 非法 kind / 缺 topic / 文献不存在', async () => {
  const cases = [
    [{ topic: 'lib', name: 'paper', chunks: [] }, 400, 'too-large'],
    [{ topic: 'lib', name: 'paper', chunks: 'nope' }, 400, 'bad-request'],
    [{ topic: 'lib', name: 'paper', chunks: Array.from({ length: 201 }, () => ({ page: 1, kind: 'text', text: 'x' })) }, 400, 'too-large'],
    [{ topic: 'lib', name: 'paper', chunks: [{ page: 1, kind: 'nope', text: 'x' }] }, 400, 'bad-request'],
    [{ topic: 'lib', name: 'paper', chunks: [{ page: 0, kind: 'text', text: 'x' }] }, 400, 'bad-request'],
    [{ topic: 'lib', name: 'paper', chunks: [{ page: 1, kind: 'formula', latex: '' }] }, 400, 'bad-request'],
    [{ topic: 'lib', name: 'paper', chunks: [{ page: 1, kind: 'text', text: 'x'.repeat(4001) }] }, 400, 'too-large'],
    [{ topic: 'lib', name: 'paper', chunks: [{ page: 1, kind: 'text', text: 'x'.repeat(3000) }, { page: 1, kind: 'text', text: 'y'.repeat(6000) }] }, 400, 'too-large'],
    [{ chunks: [{ page: 1, kind: 'text', text: 'x' }] }, 400, 'bad-request'],
  ]
  for (const [body, status, code] of cases) {
    const r = await post('/api/translate-selection', body)
    assert.equal(r.status, status, `期望 ${status}：${JSON.stringify(body).slice(0, 80)}`)
    assert.equal(r.body.code, code)
  }
  const nf = await post('/api/translate-selection', { topic: 'lib', name: 'missing', chunks: [{ page: 1, kind: 'text', text: 'hello' }] })
  assert.equal(nf.status, 404)
  assert.equal(nf.body.code, 'not-found')
  assert.ok(!nf.text.includes(DATA), '404 文案不得含服务端绝对路径')
})

test('R14 /api/formulas 响应面不变：默认响应里不得出现 textBlocks', async () => {
  await ensureServer()
  const r = await fetch(`${ORIGIN}/api/formulas?topic=lib&name=paper`)
  const body = await r.json()
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(body).sort(), ['bboxSpace', 'backend', 'equations', 'pageCount', 'pageSize', 'producer', 'source'].sort())
  assert.ok(!('textBlocks' in body), '行内块索引不得经 /api/formulas 下发（R14/R15）')
  assert.ok(!JSON.stringify(body).includes('LCVN'), '不得把 text 块内容带出去')
})

/* ══════════════════════════════════════════════════════════════════════════
   D. 真实样本（只读；缺失则 skip）：原型 §2.6 的 10 个用例 + 中心点规则
   ══════════════════════════════════════════════════════════════════════════ */

const REAL_DATA = join(homedir(), '.dsh-paper-reader', 'data')
const REAL_FILES = existsSync(REAL_DATA)
  ? readdirSync(REAL_DATA, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .flatMap((d) => readdirSync(join(REAL_DATA, d.name))
      .filter((f) => f.endsWith('.mineru.json'))
      .map((f) => join(REAL_DATA, d.name, f)))
  : []
const REAL = REAL_FILES.map((p) => {
  try { return { path: p, raw: readFileSync(p, 'utf8') } } catch { return null }
}).filter(Boolean)

/** 在真实产物里找「含 $ 的 text 块最多」的那一篇（不写死论文名，任何机上都跑）。 */
const REAL_BEST = (() => {
  let best = null
  for (const r of REAL) {
    const idx = buildTextBlockIndex(r.raw)
    const withDollar = idx.blocks.length
    if (withDollar > 0 && (!best || withDollar > best.idx.blocks.length)) best = { ...r, idx }
  }
  return best
})()

test('A3-真实样本：退化文本 → 块文本对齐（原型 align-sim4 的 10 个用例的机制等价形式）', (t) => {
  if (!REAL_BEST) return t.skip('本机没有含行内公式的真实 MinerU 产物')
  // 独立构造：把 MinerU 块文本里的 $…$ 片段**抹成它的可见字形近似**（去命令、去括号，只留字母数字），
  // 再要求对齐把这行还原回带 $ 的形态。这是对「文本层结构性破坏」的机制模拟，不依赖任何期望常量。
  const blk = REAL_BEST.idx.blocks.find((b) => (b.text.match(/\$/g) || []).length >= 2)
  assert.ok(blk, '真实产物里必须存在至少两个行内片段的块')
  const degraded = blk.text.replace(/\$[^$]*\$/g, (frag) => frag.replace(/[^A-Za-z0-9]/g, ''))
  const r = alignSelectionToBlock(degraded, blk.text)
  assert.equal(r.applied, 1, `退化文本必须能被还原（score=${r.score}）`)
  assert.ok((r.text.match(/\$/g) || []).length >= 2, `还原后必须带回 $ 片段：${r.text}`)
  const frags = r.text.match(/\$[^$]*\$/g) || []
  assert.ok(frags.every((f) => !/_\s*\{|\\hat\s*\{/.test(f.replace(/\\hat\{[^}]*\}/g, '')) || true))
  assert.ok(frags.every((f) => !/\{\s+\S\s+\}/.test(f)), `片段必须是紧凑形态（不再有逐字符空格）：${frags}`)
})

test('A3-真实样本：真实的 8 个「必须/不得」用例（机型无关的那批）', (t) => {
  if (!REAL_BEST) return t.skip('本机没有含行内公式的真实 MinerU 产物')
  const blocks = REAL_BEST.idx.blocks
  // 纯正文反例：任意真实块里「不含 $ 的连续正文」对齐回来不得引入 $
  let checked = 0
  for (const blk of blocks.slice(0, 6)) {
    const plain = blk.text.split(/\$[^$]*\$/)[0]
    if (normForAlign(plain).A.length < 12) continue
    const r = alignSelectionToBlock(plain.trim(), blk.text)
    assert.ok(!/\$/.test(r.text), `纯正文不得引入 $：${JSON.stringify(r.text)}`)
    checked++
  }
  assert.ok(checked > 0, '至少要能构造出一个纯正文反例')
})

/* ══════════════════════════════════════════════════════════════════════════
   E. 客户端（vm 里跑真实 reader 脚本）+ DOM stub
   ══════════════════════════════════════════════════════════════════════════ */

function parsePart(sel) {
  const not = []
  const bare = sel.replace(/:not\(([^)]*)\)/g, (_, cls) => { not.push(cls.replace(/^\./, '')); return '' })
  const tag = /^[a-zA-Z]/.test(bare) ? bare.match(/^[a-zA-Z][\w-]*/)[0] : ''
  const id = (/#([\w-]+)/.exec(bare) || [])[1] || ''
  const classes = [...bare.matchAll(/\.([\w-]+)/g)].map((m) => m[1])
  const attr = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(bare)
  return { tag, id, classes, attr: attr ? attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null, attrVal: attr ? (attr[2] ?? null) : undefined, not }
}
function matchesPart(el, p) {
  if (!p) return false
  if (p.tag && el.tagName !== p.tag.toUpperCase()) return false
  if (p.id && el.id !== p.id) return false
  for (const c of p.classes) if (!el.classList.contains(c)) return false
  for (const c of p.not) if (el.classList.contains(c)) return false
  if (p.attr) {
    if (p.attrVal === null || p.attrVal === undefined) { if (el.dataset[p.attr] === undefined) return false }
    else if (String(el.dataset[p.attr]) !== p.attrVal) return false
  }
  return true
}
function matchesSel(el, sel) {
  const parts = sel.trim().split(/\s+/)
  if (!matchesPart(el, parsePart(parts[parts.length - 1]))) return false
  let node = el.parentNode
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false
    while (node) { if (matchesPart(node, parsePart(parts[i]))) { found = true; node = node.parentNode; break } node = node.parentNode }
    if (!found) return false
  }
  return true
}
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(), id: '', dataset: {}, children: [], childNodes: [],
    value: '', disabled: false, onclick: null, _classes: new Set(), _handlers: {}, _innerHTMLWrites: 0,
    style: { setProperty(k, v) { this[k] = v }, removeProperty(k) { delete this[k] }, getPropertyValue: (k) => el.style[k] ?? '' },
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      toggle: (c, on) => { const v = on === undefined ? !el._classes.has(c) : !!on; if (v) el._classes.add(c); else el._classes.delete(c); return v },
      contains: (c) => el._classes.has(c),
    },
    appendChild(c) {
      // DocumentFragment（nodeType 11）appendChild 时展平（真实 DOM 语义；KaTeX 用它建子树）
      if (c && c.nodeType === 11) { for (const k of c.children.slice()) el.appendChild(k); c.children = []; return c }
      el.children.push(c); el.childNodes.push(c); c.parentNode = el; c.parentElement = el; return c
    },
    append(...cs) { cs.forEach((c) => el.appendChild(c)) },
    remove() { const p = el.parentNode; if (p) { p.children = p.children.filter((x) => x !== el); p.childNodes = p.childNodes.filter((x) => x !== el) } },
    closest(sel) { let n = el; while (n) { if (matchesSel(n, sel)) return n; n = n.parentNode } return null },
    focus() {}, blur() {}, select() {}, click() { if (typeof el.onclick === 'function') el.onclick() },
    addEventListener(t, h) { (el._handlers[t] ||= []).push(h) },
    removeEventListener(t, h) { if (el._handlers[t]) el._handlers[t] = el._handlers[t].filter((x) => x !== h) },
    querySelector(s) { return walk(el).find((e) => matchesSel(e, s)) ?? null },
    querySelectorAll(s) { return walk(el).filter((e) => matchesSel(e, s)) },
    getBoundingClientRect() { return { left: el._left ?? 0, top: el._top ?? 0, right: 0, bottom: 0, width: 0, height: 0 } },
    contains(o) { let n = o; while (n) { if (n === el) return true; n = n.parentNode } return false },
    scrollIntoView() {}, getContext() { return {} }, setAttribute() {},
    clientHeight: 0, clientWidth: 0, scrollTop: 0, scrollHeight: 0, offsetTop: 0, offsetHeight: 0,
  }
  let inner = ''
  let ownText = ''
  // textContent 语义对齐真实 DOM：**读**是「自身文本 + 所有后代文本」的拼接，**写**会先清空子节点。
  // （译文气泡改成「文本段/数学段各自成元素」之后，`$('tr-body').textContent` 必须仍能读到完整可见文本。）
  Object.defineProperty(el, 'textContent', {
    get: () => (el.children.length ? el.children.map((c) => c.textContent ?? '').join('') : ownText),
    set: (v) => { el.children = []; el.childNodes = []; ownText = v == null ? '' : String(v) },
  })
  Object.defineProperty(el, 'className', {
    get: () => [...el._classes].join(' '),
    set: (v) => { el._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)) },
  })
  Object.defineProperty(el, 'innerHTML', { get: () => inner, set: (v) => { inner = v; el._innerHTMLWrites += 1; if (v === '') { el.children = []; el.childNodes = [] } } })
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null })
  Object.defineProperty(el, 'lastChild', { get: () => el.children[el.children.length - 1] ?? null })
  Object.defineProperty(el, 'parentNode', { get: () => el._parent ?? null, set: (v) => { el._parent = v } })
  Object.defineProperty(el, 'nodeType', { get: () => el._nodeType ?? 1 })
  return el
}
function walk(root, out = []) { for (const c of root.children || []) { out.push(c); walk(c, out) } return out }
function textNode(data) {
  const n = makeEl('#text')
  n._nodeType = 3
  n.data = data
  n.textContent = data
  Object.defineProperty(n, 'length', { get: () => data.length })
  return n
}

/** 真实 vendored KaTeX（`reader/vendor/katex.min.js`，与浏览器同一个文件；已拉平，见 pr7 诊断 P0）：
 *  在 vm 里跑它的 UMD，取到 `katex` 对象（renderToString 纯函数、render 建 DOM 节点）。 */
function loadVendoredKatex() {
  const kctx = { console, setTimeout, clearTimeout }
  kctx.globalThis = kctx; kctx.window = kctx; kctx.self = kctx
  vm.createContext(kctx)
  vm.runInContext(readFileSync(join(REPO, 'reader', 'vendor', 'katex.min.js'), 'utf8'), kctx)
  return kctx
}
const KCTX = loadVendoredKatex()   // UMD 只跑一次；每次 loadReader 把当次的 document 绑给它（KaTeX.render 要建节点）

/** 跑真实 reader 脚本 + 可观测 DOM stub。 */
function loadReader({ innerWidth = 1200 } = {}) {
  const els = new Map()
  const created = []
  const requests = []
  const body = makeEl('body')
  const named = makeEl('div')
  body.appendChild(named)
  const doc = {
    body, activeElement: null, _handlers: {},
    // KaTeX 在 quirks 模式下拒绝渲染（`<meta charset>` 之外它就认 compatMode）；stub 要跟标准页面对齐
    compatMode: 'CSS1Compat',
    getElementById(id) { if (!els.has(id)) { const e = makeEl('div'); e.id = id; named.appendChild(e); els.set(id, e) } return els.get(id) },
    createElement(tag) { const e = makeEl(tag); created.push(e); return e },
    // KaTeX 用 createElementNS 建 MathML 子树（'http://www.w3.org/1998/Math/MathML'）
    createElementNS(_ns, tag) { const e = makeEl(tag); created.push(e); return e },
    createTextNode(t) { return textNode(t) },
    createDocumentFragment() { const f = makeEl('#document-fragment'); f._nodeType = 11; return f },
    createRange() {
      let s = 0, e = 0
      return {
        setStart(_n, o) { s = o }, setEnd(_n, o) { e = o },
        getBoundingClientRect() { return { left: 40, top: 100, right: 40 + (e - s) * 6, bottom: 112, width: (e - s) * 6, height: 12 } },
      }
    },
    querySelector(sel) { return walk(body).find((e) => matchesSel(e, sel)) ?? null },
    querySelectorAll(sel) { return walk(body).filter((e) => matchesSel(e, sel)) },
    addEventListener(t, h) { (doc._handlers[t] ||= []).push(h) },
    removeEventListener(t, h) { if (doc._handlers[t]) doc._handlers[t] = doc._handlers[t].filter((x) => x !== h) },
    dispatch(t, ev) { for (const h of doc._handlers[t] || []) h(ev) },
    documentElement: makeEl('html'),
  }
  const store = new Map()
  // 划词翻译接口的响应（可被用例改写；`__status` 存在 = 让这次请求失败）。
  // 放在 ctx 上：harness 字符串在 vm 里求值，看不到本函数的闭包变量。
  const ctrl = {
    trResp: {
      translation: '这是译文（含 $x_t$）', model: 'm', cached: false, ms: 3,
      formulaTotal: 1, formulaKept: 1, formulaLost: 0,
      formulaApplied: 1, formulaSkipped: 0, formulaStatus: 'applied', hasBlockIndex: true,
    },
    zh: { zh: true, dual: false, busy: false },   // /api/zh 的响应（R-02 的换文献场景用）
    hold: false,                                   // true = 挂起 translate-selection 的响应（R-01 用）
    release: null,
    holdMeta: false,                               // true = 挂起 /api/paper 的响应（N-01 用）
    releaseMeta: null,
  }
  // KaTeX 的 render 要在**同一个** vm 上下文里拿 document 建节点；每次 harness 把当次的 doc 绑过去
  // （node:test 同文件内顺序执行，不会并发打架）。renderToString 是纯函数，不依赖 DOM。
  KCTX.document = doc
  const win = {
    // 真实 vendored KaTeX（离线，与浏览器加载的是同一个文件）；渲染路径的用例靠它跑真渲染
    katex: KCTX.katex,
    devicePixelRatio: 1, innerWidth, innerHeight: 900,
    addEventListener() {}, getSelection: () => null,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  const ctx = {
    document: doc, window: win, navigator: {}, location: { search: '' },
    matchMedia: win.matchMedia,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    AbortController, console, URLSearchParams, parseInt, parseFloat, isNaN, ctrl,
    Promise, Math, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Date, Set, Map,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } },
    pdfjsLib: { TextLayer: class { async render() {} }, GlobalWorkerOptions: {} },
    fetch: async (url, init = {}) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null })
      if (String(url).includes('/api/paper?')) {
        // N-01：挂起 openPaper 的第一处 await，复现「失效点落在 await 之后」的窗口
        if (ctrl.holdMeta) { await new Promise((res) => { ctrl.releaseMeta = res }); ctrl.holdMeta = false }
        return { ok: true, status: 200, json: async () => ({ hasTranscript: false, pageCount: 2, pdfPath: '' }) }
      }
      if (String(url).includes('/api/zh?')) return { ok: true, status: 200, json: async () => ctrl.zh }
      if (String(url).endsWith('/api/translate-selection')) {
        if (ctrl.hold) {   // R-01：挂起响应，直到用例调用 ctrl.release()
          await new Promise((res) => { ctrl.release = res })
          ctrl.hold = false
        }
        const resp = ctrl.trResp
        // `__status` 存在 = 让这次响应失败（用于 A9/A10 的客户端分档）
        if (resp.__status) {
          return { ok: false, status: resp.__status, json: async () => ({ error: resp.error, code: resp.code, upstreamStatus: resp.upstreamStatus }) }
        }
        return { ok: true, status: 200, json: async () => resp }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, n: 1, topics: [], papers: [] }) }
    },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  const pane = doc.getElementById('pdf-pane')
  pane.clientHeight = 800
  pane.clientWidth = 1000
  const paneZh = doc.getElementById('pdf-pane-zh')
  paneZh.clientHeight = 800
  paneZh.clientWidth = 500
  const harness = `
    ;globalThis.__t = {
      buildChunks, formulaBoxByCenter, anchorOf, syncTargetOf, trNote, trFailure, eqLatex,
      hitTestFormula, paintEqLayer, makePageNode, renderSplit, rerender, paintPage,
      updateViewButtons, applyViewMode, persistViewMode, viewModeFromSaved, setViewMode,
      translateSelection, showAskPop, collectSelectionChars, MAX_SELECTION_CHARS,
      EQ_BY_PAGE, eqGeom, eqHotEnabled,
      setEq: (i) => { eqIndex = i },
      getEq: () => eqIndex,
      setVariant: (v) => { zhVariant = v },
      setView: (v) => { viewMode = v },
      getView: () => viewMode,
      setZoom: (z) => { zoomScale = z },
      setPageMode: (m) => { pageMode = m },
      setCurPage: (n) => { curPage = n },
      setPdfDoc: (d) => { pdfDoc = d },
      setPdfDocZh: (d) => { pdfDocZh = d },
      setCurrent: (c) => { current = c },
      setZhState: (s) => { zhState = s },
      getZhState: () => zhState,
      getAsk: () => askSelection,
      setAsk: (s) => { askSelection = s },
      getViewMode: () => viewMode,
      getVariant: () => zhVariant,
      setTrResp: (r) => { ctrl.trResp = r },
      openSplit, getPdfDocZh: () => pdfDocZh,
      openPaper, invalidateTranslate, getTrBusy: () => trBusy, getTrSeq: () => trSeq,
      splitTranslatedMath, trRenderBody, trComposeNote, showTrPop,
      // F3：把 pdf.js 置成「未就绪」，只有 ensurePdfjs 能把它装上 —— 复现刷新后恢复分屏的时序
      armColdPdfjs: (lib) => { pdfjsLib = undefined; ensurePdfjs = async () => { pdfjsLib = lib; }; },
      // R-02：pdf.js 视为「已就绪」（装上 lib 但不改动 pdfjsLib 的现值），让 openPaper 能跑完
      armPdfjs: (lib) => { ensurePdfjs = async () => { pdfjsLib = lib; }; },
    };`
  vm.runInContext(SCRIPT_SRC + harness, ctx, { filename: 'reader-inline.js' })
  return { t: ctx.__t, doc, els, created, requests, body, win, store, ctrl }
}

const viewport = (w = 612, h = 792) => ({ width: w, height: h, scale: 1 })
const pageStub = (vp) => ({
  getViewport: () => vp,
  render: () => ({ promise: Promise.resolve() }),
  getTextContent: () => ({ items: [] }),
})
const docStub = (nPages, vp = viewport()) => ({ numPages: nPages, getPage: async () => pageStub(vp) })

test('E1 display 路径：中心点相交 + 多公式 + 部分重叠 + 乱码字符不进 chunk', () => {
  const R = loadReader()
  const box = R.t.formulaBoxByCenter
  const items = [eqItem('e1', 100, 500, 300, 540), eqItem('e2', 100, 600, 200, 640)]
  // ① 中心点在内 → 命中；② 交叠但中心点在外（「任何交叠」会误吞下一行正文）→ 不命中
  assert.equal(box(rect(150, 510, 200, 530), items).eq.id, 'e1')
  assert.equal(box(rect(290, 530, 380, 560), items), null, '交叠但中心点在外：绝不算该公式（R1 实测多吞 101 字符）')
  assert.equal(box(rect(120, 610, 180, 630), items).eq.id, 'e2')
  assert.equal(box(rect(0, 0, 10, 10), items), null)
  assert.equal(box(rect(150, 510, 200, 530), null), null)
  // ③ 并列（两个盒都含中心点）→ 取面积最小者
  const overlapping = [eqItem('big', 100, 500, 400, 600), eqItem('small', 150, 520, 200, 540)]
  assert.equal(box(rect(160, 525, 190, 535), overlapping).eq.id, 'small', '并列取面积最小（与既有热区同规则）')

  // ④ 多公式 + 部分重叠：只框住公式的一半 ⇒ 仍给**完整** LaTeX（公式是原子的）
  const vp = vpOf(R)
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.setZoom(1)
  const pageDiv = R.t.makePageNode(1, vp, 'orig')
  R.body.appendChild(pageDiv)
  R.t.paintEqLayer(pageDiv, vp, 1)
  const geo = R.t.EQ_BY_PAGE.get(1)[0]
  const half = [geo.x0 + 2, (geo.y0 + geo.y1) / 2 - 1, geo.x0 + (geo.x1 - geo.x0) / 2, (geo.y0 + geo.y1) / 2 + 1]
  const chunks = R.t.buildChunks([
    { ch: 'x', page: 1, rect: half },
    { ch: 'y', page: 1, rect: half },
  ], (p) => R.t.EQ_BY_PAGE.get(p))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].kind, 'formula')
  assert.equal(chunks[0].latex, R.t.eqLatex(R.t.getEq().equations[0].latex), '部分重叠也必须给完整 LaTeX')
  assert.ok(!chunks.some((c) => c.kind === 'text'), '命中的乱码字符不得进 text 段')

  // ⑤ 两条不相邻公式 → 两个 formula chunk（阅读序）
  const two = R.t.buildChunks([
    { ch: 'a', page: 1, rect: half },
    { ch: '\n', page: 1, rect: null },
    { ch: 'b', page: 1, rect: half },
  ], (p) => R.t.EQ_BY_PAGE.get(p))
  assert.equal(two.length, 3, '两条公式之间的换行必须切出一个 text 段')
  assert.deepEqual([...two.map((c) => c.kind)], ['formula', 'text', 'formula'])
  assert.equal(two[1].text, '\n')

  // ⑥ 混合：正文 + display + 正文 的切法
  const mixed = R.t.buildChunks([
    { ch: 'A', page: 1, rect: [0, 0, 5, 5] },
    { ch: 'B', page: 1, rect: [0, 0, 5, 5] },
    { ch: 'C', page: 1, rect: half },
    { ch: 'D', page: 1, rect: [0, 0, 5, 5] },
    { ch: 'E', page: 1, rect: [0, 0, 5, 5] },
  ], (p) => R.t.EQ_BY_PAGE.get(p))
  assert.deepEqual([...mixed.map((c) => c.kind)], ['text', 'formula', 'text'])
  assert.equal(mixed[0].text, 'AB')
  assert.equal(mixed[2].text, 'DE')

  // ⑦ 无 rect（换行伪影/退化字符）→ 一律按纯文本处理，不猜归属
  const noRect = R.t.buildChunks([{ ch: 'Z', page: 1, rect: null }], (p) => R.t.EQ_BY_PAGE.get(p))
  assert.deepEqual([...noRect.map((c) => ({ ...c }))], [{ page: 1, kind: 'text', text: 'Z' }])
})

function vpOf(R) { return viewport() }

test('E2 切块闸门：段数 ≤200、单 text 段 ≤4000、总长 ≤8000', () => {
  const R = loadReader()
  const chars = []
  for (let i = 0; i < 300; i++) { chars.push({ ch: 'a'.repeat(30), page: 1, rect: null }); chars.push({ ch: '\n', page: 1, rect: null }) }
  const chunks = R.t.buildChunks(chars, () => null)
  assert.ok(chunks.length <= 200, `段数上限：${chunks.length}`)
  assert.ok(chunks.every((c) => (c.kind === 'text' ? c.text.length <= 4000 : c.latex.length <= 8000)))
  const total = chunks.reduce((n, c) => n + (c.kind === 'text' ? c.text.length : c.latex.length), 0)
  assert.ok(total <= 8000, `总长上限：${total}`)
})

test('E3 分屏同步是纯函数：同页号 + 页内比例；页数不同按比例映射并报 mismatch', () => {
  const R = loadReader()
  const pages = (n, h = 800) => Array.from({ length: n }, (_, i) => ({ page: i + 1, offsetTop: i * h, offsetHeight: h }))
  const a = R.t.anchorOf(pages(3), 800 + 400)
  assert.deepEqual({ ...a }, { page: 2, ratio: 0.5 })
  // 页数相同（实测常态 19/19）：目标页号 = 锚点页号
  const t1 = R.t.syncTargetOf(a, pages(3), 3)
  assert.equal(t1.top, 800 + 0.5 * 800)
  assert.equal(t1.mismatch, false)
  // 页数不同：按比例映射 + mismatch 提示
  const t2 = R.t.syncTargetOf({ page: 2, ratio: 0.5 }, pages(4), 3)
  assert.equal(t2.mismatch, true)
  assert.equal(t2.top, 800 + 0.5 * 800, '第 2 页 → 第 round(1*4/3)=1 → 索引 1 = 第 2 页')
  // 目标超出源页数：夹取到末页，不许越界
  const t3 = R.t.syncTargetOf({ page: 3, ratio: 1 }, pages(2), 3)
  assert.equal(t3.top, 800 + 1 * 800)
  // 边界：滚动位置在各页分界上、滚动为 0、页列表为空
  assert.deepEqual({ ...R.t.anchorOf(pages(2), 0) }, { page: 1, ratio: 0 })
  assert.deepEqual({ ...R.t.anchorOf(pages(2), 800) }, { page: 2, ratio: 0 })
  assert.equal(R.t.anchorOf([], 0), null)
  assert.equal(R.t.syncTargetOf(a, [], 3), null)
  // 滚动 10 次不累积漂移：往返换算后回到原位的误差 ≤ 1e-9
  let top = 1234
  for (let i = 0; i < 10; i++) {
    const an = R.t.anchorOf(pages(19, 800), top)
    top = R.t.syncTargetOf(an, pages(19, 800), 19).top
  }
  assert.ok(Math.abs(top - 1234) < 1e-9, `同步不得累积漂移：${top}`)
})

test('E4 结构性：译文气泡零按钮、.eqLayer 仍 pointer-events:none、剪贴板写入仍为 2 处', () => {
  // 气泡 DOM 存在，且其子树里没有任何 button（用户明确不要插入会话/复制按钮）
  const trStart = READER_HTML.indexOf('<div id="tr-pop">')
  const trEnd = READER_HTML.indexOf('</div>', READER_HTML.indexOf('id="tr-note"'))
  const trPopHtml = READER_HTML.slice(trStart, trEnd + 6)
  assert.ok(trPopHtml.includes('id="tr-body"') && trPopHtml.includes('id="tr-note"') && trPopHtml.includes('id="tr-status"'))
  assert.ok(!/<button/i.test(trPopHtml), `#tr-pop 内部不得有任何 button：${trPopHtml}`)
  // 「译」按钮在既有 #ask-actions 里（加法）
  const actions = READER_HTML.slice(READER_HTML.indexOf('<div id="ask-actions">'), READER_HTML.indexOf('</div>', READER_HTML.indexOf('id="ask-send"')))
  assert.ok(actions.includes('id="ask-translate"'), '必须在既有 #ask-actions 里新增「译」')
  for (const keep of ['id="ask-copy"', 'id="ask-cancel"', 'id="ask-send"']) assert.ok(actions.includes(keep), `既有动作不得被改动：${keep}`)
  // 热区层仍然 pointer-events:none，且热区不绑事件
  assert.match(READER_HTML, /\.eqLayer\s*\{[^}]*pointer-events:\s*none/)
  for (const rule of READER_HTML.match(/\.eq-box[^{]*\{[^}]*\}/g) || []) assert.ok(!/pointer-events/.test(rule))
  assert.ok(!/\.eqLayer[^\n]*addEventListener|eq-box[^\n]*addEventListener/.test(SCRIPT_SRC), '热区层不得绑事件')
  // 剪贴板写入仍恰好 2 处，且都在显式按钮回调之后（R8）
  const copyAt = SCRIPT_SRC.indexOf("$('ask-copy').onclick")
  const writes = [...SCRIPT_SRC.matchAll(/await navigator\.clipboard\.writeText\(|document\.execCommand\('copy'\)/g)].map((m) => m.index)
  assert.equal(writes.length, 2, '本功能不得新增任何剪贴板写入')
  for (const i of writes) assert.ok(i > copyAt, '剪贴板写入必须在用户显式点击之后')
  // 源码切片断言（R9）：mouseup → ask-cancel 之间仍是「先选区后公式」
  const mouseupBlock = SCRIPT_SRC.slice(SCRIPT_SRC.indexOf("addEventListener('mouseup'"), SCRIPT_SRC.indexOf("$('ask-cancel').onclick"))
  assert.ok(mouseupBlock.includes('getSelection') && mouseupBlock.includes('hitTestFormula'))
  assert.ok(mouseupBlock.indexOf('getSelection') < mouseupBlock.indexOf('hitTestFormula'))
  // 新代码一律在 ask-cancel 之后
  for (const fn of ['function translateSelection(', 'function buildChunks(', 'function renderSplit(', 'function anchorOf(', 'function syncTargetOf(', 'function formulaBoxByCenter(', 'function showTrPop(', 'function trNote(', 'function trFailure(']) {
    const at = SCRIPT_SRC.indexOf(fn)
    assert.ok(at > SCRIPT_SRC.indexOf("$('ask-cancel').onclick"), `${fn} 必须在 ask-cancel 之后`)
  }
})

test('E5 data-doc 作用域：中文列不铺热区、不污染 EQ_BY_PAGE、命中恒 null', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.setZoom(1)
  R.t.setView('split')
  R.t.setPageMode('scroll')
  R.t.setCurrent({ topic: 'lib', name: 'paper' })
  R.t.setPdfDoc(docStub(2))
  R.t.setPdfDocZh(docStub(2))
  await R.t.renderSplit()
  const origPages = R.t.EQ_BY_PAGE
  assert.equal(origPages.size, 2, '原文列每页都要写几何（含空数组）')
  assert.equal(origPages.get(1).length, 1, '原文列第 1 页有 1 个公式')
  const zhBox = R.els.get('pdf-pages-zh')
  // R-05：**后代口径**——.eqLayer 挂在页节点之下，用直接子节点过滤永远数不到（原断言空转）
  assert.equal(zhBox.querySelectorAll('.eqLayer').length, 0, '中文列不得出现 .eqLayer（后代口径）')
  assert.equal(zhBox.children.filter((c) => c.className === 'page').length, 2, '中文列必须真的渲染出 2 页')
  const origBox = R.els.get('pdf-pages')
  const origPage1 = origBox.children.find((c) => String(c.dataset.page) === '1')
  assert.equal(origPage1.children.filter((c) => c.className === 'eqLayer').length, 1, '原文列第 1 页必须铺一层（层挂在页节点上）')
  // 中文列的页节点：命中必须恒 null（同页号 + 全局 EQ_BY_PAGE 会命中原文几何）
  // R-05：必须用**真实公式盒的中心点**去点——(1,1) 连 6pt 外扩都够不到，删掉隔离也不会红
  const g0 = origPages.get(1)[0]
  const zhPage = zhBox.children.find((c) => c.className === 'page')
  assert.equal(R.t.hitTestFormula({ target: zhPage, clientX: (g0.x0 + g0.x1) / 2, clientY: (g0.y0 + g0.y1) / 2 }), null,
    '中文列在同一几何点上必须命中 null（否则点中文页会引用原文公式）')
  // 原文列同一几何仍能命中（不得因为加了 data-doc 判定而失效）
  const origPage = origBox.children.find((c) => c.className === 'page' && String(c.dataset.page) === '1')
  const g = origPages.get(1)[0]
  assert.ok(R.t.hitTestFormula({ target: origPage, clientX: (g.x0 + g.x1) / 2, clientY: (g.y0 + g.y1) / 2 }))
  // 每个页节点都必须无条件带 data-doc（分屏之外的选择器依赖它）
  assert.ok(origBox.children.every((c) => c.dataset.doc === 'orig' || c.className === 'eqLayer'))
  assert.ok(zhBox.children.every((c) => c.dataset.doc === 'zh'))
  // 翻页模式下同样成立
  R.t.setPageMode('paged')
  R.t.setCurPage(1)
  await R.t.renderSplit()
  assert.equal(zhBox.querySelectorAll('.eqLayer').length, 0, '翻页模式下中文列同样不得有 .eqLayer（后代口径）')
  assert.equal(R.t.EQ_BY_PAGE.size, 1, '翻页模式只渲 curPage')
})

test('E6 分屏不回归既有渲染：renderPaged/renderAllPages 语义不变，rerender 只按 viewMode 分流', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.setZoom(1)
  R.t.setPageMode('paged')
  R.t.setCurPage(2)
  R.t.setPdfDoc(docStub(3))
  // 非分屏：rerender === renderPaged（#pdf-pages 单页）
  await R.t.rerender()
  assert.equal(R.els.get('pdf-pages').children.filter((c) => c.className === 'page').length, 1)
  assert.ok(R.els.get('pdf-pages').classList.contains('paged'))
  // 分屏：rerender 转 renderSplit（两列都出页）
  R.t.setView('split')
  R.t.setPdfDocZh(docStub(3))
  await R.t.rerender()
  assert.equal(R.els.get('pdf-pages').children.filter((c) => c.className === 'page').length, 1)
  assert.equal(R.els.get('pdf-pages-zh').children.filter((c) => c.className === 'page').length, 1)
  // 切回原文：tokens/dispose 语义不变
  R.t.setView('orig')
  R.t.setPageMode('scroll')
  await R.t.rerender()
  assert.equal(R.els.get('pdf-pages').children.filter((c) => c.className === 'page').length, 3)
  assert.ok(!R.els.get('pdf-pages').classList.contains('paged'))
})

test('E7 视图模式状态机与持久化键（R4/B11/B12/B13）', () => {
  const R = loadReader()
  R.t.setCurrent({ topic: '默认专题', name: 'Dong et al. - 2026' })
  const KEY = 'dpr.variant.默认专题/Dong et al. - 2026'
  // 读回表与改造前逐条一致：zh/dual 各自需要对应产物存在，否则回落原文
  assert.equal(R.t.viewModeFromSaved('zh', { zh: true, dual: false }), 'zh')
  assert.equal(R.t.viewModeFromSaved('dual', { zh: false, dual: true }), 'dual')
  assert.equal(R.t.viewModeFromSaved('', { zh: true, dual: true }), 'orig')
  assert.equal(R.t.viewModeFromSaved(null, { zh: true, dual: true }), 'orig')
  assert.equal(R.t.viewModeFromSaved('zh', { zh: false, dual: true }), 'orig', '译文不存在必须回落原文')
  assert.equal(R.t.viewModeFromSaved('dual', { zh: true, dual: false }), 'orig')
  assert.equal(R.t.viewModeFromSaved('split', { zh: true, dual: false }), 'split')
  assert.equal(R.t.viewModeFromSaved('split', { zh: false, dual: true }), 'orig', '分屏需要 -zh.pdf')
  assert.equal(R.t.viewModeFromSaved('garbage', { zh: true, dual: true }), 'orig')

  // 状态机：进入任一非 orig 模式先退出另一个（互斥），并写同一个键
  R.t.setZhState({ zh: true, dual: true, busy: false })
  assert.equal(R.t.applyViewMode('dual'), true)
  assert.equal(R.t.getView(), 'dual')
  assert.equal(R.t.getVariant(), 'dual')
  assert.equal(R.store.get(KEY), 'dual')
  assert.equal(R.t.applyViewMode('split'), true, '分屏与对照互斥：直接切过去')
  assert.equal(R.t.getView(), 'split')
  assert.equal(R.t.getVariant(), null, 'C17：分屏时 zhVariant 必须保持 null')
  assert.equal(R.store.get(KEY), 'split', 'B12：持久化键必须写成 split')
  assert.equal(R.t.applyViewMode('orig'), true)
  assert.equal(R.store.get(KEY), '', '回原文写空串（既有语义）')
  // 只有 dual 时进不了 split；只有 zh 时进不了 dual
  R.t.setZhState({ zh: false, dual: true, busy: false })
  assert.equal(R.t.applyViewMode('split'), false)
  R.t.setZhState({ zh: true, dual: false, busy: false })
  assert.equal(R.t.applyViewMode('dual'), false, 'B1：没有 -dual.pdf 不得切换')
  assert.equal(R.t.getView(), 'orig')
  // 面板太窄：不切换 + 提示
  const narrow = loadReader({ innerWidth: 500 })
  narrow.t.setCurrent({ topic: 't', name: 'n' })
  narrow.t.setZhState({ zh: true, dual: false, busy: false })
  assert.equal(narrow.t.applyViewMode('split'), false, 'B10：<640px 不得切换')
  assert.equal(narrow.t.getView(), 'orig')
  assert.match(String(narrow.els.get('toast').textContent), /面板太窄/)
})

test('E8 按钮状态机：无产物时「对照/分屏」disabled + title 口径；分屏时「中」加闸', () => {
  const R = loadReader()
  R.t.setCurrent({ topic: 't', name: 'n' })
  R.t.setZhState({ zh: false, dual: false, busy: false })
  R.t.updateViewButtons()
  const dt = R.els.get('dual-toggle'), st = R.els.get('split-toggle')
  assert.equal(dt.disabled, true)
  assert.match(dt.title, /先用「中」生成/)
  assert.equal(st.disabled, true)
  assert.match(st.title, /还没有中文版/)
  R.t.setZhState({ zh: true, dual: false, busy: false })
  R.t.updateViewButtons()
  assert.equal(st.disabled, false)
  assert.match(st.title, /模式 B/)
  assert.equal(dt.disabled, true, '只有 zh 时对照仍不可用')
  assert.ok(R.els.get('dual-toggle').style.display !== 'none')
  // 分屏激活：「中」禁用并给出原因
  R.t.setView('split')
  R.t.updateViewButtons()
  assert.equal(R.els.get('zh-toggle').disabled, true)
  assert.match(R.els.get('zh-toggle').title, /分屏对照中/)
  assert.ok(st.classList.contains('active'))
})

test('E9 提示文案表（A7/A8/A13 的客户端分档）', () => {
  const R = loadReader()
  const note = (resp) => R.t.trNote(resp)
  R.t.setEq({ source: 'none', equations: [], reason: 'no-mineru-artifact' })
  assert.match(note({}), /未用 MinerU 转录/)
  assert.match(note({}), /译文可能不准/)
  R.t.setEq({ source: 'mineru', equations: [], reason: 'no-equations' })
  assert.match(note({}), /没有公式块/)
  R.t.setEq({ source: 'mineru', equations: [], reason: 'bad-artifact' })
  assert.match(note({}), /产物损坏/)
  R.t.setEq({ source: 'mineru', equations: [{}], reason: undefined })
  assert.match(note({ formulaLost: 2, formulaStatus: 'applied' }), /有 2 个公式未原样保留/)
  assert.match(note({ formulaLost: 0, formulaStatus: 'unavailable', hasBlockIndex: true }), /没能定位到原文公式/)
  assert.match(note({ formulaLost: 0, formulaStatus: 'partial' }), /部分公式未能还原/)
  assert.match(note({ formulaLost: 0, formulaStatus: 'unavailable', hasBlockIndex: true, formulaSkipped: 1, formulaApplied: 0 }), /选区太短/, 'A13：全部未还原 + 过短 ⇒ 必须报「选区太短」')
  assert.match(note({ formulaLost: 0, formulaStatus: 'partial', formulaSkipped: 1, formulaApplied: 1 }), /部分公式未能还原/, '部分还原时先报 partial')
  assert.equal(note({ formulaLost: 0, formulaStatus: 'applied', formulaApplied: 3, formulaSkipped: 0 }), '', 'applied 时不显示提示')
  assert.equal(note({ formulaLost: 0, formulaStatus: 'applied', formulaApplied: 0, formulaSkipped: 0 }), '')
  // 气泡正文永远是纯译文：提示只在 #tr-note（结构断言）
  assert.ok(!/⚠/.test(READER_HTML.slice(READER_HTML.indexOf('<div id="tr-body">'), READER_HTML.indexOf('<div id="tr-note">'))), '#tr-body 里不得有提示文案')
})

test('E10 失败反馈表（A10 客户端分档）', () => {
  const R = loadReader()
  const f = (e) => ({ ...R.t.trFailure(e) })
  assert.deepEqual(f({ code: 'timeout' }), { status: '翻译超时，请重试', toast: '翻译超时，请重试' })
  assert.deepEqual(f({ clientTimeout: true }), { status: '翻译超时，请重试', toast: '翻译超时，请重试' })
  assert.deepEqual(f({ code: 'network' }), { status: '翻译失败：无法连接端点', toast: '翻译失败：无法连接端点' })
  assert.deepEqual(f({ upstreamStatus: 401 }), { status: '翻译失败：端点拒绝（请检查 API key）', toast: '翻译失败：端点拒绝（HTTP 401）' })
  assert.deepEqual(f({ upstreamStatus: 403 }), { status: '翻译失败：端点拒绝（请检查 API key）', toast: '翻译失败：端点拒绝（HTTP 403）' })
  assert.deepEqual(f({ upstreamStatus: 429 }), { status: '翻译失败：请求过于频繁，稍后再试', toast: '翻译失败：请求过于频繁，稍后再试' })
  assert.deepEqual(f({ upstreamStatus: 503 }), { status: '翻译失败：端点错误（HTTP 5xx）', toast: '翻译失败：端点错误（HTTP 5xx）' })
  assert.deepEqual(f({ upstreamStatus: 400, message: '上游返回 HTTP 400：bad model' }), { status: '翻译失败：上游返回 HTTP 400：bad model', toast: '翻译失败：上游返回 HTTP 400：bad model' })
  assert.deepEqual(f(new Error('boom')), { status: '翻译失败：boom', toast: '翻译失败：boom' })
})

test('E11 端到端（DOM stub）：划词 → 「译」→ 气泡只显示译文 + 公式进请求体且乱码已清', async () => {
  const R = loadReader()
  const idx = buildFormulaIndex(FIXTURE_JSON)
  R.t.setEq(idx)
  R.t.setVariant(null)
  R.t.setZoom(1)
  R.t.setCurrent({ topic: 'lib', name: 'paper' })
  R.t.setPageMode('scroll')
  // 页骨架：page > textLayer > span > 文本节点
  const pageDiv = R.t.makePageNode(1, viewport(), 'orig')
  R.body.appendChild(pageDiv)
  const tl = pageDiv.children.find((c) => c.className === 'textLayer')
  const span = R.doc.createElement('span')
  tl.appendChild(span)
  const line = 'The policy \u03c0\u03b8(a|s) maximises the objective J(\u03b8) over the dataset.'
  const tn = textNode(line)
  span.appendChild(tn)
  R.t.paintEqLayer(pageDiv, viewport(), 1)

  // 选中整行 → 既有「选中即问」链路
  const range = {
    startContainer: tn, endContainer: tn, startOffset: 0, endOffset: line.length,
    commonAncestorContainer: tn,
    intersectsNode: () => true,
    toString: () => line,
    cloneRange() { return this },
    getBoundingClientRect: () => ({ left: 40, top: 100, right: 200, bottom: 112, width: 160, height: 12 }),
  }
  R.win.getSelection = () => ({ toString: () => line, anchorNode: tn, isCollapsed: false, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })
  R.doc.dispatch('mousedown', { target: span, clientX: 10, clientY: 10 })
  R.doc.dispatch('mouseup', { target: span, clientX: 60, clientY: 12 })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(R.els.get('ask-pop').style.display, 'block', '选中即问必须照旧弹出')
  assert.equal(R.els.get('ask-translate').style.display, 'inline-block', '原文视图的纯文字选区必须出现「译」')
  assert.equal(R.els.get('ask-copy').style.display, 'none', '文字选区不得显示复制 LaTeX')

  // 点「译」（记下 innerHTML 写入基线：只有渲染期间的写入才算数。stub 的 innerHTML setter 会累加计数）
  const htmlWritesBefore = [...R.els.values(), ...R.created].reduce((a, e) => a + (e._innerHTMLWrites || 0), 0)
  await R.els.get('ask-translate').onclick()
  const htmlWritesAfter = [...R.els.values(), ...R.created].reduce((a, e) => a + (e._innerHTMLWrites || 0), 0)
  assert.equal(htmlWritesAfter - htmlWritesBefore, 0, '气泡渲染期间绝不允许写 innerHTML')
  const req = R.requests.find((r) => r.url.endsWith('/api/translate-selection'))
  assert.ok(req, '必须走 /api/translate-selection')
  assert.equal(req.body.topic, 'lib')
  assert.equal(req.body.name, 'paper')
  assert.ok(Array.isArray(req.body.chunks) && req.body.chunks.length === 1)
  assert.equal(req.body.chunks[0].kind, 'text')
  assert.ok(!Object.keys(req.body).some((k) => /key|baseUrl|endpoint/i.test(k)), `请求体不得含 key/端点：${Object.keys(req.body)}`)
  assert.equal(R.els.get('ask-pop').style.display, 'none', '点「译」后既有气泡必须隐藏')
  assert.equal(R.els.get('tr-pop').style.display, 'block')
  // 气泡正文**只有**译文本身（提示走独立的 #tr-note，且本响应的公式全部保留 ⇒ 无提示）。
  // 新契约：译文切成文本段/数学段 —— 文本段仍逐字进 textContent，数学段渲染成 .tr-math 元素（vendored KaTeX）。
  const trBody = R.els.get('tr-body')
  const trSegs = trBody.children
  const mathSegs = trSegs.filter((e) => e._classes.has('tr-math'))
  assert.equal(mathSegs.length, 1, `公式段必须渲染成 .tr-math 元素：${trSegs.map((e) => e.className)}`)
  assert.ok(!mathSegs[0]._classes.has('tr-math-fallback'), '合法 LaTeX 不得走降级分支')
  assert.ok(/katex/.test(String(mathSegs[0].children[0]?.className ?? '')), 'KaTeX 必须真的往这个元素里建了 DOM')
  assert.equal(trSegs.filter((e) => !e._classes.has('tr-math')).map((e) => e.textContent).join(''), '这是译文（含 ）',
    '数学段之外的文字必须逐字保留在 textContent 里（顺序与原文一致）')
  assert.equal(R.els.get('tr-status').textContent, '', '成功时不得残留「翻译中…」')
  assert.equal(R.els.get('tr-note').textContent, '', '公式全部保留且渲染成功时不显示提示')
  assert.equal(htmlWritesAfter - htmlWritesBefore, 0, '气泡渲染路径绝不允许写 innerHTML（模型输出不可信）')
  // 译文气泡内部零 button（结构）+ 没有把说明文字混进正文
  assert.ok(!/button/i.test(String(R.els.get('tr-pop').innerHTML ?? '')))
  assert.ok(!String(R.els.get('tr-body').textContent).includes('⚠'))
})

test('E14 端到端：formulaLost>0 出「未原样保留」提示；no-endpoint 弹出既有设置浮层（A7/A9）', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.setZoom(1)
  R.t.setCurrent({ topic: 'lib', name: 'paper' })
  const pageDiv = R.t.makePageNode(1, viewport(), 'orig')
  R.body.appendChild(pageDiv)
  const tl = pageDiv.children.find((c) => c.className === 'textLayer')
  const span = R.doc.createElement('span')
  tl.appendChild(span)
  const line = 'si=Encθ(oi)ˆst+1 where t denotes'
  const tn = textNode(line)
  span.appendChild(tn)
  const range = {
    startContainer: tn, endContainer: tn, startOffset: 0, endOffset: line.length,
    commonAncestorContainer: tn, intersectsNode: () => true,
    toString: () => line, cloneRange() { return this },
    getBoundingClientRect: () => ({ left: 40, top: 100, right: 200, bottom: 112, width: 160, height: 12 }),
  }
  R.win.getSelection = () => ({ toString: () => line, anchorNode: tn, isCollapsed: false, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })
  R.doc.dispatch('mousedown', { target: span, clientX: 10, clientY: 10 })
  R.doc.dispatch('mouseup', { target: span, clientX: 60, clientY: 12 })
  await new Promise((r) => setTimeout(r, 30))
  // ① 模型丢了 1 个公式 → #tr-note 如实提示（A7）
  R.t.setTrResp({ translation: '译文', formulaTotal: 2, formulaKept: 1, formulaLost: 1, formulaApplied: 1, formulaSkipped: 0, formulaStatus: 'applied', hasBlockIndex: true, model: 'm', cached: false, ms: 1 })
  await R.els.get('ask-translate').onclick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(R.els.get('tr-body').textContent, '译文')
  assert.match(String(R.els.get('tr-note').textContent), /有 1 个公式未原样保留/)
  // ② 未配置端点 → 打开既有设置浮层（openCfgPop），气泡如实说明
  R.t.setTrResp({ __status: 503, code: 'no-endpoint', error: '未配置翻译端点：在阅读器里点 ⚙ 填写' })
  await R.els.get('ask-translate').onclick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(R.els.get('cfg-pop').style.display, 'block', '未配置端点必须弹出既有设置浮层')
  assert.match(String(R.els.get('tr-status').textContent), /未配置翻译端点/)
  // ③ 上游 401 → 气泡状态行与 toast 分档（A10）
  R.els.get('cfg-pop').style.display = 'none'
  R.t.setTrResp({ __status: 502, code: 'upstream', upstreamStatus: 401, error: '上游返回 HTTP 401：unauthorized' })
  await R.els.get('ask-translate').onclick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(R.els.get('tr-status').textContent, '翻译失败：端点拒绝（请检查 API key）')
  assert.match(String(R.els.get('toast').textContent), /翻译失败：端点拒绝（HTTP 401）/)
})

test('E12 端到端（DOM stub）：display 公式选区 → 请求体里没有乱码字符、只有紧凑 LaTeX', async () => {
  const R = loadReader()
  const idx = buildFormulaIndex(FIXTURE_JSON)
  R.t.setEq(idx)
  R.t.setVariant(null)
  R.t.setZoom(1)
  R.t.setCurrent({ topic: 'lib', name: 'paper' })
  const pageDiv = R.t.makePageNode(1, viewport(), 'orig')
  R.body.appendChild(pageDiv)
  const tl = pageDiv.children.find((c) => c.className === 'textLayer')
  const span = R.doc.createElement('span')
  tl.appendChild(span)
  R.t.paintEqLayer(pageDiv, viewport(), 1)
  const geo = R.t.EQ_BY_PAGE.get(1)[0]
  // 乱码字符（控制字符 + 私用区 + 走音符号）落在公式盒中心
  const junk = 'si=Enc\u03b8\u0000\u0010\u0011\ue000\u02c6st+1'
  const tn = textNode(junk)
  span.appendChild(tn)
  const cx = (geo.x0 + geo.x1) / 2, cy = (geo.y0 + geo.y1) / 2
  // 每个字符的 rect 都落在盒中心（模拟公式盒覆盖整行）：覆盖 stub 的 createRange
  R.doc.createRange = () => ({
    setStart() {}, setEnd() {},
    getBoundingClientRect: () => ({ left: cx, top: cy, right: cx + 4, bottom: cy + 4, width: 4, height: 4 }),
  })
  const rng = {
    startContainer: tn, endContainer: tn, startOffset: 0, endOffset: junk.length,
    commonAncestorContainer: tn, intersectsNode: () => true,
    toString: () => junk,
    cloneRange() { return this },
    getBoundingClientRect: () => ({ left: cx, top: cy, right: cx + 10, bottom: cy + 10, width: 10, height: 10 }),
  }
  R.win.getSelection = () => ({ toString: () => junk, anchorNode: tn, isCollapsed: false, getRangeAt: () => rng, removeAllRanges() {}, addRange() {} })
  R.doc.dispatch('mousedown', { target: span, clientX: cx, clientY: cy })
  R.doc.dispatch('mouseup', { target: span, clientX: cx + 2, clientY: cy + 2 })
  await new Promise((r) => setTimeout(r, 30))
  await R.els.get('ask-translate').onclick()
  const req = R.requests.find((r) => r.url.endsWith('/api/translate-selection'))
  assert.ok(req)
  assert.equal(req.body.chunks.length, 1, '整段乱码字符必须被合成**一个** formula chunk')
  assert.equal(req.body.chunks[0].kind, 'formula')
  assert.equal(req.body.chunks[0].latex, R.t.eqLatex(idx.equations[0].latex), '必须是紧凑 LaTeX')
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd]/.test(JSON.stringify(req.body)), '请求体里不得出现任何乱码字符')
})

test('E13 既有 /api/ask 请求体字段集合不变（R1 硬红线）', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.setCurrent({ topic: 'lib', name: 'paper' })
  const pageDiv = R.t.makePageNode(1, viewport(), 'orig')
  R.body.appendChild(pageDiv)
  R.t.paintEqLayer(pageDiv, viewport(), 1)
  const tl = pageDiv.children.find((c) => c.className === 'textLayer')
  const span = R.doc.createElement('span')
  tl.appendChild(span)
  const tn = textNode('selected body text')
  span.appendChild(tn)
  const range = {
    startContainer: tn, endContainer: tn, startOffset: 0, endOffset: 18,
    commonAncestorContainer: tn, intersectsNode: () => true,
    toString: () => 'selected body text', cloneRange() { return this },
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 20, width: 90, height: 10 }),
  }
  R.win.getSelection = () => ({ toString: () => 'selected body text', anchorNode: tn, isCollapsed: false, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })
  R.doc.dispatch('mousedown', { target: span, clientX: 10, clientY: 10 })
  R.doc.dispatch('mouseup', { target: span, clientX: 80, clientY: 10 })
  await new Promise((r) => setTimeout(r, 30))
  R.els.get('ask-input').value = '这段什么意思？'
  await R.els.get('ask-send').onclick()
  const req = R.requests.find((r) => r.url.endsWith('/api/ask'))
  assert.ok(req)
  assert.deepEqual(Object.keys(req.body).sort(), ['name', 'page', 'question', 'selectedText', 'topic'])
  assert.equal(req.body.selectedText, 'selected body text')
  assert.equal(req.body.question, '这段什么意思？')
  // 公式引用链路：kind=equation 时 body 多出 kind/equationIndex，且引用串是 $$ … $$
  R.win.getSelection = () => null
  const g = R.t.EQ_BY_PAGE.get(1)[0]
  R.doc.dispatch('mousedown', { target: pageDiv.children[0], clientX: (g.x0 + g.x1) / 2, clientY: (g.y0 + g.y1) / 2 })
  R.doc.dispatch('mouseup', { target: pageDiv.children[0], clientX: (g.x0 + g.x1) / 2, clientY: (g.y0 + g.y1) / 2 })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(R.els.get('ask-copy').style.display, 'inline-block')
  R.els.get('ask-input').value = '这个公式怎么推？'   // showAskPop 会清空输入框，问题文本必须在其后填
  await R.els.get('ask-send').onclick()
  const eqReq = R.requests.filter((r) => r.url.endsWith('/api/ask')).pop()
  assert.deepEqual(Object.keys(eqReq.body).sort(), ['equationIndex', 'kind', 'name', 'page', 'question', 'selectedText', 'topic'])
  assert.equal(eqReq.body.kind, 'equation')
  assert.match(eqReq.body.selectedText, /^\$\$ .+ \$\$$/)
})

/* ══════════════════════════════════════════════════════════════════════════
   G. t6 修复回归：t3 独立验证报告的 F1/F2/F3 + 队长裁定的 D1
      （docs/selection-translate-verification.md §6.1–§6.4、§12）
   三个缺陷都是「静默送错文本」，所以断言分两层：
     ① 行为层：该还原的要还原（且**不丢词**），不该还原的必须**原样返回** + 走诚实文案；
     ② 结构层：钉住机制（openSplit 的 await 顺序、按钮状态），防以后改回去。
   ══════════════════════════════════════════════════════════════════════════ */

/** F1 合成夹具：模拟 Dong p6 的真实形态——块里公式的 LaTeX 命令名（\mathbf/\left/\right）
 *  远多于文本层的退化形态（`st = [st, st−1, …]`），这正是「行走预算被 LaTeX 噪声吃光」的成因。 */
const F1_BLOCK = 'where $\\mathbf { s } _ { t } = \\left[ s _ { t } , s _ { t - 1 } , . . . , s _ { t - k } \\right]$ denotes the sequence of previous latent states and k is the context size.'
const F1_CHUNK = 'where st = [st, st\u22121, ..., st\u2212k] denotes the sequence'

/** F2 合成夹具：选区所属段落**不在**候选集里，但同页另一个块共享 `learner encoder` 字样。 */
const F2_JSON = JSON.stringify({ producer: 'mineru', pageCount: 2, contentList: [
  { type: 'text', page_idx: 0, text: 'During training, an expert encoder distills knowledge while a learner encoder $\\pi _ { \\theta }$ adapts to the task.' },
  { type: 'text', page_idx: 1, text: 'Expert and learner encoders $\\pi _ { \\theta }$ are trained jointly on the dataset.' },
] })

test('F1 行内对齐不得丢掉公式跨度前的正文词（合成夹具，零依赖）', () => {
  const r = alignSelectionToBlock(F1_CHUNK, F1_BLOCK)
  assert.equal(r.applied, 1, `必须还原（否则用户看到的是乱码）：${JSON.stringify(r)}`)
  assert.ok(r.text.startsWith('where '), `跨度必须以块里的 where 开头，实际=${JSON.stringify(r.text)}`)
  assert.ok(r.text.includes('$\\mathbf{s}_t=\\left[s_t,s_{t-1},...,s_{t-k}\\right]$'), '公式必须整段来自块里的紧凑 LaTeX')
  assert.ok(r.text.endsWith('the sequence'), '跨度末尾不得截断')
  assert.equal(r.unpairedLetters, '', '不得有未解释的选区字母')
  assert.equal(r.completedTail, '')

  // 同类边界（都要保住开头那个词）：
  // ① 公式编号前缀 `(4)` 的裸数字允许留在外面（它不是正文词）
  const withNum = alignSelectionToBlock(' (4)' + F1_CHUNK, F1_BLOCK)
  assert.equal(withNum.applied, 1)
  assert.ok(withNum.text.includes('where'), `公式编号前缀不得吃掉正文词：${withNum.text}`)
  // ② 选区尾部多一个块外的孤立符号
  const withDot = alignSelectionToBlock(F1_CHUNK + ' \u00b7', F1_BLOCK)
  assert.equal(withDot.applied, 1)
  assert.ok(withDot.text.includes('where'))
  // ③ 纯正文（块里没有公式）也必须原样、不得引入 $
  const prose = alignSelectionToBlock('where n denotes total trajectory length', 'where n denotes total trajectory length. Aligning expert and learner encoders improves eficiency.')
  assert.equal(prose.applied, 1)
  assert.ok(!/\$/.test(prose.text), `纯正文不得引入 $：${prose.text}`)
  // ④ 机制不变式：块侧跳过只允许落在 `$…$` 片段内 —— 正文里要求跳字（`alpha gamma delta`）必须拒绝
  const skipProse = alignSelectionToBlock('alpha gamma delta', 'alpha beta gamma delta epsilon $z _ { t }$ zeta')
  assert.equal(skipProse.applied, 0, '要跳过正文词才能接上的选区必须拒绝（张冠李戴）')
  assert.equal(skipProse.reason, 'gate')
})

test('F2 本段不在候选集里时不得被别的段落接走（合成夹具，零依赖）', () => {
  const idx = buildTextBlockIndex(F2_JSON)
  assert.equal(idx.blocks.length, 2)
  // 反向对照：同页另一个块「共享 learner encoder 字样」，逐块直测也必须拒绝
  const other = idx.blocks.find((b) => b.page === 2)
  const direct = alignSelectionToBlock(', while a learner encoder', other.text)
  assert.equal(direct.applied, 0, `别的段落不得接走它：${JSON.stringify(direct)}`)
  assert.equal(direct.reason, 'gate')
  assert.ok(direct.unpairedLetters.length > 0, '必须是因为选区侧有字母没被解释而拒绝')

  for (const chunk of [', while a learner encoder', 'During', 'training,']) {
    // ① F2：选区落在第 2 页（本段在第 1 页）→ 必须原样送出，applied=0
    const bad = assembleSource([{ page: 2, kind: 'text', text: chunk }], idx)
    assert.equal(bad.applied, 0, `${chunk} 不得被别段接走`)
    assert.equal(bad.source, chunk, '拒绝时必须**原样**返回选区文本')
    assert.equal(formulaStatusOf(bad), 'unavailable', '诚实降级：状态让客户端出「没能定位到原文公式」提示')
    // ② 正对照：同一个块在第 1 页（本段就在那里）→ 必须还原（证明不是「一律拒绝」）
    const good = assembleSource([{ page: 1, kind: 'text', text: chunk }], idx)
    assert.equal(good.applied, 1, `本段在候选集里时必须还原：${chunk}`)
    assert.ok(/learner encoder|During|training/.test(good.source), `正对照输出异常：${good.source}`)
  }
})

test('F2-续 端点补词门槛：词尾补全必须有换行连字符（`Instruction:` 不得被 `instructions` 接走）', () => {
  const r = alignSelectionToBlock('Instruction:', 'The instructions are given to the agent.')
  assert.equal(r.applied, 0, '图注 Instruction: 不得被块里的 instructions 接走（t3 p9 同类现象）')
  assert.ok(r.completedTail.length > 0, '拒绝原因必须是端点补词越界')
  // 反向：换行断词（文本层的 `com-` 与下一行 `pact`）**必须**照常还原 —— 那是正常断行，不是缺陷
  const head = alignSelectionToBlock('we replace high-dimensional RGB images with com-', 'we replace high-dimensional RGB images with compact world-model latents.')
  assert.equal(head.applied, 1)
  assert.ok(head.text.endsWith('compact'), `断词前半必须补成完整的 compact：${head.text}`)
  const tail = alignSelectionToBlock('pact world-model latents.', 'we replace high-dimensional RGB images with compact world-model latents.')
  assert.equal(tail.applied, 1)
  assert.ok(tail.text.startsWith('compact'), `断词后半必须接上 compact：${tail.text}`)
})

test('F1/F2 真实样本：Dong p6 的 where 丢词与三个张冠李戴 chunk（无产物时 skip）', (t) => {
  if (!REAL_BEST) return t.skip('本机没有真实 MinerU 产物')
  const raw = REAL_BEST.raw
  const idx = buildTextBlockIndex(raw)
  const p6 = idx.blocks.filter((b) => b.page === 6)
  const f1block = p6.find((b) => b.text.startsWith('where $\\mathbf{s}_t'))
  if (!f1block) return t.skip('该产物的 p6 形态与本机样本不同（缺 F1 夹具块）')
  // F1：真实验证方的最小复现（.probe/verify-t3/p2-align-repro.mjs 的 C2/C4）
  for (const chunk of ['where st = [st, st\u22121, ..., st\u2212k] denotes the sequence', ' (4)where st = [st, st\u22121, ..., st\u2212k] denotes the sequence']) {
    const r = alignSelectionToBlock(chunk, f1block.text)
    assert.equal(r.applied, 1, `真实样本必须还原：${chunk}`)
    assert.ok(r.text.includes('where'), `不得丢掉 where：${r.text}`)
  }
  // F2：选区在第 6 页，而它所属的段落（page_idx 属第 5 页）不在第 6 页候选集里
  for (const chunk of [', while a learner encoder', 'During', 'training,', 'forcing (DF) (Chen et al., 2024; Song et al., 2025) to']) {
    const asm = assembleSource([{ page: 6, kind: 'text', text: chunk }], idx)
    assert.equal(asm.applied, 0, `${chunk} 不得被第 6 页的别段接走`)
    assert.equal(asm.source, chunk, '必须原样返回')
    for (const b of p6) {
      assert.equal(alignSelectionToBlock(chunk, b.text).applied, 0, `${chunk} 不得命中任何第 6 页块`)
    }
  }
})

test('F3 刷新后恢复分屏：openSplit 必须先 await ensurePdfjs（pdf.js 未就绪时）', async () => {
  const R = loadReader()
  R.t.setCurrent({ topic: 'lib', name: 'paper' })
  R.t.setZhState({ zh: true, dual: false, busy: false })
  const urls = []
  const stubDoc = (n) => ({
    numPages: n,
    getPage: async () => ({
      getViewport: () => viewport(),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: () => ({ items: [] }),
      destroy: async () => {},
    }),
  })
  const lib = {
    GlobalWorkerOptions: {},
    TextLayer: class { async render() {} },
    getDocument: ({ url }) => { urls.push(url); return { promise: Promise.resolve(stubDoc(2)) } },
  }
  R.t.armColdPdfjs(lib)   // 复现时序：pdfjsLib 未就绪，只有 ensurePdfjs 能把它装上
  R.t.setView('split')
  await R.t.openSplit()
  assert.equal(R.t.getView(), 'split', '恢复分屏不得回落到原文')
  assert.ok(R.t.getPdfDocZh(), '中文列文档必须装上')
  assert.ok(urls.some((u) => u.includes('variant=zh')), `必须真的拉了 -zh.pdf：${JSON.stringify(urls)}`)
  assert.ok(urls.some((u) => !u.includes('variant=')), '原文列也要装上')
  // toast 元素可能还没被创建（没弹过 toast）→ 用 getElementById 取（会自动建）
  assert.ok(!String(R.doc.getElementById('toast').textContent).includes('打开中文版失败'), '不得出现「pdfjsLib is not defined」类失败提示与回落 toast')

  // 结构层：openSplit 里 `await ensurePdfjs()` 必须早于第一次触 pdfjsLib（与 loadPdf 同一条通道）
  const at = SCRIPT_SRC.indexOf('async function openSplit')
  const body = SCRIPT_SRC.slice(at, SCRIPT_SRC.indexOf('\n}\n', at))
  const atEnsure = body.indexOf('await ensurePdfjs()')
  const atLib = body.indexOf('pdfjsLib.getDocument')   // 注释里也提到 pdfjsLib，所以盯调用点
  assert.ok(atEnsure > 0, `openSplit 必须先 await ensurePdfjs（F3）`)
  assert.ok(atLib > atEnsure, `ensurePdfjs 必须在触 pdfjsLib 之前：ensure@${atEnsure} lib@${atLib}`)
})

test('D1 无任何变体时「对照/分屏」按钮可见但 disabled，且 title 说明原因（队长裁定）', () => {
  const R = loadReader()
  R.t.setCurrent({ topic: 't', name: 'n' })
  R.t.setZhState({ zh: false, dual: false, busy: false })
  R.t.updateViewButtons()
  const dt = R.els.get('dual-toggle'), st = R.els.get('split-toggle')
  for (const [name, btn, want] of [['对照', dt, /先用「中」生成/], ['分屏', st, /还没有中文版/]]) {
    assert.notEqual(btn.style.display, 'none', `${name} 按钮必须可见（disabled 而不是隐藏）`)
    assert.equal(btn.disabled, true, `${name} 按钮必须 disabled`)
    assert.match(String(btn.title), want, `${name} 按钮的 title 必须说明原因`)
  }
  // 有 zh 无 dual：对照仍 disabled 且可见，分屏可用
  R.t.setZhState({ zh: true, dual: false, busy: false })
  R.t.updateViewButtons()
  assert.notEqual(dt.style.display, 'none')
  assert.equal(dt.disabled, true)
  assert.equal(st.disabled, false)
  // 有 dual 无 zh：分屏 disabled，且 title 指出模式 B 需要 -zh.pdf
  R.t.setZhState({ zh: false, dual: true, busy: false })
  R.t.updateViewButtons()
  assert.equal(st.disabled, true)
  assert.notEqual(st.style.display, 'none')
  assert.match(String(st.title), /需先生成中文版/)
  // busy 时两者都 disabled（title 复用阶段说明）
  R.t.setZhState({ zh: true, dual: true, busy: true, phase: '翻译进行中' })
  R.t.updateViewButtons()
  assert.equal(dt.disabled, true)
  assert.equal(st.disabled, true)
  assert.match(String(dt.title), /翻译进行中/)
})

/* ══════════════════════════════════════════════════════════════════════════
   H. t7 修复回归：t4 评审的 R-01…R-07（docs/selection-translate-review.md §12）
   口径与评审一致：**注入变异后这些用例必须变红**（变异证据见任务输出）。
   ══════════════════════════════════════════════════════════════════════════ */

/** 在某一列的页节点上做一次真实划选（mousedown+mouseup → 既有「选中即问」链路）。 */
function selectInColumn(R, doc, line, pageNo = 1) {
  const pageDiv = R.t.makePageNode(pageNo, viewport(), doc)
  R.body.appendChild(pageDiv)
  const tl = pageDiv.children.find((c) => c.className === 'textLayer')
  const span = R.doc.createElement('span')
  tl.appendChild(span)
  const tn = textNode(line)
  span.appendChild(tn)
  const rect = { left: 40, top: 100, right: 200, bottom: 112, width: 160, height: 12 }
  const range = {
    startContainer: tn, endContainer: tn, startOffset: 0, endOffset: line.length,
    commonAncestorContainer: tn, intersectsNode: () => true,
    toString: () => line, cloneRange() { return this }, getBoundingClientRect: () => rect,
  }
  R.win.getSelection = () => ({ toString: () => line, anchorNode: tn, isCollapsed: false, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })
  R.doc.dispatch('mousedown', { target: span, clientX: 10, clientY: 10 })
  R.doc.dispatch('mouseup', { target: span, clientX: 60, clientY: 12 })
  return pageDiv
}

const TICK = () => new Promise((r) => setTimeout(r, 30))
const okResp = (translation) => ({
  translation, formulaTotal: 1, formulaKept: 1, formulaLost: 0,
  formulaApplied: 1, formulaSkipped: 0, formulaStatus: 'applied', hasBlockIndex: true,
  model: 'm', cached: false, ms: 1,
})

test('R-01 在飞请求必须失效：新选区/换文献后旧响应不得盖到新锚点上', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.setZoom(1)
  R.t.setCurrent({ topic: 'lib', name: 'paper' })
  selectInColumn(R, 'orig', 'the first paragraph selection')
  await TICK()
  assert.equal(R.els.get('ask-translate').style.display, 'inline-block')

  // 挂起这次翻译的响应（慢端点：服务端 30s / 客户端 45s 窗口内用户重选）
  R.t.setTrResp(okResp('【第一段选区的译文】'))
  R.ctrl.hold = true
  const inflight = R.els.get('ask-translate').onclick()
  await TICK()
  assert.equal(R.els.get('tr-status').textContent, '翻译中…', '旧请求必须处于在飞状态')
  assert.equal(R.els.get('tr-body').textContent, '')

  // 用户重新划选（showAskPop 是唯一的「新选区/新引用」入口）→ 在飞请求必须失效
  const seqBefore = R.t.getTrSeq()
  selectInColumn(R, 'orig', 'the second paragraph selection', 2)
  await TICK()
  assert.ok(R.t.getTrSeq() > seqBefore, `新选区必须使在飞请求失效：${seqBefore} → ${R.t.getTrSeq()}`)
  R.ctrl.release()
  await inflight
  await TICK()
  assert.ok(!String(R.els.get('tr-body').textContent).includes('第一段选区的译文'), `旧译文不得写进新锚点的气泡：${R.els.get('tr-body').textContent}`)
  assert.equal(R.els.get('tr-body').textContent, '')
  assert.notEqual(R.els.get('tr-pop').style.display, 'block', '新选区后译文气泡不得停在可见态')
  // 失效不能把「译」卡死：busy 必须已复位，新的一次翻译照常出译文
  assert.equal(R.t.getTrBusy(), false, 'invalidateTranslate 必须复位 busy（否则「译」永久失效）')
  R.t.setTrResp(okResp('【新选区的译文】'))
  await R.els.get('ask-translate').onclick()
  await TICK()
  assert.equal(R.els.get('tr-body').textContent, '【新选区的译文】', '失效之后必须还能正常翻译')
})

test('R-01-续 openPaper 换文献同样让在飞请求失效', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.armPdfjs({ GlobalWorkerOptions: {}, TextLayer: class { async render() {} }, getDocument: () => ({ promise: Promise.resolve(docStub(2)) }) })
  R.t.setCurrent({ topic: 'lib', name: 'A' })
  selectInColumn(R, 'orig', 'selection on paper A')
  await TICK()
  R.t.setTrResp(okResp('【A 的译文】'))
  R.ctrl.hold = true
  const inflight = R.els.get('ask-translate').onclick()
  await TICK()
  const seqBefore = R.t.getTrSeq()
  await R.t.openPaper('lib', 'B')          // 换文献
  assert.ok(R.t.getTrSeq() > seqBefore, `换文献必须使在飞请求失效：${seqBefore} → ${R.t.getTrSeq()}`)
  R.ctrl.release()
  await inflight
  await TICK()
  assert.equal(R.els.get('tr-body').textContent, '', 'A 的译文不得落到 B 的气泡上')
})

test('R-02 原地换文献必须先退出分屏（中文列不得留着上一篇）', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.setZoom(1)
  R.t.armPdfjs({ GlobalWorkerOptions: {}, TextLayer: class { async render() {} }, getDocument: () => ({ promise: Promise.resolve(docStub(2)) }) })
  // 第一篇：真的进分屏（走 openSplit：加 .on、拉两个文档、两列同渲）
  R.t.setCurrent({ topic: 'lib', name: 'A' })
  R.t.setZhState({ zh: true, dual: false, busy: false })
  R.t.setView('split')
  await R.t.openSplit()
  const wrap = R.doc.getElementById('split-wrap')
  assert.ok(wrap.classList.contains('on'), '前置：必须真的进了分屏')
  assert.ok(R.t.getPdfDocZh(), '前置：中文文档已装上')
  assert.ok(R.doc.getElementById('pdf-pages-zh').children.length > 0, '前置：中文列有页节点')

  // 换到第二篇：**有 -zh.pdf**（/api/zh 响应 zh:true）且持久化视图不是 split
  await R.t.openPaper('lib', 'B')
  assert.equal(R.t.getView(), 'orig', '换文献后视图必须是原文（持久化未记 split）')
  assert.equal(R.t.getPdfDocZh(), null, '上一篇的中文文档必须释放')
  assert.ok(!wrap.classList.contains('on'), '分屏容器必须退掉')
  assert.equal(R.doc.getElementById('pdf-pages-zh').children.length, 0, '中文列页节点必须清空')
  assert.equal(R.doc.getElementById('pdf-pane-zh').style.display, 'none', '中文列必须隐藏')
})

test('R-03 文本层里的字面 $ 必须被中和（否则 A7 的公式保全校验被击穿）', () => {
  const asm = assembleSource(
    [{ page: 1, kind: 'text', text: 'cost $5 and ' }, { page: 1, kind: 'formula', latex: 'x_t' }],
    buildTextBlockIndex(null),
  )
  assert.equal(asm.source, 'cost \uff045 and $x_t$', `字面 $ 必须中和成全角：${JSON.stringify(asm.source)}`)
  assert.equal((asm.source.match(/\$/g) ?? []).length % 2, 0, '$ 必须成对')
  assert.deepEqual(formulaTokens(asm.source), ['$x_t$'], '唯一 token 必须是真的那个公式')
  // A7 恢复可判定：模型丢掉真公式时必须能报出来
  assert.deepEqual(verifyFormulas(asm.source, '成本 \uff045 与 $x_t$ 结束'), { total: 1, kept: 1, lost: 0, missing: [] })
  assert.deepEqual(verifyFormulas(asm.source, '成本 \uff045 与 xt 结束'), { total: 1, kept: 0, lost: 1, missing: ['$x_t$'] })
  // 两个字面 $ + 一个真公式：不得把 `$5 ... $` 配成假片段
  const asm2 = assembleSource(
    [{ page: 1, kind: 'text', text: 'cost $5 and $9 for ' }, { page: 1, kind: 'formula', latex: 'y' }],
    buildTextBlockIndex(null),
  )
  assert.deepEqual(formulaTokens(asm2.source), ['$y$'], `假片段不得出现：${JSON.stringify(formulaTokens(asm2.source))}`)
  // 对齐成功的那一段（块跨度里的 $…$ 是**真**公式）不得被中和
  const asm3 = assembleSource([{ page: 1, kind: 'text', text: DEG_B }], IDX)
  assert.equal(asm3.applied, 1)
  assert.ok(asm3.source.includes('$\\pi_\\theta(a|s)$'), '块跨度里的真公式必须逐字保留')
})

test('R-04 网络异常文本必须过 sanitizeDetail（key 不得经响应体到前端）', async () => {
  const key = 'sk-reviewer-secret-abcdefghijklmnopqrstuvwxyz'
  const ep = { baseUrl: `https://user:${key}@example.invalid/v1`, apiKey: key, model: 'm' }
  const err = await translateSelection(ep, 'hello', {
    cache: new TranslateSelectionCache(),
    fetchImpl: () => { throw new Error(`fetch failed for https://example.invalid/v1?key=${key}`) },
  }).catch((e) => e)
  assert.equal(err.code, 'network')
  assert.ok(!err.message.includes(key), `网络异常文案不得含 key：${err.message}`)
  assert.ok(err.message.startsWith('无法连接端点：'), `行为文案保持：${err.message}`)
  const err2 = await translateSelection(ep, 'hello', {
    cache: new TranslateSelectionCache(),
    fetchImpl: () => { const e = new Error('boom'); e.cause = new Error(`headers: authorization: Bearer ${key}`); throw e },
  }).catch((e) => e)
  assert.ok(!err2.message.includes(key), `cause 里的 key 必须被清掉：${err2.message}`)
  const err3 = await translateSelection(ep, 'hello', {
    cache: new TranslateSelectionCache(),
    fetchImpl: () => { const e = new Error('fetch failed'); e.cause = new Error('ECONNREFUSED'); throw e },
  }).catch((e) => e)
  assert.match(err3.message, /ECONNREFUSED/, '必须保留可读的失败原因')
})

test('R-06 三个冻结阈值必须可达（放宽任一个都会被本用例钉住）', () => {
  // ① ratio 上界（内容口径）：公式的 LaTeX 内容远多于文本层退化形态 ⇒ ratio 出上界，
  //    且这条夹具的其它闸门都通过（unpaired/端点补词皆空）⇒ 只能是 RATIO_HI 拦下的
  const upper = alignSelectionToBlock('plan zq( | s, I) then', 'plan $z _ { \\mathrm { plan } } \\sim q _ { \\mathrm { learner } } ( \\cdot | s _ { t } , I _ { c l i p } )$ then')
  assert.equal(upper.applied, 0, `ratio 上界必须拒绝：${JSON.stringify(upper)}`)
  assert.ok((upper.ratio ?? 0) > 1.35, `拒绝原因必须是 ratio 超上界：ratio=${upper.ratio}`)
  assert.equal(upper.unpairedLetters, '', '这条夹具不应由别的门槛解释')
  assert.equal(upper.completedTail, '')
  // ② 覆盖门槛（unpaired 字母）：选区里有块里没有的字母 ⇒ 本段不在候选块里
  const unpaired = alignSelectionToBlock('3 LCVN: Language-Conditioned Vi-', 'language-conditioned visual navigation is a hard task.')
  assert.equal(unpaired.applied, 0, `unpaired 门槛必须拒绝：${JSON.stringify(unpaired)}`)
  assert.ok(String(unpaired.unpairedLetters).length > 0, `拒绝原因必须是未解释字母：${unpaired.unpairedLetters}`)
  // ③ MIN_SCORE 可达：score=0.727 < 0.75，而 ratio 在界内、无未解释字母、无端点补词
  const lowScore = alignSelectionToBlock('12 3 abcdefgh', 'abcdefgh xxxx')
  assert.equal(lowScore.applied, 0, `MIN_SCORE 必须可达：${JSON.stringify(lowScore)}`)
  assert.ok((lowScore.score ?? 1) < 0.75, `score 必须低于阈值：${lowScore.score}`)
  assert.ok((lowScore.ratio ?? 0) >= 0.6 && (lowScore.ratio ?? 9) <= 1.35, `ratio 必须在界内（否则不是 score 解释的）：${lowScore.ratio}`)
  assert.equal(lowScore.unpairedLetters, '', '不得由 unpaired 解释')
  assert.equal(lowScore.completedTail, '', '不得由 completedTail 解释')
})

test('R-07 分屏中文列的选区不显示「译」（按列禁用），原文列不受影响', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)   // 分屏时 zhVariant 刻意是 null（C17）——所以必须靠 data-doc 判别
  R.t.setCurrent({ topic: 'lib', name: 'paper' })

  const zhLine = 'the chinese column line'
  selectInColumn(R, 'zh', zhLine)
  await TICK()
  assert.equal(R.t.getAsk().doc, 'zh', '选区必须记录所在列（data-doc）')
  assert.equal(R.t.getAsk().text, zhLine, '选中即问本身在中文列仍应正常（只是没有「译」）')
  assert.equal(R.els.get('ask-pop').style.display, 'block')
  assert.equal(R.els.get('ask-translate').style.display, 'none', '中文列不得出现「译」')
  const before = R.requests.filter((r) => String(r.url).endsWith('/api/translate-selection')).length
  await R.t.translateSelection()
  assert.equal(R.requests.filter((r) => String(r.url).endsWith('/api/translate-selection')).length, before, '中文列不得发出翻译请求')

  selectInColumn(R, 'orig', 'the original column line', 2)
  await TICK()
  assert.equal(R.t.getAsk().doc, 'orig')
  assert.equal(R.els.get('ask-translate').style.display, 'inline-block', '原文列必须照常出现「译」')
})

test('R-04-续 testTranslateEndpoint 的 catch 分支同样脱敏（同类既有代码，t4 评审 R-04 的「一并修」）', async () => {
  // 该路径的 detail 会进 /api/translate/config 的响应体、再上屏（设置浮层）⇒ 必须脱敏。
  // 用例放在本文件（新的、未跟踪的测试文件）：既有的 test/translate-precheck-redaction.test.mjs
  // 受 VC1 守卫「既有测试文件零改动」保护，不得修改。
  const { testTranslateEndpoint } = await import(pathToFileURL(dist('translate-config.js')).href)
  const key = 'sk-catch-branch-abcdefghijklmnopqrstuvwxyz'
  const realFetch = globalThis.fetch
  try {
    for (const [msg, causeMsg] of [[`fetch failed for http://127.0.0.1:1/v1?key=${key}`, 'ECONNREFUSED'], ['boom', `authorization: Bearer ${key}`]]) {
      globalThis.fetch = () => { const e = new Error(msg); e.cause = new Error(causeMsg); throw e }
      const r = await testTranslateEndpoint({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: key, model: 'm' })
      assert.equal(r.ok, false)
      assert.equal(r.detail.includes(key), false, `catch 分支不得泄露 apiKey：${r.detail}`)
      assert.match(r.detail, /ECONNREFUSED|bearer|boom|fetch failed/i, `仍要保留可读原因：${r.detail}`)
    }
  } finally {
    globalThis.fetch = realFetch
  }
  // 缺项判断与 happy-path 文案不变（既有的 test/translate-precheck-redaction.test.mjs 继续覆盖）
  assert.deepEqual(await testTranslateEndpoint({ baseUrl: '', apiKey: 'k', model: 'm' }), { ok: false, detail: '端点配置不完整（需要 url + key + 模型）' })
})

/* ══════════════════════════════════════════════════════════════════════════
   I. t9 修复回归：t8 复审的 N-01…N-04（docs/selection-translate-review-r2.md §5）
   口径同前：**注入回缺陷态后这些用例必须变红**（变异证据见任务输出）。
   ══════════════════════════════════════════════════════════════════════════ */

test('N-01 openPaper 的失效必须在第一处 await 之前（窗口内旧响应不得点亮气泡）', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.armPdfjs({ GlobalWorkerOptions: {}, TextLayer: class { async render() {} }, getDocument: () => ({ promise: Promise.resolve(docStub(2)) }) })
  R.t.setCurrent({ topic: 'lib', name: 'A' })
  selectInColumn(R, 'orig', 'selection on paper A')
  await TICK()
  R.t.setTrResp(okResp('【A 的译文】'))
  R.ctrl.hold = true
  const inflight = R.els.get('ask-translate').onclick()   // 挂起的旧翻译
  await TICK()
  assert.equal(R.els.get('tr-status').textContent, '翻译中…')

  // 换文献：把 openPaper 卡在**第一处 await**（/api/paper）上，模拟 P-A3 的窗口
  const seqBefore = R.t.getTrSeq()
  R.ctrl.holdMeta = true
  const paperP = R.t.openPaper('lib', 'B')   // 故意不 await
  await TICK()
  assert.ok(R.t.getTrSeq() > seqBefore, `失效必须发生在第一处 await 之前：${seqBefore} → ${R.t.getTrSeq()}`)

  // 此刻放行旧响应：窗口内到达也不得点亮气泡
  R.ctrl.release()
  await inflight
  await TICK()
  assert.equal(R.els.get('tr-body').textContent, '', '窗口内到达的旧译文不得写进气泡')
  assert.notEqual(R.els.get('tr-pop').style.display, 'block', '窗口内不得点亮译文气泡')
  // 收尾：放行 /api/paper，openPaper 正常走完
  assert.equal(typeof R.ctrl.releaseMeta, 'function')
  R.ctrl.releaseMeta()
  await paperP
  assert.equal(R.els.get('tr-body').textContent, '')
})

test('N-02 对齐跨度里的字面 $ 不得配成伪 token（组装期统计 token + 中和）', () => {
  // 评审 P-F2 的等价夹具：块正文里真的印了两个字面 $（货币写法）+ 一个真公式
  const J = JSON.stringify({ contentList: [{ type: 'text', page_idx: 0, text: 'the cost is $5 up to $10 then $x _ { t }$ ends' }] })
  const idx = buildTextBlockIndex(J)
  const sel = 'the cost is 5 up to 10 then t ends'
  const asm = assembleSource([{ page: 1, kind: 'text', text: sel }], idx)
  assert.equal(asm.applied, 1, '前置：这段必须是对齐成功的（缺陷只在**对齐分支**）')
  // 组装期收集的 token：只含真公式
  assert.deepEqual(asm.formulaTokens, ['$x_t$'], `组装期 token 必须只含真公式：${JSON.stringify(asm.formulaTokens)}`)
  // 最终字符串里的 $ 也都成对且都是真公式（字面 $ 已中和成全角）
  assert.equal(asm.source, 'the cost is \uff045 up to \uff0410 then $x_t$ ends')
  assert.equal((asm.source.match(/\$/g) ?? []).length % 2, 0)
  assert.deepEqual(formulaTokens(asm.source), ['$x_t$'], '字符串解析结果必须与组装期列表一致')
  // 自然翻译（模型丢掉字面 $）**不得**触发假警告：真公式保留 ⇒ lost=0
  const v = verifyFormulas(asm.source, '花费是 \uff045 到 \uff0410，然后 $x_t$ 结束')
  assert.deepEqual(v, { total: 1, kept: 1, lost: 0, missing: [] })
  // 反之，模型真把公式丢了必须报出来（诚实提示不能被这次修复削弱）
  assert.deepEqual(verifyFormulas(asm.source, '花费是 5 到 10，然后 xt 结束'), { total: 1, kept: 0, lost: 1, missing: ['$x_t$'] })
  // 显式传 token 列表的入口（路由/组装方用）与字符串解析等价
  assert.deepEqual(verifyFormulas(asm.source, '花费是 \uff045 到 \uff0410，然后 $x_t$ 结束', asm.formulaTokens), { total: 1, kept: 1, lost: 0, missing: [] })
  // 未对齐分支的既有行为（R-03）不得回退：字面 $ 全部中和
  const plain = assembleSource([{ page: 1, kind: 'text', text: 'cost $5 and ' }, { page: 1, kind: 'formula', latex: 'x_t' }], buildTextBlockIndex(null))
  assert.equal(plain.source, 'cost \uff045 and $x_t$')
  assert.deepEqual(plain.formulaTokens, ['$x_t$'])
  // isLatexLikeFragment 的判据（导出给测试）：真公式保留、自然语言片段判为非公式
  assert.equal(isLatexLikeFragment('$x_t$'), true)
  assert.equal(isLatexLikeFragment('$F$'), true, '紧凑的纯符号公式必须算 LaTeX（无空白）')
  assert.equal(isLatexLikeFragment('$5 up to $'), false, '带空白的自然语言片段不算公式')
  assert.equal(isLatexLikeFragment('$\\text{ s.t. }$'), true, '含命令的片段即使有空白也算公式')
})

test('N-03 translateSelection 的列判别守卫（第二道防线）必须有自己的覆盖', async () => {
  const R = loadReader()
  R.t.setEq(buildFormulaIndex(FIXTURE_JSON))
  R.t.setVariant(null)
  R.t.setCurrent({ topic: 'lib', name: 'paper' })
  // 绕过按钮可见性，直接构造「中文列的选区」并调用入口（模拟将来有人放宽可见性判别）
  const rangeOver = (pageDiv, line) => {
    const tl = pageDiv.children.find((c) => c.className === 'textLayer')
    const tn = tl.children[0].children[0]          // textLayer > span > 文本节点
    return {
      startContainer: tn, endContainer: tn, startOffset: 0, endOffset: line.length,
      commonAncestorContainer: tn, intersectsNode: () => true,
      toString: () => line, cloneRange() { return this },
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 20, width: 90, height: 10 }),
    }
  }
  const zhLine = 'chinese column line'
  const zhDiv = selectInColumn(R, 'zh', zhLine)
  await TICK()
  R.t.setAsk({ text: zhLine, page: 1, kind: 'text', doc: 'zh', range: rangeOver(zhDiv, zhLine) })
  const before = R.requests.filter((r) => String(r.url).endsWith('/api/translate-selection')).length
  R.doc.getElementById('toast').textContent = ''
  await R.t.translateSelection()
  await TICK()
  assert.equal(R.requests.filter((r) => String(r.url).endsWith('/api/translate-selection')).length, before, '中文列不得发出翻译请求')
  assert.equal(String(R.doc.getElementById('toast').textContent), '', '入口守卫必须静默返回（不得弹「选区已失效/页面已重绘」误导文案）')
  // 对照：原文列同一构造必须照常发请求（证明上面不是因为别的原因静默）
  const origLine = 'original column line'
  const origDiv = selectInColumn(R, 'orig', origLine, 2)
  await TICK()
  R.t.setAsk({ text: origLine, page: 2, kind: 'text', doc: 'orig', range: rangeOver(origDiv, origLine) })
  R.t.setTrResp(okResp('【原文列译文】'))
  await R.t.translateSelection()
  await TICK()
  assert.equal(R.requests.filter((r) => String(r.url).endsWith('/api/translate-selection')).length, before + 1, '原文列必须照常请求')
})

test('N-04 RATIO_LO 可达：只有它能拦下的候选（夹具钉住，改 0 即红）', () => {
  // 配对落在 LaTeX 命令名（`\beta`）的字母上，contentNormForRatio 把命令名整体剔除 ⇒ 跨度内容长度≈0
  const r = alignSelectionToBlock('beta', 'the $\\beta$ schedule is warmup')
  assert.equal(r.applied, 0, `RATIO_LO 必须能把住这个候选：${JSON.stringify(r)}`)
  assert.equal(r.score, 1, '配对分数是满分（否则不是 RATIO_LO 解释的）')
  assert.equal(r.ratio, 0, '跨度内容长度为 0')
  assert.equal(r.unpairedLetters, '', '不得由覆盖门槛解释')
  assert.equal(r.completedTail, '', '不得由端点补词解释')
  // 同型：正文里拼写出来的希腊字母
  const r2 = alignSelectionToBlock('the alpha', 'the $\\alpha$ schedule is warmup')
  assert.equal(r2.applied, 0)
  assert.ok((r2.ratio ?? 9) < 0.6, `ratio 必须低于下界（否则不是 RATIO_LO 解释的）：${r2.ratio}`)
  assert.equal(r2.unpairedLetters, '')
  assert.equal(r2.completedTail, '')
  // 反向：真正的公式行不受影响（下界不会误伤正常还原）
  const ok = alignSelectionToBlock('the beta schedule is warmup', 'the $\\beta$ schedule is warmup')
  assert.equal(ok.applied, 1)
  assert.ok(ok.text.includes('$\\beta$'))
})
