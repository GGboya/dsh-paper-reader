// rerank-compare.mjs — 同一 query 对比「纯关键词排序」vs「Jev 语义重排」。
//
// 用法（在插件仓库根目录，先 pnpm run build）:
//   node examples/rerank-compare.mjs <转录txt路径> "<query>"
// 例:
//   node examples/rerank-compare.mjs ~/study/pdfqa/data/分布式系统/mapreduce-2004.txt "how does the master handle worker failure"
//
// 凭据:直接读设置面板保存的 ~/.dsh/.dsh-paper-reader/typesafe.json
// （或 TYPESAFE_API_KEY 环境变量),脚本本身不接触明文 key。
// 无凭据时只打印关键词侧,方便先看「没有 Jev 时是什么样」。

import { readFile } from 'node:fs/promises'
import { chunkText, searchChunks } from '../dist/search.js'
import { resolveRerankClient, rerankHits } from '../dist/rerank.js'

const [txtPath, query] = process.argv.slice(2)
if (!txtPath || !query) {
  console.error('用法: node examples/rerank-compare.mjs <转录txt> "<query>"')
  process.exit(1)
}

const text = await readFile(txtPath, 'utf8')
// 页码偏移表（<文献>.pages.json,有就带着,没有则页码显示 -）
let pages = null
try {
  const raw = JSON.parse(await readFile(txtPath.replace(/\.txt$/, '.pages.json'), 'utf8'))
  pages = Array.isArray(raw) ? raw : raw.pages ?? null // 兼容 {pageCount, pages:[...]} 包装
} catch { /* 没有偏移表也能跑 */ }

const K = 5, SHORTLIST = 15
const chunks = chunkText(text, 1500)
const keywordHits = searchChunks(chunks, pages, query, SHORTLIST)

const brief = (h, extra) =>
  `  片段#${String(h.chunk.index).padStart(3)}  第${h.page ?? '-'}页  ${extra}  ${h.chunk.text.replace(/\s+/g, ' ').slice(0, 70)}…`

console.log(`\nQuery: "${query}"   (全文 ${chunks.length} 个片段,关键词召回 ${keywordHits.length} 个)`)
console.log(`\n── 纯关键词 top-${K}（词频×词长）──`)
for (const h of keywordHits.slice(0, K)) console.log(brief(h, `score=${h.score}`))

const client = await resolveRerankClient()
if (!client) {
  console.log('\n(未找到 Jev 凭据,跳过重排对比。在 设置→论文伴读 保存 key,或 export TYPESAFE_API_KEY)')
  process.exit(0)
}

// 记录关键词名次,重排后对照升降
const kwRank = new Map(keywordHits.map((h, i) => [h.chunk.index, i + 1]))
const t0 = performance.now()
const reranked = await rerankHits(client, query, keywordHits, K, 0) // 0 = 不设预算,看完整结果
const ms = Math.round(performance.now() - t0)
const within = ms <= 1500

// rerankHits 返回按原文序;score 已被改写为 noul,按概率倒序展示并标注关键词名次
console.log(`\n── Jev 重排 top-${K}（单次请求 ${SHORTLIST} 个 Noul,耗时 ${ms}ms）──`)
for (const h of [...reranked].sort((a, b) => b.score - a.score)) {
  const was = kwRank.get(h.chunk.index)
  console.log(brief(h, `noul=${h.score}  关键词第${was}名`))
}
console.log(`\n插件里的 1.5s 硬预算:${within ? '✅ 本次能赶上,会走 Jev 结果' : '❌ 本次赶不上,会自动退回上面的关键词结果'}\n`)
