/**
 * templateThemeVars — 模板预览局部 cssVars 派生（W2-14，F3-C 方案 A）。
 *
 * 对 { ...THEME_DEFAULTS, ...delta } 的内存态快照经 THEME_CSS_VAR_MAP 单一真值派生
 * 局部 CSS vars——注入预览容器局部 style，不触全局 store（hover 不写 store）。
 *
 * CC-21 接续：字体字段（inputFont/msgFont，string 类型不进 THEME_CSS_VAR_MAP）
 * 显式输出四个变量——两个私有选择搬运变量（原始选择值：follow-message 哨兵或
 * 字体稳定 id）+ 两个解析派生变量（--msg-font / --cc-input-font-family）。
 * 解析复用 fontTokens 叶子模块的共享真值，不在此复制解析规则；搬运变量只服务
 * 预览局部读回（SettingsPreview.localTemplateCcTheme），不是新增主题字段，
 * 不写盘、不注册成字体、不进公共皮肤契约。派生后的字体栈不能当字体编号读回。
 */
import { THEME_CSS_VAR_MAP, THEME_DEFAULTS } from '../../domains/theme/themeFieldDefs.ts'
import { resolveFontToken, resolveInputFontToken } from '../../domains/theme/fontTokens.ts'
import type { ThemeSettings } from '../../domains/theme/themeStore'

/** 模板预览私有搬运变量：只搬运原始选择值（CC-21 接续，不进主题字段/公共契约）。 */
const TEMPLATE_INPUT_FONT_SELECTION_VAR = '--pylon-template-input-font-selection'
const TEMPLATE_MESSAGE_FONT_SELECTION_VAR = '--pylon-template-message-font-selection'

export function themeToCssVars(theme: Partial<ThemeSettings>): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [cssVar, key] of Object.entries(THEME_CSS_VAR_MAP)) {
    const value = (theme as Record<string, unknown>)[key]
    if (value === undefined) continue
    vars[cssVar] = String(value)
  }
  // 仅当局部主题本身携带字体字段（own property）才注入字体组：空对象与完全非
  // 字体的 delta 保持「未提供字段不注入」。缺失侧不读全局 store 补值——
  // inputFont 缺失/空以 follow-message 传递，msgFont 缺失/空以主题默认传递。
  const state = theme as Record<string, unknown>
  if (Object.hasOwn(state, 'inputFont') || Object.hasOwn(state, 'msgFont')) {
    const rawInputFont = typeof state.inputFont === 'string' && state.inputFont.trim() ? state.inputFont : 'follow-message'
    // THEME_DEFAULTS 的值类型是宽联合（string | number | boolean）；msgFont 运行时恒为
    // 字符串，String() 仅做类型收窄，值不变。
    const rawMsgFont = typeof state.msgFont === 'string' && state.msgFont.trim() ? state.msgFont : String(THEME_DEFAULTS.msgFont)
    vars[TEMPLATE_INPUT_FONT_SELECTION_VAR] = rawInputFont
    vars[TEMPLATE_MESSAGE_FONT_SELECTION_VAR] = rawMsgFont
    vars['--msg-font'] = resolveFontToken(rawMsgFont)
    vars['--cc-input-font-family'] = resolveInputFontToken(rawInputFont, rawMsgFont)
  }
  return vars
}
