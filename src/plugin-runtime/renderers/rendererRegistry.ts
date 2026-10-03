import { createPluginIdentity, type PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistryEntry } from '../registry/types.ts'
import type {
  CodeHighlighterDefinition,
  CodeHighlighterInput,
  ContentRendererDefinition,
  ContentRendererInput,
  MessageRendererDefinition,
  MessageRendererInput,
  RendererDefinitionBase,
  ToolRendererDefinition,
  ToolRendererInput,
  RenderKindDefinition,
  RenderNode,
  RenderResolveContext,
} from './rendererTypes.ts'
import { notifyRegistryListener } from '../registry/registryBatch.ts'
import { normalizeRendererSettingsPlacement, normalizeRendererSettingsSchema } from './rendererSettingsTypes.ts'
import { kindChain } from './rendererActivationResolver.ts'
import type { RendererSlotContribution, RendererSuiteContribution } from './rendererSuiteTypes.ts'
import { validateRenderKindSettingsNamespace, validateRendererContributionGraph, validateRendererSlotContribution, validateRendererSuiteContribution } from './rendererSuiteValidation.ts'
export type { RendererActivationSnapshot, RendererDiagnostic, RendererSlotContribution, RendererSuiteContribution } from './rendererSuiteTypes.ts'
export type {
  CodeHighlighterDefinition,
  ContentRendererDefinition,
  MessageRendererDefinition,
  RendererDefinitionBase,
  RenderKindDefinition,
  RenderNode,
  RenderResolveContext,
  ToolRendererDefinition,
} from './rendererTypes.ts'
export type { RendererApi } from './pluginRendererApi.ts'

export interface RendererRegistryTransaction {
  registerRenderKind(definition: RenderKindDefinition): AsyncDisposable
  registerSuite(definition: RendererSuiteContribution): AsyncDisposable
  registerSlot(definition: RendererSlotContribution): AsyncDisposable
  registerSolidRenderer(definition: MessageRendererDefinition): AsyncDisposable
  registerMessageRenderer(definition: MessageRendererDefinition): AsyncDisposable
  registerContentRenderer(definition: ContentRendererDefinition): AsyncDisposable
  registerToolRenderer(definition: ToolRendererDefinition): AsyncDisposable
  registerCodeHighlighter(definition: CodeHighlighterDefinition): AsyncDisposable
  /** Immutable candidate view; never published and never persisted. */
  preview(): RendererRegistrySnapshot
  validate(): void
  commit(): void
  rollback(): void
  revert(): void
}

export interface RendererRegistrySnapshot {
  readonly revision: number
  readonly renderKinds: readonly RegistryEntry<RenderKindDefinition>[]
  /**
   * 双轨正名（#520 S4-P1）：message/content/tool/highlighter 四个定义面是
   * **在役生产路径**，不是待删代码。Renderer Registry 里的双轨各自在役——
   * - **kind 语义面**（`renderKinds`）：fallback 链、`validateInput`、fixture 与
   *   settings schema 的判定真源；
   * - **suite 实现面**（`rendererSuites`/`rendererSlots`）：Workbench 实现的装配单位。
   * 本组四个兼容面是 `RendererApi.registerMessage/Content/Tool/CodeHighlighter`
   * 的 catalog 投影：`resolveSurface` 按 kind 语义面解析后在其中挑选具体渲染器
   * （content/tool 臂），message/highlighter 臂由 `resolveMessageRenderer` /
   * `resolveCodeHighlighter` 消费（chat 面）。退役前提是 Suite/Slot 面全量承接
   * 这两类消费，另行公告，见说明书 §6.4。
   */
  readonly messageRenderers: readonly RegistryEntry<MessageRendererDefinition>[]
  /** 在役兼容面（双轨声明见上）：content 臂，由 `resolveSurface` 消费。 */
  readonly contentRenderers: readonly RegistryEntry<ContentRendererDefinition>[]
  /** 在役兼容面（双轨声明见上）：tool 臂，由 `resolveSurface` 消费。 */
  readonly toolRenderers: readonly RegistryEntry<ToolRendererDefinition>[]
  /** 在役兼容面（双轨声明见上）：highlighter 臂，由 `resolveCodeHighlighter` 消费。 */
  readonly codeHighlighters: readonly RegistryEntry<CodeHighlighterDefinition>[]
  /** Atomic Suite contributions. */
  readonly rendererSuites: readonly RegistryEntry<RendererSuiteContribution>[]
  /** Suite-local Slot contributions. */
  readonly rendererSlots: readonly RegistryEntry<RendererSlotContribution>[]
}

