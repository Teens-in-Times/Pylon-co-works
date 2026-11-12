// @vitest-environment jsdom
/** @jsxImportSource solid-js */
import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateBuiltinPlugin, getPluginRuntime } from '../../../plugin-runtime/pluginCompositionRoot.ts'
import { getRendererRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { useIdentityStore, type Session } from '../../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore.ts'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore.ts'
import { toCanonicalOwnerKey } from '../../../domains/events/eventSchema.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { flushTask } from '../../../test/solidTestHelpers.ts'
import { resetAgentProbeForTests } from '../agentAdvertisedModels.ts'
import { RECOVERY_RETRY_DELAY_MS } from '../agentWorkbenchLifecycle.ts'
import AgentRendererSuiteWorkbench from '../../../sheets/agent-workbench/AgentRendererSuiteWorkbench.solid.tsx'
import type { SheetContext } from '../../../workspace-sheets/sheetTypes.ts'

const { invoke, reportError, reportDiagnostic } = vi.hoisted(() => ({ invoke: vi.fn(), reportError: vi.fn(), reportDiagnostic: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock.ts')
  return tauriCoreMock(invoke)
})
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, isBrowserMockRuntime: () => false, hasTauriRuntime: () => true }))
vi.mock('../../../app/runtimeError.ts', async original => ({
  ...await original<Record<string, unknown>>(), reportRuntimeError: reportError, reportRuntimeDiagnostic: reportDiagnostic,
}))

const session: Session = {
  id: 'session-b', source: 'local:session-b', agentId: 'agent-b', profileId: 'default', name: 'B 的会话',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '', periId: 'remote-b',
}
const owner = { profileId: session.profileId, agentId: session.agentId, localSessionId: session.source }
const ownerKey = toCanonicalOwnerKey(owner)
const localRow = {
  schemaVersion: 1, eventId: `${ownerKey}#1`, owner, sequence: 1, clientGeneration: 1,
  occurredAt: '2026-11-13T00:00:00.000Z', receivedAt: '2026-11-13T00:00:00.000Z',
  provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'agent-b' },
  eventType: 'assistant.text.delta', payloadVersion: 1,
  rawPayload: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B 的本地历史' } } },
}
const page = { events: [localRow], nextAfterSequence: null }
const loadResult = {
  response: { sessionId: session.periId, configOptions: [] }, replay: [], canonicalRevision: 1,
  replayMetadata: { complete: true, truncated: false, droppedCount: 0, boundary: { kind: 'session-load-response', observedCount: 0, retainedStartOrdinal: null, retainedEndOrdinal: null } },
  replayJournalStatus: 'local-authoritative', authority: 'local-journal', journalCoverage: 'local-observed',
  collection: { complete: true, truncated: false, droppedCount: 0 }, diagnostics: [],
}
const context: SheetContext = {
  openSheet: () => null, focusSheet: () => {}, closeSheet: () => {}, activeSession: session.id,
  selectSession: () => {}, openProfileEdit: () => {}, openSessionSettings: () => {}, sidebarCollapsed: false, rightInset: 0,
  sessionSource: () => session.source, sessionBySource: () => session,
}
let registration: ReturnType<ReturnType<typeof getRendererRegistry>['registerSuite']>
let canonicalRead: () => Promise<unknown>
let remoteLoad: () => Promise<unknown>

