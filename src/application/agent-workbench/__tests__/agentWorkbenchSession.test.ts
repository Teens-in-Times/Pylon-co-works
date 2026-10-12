import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import { createCanonicalEvent, type CanonicalConversationEvent } from '../../../domains/events/eventSchema.ts'
import type { Session } from '../../../domains/identity/identityStore.ts'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import { getCanonicalEventFeed } from '../../../infrastructure/events/canonicalEventFeed.ts'
import { toCanonicalOwnerKey } from '../../../domains/events/eventSchema.ts'
import { useThemeStore } from '../../../domains/theme/themeStore.ts'

function session(id = 'session-a', source = 'local:a'): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function message(sequence: number, role: 'user' | 'assistant', text: string, sessionId = 'local:a'): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId, sequence, recordedAt: `2026-08-22T00:00:0${sequence}.000Z`,
    source: { provider: 'peri', sourceId: `source-${sequence}` },
    identity: { messageId: `message-${sequence}` },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: { type: 'message.delta', role, parts: [{ kind: 'text', text }] },
  })
}

function canonicalRow(sequence: number, sessionUpdate: string, fields: Record<string, unknown> = {}): CanonicalConversationEvent {
  const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }
  return {
    schemaVersion: 1,
    eventId: `${toCanonicalOwnerKey(owner)}#${sequence}`,
    owner,
    provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
    clientGeneration: 1,
    sequence,
    occurredAt: `2026-08-22T00:00:0${sequence}.000Z`,
    receivedAt: `2026-08-22T00:00:0${sequence}.000Z`,
    eventType: sessionUpdate === 'user_message_chunk' ? 'user.message'
      : sessionUpdate === 'agent_message_chunk' ? 'assistant.text.delta'
        : sessionUpdate === 'agent_thought_chunk' ? 'assistant.thinking.delta'
          : sessionUpdate === 'done' ? 'turn.completed' : 'unknown',
    payloadVersion: 1,
    rawPayload: { update: { sessionUpdate, ...fields } },
  }
}

