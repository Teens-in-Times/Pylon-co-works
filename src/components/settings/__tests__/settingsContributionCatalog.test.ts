import { describe, expect, it } from 'vitest'
// #520 收口：canonicalEditableRecords 已删；buildSettingsContributionSearchItems 收进文件内，
// 用例改经在役合成入口的 searchItems 输出断言同一行为。
import { projectSettingsContributionCatalog, settingsContributionIdentity } from '../settingsContributionCatalog.ts'
import type { RendererRegistrySnapshot } from '../../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import type { PluginSettingsPageContribution } from '../../../plugin-runtime/settings/pluginSettingsTypes.ts'

const entry = <T,>(value: T, contributionId = 'fixture', ownerPluginId = 'fixture.plugin'): RegistryEntry<T> => ({
  value, contributionId, ownerPluginId, ownerRuntimeInstanceId: `${ownerPluginId}@test`, layer: 'feature', priority: 0,
})

const rendererSnapshot = (overrides: Partial<RendererRegistrySnapshot> = {}): RendererRegistrySnapshot => ({
  revision: 1, renderKinds: [], messageRenderers: [], contentRenderers: [], toolRenderers: [], codeHighlighters: [], rendererSuites: [], rendererSlots: [], ...overrides,
})

describe('SettingsContributionCatalog', () => {
  it('projects theme and renderer fields to canonical immutable routes', () => {
    const snapshot = rendererSnapshot({ renderKinds: [entry({ id: 'content.fixture', category: 'content', priority: 1, fallbackKind: 'content.unknown', settingsSchemaVersion: 1, validateInput: () => true, settings: { schemaVersion: 1, groups: [{ id: 'layout', label: 'Layout', fields: [{ key: 'maxWidth', type: 'number', default: 10 }] }] }, settingsPlacement: { categoryId: 'markdown-text', categoryLabel: 'Markdown', objectOrder: 1 } }) as never] })
    const catalog = projectSettingsContributionCatalog({ rendererSnapshot: snapshot })
    expect(catalog.records.some(record => record.namespace === 'theme' && record.fieldKey === 'accent')).toBe(true)
    expect(catalog.records.some(record => record.namespace === 'kind' && record.fieldKey === 'maxWidth' && record.canonicalRoute.section === 'renderers')).toBe(true)
    expect(Object.isFrozen(catalog.records)).toBe(true)
  })

  it('falls back unknown placement and reports a diagnostic', () => {
    const snapshot = rendererSnapshot({ renderKinds: [entry({ id: 'content.fixture', category: 'content', priority: 1, fallbackKind: 'content.unknown', settingsSchemaVersion: 1, validateInput: () => true, settings: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'x', type: 'boolean' }] }] }, settingsPlacement: { categoryId: 'unknown-owner-category', categoryLabel: 'Unknown' } }) as never] })
    const record = projectSettingsContributionCatalog({ rendererSnapshot: snapshot }).records.find(item => item.fieldKey === 'x')!
    expect(record.canonicalRoute.category).toBe('plugin-extension')
    expect(record.placementSource).toBe('fallback')
    expect(record.diagnostics.some(diagnostic => diagnostic.code === 'placement-fallback')).toBe(true)
  })

  it('uses host policy for known owner placement hints', () => {
    const snapshot = rendererSnapshot({ renderKinds: [entry({ id: 'content.fixture', category: 'content', priority: 1, fallbackKind: 'content.unknown', settingsSchemaVersion: 1, validateInput: () => true, settings: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'x', type: 'boolean' }] }] }, settingsPlacement: { categoryId: 'markdown-text', categoryLabel: 'owner supplied label' } }) as never] })
    expect(projectSettingsContributionCatalog({ rendererSnapshot: snapshot }).records.find(record => record.fieldKey === 'x')?.placementSource).toBe('host-policy')
  })

  it('keeps plugin schema opaque without an adapter and projects fields with one', () => {
    const opaque: PluginSettingsPageContribution = { id: 'opaque', label: 'Opaque', renderKind: 'isolated-surface', surfaceId: 'opaque' }
    const adapted: PluginSettingsPageContribution = { id: 'adapted', label: 'Adapted', renderKind: 'isolated-surface', surfaceId: 'adapted', schema: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'enabled', type: 'boolean' }] }] }, valueAdapter: { namespace: 'plugin-page', getSnapshot: () => ({ values: {}, unavailable: {}, revision: 0 }), setValue: () => {}, removeValue: () => {}, reset: () => {}, subscribe: () => () => {} } }
    const records = projectSettingsContributionCatalog({ pluginPages: [entry(opaque, 'opaque'), entry(adapted, 'adapted')] }).records
    expect(records.find(record => record.ownerId === 'opaque')?.fieldKey).toBeUndefined()
    expect(records.some(record => record.ownerId === 'adapted' && record.fieldKey === 'enabled')).toBe(true)
  })

  it('fails closed for malformed plugin schema instead of crashing projection', () => {
    const malformed = { id: 'bad', label: 'Bad', renderKind: 'isolated-surface' as const, surfaceId: 'bad', schema: { schemaVersion: 1, groups: [{ id: '', label: '', fields: [] }] } }
    const record = projectSettingsContributionCatalog({ pluginPages: [entry(malformed, 'bad')] }).records.find(item => item.ownerId === 'bad')
    expect(record?.fieldKey).toBeUndefined()
    expect(record?.diagnostics.some(diagnostic => diagnostic.code === 'schema-invalid')).toBe(true)
  })

  it('keeps adapter unavailable values as visible records', () => {
    const page: PluginSettingsPageContribution = { id: 'adapted', label: 'Adapted', renderKind: 'isolated-surface', surfaceId: 'adapted', schema: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [] }] }, valueAdapter: { namespace: 'plugin-page', getSnapshot: () => ({ values: {}, unavailable: { retired: { value: 'old', code: 'option-removed', message: '候选已卸载' } }, revision: 2 }), setValue: () => {}, removeValue: () => {}, reset: () => {}, subscribe: () => () => {} } }
    const record = projectSettingsContributionCatalog({ pluginPages: [entry(page, 'adapted')] }).records.find(item => item.fieldKey === 'retired')
    expect(record).toMatchObject({ active: false, diagnostics: [{ code: 'option-removed' }] })
  })

  it('distinguishes duplicate identity from route collision', () => {
    const pages = [entry({ id: 'a', label: 'A', renderKind: 'isolated-surface' as const, surfaceId: 'a' }, 'same'), entry({ id: 'a', label: 'A', renderKind: 'isolated-surface' as const, surfaceId: 'a' }, 'same')]
    const records = projectSettingsContributionCatalog({ pluginPages: pages }).records
    const duplicates = records.filter(record => record.ownerId === 'same')
    expect(duplicates.every(record => record.diagnostics.some(diagnostic => diagnostic.code === 'duplicate-identity'))).toBe(true)
    expect(settingsContributionIdentity(duplicates[0])).toContain('plugin-page')
  })

  it('blocks the deterministic loser of a cross-owner route collision', () => {
    const schema = { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'x', type: 'boolean' }] }] }
    const snapshot = rendererSnapshot({
      rendererSuites: [entry({ id: 'same', label: 'Suite', requiredKinds: [], apiVersion: 1, runtime: { framework: 'solid', version: '1' }, factory: {} as never, settings: schema, settingsPlacement: { categoryId: 'markdown-text', categoryLabel: 'Markdown' } } as never, 'same-suite')],
      rendererSlots: [entry({ id: 'same', label: 'Slot', targetSuites: ['*'], kinds: [], priority: 1, fallback: true, canRender: () => true, createSurface: () => ({}), settings: schema, settingsPlacement: { categoryId: 'markdown-text', categoryLabel: 'Markdown' } } as never, 'same-slot')],
    })
    const records = projectSettingsContributionCatalog({ rendererSnapshot: snapshot, activeSuiteId: 'same' }).records.filter(record => record.fieldKey === 'x')
    expect(records).toHaveLength(2)
    expect(records.filter(record => record.active)).toHaveLength(1)
    expect(records.some(record => record.diagnostics.some(diagnostic => diagnostic.code === 'route-collision'))).toBe(true)
  })

  it('keeps migrated layout and assistant avatar fields to one canonical editable route', () => {
    const catalog = projectSettingsContributionCatalog()
    // #483：showPet 随宠物链删除退役，catalog 不得再出现该字段（防死而复生）。
    expect(catalog.records.filter(record => record.fieldKey === 'showPet')).toHaveLength(0)
    expect(catalog.records.filter(record => record.fieldKey === 'assistantDotImage')).toHaveLength(1)
    expect(catalog.records.find(record => record.fieldKey === 'assistantDotImage')?.canonicalRoute.section).toBe('chat')
  })

  it('does not index deprecated shared Tool Kind fields as duplicate search entries', () => {
    const snapshot = rendererSnapshot({ renderKinds: [{
      ...entry({ id: 'tool.read', category: 'tool', priority: 1, fallbackKind: 'content.unknown', settingsSchemaVersion: 1, validateInput: () => true, settings: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'density', type: 'boolean', deprecated: true }] }] } } as never),
    }] })
    const catalog = projectSettingsContributionCatalog({ rendererSnapshot: snapshot })
    expect(catalog.searchItems.some(item => item.label === 'density' && item.kind === 'renderer-entry')).toBe(false)
  })

  it('emits consumer traces for canonical records', () => {
    const catalog = projectSettingsContributionCatalog()
    const accent = catalog.records.find(record => record.fieldKey === 'accent')!
    expect(accent.consumerTrace).toMatchObject({ settingsControl: 'themeFieldRenderer', productionConsumer: 'themeCssSnapshot' })
  })

  it('publishes one renderer projection for navigation, panel and preview consumers', () => {
    const snapshot = rendererSnapshot({
      rendererSuites: [entry({ id: 'suite.one', label: 'Suite', requiredKinds: [], apiVersion: 1, runtime: { framework: 'solid', version: '1' }, factory: {} as never, settings: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'x', type: 'boolean' }] }] } } as never)],
    })
    const catalog = projectSettingsContributionCatalog({ rendererSnapshot: snapshot, activeSuiteId: 'suite.one' })
    expect(catalog.rendererSnapshot).toBe(snapshot)
    expect(catalog.renderer.entries[0]?.id).toBe('suite.one')
    expect(catalog.renderer.entries[0]?.active).toBe(true)
    expect(catalog.renderer.searchItems[0]?.rendererRoute?.objectKey).toBe('suite.suite.one')
    expect(catalog.categories).toEqual(catalog.renderer.categories)
    expect(Object.isFrozen(catalog.searchItems[0])).toBe(true)
  })
})
