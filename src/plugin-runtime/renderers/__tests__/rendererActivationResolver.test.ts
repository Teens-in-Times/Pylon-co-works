import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { RendererRegistry } from '../rendererRegistry.ts'
import { resolveRendererActivation, resolveRendererNodeSlot } from '../rendererActivationResolver.ts'
import type { RendererSlotContribution, RendererSuiteContribution } from '../rendererSuiteTypes.ts'
import type { RenderSurface } from '../../../contracts/messageRenderer.ts'

const surface = (id: string): RenderSurface => ({ rendererId: id, kind: 'solid', mount: () => ({}), update: () => {}, destroy: () => {}, on: () => () => {} })
const k = (id: string, fallbackKind = 'content.unknown') => ({ id, category: 'content', fallbackKind, priority: 1, fixture: {}, defaultTokens: {}, settingsSchemaVersion: 1, validateInput: () => true })
const s = (id: string, fallbackSuiteId?: string): RendererSuiteContribution => ({ id, label: id, apiVersion: 1, runtime: { framework: 'solid', version: '1' }, compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 }, requiredKinds: ['plugin.note'], fallbackSuiteId, factory: { prepare: async () => { throw new Error('not mounted in test') } } })
const slot = (id: string, targetSuites: readonly (string | '*')[], kinds: readonly string[], fallback = false): RendererSlotContribution => ({ id, targetSuites, kinds, priority: fallback ? 100 : 1, fallback, canRender: () => true, createSurface: () => surface(id) })

describe('RendererActivationResolver', () => {
  it('chooses one suite and never mixes slots across suites', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.activation', 'one')
    registry.registerRenderKind(owner, k('plugin.note'))
    registry.registerSuite(owner, s('suite.base'))
    registry.registerSuite(owner, s('suite.alt'))
    registry.registerSlot(owner, slot('slot.base', ['suite.base'], ['plugin.note']))
    registry.registerSlot(owner, slot('slot.alt', ['suite.alt'], ['plugin.note']))
    const activation = resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'suite.alt' })
    expect(activation.suite.value.id).toBe('suite.alt')
    expect(activation.slots.get('plugin.note')?.[0].value.id).toBe('slot.alt')
  })

  it('uses targeted fallback then kind fallback and finally content.unknown', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.activation', 'fallback')
    registry.registerRenderKind(owner, k('plugin.note'))
    registry.registerSuite(owner, s('suite.base'))
    registry.registerSlot(owner, slot('slot.fallback', ['suite.base'], ['plugin.note', 'content.unknown'], true))
    const activation = resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'suite.base' })
    expect(activation.slots.get('plugin.note')?.[0].value.id).toBe('slot.fallback')
    expect(resolveRendererNodeSlot(activation, { kind: 'missing.kind' })?.value.id).toBe('slot.fallback')
  })

  it('falls back through explicit, user, mode and built-in suite order with diagnostics', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.activation', 'order')
    registry.registerRenderKind(owner, k('plugin.note'))
    registry.registerSuite(owner, s('suite.builtin'))
    const activation = resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'suite.missing', userSelectedSuiteId: 'suite.missing2', modeDefaultSuiteId: 'suite.missing3', builtInSolidSuiteId: 'suite.builtin' })
    expect(activation.suite.value.id).toBe('suite.builtin')
    expect(activation.diagnostics.some(item => item.code === 'renderer.suite.unavailable')).toBe(true)
  })
})
