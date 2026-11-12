// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/** Search navigation persists the query consumed by the mounted conversation. */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import SearchSheetView from '../SearchSheetView.solid.tsx'
import { useIdentityStore } from '../../../domains/identity/identityStore'
import { resetStores } from '../../../test/resetStores'
import { sessionUiStore } from '../../../domains/workbench/sessionUiStore.ts'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

afterEach(cleanup)

function seedLocalSnapshot(): void {
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
}

function setupCtx(): SheetContext {
  const selectSession = vi.fn()
  const openSheet = vi.fn()
  return { selectSession, openSheet } as unknown as SheetContext
}

async function searchAndClick(query: string, ctx: SheetContext): Promise<void> {
  const sheet: SheetRecord = { id: 'search', kind: 'search', title: '搜索', createdAt: 0, lastFocusedAt: 0 }
  render(() => <SearchSheetView sheet={sheet} ctx={ctx} />)
  fireEvent.input(screen.getByLabelText('跨会话搜索'), { target: { value: query } })
  await screen.findByText(/需要定位的消息 hello world/)
  fireEvent.click(screen.getByRole('button', { name: /需要定位的消息 hello world/ }))
}

describe('搜索结果导航', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('点击结果恢复会话内搜索，而不依赖部分投影的消息 ID', async () => {
    seedLocalSnapshot()
    await searchAndClick('定位', setupCtx())
    expect(sessionUiStore.get('s1', 'search-open', false)).toBe(true)
    expect(sessionUiStore.get('s1', 'search-query', '')).toBe('定位')
    expect(sessionUiStore.get('s1', 'search-index', -1)).toBe(0)
  })

  it('点击结果打开对应会话（owner-aware 接线基线绿）', async () => {
    seedLocalSnapshot()
    const ctx = setupCtx()
    await searchAndClick('定位', ctx)
    expect(ctx.selectSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('s1')
    expect(ctx.openSheet as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent', agentId: 'peri' }))
  })
})
