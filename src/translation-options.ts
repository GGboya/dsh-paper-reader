// translation-options.ts — 整篇 PDF 翻译的运行参数（不含端点凭据）。

export interface TranslationRunOptions {
  /** 单段输入估算 token 上限，超过后按换行/句子边界拆段。 */
  splitTokens: number
  /** 单次补全 max_tokens；0 表示不传，跟随端点默认。 */
  maxOutputTokens: number
  /** BabelDOC 每秒请求数，过高容易触发端点限流。 */
  qps: number
}

export const DEFAULT_TRANSLATION_RUN_OPTIONS: Readonly<TranslationRunOptions> = Object.freeze({
  splitTokens: 100000,
  maxOutputTokens: 32768,
  qps: 16,
})

const RULES = {
  splitTokens: { min: 200, max: 128_000, label: '单段上下文上限' },
  maxOutputTokens: { min: 0, max: 32_768, label: '单次输出上限' },
  qps: { min: 1, max: 32, label: '并发请求数' },
} as const

/** 损坏配置逐字段回落默认，不让一个脏数字阻断整篇翻译。 */
export function sanitizeTranslationRunOptions(input: unknown): TranslationRunOptions {
  const rec = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const out = { ...DEFAULT_TRANSLATION_RUN_OPTIONS }
  for (const key of Object.keys(RULES) as Array<keyof TranslationRunOptions>) {
    const value = rec[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const { min, max } = RULES[key]
    out[key] = Math.max(min, Math.min(max, Math.trunc(value)))
  }
  return out
}

/** HTTP 写入严格校验：不接受字符串、NaN、小数和越界值，避免“保存了但没按预期生效”。 */
export function validateTranslationRunOptions(input: unknown): TranslationRunOptions {
  const rec = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  const out = { ...DEFAULT_TRANSLATION_RUN_OPTIONS }
  for (const key of Object.keys(RULES) as Array<keyof TranslationRunOptions>) {
    const value = rec[key]
    if (value === undefined) continue
    const { min, max, label } = RULES[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${label}必须是 ${min}–${max} 之间的整数`)
    }
    out[key] = value
  }
  return out
}
