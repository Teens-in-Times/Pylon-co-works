import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../../themeDefaults.ts'
import { THEME_PRESET_KEYS, THEME_FIELD_OWNERS } from '../../themeFieldDefs.ts'
import { PRESET_ZONES, filterPresetTheme, clampPresetCcHeight } from '../../presetReducer.ts'
import { normalizeCcLayout } from '../../../cc/ccLayoutState.ts'
import { DEFAULT_PRESETS, GLOBAL_PRESETS, INTERFACE_MODE_PRESET_BUCKET, defaultPresetForInterfaceMode, fallbackPresetChip } from '../../presets/builtin.ts'
import { MODE_DEFAULT_REFERENCES, modeDefaultForInterfaceMode } from '../../presets/modeDefaultReferences.ts'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { FACTORY_ZONE_PRESET_ENTRIES } from '../factory/index.ts'
import { FACTORY_PROFILE_ZONE_PRESET_ENTRIES } from '../factory/profileEntries.ts'
import { LANDING_PRESET_ENTRIES } from '../factory/landingEntries.ts'
import { planModeDefault } from '../modeLandingPlan.ts'
import { resolveModePreset } from '../presetReferencePlan.ts'
import { zonePresetsFor } from '../zonePresetPool.ts'

const modes = [
  ['modern-gui', 'gui', 'builtin.presentation.modern-gui'],
  ['terminal-like', 'terminal', 'builtin.presentation.terminal-classic'],
  ['tactical-blue', 'tactical', 'builtin.presentation.tactical-blue'],
] as const

function deeplyFrozen(value: unknown): boolean {
  return !value || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen))
}

