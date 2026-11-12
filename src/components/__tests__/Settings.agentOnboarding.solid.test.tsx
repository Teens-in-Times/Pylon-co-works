// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 Settings.agentOnboarding.test.tsx，React RTL → Solid）：
// - AgentSettingsSection 已迁 Solid 实体并经 React 岛挂载——岛首渲异步（原 React 同步
//   提交），同步断言改 await findBy（findByTestId 先等岛落地，其余断言原样保留；
//   断言集不缩减）——上一批登记，本轮保留。
// - RTL 导入改 @solidjs/testing-library；显式 afterEach(cleanup)。
// - AgentRuntimePanel 的 vi.mock 工厂改 Solid JSX（#515 W1 起实体直连，mock 须产 Solid 元素），
//   本文件 JSX 经 solid 编译，不能进岛）；DOM 契约逐字段不变。
import { cleanup, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../test/fakeInvoke'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.solid'
import { resetStores } from '../../test/resetStores.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'

vi.mock('../settings/AgentRuntimePanel.solid.tsx', () => ({
  default: (props: { initialAgentId?: string }) => (
    <div data-testid="agent-runtime-panel" data-agent-id={props.initialAgentId}>runtime onboarding</div>
  ),
}))

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve undefined——挂载断言不关心后台 invoke 返回值 */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

const fakeInvoke = new TolerantFakeInvoke()
invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)

describe('Settings Agent onboarding', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [{ id: 'peri', name: 'Peri', exe: '<PERI_EXE_PATH>', default: true }],
    })
  })

  afterEach(async () => {
    cleanup()
  })

  it('进入 Agent 设置即挂载运行时发现入口，无需先展开高级组', async () => {
    mountSettingsSheet({ domain: 'agents-connections', section: 'agent' })

    await screen.findByTestId('agent-runtime-panel')
    expect(screen.getByTestId('agent-runtime-panel')).toBeInTheDocument()
  })

  it('错误恢复入口把目标 Agent 传给运行时管理面板', async () => {
    mountSettingsSheet({ domain: 'agents-connections', section: 'agent', agentId: 'peri' })

    await screen.findByTestId('agent-runtime-panel')
    expect(screen.getByTestId('agent-runtime-panel')).toHaveAttribute('data-agent-id', 'peri')
  })

  // #326：零 Agent 是合法首跑状态。此前该卡片回落硬编码 'peri'，会在没有这个 Agent 时
  // 显示一个不存在的名字/ID（与「预置必然失败的占位 Agent」同一类病）。
  it('零 Agent 时当前 Agent 概况如实空态，不伪造 Agent', async () => {
    // 走生产路径：list_agents 返回空表 → store 清空 activeAgent（不是直接塞 ''）
    useIdentityStore.getState().setAgents([])
    expect(useIdentityStore.getState().activeAgent).toBe('')
    mountSettingsSheet({ domain: 'agents-connections', section: 'agent' })

    await screen.findByTestId('agent-runtime-panel')
    expect(screen.queryByRole('region', { name: '当前 Agent 概况' })).toBeNull()
    expect(screen.queryByText('peri')).toBeNull()
    expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull()
    // 结构化新建入口照常可用（引导落点）
    expect(screen.getByTestId('agent-runtime-panel')).toBeInTheDocument()
  })
})
