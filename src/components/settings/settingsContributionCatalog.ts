import { THEME_FIELD_DEFS, THEME_FIELD_OWNERS } from '../../domains/theme/themeFieldDefs.ts'
import { RENDERER_SETTINGS_CATEGORIES } from '../../domains/rendererContent/rendererSettingsPlacement.ts'
import { projectRendererSettingsCatalog, type RendererSettingsCatalogProjection } from './rendererSettingsCatalog.ts'
import { domainOfSection, SECTION_ZONES, SETTINGS_DOMAIN_BY_ID, SETTINGS_SECTION_LABELS, type SettingsSectionId, type SettingsSearchItem } from './settingsDomains.ts'
import type { RendererRegistrySnapshot } from '../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RenderSettingField, RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { normalizeRendererSettingsSchema, settingFieldKey } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import type { RegistryEntry } from '../../plugin-runtime/registry/types.ts'
import type { PluginSettingsPageContribution } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'
import type { ContextPanelContribution } from '../../plugin-runtime/context-panel/contextPanelTypes.ts'

export type SettingsContributionSource =
  | 'theme' | 'renderer-kind' | 'renderer-slot' | 'renderer-suite'
  | 'plugin-page' | 'context-panel' | 'page-owned'

export type SettingsContributionNamespace = 'theme' | 'kind' | 'slot' | 'suite' | 'plugin-page' | 'context-panel' | 'page-owned'

export interface SettingsContributionDiagnostic {
  readonly code: string
  readonly message: string
}

export interface SettingsConsumerTrace {
  readonly ownerDefinition: string
  readonly settingsControl: string
  readonly storeOrPreview: string
  readonly productionConsumer: string
  readonly visibleResult: string
}

export interface SettingsContributionRecord {
  readonly source: SettingsContributionSource
  readonly ownerId: string
  readonly ownerPluginId?: string
  readonly namespace?: SettingsContributionNamespace
  readonly fieldKey?: string
  readonly label?: string
  readonly canonicalRoute: {
    readonly domain: string
    readonly section: string
    readonly category?: string
    readonly object?: string
    readonly group?: string
    readonly field?: string
  }
  readonly placementSource: 'host-policy' | 'owner-hint' | 'fallback'
  readonly semanticKey?: string
  readonly inheritsFrom?: string
  readonly active: boolean
  readonly deprecated?: boolean
  readonly aliases?: readonly string[]
  readonly diagnostics: readonly SettingsContributionDiagnostic[]
  readonly consumerTrace?: SettingsConsumerTrace
}

export interface SettingsContributionCatalog {
  readonly revision: number
  readonly records: readonly SettingsContributionRecord[]
  readonly categories: readonly { readonly id: string; readonly label: string; readonly order: number; readonly entryCount: number }[]
  readonly searchItems: readonly SettingsSearchItem[]
  readonly renderer: RendererSettingsCatalogProjection
  readonly rendererSnapshot?: RendererRegistrySnapshot
}

export interface SettingsContributionCatalogInput {
  readonly rendererSnapshot?: RendererRegistrySnapshot
  readonly activeSuiteId?: string
  readonly pluginPages?: readonly RegistryEntry<PluginSettingsPageContribution>[]
  readonly contextPanels?: readonly RegistryEntry<ContextPanelContribution>[]
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  return Object.freeze(value)
}

function identity(record: Pick<SettingsContributionRecord, 'source' | 'ownerPluginId' | 'ownerId' | 'namespace' | 'fieldKey'>): string {
  return [record.source, record.ownerPluginId ?? '', record.ownerId, record.namespace ?? '', record.fieldKey ?? ''].join('|')
}

function sectionForThemeZone(zone: string): SettingsSectionId | undefined {
  return (Object.entries(SECTION_ZONES).find(([, value]) => value === zone)?.[0] as SettingsSectionId | undefined)
}

function themeRecords(): SettingsContributionRecord[] {
  const records: SettingsContributionRecord[] = []
  for (const [fieldKey, definition] of Object.entries(THEME_FIELD_DEFS)) {
    if (definition.hidden || definition.meta || THEME_FIELD_OWNERS[fieldKey as keyof typeof THEME_FIELD_OWNERS].owner !== 'theme') continue
    const section = sectionForThemeZone(definition.zone)
    if (!section) continue
    records.push({
      source: 'theme', ownerId: fieldKey, namespace: 'theme', fieldKey,
      label: definition.label,
      canonicalRoute: {
        domain: domainOfSection(section), section,
        group: definition.group, field: fieldKey,
      },
      placementSource: 'host-policy', active: true,
      consumerTrace: {
        ownerDefinition: `themeFieldDefs:${fieldKey}`, settingsControl: 'themeFieldRenderer',
        storeOrPreview: 'ThemeStore.setZoneField', productionConsumer: 'themeCssSnapshot', visibleResult: 'Workbench CSS/theme value',
      },
      diagnostics: [],
    })
  }
  return records
}

