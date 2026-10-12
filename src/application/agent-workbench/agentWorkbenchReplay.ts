/**
 * Canonical replay / folding subsystem for the agent workbench session host
 * (#520 S3-P0-1): owns the page-fold projection seams (`foldPage`/`foldEvent`),
 * the #358 replay-negotiation fact synthesis, and the canonical reload chain
 * (`refresh` → `publishCanonicalRead` → `publishFoldedDocument`), including the
 * #376-b paged cold-load publication tail shared with the factory's `bind`.
 * Stateless with respect to lifecycle ownership: runtime/binding/clock/echo
 * come in as injected context; the factory (agentWorkbenchSession.ts) remains
 * the composition root and keeps the live/draft/terminal families.
 */
import type { Session } from '../../domains/identity/identityStore.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import {
  createWorkbenchDocument,
  projectWorkbench,
  reduceWorkbenchEvent,
  setTimelinePayloadNarrowing,
  type WorkbenchDocument,
} from '../../domains/workbench/workbenchProjector.ts'
import { timelinePayloadNarrowingDisabled } from '../../infrastructure/events/readPathSwitches.ts'
import { resolveGenerationLedgerTerminalReason } from '../../domains/workbench/generationLedgerSummary.ts'
import { resolveRuntimeErrors } from '../../app/runtimeError.ts'
import {
  canonicalDurationFromRows,
  canonicalLatestBoundaryFromRows,
  readWorkbenchRow,
  withJournalDiagnostic,
} from './agentWorkbenchProjection.ts'
import type { LatestTurnBoundary } from '../../domains/events/canonicalTurnDuration.ts'
import type { PersistedTurnBoundary } from '../../infrastructure/acp/sessionClient.ts'
import type { CanonicalDraftFragment } from '../../infrastructure/events/canonicalEventRepository.ts'
import type { WorkbenchRuntime, RuntimeStatePatch, AgentWorkbenchTurnClock } from './agentWorkbenchTurnClock.ts'
import type { AgentWorkbenchBindingState } from './agentWorkbenchOptimisticEcho.ts'
import type { AgentWorkbenchDraftState } from './agentWorkbenchDrafts.ts'
import type { createSessionUiStore } from '../../domains/workbench/sessionUiStore.ts'

/** Fields that define the Workbench binding. Presentation-only Session metadata
 * (name, lastReplyAt, autoName, etc.) must not rebuild the live document.
 * Workspace and remote binding metadata are updated through their own reload
 * seams; they are not document identity and must not reset an active stream. */
export function workbenchSessionBindingKey(session: Session | undefined): string {
  if (!session) return 'unbound'
  return [
    session.id,
    session.source,
    session.agentId,
    session.profileId,
  ].join('\u0000')
}

/** `publishCanonicalRead` 的输入（refresh 与 bind 冷装载共用）。 */
export interface CanonicalReadInput {
  readSource: string
  readOwnerKey: string
  readGeneration: number
  readSessionId: string
  envelopes: readonly WorkbenchEventEnvelope[]
  bufferedAtRead: readonly WorkbenchEventEnvelope[]
  base: WorkbenchDocument
  malformedCount: number
  canonicalDuration: ReturnType<typeof canonicalDurationFromRows>
  /** #390：回合作用域的终态判据（只看最新回合边界），不得用回合无关的「历史曾终态」。 */
  canonicalLatestBoundary: LatestTurnBoundary
  /**
   * #442 Step1：后端权威 turnBoundary（load 响应随行）。可用时替代 journal
   * 扫描与跨源「或」判定；缺省 = 回退轨（journal 扫描 + 账本归档「或」）。
   */
  turnBoundary?: PersistedTurnBoundary
  /** #390：本次读的发起时刻——封存新鲜度守卫的锚点。 */
  readStartedAt: number
  withLedgerEvidence: boolean
}

