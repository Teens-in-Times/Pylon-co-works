/**
 * selectThemeCssSnapshot 行为测试（FE-AUD-013 / 报告 9B.1）：
 * 显式派生（背景/字体/布局）+ defs 循环注入 + 空 color 省略 + 布局宽度。
 */
import { describe, expect, it } from 'vitest'
import { resolveFontToken, resolveInputFontToken } from '../fontTokens.ts'
import { selectThemeCssSnapshot } from '../themeCssSnapshot'
import { THEME_FIELD_DEFS } from '../themeFieldDefs.ts'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250, sidebarEnabled: true }

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...overrides }
}

describe('CC-21 input font projection', () => {
  it('missing, blank and follow selections resolve the current message font in production snapshots', () => {
    for (const inputFont of [undefined, '', ' ', 'follow-message']) {
      expect(resolveInputFontToken(inputFont, 'serif')).toBe('var(--font-serif-default, var(--serif))')
      expect(selectThemeCssSnapshot({ inputFont, msgFont: 'serif' }, LAYOUT)['--cc-input-font-family']).toBe('var(--font-serif-default, var(--serif))')
    }
  })

  it('explicit input fonts stay independent and plugin ids retain the content-safe fallback', () => {
    const expected = 'var(--pylon-font-vendor-input, var(--font-system, var(--font)))'
    for (const msgFont of ['mono', 'serif']) {
      expect(resolveInputFontToken('system', msgFont)).toBe('var(--font-system, var(--font))')
      expect(selectThemeCssSnapshot({ inputFont: 'vendor.input', msgFont }, LAYOUT)['--cc-input-font-family']).toBe(expected)
    }
  })
})

describe('selectThemeCssSnapshot', () => {
  it('界面字体同时投影到继承入口与显式 UI 字体 token', () => {
    const vars = selectThemeCssSnapshot(makeState({ globalFont: 'serif', chatFont: 'sans', msgFont: 'mono' }), LAYOUT)
    expect(vars['--global-font']).toContain('--font-serif-default')
    expect(vars['--font']).toBe(vars['--global-font'])
    expect(vars['--chat-font']).toContain('--font-system')
    expect(vars['--msg-font']).toContain('--font-mono-default')
  })

  it('插件字体 id 投影为稳定 CSS 变量，并按角色保留正确 fallback', () => {
    const vars = selectThemeCssSnapshot(makeState({ globalFont: 'vendor.readable-ui', codeFont: 'vendor.code' }), LAYOUT)
    expect(vars['--global-font']).toContain('--pylon-font-vendor-readable-ui')
    expect(vars['--mono']).toContain('--pylon-font-vendor-code')
    expect(vars['--mono']).toContain('var(--font-mono-default')
    expect(vars['--global-font']).toContain('var(--font-system')
  })

  it('字体 token helper 对代码与界面贡献使用不同 fallback', () => {
    expect(resolveFontToken('vendor.code', 'code')).toBe(
      'var(--pylon-font-vendor-code, var(--font-mono-default, var(--mono)))',
    )
    expect(resolveFontToken('vendor.ui')).toBe(
      'var(--pylon-font-vendor-ui, var(--font-system, var(--font)))',
    )
    expect(resolveFontToken(undefined, 'code')).toBe('var(--font-mono-default, var(--mono))')
    expect(resolveFontToken('', 'code')).toBe('var(--font-mono-default, var(--mono))')
    expect(resolveFontToken('serif', 'code')).toBe('var(--font-mono-default, var(--mono))')
    expect(resolveFontToken('system', 'code')).toBe('var(--font-mono-default, var(--mono))')
  })

  it('有左栏 Sheet 的 TitleBar 与左栏在展开/折叠时保持同宽', () => {
    const vars = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: true, sidebarWidth: 250, sidebarEnabled: true })
    expect(vars['--sheet-sidebar-track-width']).toBe('0px')
    const expanded = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: false, sidebarWidth: 320, sidebarEnabled: true })
    expect(expanded['--sheet-sidebar-track-width']).toBe('320px')
  })

  it('背景图经 toCssBackgroundImage 转换（非空输入产生 var 引用）', () => {
    const vars = selectThemeCssSnapshot(makeState({ globalBgImage: 'linear-gradient(#000,#111)' }), LAYOUT)
    expect(vars['--global-bg-image']).toContain('linear-gradient')
  })

  it('defs 驱动循环注入 color/number 且空 color 省略', () => {
    const vars = selectThemeCssSnapshot(makeState({ accent: '#3b82f6', editorFontSize: 14 }), LAYOUT)
    expect(vars['--accent']).toBe('#3b82f6')
    expect(vars['--editor-font-size']).toBe('14px')
    const empty = selectThemeCssSnapshot(makeState({ accent: '' }), LAYOUT)
    expect(empty['--accent']).toBeUndefined()
  })

  it('msgTextColor 空时走兜底链', () => {
    const vars = selectThemeCssSnapshot(makeState(), LAYOUT)
    expect(vars['--msg-text']).toContain('var(--chat-text-color')
  })
})

