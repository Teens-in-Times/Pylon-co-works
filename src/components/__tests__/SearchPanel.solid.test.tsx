// @vitest-environment jsdom
// #515：SearchPanel 测试的 Solid 版（断言集与 React 版逐一对应，未缩减）。
// 改写点登记：
// - `@testing-library/react` → `@solidjs/testing-library`（render 传函数）；
// - 受控输入的 `fireEvent.change` → `fireEvent.input`（Solid 的受控 input 走 onInput）。
import { fireEvent, render, screen, within } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import SearchPanel from '../sidebar/SearchPanel.solid.tsx'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'

function session(overrides: Partial<WorkspaceSession> & { id: string; name: string }): WorkspaceSession {
  return {
    agentId: 'peri', source: `src-${overrides.id}`, profileId: 'default', createdAt: 1, lastActiveAt: 1,
    platform: 'pylon', workdir: 'G:/Pylon', sessionPrompt: '', skills: [], hooks: [], autoName: '',
    ...overrides,
  }
}

const workspace = {
  id: 'workspace-1', agentId: 'peri', name: 'prism-desktop', rootPath: 'G:/Project/prism-desktop',
  createdAt: 1, lastActiveAt: 1, skills: [], mcpServerIds: [], hookPluginIds: [],
}

function props(overrides: Partial<AgentSidebarContributionProps> = {}): AgentSidebarContributionProps {
  return {
    activeAgentId: 'peri',
    activeSessionId: null,
    sessions: [],
    workspaces: [],
    liveGeneratingSources: [],
    presentation: 'block',
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

const type = (text: string) => {
  fireEvent.input(screen.getByRole('textbox', { name: '搜索会话' }), { target: { value: text } })
}

describe('搜索模块（独立面板）', () => {
  it('未输入时给提示、不出结果', () => {
    render(() => <SearchPanel {...props({ sessions: [session({ id: 's1', name: '会话一' })] })} />)
    expect(screen.getByText(/开始搜索/)).toBeInTheDocument()
    expect(screen.queryByRole('tree', { name: '搜索结果' })).toBeNull()
  })

  it('按会话名命中并按工作区分组，显示命中计数', () => {
    render(() => <SearchPanel {...props({
      workspaces: [workspace],
      sessions: [
        session({ id: 's1', name: '讨论终端风格', workspaceId: 'workspace-1' }),
        session({ id: 's2', name: '无关会话', workspaceId: 'workspace-1' }),
        session({ id: 's3', name: '终端下的搜索', workspaceId: undefined }),
      ],
    })} />)
    type('终端')

    expect(screen.getByRole('status')).toHaveTextContent('2 个匹配')
    const tree = screen.getByRole('tree', { name: '搜索结果' })
    expect(within(tree).getByText('讨论终端风格')).toBeInTheDocument()
    expect(within(tree).getByText('终端下的搜索')).toBeInTheDocument()
    expect(within(tree).queryByText('无关会话')).toBeNull()
    // 两个族群各自成组：有 cwd 的按工作区，无 cwd 的进「无工作区」。
    expect(within(tree).getByRole('group', { name: 'prism-desktop' })).toBeInTheDocument()
    expect(within(tree).getByRole('group', { name: '无工作区' })).toBeInTheDocument()
  })

  it('工作区名命中时列出该工作区的全部会话（对应 VSCode 搜到文件名即列该文件）', () => {
    render(() => <SearchPanel {...props({
      workspaces: [workspace],
      sessions: [
        session({ id: 's1', name: '甲', workspaceId: 'workspace-1' }),
        session({ id: 's2', name: '乙', workspaceId: 'workspace-1' }),
      ],
    })} />)
    type('prism-desktop')
    expect(screen.getByRole('status')).toHaveTextContent('2 个匹配')
  })

  it('无命中时给空态，不渲染结果树', () => {
    render(() => <SearchPanel {...props({ sessions: [session({ id: 's1', name: '会话一' })] })} />)
    type('zzz')
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument()
    expect(screen.queryByRole('tree', { name: '搜索结果' })).toBeNull()
  })

  it('点击命中项选中该会话；清除按钮清空查询并回到提示态', () => {
    const onSelectSession = vi.fn()
    render(() => <SearchPanel {...props({ onSelectSession, sessions: [session({ id: 's1', name: '会话一' })] })} />)
    type('会话')
    fireEvent.click(screen.getByRole('treeitem', { name: /会话一/ }))
    expect(onSelectSession).toHaveBeenCalledWith('s1')

    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(screen.getByRole('textbox', { name: '搜索会话' })).toHaveValue('')
    expect(screen.getByText(/开始搜索/)).toBeInTheDocument()
  })

  it('当前会话在结果里标为选中', () => {
    render(() => <SearchPanel {...props({ activeSessionId: 's1', sessions: [session({ id: 's1', name: '会话一' })] })} />)
    type('会话')
    expect(screen.getByRole('treeitem', { name: /会话一/ })).toHaveClass('active')
  })
})
