/** 独立引用合同与纯解析；待迁字段只允许 inputBorderColor 从 global 移至 cc。 */
import { PRESET_ZONES, type PresetZone, type GlobalPresetZoneSlice } from '../presetReducer.ts'
import { THEME_PRESET_KEYS, ZONE_FIELDS } from '../themeFieldDefs.ts'
import type { ThemeSettings } from '../themeTypes.ts'
import type { PresetInterfaceMode } from '../presets/types.ts'
import type { ChatPresetAxis, ZonePresetEntry } from './zonePresetPool.ts'
import { chatPresetAxisForField } from './chatPresetAxes.ts'

export type ModePresetRefs = Readonly<Record<Exclude<PresetZone, 'chat'>, string> & {
  chat: Readonly<Record<ChatPresetAxis, string>>
}>

export interface ModePresetDefinition {
  readonly name: string
  readonly label: string
  readonly mode: PresetInterfaceMode
  readonly refs: ModePresetRefs
  readonly hidden?: true
}

export type LandingPresetEntry = ZonePresetEntry & {
  readonly styleMaterial?: Readonly<{ profileId: string }>
}
export type LandingPresetPool = readonly LandingPresetEntry[]

function recordOf(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context}：不是键值表`)
  return value as Record<string, unknown>
}

function requireKeys(record: Record<string, unknown>, keys: readonly string[], context: string): void {
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${context}：缺项或多余键`)
  }
}

function requireId(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${context}：引用为空`)
  return value
}

export function requireModePresetRefs(value: unknown): ModePresetRefs {
  const refs = recordOf(value, '区域引用表')
  requireKeys(refs, PRESET_ZONES, '区域引用表')
  const chat = recordOf(refs.chat, '消息流双引用')
  requireKeys(chat, ['style', 'color'], '消息流双引用')
  return {
    global: requireId(refs.global, 'global'),
    sidebar: requireId(refs.sidebar, 'sidebar'),
    chat: { style: requireId(chat.style, 'chat/style'), color: requireId(chat.color, 'chat/color') },
    cc: requireId(refs.cc, 'cc'),
    right: requireId(refs.right, 'right'),
  }
}

export function assertLandingEntry(entry: LandingPresetEntry): void {
  requireId(entry.id, '材料身份')
  if (!['gui', 'terminal', 'tactical'].includes(entry.mode)) throw new Error(`非法模式桶：${entry.mode}`)
  if (!(PRESET_ZONES as readonly string[]).includes(entry.zone)) throw new Error(`非法区域：${entry.zone}`)
  if (entry.zone === 'chat' ? !['style', 'color'].includes(entry.axis ?? '') : entry.axis !== undefined) {
    throw new Error(`非法区域轴：${entry.zone}/${entry.axis}`)
  }
  if (entry.styleMaterial && (entry.zone !== 'chat' || entry.axis !== 'style')) throw new Error('非标量身份只属消息流样式')
  recordOf(entry.values, '材料值')
  for (const key of Object.keys(entry.values)) {
    if (!(THEME_PRESET_KEYS as readonly string[]).includes(key)) throw new Error(`非预设管理字段：${key}`)
    const zone = key === 'inputBorderColor' ? 'cc' : entry.zone
    const owned = key === 'inputBorderColor'
      ? entry.zone === zone
      : (ZONE_FIELDS[entry.zone] ?? []).includes(key as keyof ThemeSettings)
    if (!owned) throw new Error(`越区字段：${entry.zone}/${key}`)
    if (entry.zone === 'chat' && chatPresetAxisForField(key) !== entry.axis) throw new Error(`越轴字段：${entry.axis}/${key}`)
  }
}

function compositeKey(mode: PresetInterfaceMode, zone: string, axis: ChatPresetAxis | undefined, id: string): string {
  return JSON.stringify([mode, zone, axis ?? null, id])
}

function indexLandingPool(pool: LandingPresetPool): Map<string, LandingPresetEntry> {
  const entries = new Map<string, LandingPresetEntry>()
  for (const entry of pool) {
    assertLandingEntry(entry)
    const key = compositeKey(entry.mode, entry.zone, entry.axis, entry.id)
    if (entries.has(key)) throw new Error(`重复材料复合键：${key}`)
    entries.set(key, entry)
  }
  return entries
}

export function resolveLandingReference(
  mode: PresetInterfaceMode,
  zone: PresetZone,
  id: string,
  pool: LandingPresetPool,
  axis?: ChatPresetAxis,
): LandingPresetEntry {
  const entry = indexLandingPool(pool).get(compositeKey(mode, zone, axis, requireId(id, '区域引用')))
  if (!entry || entry.stale) throw new Error(`区域引用解析不到或不可用：${mode}/${zone}/${axis ?? ''}/${id}`)
  return structuredClone(entry)
}

export interface ResolvedModePreset {
  readonly slices: GlobalPresetZoneSlice[]
  readonly chat: Readonly<Record<ChatPresetAxis, LandingPresetEntry>>
  readonly values: Partial<ThemeSettings>
}

export function resolveModePreset(definition: ModePresetDefinition, pool: LandingPresetPool): ResolvedModePreset {
  requireKeys(recordOf(definition, '预设定义'), definition.hidden === undefined
    ? ['name', 'label', 'mode', 'refs'] : ['name', 'label', 'mode', 'refs', 'hidden'], '预设定义')
  requireId(definition.name, '预设名')
  requireId(definition.label, '预设标签')
  if (definition.hidden !== undefined && definition.hidden !== true) throw new Error('非法隐藏标记')
  const refs = requireModePresetRefs(definition.refs)
  const entries = indexLandingPool(pool)
  function resolve(zone: PresetZone, id: string, axis?: ChatPresetAxis): LandingPresetEntry {
    const entry = entries.get(compositeKey(definition.mode, zone, axis, id))
    if (!entry || entry.stale) throw new Error(`区域引用解析不到或不可用：${definition.mode}/${zone}/${axis ?? ''}/${id}`)
    return structuredClone(entry)
  }
  const chat = { style: resolve('chat', refs.chat.style, 'style'), color: resolve('chat', refs.chat.color, 'color') }
  const slices = PRESET_ZONES.map(zone => {
    if (zone === 'chat') return {
      zone, presetName: definition.name, theme: { ...chat.style.values, ...chat.color.values },
    }
    const entry = resolve(zone, refs[zone])
    return { zone, presetName: entry.id, theme: entry.values }
  })
  return { slices, chat, values: Object.assign({}, ...slices.map(slice => slice.theme)) }
}
