// @vitest-environment jsdom
// #515 W1：迁移自 SettingsPreview.solidMigration.test.tsx——原测试钉的是「React 桥挂
// Solid 实体」；桥（SettingsPreview.tsx）已随 React 面清零退役，本测试改为实体直连，
// 断言原样保留（Solid 中控挂载/cc 高亮/模板局部变量投影）。改名 migration.solid.test
// 以落入 solid-dom 分组。
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SettingsPreview from '../SettingsPreview.solid.tsx'
import { useThemeStore } from '../../domains/theme/themeStore.ts'
import { resetStores } from '../../test/resetStores.ts'
import { themeToCssVars } from '../settings/templateThemeVars.ts'
import { THEME_DEFAULTS } from '../../domains/theme/themeFieldDefs.ts'
import { resolveInputFontToken } from '../../domains/theme/fontTokens.ts'
import type { ThemeSettings } from '../../domains/theme/themeStore.ts'

beforeEach(() => resetStores())

afterEach(() => {
  resetStores()
  cleanup()
})

describe('SettingsPreview Solid 中控迁移', () => {
  it('挂载 Solid 中控、保留 cc 高亮并实时响应背景主题', async () => {
    const view = render(() => <SettingsPreview zone="cc" />)
    // 中控经异步 loader 挂载——全套件并行下首载可超 waitFor 默认 1s，放宽等待窗。
    const controlCenter = await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(node).not.toBeNull()
      return node!
    }, { timeout: 8000 })

    const ccWrapper = controlCenter.parentElement?.parentElement as HTMLElement | null
    expect(ccWrapper?.style.outline).toContain('solid')

    useThemeStore.setState({ ccBg: '#102030', ccBgImage: 'data:image/png;base64,fixture' })
    await waitFor(() => {
      expect(controlCenter.style.getPropertyValue('--cc-surface')).toBe('#102030')
      expect(controlCenter.style.getPropertyValue('--cc-surface-image')).toContain('url(')
    })

    fireEvent(window, new Event('resize'))
    view.unmount()
    expect(view.container.querySelector('[data-control-center="production"]')).toBeNull()
  })

  it('模板预览读取局部中控背景图与变体变量', async () => {
    const template = document.createElement('div')
    template.className = 'template-preview'
    template.style.setProperty('--cc-bg', '#203040')
    template.style.setProperty('--cc-bg-image', 'data:image/png;base64,template')
    template.style.setProperty('--cc-margin-x', '34')
    template.style.setProperty('--cc-margin-bottom', '18')
    template.style.setProperty('--cc-radius', '14')
    template.style.setProperty('--cc-surface-opacity', '66')
    template.style.setProperty('--cc-input-offset-top', '12')
    template.style.setProperty('--cc-input-height', '42')
    template.style.setProperty('--cc-input-margin-x', '16')
    template.style.setProperty('--cc-input-surface', '#405060')
    template.style.setProperty('--cc-input-surface-opacity', '55')
    template.style.setProperty('--cc-input-radius', '6')
    template.style.setProperty('--cc-input-border', '#506070')
    template.style.setProperty('--cc-input-border-width', '3')
    template.style.setProperty('--cc-input-border-opacity', '45')
    template.style.setProperty('--cc-input-font-size', '18')
    template.style.setProperty('--cc-input-text', '#fafafa')
    template.style.setProperty('--cc-input-placeholder', '#b0b0b0')
    document.body.append(template)

    const view = render(() => <SettingsPreview zone="global" />, { container: template })
    const controlCenter = await waitFor(() => {
      const node = template.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(node).not.toBeNull()
      return node!
    }, { timeout: 8000 })

    expect(controlCenter.style.getPropertyValue('--cc-surface')).toBe('#203040')
    expect(controlCenter.style.getPropertyValue('--cc-surface-image')).toContain('template')
    expect(controlCenter.style.getPropertyValue('--cc-margin-x')).toBe('34px')
    expect(controlCenter.style.getPropertyValue('--cc-margin-bottom')).toBe('18px')
    expect(controlCenter.style.getPropertyValue('--cc-radius')).toBe('14px')
    expect(controlCenter.style.getPropertyValue('--cc-surface-opacity')).toBe('66%')
    expect(controlCenter.style.getPropertyValue('--cc-input-offset-top')).toBe('12px')
    expect(controlCenter.style.getPropertyValue('--cc-input-height')).toBe('42px')
    expect(controlCenter.style.getPropertyValue('--cc-input-margin-x')).toBe('16px')
    expect(controlCenter.style.getPropertyValue('--cc-input-surface')).toBe('#405060')
    expect(controlCenter.style.getPropertyValue('--cc-input-surface-opacity')).toBe('55%')
    expect(controlCenter.style.getPropertyValue('--cc-input-radius')).toBe('6px')
    expect(controlCenter.style.getPropertyValue('--cc-input-border')).toBe('#506070')
    expect(controlCenter.style.getPropertyValue('--cc-input-border-width')).toBe('3px')
    expect(controlCenter.style.getPropertyValue('--cc-input-border-opacity')).toBe('45%')
    expect(controlCenter.style.getPropertyValue('--cc-input-font-size')).toBe('18px')
    expect(controlCenter.style.getPropertyValue('--cc-input-text')).toBe('#fafafa')
    expect(controlCenter.style.getPropertyValue('--cc-input-placeholder')).toBe('#b0b0b0')
    // ★ #238 刀8：变体类名（`cc-variant-*`）已整族删除 ⇒ 预览也不再带任何变体类
    expect([...controlCenter.classList].some(name => name.startsWith('cc-variant-'))).toBe(false)

    view.unmount()
    template.remove()
  })
})

