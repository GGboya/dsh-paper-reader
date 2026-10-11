// translate-selection.ts — 划词翻译（公式保留）的服务端核心。
//
// 契约：docs/selection-translate-requirements.md §3.3–§3.8（冻结 v1）。本模块只做**服务端**
// 的部分，且全部纯函数化（`fetchImpl` 可注入 ⇒ 单测不需要网络、不产生费用）：
//   ① `alignSelectionToBlock`：行内公式还原（文本层退化文本 ↔ MinerU text 块文本对齐，§3.4）
//   ② `assembleSource`：把客户端的 chunk 序列组装成「公式已是单 $ 定界紧凑 LaTeX」的源文本
//   ③ `buildRequestBody`：写死的 system 提示词 + §3.6 的请求体
//   ④ `translateSelection`：调用端点（含唯一的 temperature 重试）+ 响应清洗 + 内存 LRU
//   ⑤ `verifyFormulas`：把「译文原样保留公式」从口头要求变成可判定断言（§3.6-4）
//
// ⚠️ 为什么行内还原在服务端（§3.4 / C8）：客户端拿不到块文本；`compactLatex` 是 TS 侧函数，
// 阅读器是单文件内联脚本、没有打包器，复制一份必然与 src/formulas.ts 漂移；而放在这里
// 可以用 `node --test` 直接构造成本极低的攻击用例。
//
// ⚠️ 日志红线（§3.7③）：本模块**只**允许打印 `{model, status, ms, chars}` ——
// 绝不把端点对象或配置对象送进日志，API key 不进日志、不进响应、不进错误文案。

import { createHash } from 'node:crypto'
import { compactLatex, type TextBlockIndex } from './formulas.ts'
import { sanitizeDetail } from './mineru.ts'
import type { TranslateEndpoint } from './translate.ts'

/* ── 冻结参数表（§3.4；调参必须回改需求文档）────────────────────────────── */
/** 最短可对齐归一化长度 */
export const MIN_NORM = 4
/** 种子长度上下限 */
export const SEED_MAX = 12
export const SEED_MIN = 4
/** 跳过预算系数：`max(4, ceil(0.4*|S|))` */
export const SKIP_RATIO = 0.4
/** 接受阈值 */
export const MIN_SCORE = 0.75
/** 跨度长度比 `[0.6, 1.35]` */
export const RATIO_LO = 0.6
export const RATIO_HI = 1.35
/** 同一 seed 的候选出现数 */
export const SEED_TRIES = 3

/* ── 规模上限（§3.9）────────────────────────────────────────────────────── */
export const MAX_CHUNKS = 200
export const MAX_TEXT_CHARS = 4000
export const MAX_LATEX_CHARS = 2000
export const MAX_TOTAL_CHARS = 8000
/** 服务端上游超时（§3.6） */
export const UPSTREAM_TIMEOUT_MS = 30_000
/** LRU 上限（§3.7④） */
export const CACHE_LIMIT = 200

/* ── 提示词契约（§3.6，逐字冻结；改动必须回改需求文档并重跑 A6/A7）────────── */
export const SELECTION_SYSTEM_PROMPT = `You are a professional, authentic machine translation engine for academic papers.
Translate the user's input into Simplified Chinese.

Hard rules:
1. Any content wrapped in $...$ is a LaTeX formula. Keep every formula EXACTLY as
   given: do not translate it, do not rewrite or simplify it, do not change spaces,
   braces, or backslashes, do not drop it, do not add any.
2. Output the translation ONLY. No preamble, no explanation, no notes, no headings,
   no Markdown code fences, no quotes around the whole output.
3. Preserve the paragraph and line structure of the input. Never add content that is
   not in the input.
4. Translate terminology by field convention (policy -> 策略, world model -> 世界模型).
   Keep model names, dataset names, method names and abbreviations (LCVN-WM, DiT, CLIP)
   in the original form.
5. If the input is already Chinese, return it as is.`

/* ── 错误类型（错误码表 §3.9）───────────────────────────────────────────── */
export type SelectionErrorCode = 'no-endpoint' | 'bad-request' | 'too-large' | 'upstream' | 'network' | 'timeout'

export class SelectionTranslateError extends Error {
  constructor(
    readonly code: SelectionErrorCode,
    readonly status: number,
    message: string,
    /** 上游 HTTP 状态码（仅 code==='upstream' 时有意义）：客户端据此出 §3.7② 的分档文案 */
    readonly upstreamStatus: number | null = null,
  ) {
    super(message)
    this.name = 'SelectionTranslateError'
  }
}

/* ── 文本清洗（§3.3②）──────────────────────────────────────────────────── */

/** 文本层乱码字符类（§3.3② 的冻结清单）：C0/C1（\t 与 \n 是空白，另行折叠）、私用区、
 *  U+FFFD、走音符号类。**只用于 `$…$` 之外的文本层内容**——见下面的 LaTeX 例外。 */
function isTextJunk(cp: number): boolean {
  if (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0b && cp !== 0x0c && cp !== 0x0d) return true
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp >= 0xe000 && cp <= 0xf8ff) return true
  if (cp === 0xfffd) return true
  if (cp === 0x02c6 || cp === 0x02dc || cp === 0xb4 || cp === 0x005e || cp === 0x0060) return true
  return cp >= 0x300 && cp <= 0x36f
}

