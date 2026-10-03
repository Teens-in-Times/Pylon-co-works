// @vitest-environment jsdom
// #515：迁移自 Sidebar.agentSessions.test.tsx（React RTL → Solid 实体直连）。改写点登记：
// ① SessionsPanel/挂载改 Solid 实体直连，rerender（RTL 无）改信号驱动 props 重渲；
// ② 贡献 props 接线改测共享工厂 createAgentSidebarSharedProps（#515 时曾内联进
//    Sidebar.solid，#520 S4-P1-4 恢复共享工厂并迁至 sidebar/useSidebarContributionProps.ts
//    ——Sidebar 与 AgentSheetPageHost 同源消费）。断言集与 DOM 契约不缩减。
import { fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { describe, expect, it, vi } from 'vitest'
import SessionsPanel from '../sidebar/SessionsPanel.solid.tsx'
import { createAgentSidebarSharedProps } from '../sidebar/useSidebarContributionProps.ts'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'

// 下沉自 scripts/test-agent-sidebar.mts（P91 A2）：面板运行点读 liveGeneratingSources、
// 会话交互保留（showPet toggle 测试已随 #483 宠物链删除退役）。

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: 's1',
    agentId: 'peri',
    name: '会话一',
    source: 'src-1',
    profileId: 'default',
    createdAt: 1,
    lastActiveAt: 1,
    platform: 'pylon',
    workdir: 'G:/Pylon',
    sessionPrompt: '',
    skills: [],
    hooks: [],
    autoName: '',
    ...overrides,
  }
}

function panelProps(overrides: Partial<AgentSidebarContributionProps> = {}): AgentSidebarContributionProps {
  return {
    activeAgentId: 'peri',
    activeSessionId: null,
    sessions: [session()],
    workspaces: [],
    liveGeneratingSources: [],
    presentation: 'block' as const,
    collapsed: false,
    registerBlockActionHandler: vi.fn(),
    onBlockAction: vi.fn(),
    onSelectSession: vi.fn(),
    onDeleteSession: vi.fn(async () => {}),
    onOpenSessionSettings: vi.fn(),
    onRenameSession: vi.fn(),
    onCreateLooseSession: vi.fn(),
    onCreateWorkspace: vi.fn(async () => {}),
    onCreateWorkspaceSession: vi.fn(),
    ...overrides,
  }
}

/** RTL rerender 的 Solid 等价：props 信号驱动重渲（JSX spread 按信号追踪）。 */
function PanelHarness(props: { get: () => AgentSidebarContributionProps }) {
  return <SessionsPanel {...props.get()} />
}

describe('会话面板运行点（data-running 按 liveGeneratingSources）', () => {
  it('无 cwd 会话：source 在 live 列表 → 运行点亮；不在 → 无 data-running', () => {
    const [panel, setPanel] = createSignal(panelProps({ liveGeneratingSources: ['src-1'] }))
    render(() => <PanelHarness get={panel} />)
    expect(document.querySelector('.session-dot')!.getAttribute('data-running')).toBe('true')

    setPanel(panelProps({ liveGeneratingSources: [] }))
    expect(document.querySelector('.session-dot')!.hasAttribute('data-running')).toBe(false)
  })

  it('工作区会话：同样的运行点语义', () => {
    const workspace = {
      id: 'workspace-1',
      agentId: 'peri',
      name: 'Pylon',
      rootPath: 'G:/Project/Pylon',
      createdAt: 1,
      lastActiveAt: 1,
      skills: [],
      mcpServerIds: [],
      hookPluginIds: [],
    }
    const bound = session({ workspaceId: 'workspace-1' })
    const [panel, setPanel] = createSignal(panelProps({ workspaces: [workspace], sessions: [bound], liveGeneratingSources: ['src-1'] }))
    render(() => <PanelHarness get={panel} />)
    expect(document.querySelector('.session-dot')!.getAttribute('data-running')).toBe('true')

    setPanel(panelProps({ workspaces: [workspace], sessions: [bound], liveGeneratingSources: ['other'] }))
    expect(document.querySelector('.session-dot')!.hasAttribute('data-running')).toBe(false)
  })
})

describe('会话交互保留', () => {
  it('设置回调携带会话 id；删除按钮已从行上撤出（收进设置）', () => {
    const onOpenSessionSettings = vi.fn()
    render(() => <SessionsPanel {...panelProps({ onOpenSessionSettings })} />)

    fireEvent.click(screen.getByRole('button', { name: '会话一 会话设置' }))
    expect(onOpenSessionSettings).toHaveBeenCalledWith('s1')
    expect(screen.queryByRole('button', { name: '删除 会话一' })).toBeNull()
  })

  it('置顶的会话排在所属工作区最前（即使它更久没活跃）', () => {
    // 排序在 props 接线处（置顶优先 → 最近活跃），因此直接对那只接线函数下断言：
    // 走 Sidebar 反而要先把会话模块注册进插件注册表，测到的是别的东西。
    const workspace = { id: 'w1', agentId: 'peri', name: 'Pylon', rootPath: 'G:/Pylon', createdAt: 1, lastActiveAt: 1, skills: [], mcpServerIds: [], hookPluginIds: [] }
    useIdentityStore.setState({
      activeAgent: 'peri',
      activeProfileId: 'default',
      profiles: [{ id: 'default', name: 'Default', persona: '', model: '' }],
      sessions: [
        { ...session({ id: 's-new', name: '最近活跃', workspaceId: 'w1' }), lastActiveAt: 900 },
        { ...session({ id: 's-pin', name: '置顶的', workspaceId: 'w1', pinned: true }), lastActiveAt: 100 },
      ] as never,
    })
    useWorkspaceEntityStore.setState({ workspaces: [workspace] as never })
    const ctx = {
      openSheet: () => null,
      focusSheet: () => {},
      closeSheet: () => {},
      activeSession: null,
      selectSession: () => {},
      openProfileEdit: () => {},
      openSessionSettings: () => {},
      sidebarCollapsed: false,
      rightInset: 0,
      sessionSource: () => null,
      sessionBySource: () => undefined,
    }
    const Probe = () => {
      const props = createAgentSidebarSharedProps(ctx as never)
      return <div data-testid="order">{props().sessions.map(item => item.name).join(',')}</div>
    }
    render(() => <Probe />)
    expect(screen.getByTestId('order').textContent).toBe('置顶的,最近活跃')
  })

  it('双击进入重命名，Enter 提交回调', () => {
    const onRenameSession = vi.fn()
    render(() => <SessionsPanel {...panelProps({ onRenameSession })} />)
    fireEvent.doubleClick(screen.getByText('会话一'))
    const input = screen.getByDisplayValue('会话一') as HTMLInputElement
    // #515：SessionsPanel 实体已 Solid 化，受控 input 走 onInput——fireEvent.change 的
    // change 事件触不到，改派 input 事件。
    fireEvent.input(input, { target: { value: '新名字' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRenameSession).toHaveBeenCalledWith('s1', '新名字')
  })
})
