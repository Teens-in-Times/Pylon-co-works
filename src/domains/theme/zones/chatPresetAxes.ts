/** 消息流字段分轴；只分类与复制显式传入的值，不读取现场状态。 */
import { THEME_FIELD_DEFS, type ThemeFieldKey } from '../themeFieldDefs.ts'
import type { ThemeSettings } from '../themeTypes.ts'
import type { ChatPresetAxis } from './zonePresetPool.ts'

export function chatPresetAxisForField(key: string): ChatPresetAxis {
  if (!Object.hasOwn(THEME_FIELD_DEFS, key)) throw new Error(`消息流未知字段：${key}`)
  const def = THEME_FIELD_DEFS[key as ThemeFieldKey]
  if (def.zone !== 'chat' || def.meta) throw new Error(`非消息流预设字段：${key}`)
  return def.type === 'color' ? 'color' : 'style'
}

export function splitChatPresetValues(values: Partial<ThemeSettings>): Record<ChatPresetAxis, Partial<ThemeSettings>> {
  const entries = Object.entries(values)
  const axes = entries.map(([key]) => chatPresetAxisForField(key))
  return {
    style: structuredClone(Object.fromEntries(entries.filter((_, index) => axes[index] === 'style'))),
    color: structuredClone(Object.fromEntries(entries.filter((_, index) => axes[index] === 'color'))),
  }
}