const isLatexJunk = (cp: number): boolean =>
  (cp <= 0x1f && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xe000 && cp <= 0xf8ff) || cp === 0xfffd

function dropJunk(s: string, junk: (cp: number) => boolean): string {
  let out = ''
  for (const ch of s) {
    if (junk(ch.codePointAt(0) ?? 0)) continue
    out += ch
  }
  return out
}

/** 空白折叠：连续空白（\t/\r/空格…）折叠成一个空格，**换行是结构**只清它两侧的空格。 */
function collapse(s: string): string {
  return s.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim()
}

/**
 * 收尾清洗：删除 C0/C1 控制字符、私用区（E000-F8FF）、U+FFFD、走音符号类
 * （`\u02c6 \u02dc \u00b4 \u005e \u0060 \u0300-\u036f`），并把连续空白折叠成一个空格。
 *
 * **两条实现约束（都是实测/契约必需的，见实现报告）**：
 *  ① `\n` 是结构：§3.5 ④「页之间插一个 `\n`」+ §3.6 system 第 3 条「保持行结构」，
 *     所以只折叠它两侧的空格与连续空行。
 *  ② 本函数**只能作用在 `$…$` 之外**：清单里的 `\u005e`（`^`）在 LaTeX 里是上标运算符，
 *     整段组装文本过一遍会把 `v^\top` 变成 `v\top`、`x^2` 变成 `x2`（实测）——那既毁公式，
 *     又会让「公式原样保留」的校验失去意义。`assembleSource` 因此对每个 piece 分类清洗：
 *     `$…$` 内只删控制字符/私用区（`isLatexJunk`），外面才用本函数。
 */
export function stripJunk(s: string): string {
  return collapse(dropJunk(s, isTextJunk))
}

/** 一个组装 piece 的清洗：`$…$` 内是 MinerU 的 LaTeX（逐字保留），外面是文本层内容（清乱码）。 */
function cleanPiece(s: string): string {
  return s.split(/(\$[^$]*\$)/)
    .map((part) => (part.startsWith('$') && part.endsWith('$') && part.length >= 2
      ? '$' + dropJunk(part.slice(1, -1), isLatexJunk) + '$'
      : dropJunk(part, isTextJunk)))
    .join('')
}

/**
 * 中和文本层原文里的**字面 `$`**（R-03）：换成全角 `＄`（U+FF04）。
 * 组装文本的 `$…$` 因此**只**可能是真公式（formula chunk 或块跨度里的 LaTeX 片段），
 * `verifyFormulas` 的逐 token 校验才是可判定的；否则 `$5` 这种字面符会与别处的 `$` 配成
 * 假片段，把真公式挤掉（A7 空转）。模型看到的仍是同一个货币符号的常见全角写法。
 * 用于**未对齐分支**（那一段是文本层原文，里面不可能有 MinerU 的 LaTeX）。
 */
function neutralizeDollars(s: string): string {
  return s.includes('$') ? s.replace(/\$/g, '\uff04') : s
}

/**
 * 一个 `$…$` 片段**看起来是 LaTeX**吗（N-02 的判据）。
 * 真公式来自 MinerU 的 LaTeX 投影：含命令/上下标/花括号（`\ _ ^ { } &`），或者整体**不含空白**
 * （紧凑投影后的 `$x_t$`/`$F$` 这类纯符号公式）。正文里两个**字面** `$` 之间通常是自然语言
 * （`$5 up to $`）——含空白且没有 LaTeX 字符 ⇒ 判为非公式。
 *
 * ⚠️ 已知边界：紧凑的成对字面 `$`（如正文写成 `$USD$`、`$5$`）与 `$F$` 这类纯符号公式形态相同，
 * 无法区分，会按公式计入 token。本机两份语料（154+112 个 text 块、两条真实文本层）中不存在
 * 这类形态；遇到时行为与旧版一致（计入并校验），不会更糟。
 */
export function isLatexLikeFragment(fragment: string): boolean {
  const inner = fragment.startsWith('$') && fragment.endsWith('$') ? fragment.slice(1, -1) : fragment
  if (/[\\_^{}&]/.test(inner)) return true
  return !/\s/.test(inner)
}

/**
 * 中和**块跨度**里的成对字面 `$`（N-02）：保留看起来是 LaTeX 的 `$…$` 片段（那是真公式），
 * 其余 `$` 一律换成全角 `＄`。这样组装文本里的每个 `$…$` 都可判定为真公式，
 * `formulaTokens`/`verifyFormulas` 不会再把 `$5 up to $` 当成公式（假警告）或塞进提示词。
 */
function neutralizeNonLatexPairs(s: string): string {
  if (!s.includes('$')) return s
  return s.split(/(\$[^$]*\$)/)
    .map((part) => {
      if (part.startsWith('$') && part.endsWith('$') && part.length >= 2 && isLatexLikeFragment(part)) return part
      return part.replace(/\$/g, '\uff04')
    })
    .join('')
}

/** 对齐用的归一化：小写 + 只留 `[a-z0-9]` 与 CJK，其余（空白/标点/数学符号/控制字符）丢弃。 */
export function normForAlign(raw: string): { A: string; idx: number[] } {
  const chars: string[] = []
  const idx: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!.toLowerCase()
    if (/[a-z0-9\u4e00-\u9fff]/.test(c)) {
      chars.push(c)
      idx.push(i)
    }
  }
  return { A: chars.join(''), idx }
}

