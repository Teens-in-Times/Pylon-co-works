/**
 * #266 CC-13 刀5：插件件的**尺寸声明（`sizing`）**——定形与校验 + 进「最小高 / 最小宽」算式（纯函数）。
 *
 * 锁施工单 §4.1 / §4.2 / §6 的 1、2、3、5、6：
 * 1. **报了就计**：报 height ⇒ 并入状态区组**取 max**；报 width ⇒ 并入该队列**求和**（间距 0）；
 * 2. **不报 = 下界**：没报 / 非有限 / ≤0 ⇒ 该维按 0 计 ⇒ 读数与"不登记该插件件"**逐位相同**；
 * 3. **隐藏 ⇒ 不计**（在场判据 = `isWidgetVisible`，按切面逐条过）；
 * 4. **缺省入参 ⇒ 与改造前逐位相同**（`pluginWidgets` 缺省 `[]`）；
 * 5. **非法只丢该维**：另一维照收、该件照常进名单（不丢件）+ 记 `sizingRejections`。
 *
 * 数字口径（与既有 `ccHeightState.test.ts` / `ccShowVerdict.test.ts` 同一套默认值）：
 * 下边组 = 三个触发器各 28 + `ccMarginBottom` 15 ⇒ 43；上边组 = `inputOffsetTop` 10 + 输入栏 40 ⇒ 50；
 * 宽度队列 = 120 + (120+12) + (120+12) + 0 + 0 = **384**；下界 64。
 */
import { describe, expect, it } from 'vitest'
import { ccMinHeightInputOf, resolveCcHeightGroups, resolveCcMinHeight, resolveCcMinWidth, resolveCcWidthGroups, type CcMinHeightScalars } from '../ccHeightState.ts'
import { resolveCcPluginWidgetSizings, resolveCcWidgetRoster, resolvePluginWidgetSizing, type CcWidgetRosterSourceEntry } from '../ccWidgetRoster.ts'
import type { CcWidgetContribution, CcWidgetSizing } from '../../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

const SCALARS = {
  inputOffsetTop: 10, inputHeight: 40, ccMarginBottom: 15,
  modelHeight: 28, reasoningHeight: 28, permissionHeight: 28,
}
const WIDTHS = { model: 120, reasoning: 120, mode: 120 }
/** 状态区那一行的五个内置件（全藏时用；插件件是全藏后仍能自己撑起那一组的那一件）。 */
const STATUS_BUILTINS = ['model', 'reasoning', 'mode', 'tokens', 'cc-command-hint']

const plugin = (id: string, sizing?: CcWidgetSizing) => ({ id, ...sizing })
const minOf = (hiddenIds: readonly string[], sizing?: CcWidgetSizing, id = 'plug.panel') =>
  resolveCcMinHeight({ hiddenSlices: [hiddenIds, hiddenIds], scalars: SCALARS, pluginWidgets: [plugin(id, sizing)] })
const widthOf = (hiddenIds: readonly string[], sizing?: CcWidgetSizing, id = 'plug.panel') =>
  resolveCcMinWidth(resolveCcWidthGroups(hiddenIds, WIDTHS, [plugin(id, sizing)]))

