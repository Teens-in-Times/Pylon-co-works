// 迁移自 scripts/test-template-library.mts（P91 A1）；组件接线段（TemplateLibrary.tsx / Settings.tsx 源码 token 断言）不迁——已被 TemplateLibrary.globalPresets.test.tsx 行为级 UI 测试锁定。
import { describe, expect, it } from 'vitest'
import { themeToCssVars } from '../templateThemeVars.ts'
import { THEME_CSS_VAR_MAP, THEME_DEFAULTS } from '../../../domains/theme/themeFieldDefs.ts'
import { resolveFontToken, resolveInputFontToken } from '../../../domains/theme/fontTokens.ts'
import { GLOBAL_PRESETS } from '../../../domains/theme/presets/index.ts'
import type { ThemeSettings } from '../../../domains/theme/themeStore.ts'

// W2-14：模板库——预览局部 cssVars 不触全局 store；点击才应用；恢复重应用 delta

describe('templateThemeVars themeToCssVars（迁移自 scripts/test-template-library.mts，P91 A1）', () => {
  it('对 delta 展开 { ...THEME_DEFAULTS, ...delta } 派生局部 cssVars（单一真值）', () => {
    const expanded = { ...THEME_DEFAULTS, ...GLOBAL_PRESETS[0].theme }
    const vars = themeToCssVars(expanded)
    for (const [cssVar, key] of Object.entries(THEME_CSS_VAR_MAP)) {
      const value = (expanded as Record<string, unknown>)[key]
      if (value !== undefined) expect(vars[cssVar]).toBe(String(value)) // `${cssVar} 必须从快照派生`
    }
    expect(vars['--accent']).toBe(String(expanded.accent)) // accent 必须注入
    expect(Object.prototype.hasOwnProperty.call(themeToCssVars({}), '--accent')).toBe(false) // 缺省字段不注入
  })

  it('官方区模板展开后 theme 完整（delta 展开到全量）', () => {
    const official = GLOBAL_PRESETS.map(preset => ({ ...THEME_DEFAULTS, ...preset.theme }))
    expect(official.length).toBe(10)
    for (const theme of official) {
      expect(theme.accent !== undefined).toBe(true) // 展开后 accent 必有值
      expect(theme.ccHeight !== undefined).toBe(true)
    }
  })
})

// CC-21 接续：字体字段（inputFont/msgFont，string 类型不在 THEME_CSS_VAR_MAP）
// 的显式输出组——两个私有选择搬运变量 + 两个解析派生变量。
describe('templateThemeVars 字体局部传递（CC-21 接续）', () => {
  it('跟随模板自己的消息字体：搬运原始选择值，派生变量等于共享解析值', () => {
    const vars = themeToCssVars({ inputFont: 'follow-message', msgFont: 'serif' } as Partial<ThemeSettings>)
    expect(vars['--pylon-template-input-font-selection']).toBe('follow-message')
    expect(vars['--pylon-template-message-font-selection']).toBe('serif')
    expect(vars['--cc-input-font-family']).toBe(resolveInputFontToken('follow-message', 'serif'))
    expect(vars['--cc-input-font-family']).toBe('var(--font-serif-default, var(--serif))')
    expect(vars['--msg-font']).toBe(resolveFontToken('serif'))
  })

  it('独立字体：输入 mono 与消息 serif 互不干扰，不输出 raw id 作 font-family', () => {
    const vars = themeToCssVars({ inputFont: 'mono', msgFont: 'serif' } as Partial<ThemeSettings>)
    expect(vars['--pylon-template-input-font-selection']).toBe('mono')
    expect(vars['--pylon-template-message-font-selection']).toBe('serif')
    expect(vars['--cc-input-font-family']).toBe('var(--font-mono-default, var(--mono))')
    expect(vars['--msg-font']).toBe('var(--font-serif-default, var(--serif))')
    expect(vars['--cc-input-font-family']).not.toBe('mono')
    expect(vars['--msg-font']).not.toBe('serif')
  })

  it('缺侧补默认：缺 inputFont 传跟随哨兵并取局部消息字体；缺 msgFont 用主题默认，不读全局 store', () => {
    const onlyMsg = themeToCssVars({ msgFont: 'serif' } as Partial<ThemeSettings>)
    expect(onlyMsg['--pylon-template-input-font-selection']).toBe('follow-message')
    expect(onlyMsg['--pylon-template-message-font-selection']).toBe('serif')
    expect(onlyMsg['--cc-input-font-family']).toBe('var(--font-serif-default, var(--serif))')
    const onlyInput = themeToCssVars({ inputFont: 'system' } as Partial<ThemeSettings>)
    expect(onlyInput['--pylon-template-message-font-selection']).toBe(THEME_DEFAULTS.msgFont)
    expect(onlyInput['--cc-input-font-family']).toBe('var(--font-system, var(--font))')
    expect(onlyInput['--msg-font']).toBe(resolveFontToken(THEME_DEFAULTS.msgFont))
  })

  it('插件字体编号：原始编号进搬运变量，派生变量走内容安全回退链，不二次包装', () => {
    const vars = themeToCssVars({ inputFont: 'vendor.input', msgFont: 'mono' } as Partial<ThemeSettings>)
    expect(vars['--pylon-template-input-font-selection']).toBe('vendor.input')
    expect(vars['--cc-input-font-family']).toBe('var(--pylon-font-vendor-input, var(--font-system, var(--font)))')
    expect(vars['--pylon-template-input-font-selection']).not.toContain('var(')
  })

  it('空对象与完全非字体 delta 不注入字体/搬运变量，非字体自动映射原行为保持', () => {
    expect(Object.keys(themeToCssVars({})).length).toBe(0)
    const nonFont = themeToCssVars({ accent: '#3b82f6', inputFontSize: 16 } as Partial<ThemeSettings>)
    expect(nonFont['--accent']).toBe('#3b82f6')
    for (const injected of ['--pylon-template-input-font-selection', '--pylon-template-message-font-selection', '--cc-input-font-family', '--msg-font']) {
      expect(Object.prototype.hasOwnProperty.call(nonFont, injected)).toBe(false)
    }
  })
})