/* ── 行内对齐（§3.4，原型 .probe/align-sim4.mjs 的冻结版）──────────────────
   ⚠️ t6 修复（t3 报告 F1/F2，见 docs/selection-translate-verification.md §6.1/§6.2）：
   冻结版有两个缺陷，都是「静默送错文本」：
     F1 跨度端点丢词：公式的 LaTeX 比文本层退化形态长得多（`\mathbf`/`\left`/`\right`/命令名），
        双向行走的 skip 预算被这些「LaTeX 噪声」吃掉，于是在**选区侧**跳过公式前的正文词，
        `bMin` 落在 `$` 上 → 组装文本少一个词（实测 `where …` 的 `where` 丢失）。
     F2 张冠李戴：`score ≥ 0.75` 对短选区没有判别力（逐字母匹配 5/8 就 0.83），于是「本段不在
        候选集里」时会被**别的段落**接走（`, while a learner encoder` → `expert and learner encoders`）。
   修复（三条，均为「绝对门槛」，宁可拒绝还原并如实提示，也不许静默送错文本）：
     ① **块侧跳过只允许发生在 `$…$` 片段内且不消耗预算**（LaTeX 命令/括号本来就无法被文本层
        表示 ⇒ 它们是结构性差异，不是「多抓了内容」）。正文里的块侧跳字 = 张冠李戴 ⇒ 该候选作废。
        这同时让行走能回到选区两端（F1 的根因）。
     ② **端点回填**：行走仍够不到时（选区侧未配对的前缀/后缀），把它按同样的规则映射回块侧，
        因此「选区里有、块里也有」的词一定进跨度（F1 §12.1 的处方）。
     ③ **覆盖门槛**：跨度必须解释选区的**每一个字母**（未配对的字母只能是数字/符号，如公式编号
        `(4)` 的 `4`），且跨度内不得出现「块侧多出来的散文内容」（prose slack，如选区是
        `Instruction:` 而块里是 `instructions`）⇒ 否则拒绝（返回原样 + 走 §3.8 的诚实文案）。
     另：跨度长度比 `ratio` 改用**内容口径**（`$…$` 内的 `\命令名` 不算内容）——旧口径把
        `\mathbf`s_t=\left[…\right]` 的 15 个命令名字符算成选区内容，回填 `where` 后 ratio 反而
        从 1.30 涨到 1.46 被误拒。阈值 `[0.6,1.35]`、`score≥0.75`、种子/预算参数**全部未动**。 */

const WORD_CH = /[A-Za-z0-9]/

/** `$…$` 片段范围（raw 下标）。 */
function fragmentRanges(raw: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = /\$[^$]*\$/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) out.push([m.index, m.index + m[0].length])
  return out
}

/** 归一化下标 → 是否落在 `$…$` 片段内部（`$` 定界符本身不算内部）。 */
function fragmentFlags(raw: string, Bidx: number[]): boolean[] {
  const ranges = fragmentRanges(raw)
  return Bidx.map((ri) => ranges.some(([f0, f1]) => ri > f0 && ri < f1))
}

/**
 * 「内容」口径的归一化：`$…$` 内先删掉 LaTeX 命令名（`\mathbf`/`\left`/`\theta`…）与花括号/定界符，
 * 只保留真正会被文本层呈现出来的字母数字。用于跨度长度比 `ratio`——文本层永远表示不出命令名，
 * 把它们算进跨度长度等于用「LaTeX 写得多长」去衡量「有没有多抓一行」。
 */
export function contentNormForRatio(raw: string): string {
  const ranges = fragmentRanges(raw)
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const inFrag = ranges.some(([f0, f1]) => i > f0 && i < f1)
    if (inFrag && raw[i] === '\\') {
      i++
      while (i + 1 < raw.length && /[A-Za-z]/.test(raw[i + 1]!)) i++
      continue
    }
    out += raw[i]
  }
  return normForAlign(out).A
}

interface SeedHit { score: number; pairs: Array<[number, number]> }

/** 种子 + 双向行走；块侧跳过必须整段落在 `$…$` 片段内（且免费），选区侧跳过消耗预算。 */
function alignSeeds(S: string, B: string, inFrag: boolean[], skipRatio = SKIP_RATIO): SeedHit[] {
  const k = Math.min(SEED_MAX, Math.max(SEED_MIN, Math.floor(S.length / 4)))
  const seeds = [...new Set([0, Math.max(0, Math.floor((S.length - k) / 2)), Math.max(0, S.length - k)])]
  const budget0 = Math.max(4, Math.ceil(skipRatio * S.length))
  const walk = (Sx: string, Bx: string, frag: boolean[], ss: number, at: number): Array<[number, number]> => {
    const pairs: Array<[number, number]> = []
    let i = ss
    let j = at
    let budget = budget0
    while (i < Sx.length && j < Bx.length) {
      if (Sx[i] === Bx[j]) {
        pairs.push([i, j])
        i++
        j++
        continue
      }
      const nS = Bx.indexOf(Sx[i]!, j)  // 块侧：跳到该字符的下一次出现
      let freeB = false
      if (nS >= 0) {
        freeB = true
        for (let t = j; t < nS; t++) {
          if (!frag[t]) { freeB = false; break }   // 跳过范围里含正文 → 张冠李戴，候选作废
        }
      }
      const nB = Sx.indexOf(Bx[j]!, i)  // 选区侧多出的字符（文本层公式字形）→ 跳选区侧
      const costS = nB < 0 ? Infinity : nB - i
      if (freeB) { j = nS; continue }               // 片段内跳过：结构性差异，免费
      if (costS === Infinity || costS > budget) break
      budget -= costS
      i += costS
    }
    return pairs
  }
  const rev = (s: string) => [...s].reverse().join('')
  const Sr = rev(S)
  const Br = rev(B)
  const fragR = [...inFrag].reverse()
  const out: SeedHit[] = []
  for (const ss of seeds) {
    const seed = S.slice(ss, ss + k)
    if (seed.length < 4) continue
    let at = B.indexOf(seed)
    let tries = 0
    while (at >= 0 && tries < SEED_TRIES) {
      const R = walk(S, B, inFrag, ss, at)
      const L = walk(Sr, Br, fragR, S.length - 1 - ss, B.length - 1 - at).map(
        ([a, b]) => [S.length - 1 - a, B.length - 1 - b] as [number, number],
      )
      const pairs = R.concat(L)
        .sort((a, b) => a[0] - b[0])
        .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1]![0])
      out.push({ score: pairs.length / S.length, pairs })
      at = B.indexOf(seed, at + 1)
      tries++
    }
  }
  return out
}

