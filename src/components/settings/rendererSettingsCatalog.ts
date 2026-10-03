import { RENDERER_SETTINGS_CATEGORIES, resolveRendererSettingsPlacement } from '../../domains/rendererContent/rendererSettingsPlacement.ts'
import type { RendererRegistrySnapshot } from '../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RendererSettingsPlacement, RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { RENDERER_KIND_LABELS } from './settingsDomains.ts'
import type { SettingsSearchItem } from './settingsDomains.ts'
import { BUILTIN_TOOL_RENDER_KIND_IDS } from '../../domains/rendererContent/toolRenderKindCatalog.ts'

export type RendererSettingsNamespace = 'kind' | 'suite' | 'slot'

export interface RendererSettingsCatalogEntry {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly ownerPluginId: string
  readonly namespace: RendererSettingsNamespace
  readonly schema: RendererSettingsSchema
  readonly placement: RendererSettingsPlacement
  readonly active: boolean
  readonly fieldCount: number
  /** Legacy Kind schemas retained for migration/diagnostics, never editable in the normal form. */
  readonly compatibilityOnly?: boolean
  readonly compatibilityFieldCount?: number
}

export interface RendererSettingsCatalogCategory {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly order: number
  readonly entryCount: number
}

/**
 * Read-only projection consumed by Settings navigation, search and Inspector.
 * It owns no values and deliberately keeps registry plumbing out of UI
 * components; the registry snapshot remains the only source of truth.
 */
export interface RendererSettingsCatalogProjection {
  readonly entries: readonly RendererSettingsCatalogEntry[]
  readonly categories: readonly RendererSettingsCatalogCategory[]
  readonly searchItems: readonly SettingsSearchItem[]
}

function fieldCount(schema: RendererSettingsSchema): number {
  return schema.groups.reduce((count, group) => count + group.fields.length, 0)
}

function visibleFieldCount(schema: RendererSettingsSchema, compatibilityOnly: boolean): number {
  return compatibilityOnly ? 0 : fieldCount(schema)
}

function technicalPlacement(objectOrder: number): RendererSettingsPlacement {
  const category = RENDERER_SETTINGS_CATEGORIES.find(item => item.id === 'advanced-catalog')!
  return {
    categoryId: category.id,
    categoryLabel: category.label,
    categoryOrder: category.order,
    objectOrder,
    disclosure: 'technical',
  }
}

function foundationPlacement(objectOrder: number): RendererSettingsPlacement {
  const category = RENDERER_SETTINGS_CATEGORIES.find(item => item.id === 'foundation')!
  return {
    categoryId: category.id,
    categoryLabel: category.label,
    categoryOrder: category.order,
    objectOrder,
    disclosure: 'essential',
  }
}

function catalogPlacement(
  placement: RendererSettingsPlacement,
  fallbackDisclosure: RendererSettingsPlacement['disclosure'] = 'detail',
): RendererSettingsPlacement {
  const category = RENDERER_SETTINGS_CATEGORIES.find(item => item.id === placement.categoryId)
  if (category) return placement
  const extension = RENDERER_SETTINGS_CATEGORIES.find(item => item.id === 'plugin-extension')!
  return Object.freeze({
    ...placement,
    categoryId: extension.id,
    categoryLabel: extension.label,
    categoryOrder: extension.order,
    disclosure: placement.disclosure ?? fallbackDisclosure,
  })
}

