import type { RegistryEntry } from '../registry/types.ts'
import { normalizeRendererSettingsPlacement, normalizeRendererSettingsSchema, settingFieldKey } from './rendererSettingsTypes.ts'
import type { RenderKindDefinition } from './rendererTypes.ts'
import type { RendererSlotContribution, RendererSuiteContribution } from './rendererSuiteTypes.ts'

const ID_PATTERN = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/

function fail(message: string): never {
  throw new Error(`Renderer Suite contract 无效：${message}`)
}

function validateId(id: string, label: string): void {
  if (!id || id !== id.trim() || !ID_PATTERN.test(id)) fail(`${label} id 非法：${id}`)
}

function validateSettingsNamespace(
  schema: RendererSuiteContribution['settings'] | RendererSlotContribution['settings'],
  namespace: 'suite' | 'slot',
  ownerId: string,
): void {
  if (!schema) return
  const normalized = normalizeRendererSettingsSchema(schema)
  const prefix = `${namespace}.${ownerId}.`
  for (const group of normalized.groups) for (const field of group.fields) {
    const target = 'optionTarget' in field ? field.optionTarget : 'paletteTarget' in field ? field.paletteTarget : undefined
    if (target !== undefined && !target.startsWith(prefix)) {
      fail(`${namespace} settings target 必须指向 ${prefix}：${target}`)
    }
    // Force field key extraction here so malformed migration aliases are diagnosed at registration.
    settingFieldKey(field)
  }
}

export function validateRenderKindSettingsNamespace(kind: RenderKindDefinition): void {
  if (!kind.settings) return
  const normalized = normalizeRendererSettingsSchema(kind.settings)
  const prefix = `kind.${kind.id}.`
  for (const group of normalized.groups) for (const field of group.fields) {
    const target = 'optionTarget' in field ? field.optionTarget : 'paletteTarget' in field ? field.paletteTarget : undefined
    if (target !== undefined && !target.startsWith(prefix)) fail(`kind settings target 必须指向 ${prefix}：${target}`)
    settingFieldKey(field)
  }
}

export function validateRendererSuiteContribution(
  suite: RendererSuiteContribution,
  suites: readonly RegistryEntry<RendererSuiteContribution>[] = [],
  kinds: readonly RegistryEntry<RenderKindDefinition>[] = [],
  allowMissingFallback = false,
  allowMissingKinds = false,
): RendererSuiteContribution {
  validateId(suite.id, 'Suite')
  if (!suite.label?.trim()) fail(`Suite label 不能为空：${suite.id}`)
  if (suite.apiVersion !== 1) fail(`Suite apiVersion 不支持：${suite.id}`)
  if (suite.runtime?.framework !== 'solid') fail(`Suite runtime framework 必须是 Solid：${suite.id}`)
  if (!suite.runtime.version?.trim()) fail(`Suite runtime version 不能为空：${suite.id}`)
  if (!suite.compatibility?.documentSchema?.trim()) fail(`Suite documentSchema 不能为空：${suite.id}`)
  if (!Number.isInteger(suite.compatibility.renderCatalogSchema) || suite.compatibility.renderCatalogSchema < 1) {
    fail(`Suite renderCatalogSchema 无效：${suite.id}`)
  }
  if (!Array.isArray(suite.requiredKinds) || suite.requiredKinds.length === 0) fail(`Suite requiredKinds 不能为空：${suite.id}`)
  const required = new Set(suite.requiredKinds)
  if (required.size !== suite.requiredKinds.length || [...required].some(kind => !kind.trim())) fail(`Suite requiredKinds 重复或非法：${suite.id}`)
  const optional = new Set(suite.optionalKinds ?? [])
  if (optional.size !== (suite.optionalKinds ?? []).length || [...optional].some(kind => !kind.trim())) fail(`Suite optionalKinds 重复或非法：${suite.id}`)
  if ([...required].some(kind => optional.has(kind))) fail(`Suite required/optional kind 重叠：${suite.id}`)
  const knownKinds = new Set(kinds.map(entry => entry.value.id))
  for (const kind of [...required, ...optional]) if (!allowMissingKinds && !knownKinds.has(kind)) fail(`Suite 引用未知 kind：${suite.id} -> ${kind}`)
  if (suite.fallbackSuiteId !== undefined) {
    validateId(suite.fallbackSuiteId, 'Suite fallback')
    if (suite.fallbackSuiteId === suite.id) fail(`Suite fallback 自引用：${suite.id}`)
    if (!allowMissingFallback && !suites.some(entry => entry.value.id === suite.fallbackSuiteId)) fail(`Suite fallback 未注册：${suite.id} -> ${suite.fallbackSuiteId}`)
  }
  validateSettingsNamespace(suite.settings, 'suite', suite.id)
  if (suite.settingsPlacement) normalizeRendererSettingsPlacement(suite.settingsPlacement)
  // 函数臂已随 #520 结构收敛塌缩（host 直调 prepare）：裸函数在此刻拒绝，而非推迟到 prepare 阶段 TypeError。
  if (!suite.factory || typeof suite.factory.prepare !== 'function') fail(`Suite factory 缺失或缺 prepare：${suite.id}`)
  return Object.freeze({
    ...suite,
    requiredKinds: Object.freeze([...suite.requiredKinds]),
    ...(suite.optionalKinds ? { optionalKinds: Object.freeze([...suite.optionalKinds]) } : {}),
    runtime: Object.freeze({ ...suite.runtime }),
    compatibility: Object.freeze({ ...suite.compatibility }),
    ...(suite.settings ? { settings: normalizeRendererSettingsSchema(suite.settings) } : {}),
    ...(suite.settingsPlacement ? { settingsPlacement: normalizeRendererSettingsPlacement(suite.settingsPlacement) } : {}),
  })
}

