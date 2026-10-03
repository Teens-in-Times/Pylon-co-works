/**
 * Workbench session host: binding, canonical replay/live reconciliation and
 * generation ownership. This module is the **composition root** (#520
 * S3-P0-1): the replay/folding family lives in agentWorkbenchReplay.ts, the
 * draft application family in agentWorkbenchDrafts.ts, and the terminal
 * settlement family in agentWorkbenchTurnLifecycle.ts — each receives the
 * shared runtime context object (runtime/binding/fold/draft + late-bound
 * seams) and never imports back into this factory. Stateless
 * response/snapshot adapters live alongside this module
 * (agentWorkbenchProjection.ts); they cannot mutate lifecycle state or access
 * persistence. The TurnClock/liveness subsystem (agentWorkbenchTurnClock.ts)
 * and the optimistic-echo subsystem (agentWorkbenchOptimisticEcho.ts) are
 * earlier extracted collaborators; the shared binding/fold state lives in the
 * `binding`/`fold` objects below.
 */
import { createSessionResponseEnvelope, sessionResponseProjectionKey } from './sessionResponseProjection.ts'
import { messageSnapshotToWorkbenchEnvelopes } from './messageSnapshotProjection.ts'
import type { Session } from '../../domains/identity/identityStore.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { canonicalBoundaryProjection } from '../../domains/events/canonicalTurnDuration.ts'
import { setTimelinePayloadNarrowing } from '../../domains/workbench/workbenchProjector.ts'
import { timelinePayloadNarrowingDisabled } from '../../infrastructure/events/readPathSwitches.ts'
import {
  createWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
} from '../../domains/workbench/events/workbenchEventSchema.ts'
import {
  createWorkbenchDocument,
  type WorkbenchDocument,
} from '../../domains/workbench/workbenchProjector.ts'
import { createWorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { createSessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import { createThemeProjectedWorkbenchAppearanceStore } from '../../domains/appearance/themeProjectedWorkbenchAppearanceStore.ts'
import { IS_TAURI, isBrowserMockRuntime } from '../../infrastructure/tauri/env.ts'
import { discardInterruptedDraft, keepInterruptedDraft, loadCanonicalDraftFragments, tauriCanonicalEventRepository, type CanonicalDraftFragment } from '../../infrastructure/events/canonicalEventRepository.ts'
import type { CanonicalEventRow } from '../../domains/events/canonicalEventRow.ts'
import { subscribePluginEvents } from '../../infrastructure/events/pluginEventBusHost.ts'
import { messageStorageKey, parseMessageSnapshot } from '../../domains/chat/messagePersistence.ts'
import type { Message } from '../../domains/chat/messageTypes.ts'
import { createAgentWorkbenchCommandFacade, type ResolvedWorkbenchInteraction } from './agentWorkbenchCommands.ts'
import {
  extractModelConfig,
  extractModeConfig,
  extractConfigOptionValue,
  sessionResponseObject,
  type SessionResponseObject,
} from '../../infrastructure/acp/chatContracts.ts'
import {
  canonicalDurationFromRows,
  canonicalLatestBoundaryFromRows,
  isLiveTextDelta,
  localSessionFactEvent,
  runningTailStartTime,
  toWorkbenchEnvelopes,
  withJournalDiagnostic,
  type LocalSessionFact,
} from './agentWorkbenchProjection.ts'
import { createAgentWorkbenchTurnClock } from './agentWorkbenchTurnClock.ts'
import { createAgentWorkbenchOptimisticEcho } from './agentWorkbenchOptimisticEcho.ts'
import { createAgentWorkbenchDrafts } from './agentWorkbenchDrafts.ts'
import { createAgentWorkbenchReplay, workbenchSessionBindingKey } from './agentWorkbenchReplay.ts'
import { createAgentWorkbenchTurnLifecycle } from './agentWorkbenchTurnLifecycle.ts'
import {
  getCanonicalEventFeed,
  subscribeTurnSettled,
  subscribeWindowTerminalFrames,
  type CanonicalTerminalSignal,
  type CanonicalTurnSettledEvent,
} from '../../infrastructure/events/canonicalEventFeed.ts'

export type { LocalSessionFact } from './agentWorkbenchProjection.ts'
export { workbenchSessionBindingKey } from './agentWorkbenchReplay.ts'

export interface AgentWorkbenchSessionRuntimeDependencies {
  loadAll(ownerKey: string): Promise<readonly unknown[]>
  /**
   * #376-b：分页 compact 读（可选的第二条装载缝）。给了它，冷装载就**按页折**——每页的
   * 行与信封在折进文档之后立刻可回收，装载期不再「整库行 + 整库信封 + 文档」三份并存。
   * 没给就退回 `loadAll` 一次性读（既有测试与浏览器快照轨走的正是这条，语义不变）。
   *
   * `onPage` 必须**按序**逐页 await：续折依赖上一页已入账的文档。
   */
  listJournalPages?(
    ownerKey: string,
    /**
     * 必须**按序**逐页 await，且**恰好在最后一页**传 `lastPage: true`——终态判据收尾、草稿与
     * 浏览器快照都挂在那一次调用上（漏掉它等于静默丢草稿并把半份文档发布成 ready）。
     * 页为空也要调用（空 journal 也要有 `lastPage: true` 的那一次）。
     */
    onPage: (rows: readonly CanonicalEventRow[], lastPage: boolean) => Promise<void>,
  ): Promise<void>
  loadDrafts?(ownerKey: string): Promise<readonly CanonicalDraftFragment[]>
  subscribe(listener: (event: unknown) => void): () => void
  /**
   * 终帧 window 广播兜底订阅。主轨是 per-source IPC Channel（`send_message_streaming`
   * 注册、终帧 take 注销），而 `pylon:done`/`pylon:error` 的 window 广播**没有任何
   * 其他消费者**——Channel 一旦丢失（注册被清、或前端 `activeStreams` 条目被移除）
   * 终帧就没有第二次投递。这里订阅同一条广播，让终帧至少有一条不依赖 Channel 注册
   * 的路。返回退订函数。
   */
  listenTerminalFallback(listener: (signal: CanonicalTerminalSignal) => void): () => void
  /**
   * #442 Step3：账本 settle 广播订阅（终态收敛主轨）。`pylon:turn-settled
   * {source, turn}` 由后端账本 CAS Published 时发射，与 Channel 注册生命周期无关
   * ——终帧丢失场景由此收敛。缺省实现 `subscribeTurnSettled`（非 Tauri no-op）。
   */
  listenTurnSettled?(listener: (event: CanonicalTurnSettledEvent) => void): () => void
  commands?: Partial<import('./agentWorkbenchCommands.ts').AgentWorkbenchCommandDependencies>
}

function defaultTerminalFallbackListener(listener: (signal: CanonicalTerminalSignal) => void): () => void {
  return subscribeWindowTerminalFrames(listener)
}

function defaultTurnSettledListener(listener: (event: CanonicalTurnSettledEvent) => void): () => void {
  return subscribeTurnSettled(listener)
}

function defaultDependencies(): AgentWorkbenchSessionRuntimeDependencies {
  return {
    loadAll: ownerKey => {
      // #81 L2：投影读走 compact（单元 + 未覆盖行）；被覆盖行不再传输/解析。
      if (IS_TAURI && !isBrowserMockRuntime()) return tauriCanonicalEventRepository().loadAllPreferUnits(ownerKey)
      // Browser snapshots are keyed by local Session.id, not the JSON owner key.
      // bind() adds that compatibility source once it has the concrete Session.
      return Promise.resolve([])
    },
    // #376-b：生产冷装载走分页读；失败不静默回落（与 repository 的既有纪律一致，
    // 由 bind 的 catch 把错误变成 status:'error'）。
    listJournalPages: async (ownerKey, onPage) => {
      if (!IS_TAURI || isBrowserMockRuntime()) {
        await onPage([], true)
        return
      }
      const repository = tauriCanonicalEventRepository()
      let afterSequence: number | null = null
      do {
        const page = await repository.listCompact(ownerKey, afterSequence)
        afterSequence = page.nextAfterSequence
        await onPage(page.events, afterSequence === null)
      } while (afterSequence !== null)
    },
    subscribe: listener => subscribePluginEvents(listener),
    listenTerminalFallback: defaultTerminalFallbackListener,
  }
}

export function createAgentWorkbenchSessionRuntime(dependencies: Partial<AgentWorkbenchSessionRuntimeDependencies> = {}) {
  const defaults = defaultDependencies()
  const loadAll = dependencies.loadAll ?? defaults.loadAll
  // 分页缝的优先级：显式给了 `listJournalPages` 就用它；只给了 `loadAll`（既有测试与
  // 嵌入式宿主的注入形态）时**不**启用默认分页读——那等于用空页盖掉注入的行源。
  // 两者都没给（生产）才走默认分页读。
  const listJournalPages = dependencies.listJournalPages
    ?? (dependencies.loadAll ? undefined : defaults.listJournalPages)
  const loadDrafts = dependencies.loadDrafts ?? (ownerKey => IS_TAURI && !isBrowserMockRuntime()
    ? loadCanonicalDraftFragments(ownerKey) : Promise.resolve([]))
  const subscribe = dependencies.subscribe ?? defaults.subscribe
  const listenTerminalFallback = dependencies.listenTerminalFallback ?? defaults.listenTerminalFallback
  const listenTurnSettled = dependencies.listenTurnSettled ?? defaultTurnSettledListener
  const runtime = createWorkbenchRuntime({
    sessionId: null, status: 'idle',
    generating: false, generationStart: 0, tokenCount: 0, summary: null, tasks: [],
    availableModels: [], activeModel: '', availableModes: [], activeMode: '', canAttach: false,
    promptImage: false, error: null, document: createWorkbenchDocument(''),
  })
  const appearance = createThemeProjectedWorkbenchAppearanceStore()
  const sessionUi = createSessionUiStore()
  // 会话宿主的共享绑定/折叠状态（原散落闭包 let 的单源化，接口见
  // agentWorkbenchOptimisticEcho.ts）：子系统与宿主经同一对象读写，跨块共享的
  // 竞态控制面（generation/epoch/source/...）由此显式化。
  const binding = {
    boundSessionId: undefined as string | undefined,
    boundSession: undefined as Session | undefined,
    boundProvider: 'acp',
    boundSessionBindingKey: undefined as string | undefined,
    ownerKey: undefined as string | undefined,
    source: undefined as string | undefined,
    generation: 0,
    turnEpoch: 0,
    loading: false,
    buffered: [] as WorkbenchEventEnvelope[],
    malformedCount: 0,
    destroyed: false,
    // A canonical replay can finish after this runtime's initial bind. Keep a
    // separate, coalesced refresh seam so the same binding key does not make a
    // later durable tool terminal event invisible (bind itself is intentionally
    // idempotent for ordinary Session metadata updates).
    refreshInFlight: null as Promise<void> | null,
    // Every canonical read gets a monotonically increasing token. A bind read
    // that started before a refresh (or before a new bind) must not publish its
    // older snapshot after the newer read has won the race.
    canonicalReadEpoch: 0,
    selectorRequestInFlight: false,
  }
  /**
   * #393：把 Agent 标题（ACP `session_info_update.title`，投影在 `document.session.title`）
   * 回写到绑定行的 `autoName`。
   *
   * 为什么必须落库而不是显示时算：侧栏/搜索列的是**全部**会话，其中绝大多数没有
   * 活动文档；会话运行时是唯一同时持有「文档 + 本地行」的地方，所以镜像在这里做。
   * 存储以 Agent 为准（每帧覆盖写，Agent 清空则回落 `''`）；显示优先用户改名，见
   * `resolveSessionDisplayName`。
   */
  const unsubscribeSessionTitle = runtime.subscribe(() => {
    const sessionId = binding.boundSessionId
    if (binding.destroyed || sessionId === undefined) return
    const title = runtime.getSnapshot().document?.session.title ?? ''
    // 以 store 当前值为判据（`binding.boundSession` 在普通元数据更新后不再刷新，
    // 拿它比会在每次发布时都判定为「变了」而反复写盘）。
    const row = useIdentityStore.getState().sessions.find(session => session.id === sessionId)
    if (!row || row.autoName === title) return
    useIdentityStore.getState().updateSession(sessionId, { autoName: title })
  })
  // #220 折叠已下沉 wasm：折叠状态常驻会话持有的投影核（PylonProjector），JS 文档
  // 是其产出的物化视图。
  //
  // #380：这里曾有一个 `fold.log`（整会话已折信封，供 reject 回滚整页重折）+ `fold.ids`
  // （入日志去重集）。它是**载荷的第二份常驻持有**（合成语料 2237 事件 / Σ载荷 61.5 MB 下
  // ≈Σ载荷，也是会话级驻留与拍数敏感性的唯一来源），而 journal 本就是权威源——reject 改为
  // 按需 canonical 重读（`reloadFromJournal` → `refresh`）后整份日志不再需要，只剩下面这个
  // 宿主侧 overlay 计数。
  const fold = {
    // journal 迁移失败诊断（canonical.journal.malformed）是宿主侧 overlay：折叠物化
    // 出来的文档不带它，物化后按当前计数重挂（withJournalDiagnostic 幂等：filter+append）。
    journalDiagnosticCount: 0,
  }
  const draft = {
    seen: new Set<string>(),
    activeIds: new Set<string>(),
    interruptedIds: new Set<string>(),
    reconcilePending: false,
    liveDuringReconcile: [] as WorkbenchEventEnvelope[],
  }
  /** Responses from the atomic empty-state create transaction can arrive
   * before the Solid host has rebound the Workbench to the newly-added local
   * Session. Keep them keyed by local Session.id until that bind completes.
   * 排队项连同溯源标注一起暂存——排队路径丢掉标注会让 load 响应事后长得像 new 响应。 */
  const pendingSessionResponses = new Map<string, Array<{ response: SessionResponseObject; syntheticReason?: string }>>()
  const appliedSessionResponseKeys = new Map<string, { key: string; session: WorkbenchDocument['session'] | undefined }>()
  const transientSequenceBySource = new Map<string, number>()

  const updateRuntimeState = (patch: Parameters<typeof runtime.update>[0]) => {
    const current = runtime.getSnapshot()
    if (!current.document) {
      runtime.update(patch)
      return
    }
    // #487 后 update() 类型层禁止携带 document（纯字段补丁），此处无需再剥离。
    runtime.applyDocument(current.document, {
      ownerKey: binding.ownerKey,
      generation: binding.generation,
      preserveGeneration: false,
      generationPatch: patch,
    })
  }

  const clock = createAgentWorkbenchTurnClock({
    runtime,
    updateRuntimeState,
    getSource: () => binding.source,
  })
  // #520 S3-P0-1 拆分：草稿应用族 / 重放折叠族 / 终态结算族各自成模块，宿主经
  // context 对象交付共享状态（binding/fold/draft/瞬态序列）与晚绑定缝——新模块
  // 一律不回 import 本工厂（依赖单向）。echo 与 replay 互相需要的两条边（echo 的
  // 折叠缝 / replay 的 withPending 补折）都走晚绑定闭包，与拆分前的闭包互指同构。
  const drafts = createAgentWorkbenchDrafts({
    runtime,
    binding,
    draft,
    transientSequenceBySource,
    // applyLive 定义在本文件后段（时钟/echo 依赖它）——回调仅运行期触发，
    // 闭包引用无 TDZ 问题。
    applyLive: envelope => applyLive(envelope),
  })
  const replay = createAgentWorkbenchReplay({
    runtime,
    binding,
    fold,
    sessionUi,
    clock,
    updateRuntimeState,
    // echo 在下方创建——publishFoldedDocument 运行期才回调，无 TDZ 问题。
    withPending: (source, base) => echo.withPending(source, base),
    drafts,
    draft,
    transientSequenceBySource,
    loadAll,
    loadDrafts,
  })
  const echo = createAgentWorkbenchOptimisticEcho({
    runtime,
    binding,
    clock,
    updateRuntimeState,
    foldPage: replay.foldPage,
    foldEvent: replay.foldEvent,
    // #380：被拒回滚的权威源是 journal（不再是常驻信封日志）——复用 bind/refresh 同一条
    // 发布路径（epoch/generation 守卫、`binding.buffered` 覆盖读期间到达的 live 行、
    // `withPending` 补折仍 pending 的乐观行都在那边）。
    reloadFromJournal: () => replay.refresh(binding.boundSession, undefined, { rebuild: true }),
  })

  const commands = createAgentWorkbenchCommandFacade({
    ...dependencies.commands,
    // P52 D4：controller React 状态面死亡——乐观 echo 撤销只剩 document 侧投影。
    optimisticDocument: echo.project,
    rejectOptimisticDocument: echo.reject,
    resolveConfigOption(sessionId, key) {
      if (binding.boundSessionId !== sessionId) return undefined
      const option = runtime.getSnapshot().document?.session.options.find(item => item.id === key)
      return option ? { value: option.value, version: option.version } : undefined
    },
    resolveInteraction(sessionId, interactionId): ResolvedWorkbenchInteraction | undefined {
      const snapshot = runtime.getSnapshot()
      if (binding.boundSessionId !== sessionId) return undefined
      const interaction = snapshot.document?.interactions.find(item => item.id === interactionId && item.status === 'requested')
      const request = interaction?.request
      if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined
      const candidate = request as { kind?: unknown; identity?: Record<string, unknown> }
      const identity = candidate.identity
      if (!identity || typeof candidate.kind !== 'string') return undefined
      if (typeof identity.provider !== 'string' || typeof identity.agentId !== 'string'
        || typeof identity.requestId !== 'string' || typeof identity.sessionId !== 'string'
        || typeof identity.clientGeneration !== 'number') return undefined
      return {
        kind: candidate.kind,
        revision: interaction.sequence,
        identity: {
          provider: identity.provider,
          agentId: identity.agentId,
          requestId: identity.requestId,
          sessionId: identity.sessionId,
          ...(typeof identity.toolCallId === 'string' ? { toolCallId: identity.toolCallId } : {}),
          clientGeneration: identity.clientGeneration,
        },
      }
    },
  })

  const enqueueSessionResponse = (response: SessionResponseObject, targetSessionId: string, syntheticReason?: string): void => {
    if (binding.destroyed || !binding.boundSessionId || !binding.source || targetSessionId !== binding.boundSessionId) return
    const key = sessionResponseProjectionKey(response)
    const last = appliedSessionResponseKeys.get(targetSessionId)
    if (last?.key === key && last.session === runtime.getSnapshot().document?.session) return

    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(binding.source)
    const bufferedMax = binding.buffered.reduce((max, item) => Math.max(max, item.sequence), 0)
    const previousTransient = transientSequenceBySource.get(binding.source) ?? 0
    const sequence = Math.max(current.revision, bufferedMax, previousTransient) + 1
    transientSequenceBySource.set(binding.source, sequence)
    const envelope = createSessionResponseEnvelope(binding.source, binding.boundProvider, response, sequence, 'session.started', syntheticReason)
    if (binding.loading) {
      binding.buffered.push(envelope)
      appliedSessionResponseKeys.set(targetSessionId, { key, session: runtime.getSnapshot().document?.session })
      return
    }
    runtime.applyDocument(replay.foldEvent(envelope), { ownerKey: binding.ownerKey, generation: binding.generation, preserveGeneration: true })
    appliedSessionResponseKeys.set(targetSessionId, { key, session: runtime.getSnapshot().document?.session })
  }

  /**
   * 会话响应进文档。`options.syntheticReason` 只影响信封的溯源标注：建会话留空
   * （默认 `session-new-response`），复活（`load_persisted_session`）传
   * `session-load-response`，好让事后取证分得清协商事实来自哪条路径（#358）。
   */
  const applySessionResponse = (response: unknown, targetSessionId?: string, options?: { syntheticReason?: string }): void => {
    if (binding.destroyed) return
    const normalized = sessionResponseObject(response)
    const target = targetSessionId?.trim() || binding.boundSessionId
    if (!target) return
    if (binding.boundSessionId && (target === binding.boundSessionId || target === binding.source)) {
      enqueueSessionResponse(normalized, binding.boundSessionId, options?.syntheticReason)
      return
    }
    const pending = pendingSessionResponses.get(target) ?? []
    pending.push({ response: normalized, syntheticReason: options?.syntheticReason })
    pendingSessionResponses.set(target, pending)
  }

  /** Execute one selector write against this binding. Replies update the same
   * document as notifications, never a second optimistic selector store. */
  const runSessionControl = async (
    context: { agentId: string; source: string },
    fact: LocalSessionFact,
    request: () => Promise<unknown>,
  ): Promise<void> => {
    if (binding.destroyed || !binding.boundSessionId || binding.source !== context.source || binding.boundProvider !== context.agentId) throw new Error('selector_owner_stale')
    if (binding.selectorRequestInFlight) throw new Error('selector_request_in_flight')
    const requestGeneration = binding.generation
    const sessionId = binding.boundSessionId
    const before = runtime.getSnapshot().document?.session
    binding.selectorRequestInFlight = true
    sessionUi.set(sessionId, 'selector-pending', '')
    try {
      const response = sessionResponseObject(await request())
      if (binding.destroyed || binding.generation !== requestGeneration || binding.boundSessionId !== sessionId) return
      const current = runtime.getSnapshot().document ?? createWorkbenchDocument(context.source)
      const receivedSelectorUpdate = before && (before.model !== current.session.model || before.mode !== current.session.mode || before.options !== current.session.options)
      const model = extractModelConfig(response.configOptions, response).model
      const mode = extractModeConfig(response).mode
      const options = response.configOptions ?? response.config_options
      if (options?.length) {
        const sequence = Math.max(current.revision, transientSequenceBySource.get(context.source) ?? 0, ...binding.buffered.map(item => item.sequence)) + 1
        transientSequenceBySource.set(context.source, sequence)
        const envelope = createSessionResponseEnvelope(context.source, binding.boundProvider, response, sequence, 'session.config-updated')
        if (binding.loading) binding.buffered.push(envelope)
        else runtime.applyDocument(replay.foldEvent(envelope), { ownerKey: binding.ownerKey, generation: binding.generation, preserveGeneration: true })
      } else {
        if (model) applyLocalSessionFact({ kind: 'model', model }, context.source)
        if (mode) applyLocalSessionFact({ kind: 'mode', mode }, context.source)
      }
      const confirmed = fact.kind === 'model' ? model : fact.kind === 'mode' ? mode
        : options?.find(option => option.id === fact.id) && extractConfigOptionValue(options.find(option => option.id === fact.id))
      if (confirmed === undefined && !receivedSelectorUpdate) {
        const requested = fact.kind === 'model' ? fact.model : fact.kind === 'mode' ? fact.mode : String(fact.value)
        sessionUi.set(sessionId, 'selector-pending', `${requested}（等待 Agent 确认）`)
      }
    } finally {
      binding.selectorRequestInFlight = false
    }
  }

  /**
   * Project a locally-confirmed write into the document as a canonical fact.
   *
   * Two different reasons make this necessary, and both follow from the same
   * rule — the document is the single source of truth the selectors read:
   *  - a provider may accept a write without announcing it (Hermes never emits
   *    `current_mode_update`), so nothing else would publish the new value;
   *  - replaying a synthetic session response instead is not an option: its
   *    option list is response-shaped, and the projector replaces the whole
   *    `session.options` surface with it. Doing that for a model switch silently
   *    dropped the mode and reasoning catalogues, so the control center fell back
   *    to its local tables (and the reasoning write was rejected for good).
   * A fact states only the value that changed, so the rest of the surface stays.
   */
  const applyLocalSessionFact = (fact: LocalSessionFact, targetSessionId?: string): void => {
    if (binding.destroyed || !binding.boundSessionId || !binding.source) return
    const target = targetSessionId?.trim()
    if (target && target !== binding.boundSessionId && target !== binding.source) return
    const current = runtime.getSnapshot().document ?? createWorkbenchDocument(binding.source)
    const event = localSessionFactEvent(fact, current)
    if (!event) return
    const bufferedMax = binding.buffered.reduce((max, item) => Math.max(max, item.sequence), 0)
    const previousTransient = transientSequenceBySource.get(binding.source) ?? 0
    const sequence = Math.max(current.revision, bufferedMax, previousTransient) + 1
    transientSequenceBySource.set(binding.source, sequence)
    const envelope = createWorkbenchEnvelope({
      eventId: `local-fact:${binding.source}:${sequence}`,
      sessionId: binding.source,
      sequence,
      recordedAt: new Date().toISOString(),
      source: { provider: 'local-write', sourceId: `local-fact:${sequence}` },
      provenance: {
        origin: 'local-observed',
        trust: 'authoritative',
        provider: binding.boundProvider,
        orderConfidence: 'observed',
        synthetic: { reason: 'local-write-confirmed' },
      },
      event,
    })
    if (binding.loading) {
      binding.buffered.push(envelope)
      return
    }
    runtime.applyDocument(replay.foldEvent(envelope), { ownerKey: binding.ownerKey, generation: binding.generation, preserveGeneration: true })
  }

  const applyLive = (incoming: WorkbenchEventEnvelope) => {
    const currentBefore = runtime.getSnapshot().document
    // live 每信封热点（#440）：这里只要「末条 user 行」，原写法 [...messages].reverse().find
    // 是每帧 O(N) 整表拷贝+反转；倒序下标扫描引用级等价（events 突发率无批上限）。
    const messagesBefore = currentBefore?.messages
    let priorUser: WorkbenchDocument['messages'][number] | undefined
    if (messagesBefore !== undefined) {
      for (let index = messagesBefore.length - 1; index >= 0; index -= 1) {
        const candidate = messagesBefore[index]
        if (candidate !== undefined && candidate.role === 'user') {
          priorUser = candidate
          break
        }
      }
    }
    const isUserStart = incoming.event.type === 'message.delta' && incoming.event.role === 'user'
      && !(priorUser?.running === true)
    const content = isUserStart ? (incoming.event.parts ?? []).map(part => 'text' in part ? part.text : '').join('') : ''
    const echoesOptimistic = echo.matchesPending(incoming.sessionId, incoming.identity.interactionId, content)
    if (isUserStart && !echoesOptimistic) binding.turnEpoch += 1
    const envelope = echo.confirm(incoming)
    const envelopeTime = envelope.occurredAt ? Date.parse(envelope.occurredAt) || Date.now() : Date.now()
    // P52 D3：非乐观 user echo 是真实回合起点（发送方可能是同账号其它客户端）；
    // 覆盖 TurnClock，与 applyDocument 的 terminalFence:null 清除通道对齐。
    // #200：loading 期间到达的是 session/load 的**重放历史**帧——不是新回合。
    // 空 journal（#155 T2 重建升级）时 refresh 无终态证据可压住时钟，重放的 user
    // 帧会把历史回合复活成「仍在等待后端响应」的生成态并阻塞发送队列。缓冲帧在
    // 载入完成后经 wasm 投影核整页折叠（不走 applyLive），不会二次开启时钟。
    // #217：本 source 有内核表态（kernelLivenessBySource.has）时，"采纳实时帧"的
    // 启发式停用——是否在途由内核事实回答，本进程不再从观察物猜（ADR-0017 收敛
    // 推断）。clockOnlyStarts 的记账保留（canonical echo 仍需确认派发意图）。
    const kernelAuthoritative = clock.kernelAuthoritative(envelope.sessionId)
    if (isUserStart && !echoesOptimistic && !binding.loading) {
      // 空态路径的回合起点已在发送入口建立：live echo 不得把它推迟到 echo 时刻
      // （elapsed 从用户发出算起，与已绑定路径一致）。
      if (!kernelAuthoritative && !clock.hasClockOnlyStart(envelope.sessionId)) clock.start(envelope.sessionId, envelopeTime)
      clock.clearClockOnlyStart(envelope.sessionId)
      // #213：权威活性必须**明确表态**——不能再指望文档里那个 running 行把 generating 顶起来
      // （文档派生的活性已让位给回合时钟）。回合不终结，时钟就一直是权威。
      if (!kernelAuthoritative) clock.reconcile(envelope.sessionId)
    }
    // #213 补强：本 source 还没有回合时钟时，**实时**文本 delta 本身就是「在途回合」的证据
    //（同账号其它客户端先开了回合、本进程后启动）。起点取文档里首个 running 行的时间，
    // 不用 now()——否则 elapsed 会从「我们看见它」开始算。loading 期间到达的是重放历史
    //（见上），不在此列。
    // #217：内核表态可用时本启发式停用——他端先开回合的"是否在途"由内核回答（语义
    // 严格为「本进程已派发 prompt」），不再从实时帧采纳。
    if (!kernelAuthoritative && !binding.loading && isLiveTextDelta(incoming) && !clock.hasClock(envelope.sessionId)) {
      clock.start(envelope.sessionId, runningTailStartTime(currentBefore) ?? envelopeTime)
      clock.reconcile(envelope.sessionId)
    }
    // 每条 live envelope 刷新时钟活性（append-delta 不更新 message.time），并把刷新后的
    // lastTokenAt 一并写进快照。#390 之前 `touch` 只改时钟**内部**条目，快照里的
    // lastTokenAt 停在回合起点（文档派生那一路在 append-delta 下也不推进）⇒ 长流式回合里
    // `idleMs = now - lastTokenAt` 无界增长，页脚被顶成「等待响应 / 仍在等待后端响应」
    // （假 stalled），同时页脚也少了一条随帧推进的重绘驱动。
    const touchedAt = clock.touch(envelope.sessionId, envelopeTime)
    if (binding.loading) { binding.buffered.push(envelope); return }
    const liveness = clock.effectiveLiveness(envelope.sessionId)
    runtime.applyDocument(replay.foldEvent(envelope), {
      ownerKey: binding.ownerKey,
      generation: binding.generation,
      turnEpoch: binding.turnEpoch,
      terminalFence: isUserStart ? null : undefined,
      preserveGeneration: true,
      livenessSource: liveness.source,
      livenessGenerating: liveness.generating,
      ...(touchedAt !== undefined ? { generationPatch: { lastTokenAt: touchedAt } } : {}),
    })
  }

  // P52 D3/#442 Step3：终态结算族（feed 终帧 + window 广播兜底 + 账本 settle 主轨）
  // 拆入 agentWorkbenchTurnLifecycle.ts——TurnClock 幂等吸收双到，这里只持退订把手。
  const turnLifecycle = createAgentWorkbenchTurnLifecycle({
    clock,
    listenTerminalFallback,
    listenTurnSettled,
  })
  const unsubscribeEvents = subscribe(event => {
    if (binding.destroyed || !binding.ownerKey || !binding.source || !event || typeof event !== 'object') return
    const candidate = event as { owner?: Parameters<typeof toCanonicalOwnerKey>[0]; sessionId?: unknown }
    const matchesOwner = candidate.owner ? toCanonicalOwnerKey(candidate.owner) === binding.ownerKey : candidate.sessionId === binding.source
    if (!matchesOwner) return
    const envelopes = toWorkbenchEnvelopes(event)
    if (envelopes.length > 0) {
      if (draft.reconcilePending) draft.liveDuringReconcile.push(...envelopes)
      envelopes.forEach(applyLive)
    }
    else {
      binding.malformedCount += 1
      fold.journalDiagnosticCount = binding.malformedCount
      if (!binding.loading) {
        const snapshot = runtime.getSnapshot()
        if (snapshot.document) runtime.replaceDocument(withJournalDiagnostic(snapshot.document, binding.malformedCount), {
          ownerKey: binding.ownerKey, generation: binding.generation, sessionId: snapshot.sessionId,
        })
        updateRuntimeState({ status: 'degraded', error: `canonical journal 有 ${binding.malformedCount} 条事件无法迁移` })
      }
    }
  })

  const feed = getCanonicalEventFeed()
  const unsubscribeDraftChunks = feed.onDraftChunk(drafts.applyDraftChunk)
  const unsubscribeDraftCommits = feed.onDraftCommit((ownerKey, draftId) => {
    if (binding.destroyed || binding.ownerKey !== ownerKey || !draft.activeIds.has(draftId)) return
    const session = binding.boundSession
    if (!session) return
    draft.reconcilePending = true
    void (async () => {
      if (binding.refreshInFlight) await binding.refreshInFlight.catch(() => {})
      if (binding.destroyed || binding.boundSession !== session) return
      draft.reconcilePending = true
      await replay.refresh(session)
    })()
  })
  const commandsWithDraft = {
    ...commands,
    async resolveDraft(sessionId: string, draftId: string, action: 'keep' | 'discard') {
      if (binding.destroyed || binding.boundSessionId !== sessionId || !binding.ownerKey
        || !binding.boundSession || !draft.interruptedIds.has(draftId)) {
        return { ok: false, error: 'draft_not_bound' }
      }
      const ownerKey = binding.ownerKey
      const session = binding.boundSession
      try {
        if (action === 'keep') await keepInterruptedDraft(ownerKey, draftId)
        else if (!await discardInterruptedDraft(ownerKey, draftId)) return { ok: false, error: 'draft_not_found' }
        if (binding.refreshInFlight) await binding.refreshInFlight
        draft.reconcilePending = true
        await replay.refresh(session)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  return {
    runtime, appearance, sessionUi, commands: commandsWithDraft,
    /**
     * Project the response of the atomic `new_session` command into the same
     * disposable Workbench document used by canonical/live events.  This is a
     * transient bridge: it never appends to SQLite or the canonical journal.
     * The optional local Session.id lets callers publish before the Solid
     * host's bind runs; the response is buffered and consumed by bind().
     */
    applySessionResponse,
    runSessionControl,
    applyLocalSessionFact,
    refresh: replay.refresh,
    async bind(session: Session | undefined): Promise<void> {
      const nextBindingKey = workbenchSessionBindingKey(session)
      // 幂等检查保持同步 no-op；折叠出口的就绪等待放在**同步状态前缀之后**：
      // boundSessionId/source 必须在本函数首个 await 前就位（发送入口的乐观投影
      // 依赖它们判定「已绑定」），Node 宿主的 wasm 导入即就绪，浏览器端在此补一次
      // 异步等待，后续 folding 都在就绪之后。
      if (binding.boundSessionBindingKey === nextBindingKey) return
      // #520 S2-P1-2：绑定目标切换时，若原会话已被删除（identity store 已无此行——
      // 会话消失的唯一途径），回收其会话级 UI 条目，对齐 destroy() 的 sessionUi 清理
      // 语义（keep-alive sheet 的会话在他处被删时不再残留）；切往仍存在的会话则保留
      // 条目，切回恢复草稿不丢。
      if (binding.boundSessionId !== undefined && binding.boundSessionId !== session?.id
        && !useIdentityStore.getState().sessions.some(row => row.id === binding.boundSessionId)) {
        sessionUi.clear(binding.boundSessionId)
      }
      // Session objects are recreated for ordinary metadata updates (name,
      // lastReplyAt, autoName) and when canonical replay completes. Rebinding
      // in those cases replaces the whole document and looks like a page
      // refresh. Keep this seam idempotent; explicit identity changes still
      // pass through the normal reload path below. Workspace reloads use the
      // dedicated lifecycle/reload-token seam instead of rebinding here.
      binding.boundSessionBindingKey = nextBindingKey
      // Invalidate any in-flight refresh for the previous binding. Its own
      // epoch/key guard will make the eventual result a no-op; clearing the
      // pointer lets the new binding schedule its own refresh immediately.
      binding.canonicalReadEpoch += 1
      binding.refreshInFlight = null
      const nextGeneration = ++binding.generation
      // #375-a：按逃生口置位 timeline.data 收窄（投影核保持纯函数，DOM 判决留在宿主）。
      setTimelinePayloadNarrowing(!timelinePayloadNarrowingDisabled())
      // #204 ②：`turnEpoch` 是 runtime 局部的**单调**围栏（`workbenchRuntime.acceptDocument`
      // 对 live 帧执行 `options.turnEpoch < snapshot.turnEpoch` 即拒收）。绑定重建不得把它
      // 回落为 0——切回时 snapshot 的 epoch 仍停在切走前那一轮，回落会让切回后到达的思考帧
      // 被静默丢弃（正文截断在切换点），并在终帧后的 journal 重折里另起一块（思考块分裂）。
      // 这里承接当前值，新回合仍由 applyLive 的 user 帧推进（`turnEpoch += 1`）。
      binding.turnEpoch = runtime.getSnapshot().turnEpoch ?? 0
      binding.boundSessionId = session?.id
      binding.boundSession = session
      binding.boundProvider = session?.agentId || 'acp'
      binding.source = session?.source
      binding.ownerKey = session ? toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }) : undefined
      binding.buffered = []
      draft.seen.clear(); draft.activeIds.clear(); draft.interruptedIds.clear()
      draft.reconcilePending = false; draft.liveDuringReconcile = []
      binding.malformedCount = 0
      fold.journalDiagnosticCount = 0
      // 绑定重建：文档由下面的整页折从空文档起（#380 起不再需要清「折叠日志」——它已删除）。
      binding.loading = Boolean(session)
      // #217：空文档的活性申报走有效权威（内核表态随 source 的 map 跨 rebind 保留；
      // 无表态回退时钟，语义与 #213 一致）。
      const bindLiveness = clock.effectiveLiveness(session?.source ?? '')
      runtime.replaceDocument(createWorkbenchDocument(session?.source ?? ''), {
        ownerKey: binding.ownerKey ?? `unbound:${nextGeneration}`, generation: nextGeneration, turnEpoch: binding.turnEpoch, terminalFence: null, sessionId: session?.id ?? null,
        // #213：**必须**随这发空文档申报权威值。不申报时 merge 会继承上一个会话的
        // `livenessSource`/`generating`（切走一个在途会话 ⇒ 空文档带 generating:true 发布一拍，
        // 页脚闪一次 spinner、调度器还会按"直播"处理）。
        livenessSource: bindLiveness.source,
        livenessGenerating: bindLiveness.generating,
      })
      if (session) {
        const pendingResponses = [
          ...(pendingSessionResponses.get(session.id) ?? []),
          ...(pendingSessionResponses.get(session.source) ?? []),
        ]
        pendingSessionResponses.delete(session.id)
        pendingSessionResponses.delete(session.source)
        for (const item of pendingResponses) enqueueSessionResponse(item.response, session.id, item.syntheticReason)
      }
      // P52 D3：bind 重置读 TurnClock——时钟按 source 隔离，切回同 source 的
      // 活动回合恢复（reconcileTurnClock 在 journal 读完成后执行）。
      // #217：内核已表态「不在途」时，活动时钟不得顶起生成态（权威让位）。
      const activeClock = binding.source ? clock.activeUnsettledClock(binding.source) : undefined
      updateRuntimeState({
        status: binding.loading ? 'loading' : 'idle', error: null,
        ...(activeClock
          ? { generating: true, generationStart: activeClock.generationStart, lastTokenAt: activeClock.lastTokenAt, summary: null }
          : { generating: false, generationStart: 0, lastTokenAt: undefined, generationPhase: undefined, generationActivity: undefined, thinkingStart: undefined, summary: null }),
      })
      if (!session || !binding.ownerKey) return
      const loadingOwnerKey = binding.ownerKey
      const bindReadEpoch = binding.canonicalReadEpoch
      // #390：读的发起时刻——封存新鲜度守卫的锚点。切页/切回时本 source 上仍在途的
      // 回合，其时钟的 lastTokenAt 会晚于这个时刻 ⇒ 该读不得把在途判成收敛。
      const bindReadStartedAt = Date.now()
      const staleBindRead = (): boolean => (binding.destroyed || binding.generation !== nextGeneration || binding.ownerKey !== loadingOwnerKey
        || binding.canonicalReadEpoch !== bindReadEpoch)
      // #376-b：分页冷装载——逐页折进同一份文档，页内行与信封折完即可回收。发布（status
      // 收敛、时钟封存、账本证据）只做一次，在最后一页。装载失败仍走同一条 catch。
      await (async () => {
        if (!listJournalPages) {
          // 一次性装载（既有测试与浏览器快照轨）：收集全部行与信封后折一页。
          const rows = await loadAll(loadingOwnerKey)
          if (staleBindRead()) return
          const fragments = await loadDrafts(loadingOwnerKey)
          if (staleBindRead()) return
          const envelopes: WorkbenchEventEnvelope[] = []
          replay.collectRowsInto(envelopes, rows)
          envelopes.push(...drafts.projectRecoveredDrafts(fragments, replay.maxRowSequence(rows)))
          const browserSnapshot = (isBrowserMockRuntime() || !IS_TAURI) && rows.length === 0 && typeof localStorage !== 'undefined'
            ? (() => {
              const byId = parseMessageSnapshot<Message>(localStorage.getItem(messageStorageKey(session.id)))
              const bySource = parseMessageSnapshot<Message>(localStorage.getItem(messageStorageKey(session.source)))
              return messageSnapshotToWorkbenchEnvelopes(session.source, byId && byId.length > 0 ? byId : bySource ?? [])
            })()
            : []
          replay.collectRowsInto(envelopes, browserSnapshot)
          if (binding.malformedCount > 0) fold.journalDiagnosticCount = binding.malformedCount
          replay.publishCanonicalRead({
            readSource: session.source,
            readOwnerKey: loadingOwnerKey,
            readGeneration: nextGeneration,
            readSessionId: session.id,
            envelopes,
            bufferedAtRead: binding.buffered,
            base: createWorkbenchDocument(session.source),
            malformedCount: binding.malformedCount,
            canonicalDuration: canonicalDurationFromRows(rows),
            canonicalLatestBoundary: canonicalLatestBoundaryFromRows(rows),
            readStartedAt: bindReadStartedAt,
            withLedgerEvidence: false,
          })
          return
        }
        // 分页：行/信封只在页内存在。终态判据与首屏事实都必须**跨页累积**——
        // 与一次性路径的唯一已知差异：`binding.buffered`（装载期间到达的实时帧）在这里走
        // 第二次 foldPage，按到达序折；一次性路径把它们并进同一个批次按 sequence 排序折。
        // 两者只在「缓冲帧的 sequence 低于尚未读到的后续页」这种乱序角落里分叉，而缓冲帧
        // 恒为瞬态/会话响应（sequence > revision），故实际等价（评审 R2 已核）。
        // 只按末页算会把早先页里的终态行判丢（summary / 时钟封存随之错）。
        const boundaryRows: ReturnType<typeof canonicalBoundaryProjection> = []
        let maxSequence = 0
        let document = createWorkbenchDocument(session.source)
        let lastPageEnvelopes: WorkbenchEventEnvelope[] = []
        let fragments: readonly CanonicalDraftFragment[] = []
        await listJournalPages(loadingOwnerKey, async (rows, lastPage) => {
          if (staleBindRead()) return
          if (lastPage) fragments = await loadDrafts(loadingOwnerKey)
          if (staleBindRead()) return
          const envelopes: WorkbenchEventEnvelope[] = []
          replay.collectRowsInto(envelopes, rows)
          for (const row of rows) {
            const sequence = row && typeof row === 'object' && 'sequence' in row ? Number(row.sequence) : 0
            if (Number.isSafeInteger(sequence)) maxSequence = Math.max(maxSequence, sequence)
          }
          boundaryRows.push(...canonicalBoundaryProjection(rows))
          if (lastPage) {
            envelopes.push(...drafts.projectRecoveredDrafts(fragments, maxSequence))
            const browserSnapshot = (isBrowserMockRuntime() || !IS_TAURI) && rows.length === 0 && typeof localStorage !== 'undefined'
              ? (() => {
                const byId = parseMessageSnapshot<Message>(localStorage.getItem(messageStorageKey(session.id)))
                const bySource = parseMessageSnapshot<Message>(localStorage.getItem(messageStorageKey(session.source)))
                return messageSnapshotToWorkbenchEnvelopes(session.source, byId && byId.length > 0 ? byId : bySource ?? [])
              })()
              : []
            replay.collectRowsInto(envelopes, browserSnapshot)
          }
          lastPageEnvelopes = envelopes
          document = replay.foldPage(envelopes, document)
        })
        if (staleBindRead()) return
        if (binding.malformedCount > 0) fold.journalDiagnosticCount = binding.malformedCount
        const finalEnvelopes = binding.buffered.length === 0 ? lastPageEnvelopes : [...lastPageEnvelopes, ...binding.buffered]
        replay.publishFoldedDocument({
          readSource: session.source,
          readOwnerKey: loadingOwnerKey,
          readGeneration: nextGeneration,
          readSessionId: session.id,
          projected: finalEnvelopes === lastPageEnvelopes ? document : replay.foldPage(binding.buffered, document),
          readEnvelopes: finalEnvelopes,
          malformedCount: binding.malformedCount,
          canonicalDuration: canonicalDurationFromRows(boundaryRows),
          canonicalLatestBoundary: canonicalLatestBoundaryFromRows(boundaryRows),
          readStartedAt: bindReadStartedAt,
          withLedgerEvidence: false,
        })
      })().catch(error => {
        if (binding.destroyed || binding.generation !== nextGeneration || binding.ownerKey !== loadingOwnerKey
          || binding.canonicalReadEpoch !== bindReadEpoch) return
        binding.loading = false
        binding.buffered = []
        updateRuntimeState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      })
    },
    destroy() {
      if (binding.destroyed) return
      binding.destroyed = true
      turnLifecycle.dispose(); unsubscribeEvents()
      unsubscribeDraftChunks(); unsubscribeDraftCommits(); unsubscribeSessionTitle()
      runtime.destroy(); appearance.destroy(); sessionUi.destroy()
      pendingSessionResponses.clear(); appliedSessionResponseKeys.clear(); transientSequenceBySource.clear()
      clock.clearAll(); echo.clear()
    },
  }
}
