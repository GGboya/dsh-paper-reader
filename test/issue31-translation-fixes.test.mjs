// test/issue31-translation-fixes.test.mjs — issue #31 四个修复的回归守卫
//   ① NO_PROXY 里的 `[::1]` 打崩 httpx(初始化即炸) → stripBracketedIpv6Loopback
//   ② 翻译桥转发 temperature,GPT 拒参数全段失败 → 不再转发
//   ③ 段落全败退出码仍 0,纯英文"译文"发布成成功 → 发布前中文含量抽检
//   ④ 无上游状态一律兜 400,废掉 Python SDK 的 5xx 重试 → bridgeErrorStatus 映射
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const { stripBracketedIpv6Loopback, countCjkInPdf } = await import(pathToFileURL(join(ROOT, '..', 'dist', 'translate.js')))
const { bridgeErrorStatus } = await import(pathToFileURL(join(ROOT, '..', 'dist', 'harness-translate.js')))

test('① NO_PROXY:独立的 [::1] 摘除,裸 ::1 与其余条目保留,父环境不动', () => {
  const env = { NO_PROXY: 'localhost, [::1],127.0.0.1', no_proxy: '[::1]', OTHER: 'x' }
  const out = stripBracketedIpv6Loopback(env)
  assert.equal(out.NO_PROXY, 'localhost,127.0.0.1')
  assert.equal(out.no_proxy, '')
  assert.equal(env.NO_PROXY, 'localhost, [::1],127.0.0.1', '原环境对象不得被改')
  // 裸 ::1(httpx 能解析)必须保留;没有 [ 的环境原样透传
  assert.equal(stripBracketedIpv6Loopback({ no_proxy: '::1,localhost' }).no_proxy, '::1,localhost')
  assert.deepEqual(stripBracketedIpv6Loopback({ PATH: 'x' }), { PATH: 'x' })
})

test('② 翻译桥不再转发 temperature(源码契约:llm.stream 调用里没有 temperature)', () => {
  const src = readFileSync(join(ROOT, '..', 'src', 'harness-translate.ts'), 'utf8')
  const streamCall = src.slice(src.indexOf('llm.stream({'), src.indexOf(')) {', src.indexOf('llm.stream({')))
  assert.ok(streamCall.length > 0, '找不到 llm.stream 调用')
  const code = streamCall.replace(/\/\/[^\n]*/g, '') // 注释里允许提到 temperature(解释为什么删)
  assert.doesNotMatch(code, /temperature/, '桥必须停转发 temperature(#31-2:GPT-6.1-Sol 拒收)')
})

test('③ 中文含量抽检:纯英文 PDF 计 0,真译文数量级为千(运行时生成夹具)', async () => {
  // 1x1 空页 PDF(无文本层):模拟 babeldoc 段落全败时发布的"纯英文/空"产物。
  // 夹具运行时生成——test/ 下不许建子目录(VA16 会遍历 readFileSync,EISDIR)
  const dir = mkdtempSync(join(tmpdir(), 'dpr-issue31-'))
  try {
    const emptyPdf = join(dir, 'empty.pdf')
    writeFileSync(emptyPdf,
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')
    assert.equal(await countCjkInPdf(emptyPdf), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ bridgeErrorStatus:取消 499 / 上游状态保留 / 超时 504 / 连接错误 502', () => {
  assert.equal(bridgeErrorStatus(new Error('anything'), true), 499)
  assert.equal(bridgeErrorStatus(Object.assign(new Error('upstream says no'), { status: 429 })), 429)
  assert.equal(bridgeErrorStatus(Object.assign(new Error('x'), { statusCode: 500 })), 500)
  assert.equal(bridgeErrorStatus(new Error('Request timed out.')), 504)
  assert.equal(bridgeErrorStatus(new Error('Connection error.')), 502)
  assert.equal(bridgeErrorStatus(new Error('')), 502)
})

test('③ 发布路径守卫:中文含量异常时不得发布(源码契约)', () => {
  const src = readFileSync(join(ROOT, '..', 'src', 'translate.ts'), 'utf8')
  const publish = src.slice(src.indexOf('// 产出从 scratch 挪回文献目录'), src.indexOf("console.log(`[dsh-paper-reader] babeldoc done"))
  assert.match(publish, /countCjkInPdf\(probe\)/, '发布前必须抽检')
  assert.match(publish, /ZH_EMPTY_THRESHOLD/, '低于阈值必须拦截')
  assert.match(publish, /翻译实际未产出中文/, '拦截文案必须如实说明并给日志路径')
  assert.match(publish, /paraErrs > 0/, '部分段落失败要计数告警')
})
