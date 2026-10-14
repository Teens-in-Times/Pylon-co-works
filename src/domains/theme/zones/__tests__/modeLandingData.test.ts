import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { PRESET_ZONES } from '../../presetReducer.ts'
import { DEFAULT_PRESETS, INTERFACE_MODE_PRESET_BUCKET, defaultPresetForInterfaceMode } from '../../presets/builtin.ts'
import { THEME_FIELD_DEFS, type ThemeFieldDef, type ThemeFieldKey } from '../../themeFieldDefs.ts'
import {
  FACTORY_PROFILE_ZONE_PRESET_ENTRIES,
  FACTORY_ZONE_PRESET_ENTRIES,
  ZONE_PRESET_POOL,
  assembleFactoryZonePresetPool,
  chatPresetsForAxis,
  isCustomZonePresetEntry,
  resolveZonePresetEntryTheme,
  zonePresetsFor,
  type ZonePresetEntry,
} from '../index.ts'
import { LANDING_PRESET_ENTRIES } from '../factory/landingEntries.ts'

const BUCKETS = ['gui', 'terminal', 'tactical'] as const
const PROFILE_BUCKETS = { 'modern-gui': 'gui', 'terminal-like': 'terminal', 'tactical-blue': 'tactical' } as const

function fieldDef(key: string): ThemeFieldDef | undefined {
  return THEME_FIELD_DEFS[key as ThemeFieldKey]
}

function census(entries: readonly ZonePresetEntry[]) {
  const pool = assembleFactoryZonePresetPool(entries)
  return Object.fromEntries(BUCKETS.map(mode => [mode,
    Object.fromEntries(PRESET_ZONES.map(zone => [zone, pool[mode][zone].length])),
  ]))
}

// @ts-expect-error 只有 chat 可以声明轴。
const invalidCcAxis: ZonePresetEntry = { id: 'invalid', mode: 'gui', zone: 'cc', axis: 'style', label: 'invalid', values: {} }

// @ts-expect-error 来源身份不能同时指向预设与档案。
const invalidSource: ZonePresetEntry = { id: 'invalid', mode: 'gui', zone: 'chat', label: 'invalid', values: {}, source: { presetName: 'glass', profileId: 'profile' } }

void invalidSource

