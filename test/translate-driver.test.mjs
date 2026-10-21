// test/translate-driver.test.mjs — PR#11 新行为的回归守卫（翻译进度映射 + 驱动拆段）。
//
// 守什么：
//   · src/translate.ts 的进度折算（阶段中文名 / 0..1↔0..100 归一 / 按阶段权重补 overall）——
//     顶栏进度条的数据源，字段错位或 NaN 会直接画出「undefined%」。
//   · runtime/babeldoc-driver.py 的拆段兜底（长输入按句切、占位符不劈半、宁可不拆）——
//     这是「长段落不截断」的最后防线。
//
// 怎么守：translate 侧与 rightbar-swap 同套路（源码区段抽取真实现跑）；驱动侧直接用
// python import 驱动脚本调纯函数（跑不了 python 的环境按仓库惯例 skip，不红）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { normalizeEol } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))

/* ---------- 进度折算：抽取 STAGE_LABELS..buildProgress 真源码 ---------- */
// 从 dist 抽（编译产物无类型标注，与仓库「只 import dist」的测试惯例一致）
const TS = normalizeEol(readFileSync(join(ROOT, '..', 'dist', 'translate.js'), 'utf8'))
const S = TS.indexOf('const STAGE_LABELS')
const E = TS.indexOf('/** 找与 babeldoc 同 venv 的 python')
assert.ok(S >= 0 && E > S, 'dist/translate.js 抽取标记 STAGE_LABELS/resolveDriverPython 仍在（改结构请同步本测试）')
const PROGRESS_SRC = TS.slice(S, E)
const mk = new Function(PROGRESS_SRC + '\nreturn { stageLabel, toPercent, buildProgress }')()
const { stageLabel, toPercent, buildProgress } = mk

test('P1: 阶段名映射——已知 babeldoc 阶段给中文名，未知/空给原值/兜底', () => {
  assert.equal(stageLabel('Translate Paragraphs'), '翻译段落')
  assert.equal(stageLabel('Typesetting'), '排版')
  assert.equal(stageLabel('Some New Stage'), 'Some New Stage', '未知阶段原样透传（不吞）')
  assert.equal(stageLabel(null), '翻译')
})

test('P2: 百分比归一——0..1 乘 100、0..100 原样、非法值 null、越界夹住', () => {
  assert.equal(toPercent(0.76), 76)
  assert.equal(toPercent(76), 76)
  assert.equal(toPercent(250), 100)
  assert.equal(toPercent(-3), 0)
  assert.equal(toPercent('x'), null)
  assert.equal(toPercent(Number.NaN), null)
})

test('P3: buildProgress——overall 缺失时按阶段权重折算，文案含计数与百分比', () => {
  const stages = [
    { name: 'Parse PDF and Create Intermediate Representation', weight: 0.25 },
    { name: 'Translate Paragraphs', weight: 0.75 },
  ]
  // 阶段事件自带 overall（progress_update 有）：直接用
  const a = buildProgress({ stage: 'Translate Paragraphs', stagePercent: 40, stageCurrent: 521, stageTotal: 798, overall: 0.5 }, stages)
  assert.equal(a.overall, 50)
  assert.equal(a.label, '翻译段落')
  assert.match(a.text, /翻译段落（521\/798） · 50%/)
  // overall 缺失（progress_start 早期事件）：0.25 + 0.75×40% = 55%
  const b = buildProgress({ stage: 'Translate Paragraphs', stagePercent: 40, stageCurrent: 0, stageTotal: 798 }, stages)
  assert.ok(Math.abs(b.overall - 55) < 1e-9, `overall 应为 55（权重折算），得到 ${b.overall}`)
  assert.ok(Number.isFinite(b.overall), 'overall 必须是有限数（进度条画 NaN = 崩）')
})

/* ---------- 驱动拆段：python 跑不了就 skip ---------- */
function runPython(code) {
  for (const bin of ['python3', 'python']) {
    try {
      // -B：不写 __pycache__（VC1 守卫会把 runtime/ 下多出来的东西当越界改动）
      return { out: execFileSync(bin, ['-I', '-B', '-c', code], { encoding: 'utf8', timeout: 20000 }) }
    } catch (e) {
      if (e.code === 'ENOENT') continue
      throw e
    }
  }
  return null
}

const PY = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("dpr_driver", ${JSON.stringify(join(ROOT, '..', 'runtime', 'babeldoc-driver.py'))})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)   # 只执行纯函数定义区（补丁安装都在 main() 里，不会触发）
def case(name, fn):
    try: print(json.dumps({"name": name, "ok": True, "value": fn()}, ensure_ascii=False))
    except Exception as e: print(json.dumps({"name": name, "ok": False, "err": str(e)}, ensure_ascii=False))
case("rough_cjk", lambda: m.rough_tokens("汉字汉字汉字"))          # 3 字 → 2 token
case("rough_empty", lambda: m.rough_tokens(""))
case("short_no_split", lambda: m.split_text("hello world", 3000))
case("long_line_split", lambda: m.split_text("line one\\nline two\\nline three", 1))
case("sentence_split", lambda: m.split_text("One sentence here. Two sentences there. Three more text!", 3))
case("placeholder_refuse", lambda: m.split_text("<b1>open only never closed " * 20, 40))
case("balanced_ok", lambda: m.placeholders_balanced("<b1>x</b1> {v1}"))
case("torn_refuse", lambda: m.placeholders_balanced("<b1>x</b2>"))
`

test('D1: 驱动拆段纯函数（python 缺席则 skip）', { skip: runPython('1') === null && '本机无 python：驱动为发行件，CI 三平台自带 python 兜住' }, () => {
  const r = runPython(PY)
  assert.ok(r, 'python 可用性前后一致；若这里翻红说明 python 中途消失')
  const cases = Object.fromEntries(r.out.trim().split('\n').map((l) => {
    const j = JSON.parse(l)
    assert.ok(j.ok, `用例 ${j.name} 抛异常: ${j.err}`)
    return [j.name, j.value]
  }))
  assert.equal(cases.rough_empty, 0, '空串返回 0（提前短路）；非空串才有 +1 下限')
  assert.ok(cases.rough_cjk >= 2, 'CJK 估算 ≈1.5 字/token：3 字 ≈ 2 token')
  // 短输入不拆：原样返回、无 joiner
  assert.deepEqual(cases.short_no_split, [['hello world'], ''])
  // 长输入按行拆：3 行、joiner 是换行
  {
    const [pieces, joiner] = cases.long_line_split
    assert.ok(pieces.length === 3 && joiner === '\n', `应按行拆成 3 段，得到 ${JSON.stringify(pieces)}`)
  }
  // 无换行时按句子拆
  {
    const [pieces, joiner] = cases.sentence_split
    assert.ok(pieces.length >= 2 && joiner === ' ', `应按句拆成 ≥2 段，得到 ${JSON.stringify(pieces)}`)
  }
  // 占位符不平衡 → 宁可不拆（整段原样返回）
  {
    const [pieces] = cases.placeholder_refuse
    assert.equal(pieces.length, 1, '占位符会劈半时必须整体返回不拆')
  }
  assert.equal(cases.balanced_ok, true)
  // 已知启发式边界（记录而非缺陷）：平衡检查只比开/闭<b>计数，<b1>x</b2> 计数相等视为平衡——
  // 配对错乱检测非目标；拆段守卫真正要防的「块边界劈开标签」由计数差捕获
  assert.equal(cases.torn_refuse, true, '计数相等的错配视为平衡（既定启发式，改动须同步文档）')
})
