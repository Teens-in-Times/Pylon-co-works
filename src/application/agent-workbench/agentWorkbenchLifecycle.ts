/**
 * agentWorkbenchLifecycle — 会话生命周期 IPC 编排（P52 D4）。
 *
 * 从 useSessionLifecycle.ts 迁入（行为保真），controller 依赖全部退役：
 * - new_session 链：preflight → sessionClient.newSession → setSessionPeriId →
 *   setBindingGeneration → 错误上报（重试走 bumpSessionReload）；
 * - load_persisted_session 链：session.loading/loaded hooks、ReplayLoadCoordinator
 *   （owner 拒绝/authority/commit 决策保留；commit 的 UI 投影随 controller 死亡，
 *   adapter 退化为 seed-only + no-op）、replay trace（load-start/response/commit/error
 *   全量保留）、错误降级（空缓存上报 / 非空缓存诊断）；
 * - 首屏占位：canonical journal 投影读取 + 失败上报（迟到失败不污染新会话）；
 * - refresh 信号：canonicalRefresh → 宿主调 sessionRuntime.refresh（绑定链保真）。
 *
 * 框架无关：宿主 AgentRendererSuiteWorkbench 以 bind 效应驱动。
 */
import { appClients } from '../../app/appClients.ts'
import { IS_TAURI, isBrowserMockRuntime } from '../../infrastructure/tauri/env.ts'
import { useIdentityStore, type Session } from '../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore.ts'
import { reportRuntimeDiagnostic, reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import type { ColdMountTurnSnapshot, PersistedTurnBoundary, ReplayMetadata } from '../../infrastructure/acp/sessionClient.ts'
import { sessionResponseObject } from '../../infrastructure/acp/chatContracts.ts'
import { applySessionStateResponse } from '../../domains/session/sessionStateSync.ts'
import { CHAT_REPLAY_TRACE_CONTRACT, recordChatReplayTrace, replayErrorCode, safeContentEvidence } from '../../domains/chat/chatReplayTrace.ts'
import { clearMessageStorage } from '../../domains/chat/messagePersistence.ts'
import { sessionContext } from '../../domains/agent/agentContext.ts'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'
import { loadCanonicalEventsIncremental, tauriCanonicalEventRepository } from '../../infrastructure/events/canonicalEventRepository.ts'
import type { CanonicalEventRow } from '../../domains/events/canonicalEventRow.ts'
import { getCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'
import { requestNewSession } from '../../application/transactions/requestNewSession.ts'
import { collectProfilePersona } from '../../plugins/core/sessionCreation/builtinSessionCreation.ts'
import { ReplayLoadCoordinator } from '../../domains/chat/chatReplayCoordinator.ts'
import type { Message } from '../../domains/chat/messageTypes.ts'

export interface SessionRecoveryFailure {
  sessionId: string
  source: string
  message: string
}

export interface SessionReplayIntegrity {
  sessionId: string
  metadata: ReplayMetadata
}

export interface AgentWorkbenchLifecycleOutcome {
  /** placeholder 读取完成（load 链已排程）；宿主无需消费 messages（journal 由
   * sessionRuntime.bind 的 loadAll 投影），仅时序信号。 */
  readonly kind: 'placeholder-read' | 'create-scheduled'
}

/** #110 F1：恢复等待 owner runtime 就绪的上限——超过则照常尝试（失败仍走既有
 * ErrorCenter 路径）。等不到不等于成功，也不无限挂起。 */
export const AGENT_READY_TIMEOUT_MS = 15_000

/** #110 F1：首败后的单次退避重试间隔。 */
export const RECOVERY_RETRY_DELAY_MS = 2_000

/**
 * owner runtime 是否就绪（#110 F1）。
 *
 * 只有**显式已知的非 connected** 状态才算未就绪：状态缺失/非字符串时返回 true
 * （不把「还不知道」当成「未就绪」，否则在没有状态源的环境里会把恢复永久挂起）。
 */
function agentRuntimeReady(agentId: string): boolean {
  const status = useRuntimeStore.getState().agentStatuses[agentId]
  if (!status || typeof status.status !== 'string') return true
  return status.status === 'connected'
}

/**
 * 等 owner runtime 就绪（#110 F1）。
 *
 * 冷启动实测：恢复请求比 hermes ACP `connected` 早 ~2.4s，恢复必然失败并留下
 * 「恢复会话失败」错误条（叠加 F4 即 #56 的完整现场）。因此恢复入口先排队等
 * `agentStatuses[agentId].status === 'connected'`——已就绪立即返回，未就绪则订阅
 * store 变更（agent_status 事件经 App 写入 runtimeStore）后重放判定。
 *
 * 会话已切换（`isCurrent()` 为假）时立即放弃等待，返回 false 由调用方静默返回。
 */
async function waitForAgentReady(agentId: string, isCurrent: () => boolean): Promise<boolean> {
  if (agentRuntimeReady(agentId)) return true
  const subscribe = useRuntimeStore.subscribe
  if (typeof subscribe !== 'function') return true
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      unsubscribe()
      clearTimeout(timer)
      resolve(ready)
    }
    const unsubscribe = subscribe(() => {
      if (!isCurrent()) return finish(false)
      if (agentRuntimeReady(agentId)) finish(true)
    })
    const timer = setTimeout(() => finish(agentRuntimeReady(agentId)), AGENT_READY_TIMEOUT_MS)
  })
}