/** ① 词边界外扩：端点不再是词字符为止（防 v1 实测的 `…solving the follo` 截断）。 */
function expandWords(raw: string, a: number, b: number): [number, number] {
  while (a > 0 && WORD_CH.test(raw[a - 1]!) && WORD_CH.test(raw[a] ?? '')) a--
  while (b < raw.length && WORD_CH.test(raw[b] ?? '') && WORD_CH.test(raw[b - 1] ?? '')) b++
  return [a, b]
}

/** ② 片段边界外扩：端点落在 `$…$` 内部时扩到片段边界（防切出半个公式）。 */
function expandFragments(raw: string, a: number, b: number): [number, number] {
  for (const [f0, f1] of fragmentRanges(raw)) {
    if (a > f0 && a < f1) a = f0
    if (b > f0 && b < f1) b = f1
  }
  return [a, b]
}

/**
 * 端点回填（F1 的处方，§12.1）：选区侧**未配对的前缀/后缀**映射回块侧。
 * 规则与行走一致：块侧跳过必须整段在 `$…$` 片段内，且总跳过量受同一预算约束；
 * 只要有一字符映射不到，就整体放弃回填（绝不让端点落在猜出来的位置上）。
 *
 * ⚠️ **防御性代码：当前没有任何用例能区分它**（t4 评审 R-08 的独立变异 M16：把本函数关掉，
 * 全量套件 0 红、真实 Dong 语料 0 差异；t7 又专门构造了「前缀 + N 个重复字形 + 公式」
 * （N=5/20/40/80）与「公式在前、正文词在后 + 重复字形」等形态，仍然构造不出差异）。
 * 原因是可论证的：规则 ① 让块侧跳过「只在 `$…$` 内且免费」之后，反向行走用**独立的**
 * 预算从锚点一路回到选区开头；凡是回填能映射的前缀（在块里紧邻、只需片段内跳过），
 * 反向行走同样能配对；而反向行走配不上的前缀，其间的块侧字符必含正文 —— 回填的
 * 片段内检查也会同样失败。**F1 的真正修复是规则 ① + 覆盖门槛**（两者都有可区分的用例）。
 * 保留本函数是纵深防御：万一将来放宽规则 ①，端点回填仍在（且不改变任何已接受的结果）。
 */
function backfillEnds(
  S: string, B: string, inFrag: boolean[], p: number, q: number,
  bMin: number, bMax: number, budget: number,
): { lo: number | null; hi: number | null; covered: number } {
  const out = { lo: null as number | null, hi: null as number | null, covered: 0 }
  if (p > 0 && bMin > 0) {
    let j = bMin - 1
    let rest = budget
    let earliest = -1
    let ok = true
    for (let i = p - 1; i >= 0; i--) {
      const at = B.lastIndexOf(S[i]!, j)
      if (at < 0 || j - at > rest) { ok = false; break }
      for (let t = at + 1; t <= j; t++) { if (!inFrag[t]) { ok = false; break } }
      if (!ok) break
      rest -= j - at
      j = at - 1
      earliest = at
    }
    if (ok) { out.lo = earliest; out.covered += p }
  }
  if (q < S.length - 1 && bMax + 1 < B.length) {
    let j = bMax + 1
    let rest = budget
    let latest = -1
    let ok = true
    for (let i = q + 1; i < S.length; i++) {
      const at = B.indexOf(S[i]!, j)
      if (at < 0 || at - j > rest) { ok = false; break }
      for (let t = j; t < at; t++) { if (!inFrag[t]) { ok = false; break } }
      if (!ok) break
      rest -= at - j
      j = at + 1
      latest = at
    }
    if (ok) { out.hi = latest; out.covered += S.length - 1 - q }
  }
  return out
}

/** 选区原文最后一段词（小写；忽略行尾标点/连字符）。用于端点补词门槛。 */
function trailingWordOf(chunkText: string): string {
  const t = chunkText.replace(/[^A-Za-z0-9]+$/, '')
  const m = /[A-Za-z0-9]+$/.exec(t)
  return m ? m[0].toLowerCase() : ''
}

