// @vitest-environment jsdom
// #515：ContextPanelHost / AgentContextPanel 测试的 Solid 版（断言集与 React 版逐一对应，未缩减）。
// 改写点登记：
// - 实体直连（ContextPanelHost.solid / AgentContextPanel.solid），render 用
//   `@solidjs/testing-library`；
// - #515 岛退役：注册表贡献组件是 **Solid 组件**，宿主直连渲染——原「岛内 React 并发
//   调度」的 findBy/waitFor 保留（Solid 同步渲染下语义不变，find* 立即兑现）；
// - fireEvent 保留 RTL-react 版（纯 DOM 事件派发，对 Solid 树同样有效）；
// - 贡献桩组件改 Solid JSX（原 createElement 桩随 React 岛退役）。
import { fireEvent, screen, waitFor, within } from '@testing-library/dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import ContextPanelHost from '../ContextPanelHost.solid.tsx'
import AgentContextPanel from '../AgentContextPanel.solid.tsx'
import { getContextPanelRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes.ts'
import { createPreviewWorkbenchServices } from '../../../renderers/solid-workbench/preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { publishActiveWorkbenchHostPort } from '../../../application/agent-workbench/activeWorkbenchHostPort.ts'
import { useRightRailStore, RIGHT_RAIL_DEFAULT_WIDTH } from '../../../domains/workspace/layoutRailsStore.ts'

const registrations: AsyncDisposable[] = []

const sheet: SheetRecord = {
  id: 'test-sheet',
  kind: 'test-context-host',
  title: '测试工作区',
  createdAt: 1,
  lastFocusedAt: 1,
}

const ctx: SheetContext = {
  openSheet: vi.fn(() => null),
  focusSheet: vi.fn(),
  closeSheet: vi.fn(),
  activeSession: null,
  selectSession: vi.fn(),
  openProfileEdit: vi.fn(),
  openSessionSettings: vi.fn(),
  sidebarCollapsed: false,
  rightInset: 0,
  sessionSource: vi.fn(() => null),
  sessionBySource: vi.fn(() => undefined),
}

afterEach(async () => {
  cleanup()
  await Promise.all(registrations.splice(0).map(registration => registration.dispose()))
  useRightRailStore.getState().setWidth(RIGHT_RAIL_DEFAULT_WIDTH)
  vi.restoreAllMocks()
})

/** Solid 贡献桩（#515 岛退役：注册表组件是 Solid 组件）。 */
const panelStub = (text: string) => () => <div>{text}</div>

describe('ContextPanelHost', () => {
  it('同 ID 插件热替换后重置旧错误边界并渲染健康实现', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = getContextPanelRegistry()
    const oldIdentity = createPluginIdentity('test.context.hot', 'old')
    const nextIdentity = createPluginIdentity('test.context.hot', 'next')
    const BrokenPanel = () => { throw new Error('old broken panel') }
    const HealthyPanel = () => <div>热替换后的健康面板</div>
    registrations.push(registry.register(oldIdentity, {
      id: 'hot-panel', workspaceKind: sheet.kind, label: '热替换', order: 100,
      renderKind: 'first-party-solid', component: BrokenPanel,
    }))
    render(() => <ContextPanelHost sheet={sheet} ctx={ctx} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('此插件面板暂时不可用')

    const transaction = registry.beginShadowTransaction(nextIdentity, oldIdentity.key)
    transaction.register({
      id: 'hot-panel', workspaceKind: sheet.kind, label: '热替换', order: 100,
      renderKind: 'first-party-solid', component: HealthyPanel,
    }, { contributionId: 'hot-panel', priority: 100 })
    registrations.push(...transaction.commit())

    await screen.findByText('热替换后的健康面板')
  })

  it('把生产主题中的右栏宽度注入布局 CSS 变量', async () => {
    const registry = getContextPanelRegistry()
    const identity = createPluginIdentity('test.context.width', 'run-1')
    registrations.push(registry.register(identity, {
      id: 'width-panel', workspaceKind: sheet.kind, label: '宽度', order: 100,
      renderKind: 'first-party-solid', component: panelStub('宽度内容'),
    }))
    useRightRailStore.getState().setWidth(347)

    render(() => <ContextPanelHost sheet={sheet} ctx={ctx} />)

    expect(await screen.findByRole('complementary')).toHaveStyle({ '--right-width': '347px' })
  })

  it('agent 搜索消费当前 Suite Host Port 的 document 与会话 UI 状态', async () => {
    const services = createPreviewWorkbenchServices()
    const agentSheet = { ...sheet, kind: 'agent' }
    const agentCtx = { ...ctx, activeSession: 'preview-session' }
    const hostPort = createWorkbenchHostPort({
      ...services,
      suiteId: 'builtin.solid',
      sheetId: agentSheet.id,
      sessionOwnerKey: 'owner-preview',
      sessionId: 'preview-session',
    })
    const release = publishActiveWorkbenchHostPort(agentSheet.id, hostPort)

    render(() => <AgentContextPanel sheet={agentSheet} ctx={agentCtx} />)
    fireEvent.input(await screen.findByRole('textbox', { name: '搜索消息' }), { target: { value: '迁移结果' } })

    await waitFor(() => expect(screen.getByText('1/1')).toBeInTheDocument())
    expect(hostPort.sessionUi.get('search-query', '')).toBe('迁移结果')
    release()
    services.destroy()
  })

  it('会话 owner 切换后重新订阅 Host Port namespace，不串搜索状态', async () => {
    const services = createPreviewWorkbenchServices()
    const agentSheet = { ...sheet, kind: 'agent' }
    let binding = {
      suiteId: 'builtin.solid', sheetId: agentSheet.id,
      sessionOwnerKey: 'owner-a', sessionId: 'session-a',
    }
    const hostPort = createWorkbenchHostPort({
      ...services, ...binding, binding: () => binding,
    })
    const release = publishActiveWorkbenchHostPort(agentSheet.id, hostPort)
    // React 版的 rerender 语义改写：ctx 经信号重推（Solid 无 rerender API）。
    const [liveCtx, setLiveCtx] = createSignal<SheetContext>({ ...ctx, activeSession: 'session-a' })
    render(() => <AgentContextPanel sheet={agentSheet} ctx={liveCtx()} />)

    const searchBox = () => screen.getByRole('textbox', { name: '搜索消息' })
    await waitFor(() => expect(searchBox()).toBeInTheDocument())
    fireEvent.input(searchBox(), { target: { value: 'first query' } })
    binding = { ...binding, sessionOwnerKey: 'owner-b', sessionId: 'session-b' }
    setLiveCtx({ ...ctx, activeSession: 'session-b' })
    await waitFor(() => expect(searchBox()).toHaveValue(''))
    fireEvent.input(searchBox(), { target: { value: 'second query' } })

    binding = { ...binding, sessionOwnerKey: 'owner-a', sessionId: 'session-a' }
    setLiveCtx({ ...ctx, activeSession: 'session-a' })
    await waitFor(() => expect(searchBox()).toHaveValue('first query'))
    release()
    services.destroy()
  })

  it('按 order 渲染贡献标签并隔离单个贡献的渲染错误', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = getContextPanelRegistry()
    const identity = createPluginIdentity('test.context.host', 'run-1')
    const BrokenPanel = () => { throw new Error('broken contribution') }
    const HealthyPanel = () => <div>健康面板内容</div>

    registrations.push(registry.register(identity, {
      id: 'broken',
      workspaceKind: sheet.kind,
      label: '故障',
      order: 100,
      renderKind: 'first-party-solid',
      component: BrokenPanel,
    }))
    registrations.push(registry.register(identity, {
      id: 'healthy',
      workspaceKind: sheet.kind,
      label: '正常',
      order: 200,
      renderKind: 'first-party-solid',
      component: HealthyPanel,
    }))

    render(() => <ContextPanelHost sheet={sheet} ctx={ctx} />)

    await waitFor(() => expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['故障', '正常']))
    expect(await screen.findByRole('alert')).toHaveTextContent('此插件面板暂时不可用')
    fireEvent.click(screen.getByRole('tab', { name: '正常' }))
    await screen.findByText('健康面板内容')
  })

  it('切换器列出全部可显示面板，且跨 Sheet 种类也能切（种类只定默认）', async () => {
    const registry = getContextPanelRegistry()
    const identity = createPluginIdentity('test.context.switcher', 'run')
    registrations.push(registry.register(identity, {
      id: 'agent-only',
      workspaceKind: sheet.kind,
      label: '本 Sheet 面板',
      order: 100,
      renderKind: 'first-party-solid',
      component: panelStub('本 Sheet 面板内容'),
    }))
    registrations.push(registry.register(identity, {
      id: 'file-only',
      workspaceKind: 'file',
      label: 'File 面板',
      order: 200,
      renderKind: 'first-party-solid',
      component: panelStub('File 面板内容'),
    }))

    render(() => <ContextPanelHost sheet={sheet} ctx={ctx} />)

    // 用户实机报「侧栏内部没有切换侧栏种类的按钮」：只列可用面板时，单面板 Sheet 只剩一个
    // 撑满的标签，看起来是标题。现在两个都列、都能切——种类只决定默认选中谁。
    await waitFor(() => expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['本 Sheet 面板', 'File 面板']))
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'File 面板' }))
    await screen.findByText('File 面板内容')
    await waitFor(() => expect(screen.queryByText('本 Sheet 面板内容')).toBeNull())
    // 选择落到 store：这是「用户显式选过」的凭据（跨 Sheet 保持 / 重载后记得）。
    expect(useRightRailStore.getState().activePanelId).toBe('file-only')
    // 右栏内部的折叠钮已删除（折叠由标题栏那一个负责），头部只剩切换器。
    expect(document.querySelector('.context-panel-collapse')).toBeNull()
    expect([...document.querySelector('.context-panel-head')!.children].map(node => node.className))
      .toEqual(['context-panel-tabs'])
  })

  it('没显式选过时，默认选中与当前 Sheet 种类亲和的面板', async () => {
    const registry = getContextPanelRegistry()
    const identity = createPluginIdentity('test.context.affinity', 'run')
    registrations.push(registry.register(identity, {
      id: 'global-panel',
      label: '全局面板',
      order: 50,
      scope: 'global',
      renderKind: 'first-party-solid',
      component: panelStub('全局面板内容'),
    }))
    registrations.push(registry.register(identity, {
      id: 'affine-panel',
      workspaceKind: sheet.kind,
      label: '亲和面板',
      order: 900,
      renderKind: 'first-party-solid',
      component: panelStub('亲和面板内容'),
    }))

    render(() => <ContextPanelHost sheet={sheet} ctx={ctx} activePanelId={null} />)

    // 亲和优先于 order 更靠前的 global 面板。
    await screen.findByText('亲和面板内容')
    expect(within(document.body).queryByText('全局面板内容')).toBeNull()
  })
})
