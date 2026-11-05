// theme-config.ts — 阅读器深色模式的配置（纯函数，不依赖 Cordis）。
//
// 冻结方案：docs/darkmode-subtopic-plan.md §A2.3。与 translate/embed/mineru **同一套约定**：
// 落盘 $DSH_HOME/.dsh-paper-reader/theme.json（0600），GET 回生效值，POST 校验后落盘，DELETE 回落默认。
// 无密钥 ⇒ 不需要掩码，但**非法值一律回落默认**（不抛给用户、也不写半截配置）。
//
// 设置语义：
//   pdfTheme   'follow'（默认，跟随 dsh 主题）| 'off'（永不变深）| 'light' | 'dark'（强制）
//   pdfDarkStrength 0..3 → brightness/contrast 预设档（§A2.1 的实测曲线：1/1、0.92/0.95、0.85/0.9、0.8/0.85）
//   pdfDarkAdvanced  { brightness, contrast }（0.5–1，高级滑杆；给了就覆盖档位）
//   pdfDarkChrome    boolean（深色时是否把阅读器自身 UI 也切深色）

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHome } from './library.ts'

export type PdfTheme = 'follow' | 'off' | 'light' | 'dark'
export type PdfDarkStrength = 0 | 1 | 2 | 3

export interface ThemeConfig {
  pdfTheme: PdfTheme
  pdfDarkStrength: PdfDarkStrength
  pdfDarkChrome: boolean
  pdfDarkAdvanced?: { brightness: number; contrast: number }
}

/** 默认值（方案 §A2.3 冻结；`follow` = 用户原话「dsh 为深色时把 PDF 也变深色」）。 */
export const THEME_DEFAULTS: ThemeConfig = {
  pdfTheme: 'follow',
  pdfDarkStrength: 1,
  pdfDarkChrome: true,
}

/** 四档实测曲线（§A2.1）：白底在屏幕上的取值 [0,0,0] / [6,6,6] / [13,13,13] / [19,19,19]。 */
export const DARK_PRESETS: ReadonlyArray<{ brightness: number; contrast: number; label: string }> = [
  { brightness: 1, contrast: 1, label: 'strength0' },
  { brightness: 0.92, contrast: 0.95, label: 'strength1' },
  { brightness: 0.85, contrast: 0.9, label: 'strength2' },
  { brightness: 0.8, contrast: 0.85, label: 'strength3' },
]

export const THEME_MODES: readonly PdfTheme[] = ['follow', 'off', 'light', 'dark']

export function themeConfigPath(home: string = dshHome()): string {
  return join(home, '.dsh-paper-reader', 'theme.json')
}

function clampAdvanced(v: unknown): { brightness: number; contrast: number } | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const rec = v as Record<string, unknown>
  const b = typeof rec['brightness'] === 'number' && Number.isFinite(rec['brightness']) ? rec['brightness'] : undefined
  const c = typeof rec['contrast'] === 'number' && Number.isFinite(rec['contrast']) ? rec['contrast'] : undefined
  if (b === undefined || c === undefined) return undefined
  // 高级滑杆只接受 0.5–1（超出即视为非法 → 回落档位，不半途夹取）
  if (b < 0.5 || b > 1 || c < 0.5 || c > 1) return undefined
  return { brightness: b, contrast: c }
}