// CC-21 接续：模板父容器 → themeToCssVars 容器 style → localTemplateCcTheme 读回
// → 真实中控挂载的全链路字体接线。容器 style 一律由生产 themeToCssVars 生成，
// 不手填期望值绕过第一端；观察点是真实中控节点的 --cc-input-font-family 内联出口。
describe('CC-21 模板字体局部传递（父容器 → 读回 → 真实中控）', () => {
  const LOAD_WAIT = { timeout: 8000 } as const

  function makeTemplateCard(theme: Partial<ThemeSettings>): HTMLElement {
    const template = document.createElement('div')
    template.className = 'template-preview'
    for (const [name, value] of Object.entries(themeToCssVars(theme))) {
      template.style.setProperty(name, value)
    }
    document.body.append(template)
    return template
  }

  async function mountPreviewIn(template: HTMLElement) {
    const view = render(() => <SettingsPreview zone="global" />, { container: template })
    const controlCenter = await waitFor(() => {
      const node = template.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(node).not.toBeNull()
      return node!
    }, LOAD_WAIT)
    return { view, controlCenter }
  }

  const inlineInputFont = (controlCenter: HTMLElement) =>
    controlCenter.style.getPropertyValue('--cc-input-font-family')

  it('模板跟随自己的消息字体：全局字体故意不同时出口取模板 serif，改全局不被冲掉', async () => {
    useThemeStore.setState({ msgFont: 'mono', inputFont: 'system' })
    const template = makeTemplateCard({ ...THEME_DEFAULTS, msgFont: 'serif', inputFont: 'follow-message' })
    const { view, controlCenter } = await mountPreviewIn(template)

    expect(inlineInputFont(controlCenter)).toBe('var(--font-serif-default, var(--serif))')
    useThemeStore.setState({ msgFont: 'system', inputFont: 'mono' })
    await waitFor(() => {
      expect(inlineInputFont(controlCenter)).toBe('var(--font-serif-default, var(--serif))')
    }, LOAD_WAIT)
    // 全局值只反映测试明确设置，不被预览写回。
    expect(useThemeStore.getState().msgFont).toBe('system')
    expect(useThemeStore.getState().inputFont).toBe('mono')

    view.unmount()
    template.remove()
  })

  it('模板独立字体：inputFont=mono 与全局互不影响，改全局后出口仍 mono 解析值', async () => {
    useThemeStore.setState({ msgFont: 'mono', inputFont: 'system' })
    const template = makeTemplateCard({ ...THEME_DEFAULTS, inputFont: 'mono', msgFont: 'serif' })
    const { view, controlCenter } = await mountPreviewIn(template)

    expect(inlineInputFont(controlCenter)).toBe('var(--font-mono-default, var(--mono))')
    useThemeStore.setState({ msgFont: 'serif', inputFont: 'follow-message' })
    await waitFor(() => {
      expect(inlineInputFont(controlCenter)).toBe('var(--font-mono-default, var(--mono))')
    }, LOAD_WAIT)

    view.unmount()
    template.remove()
  })

  it('旧模板缺输入项：仅 msgFont 的局部主题生成传递，主输入出口跟模板消息字体而不借全局 inputFont', async () => {
    useThemeStore.setState({ msgFont: 'mono', inputFont: 'system' })
    const template = makeTemplateCard({ msgFont: 'serif' })
    const { view, controlCenter } = await mountPreviewIn(template)

    expect(inlineInputFont(controlCenter)).toBe('var(--font-serif-default, var(--serif))')
    useThemeStore.setState({ inputFont: 'mono' })
    await waitFor(() => {
      expect(inlineInputFont(controlCenter)).toBe('var(--font-serif-default, var(--serif))')
    }, LOAD_WAIT)

    view.unmount()
    template.remove()
  })

  it('插件编号：传递中保留原始 id，真实中控出口等于共享解析值，无二次包装变量', async () => {
    useThemeStore.setState({ msgFont: 'mono', inputFont: 'system' })
    const template = makeTemplateCard({ ...THEME_DEFAULTS, inputFont: 'vendor.input', msgFont: 'mono' })
    const { view, controlCenter } = await mountPreviewIn(template)

    expect(inlineInputFont(controlCenter)).toBe(resolveInputFontToken('vendor.input', 'mono'))
    expect(inlineInputFont(controlCenter)).toBe('var(--pylon-font-vendor-input, var(--font-system, var(--font)))')
    for (const name of Object.keys({ ...controlCenter.style })) {
      expect(name.startsWith('--pylon-font-var')).toBe(false)
    }

    view.unmount()
    template.remove()
  })

  it('普通设置预览：无模板父容器时出口按当前全局 inputFont/msgFont 动态更新，不被局部修复固定', async () => {
    useThemeStore.setState({ msgFont: 'mono', inputFont: 'system' })
    const view = render(() => <SettingsPreview zone="global" />)
    const controlCenter = await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>('[data-control-center="production"]')
      expect(node).not.toBeNull()
      return node!
    }, LOAD_WAIT)

    expect(inlineInputFont(controlCenter)).toBe('var(--font-system, var(--font))')
    useThemeStore.setState({ msgFont: 'serif', inputFont: 'follow-message' })
    await waitFor(() => {
      expect(inlineInputFont(controlCenter)).toBe('var(--font-serif-default, var(--serif))')
    }, LOAD_WAIT)

    view.unmount()
  })
})