/** P52 D4：controller 死后 replay commit 不再有 UI 投影意义——adapter 只保留
 * cursor 播种（canonicalEventFeed.seed）；lock/commit 语义退化 no-op。
 * 载荷（generation/authority/trace）仍在 coordinator 与返回的 outcome 中完整保留。 */
const replayAdapter = {
  beginLoadLock: () => 0,
  finishLoadLock: () => {},
  abortSessionLoad: () => {},
  commitReplaySnapshot: (_source: string, _generation: number, replay: unknown[]) => replay as Message[],
  commitCanonicalProjection: (_source: string, _generation: number, messages: Message[]) => messages,
  seedCanonicalCursor: (ownerKey: string, sequence: number) => getCanonicalEventFeed().seed(ownerKey, sequence),
}

export class AgentWorkbenchLifecycle {
  private readonly loadGenerations = new Map<string, number>()
  /** #110 F1：每 source 已用掉的退避重试次数（成功即清零，上限 1 次）。 */
  private readonly recoveryAttempts = new Map<string, number>()
  private readonly coordinator = new ReplayLoadCoordinator(replayAdapter)

  /** 当前绑定会话变更（宿主 bind 效应调用）：跑 new/load 链。
   * 返回值仅作时序信号；错误经 ErrorCenter 呈现。 */
  async activate(session: Session, options: { reloadToken?: number; isCurrent?: () => boolean }): Promise<AgentWorkbenchLifecycleOutcome | undefined> {
    if (!IS_TAURI || isBrowserMockRuntime()) {
      // Browser sessions restore these snapshots in sessionRuntime.bind().
      // Only the desktop canonical migration may discard legacy snapshots.
      return { kind: 'placeholder-read' }
    }
    const context = sessionContext(session)
    const ownerKey = toCanonicalOwnerKey({ profileId: session.profileId, agentId: session.agentId, localSessionId: session.source })
    const isCurrent = options.isCurrent ?? (() => true)

    // session.created：旧 session.start 经兼容桥执行；v2 原生 Hook 同步收到稳定新 phase。
    void this.invokeSessionStartHook(session)

    const profile = useIdentityStore.getState().profiles.find(p => p.id === session.profileId)
    const persona = collectProfilePersona(session.creationSnapshot) || profile?.persona || ''

    if (!session.periId) {
      await this.createSession(session, context, persona, isCurrent)
      return { kind: 'create-scheduled' }
    }

    // A1-c P4：先读 canonical_events 投影作为首屏占位（读失败按空缓存降级并可见
    // 上报），再走 load_persisted_session 权威恢复。localStorage 旧快照不再读写。
    // #81 L1 搭车：占位行保留为游标基线，权威恢复的 canonical 读改为增量补读
    // （不再整读第二遍；失败自动回退全量读，结果与全量重读逐行一致）。
    const placeholder = await this.coordinator.readCanonicalPlaceholder({
      ownerKey,
      // #81 L2：投影读走 compact（单元 + 未覆盖行）。
      loadCanonical: () => tauriCanonicalEventRepository().loadAllPreferUnits(ownerKey),
      projectCanonical: rows => projectMessagesFromCanonical(rows),
    }).catch((error: unknown): undefined => {
      // The canonical read can finish after a session switch/reload. A late
      // failure belongs to that abandoned generation and must not create a
      // notification for the currently visible session.
      if (!isCurrent()) return undefined
      reportRuntimeError(`读取 canonical 首屏占位失败（${session.id}）`, error, session.agentId, {
        key: `session-placeholder:${session.id}`,
        scope: { kind: 'session', id: session.id },
        source: 'chat.session-placeholder',
        recoveryAction: { label: '重试会话恢复', run: () => this.retryRecovery(session.id) },
      })
      return undefined
    })
    if (!isCurrent()) return undefined
    // D7：旧 localStorage 快照整体废弃——访问过该会话即清理旧 key，不再读写。
    clearMessageStorage(session.id, localStorage)
    // #110 F1：恢复不得早于 owner runtime 就绪（冷启动实测恢复比 ACP connected
    // 早 ~2.4s → 必然失败）。首屏占位已渲染，此处等待不给首帧加延迟。
    await waitForAgentReady(session.agentId, isCurrent)
    if (!isCurrent()) return undefined
    await this.startPersistedLoad(session, ownerKey, placeholder?.messages ?? [], isCurrent, placeholder?.rows)
    return { kind: 'placeholder-read' }
  }

