import type { RegistryEntry } from '../registry/types.ts'
import type { RenderKindDefinition, RenderNode } from './rendererTypes.ts'
import type { RenderCatalogSnapshot } from './rendererRegistry.ts'
import { createRendererDiagnostic } from './rendererDiagnostics.ts'
import type {
  RendererActivationSnapshot,
  RendererDiagnostic,
  RendererSlotContribution,
  RendererSuiteContribution,
} from './rendererSuiteTypes.ts'

export interface RendererActivationResolveOptions {
  readonly explicitSuiteId?: string
  readonly userSelectedSuiteId?: string
  readonly modeDefaultSuiteId?: string
  readonly builtInSolidSuiteId?: string
  readonly documentSchema?: string
  readonly renderCatalogSchema?: number
}

function suiteCandidates(options: RendererActivationResolveOptions): readonly string[] {
  return [options.explicitSuiteId, options.userSelectedSuiteId, options.modeDefaultSuiteId, options.builtInSolidSuiteId]
    .filter((id): id is string => Boolean(id))
}

function resolveSuite(
  snapshot: RenderCatalogSnapshot,
  options: RendererActivationResolveOptions,
  diagnostics: RendererDiagnostic[],
): RegistryEntry<RendererSuiteContribution> {
  const suites = snapshot.rendererSuites
  for (const id of suiteCandidates(options)) {
    const suite = suites.find(entry => entry.value.id === id)
    if (!suite) {
      diagnostics.push(createRendererDiagnostic('renderer.suite.unavailable', `Renderer Suite 不可用：${id}`, { severity: 'warning', suiteId: id }))
      continue
    }
    if (options.documentSchema && suite.value.compatibility.documentSchema !== options.documentSchema) {
      diagnostics.push(createRendererDiagnostic('renderer.suite.incompatible', `Renderer Suite document schema 不兼容：${id}`, { severity: 'warning', suiteId: id }))
      continue
    }
    if (options.renderCatalogSchema !== undefined && suite.value.compatibility.renderCatalogSchema !== options.renderCatalogSchema) {
      diagnostics.push(createRendererDiagnostic('renderer.suite.incompatible', `Renderer Suite render catalog schema 不兼容：${id}`, { severity: 'warning', suiteId: id }))
      continue
    }
    return suite
  }
  const fallback = suites.find(entry => entry.value.runtime.framework === 'solid') ?? suites[0]
  if (!fallback) throw new Error('Renderer Suite catalog 为空：无法生成 activation snapshot')
  diagnostics.push(createRendererDiagnostic('renderer.suite.fallback', `Renderer Suite 已回退：${fallback.value.id}`, { severity: 'warning', suiteId: fallback.value.id }))
  return fallback
}

/**
 * Kind fallback 链的唯一实现（#520 S4-P1：rendererRegistry.resolveSurface 的内联
 * walk 已收编于此，settings 预览与生产共用同一顺序）。链中断/成环截断时强制补
 * `content.unknown` 兜底——catalog 校验保证所有链终点本就是 content.unknown，
 * 补全只影响 shadow 期的退化态。
 */
export function kindChain(kindId: string, kinds: readonly RegistryEntry<RenderKindDefinition>[]): readonly string[] {
  const result: string[] = []
  let current = kinds.find(entry => entry.value.id === kindId)?.value
  while (current && !result.includes(current.id)) {
    result.push(current.id)
    current = current.fallbackKind ? kinds.find(entry => entry.value.id === current?.fallbackKind)?.value : undefined
  }
  if (!result.includes('content.unknown')) result.push('content.unknown')
  return result
}

export function resolveRendererSlot(
  suiteId: string,
  kindId: string,
  slots: readonly RegistryEntry<RendererSlotContribution>[],
): readonly RegistryEntry<RendererSlotContribution>[] {
  const candidates = slots.filter(entry => (
    entry.value.kinds.includes(kindId)
    && (entry.value.targetSuites.includes('*') || entry.value.targetSuites.includes(suiteId))
  ))
  return Object.freeze(candidates.sort((a, b) => (
    Number(a.value.fallback) - Number(b.value.fallback)
    || a.value.priority - b.value.priority
    || a.contributionId.localeCompare(b.contributionId)
  )))
}

export function resolveRendererActivation(
  snapshot: RenderCatalogSnapshot,
  options: RendererActivationResolveOptions = {},
): RendererActivationSnapshot {
  const diagnostics: RendererDiagnostic[] = []
  const suite = resolveSuite(snapshot, options, diagnostics)
  const kinds = new Map<string, RegistryEntry<RenderKindDefinition>>()
  for (const entry of snapshot.renderKinds) kinds.set(entry.value.id, entry)
  const slots = new Map<string, readonly RegistryEntry<RendererSlotContribution>[]>()
  const suiteSlots = snapshot.rendererSlots.filter(entry => (
    entry.value.targetSuites.includes('*') || entry.value.targetSuites.includes(suite.value.id)
  ))
  // Suite declarations describe its built-in contract; plugin Slot overlays
  // may add any registered semantic kind targeted at this Suite. Include both
  // sources so production consumers do not need a second registry lookup.
  const activationKinds = new Set([
    ...suite.value.requiredKinds,
    ...(suite.value.optionalKinds ?? []),
    ...suiteSlots.flatMap(entry => entry.value.kinds),
  ])
  for (const kind of activationKinds) {
    let resolved = resolveRendererSlot(suite.value.id, kind, suiteSlots)
    if (resolved.length === 0) {
      for (const fallbackKind of kindChain(kind, snapshot.renderKinds).slice(1)) {
        resolved = resolveRendererSlot(suite.value.id, fallbackKind, suiteSlots)
        if (resolved.length > 0) break
      }
    }
    if (resolved.length === 0) {
      diagnostics.push(createRendererDiagnostic('renderer.slot.unknown', `Renderer Slot 缺失，使用 content.unknown：${kind}`, { severity: 'warning', suiteId: suite.value.id, kind }))
      resolved = resolveRendererSlot(suite.value.id, 'content.unknown', suiteSlots)
    }
    slots.set(kind, resolved)
  }
  if (!slots.has('content.unknown')) {
    slots.set('content.unknown', resolveRendererSlot(suite.value.id, 'content.unknown', suiteSlots))
  }
  const activation: RendererActivationSnapshot = {
    revision: snapshot.revision,
    suite,
    kinds,
    slots,
    diagnostics: Object.freeze(diagnostics),
  }
  return Object.freeze(activation)
}

/** Resolve a single semantic node without allowing a different Suite to leak in. */
export function resolveRendererNodeSlot(
  activation: RendererActivationSnapshot,
  node: RenderNode,
): RegistryEntry<RendererSlotContribution> | undefined {
  const candidates = activation.slots.get(node.kind ?? 'content.unknown') ?? activation.slots.get('content.unknown')
  return candidates?.[0]
}