export interface AlignCandidate {
  text: string
  score: number
  ratio: number
  ok: boolean
  /** 选区侧始终未被解释的字母（数字/符号允许，如公式编号）→ 非空即拒绝 */
  unpairedLetters: string
  /**
   * 端点「补词」越界（非空即拒绝）：跨度末尾的词比选区末尾的词**更长**（expandWords 补全了词尾），
   * 而选区原文并没有换行连字符 —— 例如选区 `Instruction:`（图注）被块里的 `instructions` 接走
   * （t3 报告 §6.2 的同类现象）。带连字符的换行断词（`… with com-` ↔ `compact`）**必须放行**，
   * 那是文本层的正常断行，t3 报告 §2.5 明确把它记为假阳性而不是缺陷。
   */
  completedTail: string
}

/** 单个（块, 种子）候选：求跨度 → 端点回填 → 三次修正 → `$` 校验 → 绝对门槛 + 长度保险。 */
function candidateFor(S: string, raw: string, B: string, Bidx: number[], inFrag: boolean[], hit: SeedHit, chunkText: string): AlignCandidate | null {
  if (!hit.pairs.length) return null
  let bMin = Infinity
  let bMax = -1
  for (const [, b] of hit.pairs) {
    if (b < bMin) bMin = b
    if (b > bMax) bMax = b
  }
  const paired = new Set(hit.pairs.map((p) => p[0]))
  let p = 0
  while (p < S.length && !paired.has(p)) p++
  let q = S.length - 1
  while (q >= 0 && !paired.has(q)) q--
  const bf = backfillEnds(S, B, inFrag, p, q, bMin, bMax, Math.max(4, Math.ceil(SKIP_RATIO * S.length)))
  const loIdx = bf.lo ?? bMin
  const hiIdx = bf.hi ?? bMax
  let [a, b] = [Bidx[loIdx]!, Bidx[hiIdx]! + 1]
  ;[a, b] = expandWords(raw, a, b)
  ;[a, b] = expandFragments(raw, a, b)
  const text = raw.slice(a, b)
  const dollars = (text.match(/\$/g) ?? []).length
  // ⚠️ **防御性代码：当前没有用例能区分它**（t4 评审 R-08 的变异 M19：关掉本行，全量套件 0 红、
  // 真实 Dong 语料 0 差异；t7 又用「块里含字面 `$`（`the cost is $5 and the value $x_t$`，`$` 计数为奇数）」
  // 试图触发，拒绝都发生在别的闸门（completedTail/no-match）之后）。
  // 按构造即可论证：块内 `$` 计数恒偶（t1 实测），端点在片段内时 expandFragments 会把端点贴到
  // 片段边界 ⇒ 跨度内含的片段必成对。保留它是纵深防御（`$` 是原子的，半公式比不还原更糟）。
  if (dollars % 2 !== 0) return null

  // ③ 覆盖门槛（绝对）：跨度必须解释选区的**每一个字母**。
  //    数字/符号允许留在外面（公式编号 `(4)` 会以裸数字出现在选区里），字母不行：
  //    选区里有字母而块里没有 ⇒ 本段不在候选块里（t3 报告 F2 的 `, while a learner encoder`）。
  //    块侧不可能出现「跨度内部被吞掉的散文」：行走的块侧跳过只允许发生在 `$…$` 片段内（规则 ①），
  //    所以内部多出来的块侧字符必然是 LaTeX 命令/括号，不是别人的句子。
  let unpairedLetters = ''
  for (let i = 0; i < S.length; i++) {
    if (paired.has(i)) continue
    if (p > 0 && i < p && bf.lo !== null) continue
    if (q < S.length - 1 && i > q && bf.hi !== null) continue
    if (/[a-z]/.test(S[i]!)) unpairedLetters += S[i]
  }
  // ④ 端点补词门槛：跨度末尾的词比**选区原文**末尾的词更长（expandWords 补了词尾）时，
  //    选区原文必须带换行连字符 —— 否则就是「被别处的词接走」（`Instruction:` → `instructions`）。
  let completedTail = ''
  const selWord = trailingWordOf(chunkText)
  if (selWord && b > 0 && WORD_CH.test(raw[b - 1]!)) {
    let spanWord = ''
    for (let k = b - 1; k >= 0 && WORD_CH.test(raw[k]!); k--) spanWord = raw[k]! + spanWord
    if (spanWord.toLowerCase() !== selWord && !/[-\u2010\u2011\u2012\u2013\u2014\u2212]$/.test(chunkText.trimEnd())) {
      completedTail = spanWord
    }
  }

  const ratio = contentNormForRatio(text).length / S.length
  const ok = ratio >= RATIO_LO && ratio <= RATIO_HI && unpairedLetters === '' && completedTail === ''
  return { text, score: hit.score, ratio, ok, unpairedLetters, completedTail }
}

/** 候选择优规则（原型同款）：先 `ok`，再 `score`。 */
function better(a: AlignCandidate | null, b: AlignCandidate | null): AlignCandidate | null {
  if (!a) return b
  if (!b) return a
  if (b.ok !== a.ok) return b.ok ? b : a
  return b.score > a.score ? b : a
}

export interface AlignResult {
  /** 还原后的文本；对齐失败时**原样返回** chunkText（§3.4-9） */
  text: string
  applied: 0 | 1
  score: number | null
  ratio?: number
  /** `|nf| < 4`：不对齐（§3.4-2） */
  skipped: boolean
  /** 拒绝原因（排障/测试用）：`short`=过短 / `no-match`=没有候选 / `gate`=绝对门槛没过 */
  reason?: 'short' | 'no-match' | 'gate'
  /** 诊断（测试与排障用）：选区侧未被解释的字母 / 端点补词越界 */
  unpairedLetters?: string
  completedTail?: string
}

