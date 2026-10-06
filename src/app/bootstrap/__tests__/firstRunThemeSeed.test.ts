// @vitest-environment jsdom
/**
 * CC-14 首启主题种子：判定 / 动作 / 幂等三条面。
 *
 * 判定与动作直接驱动真实 themeStore / interfaceModeStore 单例（与种子生产路径
 * 同构）；存储用 jsdom localStorage 真身（persist writeBack 真落盘，可断言
 * pylon-theme 信封）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyFirstRunThemeSeed } from '../firstRunThemeSeed.ts'
import { useThemeStore } from '../../../domains/theme/themeStore.ts'
import { useInterfaceModeStore } from '../../../domains/interface/interfaceModeStore.ts'
import { DEFAULT_PRESETS } from '../../../domains/theme/presets/index.ts'
import { filterPresetTheme } from '../../../domains/theme/presetReducer.ts'
import { THEME_SCHEMA_VERSION } from '../../../domains/theme/migration.ts'

/**
 * 恢复两个 store 的内存初始态。**必须先恢复再清 localStorage**：setState 会触发
 * persist writeBack 落盘，顺序颠倒会让「空存储」前提被 restore 自己写脏。
 */
function restoreStores(): void {
  useThemeStore.setState(useThemeStore.getInitialState(), true)
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
}

beforeEach(() => {
  restoreStores()
  localStorage.clear()
})

describe('applyFirstRunThemeSeed', () => {
  it('空存储 ⇒ 首启：返回 true，界面模式落 terminal-like', () => {
    expect(applyFirstRunThemeSeed()).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('terminal-like')
  })

  it('空存储 ⇒ 主题值对拍终端默认预设（glass 值而非裸默认），pylon-theme 信封落盘', () => {
    expect(applyFirstRunThemeSeed()).toBe(true)
    // resetTheme 经 setGlobalPresetReducer('' , theme) 落地：对拍范围 = 预设域字段
    // （filterPresetTheme 同款过滤）；sidebarWidth/rightWidth 等非预设域字段不来自预设。
    const state = useThemeStore.getState() as unknown as Record<string, unknown>
    const preset = filterPresetTheme(DEFAULT_PRESETS.terminal.theme) as Record<string, unknown>
    const keys = Object.keys(preset)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(state[key]).toBe(preset[key])
    // 落盘信封：版本号随当前 schema；accent 直取 glass 值（裸默认是 #3b82f6）。
    const envelope = JSON.parse(localStorage.getItem('pylon-theme') ?? 'null') as {
      state: Record<string, unknown>
      version: number
    } | null
    expect(envelope).not.toBeNull()
    expect(envelope?.version).toBe(THEME_SCHEMA_VERSION)
    expect(envelope?.state.accent).toBe('#6366f1')
  })

  it('已有 pylon-theme ⇒ no-op：返回 false，两 store 状态零变化', () => {
    localStorage.setItem(
      'pylon-theme',
      JSON.stringify({ state: {}, version: THEME_SCHEMA_VERSION }),
    )
    const themeBefore = useThemeStore.getState()
    const modeBefore = useInterfaceModeStore.getState()
    expect(applyFirstRunThemeSeed()).toBe(false)
    expect(useThemeStore.getState()).toBe(themeBefore)
    expect(useInterfaceModeStore.getState()).toBe(modeBefore)
  })
})
