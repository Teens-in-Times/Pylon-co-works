import { describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  projectWorkbench,
  reduceWorkbenchEvent,
  selectActivities,
  selectInteractions, selectPendingInteractions,
  selectSessionSurface,
  selectTimeline,
  type WorkbenchDocument,
} from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, migrateWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'

const base = {
  provider: 'peri',
  sourceId: 'wire-1',
  sessionId: 'session-1',
  recordedAt: '2026-08-21T00:00:00.000Z',
} as const

function envelope(
  sequence: number,
  event: WorkbenchSemanticEvent,
  identity: WorkbenchEventEnvelope['identity'] = {},
  provenance: WorkbenchEventEnvelope['provenance'] = { origin: 'local-observed', trust: 'authoritative' },
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    ...base,
    sequence,
    source: { provider: base.provider, sourceId: `${base.sourceId}-${sequence}` },
    identity,
    provenance,
    event,
  })
}

function reduce(events: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
}

describe('WorkbenchProjector', () => {
  it('projects a migrated canonical tool event through the shared semantic vector', () => {
    const migrated = migrateWorkbenchEnvelope({ owner: { localSessionId: base.sessionId }, sequence: 1, eventType: 'tool.started', rawPayload: { tool: 'raw' }, typedPayload: { tool: { name: 'search' } } })
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    const document = projectWorkbench([migrated.value]).document
    expect(document.activities).toHaveLength(1)
    expect(document.activities[0]?.status).toBe('running')
  })

  it('projects a migrated reasoning delta as reasoning content', () => {
    const migrated = migrateWorkbenchEnvelope({ owner: { localSessionId: base.sessionId }, sequence: 1, eventType: 'assistant.reasoning.delta', rawPayload: {}, typedPayload: { text: 'thinking' } })
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    const document = projectWorkbench([migrated.value]).document
    expect(document.messages.filter(message => message.role === 'reasoning').map(message => message.content)).toContain('thinking')
  })

  it('projects a migrated plan replacement into the shared plan surface', () => {
    const migrated = migrateWorkbenchEnvelope({ owner: { localSessionId: base.sessionId }, sequence: 1, eventType: 'plan.replaced', rawPayload: {}, typedPayload: { entries: [{ id: 'step-1', content: 'Inspect', status: 'pending' }] } })
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    const document = projectWorkbench([migrated.value]).document
    expect(document.plan.entries).toHaveLength(1)
    expect(document.plan.entries[0]).toMatchObject({ id: 'step-1', content: 'Inspect' })
  })
  it('projects messages, timeline and unknown diagnostics through one pure reducer', () => {
    const events = [
      envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'question' }] }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }] }, { messageId: 'm-1' }),
      envelope(3, { type: 'event.unknown', originalType: 'future_event', summary: 'future', raw: { value: 1 }, truncated: false }),
    ]
    const document = reduce(events)
    expect(document.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'question'],
      ['assistant', 'answer'],
    ])
    expect(selectTimeline(document).map(item => item.kind)).toEqual(['message', 'message', 'unknown'])
    expect(document.diagnostics).toEqual(expect.arrayContaining([
      // #405：卡片标题给**变体名**（可读一行）；原始载荷留在诊断携带的 event 里（「事件详情」）。
      // 此前标题取 `summary`，于是未知变体在会话流里呈现为 120 字符截断的原始 JSON。
      expect.objectContaining({ code: 'event.unknown', eventId: events[2].eventId, message: '未识别的 future_event 事件' }),
    ]))
    expect(document.diagnostics.find(item => item.code === 'event.unknown')?.data).toMatchObject({
      type: 'event.unknown', originalType: 'future_event', raw: { value: 1 },
    })
  })

  it('is idempotent for duplicate event ids and keeps tool orphan relation until parent arrives', () => {
    const toolUpdate = envelope(2, {
      type: 'tool.progress',
      tool: { toolCallId: 'tool-1', name: 'read', semanticKind: 'tool.read', parentActivityId: 'parent-1', status: 'completed' },
    }, { toolCallId: 'tool-1' })
    const duplicate = reduceWorkbenchEvent(reduceWorkbenchEvent(createWorkbenchDocument(base.sessionId), toolUpdate), toolUpdate)
    expect(duplicate.appliedEventIds).toEqual([toolUpdate.eventId])
    expect(selectActivities(duplicate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', parentId: 'parent-1', semanticKind: 'tool.read', orphan: true }),
    ]))

    const parent = envelope(3, { type: 'activity.started', activityId: 'parent-1', activity: { title: 'parent' } }, { taskId: 'parent-1' })
    const attached = reduce([toolUpdate, parent])
    expect(selectActivities(attached)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', parentId: 'parent-1', orphan: false }),
    ]))
  })

  it('P57 S2-R1e：批量回放与逐事件折叠等价，appliedEventIds 形状不变（Set 预去重）', () => {
    const events = Array.from({ length: 60 }, (_, index) => envelope(index + 1, {
      type: 'message.delta',
      role: 'assistant',
      parts: [{ kind: 'text', text: `chunk-${index} ` }],
    }, { messageId: 'm-1' }))
    // 批内重复事件（同 eventId）必须只折叠一次
    const batch = [...events, events[10]!, events[40]!]

    const batched = projectWorkbench(batch).document
    const folded = batch.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))

    expect(batched.appliedEventIds).toEqual(folded.appliedEventIds)
    expect(Object.isFrozen(batched.appliedEventIds)).toBe(true)
    expect(batched.messages).toEqual(folded.messages)
    expect(selectTimeline(batched)).toEqual(selectTimeline(folded))
    expect(batched.appliedEventIds).toHaveLength(60)

    // 以批量结果为 initialDocument 重放同批事件：全部命中预去重，无新增
    const replayed = projectWorkbench(batch, { initialDocument: batched }).document
    expect(replayed.appliedEventIds).toEqual(batched.appliedEventIds)
    expect(selectTimeline(replayed)).toEqual(selectTimeline(batched))
  })

  it('P57 S2-R1a：refreshOrphans 无 orphan 变化时恒等返回输入 document', () => {
    const toolUpdate = envelope(1, {
      type: 'tool.progress',
      tool: { toolCallId: 'tool-orphan', name: 'read', semanticKind: 'tool.read', parentActivityId: 'parent-x' },
    }, { toolCallId: 'tool-orphan' })
    const first = reduceWorkbenchEvent(createWorkbenchDocument(base.sessionId), toolUpdate)
    const orphaned = first.activities.find(activity => activity.id === 'tool-orphan')
    expect(orphaned).toMatchObject({ orphan: true })

    // 重放同一事件被 id 去重直接返回；这里验证 orphan 已稳定后再次折叠无副作用：
    // 用未去重的新事件触发 refreshOrphans，orphan 不变 → activities 引用保持。
    const noise = envelope(2, { type: 'usage.updated', usage: { inputTokens: 3 } })
    const after = reduceWorkbenchEvent(first, noise)
    expect(after.activities).toBe(first.activities)
    expect(after).not.toBe(first)

    // parent 到达 → orphan 翻转 → 才克隆
    const parent = envelope(3, { type: 'activity.started', activityId: 'parent-x', activity: { title: 'parent' } }, { taskId: 'parent-x' })
    const attached = reduceWorkbenchEvent(after, parent)
    expect(attached.activities).not.toBe(after.activities)
    expect(attached.activities.find(activity => activity.id === 'tool-orphan')).toMatchObject({ orphan: false })
  })

  it('resolves interactions, session state and turn failure deterministically', () => {
    const events = [
      envelope(1, { type: 'interaction.requested', interactionId: 'ask-1', request: { question: 'continue?' } }, { interactionId: 'ask-1' }),
      envelope(2, { type: 'session.commands-updated', commands: [{ name: '/compact' }] }),
      envelope(3, { type: 'usage.updated', usage: { inputTokens: 4 } }),
      envelope(4, { type: 'diagnostic.notice', level: 'error', message: 'failed', code: 'turn.failed' }),
      envelope(5, { type: 'interaction.resolved', interactionId: 'ask-1', response: { answer: 'yes' } }, { interactionId: 'ask-1' }),
    ]
    const document = reduce(events)
    // C11 语义升级：selectInteractions 返回全量（resolved 仍可审计）；待处理队列为空
    expect(selectInteractions(document)).toHaveLength(1)
    expect(selectInteractions(document)[0]).toMatchObject({ id: 'ask-1', status: 'resolved' })
    expect(selectPendingInteractions(document)).toEqual([])
    expect(selectSessionSurface(document)).toMatchObject({ commands: [{ name: '/compact' }], usage: { inputTokens: 4 } })
    expect(document.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'turn.failed', level: 'error' }),
    ]))
  })

  // 「turn failure / provider.error 终态 settle」两用例已归并至 workbenchProjectorLifecycle.test.ts

  it('live 与 restart provenance 投影同文档；recovery-import 内容相同但按已沉淀处理', () => {
    const live = envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'same' }] })
    const restart = envelope(1, live.event, live.identity, { origin: 'migration', trust: 'unverified' })
    const recovery = envelope(1, live.event, live.identity, { origin: 'recovery-import', trust: 'unverified', provider: 'peri', importId: 'import-1' })
    expect(projectWorkbench([live]).document).toEqual(projectWorkbench([restart]).document)
    // #200：provenance 不改变消息内容/身份/分段——但 recovery-import 是
    // session/load 的历史导入（历史无「在途」语义），running 必须按已沉淀处理，
    // 否则导入历史永久「仍在等待后端响应」并阻塞发送队列。
    const liveMessages = projectWorkbench([live]).document.messages
    const recoveryMessages = projectWorkbench([recovery]).document.messages
    expect(recoveryMessages).toEqual(liveMessages.map(message => ({ ...message, running: false })))
    expect(recoveryMessages[0]?.running).toBe(false)
  })

  it('sorts journal sequence deterministically while identity events may arrive out of order', () => {
    const first = envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'a' }] })
    const second = envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'b' }] })
    expect(projectWorkbench([second, first]).document).toEqual(projectWorkbench([first, second]).document)
  })

  it('aggregates contiguous same-role chunks when the provider omits message identity', () => {
    const first = envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'first' }] })
    const second = envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'second' }] })
    expect(projectWorkbench([first, second]).document.messages.map(message => message.content)).toEqual(['firstsecond'])
  })

  it('aggregates contiguous identity-less user chunks into one prompt row', () => {
    const first = envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'first' }] })
    const second = envelope(2, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'second' }] })
    expect(projectWorkbench([first, second]).document.messages.map(message => message.content)).toEqual(['firstsecond'])
  })

  it('aggregates one assistant stream when the provider rotates identity on every chunk', () => {
    const chunks = [
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '这' }] }, { messageId: 'chunk-1' }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '是' }] }, { messageId: 'chunk-2' }),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: ' complete' }] }, { messageId: 'chunk-3' }),
      envelope(4, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: ' answer' }] }, { messageId: 'chunk-4' }),
    ]

    const document = projectWorkbench(chunks).document
    expect(document.messages.map(message => message.content))
      .toEqual(['这是 complete answer'])
    expect(document.messages[0].parts).toEqual([{ kind: 'text', text: '这是 complete answer' }])
  })

  it.each([
    [{ messageId: 'first' }, { messageId: 'second' }],
    [{ messageId: 'same' }, { messageId: 'same' }],
    [{}, {}],
  ])('opens an explicitly started message after completion without concatenating complete texts (%j, %j)', (firstIdentity, secondIdentity) => {
    const firstText = '```ts\nconst state = "completed"\n```'
    const secondText = 'The following paragraph belongs to another message.\nIt keeps its newline.'
    const events = [
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'markdown', text: firstText }] }, firstIdentity),
      envelope(2, { type: 'message.completed', role: 'assistant', parts: [] }, firstIdentity),
      envelope(3, { type: 'message.started', role: 'assistant', parts: [] }, secondIdentity),
      envelope(4, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'markdown', text: secondText }] }, secondIdentity),
      envelope(5, { type: 'message.completed', role: 'assistant', parts: [] }, secondIdentity),
    ]
    for (const document of [reduce(events), projectWorkbench(events).document]) {
      expect(document.messages.map(message => message.content)).toEqual([firstText, secondText])
      expect(document.messages.map(message => message.parts)).toEqual([
        [{ kind: 'markdown', text: firstText }], [{ kind: 'markdown', text: secondText }],
      ])
      expect(document.messages.every(message => !message.running)).toBe(true)
      expect(new Set(document.messages.map(message => message.segmentId)).size).toBe(2)
    }
  })

  it('keeps assistant streams separated across a tool boundary even when identity is reused', () => {
    const document = reduce([
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'before tool' }] }, { messageId: 'turn-message' }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, { toolCallId: 'tool-1' }),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'after tool' }] }, { messageId: 'turn-message' }),
    ])

    expect(document.messages.filter(message => message.role === 'assistant').map(message => message.content))
      .toEqual(['before tool', 'after tool'])
    expect(new Set(document.messages.map(message => message.id)).size).toBe(document.messages.length)
    expect(new Set(document.messages.map(message => message.segmentId)).size).toBe(document.messages.length)
  })

  it('uses segment identity rather than a shared provider turn identity for render rows', () => {
    const document = reduce([
      envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'question' }] }, { turnId: 'turn-1' }),
      envelope(2, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'thinking' }] }, { turnId: 'turn-1' }),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }] }, { turnId: 'turn-1' }),
    ])

    expect(document.messages.map(message => message.identity.turnId)).toEqual(['turn-1', 'turn-1', 'turn-1'])
    expect(new Set(document.messages.map(message => message.id)).size).toBe(3)
    expect(new Set(document.messages.map(message => message.segmentId)).size).toBe(3)
    expect(document.messages.every(message => message.id.startsWith(`${base.sessionId}:`))).toBe(true)
  })

  it('keeps assistant and reasoning streams open across non-boundary side-channel events', () => {
    const document = reduce([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'think-' }] }, { messageId: 'reasoning-a' }),
      envelope(2, { type: 'usage.updated', usage: { inputTokens: 1 } }),
      envelope(3, { type: 'plan.replaced', entries: [] }),
      envelope(4, { type: 'diagnostic.notice', level: 'info', message: 'notice' }),
      envelope(5, { type: 'activity.progress', activityId: 'background-1', patch: { status: 'running' } }),
      envelope(6, { type: 'extension.event', kind: 'vendor.progress', payload: {}, fallback: [] }),
      envelope(7, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'together' }] }, { messageId: 'reasoning-b' }),
      envelope(8, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer-' }] }, { messageId: 'assistant-a' }),
      envelope(9, { type: 'usage.updated', usage: { outputTokens: 1 } }),
      envelope(10, { type: 'plan.replaced', entries: [] }),
      envelope(11, { type: 'diagnostic.notice', level: 'info', message: 'another notice' }),
      envelope(12, { type: 'activity.progress', activityId: 'background-1', patch: { status: 'running' } }),
      envelope(13, { type: 'extension.event', kind: 'vendor.progress', payload: {}, fallback: [] }),
      envelope(14, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'together' }] }, { messageId: 'assistant-b' }),
    ])

    expect(document.messages.map(message => [message.role, message.content])).toEqual([
      ['reasoning', 'think-together'],
      ['assistant', 'answer-together'],
    ])
  })

  it('uses an empty late terminal event to settle the existing segment without creating an empty row', () => {
    const document = reduce([
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'I will inspect' }] }, { messageId: 'message-1' }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, { toolCallId: 'tool-1' }),
      envelope(3, { type: 'message.completed', role: 'assistant', parts: [] }, { messageId: 'message-1' }),
    ])

    expect(document.messages).toHaveLength(1)
    expect(document.messages[0]).toMatchObject({ content: 'I will inspect', running: false })
  })

  it('does not split or settle a new assistant stream when an older tool terminal arrives late', () => {
    const document = reduce([
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'before tool' }] }, { messageId: 'shared' }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, { toolCallId: 'tool-1' }),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'after ' }] }, { messageId: 'shared' }),
      envelope(4, { type: 'tool.completed', tool: { toolCallId: 'tool-1', status: 'completed' } }, { toolCallId: 'tool-1' }),
      envelope(5, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'completion' }] }, { messageId: 'shared' }),
    ])

    expect(document.messages.map(message => [message.content, message.running])).toEqual([
      ['before tool', false],
      ['after completion', true],
    ])
  })

  it('keeps identity-less chunks separated across a tool boundary', () => {
    const document = reduce([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'before tool' }] }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, { toolCallId: 'tool-1' }),
      envelope(3, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'after tool' }] }),
    ])
    expect(document.messages.filter(message => message.role === 'reasoning').map(message => message.content))
      .toEqual(['before tool', 'after tool'])
  })

  it('settles every running message when the session completes', () => {
    const document = reduce([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'thinking' }] }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }] }),
      envelope(3, { type: 'session.completed', stopReason: 'end_turn' }),
    ])
    expect(document.messages.map(message => message.running)).toEqual([false, false])
  })

  it('settles superseded text segments as soon as a semantic boundary starts', () => {
    const document = reduce([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'thinking' }] }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer before tool' }] }),
      envelope(3, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, { toolCallId: 'tool-1' }),
    ])

    expect(document.messages.map(message => [message.role, message.running])).toEqual([
      ['reasoning', false],
      ['assistant', false],
    ])
  })

  it('folds adjacent optimistic and authoritative copies of the same user message', () => {
    const optimistic = envelope(
      1,
      { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'one prompt' }] },
      { interactionId: 'client-1' },
      { origin: 'optimistic-local', trust: 'unverified' },
    )
    const authoritative = envelope(
      2,
      { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'one prompt' }] },
      {},
      { origin: 'local-observed', trust: 'authoritative' },
    )
    const messages = projectWorkbench([optimistic, authoritative]).document.messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: `${base.sessionId}:${authoritative.eventId}`,
      segmentId: authoritative.eventId,
      content: 'one prompt',
      identity: {},
    })
  })

  it('folds a late optimistic append by request identity even after assistant chunks won the persistence race', () => {
    const authoritative = envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'prompt' }] }, { interactionId: 'client-late' })
    const assistant = envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }] })
    const optimistic = envelope(3,
      { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'prompt' }] },
      { interactionId: 'client-late' }, { origin: 'optimistic-local', trust: 'unverified' })
    expect(projectWorkbench([authoritative, assistant, optimistic]).document.messages.map(message => message.content))
      .toEqual(['prompt', 'answer'])
  })

  it('does not suppress a new optimistic prompt merely because old history has identical text', () => {
    const document = reduce([
      envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'continue' }] }),
      envelope(2, { type: 'message.completed', role: 'assistant', parts: [{ kind: 'text', text: 'old answer' }] }),
      envelope(3, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'continue' }] }, { interactionId: 'new-request' }, { origin: 'optimistic-local', trust: 'unverified' }),
    ])

    expect(document.messages.map(message => message.content)).toEqual(['continue', 'old answer', 'continue'])
    expect(document.messages.at(-1)?.optimistic).toBe(true)
  })
})