  /** 会话删除后清理该 source 的 load generation（prune 等价物）。 */
  prune(sources: readonly string[]): void {
    for (const key of [...this.loadGenerations.keys()]) {
      if (!sources.includes(key)) this.loadGenerations.delete(key)
    }
    for (const key of [...this.recoveryAttempts.keys()]) {
      if (!sources.includes(key)) this.recoveryAttempts.delete(key)
    }
  }

  retryRecovery(sessionId: string): void {
    const session = useIdentityStore.getState().sessions.find(candidate => candidate.id === sessionId)
    if (!session) return
    useRuntimeStore.getState().bumpSessionReload(sessionContext(session))
  }

  private async invokeSessionStartHook(session: Session): Promise<void> {
    const { runSessionBoundaryHook } = await import('../../application/transactions/sessionHookTransactions.ts')
    void runSessionBoundaryHook('session.created', session)
  }

  private async createSession(session: Session, context: ReturnType<typeof sessionContext>, persona: string, isCurrent: () => boolean): Promise<void> {
    const loadGeneration = (this.loadGenerations.get(session.source) ?? 0) + 1
    this.loadGenerations.set(session.source, loadGeneration)
    const sessionClient = appClients.session()
    // OWNER-02：new_session 目标 owner = session.agentId（从 Session 读取）。
    // CWD-03：绑定 Workspace 时随 wire 发送 workspaceId（后端以 root_path 为 root 单一来源）。
    try {
      const response = await requestNewSession(session, sessionClient, () => ({
        persona,
        workspaceId: session.workspaceId || undefined,
        model: useIdentityStore.getState().profiles.find(p => p.id === session.profileId)?.model || undefined,
      }))
      if (this.loadGenerations.get(session.source) !== loadGeneration || !isCurrent()) return
      const res = sessionResponseObject(response)
      const periId = res.sessionId ?? res.periId
      if (periId) useIdentityStore.getState().setSessionPeriId(session.id, periId)
      applySessionStateResponse(context, res)
      // OWNER-04：new_session 成功 → 记录本次绑定建立时的 agent generation。
      useRuntimeStore.getState().setBindingGeneration(context, useRuntimeStore.getState().agentStatuses[session.agentId]?.generation)
      resolveRuntimeErrors({ key: `session-create:${session.id}`, source: 'chat.session-create' })
    }
    catch (error) {
      if (this.loadGenerations.get(session.source) !== loadGeneration || !isCurrent()) return
      reportRuntimeError('创建会话', error, session.agentId, {
        key: `session-create:${session.id}`,
        scope: { kind: 'session', id: session.id },
        source: 'chat.session-create',
        recoveryAction: { label: '重试会话恢复', run: () => this.retryRecovery(session.id) },
      })
    }
  }