// #154：左列宽度从「三套独立 token + 42px 折叠轨道」收敛为一个真值。
// 折叠 = 0（不再保留紧凑轨道，用户明确要求折叠后不留列）。
describe('#154 左列唯一宽度真值契约（折叠 = 0）', () => {
  it('折叠时轨道为 0，且四套旧 token 不得复活', () => {
    const vars = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: true, sidebarWidth: 320, sidebarEnabled: true })
    expect(vars['--sheet-sidebar-track-width']).toBe('0px')
    // 这四套各自独立演化正是浏览器/Gateway 分割线错位的成因（标题栏读
    // --titlebar-sidebar-width、左列读 --workspace-sidebar-track-width、8 个
    // Sheet 自画的 aside 读 --sheet-sidebar-width 且不感知折叠）。复活任何一套
    // 都意味着又出现第二条宽度来源。
    for (const retired of [
      '--titlebar-sidebar-width',
      '--workspace-sidebar-track-width',
      '--workspace-sidebar-collapsed-width',
      '--sheet-sidebar-width',
    ]) {
      expect(vars[retired]).toBeUndefined()
    }
  })

  it('展开时取用户宽度', () => {
    const expanded = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: false, sidebarWidth: 320, sidebarEnabled: true })
    expect(expanded['--sheet-sidebar-track-width']).toBe('320px')
  })

  it('无左栏的 Sheet 轨道为 0（不空占标题栏第一列）', () => {
    const vars = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: false, sidebarWidth: 320, sidebarEnabled: false })
    expect(vars['--sheet-sidebar-track-width']).toBe('0px')
  })
})

// 下沉自 scripts/test-message-style.mts（P91 A2）：消息样式变量契约。
describe('msg 变量派生契约', () => {
  it('--msg-font/--msg-text 由快照显式派生', () => {
    const vars = selectThemeCssSnapshot(makeState({ msgFont: 'code', msgTextColor: '#ff0000' }), LAYOUT)
    expect(vars['--msg-font']).toBe(resolveFontToken('code'))
    expect(vars['--msg-text']).toBe('#ff0000')
  })

  it('--msg-text 缺省回落 chat 文本色链', () => {
    const vars = selectThemeCssSnapshot(makeState(), LAYOUT)
    expect(vars['--msg-text']).toBe('var(--chat-text-color,var(--text))')
  })

  it('--msg-line-height 由 defs 声明驱动循环注入（chat zone number 字段）', () => {
    expect(THEME_FIELD_DEFS.msgLineHeight).toBeDefined()
    expect(THEME_FIELD_DEFS.msgLineHeight.zone).toBe('chat')
    expect(THEME_FIELD_DEFS.msgLineHeight.type).toBe('number')
  })
})
