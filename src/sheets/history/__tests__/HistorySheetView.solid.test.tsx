// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import HistorySheetView from '../HistorySheetView.solid.tsx'
import { useIdentityStore } from '../../../domains/identity/identityStore'
beforeEach(() => useIdentityStore.setState({ activeAgent: 'peri', agents: [{ id: 'peri', name: 'Peri', available: true }] }))
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

// #279 第 1 梯队：HistorySheetView Solid 实体的原生渲染路径（不经 React 桥）——
// 断言语义与 HistorySheetView.replayError.test.tsx 同源（CR-002 回放冲突呈现）。

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }))
vi.mock('../../../infrastructure/acp/sessionClient', () => ({
  createSessionClient: () => ({
    listPersistedSessions: vi.fn().mockResolvedValue([
      { id: 'p1', source: 'qq:group:1', title: '回放冲突存档', periId: 'peri-9', updatedAt: 100 },
    ]),
    exportSession: vi.fn(),
  }),
}))

const sheet: SheetRecord = { id: 'history', kind: 'history', title: '存档', createdAt: 0, lastFocusedAt: 0 }

function makeCtx(): SheetContext {
  return { selectSession: vi.fn(), openSheet: vi.fn() } as unknown as SheetContext
}

afterEach(() => cleanup())

describe('HistorySheetView.solid', () => {
  it('渲染存档骨架（标题/条目/回放导出按钮）', async () => {
    const ctx = makeCtx()
    const view = render(() => <HistorySheetView sheet={sheet} ctx={ctx} />)
    await screen.findByText(/回放冲突存档/)
    expect(screen.getByText(/存档会话（1）/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '回放' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '导出' })).toBeTruthy()
    view.unmount()
  })

  it('存档无 owner（identityStore 无 periId 行）→ 回放点击呈现错误且不导航', async () => {
    const ctx = makeCtx()
    const view = render(() => <HistorySheetView sheet={sheet} ctx={ctx} />)
    const button = await screen.findByRole('button', { name: /回放/ })
    fireEvent.click(button)
    await vi.waitFor(() => {
      // 实际路径：openOwnedSessionTransaction 归属不明 → exportError 槽呈现 + 「打开 Agent 设置」入口
      expect(screen.getByRole('alert').textContent).toContain('归属不明')
    })
    expect(ctx.selectSession).not.toHaveBeenCalled()
    expect(ctx.openSheet).not.toHaveBeenCalled()
    view.unmount()
  })
})
