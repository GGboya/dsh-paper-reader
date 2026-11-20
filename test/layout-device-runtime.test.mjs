// test/layout-device-runtime.test.mjs — GPU 版面检测运行时按需安装的决策守卫。
//
// 守什么：
//   · babeldoc-install.ts 的 layoutRuntimePackage / needsDmlInstall 纯函数矩阵——
//     「谁才会触发自动安装」错一格，就会出现「用户选了 GPU 却永远装不上」或
//     「默认 CPU 的用户被偷偷动 venv」两种事故；
//   · 接线：translate.ts 必须在启动翻译前调 ensureOnnxLayoutDevice（断了 = 静默不装），
//     安装失败路径必须如实提示（不粉饰「pip 说装好了」）。
//
// 怎么守：与 translation-follow 同套路，静态 import dist 真实现跑；接线用源码断言。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layoutRuntimePackage, needsDmlInstall } from '../dist/babeldoc-install.js'

const ROOT = dirname(fileURLToPath(import.meta.url))

test('L1 包名矩阵：只有 win32 + dml/auto 才返回 onnxruntime-directml，其余一律不自动装', () => {
  assert.equal(layoutRuntimePackage('dml', 'win32'), 'onnxruntime-directml')
  assert.equal(layoutRuntimePackage('auto', 'win32'), 'onnxruntime-directml')
  // cuda 不自动装：需要系统级 CUDA+cuDNN，装一半的残缺比缺更糟
  assert.equal(layoutRuntimePackage('cuda', 'win32'), null, 'cuda 必须留给用户手动装')
  // 默认 cpu / 未知值绝不动 venv
  assert.equal(layoutRuntimePackage('cpu', 'win32'), null)
  assert.equal(layoutRuntimePackage('gpu', 'win32'), null)
  // 非 win32：Linux 无 DirectML、macOS 上游自动 CoreML
  assert.equal(layoutRuntimePackage('dml', 'linux'), null)
  assert.equal(layoutRuntimePackage('auto', 'darwin'), null)
})

test('L2 装不装 DML 的判定：探测不了就不动、已就位就不装、auto 见 CUDA 就让位', () => {
  const cpuOnly = ['CPUExecutionProvider']
  const withDml = ['DmlExecutionProvider', 'CPUExecutionProvider']
  const withCuda = ['CUDAExecutionProvider', 'CPUExecutionProvider']
  // win32 + dml：缺 DML 才装
  assert.equal(needsDmlInstall('dml', cpuOnly, 'win32'), true)
  assert.equal(needsDmlInstall('dml', withDml, 'win32'), false)
  // auto：已有任何 GPU provider（用户手装过 onnxruntime-gpu）就不装
  assert.equal(needsDmlInstall('auto', withCuda, 'win32'), false)
  assert.equal(needsDmlInstall('auto', cpuOnly, 'win32'), true)
  // 探测不了（null）：宁可驱动回落 CPU，也不在状态未知的 venv 上盲动
  assert.equal(needsDmlInstall('dml', null, 'win32'), false, 'providers 探测失败必须跳过安装')
  // cuda / cpu / 非 win32：纯函数层面就关死
  assert.equal(needsDmlInstall('cuda', cpuOnly, 'win32'), false)
  assert.equal(needsDmlInstall('cpu', cpuOnly, 'win32'), false)
  assert.equal(needsDmlInstall('dml', cpuOnly, 'linux'), false)
})

test('L3 接线守卫：translate 启动前必须调 ensureOnnxLayoutDevice，失败路径必须如实提示', () => {
  const ts = readFileSync(join(ROOT, '..', 'dist', 'translate.js'), 'utf8')
  assert.match(ts, /ensureOnnxLayoutDevice\(/, 'runPipeline 必须在 launch 前按需补装 GPU 运行时')
  assert.match(ts, /resolveDriverPython\(bin\), options\.layoutDevice/, '只对与 babeldoc 同 venv 的 python 操作（用户自管环境不碰）')
  const install = readFileSync(join(ROOT, '..', 'dist', 'babeldoc-install.js'), 'utf8')
  // 安装失败的两级如实提示：phase 给用户看、console.warn 给日志
  assert.match(install, /GPU 版面检测运行时安装失败，本次回落 CPU/)
  assert.match(install, /用 CPU 跑版面/, '失败必须 phase 如实提示，不能静默')
  // 装完必须复核 provider（不粉饰「pip 说装好了」）
  assert.match(install, /安装完成但 DmlExecutionProvider 未出现/)
  // 装包必须走国内镜像轮询（与 babeldoc 主安装同一通道）
  assert.match(install, /onnxruntime-directml/)
  assert.match(install, /CN_MIRRORS/, '镜像列表必须复用主安装通道的国内镜像')
})

test('L4 安装通道守卫：uv 通道优先（uv venv 没有 pip），pip 自举兜底不得删除', () => {
  // 真机教训：uv 建的 venv 默认不带 pip，纯 `-m pip` 直接 No module named pip。
  // 通道序必须是 uv（官方/探速源 → 镜像续装）→ 没有 uv 才 ensurepip 自举 + 国内镜像轮询。
  const install = readFileSync(join(ROOT, '..', 'dist', 'babeldoc-install.js'), 'utf8')
  assert.match(install, /\['pip', 'install', '--python', venvPy, pkg\]/, '必须优先用 uv 通道装（uv venv 没有 pip）')
  assert.match(install, /UV_DEFAULT_INDEX: UV_MIRROR/, 'uv 官方源失败必须镜像续装（与主安装链同款两段式）')
  assert.match(install, /'ensurepip', '--upgrade'/, '没有 uv 时必须 ensurepip 自举，不能裸跑 -m pip')
})
