import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_SHEET_STATE, sheetReducer } from '../../../domains/workspace/sheetState'
import {
  parseSheetStateV2,
  serializeSheetStateV2,
  type PersistedSheetState,
} from '../../../domains/workspace/sheetPersistence'
import { resolveWorkspace } from '../workspaceRegistry'
import type { WorkspaceTypeDefinition } from '../workspaceTypes'
import { TestPluginRuntime as PluginRuntime } from '../../testing/pluginRuntimeHarness.ts'
import type { PluginWorkspaceApi } from '../pluginWorkspaceApi'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore'
import '../../../app/bootstrap/workspaceControllerWiring'

function dynamicWorkspace(kind: string): WorkspaceTypeDefinition {
  return {
    kind,
    label: 'Dynamic Test',
    singleton: true,
    getSingletonKey: () => kind,
    sidebarMode: 'none',
    launch: {
      kind,
      title: 'Dynamic Test',
      description: 'v2 workspace API fixture',
      launchable: true,
    },
    component: () => null,
    createInitialState: input => ({ input: input ?? null }),
    serialize: state => ({ schema: 1, value: state }),
    deserialize: raw => {
      if (!raw || typeof raw !== 'object' || (raw as { schema?: unknown }).schema !== 1) {
        throw new Error('invalid dynamic workspace state')
      }
      return (raw as { value: unknown }).value
    },
  }
}

describe('PluginWorkspaceApi', () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
    localStorage.clear()
  })

  it('PluginScope 持有动态 workspace 注册，停用后自动注销', async () => {
    const kind = 'test.dynamic-lifecycle'
    const runtime = new PluginRuntime()
    const instance = runtime.activateBuiltinSync({
      id: 'test.workspace-lifecycle',
      activate: ({ workspace }) => {
        workspace.registerType(dynamicWorkspace(kind))
      },
    })

    expect(resolveWorkspace(kind)?.label).toBe('Dynamic Test')
    expect(instance.scope.size).toBe(1)

    const result = await runtime.deactivate(instance.identity.key)

    expect(result.scope).toEqual({ disposed: 1, remaining: 0, errors: [] })
    expect(resolveWorkspace(kind)).toBeUndefined()
  })

  it('动态 kind 可打开并通过 v2 持久化解析往返', async () => {
    const kind = 'test.dynamic-persistence'
    const runtime = new PluginRuntime()
    const instance = await runtime.activateBuiltin({
      id: 'test.workspace-persistence',
      activate: ({ workspace }) => {
        workspace.registerType(dynamicWorkspace(kind))
      },
    })

    const opened = sheetReducer(EMPTY_SHEET_STATE, {
      type: 'open',
      now: 100,
      sheet: { kind, title: 'Dynamic Sheet', state: { count: 2 } },
    })
    const persisted: PersistedSheetState = { ...opened, agentStates: {} }
    const serialized = serializeSheetStateV2(persisted)
    const restored = parseSheetStateV2(serialized)

    expect(opened.sheets).toHaveLength(1)
    expect(opened.sheets[0].state).toEqual({ schema: 1, value: { input: { count: 2 } } })
    expect(restored.state.sheets).toEqual(opened.sheets)

    await runtime.deactivate(instance.identity.key)
    expect(parseSheetStateV2(serialized).state.sheets).toEqual([])
    expect(sheetReducer(EMPTY_SHEET_STATE, {
      type: 'open',
      now: 200,
      sheet: { kind, title: 'Unregistered Dynamic Sheet' },
    }).sheets).toEqual([])
  })

  it('激活失败时回滚 workspace 注册', async () => {
    const kind = 'test.dynamic-rollback'
    const runtime = new PluginRuntime()

    await expect(runtime.activateBuiltin({
      id: 'test.workspace-rollback',
      activate: ({ workspace }) => {
        workspace.registerType(dynamicWorkspace(kind))
        throw new Error('activate failed')
      },
    })).rejects.toMatchObject({ rollback: { disposed: 1, errors: [] } })

    expect(resolveWorkspace(kind)).toBeUndefined()
  })

  it('open/focus/close/list 共用真实 Workspace controller，并执行异步 canClose', async () => {
    const kind = 'test.dynamic-controller'
    const runtime = new PluginRuntime()
    let workspaceApi: PluginWorkspaceApi | undefined
    let allowClose = false
    const definition = dynamicWorkspace(kind)
    definition.canClose = async () => allowClose
    const instance = runtime.activateBuiltinSync({
      id: 'test.workspace-controller',
      activate: ({ workspace }) => {
        workspaceApi = workspace
        workspace.registerType(definition)
      },
    })

    const id = workspaceApi!.open({ type: kind, title: 'Controller', state: { count: 3 } })
    expect(id).toBeTruthy()
    expect(workspaceApi!.list().map(sheet => sheet.id)).toEqual([id])
    expect(workspaceApi!.listTypes().some(item => item.kind === kind)).toBe(true)
    expect(workspaceApi!.focus(id!)).toBe(true)
    expect(await workspaceApi!.close(id!)).toBe(false)
    expect(workspaceApi!.list()).toHaveLength(1)

    allowClose = true
    expect(await workspaceApi!.close(id!)).toBe(true)
    expect(workspaceApi!.list()).toEqual([])
    await runtime.deactivate(instance.identity.key)
  })
})