function rendererRecords(snapshot: RendererRegistrySnapshot | undefined, activeSuiteId?: string): SettingsContributionRecord[] {
  if (!snapshot) return []
  const records: SettingsContributionRecord[] = []
  const projection = projectRendererSettingsCatalog(snapshot, activeSuiteId)
  for (const entry of projection.entries) {
    const source = entry.namespace === 'suite' ? 'renderer-suite' as const : entry.namespace === 'slot' ? 'renderer-slot' as const : 'renderer-kind' as const
    const category = entry.placement.categoryId
    const placementSource = category === 'plugin-extension' && !entry.active ? 'fallback' : 'host-policy'
    for (const group of entry.schema.groups) for (const field of group.fields) {
      const key = settingFieldKey(field)
      if (!key) continue
      records.push({
        source,
        ownerId: entry.id,
        ownerPluginId: entry.ownerPluginId,
        namespace: entry.namespace,
        fieldKey: key,
        label: field.label ?? key,
        canonicalRoute: {
          domain: 'appearance', section: 'renderers', category,
          object: entry.id, group: group.id, field: key,
        },
        placementSource: entry.placement.categoryId === 'plugin-extension' ? 'fallback' : placementSource,
        semanticKey: (field as RenderSettingField & { semanticKey?: string }).semanticKey,
        inheritsFrom: (field as RenderSettingField & { inheritsFrom?: string }).inheritsFrom,
        active: entry.active,
        deprecated: (field as RenderSettingField & { deprecated?: boolean }).deprecated,
        aliases: (field as RenderSettingField & { aliases?: readonly string[] }).aliases,
        diagnostics: entry.placement.categoryId === 'plugin-extension' ? [{ code: 'placement-fallback', message: '未知 Renderer category，已归入插件扩展' }] : [],
        consumerTrace: {
          ownerDefinition: `${entry.namespace}:${entry.id}.${key}`, settingsControl: 'RendererSettingField',
          storeOrPreview: 'RendererSettingsStore', productionConsumer: 'productionRenderAppearance', visibleResult: 'resolved renderer appearance',
        },
      })
    }
  }
  return records
}

