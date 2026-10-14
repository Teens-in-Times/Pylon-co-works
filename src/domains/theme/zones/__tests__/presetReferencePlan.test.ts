import { describe, expect, it } from 'vitest'
import { PRESET_ZONES, assertZoneSliceOwnership } from '../../presetReducer.ts'
import { THEME_FIELD_DEFS } from '../../themeFieldDefs.ts'
import { MODE_DEFAULT_REFERENCES } from '../../presets/modeDefaultReferences.ts'
import { LANDING_PRESET_ENTRIES } from '../factory/landingEntries.ts'
import { requireModePresetRefs, resolveModePreset, assertLandingEntry, type LandingPresetEntry } from '../presetReferencePlan.ts'
import { legacyAssemblySlices } from '../modeLandingPlan.ts'

const definition = MODE_DEFAULT_REFERENCES.gui

describe('#607 引用计划', () => {
  it('五区六引用严格校验，缺轴空值多余区域与轴拒绝', () => {
    expect(requireModePresetRefs(definition.refs)).toEqual(definition.refs)
    const { right: _right, ...missing } = definition.refs
    void _right
    for (const refs of [null, [], missing, { ...definition.refs, extra: 'x' }, { ...definition.refs, cc: ' ' },
      { ...definition.refs, chat: { style: 'x' } }, { ...definition.refs, chat: { ...definition.refs.chat, extra: 'x' } },
      { ...definition.refs, chat: { style: '', color: 'x' } }, { ...definition.refs, chat: 'single' }]) {
      expect(() => requireModePresetRefs(refs)).toThrow()
    }
  })

  it('三隐藏成员按同桶同区同轴解析为五切片，返回值与来源隔离', () => {
    for (const item of Object.values(MODE_DEFAULT_REFERENCES)) {
      const result = resolveModePreset(item, LANDING_PRESET_ENTRIES)
      expect(result.slices.map(slice => slice.zone)).toEqual([...PRESET_ZONES])
      expect(result.chat.style.id).toBe(item.refs.chat.style)
      expect(result.chat.color.id).toBe(item.refs.chat.color)
      expect(result.chat.style.styleMaterial).toBeDefined()
      expect(result.chat.color.styleMaterial).toBeUndefined()
      expect(result.values).toEqual(Object.assign({}, ...result.slices.map(slice => slice.theme)))
      expect(result.chat.style.values).not.toBe(LANDING_PRESET_ENTRIES.find(entry => entry.id === item.refs.chat.style)?.values)
      result.values.ccHidden?.push('probe')
      expect(resolveModePreset(item, LANDING_PRESET_ENTRIES).values.ccHidden).not.toContain('probe')
    }
  })

  it('缺失错桶错区错轴重复键及非法定义拒绝，无外部修改', () => {
    const before = structuredClone(LANDING_PRESET_ENTRIES)
    for (const refs of [
      { ...definition.refs, cc: 'missing' },
      { ...definition.refs, cc: MODE_DEFAULT_REFERENCES.terminal.refs.cc },
      { ...definition.refs, cc: definition.refs.global },
      { ...definition.refs, chat: { style: definition.refs.chat.color, color: definition.refs.chat.style } },
    ]) expect(() => resolveModePreset({ ...definition, refs }, LANDING_PRESET_ENTRIES)).toThrow(/解析不到/)
    expect(() => resolveModePreset(definition, [...LANDING_PRESET_ENTRIES, LANDING_PRESET_ENTRIES[0]])).toThrow(/重复材料复合键/)
    const illegalDefinition = { ...definition, theme: {} }
    expect(() => resolveModePreset(illegalDefinition, LANDING_PRESET_ENTRIES)).toThrow(/多余键/)
    expect(LANDING_PRESET_ENTRIES).toEqual(before)
  })

  it('新材料越区越轴非预设字段拒绝，边线只归cc且旧漏斗逐键合法', () => {
    const base: LandingPresetEntry = { id: 'probe', mode: 'gui', zone: 'cc', values: { inputBorderColor: '#fff' }, label: 'probe' }
    expect(() => assertLandingEntry(base)).not.toThrow()
    expect(() => assertLandingEntry({ ...base, zone: 'global' })).toThrow(/越区/)
    expect(() => assertLandingEntry({ ...base, values: { sidebarWidth: 250 } })).toThrow(/非预设管理/)
    expect(() => assertLandingEntry({ ...base, values: { ccEditMode: false } })).toThrow(/非预设管理/)
    expect(() => assertLandingEntry({ ...base, zone: 'chat', axis: 'style', values: { chatBg: '#fff' } })).toThrow(/越轴/)
    expect(() => assertLandingEntry({ ...base, values: { accent: '#fff' } })).toThrow(/越区/)
    expect(THEME_FIELD_DEFS.inputBorderColor.zone).toBe('global')
    for (const item of Object.values(MODE_DEFAULT_REFERENCES)) {
      const result = resolveModePreset(item, LANDING_PRESET_ENTRIES)
      expect(result.slices.filter(slice => Object.hasOwn(slice.theme, 'inputBorderColor')).map(slice => slice.zone)).toEqual(['cc'])
      const adapted = legacyAssemblySlices(result.slices)
      for (const slice of adapted) expect(() => assertZoneSliceOwnership(slice.zone, slice.theme, '测试旧合同')).not.toThrow()
      expect(Object.assign({}, ...adapted.map(slice => slice.theme))).toEqual(result.values)
      expect(result.slices.find(slice => slice.zone === 'cc')?.theme).toHaveProperty('inputBorderColor')
    }
  })
})
