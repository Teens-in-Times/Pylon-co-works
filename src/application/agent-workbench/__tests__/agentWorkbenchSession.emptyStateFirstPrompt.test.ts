import { describe, expect, it } from 'vitest'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import type { Session } from '../../../domains/identity/identityStore.ts'
import { toCanonicalOwnerKey } from '../../../domains/events/eventSchema.ts'
import { getCanonicalEventFeed } from '../../../infrastructure/events/canonicalEventFeed.ts'

/**
 * issue #68：冷启动 + 会话创建空态下发出首条 prompt，生成结束后聊天区**没有渲染**
 * 「处理耗时」摘要行；切到其它 sheet 再切回（触发 refresh 的 displayOnly 兜底）才出现。
 *
 * 生产时序（`ControlCenter.createEmptySession` → `commands.createSession`）：
 * `selectSession(created.sessionId)` 之后**同一 tick** 调 `send`，而 Workbench 的 bind
 * 由 Solid host 的 createEffect 触发（AgentRendererSuiteWorkbench.solid.tsx，
 * `createEffect(() => { void sessionRuntime.bind(session()) })`，内部 await loadAll）。
 * 因此发送入口运行时该会话**尚未绑定**。
 *
 * 修复前：`projectOptimisticUser` 因未绑定早退 ⇒ 无 TurnClock 起点 ⇒ 终帧
 * `turnClockTerminal` 查不到条目直接 return ⇒ 摘要永不发布。
 * 修复后：回合起点在发送入口无条件建立，终帧到达即发布摘要，无需重挂载。
 */

function session(id: string, source: string): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function canonicalRow(sequence: number, sessionUpdate: string, localSessionId: string, fields: Record<string, unknown> = {}) {
  const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId }
  return {
    schemaVersion: 1,
    eventId: `${toCanonicalOwnerKey(owner)}#${sequence}`,
    owner,
    provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
    clientGeneration: 1,
    sequence,
    occurredAt: `2026-09-13T00:00:0${sequence}.000Z`,
    receivedAt: `2026-09-13T00:00:0${sequence}.000Z`,
    eventType: sessionUpdate === 'user_message_chunk' ? 'user.message'
      : sessionUpdate === 'agent_message_chunk' ? 'assistant.text.delta'
        : sessionUpdate === 'done' ? 'turn.completed' : 'unknown',
    payloadVersion: 1,
    rawPayload: { update: { sessionUpdate, ...fields } },
  }
}

describe('empty-state first prompt publishes the terminal summary without a rebind (issue #68)', () => {
  it('publishes the completion summary on the first render after the terminal frame', async () => {
    const feed = getCanonicalEventFeed()
    let pushEvent: ((row: unknown) => void) | undefined
    const active = session('session-empty-first', 'local:empty-first')
    const service = createAgentWorkbenchSessionRuntime({
      // 新会话的首轮尚未落盘：bind 读到的 journal 为空（终态只在 live 链路里出现）。
      loadAll: async () => [],
      subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
      commands: {
        resolveSession: () => active,
        nextClientMessageId: () => 'client-empty-1',
        sendMessage: async () => {},
        optimisticUser: () => {},
        rejectOptimisticUser: () => {},
        resolvePersona: () => 'default',
        requestCancel: () => {},
      },
    })

    // ① 空态创建：会话已被 select，bind 尚未发生（Solid host 的 createEffect 首轮运行后才 bind）。
    const sent = await service.commands.send(active.id, { text: '首条消息' })
    expect(sent.status).toBe('sent')

    // ② bind 落地：journal 仍无终态，但发送入口建立的回合时钟已生效。
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // ③ live user echo + 助手流式行。
    pushEvent?.(canonicalRow(1, 'user_message_chunk', active.source, { content: { type: 'text', text: '首条消息' } }))
    pushEvent?.(canonicalRow(2, 'agent_message_chunk', active.source, { content: { type: 'text', text: '正在生成' } }))
    expect(service.runtime.getSnapshot().generating).toBe(true)
    expect(service.runtime.getSnapshot().summary).toBeNull()

    // ④ 生成结束：终帧到达即发布摘要——**没有**任何 re-bind / refresh（等价于不切 sheet）。
    // 这 5ms 是承重睡：elapsedMs = 终帧 Date.now() − 发送入口 Date.now()
    // （optimisticEcho 的 generationStart，agentWorkbenchOptimisticEcho.ts:85/122），
    // Date.now 1ms 分辨率下必须真实越过至少 1ms 才保得住 elapsedMs > 0——
    // 不能降级成纯微任务冲刷（flushTask 可落在同一毫秒内）。
    await new Promise(resolve => setTimeout(resolve, 5))
    await feed.acceptFrame({ event: 'pylon:done', payload: { source: active.source } })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({
      reason: 'done',
      durationSource: 'live-monotonic',
      durationAvailable: true,
    })
    // elapsed 从**发送入口**算起（而非 echo 或 bind 时刻），故必然大于 0。
    expect(snapshot.summary?.elapsedMs).toBeGreaterThan(0)
    service.destroy()
  })

  it('publishes the display-only summary when the terminal frame lands before bind', async () => {
    const feed = getCanonicalEventFeed()
    const active = session('session-empty-terminal-first', 'local:empty-terminal-first')
    const service = createAgentWorkbenchSessionRuntime({
      // 终帧先到、journal 随后落盘：bind 读到的 journal 已含终态行。
      loadAll: async () => [
        canonicalRow(1, 'user_message_chunk', active.source, { content: { type: 'text', text: '首条消息' } }),
        canonicalRow(2, 'done', active.source),
      ],
      subscribe: () => () => {},
      commands: {
        resolveSession: () => active,
        nextClientMessageId: () => 'client-terminal-first-1',
        sendMessage: async () => {},
        optimisticUser: () => {},
        rejectOptimisticUser: () => {},
        resolvePersona: () => 'default',
        requestCancel: () => {},
      },
    })

    // 空态发送（尚未 bind）⇒ 终帧抢先到达（此刻 source 还不是已绑定的会话）。
    const sent = await service.commands.send(active.id, { text: '首条消息' })
    expect(sent.status).toBe('sent')
    await feed.acceptFrame({ event: 'pylon:done', payload: { source: active.source } })

    // bind 完成后摘要仍必须出现（走 displayOnly 兜底，不依赖重挂载）。
    await service.bind(active)
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({
      reason: 'done',
      displayOnly: true,
      elapsedMs: 1000,
    })
    service.destroy()
  })

  it('a rejected empty-state send does not resurrect a stuck indicator after bind', async () => {
    const active = session('session-empty-rejected', 'local:empty-rejected')
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      subscribe: () => () => {},
      commands: {
        resolveSession: () => active,
        nextClientMessageId: () => 'client-rejected-1',
        sendMessage: async () => { throw new Error('provider offline') },
        optimisticUser: () => {},
        rejectOptimisticUser: () => {},
        resolvePersona: () => 'default',
        requestCancel: () => {},
      },
    })

    const sent = await service.commands.send(active.id, { text: '首条消息' })
    expect(sent.status).toBe('rejected')

    await service.bind(active)
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toBeNull()
    expect(snapshot.generationStart).toBe(0)
    service.destroy()
  })
})
