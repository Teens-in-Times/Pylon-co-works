/**
 * #266 CC-13 刀4 · `ccPluginProps`（插件元件属性值的家）的纯函数锁定。
 *
 * 口径（施工单 §4.1）：
 * - **形状**：`Record<widgetId, Record<fieldKey, string | number>>`，缺省 `{}`；
 * - **归一化**：非对象整体 ⇒ `{}`；逐层兜底（非对象记录丢弃、值只留 string | number）；
 *   **保留未知 widgetId / fieldKey**（读盘不丢、撤下才清 —— 与位置表同口径）；
 * - **写入 / 清除**：值相同 / 记录不存在 ⇒ **原样返回同一个对象**（幂等，不产无谓发布）。
 */
import { describe, expect, it } from 'vitest'
import {
  clearCcPluginPropsState,
  cloneCcPluginProps,
  normalizeCcPluginProps,
  setCcPluginPropState,
} from '../ccPluginProps.ts'

describe('#266 CC-13 刀4 · ccPluginProps 归一化', () => {
  it('整体非对象（null / undefined / 数组 / 标量）⇒ 空表', () => {
    for (const raw of [null, undefined, 3, 'x', true, [], ['a']]) {
      expect(normalizeCcPluginProps(raw), `raw=${JSON.stringify(raw)}`).toEqual({})
    }
  })

  it('逐层兜底：非对象的记录整条丢弃；值只留 string | number（布尔 / null / 对象 / 数组全丢）', () => {
    const normalized = normalizeCcPluginProps({
      'test.good': { size: 18, accent: '#123456', label: 'large' },
      'test.mixed': { keep: 1, dropBool: true, dropNull: null, dropObject: { a: 1 }, dropArray: [1] },
      'test.not-a-record': 'oops',
      'test.array-record': [1, 2],
      'test.all-dropped': { a: true, b: null },
    })
    expect(normalized).toEqual({
      'test.good': { size: 18, accent: '#123456', label: 'large' },
      'test.mixed': { keep: 1 },
    })
  })

  it('非有限数字不进数据（NaN / Infinity）；过滤后为空的记录不保留（不养空壳）', () => {
    expect(normalizeCcPluginProps({
      'test.nan': { a: Number.NaN },
      'test.inf': { a: Number.POSITIVE_INFINITY, b: 2 },
    })).toEqual({ 'test.inf': { b: 2 } })
  })

  it('保留未知 widgetId / fieldKey（读盘不丢 —— 与位置表同口径）', () => {
    const raw = { 'plugin.unknown-widget': { 'whatever-key': 'v' } }
    expect(normalizeCcPluginProps(raw)).toEqual(raw)
  })

  it('幂等：连跑两次结果相同；不改入参', () => {
    const raw = { 'test.a': { size: 18, accent: '#fff' } }
    const snapshot = JSON.parse(JSON.stringify(raw))
    const once = normalizeCcPluginProps(raw)
    expect(normalizeCcPluginProps(once)).toEqual(once)
    expect(raw).toEqual(snapshot)
  })
})

describe('#266 CC-13 刀4 · ccPluginProps 写入 / 清除', () => {
  it('写入：新键落表；同值 ⇒ 原样返回同一个对象（幂等）；只动那一个元件', () => {
    const base = { 'test.a': { size: 18 }, 'test.b': { size: 9 } }
    const written = setCcPluginPropState(base, 'test.a', 'accent', '#123456')
    expect(written).toEqual({ 'test.a': { size: 18, accent: '#123456' }, 'test.b': { size: 9 } })
    // 幂等：同值再写 ⇒ 连对象引用都不换
    expect(setCcPluginPropState(written, 'test.a', 'accent', '#123456')).toBe(written)
    // 覆盖同键（改值 ⇒ 新对象）
    const overwritten = setCcPluginPropState(written, 'test.a', 'accent', '#000000')
    expect(overwritten).not.toBe(written)
    expect(overwritten).toEqual({ 'test.a': { size: 18, accent: '#000000' }, 'test.b': { size: 9 } })
    expect(base).toEqual({ 'test.a': { size: 18 }, 'test.b': { size: 9 } })
  })

  it('写入：缺记录的元件现建；非有限数字 no-op（原样返回）', () => {
    const base = {}
    expect(setCcPluginPropState(base, 'test.new', 'size', 20)).toEqual({ 'test.new': { size: 20 } })
    expect(setCcPluginPropState(base, 'test.new', 'size', Number.NaN)).toBe(base)
    // 类型上不接受的值（运行时可能是插件侧传进来的脏值）同样 no-op
    expect(setCcPluginPropState(base, 'test.new', 'size', undefined as unknown as number)).toBe(base)
  })

  it('清除：删掉一个元件的全部值；不存在 ⇒ 原样返回同一个对象（幂等）', () => {
    const base = { 'test.a': { size: 18 }, 'test.b': { size: 9 } }
    const cleared = clearCcPluginPropsState(base, 'test.a')
    expect(cleared).toEqual({ 'test.b': { size: 9 } })
    expect(clearCcPluginPropsState(base, 'test.no-such')).toBe(base)
    expect(clearCcPluginPropsState(cleared, 'test.a')).toBe(cleared)
  })

  it('clone 是深拷贝：改副本不污染原件（快照发布用）', () => {
    const base = { 'test.a': { size: 18 } }
    const copy = cloneCcPluginProps(base)
    expect(copy).toEqual(base)
    expect(copy).not.toBe(base)
    expect(copy['test.a']).not.toBe(base['test.a'])
    copy['test.a'].size = 99
    expect(base['test.a'].size).toBe(18)
  })
})
