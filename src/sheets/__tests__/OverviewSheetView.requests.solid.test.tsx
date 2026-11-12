// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@solidjs/testing-library'
import OverviewSheetView from '../OverviewSheetView.solid.tsx'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { resetStores } from '../../test/resetStores.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import type { PersistedSessionSummary } from '../../domains/overview/persistedSessions.ts'

const mocks = vi.hoisted(() => ({ list: vi.fn(), report: vi.fn(), resolve: vi.fn() }))
vi.mock('../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, hasTauriRuntime: () => false }))
vi.mock('../../infrastructure/acp/sessionClient', () => ({ createSessionClient: () => ({ listPersistedSessions: mocks.list }) }))
vi.mock('../../app/runtimeError', async importOriginal => ({
  ...await importOriginal<typeof import('../../app/runtimeError')>(),
  reportRuntimeError: mocks.report,
  resolveRuntimeErrors: mocks.resolve,
}))

const sheet: SheetRecord = { id: 'overview', kind: 'overview', title: '概览', createdAt: 0, lastFocusedAt: 0 }
const agent = (id: string) => ({ id, name: id, provider: 'ACP' })
const archive = (id: string): PersistedSessionSummary[] => [{ id, title: id, periId: id, updatedAt: 100 }]
const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }
function pending() {
  let resolve!: (value: PersistedSessionSummary[]) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<PersistedSessionSummary[]>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const renderOverview = () => render(() => <OverviewSheetView sheet={sheet} ctx={{} as SheetContext} />)

beforeEach(() => {
  resetStores()
  mocks.list.mockReset().mockResolvedValue([])
  mocks.report.mockReset()
  mocks.resolve.mockReset()
  useIdentityStore.setState({ agents: [], activeAgent: 'peri', sessions: [] })
})
afterEach(cleanup)

describe('Overview agent-scoped recent archive loading', () => {
  it('uses the same store snapshot when catalog and active Agent arrive together', async () => {
    renderOverview()
    useIdentityStore.setState({ agents: [agent('peri'), agent('hermes')], activeAgent: 'hermes' })
    await flush()
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it('waits for an actual catalog member and loads when the active Agent becomes ready', async () => {
    mocks.list.mockResolvedValue(archive('准备后的存档'))
    renderOverview()
    await flush()
    expect(mocks.list).not.toHaveBeenCalled()
    useIdentityStore.setState({ agents: [agent('hermes')] })
    await flush()
    expect(mocks.list).not.toHaveBeenCalled()
    useIdentityStore.setState({ activeAgent: 'hermes' })
    await flush()
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: /准备后的存档/ })).toBeInTheDocument()
    expect(mocks.report).not.toHaveBeenCalled()
  })

  it('reloads on active Agent changes and ignores an earlier pending response', async () => {
    const first = pending()
    const second = pending()
    mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    useIdentityStore.setState({ agents: [agent('peri'), agent('hermes')], activeAgent: 'peri' })
    renderOverview()
    useIdentityStore.setState({ activeAgent: 'hermes' })
    await flush()
    expect(mocks.list).toHaveBeenCalledTimes(2)
    second.resolve(archive('当前Agent存档'))
    first.resolve(archive('旧Agent存档'))
    await flush()
    expect(screen.getByRole('button', { name: /当前Agent存档/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /旧Agent存档/ })).toBeNull()
    useIdentityStore.setState({ agents: [agent('peri'), { ...agent('hermes'), name: '重命名' }] })
    await flush()
    expect(mocks.list).toHaveBeenCalledTimes(2)
    useIdentityStore.setState({ activeAgent: '', agents: [] })
    await flush()
    expect(screen.queryByRole('button', { name: /当前Agent存档/ })).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('ignores a request that %s after unmount', async outcome => {
    const request = pending()
    mocks.list.mockReturnValue(request.promise)
    useIdentityStore.setState({ agents: [agent('peri')], activeAgent: 'peri' })
    const { unmount } = renderOverview()
    unmount()
    if (outcome === 'resolve') request.resolve(archive('迟到存档'))
    else request.reject(new Error('迟到错误'))
    await flush()
    expect(mocks.report).not.toHaveBeenCalled()
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it.each([
    new Error('archive unavailable'),
    { code: 'no_active_agent', message: 'no active agent configured' },
  ])('reports real failures for a ready Agent', async error => {
    mocks.list.mockRejectedValue(error)
    useIdentityStore.setState({ agents: [agent('peri')], activeAgent: 'peri' })
    renderOverview()
    await flush()
    expect(mocks.report).toHaveBeenCalledWith('读取最近会话', error, undefined, expect.objectContaining({ key: 'overview:recent-sessions' }))
  })
})
