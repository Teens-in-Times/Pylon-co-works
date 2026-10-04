// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { serializeWorkspaces, type Workspace } from '../workspaceEntities.ts'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('../../../infrastructure/tauri/env', () => ({ IS_TAURI: true, isBrowserMockRuntime: () => false }))

import { useWorkspaceEntityStore } from '../workspaceEntityStore.ts'

let fakeInvoke: FakeInvoke

const legacy: Workspace = {
  id: 'legacy-workspace-id',
  agentId: 'peri',
  name: 'Legacy',
  rootPath: 'C:\\legacy',
  createdAt: 1,
  lastActiveAt: 2,
  skills: ['review'],
  mcpServerIds: [],
  hookPluginIds: [],
}

describe('Workspace 后端持久化升级迁移', () => {
  beforeEach(() => {
    localStorage.clear()
    fakeInvoke = new FakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    useWorkspaceEntityStore.setState({ workspaces: [], hydrated: false })
  })

  it('后端首次为空时保留 id 导入旧前端镜像', async () => {
    localStorage.setItem('pylon-workspaces', serializeWorkspaces([legacy]))
    fakeInvoke.registerMany({
      workspace_list: () => [],
      workspace_restore: () => [legacy],
    })

    await useWorkspaceEntityStore.getState().hydrate()

    expect(fakeInvoke.calls[0]).toEqual({ cmd: 'workspace_list', args: {} })
    expect(fakeInvoke.calls[1]).toEqual({ cmd: 'workspace_restore', args: { workspaces: [legacy] } })
    expect(useWorkspaceEntityStore.getState().workspaces).toEqual([legacy])
  })
})