// 以下 build / categories / searchItems 三步仅由 `projectRendererSettingsCatalog` 在文件内
// 合成消费，无外部导入者（#520 收口：导出面收窄到合成入口与在役类型）。
function buildRendererSettingsCatalog(
  snapshot: RendererRegistrySnapshot,
  activeSuiteId?: string,
): readonly RendererSettingsCatalogEntry[] {
  const activeSuite = snapshot.rendererSuites.find(entry => entry.value.id === activeSuiteId)?.value
  const supportedKinds = activeSuite
    ? new Set([...activeSuite.requiredKinds, ...(activeSuite.optionalKinds ?? [])])
    : undefined
  const suiteEntries = snapshot.rendererSuites.flatMap((entry, index) => entry.value.settings ? [{
    id: entry.value.id,
    label: entry.value.label,
    description: entry.value.description,
    ownerPluginId: entry.ownerPluginId,
    namespace: 'suite' as const,
    schema: entry.value.settings,
    placement: catalogPlacement(entry.value.settingsPlacement ?? (entry.value.id === activeSuiteId ? foundationPlacement(index) : technicalPlacement(index))),
    active: entry.value.id === activeSuiteId,
    fieldCount: fieldCount(entry.value.settings),
  }] : [])
  const slotEntries = snapshot.rendererSlots.flatMap((entry, index) => entry.value.settings ? [{
    id: entry.value.id,
    label: entry.value.label ?? entry.value.id,
    description: entry.value.description,
    ownerPluginId: entry.ownerPluginId,
    namespace: 'slot' as const,
    schema: entry.value.settings,
    placement: catalogPlacement(entry.value.settingsPlacement ?? technicalPlacement(100 + index)),
    active: Boolean(activeSuiteId && (entry.value.targetSuites.includes('*') || entry.value.targetSuites.includes(activeSuiteId))),
    fieldCount: fieldCount(entry.value.settings),
  }] : [])
  const kindEntries = snapshot.renderKinds.flatMap(entry => entry.value.settings ? [{
    id: entry.value.id,
    label: RENDERER_KIND_LABELS[entry.value.id] ?? entry.value.id,
    ownerPluginId: entry.ownerPluginId,
    namespace: 'kind' as const,
    schema: entry.value.settings,
    placement: catalogPlacement(resolveRendererSettingsPlacement(entry.value.id, entry.value.settingsPlacement)),
    // Built-in tool kinds intentionally share one Slot-owned appearance
    // schema. Keep every original Kind addressable in Advanced Catalog, while
    // the normal Tool Activity category presents the shared Slot once.
    active: (supportedKinds ? supportedKinds.has(entry.value.id) : true)
      && !BUILTIN_TOOL_RENDER_KIND_IDS.has(entry.value.id),
    compatibilityOnly: BUILTIN_TOOL_RENDER_KIND_IDS.has(entry.value.id),
    fieldCount: visibleFieldCount(entry.value.settings, BUILTIN_TOOL_RENDER_KIND_IDS.has(entry.value.id)),
    compatibilityFieldCount: BUILTIN_TOOL_RENDER_KIND_IDS.has(entry.value.id) ? fieldCount(entry.value.settings) : undefined,
  }] : [])

  return Object.freeze([...suiteEntries, ...slotEntries, ...kindEntries].sort((a, b) =>
    (a.placement.categoryOrder ?? 100) - (b.placement.categoryOrder ?? 100)
    || (a.placement.objectOrder ?? 100) - (b.placement.objectOrder ?? 100)
    || a.label.localeCompare(b.label, 'zh-CN'),
  ))
}

function rendererSettingsCatalogCategories(
  entries: readonly RendererSettingsCatalogEntry[],
): readonly RendererSettingsCatalogCategory[] {
  return RENDERER_SETTINGS_CATEGORIES.flatMap(category => {
    const entryCount = entries.filter(entry => entry.placement.categoryId === category.id && (entry.active || category.id === 'advanced-catalog')).length
    return entryCount > 0 || category.id === 'advanced-catalog'
      ? [{ ...category, entryCount }]
      : []
  })
}

export function rendererSettingsEntryKey(entry: Pick<RendererSettingsCatalogEntry, 'namespace' | 'id'>): string {
  return `${entry.namespace}.${entry.id}`
}

/**
 * Search projection for the quick-search command surface. It is deliberately
 * built from the catalog rather than mounted UI fields, so unselected
 * renderer objects remain searchable without paying their render cost.
 */
function buildRendererSettingsSearchItems(
  entries: readonly RendererSettingsCatalogEntry[],
): readonly SettingsSearchItem[] {
  return Object.freeze(entries.flatMap(entry => {
    const objectKey = rendererSettingsEntryKey(entry)
    return entry.schema.groups.flatMap(group => group.fields.map(field => {
      const fieldKey = field.key ?? field.id ?? ''
      const label = field.label ?? fieldKey
      return {
        path: `外观 › 渲染器 › ${entry.placement.categoryLabel} › ${entry.label} › ${group.label}`,
        label,
        section: 'renderers' as const,
        advanced: field.advanced === true || entry.placement.disclosure === 'technical',
        kind: 'renderer-entry' as const,
        anchor: `renderer:${objectKey}:${group.id}:${fieldKey}`,
        rendererRoute: {
          categoryId: entry.placement.categoryId,
          objectKey,
          groupId: group.id,
          fieldKey,
        },
      }
    }))
  }))
}

export function projectRendererSettingsCatalog(
  snapshot: RendererRegistrySnapshot,
  activeSuiteId?: string,
): RendererSettingsCatalogProjection {
  const entries = buildRendererSettingsCatalog(snapshot, activeSuiteId)
  return Object.freeze({
    entries,
    categories: rendererSettingsCatalogCategories(entries),
    searchItems: buildRendererSettingsSearchItems(entries),
  })
}
