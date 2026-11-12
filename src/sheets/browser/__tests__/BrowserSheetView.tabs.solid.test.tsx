// @vitest-environment jsdom
/**
 * Browser 内部多标签。
 * #515：自 React 测试逐用例移植为 Solid 实体原生测试（断言集不缩减）。
 */
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import BrowserSheetView from '../BrowserSheetView.solid'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore.ts'
import { useIdentityStore } from '../../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { browserEventFeed } from '../../../infrastructure/tauri/browserEventFeed.ts'

vi.mock('../../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, hasTauriRuntime: () => true, isBrowserMockRuntime: () => true }))

const { invokeRef, reportError } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
  reportError: vi.fn(),
}))
vi.mock('../../../app/runtimeError', async original => ({ ...await original<Record<string, unknown>>(), reportRuntimeError: reportError }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

const sheet: SheetRecord = { id: 'browser-tabs', kind: 'browser', title: 'Browser', createdAt: 0, lastFocusedAt: 0 }
const ctx: SheetContext = {
  openSheet: vi.fn(), focusSheet: vi.fn(), closeSheet: vi.fn(), activeSession: null,
  selectSession: vi.fn(), openProfileEdit: vi.fn(), openSessionSettings: vi.fn(),
  sidebarCollapsed: false, rightInset: 0,
  sessionSource: () => null, sessionBySource: () => undefined,
}

const firstTab = { id: 1, url: 'https://example.com', title: 'Example Domain' }
const secondTab = { id: 2, url: 'https://www.iana.org/help/example-domains', title: 'IANA Help' }
type TestBrowserTab = { id: number; url: string; title: string | null }
const snapshot = (activeTabId: number | null, tabs: TestBrowserTab[] = [firstTab, secondTab]) => {
  const active = tabs.find(tab => tab.id === activeTabId)
  return {
    instanceId: active?.id ?? 0,
    phase: active ? 'ready' : 'idle',
    url: active?.url ?? null,
    title: active?.title ?? null,
    error: null,
    zoomPercent: 90,
    activeTabId,
    tabs,
  }
}

let serverTabs: TestBrowserTab[] = [firstTab, secondTab]
let serverActiveTabId: number | null = 1
let fakeInvoke: FakeInvoke

function seedReturnSession(agentId: string): string {
  const id = `${agentId}-return-session`
  useIdentityStore.setState({ sessions: [{
    id, agentId, source: `local:${id}`, profileId: 'default', name: '发起会话',
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
  }] })
  return id
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Browser 内部多标签', () => {
  it('keeps event consumers stable while the Sheet enters and leaves the active workspace', async () => {
    const subscribe = vi.spyOn(browserEventFeed, 'subscribe')
    const [active, setActive] = createSignal(true)
    render(() => <BrowserSheetView sheet={sheet} ctx={{ ...ctx, isActive: active() }} />)
    await screen.findByRole('tab', { name: /Example Domain/ })
    expect(subscribe).toHaveBeenCalledTimes(2)
    setActive(false)
    setActive(true)
    await waitFor(() => expect(screen.getByRole('tab', { name: /Example Domain/ })).toBeInTheDocument())
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  beforeEach(() => {
    resetStores()
    reportError.mockClear()
    serverTabs = [firstTab, secondTab]
    serverActiveTabId = 1
    fakeInvoke = new FakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    fakeInvoke.registerMany({
      browser_status: () => Promise.resolve(snapshot(serverActiveTabId, serverTabs)),
      browser_select_tab: args => {
        serverActiveTabId = (args as { tabId?: number }).tabId ?? serverActiveTabId
        return Promise.resolve(snapshot(serverActiveTabId, serverTabs))
      },
      browser_close_tab: args => {
        serverTabs = serverTabs.filter(tab => tab.id !== (args as { tabId?: number }).tabId)
        if (serverActiveTabId === (args as { tabId?: number }).tabId) serverActiveTabId = serverTabs.at(-1)?.id ?? null
        return Promise.resolve(snapshot(serverActiveTabId, serverTabs))
      },
      browser_new_tab: () => {
        serverTabs = [...serverTabs, { id: 3, url: 'about:blank', title: null }]
        serverActiveTabId = 3
        return Promise.resolve(snapshot(serverActiveTabId, serverTabs))
      },
      browser_set_bounds: () => Promise.resolve({}),
      browser_close: () => Promise.resolve({}),
    })
  })

  it('从聊天资源打开后可返回发起对话，来源关闭后不保留无效入口', async () => {
    const chatSheet: SheetRecord = { id: 'chat-origin', kind: 'agent', title: '当前任务', createdAt: 0, lastFocusedAt: 0 }
    const original = useWorkspaceStore.getState().workspaceSheets
    useWorkspaceStore.setState({ workspaceSheets: { ...original, sheets: [chatSheet, sheet] } })
    const focusSheet = vi.fn()
    try {
      render(() => <BrowserSheetView sheet={{ ...sheet, metadata: { resourceReturnSheetId: chatSheet.id, resourceReturnTitle: chatSheet.title } }} ctx={{ ...ctx, focusSheet }} />)
      fireEvent.click(screen.getByRole('button', { name: '返回对话：当前任务' }))
      expect(focusSheet).toHaveBeenCalledWith(chatSheet.id)
      useWorkspaceStore.setState({ workspaceSheets: { ...original, sheets: [sheet] } })
      expect(screen.queryByRole('button', { name: /返回对话/ })).not.toBeInTheDocument()
    } finally { useWorkspaceStore.setState({ workspaceSheets: original }) }
  })

  it('returns to the original session only after its different Agent runtime has activated', async () => {
    useIdentityStore.setState({ agents: [{ id: 'peri', name: '一号' }, { id: 'hermes', name: '二号' }], activeAgent: 'peri' })
    const sessionId = seedReturnSession('hermes')
    const chatSheet: SheetRecord = { id: 'chat-owner', kind: 'agent', agentId: 'hermes', title: '二号', createdAt: 0, lastFocusedAt: 0 }
    useWorkspaceStore.setState({ workspaceSheets: { ...useWorkspaceStore.getState().workspaceSheets, sheets: [chatSheet, sheet], activeSheetId: sheet.id } })
    let completeSwitch!: () => void
    fakeInvoke.register('switch_agent', () => new Promise<void>(resolve => { completeSwitch = resolve }))
    fakeInvoke.register('agent_status', () => ({ agent: 'hermes', agentId: 'hermes', status: 'connected' }))
    const focusSheet = vi.fn()
    const selectSession = vi.fn()
    render(() => <BrowserSheetView sheet={{ ...sheet, metadata: { resourceReturnSheetId: chatSheet.id, resourceReturnSessionId: sessionId } }} ctx={{ ...ctx, focusSheet, selectSession }} />)

    fireEvent.click(screen.getByRole('button', { name: '返回对话：二号' }))
    expect(fakeInvoke.calls).toContainEqual({ cmd: 'switch_agent', args: { name: 'hermes' } })
    expect(focusSheet).not.toHaveBeenCalled()
    expect(selectSession).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '返回对话：二号' })).toBeDisabled()
    await waitFor(() => expect(completeSwitch).toBeTypeOf('function'))
    completeSwitch()
    await waitFor(() => expect(focusSheet).toHaveBeenCalledWith(chatSheet.id))
    expect(selectSession).toHaveBeenCalledWith(sessionId)
    expect(useIdentityStore.getState().activeAgent).toBe('hermes')
    expect(useRuntimeStore.getState().agentStatuses.hermes.status).toBe('connected')
    expect(selectSession.mock.invocationCallOrder[0]).toBeLessThan(focusSheet.mock.invocationCallOrder[0])
  })

  it('keeps Browser and its selection when owner activation fails', async () => {
    const sessionId = seedReturnSession('hermes')
    const chatSheet: SheetRecord = { id: 'chat-owner', kind: 'agent', agentId: 'hermes', title: '二号', createdAt: 0, lastFocusedAt: 0 }
    useWorkspaceStore.setState({ workspaceSheets: { ...useWorkspaceStore.getState().workspaceSheets, sheets: [chatSheet, sheet], activeSheetId: sheet.id } })
    fakeInvoke.register('switch_agent', () => Promise.reject(new Error('Agent unavailable')))
    const focusSheet = vi.fn()
    const selectSession = vi.fn()
    render(() => <BrowserSheetView sheet={{ ...sheet, metadata: { resourceReturnSheetId: chatSheet.id, resourceReturnSessionId: sessionId } }} ctx={{ ...ctx, focusSheet, selectSession }} />)

    fireEvent.click(screen.getByRole('button', { name: '返回对话：二号' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent 尚未就绪')
    expect(focusSheet).not.toHaveBeenCalled()
    expect(selectSession).not.toHaveBeenCalled()
    expect(useIdentityStore.getState().activeAgent).toBe('peri')
    expect(useRuntimeStore.getState().agentStatuses.hermes).toBeUndefined()
    expect(reportError).toHaveBeenCalledWith('切换 Agent', expect.any(Error), 'hermes', expect.any(Object))
  })

  it('在 Browser 视图内切换、新建和关闭标签；关闭最后标签回空态', async () => {
    const [ctxSignal] = createSignal<SheetContext>(ctx)
    render(() => <BrowserSheetView sheet={sheet} ctx={ctxSignal()} />)

    expect(await screen.findByRole('tab', { name: 'Example Domain' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'IANA Help' }))
    await waitFor(() => {
      expect(fakeInvoke.calls).toContainEqual({ cmd: 'browser_select_tab', args: { tabId: 2 } })
      expect(screen.getByRole('textbox', { name: '网址' })).toHaveValue(secondTab.url)
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭 IANA Help' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'IANA Help' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '新建浏览器标签' }))
    await waitFor(() => {
      expect(fakeInvoke.calls).toContainEqual({ cmd: 'browser_new_tab', args: {} })
      expect(screen.getByRole('tab', { name: '新标签' })).toHaveAttribute('aria-selected', 'true')
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭 新标签' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Example Domain' })).toHaveAttribute('aria-selected', 'true'))
    fireEvent.click(screen.getByRole('button', { name: '关闭 Example Domain' }))
    await waitFor(() => {
      expect(screen.queryByRole('tablist', { name: '浏览器标签' })).toBeNull()
      expect(screen.getByRole('button', { name: '新建标签' })).toBeTruthy()
    })
  })
})
