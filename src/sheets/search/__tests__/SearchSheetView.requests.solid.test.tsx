// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SearchSheetView from '../SearchSheetView.solid.tsx'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import { searchAllMessages } from '../../../domains/search/searchService'

vi.mock('../../../domains/search/searchService', () => ({ searchAllMessages: vi.fn() }))
vi.mock('../../../app/runtimeError', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))
const sheet: SheetRecord = { id: 'search-race', kind: 'search', title: '搜索', createdAt: 0, lastFocusedAt: 0 }
const ctx = {} as SheetContext
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('search request ownership', () => {
  it('clearing the query invalidates the pending result and keeps the initial empty state', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof searchAllMessages>>) => void
    vi.mocked(searchAllMessages).mockReturnValue(new Promise(done => { resolve = done }))
    render(() => <SearchSheetView sheet={sheet} ctx={ctx} />)
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'hello' } })
    expect(screen.getByText('搜索中…')).toBeTruthy()
    expect(screen.queryByText('没有匹配结果')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '清除查询' }))
    resolve({ results: [{ sessionId: 'old', messageId: 'old', snippet: 'stale result' }], truncated: true })
    await Promise.resolve()
    expect(screen.queryByText('stale result')).toBeNull()
    expect(screen.queryByText(/结果过多已截断/)).toBeNull()
    expect(screen.getByText('搜索本地会话消息')).toBeTruthy()
  })

  it('a failed query has a retry that renders the new result', async () => {
    vi.mocked(searchAllMessages).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ results: [{ sessionId: 's', messageId: 'm', snippet: 'recovered' }], truncated: false })
    render(() => <SearchSheetView sheet={sheet} ctx={ctx} />)
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'hello' } })
    fireEvent.click(await screen.findByRole('button', { name: '重试搜索' }))
    await screen.findByText('recovered')
    expect(searchAllMessages).toHaveBeenCalledTimes(2)
  })
})
