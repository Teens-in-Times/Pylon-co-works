/** 默认落点纯计划；只返回 patch，旧装配前临时还原待迁边线的旧归属。 */
import { DEFAULTS } from '../themeDefaults.ts'
import { assembleGlobalPresetReducer, type GlobalPresetZoneSlice } from '../presetReducer.ts'
import { THEME_PRESET_KEYS } from '../themeFieldDefs.ts'
import type { ThemeSettings } from '../themeTypes.ts'
import type { PresetInterfaceMode } from '../presets/types.ts'
import type { PresetZone } from '../presetReducer.ts'
import type { ChatPresetAxis } from './zonePresetPool.ts'
import { resolveLandingReference, resolveModePreset, type LandingPresetPool, type ModePresetDefinition } from './presetReferencePlan.ts'

export function legacyAssemblySlices(slices: readonly GlobalPresetZoneSlice[]): GlobalPresetZoneSlice[] {
  const result = slices.map(slice => structuredClone(slice))
  const global = result.find(slice => slice.zone === 'global')
  const cc = result.find(slice => slice.zone === 'cc')
  if (!global || !cc) throw new Error('待迁边线适配缺少global/cc区域')
  if (Object.hasOwn(global.theme, 'inputBorderColor')) throw new Error('待迁边线重复归属')
  if (cc.theme.inputBorderColor !== undefined) {
    global.theme.inputBorderColor = cc.theme.inputBorderColor
    delete cc.theme.inputBorderColor
  }
  return result
}

export function planModeDefault(definition: ModePresetDefinition, pool: LandingPresetPool): ThemeSettings {
  const resolved = resolveModePreset(definition, pool)
  const missing = THEME_PRESET_KEYS.filter(key => !Object.hasOwn(resolved.values, key))
  if (missing.length) throw new Error(`默认引用缺少完整字段：${missing.join('/')}`)
  const defaults = structuredClone(DEFAULTS)
  const patch = assembleGlobalPresetReducer(defaults, legacyAssemblySlices(resolved.slices), { appliedName: '' })
  return { ...defaults, ...patch }
}

export function planLandingRegion(
  mode: PresetInterfaceMode,
  zone: PresetZone,
  id: string,
  pool: LandingPresetPool,
  axis?: ChatPresetAxis,
): Partial<ThemeSettings> {
  return resolveLandingReference(mode, zone, id, pool, axis).values
}
