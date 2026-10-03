import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import type { Session } from '../../../domains/identity/identityStore.ts'
import { createAgentWorkbenchSession } from '../../../application/agent-workbench/agentWorkbenchSessionCreation.ts'
import { AgentWorkbenchLifecycle } from '../../../application/agent-workbench/agentWorkbenchLifecycle.ts'
import { createCliSessionControlPort } from '../../../cli/pylonCliDomainPorts.ts'

const mocks = vi.hoisted(() => ({
  identity: vi.fn(), runtime: vi.fn(), preflight: vi.fn(),
  hook: vi.fn(), boundary: vi.fn(), apply: vi.fn(), report: vi.fn(),
}))

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve undefined（对齐 mockReset 后 vi.fn 的默认行为） */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}
vi.mock('../../../domains/identity/identityStore.ts', () => ({ useIdentityStore: { getState: mocks.identity } }))
vi.mock('../../../domains/runtime/runtimeStore.ts', () => ({ useRuntimeStore: { getState: mocks.runtime } }))
vi.mock('../../../domains/workspace/workspaceEntityStore.ts', () => ({ useWorkspaceEntityStore: { getState: () => ({ workspaces: [] }) } }))
vi.mock('../../../plugins/core/sessionCreation/sessionPreflight.ts', () => ({ runSessionPreflight: mocks.preflight }))
vi.mock('../../../plugin-runtime/runtimeServices.ts', () => ({ getHookRuntime: () => ({ invoke: mocks.hook }) }))
vi.mock('../../../application/transactions/sessionHookTransactions.ts', () => ({ runSessionBoundaryHook: mocks.boundary }))
vi.mock('../../../domains/session/sessionStateSync.ts', () => ({ applySessionStateResponse: mocks.apply }))
vi.mock('../../../app/runtimeError.ts', () => ({ reportRuntimeError: mocks.report, resolveRuntimeErrors: vi.fn() }))
vi.mock('../../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, isBrowserMockRuntime: () => false }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const session: Session = {
  id: 'local-id', agentId: 'owner', profileId: 'profile', source: 'local:source',
  name: 'title', createdAt: 1, lastActiveAt: 1, platform: 'local',
  workdir: '/workspace', workspaceId: 'workspace', sessionPrompt: '', skills: [], hooks: [], autoName: '',
}
const profile = { id: 'profile', name: 'profile', persona: 'persona', model: 'model' }
const identity = {
  sessions: [session], profiles: [profile], activeAgent: 'unrelated-agent',
  addSession: vi.fn(() => session.id), setSessionPeriId: vi.fn(), removeSession: vi.fn(),
}
const runtime = { agentStatuses: { owner: { generation: 7 } }, setBindingGeneration: vi.fn() }
const paths = ['workbench', 'cli', 'recovery'] as const
type Path = typeof paths[number]
function create(path: Path, signal = new AbortController().signal, isCurrent = () => true) {
  if (path === 'workbench') return createAgentWorkbenchSession(undefined, { agentId: session.agentId })
  if (path === 'cli') return createCliSessionControlPort().create({ agentId: session.agentId }, { signal })
  return new AgentWorkbenchLifecycle().activate(session, { isCurrent })
}

let fakeInvoke: TolerantFakeInvoke

beforeEach(() => {
  vi.clearAllMocks()
  fakeInvoke = new TolerantFakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  identity.profiles = [profile]
  mocks.identity.mockReturnValue(identity)
  mocks.runtime.mockReturnValue(runtime)
  mocks.hook.mockImplementation(async (_phase, event) => ({ action: 'continue', event }))
  mocks.preflight.mockResolvedValue({ mcpServers: [{ name: 'mcp' }] })
  fakeInvoke.register('new_session', () => ({ sessionId: 'remote', configOptions: [] }))
})

