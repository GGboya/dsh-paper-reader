// test/chunk-surrogate.test.mjs — issue #9 回归：按 UTF-16 码元截断绝不产生孤立代理项（lone surrogate）。
//
// 后果不是「显示难看」：片段文本经 search_paper 返回后留在会话历史里，宿主之后每一轮
// 模型请求都会 400 INVALID_REQUEST，**整条会话报废**。数学类论文极易触发——LaTeX 数学
// 斜体字母全在 U+1D400 区段（𝑋 = U+1D44B = D835 DC4B，一个代理对）。
//
// 本文件守两处服务端截断：
//   S1/S2  src/search.ts chunkText 超长段硬切（issue 实测：size=1500 时 chunk 13/14 恰好
//          以 D835 结尾 / DC4B 开头）
//   S3     src/mineru.ts sanitizeDetail 的 240 码元截断（错误详情会拼进 tool result）
// 阅读器侧的选区闸门截断（同类）在 selection-translate.test.mjs 的 E2b。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const dist = (m) => join(REPO, 'dist', m)

const { chunkText } = await import(pathToFileURL(dist('search.js')).href)
const { sanitizeDetail } = await import(pathToFileURL(dist('mineru.js')).href)

/** 孤立代理项探测器：与 String.prototype.isWellFormed()（ES2024，Node ≥16）等价的显式写法，
 *  双保险——即便未来有人换了运行时没有 isWellFormed，正则这条路也能红。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u
const wellFormed = (s) => s.isWellFormed() && !LONE_SURROGATE.test(s)

/** 数学斜体区段字符（与 issue 实测同款）：𝑋 𝑡 𝑌 𝑇 𝑎 𝜋 ——按**码点**取（[i] 按码元会把代理对拆成孤立项） */
const MATH = Array.from('\u{1D44B}\u{1D461}\u{1D4CC}\u{1D447}\u{1D44E}\u{1D70B}')
const CJK = Array.from('中文字符也进上下文')

test('S1 硬切边界落在代理对中间时必须回退到码点边界（issue #9 复现形状）', () => {
  // 构造：size=10，第 9-10 码元恰是一个完整代理对（高代理在 index 9）——
  // 旧实现 slice(0,10) 会产出「9 个 a + 孤立高代理 D835」的片段，正是 issue 里 chunk 13 的形状。
  const p = 'a'.repeat(9) + '\u{1D44B}' + 'b'.repeat(30)
  const chunks = chunkText(p, 10)
  assert.ok(chunks.length >= 2, '必须切出多个片段')
  for (const c of chunks) {
    assert.ok(wellFormed(c.text), `片段 ${c.index} 不得含孤立代理项：${JSON.stringify(c.text)}`)
    assert.equal(c.end - c.start, c.text.length, 'start/end 区间长度必须等于片段文本长度')
  }
  // 字符零丢失：单段场景下全部片段按序拼回 === 原段（截断回退只是移动边界，不是丢字）
  assert.equal(chunks.map((c) => c.text).join(''), p)
  // 𝑋 完整落在恰好一个片段里（旧实现会被切成两个孤立代理项）
  const holders = chunks.filter((c) => c.text.includes('\u{1D44B}'))
  assert.equal(holders.length, 1)
})

test('S2 压力：size=200、大量非 BMP 字符散布在各奇偶偏移上，片段全部合法（issue 的 413 片段压力同款）', () => {
  // 确定性伪随机（不依赖 Math.random，三平台逐字节一致）
  let seed = 42
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const units = []
  for (let i = 0; i < 5000; i++) {
    const r = rnd()
    if (r < 0.3) units.push(MATH[Math.floor(rnd() * MATH.length)])  // 非 BMP（2 码元）
    else if (r < 0.5) units.push(CJK[Math.floor(rnd() * CJK.length)]) // BMP 多字节（1 码元）
    else units.push(String.fromCharCode(97 + Math.floor(rnd() * 26))) // ASCII
  }
  const text = units.join('')
  const chunks = chunkText(text, 200)
  assert.ok(chunks.length > 20, `压力文本必须切出足够多片段：${chunks.length}`)
  for (const c of chunks) {
    assert.ok(wellFormed(c.text), `片段 ${c.index} 不得含孤立代理项`)
    assert.equal(c.end - c.start, c.text.length)
  }
  // 全文字符零丢失、零重复：区间按序无缝铺满（单段输入，片段间无 \n\n 并包）
  let pos = 0
  for (const c of chunks) {
    assert.equal(c.start, pos, '片段区间必须无缝衔接')
    assert.equal(text.slice(c.start, c.end), c.text, '区间取回的原文必须与片段逐字相同')
    pos = c.end
  }
  assert.equal(pos, text.length)
})

test('S3 sanitizeDetail 的 240 码元截断不得以孤立高代理项收尾（错误详情进模型上下文）', () => {
  // 'a' + 200 个 𝑋：240 码元切点恰好落在第 120 个代理对的中间（index 239 是高代理）
  const msg = 'a' + '\u{1D44B}'.repeat(200)
  const out = sanitizeDetail(msg)
  assert.ok(wellFormed(out), `脱敏详情不得含孤立代理项：${JSON.stringify(out.slice(-4))}`)
  assert.equal(out.length, 239, '回退一个码元，短 1 而不是切开')
  // 对照：切点本来就在码点边界时，一个码元都不能少
  const aligned = sanitizeDetail('\u{1D44B}'.repeat(200))
  assert.equal(aligned.length, 240)
  assert.ok(wellFormed(aligned))
})

test('S4 源码守卫：三处截断点都带回退逻辑（防后人复制旧写法）', () => {
  const search = readFileSync(join(REPO, 'src', 'search.ts'), 'utf8')
  assert.match(search, /beforeCut >= 0xd800 && beforeCut <= 0xdbff/, 'chunkText 硬切必须回退码点边界')
  const mineru = readFileSync(join(REPO, 'src', 'mineru.ts'), 'utf8')
  assert.match(mineru, /last >= 0xd800 && last <= 0xdbff/, 'sanitizeDetail 截断必须去掉尾部孤立高代理')
  const reader = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')
  assert.match(reader, /before >= 0xd800 && before <= 0xdbff/, '阅读器选区闸门截断必须回退码点边界')
})
