// @vitest-environment jsdom
/** @jsxImportSource solid-js */
import { cleanup, render } from '@solidjs/testing-library'
import { createSignal, getOwner } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../sheetTypes.ts'

const probes = vi.hoisted(() => new Map<string, () => SheetContext>())
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
vi.mock('../SheetHost.solid.tsx', () => ({ default: (props: { sheet: SheetRecord; ctx: SheetContext }) => {
  probes.set(props.sheet.id, () => props.ctx)
  return null
} }))
vi.mock('../SheetSidebarSlot.solid.tsx', () => ({ default: (props: { ctx: SheetContext }) => { probes.set('sidebar', () => props.ctx); return null } }))
vi.mock('../../components/right-panel/RightRailHost.solid.tsx', () => ({ default: (props: { ctx: SheetContext }) => { probes.set('right-rail', () => props.ctx); return null } }))

import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import SheetLayout from '../SheetLayout.solid.tsx'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'
import { useRightRailStore } from '../../domains/workspace/layoutRailsStore.ts'
import { resetStores } from '../../test/resetStores.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore.ts'
import { useHydrationStore } from '../../app/bootstrap/hydrationState.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { registerAgentSessionSelection } from '../../app/agentSessionSelection.ts'
import { activateAgentSheet } from '../activateAgentSheet.ts'