beforeAll(async () => {
  await activateBuiltinPlugin('builtin.pylon-renderers')
  registration = getRendererRegistry().registerSuite(createPluginIdentity('test.recovery-observer', 'runtime'), {
    id: 'test.recovery-observer', label: 'Recovery observer', apiVersion: 1,
    runtime: { framework: 'solid', version: '1' }, requiredKinds: ['content.unknown'],
    compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
    factory: { async prepare() { return { mount(container, _input, host) {
      const display = () => { container.textContent = host.document.getSnapshot()?.messages.map(message => message.content).join('\n') ?? '' }
      const unsubscribe = host.document.subscribe(display)
      display()
      return { update() {}, pause() {}, resume() {}, destroy: unsubscribe, on(event, listener) { if (event === 'ready') listener({}); return () => {} } }
    } } } },
  })
})
afterAll(async () => {
  await registration.dispose()
  const active = getPluginRuntime().snapshot().active.find(item => item.pluginId === 'builtin.pylon-renderers')
  if (active) await getPluginRuntime().deactivate(active.key)
})
beforeEach(() => {
  localStorage.clear()
  resetStores()
  resetAgentProbeForTests()
  vi.clearAllMocks()
  canonicalRead = async () => page
  remoteLoad = async () => loadResult
  invoke.mockImplementation((command: string) => {
    if (command === 'evt_load_compact') return canonicalRead()
    if (command === 'evt_draft_list') return Promise.resolve([])
    if (command === 'evt_revision') return Promise.resolve(1)
    if (command === 'load_persisted_session') return remoteLoad()
    if (command === 'probe_agent_selectors') return Promise.resolve({ configOptions: [] })
    return Promise.resolve(undefined)
  })
  useIdentityStore.setState({ activeAgent: 'agent-a', sessions: [session], sessionsHydrated: true })
  useWorkspaceStore.setState({ workspaceSheets: { ...useWorkspaceStore.getState().workspaceSheets, activeSheetId: 'sheet-a' } })
  useRuntimeStore.getState().setAgentStatus('agent-a', { agent: 'agent-a', status: 'connected' })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

function focus(sheetId: string) {
  useWorkspaceStore.setState({ workspaceSheets: { ...useWorkspaceStore.getState().workspaceSheets, activeSheetId: sheetId } })
}
function connectOwner() {
  useIdentityStore.setState({ activeAgent: 'agent-b' })
  useRuntimeStore.getState().setAgentStatus('agent-b', { agent: 'agent-b', status: 'connected' })
}
function mountWorkbench() {
  return render(() => <AgentRendererSuiteWorkbench
    sheet={{ id: 'sheet-b', kind: 'agent', title: 'B', agentId: 'agent-b', createdAt: 1, lastFocusedAt: 1 }}
    ctx={context} modeId="modern-gui" defaultSuiteId="test.recovery-observer" isReplay={false}
  />)
}
function remoteCalls() { return invoke.mock.calls.filter(call => call[0] === 'load_persisted_session') }

describe('native keep-alive workbench recovery', () => {
  it('reads hidden local history, then restores only its active connected owner', async () => {
    mountWorkbench()
    expect(await screen.findByText('B 的本地历史')).toBeTruthy()
    expect(remoteCalls()).toHaveLength(0)
    expect(invoke.mock.calls.some(call => call[0] === 'probe_agent_selectors')).toBe(false)
    focus('sheet-b')
    await flushTask()
    expect(remoteCalls()).toHaveLength(0)
    useIdentityStore.setState({ activeAgent: 'agent-b' })
    await flushTask()
    expect(remoteCalls()).toHaveLength(0)
    useRuntimeStore.getState().setAgentStatus('agent-b', { agent: 'agent-b', status: 'connecting' })
    await flushTask()
    expect(remoteCalls()).toHaveLength(0)
    connectOwner()
    await waitFor(() => expect(remoteCalls()).toHaveLength(1))
    expect(remoteCalls()[0][1]).toMatchObject({ owner, periId: 'remote-b' })
    useRuntimeStore.getState().setAgentStatus('agent-a', { agent: 'agent-a', status: 'disconnected' })
    await flushTask()
    expect(remoteCalls()).toHaveLength(1)
    expect(invoke.mock.calls.some(call => call[0] === 'switch_agent' || call[0] === 'new_session')).toBe(false)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('hiding during a local read cancels ACP recovery while retaining local history', async () => {
    let finishRead!: (value: unknown) => void
    const pendingRead = new Promise(resolve => { finishRead = resolve })
    canonicalRead = () => pendingRead
    connectOwner()
    focus('sheet-b')
    mountWorkbench()
    await waitFor(() => expect(invoke.mock.calls.filter(call => call[0] === 'evt_load_compact').length).toBeGreaterThanOrEqual(2))
    focus('sheet-a')
    finishRead(page)
    expect(await screen.findByText('B 的本地历史')).toBeTruthy()
    await flushTask()
    expect(remoteCalls()).toHaveLength(0)
    expect(reportError).not.toHaveBeenCalled()
    expect(reportDiagnostic).not.toHaveBeenCalled()
  })

  it('a late remote failure after hiding neither reports nor retries the abandoned activation', async () => {
    let failLoad!: (reason: unknown) => void
    remoteLoad = () => new Promise((_resolve, reject) => { failLoad = reject })
    connectOwner()
    focus('sheet-b')
    mountWorkbench()
    await waitFor(() => expect(remoteCalls()).toHaveLength(1))
    vi.useFakeTimers()
    focus('sheet-a')
    failLoad(new Error('owner disconnected after hiding'))
    await vi.advanceTimersByTimeAsync(RECOVERY_RETRY_DELAY_MS * 2)
    expect(remoteCalls()).toHaveLength(1)
    expect(reportError).not.toHaveBeenCalled()
    expect(reportDiagnostic).not.toHaveBeenCalled()
  })
})