/** 把任意来源的值规范化成合法配置：**非法值一律回落默认**（不抛错、不半截生效）。 */
export function normalizeThemeConfig(raw: unknown): ThemeConfig {
  if (typeof raw !== 'object' || raw === null) return { ...THEME_DEFAULTS }
  const rec = raw as Record<string, unknown>
  const mode = THEME_MODES.includes(rec['pdfTheme'] as PdfTheme) ? (rec['pdfTheme'] as PdfTheme) : THEME_DEFAULTS.pdfTheme
  const strengthRaw = rec['pdfDarkStrength']
  const strength = (Number.isInteger(strengthRaw) && (strengthRaw as number) >= 0 && (strengthRaw as number) <= 3
    ? strengthRaw
    : THEME_DEFAULTS.pdfDarkStrength) as PdfDarkStrength
  const chrome = typeof rec['pdfDarkChrome'] === 'boolean' ? rec['pdfDarkChrome'] : THEME_DEFAULTS.pdfDarkChrome
  const advanced = clampAdvanced(rec['pdfDarkAdvanced'])
  const out: ThemeConfig = { pdfTheme: mode, pdfDarkStrength: strength, pdfDarkChrome: chrome }
  if (advanced) out.pdfDarkAdvanced = advanced
  return out
}

/** 生效的 brightness/contrast（高级滑杆优先于档位）——阅读器与断言共用这一处。 */
export function resolveDarkCurve(cfg: ThemeConfig): { brightness: number; contrast: number } {
  if (cfg.pdfDarkAdvanced) return { ...cfg.pdfDarkAdvanced }
  const preset = DARK_PRESETS[cfg.pdfDarkStrength] ?? DARK_PRESETS[1]!
  return { brightness: preset.brightness, contrast: preset.contrast }
}

/** 读配置；文件缺失/损坏一律回落默认（与 translate/embed 的读策略一致）。 */
export async function readThemeConfig(home: string = dshHome()): Promise<ThemeConfig> {
  try {
    const data = JSON.parse(await readFile(themeConfigPath(home), 'utf8')) as unknown
    return normalizeThemeConfig(data)
  } catch {
    return { ...THEME_DEFAULTS }
  }
}

/** 写入前的**严格**校验（POST 用）：非法输入抛 Error（路由层给 400），绝不静默改值。 */
export function validateThemePatch(raw: unknown): ThemeConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('配置必须是对象')
  const rec = raw as Record<string, unknown>
  if (rec['pdfTheme'] !== undefined && !THEME_MODES.includes(rec['pdfTheme'] as PdfTheme)) {
    throw new Error("pdfTheme 只能是 follow/off/light/dark")
  }
  if (rec['pdfDarkStrength'] !== undefined) {
    const v = rec['pdfDarkStrength']
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3) throw new Error('pdfDarkStrength 只能是 0/1/2/3')
  }
  if (rec['pdfDarkChrome'] !== undefined && typeof rec['pdfDarkChrome'] !== 'boolean') {
    throw new Error('pdfDarkChrome 只能是布尔值')
  }
  if (rec['pdfDarkAdvanced'] !== undefined && rec['pdfDarkAdvanced'] !== null) {
    const a = rec['pdfDarkAdvanced'] as Record<string, unknown>
    for (const k of ['brightness', 'contrast']) {
      const v = a?.[k]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 1) throw new Error(`${k} 必须在 0.5–1 之间`)
    }
  }
  // 与已存值合并（POST 是**补丁**语义：只改给到的键）
  return normalizeThemeConfig({ ...THEME_DEFAULTS, ...rec })
}

export async function writeThemeConfig(cfg: ThemeConfig, home: string = dshHome()): Promise<void> {
  const file = themeConfigPath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(file, 0o600)
}

export async function clearThemeConfig(home: string = dshHome()): Promise<void> {
  await rm(themeConfigPath(home), { force: true })
}

/** 阅读器直接可用的载荷（GET 响应 + 注入 iframe 的 postMessage 用同一形状）。 */
export function themePayload(cfg: ThemeConfig): {
  pdfTheme: PdfTheme
  pdfDarkStrength: PdfDarkStrength
  pdfDarkChrome: boolean
  curve: { brightness: number; contrast: number }
} {
  return {
    pdfTheme: cfg.pdfTheme,
    pdfDarkStrength: cfg.pdfDarkStrength,
    pdfDarkChrome: cfg.pdfDarkChrome,
    curve: resolveDarkCurve(cfg),
  }
}
