// @vitest-environment jsdom
/**
 * CR-002（玉衡 finding）：Overview resumeSession 遇事务失败（如 source/periId 归属冲突）
 * 必须把 result.message 呈现到 error 槽（role=alert），而不是静默 return。
 * 修复前 RED：点击后无 alert；修复后 GREEN。
 * #515：自 OverviewSheetView.resumeError.test.tsx 迁移（断言集原样保留，渲染改走 Solid 实体）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import OverviewSheetView from '../OverviewSheetView.solid.tsx'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import { FakeInvoke } from '../../test/fakeInvoke'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { resetStores } from '../../test/resetStores.ts'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

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

// 最近会话列表挂在 IS_TAURI 守卫后；置真让 listPersistedSessions 填充恢复入口
vi.mock('../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, hasTauriRuntime: () => false }))
vi.mock('../../infrastructure/acp/sessionClient', () => ({
  createSessionClient: () => ({
    listPersistedSessions: vi.fn().mockResolvedValue([
      { id: 'p1', source: 'qq:group:1', title: '归属冲突存档', periId: 'peri-9', updatedAt: 100 },
    ]),
  }),
}))
vi.mock('../../application/transactions/resumePersistedSessionTransaction', () => ({
  resumePersistedSessionTransaction: vi.fn(() => ({
    ok: false,
    kind: 'conflict',
    message: '存档会话归属冲突：source 与 periId 指向不同会话，需显式选择',
  })),
}))

const sheet: SheetRecord = { id: 'overview', kind: 'overview', title: '概览', createdAt: 0, lastFocusedAt: 0 }

function makeCtx(): SheetContext {
  return { selectSession: vi.fn(), openSheet: vi.fn() } as unknown as SheetContext
}

afterEach(() => cleanup())

describe('CR-002 Overview 恢复会话失败呈现', () => {
  it('事务冲突 → error 槽显示 message，不导航', async () => {
    resetStores()
    useIdentityStore.setState({ agents: [{ id: 'peri', name: 'Peri', provider: 'ACP' }], activeAgent: 'peri' })
    const ctx = makeCtx()
    render(() => <OverviewSheetView sheet={sheet} ctx={ctx} />)
    const button = await screen.findByRole('button', { name: /归属冲突存档/ })
    fireEvent.click(button)
    const alert = await screen.findByRole('alert')
    // I01-W4：存档无 owner → blocked（不静默归 active Agent）；冲突需显式 owner（见事务单测）
    expect(alert.textContent).toContain('归属不明')
    expect(ctx.selectSession).not.toHaveBeenCalled()
    expect(ctx.openSheet).not.toHaveBeenCalled()
  })
})
