// test/client-reload.test.mjs — 桌面端更新 / 停用再启用会重复执行 classic client.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')

test('R1 客户端可在旧版全局常量仍存在时连续导入两次', () => {
  const registrations = []
  const ctx = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    console, atob,
  }
  vm.createContext(ctx)
  // 1.9.0 及更早版本留下的全局 lexical：修复版若仅把 const 改成 var，第一行仍会冲突。
  vm.runInContext(`
    const DPR_THEME_PREF_KEY = 'old';
    const DPR_THEME_MIRROR_KEY = 'old';
    const DPR_SYNC_SCROLL_KEY = 'old';
  `, ctx, { filename: 'client-old-globals.js' })
  vm.runInContext(CLIENT, ctx, { filename: 'client-first-import.js' })
  vm.runInContext(CLIENT, ctx, { filename: 'client-second-import.js' })
  assert.equal(registrations.length, 2, '两次导入都应完成模块注册')
  assert.equal(registrations[0].id, '@ggboy123/dsh-paper-reader')
  assert.equal(registrations[1].id, '@ggboy123/dsh-paper-reader')
  assert.equal(typeof registrations[1].factory, 'function')
})

test('R2 顶层不再新增全局 lexical 声明（函数声明可安全重复）', () => {
  assert.doesNotMatch(CLIENT, /^(?:const|let|class)\s/m,
    '文件顶层不得出现 const / let / class；更新与重启用会把脚本再次放进同一全局环境')
})