export interface ResolvedRenderer {
  readonly kind: string
  readonly rendererId?: string
  readonly renderer?: RegistryEntry<MessageRendererDefinition | ContentRendererDefinition | ToolRendererDefinition | CodeHighlighterDefinition>
  readonly fallback: boolean
  readonly diagnostics: readonly { code: string; message: string; kind?: string; rendererId?: string }[]
}

export interface RenderCatalogSnapshot extends RendererRegistrySnapshot {}

function validateDefinition<TInput>(definition: RendererDefinitionBase<TInput>): void {
  if (!definition.id) throw new Error('Renderer id 不能为空')
  if (!Number.isFinite(definition.priority)) throw new Error(`Renderer priority 无效：${definition.id}`)
  if (typeof definition.fallback !== 'boolean') throw new Error(`Renderer fallback 必须显式声明：${definition.id}`)
  if (typeof definition.canRender !== 'function') throw new Error(`Renderer canRender 缺失：${definition.id}`)
  if (definition.settings) normalizeRendererSettingsSchema(definition.settings)
}

function freezeRendererDefinition<TInput, TDefinition extends RendererDefinitionBase<TInput>>(definition: TDefinition): TDefinition {
  return Object.freeze({
    ...definition,
    ...(definition.settings ? { settings: normalizeRendererSettingsSchema(definition.settings) } : {}),
  }) as TDefinition
}

function freezeRenderKind(definition: RenderKindDefinition): RenderKindDefinition {
  const freeze = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    return Object.freeze(value)
  }
  return Object.freeze({
    ...definition,
    ...(definition.aliases ? { aliases: Object.freeze([...definition.aliases]) } : {}),
    fixture: freeze(definition.fixture),
    defaultTokens: freeze(definition.defaultTokens),
    ...(definition.settings ? { settings: normalizeRendererSettingsSchema(definition.settings) } : {}),
    ...(definition.settingsPlacement ? { settingsPlacement: normalizeRendererSettingsPlacement(definition.settingsPlacement) } : {}),
    ...(definition.compatibility ? { compatibility: freeze({ ...definition.compatibility }) as Readonly<Record<string, string>> } : {}),
  })
}

