import { describe, expect, it } from 'vitest'
import { THEME_FIELD_DEFS, ZONE_FIELDS } from '../../themeFieldDefs.ts'
import { chatPresetAxisForField, splitChatPresetValues } from '../chatPresetAxes.ts'
import { FACTORY_ZONE_PRESET_ENTRIES } from '../factory/index.ts'
import { FACTORY_PROFILE_ZONE_PRESET_ENTRIES } from '../factory/profileEntries.ts'
import { LANDING_PRESET_ENTRIES } from '../factory/landingEntries.ts'
import { planLandingRegion } from '../modeLandingPlan.ts'

describe('#607 消息流两轴', () => {
  it('全集40色37样式互斥，隐藏字段及非色视觉参数按字段类型分类', () => {
    const colors = ZONE_FIELDS.chat.filter(key => chatPresetAxisForField(key) === 'color')
    const styles = ZONE_FIELDS.chat.filter(key => chatPresetAxisForField(key) === 'style')
    expect(colors).toHaveLength(40)
    expect(styles).toHaveLength(37)
    expect(new Set([...colors, ...styles]).size).toBe(77)
    for (const key of ZONE_FIELDS.chat) expect(chatPresetAxisForField(key)).toBe(THEME_FIELD_DEFS[key].type === 'color' ? 'color' : 'style')
    for (const key of ['chatBgImage', 'chatBlur', 'chatTransparency', 'toolConnectorOpacity', 'assistantDotImage', 'spinnerDoneMarkerMode']) expect(chatPresetAxisForField(key)).toBe('style')
    for (const key of ['chatBg', 'msgTextColor', 'synCoReference']) expect(chatPresetAxisForField(key)).toBe('color')
  })

  it('未知和非chat键拒绝，不静默丢弃', () => {
    for (const key of ['missing', '__proto__', 'accent', 'ccEditMode']) expect(() => chatPresetAxisForField(key)).toThrow()
    expect(() => splitChatPresetValues({ accent: '#fff' })).toThrow(/非消息流/)
  })

  it('19份原料拆合保真且同值身份不折叠，两轴应用顺序完全相同', () => {
    const sources = [
      ...FACTORY_ZONE_PRESET_ENTRIES.filter(entry => entry.zone === 'chat').map(entry => ({ entry, source: 'factory' })),
      ...FACTORY_PROFILE_ZONE_PRESET_ENTRIES.filter(entry => entry.zone === 'chat').map(entry => ({ entry, source: 'profile' })),
    ]
    expect(sources).toHaveLength(19)
    for (const { entry, source } of sources) {
      const split = splitChatPresetValues(entry.values)
      expect({ ...split.style, ...split.color }).toEqual(entry.values)
      expect(Object.keys(split.style).filter(key => Object.hasOwn(split.color, key))).toEqual([])
      const style = planLandingRegion(entry.mode, 'chat', `${source}:${entry.id}:chat:style`, LANDING_PRESET_ENTRIES, 'style')
      const color = planLandingRegion(entry.mode, 'chat', `${source}:${entry.id}:chat:color`, LANDING_PRESET_ENTRIES, 'color')
      expect(style).toEqual(split.style)
      expect(color).toEqual(split.color)
      expect({ ...style, ...color }).toEqual({ ...color, ...style })
      expect({ ...style, ...color }).toEqual(entry.values)
    }
  })
})