describe('Agent Workbench canonical session runtime', () => {
  it.each(['goal_snapshot', 'turn_committed', 'state_snapshot'])('#563：新会话收到静默 %s 行不误报 journal 损坏，冷读与 refresh 同判', async eventType => {
    const muted = canonicalRow(2, 'peri/agent_event', {
      eventJson: JSON.stringify({ type: eventType, value: {} }),
    })
    const rows = [canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: 'new prompt' } }), muted]
    let persisted: readonly unknown[] = []
    let publish: ((event: unknown) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => persisted,
      subscribe: listener => { publish = listener; return () => { publish = undefined } },
    })
    await service.bind(session())
    publish?.(rows[0])
    const beforeMuted = service.runtime.getSnapshot()
    publish?.(muted)
    expect(service.runtime.getSnapshot()).toBe(beforeMuted)
    expect(service.runtime.getSnapshot().error).toBeNull()
    expect(service.runtime.getSnapshot().document?.diagnostics.some(item => item.code === 'canonical.journal.malformed')).toBe(false)
    persisted = rows
    await service.refresh(session())
    expect(service.runtime.getSnapshot().status).not.toBe('degraded')
    expect(service.runtime.getSnapshot().error).toBeNull()
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['new prompt'])
    service.destroy()

    const restored = createAgentWorkbenchSessionRuntime({ loadAll: async () => rows, subscribe: () => () => {} })
    await restored.bind(session())
    expect(restored.runtime.getSnapshot().status).not.toBe('degraded')
    expect(restored.runtime.getSnapshot().error).toBeNull()
    expect(restored.runtime.getSnapshot().document?.diagnostics.some(item => item.code === 'canonical.journal.malformed')).toBe(false)
    restored.destroy()

    const paged = createAgentWorkbenchSessionRuntime({
      listJournalPages: async (_ownerKey, onPage) => {
        await onPage([rows[0]], false)
        await onPage([muted], true)
      },
      subscribe: () => () => {},
    })
    await paged.bind(session())
    expect(paged.runtime.getSnapshot().status).not.toBe('degraded')
    expect(paged.runtime.getSnapshot().error).toBeNull()
    expect(paged.runtime.getSnapshot().document?.diagnostics.some(item => item.code === 'canonical.journal.malformed')).toBe(false)
    paged.destroy()
  })

  it('#563：损坏行与合法静默行混合时，只统计损坏行', async () => {
    const valid = canonicalRow(1, 'peri/agent_event', { eventJson: JSON.stringify({ type: 'goal_snapshot', value: {} }) })
    const invalid = { ...valid, sequence: 2, eventId: 'invalid-id' }
    let publish: ((event: unknown) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [valid, invalid],
      subscribe: listener => { publish = listener; return () => { publish = undefined } },
    })
    const assertMalformed = (count: number) => {
      expect(service.runtime.getSnapshot().status).toBe('degraded')
      expect(service.runtime.getSnapshot().document?.diagnostics).toContainEqual(expect.objectContaining({
        code: 'canonical.journal.malformed', data: { malformedCount: count },
        message: `canonical journal 有 ${count} 条事件无法解析`,
      }))
    }
    await service.bind(session())
    assertMalformed(1)
    await service.refresh(session())
    assertMalformed(1)
    publish?.(valid)
    assertMalformed(1)
    publish?.(invalid)
    assertMalformed(2)
    service.destroy()
  })

  it('#155 T3：冷挂载恢复中断片段为有标记的临时内容', async () => {
    const ownerKey = toCanonicalOwnerKey({ profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' })
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      loadDrafts: async () => [{
        ownerKey, draftId: 'crashed-run', fragmentIndex: 0, clientGeneration: 1,
        remoteSessionId: 'remote-1', eventType: 'assistant.text.delta', identity: null,
        rawPayload: [{ update: { sessionUpdate: 'agent_message_chunk', content: { text: '未完成的回复' } } }],
        firstReceivedAt: '2026-09-25T00:00:00.000Z', createdAt: 1, interrupted: true,
      }],
      subscribe: () => () => {},
    })
    await service.bind(session())
    expect(service.runtime.getSnapshot().document?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: '未完成的回复', interruptedDraft: true, draftId: 'crashed-run', running: false }),
    ]))
    service.destroy()
  })
  it('#155 T3：预算分行后中断的片段继续已有消息时仍可处理', async () => {
    const ownerKey = toCanonicalOwnerKey({ profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' })
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [canonicalRow(1, 'agent_message_chunk', { content: { text: '已提交前缀' } })],
      loadDrafts: async () => [{
        ownerKey, draftId: 'tail-run', fragmentIndex: 0, clientGeneration: 1,
        remoteSessionId: 'remote-1', eventType: 'assistant.text.delta', identity: null,
        rawPayload: [{ update: { sessionUpdate: 'agent_message_chunk', content: { text: '中断尾部' } } }],
        firstReceivedAt: '2026-09-25T00:00:00.000Z', createdAt: 1, interrupted: true,
      }],
      subscribe: () => () => {},
    })
    await service.bind(session())
    expect(service.runtime.getSnapshot().document?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: '已提交前缀中断尾部', interruptedDraft: true, draftId: 'tail-run', running: false,
      }),
    ]))
    service.destroy()
  })
  it('#155 T3：正式提交替换临时投影，不重复正文', async () => {
    const ownerKey = toCanonicalOwnerKey({ profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' })
    let rows: unknown[] = []
    let fragments = [{
      ownerKey, draftId: 'handoff-run', fragmentIndex: 0, clientGeneration: 1,
      remoteSessionId: 'remote-1', eventType: 'assistant.text.delta' as const, identity: null,
      rawPayload: [{ update: { sessionUpdate: 'agent_message_chunk', content: { text: '同一段正文' } } }],
      firstReceivedAt: '2026-09-25T00:00:00.000Z', createdAt: 1, interrupted: false,
    }]
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => rows,
      loadDrafts: async () => fragments,
      subscribe: () => () => {},
    })
    await service.bind(session())
    expect(service.runtime.getSnapshot().document?.messages[0]?.content).toBe('同一段正文')
    expect(service.runtime.getSnapshot().document?.messages[0]?.interruptedDraft).toBeUndefined()
    rows = [canonicalRow(1, 'agent_message_chunk', { content: { text: '同一段正文' } })]
    fragments = []
    await getCanonicalEventFeed().acceptFrame({
      event: 'pylon:update',
      payload: { source: 'local:a', committedDraftId: 'handoff-run', canonicalEvent: rows[0] },
    })
    await vi.waitFor(() => {
      expect(service.runtime.getSnapshot().document?.messages.map(message => message.content)).toEqual(['同一段正文'])
      expect(service.runtime.getSnapshot().document?.messages[0]?.source.sourceId).toBe(ownerKey + '#1')
    })
    service.destroy()
  })
  it('重启后 canonical 已完成消息仍显示完成态摘要', async () => {
    const active = session('session-restored', 'local:a')
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [
        canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '已恢复请求' } }),
        canonicalRow(2, 'done'),
      ],
      subscribe: () => () => {},
    })

    await service.bind(active)

    expect(service.runtime.getSnapshot()).toMatchObject({
      generating: false,
      summary: { reason: 'done', elapsedMs: 1000, tokenCount: 0 },
    })
    service.destroy()
  })

  it('bind without a turn epoch keeps a canonical terminal document closed against a stale late patch', async () => {
    const active = session('session-restored-stale-controller', 'local:stale-controller')
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [
        canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '已完成请求' } }),
        canonicalRow(2, 'done'),
      ],
      subscribe: () => () => {},
    })

    await service.bind(active)

    expect(service.runtime.getSnapshot()).toMatchObject({
      generating: false,
      document: { session: { status: 'completed' } },
    })
    service.destroy()
  })

  it('P52 D3：controller transient 桥已移除——canonical running 行是唯一流式显示', async () => {
    const active = session('session-transient-bridge', 'local:transient-bridge')
    let publish: ((event: WorkbenchEventEnvelope) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      subscribe: listener => { publish = listener; return () => { publish = undefined } },
    })

    await service.bind(active)

    publish?.(createWorkbenchEnvelope({
      sessionId: active.source,
      sequence: 1,
      recordedAt: '2026-08-22T00:00:00.100Z',
      source: { provider: 'peri', sourceId: 's' },
      identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '流式正文' }] },
    }))

    const snapshot = service.runtime.getSnapshot()
    // 流式显示唯一主人 = canonical running 行（P52 D5：transient 字段已删除）。
    expect(snapshot.document?.messages.some(message => message.running && message.content === '流式正文')).toBe(true)
    expect(snapshot.generating).toBe(true)
    service.destroy()
  })

  it('切换会话后从 TurnClock 恢复生成指示器与迟滞时钟', async () => {
    const active = session('session-a', 'local:a')
    const other = session('session-b', 'local:b')
    let publish: ((event: WorkbenchEventEnvelope) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      subscribe: listener => { publish = listener; return () => { publish = undefined } },
    })

    // source A 的回合起点：live user echo envelope 驱动 TurnClock.start
    await service.bind(active)
    publish?.(createWorkbenchEnvelope({
      sessionId: active.source,
      sequence: 1,
      recordedAt: '1970-01-01T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'a-user' },
      identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'A 回合' }] },
    }))
    expect(service.runtime.getSnapshot()).toMatchObject({ generating: true })
    // 切到 B——指示器清零
    await service.bind(other)
    expect(service.runtime.getSnapshot()).toMatchObject({ generating: false, generationStart: 0 })
    // 切回 A——TurnClock 按 source 恢复活动时钟（journal 读完成后 reconcile）
    await service.bind(active)
    expect(service.runtime.getSnapshot()).toMatchObject({ generating: true })
    service.destroy()
  })

  it('canonical 活动态投影缺少运行行时仍保持 TurnClock 的计时起点', async () => {
    const active = session('session-clock', 'local:clock')
    let publish: ((event: WorkbenchEventEnvelope) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      subscribe: listener => { publish = listener; return () => { publish = undefined } },
    })
    await service.bind(active)
    // 回合起点：user echo envelope 驱动 TurnClock.start（Date.parse(recordedAt)）
    publish?.(createWorkbenchEnvelope({
      sessionId: active.source,
      sequence: 1,
      recordedAt: '2026-08-22T00:00:00.000Z',
      source: { provider: 'peri', sourceId: 'clock-user' },
      identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'tick' }] },
    }))
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_047_000)

    // 投影间隙：只有 transient session status、无 running 行——Date.now() 回退
    // 不得把 startTime 拉到当前时刻（R2 preserveActiveGeneration 由 TurnClock 持值）
    publish?.(createWorkbenchEnvelope({
      sessionId: active.source,
      sequence: 2,
      recordedAt: '2026-08-22T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'clock-status' },
      identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'session.status-updated', status: 'running' },
    }))

    expect(service.runtime.getSnapshot()).toMatchObject({
      generating: true,
    })
    service.destroy()
  })

  it('同一绑定身份的 Session 元数据更新不会重建流式文档', async () => {
    let loads = 0
    let liveEvent: ((event: WorkbenchEventEnvelope) => void) | undefined
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => { loads += 1; return [] },
      subscribe: listener => { liveEvent = listener; return () => { liveEvent = undefined } },
    })

    await service.bind(active)
    liveEvent?.(message(1, 'assistant', '流式内容'))
    const before = service.runtime.getSnapshot().document

    await service.bind({ ...active, name: '终态更新后的标题', autoName: '自动标题', lastReplyAt: 42, periId: 'remote-1', workspaceId: 'workspace-2', workdir: 'C:/workspace-2' })

    expect(loads).toBe(1)
    expect(service.runtime.getSnapshot().document).toBe(before)
    expect(service.runtime.getSnapshot().document?.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: '流式内容' }),
    ])
    service.destroy()
  })

  it('在 ACP 发送完成前把用户消息乐观投影到当前文档', async () => {
    let finishSend: (() => void) | undefined
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: () => () => {},
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-optimistic-1',
        optimisticUser: () => {},
        sendMessage: () => new Promise<void>(resolve => { finishSend = resolve }),
      },
    })
    await service.bind(active)

    const sending = service.commands.send(active.id, { text: '立刻显示这条消息' })
    expect(service.runtime.getSnapshot()).toMatchObject({ generating: true })
    expect(service.runtime.getSnapshot().document?.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '立刻显示这条消息', optimistic: true }),
    ])

    finishSend?.()
    await sending
    service.destroy()
  })

  it('authoritative user echo confirms the optimistic row without duplication', async () => {
    let liveEvent: ((event: WorkbenchEventEnvelope) => void) | undefined
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: listener => { liveEvent = listener; return () => {} },
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-confirm-1',
        optimisticUser: () => {}, sendMessage: async () => {},
      },
    })
    await service.bind(active)
    await service.commands.send(active.id, { text: '只出现一次' })
    liveEvent?.(message(1, 'user', '只出现一次'))

    const messages = service.runtime.getSnapshot().document?.messages ?? []
    expect(messages).toEqual([expect.objectContaining({ role: 'user', content: '只出现一次' })])
    expect(messages[0]?.optimistic).toBeUndefined()
    service.destroy()
  })

  it('相同正文连续发送时按发送顺序确认各自的 authoritative echo', async () => {
    let liveEvent: ((event: WorkbenchEventEnvelope) => void) | undefined
    let clientSequence = 0
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: listener => { liveEvent = listener; return () => {} },
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => `client-repeat-${++clientSequence}`,
        optimisticUser: () => {}, sendMessage: async () => {},
      },
    })
    await service.bind(active)
    await service.commands.send(active.id, { text: '继续' })
    await service.commands.send(active.id, { text: '继续' })

    liveEvent?.(message(1, 'user', '继续'))
    const partiallyConfirmed = service.runtime.getSnapshot().document?.messages ?? []
    expect(partiallyConfirmed).toHaveLength(2)
    expect(partiallyConfirmed.map(item => item.optimistic)).toEqual([undefined, true])

    liveEvent?.(message(2, 'user', '继续'))
    const messages = service.runtime.getSnapshot().document?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages.every(item => item.role === 'user' && item.content === '继续' && item.optimistic === undefined)).toBe(true)
    service.destroy()
  })

  it('load 期间只收到一个同正文 echo 时仍保留第二条 pending optimistic row', async () => {
    let resolveLoad: ((events: readonly unknown[]) => void) | undefined
    let liveEvent: ((event: WorkbenchEventEnvelope) => void) | undefined
    let clientSequence = 0
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: () => new Promise(resolve => { resolveLoad = resolve }),
      subscribe: listener => { liveEvent = listener; return () => {} },
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => `client-buffered-${++clientSequence}`,
        optimisticUser: () => {}, sendMessage: async () => {},
      },
    })
    const binding = service.bind(active)
    await service.commands.send(active.id, { text: '继续' })
    await service.commands.send(active.id, { text: '继续' })
    liveEvent?.(message(1, 'user', '继续'))
    resolveLoad?.([])
    await binding

    const messages = service.runtime.getSnapshot().document?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages.filter(item => item.optimistic === true)).toHaveLength(1)
    service.destroy()
  })

  it('发送被拒绝时撤销乐观行与错误生成态', async () => {
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: () => () => {},
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-reject-1',
        optimisticUser: () => {}, sendMessage: async () => { throw new Error('offline') },
      },
    })
    await service.bind(active)
    await expect(service.commands.send(active.id, { text: '发送失败' })).resolves.toMatchObject({ status: 'rejected' })
    expect(service.runtime.getSnapshot()).toMatchObject({ generating: false })
    expect(service.runtime.getSnapshot().document?.messages).toEqual([])
    service.destroy()
  })

  it('发送被拒绝后时钟回滚：迟到的非文档证据不得经 updateRuntimeState 复活指示器', async () => {
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      subscribe: () => () => {},
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-reject-runtime',
        optimisticUser: () => {},
        sendMessage: async () => { throw new Error('offline') },
      },
    })
    await service.bind(active)
    await service.commands.send(active.id, { text: '发送失败' })
    // 发送被拒：乐观投影已撤销、TurnClock 已回滚、document 无 running 行。
    expect(service.runtime.getSnapshot().generating).toBe(false)
    expect(service.runtime.getSnapshot().document?.messages).toEqual([])
    // reconcileTurnClock 是唯一的时钟回写路径：无活动时钟的 source 在
    // bind/refresh 后不得恢复 generating（区别于有活动时钟的切回恢复用例）。
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(false)
    service.destroy()
  })

  it('#204③/#380：被拒回滚以 journal 为准——refresh 时代的事实全保留、乐观行消失', async () => {
    const active = session('session-foldlog-replace', 'local:foldlog-replace')
    const userRow = message(1, 'user', 'hello')
    let rows: readonly unknown[] = [userRow]
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => rows,
      subscribe: () => () => {},
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-foldlog-reject',
        optimisticUser: () => {}, sendMessage: async () => { throw new Error('offline') },
      },
    })
    await service.bind(active)
    // refresh 让 journal 长出 assistant 行——foldLog 必须被这份新权威集整体替换，
    // 而不是继续钉住 bind 时代的旧信封实例（#204③ 前它还被回滚重折当作源）。
    rows = [userRow, message(2, 'assistant', 'world')]
    await service.refresh(active)
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['hello', 'world'])

    await expect(service.commands.send(active.id, { text: '发送失败' })).resolves.toMatchObject({ status: 'rejected' })
    // 回滚整页重折源 = refresh 集：被拒乐观行消失，refresh 时代的 journal 事实全保留。
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['hello', 'world'])
    expect(service.runtime.getSnapshot().generating).toBe(false)
    service.destroy()
  })

  it('#380：被拒回滚的权威源是 journal——重读会把期间落盘的行一并带回来', async () => {
    const active = session('session-380-reject', 'local:380-reject')
    const userRow = message(1, 'user', 'hello', 'local:380-reject')
    // 判据的构造：这份 journal 行**从未**进过任何 fold（bind 时还不存在，也没有 refresh），
    // 因此它只可能来自「回滚时真的读了一次 journal」——修前整页重折走的是内存里的信封日志，
    // 这条 assistant 行不会出现（用例会失败）。
    const laterRow = message(9, 'assistant', 'landed-later', 'local:380-reject')
    let rows: readonly unknown[] = [userRow]
    const loadAll = vi.fn(async () => rows)
    const service = createAgentWorkbenchSessionRuntime({
      loadAll,
      subscribe: () => () => {},
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-380-reject',
        optimisticUser: () => {}, sendMessage: async () => { throw new Error('offline') },
      },
    })
    await service.bind(active)
    const readsAfterBind = loadAll.mock.calls.length
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['hello'])

    rows = [userRow, laterRow]
    await expect(service.commands.send(active.id, { text: '发送失败' })).resolves.toMatchObject({ status: 'rejected' })
    // 回滚读了一次 journal（不是内存日志），乐观行消失、两条 journal 行都在。
    expect(loadAll.mock.calls.length).toBeGreaterThan(readsAfterBind)
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['hello', 'landed-later'])
    expect(service.runtime.getSnapshot().generating).toBe(false)
    service.destroy()
  })


  it('#380：在途 refresh 不会把被拒回滚的重建吞掉（rebuild 排队而非合并）', async () => {
    const active = session('session-rebuild-race', 'local:rebuild-race')
    let releaseFirstRead: (() => void) | undefined
    let readCount = 0
    const loadAll = vi.fn(async () => {
      readCount += 1
      if (readCount === 2) {
        // 第二次读（下面手动发起的「在途 refresh」）挂住不返回，制造合并窗口。
        await new Promise<void>(resolve => { releaseFirstRead = resolve })
      }
      return []
    })
    const service = createAgentWorkbenchSessionRuntime({
      loadAll,
      subscribe: () => () => {},
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-rebuild-race',
        optimisticUser: () => {}, sendMessage: async () => { throw new Error('offline') },
      },
    })
    await service.bind(active)
    expect(readCount).toBe(1)

    const inFlight = service.refresh(active)          // 在途「续折」读，挂住
    await Promise.resolve()
    expect(readCount).toBe(2)

    const send = service.commands.send(active.id, { text: '发送失败' })
    await Promise.resolve()
    // rebuild 请求不得被在途读合并：它会排队等在途读落地之后再读一次（readCount 停在 2）。
    expect(readCount).toBe(2)
    releaseFirstRead?.()
    await inFlight.catch(() => {})
    await expect(send).resolves.toMatchObject({ status: 'rejected' })

    // 排队的那次 rebuild 真的跑了（第 3 次读），且乐观行已从文档消失。
    expect(readCount).toBeGreaterThanOrEqual(3)
    expect(service.runtime.getSnapshot().document?.messages).toEqual([])
    expect(service.runtime.getSnapshot().generating).toBe(false)
    service.destroy()
  })

  it('生产 appearance 命令经 Zustand adapter 写回主题权威', () => {
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [], subscribe: () => () => {} })
    try {
      service.appearance.dispatch({ type: 'set-cc-property', key: 'modelSwitchMode', value: 'cycle' })
      service.appearance.dispatch({ type: 'update-cc-placement', id: 'model', placement: { offsetX: 18 } })

      expect(useThemeStore.getState().modelSwitchMode).toBe('cycle')
      expect(useThemeStore.getState().ccLayout.placements.model.offsetX).toBe(18)
      expect(service.appearance.getSnapshot()).toMatchObject({ modelSwitchMode: 'cycle' })
    } finally {
      service.destroy()
      useThemeStore.setState(useThemeStore.getInitialState(), true)
    }
  })

  it('SQLite load 与 durable live event 归入同一个 WorkbenchDocument', async () => {
    let live: ((event: WorkbenchEventEnvelope) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [message(1, 'user', 'hello')],
      subscribe: listener => { live = listener; return () => { live = undefined } },
    })

    await service.bind(session())
    const loadedDocument = service.runtime.getSnapshot().document
    expect(loadedDocument?.messages.map(item => item.content)).toEqual(['hello'])

    live?.(message(2, 'assistant', 'world'))
    expect(service.runtime.getSnapshot().document).not.toBe(loadedDocument)
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['hello', 'world'])
    service.destroy()
  })

  it('canonical refresh 吸收绑定后到达的工具终态', async () => {
    const active = session('session-tool-refresh', 'local:tool-refresh')
    const started = createWorkbenchEnvelope({
      sessionId: active.source,
      sequence: 1,
      recordedAt: '2026-08-22T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'tool-start' },
      identity: { toolCallId: 'tool-refresh-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.started', tool: { name: 'Read', kind: 'read_file' } },
    })
    const completed = createWorkbenchEnvelope({
      sessionId: active.source,
      sequence: 2,
      recordedAt: '2026-08-22T00:00:02.000Z',
      source: { provider: 'peri', sourceId: 'tool-complete' },
      identity: { toolCallId: 'tool-refresh-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.completed', tool: { status: 'completed', rawOutput: 'ok' } },
    })
    let rows: readonly unknown[] = [started]
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => rows,
      subscribe: () => () => {},
    })

    await service.bind(active)
    expect(service.runtime.getSnapshot().document?.activities).toContainEqual(expect.objectContaining({
      id: 'tool-refresh-1', status: 'running',
    }))

    rows = [started, completed]
    await service.refresh(active)

    expect(service.runtime.getSnapshot().document?.activities).toContainEqual(expect.objectContaining({
      id: 'tool-refresh-1', status: 'completed',
    }))
    service.destroy()
  })

  it('刷新读取赢过仍在途的初始绑定读取，不被旧快照回写覆盖', async () => {
    const active = session('session-tool-refresh-race', 'local:tool-refresh-race')
    const started = createWorkbenchEnvelope({
      sessionId: active.source, sequence: 1,
      recordedAt: '2026-08-22T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'tool-start-race' },
      identity: { toolCallId: 'tool-refresh-race-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.started', tool: { name: 'Read' } },
    })
    const completed = createWorkbenchEnvelope({
      sessionId: active.source, sequence: 2,
      recordedAt: '2026-08-22T00:00:02.000Z',
      source: { provider: 'peri', sourceId: 'tool-complete-race' },
      identity: { toolCallId: 'tool-refresh-race-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.completed', tool: { status: 'completed', rawOutput: 'ok' } },
    })
    const lateMessage = createWorkbenchEnvelope({
      sessionId: active.source, sequence: 3,
      recordedAt: '2026-08-22T00:00:03.000Z',
      source: { provider: 'peri', sourceId: 'message-after-bind-read' },
      identity: { messageId: 'message-after-bind-read' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'late' }] },
    })
    let resolveInitial!: (rows: readonly unknown[]) => void
    let resolveRefresh!: (rows: readonly unknown[]) => void
    let publish: ((event: WorkbenchEventEnvelope) => void) | undefined
    let calls = 0
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: () => calls++ === 0
        ? new Promise(resolve => { resolveInitial = resolve })
        : new Promise(resolve => { resolveRefresh = resolve }),
      subscribe: listener => { publish = listener; return () => { publish = undefined } },
    })

    const binding = service.bind(active)
    await Promise.resolve()
    publish?.(lateMessage)
    const refreshing = service.refresh(active)
    resolveRefresh?.([started, completed])
    await refreshing
    resolveInitial?.([started])
    await binding

    expect(service.runtime.getSnapshot().document?.activities).toContainEqual(expect.objectContaining({
      id: 'tool-refresh-race-1', status: 'completed',
    }))
    expect(service.runtime.getSnapshot().document?.messages).toContainEqual(expect.objectContaining({
      content: 'late', role: 'assistant',
    }))
    service.destroy()
  })

  it('创建响应在 bind 前到达时仍投影模型、模式与选项到 canonical Workbench 文档', async () => {
    const active = session('created-session', 'local:created')
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: () => () => {},
    })
    service.applySessionResponse({
      sessionId: 'remote-created',
      models: {
        currentModelId: 'openrouter:deepseek-v4-flash',
        availableModels: [
          { modelId: 'openrouter:deepseek-v4-flash', name: 'DeepSeek Flash' },
          { modelId: 'openrouter:deepseek-v4-pro', name: 'DeepSeek Pro' },
        ],
      },
      modes: {
        currentModeId: 'accept_edits',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'accept_edits', name: 'Accept Edits' },
        ],
      },
    }, active.id)
    await service.bind(active)
    const document = service.runtime.getSnapshot().document
    expect(document?.session).toMatchObject({
      status: 'ready', model: 'openrouter:deepseek-v4-flash', mode: 'accept_edits',
    })
    expect(document?.session.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'model', value: 'openrouter:deepseek-v4-flash' }),
      expect.objectContaining({ id: 'mode', value: 'accept_edits' }),
    ]))
    const modelOption = document?.session.options.find(option => option.id === 'model')
    expect(modelOption?.schema).toEqual(expect.objectContaining({
      options: expect.arrayContaining([expect.objectContaining({ id: 'openrouter:deepseek-v4-pro' })]),
    }))
    service.destroy()
  })

  it('supports top-level availableModels responses and preserves the selected model list', async () => {
    const active = session('created-top-level-models', 'local:created-top-level-models')
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [], subscribe: () => () => {} })
    service.applySessionResponse({
      sessionId: 'remote-created',
      modelId: 'deepseek-v4-flash',
      availableModels: [
        { modelId: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { modelId: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      ],
    }, active.id)
    await service.bind(active)
    const option = service.runtime.getSnapshot().document?.session.options.find(item => item.id === 'model')
    expect(option?.value).toBe('deepseek-v4-flash')
    expect(option?.schema).toEqual(expect.objectContaining({
      options: expect.arrayContaining([
        expect.objectContaining({ id: 'deepseek-v4-flash' }),
        expect.objectContaining({ id: 'deepseek-v4.1-flash' }),
      ]),
    }))
    service.destroy()
  })

  it('重复投影相同创建响应不会制造重复 session 事件', async () => {
    const active = session('created-idempotent', 'local:created-idempotent')
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [], subscribe: () => () => {} })
    await service.bind(active)
    const response = {
      sessionId: 'remote-created',
      models: { currentModelId: 'm', availableModels: ['m'] },
      modes: { currentModeId: 'default', availableModes: ['default'] },
    }
    service.applySessionResponse(response, active.id)
    service.applySessionResponse(response, active.id)
    expect(service.runtime.getSnapshot().document?.timeline.filter(item => item.kind === 'session')).toHaveLength(1)
    service.destroy()
  })

  // #358：复活（load_persisted_session）响应对文档而言就是**本会话的协商事实**。此前只有建会话
  // 路径把它投影成 `session.started`，复活路径只更新会话状态 ⇒ 文档缺前提，
  // `WorkbenchDocumentSurface` 的守卫失配，回放出来的 model / mode 目录被渲染成会话下方
  // 那份「配置 / 保存 / select」持久卡片（且每次重启由 journal 回放重建）。
  it('#358 复活响应投影为 session.started 协商事实，并保留回放出来的目录', async () => {
    const active = session('revived-config', 'local:revived-config')
    const catalogue = [
      { id: 'model', name: 'model', category: 'model', type: 'select', currentValue: 'fable', options: [{ value: 'fable' }] },
      { id: 'mode', name: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default' }] },
    ]
    const replayedConfig = createCanonicalEvent({
      owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:revived-config' },
      clientGeneration: 1,
      sequence: 1,
      occurredAt: '2026-09-26T04:12:24.341Z',
      eventType: 'session.config-updated',
      payloadVersion: 1,
      rawPayload: { sessionId: 'remote-1', update: { sessionUpdate: 'config_option_update', configOptions: catalogue } },
    })
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [replayedConfig], subscribe: () => () => {} })
    await service.bind(active)
    const negotiationEntry = () => service.runtime.getSnapshot().document?.timeline
      .find(entry => entry.kind === 'session' && (entry.data as { type?: unknown } | undefined)?.type === 'session.started')
    expect(service.runtime.getSnapshot().document?.session.options.map(option => option.id)).toEqual(['model', 'mode'])
    expect(negotiationEntry()).toBeUndefined()

    service.applySessionResponse({ sessionId: 'remote-1', configOptions: catalogue }, active.id, { syntheticReason: 'session-load-response' })

    expect(negotiationEntry()).toBeDefined()
    expect((negotiationEntry()?.data as { options?: unknown[] }).options).toHaveLength(2)
    expect(service.runtime.getSnapshot().document?.session.options.map(option => option.id)).toEqual(['model', 'mode'])
    expect(service.runtime.getSnapshot().document?.session.status).toBe('ready')
    service.destroy()
  })

  // #358 遗留：**已持久化**会话（有 remote id，历史来自 journal 回放）的目录本身就是协商事实。
  // 现场：冷启动两次 session/load 都 `connection_closed`，load 响应永远不来 —— 若只把 load
  // 响应当唯一来源，卡片就会常驻。这条合成事实不带 status，不改写会话状态机。
  it('#358 已持久化会话的 bind 回放补出协商事实（不等 load 响应）', async () => {
    const persisted = { ...session('revived-fact', 'local:revived-fact'), periId: 'peri-1' }
    const catalogue = [
      { id: 'model', name: 'model', category: 'model', type: 'select', currentValue: 'fable', options: [{ value: 'fable' }] },
      { id: 'mode', name: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default' }] },
    ]
    const replayedConfig = createCanonicalEvent({
      owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:revived-fact' },
      clientGeneration: 1,
      sequence: 1,
      occurredAt: '2026-09-26T04:12:24.341Z',
      eventType: 'session.config-updated',
      payloadVersion: 1,
      rawPayload: { sessionId: 'remote-1', update: { sessionUpdate: 'config_option_update', configOptions: catalogue } },
    })
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [replayedConfig], subscribe: () => () => {} })
    await service.bind(persisted)

    const document = service.runtime.getSnapshot().document
    const negotiation = document?.timeline.find(entry => entry.kind === 'session'
      && (entry.data as { type?: unknown } | undefined)?.type === 'session.started')
    expect(negotiation).toBeDefined()
    expect((negotiation?.data as { status?: unknown }).status).toBeUndefined()
    expect((negotiation?.data as { options?: unknown[] }).options).toHaveLength(2)
    expect(document?.session.options.map(option => option.id)).toEqual(['model', 'mode'])
    service.destroy()
  })

  // 反面对照：本进程新建（尚无 remote id）的文档不补事实——「没有启动协商时普通
  // session.config-updated 保留其编辑器」这条既有契约（mountSolidWorkbench :2156）不动。
  it('#358 未持久化会话不补协商事实', async () => {
    const fresh = session('fresh-fact', 'local:fresh-fact')
    const replayedConfig = createCanonicalEvent({
      owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:fresh-fact' },
      clientGeneration: 1,
      sequence: 1,
      occurredAt: '2026-09-26T04:12:24.341Z',
      eventType: 'session.config-updated',
      payloadVersion: 1,
      rawPayload: { sessionId: 'remote-1', update: { sessionUpdate: 'config_option_update', configOptions: [
        { id: 'model', name: 'model', category: 'model', type: 'select', currentValue: 'fable', options: [{ value: 'fable' }] },
      ] } },
    })
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [replayedConfig], subscribe: () => () => {} })
    await service.bind(fresh)

    const document = service.runtime.getSnapshot().document
    expect(document?.timeline.some(entry => entry.kind === 'session'
      && (entry.data as { type?: unknown } | undefined)?.type === 'session.started')).toBe(false)
    expect(document?.session.options.map(option => option.id)).toEqual(['model'])
    service.destroy()
  })

  // #97：catalog 不被压成单项——空成功响应/空 configOptions 回声只能结束传输，
  // 不能把已投影的两项 selector catalog 替换成单项合成列表。
  it('#97 空回声响应保留已投影的 selector catalog', async () => {
    const active = session('echo-keeps-catalog', 'local:echo-keeps-catalog')
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [], subscribe: () => () => {} })
    await service.bind(active)
    service.applySessionResponse({
      sessionId: 'remote-created',
      models: {
        currentModelId: 'm1',
        availableModels: [{ modelId: 'm1', name: 'One' }, { modelId: 'm2', name: 'Two' }],
      },
    }, active.id)
    const modelOptions = () => service.runtime.getSnapshot().document?.session.options.find(item => item.id === 'model')
    // schema 是 JsonValue 联合：先收窄到对象再取 options（tsc 严格索引）。
    const schemaOptions = (): unknown => {
      const schema = modelOptions()?.schema
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
      return (schema as { readonly options?: unknown }).options
    }
    const twoChoices = expect.objectContaining({
      options: expect.arrayContaining([expect.objectContaining({ id: 'm1' }), expect.objectContaining({ id: 'm2' })]),
    })
    expect(modelOptions()?.schema).toEqual(twoChoices)
    // 评审补强：恰两项——arrayContaining 会掩盖「附加合成第三项」的劣化。
    expect(schemaOptions()).toHaveLength(2)

    // 空对象回声：document options 完整保留。
    service.applySessionResponse({}, active.id)
    expect(modelOptions()?.schema).toEqual(twoChoices)
    expect(schemaOptions()).toHaveLength(2)
    // 恒空 configOptions 回声（hermes set_config_option 形态）：同样不得清空 catalog。
    service.applySessionResponse({ configOptions: [] }, active.id)
    expect(modelOptions()?.schema).toEqual(twoChoices)
    expect(schemaOptions()).toHaveLength(2)
    service.destroy()
  })

  it('#97 权威完整列表刷新 catalog，旧 choices 不残留', async () => {
    const active = session('authoritative-refresh', 'local:authoritative-refresh')
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [], subscribe: () => () => {} })
    await service.bind(active)
    service.applySessionResponse({
      sessionId: 'remote-created',
      models: {
        currentModelId: 'm1',
        availableModels: [{ modelId: 'm1' }, { modelId: 'm2' }],
      },
    }, active.id)
    // Agent 推送新的完整模型面（旧 m1/m2 都不在）→ catalog 按权威列表整体刷新。
    service.applySessionResponse({
      models: {
        currentModelId: 'm3',
        availableModels: [{ modelId: 'm3', name: 'Three' }, { modelId: 'm4', name: 'Four' }],
      },
    }, active.id)
    const option = service.runtime.getSnapshot().document?.session.options.find(item => item.id === 'model')
    expect(option?.value).toBe('m3')
    expect(option?.schema).toEqual(expect.objectContaining({
      options: expect.arrayContaining([expect.objectContaining({ id: 'm3' }), expect.objectContaining({ id: 'm4' })]),
    }))
    expect(JSON.stringify(option?.schema)).not.toContain('"m1"')
    expect(JSON.stringify(option?.schema)).not.toContain('"m2"')
    service.destroy()
  })

  it('真实 schemaVersion=1 canonical SQLite 行经 normalizer 投影而非误当 Workbench envelope', async () => {
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [
        canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: 'canonical user' } }),
        canonicalRow(2, 'plan', { entries: [{ id: 'task-1', content: '接通生产计划', status: 'blocked', blockedReason: '等待输入' }] }),
      ],
      subscribe: () => () => {},
    })

    await service.bind(session())

    expect(service.runtime.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['canonical user'])
    expect(service.runtime.getSnapshot().document?.plan.entries).toEqual([
      expect.objectContaining({ id: 'task-1', content: '接通生产计划', status: 'blocked', blockedReason: '等待输入' }),
    ])
    service.destroy()
  })

  it('生产 journal 重建会折叠用户双写、聚合 chunk、settle 终态，重复 bind 不累积', async () => {
    const rows = [
      {
        ...canonicalRow(1, 'user_message_chunk', {
          content: { type: 'text', text: 'one prompt' },
          _meta: { pylonOptimisticUser: true, requestId: 'client-1' },
        }),
        provenance: { origin: 'migration', trust: 'unverified', provider: 'peri' },
      },
      {
        ...canonicalRow(2, 'user_message_chunk', { content: { type: 'text', text: 'one prompt' } }),
        provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
      },
      canonicalRow(3, 'agent_thought_chunk', { content: { type: 'text', text: 'think-' } }),
      canonicalRow(4, 'agent_thought_chunk', { content: { type: 'text', text: 'together' } }),
      canonicalRow(5, 'agent_message_chunk', { content: { type: 'text', text: 'answer-' } }),
      canonicalRow(6, 'agent_message_chunk', { content: { type: 'text', text: 'together' } }),
      canonicalRow(7, 'done'),
    ]
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => rows,
      subscribe: () => () => {},
    })

    for (let index = 0; index < 3; index += 1) {
      await service.bind(session())
      expect(service.runtime.getSnapshot().document?.messages.map(message => ({
        role: message.role, content: message.content, running: message.running,
      }))).toEqual([
        { role: 'user', content: 'one prompt', running: false },
        { role: 'reasoning', content: 'think-together', running: false },
        { role: 'assistant', content: 'answer-together', running: false },
      ])
    }
    service.destroy()
  })

  it('Session 切换后拒绝上一 owner 的迟到 load 结果', async () => {
    const pending = new Map<string, (events: readonly unknown[]) => void>()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: ownerKey => new Promise(resolve => pending.set(ownerKey, resolve)),
      subscribe: () => () => {},
    })

    const loadingA = service.bind(session('session-a', 'local:a'))
    const loadingB = service.bind(session('session-b', 'local:b'))
    pending.get(toCanonicalOwnerKey({ profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }))?.([message(1, 'user', 'stale-a')])
    await loadingA
    expect(service.runtime.getSnapshot().sessionId).toBe('session-b')
    expect(service.runtime.getSnapshot().document?.messages).toEqual([])

    pending.get(toCanonicalOwnerKey({ profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:b' }))?.([message(1, 'user', 'fresh-b', 'local:b')])
    await loadingB
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['fresh-b'])
    service.destroy()
  })

  it('SQLite load 期间到达的 live event 在同一 generation 合并且保持 sequence 顺序', async () => {
    let resolveLoad: ((events: readonly unknown[]) => void) | undefined
    let live: ((event: WorkbenchEventEnvelope) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: () => new Promise(resolve => { resolveLoad = resolve }),
      subscribe: listener => { live = listener; return () => {} },
    })

    const loading = service.bind(session())
    live?.(message(2, 'assistant', 'live-second'))
    resolveLoad?.([message(1, 'user', 'loaded-first')])
    await loading

    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['loaded-first', 'live-second'])
    service.destroy()
  })

  it('畸形 journal row 不伪装成完整 ready，并留下可诊断的 degraded 状态', async () => {
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [message(1, 'user', 'valid'), { schemaVersion: 99, secretShape: true }],
      subscribe: () => () => {},
    })

    await service.bind(session())

    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['valid'])
    expect(service.runtime.getSnapshot()).toMatchObject({
      status: 'degraded',
      error: expect.stringContaining('1'),
    })
    expect(service.runtime.getSnapshot().document?.diagnostics).toContainEqual(expect.objectContaining({
      code: 'canonical.journal.malformed', level: 'error',
    }))
    service.destroy()
  })
})
