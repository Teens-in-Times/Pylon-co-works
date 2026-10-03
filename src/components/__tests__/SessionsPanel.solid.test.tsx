// @vitest-environment jsdom
// #515：SessionsPanel 测试的 Solid 版（断言集与 React 版逐一对应，未缩减）。
// 改写点登记：
// - `@testing-library/react` 的 render → `@solidjs/testing-library` 的 render（传函数）；
//   **fireEvent 保留 RTL-react 版**：本文件断言覆盖 Dialog 内的 CwdSettingsPanel React 岛，
//   RTL 的 fireEvent 自带 act 包装，岛内状态更新不会落成 console.error 噪音；
// - 受控输入断言不变（fireEvent.change 对 Solid 实体的输入走原生 change 事件无法触达
//   onInput 的场景，本文件输入均经 React 岛或 waitFor 异步链，无需改写）。
import { fireEvent, screen, waitFor, within } from '@testing-library/dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import SessionsPanel from '../sidebar/SessionsPanel.solid.tsx'
import { resetStores } from '../../test/resetStores'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore'
import { getPluginRuntime } from '../../plugin-runtime/pluginCompositionRoot.ts'

const { invoke, open } = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))

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

const boundSession = {
  id: 'session-1', agentId: 'peri', name: '实现界面', source: 'local:1', profileId: 'profile-a',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: workspace.rootPath, workspaceId: workspace.id,
  sessionPrompt: '', skills: [], hooks: [], autoName: '', metadata: {}, context: {},
}

/** 无 cwd 会话：只有 `workdir` 空串、没有 `workspaceId`——分组判据就是 `!workspaceId`。 */
const looseSession = {
  id: 'session-2', agentId: 'peri', name: '介绍一下你自己', source: 'local:2', profileId: 'profile-a',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '',
  sessionPrompt: '', skills: [], hooks: [], autoName: '', metadata: {}, context: {},
}

