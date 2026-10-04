import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hydrateIdentityAndWorkspace,
  resetHydrationCoordinator,
} from '../hydrateIdentityAndWorkspace.ts'
import { useIdentityStore } from '../../../domains/identity/identityStore.ts'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore.ts'
import { useWorkspaceEntityStore } from '../../../domains/workspace/workspaceEntityStore.ts'

describe('identity/workspace hydration coordinator', () => {
  beforeEach(() => {
    resetHydrationCoordinator()
  })

  it('single-flights concurrent callers and preserves stage order', async () => {
    const order: string[] = []
    const profiles = vi.spyOn(useIdentityStore.getState(), 'hydrateProfiles').mockImplementation(async () => { order.push('profiles') })
    const sheets = vi.spyOn(useWorkspaceStore.getState(), 'hydrateWorkspaceSheets').mockImplementation(() => { order.push('workspace-sheets') })
    const entities = vi.spyOn(useWorkspaceEntityStore.getState(), 'hydrate').mockImplementation(async () => { order.push('workspace-entities') })
    const sessions = vi.spyOn(useIdentityStore.getState(), 'hydrateSessions').mockImplementation(async () => { order.push('sessions') })

    const first = hydrateIdentityAndWorkspace()
    const second = hydrateIdentityAndWorkspace()
    expect(first).toBe(second)
    await first
    expect(order).toEqual(['profiles', 'workspace-sheets', 'workspace-entities', 'sessions'])
    profiles.mockRestore(); sheets.mockRestore(); entities.mockRestore(); sessions.mockRestore()
  })
})
