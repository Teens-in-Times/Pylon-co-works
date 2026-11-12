import { appClients } from '../app/appClients.ts'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../app/runtimeError'

const pendingActivations = new Map<string, Promise<boolean>>()

/** A selected configuration is not proof that its Agent process has started. */
export function isAgentSheetRuntimeReady(agentId: string): boolean {
  return useIdentityStore.getState().activeAgent === agentId
    && useRuntimeStore.getState().agentStatuses[agentId]?.status === 'connected'
}

/** Start or switch the GUI runtime before exposing Agent business commands. */
export async function activateAgentSheet(
  agentId: string,
  agentName: string,
  onActivated: () => void,
  options?: { silent?: boolean },
): Promise<boolean> {
  if (isAgentSheetRuntimeReady(agentId)) {
    onActivated()
    return true
  }
  let activation = pendingActivations.get(agentId)
  if (!activation) {
    activation = startAgentRuntime(agentId, agentName, options)
    pendingActivations.set(agentId, activation)
  }
  try {
    const activated = await activation
    if (!activated || useIdentityStore.getState().activeAgent !== agentId) return false
    onActivated()
    return true
  } finally {
    if (pendingActivations.get(agentId) === activation) pendingActivations.delete(agentId)
  }
}

async function startAgentRuntime(agentId: string, agentName: string, options?: { silent?: boolean }): Promise<boolean> {
  const agentClient = appClients.agent()
  const result = await switchAgentTransaction(agentId, agentName, {
    switchAgent: () => agentClient.switchAgent(agentId),
    resetRuntime: () => useRuntimeStore.getState().resetSessionRuntime(),
    setActiveAgent: id => useIdentityStore.getState().setActiveAgent(id),
    fetchAgentStatus: () => agentClient.agentStatus(),
    applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
    reportError: (action, error) => reportRuntimeError(action, error, agentId, {
      key: `agent:${agentId}:${action}`,
      scope: { kind: 'agent', id: agentId },
      source: 'agent.activation',
    }),
    resolveError: action => resolveRuntimeErrors({ key: `agent:${agentId}:${action}` }),
    dispatchSwitched: () => {
      if (!options?.silent) window.dispatchEvent(new CustomEvent('pylon:agent-switched'))
    },
  })
  return result.ok
}
