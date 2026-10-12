/**
 * #266 CC-13 刀3 · **位置键空间**（本线唯一一次数据格式放开）的守卫。
 *
 * 锁四件事（施工单 §4.1 / §4.2 / §4.3）：
 * 1. **未知键读盘保留** —— 读盘发生在插件登记**之前**，丢掉名单外的键 = 每次重启误删插件位置；
 * 2. **逐键 clamp** —— 未知键与内置件同一套范围（order 0–99 / offsetX ±48 / offsetY ±16）；
 * 3. **内置缺项补默认 + legacy `send` 别名不回归**；
 * 4. **兜底解析**（`resolveCcWidgetPlacements`）—— 插件件未落盘也得有 `order`（状态区末尾、按登记序连号），
 *    且**读盘往返**保住插件位置（= "重启后仍在"的机器判据）。
 *
 * `DEFAULT_CC_LAYOUT` 只含内置件（§4.1）：插件件的默认值**不写进它**，由读取侧算。
 */
import { describe, expect, it } from 'vitest'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT, normalizeCcLayout, type CcLayoutV3 } from '../ccLayoutState.ts'
import { resolveCcDraggableWidgetIds, resolveCcWidgetPlacements, resolveCcWidgetRoster } from '../ccWidgetRoster.ts'
import { CC_WIDGET_IDS } from '../widgetDefinitions.ts'

const layoutOf = (placements: Record<string, unknown>): Partial<CcLayoutV3> =>
  ({ version: 9, placements }) as unknown as Partial<CcLayoutV3>

describe('#266 CC-13 刀3 · 位置键空间（未知键保留 + 逐键 clamp）', () => {
  it('未知键（插件件 id）读盘保留 —— 不再"多余项忽略"', () => {
    const normalized = normalizeCcLayout(layoutOf({
      'test.plugin-alpha': { order: 8, offsetX: 5, offsetY: -2 },
      model: { order: 9, offsetX: 12, offsetY: -4 },
    }))
    expect(normalized.placements['test.plugin-alpha']).toEqual({ order: 8, offsetX: 5, offsetY: -2 })
    expect(normalized.placements.model).toEqual({ order: 9, offsetX: 12, offsetY: -4 })
    expect(normalized.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
  })

  it('未知键同过 clamp（与内置件同一套范围）', () => {
    const normalized = normalizeCcLayout(layoutOf({
      'test.plugin-alpha': { order: 999, offsetX: 999, offsetY: -999 },
      'test.plugin-beta': { order: -5, offsetX: Number.NaN, offsetY: 3.7 },
    }))
    expect(normalized.placements['test.plugin-alpha']).toEqual({ order: 99, offsetX: 48, offsetY: -16 })
    // 非有限值落 0（persist 域语言）；offsetY 不取整（与既有口径一致）
    expect(normalized.placements['test.plugin-beta']).toEqual({ order: 0, offsetX: 0, offsetY: 3.7 })
  })

  it('内置缺项补默认；DEFAULT_CC_LAYOUT 只含内置件（插件默认不写进数据）', () => {
    const normalized = normalizeCcLayout(layoutOf({ 'test.plugin-alpha': { order: 8, offsetX: 0, offsetY: 0 } }))
    for (const id of [...CC_WIDGET_IDS, 'cc-send-button']) {
      expect(normalized.placements[id], id).toEqual(DEFAULT_CC_LAYOUT.placements[id])
    }
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).toEqual([...CC_WIDGET_IDS, 'cc-send-button'])
  })

  it('legacy `send` 别名不回归：键名换、位置不动；真名在场则真名优先，且不以 `send` 为键残留', () => {
    const aliased = normalizeCcLayout(layoutOf({ send: { order: 4, offsetX: 8, offsetY: -1 } }))
    expect(aliased.placements['cc-send-button']).toEqual({ order: 4, offsetX: 8, offsetY: -1 })
    expect(Object.keys(aliased.placements)).not.toContain('send')

    const both = normalizeCcLayout(layoutOf({
      send: { order: 4, offsetX: 8, offsetY: -1 },
      'cc-send-button': { order: 1, offsetX: 2, offsetY: 3 },
    }))
    expect(both.placements['cc-send-button']).toEqual({ order: 1, offsetX: 2, offsetY: 3 })
    expect(Object.keys(both.placements)).not.toContain('send')
  })
})

describe('#266 CC-13 刀3 · 兜底解析（插件件未落盘也有位置）', () => {
  const STATUS_LANDING_IN_BUILTIN_MAX_ORDER = Math.max(
    ...Object.entries(DEFAULT_CC_LAYOUT.placements)
      .filter(([id]) => ['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint'].includes(id))
      .map(([, placement]) => placement.order),
  )

  it('插件件缺项 ⇒ 状态区末尾、按登记序连号（order 递增、offset 0/0）', () => {
    const resolved = resolveCcWidgetPlacements(DEFAULT_CC_LAYOUT, ['test.plugin-first', 'test.plugin-later'])
    expect(resolved['test.plugin-first']).toEqual({ order: STATUS_LANDING_IN_BUILTIN_MAX_ORDER + 1, offsetX: 0, offsetY: 0 })
    expect(resolved['test.plugin-later']).toEqual({ order: STATUS_LANDING_IN_BUILTIN_MAX_ORDER + 2, offsetX: 0, offsetY: 0 })
    // 内置件不受影响（逐项等于定义表默认）
    expect(resolved.model).toEqual(DEFAULT_CC_LAYOUT.placements.model)
  })

  it('落盘之后以数据为准（兜底不再覆盖用户值）', () => {
    const stored = normalizeCcLayout(layoutOf({ 'test.plugin-first': { order: 2, offsetX: 7, offsetY: 1 } }))
    const resolved = resolveCcWidgetPlacements(stored, ['test.plugin-first'])
    expect(resolved['test.plugin-first']).toEqual({ order: 2, offsetX: 7, offsetY: 1 })
  })

  it('读盘往返（= 重启）保住插件位置；未登记的键同样不被丢掉', () => {
    const written = normalizeCcLayout(layoutOf({
      'test.plugin-first': { order: 3, offsetX: -6, offsetY: 2 },
      'test.plugin-gone': { order: 8, offsetX: 0, offsetY: 0 },
    }))
    // 落盘 → 读盘（同一份数据再跑一次归一化，模拟重启时 persist merge 的那一次）
    const reloaded = normalizeCcLayout(JSON.parse(JSON.stringify(written)) as Partial<CcLayoutV3>)
    expect(reloaded.placements['test.plugin-first']).toEqual({ order: 3, offsetX: -6, offsetY: 2 })
    // ★ 幂等：再跑一次结果逐项相同（`alignThemeStructure` 每次读盘都跑）
    expect(reloaded).toEqual(normalizeCcLayout(reloaded))
  })

  it('可拖件序：内置表序在前、插件登记序在后（编辑列 / 拖动 / 碰撞障碍集同一份）', () => {
    const roster = resolveCcWidgetRoster([
      { ownerPluginId: 'test.cc', value: { id: 'test.plugin-first', label: '先登记', render: { kind: 'host-renderer', rendererKey: 'tokens' } } },
      { ownerPluginId: 'test.cc', value: { id: 'test.plugin-later', label: '后登记', render: { kind: 'host-renderer', rendererKey: 'mode' } } },
    ])
    expect(resolveCcDraggableWidgetIds(roster)).toEqual([...CC_WIDGET_IDS, 'cc-send-button', 'test.plugin-first', 'test.plugin-later'])
  })
})
