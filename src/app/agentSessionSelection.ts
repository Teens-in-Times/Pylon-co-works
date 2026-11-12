import { useIdentityStore } from '../domains/identity/identityStore.ts'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore.ts'

/** Switching the runtime can focus its Sheet before the transaction broadcasts.
 * Restore its validated selection instead of erasing the just-restored memory. */
export function registerAgentSessionSelection(selectSession: (id: string | null) => void): () => void {
  const restoreSelection = () => {
    const identity = useIdentityStore.getState()
    const remembered = useWorkspaceStore.getState().sheetAgentStates[identity.activeAgent]?.activeSessionId
    const session = identity.sessions.find(item => item.id === remembered
      && item.agentId === identity.activeAgent && item.profileId === identity.activeProfileId)
    selectSession(session?.id ?? null)
  }
  window.addEventListener('pylon:agent-switched', restoreSelection)
  return () => window.removeEventListener('pylon:agent-switched', restoreSelection)
}
