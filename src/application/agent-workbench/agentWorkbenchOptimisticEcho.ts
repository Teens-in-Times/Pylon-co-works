/**
 * Optimistic user echo subsystem for the agent workbench session host (P52 D4,
 * #68, #213): projects the locally-sent user message into the document before
 * any provider echo, rolls it back when the send is rejected, reconciles the
 * canonical echo against the pending optimistic entries, and folds still-pending
 * entries back in after a cold bind/refresh rebuilds the projection.
 * Owns `pendingOptimisticBySource`; clock interaction goes through the
 * TurnClock subsystem, document folding through the injected fold seams.
 */
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import { createWorkbenchDocument, type WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import { reduceGenerationActivity } from '../../domains/activity/generationStateMachine.ts'
import type { AgentWorkbenchTurnClock, RuntimeStatePatch, WorkbenchRuntime } from './agentWorkbenchTurnClock.ts'

/** 会话宿主的共享绑定状态（原工厂散落闭包 let 的单源化）。宿主与子系统共同读写。 */
export interface AgentWorkbenchBindingState {
  boundSessionId: string | undefined
  /** 当前绑定的本地 Session 行（`withReplayNegotiationFact` 等读其 remote id）。 */
  boundSession: import('../../domains/identity/identityStore.ts').Session | undefined
  boundProvider: string
  boundSessionBindingKey: string | undefined
  ownerKey: string | undefined
  source: string | undefined
  generation: number
  turnEpoch: number
  loading: boolean
  buffered: WorkbenchEventEnvelope[]
  malformedCount: number
  destroyed: boolean
  refreshInFlight: Promise<void> | null
  canonicalReadEpoch: number
  selectorRequestInFlight: boolean
}

export interface AgentWorkbenchOptimisticEchoDeps {
  runtime: WorkbenchRuntime
  binding: AgentWorkbenchBindingState
  clock: AgentWorkbenchTurnClock
  updateRuntimeState: (patch: RuntimeStatePatch) => void
  foldPage(envelopes: readonly WorkbenchEventEnvelope[], base?: WorkbenchDocument): WorkbenchDocument
  foldEvent(envelope: WorkbenchEventEnvelope, base?: WorkbenchDocument): WorkbenchDocument
  /**
   * #380：按 canonical journal 重读并重建当前绑定的文档（宿主侧 `refresh`：异步、按
   * binding/generation/epoch 守卫、与 bind 共用同一条发布路径）。
   */
  reloadFromJournal: () => Promise<void> | void
}

export interface AgentWorkbenchOptimisticEcho {
  /** 发送入口的乐观投影（回合起点记账也在这里）。 */
  project(targetSource: string, content: string, clientMessageId: string): void
  /**
   * 发送被拒：撤销乐观行与时钟。
   *
   * #380 起**异步**（回滚走 canonical 重读，语义见 `reject` 实现处的注释）：需要「回滚已落地」
   * 时序保证的调用方要 await 它——`send` 命令就是这么做的。
   */
  reject(targetSource: string, clientMessageId: string): Promise<void>
  /** bind/refresh 重建投影核后补折仍 pending 的乐观信封。 */
  withPending(targetSource: string, base: WorkbenchDocument): WorkbenchDocument
  /** canonical echo 到达：匹配 pending 条目，必要时回写 clientMessageId。 */
  confirm(envelope: WorkbenchEventEnvelope): WorkbenchEventEnvelope
  /** live user 帧是否为某条 pending 乐观行的回声。 */
  matchesPending(targetSource: string, interactionId: unknown, content: string): boolean
  clear(): void
}

interface PendingOptimisticEntry {
  clientMessageId: string
  content: string
  priorCanonicalMatches: number
  envelope: WorkbenchEventEnvelope
}

export function createAgentWorkbenchOptimisticEcho(deps: AgentWorkbenchOptimisticEchoDeps): AgentWorkbenchOptimisticEcho {
  const { runtime, binding, clock, updateRuntimeState, foldPage, foldEvent, reloadFromJournal } = deps
  const pendingOptimisticBySource = new Map<string, PendingOptimisticEntry[]>()

  const echo: AgentWorkbenchOptimisticEcho = {
    project(targetSource, content, clientMessageId) {
      if (binding.destroyed) return
      // P52 D3：回合起点属于**发送入口**，不属于 bind。空态创建路径
      // （ControlCenter.createEmptySession → selectSession → send 同一 tick）下会话已被
      // 选中但 bind 尚未完成；若在这里因"未绑定"早退，终帧到达时 turnClocks 没有该 source
      // 的条目，turnClockTerminal 会直接 return ⇒ 终态摘要永不发布（issue #68）。
      // 故时钟先无条件建立/覆盖；文档投影与快照 patch 仍严格限于已绑定的本 source。
      const now = Date.now()
      clock.start(targetSource, now)
      // #217：发送入口 = 派发意图——内核在出站成功时会置位同一事实（begin 同点）。
      // 仅 Fresh化已存在的内核条目（权威立即回到 kernel）；无内核表态的宿主不得被
      // 制造出内核权威（保持 #213 时钟权威，兼容旧内核）。
      clock.freshenKernelInFlight(targetSource)
      if (targetSource !== binding.source || !binding.boundSessionId) {
        // 仅时钟起点：文档投影要等 bind 之后由 canonical echo 承担。
        clock.markClockOnlyStart(targetSource, clientMessageId)
        return
      }
      const current = runtime.getSnapshot().document ?? createWorkbenchDocument(targetSource)
      const existing = pendingOptimisticBySource.get(targetSource) ?? []
      if (existing.some(item => item.clientMessageId === clientMessageId)) return
      const envelope = createWorkbenchEnvelope({
        eventId: `optimistic:${targetSource}:${clientMessageId}`,
        sessionId: targetSource,
        sequence: current.revision + existing.length + 1,
        recordedAt: new Date(now).toISOString(),
        source: { provider: 'local-user', sourceId: clientMessageId },
        identity: { interactionId: clientMessageId },
        provenance: { origin: 'optimistic-local', trust: 'unverified' },
        event: { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: content }] },
      })
      existing.push({
        clientMessageId,
        content,
        priorCanonicalMatches: current.messages.filter(message => message.role === 'user'
          && message.content === content && message.optimistic !== true).length
          + existing.filter(item => item.content === content).length,
        envelope,
      })
      pendingOptimisticBySource.set(targetSource, existing)
      binding.turnEpoch += 1
      runtime.applyDocument(foldEvent(envelope), { ownerKey: binding.ownerKey, generation: binding.generation, turnEpoch: binding.turnEpoch, terminalFence: null, preserveGeneration: true })
      updateRuntimeState({
        generating: true,
        generationStart: now,
        lastTokenAt: now,
        generationPhase: { kind: 'thinking' },
        generationActivity: reduceGenerationActivity(undefined, { type: 'start', at: now }),
        summary: null,
      })
    },

    async reject(targetSource, clientMessageId) {
      const pending = pendingOptimisticBySource.get(targetSource) ?? []
      const rejected = pending.find(item => item.clientMessageId === clientMessageId)
      if (!rejected) {
        // 空态路径（尚未 bind）没有文档投影可撤：project 只记了"仅时钟起点"。
        // 拒绝时同样必须撤销时钟，否则 bind 后的 reconcile 会把从未发出的回合
        // 复活成常驻 spinner（issue #68 配套）。
        if (clock.peekClockOnlyStart(targetSource) === clientMessageId) {
          clock.clearClockOnlyStart(targetSource)
          clock.rollback(targetSource)
        }
        return
      }
      const remaining = pending.filter(item => item !== rejected)
      if (remaining.length > 0) pendingOptimisticBySource.set(targetSource, remaining)
      else pendingOptimisticBySource.delete(targetSource)
      if (binding.source !== targetSource) return
      const current = runtime.getSnapshot().document
      if (!current) return
      // #380：回滚不再从「整会话信封日志」整页重折——那份日志是载荷的第二份常驻持有
      // （合成语料下 ≈Σ载荷），而 journal 本来就是权威源。改为请宿主做一次 canonical
      // 重读：`publishCanonicalRead → withPending` 只会补折**仍 pending** 的乐观行，
      // 被拒这条刚从这里移除，自然不在重建结果里；journal 事实一条不少。
      //
      // 两条如实的语义变化（原同步整页重折没有）：
      // 1. 时间上是**异步**的：乐观行在重读落地前仍在屏上（调用方 await 本次 reject 可拿到
      //    「已回滚」的时序保证，`send` 命令就这么做）；
      // 2. 重建视角改为 journal 为准：尚未落盘（sink debounce 窗口内）的 live 行按既有
      //    refresh 语义处理（`binding.buffered` 覆盖读期间到达的行），不在本次重建里则由
      //    下一次 canonical 读回补。
      await reloadFromJournal()
      if (binding.destroyed) return
      // P52 D3：发送被拒 = 回合回滚；若无其它在途乐观回合，时钟一并撤销，
      // 后续迟到帧不得经 updateRuntimeState 复活指示器（原 controller 侧由
      // reject-optimistic-user reducer 承担）。时钟按 source 归档，切走也照撤。
      if (remaining.length === 0) clock.rollback(targetSource)
      // 重读期间可能已切到别的会话（异步化引入的窗口）：那时不要再拿旧 source 的剩余 pending
      // 去写当前 UI 的生成态——新会话的生成态归它自己的时钟/绑定管。
      if (binding.source !== targetSource) return
      const existingActivity = runtime.getSnapshot().generationActivity
      updateRuntimeState({
        // #213：回滚后的活性只认"是否还有未撤销的乐观回合"——**不得**再看文档里有没有
        // `running` 行。那条推断在权威化之后成了漏网语义：一个带截断残行的旧会话（无时钟、
        // 无终态）会让被拒的发送把页脚永久顶成生成中。
        generating: remaining.length > 0,
        generationPhase: remaining.length > 0 ? { kind: 'thinking' } : undefined,
        generationActivity: remaining.length > 0
          ? existingActivity ?? reduceGenerationActivity(undefined, { type: 'start', at: Date.now() })
          : undefined,
      })
    },

    withPending(targetSource, base) {
      const pending = pendingOptimisticBySource.get(targetSource) ?? []
      if (pending.length === 0) return base
      // canonical 回声计数按 base 统计：pending 信封全是 optimistic-local，折叠它们
      // 不会新增非乐观 user 行，先剪枝再批量折入与逐个计数同判。
      const candidates = pending.filter(item => {
        const canonicalMatches = base.messages.filter(message => message.role === 'user'
          && message.content === item.content && message.optimistic !== true).length
        return canonicalMatches <= item.priorCanonicalMatches
      })
      let document = base
      if (candidates.length > 0) {
        // 剩余 pending 一页折入：bind 重建投影核后是真正入账；refresh 路径里已入账的
        // 乐观信封按 eventId 幂等跳过（no-op）。存活检查看最终文档的 optimistic 行。
        document = foldPage(candidates.map(item => item.envelope), base)
      }
      const remaining = candidates.filter(item => document.messages.some(message => message.optimistic
        && message.identity.interactionId === item.clientMessageId))
      if (remaining.length > 0) pendingOptimisticBySource.set(targetSource, remaining)
      else pendingOptimisticBySource.delete(targetSource)
      return document
    },

    confirm(envelope) {
      if (envelope.provenance.origin === 'optimistic-local') return envelope
      if ((envelope.event.type !== 'message.delta' && envelope.event.type !== 'message.completed')
        || envelope.event.role !== 'user') return envelope
      const content = (envelope.event.parts ?? []).map(part => 'text' in part ? part.text : '').join('')
      const targetSource = envelope.sessionId
      const pending = pendingOptimisticBySource.get(targetSource) ?? []
      const requestId = envelope.identity.interactionId
      const matched = (requestId ? pending.find(item => item.clientMessageId === requestId) : undefined)
        ?? pending.find(item => item.content === content)
      if (!matched) return envelope
      const remaining = pending.filter(item => item !== matched)
      if (remaining.length > 0) pendingOptimisticBySource.set(targetSource, remaining)
      else pendingOptimisticBySource.delete(targetSource)
      if (requestId === matched.clientMessageId) return envelope
      return Object.freeze({
        ...envelope,
        identity: Object.freeze({ ...envelope.identity, interactionId: matched.clientMessageId }),
      })
    },

    matchesPending(targetSource, interactionId, content) {
      const pending = pendingOptimisticBySource.get(targetSource) ?? []
      return pending.some(item => item.clientMessageId === interactionId || item.content === content)
    },

    clear() {
      pendingOptimisticBySource.clear()
    },
  }
  return echo
}
