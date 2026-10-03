/**
 * OWNER-03 冷启动 Sheet activation 状态机（方案书 §5.9）。
 *
 * 规则（§5.9 原文语义）：
 * 1. Sheet 恢复只代表用户意图，不代表 Agent 已连接。
 * 2. activeSheetId、activeAgent、Session.agentId 不一致时进入 restore_error，不自动猜测。
 * 3. Agent 未连接时 InputBar 必须 disabled，并显示 owner Agent 状态。
 * 4. （OWNER-04）重连后 generation 变化，旧 binding 必须 Invalidated，不能继续发送旧 remote id。
 *
 * 纯函数域：零框架依赖，node 可测。
 *
 * 状态机：
 * - idle              无可绑定目标（无激活 agent sheet / 无激活会话）——InputBar 本就不挂载
 * - restoring         归属已一致，Agent 连接确认中（状态缺失/connecting/reconnecting）
 * - restore_error     引用不一致（sheet 归属 / 会话归属 / activeAgent 冲突，或会话缺失）——不猜测
 * - agent_disconnected 归属明确但 Agent 处于终态未连接（disconnected/error/crashed/inactive/unknown）
 * - binding_ready     Agent connected → InputBar 可启用
 * - binding_stale     重连 generation 变化 → 旧 binding 失效（OWNER-04：不能继续发送旧 remote id，
 *                     须重新加载会话后重建 binding）
 */
import type { AgentConnectionStatus, AgentStatus } from '../../contracts/agentTypes'
import type { SessionBindingSnapshot } from '../../contracts/agentTypes'
import { statusLabel } from '../../contracts/agentTypes'
import type { Session } from '../identity/identityStore'

export type BindingState =
  | { kind: 'idle' }
  | { kind: 'restoring'; agentId: string }
  | { kind: 'restore_error'; agentId?: string; reason: string }
  | { kind: 'agent_disconnected'; agentId: string; status: AgentConnectionStatus }
  | { kind: 'binding_ready'; agentId: string; sessionId: string }
  | { kind: 'binding_probing'; agentId: string; sessionId: string; generation: number }
  | { kind: 'binding_detached'; agentId: string; sessionId: string; reason: string; retryable: boolean }
  | { kind: 'binding_stale'; agentId: string; sessionId: string; fromGeneration: number; toGeneration: number }

/** resolver 最小化输入：只读 kind/agentId，避免域依赖 workspace-sheets 具体类型 */
export interface ActiveSheetLike {
  kind: string
  agentId?: string
}

export interface BindingResolutionInput {
  /** workspaceSheets.activeSheetId 解析出的激活 sheet（null = 无激活 sheet） */
  activeSheet: ActiveSheetLike | null
  /** App 层激活会话 id（InputBar sessionId） */
  activeSessionId: string | null
  sessions: readonly Session[]
  /** identityStore.activeAgent 原值（**空串 = 没有 Agent**：零 Agent 首跑，或尚未确定；
   *  空串不参与冲突判定） */
  activeAgent: string
  /** runtimeStore.agentStatuses[owner]（缺失 = 状态快照尚未到达 → restoring） */
  ownerStatus: AgentStatus | null | undefined
}

export function resolveBindingState(input: BindingResolutionInput): BindingState {
  const { activeSheet, activeSessionId } = input

  // 无激活 sheet / 非 agent sheet：无绑定目标（InputBar 不会挂载）
  if (!activeSheet) return { kind: 'idle' }
  if (activeSheet.kind !== 'agent') return { kind: 'idle' }

  const sheetOwner = activeSheet.agentId
  // agent sheet 缺 agentId：无法确定归属，不猜测
  if (!sheetOwner) return { kind: 'restore_error', reason: '激活的 Agent sheet 缺少 agentId，无法确定归属' }

  // 无激活会话：无绑定目标（InputBar 不会挂载）
  if (!activeSessionId) return { kind: 'idle' }

  const session = input.sessions.find(item => item.id === activeSessionId)
  // 会话不存在（持久化记忆引用了已删除会话）：不猜测
  if (!session) {
    return { kind: 'restore_error', agentId: sheetOwner, reason: '激活会话在 identity 中不存在，无法恢复绑定' }
  }
  // 会话归属 ≠ Sheet 归属：不猜测
  if (session.agentId !== sheetOwner) {
    return { kind: 'restore_error', agentId: sheetOwner, reason: `激活 Sheet 归属 ${sheetOwner}，会话归属 ${session.agentId}，不一致` }
  }
  // activeAgent 与 Sheet 归属冲突（空串 = 冷启动未确定，不判冲突）
  if (input.activeAgent && input.activeAgent !== sheetOwner) {
    return { kind: 'restore_error', agentId: sheetOwner, reason: `activeAgent=${input.activeAgent} 与激活 Sheet 归属 ${sheetOwner} 不一致` }
  }

  const status = input.ownerStatus
  // 状态快照缺失 / 连接中：等待确认
  if (!status) return { kind: 'restoring', agentId: sheetOwner }
  if (status.status === 'connected') {
    return { kind: 'binding_ready', agentId: sheetOwner, sessionId: session.id }
  }
  if (status.status === 'connecting' || status.status === 'reconnecting') {
    return { kind: 'restoring', agentId: sheetOwner }
  }
  // 其余（disconnected/error/crashed/inactive/unknown）：归属明确但 Agent 未连接
  return { kind: 'agent_disconnected', agentId: sheetOwner, status: status.status }
}

