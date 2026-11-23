// test/ci-flake-guards.test.mjs — 2026-11-23 main CI 两处既有红的修复守卫。
//
// 守什么:
//   W1 翻译引擎系统 Python 探活的版本窗口必须卡 3.10 ≤ v < 3.14——
//      · 3.15:onnxruntime 无 cp315 wheel,uv 解析 No solution,镜像兜底同样无解;
//      · 3.14:babeldoc 0.6.x 的 priority_thread_pool_executor 用了 CPython 私有
//        _WorkItem(签名 3.14 已变),import 即 TypeError。
//      engine-smoke ubuntu/macos clean 双红实证。放开上限前必须先确认 wheel 与
//      babeldoc 都已兼容,并同步改这里的断言——别只删断言。
//   W2 全量测试的文件级超时不得低于 180s——node --test 把每个测试文件当一个顶层
//      测试,macOS 慢 runner 上重度 fs 文件(library-clear-and-busy / pr8-clear-migrate)
//      整文件可超 60s,60s 上限谁赶上慢时段谁红(v1.13.1 与 v1.14.0 合并各实证一次)。
//
// 怎么守:源码/脚本契约断言(与 L3/D3 同套路),编译产物字符串字面量原样保留。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

test('W1 系统 Python 探活必须卡版本窗口 3.10 ≤ v < 3.14（超界回落托管 3.12）', () => {
  const src = readFileSync(join(ROOT, '..', 'dist', 'babeldoc-install.js'), 'utf8')
  assert.match(
    src,
    /\(3, 10\) <= sys\.version_info\[:2\] < \(3, 14\)/,
    '探活脚本必须是带上限的区间判断(3.14/3.15 系统机会炸在安装上)',
  )
  assert.doesNotMatch(
    src,
    /sys\.version_info >= \(3, 10\)/,
    '无上限的 >= 会让 Python 3.14(私有 API 变更)/3.15(无 wheel)的系统机安装必失败',
  )
  // 托管回落必须仍是已知可用的 3.12 + only-managed(不悄悄用超界的系统解释器)
  assert.match(
    src,
    /'venv', venvDir, '--python', '3\.12', '--python-preference', 'only-managed'/,
    '超界系统的回落通道必须是托管 3.12',
  )
})

test('W2 全量测试文件级超时不得低于 180s（慢 runner 上重度 fs 文件整文件超 60s）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8'))
  const m = pkg.scripts.test.match(/--test-timeout=(\d+)/)
  assert.ok(m, 'test 脚本必须显式带 --test-timeout')
  assert.ok(
    Number(m[1]) >= 180_000,
    `文件级超时 ${m[1]}ms 太紧:node --test 把每个文件当顶层测试,慢 runner 上重度 fs 文件整文件可超 60s(2026-11-23 两次实证)`,
  )
})
