/**
 * canonicalTouchedFileProjection 测试（0-A0 / issue #282）：
 * 路径提取三级优先（diff block > locations > rawInput）、非 edit 类零记录、
 * 绝对路径按 workspace root 求相对、求不出相对 → 丢弃、recordTouchedFile
 * 按 source 命中会话、install 幂等（重复安装只订阅一次 bus）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const subscribeSpy = vi.hoisted(() => vi.fn(() => () => undefined))
const sessionsRef = vi.hoisted(() => ({
  current: [] as Array<{ id: string; agentId: string; source: string; workdir: string; workspaceId?: string }>,
}))
const workspacesRef = vi.hoisted(() => ({ current: [] as Array<{ id: string; rootPath: string }> }))
const recordTouchedFileMock = vi.hoisted(() => vi.fn())

vi.mock('../../../domains/identity/identityStore.ts', () => ({
  useIdentityStore: { getState: () => ({ sessions: sessionsRef.current }) },
}))
vi.mock('../../../domains/workspace/workspaceEntityStore.ts', () => ({
  useWorkspaceEntityStore: { getState: () => ({ workspaces: workspacesRef.current }) },
}))
vi.mock('../../../domains/workspace/workspaceStore.ts', () => ({
  useWorkspaceStore: { getState: () => ({ recordTouchedFile: recordTouchedFileMock }) },
}))
vi.mock('../../../infrastructure/events/pluginEventBusHost.ts', () => ({
  subscribePluginEvents: (...args: unknown[]) => subscribeSpy(...(args as [])),
  publishPluginEvent: vi.fn(),
}))

import type { CanonicalConversationEvent } from '../../../domains/events/eventSchema'
import {
  extractTouchedPaths,
  installCanonicalTouchedFileProjection,
  projectCanonicalEventToTouchedFiles,
  uninstallCanonicalTouchedFileProjection,
} from '../canonicalTouchedFileProjection'

function toolEvent(input: {
  eventType?: CanonicalConversationEvent['eventType']
  kind?: string
  title?: string
  rawPayload?: unknown
  rawInput?: unknown
}): CanonicalConversationEvent {
  return {
    eventId: '["p","peri","local:a"]#1',
    owner: { profileId: 'p', agentId: 'peri', localSessionId: 'local:a' },
    clientGeneration: 1,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    eventType: input.eventType ?? 'tool.call.started',
    payloadVersion: 1,
    typedPayload: { tool: { ...(input.kind ? { kind: input.kind } : {}), ...(input.title ? { title: input.title } : {}), ...(input.rawInput !== undefined ? { rawInput: input.rawInput } : {}) } },
    rawPayload: input.rawPayload ?? {},
  } as CanonicalConversationEvent
}

beforeEach(() => {
  recordTouchedFileMock.mockClear()
  subscribeSpy.mockClear()
  sessionsRef.current = [{ id: 's1', agentId: 'peri', source: 'local:a', workdir: 'C:\\ws' }]
  workspacesRef.current = []
  uninstallCanonicalTouchedFileProjection()
})

describe('extractTouchedPaths 三级优先', () => {
  it('非 tool.call 事件 → 空', () => {
    expect(extractTouchedPaths(toolEvent({ eventType: 'assistant.text.delta', kind: 'edit' }))).toEqual([])
  })

  it('diff content block 最强：命中即只采信它（绝对路径按 cwd 求相对）', () => {
    const event = toolEvent({
      kind: 'read',
      rawPayload: { content: [{ type: 'diff', path: 'C:\\ws\\src\\a.ts', oldText: 'x', newText: 'y' }] },
    })
    expect(extractTouchedPaths(event, 'C:\\ws')).toEqual(['src/a.ts'])
  })

  it('edit 类 locations[] 次之；locations 里的多路径去重', () => {
    const event = toolEvent({
      kind: 'edit',
      rawPayload: { locations: [{ path: 'C:\\ws\\a.ts' }, { path: 'C:\\ws\\a.ts' }, { path: 'C:\\ws\\b.ts' }] },
    })
    expect(extractTouchedPaths(event, 'C:\\ws')).toEqual(['a.ts', 'b.ts'])
  })

  it('非 edit 类工具的 locations 不采信（防读类误记）', () => {
    const event = toolEvent({ kind: 'read', rawPayload: { locations: [{ path: 'C:\\ws\\a.ts' }] } })
    expect(extractTouchedPaths(event, 'C:\\ws')).toEqual([])
  })

  it('rawInput 键兜底：kind=edit 且 rawInput.path 相对路径原样', () => {
    const event = toolEvent({ kind: 'edit', rawInput: { path: 'src/a.ts' } })
    expect(extractTouchedPaths(event, 'C:\\ws')).toEqual(['src/a.ts'])
  })

  it('旧工具名回退：kind 缺失但 title=Edit 也算 edit', () => {
    const event = toolEvent({ title: 'Edit', rawInput: { file_path: 'C:\\ws\\a.ts' } })
    expect(extractTouchedPaths(event, 'C:\\ws')).toEqual(['a.ts'])
  })

  it('旧工具名回退覆盖 Write/patch 变体', () => {
    for (const title of ['Write', 'patch']) {
      const event = toolEvent({ title, rawInput: { path: 'C:\\ws\\a.ts' } })
      expect(extractTouchedPaths(event, 'C:\\ws')).toEqual(['a.ts'])
    }
  })

  it('completed 终态同样触发（写盘发生在 started 与 completed 之间）', () => {
    const event = toolEvent({ eventType: 'tool.call.completed', kind: 'edit', rawInput: { path: 'src/a.ts' } })
    expect(extractTouchedPaths(event, 'C:\\ws')).toEqual(['src/a.ts'])
  })

  it('cwd 外绝对路径 → 丢弃不记录', () => {
    const event = toolEvent({ kind: 'edit', rawInput: { path: 'D:\\elsewhere\\a.ts' } })
    expect(extractTouchedPaths(event, 'C:\\ws')).toEqual([])
  })
})

describe('projectCanonicalEventToTouchedFiles', () => {
  it('命中会话 → recordTouchedFile({agentId, source}, {path, toolKind, at})', () => {
    projectCanonicalEventToTouchedFiles(toolEvent({ kind: 'edit', rawInput: { path: 'src/a.ts' } }))
    expect(recordTouchedFileMock).toHaveBeenCalledTimes(1)
    const [context, file] = recordTouchedFileMock.mock.calls[0]!
    expect(context).toEqual({ agentId: 'peri', source: 'local:a' })
    expect(file).toMatchObject({ path: 'src/a.ts', toolKind: 'edit' })
    expect(typeof file.at).toBe('number')
  })

  it('workspaceId 绑定会话的 cwd 取 rootPath 而非 workdir', () => {
    sessionsRef.current = [{ id: 's1', agentId: 'peri', source: 'local:a', workdir: 'C:\\ws', workspaceId: 'w1' }]
    workspacesRef.current = [{ id: 'w1', rootPath: 'E:\\repo' }]
    projectCanonicalEventToTouchedFiles(toolEvent({ kind: 'edit', rawInput: { path: 'E:\\repo\\b.ts' } }))
    expect(recordTouchedFileMock.mock.calls[0]![1]).toMatchObject({ path: 'b.ts' })
  })

  it('未命中会话（owner 不匹配）→ 零记录', () => {
    sessionsRef.current = [{ id: 's1', agentId: 'other', source: 'local:z', workdir: 'C:\\ws' }]
    projectCanonicalEventToTouchedFiles(toolEvent({ kind: 'edit', rawInput: { path: 'a.ts' } }))
    expect(recordTouchedFileMock).not.toHaveBeenCalled()
  })
})

describe('install 幂等', () => {
  it('重复安装只订阅一次 bus；reset 后可重装', () => {
    installCanonicalTouchedFileProjection()
    installCanonicalTouchedFileProjection()
    expect(subscribeSpy).toHaveBeenCalledTimes(1)
    uninstallCanonicalTouchedFileProjection()
    installCanonicalTouchedFileProjection()
    expect(subscribeSpy).toHaveBeenCalledTimes(2)
  })
})
