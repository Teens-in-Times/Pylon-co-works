/**
 * #445：searchAllMessagesTauri 命中行两阶段搜索测试。
 * - 阶段 1 后端命中行 → 阶段 2 定向单行 compact 读（不再候选 owner 全量拉流）
 * - 同一单元覆盖的多个命中序列去重为一次拉行（按回读行 sequence 去重）
 * - 投影复核剔除：后端命中但投影文本不含查询词的行不出结果（漏配对消除）
 * - 达上限截断；turn.unit 命中经 compact 拉回后投影展开段文本
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((...args: unknown[]) => invokeMock(...args))
})

const sessionsRef: { current: unknown[] } = { current: [] }
vi.mock('../../identity/identityStore.ts', () => ({
  useIdentityStore: { getState: () => ({ sessions: sessionsRef.current }) },
}))

const repoRef: {
  current: {
    searchHits: ReturnType<typeof vi.fn>
    listCompact: ReturnType<typeof vi.fn>
    loadAllPreferUnits: ReturnType<typeof vi.fn>
  }
} = { current: { searchHits: vi.fn(), listCompact: vi.fn(), loadAllPreferUnits: vi.fn() } }
vi.mock('../../../infrastructure/events/canonicalEventRepository.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../infrastructure/events/canonicalEventRepository.ts')>()
  return { ...actual, tauriCanonicalEventRepository: () => repoRef.current }
})

import type { Session } from '../../identity/identityStore.ts'
import type { CanonicalEventRow } from '../../../domains/events/canonicalEventRow.ts'
import { searchAllMessagesTauri } from '../searchService.ts'

const OWNER_KEY = '["p1","peri","local:a"]'

function session(id: string, source = 'local:a'): Session {
  return { id, profileId: 'p1', agentId: 'peri', source } as unknown as Session
}

function row(sequence: number, eventType: string, rawPayload: unknown, typedPayload?: unknown): CanonicalEventRow {
  return {
    eventId: `${OWNER_KEY}#${sequence}`,
    owner: { profileId: 'p1', agentId: 'peri', localSessionId: 'local:a' },
    clientGeneration: 1,
    sequence,
    occurredAt: '2026-08-14T00:00:00.000Z',
    receivedAt: '2026-08-14T00:00:00.000Z',
    eventType,
    payloadVersion: 1,
    rawPayload,
    ...(typedPayload !== undefined ? { typedPayload } : {}),
  } as unknown as CanonicalEventRow
}

function hit(sequence: number, localSessionId = 'local:a') {
  return {
    profileId: 'p1',
    agentId: 'peri',
    localSessionId,
    remoteSessionId: 'remote-1',
    sequence,
    eventType: 'user.message',
    occurredAt: '2026-08-14T00:00:00.000Z',
    matchOffset: 10,
  }
}

/** 单条命中页：evt_load_compact 的 limit 1 页。 */
function singlePage(eventRow: CanonicalEventRow) {
  return { events: [eventRow], nextAfterSequence: null }
}

