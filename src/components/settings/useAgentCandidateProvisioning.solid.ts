import { createEffect, createSignal, onCleanup } from 'solid-js'
import { errorCode as wireErrorCode, errorMessage } from '../../infrastructure/tauri/errorPayload.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import type { AgentClient, AgentsConfigDocument } from '../../infrastructure/acp/agentClient'
import type { AgentEntry } from '../../domains/identity/identityStore'
import { useIdentityStore } from '../../domains/identity/identityStore'
import type { AgentRuntimeCandidate } from '../../domains/agent/agentDetector.ts'
import { candidateImportMode, type AgentCandidateValidationState } from '../../domains/agent/candidateValidation.ts'
import { validateInvocation } from '../../domains/agent/invocationDraft.ts'
import { provisionAgentTransaction } from '../../application/transactions/provisionAgentTransaction.ts'
import { activateAgentSheet } from '../../workspace-sheets/activateAgentSheet.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'

export interface CandidateDraft { id: string; name: string; executable: string; args: string[]; provider: string }
type ProvisioningPhase = 'testing' | 'saving' | 'activating'
interface Operation { candidateId: string; phase: ProvisioningPhase }
interface ValidatedDraft { fingerprint: string; validation: AgentCandidateValidationState }

export function candidateDraft(candidate: AgentRuntimeCandidate): CandidateDraft {
  return { id: candidate.suggestedAgentId, name: candidate.name, executable: candidate.executable, args: [...candidate.args], provider: candidate.provider }
}

function normalizedDraft(draft: CandidateDraft): CandidateDraft {
  return { id: draft.id.trim(), name: draft.name.trim(), executable: draft.executable.trim(), provider: draft.provider.trim(), args: [...draft.args] }
}

/** Owns one panel's drafts, validation receipts and import operations.
 * Editing/cancelling/unmounting fences late validation before persistence.
 * Import stores configuration; activation is an explicit action.
 *
 * #515 W1：Solid 形态（消费者 AgentRuntimePanel.solid 直连；须在响应式
 * owner 内调用）。契约：`agents` 为 accessor（`agents()` 每次读最新列表）；卸载
 * 收尾经 onCleanup、列表跟随经 createEffect 承担。
 */