/**
 * 一行选区文本 ↔ 一个 MinerU text 块 → 还原后的文本。
 * 纯函数；块文本在内部过一遍 `compactLatex`（幂等：块索引里已经是紧凑形态）。
 *
 * 交付侧语义（t6 修复后）：`applied=1` ⟺ 跨度覆盖了选区**每一个字母**、没有块侧多出来的散文、
 * 长度比在 `[0.6,1.35]`、`score ≥ 0.75`。任一条不满足 ⇒ `applied=0` 且**原样返回** chunkText，
 * 由 §3.8 的文案表如实提示（绝不静默换掉用户的句子）。
 */
export function alignSelectionToBlock(chunkText: string, blockText: string): AlignResult {
  const { A: S } = normForAlign(chunkText)
  if (S.length < MIN_NORM) return { text: chunkText, applied: 0, score: null, skipped: true, reason: 'short' }
  const raw = compactLatex(blockText)
  const { A: B, idx: Bidx } = normForAlign(raw)
  if (!B.length) return { text: chunkText, applied: 0, score: null, skipped: false, reason: 'no-match' }
  const inFrag = fragmentFlags(raw, Bidx)
  let best: AlignCandidate | null = null
  for (const hit of alignSeeds(S, B, inFrag)) {
    best = better(best, candidateFor(S, raw, B, Bidx, inFrag, hit, chunkText))
  }
  if (!best || !best.ok || best.score < MIN_SCORE) {
    return {
      text: chunkText, applied: 0, skipped: false, reason: best ? 'gate' : 'no-match',
      score: best ? best.score : null,
      ...(best ? { ratio: best.ratio, unpairedLetters: best.unpairedLetters, completedTail: best.completedTail } : {}),
    }
  }
  return { text: best.text, applied: 1, score: best.score, ratio: best.ratio, skipped: false, unpairedLetters: '', completedTail: '' }
}

/* ── 组装（§3.2 客户端切块 → §3.3/§3.4 服务端组装）─────────────────────── */

export interface TranslateChunk {
  page: number
  kind: 'text' | 'formula'
  text?: string
  latex?: string
}

/**
 * 从一个**已中和**的 piece 里按出现顺序抽出 `$…$` 片段 = 真公式（N-02）。
 * 这里刻意不再做一次「看起来像 LaTeX」的过滤：唯一那道闸门是 `neutralizeNonLatexPairs`
 * （它已把非 LaTeX 的成对 `$` 换成全角），再加一层过滤会变成**没有变异能区分的冗余代码**
 * （t9 的 M-N02b/M-N02c 实测：删掉过滤，全部用例仍绿）。单一闸门 = 单一事实源。
 */
function latexFragments(s: string): string[] {
  return [...s.matchAll(/\$[^$]*\$/g)].map((m) => m[0])
}

export interface AssembleResult {
  /** 发给模型的源文本：公式已是单 `$` 定界的紧凑 LaTeX，乱码字符已被清洗 */
  source: string
  /** text chunk 数（用于 formulaStatus 判定） */
  textChunkCount: number
  /** 成功还原的 text chunk 数 */
  applied: number
  /** 因过短而未尝试对齐的 text chunk 数 */
  skipped: number
  /** 产物可读、行内还原有块可查（bare 产物也算 true） */
  hasBlockIndex: boolean
  /**
   * **组装期统计的公式 token 列表**（N-02）：按组装顺序收集的、可以确信是真公式的 `$…$`——
   * formula chunk 原样发的串 + 块跨度里**看起来是 LaTeX** 的片段。`verifyFormulas` 优先吃这个列表，
   * 而不是回头解析最终字符串；正文里的成对字面 `$`（`$5 up to $`）既不入列表、也已被中和。
   */
  formulaTokens: string[]
}

/**
 * 组装源文本（§3.3②/§3.4/§3.5）。
 * - `formula` chunk → `$` + 紧凑 LaTeX + `$`（**该段乱码字符不进入请求体**）
 * - `text` chunk → 在**该页所有候选块**里取最高分（跨块/跨页各自命中自己的页）
 * - 页码变化处插一个 `\n`（§3.5 ④）
 * - 清洗按 piece 分类做：`$…$` 内逐字保留 LaTeX，外面清文本层乱码（见 `stripJunk` 的说明）
 *
 * 行尾换行必须保留：客户端把换行作为 text 段的**结尾字符**发过来（§3.2-6），而替换用的块跨度
 * 不含换行；不补回去，两行正文会被粘成一行（system 第 3 条要求保持行结构）。
 */
