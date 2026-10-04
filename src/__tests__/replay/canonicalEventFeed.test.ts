// @vitest-environment jsdom
/**
 * P52 D2：canonicalEventFeed 单元契约。
 * 锁定：kernel-committed 行经 cursor 逐条 publish 恰一次（pluginEventBus 单一
 * 发布者不变量的 feed 侧）；无 canonicalEvent 的帧直转发 kernelCommitted=false；
 * 终帧信号 done/error；source gate 前置丢弃；discard/seed 委托。
 * #439：canonical sink 自写轨与注入缝已退役，feed 只读消费 committed 行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushTask } from '../../test/solidTestHelpers.ts'

const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => handler({ payload }))
    return Promise.resolve(() => { listeners.delete(event) })
  }),
}))
// #542：兜底监听注册守卫改用 IS_TAURI（env.ts 模块级 const，import 时求值）。
// 本文件验证「注册两条广播兜底」的契约，须以 Tauri 宿主在场为前提——在
// vi.hoisted（先于所有 import 求值）注入宿主标记；裸 jsdom 下的守卫跳过
// 行为由 canonicalEventFeed.tauriGuard.test.ts 对偶覆盖。
vi.hoisted(() => {
  ;(globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } }).window!.__TAURI_INTERNALS__ = { transformCallback: (cb: unknown) => cb }
})
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn((..._args: unknown[]) => Promise.resolve({})) }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((...args: unknown[]) => invokeMock(...args))
})

import { createCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'
import { subscribePluginEvents, clearPluginEventListenersForTests } from '../../infrastructure/events/pluginEventBusHost.ts'
import type { CanonicalEventRow } from '../../domains/events/canonicalEventRow.ts'

const SOURCE = 'local:feed-unit'

function canonicalEvent(sequence: number, eventType: string, text: string): Record<string, unknown> {
  return {
    eventId: `["p1","peri","${SOURCE}"]#${sequence}`,
    profileId: 'p1', agentId: 'peri', localSessionId: SOURCE, remoteSessionId: 'remote-1',
    clientGeneration: 1, sequence,
    occurredAt: '2026-09-06T00:00:00.000Z', receivedAt: '2026-09-06T00:00:00.000Z',
    eventType, payloadVersion: 1,
    typedPayload: { text }, rawPayload: { source: SOURCE }, createdAt: 1,
  }
}

beforeEach(() => {
  listeners.clear()
  invokeMock.mockReset()
  invokeMock.mockResolvedValue({})
  clearPluginEventListenersForTests()
})

afterEach(() => {
  clearPluginEventListenersForTests()
})

describe('canonicalEventFeed（P52 D2）', () => {
  it('#155 T3：draft 只走临时 seam，正式提交再进入 canonical bus', async () => {
    const feed = createCanonicalEventFeed()
    const drafts: string[] = []
    const commits: string[] = []
    const canonical: number[] = []
    const forwards: boolean[] = []
    feed.onDraftChunk(chunk => { drafts.push(`${chunk.draftId}:${chunk.chunkIndex}`) })
    feed.onDraftCommit((_owner, draftId) => { commits.push(draftId) })
    feed.onForward(frame => { forwards.push(frame.kernelCommitted) })
    subscribePluginEvents(event => { canonical.push((event as CanonicalEventRow).sequence) })
    await feed.acceptFrame({ event: 'pylon:update', payload: {
      source: SOURCE, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'a' } },
      draftChunk: { ownerKey: `["p1","peri","${SOURCE}"]`, draftId: 'd1', chunkIndex: 0, clientGeneration: 1 },
    } })
    expect(drafts).toEqual(['d1:0'])
    expect(canonical).toEqual([])
    expect(forwards).toEqual([true])
    await feed.acceptFrame({ event: 'pylon:update', payload: {
      source: SOURCE, committedDraftId: 'd1', canonicalEvent: canonicalEvent(1, 'assistant.text.delta', 'a'),
    } })
    expect(commits).toEqual(['d1'])
    expect(canonical).toEqual([1])
  })
  it('kernel-committed 行 publish 恰一次，且转发标记 kernelCommitted=true', async () => {
    const feed = createCanonicalEventFeed()
    const published: CanonicalEventRow[] = []
    subscribePluginEvents(event => { published.push(event as CanonicalEventRow) })
    const forwards: boolean[] = []
    feed.onForward(({ kernelCommitted }) => { forwards.push(kernelCommitted) })

    await feed.acceptFrame({ event: 'pylon:user', payload: { source: SOURCE, content: 'q', canonicalEvent: canonicalEvent(1, 'user.message', 'q') } })

    expect(published).toHaveLength(1)
    expect(published[0]?.eventType).toBe('user.message')
    expect(forwards).toEqual([true])
  })

  it('无 canonicalEvent 的帧只转发不 publish，kernelCommitted=false', async () => {
    const feed = createCanonicalEventFeed()
    const published: unknown[] = []
    subscribePluginEvents(event => { published.push(event) })
    const forwards: boolean[] = []
    feed.onForward(({ kernelCommitted }) => { forwards.push(kernelCommitted) })

    await feed.acceptFrame({ event: 'pylon:update', payload: { source: SOURCE, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x' } } } })

    expect(published).toHaveLength(0)
    expect(forwards).toEqual([false])
  })

  it('gap 回填行不转发当前帧标记，经 onRecoveredRow 回传；当前行转发 kernelCommitted=true', async () => {
    const feed = createCanonicalEventFeed()
    const recovered: string[] = []
    feed.onRecoveredRow(event => { recovered.push(event.eventType) })
    const forwards: boolean[] = []
    feed.onForward(({ kernelCommitted }) => { forwards.push(kernelCommitted) })

    await feed.acceptFrame({ event: 'pylon:user', payload: { source: SOURCE, content: 'q', canonicalEvent: canonicalEvent(1, 'user.message', 'q') } })
    // sequence 1 → 3：中间缺 2，触发 evt_list 回填；批含 [seq2 回填行, seq3 当前行]
    invokeMock.mockResolvedValueOnce({ events: [canonicalEvent(2, 'assistant.text.delta', 'mid'), canonicalEvent(3, 'turn.completed', '')], nextBeforeSequence: 3 })
    await feed.acceptFrame({ event: 'pylon:done', payload: { source: SOURCE, canonicalEvent: canonicalEvent(3, 'turn.completed', '') } })

    expect(recovered).toEqual(['assistant.text.delta'])
    expect(invokeMock).toHaveBeenCalledWith('evt_list', expect.objectContaining({ ownerKey: `["p1","peri","${SOURCE}"]` }))
    // seq1 与 seq3（当前行）各转发一次且标记 true；seq2 是回填行，只走 onRecoveredRow。
    expect(forwards).toEqual([true, true])
  })

  it('终帧信号 done/error 附 source；非终帧不发射', async () => {
    const feed = createCanonicalEventFeed()
    const terminals: Array<{ source?: string; kind: string }> = []
    feed.onTerminal(signal => { terminals.push({ source: signal.source, kind: signal.kind }) })

    await feed.acceptFrame({ event: 'pylon:update', payload: { source: SOURCE } })
    await feed.acceptFrame({ event: 'pylon:done', payload: { source: SOURCE } })
    await feed.acceptFrame({ event: 'pylon:error', payload: { source: SOURCE, error: 'boom' } })

    expect(terminals).toEqual([
      { source: SOURCE, kind: 'done' },
      { source: SOURCE, kind: 'error' },
    ])
  })

  it('source gate 拒绝的帧整帧丢弃（不 cursor、不 publish、不转发）', async () => {
    const feed = createCanonicalEventFeed()
    feed.setSourceGate(source => source === SOURCE)
    const published: unknown[] = []
    subscribePluginEvents(event => { published.push(event) })
    let forwarded = 0
    feed.onForward(() => { forwarded += 1 })

    await feed.acceptFrame({ event: 'pylon:user', payload: { source: 'local:unknown', content: 'q', canonicalEvent: canonicalEvent(1, 'user.message', 'q') } })

    expect(published).toHaveLength(0)
    expect(forwarded).toBe(0)
  })

  it('onCanonicalRow 回传每条已提交行（load 事务缓冲输入）', async () => {
    const feed = createCanonicalEventFeed()
    const rows: number[] = []
    feed.onCanonicalRow(event => { rows.push(event.sequence) })

    await feed.acceptFrame({ event: 'pylon:user', payload: { source: SOURCE, content: 'q', canonicalEvent: canonicalEvent(1, 'user.message', 'q') } })
    await feed.acceptFrame({ event: 'pylon:update', payload: { source: SOURCE, canonicalEvent: canonicalEvent(2, 'assistant.text.delta', 'a') } })

    expect(rows).toEqual([1, 2])
  })

  it('pylon:user 广播兜底走同一 acceptFrame 入口', async () => {
    createCanonicalEventFeed()
    // 广播注册是异步的（listen promise）；等待一拍
    await flushTask()
    const handler = listeners.get('pylon:user')
    expect(handler).toBeDefined()
  })

  it('#310：pylon:update 广播兜底把助手正文帧送进 plugin bus（未注册 Channel 的发送路径）', async () => {
    const feed = createCanonicalEventFeed()
    await flushTask()
    const handler = listeners.get('pylon:update')
    expect(handler).toBeDefined()
    // 已 seed 到 2：sequence 3 不是 gap，走正常 publish 路径
    feed.seed(`["p1","peri","${SOURCE}"]`, 2)
    const published: CanonicalEventRow[] = []
    subscribePluginEvents(event => { published.push(event as CanonicalEventRow) })

    // 后端对未注册 per-source Channel 的来源改走窗口广播（与 Channel 互斥）：
    // 这一帧此前没有任何订阅者，实时投影整段收不到助手正文。
    handler!({ source: SOURCE, canonicalEvent: canonicalEvent(3, 'assistant.text.delta', 'a') })
    await flushTask()

    expect(published.map(event => event.sequence)).toEqual([3])
  })

  it('discard 与 seed 委托 cursor（seed 只增）', async () => {
    const feed = createCanonicalEventFeed()
    feed.seed(`["p1","peri","${SOURCE}"]`, 5)
    // 已 seed 到 5：sequence 2 的行是旧消息，直接去重丢弃（无 publish）
    const published: unknown[] = []
    subscribePluginEvents(event => { published.push(event) })
    await feed.acceptFrame({ event: 'pylon:user', payload: { source: SOURCE, content: 'q', canonicalEvent: canonicalEvent(2, 'user.message', 'q') } })
    expect(published).toHaveLength(0)
    feed.discard(`["p1","peri","${SOURCE}"]`)
    // discard 后 cursor 归零：同一行重新按 sequence 1 起算会 gap（回填 evt_list）
    invokeMock.mockResolvedValueOnce({ events: [canonicalEvent(2, 'user.message', 'q')], nextBeforeSequence: 3 })
    await feed.acceptFrame({ event: 'pylon:user', payload: { source: SOURCE, content: 'q', canonicalEvent: canonicalEvent(2, 'user.message', 'q') } })
    expect(invokeMock).toHaveBeenCalledWith('evt_list', expect.objectContaining({ ownerKey: `["p1","peri","${SOURCE}"]` }))
  })
})
