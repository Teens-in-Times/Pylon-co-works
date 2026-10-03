import { describe, expect, it } from 'vitest'
import type { RenderSurface } from '../../../contracts/messageRenderer.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { resolveRendererActivation } from '../../../plugin-runtime/renderers/rendererActivationResolver.ts'
import { RendererRegistry } from '../../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RenderKindDefinition } from '../../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSlotContribution, RendererSuiteContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../textRenderKindCatalog.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../executionRenderKindCatalog.ts'

/**
 * C06/C07/C15 共享 Slot 生命周期套件（参数化宿主）。
 *
 * diff/LSP、execution、artifact 三类扩展内容 Slot 的热更新/卸载行为同构同契约：
 * overlay 胜出解析 → shadow transaction 原子替换 → 旧实例 dispose → 恰一条新 owner 条目 →
 * 新实例 dispose → base Slot 恢复。场景差异只在 render kind 与 slot 工厂，
 * 因此以 describe.each 参数化；Suite-local 隔离断言为本文件独有，单独保留。
 */

function surface(rendererId: string): RenderSurface {
  return {
    rendererId,
    kind: 'solid',
    mount: () => ({}),
    update: () => {},
    destroy: () => {},
    on: () => () => {},
  }
}

function suite(id: string, requiredKinds: readonly string[], optionalKinds: readonly string[] = []): RendererSuiteContribution {
  return {
    id, label: id, apiVersion: 1,
    runtime: { framework: 'solid', version: '1.0.0' },
    compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
    requiredKinds: [...requiredKinds], optionalKinds: [...optionalKinds],
    // factory 只剩 prepare 工厂形态（#520 S4-P2 函数臂塌缩）；本测试不挂载实现。
    factory: { prepare: async () => { throw new Error('not mounted in test') } },
  }
}

interface SlotLifecycleScenario {
  readonly label: string
  readonly kinds: readonly string[]
  readonly catalog: readonly RenderKindDefinition[]
  readonly overlayPluginId: string
  readonly overlaySlotId: string
  readonly createBaseSlot: () => RendererSlotContribution
  readonly createOverlaySlot: () => RendererSlotContribution
}

/** c15 工厂：canRender 按声明 kind 过滤，fallback 由 priority>100 派生（原 c15SlotLifecycle.test.ts） */
function kindCheckedSlot(id: string, kinds: readonly string[], priority: number): RendererSlotContribution {
  return {
    id, targetSuites: ['builtin.solid'], kinds: [...kinds], priority, fallback: priority > 100,
    canRender: input => kinds.includes(input.kind), createSurface: () => surface(id),
  }
}

/** C07 工厂：canRender 恒真，fallback/priority 显式（原 executionSlotLifecycle.test.ts） */
function executionOverlay(id: string, targetSuites: readonly string[], fallback = false, priority = 1): RendererSlotContribution {
  return {
    id, targetSuites, kinds: ['activity.process'], priority, fallback, canRender: () => true,
    createSurface: () => surface(id),
  }
}

/** C06 工厂：overlay 声明 diff+LSP 双 kind、可指定 target suites（原 diffLspSlotLifecycle.test.ts） */
function diffLspSlot(
  id: string,
  targetSuites: readonly string[],
  rendererId: string,
  options: { fallback?: boolean; priority?: number } = {},
): RendererSlotContribution {
  return {
    id, targetSuites, kinds: ['content.diff', 'diagnostic.lsp'],
    priority: options.priority ?? 1,
    fallback: options.fallback ?? false,
    canRender: () => true,
    createSurface: () => surface(rendererId),
  }
}

const scenarios: readonly SlotLifecycleScenario[] = [
  {
    label: 'C06 diff/LSP 扩展内容',
    kinds: ['content.diff', 'diagnostic.lsp'],
    catalog: BUILTIN_TEXT_RENDER_KINDS,
    overlayPluginId: 'example.diff-overlay',
    overlaySlotId: 'example.diff-overlay.slot',
    createBaseSlot: () => diffLspSlot('builtin.solid.content.base', ['builtin.solid'], 'builtin-base', { fallback: true, priority: 10_000 }),
    createOverlaySlot: () => diffLspSlot('example.diff-overlay.slot', ['builtin.solid'], 'overlay-v2'),
  },
  {
    label: 'C07 execution 过程',
    kinds: ['activity.process'],
    catalog: BUILTIN_EXECUTION_RENDER_KINDS,
    overlayPluginId: 'example.process-overlay',
    overlaySlotId: 'example.process-overlay',
    createBaseSlot: () => executionOverlay('builtin.solid.content.base', ['builtin.solid'], true, 10_000),
    createOverlaySlot: () => executionOverlay('example.process-overlay', ['builtin.solid']),
  },
  {
    label: 'C15 artifact 扩展内容',
    kinds: ['content.artifact'],
    catalog: BUILTIN_TEXT_RENDER_KINDS,
    overlayPluginId: 'plugin.artifact-preview',
    overlaySlotId: 'plugin.artifact-preview.slot',
    createBaseSlot: () => kindCheckedSlot('builtin.solid.content.base', ['content.artifact'], 10_000),
    createOverlaySlot: () => kindCheckedSlot('plugin.artifact-preview.slot', ['content.artifact'], 1),
  },
]

