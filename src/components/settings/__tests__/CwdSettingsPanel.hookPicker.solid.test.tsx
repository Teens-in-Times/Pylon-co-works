// @vitest-environment jsdom
// #515：迁移自 CwdSettingsPanel.hookPicker.test.tsx（React RTL → Solid 实体直连）。
// 断言改写点登记：
// - workspaceEntityStore mock 形态：实体经 createZustandSignal/getState 消费 store，
//   mock 从「可调用 selector 函数」改为 zustand 形态对象 { getState, subscribe }——
//   断言本体（updateWorkspace 调用参数/次数）原样保留。
// - checkbox 的 fireEvent.click 断言不变（Solid 原生 change 在 click 内同步触发）。
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../../../domains/workspace/workspaceEntities'

const updateWorkspace = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../../domains/workspace/workspaceEntityStore', () => ({
  useWorkspaceEntityStore: {
    getState: () => ({ updateWorkspace }),
    subscribe: () => () => {},
  },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(async () => [])
})
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))
vi.mock('../../../infrastructure/acp/agentClient', () => ({
  createAgentClient: () => ({ getMcpServers: async () => [] }),
}))

import CwdSettingsPanel from '../CwdSettingsPanel.solid.tsx'
import { getPluginRuntime } from '../../../plugin-runtime/pluginCompositionRoot.ts'

const workspace: Workspace = {
  id: 'w1',
  agentId: 'peri',
  name: '工作区一',
  rootPath: '/repo',
  createdAt: 0,
  lastActiveAt: 0,
  skills: [],
  mcpServerIds: [],
  hookPluginIds: ['legacy.gone'],
}

afterEach(() => cleanup())

afterEach(async () => {
  updateWorkspace.mockClear()
  const runtime = getPluginRuntime()
  for (const identity of runtime.snapshot().active) {
    if (identity.pluginId.startsWith('test.hook-picker')) await runtime.disable(identity.pluginId)
  }
})

describe('CwdSettingsPanel Hook opt-in picker', () => {
  it('已存但未激活的插件 id 显示为保留声明项，可移除', () => {
    render(() => <CwdSettingsPanel workspace={workspace} onClose={() => undefined} />)
    const legacy = screen.getByLabelText('保留未激活 Hook 插件 legacy.gone') as HTMLInputElement
    expect(legacy.checked).toBe(true)
    expect(screen.getByText(/未激活，保留声明/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('移除未激活 Hook 插件 legacy.gone'))
    expect(screen.queryByLabelText('保留未激活 Hook 插件 legacy.gone')).toBeNull()
  })

  it('勾选已激活插件后保存，updateWorkspace 持久化 hookPluginIds', async () => {
    const runtime = getPluginRuntime()
    runtime.activateBuiltinSync({ id: 'test.hook-picker.demo', activate: () => undefined })
    render(() => <CwdSettingsPanel workspace={workspace} onClose={() => undefined} />)

    const checkbox = screen.getByLabelText('Hook 插件 test.hook-picker.demo') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    expect(checkbox.checked).toBe(true)

    fireEvent.click(screen.getByText('保存更改'))
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledOnce())
    expect(updateWorkspace).toHaveBeenCalledWith('w1', expect.objectContaining({
      hookPluginIds: ['legacy.gone', 'test.hook-picker.demo'],
    }))
  })
})