// #446：diagnostics 无上限收敛——同码计数环 / 条目环 / data 字节预算，error 级豁免。
describe('#446 diagnostics 环', () => {
  const notice = (sequence: number, code: string, message = `notice ${sequence}`, level: 'info' | 'warning' | 'error' = 'info') =>
    envelope(sequence, { type: 'diagnostic.notice', level, message, code })

  it('同 code 同 message 的非 error notice 合并为一条 count=2（刷新到最新事件，保留首条 message）', () => {
    const first = notice(1, 'usage.invalid-field', '字段 size 非法')
    const second = notice(2, 'usage.invalid-field', '字段 size 非法')
    const document = reduce([first, second])
    expect(document.diagnostics).toHaveLength(1)
    expect(document.diagnostics[0]).toMatchObject({
      code: 'usage.invalid-field',
      message: '字段 size 非法',
      count: 2,
      eventId: second.eventId,
      sequence: 2,
    })
  })

  it('不同 message（如不同 unknown 变体名）不成环——#405 的变体名各自成卡', () => {
    const a = envelope(1, { type: 'event.unknown', originalType: 'future_event', summary: 'future', raw: { v: 1 }, truncated: false })
    const b = envelope(2, { type: 'event.unknown', originalType: 'peri.goal_snapshot', summary: 'goal', raw: { v: 2 }, truncated: false })
    const document = reduce([a, b])
    const unknowns = document.diagnostics.filter(entry => entry.code === 'event.unknown')
    expect(unknowns).toHaveLength(2)
    expect(unknowns.map(entry => entry.count)).toEqual([undefined, undefined])
  })

  it('error 级豁免计数环（逐条进 diagnostics，与 systemErrors 的收敛并行）', () => {
    const document = reduce([notice(1, 'agent.x', 'boom', 'error'), notice(2, 'agent.x', 'boom', 'error')])
    expect(document.diagnostics.filter(entry => entry.code === 'agent.x')).toHaveLength(2)
    expect(document.systemErrors.length).toBeGreaterThanOrEqual(2)
  })

  it('条目环：非 error 条目超 256 丢最旧，error 条目恒保留', () => {
    const events = [notice(1, 'agent.keep', 'boom', 'error')]
    for (let index = 0; index < 300; index += 1) events.push(notice(index + 2, `code-${index}`))
    const document = reduce(events)
    const nonError = document.diagnostics.filter(entry => entry.level !== 'error')
    expect(nonError.length).toBeLessThanOrEqual(256)
    expect(document.diagnostics.some(entry => entry.code === 'agent.keep')).toBe(true)
    // 丢的是最旧：最早的非 error 码已不在
    expect(document.diagnostics.some(entry => entry.code === 'code-0')).toBe(false)
  })

  it('data 字节预算：超 256KB 时从最旧的非 error 条目摘 data（置 dataOmitted），最新保留', () => {
    const big = 'x'.repeat(200_000)
    const first = envelope(1, { type: 'diagnostic.notice', level: 'info', message: big, code: 'big.one' })
    const second = envelope(2, { type: 'diagnostic.notice', level: 'info', message: big, code: 'big.two' })
    const document = reduce([first, second])
    const one = document.diagnostics.find(entry => entry.code === 'big.one')
    const two = document.diagnostics.find(entry => entry.code === 'big.two')
    expect(one?.dataOmitted).toBe(true)
    expect(one?.data).toBeUndefined()
    expect(two?.data).toBeDefined()
    // 摘除只动载荷：卡片语义字段仍在
    expect(one?.message).toBe(big)
  })
})