function validateRenderKind(
  definition: RenderKindDefinition,
  existing: readonly RegistryEntry<RenderKindDefinition>[],
  allowMissingFallback = false,
  checkDuplicate = true,
): void {
  if (!definition.id.trim()) throw new Error('RenderKind id 不能为空')
  if (!definition.id.includes('.')) throw new Error(`RenderKind id 必须是 namespaced：${definition.id}`)
  if (!definition.category.trim()) throw new Error(`RenderKind category 不能为空：${definition.id}`)
  if (definition.aliases?.some(alias => !alias.trim() || alias.includes(' '))) throw new Error(`RenderKind aliases 非法：${definition.id}`)
  if (definition.id !== 'content.unknown' && !definition.fallbackKind) throw new Error(`RenderKind fallbackKind 缺失：${definition.id}`)
  if (!Number.isFinite(definition.priority)) throw new Error(`RenderKind priority 无效：${definition.id}`)
  if (!Number.isInteger(definition.settingsSchemaVersion) || definition.settingsSchemaVersion < 1) throw new Error(`RenderKind settingsSchemaVersion 无效：${definition.id}`)
  if (definition.settings && definition.settings.schemaVersion !== definition.settingsSchemaVersion) throw new Error(`RenderKind settings schemaVersion 不匹配：${definition.id}`)
  if (typeof definition.validateInput !== 'function') throw new Error(`RenderKind validateInput 缺失：${definition.id}`)
  if (definition.fallbackKind === definition.id) throw new Error(`RenderKind fallbackKind 自引用：${definition.id}`)
  if (checkDuplicate && existing.some(entry => entry.value.id === definition.id)) throw new Error(`RenderKind id 重复：${definition.id}`)
  if (!allowMissingFallback && definition.fallbackKind && !existing.some(entry => entry.value.id === definition.fallbackKind)) throw new Error(`RenderKind fallbackKind 未注册：${definition.id} -> ${definition.fallbackKind}`)
  const byId = new Map(existing.map(entry => [entry.value.id, entry.value]))
  byId.set(definition.id, definition)
  const seen = new Set<string>()
  const walk = (id: string) => {
    if (seen.has(id)) throw new Error(`RenderKind fallback chain 成环：${id}`)
    seen.add(id)
    const current = byId.get(id)
    if (current?.fallbackKind) walk(current.fallbackKind)
    seen.delete(id)
  }
  walk(definition.id)
}

function select<TInput, TDefinition extends RendererDefinitionBase<TInput>>(
  entries: readonly RegistryEntry<TDefinition>[],
  input: TInput,
): RegistryEntry<TDefinition> | undefined {
  const capable: RegistryEntry<TDefinition>[] = []
  for (const entry of entries) {
    try {
      if (entry.value.canRender(input)) capable.push(entry)
    } catch (error) {
      if (entry.value.onError?.(error, input) === 'rethrow') throw error
    }
  }
  return capable.find(entry => !entry.value.fallback) ?? capable.find(entry => entry.value.fallback)
}

export class RendererRegistry {
  private readonly kinds = new ReactiveRegistryStore<RenderKindDefinition>()
  private readonly messages = new ReactiveRegistryStore<MessageRendererDefinition>()
  private readonly contents = new ReactiveRegistryStore<ContentRendererDefinition>()
  private readonly tools = new ReactiveRegistryStore<ToolRendererDefinition>()
  private readonly highlighters = new ReactiveRegistryStore<CodeHighlighterDefinition>()
  private readonly suites = new ReactiveRegistryStore<RendererSuiteContribution>()
  private readonly slots = new ReactiveRegistryStore<RendererSlotContribution>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private batchDepth = 0
  private publishQueued = false
  private snapshotValue: RendererRegistrySnapshot = Object.freeze({
    revision: 0,
    renderKinds: Object.freeze([]),
    messageRenderers: Object.freeze([]),
    contentRenderers: Object.freeze([]),
    toolRenderers: Object.freeze([]),
    codeHighlighters: Object.freeze([]),
    rendererSuites: Object.freeze([]),
    rendererSlots: Object.freeze([]),
  })

  constructor() {
    const publish = () => this.publish()
    this.kinds.subscribe(publish)
    this.messages.subscribe(publish)
    this.contents.subscribe(publish)
    this.tools.subscribe(publish)
    this.highlighters.subscribe(publish)
    this.suites.subscribe(publish)
    this.slots.subscribe(publish)
    const owner = createPluginIdentity('core.renderer.catalog', 'builtin')
    this.kinds.register(owner, Object.freeze({
      id: 'content.unknown', category: 'content', priority: 10000,
      fixture: { raw: true }, defaultTokens: {}, settingsSchemaVersion: 1,
      validateInput: () => true,
    }), { contributionId: 'content.unknown', layer: 'platform', priority: 10000 })
  }

