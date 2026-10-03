// @vitest-environment jsdom
// #515：自 OverviewSheetView.visual.test.tsx 迁移（断言集与用例逐一保留，渲染改走
// Solid 实体；fireEvent/screen 等查询语义不变）。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import OverviewSheetView from '../OverviewSheetView.solid.tsx'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore.ts'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore.ts'
import { resetStores } from '../../test/resetStores.ts'
import { FakeInvoke } from '../../test/fakeInvoke'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: false, hasTauriRuntime: () => false }))

/** 未注册命令 resolve {}（对齐原内联 mock `vi.fn(() => Promise.resolve({}))` 的宽松路径） */
class PermissiveFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return {}
      throw error
    })
  }
}

let fakeInvoke: PermissiveFakeInvoke

const sheet: SheetRecord = { id: 'overview', kind: 'overview', title: 'Overview', createdAt: 0, lastFocusedAt: 0 }

// vitest globals 未开，solid testing-library 不自动 cleanup——多 render 测试文件手动收。
afterEach(cleanup)

beforeEach(() => {
  fakeInvoke = new PermissiveFakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  resetStores()
  useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  useIdentityStore.setState({
    activeAgent: 'peri',
    agents: [
      { id: 'peri', name: 'Peri', provider: 'ACP' },
      { id: 'hermes', name: 'Hermes', provider: 'ACP' },
    ],
    sessions: [{
      id: 'session-1', agentId: 'peri', periId: 'remote-1', name: '视觉验收会话', source: 'local:visual',
      profileId: 'default', createdAt: 1, lastActiveAt: Date.now(), platform: 'local', workdir: 'G:/Pylon',
      workspaceId: 'workspace-1', sessionPrompt: '', skills: [], hooks: [], autoName: '视觉验收会话',
    }],
  })
  useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected' })
  useRuntimeStore.getState().setAgentStatus('hermes', { agent: 'hermes', agentId: 'hermes', status: 'error' })
  useWorkspaceEntityStore.setState({
    hydrated: true,
    workspaces: [{
      id: 'workspace-1', agentId: 'peri', name: 'Pylon Desktop', rootPath: 'G:/Pylon', createdAt: 1,
      lastActiveAt: Date.now(), skills: [], mcpServerIds: [], hookPluginIds: [],
    }],
  })
})

