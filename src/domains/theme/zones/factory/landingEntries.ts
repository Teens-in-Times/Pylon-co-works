/** 独立落点备料；构建时拆分只读来源，不连接生产池或现场状态。 */
import { DEFAULTS } from '../../themeDefaults.ts'
import { DEFAULT_PRESETS } from '../../presets/builtin.ts'
import { filterPresetTheme, PRESET_ZONES } from '../../presetReducer.ts'
import type { PresetInterfaceMode } from '../../presets/types.ts'
import type { ThemeSettings } from '../../themeTypes.ts'
import { pickZoneFields } from '../pickZoneFields.ts'
import { splitChatPresetValues } from '../chatPresetAxes.ts'
import { assertLandingEntry, type LandingPresetEntry } from '../presetReferencePlan.ts'
import { FACTORY_ZONE_PRESET_ENTRIES } from './index.ts'
import { FACTORY_PROFILE_ZONE_PRESET_ENTRIES } from './profileEntries.ts'

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child)
    Object.freeze(value)
  }
  return value
}

const PROFILE_INPUT_BORDERS: Readonly<Record<string, string>> = Object.freeze({
  'builtin.presentation.modern-gui': 'rgba(148,163,184,0.26)',
  'builtin.presentation.terminal-classic': '',
  'builtin.presentation.terminal-modern': 'rgba(59,130,246,0.32)',
  'builtin.presentation.paper-low-contrast': 'rgba(128,102,63,0.24)',
  'builtin.presentation.console-glass': 'rgba(148,163,184,0.30)',
  'builtin.presentation.agent-command': 'rgba(148,163,184,0.24)',
  'builtin.presentation.agent-map': 'rgba(148,163,184,0.24)',
  'builtin.presentation.focus-flow': 'rgba(148,163,184,0.24)',
  'builtin.presentation.tactical-blue': 'rgba(119,172,230,0.45)',
})

function profileEntry(profileId: string, zone: 'chat' | 'cc'): LandingPresetEntry {
  const entry = FACTORY_PROFILE_ZONE_PRESET_ENTRIES.find(item => item.id === profileId && item.zone === zone)
  if (!entry) throw new Error(`缺少档案原材料：${profileId}/${zone}`)
  return structuredClone(entry)
}

function profileBorder(profileId: string): string {
  const value = PROFILE_INPUT_BORDERS[profileId]
  if (value === undefined) throw new Error(`缺少待迁边线：${profileId}`)
  return value
}

function splitChat(entry: LandingPresetEntry, source: 'factory' | 'profile'): LandingPresetEntry[] {
  const axes = splitChatPresetValues(entry.values)
  return (['style', 'color'] as const).map(axis => ({
    ...structuredClone(entry), id: `${source}:${entry.id}:chat:${axis}`, zone: 'chat', axis,
    values: axes[axis],
    ...(axis === 'style' && entry.source?.profileId ? { styleMaterial: { profileId: entry.source.profileId } } : {}),
  }))
}

function buildLandingEntries(): LandingPresetEntry[] {
  const entries: LandingPresetEntry[] = []
  for (const original of FACTORY_ZONE_PRESET_ENTRIES) {
    if (original.zone === 'chat') {
      entries.push(...splitChat(original, 'factory'))
      continue
    }
    const entry = structuredClone(original)
    entry.values = filterPresetTheme(entry.values)
    if (entry.zone === 'global') delete entry.values.inputBorderColor
    if (entry.zone === 'cc') {
      const global = FACTORY_ZONE_PRESET_ENTRIES.find(item => item.mode === entry.mode && item.zone === 'global' && item.id === entry.id)
      if (global?.values.inputBorderColor !== undefined) entry.values.inputBorderColor = global.values.inputBorderColor
    }
    entry.id = `factory:${entry.id}:${entry.zone}`
    entries.push(entry)
  }
  for (const original of FACTORY_PROFILE_ZONE_PRESET_ENTRIES) {
    if (original.zone === 'chat') entries.push(...splitChat(original, 'profile'))
    else if (original.zone === 'cc') entries.push({
      ...structuredClone(original), id: `profile:${original.id}:cc`,
      values: { ...structuredClone(original.values), inputBorderColor: profileBorder(original.id) },
    })
  }
  for (const [mode, profileId] of [
    ['gui', 'builtin.presentation.modern-gui'],
    ['terminal', 'builtin.presentation.terminal-classic'],
    ['tactical', 'builtin.presentation.tactical-blue'],
  ] as const) {
    const baseline: Partial<ThemeSettings> = {
      ...filterPresetTheme(structuredClone(DEFAULTS)),
      ...(mode === 'tactical' ? {} : structuredClone(filterPresetTheme(DEFAULT_PRESETS[mode].theme))),
      ...profileEntry(profileId, 'chat').values,
      ...profileEntry(profileId, 'cc').values,
      inputBorderColor: profileBorder(profileId),
      ...(mode === 'tactical' ? {
        accent: '#65dfff', titlebarBg: '#080e19', titlebarTextColor: '#f4f8ff',
        sidebarBg: '#0c1728', sidebarTextColor: '#c2d0e3', chatBg: '#080f1e',
        chatTextColor: '#eef5ff', msgTextColor: '#eef5ff', rightBg: '#101c30',
      } : {}),
    }
    for (const zone of PRESET_ZONES) {
      const values = pickZoneFields(baseline, zone)
      if (zone === 'global') delete values.inputBorderColor
      if (zone === 'cc') values.inputBorderColor = baseline.inputBorderColor
      const base: LandingPresetEntry = {
        id: defaultLandingEntryId(mode, zone), label: `${mode}-默认`, mode, zone,
        origin: 'factory', values,
      }
      if (zone === 'chat') {
        const axes = splitChatPresetValues(values)
        entries.push(...(['style', 'color'] as const).map(axis => ({
          ...base, zone: 'chat' as const, id: defaultLandingEntryId(mode, 'chat', axis), axis, values: axes[axis],
          ...(axis === 'style' ? { styleMaterial: { profileId } } : {}),
        })))
      } else entries.push(base)
    }
  }
  for (const entry of entries) assertLandingEntry(entry)
  return entries
}

export function defaultLandingEntryId(mode: PresetInterfaceMode, zone: string, axis?: 'style' | 'color'): string {
  return `default:${mode}:${zone}${axis ? `:${axis}` : ''}`
}

export const LANDING_PRESET_ENTRIES: readonly LandingPresetEntry[] = freezeTree(buildLandingEntries())
