// test/rerank-hits.test.mjs — rerankHits 的选定与展示顺序契约（issue #13 重排成功路径的守卫）。
//
// rerank.ts 只依赖注入进来的 TypeSafe 客户端（systemOne），这里用桩客户端覆盖两条硬约束：
//   R1 top-k 按 noul 分选定、展示按 chunk.index（原文序）、score 改写为 noul；
//   R2 选定与输入顺序无关 —— 融合层修复后进来的是 RRF 相关性序（issue #13），重排必须不受影响。
// 只 import dist/*.js（跑前先 `npm run build`）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)
const { rerankHits } = await import(pathToFileURL(dist('rerank.js')).href)

const mk = (index, score) => ({ chunk: { index, start: index, end: index + 1, text: `c${index}` }, score, page: 1 })

/** 桩客户端：按传入的 noul 表回答 c1..cN（不看问题内容，顺序即 shortlist 顺序）。 */
function stubClient(nouls) {
  return {
    systemOne: async () => ({ answers: Object.fromEntries(nouls.map((n, i) => [`c${i + 1}`, { noul: n }])) }),
  }
}

test('R1 重排成功路径：top-k 按 noul 选定、展示按原文序、score 改写为 noul', async () => {
  // 融合层修复后进来的是 RRF 相关性序：#4 > #6 > #2 > #1 > #5 > #3
  const rrfOrder = [mk(4, 0.03), mk(6, 0.025), mk(2, 0.02), mk(1, 0.015), mk(5, 0.01), mk(3, 0.008)]
  // noul 判定最能回答的是 #3(0.95)、#4(0.8)、#2(0.7)，其余 0.1
  const out = await rerankHits(stubClient([0.8, 0.1, 0.7, 0.1, 0.1, 0.95]), 'q', rrfOrder, 3, 0)
  assert.deepEqual(out.map((h) => h.chunk.index), [2, 3, 4], '选定 {3,4,2}，展示按原文序')
  assert.deepEqual(out.map((h) => h.score), [0.7, 0.95, 0.8], 'score 改写为 noul（千分位取整，跟随展示位置）')
})

test('R2 输入顺序无关：文档序进 / RRF 序进 → 同一集合、同一展示序', async () => {
  const docOrder = [1, 2, 3, 4, 5, 6].map((i) => mk(i, 0.01))
  const rrfOrder = [4, 6, 2, 1, 5, 3].map((i) => mk(i, 0.02))
  // 同一份语义（#3=0.95、#4=0.8、#1=0.3，其余递减）按各自位置喂给桩
  const a = await rerankHits(stubClient([0.3, 0.2, 0.95, 0.8, 0.1, 0.05]), 'q', docOrder, 3, 0)
  const b = await rerankHits(stubClient([0.8, 0.05, 0.2, 0.3, 0.1, 0.95]), 'q', rrfOrder, 3, 0)
  assert.deepEqual(a.map((h) => h.chunk.index), [1, 3, 4], '文档序进：top-k = {3,4,1}')
  assert.deepEqual(b.map((h) => h.chunk.index), [1, 3, 4], 'RRF 序进：选定集合一致')
  assert.deepEqual(a.map((h) => h.chunk.text), b.map((h) => h.chunk.text), '展示内容逐项一致')
})
