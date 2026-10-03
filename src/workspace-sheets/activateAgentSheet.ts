import { appClients } from '../app/appClients.ts'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../app/runtimeError'

/**
 * Release 1.x Agent Sheet activation boundary: switch the single GUI runtime
 * before exposing a different Agent Sheet to focus or business commands.
 */
export async function activateAgentSheet(
  agentId: string,
  agentName: string,
  onActivated: () => void,
  options?: { silent?: boolean },
): Promise<boolean> {
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
    openAgentSheet: onActivated,
  })
  return result.ok
}
