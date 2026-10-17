#!/usr/bin/env node
// release.mjs — 一条命令发版：跑测试 → 同步 README 版本 → bump + commit + annotated tag
//               → push → npm publish → 建 GitHub Release（发布记录不放 README）。
// 用法：pnpm release <patch|minor|major|x.y.z> ["一句话摘要"] [--skip-tests] [--dry-run]
// 例：  pnpm release minor "划词翻译 + 中英分屏"
//       pnpm release patch "修 Windows 占用语义"
//
// README 版本守卫（test/library-clear-and-busy.test.mjs C3）只允许两份 README 出现当前
// 版本号；本脚本会把旧版本号整体替换成新版本号，并在提交前按同样的规则自检。
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const NPM = isWin ? 'npm.cmd' : 'npm'
const GH = isWin ? 'gh.cmd' : 'gh'
const GIT = 'git'
const READMES = ['README.md', 'README_EN.md']

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('-')))
const positional = argv.filter((a) => !a.startsWith('-'))
const bump = positional[0]
const summary = positional.slice(1).join(' ').trim()
const dryRun = flags.has('--dry-run')
const skipTests = flags.has('--skip-tests')
const KNOWN_FLAGS = new Set(['--skip-tests', '--dry-run', '-h', '--help'])

for (const f of flags) if (!KNOWN_FLAGS.has(f)) fail(`未知参数：${f}`)
if (flags.has('-h') || flags.has('--help')) usage(0)
if (!bump || !isValidBump(bump)) usage(1)

// ---------- 基础工具 ----------

function usage(code) {
  console.log(`用法：pnpm release <patch|minor|major|x.y.z> ["一句话摘要"] [--skip-tests] [--dry-run]

  pnpm release patch "修 Windows 占用语义"     # 1.5.0 → 1.5.1
  pnpm release minor "划词翻译 + 中英分屏"      # 1.5.1 → 1.6.0
  pnpm release 2.0.0 "首个稳定大版本"

  --skip-tests  跳过 npm test（不推荐）
  --dry-run     只打印将执行的命令，不做任何修改`)
  process.exit(code)
}

function fail(msg) {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

function isValidBump(v) {
  // 只支持稳定版 x.y.z：README 版本守卫按 x.y.z 匹配，预发布版会误伤。
  return ['patch', 'minor', 'major'].includes(v) || /^\d+\.\d+\.\d+$/.test(v)
}

function nextVersion(current, target) {
  if (/^\d+\.\d+\.\d+$/.test(target)) return target
  const [major, minor, patch] = current.split('.').map(Number)
  if (target === 'major') return `${major + 1}.0.0`
  if (target === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

function displayCmd(cmd, args) {
  return [cmd.replace(/\.cmd$/, ''), ...args]
    .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
    .join(' ')
}

function run(cmd, args, { capture = false, mutating = false, skipInDryRun = false, recovery = '' } = {}) {
  console.log(`\n$ ${displayCmd(cmd, args)}`)
  if (dryRun && (mutating || skipInDryRun)) return { status: 0, stdout: '' }

  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  })
  if (r.error) fail(`无法执行 ${cmd}：${r.error.message}`)
  if (r.status !== 0) {
    if (capture && r.stderr) console.error(r.stderr.trim())
    if (recovery) console.error(`\n修复后可继续执行：\n${recovery}`)
    fail(`${cmd} 失败（exit ${r.status}）`)
  }
  return r
}

function capture(cmd, args) {
  return (run(cmd, args, { capture: true }).stdout || '').trim()
}

function tagExists(tag) {
  return spawnSync(GIT, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: ROOT }).status === 0
}

// ---------- README 版本同步（与 C3 守卫同规则） ----------

function planReadmeUpdates(current, next) {
  return READMES.map((file) => {
    const path = join(ROOT, file)
    const oldText = readFileSync(path, 'utf8')
    const newText = oldText
      .replaceAll(`v${current}`, `v${next}`)
      .replaceAll(`@${current}`, `@${next}`)
    return { file, path, newText, changed: newText !== oldText }
  })
}

