import { describe, expect, it } from 'vitest'
// #520 收口：catalog 的 build/categories/searchItems 步骤已收进文件内，公开面只剩
// `projectRendererSettingsCatalog` 合成入口 —— 用例统一经它取 entries。
import { projectRendererSettingsCatalog } from '../rendererSettingsCatalog.ts'
import type { RendererRegistrySnapshot } from '../../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RenderKindDefinition } from '../../../plugin-runtime/renderers/rendererTypes.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'

const schema = {
  schemaVersion: 1,
  groups: [{ id: 'appearance', label: '外观', fields: [{ key: 'tone', label: '色调', type: 'choice', options: [{ value: 'default', label: '默认' }], default: 'default' }] }],
} as const

function snapshot(kind: RenderKindDefinition): RendererRegistrySnapshot {
  return {
    revision: 1,
    renderKinds: [{ contributionId: kind.id, ownerPluginId: 'plugin.demo', ownerRuntimeInstanceId: 'demo', layer: 'feature', priority: 1, value: kind }],
    messageRenderers: [], contentRenderers: [], toolRenderers: [], codeHighlighters: [], rendererSuites: [], rendererSlots: [],
  }
}

describe('Renderer settings catalog fallback placement', () => {
  it('未知 category 进入插件扩展而不是从导航中消失', () => {
    const kind = {
      id: 'plugin.demo.kind', category: 'content', fallbackKind: 'content.unknown', priority: 1,
      fixture: { text: 'fixture' }, defaultTokens: {}, settingsSchemaVersion: 1, settings: schema,
      settingsPlacement: { categoryId: 'plugin-specific', categoryLabel: 'Plugin Specific', objectOrder: 7, disclosure: 'essential' },
      validateInput: () => true,
    } as unknown as RenderKindDefinition
    const entry = projectRendererSettingsCatalog(snapshot(kind)).entries[0]
    expect(entry.placement.categoryId).toBe('plugin-extension')
    expect(entry.placement.categoryLabel).toBe('插件扩展')
    expect(entry.placement.objectOrder).toBe(7)
  })

  it('shared Tool Kind schema is compatibility-only while Slot remains the editable route', () => {
    const entries = projectRendererSettingsCatalog({
      revision: 1,
      renderKinds: BUILTIN_TOOL_RENDER_KINDS.map(kind => ({ contributionId: kind.id, ownerPluginId: 'core', ownerRuntimeInstanceId: 'core', layer: 'platform' as const, priority: 1, value: kind })),
      messageRenderers: [], contentRenderers: [], toolRenderers: [], codeHighlighters: [], rendererSuites: [], rendererSlots: [],
    }).entries
    const tool = entries.find(entry => entry.id === 'tool.read')!
    expect(tool.compatibilityOnly).toBe(true)
    expect(tool.fieldCount).toBe(0)
    expect(tool.compatibilityFieldCount).toBeGreaterThan(0)
    expect(tool.schema.groups[0].fields[0]).toMatchObject({ deprecated: true, inheritsFrom: expect.stringContaining('slot.') })
  })
})
