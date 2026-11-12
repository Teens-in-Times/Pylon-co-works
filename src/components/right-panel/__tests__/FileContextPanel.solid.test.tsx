// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileContextPanel from '../FileContextPanel.solid.tsx'
import { useIdentityStore, type Session } from '../../../domains/identity/identityStore.ts'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore.ts'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore.ts'
import { toAgentContextKey } from '../../../domains/agent/agentContext.ts'
import { resetStores } from '../../../test/resetStores.ts'
import type { SheetContext } from '../../../workspace-sheets/sheetTypes.ts'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock.ts')
  return tauriCoreMock(invoke)
})

function session(id: string, agentId: string): Session {
  return {
    id, agentId, source: 'same-source', name: id, profileId: 'default', createdAt: 0, lastActiveAt: 0,
    platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
  }
}

function seed() {
  useIdentityStore.setState({
    activeAgent: 'agent-a', agents: [{ id: 'agent-a', name: 'Agent A' }, { id: 'agent-b', name: 'Agent B' }],
    sessions: [session('Session A', 'agent-a'), session('Session B', 'agent-b')],
  })
  useWorkspaceStore.setState(state => ({
    workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'file', sheets: [{ id: 'file', kind: 'file', title: '文件', createdAt: 0, lastFocusedAt: 0, metadata: { activeFile: 'C:\\project\\notes.md' } }] },
    touchedFiles: { [toAgentContextKey({ agentId: 'agent-b', source: 'same-source' })]: [{ source: 'same-source', path: 'c:/project/notes.md', toolKind: 'Edit', at: 1 }] },
  }))
  let selected: string | null = 'Session A'
  const selectSession = vi.fn((id: string | null) => { selected = id })
  const openSheet = vi.fn(() => 'agent-b-sheet')
  const ctx = { selectSession, openSheet, get activeSession() { return selected } } as unknown as SheetContext
  return { ctx, selectSession, openSheet }
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
  invoke.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('File context session navigation', () => {
  it('uses the touched-file owner even with duplicate sources and waits for its real switch before selecting', async () => {
    let resolveSwitch!: (value: unknown) => void
    const pending = new Promise(resolve => { resolveSwitch = resolve })
    invoke.mockImplementation(command => command === 'switch_agent' ? pending : Promise.resolve({ agent: 'agent-b', status: 'disconnected' }))
    const { ctx, selectSession, openSheet } = seed()
    render(() => <FileContextPanel ctx={ctx} />)
    expect(screen.queryByRole('button', { name: /Session A/ })).not.toBeInTheDocument()
    const target = screen.getByRole('button', { name: /Session B/ })
    fireEvent.click(target)
    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'agent-b' })
    expect(target).toBeDisabled()
    expect(selectSession).not.toHaveBeenCalled()
    expect(openSheet).not.toHaveBeenCalled()
    expect(useIdentityStore.getState().activeAgent).toBe('agent-a')

    resolveSwitch(null)
    await waitFor(() => expect(openSheet).toHaveBeenCalledWith({ kind: 'agent', title: 'Session B', agentId: 'agent-b' }))
    expect(selectSession).toHaveBeenCalledWith('Session B')
    expect(useIdentityStore.getState().activeAgent).toBe('agent-b')
    expect(useRuntimeStore.getState().agentStatuses['agent-b'].status).toBe('disconnected')
    expect(invoke).toHaveBeenCalledWith('agent_status', undefined)
  })

  it('keeps the file page and current selection when switching the related session owner fails', async () => {
    invoke.mockRejectedValue(new Error('Agent B unavailable'))
    const { ctx, selectSession, openSheet } = seed()
    render(() => <FileContextPanel ctx={ctx} />)
    fireEvent.click(screen.getByRole('button', { name: /Session B/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent 尚未就绪')
    expect(useIdentityStore.getState().activeAgent).toBe('agent-a')
    expect(useWorkspaceStore.getState().workspaceSheets.activeSheetId).toBe('file')
    expect(ctx.activeSession).toBe('Session A')
    expect(selectSession).not.toHaveBeenCalled()
    expect(openSheet).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Session B/ })).not.toBeDisabled()
  })

  it('activates a selected but disconnected owner instead of treating configuration selection as readiness', async () => {
    const { ctx, openSheet } = seed()
    useIdentityStore.setState({ activeAgent: 'agent-b' })
    invoke.mockImplementation(command => Promise.resolve(command === 'agent_status' ? { agent: 'agent-b', status: 'disconnected' } : null))
    render(() => <FileContextPanel ctx={ctx} />)
    fireEvent.click(screen.getByRole('button', { name: /Session B/ }))
    await waitFor(() => expect(openSheet).toHaveBeenCalledOnce())
    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'agent-b' })
    expect(useRuntimeStore.getState().agentStatuses['agent-b'].status).toBe('disconnected')
  })

  it('restores the target profile before selecting a session on an already connected owner', async () => {
    const { ctx, selectSession, openSheet } = seed()
    const defaults = useIdentityStore.getState()
    useIdentityStore.setState({
      activeAgent: 'agent-b', activeProfileId: 'profile-a',
      profiles: [{ ...defaults.profiles[0], id: 'profile-a' }, { ...defaults.profiles[0], id: 'profile-b' }],
      sessions: defaults.sessions.map(item => ({ ...item, profileId: item.agentId === 'agent-b' ? 'profile-b' : 'profile-a' })),
      identityPersistence: { profiles: 'ready', sessions: 'ready' },
    })
    useRuntimeStore.getState().setAgentStatus('agent-b', { agent: 'agent-b', status: 'connected' })
    selectSession.mockImplementation(() => { expect(useIdentityStore.getState().activeProfileId).toBe('profile-b') })
    render(() => <FileContextPanel ctx={ctx} />)
    fireEvent.click(screen.getByRole('button', { name: /Session B/ }))
    await waitFor(() => expect(openSheet).toHaveBeenCalledOnce())
    expect(selectSession).toHaveBeenCalledWith('Session B')
    expect(invoke.mock.calls.some(([command]) => command === 'switch_agent')).toBe(false)
  })

  it('does not guess the current Agent for an association without a local session owner', () => {
    const { ctx, selectSession, openSheet } = seed()
    useIdentityStore.setState({ sessions: [session('Session A', 'agent-a')] })
    render(() => <FileContextPanel ctx={ctx} />)
    const unknown = screen.getByRole('button', { name: /外部会话/ })
    expect(unknown).toBeDisabled()
    fireEvent.click(unknown)
    expect(invoke).not.toHaveBeenCalled()
    expect(selectSession).not.toHaveBeenCalled()
    expect(openSheet).not.toHaveBeenCalled()
  })
})
