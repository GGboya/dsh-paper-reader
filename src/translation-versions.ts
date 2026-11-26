// translation-versions.ts — 每篇论文的译文版本清单与不可变版本文件。
//
// 布局：
//   新布局 <专题>/<论文>/<论文>.pdf       → <专题>/<论文>/.translations/
//   旧平铺 <专题>/<论文>.pdf              → <专题>/.<论文>.translations/
// 旧版 <论文>-zh.pdf / -dual.pdf 作为 v1（legacy）兼容读取；新产物发布到 .translations/vN/。
// activeId 只是指针：预览/切换/回滚不复制 PDF，重译也绝不先删当前版本。
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface VersionPaperRef { pdfPath: string; name?: string }
export type TranslationVariant = 'zh' | 'dual'
export interface TranslationVersion {
  id: string
  createdAt: string
  model: string | null
  provider: string | null
  endpointId: string | null
  variants: { zh: boolean; dual: boolean }
  bytes: number
  legacy?: boolean
}
export interface TranslationVersionState {
  activeId: string | null
  versions: TranslationVersion[]
  warning?: string
}
export interface PublishVersionInput {
  model?: string | null
  provider?: string | null
  endpointId?: string | null
  files: Array<{ source: string; variant: TranslationVariant }>
}

const VERSION_ID = /^v[1-9]\d*$/

function stemOf(ref: VersionPaperRef): string {
  return basename(ref.pdfPath, extname(ref.pdfPath))
}
export function translationStoreDir(ref: VersionPaperRef): string {
  const parent = dirname(ref.pdfPath)
  const stem = stemOf(ref)
  return basename(parent) === stem ? join(parent, '.translations') : join(parent, `.${stem}.translations`)
}
/** library-manage 在旧平铺改名/移动时按这个精确条目名连带处理。 */
export function translationStoreEntryName(ref: VersionPaperRef): string {
  return basename(translationStoreDir(ref))
}
function indexPath(ref: VersionPaperRef): string { return join(translationStoreDir(ref), 'index.json') }
function canonicalVariant(ref: VersionPaperRef, variant: TranslationVariant): string {
  return ref.pdfPath.slice(0, -extname(ref.pdfPath).length) + (variant === 'zh' ? '-zh.pdf' : '-dual.pdf')
}
function validVersionId(id: unknown): id is string { return typeof id === 'string' && VERSION_ID.test(id) }
function safeFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}
function fileBytes(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}
function versionFile(ref: VersionPaperRef, version: TranslationVersion, variant: TranslationVariant): string {
  return version.legacy ? canonicalVariant(ref, variant) : join(translationStoreDir(ref), version.id, `${variant}.pdf`)
}
function hydrate(ref: VersionPaperRef, raw: Partial<TranslationVersion> & { id: string }): TranslationVersion | null {
  if (!validVersionId(raw.id)) return null
  const legacy = raw.legacy === true
  const base = { ...raw, legacy } as TranslationVersion
  const zh = safeFile(versionFile(ref, base, 'zh'))
  const dual = safeFile(versionFile(ref, base, 'dual'))
  if (!zh && !dual) return null
  return {
    id: raw.id,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    model: typeof raw.model === 'string' && raw.model ? raw.model : null,
    provider: typeof raw.provider === 'string' && raw.provider ? raw.provider : null,
    endpointId: typeof raw.endpointId === 'string' && raw.endpointId ? raw.endpointId : null,
    variants: { zh, dual },
    bytes: (zh ? fileBytes(versionFile(ref, base, 'zh')) : 0) + (dual ? fileBytes(versionFile(ref, base, 'dual')) : 0),
    ...(legacy ? { legacy: true } : {}),
  }
}
function legacyVersion(ref: VersionPaperRef): TranslationVersion | null {
  const candidate = { id: 'v1', legacy: true } as TranslationVersion
  const hydrated = hydrate(ref, candidate)
  if (!hydrated) return null
  const paths = (['zh', 'dual'] as const).filter((v) => hydrated.variants[v]).map((v) => versionFile(ref, hydrated, v))
  const mtimes = paths.map((p) => { try { return statSync(p).mtimeMs } catch { return 0 } }).filter(Boolean)
  if (mtimes.length) hydrated.createdAt = new Date(Math.min(...mtimes)).toISOString()
  return hydrated
}
function byNewest(a: TranslationVersion, b: TranslationVersion): number {
  const ai = validVersionId(a.id) ? Number(a.id.slice(1)) : 0
  const bi = validVersionId(b.id) ? Number(b.id.slice(1)) : 0
  return bi - ai || b.createdAt.localeCompare(a.createdAt)
}
function fallbackState(ref: VersionPaperRef, warning?: string): TranslationVersionState {
  const legacy = legacyVersion(ref)
  return { activeId: legacy?.id ?? null, versions: legacy ? [legacy] : [], ...(warning ? { warning } : {}) }
}

