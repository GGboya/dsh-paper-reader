// test/translation-versions.test.mjs — 译文版本：不可变历史 + 当前指针 + 文献管理联动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync, symlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listTranslationVersions,
  translationVariantPath,
  translationStoreDir,
  publishTranslationVersion,
  activateTranslationVersion,
  deleteTranslationVersion,
} from '../dist/translation-versions.js'
import { renamePaper, movePaper, deletePaper, restoreTrashItem, listTrash } from '../dist/library-manage.js'

function env(layout = 'folder') {
  const data = mkdtempSync(join(tmpdir(), 'dpr-versions-'))
  const dir = layout === 'folder' ? join(data, 'T', 'P') : join(data, 'T')
  mkdirSync(dir, { recursive: true })
  const ref = { topic: 'T', name: 'P', pdfPath: join(dir, 'P.pdf') }
  writeFileSync(ref.pdfPath, '%PDF-original')
  return { data, ref, dir }
}
function canonical(ref, variant) { return ref.pdfPath.slice(0, -4) + `-${variant}.pdf` }
function put(path, text = '%PDF-translation') { writeFileSync(path, text); return path }
function publish(ref, model = 'model-a') {
  const source = mkdtempSync(join(tmpdir(), 'dpr-candidate-'))
  return publishTranslationVersion(ref, {
    model, provider: 'test-provider', endpointId: 'saved-1',
    files: [{ source: put(join(source, 'mono.pdf'), `%PDF-${model}`), variant: 'zh' }],
  })
}

test('V1 旧 -zh/-dual 自动成为 v1；模型未知如实为空，不创建任何文件', () => {
  const { ref } = env()
  put(canonical(ref, 'zh'), '%PDF-old')
  put(canonical(ref, 'dual'), '%PDF-old-dual')
  const state = listTranslationVersions(ref)
  assert.equal(state.activeId, 'v1')
  assert.equal(state.versions.length, 1)
  assert.equal(state.versions[0].model, null)
  assert.deepEqual(state.versions[0].variants, { zh: true, dual: true })
  assert.equal(translationVariantPath(ref, 'zh'), canonical(ref, 'zh'))
  assert.equal(existsSync(translationStoreDir(ref)), false, '只读列表不能创建版本目录')
})

test('V2 新翻译从 v2 开始并自动切换；v1 文件不动，预览指定版本不改 activeId', async () => {
  const { ref } = env()
  put(canonical(ref, 'zh'), '%PDF-old')
  const v2 = await publish(ref, 'model-b')
  assert.equal(v2.id, 'v2')
  assert.equal(v2.provider, 'test-provider')
  assert.equal(listTranslationVersions(ref).activeId, 'v2')
  assert.equal(readFileSync(canonical(ref, 'zh'), 'utf8'), '%PDF-old')
  assert.equal(readFileSync(translationVariantPath(ref, 'zh'), 'utf8'), '%PDF-model-b')
  assert.equal(readFileSync(translationVariantPath(ref, 'zh', 'v1'), 'utf8'), '%PDF-old')
  assert.equal(listTranslationVersions(ref).activeId, 'v2', '显式预览 v1 不得切换当前版本')
  assert.throws(() => translationVariantPath(ref, 'dual', 'v2'), /没有中英对照产物/)
  assert.throws(() => translationVariantPath(ref, 'zh', 'v99'), /不存在/)
})

test('V3 连续发布保留全部成功版本；切换只改指针，当前版本禁止删除', async () => {
  const { ref } = env()
  put(canonical(ref, 'zh'))
  await publish(ref, 'model-b')
  await publish(ref, 'model-c')
  let state = listTranslationVersions(ref)
  assert.deepEqual(state.versions.map((v) => v.id), ['v3', 'v2', 'v1'])
  assert.equal(state.activeId, 'v3')
  await activateTranslationVersion(ref, 'v1')
  assert.equal(listTranslationVersions(ref).activeId, 'v1')
  assert.equal(readFileSync(translationVariantPath(ref, 'zh', 'v3'), 'utf8'), '%PDF-model-c')
  await assert.rejects(deleteTranslationVersion(ref, 'v1'), /当前版本不能直接删除/)
  await deleteTranslationVersion(ref, 'v2')
  state = listTranslationVersions(ref)
  assert.deepEqual(state.versions.map((v) => v.id), ['v3', 'v1'])
  assert.equal(existsSync(join(translationStoreDir(ref), 'v2')), false)
  assert.equal(readFileSync(translationVariantPath(ref, 'zh', 'v3'), 'utf8'), '%PDF-model-c')
})