describe('#266 刀5 · sizing 定形与校验（resolvePluginWidgetSizing）', () => {
  const OWNER = 'test.cc-sizing-plugin'
  const resolve = (raw: unknown) => resolvePluginWidgetSizing('plug.panel', OWNER, raw)

  it('没报（undefined）⇒ 两维都不参与，且**不诊断**（合法写法，与内置「内容撑」件同待遇）', () => {
    expect(resolve(undefined)).toEqual({ rejected: [] })
  })

  it('两维各自可选：单报一维只收一维；两维都报都收', () => {
    expect(resolve({ height: 120 }).sizing).toEqual({ height: 120 })
    expect(resolve({ width: 200 }).sizing).toEqual({ width: 200 })
    expect(resolve({ width: 200, height: 120 }).sizing).toEqual({ width: 200, height: 120 })
    expect(resolve({ width: 200, height: 120 }).rejected).toEqual([])
  })

  it('非法维度 ⇒ 只忽略该维度 + 诊断（另一维照收、该件照常上屏）', () => {
    // 非法值各形态：负数 / 0 / NaN / Infinity / 字符串 / null
    for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY, '120', null]) {
      const onlyBad = resolve({ height: bad })
      expect(onlyBad.sizing, String(bad)).toBeUndefined()
      expect(onlyBad.rejected, String(bad)).toEqual([
        { widgetId: 'plug.panel', ownerPluginId: OWNER, dimension: 'height', reason: 'invalid-number' },
      ])
    }
    // 一维坏、一维好：好的那维留下，坏的那维只记一条诊断（不丢件、不丢另一维）
    expect(resolve({ width: 200, height: -5 })).toEqual({
      sizing: { width: 200 },
      rejected: [{ widgetId: 'plug.panel', ownerPluginId: OWNER, dimension: 'height', reason: 'invalid-number' }],
    })
  })

  it('整条不是对象（字符串 / 数组 / null）⇒ 两维都不参与 + 一条 dimension=both 的诊断', () => {
    for (const bad of ['x', ['200'], null, 42]) {
      expect(resolve(bad), String(bad)).toEqual({
        rejected: [{ widgetId: 'plug.panel', ownerPluginId: OWNER, dimension: 'both', reason: 'not-an-object' }],
      })
    }
  })
})