/** 同步读取（zhStatus / pdfVariantPath 的既有同步契约不变）；坏清单回退旧版，但发布/删除会拒绝覆盖。 */
export function listTranslationVersions(ref: VersionPaperRef): TranslationVersionState {
  const store = translationStoreDir(ref)
  try {
    const storeStat = lstatSync(store)
    if (!storeStat.isDirectory() || storeStat.isSymbolicLink()) return fallbackState(ref, '译文版本目录异常，已回退到旧版译文；历史文件未改动')
  } catch { /* 目录不存在：仅旧版或尚未翻译 */ }
  const path = indexPath(ref)
  if (!existsSync(path)) return fallbackState(ref)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { activeId?: unknown; versions?: unknown }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.versions)) return fallbackState(ref, '译文版本清单损坏，已回退到旧版译文；历史文件未改动')
    const versions: TranslationVersion[] = []
    for (const item of raw.versions) {
      if (!item || typeof item !== 'object') continue
      const hydrated = hydrate(ref, item as Partial<TranslationVersion> & { id: string })
      if (hydrated && !versions.some((v) => v.id === hydrated.id)) versions.push(hydrated)
    }
    const legacy = legacyVersion(ref)
    if (legacy && !versions.some((v) => v.id === legacy.id)) versions.push(legacy)
    versions.sort(byNewest)
    if (!versions.length) return { activeId: null, versions: [] }
    const activeId = typeof raw.activeId === 'string' && versions.some((v) => v.id === raw.activeId) ? raw.activeId : versions[0]!.id
    return { activeId, versions }
  } catch {
    return fallbackState(ref, '译文版本清单无法读取，已回退到旧版译文；历史文件未改动')
  }
}

export function activeTranslationVersion(ref: VersionPaperRef): string | null {
  return listTranslationVersions(ref).activeId
}

/** 解析某个变体的实际文件；显式 version 不存在时抛错，绝不静默换成另一版。 */
export function translationVariantPath(ref: VersionPaperRef, variant: TranslationVariant, versionId?: string | null): string {
  const state = listTranslationVersions(ref)
  const id = versionId || state.activeId
  const version = state.versions.find((v) => v.id === id)
  if (!version) throw new Error(versionId ? `译文版本不存在：${versionId}` : '当前没有可用的译文版本')
  if (!version.variants[variant]) throw new Error(`译文版本 ${version.id} 没有${variant === 'zh' ? '纯中文' : '中英对照'}产物`)
  return versionFile(ref, version, variant)
}

