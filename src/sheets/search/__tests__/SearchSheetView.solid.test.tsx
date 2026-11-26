// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import SearchSheetView from '../SearchSheetView.solid.tsx'
import { useIdentityStore } from '../../../domains/identity/identityStore'
import { resetStores } from '../../../test/resetStores'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

// #279 第 1 梯队：SearchSheetView Solid 实体的原生渲染路径（不经 React 桥）——
// 断言语义与 searchNavigation.integration.test.tsx 同源（持久定位意图 + owner-aware 打开）。

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

const sheet: SheetRecord = { id: 'search', kind: 'search', title: '搜索', createdAt: 0, lastFocusedAt: 0 }

afterEach(() => cleanup())

describe('SearchSheetView.solid', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('渲染骨架与空态，输入关键词出结果', async () => {
    seedLocalSnapshot()
    const ctx = setupCtx()
    const view = render(() => <SearchSheetView sheet={sheet} ctx={ctx} />)
    expect(screen.getByText('跨会话搜索')).toBeTruthy()
    expect(screen.getByText('搜索本地会话消息')).toBeTruthy()
    fireEvent.input(screen.getByLabelText('跨会话搜索'), { target: { value: '定位' } })
    const hit = await screen.findByRole('button', { name: /会话一.*hello world/ })
    expect(hit).toHaveTextContent('需要定位的消息 hello world')
    expect(hit.querySelector('mark')).toHaveTextContent('定位')
    expect(screen.queryByText('搜索本地会话消息')).toBeNull()
    view.unmount()
  })

  it('长消息中的命中片段可见，已移除的会话保留片段并停用导航', async () => {
    seedLocalSnapshot()
    localStorage.setItem('pylon-msgs-s1', JSON.stringify([
      { id: 'm1', content: '前文'.repeat(100) + '需要定位的消息 hello world' },
    ]))
    const ctx = setupCtx()
    const view = render(() => <SearchSheetView sheet={sheet} ctx={ctx} />)
    fireEvent.input(screen.getByLabelText('跨会话搜索'), { target: { value: '定位' } })
    const hit = await screen.findByRole('button', { name: /会话一.*hello world/ })
    expect(hit.querySelector('mark')).toHaveTextContent('定位')
    expect(hit).toBeEnabled()
    useIdentityStore.setState({ sessions: [] })
    expect(await screen.findByRole('button', { name: /会话不可用.*hello world/ })).toBeDisabled()
    view.unmount()
  })
})