describe('#266 刀5 · sizing 进算式（高度取 max / 宽度求和 / 隐藏不计 / 不报 = 下界）', () => {
  it('★ 缺省入参 ⇒ 与改造前**逐位相同**（组表、最小高、最小宽一字不差）', () => {
    const legacyHeightGroups = [
      { id: 'landing:cc-surface:top', height: 40, edgeGap: 10 },
      { id: 'landing:cc-surface:bottom', height: 28, edgeGap: 15 },
    ]
    expect(resolveCcHeightGroups([], SCALARS)).toEqual(legacyHeightGroups)
    expect(resolveCcHeightGroups([], SCALARS, [])).toEqual(legacyHeightGroups)
    expect(resolveCcMinHeight({ hiddenSlices: [[], []], scalars: SCALARS })).toBe(64)
    expect(resolveCcMinHeight({ hiddenSlices: [[], []], scalars: SCALARS, pluginWidgets: [] })).toBe(64)
    expect(resolveCcMinWidth(resolveCcWidthGroups([], WIDTHS))).toBe(384)
    expect(resolveCcMinWidth(resolveCcWidthGroups([], WIDTHS, []))).toBe(384)
    // 空的插件件输入 ⇒ 组表里不出现任何多余的行（不许"凭空建组"）
    expect(resolveCcWidthGroups([], WIDTHS, []).map(group => group.id))
      .toEqual(['queue:cc-surface:top', 'queue:cc-surface:bottom'])
  })

  it('★ 报了 height ⇒ 并入状态区组**取 max**：比内置最大高大就抬起来（64 → 135）', () => {
    // 状态组高 = max(触发器 28, 插件件 120) = 120；到边距离仍是该组自己的 15 ⇒ 135
    expect(minOf([], { height: 120 })).toBe(135)
    // 只报高度、不报宽度 ⇒ 宽度侧逐位不变（两维互不牵连）
    expect(widthOf([], { height: 120 })).toBe(384)
  })

  it('报了 height 但**不高于**内置最大高 ⇒ 取 max 不压低（60 仍是 60）', () => {
    const raised = { ...SCALARS, modelHeight: 60 }
    const withPlugin = resolveCcMinHeight({
      hiddenSlices: [[], []], scalars: raised, pluginWidgets: [plugin('plug.panel', { height: 16 })],
    })
    expect(withPlugin).toBe(75) // 15 + 60，插件件的 16 被 max 吃掉
  })

  it('状态区内置件**全藏**时，插件件自己就能撑起那一组（120 + 该落脚处声明的 `ccMarginBottom` 15 = 135；不报则一组建不起来 = 64）', () => {
    // 全藏 + 报了 120：上边组 50、下边组（由插件件撑起）120 + 15 = 135 ⇒ 135
    // ★ CC-13 刀5 接续：这一条原先是 120（插件件新建组时 edgeGap 记 0）——那正是接续单要修的缺陷
    //   （边距是**落脚处**的属性：状态区贴下边 ⇒ 无论谁在场都该加 `ccMarginBottom`）。读数与小节见下方
    //   的「刀5 接续」describe。
    expect(minOf(STATUS_BUILTINS, { height: 120 })).toBe(135)
    // 全藏 + 没报 ⇒ 与"不登记该插件件"逐位相同：只有上边组 50 ⇒ 下界 64
    expect(minOf(STATUS_BUILTINS)).toBe(64)
    expect(resolveCcMinHeight({ hiddenSlices: [STATUS_BUILTINS, STATUS_BUILTINS], scalars: SCALARS })).toBe(64)
  })

  it('★ 报了 width ⇒ 并入状态区队列**求和**（间距 0）：384 → 584；也不牵连高度', () => {
    expect(widthOf([], { width: 200 })).toBe(584)
    expect(minOf([], { width: 200 })).toBe(64)
    // 两件并排 ⇒ 各自求和（不是取 max）
    expect(resolveCcMinWidth(resolveCcWidthGroups([], WIDTHS, [
      plugin('plug.a', { width: 200 }), plugin('plug.b', { width: 50 }),
    ]))).toBe(634)
  })

  it('★ 隐藏 ⇒ 不计（与内置件同一谓词、按切面各算一遍）；取消 ⇒ 回升', () => {
    expect(minOf(['plug.panel'], { height: 120 })).toBe(64)
    expect(widthOf(['plug.panel'], { width: 200 })).toBe(384)
    // 只有**那一份切面**藏了它时，另一份切面照样把它算上（两态取 max 的口径不变）
    expect(resolveCcMinHeight({
      hiddenSlices: [['plug.panel'], []],
      scalars: SCALARS,
      pluginWidgets: [plugin('plug.panel', { height: 120 })],
    })).toBe(135)
  })

  it('★ 不报 / 非法维度 ⇒ 读数与"不登记该插件件"**逐位相同**（下界）', () => {
    const legacy = resolveCcHeightGroups([], SCALARS)
    expect(resolveCcHeightGroups([], SCALARS, [plugin('plug.panel')])).toEqual(legacy)
    // 算式自身也拦一道：非有限 / ≤0 一律按 0 计（定形处之外的第二道防线）
    expect(resolveCcHeightGroups([], SCALARS, [plugin('plug.panel', { height: Number.NaN })])).toEqual(legacy)
    expect(resolveCcHeightGroups([], SCALARS, [plugin('plug.panel', { height: 0 })])).toEqual(legacy)
    expect(resolveCcWidthGroups([], WIDTHS, [plugin('plug.panel', { width: -1 })])).toEqual(resolveCcWidthGroups([], WIDTHS))
    // 全藏时也不许因为"有一件没报尺寸的插件件"而凭空多出一个组（那会把 64 抬到 120）
    expect(resolveCcHeightGroups(STATUS_BUILTINS, SCALARS, [plugin('plug.panel')]).map(group => group.id))
      .toEqual(['landing:cc-surface:top'])
  })
})

/**
 * ★★ CC-13 刀5 **接续**：**组级 `edgeGap` 取「该落脚处在定义表里声明的边距」，与"谁在场"无关**。
 *
 * 修正的缺陷：插件件把某落脚处的内置件**全挤走**（`ccHiddenEmpty` 默认全藏状态件 ⇒ 空态默认就是这个组合）
 * 时，组由插件件新建 ⇒ 原先 `edgeGap` 记 0 ⇒ 下界少算 `ccMarginBottom`（实机 120，应为 135）。
 * 等价性要求（内置读数逐位不变）：同一落脚处同 side ⇒ 在内置行里取 max 与本表声明值**相等**，
 * 两条路只在"该落脚处无内置件在场"时分道 —— 正是本接续要补的那一半。
 */