describe.each(paths)('%s session creation contract', path => {
  it('waits for preflight, uses the session owner, then commits the remote binding', async () => {
    const gate = deferred<{ mcpServers: unknown[] }>()
    mocks.preflight.mockReturnValue(gate.promise)
    const pending = create(path)
    await vi.waitFor(() => expect(mocks.preflight).toHaveBeenCalledTimes(1))
    expect(fakeInvoke.calls).toHaveLength(0)
    expect(identity.setSessionPeriId).not.toHaveBeenCalled()
    gate.resolve({ mcpServers: [{ name: 'mcp' }] })
    await pending
    expect(fakeInvoke.calls).toHaveLength(1)
    expect(fakeInvoke.calls[0]).toEqual({
      cmd: 'new_session',
      args: {
        agentId: 'owner', profileId: 'profile', source: 'local:source',
        cwd: '/workspace', workspaceId: 'workspace', persona: 'persona', model: 'model',
        mcpServers: [{ name: 'mcp' }],
      },
    })
    expect(identity.setSessionPeriId).toHaveBeenCalledExactlyOnceWith('local-id', 'remote')
    if (path !== 'cli') expect(runtime.setBindingGeneration).toHaveBeenCalledWith({ agentId: 'owner', source: 'local:source' }, 7)
    else expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('preserves profile snapshot timing across asynchronous preflight', async () => {
    mocks.preflight.mockImplementation(async () => {
      identity.profiles = [{ ...profile, persona: 'changed-persona', model: 'changed-model' }]
      return { mcpServers: [] }
    })
    await create(path)
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'new_session',
      args: expect.objectContaining({
        persona: 'persona', model: path === 'recovery' ? 'changed-model' : 'model',
      }),
    })
    expect(fakeInvoke.calls[0]!.args).not.toHaveProperty('mcpServers')
  })

  it.each(['preflight', 'remote'] as const)('%s failure preserves the entry-specific rollback policy', async stage => {
    const error = new Error(`${stage} failed`)
    if (stage === 'preflight') mocks.preflight.mockRejectedValue(error)
    else fakeInvoke.register('new_session', () => { throw error })
    const pending = create(path)
    if (path === 'recovery') {
      await pending
      expect(mocks.report).toHaveBeenCalledWith('创建会话', error, 'owner', expect.any(Object))
      expect(identity.removeSession).not.toHaveBeenCalled()
    } else {
      await expect(pending).rejects.toBe(error)
      expect(identity.removeSession).toHaveBeenCalledExactlyOnceWith('local-id')
    }
    expect(identity.setSessionPeriId).not.toHaveBeenCalled()
    if (stage === 'preflight') expect(fakeInvoke.calls).toHaveLength(0)
  })
})

it('workbench preserves explicit model/reasoning/mode and projection-before-binding order', async () => {
  const project = vi.fn()
  await createAgentWorkbenchSession({ model: 'selected', reasoningLevel: 'high', mode: 'plan' }, {
    agentId: 'owner', applySessionResponse: project,
  })
  expect(fakeInvoke.calls).toContainEqual({
    cmd: 'new_session',
    args: expect.objectContaining({ model: 'selected', reasoningLevel: 'high', mode: 'plan' }),
  })
  expect(project).toHaveBeenCalledWith('local-id', expect.objectContaining({ sessionId: 'remote' }))
  expect(project.mock.invocationCallOrder[0]).toBeLessThan(runtime.setBindingGeneration.mock.invocationCallOrder[0])
})

it('CLI cancellation after a remote response rolls back without committing it', async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled')
  fakeInvoke.register('new_session', () => { controller.abort(reason); return 'remote-string' })
  await expect(create('cli', controller.signal)).rejects.toBe(reason)
  expect(mocks.preflight).toHaveBeenCalledWith(session, controller.signal)
  expect(identity.removeSession).toHaveBeenCalledWith('local-id')
  expect(identity.setSessionPeriId).not.toHaveBeenCalled()
  expect(mocks.boundary).not.toHaveBeenCalled()
})

it('recovery ignores a late response after the visible session changes', async () => {
  let current = true
  fakeInvoke.register('new_session', () => { current = false; return { sessionId: 'late' } })
  await create('recovery', undefined, () => current)
  expect(identity.setSessionPeriId).not.toHaveBeenCalled()
  expect(mocks.apply).not.toHaveBeenCalled()
  expect(runtime.setBindingGeneration).not.toHaveBeenCalled()
})