beforeEach(() => { localStorage.clear(); resetStores(); probes.clear(); invoke.mockReset(); useHydrationStore.getState().setStatus('idle') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('keep-alive SheetContext lifetime', () => {
  it('async consumers read stable snapshots that update with activity and stop after unmount', async () => {
    const workspace = useWorkspaceStore.getState()
    const browserId = workspace.openSheet({ kind: 'browser', title: 'Browser' })!
    const fileId = workspace.openSheet({ kind: 'file', title: 'Files' })!
    workspace.focusSheet(browserId)
    const view = render(() => <SheetLayout activeSession={null} onSelectSession={() => {}} onProfileEdit={() => {}} onSessionSettings={() => {}} />)
    const readContext = probes.get(browserId)!
    const initial = readContext()
    expect(initial.isActive).toBe(true)
    const warnings = vi.spyOn(console, 'warn')
    await Promise.resolve().then(() => {
      expect(getOwner()).toBeNull()
      expect(readContext()).toBe(initial)
      expect(readContext()).toBe(initial)
    })
    expect(warnings).not.toHaveBeenCalled()
    workspace.focusSheet(fileId)
    expect(readContext().isActive).toBe(false)
    useRightRailStore.getState().setLeftRailCollapsed(true)
    expect(readContext().sidebarCollapsed).toBe(true)
    const retired = readContext()
    view.unmount()
    useRightRailStore.getState().setLeftRailCollapsed(false)
    expect(readContext()).toBe(retired)
    expect(readContext().sidebarCollapsed).toBe(true)
  })

  it('keeps two Agent selections through runtime activation, Browser return and renderer remount', async () => {
    useIdentityStore.setState({ agents: [{ id: 'qa-ui', name: '一号' }, { id: 'pylon-fake-agent', name: '二号' }], activeAgent: 'qa-ui' })
    const firstSession = useIdentityStore.getState().addSession('一号会话', 'qa-ui')
    const secondSession = useIdentityStore.getState().addSession('二号会话', 'pylon-fake-agent')
    const workspace = useWorkspaceStore.getState()
    const firstSheet = workspace.openSheet({ kind: 'agent', title: '一号', agentId: 'qa-ui' })!
    const secondSheet = workspace.openSheet({ kind: 'agent', title: '二号', agentId: 'pylon-fake-agent' })!
    const browserSheet = workspace.openSheet({ kind: 'browser', title: 'Browser' })!
    workspace.setSheetAgentState('qa-ui', { activeSessionId: firstSession, activeProfileId: 'default' })
    workspace.setSheetAgentState('pylon-fake-agent', { activeSessionId: secondSession, activeProfileId: 'default' })
    useRuntimeStore.getState().setAgentStatus('qa-ui', { agent: 'qa-ui', status: 'connected' })
    const [selected, select] = createSignal<string | null>(firstSession)
    const renderLayout = () => render(() => <SheetLayout activeSession={selected()} onSelectSession={select} onProfileEdit={() => {}} onSessionSettings={() => {}} />)
    const releaseSelection = registerAgentSessionSelection(select)
    // The application focuses an existing Sheet when identity changes, before
    // switchAgentTransaction broadcasts its completion event.
    const releaseFocus = useIdentityStore.subscribe(state => {
      if (state.activeAgent === 'pylon-fake-agent') workspace.focusSheet(secondSheet)
    })
    let releaseSwitch!: () => void
    invoke.mockImplementation((command: string) => command === 'switch_agent'
      ? new Promise<void>(resolve => { releaseSwitch = resolve })
      : Promise.resolve({ agent: 'pylon-fake-agent', agentId: 'pylon-fake-agent', status: 'connected' }))
    const view = renderLayout()
    useHydrationStore.getState().setStatus('ready')
    try {
      const switching = activateAgentSheet('pylon-fake-agent', '二号', () => workspace.focusSheet(secondSheet))
      expect(selected()).toBe(firstSession)
      expect(workspace.workspaceSheets.activeSheetId).toBe(browserSheet)
      releaseSwitch()
      expect(await switching).toBe(true)
      expect(selected()).toBe(secondSession)
      expect(probes.get(secondSheet)!().activeSession).toBe(secondSession)
      expect(probes.get('sidebar')!().activeSession).toBe(secondSession)
      expect(probes.get('right-rail')!().activeSession).toBe(secondSession)
      expect(probes.get(firstSheet)!().activeSession).toBe(firstSession)
      expect(useWorkspaceStore.getState().sheetAgentStates['qa-ui'].activeSessionId).toBe(firstSession)
      expect(useWorkspaceStore.getState().sheetAgentStates['pylon-fake-agent'].activeSessionId).toBe(secondSession)

      workspace.focusSheet(browserSheet)
      workspace.focusSheet(secondSheet)
      useInterfaceModeStore.getState().setInterfaceMode('modern-gui')
      expect(probes.get(secondSheet)!().activeSession).toBe(secondSession)
      expect(probes.get('right-rail')!().activeSession).toBe(secondSession)
      view.unmount()
      renderLayout()
      expect(probes.get(secondSheet)!().activeSession).toBe(secondSession)
      expect(selected()).toBe(secondSession)
      expect(invoke.mock.calls.filter(call => call[0] === 'switch_agent')).toHaveLength(1)
    } finally { releaseSelection(); releaseFocus() }
  })

  it('rejects cross-owner and cross-profile memory on switch completion', () => {
    const first = useIdentityStore.getState().addSession('一号会话', 'peri')
    const second = useIdentityStore.getState().addSession('二号会话', 'hermes')
    useIdentityStore.setState({ activeAgent: 'hermes', activeProfileId: 'default' })
    const select = vi.fn()
    const release = registerAgentSessionSelection(select)
    try {
      useWorkspaceStore.getState().setSheetAgentState('hermes', { activeSessionId: first })
      window.dispatchEvent(new CustomEvent('pylon:agent-switched'))
      expect(select).toHaveBeenLastCalledWith(null)
      useIdentityStore.getState().updateSession(second, { profileId: 'local' })
      useWorkspaceStore.getState().setSheetAgentState('hermes', { activeSessionId: second })
      window.dispatchEvent(new CustomEvent('pylon:agent-switched'))
      expect(select).toHaveBeenLastCalledWith(null)
      useIdentityStore.setState({ activeProfileId: 'local' })
      window.dispatchEvent(new CustomEvent('pylon:agent-switched'))
      expect(select).toHaveBeenLastCalledWith(second)
    } finally { release() }
  })
})
