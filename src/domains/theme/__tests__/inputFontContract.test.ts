/**
 * inputFontContract — CC-21 输入栏字体契约守卫（原单授权 20）。
 *
 * 锁四件事：
 * 1. inputFont 字段结构：cc 区「输入框本体」、默认 follow-message、fontPicker/content；
 *    显式派生登记（noCssVar 且无 cssVar 声明）——防止将来加回声明再破 skinSchema 同源检查。
 * 2. 三处显式派生（主快照 / 皮肤契约 fixture / 模板局部）对同一主题输入同值。
 * 3. 皮肤契约变量目录含 --cc-input-font-family。
 * 输入框字体重测和独立/跟随行为由 InputBar.solid.test.tsx 验证；实际字体样式由 WebView2 验收。
 */
import { describe, expect, it } from 'vitest'
import { CC_MEMBER_FIELDS, THEME_CSS_VAR_MAP, THEME_FIELD_DEFS, THEME_PRESET_KEYS, THEME_SETTING_KEYS, ZONE_FIELDS } from '../themeFieldDefs.ts'
import { selectThemeCssSnapshot } from '../themeCssSnapshot.ts'
import { resolveInputFontToken } from '../fontTokens.ts'
import { WORKBENCH_CSS_VARIABLES, createWorkbenchSkinFixtureSet } from '../../appearance/workbenchSkinContract.ts'
import { themeToCssVars } from '../../../components/settings/templateThemeVars.ts'
import type { ThemeFieldKey } from '../themeFieldDefs.ts'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250, sidebarEnabled: true }

describe('CC-21 inputFont 字段结构（声明与白名单）', () => {
  it('inputFont 归 cc 区「输入框本体」，默认 follow-message，content fontPicker', () => {
    const def = THEME_FIELD_DEFS.inputFont
    expect(def.zone).toBe('cc')
    expect(def.group).toBe('输入框本体')
    expect(def.default).toBe('follow-message')
    expect(def.control).toBe('fontPicker')
    expect(def.fontRole).toBe('content')
    expect(THEME_SETTING_KEYS).toContain('inputFont' as ThemeFieldKey)
    expect(THEME_PRESET_KEYS).toContain('inputFont' as ThemeFieldKey)
    expect(ZONE_FIELDS.cc).toContain('inputFont' as ThemeFieldKey)
    expect(CC_MEMBER_FIELDS['输入框本体']).toContain('inputFont' as ThemeFieldKey)
  })

  it('inputFont 登记显式派生：noCssVar 且无 cssVar 声明，不进 THEME_CSS_VAR_MAP', () => {
    expect(THEME_FIELD_DEFS.inputFont.cssVar).toBeUndefined()
    expect(THEME_FIELD_DEFS.inputFont.noCssVar).toBe(true)
    expect('--cc-input-font-family' in THEME_CSS_VAR_MAP).toBe(false)
  })
})

describe('CC-21 三处显式派生同值（快照 / 皮肤契约 / 模板局部）', () => {
  it('default 与 boundary-max fixture 的输入字体在三处派生逐一相等，且等于共享解析真值', () => {
    const fixtureSet = createWorkbenchSkinFixtureSet([], 'contract-check')
    for (const id of ['default', 'schema-boundary-max']) {
      const fixture = fixtureSet.fixtures.find(item => item.id === id)
      expect(fixture, id).toBeDefined()
      const theme = fixture!.theme
      const expected = resolveInputFontToken(theme.inputFont, theme.msgFont)
      expect(fixture!.cssVariables['--cc-input-font-family']).toBe(expected)
      expect(selectThemeCssSnapshot(theme as unknown as Record<string, unknown>, LAYOUT)['--cc-input-font-family']).toBe(expected)
      expect(themeToCssVars(theme)['--cc-input-font-family']).toBe(expected)
    }
  })

  it('跟随态派生随消息字体、独立态不随（快照与模板同值）', () => {
    for (const [msgFont, expectedFollow] of [['mono', 'var(--font-mono-default, var(--mono))'], ['serif', 'var(--font-serif-default, var(--serif))']] as const) {
      const follow = resolveInputFontToken('follow-message', msgFont)
      expect(follow).toBe(expectedFollow)
      expect(selectThemeCssSnapshot({ inputFont: 'follow-message', msgFont }, LAYOUT)['--cc-input-font-family']).toBe(follow)
      expect(themeToCssVars({ inputFont: 'follow-message', msgFont })['--cc-input-font-family']).toBe(follow)
      const independent = resolveInputFontToken('system', msgFont)
      expect(independent).toBe('var(--font-system, var(--font))')
      expect(selectThemeCssSnapshot({ inputFont: 'system', msgFont }, LAYOUT)['--cc-input-font-family']).toBe(independent)
      expect(themeToCssVars({ inputFont: 'system', msgFont })['--cc-input-font-family']).toBe(independent)
    }
  })
})

describe('CC-21 皮肤契约变量目录', () => {
  it('皮肤契约变量目录含 --cc-input-font-family', () => {
    expect(WORKBENCH_CSS_VARIABLES).toContain('--cc-input-font-family')
  })

})
