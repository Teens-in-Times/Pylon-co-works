/**
 * inputFontContract — CC-21 输入栏字体契约守卫（原单授权 20）。
 *
 * 锁四件事：
 * 1. inputFont 字段结构：cc 区「输入框本体」、默认 follow-message、fontPicker/content；
 *    显式派生登记（noCssVar 且无 cssVar 声明）——防止将来加回声明再破 skinSchema 同源检查。
 * 2. 三处显式派生（主快照 / 皮肤契约 fixture / 模板局部）对同一主题输入同值。
 * 3. 皮肤契约变量目录含 --cc-input-font-family。
 * 4. InputBar.css 的真实消费点（剥注释后按规则块断言，不做全文件子串匹配）：
 *    主输入一般 / CLI / terminal-modern 特化三处 font-family 首选 --cc-input-font-family，
 *    无裸旧消息字体链盖回；预测 ghost 与队列编辑框同变量。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CC_MEMBER_FIELDS, THEME_CSS_VAR_MAP, THEME_FIELD_DEFS, THEME_PRESET_KEYS, THEME_SETTING_KEYS, ZONE_FIELDS } from '../themeFieldDefs.ts'
import { selectThemeCssSnapshot } from '../themeCssSnapshot.ts'
import { resolveInputFontToken } from '../fontTokens.ts'
import { WORKBENCH_CSS_VARIABLES, createWorkbenchSkinFixtureSet } from '../../appearance/workbenchSkinContract.ts'
import { themeToCssVars } from '../../../components/settings/templateThemeVars.ts'
import type { ThemeFieldKey } from '../themeFieldDefs.ts'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250, sidebarEnabled: true }

const cssPath = fileURLToPath(new URL('../../../../src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css', import.meta.url))

/** 剥掉块注释后按右花括号切规则块（本仓产品 CSS 为高密度书写，块级匹配已足够精确）。 */
function ruleBlocks(css: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map(block => block.trim())
    .filter(Boolean)
}

function ruleBody(block: string): string {
  const brace = block.indexOf('{')
  return brace >= 0 ? block.slice(brace + 1) : ''
}

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

describe('CC-21 皮肤契约与 InputBar.css 消费', () => {
  it('皮肤契约变量目录含 --cc-input-font-family', () => {
    expect(WORKBENCH_CSS_VARIABLES).toContain('--cc-input-font-family')
  })

  it('主输入一般 / CLI / terminal-modern 三处 font-family 首选输入字体变量，无裸旧链盖回', () => {
    const blocks = ruleBlocks(readFileSync(cssPath, 'utf8'))
    const consume = (selector: string) => blocks.some(block =>
      block.includes(selector) && ruleBody(block).includes('font-family:var(--cc-input-font-family,'))
    // 三处主输入消费：一般规则、CLI 特化、terminal-modern 特化（!important 也走同变量）。
    expect(consume('.input-textarea'), '主输入一般规则').toBe(true)
    expect(consume('.input-bar.cli-mode .input-textarea'), 'CLI 特化').toBe(true)
    expect(consume('[data-presentation-profile="builtin.presentation.terminal-modern"] .input-textarea'), 'terminal-modern 特化').toBe(true)
    // 无高优先级旧链盖回：剥注释后不允许任何裸 `font-family:var(--msg-font` 声明
    // （--msg-font 只允许作为 --cc-input-font-family 的兜底参数出现）。
    const bareLegacy = blocks.filter(block => ruleBody(block).includes('font-family:var(--msg-font'))
    expect(bareLegacy, '存在裸旧消息字体链 font-family 声明').toEqual([])
  })

  it('预测 ghost 与队列编辑框消费同一输入字体链', () => {
    const blocks = ruleBlocks(readFileSync(cssPath, 'utf8'))
    const ghost = blocks.find(block => block.includes('.input-ghost-suggestion'))
    expect(ghost).toBeDefined()
    // ghost 经 font:inherit 继承 textarea 字体，行距必须与主输入同链（接续不因行距错位）。
    expect(ruleBody(ghost!)).toContain('line-height:var(--cc-input-line-height,var(--msg-line-height')
    const queueEditor = blocks.find(block => block.includes('.queued-message-editor'))
    expect(queueEditor).toBeDefined()
    expect(ruleBody(queueEditor!)).toContain('font-family:var(--cc-input-font-family,')
  })
})