export function validateRendererSlotContribution(
  slot: RendererSlotContribution,
  suites: readonly RegistryEntry<RendererSuiteContribution>[],
  kinds: readonly RegistryEntry<RenderKindDefinition>[],
  allowMissingReferences = false,
): RendererSlotContribution {
  validateId(slot.id, 'Slot')
  if (!Array.isArray(slot.targetSuites) || slot.targetSuites.length === 0) fail(`Slot targetSuites 不能为空：${slot.id}`)
  if (new Set(slot.targetSuites).size !== slot.targetSuites.length) fail(`Slot targetSuites 重复：${slot.id}`)
  if (!Array.isArray(slot.kinds) || slot.kinds.length === 0 || new Set(slot.kinds).size !== slot.kinds.length) fail(`Slot kinds 非法或重复：${slot.id}`)
  const knownSuites = new Set(suites.map(entry => entry.value.id))
  for (const target of slot.targetSuites) {
    if (!allowMissingReferences && target !== '*' && !knownSuites.has(target)) fail(`Slot targetSuite 未注册：${slot.id} -> ${target}`)
  }
  const knownKinds = new Set(kinds.map(entry => entry.value.id))
  for (const kind of slot.kinds) if (!allowMissingReferences && !knownKinds.has(kind)) fail(`Slot 引用未知 kind：${slot.id} -> ${kind}`)
  if (!Number.isFinite(slot.priority)) fail(`Slot priority 无效：${slot.id}`)
  if (typeof slot.fallback !== 'boolean') fail(`Slot fallback 必须显式声明：${slot.id}`)
  if (typeof slot.canRender !== 'function' || typeof slot.createSurface !== 'function') fail(`Slot implementation 缺失：${slot.id}`)
  validateSettingsNamespace(slot.settings, 'slot', slot.id)
  if (slot.settingsPlacement) normalizeRendererSettingsPlacement(slot.settingsPlacement)
  return Object.freeze({
    ...slot,
    targetSuites: Object.freeze([...slot.targetSuites]),
    kinds: Object.freeze([...slot.kinds]),
    ...(slot.settings ? { settings: normalizeRendererSettingsSchema(slot.settings) } : {}),
    ...(slot.settingsPlacement ? { settingsPlacement: normalizeRendererSettingsPlacement(slot.settingsPlacement) } : {}),
  })
}

export interface RendererContributionGraph {
  readonly suites: readonly RegistryEntry<RendererSuiteContribution>[]
  readonly slots: readonly RegistryEntry<RendererSlotContribution>[]
  readonly kinds: readonly RegistryEntry<RenderKindDefinition>[]
}

export function validateRendererContributionGraph(graph: RendererContributionGraph): void {
  const suiteIds = new Set<string>()
  for (const entry of graph.suites) {
    if (suiteIds.has(entry.value.id)) fail(`Suite id 重复：${entry.value.id}`)
    suiteIds.add(entry.value.id)
  }
  const kindIds = new Set(graph.kinds.map(entry => entry.value.id))
  for (const entry of graph.kinds) validateRenderKindSettingsNamespace(entry.value)
  for (const suite of graph.suites) validateRendererSuiteContribution(suite.value, graph.suites, graph.kinds)
  for (const slot of graph.slots) validateRendererSlotContribution(slot.value, graph.suites, graph.kinds)
  const slotPairs = new Map<string, RegistryEntry<RendererSlotContribution>>()
  for (const entry of graph.slots) {
    for (const target of entry.value.targetSuites) for (const kind of entry.value.kinds) {
      const key = `${target}|${kind}|${entry.value.fallback ? 'fallback' : 'base'}`
      const previous = slotPairs.get(key)
      if (!previous) {
        slotPairs.set(key, entry)
        continue
      }
      // Fallback is a single safety net for a target/kind and must remain
      // globally unique. Explicit (non-fallback) slots may intentionally
      // overlay another owner; duplicate declarations from one runtime are
      // still rejected so a package cannot shadow itself accidentally.
      const sameOwner = !previous.ownerRuntimeInstanceId
        || !entry.ownerRuntimeInstanceId
        || previous.ownerRuntimeInstanceId === entry.ownerRuntimeInstanceId
      if (entry.value.fallback || previous.value.fallback || sameOwner) {
        fail(`Slot duplicate target/kind：${target} -> ${kind}`)
      }
    }
  }
  // A suite fallback graph must terminate and may only point at a registered suite.
  for (const suite of graph.suites) {
    const seen = new Set<string>()
    let current: RendererSuiteContribution | undefined = suite.value
    while (current?.fallbackSuiteId) {
      if (seen.has(current.id)) fail(`Suite fallback chain 成环：${current.id}`)
      seen.add(current.id)
      current = graph.suites.find(entry => entry.value.id === current?.fallbackSuiteId)?.value
      if (!current) fail(`Suite fallback 未注册：${suite.value.id}`)
    }
  }
  // Keep this explicit: graph validation must not silently accept a required kind that vanished.
  for (const suite of graph.suites) for (const required of suite.value.requiredKinds) if (!kindIds.has(required)) fail(`Suite required kind 缺失：${suite.value.id} -> ${required}`)
}
