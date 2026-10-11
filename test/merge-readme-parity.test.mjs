// 守卫：README 的「产物清单」必须与代码里的清单同步，且不得引用不随仓库分发的内部文档。
//
// 为什么需要它：整合期间连续两轮，唯一的缺陷都是「文档漂移」，不是代码——
//   · F1：README 承诺「改名连带学习档案一起搬家」，而代码的派生产物清单里没有 .study.json
//   · N1：README 说手工放进库的 .hidden.pdf「删不掉」，而代码已经放开（只做边界校验）
// 代码有四道关卡（实现自证 / 独立验证 / 评审 / 变异测试），文档一道都没有。
// 这条断言把文档纳入可验证范围：**代码每处理一种派生产物，两份 README 都必须写明**；
// 并且 README 不得引用那些只存在于开发机、不随仓库分发的内部文档。
//
// 若将来某条断言确实不再适用，请**改写它**，不要删除——它挡住的正是我们踩过的坑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const readmes = ['README.md', 'README_EN.md']

/** 只存在于开发机、不随仓库分发的过程文档——README 不得引用，否则读者找不到。 */
const INTERNAL_DOCS = [
  'docs/reader-ux-requirements.md',
  'docs/reader-ux-verification.md',
  'docs/merge-plan.md',
  'docs/merge-verify.md',
  'docs/merge-review.md',
  'docs/security-verify.md',
  'docs/security-review.md',
]

test('README 产物清单与代码同步：必须存在完整列出全部派生产物与译文变体的段落', async () => {
  const { PAPER_STEM_SUFFIXES, PDF2ZH_VARIANT_SUFFIXES } = await import(
    join(REPO, 'dist', 'library-manage.js')
  )
  const wanted = [...PAPER_STEM_SUFFIXES, ...PDF2ZH_VARIANT_SUFFIXES]
  for (const file of readmes) {
    const text = readFileSync(join(REPO, file), 'utf8')
    // 按空行切段：要求**某一段**同时列出全部后缀。
    // 不能只断言「文中某处出现过该后缀」——它在功能说明里也会被提到，
    // 那样把产物清单里的条目删掉，断言依然为真（本断言第一版就是这么空转的）。
    const paragraphs = text.split(/\n\s*\n/)
    const complete = paragraphs.find((p) => wanted.every((w) => p.includes(w)))
    if (!complete) {
      // 报告"最接近完整"的那一段缺了什么——不要笼统地说"全都缺"，
      // 那会把排查方向带偏（本断言第一版就是这么误报的）。
      const best = paragraphs
        .map((p) => ({ p, n: wanted.filter((w) => p.includes(w)).length }))
        .sort((a, b) => b.n - a.n)[0]
      const missing = best ? wanted.filter((w) => !best.p.includes(w)) : wanted
      assert.fail(
        `${file} 没有任何一段完整列出全部派生产物与译文变体；` +
          `最接近的一段（命中 ${best ? best.n : 0}/${wanted.length}）缺少：${missing.join(' ')}。` +
          `代码处理它，文档就必须在**同一处**说清（F1 就是这么漏的）`,
      )
    }
  }
})

test('README 不得引用不随仓库分发的内部文档', () => {
  for (const file of readmes) {
    const text = readFileSync(join(REPO, file), 'utf8')
    for (const doc of INTERNAL_DOCS) {
      assert.ok(
        !text.includes(doc),
        `${file} 引用了 ${doc}——该文档不随仓库分发，读者打不开（N1 的原文就是这么写的）`,
      )
    }
  }
})
