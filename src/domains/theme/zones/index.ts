/** 区域层门面：对外统一导出。 */

export { pickZoneFields } from './pickZoneFields.ts'
export { effectivePresetTheme, type ZoneRefBackedPreset } from './effectivePresetTheme.ts'
export { FACTORY_ZONE_PRESET_ENTRIES } from './factory/index.ts'
export { FACTORY_PROFILE_ZONE_PRESET_ENTRIES } from './factory/profileEntries.ts'
export {
  ZONE_PRESET_POOL,
  assembleFactoryZonePresetPool,
  chatPresetsForAxis,
  cleanupZonePresetEntries,
  createZonePresetEntryId,
  isCustomZonePresetEntry,
  normalizeZonePresetEntries,
  normalizeZonePresetValues,
  removeZonePresetEntryReducer,
  resolveZonePresetEntryTheme,
  zonePresetsFor,
} from './zonePresetPool.ts'
export type { ChatPresetAxis, ZonePresetSource, ZonePresetEntry, ZonePresetOrigin, ZonePresetPool, ZonePresetRemovalPatch, ZonePresetRemovalState } from './zonePresetPool.ts'
