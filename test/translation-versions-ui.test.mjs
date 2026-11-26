// test/translation-versions-ui.test.mjs — 重译进度与译文版本面板的浏览器端契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReaderScript } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const { script: READER } = readReaderScript(join(REPO, 'reader', 'index.html'))
const HTML = readFileSync(join(REPO, 'reader', 'index.html'), 'utf8')
const HOST = readFileSync(join(REPO, 'src', 'host.ts'), 'utf8')
const STORE = readFileSync(join(REPO, 'src', 'translation-versions.ts'), 'utf8')

function updateProgressWith(state) {
  const start = READER.indexOf('function updateZhProgress() {')
  const end = READER.indexOf('let zhCancelArmed = false;', start)
  assert.ok(start >= 0 && end > start)
  const box = {
    hidden: true,
    classList: { toggle() {}, remove() {} },
    querySelector(selector) {
      if (selector === '.fill') return this.fill
      if (selector === '.txt') return this.txt
      throw new Error(selector)
    },
    fill: { style: {} }, txt: { textContent: '' }, title: '',
  }
  const cancel = { style: {}, textContent: '', disabled: false }
  new Function('$', 'zhState', 'zhCancelArmed', 'renderVersionsRunning', `${READER.slice(start, end)}\nreturn updateZhProgress()`)(
    (id) => id === 'zh-prog' ? box : cancel,
    state, false, () => {},
  )
  return { box, cancel }
}

test('U1 准备阶段 progress:null 也必须显示顶栏进度，不能再“点了没反应”', () => {
  const { box, cancel } = updateProgressWith({ busy: true, progress: null, phase: '正在检查翻译引擎…' })
  assert.equal(box.hidden, false)
  assert.equal(box.txt.textContent, '正在检查翻译引擎…')
  assert.equal(box.title, '正在检查翻译引擎…')
  assert.equal(cancel.style.display, '')
})

test('U2 有真实 overall 时显示阶段与百分比；结束后隐藏', () => {
  const running = updateProgressWith({ busy: true, progress: { label: '翻译段落', overall: 67.6, text: '翻译段落（12/20） · 68%' }, phase: '翻译段落…' })
  assert.equal(running.box.hidden, false)
  assert.equal(running.box.txt.textContent, '翻译段落 68%')
  assert.equal(running.box.fill.style.width, '67.6%')
  const done = updateProgressWith({ busy: false, progress: null })
  assert.equal(done.box.hidden, true)
  assert.equal(done.cancel.style.display, 'none')
})

test('U3 视图菜单与顶栏进度都能打开版本面板，键盘也可触发', () => {
  assert.match(HTML, /<button data-act="versions">译文版本…<\/button>/)
  assert.match(HTML, /id="zh-prog" hidden role="button" tabindex="0"/)
  assert.match(READER, /\$\('zh-prog'\)\.onclick = \(\) => void openVersionsPop\(\)/)
  assert.match(READER, /\$\('zh-prog'\)\.onkeydown/)
  assert.match(READER, /else if \(act === 'versions'\) void openVersionsPop\(\)/)
})

test('U4 预览与设为当前分离；切论文清空预览；删除两击确认且当前版本无删除按钮', () => {
  assert.match(READER, /selectedVersion = id;\s+await invalidateAltViews\(\);\s+await setViewMode/)
  assert.match(READER, /api\('\/zh\/versions\/activate'[\s\S]{0,250}selectedVersion = null/)
  assert.match(READER, /current = \{ topic, name \};\s+selectedVersion = null;\s+versionData =/)
  assert.match(READER, /if \(versionDeleteArmed !== id\)/)
  assert.match(READER, /const actions = current\s+\? `<span class="version-current-label"/, '当前版本只提供打开，不提供删除')
  assert.match(STORE, /当前版本不能直接删除/)
})

test('U5 服务端提供列表/激活/删除与指定版本 PDF；ETag 包含版本指针', () => {
  for (const route of ["sub === '/api/zh/versions'", "sub === '/api/zh/versions/activate'", "sub === '/api/zh/versions/delete'"]) assert.ok(HOST.includes(route))
  assert.match(HOST, /pdfVariantPath\(ref, variant, requestedVersion\)/)
  assert.match(HOST, /const versionTag = variant \? requestedVersion \|\| listTranslationVersions\(ref\)\.activeId/)
  assert.match(HOST, /const etag = `"\$\{versionTag\}-/)
})

test('U6 文案不再声称“先删旧译文”：重译期间当前版本保持可读', () => {
  assert.ok(!READER.includes('已删除旧译文，开始重新翻译'))
  assert.ok(!READER.includes('force=true 时服务端先删旧译文'))
  assert.match(READER, /开始创建新翻译版本/)
  assert.match(READER, /失败或取消不会影响当前版本/)
  assert.match(HTML, /成功版本全部保留在本篇论文目录；删除需二次确认，不自动清理。/)
})

test('D1 中英 README / features 同步版本保留、失败不覆盖与磁盘代价', () => {
  for (const file of ['README.md', 'docs/features.md']) {
    const text = readFileSync(join(REPO, file), 'utf8')
    assert.match(text, /译文版本/)
    assert.match(text, /全部成功版本保留|全部历史版本/)
  }
  assert.match(readFileSync(join(REPO, 'docs', 'features.md'), 'utf8'), /磁盘占用/)
  for (const file of ['README_EN.md', 'docs/features_EN.md']) {
    const text = readFileSync(join(REPO, file), 'utf8')
    assert.match(text, /[Tt]ranslation version/)
    assert.match(text, /all (?:successful versions|kept)|all kept/i)
  }
  assert.match(readFileSync(join(REPO, 'docs', 'features_EN.md'), 'utf8'), /disk space/)
})

