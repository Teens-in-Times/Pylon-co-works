import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { RendererRegistry } from '../rendererRegistry.ts'
import type { RendererSlotContribution, RendererSuiteContribution } from '../rendererSuiteTypes.ts'
import type { RenderNodeSnapshot, RenderSurface } from '../../../contracts/messageRenderer.ts'

const surface = (id: string): RenderSurface => ({
  rendererId: id,
  kind: 'solid',
  mount: () => ({}),
  update: () => {},
  destroy: () => {},
  on: () => () => {},
})

const kind = (id: string, fallbackKind = 'content.unknown') => ({
  id,
  category: 'content',
  fallbackKind,
  priority: 10,
  fixture: {},
  defaultTokens: {},
  settingsSchemaVersion: 1,
  validateInput: () => true,
})

const suite = (id = 'suite.base', requiredKinds = ['plugin.note']): RendererSuiteContribution => ({
  id,
  label: id,
  apiVersion: 1,
  runtime: { framework: 'solid', version: '1.0.0' },
  compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
  requiredKinds,
  // factory 只剩 prepare 工厂形态（#520 S4-P2 函数臂塌缩）；本测试不挂载实现。
  factory: { prepare: async () => { throw new Error('not mounted in test') } },
})

const slot = (id: string, targetSuites: readonly (string | '*')[], kinds: readonly string[], fallback = false): RendererSlotContribution => ({
  id,
  targetSuites,
  kinds,
  priority: 10,
  fallback,
  canRender: () => true,
  createSurface: () => surface(id),
})

describe('Renderer Suite contract validation', () => {
  it('rejects missing required kind, non-Solid runtime, duplicate slot and unknown settings target', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.suite', 'validation')
    expect(() => registry.registerSuite(owner, suite('suite.missing', ['plugin.missing']))).toThrow(/required kind|kind/i)
    expect(() => registry.registerSuite(owner, { ...suite(), runtime: { framework: 'react' as 'solid', version: '1' } })).toThrow(/framework|Solid/i)

    registry.registerRenderKind(owner, kind('plugin.note'))
    registry.registerSuite(owner, suite())
    registry.registerSlot(owner, slot('slot.base', ['suite.base'], ['plugin.note']))
    expect(() => registry.registerSlot(owner, slot('slot.duplicate', ['suite.base'], ['plugin.note']))).toThrow(/duplicate|重复/i)
  })

  it('allows cross-owner explicit overlays but keeps fallback slots globally unique', () => {
    const registry = new RendererRegistry()
    const baseOwner = createPluginIdentity('test.suite', 'overlay-base')
    const overlayOwner = createPluginIdentity('test.suite', 'overlay-plugin')
    registry.registerRenderKind(baseOwner, kind('plugin.note'))
    registry.registerSuite(baseOwner, suite())
    registry.registerSlot(baseOwner, slot('slot.base', ['suite.base'], ['plugin.note']))

    expect(() => registry.registerSlot(overlayOwner, slot('slot.overlay', ['suite.base'], ['plugin.note']))).not.toThrow()

    const fallbackRegistry = new RendererRegistry()
    fallbackRegistry.registerRenderKind(baseOwner, kind('plugin.note'))
    fallbackRegistry.registerSuite(baseOwner, suite())
    fallbackRegistry.registerSlot(baseOwner, slot('slot.fallback.base', ['suite.base'], ['plugin.note'], true))
    expect(() => fallbackRegistry.registerSlot(overlayOwner, slot('slot.fallback.overlay', ['suite.base'], ['plugin.note'], true))).toThrow(/duplicate|重复/i)
  })

  it('rejects suite fallback cycles and settings namespace mismatch', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.suite', 'cycle')
    registry.registerRenderKind(owner, kind('plugin.note'))
    const tx = registry.beginShadowTransaction(owner, 'old-cycle-suite')
    tx.registerSuite({ ...suite('suite.a'), fallbackSuiteId: 'suite.b' })
    tx.registerSuite({ ...suite('suite.b'), fallbackSuiteId: 'suite.a' })
    expect(() => tx.validate()).toThrow(/cycle|成环/i)
    tx.rollback()
    expect(() => registry.registerSuite(owner, {
      ...suite('suite.bad-settings'),
      settings: { schemaVersion: 1, groups: [{ id: 'main', label: 'Main', fields: [{ key: 'density', type: 'choice', presentation: 'select', options: [{ value: 'x' }], optionTarget: 'slot.other.density' }] }] },
    })).toThrow(/namespace|target|settings/i)
  })

  it('keeps owner/runtime identity on suite and slot entries', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.suite', 'identity')
    registry.registerRenderKind(owner, kind('plugin.note'))
    registry.registerSuite(owner, suite())
    registry.registerSlot(owner, slot('slot.base', ['suite.base'], ['plugin.note']))
    expect(registry.snapshot().rendererSuites[0]).toMatchObject({ ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key })
    expect(registry.snapshot().rendererSlots[0]).toMatchObject({ ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key })
  })

  it('publishes one coherent revision for suite/kind/slot shadow commit and restores it on revert', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.suite', 'transaction')
    const before = registry.snapshot()
    const changed: number[] = []
    registry.subscribe(() => changed.push(registry.snapshot().revision))
    const tx = registry.beginShadowTransaction(owner, 'old-runtime')
    tx.registerRenderKind(ownerKind('plugin.tx'))
    tx.registerSuite(suite('suite.tx', ['plugin.tx']))
    tx.registerSlot(slot('slot.tx', ['suite.tx'], ['plugin.tx']))
    tx.validate()
    tx.commit()
    expect(changed).toHaveLength(1)
    expect(registry.snapshot().rendererSuites.some(entry => entry.value.id === 'suite.tx')).toBe(true)
    tx.revert()
    expect(registry.snapshot().revision).toBe(before.revision + 2)
    expect(registry.snapshot().rendererSuites.some(entry => entry.value.id === 'suite.tx')).toBe(false)
  })

  it('allows transaction declarations in any order and validates references only at candidate boundary', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.suite', 'order')
    const tx = registry.beginShadowTransaction(owner, 'old-order')
    tx.registerSlot(slot('slot.order', ['suite.order'], ['plugin.order']))
    tx.registerSuite(suite('suite.order', ['plugin.order']))
    tx.registerRenderKind(kind('plugin.order'))
    expect(tx.preview().rendererSuites.some(entry => entry.value.id === 'suite.order')).toBe(true)
    expect(tx.preview().revision).toBe(registry.snapshot().revision)
    expect(() => tx.validate()).not.toThrow()
    tx.rollback()
  })
})

const ownerKind = (id: string) => kind(id)

void ({} as RenderNodeSnapshot)
