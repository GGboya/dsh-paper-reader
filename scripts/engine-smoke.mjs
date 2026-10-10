#!/usr/bin/env node
// engine-smoke.mjs — 翻译引擎安装链路的冒烟测试（配合 CI 的 windows-latest 干净环境）。
// 用法：node scripts/engine-smoke.mjs <scenario> [--keep]
// 场景：
//   clean        全新安装（临时 home/data，走完下载 uv → venv → babeldoc 全链路）
//   managed-uv   强制走插件托管 uv 下载路径（DSH_PR_MANAGED_UV_ONLY=1，绕开 runner 预装的 uv）
//   pip-fallback 强制走 pip + 国内镜像备用通道（DSH_PR_FORCE_PIP_CHANNEL=1）
//   repair       装完后破坏 venv（删 pymupdf），模拟「exe 在、依赖残缺」，验证自检→修复
//   translate    clean + 本地 mock OpenAI 端点真跑一遍 babeldoc 翻译管线（确定性、无需 LLM key）
// 内部子命令：once（repair 场景用子进程跑，避开 babeldoc-install 进程内 verified 缓存，
// 顺便模拟真实 app 重启）。需先 pnpm build（import 的是 dist/ 产物）。
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const isWin = process.platform === 'win32'
const { ensureBabeldoc } = await import(
  new URL('../dist/babeldoc-install.js', import.meta.url)
)

const args = process.argv.slice(2)
const scenario = args[0]
const keep = args.includes('--keep')
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

/** 与 translate.ts findBabeldoc 的第一候选位一致：只认插件托管 venv，不碰 PATH。 */
function venvDirOf(dataDir) {
  return join(dirname(dataDir), '.venv-pdf2zh')
}
function venvBin(venvDir) {
  return join(venvDir, isWin ? 'Scripts' : 'bin', isWin ? 'babeldoc.exe' : 'babeldoc')
}
function findExistingOf(dataDir) {
  const bin = venvBin(venvDirOf(dataDir))
  return Promise.resolve(existsSync(bin) ? bin : null)
}

async function ensureOnce(home, dataDir) {
  const bin = await ensureBabeldoc(dataDir, home, () => findExistingOf(dataDir), (p) =>
    console.log(`[phase] ${p}`),
  )
  const version = execFileSync(bin, ['--version'], { timeout: 60_000 }).toString().trim()
  console.log(`[ok] babeldoc 可用：${bin}（${version}）`)
  return bin
}

/** 跑一次完整安装（子进程，模拟 app 重启后的全新进程）。 */
function runOnceChild(home, dataDir, env = {}) {
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), 'once', '--home', home, '--data', dataDir],
    { stdio: 'inherit', env: { ...process.env, ...env }, timeout: 40 * 60_000 },
  )
  if (r.status !== 0) fail(`once 子进程失败（exit ${r.status}）`)
}