describe('#607 刀1 · 独立档案数据准备', () => {
  it('九份档案逐区逐键保真，来源与显式模式归桶一致', () => {
    expect(BUILTIN_PRESENTATION_PROFILES).toHaveLength(9)
    expect(FACTORY_PROFILE_ZONE_PRESET_ENTRIES).toHaveLength(18)
    const keys = FACTORY_PROFILE_ZONE_PRESET_ENTRIES.map(entry => `${entry.mode}/${entry.zone}/${entry.id}`)
    expect(new Set(keys).size).toBe(18)
    for (const profile of BUILTIN_PRESENTATION_PROFILES) {
      const mode = profile.interfaceMode ? PROFILE_BUCKETS[profile.interfaceMode as keyof typeof PROFILE_BUCKETS] : 'terminal'
      expect(mode, profile.id).toBeDefined()
      for (const zone of ['chat', 'cc'] as const) {
        const matches = FACTORY_PROFILE_ZONE_PRESET_ENTRIES.filter(entry => entry.id === profile.id && entry.zone === zone)
        expect(matches, `${profile.id}/${zone}`).toHaveLength(1)
        const entry = matches[0]
        const expected = Object.fromEntries(Object.entries(profile.tokens ?? {}).filter(([key]) => {
          const def = fieldDef(key)
          return def?.zone === zone && !def.meta
        }))
        expect(entry.values, `${profile.id}/${zone} 逐键保真`).toEqual(expected)
        expect(entry.mode, profile.id).toBe(mode)
        expect(entry.label, profile.id).toBe(profile.label)
        expect(entry.source).toEqual({ profileId: profile.id })
        expect(isCustomZonePresetEntry(entry)).toBe(false)
        expect(resolveZonePresetEntryTheme(entry)).toBe(entry.values)
        expect(entry.axis).toBe(zone === 'chat' ? 'style' : undefined)
        expect(entry.values).not.toHaveProperty('ccLayout')
      }
    }
  })

  it('三桶五区显式装配，新18条保留对象身份和同值不同来源', () => {
    const pool = assembleFactoryZonePresetPool(FACTORY_PROFILE_ZONE_PRESET_ENTRIES)
    expect(census(FACTORY_PROFILE_ZONE_PRESET_ENTRIES)).toEqual({
      gui: { global: 0, sidebar: 0, chat: 4, cc: 4, right: 0 },
      terminal: { global: 0, sidebar: 0, chat: 4, cc: 4, right: 0 },
      tactical: { global: 0, sidebar: 0, chat: 1, cc: 1, right: 0 },
    })
    for (const mode of BUCKETS) {
      expect(Object.keys(pool[mode])).toEqual([...PRESET_ZONES])
      for (const zone of PRESET_ZONES) {
        expect(pool[mode][zone]).toEqual(FACTORY_PROFILE_ZONE_PRESET_ENTRIES.filter(entry => entry.mode === mode && entry.zone === zone))
        for (const entry of pool[mode][zone]) {
          expect(FACTORY_PROFILE_ZONE_PRESET_ENTRIES).toContain(entry)
          expect(Object.isFrozen(entry)).toBe(true)
        }
      }
    }
    const twins = pool.gui.cc.filter(entry => ['builtin.presentation.agent-command', 'builtin.presentation.agent-map', 'builtin.presentation.focus-flow'].includes(entry.id))
    expect(twins).toHaveLength(3)
    expect(twins[0].values).toEqual(twins[1].values)
    expect(twins[1].values).toEqual(twins[2].values)
    expect(new Set(twins.map(entry => entry.source?.profileId)).size).toBe(3)
    console.info('[#607 新数据逐桶逐区]', JSON.stringify(census(FACTORY_PROFILE_ZONE_PRESET_ENTRIES)))
  })

  it('chat纯查询分轴，旧无轴按配色解释且不改值不改顺序', () => {
    const color: ZonePresetEntry = { id: 'explicit-color', mode: 'gui', zone: 'chat', axis: 'color', label: '配色', values: { messageRadius: 2 } }
    const entries = [...FACTORY_ZONE_PRESET_ENTRIES, ...FACTORY_PROFILE_ZONE_PRESET_ENTRIES, color]
    const pool = assembleFactoryZonePresetPool(entries)
    for (const mode of BUCKETS) {
      const styles = chatPresetsForAxis(pool, mode, 'style')
      const colors = chatPresetsForAxis(pool, mode, 'color')
      expect(styles).toEqual(FACTORY_PROFILE_ZONE_PRESET_ENTRIES.filter(entry => entry.mode === mode && entry.zone === 'chat'))
      expect(colors).toEqual([...FACTORY_ZONE_PRESET_ENTRIES.filter(entry => entry.mode === mode && entry.zone === 'chat'), ...(mode === 'gui' ? [color] : [])])
      for (const entry of [...styles, ...colors]) expect(entries).toContain(entry)
    }
    expect(chatPresetsForAxis(pool, 'tactical', 'color')).toEqual([])
    expect(FACTORY_ZONE_PRESET_ENTRIES.every(entry => entry.axis === undefined)).toBe(true)
  })

  it('非chat轴与越区字段在装配时拒绝，不静默过滤（待迁边线是唯一例外）', () => {
    expect(() => assembleFactoryZonePresetPool([invalidCcAxis])).toThrow(/非法 chat 轴/)
    const badChatAxis = { ...invalidCcAxis, zone: 'chat', axis: 'invalid' } as unknown as ZonePresetEntry
    expect(() => assembleFactoryZonePresetPool([badChatAxis])).toThrow(/非法 chat 轴/)
    // ★ #607 刀3a：`inputBorderColor` 是**唯一**允许落在 cc 材料里的待迁边线（字段归属表里仍写 global）
    const pendingBorder: ZonePresetEntry = { id: 'pending-border', mode: 'tactical', zone: 'cc', label: '待迁', values: { inputBorderColor: '#fff' } }
    expect(() => assembleFactoryZonePresetPool([pendingBorder])).not.toThrow()
    // 其余跨区键照旧报错（闸门没有被这条例外放宽）
    const crossZone: ZonePresetEntry = { id: 'cross-zone', mode: 'tactical', zone: 'cc', label: '越区', values: { sidebarBg: '#fff' } }
    expect(() => assembleFactoryZonePresetPool([crossZone])).toThrow(/越区.*sidebarBg/)
  })

  it('工厂原材料原处不动，候选为factory:*加样式轴/中控行指定档案（蓝调桶以默认单出候选）', () => {
    expect(FACTORY_ZONE_PRESET_ENTRIES).toHaveLength(50)
    expect(new Set(FACTORY_ZONE_PRESET_ENTRIES.map(entry => entry.id)).size).toBe(10)
    const usedProfileIds = new Set(LANDING_PRESET_ENTRIES
      .filter(entry => (entry.id.startsWith('default:') || entry.id.startsWith('preset:'))
        && entry.zone === 'chat' && entry.axis === 'style')
      .map(entry => entry.styleMaterial?.profileId))
    for (const [interfaceMode, mode] of [['modern-gui', 'gui'], ['terminal-like', 'terminal']] as const) {
      for (const zone of PRESET_ZONES) {
        const expected = LANDING_PRESET_ENTRIES.filter(entry =>
          entry.id.startsWith('factory:') && entry.mode === mode && entry.zone === zone)
        expect(ZONE_PRESET_POOL[mode][zone]).toEqual(expected)
        const profiles = LANDING_PRESET_ENTRIES.filter(entry => entry.mode === mode && entry.zone === zone
          && entry.id.startsWith('profile:') && !usedProfileIds.has(entry.source?.profileId))
        // 池仍只装工厂；行候选为工厂条加样式轴/中控行的指定档案，顺序固定。
        expect(zonePresetsFor(interfaceMode, zone)).toEqual([...expected, ...(zone === 'cc' ? profiles : [])])
        if (zone === 'chat') for (const axis of ['style', 'color'] as const) {
          expect(zonePresetsFor(interfaceMode, zone, [], axis)).toEqual([
            ...expected.filter(entry => entry.axis === axis),
            ...(axis === 'style' ? profiles.filter(entry => entry.axis === 'style') : []),
          ])
        }
      }
    }
    expect(zonePresetsFor('terminal-like', 'cc').filter(entry => entry.id.startsWith('profile:')).map(entry => entry.id))
      .toEqual([
        'profile:builtin.presentation.terminal-modern:cc',
        'profile:builtin.presentation.paper-low-contrast:cc',
        'profile:builtin.presentation.console-glass:cc',
      ])
    expect(zonePresetsFor('modern-gui', 'cc').filter(entry => entry.id.startsWith('profile:'))).toEqual([])
    for (const interfaceMode of ['modern-gui', 'terminal-like', 'tactical-blue']) {
      expect(zonePresetsFor(interfaceMode, 'chat', [], 'color').filter(entry => entry.id.startsWith('profile:'))).toEqual([])
    }
    // 蓝调：家族里只有隐藏默认一员 ⇒ 区域行以它出候选（否则该桶区域行整组不渲染）
    for (const zone of PRESET_ZONES) {
      const expected = LANDING_PRESET_ENTRIES.filter(entry =>
        entry.id.startsWith('default:tactical:') && entry.zone === zone)
      expect(ZONE_PRESET_POOL.tactical[zone]).toEqual(expected)
      expect(zonePresetsFor('tactical-blue', zone)).toEqual(expected)
    }
    expect(INTERFACE_MODE_PRESET_BUCKET['tactical-blue']).toBe('tactical')
    expect(DEFAULT_PRESETS.tactical).toBeUndefined()
    expect(defaultPresetForInterfaceMode('tactical-blue')).toBeUndefined()
    expect(defaultPresetForInterfaceMode('modern-gui')).toBe(DEFAULT_PRESETS.gui)
    expect(defaultPresetForInterfaceMode('terminal-like')).toBe(DEFAULT_PRESETS.terminal)
  })

  it('未迁移token只含已点名全局边线，非标量材料仍留在九档案', () => {
    const pending = BUILTIN_PRESENTATION_PROFILES.map(profile => {
      const tokens = Object.entries(profile.tokens ?? {})
      expect(tokens.filter(([key]) => !fieldDef(key)), `${profile.id} 未知键`).toEqual([])
      expect(tokens.filter(([key]) => fieldDef(key)?.meta), `${profile.id} meta键`).toEqual([])
      const outside = tokens.filter(([key]) => !['chat', 'cc'].includes(fieldDef(key)!.zone))
      expect(outside.map(([key]) => key), profile.id).toEqual(['inputBorderColor'])
      expect(profile.assets, `${profile.id} assets尚未迁移`).toBeDefined()
      const kinds = Object.keys(profile.kindTokens ?? {})
      expect(kinds.length).toBe(['builtin.presentation.agent-command', 'builtin.presentation.agent-map', 'builtin.presentation.focus-flow'].includes(profile.id) ? 8 : 0)
      expect(profile).not.toHaveProperty('rendererSuiteId')
      return { profileId: profile.id, outsideTokens: Object.fromEntries(outside), kindTokens: kinds, assets: profile.assets, rendererSuiteId: null }
    })
    console.info('[#607 待后续迁移材料]', JSON.stringify(pending))
  })
})