export function createAgentCandidateProvisioning(options: {
  agentClient: AgentClient
  agents: () => readonly AgentEntry[]
  reportPanelError: (operation: string, error: unknown, agentId?: string) => ReturnType<typeof reportRuntimeError>
  resolvePanelError: (operation: string, agentId?: string) => void
  reportConfigMutationError: (operation: string, error: unknown, agentId?: string) => unknown
  setFeedback: (message: string | null) => void
  setConfigConflict: (conflict: boolean) => void
  notify: (message: string) => void
}) {
  const { agentClient, reportPanelError, resolvePanelError, reportConfigMutationError, setFeedback, setConfigConflict, notify } = options
  const [candidateValidation, setCandidateValidation] = createSignal<Record<string, AgentCandidateValidationState>>({})
  const [candidateDrafts, setCandidateDrafts] = createSignal<Record<string, CandidateDraft>>({})
  const [importedCandidateIds, setImportedCandidateIds] = createSignal<Record<string, string>>({})
  const [candidateErrors, setCandidateErrors] = createSignal<Record<string, string>>({})
  const [provisioningCandidateId, setProvisioningCandidateId] = createSignal<string | null>(null)
  const [provisioningPhase, setProvisioningPhase] = createSignal<ProvisioningPhase | null>(null)
  // 组件体只跑一次：operation/ref 簿记用普通可变变量（原 useRef）。
  let currentOperation: Operation | null = null
  const draftsRef: Record<string, CandidateDraft> = {}
  const validationsRef: Record<string, ValidatedDraft> = {}
  const importedRef: Record<string, string> = {}
  let mounted = true
  onCleanup(() => { mounted = false; currentOperation = null })

  createEffect(() => {
    // A successful reload can also remove an Agent imported in this panel.
    // Keep local saved receipts through refresh failures, but retire deleted IDs.
    // ⚠️ agents 须在 effect 体顶层读取并落成局部量——依赖读取发生在嵌套 filter 回调里时
    // 重订阅不稳定（本仓 Solid 版本实测：迟到写入后 Effect 不再重跑）。
    const currentAgents = options.agents()
    const deleted = Object.entries(importedRef).filter(([, id]) => !currentAgents.some(agent => agent.id === id))
    if (deleted.length === 0) return
    for (const [candidateId] of deleted) delete importedRef[candidateId]
    setImportedCandidateIds({ ...importedRef })
  })

  const currentDraft = (candidate: AgentRuntimeCandidate) => normalizedDraft(draftsRef[candidate.candidateId] ?? candidateDraft(candidate))
  const owns = (operation: Operation) => mounted && currentOperation === operation
  const begin = (candidateId: string, phase: ProvisioningPhase): Operation | null => {
    if (currentOperation) return null
    const operation: Operation = { candidateId, phase }
    currentOperation = operation
    setProvisioningCandidateId(candidateId)
    setProvisioningPhase(phase)
    setCandidateErrors(current => { const next = { ...current }; delete next[candidateId]; return next })
    setFeedback(null)
    return operation
  }
  const finish = (operation: Operation) => {
    if (!owns(operation)) return
    currentOperation = null
    setProvisioningCandidateId(null)
    setProvisioningPhase(null)
  }
  const forgetValidation = (candidateId: string) => {
    delete validationsRef[candidateId]
    setCandidateValidation(current => { const next = { ...current }; delete next[candidateId]; return next })
  }
  const cancelCandidateValidation = () => {
    const operation = currentOperation
    if (!operation || operation.phase !== 'testing') return
    forgetValidation(operation.candidateId)
    finish(operation)
    setFeedback('已取消本次验证；迟到结果不会导入。')
  }

  const validate = async (candidate: AgentRuntimeCandidate, draft: CandidateDraft, operation: Operation) => {
    setCandidateValidation(current => ({ ...current, [candidate.candidateId]: { status: 'testing' } }))
    const result = await agentClient.testAgentCandidate(draft.id, {
      name: draft.name, provider: draft.provider, transport: 'subprocess', exe: draft.executable, args: draft.args,
    })
    if (!owns(operation)) return null
    const validation: AgentCandidateValidationState = { status: result.ok ? 'ok' : 'failed', result }
    validationsRef[candidate.candidateId] = { fingerprint: JSON.stringify(draft), validation }
    setCandidateValidation(current => ({ ...current, [candidate.candidateId]: validation }))
    if (result.ok) resolvePanelError('验证 Agent 候选', draft.id)
    else reportPanelError('验证 Agent 候选', result.error ?? new Error('Agent 候选验证失败'), draft.id)
    return validation
  }

  const importCandidate = async (candidate: AgentRuntimeCandidate, acceptUnverified = false) => {
    if (currentOperation) return
    const agents = options.agents()
    const draft = currentDraft(candidate)
    if (!draft.id || !draft.name || !draft.executable || !draft.provider) {
      setCandidateErrors(current => ({ ...current, [candidate.candidateId]: '标识、名称、可执行文件和提供方不能为空。' }))
      return
    }
    const invalid = validateInvocation({ executable: draft.executable, args: draft.args }).issues.find(issue => issue.severity === 'error')
    if (invalid) { setCandidateErrors(current => ({ ...current, [candidate.candidateId]: invalid.message })); return }
    // Preserve provider-level import deduplication, even if the list refresh failed.
    const configured = agents.find(agent => agent.provider === draft.provider)
    const reportedId = agents.find(agent => agent.id === candidate.alreadyImportedAgentId)?.id
    const existingId = importedRef[candidate.candidateId] ?? reportedId ?? configured?.id
    if (existingId) {
      importedRef[candidate.candidateId] = existingId
      setImportedCandidateIds(current => ({ ...current, [candidate.candidateId]: existingId }))
      setFeedback('已导入为 ' + existingId + '，请选择“使用此 Agent”。')
      return
    }
    if (agents.some(agent => agent.id === draft.id)) {
      setCandidateErrors(current => ({ ...current, [candidate.candidateId]: '标识 ' + draft.id + ' 已被其他 Agent 使用，请调整标识后重试。' }))
      return
    }
    const operation = begin(candidate.candidateId, 'testing')
    if (!operation) return
    let stored = false
    try {
      const receipt = validationsRef[candidate.candidateId]
      const validation = receipt?.fingerprint === JSON.stringify(draft) && (receipt.validation.status === 'ok' || acceptUnverified)
        ? receipt.validation : await validate(candidate, draft, operation)
      if (!validation || !owns(operation)) return
      const mode = candidateImportMode(candidate, validation)
      if (mode === 'blocked' || (mode === 'unverified' && !acceptUnverified)) return
      operation.phase = 'saving'
      setProvisioningPhase('saving')
      const config = { name: draft.name, provider: draft.provider, transport: 'subprocess' as const, exe: draft.executable, args: draft.args, default: agents.length === 0 }
      const result = await provisionAgentTransaction({
        candidateId: candidate.candidateId, agentId: draft.id, name: draft.name, provider: draft.provider, executable: draft.executable, args: draft.args,
      }, {
        validate: () => agentClient.testAgentCandidate(draft.id, config),
        persist: async () => {
          try { await agentClient.createAgent(draft.id, config) } catch (error) {
            if (wireErrorCode(error) !== 'config_read_only') throw error
            const document: AgentsConfigDocument = { agents: { [draft.id]: config } }
            await agentClient.initializeAgentsConfig(draft.id, document)
          }
          stored = true
          importedRef[candidate.candidateId] = draft.id
          if (mounted) setImportedCandidateIds(current => ({ ...current, [candidate.candidateId]: draft.id }))
        },
        refreshAgents: () => agentClient.listAgents(),
        applyAgents: list => useIdentityStore.getState().setAgents(list),
        activate: async () => false,
      }, { validation: validation.result, acceptUnverified: mode === 'unverified', activate: false })
      if (!owns(operation)) return
      if (result.kind === 'stored') {
        setConfigConflict(false)
        resolvePanelError('导入 Agent 候选', draft.id)
        notify('已导入 ' + draft.name + '（' + draft.id + '）' + (mode === 'unverified' ? '；尚未验证连接' : '；可点击“使用此 Agent”打开'))
      }
    } catch (error) {
      if (!owns(operation)) return
      if (operation.phase === 'testing') {
        forgetValidation(candidate.candidateId)
        reportPanelError('验证 Agent 候选', error, draft.id)
      } else reportConfigMutationError('导入 Agent 候选', error, draft.id)
      setCandidateErrors(current => ({ ...current, [candidate.candidateId]: stored
        ? '配置已保存为 ' + draft.id + '，刷新列表失败：' + errorMessage(error) + '。请重新载入配置。'
        : (operation.phase === 'testing' ? '验证' : '导入') + '失败：' + errorMessage(error, '请查看运行日志') + '。草稿已保留，可重试。' }))
    } finally { finish(operation) }
  }

  const activateImportedCandidate = async (candidate: AgentRuntimeCandidate) => {
    const configured = options.agents().find(agent => agent.id === candidate.alreadyImportedAgentId || agent.provider === currentDraft(candidate).provider)
    const agentId = importedRef[candidate.candidateId] ?? configured?.id
    if (!agentId) return
    const operation = begin(candidate.candidateId, 'activating')
    if (!operation) return
    const agentName = options.agents().find(agent => agent.id === agentId)?.name ?? candidate.name
    try {
      const activated = await activateAgentSheet(agentId, agentName, () => {
        if (owns(operation)) useWorkspaceStore.getState().openSheet({ kind: 'agent', title: agentName, agentId })
      })
      if (!owns(operation)) return
      if (activated) notify('已打开 ' + agentName)
      else setCandidateErrors(current => ({ ...current, [candidate.candidateId]: agentName + ' 尚未连接，请检查启动入口或运行日志。' }))
    } catch (error) {
      if (owns(operation)) setCandidateErrors(current => ({ ...current, [candidate.candidateId]: errorMessage(error, '连接失败') }))
    } finally { finish(operation) }
  }

  const updateCandidateDraft = (candidate: AgentRuntimeCandidate, patch: Partial<CandidateDraft>) => {
    if (currentOperation?.phase === 'saving') return
    if (currentOperation?.candidateId === candidate.candidateId) cancelCandidateValidation()
    const draft = { ...(draftsRef[candidate.candidateId] ?? candidateDraft(candidate)), ...patch }
    draftsRef[candidate.candidateId] = draft
    setCandidateDrafts(current => ({ ...current, [candidate.candidateId]: draft }))
    forgetValidation(candidate.candidateId)
    setCandidateErrors(current => { const next = { ...current }; delete next[candidate.candidateId]; return next })
  }

  return {
    candidateValidation, candidateDrafts, importedCandidateIds, candidateErrors, provisioningCandidateId, provisioningPhase,
    validateAndImportCandidate: (candidate: AgentRuntimeCandidate) => importCandidate(candidate),
    importUnverifiedCandidate: (candidate: AgentRuntimeCandidate) => importCandidate(candidate, true),
    activateImportedCandidate, updateCandidateDraft, cancelCandidateValidation,
  }
}
