// @vitest-environment jsdom
/**
 * #607 刀3a · 切换 / 重置的**同一条路径**与两轴自定义（验收 §5.1/§5.2/§5.3/§5.5/§5.6）。
 *
 * 用法与 `defaultPresets.solid.test.tsx` 一致：拉起真实第一方注册表（界面模式 / 呈现档案 /
 * 渲染器套件 / Shell 配方），因为 `activateInterfaceMode` 的可用性闸门依赖它们。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { activateInterfaceMode, resetThemeForActiveInterfaceMode } from '../activateInterfaceMode.ts'
import { PRESET_ZONES, deriveGlobalStatus } from '../../../domains/theme/presetReducer.ts'
import { THEME_PRESET_KEYS } from '../../../domains/theme/themeFieldDefs.ts'
import { useThemeStore } from '../../../domains/theme/themeStore.ts'
import { useCustomPresetStore } from '../../../domains/theme/customPresetStore.ts'
import { useInterfaceModeStore } from '../../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../../domains/presentation/presentationPreferenceStore.ts'
import { normalizeZonePresetEntries, resolveZonePresetEntryTheme, zonePresetsFor } from '../../../domains/theme/zones/index.ts'
import { planModeDefaultForInterfaceMode } from '../../../domains/theme/zones/modeLandingPlan.ts'
import { resetStores } from '../../../test/resetStores.ts'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'

const MODES = [
  ['modern-gui', 'gui', 'builtin.presentation.modern-gui'],
  ['terminal-like', 'terminal', 'builtin.presentation.terminal-classic'],
  ['tactical-blue', 'tactical', 'builtin.presentation.tactical-blue'],
] as const

/** 终态快照：预设域字段（键值）＋ 账 ＋ 身份 ＋ 结构载体（ccLayout / 显隐两份表）。 */
function snapshot(): Record<string, unknown> {
  const theme = useThemeStore.getState() as unknown as Record<string, unknown>
  const fields = Object.fromEntries(THEME_PRESET_KEYS.map(key => [key, theme[key]]))
  return {
    fields,
    appliedPreset: { ...useThemeStore.getState().appliedPreset },
    custom: { ...useThemeStore.getState().custom },
    ccLayout: structuredClone(useThemeStore.getState().ccLayout),
    ccHidden: [...useThemeStore.getState().ccHidden],
    ccHiddenEmpty: [...useThemeStore.getState().ccHiddenEmpty],
    interfaceMode: useInterfaceModeStore.getState().interfaceMode,
    activeProfileId: usePresentationPreferenceStore.getState().activeProfileId,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
})

describe('#607 刀3a · 切换＝重置（同一条路径）', () => {
  for (const [interfaceMode, , profileId] of MODES) {
    it(`${interfaceMode}：切走再切回 == 切走再切回＋重置（值 / 账 / 结构三层）`, () => {
      const other = interfaceMode === 'modern-gui' ? 'terminal-like' : 'modern-gui'
      // A：切走 → 切回
      expect(activateInterfaceMode(other)).toBe(true)
      expect(activateInterfaceMode(interfaceMode)).toBe(true)
      const returned = snapshot()
      // B：切走 → 切回 → 重置
      expect(resetThemeForActiveInterfaceMode()).toBe(true)
      expect(snapshot()).toEqual(returned)
      // 账：切换 / 重置都清账（§5.2）
      for (const zone of PRESET_ZONES) {
        expect(useThemeStore.getState().appliedPreset[zone], zone).toBe('')
        expect(useThemeStore.getState().custom[zone], zone).toBe(false)
      }
      // 不亮兜底「自定义」假账 chip
      expect(deriveGlobalStatus(useThemeStore.getState())).toBe('')
      // 身份取自材料里生效的消息流样式单
      expect(usePresentationPreferenceStore.getState().activeProfileId).toBe(profileId)
      expect(useInterfaceModeStore.getState().interfaceMode).toBe(interfaceMode)
    })
  }

  it('★ 无默认单的界面模式 ⇒ 纯层返回 undefined（调用方回落整份 DEFAULTS）', () => {
    expect(planModeDefaultForInterfaceMode('not-registered')).toBeUndefined()
    expect(planModeDefaultForInterfaceMode('third-party.mode')).toBeUndefined()
    for (const [interfaceMode] of MODES) {
      expect(planModeDefaultForInterfaceMode(interfaceMode)?.theme, interfaceMode).toBeTruthy()
    }
    // 交易层：未登记模式进不了可用性闸门（既有 false 语义不变）；
    // 已注册但无默认单的**插件模式**回落 DEFAULTS 的整条链由
    // `pluginInterfaceMode.integration.solid.test.tsx` 用真实注册表覆盖。
    expect(activateInterfaceMode('not-registered')).toBe(false)
  })

  it('蓝调战术：可切换 / 可重置，落点是它的默认单（含蓝调配色）', () => {
    expect(activateInterfaceMode('tactical-blue')).toBe(true)
    expect((useThemeStore.getState() as unknown as Record<string, unknown>).accent).toBe('#65dfff')
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.tactical-blue')
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.tactical-blue')
    // 区域行可见（家族唯一成员 = 默认单）
    expect(zonePresetsFor('tactical-blue', 'sidebar').length).toBeGreaterThan(0)
  })
})