/** `publishFoldedDocument` 的输入（已折好的文档；语义见函数注释）。 */
export interface FoldedDocumentInput {
  readSource: string
  readOwnerKey: string
  readGeneration: number
  readSessionId: string
  projected: WorkbenchDocument
  readEnvelopes: readonly WorkbenchEventEnvelope[]
  malformedCount: number
  canonicalDuration: ReturnType<typeof canonicalDurationFromRows>
  canonicalLatestBoundary: LatestTurnBoundary
  /** #442 Step1：后端权威回合边界（refresh 随 load 响应携入；缺省 = 回退轨）。 */
  turnBoundary?: PersistedTurnBoundary
  readStartedAt: number
  withLedgerEvidence: boolean
}

export interface AgentWorkbenchReplayDeps {
  runtime: WorkbenchRuntime
  binding: AgentWorkbenchBindingState
  /** 宿主侧 overlay 计数（journal 解析失败诊断）；bind 与事件通道负责重置。 */
  fold: { journalDiagnosticCount: number }
  sessionUi: ReturnType<typeof createSessionUiStore>
  clock: AgentWorkbenchTurnClock
  updateRuntimeState: (patch: RuntimeStatePatch) => void
  /** 仍 pending 的乐观行补折（宿主 echo 子系统；晚绑定，调用时 echo 已就绪）。 */
  withPending(targetSource: string, base: WorkbenchDocument): WorkbenchDocument
  /** 草稿应用族（agentWorkbenchDrafts.ts）：发布前标记 + 重读期碎片投影。 */
  drafts: {
    withInterruptedDraftMarker(document: WorkbenchDocument, envelopes: readonly WorkbenchEventEnvelope[]): WorkbenchDocument
    projectRecoveredDrafts(fragments: readonly CanonicalDraftFragment[], startSequence: number): WorkbenchEventEnvelope[]
  }
  /** 草稿去重/续写状态（refresh 的 reconcile 记账直接读写；与草稿子系统共享）。 */
  draft: AgentWorkbenchDraftState
  /** 宿主持有的瞬态序列记账（replay 协商事实与 session-response/local-fact 共用）。 */
  transientSequenceBySource: Map<string, number>
  loadAll(ownerKey: string): Promise<readonly unknown[]>
  loadDrafts(ownerKey: string): Promise<readonly CanonicalDraftFragment[]>
}

export interface AgentWorkbenchReplay {
  foldPage(envelopes: readonly WorkbenchEventEnvelope[], base?: WorkbenchDocument): WorkbenchDocument
  foldEvent(envelope: WorkbenchEventEnvelope, base?: WorkbenchDocument): WorkbenchDocument
  publishCanonicalRead(input: CanonicalReadInput): void
  publishFoldedDocument(input: FoldedDocumentInput): void
  /** 行 → 信封（#205：按序直接收集）；读取失败计入 malformed，成功空投影不计。 */
  collectRowsInto(target: WorkbenchEventEnvelope[], rows: readonly unknown[]): void
  maxRowSequence(rows: readonly unknown[]): number
  refresh(
    session: Session | undefined,
    ledgerTurn?: unknown,
    options?: { rebuild?: boolean; turnBoundary?: PersistedTurnBoundary },
  ): Promise<void>
}