describe('#446 审查轮补锁', () => {
  const bigNotice = (sequence: number, code: string) =>
    envelope(sequence, { type: 'diagnostic.notice', level: 'info', message: 'x'.repeat(200_000), code })

  it('合并恢复 data 时剥掉 dataOmitted——不出现 data 与标记并存的违约态', () => {
    const first = bigNotice(1, 'big.ring')
    const second = bigNotice(2, 'big.ring')
    const document = reduce([first, second, envelope(3, { type: 'diagnostic.notice', level: 'info', message: 'x'.repeat(200_000), code: 'big.ring' })])
    const entry = document.diagnostics.find(item => item.code === 'big.ring')
    // 第二拍起总量超预算摘除首条 data；第三拍合并恢复 data ⇒ 标记必须消失
    expect(entry?.dataOmitted).toBeUndefined()
    expect(entry?.data).toBeDefined()
    expect(entry?.count).toBe(3)
  })

  it('不同 level（info→warning）不成环——升级证据不被首条 level 吞掉', () => {
    const info = envelope(1, { type: 'diagnostic.notice', level: 'info', message: '同形', code: 'lvl.x' })
    const warning = envelope(2, { type: 'diagnostic.notice', level: 'warning', message: '同形', code: 'lvl.x' })
    const document = reduce([info, warning])
    const rows = document.diagnostics.filter(entry => entry.code === 'lvl.x')
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.level)).toEqual(['info', 'warning'])
  })

  it('条目环淘汰保持到达序（error 不被重排到队首）', () => {
    const events = [envelope(1, { type: 'diagnostic.notice', level: 'info', message: '早期', code: 'early' })]
    for (let index = 0; index < 300; index += 1) {
      events.push(envelope(index + 2, { type: 'diagnostic.notice', level: index === 150 ? 'error' : 'info', message: `n${index}`, code: `c-${index}` }))
    }
    const document = reduce(events)
    const codes = document.diagnostics.map(entry => entry.code)
    // 幸存的是最新 256 条非 error（最旧的 early/c-0..c-43 被环丢掉），且保持到达序——
    // error 条目（c-150）留在它到达的位置，不被重排到队首
    expect(codes[0]).toBe('c-43')
    expect(codes).not.toContain('early')
    expect(codes.indexOf('c-150')).toBeGreaterThan(0)
    expect(codes.indexOf('c-150')).toBeLessThan(codes.length - 1)
  })
})
