// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * CR-002（玉衡 finding）：History openReplay 遇事务失败（如 source/periId 归属冲突）
 * 必须把 result.message 呈现到 exportError 槽（role=alert），而不是静默 return。
 * 修复前 RED：点击回放后无 alert；修复后 GREEN。
 *
 * #515：迁移自 HistorySheetView.replayError.test.tsx（原文件 import 的正是 React 薄桥
 * HistorySheetView.tsx → 改为实体直连 HistorySheetView.solid.tsx，React RTL →
 * @solidjs/testing-library）。改写点登记：
 * - `render(<HistorySheetView/>)` → `render(() => <HistorySheetView/>)`；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（role=alert 呈现「归属不明」、不 selectSession、不开 sheet）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import HistorySheetView from '../HistorySheetView.solid.tsx'
import { useIdentityStore } from '../../../domains/identity/identityStore'
beforeEach(() => useIdentityStore.setState({ activeAgent: 'peri', agents: [{ id: 'peri', name: 'Peri', available: true }] }))
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import { FakeInvoke } from '../../../test/fakeInvoke'

afterEach(cleanup)

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve {}（对齐原内联 mock `vi.fn(() => Promise.resolve({}))` 的宽松路径） */
class PermissiveFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return {}
      throw error
    })
  }
}

invokeRef.current = (cmd, args) => new PermissiveFakeInvoke().invoke(cmd, args)

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }))
vi.mock('../../../infrastructure/acp/sessionClient', () => ({
  createSessionClient: () => ({
    listPersistedSessions: vi.fn().mockResolvedValue([
      { id: 'p1', source: 'qq:group:1', title: '回放冲突存档', periId: 'peri-9', updatedAt: 100 },
    ]),
    exportSession: vi.fn(),
  }),
}))
vi.mock('../../../application/transactions/resumePersistedSessionTransaction', () => ({
  resumePersistedSessionTransaction: vi.fn(() => ({
    ok: false,
    kind: 'conflict',
    message: '存档会话归属冲突：source 与 periId 指向不同会话，需显式选择',
  })),
}))

const sheet: SheetRecord = { id: 'history', kind: 'history', title: '存档', createdAt: 0, lastFocusedAt: 0 }

function makeCtx(): SheetContext {
  return { selectSession: vi.fn(), openSheet: vi.fn() } as unknown as SheetContext
}

describe('CR-002 History 回放冲突呈现', () => {
  it('事务冲突 → exportError 槽显示 message，不进入姿态', async () => {
    const ctx = makeCtx()
    render(() => <HistorySheetView sheet={sheet} ctx={ctx} />)
    const button = await screen.findByRole('button', { name: /回放/ })
    fireEvent.click(button)
    const alert = await screen.findByRole('alert')
    // I01-W4：存档无 owner → blocked（不静默归 active Agent）
    expect(alert.textContent).toContain('归属不明')
    expect(ctx.selectSession).not.toHaveBeenCalled()
    expect(ctx.openSheet).not.toHaveBeenCalled()
  })
})