export function assembleSource(chunks: readonly TranslateChunk[], index: TextBlockIndex | null): AssembleResult {
  const parts: string[] = []
  const tokens: string[] = []
  let textChunkCount = 0
  let applied = 0
  let skipped = 0
  let lastPage: number | null = null
  for (const c of chunks) {
    if (lastPage !== null && c.page !== lastPage) parts.push('\n')
    lastPage = c.page
    if (c.kind === 'formula') {
      const piece = '$' + (c.latex ?? '') + '$'
      parts.push(piece)
      tokens.push(piece)   // 客户端按 equation bbox 切出来的 ⇒ 一定是真公式
      continue
    }
    textChunkCount++
    const chunkText = c.text ?? ''
    const eol = /[ \t]*\r?\n[ \t]*$/.test(chunkText) ? '\n' : ''
    let best: AlignCandidate | null = null
    let wasSkipped = false
    for (const blk of index?.blocks ?? []) {
      if (blk.page !== c.page) continue
      const r = alignSelectionToBlock(chunkText, blk.text)
      if (r.skipped) {
        wasSkipped = true
        continue
      }
      best = better(best, r.applied === 1
        ? { text: r.text + eol, score: r.score ?? 0, ratio: r.ratio ?? 1, ok: true, unpairedLetters: '', completedTail: '' }
        : null)
    }
    if (wasSkipped) skipped++
    if (best) {
      applied++
      // 块跨度：里面的 `$…$` 是块文本的 LaTeX 片段；但块正文里也可能印了**字面** `$`（`$5 up to $`）。
      // 只保留「看起来是 LaTeX」的片段，其余 `$` 中和成全角（N-02）；token 在**组装期**收集。
      const span = neutralizeNonLatexPairs(best.text)
      parts.push(span)
      for (const frag of latexFragments(span)) tokens.push(frag)
    } else {
      // 未对齐 → 这段就是文本层原文，里面的 `$` 只可能是**字面字符**（`$5` 之类），
      // 不是定界符。必须中和掉：否则它会与别处的 `$` 配成假片段，
      // 让 `formulaTokens`/`verifyFormulas` 把真公式漏掉（R-03 实测：源 `cost is $5 and $x_t$`
      // 只识别出一个 token `$5 and $`，`$x_t$` 丢失时 formulaLost 仍为 0 ⇒ A7 失效）。
      parts.push(neutralizeDollars(chunkText))
    }
  }
  return {
    source: collapse(parts.map(cleanPiece).join('')),
    textChunkCount,
    applied,
    skipped,
    hasBlockIndex: index?.source === 'mineru',
    formulaTokens: tokens,
  }
}

/** `formulaStatus` 判定（§3.9 表）。 */
export function formulaStatusOf(r: Pick<AssembleResult, 'hasBlockIndex' | 'applied' | 'textChunkCount'>): string {
  if (!r.hasBlockIndex) return 'no-artifact'
  if (r.textChunkCount === 0) return 'applied'
  if (r.applied === 0) return 'unavailable'
  if (r.applied < r.textChunkCount) return 'partial'
  return 'applied'
}

/* ── 提示词与请求体（§3.6）────────────────────────────────────────────── */

export function clampMaxTokens(chars: number): number {
  return Math.min(4096, Math.max(256, Math.ceil(1.5 * chars)))
}

/** 推理型模型关思考（与 src/translate.ts:264 同一判据、同一理由：自定义端点不加）。 */
export function wantsThinkingOff(baseUrl: string): boolean {
  return /bigmodel|kimi|moonshot|deepseek/i.test(baseUrl)
}

/** 请求体：**只有** model/messages/max_tokens/temperature（命中域名时才多 thinking）。 */
export function buildRequestBody(model: string, source: string, baseUrl = ''): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: SELECTION_SYSTEM_PROMPT },
      { role: 'user', content: source },
    ],
    max_tokens: clampMaxTokens(source.length),
    temperature: 0,
  }
  if (wantsThinkingOff(baseUrl)) body['thinking'] = { type: 'disabled' }
  return body
}

/* ── 响应清洗与公式保全校验（§3.6-2/3/4）──────────────────────────────── */

/** 整体被 ``` 包裹时剥掉围栏与语言标注。 */
export function stripFence(s: string): string {
  const t = s.trim()
  const m = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t)
  return m ? m[1]!.trim() : t
}

/** 剥掉行首的 `译文：` / `翻译：` / `Translation:`。 */
export function stripPrefix(s: string): string {
  return s.replace(/^\s*(?:译文|翻译|Translation)\s*[:：]\s*/, '')
}

/**
 * 源文本里的 `$…$` token（按出现顺序）。
 * **权威来源是 `assembleSource` 在组装期收集的 `formulaTokens` 列表**（N-02）——组装文本里的
 * 每个 `$…$` 都在组装期过了唯一那道闸门（`neutralizeNonLatexPairs`：字面 `$` 中和为全角），
 * 所以这里再解析一遍得到的列表与那个列表**逐项相同**（测试 `N-02` 直接断言这条等价性）。
 * 保留本函数是为了兼容「只拿到源文本」的调用方（如 host 路由，不在本轮 inScope）与单测。
 */
export function formulaTokens(source: string): string[] {
  return [...source.matchAll(/\$[^$]*\$/g)].map((m) => m[0])
}

export interface FormulaVerify {
  total: number
  kept: number
  lost: number
  missing: string[]
}

/** 逐 token 原样 `includes` 校验（§3.6-4）。v1 不做自动回插，只回报缺失数。 */
export function verifyFormulas(source: string, translation: string, tokens?: readonly string[]): FormulaVerify {
  // tokens 优先：调用方（路由/组装方）应传 `assembleSource(...).formulaTokens`，避免回头解析字符串
  const list = tokens ?? formulaTokens(source)
  const missing = list.filter((t) => !translation.includes(t))
  return { total: list.length, kept: list.length - missing.length, lost: missing.length, missing }
}

/* ── 缓存（§3.7④）：进程内存 LRU，不落盘 ───────────────────────────────── */

