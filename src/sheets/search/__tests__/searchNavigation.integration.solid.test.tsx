// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * FE-AUD-003 行为回归：跨会话搜索「定位消息」必须有消费者。
 *
 * 目标行为：点击搜索结果时，按 sessionId+messageId 保存持久导航意图
 * （sessionUiState key `pendingMessageLocation`），不依赖瞬时 CustomEvent——
 * 后者在 ChatView 跨挂载场景下必然丢失。
 *
 * #515：迁移自 searchNavigation.integration.test.tsx（React RTL → @solidjs/testing-library，
 * 实体直连 SearchSheetView.solid.tsx）。改写点登记：
 * - `render(<SearchSheetView/>)` → `render(() => <SearchSheetView/>)`；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开，solid 库不自动清理）；
 * - 断言集逐字保留（pendingMessageLocation 持久意图 + selectSession/openSheet 接线）。
 */
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

describe('FE-AUD-003 搜索定位消费者', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('点击结果创建持久定位意图（sessionUiStore 持久，不依赖瞬时 CustomEvent）', async () => {
    seedLocalSnapshot()
    await searchAndClick('定位', setupCtx())
    expect(sessionUiStore.get<{ sessionId: string; messageId: string } | undefined>('s1', 'pendingMessageLocation', undefined))
      .toEqual({ sessionId: 's1', messageId: 'm1' })
  })

  it('点击结果打开对应会话（owner-aware 接线基线绿）', async () => {
    seedLocalSnapshot()
    const ctx = setupCtx()
    await searchAndClick('定位', ctx)
    expect(ctx.selectSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('s1')
    expect(ctx.openSheet as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent', agentId: 'peri' }))
  })
})
