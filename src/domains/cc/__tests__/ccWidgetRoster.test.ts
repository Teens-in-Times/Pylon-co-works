import { describe, expect, it } from 'vitest'
import { resolveCcWidgetRoster, type CcWidgetRosterSourceEntry } from '../ccWidgetRoster.ts'
import { CC_WIDGET_GROUPS } from '../widgetDefinitions.ts'
import type { CcWidgetContribution } from '../../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

/**
 * #266 CC-13 刀2：**活名单合成**（纯函数）的不变量锁。
 *
 * 这三条对应施工单 §2 目标 1 与规范 §4.3：∪ 合成（表序在前）/ 冲突拒绝（不静默）/
 * 追加顺序（插件按传入序追加在表序之后）。
 */
function source(ownerPluginId: string, value: CcWidgetContribution): CcWidgetRosterSourceEntry {
  return { ownerPluginId, value }
}

const BUILTIN_IDS = CC_WIDGET_GROUPS.map(row => row.id)

describe('#266 CC-13 刀2 · 中控活名单合成（纯函数）', () => {
  it('无登记 ⇒ 活名单 = 定义表 8 行；内置件渲染约定 = host-renderer(rendererKey = id)', () => {
    const roster = resolveCcWidgetRoster([])
    expect(roster.rejected).toEqual([])
    expect(roster.entries.map(entry => entry.id)).toEqual(BUILTIN_IDS)
    expect(roster.entries.every(entry => entry.source === 'builtin')).toBe(true)
    expect(roster.entries.map(entry => entry.render)).toEqual(
      CC_WIDGET_GROUPS.map(row => ({ kind: 'host-renderer', rendererKey: row.id })),
    )
  })

  it('∪ 合成 + 追加顺序：插件件按传入序追加在表序之后，render / 标签 / 归属原样透传', () => {
    const roster = resolveCcWidgetRoster([
      source('test.plugin-a', {
        id: 'test.first',
        label: '甲件',
        category: 'test',
        render: { kind: 'host-renderer', rendererKey: 'tokens' },
      }),
      source('test.plugin-a', {
        id: 'test.second',
        label: '乙件',
        render: { kind: 'isolated-surface', surfaceId: 'test.surface' },
      }),
    ])
    expect(roster.rejected).toEqual([])
    // 表序在前（逐字等于定义表序）、插件件在后（保持传入顺序 —— 后传入在更下）
    expect(roster.entries.map(entry => entry.id)).toEqual([...BUILTIN_IDS, 'test.first', 'test.second'])
    expect(roster.entries.at(-2)).toEqual({
      id: 'test.first',
      label: '甲件',
      category: 'test',
      source: 'plugin',
      render: { kind: 'host-renderer', rendererKey: 'tokens' },
      ownerPluginId: 'test.plugin-a',
    })
    expect(roster.entries.at(-1)).toEqual({
      id: 'test.second',
      label: '乙件',
      source: 'plugin',
      render: { kind: 'isolated-surface', surfaceId: 'test.surface' },
      ownerPluginId: 'test.plugin-a',
    })
  })

  it('冲突拒绝：插件用内置 id ⇒ 该登记被拒（不静默、不进名单），内置件逐行不受影响', () => {
    const baseline = resolveCcWidgetRoster([])
    const roster = resolveCcWidgetRoster([
      source('test.plugin-b', { id: 'input', label: '假输入栏', render: { kind: 'host-renderer', rendererKey: 'tokens' } }),
      source('test.plugin-b', { id: 'test.kept', label: '合法件', render: { kind: 'host-renderer', rendererKey: 'tokens' } }),
    ])
    expect(roster.rejected).toEqual([{ id: 'input', ownerPluginId: 'test.plugin-b', reason: 'id-collision' }])
    // 合法件照常进入；被拒的那条一个字节都不进名单
    expect(roster.entries.map(entry => entry.id)).toEqual([...BUILTIN_IDS, 'test.kept'])
    // 内置件行与"无登记"时逐行相同（被拒登记不改写内置行）
    expect(roster.entries.slice(0, BUILTIN_IDS.length)).toEqual(baseline.entries)
  })

  it('缺渲染声明的登记被拒（不静默）：reason = missing-render', () => {
    const roster = resolveCcWidgetRoster([
      source('test.plugin-c', { id: 'test.no-render', label: '没有画法的件' }),
    ])
    expect(roster.rejected).toEqual([{ id: 'test.no-render', ownerPluginId: 'test.plugin-c', reason: 'missing-render' }])
    expect(roster.entries.map(entry => entry.id)).toEqual(BUILTIN_IDS)
  })
})