/** 键 = `sha256(model + '\0' + assembledText)`；**不含 key**（不做任何密钥派生）。 */
export function selectionCacheKey(model: string, source: string): string {
  return createHash('sha256').update(model + '\0' + source, 'utf8').digest('hex')
}

/** 极简 LRU：Map 的插入序即最近使用序（命中先删再插）。零依赖。 */
export class TranslateSelectionCache {
  private map = new Map<string, string>()

  constructor(private readonly limit: number = CACHE_LIMIT) {}

  get(key: string): string | undefined {
    const hit = this.map.get(key)
    if (hit === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, hit)
    return hit
  }

  set(key: string, value: string): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  get size(): number { return this.map.size }

  clear(): void { this.map.clear() }
}

/** 进程级默认缓存（服务端路由用它；测试可注入自己的实例）。 */
export const selectionCache = new TranslateSelectionCache()

/* ── 端点调用（§3.6 / §3.7）──────────────────────────────────────────── */

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>

export interface TranslateSelectionDeps {
  fetchImpl?: FetchLike
  timeoutMs?: number
  cache?: TranslateSelectionCache
  /** 便于测试与排障留痕；默认 no-op，只打印白名单字段 */
  log?: (info: { model: string; status: number; ms: number; chars: number }) => void
}

export interface TranslateSelectionResult {
  translation: string
  model: string
  cached: boolean
  ms: number
  formulaTotal: number
  formulaKept: number
  formulaLost: number
}

function networkDetail(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ''
  return (err instanceof Error ? err.message : String(err)) + cause
}

/**
 * 调端点翻译一段源文本。
 * - body/URL/头与 §3.6 写死一致；**不**发 response_format/reasoning/tools/top_p/stream
 * - 唯一的重试：HTTP 400 且响应体匹配 `/temperature/i` → 去掉 `temperature` 重发一次
 * - 上游错误详情一律过 `sanitizeDetail(text, apiKey)`；本函数不打印任何 key
 */
export async function translateSelection(
  endpoint: TranslateEndpoint,
  source: string,
  deps: TranslateSelectionDeps = {},
): Promise<TranslateSelectionResult> {
  const baseUrl = endpoint.baseUrl ?? ''
  const apiKey = endpoint.apiKey ?? ''
  const model = endpoint.model ?? ''
  if (!baseUrl || !apiKey || !model) {
    throw new SelectionTranslateError('no-endpoint', 503, '未配置翻译端点：在阅读器里点 ⚙ 填写（OpenAI 兼容端点即可）')
  }
  const cache = deps.cache ?? selectionCache
  const key = selectionCacheKey(model, source)
  const hit = cache.get(key)
  if (hit !== undefined) {
    const v = verifyFormulas(source, hit)
    return { translation: hit, model, cached: true, ms: 0, formulaTotal: v.total, formulaKept: v.kept, formulaLost: v.lost }
  }

  const fetchImpl = (deps.fetchImpl ?? (globalThis.fetch as FetchLike))
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  const started = Date.now()
  const send = async (body: Record<string, unknown>): Promise<Response> => {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
      })
    } catch (err) {
      // 超时 vs 连不上：两者文案不同（§3.7②）
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new SelectionTranslateError('timeout', 504, '翻译超时，请重试')
      }
      // 网络异常文本同样必须过 sanitizeDetail（R-04）：fetch 抛出的原因串可能带上
      // baseUrl（含凭据/查询参数）或回显 Authorization，而这条消息会原样进响应体到前端。
      throw new SelectionTranslateError('network', 502, `无法连接端点：${sanitizeDetail(networkDetail(err), apiKey)}`)
    }
  }

  let res = await send(buildRequestBody(model, source, baseUrl))
  let resText: string | null = null
  if (res.status === 400) {
    const probe = await res.text().catch(() => '')
    // 唯一的白名单重试：严格端点不认 temperature
    if (/temperature/i.test(probe)) {
      const body = buildRequestBody(model, source, baseUrl)
      delete body['temperature']
      res = await send(body)
    } else {
      resText = probe
    }
  }
  if (!res.ok) {
    const text = (resText ?? await res.text().catch(() => '')).slice(0, 200)
    throw new SelectionTranslateError(
      'upstream', 502,
      `上游返回 HTTP ${res.status}${text ? '：' + sanitizeDetail(text, apiKey) : ''}`,
      res.status,
    )
  }
  const rawText = resText ?? await res.text().catch(() => '')
  let data: unknown
  try {
    data = JSON.parse(rawText)
  } catch {
    throw new SelectionTranslateError('upstream', 502, `端点响应不是合法 JSON：${sanitizeDetail(rawText.slice(0, 200), apiKey)}`, res.status)
  }
  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new SelectionTranslateError('upstream', 502, '端点没有返回补全内容（choices[0].message.content 为空）', res.status)
  }
  const translation = stripPrefix(stripFence(content))
  const ms = Date.now() - started
  cache.set(key, translation)
  const v = verifyFormulas(source, translation)
  // 日志白名单：只有 model/status/ms/chars（§3.7③）——key 与 baseUrl 永不出现
  const log = deps.log ?? ((info) => console.log('[dsh-paper-reader] translate-selection', JSON.stringify(info)))
  log({ model, status: 200, ms, chars: source.length })
  return { translation, model, cached: false, ms, formulaTotal: v.total, formulaKept: v.kept, formulaLost: v.lost }
}