export interface BindingGenerationInput {
  /** binding 建立时的 agent generation（load_persisted_session/new_session 成功时记录） */
  establishedGeneration: number | undefined
  /** 当前 agentStatus.generation（重连后递增） */
  currentGeneration: number | undefined
  /** Kernel auto-reconnect continuity probe snapshot for this exact agent+source. */
  backendHealth?: SessionBindingSnapshot
}

/**
 * OWNER-04：binding generation 精化——binding_ready 只代表"Agent 当前 connected"，
 * 若 binding 建立时的 generation 已不是当前 generation（Agent 重连/替换），旧 binding
 * 必须 Invalidated（不能继续发送旧 remote id）。无 generation 信息时无法检测，保持 ready。
 */
export function refineBindingGeneration(binding: BindingState, generations: BindingGenerationInput): BindingState {
  if (binding.kind !== 'binding_ready') return binding
  const { establishedGeneration, currentGeneration, backendHealth } = generations
  if (backendHealth?.health === 'probing') {
    return {
      kind: 'binding_probing',
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      generation: backendHealth.generation,
    }
  }
  if (backendHealth?.health === 'detached') {
    return {
      kind: 'binding_detached',
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      reason: backendHealth.reason ?? 'session-binding-detached',
      retryable: backendHealth.retryable,
    }
  }
  if (establishedGeneration === undefined || currentGeneration === undefined) return binding
  if (establishedGeneration === currentGeneration) return binding
  return {
    kind: 'binding_stale',
    agentId: binding.agentId,
    sessionId: binding.sessionId,
    fromGeneration: establishedGeneration,
    toGeneration: currentGeneration,
  }
}

/** InputBar 锁定判定：idle（无绑定目标）与 binding_ready 之外的态都禁用发送 */
export function isBindingLocked(state: BindingState): boolean {
  return state.kind !== 'idle' && state.kind !== 'binding_ready'
}

/** UI 状态文案（disabled 控件解释原因用）；idle/binding_ready 返回空串 */
export function bindingStatusText(state: BindingState): string {
  switch (state.kind) {
    case 'idle': return ''
    case 'restoring': return `正在恢复会话绑定…等待 Agent ${state.agentId} 连接`
    case 'restore_error': return `会话绑定恢复失败：${state.reason}`
    case 'agent_disconnected': return `Agent ${state.agentId} ${statusLabel(state.status)}，暂不能发送`
    case 'binding_stale': return `Agent ${state.agentId} 已重连（generation ${state.toGeneration}），会话绑定已失效，需重新加载会话`
    case 'binding_probing': return `Agent ${state.agentId} 已重连，正在验证远端会话是否仍可继续…`
    case 'binding_detached': return `远端会话绑定不可用（${state.reason}），请重新连接会话`
    case 'binding_ready': return ''
  }
}

export interface BindingHint {
  readonly text: string
  readonly error: boolean
}

/** 输入栏悬浮提示的呈现判据（唯一出处）：文案非空即显示；error 变体仅 restore_error。 */
export function bindingHint(state: BindingState): BindingHint | undefined {
  const text = bindingStatusText(state)
  return text ? { text, error: state.kind === 'restore_error' } : undefined
}