/** 生成一个最小合法 PDF（ASCII 内容，xref 偏移按字节算）。 */
function buildTinyPdf(text) {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`
  return pdf
}

/** 破坏 venv：删掉 pymupdf 包本体和 dist-info，模拟「exe 在、依赖残缺」的坏安装。 */
async function corruptVenv(venvDir) {
  const spRoot = isWin
    ? join(venvDir, 'Lib', 'site-packages')
    : join(
        venvDir,
        'lib',
        (await readdir(join(venvDir, 'lib'))).find((d) => d.startsWith('python')),
        'site-packages',
      )
  const victims = (await readdir(spRoot)).filter(
    (d) => d === 'pymupdf' || /^pymupdf-.*\.dist-info$/.test(d),
  )
  if (victims.length === 0) fail(`未找到 pymupdf 安装痕迹：${spRoot}`)
  for (const v of victims) await rm(join(spRoot, v), { recursive: true, force: true })
  console.log(`[corrupt] 已删除 ${victims.join(', ')}`)
}

/**
 * 本地 mock OpenAI 端点。babeldoc 0.6+ 只有 LLM 翻译后端（没有 bing/google），
 * mock 一个 127.0.0.1 的 /chat/completions：确定性、免费、无外网依赖。
 * 翻译 prompt 回「Input:\n\n」之后的原文（恒等翻译，只验证管线不验证翻译质量）；
 * JSON mode（术语抽取等）回空对象；usage 字段齐全（babeldoc 会统计 token）。
 */
function startMockOpenAI() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let content = 'mock'
      try {
        const j = JSON.parse(body)
        if (j.response_format?.type === 'json_object') content = '{}'
        else {
          const user = [...(j.messages ?? [])].reverse().find((m) => m.role === 'user')
          const text = typeof user?.content === 'string' ? user.content : ''
          const marker = 'Input:\n\n'
          const i = text.indexOf(marker)
          content = i >= 0 ? text.slice(i + marker.length) : text || 'mock'
        }
      } catch {}
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          created: 0,
          model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      }),
    )
  })
}

/** 探测 babeldoc 支持的可选参数（不认识的参数会让它启动即报错，与 translate.ts 同策略）。 */
function probeFlags(bin, candidates) {
  try {
    const help = execFileSync(bin, ['--help'], { timeout: 60_000 }).toString()
    return candidates.filter((f) => help.includes(`--${f}`)).map((f) => `--${f}`)
  } catch {
    return []
  }
}

async function main() {
  if (!scenario || scenario === 'once') {
    if (scenario === 'once') {
      const home = opt('--home')
      const data = opt('--data')
      if (!home || !data) fail('once 需要 --home 与 --data')
      await ensureOnce(home, data)
      return
    }
    fail('用法：node scripts/engine-smoke.mjs <clean|managed-uv|pip-fallback|repair|translate> [--keep]')
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-pr-smoke-'))
  const home = join(root, 'home')
  const dataDir = join(root, 'library')
  await mkdir(dataDir, { recursive: true })
  console.log(`[setup] 临时目录 ${root}`)
  try {
    if (scenario === 'clean' || scenario === 'translate') {
      await ensureOnce(home, dataDir)
    } else if (scenario === 'managed-uv') {
      process.env.DSH_PR_MANAGED_UV_ONLY = '1'
      await ensureOnce(home, dataDir)
      const managed = join(home, '.dsh-paper-reader', 'bin', isWin ? 'uv.exe' : 'uv')
      if (!existsSync(managed)) fail('DSH_PR_MANAGED_UV_ONLY=1 但托管 uv 未落盘')
      console.log(`[ok] 托管 uv 已下载并校验：${managed}`)
    } else if (scenario === 'pip-fallback') {
      process.env.DSH_PR_FORCE_PIP_CHANNEL = '1'
      await ensureOnce(home, dataDir)
    } else if (scenario === 'repair') {
      runOnceChild(home, dataDir)
      await corruptVenv(venvDirOf(dataDir))
      console.log('[repair] 依赖已破坏，重跑 ensure（应自检失败→自动修复）…')
      runOnceChild(home, dataDir)
      console.log('[ok] 残缺安装已自动修复')
    } else {
      fail(`未知场景：${scenario}`)
    }

    if (scenario === 'translate') {
      const bin = venvBin(venvDirOf(dataDir))
      const pdf = join(root, 'tiny.pdf')
      const out = join(root, 'out')
      await mkdir(out, { recursive: true })
      await writeFile(pdf, buildTinyPdf('The quick brown fox jumps over the lazy dog.'))
      const mock = await startMockOpenAI()
      console.log(`[translate] mock OpenAI 端点 ${mock.url}，真跑 babeldoc 管线 …`)
      try {
        // 必须异步：mock server 与 babeldoc 同进程,execFileSync 会阻塞事件循环,
        // mock 永远 accept 不到请求 → 双等死锁(已踩过)
        await execFileP(
          bin,
          [
            '--files', pdf, '--lang-in', 'en', '--lang-out', 'zh-CN',
            '--openai', '--openai-model', 'mock',
            '--openai-base-url', mock.url, '--openai-api-key', 'mock',
            '--qps', '16', '--no-watermark', '--output', out,
            // 与 translate.ts 相同的可选参数探测（skip-figure-text 仅 fork 有）
            ...probeFlags(bin, ['skip-figure-text', 'no-auto-extract-glossary']),
          ],
          { timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' } },
        ).catch((e) => {
          // 失败时打出 babeldoc 日志尾巴再抛,CI 上不用翻原始日志
          const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().slice(-2000)
          if (tail) console.error(tail)
          throw e
        })
      } finally {
        await mock.close()
      }
      const produced = (await readdir(out)).filter((f) => f.endsWith('.pdf'))
      if (produced.length === 0) fail('翻译未产出 PDF')
      console.log(`[ok] 翻译产出：${produced.join(', ')}`)
    }
    console.log(`✓ 场景 ${scenario} 通过`)
  } finally {
    if (keep) console.log(`[keep] 临时目录保留：${root}`)
    else await rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
