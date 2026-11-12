/** @jsxImportSource solid-js */
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { errorCode as wireErrorCode } from '../../infrastructure/tauri/errorPayload.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { useIdentityStore, type AgentEntry } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { selectAgentStatus } from '../../contracts/agentTypes'
import { validateInvocation } from '../../domains/agent/invocationDraft.ts'
import { builtinAgentCatalog } from '../../domains/agent/agentCatalog.ts'
import {
  agentDraftFingerprint,
  agentDraftReducer,
  canSaveAgentDraft,
  initialAgentDraftState,
  type AgentDraftState,
} from '../../domains/agent/agentDraftMachine.ts'
import {
  assertCustomProfileFieldsAllowed,
  validateCustomProfile,
} from '../../domains/agent/customProfileRules.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { createAgentDetection } from './useAgentDetection.solid.ts'
import { createAgentPanelFeedback } from './useAgentPanelFeedback.solid.ts'
import { createAgentCandidateProvisioning } from './useAgentCandidateProvisioning.solid.ts'
import AgentRuntimeCard from './AgentRuntimeCard.solid.tsx'
import AgentCandidateList from './AgentCandidateList.solid.tsx'
import AgentCreateForm, { type AgentCreateDraftInput } from './AgentCreateForm.solid.tsx'
import { emptyDraft, agentConfig, agentsDocument, type Draft } from './agentRuntimePanelDrafts'
import { activateAgentSheet } from '../../workspace-sheets/activateAgentSheet.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'

function invocationError(executable: string, args: string[]): string | null {
  const error = validateInvocation({ executable, args }).issues.find(issue => issue.severity === 'error')
  return error?.message ?? null
}

interface AgentRuntimePanelProps {
  initialAgentId?: string
}

/**
 * 施工文档 §4.1：Agent 运行时配置面板。
 * 复用既有 Settings agent section 边界；结构化操作（exe/name/provider/default/新建/测试）
 * 全部走 typed client，不重建整块 YAML。
 *
 * A-V4 拆分后本组件只保留：编辑流状态机（草稿→验证→保存，跨卡单飞）与卡级事务、
 * 新建事务、装配。探测流在 createAgentDetection；候选验证/导入在
 * createAgentCandidateProvisioning；反馈双通道（feedback/toast/冲突横幅）在
 * createAgentPanelFeedback；呈现分别在 AgentRuntimeCard / AgentCandidateList /
 * AgentCreateForm。
 */