test('V4 发布中途失败：当前版本与旧文件不变，本次候选目录清理', async () => {
  const { ref } = env()
  put(canonical(ref, 'zh'), '%PDF-safe')
  const source = mkdtempSync(join(tmpdir(), 'dpr-candidate-'))
  const good = put(join(source, 'mono.pdf'), '%PDF-new')
  await assert.rejects(publishTranslationVersion(ref, { files: [
    { source: good, variant: 'zh' }, { source: join(source, 'missing.pdf'), variant: 'dual' },
  ] }))
  assert.equal(listTranslationVersions(ref).activeId, 'v1')
  assert.equal(readFileSync(canonical(ref, 'zh'), 'utf8'), '%PDF-safe')
  assert.equal(existsSync(join(translationStoreDir(ref), 'v2')), false)
})

test('V5 损坏清单回退旧版但拒绝覆盖；历史目录保持原样', async () => {
  const { ref } = env()
  put(canonical(ref, 'zh'))
  await publish(ref)
  const index = join(translationStoreDir(ref), 'index.json')
  writeFileSync(index, '{broken')
  assert.match(listTranslationVersions(ref).warning, /无法读取/)
  assert.equal(listTranslationVersions(ref).activeId, 'v1')
  await assert.rejects(publish(ref), /损坏/)
  assert.equal(readFileSync(index, 'utf8'), '{broken')
  assert.equal(existsSync(join(translationStoreDir(ref), 'v2', 'zh.pdf')), true)
})

test('V6 旧平铺：改名 → 跨专题移动 → 删除恢复，版本目录始终跟随且可读', async () => {
  const { data, ref } = env('legacy')
  put(canonical(ref, 'zh'))
  await publish(ref)
  renamePaper(data, 'T', 'P', 'Q')
  const movedRef = { topic: 'T', name: 'Q', pdfPath: join(data, 'T', 'Q.pdf') }
  assert.equal(listTranslationVersions(movedRef).activeId, 'v2')
  assert.equal(existsSync(join(data, 'T', '.Q.translations', 'v2', 'zh.pdf')), true)
  mkdirSync(join(data, 'U'))
  movePaper(data, 'T', 'Q', 'U')
  const inFolder = { topic: 'U', name: 'Q', pdfPath: join(data, 'U', 'Q', 'Q.pdf') }
  assert.equal(listTranslationVersions(inFolder).activeId, 'v2')
  assert.equal(existsSync(join(data, 'U', 'Q', '.translations', 'v2', 'zh.pdf')), true)
  const deleted = deletePaper(data, 'U', 'Q')
  const trash = listTrash(data)
  const item = trash.items.find((x) => x.kind === 'paper' && x.name === 'Q')
  assert.ok(item)
  restoreTrashItem(data, item.id)
  assert.equal(listTranslationVersions(inFolder).activeId, 'v2')
  assert.equal(readFileSync(translationVariantPath(inFolder, 'zh', 'v2'), 'utf8'), '%PDF-model-a')
  assert.equal(existsSync(join(data, 'U', 'Q', '.translations')), true)
  assert.ok(deleted.ok)
})

test('V7 新布局：改名/移动不需要重写清单，版本仍按 activeId 解析', async () => {
  const { data, ref } = env('folder')
  put(canonical(ref, 'zh'))
  await publish(ref)
  renamePaper(data, 'T', 'P', 'Q')
  mkdirSync(join(data, 'U'))
  movePaper(data, 'T', 'Q', 'U')
  const moved = { topic: 'U', name: 'Q', pdfPath: join(data, 'U', 'Q', 'Q.pdf') }
  assert.equal(listTranslationVersions(moved).activeId, 'v2')
  assert.equal(readFileSync(translationVariantPath(moved, 'zh'), 'utf8'), '%PDF-model-a')
})

test('V8 版本目录是符号链接时回退读取并拒绝发布，不跟随到库外', { skip: process.platform === 'win32' }, async () => {
  const { data, ref } = env()
  put(canonical(ref, 'zh'))
  const outside = mkdtempSync(join(tmpdir(), 'dpr-outside-'))
  symlinkSync(outside, translationStoreDir(ref), 'dir')
  assert.match(listTranslationVersions(ref).warning, /异常/)
  await assert.rejects(publish(ref), /拒绝|异常|损坏/)
  assert.deepEqual(readdirSync(outside), [])
  assert.equal(lstatSync(translationStoreDir(ref)).isSymbolicLink(), true)
  assert.equal(existsSync(join(data, '.trash')), false)
})