function pluginRecords(input: SettingsContributionCatalogInput): SettingsContributionRecord[] {
  const records: SettingsContributionRecord[] = []
  for (const entry of input.pluginPages ?? []) {
    const page = entry.value
    let schema: RendererSettingsSchema | undefined
    let schemaError: unknown
    if (page.schema) {
      try { schema = normalizeRendererSettingsSchema(page.schema) } catch (error) { schemaError = error }
    }
    const hasSchema = Boolean(schema)
    const hasAdapter = Boolean(page.valueAdapter)
    const base = {
      source: 'plugin-page' as const, ownerId: entry.contributionId, ownerPluginId: entry.ownerPluginId,
      label: page.label,
      namespace: 'plugin-page' as const, canonicalRoute: { domain: 'plugins', section: 'pluginManager', object: entry.contributionId },
      placementSource: 'host-policy' as const, active: true,
      diagnostics: schemaError ? [{ code: 'schema-invalid', message: schemaError instanceof Error ? schemaError.message : 'schema 非法，保留 opaque page' }] : (!hasSchema || hasAdapter ? [] : [{ code: 'value-adapter-missing', message: 'schema contribution 无 value adapter，保留 opaque page' }]),
      consumerTrace: {
        ownerDefinition: `plugin-page:${entry.contributionId}`, settingsControl: hasSchema && hasAdapter ? 'RendererSettingField' : 'PluginSettingsPageHost',
        storeOrPreview: hasAdapter ? 'SettingsValueAdapter' : 'opaque surface', productionConsumer: 'plugin contribution owner', visibleResult: 'plugin settings surface',
      },
    }
    if (!hasSchema || !hasAdapter) { records.push(base); continue }
    for (const group of schema!.groups) for (const field of group.fields) {
      const key = settingFieldKey(field)
      records.push({ ...base, fieldKey: key, canonicalRoute: { ...base.canonicalRoute, group: group.id, field: key } })
    }
    for (const [key, unavailable] of Object.entries(page.valueAdapter!.getSnapshot().unavailable)) {
      const existingIndex = records.findIndex(record => record.ownerId === entry.contributionId && record.fieldKey === key)
      const diagnostic = { code: unavailable.code || 'unavailable', message: unavailable.message || '字段当前不可用，已保留原值' }
      if (existingIndex >= 0) {
        const existing = records[existingIndex]!
        records[existingIndex] = { ...existing, active: false, diagnostics: [...existing.diagnostics, diagnostic] }
      } else records.push({ ...base, fieldKey: key, active: false, canonicalRoute: { ...base.canonicalRoute, field: key }, diagnostics: [diagnostic] })
    }
  }
  for (const entry of input.contextPanels ?? []) {
    const panel = entry.value
    const section = panel.settings?.section === 'pluginManager' ? 'pluginManager' : 'right'
    let schema: RendererSettingsSchema | undefined
    let schemaError: unknown
    if (panel.schema) {
      try { schema = normalizeRendererSettingsSchema(panel.schema) } catch (error) { schemaError = error }
    }
    const hasSchema = Boolean(schema)
    const hasAdapter = Boolean(panel.valueAdapter)
    const base = {
      source: 'context-panel' as const, ownerId: entry.contributionId, ownerPluginId: entry.ownerPluginId,
      label: panel.settings?.label ?? panel.label,
      namespace: 'context-panel' as const, canonicalRoute: { domain: section === 'right' ? 'appearance' : 'plugins', section, object: entry.contributionId },
      placementSource: 'host-policy' as const, active: true,
      diagnostics: schemaError ? [{ code: 'schema-invalid', message: schemaError instanceof Error ? schemaError.message : 'schema 非法，保留 opaque page' }] : (!hasSchema || hasAdapter ? [] : [{ code: 'value-adapter-missing', message: 'schema contribution 无 value adapter，保留 opaque page' }]),
      consumerTrace: {
        ownerDefinition: `context-panel:${entry.contributionId}`, settingsControl: hasSchema && hasAdapter ? 'RendererSettingField' : 'ContextPanelHost',
        storeOrPreview: hasAdapter ? 'SettingsValueAdapter' : 'opaque surface', productionConsumer: 'context panel owner', visibleResult: 'context panel settings surface',
      },
    }
    if (!hasSchema || !hasAdapter) { records.push(base); continue }
    for (const group of schema!.groups) for (const field of group.fields) {
      const key = settingFieldKey(field)
      records.push({ ...base, fieldKey: key, canonicalRoute: { ...base.canonicalRoute, group: group.id, field: key } })
    }
    for (const [key, unavailable] of Object.entries(panel.valueAdapter!.getSnapshot().unavailable)) {
      const existingIndex = records.findIndex(record => record.ownerId === entry.contributionId && record.fieldKey === key)
      const diagnostic = { code: unavailable.code || 'unavailable', message: unavailable.message || '字段当前不可用，已保留原值' }
      if (existingIndex >= 0) {
        const existing = records[existingIndex]!
        records[existingIndex] = { ...existing, active: false, diagnostics: [...existing.diagnostics, diagnostic] }
      } else records.push({ ...base, fieldKey: key, active: false, canonicalRoute: { ...base.canonicalRoute, field: key }, diagnostics: [diagnostic] })
    }
  }
  return records
}

function withDiagnostics(records: SettingsContributionRecord[]): SettingsContributionRecord[] {
  const byIdentity = new Map<string, SettingsContributionRecord[]>()
  const byRoute = new Map<string, SettingsContributionRecord[]>()
  const bySemantic = new Map<string, SettingsContributionRecord[]>()
  for (const record of records) {
    const id = identity(record)
    const route = JSON.stringify(record.canonicalRoute)
    byIdentity.set(id, [...(byIdentity.get(id) ?? []), record])
    byRoute.set(route, [...(byRoute.get(route) ?? []), record])
    if (record.semanticKey) bySemantic.set(record.semanticKey, [...(bySemantic.get(record.semanticKey) ?? []), record])
  }
  return records.map(record => {
    const diagnostics = [...record.diagnostics]
    const identityPeers = byIdentity.get(identity(record)) ?? []
    const identityIndex = identityPeers.indexOf(record)
    const duplicate = identityPeers.length > 1
    if (duplicate) diagnostics.push({ code: 'duplicate-identity', message: '同一 owner/field identity 重复' })
    const routePeers = byRoute.get(JSON.stringify(record.canonicalRoute)) ?? []
    const routeCollision = routePeers.some(peer => identity(peer) !== identity(record))
    const routeIndex = routePeers.indexOf(record)
    if (routeCollision) diagnostics.push({ code: 'route-collision', message: '跨 owner canonical route 冲突' })
    const semanticPeers = record.semanticKey ? (bySemantic.get(record.semanticKey) ?? []) : []
    if (semanticPeers.length > 1 && semanticPeers.some(peer => identity(peer) !== identity(record))) {
      diagnostics.push({ code: 'semantic-key-collision', message: `semanticKey ${record.semanticKey} 跨 owner 重叠；保留各自作用域` })
    }
    const blocked = (duplicate && identityIndex > 0) || (routeCollision && routeIndex > 0)
    return {
      ...record,
      active: blocked ? false : record.active,
      ...(routeCollision && routeIndex > 0 ? { canonicalRoute: { ...record.canonicalRoute, category: 'plugin-extension' } } : {}),
      diagnostics: Object.freeze(diagnostics),
    }
  })
}

