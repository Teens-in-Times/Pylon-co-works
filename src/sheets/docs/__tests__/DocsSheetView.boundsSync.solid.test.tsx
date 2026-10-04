// @vitest-environment jsdom
/**
 * #371 Docs Sheet 原生 WebView 同步契约：
 * 1. 折叠状态（ctx.sidebarCollapsed）变化必须即时重同步 WebView bounds（与 Browser
 *    Sheet 的 I09-A-FE-02 同一约束）；
 * 2. 可见性随 ctx.isActive 与模态覆盖层切换（原生子 WebView 不受 display:none 影响）：
 *    覆盖层打开 → setVisible(false)，关闭 → true；非活动不自动 start。
 *
 * #515：自 React 测试逐用例移植为 Solid 实体原生测试（断言集不缩减）。改写点：
 * - React `rerender` → ctx 信号翻转（Solid 无 rerender，等价的 props 推入路径）；
 * - 覆盖层 store 写入外的 React `act` 包裹移除（Solid 侧无需 act，信号同步通知）。
 */
import { createSignal } from 'solid-js'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import DocsSheetView from '../DocsSheetView.solid'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { useModalOverlayStore } from '../../../app/modalOverlayStore'

vi.mock('../../../infrastructure/tauri/env.ts', () => ({
  IS_TAURI: true,
  hasTauriRuntime: () => true,
}))

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

const sheet: SheetRecord = { id: 'docs-1', kind: 'docs', title: '文档', createdAt: 0, lastFocusedAt: 0 }
const baseCtx: SheetContext = {
  openSheet: vi.fn(), focusSheet: vi.fn(), closeSheet: vi.fn(), activeSession: null,
  selectSession: vi.fn(), openProfileEdit: vi.fn(), openSessionSettings: vi.fn(),
  sidebarCollapsed: false, rightInset: 0, isActive: true,
  sessionSource: () => null, sessionBySource: () => undefined,
}

function readySnapshot(): unknown {
  return { phase: 'ready', error: null, visible: true }
}

afterEach(() => cleanup())

describe('#371 Docs Sheet WebView 同步（bounds / visible）', () => {
  let fakeInvoke: FakeInvoke

  beforeEach(() => {
    fakeInvoke = new FakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    fakeInvoke.registerMany({
      docs_sheet_status: () => Promise.resolve({ phase: 'idle', error: null, visible: true }),
      docs_sheet_start: () => Promise.resolve(readySnapshot()),
      docs_sheet_set_bounds: () => Promise.resolve({}),
      docs_sheet_set_visible: () => Promise.resolve(readySnapshot()),
      docs_sheet_close: () => Promise.resolve({ phase: 'idle', error: null, visible: true }),
    })
    useModalOverlayStore.setState({ openKeys: new Set<string>() })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
  })

  function callsOf(cmd: string) {
    return fakeInvoke.calls.filter(call => call.cmd === cmd)
  }

  it('活动态自动 start；折叠切换重同步 bounds（次数递增）', async () => {
    const [ctx, setCtx] = createSignal<SheetContext>(baseCtx)
    render(() => <DocsSheetView sheet={sheet} ctx={ctx()} />)
    await waitFor(() => expect(callsOf('docs_sheet_start').length).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(callsOf('docs_sheet_set_bounds').length).toBeGreaterThanOrEqual(1))
    const expanded = callsOf('docs_sheet_set_bounds').length

    setCtx({ ...baseCtx, sidebarCollapsed: true })
    await waitFor(() => expect(callsOf('docs_sheet_set_bounds').length).toBeGreaterThan(expanded))
    const collapsed = callsOf('docs_sheet_set_bounds').length

    setCtx({ ...baseCtx, sidebarCollapsed: false })
    await waitFor(() => expect(callsOf('docs_sheet_set_bounds').length).toBeGreaterThan(collapsed))
  })

  it('非活动不自动 start；转活动后 start 并同步可见性', async () => {
    const [ctx, setCtx] = createSignal<SheetContext>({ ...baseCtx, isActive: false })
    render(() => <DocsSheetView sheet={sheet} ctx={ctx()} />)
    // 非活动：不自动 start（文档壳无 status 探测，后端 start 幂等去重）。
    // fake timers 推进 50ms（到期定时器与微任务链全部跑完）再做负断言——
    // 组件本体不用定时器，任何错误触发的 start 都走 invoke 异步链，逃不过这个窗口。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await vi.advanceTimersByTimeAsync(50)
    } finally {
      vi.useRealTimers()
    }
    expect(callsOf('docs_sheet_start').length).toBe(0)

    setCtx({ ...baseCtx, isActive: true })
    await waitFor(() => expect(callsOf('docs_sheet_start').length).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(callsOf('docs_sheet_set_visible').length).toBeGreaterThanOrEqual(1))
    expect(callsOf('docs_sheet_set_visible').at(-1)!.args).toMatchObject({ visible: true })
  })

  it('覆盖层打开 → setVisible(false)；关闭 → setVisible(true)', async () => {
    const [ctx] = createSignal<SheetContext>(baseCtx)
    render(() => <DocsSheetView sheet={sheet} ctx={ctx()} />)
    await waitFor(() => expect(callsOf('docs_sheet_set_visible').length).toBeGreaterThanOrEqual(1))
    expect(callsOf('docs_sheet_set_visible').at(-1)!.args).toMatchObject({ visible: true })

    useModalOverlayStore.getState().setOverlayOpen('sheet-launcher', true)
    await waitFor(() => expect(callsOf('docs_sheet_set_visible').at(-1)!.args).toMatchObject({ visible: false }))

    useModalOverlayStore.getState().setOverlayOpen('sheet-launcher', false)
    await waitFor(() => expect(callsOf('docs_sheet_set_visible').at(-1)!.args).toMatchObject({ visible: true }))
  })
})