describe('#266 刀5 接续 · 组级边距取「落脚处声明」（与谁在场无关）', () => {
  const bottomGroupOf = (
    hiddenIds: readonly string[],
    sizing?: CcWidgetSizing,
    scalars: CcMinHeightScalars = SCALARS,
  ) => resolveCcHeightGroups(hiddenIds, scalars, [plugin('plug.panel', sizing)])
    .find(group => group.id === 'landing:cc-surface:bottom')

  it('★ 插件件独占状态组 ⇒ 边距照算 `ccMarginBottom`（120 → 135），与内置件在场时**同值**', () => {
    // 内置件在场：组由内置行建起来 ⇒ 15 + 120
    expect(minOf([], { height: 120 })).toBe(135)
    // 内置件全藏（插件件独占）：组由插件件建 ⇒ 边距**同样**取该落脚处声明 ⇒ 15 + 120
    expect(minOf(STATUS_BUILTINS, { height: 120 })).toBe(135)
    // 不变量的直接读数：**边距不随在场集合变化**
    expect(minOf(STATUS_BUILTINS, { height: 120 })).toBe(minOf([], { height: 120 }))
    // 组对象层两侧一致（不是"读数凑巧相等"）
    expect(bottomGroupOf([])).toEqual({ id: 'landing:cc-surface:bottom', height: 28, edgeGap: 15 })
    expect(bottomGroupOf(STATUS_BUILTINS, { height: 120 }))
      .toEqual({ id: 'landing:cc-surface:bottom', height: 120, edgeGap: 15 })
  })

  it('★ 声明边距缺省 ⇒ 0（"缺项按 0"的既有纪律）：独占组读数 120 而不是 135', () => {
    const sparseScalars = { inputOffsetTop: 10, inputHeight: 40, modelHeight: 28, reasoningHeight: 28, permissionHeight: 28 }
    expect(bottomGroupOf(STATUS_BUILTINS, { height: 120 }, sparseScalars))
      .toEqual({ id: 'landing:cc-surface:bottom', height: 120, edgeGap: 0 })
    expect(resolveCcMinHeight({
      hiddenSlices: [STATUS_BUILTINS, STATUS_BUILTINS],
      scalars: sparseScalars,
      pluginWidgets: [plugin('plug.panel', { height: 120 })],
    })).toBe(120)
  })

  it('★ 内置件读数逐位不变：三态组表与"在场行取 max"逐位相等（本接续的等价性要求）', () => {
    // 全在场 / 部分在场 / 只剩内容撑件 —— 边距都还是那两条声明值（10 / 15）
    expect(resolveCcHeightGroups([], SCALARS)).toEqual([
      { id: 'landing:cc-surface:top', height: 40, edgeGap: 10 },
      { id: 'landing:cc-surface:bottom', height: 28, edgeGap: 15 },
    ])
    expect(resolveCcHeightGroups(['model'], SCALARS)).toEqual([
      { id: 'landing:cc-surface:top', height: 40, edgeGap: 10 },
      { id: 'landing:cc-surface:bottom', height: 28, edgeGap: 15 },
    ])
    expect(resolveCcHeightGroups(['model', 'reasoning', 'mode'], SCALARS)).toEqual([
      { id: 'landing:cc-surface:top', height: 40, edgeGap: 10 },
      { id: 'landing:cc-surface:bottom', height: 28, edgeGap: 15 },
    ])
    expect(minOf([])).toBe(64)
    expect(minOf(['model'])).toBe(64)
    expect(minOf(STATUS_BUILTINS)).toBe(64)
  })

  it('★ 横向同口径：独占队列的边距取该落脚处声明的 `layout.x.gap`（今天全行缺省 ⇒ 0，读数不变）', () => {
    const soloQueue = resolveCcWidthGroups(STATUS_BUILTINS, WIDTHS, [plugin('plug.panel', { width: 200 })])
      .find(group => group.id === 'queue:cc-surface:bottom')!
    const builtinQueue = resolveCcWidthGroups([], WIDTHS).find(group => group.id === 'queue:cc-surface:bottom')!
    expect(soloQueue).toEqual({ id: 'queue:cc-surface:bottom', width: 200, edgeGap: 0 })
    // 与内置件在场时**逐位相同**（同一声明值）
    expect(soloQueue.edgeGap).toBe(builtinQueue.edgeGap)
    expect(widthOf(STATUS_BUILTINS, { width: 200 })).toBe(200)
    expect(widthOf([], { width: 200 })).toBe(584)
  })
})