export default function AgentRuntimePanel(props: AgentRuntimePanelProps) {
  let mounted = true
  onCleanup(() => { mounted = false })
  let testSequence = 0
  const agentClient = appClients.agent()
  const agents = createZustandSignal(useIdentityStore, s => s.agents)
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const agentStatuses = createZustandSignal(useRuntimeStore, s => s.agentStatuses)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal<Draft>(emptyDraft())
  const [savingId, setSavingId] = createSignal<string | null>(null)
  const [testingId, setTestingId] = createSignal<string | null>(null)
  const [testResult, setTestResult] = createSignal<Record<string, string>>({})
  // B1：编辑流的草稿→验证→保存生命周期收拢为显式状态机（旧 verifiedDrafts
  // 散落三处 state 的不变量在此由 reducer + 测试锁定）。Solid 无 useState 惰性初始化，
  // 工厂就地求值。
  const [draftMachine, setDraftMachine] = createSignal<AgentDraftState>(initialAgentDraftState())
  // B1：最近一次草稿验证返回的启动计划（与真实 spawn 同源；env 已在后端掩码）。
  const [draftLaunchPlan, setDraftLaunchPlan] = createSignal<{ argv: string[] } | null>(null)
  const [showCreate, setShowCreate] = createSignal(false)
  const [activatingId, setActivatingId] = createSignal<string | null>(null)
  const [createdAgent, setCreatedAgent] = createSignal<{ id: string; name: string } | null>(null)
  const [createPhase, setCreatePhase] = createSignal<'testing' | 'saving' | null>(null)
  const [expandedAgentIds, setExpandedAgentIds] = createSignal<Record<string, boolean>>({})
  // 组件体只跑一次：聚焦过账（原 useRef）用普通可变变量。
  let focusedInitialAgent: string | null = null

  const panelErrorKey = (operation: string, agentId?: string) => `agent-panel:${operation}:${agentId ?? 'app'}`
  const reportPanelError = (operation: string, error: unknown, agentId?: string) => reportRuntimeError(operation, error, agentId, {
    key: panelErrorKey(operation, agentId),
    scope: agentId ? { kind: 'agent', id: agentId } : { kind: 'app', id: 'agent-settings' },
    source: 'settings.agent-runtime',
  })
  const resolvePanelError = (operation: string, agentId?: string) => resolveRuntimeErrors({ key: panelErrorKey(operation, agentId) })

  const { feedback, setFeedback, toast, notify, configConflict, setConfigConflict, reportConfigMutationError } =
    createAgentPanelFeedback({ reportPanelError })

  const refreshAgents = async () => {
    const list = await agentClient.listAgents()
    useIdentityStore.getState().setAgents(list)
  }

  const { detecting, detectRuntimes, probeFailureByAgentId, ...detection } = createAgentDetection({
    reportPanelError, resolvePanelError, setFeedback,
  })
  // A discovery snapshot can outlive a delete or manual import in this panel.
  // The current registry owns whether a provider is already configured.
  // ⚠️ 候选数组按**报告原引用**直传（Solid For 按对象引用判行——不得在宿主做 map 产生
  // 新对象身份，否则每次 agents 变更整列 DOM 重挂，React 时代 keyed reconcile 的
  // 「原地更新」契约被破坏）；导入态解析改为 lookup prop，由候选行内响应式调用。

  const provisioning = createAgentCandidateProvisioning({
    agentClient, agents, reportPanelError, resolvePanelError, reportConfigMutationError,
    setFeedback, setConfigConflict, notify,
  })

  const reloadConfigSnapshot = async () => {
    try {
      await agentClient.agentConfigSnapshot()
      await refreshAgents()
      setConfigConflict(false)
      setFeedback('配置已重新载入；未提交草稿仍保留。')
      resolvePanelError('重新载入 Agent 配置')
    } catch (error) {
      reportPanelError('重新载入 Agent 配置', error)
      setFeedback('重新载入失败，详情见右下角错误中心')
    }
  }

  // 深链 initialAgentId：目标 Agent 出现于列表时聚焦其编辑卡（一次）。
  createEffect(() => {
    const list = agents()
    const initialAgentId = props.initialAgentId
    if (!initialAgentId || focusedInitialAgent === initialAgentId) return
    const target = list.find(agent => agent.id === initialAgentId)
    if (!target) return
    focusedInitialAgent = initialAgentId
    setEditingId(target.id)
    setDraft(emptyDraft(target))
    setDraftMachine(agentDraftReducer(initialAgentDraftState(), { type: 'select', agentId: target.id }))
    setFeedback('请重新选择或修正该 Agent 的可执行文件。')
  })

  const startEdit = (agent: AgentEntry) => {
    testSequence += 1
    setTestingId(null)
    setEditingId(agent.id)
    setDraft(emptyDraft(agent))
    setFeedback(null)
    setDraftLaunchPlan(null)
    setDraftMachine(agentDraftReducer(initialAgentDraftState(), { type: 'select', agentId: agent.id }))
  }

  /** 草稿任一字段变更：指纹更新 + 旧验证立即失效（状态机保证）。 */
  const patchDraft = (updater: (current: Draft) => Draft) => {
    if (draftMachine().phase === 'testing') {
      testSequence += 1
      setTestingId(null)
      setDraftLaunchPlan(null)
      const agentId = editingId()
      if (agentId) setTestResult(current => ({ ...current, [agentId]: '配置已修改，请重新测试连接。' }))
    }
    setDraft(current => {
      const next = updater(current)
      setDraftMachine(machine => agentDraftReducer(machine, {
        type: 'edit',
        fingerprint: agentDraftFingerprint({ name: next.name, provider: next.provider, exe: next.exe, args: next.args }),
      }))
      return next
    })
  }

  const saveEdit = async (agentId: string) => {
    if (savingId()) return
    const current = draft()
    const invalid = invocationError(current.exe, current.args)
    if (invalid) { setFeedback(invalid); return }
    // 状态机 fail-closed：只有 verified 且验证过的指纹与草稿当前指纹相等
    // 才能保存（草稿变更/切换 agent/取消都会使旧验证失效）。
    if (draftMachine().agentId !== agentId || !canSaveAgentDraft(draftMachine())) {
      setFeedback('请先测试连接成功，再保存配置变更。')
      return
    }
    setDraftMachine(machine => agentDraftReducer(machine, { type: 'saveBegin' }))
    setSavingId(agentId)
    setFeedback(null)
    try {
      await agentClient.ensureConfigRevision()
      await agentClient.updateAgentFieldPatch(agentId, {
        name: current.name,
        exe: current.exe,
        provider: current.provider.trim() || null,
        ...(current.argsKnown ? { args: [...current.args] } : {}),
      })
      await refreshAgents()
      setDraftMachine(machine => agentDraftReducer(machine, { type: 'saveEnd', ok: true }))
      setEditingId(null)
      setConfigConflict(false)
      setFeedback(null)
      resolvePanelError('保存 Agent 字段', agentId)
      notify(`已保存 ${agentId}`)
    } catch (error) {
      // 保存失败（含 CAS 冲突）：状态机回到 verified，草稿与验证都保留，可重试。
      setDraftMachine(machine => agentDraftReducer(machine, { type: 'saveEnd', ok: false }))
      reportConfigMutationError('保存 Agent 字段', error, agentId)
      notify(`保存失败：${agentId}`)
    } finally {
      setSavingId(null)
    }
  }

  const setDefault = async (agentId: string) => {
    if (savingId()) return
    setSavingId(agentId)
    setFeedback(null)
    try {
      await agentClient.ensureConfigRevision()
      try {
        await agentClient.updateAgentFieldPatch(agentId, { default: true })
      } catch (error) {
        if (wireErrorCode(error) !== 'config_read_only') throw error
        await agentClient.initializeAgentFieldPatch(agentId, { default: true })
      }
      await refreshAgents()
      setConfigConflict(false)
      setFeedback(null)
      resolvePanelError('设置默认 Agent', agentId)
      notify(`已将 ${agentId} 设为默认`)
    } catch (error) {
      reportConfigMutationError('设置默认 Agent', error, agentId)
    } finally {
      setSavingId(null)
    }
  }

  /** issue #67A：删除已连接的 agent runtime 配置条目。
   *  用户裁定口径：仅摘配置 + 停 runtime，**不**删该 agent 的会话与记录数据；
   *  删除前必须让用户看清"将移除什么 / 保留什么"——确认交互由 AgentRuntimeCard 的
   *  ConfirmArmButton 承载（armed 态旁注影响面，#520 K 域起替代 window.confirm 式）。
   *  active agent 先由前端拦一道（后端 `config_active_agent_protected` 仍是唯一真值）。 */
  const deleteAgent = async (agent: AgentEntry) => {
    if (savingId() || testingId()) return
    if (agent.id === activeAgent()) {
      setFeedback('当前正在使用的 Agent 不能删除，请先切换到其它 Agent。')
      return
    }
    setSavingId(agent.id)
    setFeedback(null)
    try {
      await agentClient.deleteAgent(agent.id)
      if (editingId() === agent.id) {
        setEditingId(null)
        setDraftMachine(initialAgentDraftState())
      }
      await refreshAgents()
      setConfigConflict(false)
      setFeedback(null)
      resolvePanelError('删除 Agent', agent.id)
      notify(`已删除 ${agent.name}（${agent.id}）`)
    } catch (error) {
      reportConfigMutationError('删除 Agent', error, agent.id)
    } finally {
      setSavingId(null)
    }
  }

  const testConnection = async (agentId: string) => {
    if (testingId()) return
    const sequence = ++testSequence
    const isCurrent = () => mounted && sequence === testSequence
    setTestingId(agentId)
    setTestResult(current => ({ ...current, [agentId]: '测试中…' }))
    try {
      const result = await agentClient.testAgentConnection(agentId)
      if (!isCurrent()) return
      setTestResult(current => ({
        ...current,
        [agentId]: result.ok
          ? `连接成功（${result.durationMs}ms）`
          : `连接失败：${result.error?.message ?? '未知错误'}`,
      }))
      if (result.ok) {
        resolvePanelError('测试 Agent 连接', agentId)
      } else {
        reportPanelError('测试 Agent 连接', result.error ?? new Error('Agent 连接失败'), agentId)
      }
    } catch (error) {
      if (!isCurrent()) return
      const detail = reportPanelError('测试 Agent 连接', error, agentId)
      setTestResult(current => ({ ...current, [agentId]: detail.message }))
    } finally {
      if (isCurrent()) setTestingId(null)
    }
  }

  const testDraftConnection = async (agentId: string) => {
    if (testingId()) return
    const current = draft()
    const invalid = invocationError(current.exe, current.args)
    if (invalid) { setFeedback(invalid); return }
    const sequence = ++testSequence
    const isCurrent = () => mounted && sequence === testSequence
    // 在发起验证前捕获草稿指纹：验证期间用户再改草稿，状态机会作废本次验证。
    const testedFingerprint = agentDraftFingerprint({ name: current.name, provider: current.provider, exe: current.exe, args: current.args })
    setDraftMachine(machine => agentDraftReducer(machine, { type: 'testBegin' }))
    // Solid setter 同步生效：此处读到的已是 testBegin 后的机器（testRequestId 已 +1）。
    const requestId = draftMachine().testRequestId
    setTestingId(agentId)
    setDraftLaunchPlan(null)
    setTestResult(currentState => ({ ...currentState, [agentId]: '测试中…' }))
    try {
      const result = await agentClient.testAgentCandidate(agentId, {
        name: current.name.trim(), provider: current.provider.trim(), transport: 'subprocess', exe: current.exe.trim(), args: [...current.args],
      })
      if (!isCurrent()) return
      setDraftLaunchPlan(result.launchPlan && 'argv' in result.launchPlan ? { argv: result.launchPlan.argv } : null)
      if (!result.ok) throw new Error(result.error?.message ?? '连接失败')
      setDraftMachine(machine => agentDraftReducer(machine, {
        type: 'testEnd', requestId, ok: true, testedFingerprint,
        message: `连接成功（${result.durationMs}ms），现在可以保存`,
      }))
      setTestResult(currentState => ({ ...currentState, [agentId]: `连接成功（${result.durationMs}ms），现在可以保存` }))
      setFeedback(null)
    } catch (error) {
      if (!isCurrent()) return
      const message = `连接失败：${error instanceof Error ? error.message : String(error)}`
      setDraftMachine(machine => agentDraftReducer(machine, {
        type: 'testEnd', requestId, ok: false, testedFingerprint, message,
      }))
      setTestResult(currentState => ({ ...currentState, [agentId]: message }))
    } finally { if (isCurrent()) setTestingId(null) }
  }

  /** A cancelled probe cannot overwrite a later probe's status or busy lock. */
  const cancelDraftTest = () => {
    testSequence += 1
    setDraftMachine(machine => agentDraftReducer(machine, { type: 'testCancel' }))
    setTestingId(null)
    const agentId = editingId()
    if (agentId) setTestResult(current => ({ ...current, [agentId]: '验证已取消，可以重新测试。' }))
  }

  const restartRuntime = async (agentId: string) => {
    if (savingId()) return
    setSavingId(agentId)
    setFeedback(null)
    try {
      await agentClient.restartAgentRuntime(agentId)
      await refreshAgents()
      resolvePanelError('重启 Agent runtime', agentId)
      notify(`已重启 ${agentId} 并应用配置`)
    } catch (error) {
      reportConfigMutationError('重启 Agent runtime', error, agentId)
    } finally {
      setSavingId(null)
    }
  }

  const createAgent = async (createDraft: AgentCreateDraftInput) => {
    if (savingId()) return
    const id = createDraft.id.trim()
    // B1：自定义 profile 规则（复用 Codeg 类别）：slug、重复 id、内置 id 冲突、
    // 必填 launch。后端另有同款 slug/重复校验；此处让用户在提交前看到原因。
    const profileIssues = validateCustomProfile(
      { id, name: createDraft.name, exe: createDraft.exe, provider: createDraft.provider },
      agents().map(agent => agent.id),
      builtinAgentCatalog.providers(),
    )
    if (profileIssues.length > 0) {
      setFeedback(profileIssues.map(issue => issue.message).join('；'))
      return
    }
    const invalid = invocationError(createDraft.exe, createDraft.args)
    if (invalid) { setFeedback(invalid); return }
    setSavingId(id)
    setCreatePhase('testing')
    setFeedback(null)
    const config = agentConfig(createDraft.name, createDraft.exe, createDraft.args, createDraft.provider, agents().length === 0)
    let stored = false
    // SAFETY: AgentCreateConfig 是扁平 JSON 对象的命名类型；此断言只把它扩宽为按**键名**读取的
    // 视图（assertCustomProfileFieldsAllowed 仅遍历 Object.keys，不读值），结构不变、不丢字段。
    assertCustomProfileFieldsAllowed(config as unknown as Record<string, unknown>)
    try {
      const validation = await agentClient.testAgentCandidate(id, { ...config, provider: config.provider ?? createDraft.provider })
      if (!mounted) return
      if (!validation.ok) {
        const detail = reportPanelError('验证手动 Agent', validation.error ?? new Error('连接验证未通过'), id)
        setFeedback(`连接验证未通过：${detail.message}。请修正启动入口后重试，草稿已保留。`)
        return
      }
      resolvePanelError('验证手动 Agent', id)
      setCreatePhase('saving')
      await agentClient.ensureConfigRevision()
      if (!mounted) return
      await agentClient.createAgent(id, config)
      stored = true
      setCreatedAgent({ id, name: createDraft.name })
      setShowCreate(false)
      await refreshAgents()
      setConfigConflict(false)
      setFeedback(null)
      resolvePanelError('新建 Agent', id)
      notify(`已新建 Agent ${id}`)
    } catch (error) {
      if (!mounted) return
      if (stored) {
        reportPanelError('刷新 Agent 列表', error, id)
        setConfigConflict(true)
        setFeedback(`${createDraft.name} 已保存，但列表刷新失败。请重新载入配置，无需重复创建。`)
        return
      }
      // 施工文档 §4.6：embedded source 首次配置——create 撞 config_read_only 时，
      // 自动改为在 exe 旁初始化外部 agents.yaml（同一最小配置）。
      if (createPhase() === 'saving' && wireErrorCode(error) === 'config_read_only') {
        try {
          await agentClient.initializeAgentsConfig(id, agentsDocument(id, config))
          setCreatedAgent({ id, name: createDraft.name })
          setShowCreate(false)
          await refreshAgents()
          resolvePanelError('初始化 Agent 配置', id)
          setShowCreate(false)
          setFeedback(`已初始化外部配置并新建 Agent ${id}`)
        } catch (initError) {
          reportConfigMutationError('初始化 Agent 配置', initError, id)
        }
        return
      }
      reportConfigMutationError('新建 Agent', error, id)
    } finally {
      setSavingId(null)
      setCreatePhase(null)
    }
  }

  const openAgent = async (id: string, name: string) => {
    if (activatingId()) return
    setActivatingId(id)
    try {
      const opened = await activateAgentSheet(id, name, () => { if (mounted) useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: id, title: name }) })
      if (!mounted) return
      if (!opened) setFeedback(`${name} 尚未连接，请检查启动入口或运行日志。`)
    } catch (error) {
      const detail = reportPanelError('打开 Agent 对话', error, id)
      setFeedback(detail.message)
    } finally { setActivatingId(null) }
  }

  return (
    <div class="agent-runtime-panel">
      <Show when={toast()}>
        <div class="agent-runtime-toast" role="status" aria-live="polite">{toast()}</div>
      </Show>
      <Show when={feedback()}><div class="set-hint" role="status">{feedback()}</div></Show>
      <Show when={configConflict()}>
        <button type="button" class="set-btn" onClick={() => void reloadConfigSnapshot()}>
          重新载入配置
        </button>
      </Show>

      <Show when={!showCreate()}>
      <AgentCandidateList
        candidates={detection.candidates()}
        resolveImportedAgentId={candidate => {
          const currentAgents = agents()
          return currentAgents.find(agent => agent.id === candidate.alreadyImportedAgentId || agent.provider === candidate.provider)?.id
        }}
        selectedCandidateId={detection.selectedCandidateId()}
        onSelectCandidate={detection.setSelectedCandidateId}
        detectionDiagnostics={detection.detectionDiagnostics()}
        detectionElapsedMs={detection.detectionElapsedMs()}
        detectionPreflight={detection.detectionPreflight()}
        detectionTruncated={detection.detectionTruncated()}
        detectionCompleted={detection.detectionCompleted()}
        detecting={detecting()}
        onRedetect={() => { void detectRuntimes(true) }}
        onCancelDetection={detection.cancelDetection}
        onManualCreate={() => setShowCreate(true)}
        candidateDrafts={provisioning.candidateDrafts()}
        candidateValidation={provisioning.candidateValidation()}
        importedCandidateIds={provisioning.importedCandidateIds()}
        candidateErrors={provisioning.candidateErrors()}
        provisioningCandidateId={provisioning.provisioningCandidateId() ?? savingId() ?? testingId() ?? activatingId()}
        provisioningPhase={provisioning.provisioningPhase()}
        onCancelValidation={provisioning.cancelCandidateValidation}
        onValidateAndImport={candidate => { void provisioning.validateAndImportCandidate(candidate) }}
        onImportUnverified={candidate => { void provisioning.importUnverifiedCandidate(candidate) }}
        onActivateImported={candidate => { void provisioning.activateImportedCandidate(candidate) }}
        onUpdateCandidateDraft={provisioning.updateCandidateDraft}
      />
      </Show>

      <Show when={showCreate()}>
        <div class="flex items-center justify-between gap-3 border-t border-stroke-subtle pt-5">
          <h4 class="m-0 text-[16px] font-semibold">手动添加 Agent</h4>
          <button class="ps-btn sm" type="button" disabled={savingId() !== null} onClick={() => setShowCreate(false)}>返回发现结果</button>
        </div>
        <AgentCreateForm busy={savingId() !== null} phase={createPhase()} onCreate={createAgent} />
      </Show>
      <Show when={createdAgent()}>
        <div class="flex items-center justify-between flex-wrap gap-3 py-4 border-t border-stroke-subtle" role="status">
          <span class="text-[13px]">{createdAgent()!.name} 已添加，可以开始对话。</span>
          <button class="ps-btn sm primary" type="button" disabled={activatingId() !== null} onClick={() => { void openAgent(createdAgent()!.id, createdAgent()!.name) }}>{activatingId() ? '连接中…' : '打开对话'}</button>
        </div>
      </Show>
      <Show when={agents().length > 0}>
        <section class="mt-6 pt-5 border-t border-stroke-subtle" aria-label="已配置的 Agent">
          <header class="flex items-baseline justify-between gap-3 mb-1"><h4 class="m-0 text-[17px] font-semibold">已配置的 Agent</h4><span class="text-[12px] text-text-dim">{agents().length} 个运行时</span></header>
          <For each={agents()}>{agent => {
        const status = () => selectAgentStatus(agent.id, activeAgent(), agentStatuses())
        return (
          <AgentRuntimeCard
            agent={agent}
            expanded={expandedAgentIds()[agent.id] === true}
            onToggleExpanded={() => setExpandedAgentIds(current => ({ ...current, [agent.id]: !current[agent.id] }))}
            onOpenAgent={() => { void openAgent(agent.id, agent.name) }}
            activating={activatingId() === agent.id}
            activeAgent={activeAgent()}
            status={status()}
            isEditing={editingId() === agent.id}
            draft={draft()}
            onPatchDraft={patchDraft}
            draftLaunchPlan={draftLaunchPlan()}
            draftMachinePhase={draftMachine().phase}
            probeFailure={probeFailureByAgentId().get(agent.id)}
            detecting={detecting()}
            onRedetect={() => { void detectRuntimes(true) }}
            savingId={savingId() ?? provisioning.provisioningCandidateId() ?? activatingId()}
            testingId={testingId()}
            testResultText={testResult()[agent.id]}
            onStartEdit={() => startEdit(agent)}
            onSaveEdit={() => { void saveEdit(agent.id) }}
            onTestDraftConnection={() => { void testDraftConnection(agent.id) }}
            onCancelDraftTest={cancelDraftTest}
            onCancelEdit={() => { setEditingId(null); setDraftMachine(initialAgentDraftState()) }}
            onSetDefault={() => { void setDefault(agent.id) }}
            onTestConnection={() => { void testConnection(agent.id) }}
            onRestartRuntime={() => { void restartRuntime(agent.id) }}
            onDeleteAgent={() => { void deleteAgent(agent) }}
          />
        )
      }}</For>
        </section>
      </Show>
    </div>
  )
}