describe.each(scenarios)('Slot lifecycle（$label）', scenario => {
  it('shadow-update 原子替换 overlay，旧实例卸载后恰一条新 owner 条目，新实例卸载后恢复 base Slot', async () => {
    const registry = new RendererRegistry()
    const builtin = createPluginIdentity('builtin.pylon-renderers', 'base')
    for (const kindId of scenario.kinds) {
      registry.registerRenderKind(builtin, scenario.catalog.find(kind => kind.id === kindId)!)
    }
    registry.registerSuite(builtin, suite('builtin.solid', [scenario.kinds[0]!], scenario.kinds.slice(1)))
    registry.registerSlot(builtin, scenario.createBaseSlot())

    const v1 = createPluginIdentity(scenario.overlayPluginId, 'v1')
    const oldHandle = registry.registerSlot(v1, scenario.createOverlaySlot())
    for (const kindId of scenario.kinds) {
      expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
        .slots.get(kindId)?.[0].ownerRuntimeInstanceId).toBe(v1.key)
    }

    const v2 = createPluginIdentity(scenario.overlayPluginId, 'v2')
    const update = registry.beginShadowTransaction(v2, v1.key)
    const nextHandle = update.registerSlot(scenario.createOverlaySlot())
    update.validate()
    update.commit()
    await oldHandle.dispose()
    const overlayEntries = registry.snapshot().rendererSlots.filter(entry => entry.value.id === scenario.overlaySlotId)
    expect(overlayEntries).toHaveLength(1)
    expect(overlayEntries[0]?.ownerRuntimeInstanceId).toBe(v2.key)
    for (const kindId of scenario.kinds) {
      expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
        .slots.get(kindId)?.[0].ownerRuntimeInstanceId).toBe(v2.key)
    }

    await nextHandle.dispose()
    for (const kindId of scenario.kinds) {
      expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
        .slots.get(kindId)?.[0].value.id).toBe('builtin.solid.content.base')
    }
  })
})

describe('C06 diff and LSP Slot ownership — Suite-local 隔离（本文件独有断言）', () => {
  it('keeps overlays Suite-local and atomically restores the base Slot after hot-update cleanup', async () => {
    const registry = new RendererRegistry()
    const builtin = createPluginIdentity('builtin.pylon-renderers', 'base')
    const alt = createPluginIdentity('example.alt-suite', 'base')
    for (const id of ['content.diff', 'diagnostic.lsp']) {
      registry.registerRenderKind(builtin, BUILTIN_TEXT_RENDER_KINDS.find(kind => kind.id === id)!)
    }
    registry.registerSuite(builtin, suite('builtin.solid', ['content.diff'], ['diagnostic.lsp']))
    registry.registerSuite(alt, suite('example.alt', ['content.diff'], ['diagnostic.lsp']))
    registry.registerSlot(builtin, diffLspSlot('builtin.solid.content.base', ['builtin.solid'], 'builtin-base', { fallback: true, priority: 10_000 }))
    registry.registerSlot(alt, diffLspSlot('example.alt.content.base', ['example.alt'], 'alt-base', { fallback: true, priority: 10_000 }))

    const oldOwner = createPluginIdentity('example.diff-overlay', 'v1')
    const oldHandle = registry.registerSlot(oldOwner, diffLspSlot('example.diff-overlay.slot', ['builtin.solid'], 'overlay-v1'))
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
      .slots.get('content.diff')?.[0].value.id).toBe('example.diff-overlay.slot')
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'example.alt' })
      .slots.get('content.diff')?.[0].value.id).toBe('example.alt.content.base')

    const nextOwner = createPluginIdentity('example.diff-overlay', 'v2')
    const update = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    const nextHandle = update.registerSlot(diffLspSlot('example.diff-overlay.slot', ['builtin.solid'], 'overlay-v2'))
    update.validate()
    update.commit()
    expect(registry.snapshot().rendererSlots.filter(entry => entry.value.id === 'example.diff-overlay.slot')).toHaveLength(1)
    expect(registry.snapshot().rendererSlots.find(entry => entry.value.id === 'example.diff-overlay.slot')?.ownerRuntimeInstanceId).toBe(nextOwner.key)

    await oldHandle.dispose()
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
      .slots.get('diagnostic.lsp')?.[0].value.id).toBe('example.diff-overlay.slot')
    await nextHandle.dispose()
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
      .slots.get('content.diff')?.[0].value.id).toBe('builtin.solid.content.base')
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'example.alt' })
      .slots.get('diagnostic.lsp')?.[0].value.id).toBe('example.alt.content.base')
  })
})