describe('#266 刀5 · 活名单把 sizing 带出来（合成 + 映射成算式输入）', () => {
  const source = (value: CcWidgetContribution): CcWidgetRosterSourceEntry => ({ value, ownerPluginId: 'test.cc-sizing-plugin' })
  const render = { kind: 'host-renderer', rendererKey: 'tokens' } as const

  it('合成：合法的两维随条目带出；没报 ⇒ 键不出现（不给每条登记白添空对象）', () => {
    const roster = resolveCcWidgetRoster([
      source({ id: 'plug.sized', label: '带尺寸', render, sizing: { width: 200, height: 120 } }),
      source({ id: 'plug.plain', label: '没报尺寸', render }),
    ])
    expect(roster.entries.find(entry => entry.id === 'plug.sized')?.sizing).toEqual({ width: 200, height: 120 })
    expect(roster.entries.find(entry => entry.id === 'plug.plain')).not.toHaveProperty('sizing')
    expect(roster.sizingRejections).toEqual([])
    // 内置件不带 sizing（它是声明式算式的另一条来源：定义表字段）
    expect(roster.entries.filter(entry => entry.source === 'builtin').every(entry => entry.sizing === undefined)).toBe(true)
  })

  it('合成：非法维度只丢该维 + 进 sizingRejections（该件仍在活名单里）', () => {
    const roster = resolveCcWidgetRoster([
      source({ id: 'plug.half', label: '半坏', render, sizing: { width: 200, height: -5 } }),
      source({ id: 'plug.broken', label: '全坏', render, sizing: 'x' as unknown as CcWidgetSizing }),
    ])
    expect(roster.entries.find(entry => entry.id === 'plug.half')?.sizing).toEqual({ width: 200 })
    expect(roster.entries.find(entry => entry.id === 'plug.broken')).not.toHaveProperty('sizing')
    expect(roster.rejected).toEqual([])
    expect(roster.sizingRejections).toEqual([
      { widgetId: 'plug.half', ownerPluginId: 'test.cc-sizing-plugin', dimension: 'height', reason: 'invalid-number' },
      { widgetId: 'plug.broken', ownerPluginId: 'test.cc-sizing-plugin', dimension: 'both', reason: 'not-an-object' },
    ])
  })

  it('映射成算式输入：只取**报了尺寸**的插件件（内置件与没报的件都不出现）', () => {
    const roster = resolveCcWidgetRoster([
      source({ id: 'plug.sized', label: '带尺寸', render, sizing: { width: 200, height: 120 } }),
      source({ id: 'plug.plain', label: '没报尺寸', render }),
    ])
    expect(resolveCcPluginWidgetSizings(roster.entries)).toEqual([{ id: 'plug.sized', width: 200, height: 120 }])
    // 端到端：活名单 → 算式输入 → 最小高抬高（插件件默认落点 = 状态区）
    const pluginWidgets = resolveCcPluginWidgetSizings(roster.entries)
    expect(resolveCcMinHeight({ hiddenSlices: [[], []], scalars: SCALARS, pluginWidgets })).toBe(135)
  })

  it('ccMinHeightInputOf 把插件件一并带进算式输入（第二参缺省 ⇒ 逐位不变）', () => {
    const theme = { ...SCALARS, ccHidden: [], ccHiddenEmpty: [] }
    expect(ccMinHeightInputOf(theme).pluginWidgets).toEqual([])
    expect(resolveCcMinHeight(ccMinHeightInputOf(theme))).toBe(64)
    expect(resolveCcMinHeight(ccMinHeightInputOf(theme, [plugin('plug.panel', { height: 120 })]))).toBe(135)
  })
})