describe('searchAllMessagesTauri（#445 命中行两阶段）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    repoRef.current.searchHits = vi.fn()
    repoRef.current.listCompact = vi.fn()
    repoRef.current.loadAllPreferUnits = vi.fn()
    sessionsRef.current = [session('s1')]
  })

  it('命中行走定向单行 compact 读，不触发全量 loadAllPreferUnits', async () => {
    repoRef.current.searchHits.mockResolvedValue([hit(3)])
    repoRef.current.listCompact.mockResolvedValue(
      singlePage(row(3, 'user.message', { text: 'hello needle world' }, { text: 'hello needle world' })),
    )

    const { results, truncated } = await searchAllMessagesTauri('needle')

    expect(repoRef.current.searchHits).toHaveBeenCalledWith('needle', 50)
    expect(repoRef.current.listCompact).toHaveBeenCalledWith(OWNER_KEY, 2, 1)
    expect(repoRef.current.loadAllPreferUnits).not.toHaveBeenCalled()
    expect(truncated).toBe(false)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      sessionId: 's1',
      messageId: 'user-1',
      agentId: 'peri',
      snippet: 'hello needle world',
      // timeOf = toLocaleTimeString()（locale/时区敏感），期望按同一变换动态推导。
      time: new Date('2026-08-14T00:00:00.000Z').toLocaleTimeString(),
    })
  })

  it('同一单元覆盖的多个命中序列按回读行 sequence 去重为一次投影', async () => {
    repoRef.current.searchHits.mockResolvedValue([hit(10), hit(12)])
    repoRef.current.listCompact.mockImplementation(
      async (_ownerKey: string, afterSequence: number | null) => {
        // 两个命中位置都被同一单元（行 sequence 15）覆盖：compact 语义回读同一行。
        void afterSequence
        return singlePage(row(15, 'user.message', { text: 'needle in unit' }, { text: 'needle in unit' }))
      },
    )

    const { results } = await searchAllMessagesTauri('needle')

    expect(repoRef.current.listCompact).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(1)
    expect(results[0].messageId).toBe('user-1')
  })

  it('后端命中但投影文本不含查询词 → 复核剔除（漏配对消除）', async () => {
    repoRef.current.searchHits.mockResolvedValue([hit(3)])
    repoRef.current.listCompact.mockResolvedValue(
      singlePage(row(3, 'user.message', { text: 'totally unrelated' }, { text: 'totally unrelated' })),
    )

    const { results, truncated } = await searchAllMessagesTauri('needle')

    expect(results).toEqual([])
    expect(truncated).toBe(false)
  })

  it('owner 不在 identityStore → 不拉行不产出', async () => {
    repoRef.current.searchHits.mockResolvedValue([hit(3, 'local:ghost')])

    const { results } = await searchAllMessagesTauri('needle')

    expect(repoRef.current.listCompact).not.toHaveBeenCalled()
    expect(results).toEqual([])
  })

  it('达 BACKEND_SEARCH_LIMIT 截断', async () => {
    const hits = Array.from({ length: 50 }, (_, index) => hit(index + 1))
    repoRef.current.searchHits.mockResolvedValue(hits)
    repoRef.current.listCompact.mockImplementation(
      async (_ownerKey: string, afterSequence: number | null) =>
        singlePage(row((afterSequence ?? 0) + 1, 'user.message', { text: `needle ${afterSequence}` }, { text: `needle ${afterSequence}` })),
    )

    const { results, truncated } = await searchAllMessagesTauri('needle')

    expect(results).toHaveLength(50)
    expect(truncated).toBe(true)
  })

  it('turn.unit 命中：compact 拉回单元行，投影展开段文本后复核出 snippet', async () => {
    repoRef.current.searchHits.mockResolvedValue([hit(10)])
    const unitRow = row(15, 'turn.unit', { kind: 'turn-unit' }, {
      seqStart: 8,
      seqEnd: 12,
      foldedCount: 5,
      // 实值对齐后端 turn_rollup.rs 常量（parse 读侧刻意不校验方案字符串，但
      // 夹具不忠实会误导照抄者）。
      aggregateKind: 'turn-rollup',
      foldScheme: 'adjacent-delta-fold-v2',
      contentSha256: 'a'.repeat(64),
      terminal: { eventType: 'turn.completed', occurredAt: '2026-08-14T00:00:05.000Z' },
      segments: [{
        kind: 'delta-run',
        eventType: 'assistant.text.delta',
        seqStart: 8,
        seqEnd: 12,
        text: 'the needle text inside unit',
        occurredAt: '2026-08-14T00:00:01.000Z',
        markdown: false,
      }],
    })
    repoRef.current.listCompact.mockResolvedValue(singlePage(unitRow))

    const { results } = await searchAllMessagesTauri('needle')

    expect(repoRef.current.listCompact).toHaveBeenCalledWith(OWNER_KEY, 9, 1)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      messageId: 'msg-1',
      snippet: 'the needle text inside unit',
    })
  })

  it('搜索失败传递给页面的错误与重试状态', async () => {
    repoRef.current.searchHits.mockRejectedValue(new Error('evt_search failed'))

    await expect(searchAllMessagesTauri('needle')).rejects.toThrow('evt_search failed')
    expect(repoRef.current.listCompact).not.toHaveBeenCalled()
  })

  it('命中行读取失败不伪装成完整结果', async () => {
    repoRef.current.searchHits.mockResolvedValue([hit(3), hit(7)])
    repoRef.current.listCompact.mockImplementation(
      async (_ownerKey: string, afterSequence: number | null) => {
        if (afterSequence === 2) throw new Error('evt_load_compact failed')
        return singlePage(row(7, 'user.message', { text: 'needle on row seven' }, { text: 'needle on row seven' }))
      },
    )

    await expect(searchAllMessagesTauri('needle')).rejects.toThrow('evt_load_compact failed')
    expect(repoRef.current.listCompact).toHaveBeenCalledTimes(2)
  })
})