export function projectSettingsContributionCatalog(input: SettingsContributionCatalogInput = {}): SettingsContributionCatalog {
  const records = withDiagnostics([...themeRecords(), ...rendererRecords(input.rendererSnapshot, input.activeSuiteId), ...pluginRecords(input)])
  const frozen = freezeDeep(records.slice().sort((a, b) => JSON.stringify(a.canonicalRoute).localeCompare(JSON.stringify(b.canonicalRoute)))) as readonly SettingsContributionRecord[]
  const renderer = input.rendererSnapshot
    ? projectRendererSettingsCatalog(input.rendererSnapshot, input.activeSuiteId)
    : Object.freeze({ entries: Object.freeze([]), categories: Object.freeze([]), searchItems: Object.freeze([]) }) as RendererSettingsCatalogProjection
  const categories = renderer.categories.length > 0
    ? renderer.categories
    : Object.freeze(RENDERER_SETTINGS_CATEGORIES.map(category => ({
      ...category,
      entryCount: frozen.filter(record => record.canonicalRoute.category === category.id && record.active && !record.deprecated).length,
    })).filter(category => category.entryCount > 0 || category.id === 'advanced-catalog'))
  const adapterRevisions = [...(input.pluginPages ?? []), ...(input.contextPanels ?? [])]
    .map(entry => entry.value.valueAdapter?.getSnapshot().revision ?? 0)
  const revision = [input.rendererSnapshot?.revision ?? 0, ...(adapterRevisions.length > 0 ? adapterRevisions : [0])]
    .reduce((hash, value) => ((hash * 31) ^ value) >>> 0, 17)
  const base = { revision, records: frozen, categories, searchItems: [] as readonly SettingsSearchItem[], renderer, rendererSnapshot: input.rendererSnapshot }
  return Object.freeze({ ...base, searchItems: freezeDeep(buildSettingsContributionSearchItems(base)) })
}

// #520 收口：canonicalEditableRecords 已删（含测试在内全仓零生产消费者）；
// searchItems 构建步骤仅由 projectSettingsContributionCatalog 文件内消费，导出面收窄。
/** Convert the canonical records into the SettingsQuickSearch contract. */
function buildSettingsContributionSearchItems(
  catalog: SettingsContributionCatalog,
): readonly SettingsSearchItem[] {
  return Object.freeze(catalog.records.filter(record => !(record.namespace === 'kind' && record.ownerId.startsWith('tool.') && record.deprecated)).map(record => {
    const route = record.canonicalRoute
    const domain = SETTINGS_DOMAIN_BY_ID[route.domain as keyof typeof SETTINGS_DOMAIN_BY_ID]
    const section = route.section as SettingsSectionId
    const path = `${domain?.label ?? route.domain} › ${SETTINGS_SECTION_LABELS[section] ?? route.section}`
    const item: SettingsSearchItem = {
      path: `${path}${route.category ? ` › ${route.category}` : ''}${route.object ? ` › ${route.object}` : ''}${route.group ? ` › ${route.group}` : ''}`,
      label: record.label ?? record.fieldKey ?? record.ownerId,
      section,
      advanced: Boolean(record.deprecated || record.diagnostics.length > 0),
      kind: record.source === 'plugin-page' ? 'plugin-page' : record.source === 'context-panel' ? 'context-panel' : record.source === 'theme' ? 'chain-a' : 'renderer-entry',
      ...(record.namespace === 'theme' && record.fieldKey ? { anchor: `field:${record.fieldKey}` } : {}),
      ...((record.source === 'plugin-page' || record.source === 'context-panel') && record.fieldKey ? { anchor: `schema:${record.ownerId}:${record.fieldKey}` } : {}),
      ...(record.namespace && ['kind', 'slot', 'suite'].includes(record.namespace) && record.fieldKey ? {
        rendererRoute: {
          categoryId: route.category ?? 'plugin-extension',
          objectKey: `${record.namespace}.${record.ownerId}`,
          groupId: route.group ?? '',
          fieldKey: record.fieldKey,
        },
        anchor: `renderer:${record.namespace}.${record.ownerId}:${route.group ?? ''}:${record.fieldKey}`,
      } : {}),
      ...(record.source === 'plugin-page' ? { pluginPageId: record.ownerId } : {}),
      ...(record.source === 'context-panel' ? { contextPanelId: record.ownerId } : {}),
    }
    return item
  }))
}

export { identity as settingsContributionIdentity }