  registerRenderKind(owner: PluginIdentity, definition: RenderKindDefinition): AsyncDisposable {
    validateRenderKind(definition, this.snapshotValue.renderKinds)
    validateRenderKindSettingsNamespace(definition)
    return this.kinds.register(owner, freezeRenderKind(definition), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  registerSuite(owner: PluginIdentity, definition: RendererSuiteContribution): AsyncDisposable {
    const normalized = validateRendererSuiteContribution(definition, this.snapshotValue.rendererSuites, this.snapshotValue.renderKinds)
    validateRendererContributionGraph({
      suites: [...this.snapshotValue.rendererSuites, {
        ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key,
        contributionId: normalized.id, layer: 'feature', priority: 1000, value: normalized,
      }],
      slots: this.snapshotValue.rendererSlots,
      kinds: this.snapshotValue.renderKinds,
    })
    return this.suites.register(owner, normalized, { contributionId: normalized.id })
  }

  registerSlot(owner: PluginIdentity, definition: RendererSlotContribution): AsyncDisposable {
    const normalized = validateRendererSlotContribution(definition, this.snapshotValue.rendererSuites, this.snapshotValue.renderKinds)
    validateRendererContributionGraph({
      suites: this.snapshotValue.rendererSuites,
      slots: [...this.snapshotValue.rendererSlots, {
        ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key,
        contributionId: normalized.id, layer: 'feature', priority: normalized.priority, value: normalized,
      }],
      kinds: this.snapshotValue.renderKinds,
    })
    return this.slots.register(owner, normalized, { contributionId: normalized.id, priority: normalized.priority })
  }

  registerSolidRenderer(owner: PluginIdentity, definition: MessageRendererDefinition): AsyncDisposable {
    if (definition.renderer.kind !== 'solid') throw new Error(`Solid renderer kind 非法：${definition.id}`)
    return this.registerMessageRenderer(owner, definition)
  }

  registerMessageRenderer(owner: PluginIdentity, definition: MessageRendererDefinition): AsyncDisposable {
    validateDefinition(definition)
    if (!definition.renderer?.rendererId) throw new Error(`Message renderer 实现无 rendererId：${definition.id}`)
    return this.messages.register(owner, freezeRendererDefinition(definition), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  registerContentRenderer(owner: PluginIdentity, definition: ContentRendererDefinition): AsyncDisposable {
    validateDefinition(definition)
    if (!definition.kind || !definition.provider) throw new Error(`Content renderer 定义无效：${definition.id}`)
    return this.contents.register(owner, freezeRendererDefinition(definition), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  registerToolRenderer(owner: PluginIdentity, definition: ToolRendererDefinition): AsyncDisposable {
    validateDefinition(definition)
    if (!definition.kind || !definition.renderer) throw new Error(`Tool renderer 定义无效：${definition.id}`)
    return this.tools.register(owner, freezeRendererDefinition(definition), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  registerCodeHighlighter(owner: PluginIdentity, definition: CodeHighlighterDefinition): AsyncDisposable {
    validateDefinition(definition)
    if (typeof definition.highlight !== 'function') throw new Error(`Code highlighter 实现无效：${definition.id}`)
    return this.highlighters.register(owner, freezeRendererDefinition(definition), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RendererRegistryTransaction {
    const kinds = this.kinds.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const stagedKinds: RenderKindDefinition[] = []
    const stagedSuites: RendererSuiteContribution[] = []
    const stagedSlots: RendererSlotContribution[] = []
    const suites = this.suites.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const slots = this.slots.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const messages = this.messages.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const contents = this.contents.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const tools = this.tools.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const highlighters = this.highlighters.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const transactions = [kinds, suites, slots, messages, contents, tools, highlighters] as const
    const candidateKinds = () => [
      ...this.snapshotValue.renderKinds.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId),
      ...stagedKinds.map(value => ({ value } as RegistryEntry<RenderKindDefinition>)),
    ]
    const candidateSuites = () => [
      ...this.snapshotValue.rendererSuites.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId),
      ...stagedSuites.map(value => ({
        ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key,
        contributionId: value.id, layer: 'feature', priority: 1000, value,
      } as RegistryEntry<RendererSuiteContribution>)),
    ]
    const candidateSlots = () => [
      ...this.snapshotValue.rendererSlots.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId),
      ...stagedSlots.map(value => ({
        ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key,
        contributionId: value.id, layer: 'feature', priority: value.priority, value,
      } as RegistryEntry<RendererSlotContribution>)),
    ]
    return {
      registerRenderKind: definition => {
        // Shadow updates replace the previous owner atomically. Validate the
        // candidate against the surviving catalog, otherwise the old kind is
        // incorrectly treated as a duplicate before the transaction can stage.
        validateRenderKind(
          definition,
          this.snapshotValue.renderKinds.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId),
          true,
        )
        validateRenderKindSettingsNamespace(definition)
        stagedKinds.push(definition)
        return kinds.register(freezeRenderKind(definition), { contributionId: definition.id, priority: definition.priority })
      },
      registerSuite: definition => {
        const normalized = validateRendererSuiteContribution(definition, this.snapshotValue.rendererSuites, [
          ...this.snapshotValue.renderKinds,
          ...stagedKinds.map(value => ({ value } as RegistryEntry<RenderKindDefinition>)),
        ], true, true)
        stagedSuites.push(normalized)
        return suites.register(normalized, { contributionId: normalized.id })
      },
      registerSlot: definition => {
        const normalized = validateRendererSlotContribution(definition,
          [...this.snapshotValue.rendererSuites, ...stagedSuites.map(value => ({ value } as RegistryEntry<RendererSuiteContribution>))],
          [...this.snapshotValue.renderKinds, ...stagedKinds.map(value => ({ value } as RegistryEntry<RenderKindDefinition>))], true)
        stagedSlots.push(normalized)
        return slots.register(normalized, { contributionId: normalized.id, priority: normalized.priority })
      },
      registerSolidRenderer: definition => {
        if (definition.renderer.kind !== 'solid') throw new Error(`Solid renderer kind 非法：${definition.id}`)
        validateDefinition(definition)
        if (!definition.renderer?.rendererId) throw new Error(`Message renderer 实现无 rendererId：${definition.id}`)
        return messages.register(freezeRendererDefinition(definition), { contributionId: definition.id, priority: definition.priority })
      },
      registerMessageRenderer: definition => {
        validateDefinition(definition)
        if (!definition.renderer?.rendererId) throw new Error(`Message renderer 实现无 rendererId：${definition.id}`)
        return messages.register(freezeRendererDefinition(definition), {
          contributionId: definition.id,
          priority: definition.priority,
        })
      },
      registerContentRenderer: definition => {
        validateDefinition(definition)
        if (!definition.kind || !definition.provider) throw new Error(`Content renderer 定义无效：${definition.id}`)
        return contents.register(freezeRendererDefinition(definition), {
          contributionId: definition.id,
          priority: definition.priority,
        })
      },
      registerToolRenderer: definition => {
        validateDefinition(definition)
        if (!definition.kind || !definition.renderer) throw new Error(`Tool renderer 定义无效：${definition.id}`)
        return tools.register(freezeRendererDefinition(definition), {
          contributionId: definition.id,
          priority: definition.priority,
        })
      },
      registerCodeHighlighter: definition => {
        validateDefinition(definition)
        if (typeof definition.highlight !== 'function') throw new Error(`Code highlighter 实现无效：${definition.id}`)
        return highlighters.register(freezeRendererDefinition(definition), {
          contributionId: definition.id,
          priority: definition.priority,
        })
      },
      preview: () => Object.freeze({
        revision: this.snapshotValue.revision,
        renderKinds: Object.freeze(candidateKinds()),
        rendererSuites: Object.freeze(candidateSuites()),
        rendererSlots: Object.freeze(candidateSlots()),
        messageRenderers: this.snapshotValue.messageRenderers,
        contentRenderers: this.snapshotValue.contentRenderers,
        toolRenderers: this.snapshotValue.toolRenderers,
        codeHighlighters: this.snapshotValue.codeHighlighters,
      }),
      validate: () => {
        const existing = this.snapshotValue.renderKinds.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId)
        const combined = [...existing, ...stagedKinds.map(definition => ({ value: definition } as RegistryEntry<RenderKindDefinition>))]
        const ids = new Set<string>()
        for (const definition of stagedKinds) {
          if (ids.has(definition.id) || existing.some(entry => entry.value.id === definition.id)) throw new Error(`RenderKind id 重复：${definition.id}`)
          ids.add(definition.id)
        }
        for (const definition of stagedKinds) validateRenderKind(definition, combined, false, false)
        const existingSuites = this.snapshotValue.rendererSuites.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId)
        const existingSlots = this.snapshotValue.rendererSlots.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId)
        const suiteEntries = [...existingSuites, ...stagedSuites.map(value => ({
          ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key,
          contributionId: value.id, layer: 'feature', priority: 1000, value,
        } as RegistryEntry<RendererSuiteContribution>))]
        const slotEntries = [...existingSlots, ...stagedSlots.map(value => ({
          ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key,
          contributionId: value.id, layer: 'feature', priority: value.priority, value,
        } as RegistryEntry<RendererSlotContribution>))]
        validateRendererContributionGraph({ suites: suiteEntries, slots: slotEntries, kinds: combined })
        for (const transaction of transactions) transaction.validate()
      },
      commit: () => {
        // Commit only after the cross-registry candidate has passed kind validation.
        const existing = this.snapshotValue.renderKinds.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId)
        const combined = [...existing, ...stagedKinds.map(definition => ({ value: definition } as RegistryEntry<RenderKindDefinition>))]
        for (const definition of stagedKinds) validateRenderKind(definition, combined, false, false)
        const existingSuites = this.snapshotValue.rendererSuites.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId)
        const existingSlots = this.snapshotValue.rendererSlots.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId)
        validateRendererContributionGraph({
          suites: [...existingSuites, ...stagedSuites.map(value => ({
            ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key,
            contributionId: value.id, layer: 'feature', priority: 1000, value,
          } as RegistryEntry<RendererSuiteContribution>))],
          slots: [...existingSlots, ...stagedSlots.map(value => ({
            ownerPluginId: owner.pluginId, ownerRuntimeInstanceId: owner.key,
            contributionId: value.id, layer: 'feature', priority: value.priority, value,
          } as RegistryEntry<RendererSlotContribution>))],
          kinds: combined,
        })
        this.batchDepth += 1
        try {
          for (const transaction of transactions) transaction.commit()
        } finally {
          this.batchDepth -= 1
          if (this.batchDepth === 0 && this.publishQueued) {
            this.publishQueued = false
            this.publish()
          }
        }
      },
      rollback: () => { for (const transaction of transactions) transaction.rollback() },
      revert: () => {
        this.batchDepth += 1
        try {
          for (const transaction of [...transactions].reverse()) transaction.revert()
        } finally {
          this.batchDepth -= 1
          if (this.batchDepth === 0 && this.publishQueued) {
            this.publishQueued = false
            this.publish()
          }
        }
      },
    }
  }

