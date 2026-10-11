/**
 * fontTokens — 字体选择换算纯函数（叶子模块）。
 *
 * 供主题 CSS 快照（themeCssSnapshot）、外观快照（appearance）、工作台皮肤契约
 * （workbenchSkinContract）与字体选择器（FontContributionPicker）共用同一解析真值。
 * 仅依赖零 import 的 contracts/fonts.ts，不进任何跨域依赖环。
 */
import { fontContributionCssVariable } from '../../contracts/fonts.ts'

/**
 * Resolve a persisted font selection to a CSS token.
 *
 * `fallback` is deliberately role-aware: an unavailable code contribution
 * must remain monospaced after plugin deactivation, while interface/content
 * contributions may safely fall back to the system UI stack.
 */
export function resolveFontToken(value: unknown, fallback: 'system' | 'code' = 'system'): string {
  const fallbackToken = fallback === 'code'
    ? 'var(--font-mono-default, var(--mono))'
    : 'var(--font-system, var(--font))'
  if (value === 'mono') return 'var(--font-mono-default, var(--mono))'
  // `codeFont` only exposes mono plus plugin ids. Treat legacy/invalid
  // proportional selections as unavailable instead of allowing code to lose
  // its monospaced role after migration or a hand-edited persisted value.
  if (fallback === 'code' && (value === 'serif' || value === 'system' || value === 'sans')) return fallbackToken
  if (value === 'serif') return 'var(--font-serif-default, var(--serif))'
  if (typeof value !== 'string' || !value.trim()) return fallbackToken
  if (value === 'system' || value === 'sans') return 'var(--font-system, var(--font))'
  return `var(${fontContributionCssVariable(value)}, ${fallbackToken})`
}

export function resolveInputFontToken(inputFont: unknown, messageFont: unknown): string {
  return resolveFontToken(typeof inputFont !== 'string' || !inputFont.trim() || inputFont === 'follow-message' ? messageFont : inputFont)
}
