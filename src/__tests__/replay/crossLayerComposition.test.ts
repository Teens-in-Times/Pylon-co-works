/**
 * ④ 跨层组合：同一输入在多种存储形态下，三层观测量必须彼此一致。
 *
 * 这是本目录的核心。各层都有单测，但此前**没有任何测试断言整条管线彼此一致**——
 * 于是"改动会打破哪一层"只能靠猜。组合测试把这件事变成一个可定位的红点。
 *
 * 三层观测量：
 * - 投影层：`Message[]`（逐字节）
 * - 边界层：`deriveCanonicalTurnDuration` / `hasCanonicalTurnTerminal`
 * - 游标层：消费完整行集后的 cursor 位置
 *
 * 游标层曾无法接受聚合形态（聚合行的占用跨度让它判 gap），该分歧已由 ADR-0016 的跨度
 * 感知连续性判据收口：batch 行按 `seqSpan` 覆盖游标下一号推进。曾记此分歧的 it.todo
 * 已恢复为真实断言（#535）。
 */
import { describe, expect, it, vi } from 'vitest'
import { CanonicalEventCursor } from '../../infrastructure/events/canonicalEventCursor.ts'
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch.ts'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal } from '../../domains/events/canonicalTurnDuration.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'
import { COMPOSED_WIRES, OWNER_KEY, assistantRuns, boundaryOf, chunkRows } from './harness.ts'

describe('④ 跨层组合 · 同一回合的多形态三层一致', () => {
  it('投影层：逐 chunk 与聚合形态的 Message[] 逐字节相等', () => {
    const perChunk = chunkRows(COMPOSED_WIRES)
    const merged = mergeAdjacentDeltaChunks(perChunk)

    // 聚合必须真的发生，否则等价断言是空转
    expect(merged.some(row => row.eventType.endsWith('.batch'))).toBe(true)
    expect(JSON.stringify(projectMessagesFromCanonical(merged)))
      .toBe(JSON.stringify(projectMessagesFromCanonical(perChunk)))
  })

  it('组合：投影层与边界层在同一份行集上同时成立（聚合形态）', () => {
    const merged = mergeAdjacentDeltaChunks(chunkRows(COMPOSED_WIRES))

    // 投影层：正文完整且顺序落定
    expect(assistantRuns(projectMessagesFromCanonical(merged)).join('')).toContain('甲乙丙')
    // 边界层：终态存在，且能从行自身的时间戳推出时长
    expect(hasCanonicalTurnTerminal(merged)).toBe(true)
    expect(deriveCanonicalTurnDuration(merged.map(boundaryOf))).toBeDefined()
  })

  it('游标层：逐 chunk 形态可推进到最后一条 sequence', async () => {
    const rows = chunkRows(COMPOSED_WIRES)
    const cursor = new CanonicalEventCursor({ list: vi.fn() })
    const applied: number[] = []

    for (const row of rows) await cursor.accept(row, consumed => { applied.push(consumed.sequence) })

    expect(applied).toEqual(rows.map(row => row.sequence))
    expect(cursor.cursor(OWNER_KEY)).toBe(rows.length)
  })

  it('游标层：聚合形态与逐 chunk 形态推进到同一位置（无 gap）', async () => {
    const perChunk = chunkRows(COMPOSED_WIRES)
    const merged = mergeAdjacentDeltaChunks(perChunk)
    // 聚合必须真的发生，否则等价断言是空转
    expect(merged.some(row => row.eventType.endsWith('.batch'))).toBe(true)

    const perChunkCursor = new CanonicalEventCursor({ list: vi.fn() })
    for (const row of perChunk) await perChunkCursor.accept(row, () => {})

    const mergedCursor = new CanonicalEventCursor({ list: vi.fn() })
    const applied: number[] = []
    for (const row of merged) await mergedCursor.accept(row, consumed => { applied.push(consumed.sequence) })

    // ADR-0016：batch 行按 seqSpan 占用推进（applied 记的是跨度末位 sequence）
    expect(applied).toEqual(merged.map(row => row.sequence))
    expect(mergedCursor.cursor(OWNER_KEY)).toBe(perChunkCursor.cursor(OWNER_KEY))
    expect(mergedCursor.cursor(OWNER_KEY)).toBe(COMPOSED_WIRES.length)
  })
})