  resolveMessageRenderer(input: MessageRendererInput = {}) {
    return select(this.snapshotValue.messageRenderers, input)
  }

  resolveFallbackMessageRenderer(input: MessageRendererInput = {}, excludedContributionId?: string) {
    return select(
      this.snapshotValue.messageRenderers.filter(entry => (
        entry.value.fallback && entry.contributionId !== excludedContributionId
      )),
      input,
    )
  }

  resolveContentRenderer(input: ContentRendererInput) {
    return select(this.snapshotValue.contentRenderers.filter(entry => entry.value.kind === input.kind), input)
  }

  resolveToolRenderer(input: ToolRendererInput) {
    return select(this.snapshotValue.toolRenderers.filter(entry => (
      entry.value.kind === input.kind || entry.value.kind === '*'
    )), input)
  }

  resolveCodeHighlighter(input: CodeHighlighterInput) {
    return select(this.snapshotValue.codeHighlighters, input)
  }

  resolveSurface(node: RenderNode, context: RenderResolveContext = {}): ResolvedRenderer {
    const diagnostics: Array<{ code: string; message: string; kind?: string; rendererId?: string }> = []
    const requestedKind = node.kind?.trim() || 'content.unknown'
    const kinds = this.snapshotValue.renderKinds
    const kindEntry = kinds.find(entry => entry.value.id === requestedKind || entry.value.aliases?.includes(requestedKind))
    if (!kindEntry && requestedKind !== 'content.unknown') {
      const diagnostic = { code: 'render-kind.unknown', message: `Unknown RenderKind ${requestedKind}; using content.unknown`, kind: requestedKind }
      diagnostics.push(diagnostic)
      context.diagnostic?.(diagnostic)
    }
    // #520 S4-P1：fallback 链走 rendererActivationResolver.kindChain 单一实现
    // （强制补 content.unknown 兜底语义一致），预览与生产不再各持一份 walk。
    const candidateKinds = kindChain(kindEntry?.value.id ?? 'content.unknown', kinds)
    const rendererId = context.rendererId ?? node.rendererId
    const find = (kind: string) => {
      const input = { kind, payload: node.payload }
      const definition = kinds.find(entry => entry.value.id === kind)?.value
      const acceptedKinds = new Set([kind, ...(definition?.aliases ?? [])])
      const candidates = [
        ...this.snapshotValue.contentRenderers.filter(entry => acceptedKinds.has(entry.value.kind)),
        ...this.snapshotValue.toolRenderers.filter(entry => acceptedKinds.has(entry.value.kind)),
      ]
      const explicit = rendererId ? candidates.find(entry => entry.contributionId === rendererId) : undefined
      if (explicit) return explicit
      for (const candidate of candidates) {
        try {
          if (candidate.value.canRender(input as never)) return candidate
        } catch (error) {
          const decision = candidate.value.onError?.(error, input as never)
          const diagnostic = { code: 'renderer.canRender.failed', message: `renderer ${candidate.contributionId} canRender failed`, kind, rendererId: candidate.contributionId }
          diagnostics.push(diagnostic)
          context.diagnostic?.(diagnostic)
          if (decision === 'rethrow') throw error
        }
      }
      return undefined
    }
    for (const kind of candidateKinds) {
      const definition = kinds.find(entry => entry.value.id === kind)?.value
      if (definition) {
        try {
          if (!definition.validateInput(node.payload)) continue
        } catch {
          const diagnostic = { code: 'render-kind.validate.failed', message: `RenderKind ${kind} validateInput failed`, kind }
          diagnostics.push(diagnostic)
          context.diagnostic?.(diagnostic)
          continue
        }
      }
      const renderer = find(kind)
      if (renderer) return { kind, rendererId: renderer.contributionId, renderer, fallback: kind !== requestedKind, diagnostics: Object.freeze(diagnostics) }
    }
    return { kind: 'content.unknown', fallback: true, diagnostics: Object.freeze(diagnostics) }
  }

  snapshot(): RenderCatalogSnapshot {
    return this.snapshotValue
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    if (this.batchDepth > 0) {
      this.publishQueued = true
      return
    }
    this.revision += 1
    this.snapshotValue = Object.freeze({
      revision: this.revision,
      renderKinds: this.kinds.getSnapshot().entries,
      messageRenderers: this.messages.getSnapshot().entries,
      contentRenderers: this.contents.getSnapshot().entries,
      toolRenderers: this.tools.getSnapshot().entries,
      codeHighlighters: this.highlighters.getSnapshot().entries,
      rendererSuites: this.suites.getSnapshot().entries,
      rendererSlots: this.slots.getSnapshot().entries,
    })
    for (const listener of [...this.listeners]) notifyRegistryListener(listener)
  }
}