export function createAgentWorkbenchReplay(deps: AgentWorkbenchReplayDeps): AgentWorkbenchReplay {
  const { runtime, binding, fold, sessionUi, clock, updateRuntimeState, draft, transientSequenceBySource, loadAll, loadDrafts } = deps

  /**
   * 页级折叠（**TS 纯函数投影核**）：一页一次「文档入、文档出」。
   *
   * 2026-09-21 投影自 wasm 回退 TS（判决与依据见 ADR-0018 的 scope 修订）：wasm 投影在现实
   * 入口只有 1.12×、页级 1.92×，而文档必须在核里与 JS 里**各存一份**（持有成本 4.4–6.1×）
   * —— 换来的是负收益。回退后文档只有一份，也再没有「核就绪」这回事。
   *
   * `base` 的语义是**承重的**，别一律省：
   * - 缺省 = 续折当前文档（live / session-response / refresh 的语义）；
   * - **冷装载（bind）与回滚重折必须显式传新的空文档** —— 那是「重建」不是「续折」；
   *   上游那条「审核修复：恢复基线的 `initialDocument: current`」指的就是这里别传错。
   */
  const foldPage = (
    envelopes: readonly WorkbenchEventEnvelope[],
    base?: WorkbenchDocument,
  ): WorkbenchDocument => {
    // #375-a：逃生口按**每次折页**求值（不是在 bind 时求一次）——工作台内部的皮肤/插件在
    // 挂载后挂上的属性才算「现场抢救」；只在 bind 求值会让它对会话中途挂上的属性不可达。
    // 一次 querySelector 相对整页投影可忽略。
    setTimelinePayloadNarrowing(!timelinePayloadNarrowingDisabled())
    const initial = base ?? runtime.getSnapshot().document ?? createWorkbenchDocument(binding.source ?? '')
    const projected = projectWorkbench(envelopes, { initialDocument: initial }).document
    return fold.journalDiagnosticCount > 0 ? withJournalDiagnostic(projected, fold.journalDiagnosticCount) : projected
  }

  /**
   * 单事件折叠（live 路径）：走**单事件归约器**而不是 `foldPage([one])`。
   * 页级入口为取得工作数组所有权会整份复制 timeline（#205 的优化），逐事件用它就是
   * Θ(N²) —— 这正是 #205 当初把 live 从页级入口挪开的原因，不要合流。
   */
  const foldEvent = (
    envelope: WorkbenchEventEnvelope,
    base?: WorkbenchDocument,
  ): WorkbenchDocument => {
    const current = base ?? runtime.getSnapshot().document ?? createWorkbenchDocument(binding.source ?? '')
    const next = reduceWorkbenchEvent(current, envelope)
    if (binding.boundSessionId && (next.session.model !== current.session.model || next.session.mode !== current.session.mode || next.session.options !== current.session.options)) {
      sessionUi.set(binding.boundSessionId, 'selector-pending', '')
    }
    return next
  }

  /**
   * #358：复活会话的协商事实**不能只等 load 响应**——首屏 journal 回放先于响应到达，
   * load 失败/重试期间它更不会来，于是 `WorkbenchDocumentSurface` 的守卫前提一直为假，
   * model / mode 目录常驻会话下方（用户报的「怎么也消不掉」）。
   *
   * 已持久化会话（有 remote id ⇒ 历史来自 journal 回放，而非本进程新建）回放出来的
   * 目录，就是该会话的协商事实。这里补一条合成 `session.started`：**不带 `status`**，
   * 只交出守卫与中控需要的目录，不碰会话状态机（`status` 由 replayed/内核事实决定）。
   * 时间线已有该事实（建会话路径或 load 响应写过）时不重复投影。
   */
  const withReplayNegotiationFact = (document: WorkbenchDocument): WorkbenchDocument => {
    const source = binding.source
    if (!source || !binding.boundSession?.periId) return document
    const options = document.session.options
    if (options.length === 0) return document
    if (document.timeline.some(entry => entry.kind === 'session'
      && (entry.data as { type?: unknown } | undefined)?.type === 'session.started')) return document
    const sequence = Math.max(document.revision, transientSequenceBySource.get(source) ?? 0) + 1
    transientSequenceBySource.set(source, sequence)
    const envelope = createWorkbenchEnvelope({
      eventId: `session-replay-negotiation:${source}:${sequence}`,
      sessionId: source,
      sequence,
      recordedAt: new Date().toISOString(),
      source: { provider: binding.boundProvider || 'acp', sourceId: `session-replay-negotiation:${sequence}` },
      identity: { runId: `session-replay-negotiation:${sequence}` },
      provenance: {
        origin: 'local-observed',
        trust: 'authoritative',
        provider: binding.boundProvider || 'acp',
        orderConfidence: 'observed',
        synthetic: { reason: 'session-replay-negotiation' },
      },
      event: {
        type: 'session.started',
        ...(document.session.model ? { model: document.session.model } : {}),
        ...(document.session.mode ? { mode: document.session.mode } : {}),
        // 展开成匿名对象类型：SessionConfigOption 是 interface（无 index signature），
        // 直接放进 `readonly JsonValue[]` 过不了 tsc；语义逐字段保持。
        options: options.map(option => ({ ...option })),
      },
    })
    return foldPage([envelope], document)
  }

  /**
   * 行 → 信封（#205：按序直接收集，不先 concat 再 flatMap）；不可迁移的行计入 malformed。
   * #376-b：分页装载下这个数组只活一页，折完即回收。
   */
  const collectRowsInto = (target: WorkbenchEventEnvelope[], rows: readonly unknown[]): void => {
    for (const row of rows) {
      const read = readWorkbenchRow(row)
      if (!read.ok) {
        binding.malformedCount += 1
        continue
      }
      for (const envelope of read.envelopes) target.push(envelope)
    }
  }

  const maxRowSequence = (rows: readonly unknown[]): number => rows.reduce<number>((max, row) => {
    const sequence = row && typeof row === 'object' && 'sequence' in row ? Number(row.sequence) : 0
    return Math.max(max, Number.isSafeInteger(sequence) ? sequence : 0)
  }, 0)

  /**
   * Canonical 重载/冷装载的成功尾巴（refresh 与 bind 的共享发布路径）：把折好的
   * 文档替换进 runtime、按权威活性申报、收敛时钟与账本证据、按需发布 display-only
   * 摘要。`withLedgerEvidence` 区分两条路——refresh 携带 #99 账本快照（bind 不据
   * journal 终态**行**置内核表态，内核事实只来自冷挂载快照的 turnInFlight/账本、
   * 终帧与本地生命周期）。
   */
  const publishCanonicalRead = (input: CanonicalReadInput): void => {
    const readEnvelopes = input.bufferedAtRead.length === 0 ? input.envelopes : [...input.envelopes, ...input.bufferedAtRead]
    const projected = foldPage(readEnvelopes, input.base)
    publishFoldedDocument({ ...input, projected, readEnvelopes })
  }

  /**
   * 发布**已折好**的文档：`publishCanonicalRead` 的成功尾巴。抽出来是为了让 #376-b 的
   * 分页冷装载能在最后一页一次发布（前面各页只折不发，避免中途把 status 打成 ready、
   * 拿半份 journal 去封存时钟）。语义与原来逐字相同。
   */
  const publishFoldedDocument = (input: FoldedDocumentInput): void => {
    const readEnvelopes = input.readEnvelopes
    const reconciled = deps.withPending(input.readSource, input.projected)
    const document = withReplayNegotiationFact(deps.drafts.withInterruptedDraftMarker(
      input.malformedCount > 0 ? withJournalDiagnostic(reconciled, input.malformedCount) : reconciled,
      readEnvelopes,
    ))
    binding.buffered = []
    binding.loading = false
    const readLiveness = clock.effectiveLiveness(input.readSource)
    runtime.replaceDocument(document, {
      ownerKey: input.readOwnerKey,
      generation: input.readGeneration,
      sessionId: input.readSessionId,
      livenessSource: readLiveness.source,
      livenessGenerating: readLiveness.generating,
    })
    if (input.malformedCount > 0) {
      updateRuntimeState({ status: 'degraded', error: `canonical journal 有 ${input.malformedCount} 条事件无法解析` })
    } else {
      updateRuntimeState({ status: 'ready', error: null })
      // A successful canonical refresh is authoritative evidence that any
      // earlier recoverable bind/replay notice for this session is stale.
      // Resolve by stable key only; errors from other sessions remain.
      resolveRuntimeErrors({ key: `session-recovery:${input.readSessionId}`, source: 'chat.session-recovery' })
    }
    // P52 D3：journal 终态证据封存时钟；活动时钟覆盖投影间隙的回退。
    // #99：账本是第二条终态证据——journal 读可能早于终态行落盘（后端
    // "done 先于 persist"），只认 journal 会让这类读把在途投影判成当前事实，
    // 既封不住时钟、也补不出摘要。
    // #390：journal 侧的判据必须是**回合作用域**的（`latestTurnBoundary`）——
    // 「历史上出现过终态」会把上一轮的终态行当成本轮收敛的证据，直接导致在途回合
    // 被压成上一轮的 displayOnly 摘要（切页/重读即触发）。
    // #217：终态证据同样收敛内核在途事实——账本/journal 终态就是内核自己在说
    // 「回合已终态」（终帧丢失时这是唯一落静路，displayOnly 摘要依赖它）。
    // #442 Step1：后端权威 `turnBoundary` 可用时**替代**跨源「或」判定——它由
    // 账本（存在即权威，journal 终态行落盘时序不参与）或 journal 判据在后端一次
    // 合成，`open` 是权威的「未收敛」表态（封存会让在途回合被上一轮终态压塌，
    // 正是 #390 缺陷族）；`unknown`/字段缺失回退既有「或」轨。
    const ledgerTerminalReason = input.withLedgerEvidence ? clock.ledgerTerminalOf(input.readSource) : undefined
    const hasTerminalEvidence = input.turnBoundary !== undefined
      ? input.turnBoundary.kind === 'terminal'
      : (input.canonicalLatestBoundary === 'terminal' || ledgerTerminalReason !== undefined)
    clock.settleFromDocument(input.readSource, hasTerminalEvidence, input.readStartedAt)
    // #217：终态证据收敛内核事实。**只认账本终态**（ledgerTerminalReason，内核
    // 自己的账本）——journal 终态行是文档历史，不是内核活性事实，不得制造内核
    // 条目（时钟封存那一半维持 #99 无条件既有语义，kernel 写跟随账本那一半）。
    // 这是无条件写，与顶部的新鲜度守卫刻意不同：账本终态是点时内核事实的
    // 收敛陈述，早于它发出的 true 快照已被守卫二的回合身份挡住。
    // #442 Step1：boundary 权威期为 `open` 时跳过——权威说「未收敛」，归档里的
    // 账本终态只可能属于上一回合（不再让上一回合的终态收敛本回合内核条目）。
    if (ledgerTerminalReason !== undefined && input.turnBoundary?.kind !== 'open') clock.settleKernelFromLedger(input.readSource)
    clock.settleRuntimeLiveness(input.readSource)
    clock.reconcile(input.readSource)
    const settled = runtime.getSnapshot()
    // #442 Step1：boundary 两端可测时 duration 扫描退役（displayOnly 摘要的耗时
    // 直接取后端权威两端）；扫描保留为字段缺失时的回退轨。
    const boundaryElapsed = input.turnBoundary?.kind === 'terminal'
      && input.turnBoundary.startedAtMs !== undefined && input.turnBoundary.endedAtMs !== undefined
      ? { elapsedMs: input.turnBoundary.endedAtMs - input.turnBoundary.startedAtMs }
      : undefined
    if (!settled.generating && !settled.summary && hasTerminalEvidence) {
      updateRuntimeState({
        summary: {
          elapsedMs: boundaryElapsed?.elapsedMs ?? input.canonicalDuration?.elapsedMs ?? 0,
          tokenCount: settled.tokenCount,
          completedFrame: '',
          reason: ledgerTerminalReason ?? 'done',
          durationSource: boundaryElapsed !== undefined
            ? 'turn-boundary'
            : input.canonicalDuration?.source ?? 'unknown',
          durationAvailable: boundaryElapsed !== undefined || input.canonicalDuration !== undefined,
          // Display-only restore: must not synthesize a terminal fence
          // (see normalizeRuntimeSnapshot), or the next controller-driven
          // generation cannot restart the indicator after a rebind.
          displayOnly: true,
        },
      })
    }
  }

  /**
   * Canonical 重载：把 journal 读回来的投影折回文档，并据此收敛时钟。
   *
   * `ledgerTurn` = 后端 #99 turn 账本随 `load_persisted_session` 回来的快照
   * （`ColdMountTurnSnapshot.turn`）。它是**终帧之外唯一的终态证据**：终帧只经
   * per-source IPC Channel 一条路交付，丢了就没有第二次；而账本由后端权威状态
   * 合成、不依赖一次性 event。因此「本回合是否已收敛」= journal 读到终态行
   * **或** 账本说已收敛——只认前者会让一次早于终态行落盘的读把摘要判成不存在。
   */
  /**
   * `rebuild`（#380）：以**空文档**为 base 整页重建，而不是续折当前文档。bind（冷装载）与
   * **被拒回滚**要的是重建语义——「重建视角里那条乐观行从未发生」；续折会把当前文档原样带过来，
   * 乐观行也就删不掉（这正是回滚不能直接复用缺省 refresh 的原因）。其余语义（epoch/generation
   * 守卫、`buffered` 覆盖读期间到达的 live 行、`withPending` 补折剩余乐观行）两条路径共用。
   *
   * `options.turnBoundary`（#442 Step1）：load 响应随行的后端权威回合边界——进
   * `publishFoldedDocument` 后替代跨源「或」判定与 duration 扫描（字段可用即退役，
   * 缺省回退既有轨）。
   */
  const refresh = async (
    session: Session | undefined,
    ledgerTurn?: unknown,
    options: { rebuild?: boolean; turnBoundary?: PersistedTurnBoundary } = {},
  ): Promise<void> => {
    if (binding.destroyed || !session || !binding.ownerKey || !binding.boundSessionId || !binding.source) return
    const bindingKey = workbenchSessionBindingKey(session)
    const refreshOwnerKey = binding.ownerKey
    const refreshSource = binding.source
    const refreshSessionId = binding.boundSessionId
    const refreshGeneration = binding.generation
    if (bindingKey !== binding.boundSessionBindingKey || session.id !== refreshSessionId || session.source !== refreshSource) return
    if (binding.refreshInFlight) {
      // #380：**rebuild 请求不能被在途读合并掉**。合并返回的是先前那次读的 promise，而它的 base
      // 是含乐观行的 current 文档（续折）——被拒乐观行会因此留在屏幕上，「send 返回时已撤销」的
      // 时序保证在这个窗口里失效（评审发现的合并竞态）。故 rebuild 请求排队：等在途读落地后
      // 再跑一次（那时 `refreshInFlight` 已被清空，递归调用走新读）。
      if (!options.rebuild) return binding.refreshInFlight
      const inFlight = binding.refreshInFlight
      return inFlight.then(
        () => refresh(session, ledgerTurn, options),
        () => refresh(session, ledgerTurn, options),
      )
    }
    const refreshEpoch = ++binding.canonicalReadEpoch
    // #390：读的发起时刻——封存新鲜度守卫的锚点（读发起之后到达的帧证明读已过时）。
    const refreshStartedAt = Date.now()
    // 账本终态按 source 归档；本次调用的账本可能被去重丢掉，但归档会留下。
    const ledgerTerminalReason = resolveGenerationLedgerTerminalReason(ledgerTurn)
    if (ledgerTerminalReason !== undefined) clock.archiveLedgerTerminal(refreshSource, ledgerTerminalReason)
    // #217：内核在途事实随快照入库（守卫逻辑见 clock.observeKernelSnapshot）。
    clock.observeKernelSnapshot(refreshSource, ledgerTurn)

    const run = (async () => {
      try {
        const rows = await loadAll(refreshOwnerKey)
        const fragments = await loadDrafts(refreshOwnerKey)
        const current = runtime.getSnapshot().document ?? createWorkbenchDocument(refreshSource)
        const canonicalDuration = canonicalDurationFromRows(rows)
        const canonicalLatestBoundary = canonicalLatestBoundaryFromRows(rows)
        // Session switches/rebinds invalidate the result. Do not let a late
        // canonical read replace the document belonging to the new owner.
        if (binding.destroyed || bindingKey !== binding.boundSessionBindingKey || binding.ownerKey !== refreshOwnerKey
          || binding.source !== refreshSource || binding.boundSessionId !== refreshSessionId || binding.generation !== refreshGeneration
          || binding.canonicalReadEpoch !== refreshEpoch) return

        let refreshMalformedCount = 0
        const envelopes = rows.flatMap(row => {
          const read = readWorkbenchRow(row)
          if (read.ok) return read.envelopes
          refreshMalformedCount += 1
          return []
        })
        if (draft.reconcilePending) {
          draft.seen.clear(); draft.activeIds.clear(); draft.interruptedIds.clear()
        }
        envelopes.push(...deps.drafts.projectRecoveredDrafts(fragments, rows.reduce<number>((max, row) => {
          const sequence = row && typeof row === 'object' && 'sequence' in row ? Number(row.sequence) : 0
          return Math.max(max, Number.isSafeInteger(sequence) ? sequence : 0)
        }, 0)))
        // If refresh supersedes an initial bind read, fold events that arrived
        // while that read was in flight into the winning projection and release
        // the load buffer. Otherwise those events would remain stranded behind
        // the invalidated bind promise.
        const bufferedAtRefresh = draft.reconcilePending
          ? [...binding.buffered, ...draft.liveDuringReconcile]
          : binding.buffered
        // #81 L2：保留折入式投影（读快照建立后提交的 live 行不得被 replace 丢弃）。
        // 粒度互斥由 coverage 区间承担：journal 信封（单元 segment/逐 chunk）对
        // live 已应用区间完全覆盖者跳过——折叠状态在会话投影核里，live 行与 journal
        // 行同判幂等，整页重折即收敛。
        if (refreshMalformedCount > 0) fold.journalDiagnosticCount = refreshMalformedCount
        // #380：此处原有一份「以 journal 权威集整体替换 foldLog」的记账（#204③）——日志本身
        // 已整份删除，回滚改走 canonical 重读，这里不再需要任何替换动作。
        publishCanonicalRead({
          readSource: refreshSource,
          readOwnerKey: refreshOwnerKey,
          readGeneration: refreshGeneration,
          readSessionId: refreshSessionId,
          envelopes,
          bufferedAtRead: bufferedAtRefresh,
          base: options.rebuild || draft.reconcilePending ? createWorkbenchDocument(refreshSource) : current,
          malformedCount: refreshMalformedCount,
          canonicalDuration,
          canonicalLatestBoundary,
          turnBoundary: options.turnBoundary,
          readStartedAt: refreshStartedAt,
          withLedgerEvidence: true,
        })
        draft.reconcilePending = false
        draft.liveDuringReconcile = []
      } catch (error) {
        if (binding.destroyed || bindingKey !== binding.boundSessionBindingKey || binding.ownerKey !== refreshOwnerKey
          || binding.source !== refreshSource || binding.boundSessionId !== refreshSessionId || binding.generation !== refreshGeneration
          || binding.canonicalReadEpoch !== refreshEpoch) return
        const bufferedAfterFailure = binding.buffered
        binding.buffered = []
        binding.loading = false
        // A failed refresh may have superseded the initial bind read. Keep
        // already-observed live/session-response events visible even though
        // the canonical reload itself is degraded.
        for (const envelope of bufferedAfterFailure) {
          runtime.applyDocument(foldEvent(envelope), {
            ownerKey: refreshOwnerKey,
            generation: refreshGeneration,
            preserveGeneration: true,
          })
        }
        updateRuntimeState({ status: 'degraded', error: error instanceof Error ? error.message : String(error) })
      }
    })()
    const pending = run.finally(() => {
      if (binding.refreshInFlight === pending) binding.refreshInFlight = null
    })
    binding.refreshInFlight = pending
    return pending
  }

  return {
    foldPage,
    foldEvent,
    publishCanonicalRead,
    publishFoldedDocument,
    collectRowsInto,
    maxRowSequence,
    refresh,
  }
}
