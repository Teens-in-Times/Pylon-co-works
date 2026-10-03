/**
 * Terminal settlement subsystem for the agent workbench session host (#520
 * S3-P0-1): funnels the three terminal-evidence rails (feed terminal frames,
 * the window broadcast fallback, and #442 Step3 ledger settle broadcasts) into
 * idempotent TurnClock terminals. Settlement itself is owned by the clock
 * (first terminal wins), so duplicate delivery across rails is a no-op.
 * The factory (agentWorkbenchSession.ts) injects its resolvable listeners and
 * disposes the returned handle on destroy.
 */
import { resolveGenerationLedgerTerminalReason } from '../../domains/workbench/generationLedgerSummary.ts'
import type { PromptFailureMetadata } from '../../infrastructure/acp/chatContracts.ts'
import type { AgentWorkbenchTurnClock } from './agentWorkbenchTurnClock.ts'
import type { CanonicalTerminalSignal, CanonicalTurnSettledEvent } from '../../infrastructure/events/canonicalEventFeed.ts'
import { getCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'

export interface AgentWorkbenchTurnLifecycleDeps {
  clock: AgentWorkbenchTurnClock
  /** 终帧 window 广播兜底轨（工厂依赖透传；缺省 `subscribeWindowTerminalFrames`）。 */
  listenTerminalFallback(listener: (signal: CanonicalTerminalSignal) => void): () => void
  /** #442 Step3：账本 settle 广播主轨（工厂依赖透传；缺省 `subscribeTurnSettled`）。 */
  listenTurnSettled(listener: (event: CanonicalTurnSettledEvent) => void): () => void
}

export interface AgentWorkbenchTurnLifecycle {
  /** 退订三条终态轨（宿主 destroy 调用）。 */
  dispose(): void
}

export function createAgentWorkbenchTurnLifecycle(deps: AgentWorkbenchTurnLifecycleDeps): AgentWorkbenchTurnLifecycle {
  const { clock, listenTerminalFallback, listenTurnSettled } = deps

  // P52 D3：feed 终帧信号 → TurnClock 终态（done/error；cancelled 映射 cancelled）。
  // 时钟幂等：首个终态 wins；不在当前 source 的终帧只封存该 source 的时钟。
  // 终态收敛的唯一入口：TurnClock 幂等（首个终态 wins），故 Channel 主轨与 window
  // 广播兜底轨重复投递同一终帧是安全的——两条路都到就只是个 no-op。
  const handleTerminalSignal = (signal: CanonicalTerminalSignal): void => {
    if (!signal.source) return
    const payload = signal.payload as { cancelled?: unknown; failure?: unknown; data?: { stopReason?: unknown } } | null
    // #324：done 帧携带 stopReason=cancelled（内核中性结算的用户主动停止）——
    // 页脚按「已停止」呈现，不冒充自然完成。
    const doneStopReason = payload && typeof payload.data === 'object' && payload.data !== null
      ? payload.data.stopReason
      : undefined
    const reason: 'done' | 'cancelled' | 'error' = signal.kind === 'error'
      ? (payload?.cancelled === true ? 'cancelled' : 'error')
      : doneStopReason === 'cancelled' ? 'cancelled' : 'done'
    const failure = signal.kind === 'error' && payload && typeof payload === 'object' && typeof payload.failure === 'object'
      ? payload.failure as PromptFailureMetadata
      : undefined
    // #442 Step2：终帧 additive turnId 透传给时钟——身份戳结算走精确匹配，
    // 「最近一次 active 快照」猜测在字段可用时退役（缺省回退猜测轨）。
    clock.terminal(signal.source, reason, Date.now(), failure, signal.turnId)
  }

  // #442 Step3：账本广播 = 终态收敛主轨（内核事实，与 Channel 注册生命周期无关）。
  // done/error 帧自此退化为正文/usage 载体——本 handler 用后端权威 TurnRecord 直接
  // 收敛：cause→reason 走既有词表映射（resolveGenerationLedgerTerminalReason，不新增
  // 语义），settledAtMs/turnId 直供时钟（elapsed 起点用权威终点、身份戳精确结算）；
  // 与终帧的双到由 TurnClock 幂等吸收。
  const handleTurnSettled = (event: CanonicalTurnSettledEvent): void => {
    const reason = resolveGenerationLedgerTerminalReason({ turn: event.turn })
    if (reason !== undefined) {
      const terminal = (event.turn as { terminal?: { settledAtMs?: unknown } }).terminal
      const settledAtMs = terminal !== null && typeof terminal === 'object'
        && typeof (terminal as { settledAtMs?: unknown }).settledAtMs === 'number'
        ? (terminal as { settledAtMs: number }).settledAtMs
        : undefined
      const key = (event.turn as { key?: { turnId?: unknown } }).key
      const turnId = key !== null && typeof key === 'object'
        && typeof (key as { turnId?: unknown }).turnId === 'number'
        ? (key as { turnId: number }).turnId
        : undefined
      clock.terminal(event.source, reason, settledAtMs ?? Date.now(), undefined, turnId)
      return
    }
    // 词表认不出的 cause：内核说 settle 就是 settle——收敛活性与封存时钟，但不伪造
    // reason 摘要（宁可「无摘要的静止」，也不把失败报成成功）。
    clock.settleKernelFromLedger(event.source)
    clock.settleFromDocument(event.source, true, undefined)
    clock.settleRuntimeLiveness(event.source)
  }

  const unsubscribeTurnClockTerminal = getCanonicalEventFeed().onTerminal(handleTerminalSignal)
  const unsubscribeTerminalFallback = listenTerminalFallback(handleTerminalSignal)
  const unsubscribeTurnSettled = listenTurnSettled(handleTurnSettled)

  return {
    dispose() {
      unsubscribeTurnClockTerminal()
      unsubscribeTerminalFallback()
      unsubscribeTurnSettled()
    },
  }
}
