/** 默认落点纯计划；只返回 patch，旧装配前临时还原待迁边线的旧归属。 */
import { DEFAULTS } from '../themeDefaults.ts'
import { assembleGlobalPresetReducer, type GlobalPresetZoneSlice } from '../presetReducer.ts'
import { THEME_PRESET_KEYS } from '../themeFieldDefs.ts'
import type { ThemeSettings } from '../themeTypes.ts'
import type { PresetInterfaceMode } from '../presets/types.ts'
import type { PresetZone } from '../presetReducer.ts'
import type { ChatPresetAxis } from './zonePresetPool.ts'
import { modeDefaultForInterfaceMode } from '../presets/modeDefaultReferences.ts'
import { LANDING_PRESET_ENTRIES } from './factory/landingEntries.ts'
import { resolveLandingReference, resolveModePreset, type LandingPresetPool, type ModePresetDefinition, type ResolvedModePreset } from './presetReferencePlan.ts'

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
  return assembleDefaultFromResolved(resolveModePreset(definition, pool))
}

/** 整份默认计划 ＋ 它带来的消息流样式单身份。 */
export interface ModeDefaultPlan {
  /** 整份主题（含 `appliedPreset` 全 `''` / `custom` 全 `false` 的清账语义）。 */
  readonly theme: ThemeSettings
  /** 生效的消息流样式单身份（`activeProfileId` 的取值来源）；材料不带身份时为 undefined。 */
  readonly styleProfileId?: string
}

/**
 * ★ #607 刀3a：**界面模式 → 本大类隐藏默认单 → 整份主题计划**（切换 / 重置的唯一纯入口）。
 *
 * 未登记的模式（无 `MODE_DEFAULT_REFERENCES`，如插件模式）⇒ 返回 `undefined`，
 * 调用方回落整份 `DEFAULTS`（不报错、不悬空）。
 */
export function planModeDefaultForInterfaceMode(interfaceMode: string): ModeDefaultPlan | undefined {
  const definition = modeDefaultForInterfaceMode(interfaceMode)
  if (!definition) return undefined
  const resolved = resolveModePreset(definition, LANDING_PRESET_ENTRIES)
  const styleProfileId = resolved.chat.style.styleMaterial?.profileId
  return {
    theme: assembleDefaultFromResolved(resolved),
    ...(styleProfileId ? { styleProfileId } : {}),
  }
}

/** 已解析的默认单 → 整份主题（完整 DEFAULTS ＋ 逐区域装配的 patch，含清账语义）。 */
function assembleDefaultFromResolved(resolved: ResolvedModePreset): ThemeSettings {
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