describe('#607 刀3a · 两轴自定义与混搭（§5.3）', () => {
  beforeEach(() => {
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('混搭成立：终端观感的消息流样式单 ＋ 现代输入栏的中控单同时生效（§5.3）', () => {
    // 候选按**界面模式桶**出（区域行的既有口径不变）⇒ 混搭 = 同一桶内不同预设的各区条目混用。
    // 这里就是验收那条例子：solarized 的消息流样式单（终端观感：msgStyle/mono/classic）
    // ＋ glass 的中控单（现代输入栏）。
    const styleEntry = zonePresetsFor('modern-gui', 'chat', [], 'style').find(entry => entry.id === 'factory:solarized:chat:style')!
    const ccEntry = zonePresetsFor('modern-gui', 'cc').find(entry => entry.id === 'factory:glass:cc')!
    expect(styleEntry, '消息流样式单候选').toBeTruthy()
    expect(ccEntry, '中控单候选').toBeTruthy()
    const styleTheme = resolveZonePresetEntryTheme(styleEntry)! as Record<string, unknown>
    const ccTheme = resolveZonePresetEntryTheme(ccEntry)! as Record<string, unknown>
    useThemeStore.getState().applyZonePreset('chat', styleEntry.id, styleTheme as never)
    useThemeStore.getState().applyZonePreset('cc', ccEntry.id, ccTheme as never)
    const after = useThemeStore.getState() as unknown as Record<string, unknown>
    // 两区的值同时生效：中控是 glass 的，消息流样式仍是 solarized 的（没被中控那一次覆盖回去）
    expect(after.msgStyle).toBe('terminal')
    expect(after.chatFont).toBe('mono')
    expect(after.messageLayout).toBe('classic')
    for (const key of ['inputBg', 'inputTextColor', 'modeAutoColor'] as const) {
      expect(after[key], key).toEqual(ccTheme[key])
    }
    // 账：两次「局部预设」各记自己那一区
    expect(useThemeStore.getState().appliedPreset.chat).toBe(styleEntry.id)
    expect(useThemeStore.getState().appliedPreset.cc).toBe(ccEntry.id)
  })

  it('两轴各自另存：条目带轴、快照只装该轴切片、刷新后可复现', () => {
    const theme = useThemeStore.getState()
    theme.setZoneField('chat', { msgLineHeight: 2.05, messageRadius: 22 })
    const store = useCustomPresetStore.getState()
    const styleId = store.saveZonePresetEntry('gui', 'chat', '我的样式单', 'style')!
    const colorId = useCustomPresetStore.getState().saveZonePresetEntry('gui', 'chat', '我的配色单', 'color')!
    const entries = useCustomPresetStore.getState().zonePresetEntries
    const styleEntry = entries.find(entry => entry.id === styleId)!
    const colorEntry = entries.find(entry => entry.id === colorId)!
    expect(styleEntry.axis).toBe('style')
    expect(colorEntry.axis).toBe('color')
    // 快照只装该轴切片：样式单拿到 msgLineHeight / messageRadius，配色单不拿
    expect(styleEntry.values.msgLineHeight).toBe(2.05)
    expect(styleEntry.values.messageRadius).toBe(22)
    expect(colorEntry.values).not.toHaveProperty('msgLineHeight')
    expect(colorEntry.values).not.toHaveProperty('messageRadius')
    // 两行各自只看见自己那一轴的条目
    const styleRow = zonePresetsFor('modern-gui', 'chat', entries, 'style').map(entry => entry.id)
    const colorRow = zonePresetsFor('modern-gui', 'chat', entries, 'color').map(entry => entry.id)
    expect(styleRow).toContain(styleId)
    expect(styleRow).not.toContain(colorId)
    expect(colorRow).toContain(colorId)
    expect(colorRow).not.toContain(styleId)

    // 持久化往返：读入路径保留轴，值不变
    const persisted = JSON.parse(localStorage.getItem('pylon-custom-presets')!) as { state: { zonePresetEntries: unknown } }
    const restored = normalizeZonePresetEntries(persisted.state.zonePresetEntries)
    expect(restored).toEqual(entries)
    expect(restored.find(entry => entry.id === styleId)?.axis).toBe('style')

    // 可复现：改成别的值 → 应用该条目 → 回到保存时的值
    useThemeStore.getState().setZoneField('chat', { msgLineHeight: 1.1, messageRadius: 2 })
    const colorBefore = (useThemeStore.getState() as unknown as Record<string, unknown>).messageUserBg
    useThemeStore.getState().applyZonePreset('chat', styleId, resolveZonePresetEntryTheme(styleEntry)!)
    expect((useThemeStore.getState() as unknown as Record<string, unknown>).msgLineHeight).toBe(2.05)
    expect((useThemeStore.getState() as unknown as Record<string, unknown>).messageRadius).toBe(22)
    // 且只动自己那一轴（样式单不含配色键 ⇒ 配色值不动）
    expect((useThemeStore.getState() as unknown as Record<string, unknown>).messageUserBg).toBe(colorBefore)
  })

  it('蓝调桶也能存自定义（家族暂无公开成员也不影响「存当前」）', () => {
    useInterfaceModeStore.setState({ interfaceMode: 'tactical-blue' })
    useThemeStore.getState().setZoneField('sidebar', { sidebarBg: '#123456' })
    const id = useCustomPresetStore.getState().saveZonePresetEntry('tactical', 'sidebar', '蓝调侧栏')!
    expect(id).toBeTruthy()
    const row = zonePresetsFor('tactical-blue', 'sidebar', useCustomPresetStore.getState().zonePresetEntries)
    expect(row.some(entry => entry.id === id)).toBe(true)
  })
})
