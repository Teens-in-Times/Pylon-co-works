// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import HistorySheetView from '../HistorySheetView.solid.tsx'
import { useIdentityStore } from '../../../domains/identity/identityStore'
beforeEach(() => useIdentityStore.setState({ activeAgent: 'peri', agents: [{ id: 'peri', name: 'Peri', available: true }] }))
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

const { list } = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('../../../app/appClients', () => ({ appClients: { session: () => ({ listPersistedSessions: list }) } }))
vi.mock('../../../app/runtimeError', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('distinguishes loading, failed and empty history and offers retry', async () => {
  let reject!: (error: Error) => void
  list.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail })).mockResolvedValueOnce([])
  const sheet: SheetRecord = { id: 'history-load', kind: 'history', title: '存档', createdAt: 0, lastFocusedAt: 0 }
  render(() => <HistorySheetView sheet={sheet} ctx={{} as SheetContext} />)
  expect(screen.getByText('正在读取存档…')).toBeTruthy()
  expect(screen.queryByText('还没有存档会话')).toBeNull()
  reject(new Error('offline'))
  fireEvent.click(await screen.findByRole('button', { name: '重新加载存档' }))
  await screen.findByText('还没有存档会话')
  expect(list).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('正在读取存档…')).toBeNull()
  expect(screen.queryByRole('button', { name: '重新加载存档' })).toBeNull()
})

it('does not request an agent archive before an Agent is configured', () => {
  useIdentityStore.setState({ activeAgent: '', agents: [] })
  render(() => <HistorySheetView sheet={{ id: 'empty', kind: 'history', title: '存档', createdAt: 0, lastFocusedAt: 0 }} ctx={{} as SheetContext} />)
  expect(list).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '连接 Agent' })).toBeEnabled()
  expect(screen.queryByText('正在读取存档…')).toBeNull()
})

it('filters all archive entries before pagination and can clear the filter', async () => {
  list.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({ id: `p${index}`, title: index === 24 ? '解决布局问题' : `存档 ${index}`, updatedAt: 100 - index })))
  render(() => <HistorySheetView sheet={{ id: 'filter', kind: 'history', title: '存档', createdAt: 0, lastFocusedAt: 0 }} ctx={{} as SheetContext} />)
  await screen.findByText('存档 0')
  expect(screen.queryByText('解决布局问题')).toBeNull()
  fireEvent.input(screen.getByRole('searchbox', { name: '筛选存档' }), { target: { value: '布局' } })
  expect(screen.getByText('解决布局问题')).toBeVisible()
  expect(screen.queryByText('存档 0')).toBeNull()
  fireEvent.input(screen.getByRole('searchbox', { name: '筛选存档' }), { target: { value: '' } })
  expect(screen.getByText('存档 0')).toBeVisible()
})