  private async startPersistedLoad(
    session: Session,
    ownerKey: string,
    cached: Message[],
    isCurrent: () => boolean,
    placeholderRows?: readonly CanonicalEventRow[],
  ): Promise<void> {
    const sessionClient = appClients.session()
    // OWNER-02：load_persisted_session 目标 owner = session.agentId（从 Session 读取）。
    // CWD-03：绑定 Workspace 时随 wire 发送 workspaceId（后端以 root_path 为 root 单一来源）。
    void getHookRuntime().invoke('session.loading', { session, source: session.source }, session.hooks.length > 0 ? session.hooks : undefined)
    const pending = this.coordinator.load({
      source: session.source,
      ownerKey,
      cached,
      load: () => sessionClient.loadPersistedSession({ owner: { profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }, periId: session.periId, cwd: session.workdir || undefined, workspaceId: session.workspaceId || undefined }),
      // #81 L1：占位行可用时增量补读差量（省掉第二次全量 loadAll）；无占位基线
      // （首屏读取失败等）保持全量读。
      loadCanonical: () => placeholderRows
        ? loadCanonicalEventsIncremental(tauriCanonicalEventRepository(), ownerKey, placeholderRows)
        : tauriCanonicalEventRepository().loadAllPreferUnits(ownerKey),
      projectCanonical: rows => projectMessagesFromCanonical(rows),
      isCurrent,
    })
    const loadGeneration = this.coordinator.currentGeneration(session.source) ?? 0
    recordChatReplayTrace({
      kind: 'load-start', ownerSessionId: session.id, source: session.source, generation: loadGeneration,
      contract: CHAT_REPLAY_TRACE_CONTRACT, owner: ownerKey, loadGeneration,
      captureLp: 'active-replay-registry',
      ...safeContentEvidence(cached),
    })
    try {
      const outcome = await pending
      if (!outcome) return
      void getHookRuntime().invoke('session.loaded', { session, source: session.source }, session.hooks.length > 0 ? session.hooks : undefined)
      const res = sessionResponseObject(outcome.response)
      recordChatReplayTrace({
        kind: 'load-response',
        ownerSessionId: session.id, source: session.source, generation: loadGeneration,
        contract: CHAT_REPLAY_TRACE_CONTRACT,
        owner: ownerKey, loadGeneration,
        captureLp: 'active-replay-registry',
        responseBoundary: outcome.replayMetadata.boundary.kind,
        observedCount: outcome.replayMetadata.boundary.observedCount,
        retainedCount: outcome.replayCount,
        droppedCount: outcome.replayMetadata.droppedCount,
        authority: outcome.authority,
        canonicalRevision: outcome.canonicalRevision,
        detail: {
          replayCount: outcome.replayCount,
          replayComplete: outcome.replayMetadata.complete,
          replayTruncated: outcome.replayMetadata.truncated,
          replayDroppedCount: outcome.replayMetadata.droppedCount,
          replayBoundary: outcome.replayMetadata.boundary.kind,
          replayObservedCount: outcome.replayMetadata.boundary.observedCount,
          replayJournalStatus: outcome.replayJournalStatus,
          canonicalRevision: outcome.canonicalRevision,
        },
      })
      recordChatReplayTrace({
        kind: 'load-commit', ownerSessionId: session.id, source: session.source, generation: loadGeneration,
        contract: CHAT_REPLAY_TRACE_CONTRACT, owner: ownerKey, loadGeneration,
        captureLp: 'active-replay-registry',
        responseBoundary: outcome.replayMetadata.boundary.kind,
        observedCount: outcome.replayMetadata.boundary.observedCount,
        retainedCount: outcome.replayCount,
        droppedCount: outcome.replayMetadata.droppedCount,
        authority: outcome.authority,
        canonicalRevision: outcome.canonicalRevision,
        commitOutcome: outcome.commit,
        detail: { commit: outcome.commit, authority: outcome.authority, canonicalRevision: outcome.canonicalRevision },
        ...safeContentEvidence(outcome.messages),
      })
      resolveRuntimeErrors({ action: '恢复会话', scope: { kind: 'session', id: session.id }, source: 'chat.session-recovery' })
      resolveRuntimeErrors({ key: `session-recovery:${session.id}`, source: 'chat.session-recovery' })
      resolveRuntimeErrors({ key: `session-placeholder:${session.id}`, source: 'chat.session-placeholder' })
      this.recoveryAttempts.delete(session.source)
      applySessionStateResponse(sessionContext(session), res)
      // #358：复活的协商目录也必须作为**协商事实**进文档面。建会话路径把 new_session 响应
      // 同时交给 session-state 与工作台文档（投影成 `session.started`，`sessionResponseProjection.ts`），
      // 而 `WorkbenchDocumentSurface` 的守卫正是靠这条事实才不把 model / mode 目录渲染成会话下方的
      // 第二份配置表单；load 路径此前只同步前者，于是复活会话的目录卡片消不掉。
      this.onSessionLoadResponse?.(session, res)
      // OWNER-04：load_persisted_session 成功 → 记录本次绑定重建时的 agent generation。
      // 上次绑定的 generation 已不同（重连/替换）时，旧 binding 必须 Invalidated。
      useRuntimeStore.getState().setBindingGeneration(sessionContext(session), useRuntimeStore.getState().agentStatuses[session.agentId]?.generation)
      // load 后 canonical journal 可能发现 bind 读漏掉的终态事件——通知宿主 refresh。
      // #99 账本快照随 outcome 一起交宿主：journal 读可能早于终态行落盘，账本是
      // 不依赖一次性 Tauri event 的终态证据（见 refresh 的 ledgerTurn 说明）。
      // #442 Step1：权威 turnBoundary 一并交下（「或」判定在字段可用时退役）。
      this.onCanonicalRefresh?.(session, outcome.canonicalRevision, outcome.turn, outcome.turnBoundary)
    }
    catch (error) {
      if (this.coordinator.currentGeneration(session.source) !== loadGeneration) return
      if (!isCurrent()) return
      recordChatReplayTrace({
        kind: 'load-error', ownerSessionId: session.id, source: session.source, generation: loadGeneration,
        contract: CHAT_REPLAY_TRACE_CONTRACT, owner: ownerKey, loadGeneration,
        captureLp: 'active-replay-registry', responseBoundary: 'not-observed',
        observedCount: 0, retainedCount: 0, droppedCount: 0,
        authority: 'none', canonicalRevision: 0, commitOutcome: 'load-error',
        errorCode: replayErrorCode(error),
      })
      const options = {
        key: `session-recovery:${session.id}`,
        scope: { kind: 'session' as const, id: session.id },
        source: 'chat.session-recovery',
        recoveryAction: { label: '重试会话恢复', run: () => this.retryRecovery(session.id) },
      }
      // canonical 首屏占位已经提供可用历史时，远端 ACP replay 失败不应
      // 把底部错误条覆盖在可读会话上；用户仍可从 Runtime/ErrorCenter
      // 看到诊断并按需重试。空缓存时保留原有可操作失败提示。
      if (cached.length === 0) {
        reportRuntimeError('恢复会话', error, session.agentId, options)
      } else {
        reportRuntimeDiagnostic('恢复会话', error, session.agentId, options)
      }
      // #110 F1：首败保留上面这条 ErrorCenter 记录，并排一次退避自动重试——冷启动
      // 竞态的时间余量（本次取证里恢复正是碰巧由后续链路自动恢复的）。重试成功时
      // 上面的 resolveRuntimeErrors 会清掉该条；仍失败才停为手动重试。
      this.scheduleRecoveryRetry(session, ownerKey, cached, isCurrent, placeholderRows, loadGeneration)
    }
  }

