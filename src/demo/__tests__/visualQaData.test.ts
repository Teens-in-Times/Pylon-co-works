// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildVisualQaMessages,
  buildVisualQaPluginPackages,
  buildVisualQaSessions,
  buildVisualQaWorkspaces,
} from '../visualQaData.ts'
import { mockInvokeCommand } from '../mockTauri.ts'
import { seedDemo } from '../seed.ts'
import { buildDemoMessages, buildDemoSessions } from '../demoData.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { messageStorageKey, parseMessageSnapshot } from '../../domains/chat/messagePersistence.ts'
import { resetStores } from '../../test/resetStores.ts'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'

afterEach(() => { resetStores(); localStorage.clear() })

describe('browser visual QA dataset', () => {
  it('standard reset replaces an existing visual seed and stale snapshot without changing appearance', () => {
    const select = vi.fn()
    seedDemo(select, { scenario: 'visual', reset: true })
    expect(useIdentityStore.getState().sessions.some(session => session.id === 'demo-visual-matrix')).toBe(true)
    const standard = buildDemoSessions()
    localStorage.setItem(messageStorageKey(standard[0].id), '[]')
    localStorage.setItem('pylon-theme', 'preserved-theme-value')
    useInterfaceModeStore.getState().setInterfaceMode('modern-gui')

    seedDemo(select, { scenario: 'standard', reset: true })

    expect(useIdentityStore.getState().sessions.map(session => session.id)).toEqual(standard.map(session => session.id))
    expect(parseMessageSnapshot(localStorage.getItem(messageStorageKey(standard[0].id)))).toEqual(buildDemoMessages(standard[0].id))
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.some(sheet => sheet.kind === 'browser')).toBe(false)
    expect(select).toHaveBeenLastCalledWith(standard[0].id)
    expect(localStorage.getItem('pylon-theme')).toBe('preserved-theme-value')
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
  })

  it('ordinary standard reload preserves existing sessions and message edits', () => {
    seedDemo(() => {}, { scenario: 'standard', reset: true })
    const current = useIdentityStore.getState().sessions[0]
    useIdentityStore.setState({ sessions: [{ ...current, name: '保留我的会话' }] })
    const stored = JSON.stringify([{ ...buildDemoMessages(current.id)[0], content: '保留我的草稿' }])
    localStorage.setItem(messageStorageKey(current.id), stored)

    seedDemo(() => {}, { scenario: 'standard' })

    expect(useIdentityStore.getState().sessions[0].name).toBe('保留我的会话')
    expect(localStorage.getItem(messageStorageKey(current.id))).toBe(stored)
  })

  it('provides a dense, referentially valid workspace/session graph', () => {
    const sessions = buildVisualQaSessions()
    const workspaces = buildVisualQaWorkspaces()
    const workspaceIds = new Set(workspaces.map(workspace => workspace.id))

    expect(sessions.length).toBeGreaterThanOrEqual(10)
    expect(workspaces.length).toBeGreaterThanOrEqual(8)
    expect(new Set(sessions.map(session => session.id)).size).toBe(sessions.length)
    expect(new Set(workspaces.map(workspace => workspace.id)).size).toBe(workspaces.length)
    expect(sessions.filter(session => session.workspaceId).every(session => workspaceIds.has(session.workspaceId!))).toBe(true)
    expect(sessions.some(session => session.workspaceId === undefined)).toBe(true)
    expect(workspaces.some(workspace => workspace.rootPath.length > 70)).toBe(true)
  })

  it('covers rich renderers, long context, tool states, i18n and empty state', () => {
    const matrix = buildVisualQaMessages('demo-visual-matrix')
    const longContext = buildVisualQaMessages('demo-long-context')
    const swarm = buildVisualQaMessages('demo-task-swarm')
    const i18n = buildVisualQaMessages('demo-i18n')

    expect(matrix.length).toBeGreaterThanOrEqual(20)
    expect(longContext).toHaveLength(36)
    expect(swarm.filter(message => message.role === 'tool').length).toBeGreaterThanOrEqual(20)
    const toolStates = new Set(swarm.map(message => message.toolStatus).filter(Boolean))
    expect(toolStates.size).toBe(7)
    expect([...toolStates]).toEqual(expect.arrayContaining(['completed', 'in_progress', 'waiting', 'failed']))
    const structured = matrix.find(message => message.id === 'mock-assistant-structured') as MessageWithSemanticParts | undefined
    expect(structured?.semanticParts?.map(part => part.kind)).toEqual(expect.arrayContaining([
      'location', 'progress', 'list', 'key-value', 'json', 'tool-use', 'tool-result',
    ]))
    expect(i18n.map(message => message.content).join('\n')).toMatch(/日本語/)
    expect(i18n.map(message => message.content).join('\n')).toMatch(/العربية/)
    expect(buildVisualQaMessages('demo-empty')).toEqual([])
  })

  it('populates browser backend workspaces and API 1.0 plugin packages', async () => {
    const workspaces = await mockInvokeCommand('workspace_list')
    const packages = buildVisualQaPluginPackages()
    const installed = await mockInvokeCommand('plugin_package_list')

    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'w-pylon', skills: expect.any(Array) }),
    ]))
    expect(installed).toHaveLength(packages.length)
    expect(packages.every(item => item.package.manifest.api === '1.0' && item.enabled === false)).toBe(true)
  })

  it('provides an agent status snapshot for browser agent switching', async () => {
    const initial = await mockInvokeCommand('agent_status') as { agentId?: string; status?: string }
    expect(initial).toMatchObject({ agentId: 'peri', status: 'connected' })

    await mockInvokeCommand('switch_agent', { name: 'pi' })
    const switched = await mockInvokeCommand('agent_status') as { agentId?: string; status?: string }
    expect(switched).toMatchObject({ agentId: 'pi', status: 'connecting' })

    // Keep the module-level browser fixture deterministic for following tests.
    await mockInvokeCommand('switch_agent', { name: 'peri' })
  })

  it('keeps browser-mode Git mutations stateful for interaction QA', async () => {
    await mockInvokeCommand('git_stage', { paths: ['src/sheets/AgentSheetView.tsx'] })
    const staged = await mockInvokeCommand('git_status_with_branch') as { entries: Array<{ path: string; staged: boolean }> }
    expect(staged.entries.find(entry => entry.path === 'src/sheets/AgentSheetView.tsx')?.staged).toBe(true)

    const branch = await mockInvokeCommand('git_create_branch', { name: 'feature/visual-qa' }) as { status: { branch: { branch: string } } }
    expect(branch.status.branch.branch).toBe('feature/visual-qa')

    await mockInvokeCommand('git_unstage', { paths: ['src/sheets/AgentSheetView.tsx'] })
  })
})

interface MessageWithSemanticParts {
  readonly semanticParts?: readonly { readonly kind: string }[]
}