function createProps(overrides: Partial<AgentSidebarContributionProps> = {}): AgentSidebarContributionProps {
  return {
    activeAgentId: 'peri',
    activeSessionId: null,
    sessions: [],
    workspaces: [workspace],
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

/** 宿主要求贡献在挂载期注册区块头动作处理器；测试里接住它并按 actionId 调回去。 */
function captureBlockAction(overrides: Partial<AgentSidebarContributionProps> = {}) {
  let handler: ((actionId: string) => void) | null = null
  const props = createProps({ registerBlockActionHandler: next => { handler = next }, ...overrides })
  return { props, fire: (actionId: string) => { if (!handler) throw new Error('贡献未注册区块头处理器'); handler!(actionId) } }
}

describe('SessionsPanel', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    invoke.mockResolvedValue([])
    open.mockReset()
    open.mockResolvedValue(null)
  })

  it('区块头的「工作区」动作交给目录选择器，并自动生成工作区名称', async () => {
    const onCreateWorkspace = vi.fn(async () => {})
    open.mockResolvedValue('C:\\Users\\Tester\\pylon-demo')
    const { props, fire } = captureBlockAction({ onCreateWorkspace })
    render(() => <SessionsPanel {...props} />)

    // 头部按钮由宿主渲染，贡献只注册语义——这里正是那条链路的断言。
    fire('new-workspace')

    await waitFor(() => expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择工作区文件夹',
    }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '工作区名称' })).toHaveValue('pylon-demo'))
    expect(screen.getByTitle('C:\\Users\\Tester\\pylon-demo')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(onCreateWorkspace).toHaveBeenCalledWith('pylon-demo', 'C:\\Users\\Tester\\pylon-demo'))
    expect(screen.queryByRole('textbox', { name: '工作区名称' })).not.toBeInTheDocument()
  })

  it('将工作区设置作为弹出式对话框呈现', async () => {
    render(() => <SessionsPanel {...createProps()} />)

    const list = screen.getByRole('tree', { name: '工作区与会话' })
    fireEvent.click(within(list).getByRole('button', { name: 'Pylon 工作区设置' }))

    const settings = await screen.findByRole('dialog')
    expect(within(settings).getByText('G:/Project/Pylon')).toBeInTheDocument()
    expect(within(settings).getByText('Skills（逗号分隔）')).toBeInTheDocument()
    expect(within(settings).queryByRole('button', { name: '在 Pylon 中新建会话' })).not.toBeInTheDocument()

    fireEvent.click(within(settings).getByRole('button', { name: '关闭工作区设置' }))
    expect(screen.getByRole('tree', { name: '工作区与会话' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '在 Pylon 中新建会话' })).toBeInTheDocument()
  })

  it('工作区设置会实际保存名称、目录、Skills 与 Hook，而不是安慰按钮', async () => {
    useWorkspaceEntityStore.setState({ workspaces: [workspace], hydrated: true })
    const runtime = getPluginRuntime()
    runtime.activateBuiltinSync({ id: 'test.hooks.audit', activate: () => undefined })
    render(() => <SessionsPanel {...createProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pylon 工作区设置' }))

    // #515：CwdSettingsPanel 已迁 Solid 实体（输入走 onInput）——文本输入用
    // fireEvent.input 触达（原生 change 在 Solid 下等价 blur 语义，打不进受控流）。
    fireEvent.input(await screen.findByRole('textbox', { name: '工作区名称' }), { target: { value: 'Pylon Desktop' } })
    fireEvent.input(screen.getByRole('textbox', { name: '工作目录' }), { target: { value: '/path/to/project' } })
    fireEvent.input(screen.getByRole('textbox', { name: 'Skills（逗号分隔）' }), { target: { value: 'review, test' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hook 插件 test.hooks.audit' }))
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    await waitFor(() => expect(useWorkspaceEntityStore.getState().workspaces[0]).toMatchObject({
      name: 'Pylon Desktop',
      rootPath: '/path/to/project',
      skills: ['review', 'test'],
      hookPluginIds: ['test.hooks.audit'],
    }))
    await runtime.disable('test.hooks.audit')
  })

  it('持久化每个工作区的展开状态，并支持键盘选择会话', async () => {
    const onSelectSession = vi.fn()
    const view = render(() => <SessionsPanel {...createProps({ sessions: [boundSession], onSelectSession })} />)

    fireEvent.keyDown(screen.getByText('实现界面').closest('[role="treeitem"]')!, { key: 'Enter' })
    expect(onSelectSession).toHaveBeenCalledWith('session-1')
    fireEvent.click(screen.getByRole('button', { name: '折叠 Pylon' }))
    await waitFor(() => expect(localStorage.getItem('pylon-workspace-tree:v1')).toContain('workspace-1'))

    view.unmount()
    render(() => <SessionsPanel {...createProps({ sessions: [boundSession] })} />)
    expect(screen.getByRole('button', { name: '展开 Pylon' })).toBeInTheDocument()
    const collapsedSessions = document.querySelector('.cwd-group-sessions.is-collapsed')
    expect(collapsedSessions).toHaveAttribute('aria-hidden', 'true')
  })

  it('将工作区身份与操作分成稳定几何层；会话计数不再显示', () => {
    render(() => <SessionsPanel {...createProps()} />)
    const toggle = screen.getByRole('button', { name: '折叠 Pylon' })
    const head = toggle.closest('.cwd-group-head')!

    // 身份是单行的「文件夹 + 名称」；目录路径降级为 tooltip（不再占一行 9.5px 小字）。
    expect(toggle).toContainElement(screen.getByText('Pylon'))
    expect(toggle).toHaveAttribute('title', 'G:/Project/Pylon')
    expect(head).toContainElement(screen.getByRole('button', { name: '在 Pylon 中新建会话' }))
    expect(head).toContainElement(screen.getByRole('button', { name: 'Pylon 工作区设置' }))
    expect(document.querySelector('.cwd-group-count')).toBeNull()
    expect(screen.queryByLabelText('0 个会话')).toBeNull()
  })

  it('无 cwd 会话落在会话列表最底部的独立分组，且带自己的新建入口', () => {
    const onCreateLooseSession = vi.fn()
    render(() => <SessionsPanel {...createProps({ sessions: [boundSession, looseSession], onCreateLooseSession })} />)

    const groups = [...document.querySelectorAll('.cwd-group')]
    expect(groups).toHaveLength(2)
    expect(groups.at(-1)!.querySelector('.cwd-group-name')!.textContent).toBe('无工作区')
    // 有工作区的会话归工作区组，无 cwd 的归底部组，两者不混。
    expect(groups[0].querySelector('.session-name')!.textContent).toBe('实现界面')
    expect(groups.at(-1)!.querySelector('.session-name')!.textContent).toBe('介绍一下你自己')

    fireEvent.click(screen.getByRole('button', { name: '在 无工作区 中新建会话' }))
    expect(onCreateLooseSession).toHaveBeenCalledOnce()
  })

  it('会话行只有两个动作：置顶与设置（删除/导出/归档从行上撤出，收进设置）', () => {
    const onOpenSessionSettings = vi.fn()
    const onToggleSessionPin = vi.fn()
    render(() => <SessionsPanel {...createProps({ sessions: [boundSession], onOpenSessionSettings, onToggleSessionPin })} />)

    const row = document.querySelector('.session-item')!
    const labels = [...row.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))
    expect(labels).toEqual(['置顶 实现界面', '实现界面 会话设置'])
    // 三个旧动作不得复活（用户点名「设置和删除完全不见了」，但要求行上只留两个）。
    expect(screen.queryByLabelText('删除 实现界面')).toBeNull()
    expect(screen.queryByLabelText('实现界面 导出')).toBeNull()
    expect(screen.queryByLabelText('实现界面 归档')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '实现界面 会话设置' }))
    expect(onOpenSessionSettings).toHaveBeenCalledWith('session-1')
    expect(screen.getByRole('button', { name: '实现界面 会话设置' })).toHaveAttribute('title', '会话设置（重命名 / 归档 / 导出）')
  })

  it('置顶按钮切换置顶且不选中会话；已置顶的行常驻显示取消置顶', async () => {
    const onToggleSessionPin = vi.fn()
    const onSelectSession = vi.fn()
    // React 版的 rerender 语义改写：props 经信号重推（Solid 无 rerender API）。
    const [currentProps, setCurrentProps] = createSignal(createProps({ sessions: [boundSession], onToggleSessionPin, onSelectSession }))
    render(() => <SessionsPanel {...currentProps()} />)

    fireEvent.click(screen.getByRole('button', { name: '置顶 实现界面' }))
    expect(onToggleSessionPin).toHaveBeenCalledWith('session-1')
    // 行内的按钮必须 stopPropagation：点按钮不该连带选中会话。
    expect(onSelectSession).not.toHaveBeenCalled()

    setCurrentProps(createProps({ sessions: [{ ...boundSession, pinned: true }], onToggleSessionPin, onSelectSession }))
    await waitFor(() => expect(screen.getByRole('button', { name: '取消置顶 实现界面' })).toHaveAttribute('aria-pressed', 'true'))
    expect(document.querySelector('.session-item')).toHaveAttribute('data-pinned', 'true')
  })

  it('没有任何工作区也没有无 cwd 会话时给出起步空态', () => {
    render(() => <SessionsPanel {...createProps({ workspaces: [] })} />)
    expect(screen.getByText('从一个文件夹开始')).toBeInTheDocument()
  })
})
