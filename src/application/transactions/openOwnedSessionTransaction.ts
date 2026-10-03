/**
 * openOwnedSessionTransaction — owner-aware 会话打开事务（ISSUE-01 W4）。
 *
 * History/Search/Overview/File 等入口统一走本事务：先确定目标 Session 的 owner（agentId），
 * 若与当前 active Agent 不同则先 await 切换 owner（成功才继续），再复查 Session 仍存在且
 * owner 未变，最后 selectSession + 以 owner 打开 agent sheet。任一步失败保持原页面，
 * 不静默归到 active Agent（ISSUE-01 目标行为 4/5）。
 *
 * 结果 kinds：
 * - blocked          owner 无法确定（存档无归属）→ 显式要求恢复选择
 * - validation       目标 Session 不存在 / 创建失败
 * - transport        切换 owner Agent 失败
 * - mismatch         复查时 Session 已变化（删除/owner 变更）
 */
import { tauriInvokeTransport } from '../../infrastructure/acp/tauriTransport.ts'
import type { Session } from '../../domains/identity/identityStore'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'
import { createAgentClient } from '../../infrastructure/acp/agentClient'
import { switchAgentTransaction } from './switchAgentTransaction'
import type { TransactionResult } from './transactionResult'
import { resumePersistedSessionTransaction } from './resumePersistedSessionTransaction'
import { ARCHIVED_OWNER_CONFLICT_MESSAGE, resolveArchivedSessionOwner } from './archiveOwnerResolver'

/**
 * switchAgent 装配共享工厂（#520 S2-P2：本文件与 settingsAgentActions 的 ports
 * 对象逐字重复收敛）——client / runtime / identity / 广播接线单源；差异面作参数注入：
 * Agent 名解析（缺省回落 agentId）与错误口径（report/resolve 回调各自闭合自己的
 * key/来源格式：本事务用 `agent-switch:*` + source 'agent.switch'，Settings 用
 * `settings:*` + source 'settings'）。
 */
export function createSwitchAgentRunner(options: {
  resolveAgentName?: (agentId: string) => string | undefined
  reportError: (action: string, error: unknown, agentId: string) => void
  resolveError: (action: string, agentId: string) => void
}): (agentId: string) => Promise<TransactionResult<string>> {
  return agentId => switchAgentTransaction(agentId, options.resolveAgentName?.(agentId) ?? agentId, {
    switchAgent: id => createAgentClient({ invoke: tauriInvokeTransport }).switchAgent(id),
    resetRuntime: () => useRuntimeStore.getState().resetSessionRuntime(),
    setActiveAgent: id => useIdentityStore.getState().setActiveAgent(id),
    fetchAgentStatus: () => createAgentClient({ invoke: tauriInvokeTransport }).agentStatus(),
    applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
    reportError: (action, error) => options.reportError(action, error, agentId),
    resolveError: action => options.resolveError(action, agentId),
    dispatchSwitched: () => window.dispatchEvent(new CustomEvent('pylon:agent-switched')),
  })
}

/**
 * 标准 owner 切换实现：复用 switchAgentTransaction 完整流程（invoke → reset runtime →
 * setActiveAgent → 对账 agent_status → 广播 agent-switched）。不在此开 sheet——
 * openOwnedSessionTransaction 负责最后以 owner 打开 agent sheet。
 */
export function createStandardSwitchAgent(getAgentName: (agentId: string) => string | undefined): (agentId: string) => Promise<TransactionResult<string>> {
  const operationKey = (agentId: string, action: string) => `agent-switch:${agentId}:${action}`
  return createSwitchAgentRunner({
    resolveAgentName: getAgentName,
    reportError: (action, error, agentId) => reportRuntimeError(action, error, agentId, {
      key: operationKey(agentId, action),
      scope: { kind: 'agent', id: agentId },
      source: 'agent.switch',
    }),
    resolveError: (action, agentId) => resolveRuntimeErrors({
      key: operationKey(agentId, action),
      source: 'agent.switch',
      scope: { kind: 'agent', id: agentId },
    }),
  })
}

export interface OpenOwnedSessionDeps {
  /** 新鲜读取 sessions（切换后复查需最新状态，不用静态快照——CR-002） */
  getSessions: () => readonly Session[]
  activeAgent: string | null
  addSession: (name: string, agentId?: string) => string
  updateSession: (id: string, partial: Partial<Session>) => void
  /** 返回 switchAgentTransaction 判别结果（{ok:false} 而非抛异常——CR-001） */
  switchAgent: (agentId: string) => Promise<TransactionResult<string>>
  selectSession: (id: string) => void
  openAgentSheet: (opts: { title: string; agentId: string }) => void
}

export interface OpenOwnedSessionInput {
  /** 已知 Session id（Search/File/Overview 本地会话路径） */
  targetId?: string
  /** 存档恢复路径（History/Overview 存档条目，无本地 identity 行） */
  source?: string
  periId?: string
  title?: string
  updatedAt?: number
  /** 调用方已知的显式 owner（存档条目若携带 agentId） */
  ownerAgentId?: string
}

export async function openOwnedSessionTransaction(
  input: OpenOwnedSessionInput,
  deps: OpenOwnedSessionDeps,
): Promise<TransactionResult<string>> {
  let target: Session | undefined
  let ownerAgentId: string | undefined

  if (input.targetId) {
    target = deps.getSessions().find(session => session.id === input.targetId)
    if (!target) return { ok: false, kind: 'validation', message: '会话不存在' }
    ownerAgentId = target.agentId
  } else {
    // 存档恢复：预查与实际恢复共用同一 resolver；conflict 文案由 ARCHIVED_OWNER_CONFLICT_MESSAGE 单源，杜绝语义漂移。
    const resolution = resolveArchivedSessionOwner(input, deps.getSessions())
    if (resolution.kind === 'conflict') {
      return { ok: false, kind: 'conflict', message: ARCHIVED_OWNER_CONFLICT_MESSAGE }
    }
    ownerAgentId = input.ownerAgentId ?? (resolution.kind === 'resolved' ? resolution.agentId : undefined)
    if (!ownerAgentId) {
      return { ok: false, kind: 'blocked', message: '存档会话归属不明，无法自动打开（请先指定 Agent）' }
    }
    const resume = resumePersistedSessionTransaction(input.source, input.periId, input.title, input.updatedAt, {
      sessions: deps.getSessions(),
      addSession: deps.addSession,
      updateSession: deps.updateSession,
    }, ownerAgentId)
    if (!resume.ok) return resume
    target = deps.getSessions().find(session => session.id === resume.value)
  }
  if (!target) return { ok: false, kind: 'validation', message: '会话创建失败' }

  // owner 与当前 active 不同 → 先切 owner；失败保持原页面（判别结果非抛异常——CR-001）
  if (ownerAgentId !== deps.activeAgent) {
    const switchResult = await deps.switchAgent(ownerAgentId)
    if (!switchResult.ok) {
      return { ok: false, kind: 'transport', message: `切换 Agent 失败：${switchResult.message}`, cause: switchResult.cause }
    }
  }

  // 复查：Session 仍存在且 owner 未变（切换期间可能被删除/重绑）
  const after = deps.getSessions().find(session => session.id === target!.id)
  if (!after || after.agentId !== ownerAgentId) {
    return { ok: false, kind: 'mismatch', message: '会话在切换期间已变化，请重试' }
  }

  deps.selectSession(after.id)
  deps.openAgentSheet({ title: after.name, agentId: ownerAgentId })
  return { ok: true, value: after.id }
}
