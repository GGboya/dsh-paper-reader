// 守卫：README 与「代码 / 仓库」的一致性。
//
// 背景：整合期间连续三轮，唯一的缺陷都是**文档漂移**而非代码——
//   · F1：README 承诺「改名连带学习档案一起搬家」，而代码的派生产物清单里没有 .study.json
//   · N1：README 说手工放进库的 .hidden.pdf「删不掉」，而代码已经放开（只做边界校验）
//   · G1：README 链向 `docs/embed-plan.md`——它**不在 git ls-files**（只在开发机），发布后是死链
// 代码有四道关卡（实现自证 / 独立验证 / 评审 / 变异测试），文档一道都没有，所以补这条守卫。
//
// 它检查**且只检查**这三件能被机械验证的事：
//   ① 产物清单（bullet 级）：某**一条 bullet** 必须完整列出代码里的全部派生产物后缀与译文变体。
//      为什么是 bullet 级而不是段落级：同一段落里的其它 bullet 也会提到后缀（例如译文那段），
//      段落级下「只把清单 bullet 里的 .study.json 删掉」仍然为真——空转（t9 的 G3 实测）。
//   ② 引用可解析（一般性质）：README 里**每一个** `docs/...` 引用都必须存在于 `git ls-files docs`
//      且确实在磁盘上。判据是「引用必须能解析」，**不是**「不得出现 docs/」——上游自带 tracked 的
//      docs/（演示图等），是仓库的一部分。这里刻意**不用黑名单**：黑名单只挡你当时想到的名字，
//      真实存在但未跟踪的文档（docs/embed-plan.md 就是这么漏过去的）它会放行（t9 的 G2 实测）。
//      无 git 环境（例如从 tarball 解压、非 checkout）时**显式 skip**，不静默通过。
//   ③ 上述两条覆盖的 README：README.md 与 README_EN.md 都要过。
//
// 它**不**检查：README 的其它叙述内容、链接以外的语义、代码行为、文档与实现的一致性（那不是机械
// 可判的）。也就是说「文档被纳入可验证范围」仅限上面三条——上一版注释这么写却只做了 7 条硬编码
// 名单，属于**声称的覆盖范围大于实际**（t9 的 G4），这里如实写明边界。
//
// 若将来某条断言确实不再适用，请**改写它**，不要删除——它挡住的正是我们踩过的坑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const readmes = ['README.md', 'README_EN.md']

/** README 里所有 `docs/...` 形式的引用（相对链接/图片，以及 raw.githubusercontent 绝对 URL 里的同一段路径）。 */
function docsRefs(text) {
  const out = new Set()
  for (const m of text.matchAll(/docs\/[A-Za-z0-9._/-]+/g)) {
    // 去掉可能被正则吞进来的行尾标点（`[...](...)` 的 `)` 与 `]` 已在字符类外，不必处理首尾）
    out.add(m[0].replace(/[.,;:!?)\]}>'"]+$/, ''))
  }
  return [...out].sort()
}

/** `git ls-files docs` 的结果；无 git（或不在仓库里）返回 null，由调用方显式 skip。 */
function trackedDocs() {
  try {
    const raw = execFileSync('git', ['ls-files', 'docs'], { cwd: REPO, encoding: 'utf8' })
    return new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    return null
  }
}

test('README 产物清单与代码同步：必须存在**一条 bullet**完整列出全部派生产物与译文变体', async () => {
  const { PAPER_STEM_SUFFIXES, PDF2ZH_VARIANT_SUFFIXES } = await import(pathToFileURL(join(REPO, 'dist', 'library-manage.js')).href)
  const wanted = [...PAPER_STEM_SUFFIXES, ...PDF2ZH_VARIANT_SUFFIXES]
  for (const file of readmes) {
    const text = readFileSync(join(REPO, file), 'utf8')
    // 按 bullet 切（`\n` 后面紧跟 `- ` / `* ` 处断开）：一条 bullet 内（含其续行）必须同时列出全部后缀。
    // 不能用空行切段——同段别的 bullet 提到同一后缀时，删掉清单 bullet 里的那一项仍然为真（空转）。
    const bullets = text.split(/\n(?=[-*] )/)
    const complete = bullets.find((b) => wanted.every((w) => b.includes(w)))
    if (!complete) {
      // 报告"最接近完整"的那一条缺了什么——不要笼统地说"全都缺"，那会把排查方向带偏
      const best = bullets
        .map((b) => ({ b, n: wanted.filter((w) => b.includes(w)).length }))
        .sort((a, b) => b.n - a.n)[0]
      const missing = best ? wanted.filter((w) => !best.b.includes(w)) : wanted
      assert.fail(
        `${file} 没有任何**一条 bullet** 完整列出全部派生产物与译文变体；` +
          `最接近的一条（命中 ${best ? best.n : 0}/${wanted.length}）缺少：${missing.join(' ')}。` +
          `代码处理它，文档就必须在**同一处**说清（F1 就是这么漏的）`,
      )
    }
  }
})

test('README 的每个 docs/ 引用都必须能解析到仓库里的真实文件（一般性质，非黑名单）', (t) => {
  const tracked = trackedDocs()
  if (!tracked) {
    t.skip('无 git 环境（例如从 tarball 解压），无法核对 docs/ 引用是否随仓库分发')
    return
  }
  for (const file of readmes) {
    const refs = docsRefs(readFileSync(join(REPO, file), 'utf8'))
    assert.ok(refs.length > 0, `${file} 应至少有一个 docs/ 引用（演示图等）——引用被清空了？`)
    const untracked = refs.filter((r) => !tracked.has(r))
    assert.deepEqual(
      untracked,
      [],
      `${file} 引用了不随仓库分发的 docs/ 路径（发布后读者打不开，G1 的死链就是这么来的）：` +
        `${untracked.join(', ')}。若必须引用，请把该文档正式纳入仓库`,
    )
    const missing = refs.filter((r) => !existsSync(join(REPO, r)))
    assert.deepEqual(missing, [], `${file} 引用的文件在磁盘上不存在：${missing.join(', ')}`)
  }
})
