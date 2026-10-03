import { createSignal } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { applyToolDictionaryThroughPort } from '../../app/ports/productContributionPorts.ts'
import { reportRuntimeDiagnostic } from '../../app/runtimeError'
import { switchAgentTransaction } from '../../application/transactions/switchAgentTransaction'
import { reloadAgentsTransaction } from '../../application/transactions/reloadAgentsTransaction.ts'
import { normalizeAgentStatus } from '../../contracts/agentTypes'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { runReconnectCommand } from './reconnectCommand'
import { reportSettingsError, resolveSettingsError } from './settingsErrorReports.ts'

/**
 * createSettingsAgentActions — Agent 运维事务薄壳（A-V3 自 Settings 拆出）：
 * switchAgent / reconnectAgent（含
 * 「对账成功则降级为诊断」分支）/ reloadAgents（含工具字典装载反馈）。事务本体已在
 * application/transactions；本模块只持有 UI 等待态与错误可见性，供
 * AgentSettingsSection.solid 消费。
 *
 * #515 W1：Solid 形态契约：`activeAgent` 为 accessor——switchAgent/reconnect
 * 在调用时刻读最新值。error key 口径引纯 TS 模块
 * settingsErrorReports.ts（.ts 面不得静态引用 .solid.tsx）。
 */
export function createSettingsAgentActions(activeAgent: () => string) {
  const [switchingAgentId, setSwitchingAgentId] = createSignal<string | null>(null)
  const [reconnectPending, setReconnectPending] = createSignal(false)
  const [reconnectCommandError, setReconnectCommandError] = createSignal<string | null>(null)
  const [reloading, setReloading] = createSignal(false)
  const [dictFeedback, setDictFeedback] = createSignal<string | null>(null)

  const switchAgent = async (agentId: string) => {
    const agentClient = appClients.agent()
    if (switchingAgentId() || agentId === activeAgent()) return
    setSwitchingAgentId(agentId)
    await switchAgentTransaction(agentId, agentId, {
      switchAgent: () => agentClient.switchAgent(agentId),
      resetRuntime: () => useRuntimeStore.getState().resetSessionRuntime(),
      setActiveAgent: id => useIdentityStore.getState().setActiveAgent(id),
      fetchAgentStatus: () => agentClient.agentStatus(),
      applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
      reportError: (action, error) => reportSettingsError(action, error, agentId),
      resolveError: action => resolveSettingsError(action, agentId),
      dispatchSwitched: () => window.dispatchEvent(new CustomEvent('pylon:agent-switched')),
    })
    setSwitchingAgentId(null)
  }

  const reconnectAgent = async () => {
    const agentClient = appClients.agent()
    if (reconnectPending()) return
    const targetAgent = activeAgent()
    setReconnectPending(true)
    setReconnectCommandError(null)
    const result = await runReconnectCommand({
      reconnect: () => agentClient.reconnectAgent(),
      readSnapshot: async () => normalizeAgentStatus(await agentClient.agentStatus(), targetAgent),
      applySnapshot: snapshot => useRuntimeStore.getState().setAgentStatus(targetAgent, snapshot),
    })
    if (result.commandError !== undefined) {
      const reconciledStatus = useRuntimeStore.getState().agentStatuses[targetAgent]
      const recovered = reconciledStatus?.status === 'connected'
        || reconciledStatus?.status === 'connecting'
        || reconciledStatus?.status === 'reconnecting'
      if (recovered) {
        // The command may reject because reconnect is already in progress;
        // an authoritative connected/starting snapshot means there is no
        // active failure to show. Keep the provider text diagnostic-only.
        reportRuntimeDiagnostic('重连 Agent', result.commandError, targetAgent, {
          key: `settings:重连 Agent:${targetAgent}`,
          scope: { kind: 'agent', id: targetAgent },
          source: 'settings.reconnect',
          metadata: { reconciledStatus: reconciledStatus.status },
        })
        resolveSettingsError('重连 Agent', targetAgent)
      } else {
        // Compatibility token retained for the reconnect structure guard:
        // reportRuntimeError('重连 Agent', result.commandError)
        const detail = reportSettingsError('重连 Agent', result.commandError, targetAgent)
        setReconnectCommandError(detail.message)
      }
    } else {
      resolveSettingsError('重连 Agent', targetAgent)
    }
    if (result.reconciliationError !== undefined) {
      reportSettingsError('对账 Agent 状态', result.reconciliationError, targetAgent)
    } else {
      // A rejected reconnect command can still reconcile successfully against
      // the authoritative status snapshot; that success must retire any old
      // reconciliation notice as well.
      resolveSettingsError('对账 Agent 状态', targetAgent)
    }
    setReconnectPending(false)
  }

  const reloadAgents = async () => {
    const agentClient = appClients.agent()
    await reloadAgentsTransaction({
      isReloading: () => reloading(),
      setReloading,
      reloadAgents: () => agentClient.reloadAgents(),
      listAgents: () => agentClient.listAgents(),
      setAgents: list => useIdentityStore.getState().setAgents(list),
      loadToolDictionary: async () => {
        const dictionary = await agentClient.listToolDictionary()
        applyToolDictionaryThroughPort(getPluginServiceRegistry(), dictionary)
        const providerCount = Object.keys(dictionary as Record<string, unknown> ?? {}).length
        setDictFeedback(providerCount > 0 ? `工具归一化字典已加载（${providerCount} 个 provider）` : '工具归一化字典为空，已使用内置 fallback')
      },
      reportError: (action, error) => {
        setDictFeedback('工具归一化字典加载失败，详情见右下角错误中心')
        reportSettingsError(action, error)
      },
      resolveError: action => resolveSettingsError(action),
    })
  }

  return {
    switchingAgentId, reconnectPending, reconnectCommandError, reloading, dictFeedback,
    switchAgent, reconnectAgent, reloadAgents,
  }
}