  /**
   * #110 F1：单次退避重试排程。
   *
   * 守卫齐备才排：该 source 未用过重试额度、仍是当前 load generation、会话仍是
   * 当前绑定。任一不成立即放弃——重试不得覆盖用户此后的显式操作，也不得与更
   * 新的 load 竞争（coordinator 的 generation 是唯一权威）。
   */
  private scheduleRecoveryRetry(
    session: Session,
    ownerKey: string,
    cached: Message[],
    isCurrent: () => boolean,
    placeholderRows: readonly CanonicalEventRow[] | undefined,
    failedGeneration: number,
  ): void {
    const attempts = this.recoveryAttempts.get(session.source) ?? 0
    if (attempts >= 1) return
    this.recoveryAttempts.set(session.source, attempts + 1)
    setTimeout(() => {
      if (!isCurrent()) return
      if (this.coordinator.currentGeneration(session.source) !== failedGeneration) return
      void this.startPersistedLoad(session, ownerKey, cached, isCurrent, placeholderRows)
    }, RECOVERY_RETRY_DELAY_MS)
  }

  /** load 完成信号（宿主接 sessionRuntime.refresh）。 */
  onCanonicalRefresh?: (session: Session, canonicalRevision: number, turn?: ColdMountTurnSnapshot, turnBoundary?: PersistedTurnBoundary) => void
  /** #358：load 成功后的会话响应（协商目录）交宿主投影进工作台文档；未接线时静默跳过。 */
  onSessionLoadResponse?: (session: Session, response: unknown) => void
}
