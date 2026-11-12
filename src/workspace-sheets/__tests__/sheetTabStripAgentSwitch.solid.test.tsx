// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SheetTabStrip from '../SheetTabStrip.solid.tsx'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { resetStores } from '../../test/resetStores'
import type { SheetRecord } from '../sheetTypes'

// #498：React 死桥随 #484 删除后，聚焦切换事务语义（原 sheetTabStripAgentSwitch.test.tsx）
// 由 Solid 实体承接。契约不变：非 active Agent 必须等 switch_agent 成功后才 focus；
// 失败不 focus 且保持原 active；键盘移动同契约。
// 失败/对账路径经 reportRuntimeError 走 console.error 上报——白名单登记见 vitest.setup.ts。

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

const sheets: SheetRecord[] = [
  { id: 'peri-sheet', kind: 'agent', title: 'Peri', agentId: 'peri', createdAt: 1, lastFocusedAt: 1 },
  { id: 'hermes-sheet', kind: 'agent', title: 'Hermes', agentId: 'hermes', createdAt: 2, lastFocusedAt: 2 },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderStrip(onFocus = vi.fn()) {
  const result = render(() => <SheetTabStrip latest={() => ({
    sheets,
    activeSheetId: 'peri-sheet',
    activeAgent: useIdentityStore.getState().activeAgent,
    agentStatuses: {},
    onFocus,
    onClose: vi.fn(),
    menuActions: { onTogglePin: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReopen: vi.fn() },
    canReopen: false,
  })} />)
  return { ...result, onFocus }
}

describe('Agent Sheet 聚焦切换事务（SheetTabStrip.solid）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    useIdentityStore.setState({
      agents: [
        { id: 'peri', name: 'Peri' },
        { id: 'hermes', name: 'Hermes' },
      ],
      activeAgent: 'peri',
    })
  })

  afterEach(cleanup)

  it('非 active Agent 必须等 switch 成功后才 focus', async () => {
    const pending = deferred<unknown>()
    invoke.mockReturnValueOnce(pending.promise)
    const { onFocus } = renderStrip()

    const hermesTab = screen.getByRole('tab', { name: /Hermes/ })
    fireEvent.click(hermesTab)

    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'hermes' })
    expect(onFocus).not.toHaveBeenCalled()
    expect(useIdentityStore.getState().activeAgent).toBe('peri')
    // 切换进行中：该页签 disabled + aria-busy，防止并发重复触发。
    expect(hermesTab).toBeDisabled()
    expect(hermesTab).toHaveAttribute('aria-busy', 'true')

    pending.resolve(null)

    await waitFor(() => expect(onFocus).toHaveBeenCalledWith('hermes-sheet'))
    expect(useIdentityStore.getState().activeAgent).toBe('hermes')
  })

  it('switch 失败时不 focus，且保持原 active Agent', async () => {
    invoke.mockRejectedValueOnce(new Error('Hermes 启动失败'))
    const { onFocus } = renderStrip()

    fireEvent.click(screen.getByRole('tab', { name: /Hermes/ }))

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(onFocus).not.toHaveBeenCalled()
    expect(useIdentityStore.getState().activeAgent).toBe('peri')
    // 失败后切换态复位：页签恢复可点，不永久卡在 disabled。
    await waitFor(() => expect(screen.getByRole('tab', { name: /Hermes/ })).not.toBeDisabled())
  })

  it('已连接的 active Agent Sheet 直接 focus，不重复 switch', () => {
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', status: 'connected' })
    const { onFocus } = renderStrip()

    fireEvent.click(screen.getByRole('tab', { name: /Peri/ }))

    expect(onFocus).toHaveBeenCalledWith('peri-sheet')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('选中的 Agent 没有运行时状态时，先启动再 focus', async () => {
    const pending = deferred<unknown>()
    invoke.mockImplementation(command => command === 'switch_agent' ? pending.promise : Promise.resolve({ agent: 'peri', status: 'connected' }))
    const { onFocus } = renderStrip()
    fireEvent.click(screen.getByRole('tab', { name: /Peri/ }))
    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'peri' })
    expect(onFocus).not.toHaveBeenCalled()
    pending.resolve(null)
    await waitFor(() => expect(onFocus).toHaveBeenCalledWith('peri-sheet'))
  })

  it('键盘移动到非 active Agent 同样先 switch 后 focus', async () => {
    const pending = deferred<unknown>()
    invoke.mockReturnValueOnce(pending.promise)
    const { onFocus } = renderStrip()

    fireEvent.keyDown(screen.getByRole('tab', { name: /Peri/ }), { key: 'ArrowRight' })

    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'hermes' })
    expect(onFocus).not.toHaveBeenCalled()

    pending.resolve(null)

    await waitFor(() => expect(onFocus).toHaveBeenCalledWith('hermes-sheet'))
  })
})