function assertWritableStore(ref: VersionPaperRef): void {
  const dir = translationStoreDir(ref)
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('译文版本目录不是普通目录，已拒绝写入')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const index = indexPath(ref)
  if (existsSync(index)) {
    const state = listTranslationVersions(ref)
    if (state.warning) throw new Error('译文版本清单损坏，已停止发布以免覆盖历史记录；请先备份并修复 .translations/index.json')
  }
}
async function writeState(ref: VersionPaperRef, state: TranslationVersionState): Promise<void> {
  assertWritableStore(ref)
  const dir = translationStoreDir(ref)
  await mkdir(dir, { recursive: true })
  const payload = JSON.stringify({ v: 1, activeId: state.activeId, versions: [...state.versions].sort(byNewest) }, null, 2)
  const tmp = join(dir, `index.json.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, indexPath(ref))
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

function nextVersionId(ref: VersionPaperRef, versions: TranslationVersion[]): string {
  let max = 0
  for (const v of versions) if (validVersionId(v.id)) max = Math.max(max, Number(v.id.slice(1)))
  try {
    for (const e of readdirSync(translationStoreDir(ref), { withFileTypes: true })) {
      if (e.isDirectory() && validVersionId(e.name)) max = Math.max(max, Number(e.name.slice(1)))
    }
  } catch { /* 首次创建 */ }
  return `v${max + 1}`
}

/** 成功后一次发布：先完整搬入候选目录，再原子切换清单；任何失败都不改变当前版本。 */
export async function publishTranslationVersion(ref: VersionPaperRef, input: PublishVersionInput): Promise<TranslationVersion> {
  if (!input.files.length) throw new Error('没有可发布的译文产物')
  assertWritableStore(ref)
  const state = listTranslationVersions(ref)
  const id = nextVersionId(ref, state.versions)
  const dir = join(translationStoreDir(ref), id)
  await mkdir(translationStoreDir(ref), { recursive: true })
  await mkdir(dir) // 已存在就失败：中断残留/孤儿目录绝不覆盖
  try {
    const variants = { zh: false, dual: false }
    let bytes = 0
    for (const file of input.files) {
      if (file.variant !== 'zh' && file.variant !== 'dual') throw new Error('未知译文变体')
      const target = join(dir, `${file.variant}.pdf`)
      await rename(file.source, target)
      variants[file.variant] = true
      bytes += fileBytes(target)
    }
    const version: TranslationVersion = {
      id,
      createdAt: new Date().toISOString(),
      model: input.model || null,
      provider: input.provider || null,
      endpointId: input.endpointId || null,
      variants,
      bytes,
    }
    const versions = [version, ...state.versions.filter((v) => v.id !== id)]
    await writeState(ref, { activeId: id, versions })
    return version
  } catch (e) {
    // 只删这次新建的候选目录；index.json 尚未指向它，当前版本与历史版本都不动。
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

export async function activateTranslationVersion(ref: VersionPaperRef, id: string): Promise<TranslationVersionState> {
  const state = listTranslationVersions(ref)
  if (state.warning) throw new Error(state.warning)
  if (!state.versions.some((v) => v.id === id)) throw new Error(`译文版本不存在：${id}`)
  await writeState(ref, { ...state, activeId: id })
  return { ...state, activeId: id }
}

export async function deleteTranslationVersion(ref: VersionPaperRef, id: string): Promise<TranslationVersionState> {
  const state = listTranslationVersions(ref)
  if (state.warning) throw new Error(state.warning)
  const version = state.versions.find((v) => v.id === id)
  if (!version) throw new Error(`译文版本不存在：${id}`)
  if (state.activeId === id) throw new Error('当前版本不能直接删除；请先切换到另一个版本')
  const next = { activeId: state.activeId, versions: state.versions.filter((v) => v.id !== id) }
  // 先更新清单，再删文件：中途失败时当前/剩余版本仍可解析，不会把清单指向残缺版本。
  await writeState(ref, next)
  if (version.legacy) {
    await rm(canonicalVariant(ref, 'zh'), { force: true })
    await rm(canonicalVariant(ref, 'dual'), { force: true })
  } else {
    const dir = join(translationStoreDir(ref), id)
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('译文版本目录异常，已拒绝删除')
    await rm(dir, { recursive: true, force: true })
  }
  return next
}