describe('#607 完整默认准备', () => {
  it('三默认逐字段保真覆盖完整DEFAULTS，非预设宽度260且结构归一清账', () => {
    for (const [interfaceMode, mode, profileId] of modes) {
      const profile = BUILTIN_PRESENTATION_PROFILES.find(item => item.id === profileId)
      expect(profile).toBeDefined()
      const expected = {
        ...structuredClone(DEFAULTS),
        ...(mode === 'tactical' ? {} : filterPresetTheme(structuredClone(DEFAULT_PRESETS[mode].theme))),
        ...profile?.tokens,
        ...(mode === 'tactical' ? {
          accent: '#65dfff', titlebarBg: '#080e19', titlebarTextColor: '#f4f8ff', sidebarBg: '#0c1728',
          sidebarTextColor: '#c2d0e3', chatBg: '#080f1e', chatTextColor: '#eef5ff', msgTextColor: '#eef5ff', rightBg: '#101c30',
        } : {}),
      }
      expected.ccLayout = normalizeCcLayout(expected.ccLayout)
      expected.ccHeight = clampPresetCcHeight(expected)
      const plan = planModeDefault(MODE_DEFAULT_REFERENCES[mode], LANDING_PRESET_ENTRIES)
      expect(plan).toEqual(expected)
      expect(Object.keys(plan).sort()).toEqual(Object.keys(DEFAULTS).sort())
      expect(plan.rightWidth).toBe(260)
      expect(plan.sidebarWidth).toBe(DEFAULTS.sidebarWidth)
      expect(plan.ccEditMode).toBe(false)
      expect(plan.ccPluginProps).toEqual({})
      expect(plan.ccHidden).toEqual(expected.ccHidden)
      expect(plan.ccHiddenEmpty).toEqual(DEFAULTS.ccHiddenEmpty)
      for (const zone of PRESET_ZONES) {
        expect(plan.appliedPreset[zone]).toBe('')
        expect(plan.custom[zone]).toBe(false)
      }
      const resolved = resolveModePreset(MODE_DEFAULT_REFERENCES[mode], LANDING_PRESET_ENTRIES)
      expect(Object.keys(resolved.values).sort()).toEqual([...THEME_PRESET_KEYS].sort())
      console.info('[#607 默认覆盖]', JSON.stringify({ interfaceMode, full: Object.keys(plan).length, preset: Object.keys(resolved.values).length, rightWidth: plan.rightWidth, sidebarWidth: plan.sidebarWidth }))
    }
    expect(THEME_FIELD_OWNERS.rightWidth.owner).toBe('right-rail')
    expect(THEME_FIELD_OWNERS.sidebarWidth.owner).toBe('workspace-layout')
    expect(DEFAULT_PRESETS.gui.theme.rightWidth).toBe(250)
  })

  it('材料数量唯一且深冻结隔离，九边线与样式非标量来源逐份正确', () => {
    const oldChat = LANDING_PRESET_ENTRIES.filter(entry => entry.id.startsWith('factory:') && entry.zone === 'chat')
    const profileChat = LANDING_PRESET_ENTRIES.filter(entry => entry.id.startsWith('profile:') && entry.zone === 'chat')
    const profileCc = LANDING_PRESET_ENTRIES.filter(entry => entry.id.startsWith('profile:') && entry.zone === 'cc')
    const defaults = LANDING_PRESET_ENTRIES.filter(entry => entry.id.startsWith('default:'))
    expect([oldChat.length, profileChat.length, profileCc.length, defaults.length]).toEqual([20, 18, 9, 18])
    expect(LANDING_PRESET_ENTRIES).toHaveLength(105)
    expect(new Set(LANDING_PRESET_ENTRIES.map(entry => JSON.stringify([entry.mode, entry.zone, entry.axis, entry.id]))).size).toBe(105)
    expect(deeplyFrozen(LANDING_PRESET_ENTRIES)).toBe(true)
    for (const entry of LANDING_PRESET_ENTRIES) {
      expect(entry.values).not.toHaveProperty('rightWidth')
      expect(entry.values).not.toHaveProperty('sidebarWidth')
      expect(entry.values).not.toHaveProperty('ccEditMode')
      expect(entry.values).not.toHaveProperty('profileId')
      if (Object.hasOwn(entry.values, 'inputBorderColor')) expect(entry.zone).toBe('cc')
      expect([...FACTORY_ZONE_PRESET_ENTRIES, ...FACTORY_PROFILE_ZONE_PRESET_ENTRIES].some(source => source.values === entry.values)).toBe(false)
    }
    for (const profile of BUILTIN_PRESENTATION_PROFILES) {
      const entry = profileCc.find(item => item.source?.profileId === profile.id)
      expect(entry?.values.inputBorderColor).toBe(profile.tokens?.inputBorderColor)
      expect(profileChat.find(item => item.axis === 'style' && item.source?.profileId === profile.id)?.styleMaterial).toEqual({ profileId: profile.id })
    }
    console.info('[#607 材料计数]', JSON.stringify({ factoryChat: oldChat.length, profileChat: profileChat.length, profileCc: profileCc.length, defaults: defaults.length, otherFactory: 40, total: LANDING_PRESET_ENTRIES.length }))
    console.info('[#607 旧默认过滤移除]', JSON.stringify(Object.entries(DEFAULT_PRESETS).map(([mode, item]) => ({ mode, removed: Object.keys(item.theme).filter(key => !Object.hasOwn(filterPresetTheme(item.theme), key)).map(key => ({ key, owner: THEME_FIELD_OWNERS[key as keyof typeof THEME_FIELD_OWNERS].owner })) }))))
  })

  it('计划不读现场或记忆，返回结构可独立修改且缺完整默认拒绝', () => {
    for (const [interfaceMode, mode] of modes) {
      expect(modeDefaultForInterfaceMode(interfaceMode)).toBe(MODE_DEFAULT_REFERENCES[mode])
      const first = planModeDefault(MODE_DEFAULT_REFERENCES[mode], LANDING_PRESET_ENTRIES)
      const second = planModeDefault(MODE_DEFAULT_REFERENCES[mode], LANDING_PRESET_ENTRIES)
      first.rightWidth = 999
      first.ccLayout.placements.input.offsetX = 999
      first.ccPluginProps.probe = { width: 999 }
      first.custom.cc = true
      expect(planModeDefault(MODE_DEFAULT_REFERENCES[mode], LANDING_PRESET_ENTRIES)).toEqual(second)
    }
    expect(modeDefaultForInterfaceMode('missing')).toBeUndefined()
    const incomplete = structuredClone(LANDING_PRESET_ENTRIES)
    const cc = incomplete.find(entry => entry.id === MODE_DEFAULT_REFERENCES.gui.refs.cc)
    if (!cc) throw new Error('测试默认材料缺失')
    delete cc.values.inputRadius
    expect(() => planModeDefault(MODE_DEFAULT_REFERENCES.gui, incomplete)).toThrow(/缺少完整字段/)
  })

  it('新隐藏默认不泄漏旧候选chips，旧50旧18与来源/输入池调用前后不变', () => {
    expect(GLOBAL_PRESETS).toHaveLength(10)
    expect(FACTORY_ZONE_PRESET_ENTRIES).toHaveLength(50)
    expect(FACTORY_PROFILE_ZONE_PRESET_ENTRIES).toHaveLength(18)
    for (const item of Object.values(MODE_DEFAULT_REFERENCES)) {
      expect(item.hidden).toBe(true)
      expect(item).not.toHaveProperty('theme')
      expect(item).not.toHaveProperty('profileId')
      expect(GLOBAL_PRESETS.some(old => old.name === item.name)).toBe(false)
      expect(fallbackPresetChip(item.name, [])?.label).toBe('未知预设')
    }
    for (const [interfaceMode, mode] of modes) for (const zone of PRESET_ZONES) {
      expect(zonePresetsFor(interfaceMode, zone)).toEqual(FACTORY_ZONE_PRESET_ENTRIES.filter(entry => entry.mode === mode && entry.zone === zone))
    }
    expect(INTERFACE_MODE_PRESET_BUCKET['tactical-blue']).toBeUndefined()
    expect(defaultPresetForInterfaceMode('tactical-blue')).toBeUndefined()
    // 来源与显式入参不变守卫：快照只比对内存对象，不读 git 跟踪状态或历史存档。
    const sources = {
      factory: structuredClone(FACTORY_ZONE_PRESET_ENTRIES),
      profile: structuredClone(FACTORY_PROFILE_ZONE_PRESET_ENTRIES),
      guiDefault: structuredClone(DEFAULT_PRESETS.gui),
      terminalDefault: structuredClone(DEFAULT_PRESETS.terminal),
      bucket: structuredClone(INTERFACE_MODE_PRESET_BUCKET),
    }
    const pool = structuredClone(LANDING_PRESET_ENTRIES)
    const poolSnapshot = structuredClone(pool)
    for (const [, mode] of modes) {
      const definition = MODE_DEFAULT_REFERENCES[mode]
      expect(planModeDefault(definition, pool)).toEqual(planModeDefault(definition, LANDING_PRESET_ENTRIES))
      expect(resolveModePreset(definition, pool).values).toEqual(resolveModePreset(definition, LANDING_PRESET_ENTRIES).values)
    }
    expect(pool).toEqual(poolSnapshot)
    expect(FACTORY_ZONE_PRESET_ENTRIES).toEqual(sources.factory)
    expect(FACTORY_PROFILE_ZONE_PRESET_ENTRIES).toEqual(sources.profile)
    expect(DEFAULT_PRESETS.gui).toEqual(sources.guiDefault)
    expect(DEFAULT_PRESETS.terminal).toEqual(sources.terminalDefault)
    expect(INTERFACE_MODE_PRESET_BUCKET).toEqual(sources.bucket)
    console.info('[#607 来源不变]', JSON.stringify({ factory: sources.factory.length, profile: sources.profile.length, defaults: Object.keys(DEFAULT_PRESETS).length, pool: pool.length, bucket: Object.keys(sources.bucket).length }))
  })
})
