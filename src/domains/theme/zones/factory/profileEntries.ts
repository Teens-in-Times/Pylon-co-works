/** 独立档案备料索引；不装入旧出厂池，也不读取档案注册表。 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'
import { FACTORY_PROFILE_CHAT } from './profile-chat.ts'
import { FACTORY_PROFILE_CC } from './profile-cc.ts'

export const FACTORY_PROFILE_ZONE_PRESET_ENTRIES: readonly ZonePresetEntry[] = Object.freeze([
  ...FACTORY_PROFILE_CHAT.filter(entry => entry.mode === 'gui'),
  ...FACTORY_PROFILE_CC.filter(entry => entry.mode === 'gui'),
  ...FACTORY_PROFILE_CHAT.filter(entry => entry.mode === 'terminal'),
  ...FACTORY_PROFILE_CC.filter(entry => entry.mode === 'terminal'),
  ...FACTORY_PROFILE_CHAT.filter(entry => entry.mode === 'tactical'),
  ...FACTORY_PROFILE_CC.filter(entry => entry.mode === 'tactical'),
])
