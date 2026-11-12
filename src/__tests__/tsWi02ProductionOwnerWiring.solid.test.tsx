// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * TS-WI02：三个生产视图必须保留 transaction 传入的 agentId（渲染驱动）。
 *
 * 契约：Overview / History / Search 打开存档或会话时构造的 openOwnedSessionTransaction
 * 依赖注入中，addSession 必须把事务解析出的 owner agentId 原样透传给 identityStore——
 * 一旦丢失，store 会静默回退 activeAgent，owner 归属即被破坏（ISSUE-01）。
 *
 * 断言方式：真实渲染 + 点击触发，捕获视图在交互中实际构造的 deps，再调用其中的
 * addSession。预置 activeAgent ≠ 目标 owner，任何「丢弃 agentId」的接线变异必然红。
 *
 * #515：迁移自 tsWi02ProductionOwnerWiring.test.tsx（React RTL → @solidjs/testing-library，
 * 实体直连 OverviewSheetView/HistorySheetView/SearchSheetView 的 .solid.tsx）。
 * 改写点登记：
 * - `render(<X/>)` → `render(() => <X/>)`，import 换 .solid.tsx 实体；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - `waitFor`/`fireEvent`/`screen` 改从 @solidjs/testing-library 取（同名同语义）；
 * - vi.mock 门面（tauri/env/sessionClient/searchService/openOwnedSessionTransaction）原样保留——
 *   store 门面签名未变，solid 实体经同一模块图拿到 mock；
 * - 断言集逐字保留（capturedDeps.addSession 透传 agentId）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import OverviewSheetView from '../sheets/OverviewSheetView.solid.tsx'
import HistorySheetView from '../sheets/history/HistorySheetView.solid.tsx'
import SearchSheetView from '../sheets/search/SearchSheetView.solid.tsx'
import { useIdentityStore } from '../domains/identity/identityStore'
import { resetStores } from '../test/resetStores'
import type { OpenOwnedSessionDeps } from '../application/transactions/openOwnedSessionTransaction'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'

afterEach(cleanup)

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../test-utils/tauriCoreMock')
  return tauriCoreMock(() => Promise.resolve({}))
})
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }))
// 最近会话/存档列表挂在 IS_TAURI 守卫后；置真让 listPersistedSessions 填充入口。
// 其余导出（isBrowserMockRuntime 等）保持真实实现，identityStore 依赖它们判定 hasBackend。
vi.mock('../infrastructure/tauri/env.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../infrastructure/tauri/env.ts')>()),
  IS_TAURI: true,
  hasTauriRuntime: () => false,
}))
vi.mock('../infrastructure/acp/sessionClient', () => ({
  createSessionClient: () => ({
    listPersistedSessions: vi.fn().mockResolvedValue([
      { id: 'p1', source: 'qq:group:1', title: 'TS-WI02 存档', periId: 'peri-9', updatedAt: 100 },
    ]),
    exportSession: vi.fn(),
  }),
}))
// IS_TAURI 置真会让 searchAllMessages 走 canonical 后端搜索；本文件只关心
// 点击结果后的接线，搜索源固定为 localStorage snapshot（与 browser 模式同源）。
vi.mock('../domains/search/searchService', async importOriginal => ({
  ...(await importOriginal<typeof import('../domains/search/searchService')>()),
  searchAllMessages: (
    await importOriginal<typeof import('../domains/search/searchService')>()
  ).searchAllMessagesSnapshot,
}))

const capturedDeps: OpenOwnedSessionDeps[] = []
vi.mock('../application/transactions/openOwnedSessionTransaction', async importOriginal => {
  const actual = await importOriginal<typeof import('../application/transactions/openOwnedSessionTransaction')>()
  return {
    ...actual,
    openOwnedSessionTransaction: vi.fn((_target: unknown, deps: OpenOwnedSessionDeps) => {
      capturedDeps.push(deps)
      return Promise.resolve({ ok: true, value: 'ts-wi02' })
    }),
  }
})

const overviewSheet: SheetRecord = { id: 'overview', kind: 'overview', title: '概览', createdAt: 0, lastFocusedAt: 0 }
const historySheet: SheetRecord = { id: 'history', kind: 'history', title: '存档', createdAt: 0, lastFocusedAt: 0 }
const searchSheet: SheetRecord = { id: 'search', kind: 'search', title: '搜索', createdAt: 0, lastFocusedAt: 0 }

function makeCtx(): SheetContext {
  return { selectSession: vi.fn(), openSheet: vi.fn() } as unknown as SheetContext
}

/** 契约断言：视图注入的 addSession 必须把事务给出的 agentId 透传给 identityStore。 */
async function expectAddSessionPreservesOwner(): Promise<void> {
  await waitFor(() => expect(capturedDeps).toHaveLength(1))
  const id = capturedDeps[0].addSession('TS-WI02 会话', 'agent-owner')
  const created = useIdentityStore.getState().sessions.find(session => session.id === id)
  expect(created).toBeDefined()
  expect(created?.agentId).toBe('agent-owner')
}

describe('TS-WI02 production addSession owner wiring', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    capturedDeps.length = 0
    // 预置一个不同的 activeAgent：若接线丢弃 agentId，store 将回退到它，断言即红
    useIdentityStore.setState({ activeAgent: 'agent-active', agents: [{ id: 'agent-active', name: 'Active Agent', provider: 'ACP' }] })
  })

  it('OverviewSheetView：恢复存档入口注入的 addSession 透传 agentId', async () => {
    render(() => <OverviewSheetView sheet={overviewSheet} ctx={makeCtx()} />)
    fireEvent.click(await screen.findByRole('button', { name: /TS-WI02 存档/ }))
    await expectAddSessionPreservesOwner()
  })

  it('HistorySheetView：回放入口注入的 addSession 透传 agentId', async () => {
    render(() => <HistorySheetView sheet={historySheet} ctx={makeCtx()} />)
    fireEvent.click(await screen.findByRole('button', { name: /回放/ }))
    await expectAddSessionPreservesOwner()
  })

  it('SearchSheetView：搜索结果入口注入的 addSession 透传 agentId', async () => {
    useIdentityStore.setState({
      sessions: [{
        id: 's1', agentId: 'peri', name: '会话一', source: 'local:会话一', profileId: 'profile-a',
        createdAt: 0, lastActiveAt: 0, platform: 'local', workdir: '',
        sessionPrompt: '', skills: [], hooks: [], autoName: '',
      }],
    })
    localStorage.setItem('pylon-msgs-s1', JSON.stringify([
      { id: 'm1', content: '需要定位的消息 hello world', time: '2026-01-01' },
    ]))
    render(() => <SearchSheetView sheet={searchSheet} ctx={makeCtx()} />)
    fireEvent.input(screen.getByLabelText('跨会话搜索'), { target: { value: '定位' } })
    fireEvent.click(await screen.findByRole('button', { name: /需要定位的消息 hello world/ }))
    await expectAddSessionPreservesOwner()
  })
})
