// @vitest-environment jsdom
/**
 * P52 D4：设置页中控预览挂真实 SolidControlCenter 的回归锁。
 * 锁定：loader 可加载、挂载产出真实中控 DOM（输入栏 + 状态槽）、主题同步
 * 生效（外观 store 快照变化）、destroy 清理宿主。
 */
import { describe, expect, it } from 'vitest'
import { loadSettingsPreviewControlCenter } from '../settingsPreviewControlCenterLoader.ts'

describe('settingsPreviewControlCenter（P52 D4 Solid 中控预览）', () => {
  it('挂载真实 SolidControlCenter：输入域进入 DOM，会话态不渲染旧状态槽（A6-3）', async () => {
    const { mountSettingsPreviewControlCenter } = await loadSettingsPreviewControlCenter()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const handle = mountSettingsPreviewControlCenter(host)

    expect(host.querySelector('.control-center')).toBeTruthy()
    // 真实中控结构：输入栏（fixture 提供会话 composer）
    expect(host.querySelector('textarea, input, .cc-input, [class*="input" i]')).toBeTruthy()
    // A6-3 更新（2026-09-14）：模型控件常态显示（每轮对话都要看的当前状态）；
    // 2026-09-15 起：思考强度、权限模式、用量显示控件一并常态显示；其余旧状态控件在会话态仍然隐藏。
    // ★ #238 刀3（写法同步）：三个槽位包装节点（`.cc-status-primary/-secondary/.cc-actions`）
    // 已随槽位层拆除 —— 信息控件现在都在**一个落脚处容器** `.cc-status-group` 里，按序号排。
    const statusWidgetIds = [...host.querySelectorAll(
      '.cc-status-group [data-widget-id]',
    )].map(el => el.getAttribute('data-widget-id'))
    // ★ #238 刀5B：命令行提示升格为普通元件后也在这条行里（活跃会话 + cli ⇒ 三条条件满足）
    expect(statusWidgetIds).toEqual(['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint'])
    // 那三个槽位节点确实不再存在（DOM 级验收）
    expect(host.querySelector('.cc-status-primary:not(.cc-status-group), .cc-status-secondary, .cc-actions')).toBeNull()

    handle.destroy()
    expect(host.childElementCount).toBe(0)
    host.remove()
  })

  it('CC-21 standalone setTheme changes the inline font for follow and preserves independent input', async () => {
    const { mountSettingsPreviewControlCenter } = await loadSettingsPreviewControlCenter()
    const { DEFAULTS } = await import('../../../domains/theme/themeDefaults.ts')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const handle = mountSettingsPreviewControlCenter(host)
    try {
      const font = () => host.querySelector<HTMLElement>('.control-center')!.style.getPropertyValue('--cc-input-font-family')
      handle.setTheme({ ...structuredClone(DEFAULTS), inputFont: 'follow-message', msgFont: 'serif' })
      expect(font()).toBe('var(--font-serif-default, var(--serif))')
      handle.setTheme({ ...structuredClone(DEFAULTS), inputFont: 'system', msgFont: 'mono' })
      expect(font()).toBe('var(--font-system, var(--font))')
      handle.setTheme({ ...structuredClone(DEFAULTS), inputFont: 'system', msgFont: 'serif' })
      expect(font()).toBe('var(--font-system, var(--font))')
    } finally {
      handle.destroy()
      host.remove()
    }
  })

  it('setTheme 同步外观 store（预览随主题实时变化）', async () => {
    const { mountSettingsPreviewControlCenter } = await loadSettingsPreviewControlCenter()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const handle = mountSettingsPreviewControlCenter(host)

    // setTheme 消费完整 ThemeSettings（生产路径 = THEME_DEFAULTS 与 store 快照合并）
    const { DEFAULTS } = await import('../../../domains/theme/themeDefaults.ts')
    expect(() => handle.setTheme({ ...structuredClone(DEFAULTS), chatFont: 'serif' } as unknown as Record<string, unknown>)).not.toThrow()

    handle.destroy()
    host.remove()
  })
})
