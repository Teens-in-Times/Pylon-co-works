// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, it, vi } from 'vitest'
import RuntimeSheetView from '../RuntimeSheetView.solid.tsx'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

const { list, subscribe, dispose } = vi.hoisted(() => ({ list: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() }))
vi.mock('../../app/appClients', () => ({ appClients: { runtime: {
  startupDiagnostics: vi.fn().mockResolvedValue({}), listRuntimeLogs: list,
  setRuntimeLogLive: vi.fn().mockResolvedValue(undefined), clearRuntimeLogs: vi.fn().mockResolvedValue(undefined),
} } }))
vi.mock('../../infrastructure/tauri/runtimeEventClient', () => ({ runtimeEventClient: { subscribe } }))
vi.mock('../../app/runtimeError', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('retries failed loads, labels filters and exposes log detail expansion', async () => {
  subscribe.mockImplementation(() => ({ dispose }))
  list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ id: 1, timestamp: 1, level: 'warn', source: 'agent', message: 'retryable failure', code: 'E_RETRY' }])
  const sheet: SheetRecord = { id: 'runtime', kind: 'runtime', title: '日志', createdAt: 0, lastFocusedAt: 0 }
  const view = render(() => <RuntimeSheetView sheet={sheet} ctx={{} as SheetContext} />)
  fireEvent.click(await screen.findByRole('button', { name: '重新读取日志' }))
  const row = await screen.findByRole('button', { name: /retryable failure/ })
  expect(row).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(row)
  expect(row).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('E_RETRY')).toBeTruthy()
  fireEvent.input(screen.getByRole('searchbox', { name: '搜索日志' }), { target: { value: 'no-match' } })
  expect(screen.getByText('没有匹配的日志')).toBeTruthy()
  view.unmount()
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(dispose).toHaveBeenCalledTimes(1)
})