describe('Overview visual workbench', () => {
  // 改写点登记：指挥台是 Solid 直连（TacticalCommandDeck.solid），交互一律经 findBy
  // 等待渲染落 DOM；断言集与 React 版逐条一致，不缩减。
  it('战术导航进入现有分区、返回，并通过 Sheet host 打开诊断', async () => {
    useInterfaceModeStore.setState({ interfaceMode: 'tactical-blue' })
    const ctx = { openSheet: vi.fn(), selectSession: vi.fn() } as unknown as SheetContext
    const { container } = render(() => <OverviewSheetView sheet={sheet} ctx={ctx} />)
    const identity = useIdentityStore.getState()
    fireEvent.click(await screen.findByRole('button', { name: /Agent 编队/ }))
    expect(container.querySelector('.overview-sheet')).toHaveAttribute('data-tactical-panel', 'agents')
    expect(screen.getByRole('button', { name: /Peri.*1 个会话.*已连接/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '← 返回指挥台' }))
    expect(container.querySelector('.overview-sheet')).toHaveAttribute('data-tactical-panel', 'home')
    fireEvent.click(await screen.findByRole('button', { name: /运行诊断/ }))
    expect(ctx.openSheet).toHaveBeenCalledWith({ kind: 'runtime', title: '运行诊断' })
    expect(useIdentityStore.getState()).toBe(identity)
  })

  it('projects runtime, session and workspace truth into actionable sections', () => {
    const ctx = { openSheet: vi.fn(), selectSession: vi.fn() } as unknown as SheetContext
    render(() => <OverviewSheetView sheet={sheet} ctx={ctx} />)

    expect(screen.getByRole('heading', { name: '欢迎回到工作台' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Peri.*1 个会话.*已连接/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Hermes.*0 个会话.*错误/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /视觉验收会话.*Pylon Desktop.*Peri/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Pylon Desktop.*G:\/Pylon.*1 会话/ })).toBeInTheDocument()
  })

  it('#254：同名 Agent 的 Fleet 卡以 agentId 区分', () => {
    useIdentityStore.setState({
      agents: [
        { id: 'peri', name: 'Peri', provider: 'ACP' },
        { id: 'hermes', name: 'Hermes', provider: 'ACP' },
        { id: 'hermes-2', name: 'Hermes', provider: 'hermes' },
      ],
    })
    const ctx = { openSheet: vi.fn(), selectSession: vi.fn() } as unknown as SheetContext
    render(() => <OverviewSheetView sheet={sheet} ctx={ctx} />)

    // 两张同名「Hermes」卡，副标题必须露出各自的 agentId
    expect(screen.getByRole('button', { name: /Hermes.*hermes · 0 个会话/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Hermes.*hermes-2 · 0 个会话/ })).toBeInTheDocument()
  })

  it('#255：工作区卡双口径——关联数与当前可见数分叉时并列标注，一致时退回单数字', () => {
    useIdentityStore.setState({
      activeProfileId: 'default',
      sessions: [
        {
          id: 'session-1', agentId: 'peri', periId: 'remote-1', name: '当前可见会话', source: 'local:cur',
          profileId: 'default', createdAt: 1, lastActiveAt: Date.now(), platform: 'local', workdir: 'G:/Pylon',
          workspaceId: 'workspace-1', sessionPrompt: '', skills: [], hooks: [], autoName: '当前可见会话',
        },
        {
          id: 'session-2', agentId: 'hermes', periId: 'remote-2', name: '他 Agent 会话', source: 'local:other',
          profileId: 'default', createdAt: 2, lastActiveAt: Date.now() - 1000, platform: 'local', workdir: 'G:/Pylon',
          workspaceId: 'workspace-1', sessionPrompt: '', skills: [], hooks: [], autoName: '他 Agent 会话',
        },
        {
          id: 'session-3', agentId: 'peri', periId: 'remote-3', name: '归档会话', source: 'local:arch',
          profileId: 'default', createdAt: 3, lastActiveAt: Date.now() - 2000, platform: 'local', workdir: 'G:/Pylon',
          workspaceId: 'workspace-1', sessionPrompt: '', skills: [], hooks: [], autoName: '归档会话',
          archivedAt: 5,
        },
      ],
    })
    const ctx = { openSheet: vi.fn(), selectSession: vi.fn() } as unknown as SheetContext
    render(() => <OverviewSheetView sheet={sheet} ctx={ctx} />)

    // 关联 3（workspaceId 全计）；当前可见 1（default profile + peri + 未归档，与左栏树同口径）
    expect(screen.getByRole('button', { name: /Pylon Desktop.*3 关联 · 1 当前/ })).toBeInTheDocument()
  })

  it('opens the existing Agent settings domain from the hero action', () => {
    const listener = vi.fn()
    window.addEventListener('pylon:open-settings', listener)
    render(() => <OverviewSheetView sheet={sheet} ctx={{ } as SheetContext} />)

    fireEvent.click(screen.getByRole('button', { name: 'Agent 设置' }))
    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      domain: 'agents-connections', section: 'agent', agentId: 'peri',
    })
    window.removeEventListener('pylon:open-settings', listener)
  })

  it('内置占位路径不冒充可用 Agent，空工作台优先进入配置', () => {
    useIdentityStore.setState({
      sessions: [],
      agents: [{ id: 'peri', name: 'Peri', provider: 'peri', exe: '<PERI_EXE_PATH>', default: true }],
    })
    const listener = vi.fn()
    window.addEventListener('pylon:open-settings', listener)
    render(() => <OverviewSheetView sheet={sheet} ctx={{ } as SheetContext} />)

    expect(screen.queryByRole('button', { name: /打开 Peri/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /配置 Agent/ }))
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener('pylon:open-settings', listener)
  })

  // 下沉自 scripts/test-overview-sheet.mts（P91 A2）：三入口壳 + 选择 Agent 事务流
  // （switchAgentTransaction → 无缝 open agent sheet；失败保持 overview 并可审计展示）。
  it('选择 Agent：卡片点击经 switch 事务成功后打开 agent sheet 并清运行时状态', async () => {
    const ctx = { openSheet: vi.fn(), selectSession: vi.fn() } as unknown as SheetContext
    render(() => <OverviewSheetView sheet={sheet} ctx={ctx} />)

    // 三入口壳在场：选择 Agent（section 标题）+ hero 的 Agent 设置入口
    expect(screen.getByRole('heading', { name: '选择 Agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agent 设置' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Peri.*1 个会话.*已连接/ }))
    await vi.waitFor(() => {
      expect(ctx.openSheet).toHaveBeenCalledWith({ kind: 'agent', title: 'Peri', agentId: 'peri' })
    })
    // pylon:agent-switched 广播（switchAgentTransaction dispatchSwitched）
    expect(useIdentityStore.getState().activeAgent).toBe('peri')
  })

  it('选择 Agent 失败：保持 overview、错误以 alert 展示、卡片恢复可再选', async () => {
    fakeInvoke.register('switch_agent', () => { throw new Error('switch refused') })
    const ctx = { openSheet: vi.fn(), selectSession: vi.fn() } as unknown as SheetContext
    render(() => <OverviewSheetView sheet={sheet} ctx={ctx} />)

    fireEvent.click(screen.getByRole('button', { name: /Peri.*1 个会话.*已连接/ }))
    // 非校验错误：页面给 status 提示，细节进右下角错误中心（reportRuntimeError）
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('操作失败，详情见右下角错误中心')
    expect(ctx.openSheet).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Peri.*1 个会话.*已连接/ })).toBeEnabled()
  })
})
