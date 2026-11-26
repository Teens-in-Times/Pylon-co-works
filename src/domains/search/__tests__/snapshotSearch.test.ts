// 迁移自 scripts/test-snapshot-search.mts（P91 A1）。
// 按点名清单 A.14 处置只迁纯函数断言：envelope/裸数组解析、大小写不敏感匹配、
// 损坏快照容错、空查询无结果、扫描上限截断（W3-03）。原脚本对 SearchSheetView.tsx
// 与 builtinWorkspacePlugins.ts 的源码正则接线段不迁——已被 integration 行为测试锁
// （处置行点名「接线已被 integration 锁」）。
import { describe, expect, it } from 'vitest'
import { isMessageSnapshotKey, parseMessageSnapshotRaw, snapshotSearch, SNAPSHOT_SCAN_LIMIT } from '../snapshotSearch.ts'

describe('snapshotSearch 纯搜索（原 test-snapshot-search.mts §1，W3-03）', () => {
  it('envelope/裸数组都解析；匹配大小写不敏感；损坏快照不崩；空查询无结果', () => {
    const raw: Record<string, string> = {
      'pylon-msgs-s1': JSON.stringify({ version: 1, messages: [{ id: 'm1', content: '你好世界', time: '12:00' }, { id: 'm2', content: 'hello world' }] }),
      'pylon-msgs-s2': JSON.stringify([{ id: 'm3', content: 'Hello Again' }]),
      'pylon-msgs-s3': '{broken',
      'other-key': 'x',
    }
    const storage = { getItem: (key: string) => raw[key] ?? null }
    const keys = Object.keys(raw)
    const r = snapshotSearch(storage, 'hello', keys)
    expect(r.results.length).toBe(2)
    expect(r.results.some(x => x.sessionId === 's1' && x.messageId === 'm2')).toBe(true)
    expect(r.results.some(x => x.sessionId === 's2' && x.messageId === 'm3')).toBe(true)
    expect(isMessageSnapshotKey('pylon-msgs-s1')).toBe(true)
    expect(isMessageSnapshotKey('other-key')).toBe(false)
    expect(parseMessageSnapshotRaw(raw['pylon-msgs-s3'])).toEqual([])
    expect(snapshotSearch(storage, '', keys).results).toEqual([])
    expect(snapshotSearch(storage, 'zzz', keys).results).toEqual([])
  })
})

describe('snapshotSearch 命中片段与扫描上限', () => {
  it('在原文命中处截取片段，前文的大小写展开和两端的 emoji 不会截断命中', () => {
    const content = 'İ'.repeat(160) + '🎵' + 'a'.repeat(39) + 'NEEDLE' + 'b'.repeat(39) + '🎵tail'
    const storage = { getItem: () => JSON.stringify([{ id: 'm', content }]) }
    const { results } = snapshotSearch(storage, 'needle', ['pylon-msgs-s1'])
    expect(results[0]?.snippet).toBe('…🎵' + 'a'.repeat(39) + 'NEEDLE' + 'b'.repeat(39) + '🎵…')
  })

  it('超限截断并标记 truncated；SNAPSHOT_SCAN_LIMIT 纯常量', () => {
    const keys = Array.from({ length: 5 }, (_, i) => `pylon-msgs-s${i}`)
    const raw: Record<string, string> = {}
    for (const key of keys) raw[key] = JSON.stringify([{ id: 'm', content: 'needle' }])
    const r = snapshotSearch({ getItem: (key: string) => raw[key] ?? null }, 'needle', keys, { limit: 3 })
    expect(r.results.length).toBe(3)
    expect(r.truncated).toBe(true)
    expect(SNAPSHOT_SCAN_LIMIT).toBe(2000)
  })
})