function checkReadmes(updates, version) {
  for (const { file, newText } of updates) {
    if (!newText.includes(`v${version}`) && !newText.includes(`@${version}`)) {
      fail(`${file} 未出现新版本 v${version} / @${version}；请检查「当前版本」行`)
    }
    const others = [...new Set(
      [...newText.matchAll(/[v@](\d+\.\d+\.\d+)/g)].map((m) => m[1]).filter((x) => x !== version),
    )]
    if (others.length) {
      fail(`${file} 会残留其它版本号：${others.join(', ')}（C3 守卫只允许当前版本）`)
    }
  }
}

// ---------- 主流程 ----------

const branch = capture(GIT, ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') fail(`当前分支是「${branch}」，发版必须从 main 进行`)

const dirty = capture(GIT, ['status', '--porcelain'])
if (dirty) fail(`工作区不干净，请先提交或清理：\n${dirty}`)

run(GIT, ['fetch', 'origin', 'main'], { skipInDryRun: true })
const counts = capture(GIT, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
const [ahead, behind] = counts.split(/\s+/).map(Number)
if (behind > 0) fail(`本地落后 origin/main ${behind} 个提交，请先 git pull --ff-only`)
if (ahead > 0) console.log(`ℹ 本地领先 origin/main ${ahead} 个提交，将随发版一起推送`)

run(GH, ['auth', 'status'], { capture: true })
run(NPM, ['whoami'], { capture: true, recovery: 'npm login' })

const pkgPath = join(ROOT, 'package.json')
const current = JSON.parse(readFileSync(pkgPath, 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(current)) fail(`当前版本 ${current} 不是稳定的 x.y.z`)
const next = nextVersion(current, bump)
if (compareVersions(next, current) <= 0) fail(`新版本 ${next} 必须大于当前版本 ${current}`)

const tag = `v${next}`
const title = summary ? `${tag} — ${summary}` : tag
const commitMessage = summary ? `release: ${tag} — ${summary}` : `release: ${tag}`
const recovery = [
  'git push --follow-tags',
  'npm publish',
  `gh release create ${tag} --verify-tag --generate-notes --title ${JSON.stringify(title)}`,
].join('\n')

if (tagExists(tag)) fail(`本地已存在 tag ${tag}`)
const remoteTag = spawnSync(GIT, ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], {
  cwd: ROOT,
  encoding: 'utf8',
})
if (remoteTag.status === 0) fail(`远端已存在 tag ${tag}`)

console.log(`\n准备发布 ${current} → ${next}`)
if (!skipTests) {
  run(NPM, ['test'], { skipInDryRun: true })
} else {
  console.log('\n⚠ 已跳过测试（--skip-tests）')
}

const readmeUpdates = planReadmeUpdates(current, next)
for (const u of readmeUpdates) {
  console.log(`  ${u.file}: ${u.changed ? `${current} → ${next}` : '未找到旧版本号，需手工检查'}`)
}
checkReadmes(readmeUpdates, next)
if (!dryRun) {
  for (const u of readmeUpdates) if (u.changed) writeFileSync(u.path, u.newText)
}

run(NPM, ['version', next, '--no-git-tag-version'], { mutating: true })

if (!dryRun) {
  const actual = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  if (actual !== next) fail(`package.json 版本未更新到 ${next}（实际 ${actual}）`)
}

run(GIT, ['add', 'package.json', ...READMES], { mutating: true })
run(GIT, ['commit', '-m', commitMessage], { mutating: true })
run(GIT, ['tag', '-a', tag, '-m', title], { mutating: true })
run(GIT, ['push', '--follow-tags'], { mutating: true, recovery })
run(NPM, ['publish'], {
  mutating: true,
  recovery: [`npm publish`, `gh release create ${tag} --verify-tag --generate-notes --title ${JSON.stringify(title)}`].join('\n'),
})
run(GH, ['release', 'create', tag, '--verify-tag', '--generate-notes', '--title', title], {
  mutating: true,
  recovery: `gh release create ${tag} --verify-tag --generate-notes --title ${JSON.stringify(title)}`,
})

if (dryRun) {
  console.log('\n✓ dry-run 完成：以上命令均未执行，工作区未修改')
  process.exit(0)
}

console.log(`\n✅ ${tag} 发布完成`)
console.log(`   https://github.com/GGboya/dsh-paper-reader/releases/tag/${tag}`)
console.log(`   https://www.npmjs.com/package/@ggboy123/dsh-paper-reader/v/${next}`)
