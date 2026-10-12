// @vitest-environment jsdom
/**
 * #266 CC-13 刀3 立、**刀4 泛化** · `clear-cc-widget-data` 的**三段接线**守卫（施工单 §4.4）。
 *
 * 三段 = 命令联合（编译期，由本文件的类型化派发间接锁住）→
 * `reduceAppearanceCommand`（纯 reducer / fixture 路径）→
 * `themeProjectedWorkbenchAppearanceStore.dispatchAppearanceCommand`（生产路径）。
 * ★ 刀4 把命令从 `clear-cc-placement` 泛化为 `clear-cc-widget-data`：一次清**三样** ——
 *   位置记录（`ccLayout.placements[id]`）、插件属性（`ccPluginProps[id]`）、
 *   两份显隐表（`ccHidden` / `ccHiddenEmpty`）里的该 id。口径三条：
 * - **删得掉**：三样各自存在 ⇒ 全都消失（重装回来 = 回到计算默认 + 参数回声明缺省）；
 * - **只删该 id**：内置件与别的插件件的数据一字不动；
 * - **幂等**：三样都不存在 ⇒ **原样返回**（不产发布 / 不置 zone custom）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeCcLayout, type CcLayoutV3 } from '../../cc/ccLayoutState.ts'
import { createStaticWorkbenchAppearanceStore, reduceAppearanceCommand } from '../workbenchAppearanceStore.ts'
import { createThemeProjectedWorkbenchAppearanceStore } from '../themeProjectedWorkbenchAppearanceStore.ts'
import { useThemeStore } from '../../theme/themeStore.ts'
import { DEFAULTS } from '../../theme/themeDefaults.ts'
import { resetStores } from '../../../test/resetStores.ts'
import type { ThemeSettings } from '../../theme/themeStore.ts'

beforeEach(() => {
  localStorage.clear()
  resetStores()
})

const PLUGIN_ID = 'test.plugin-alpha'

/** 一份"三样都动过"的主题（插件件 id 走**未知键保留**那条路进位置数据）。 */
function themeWithPluginData(): ThemeSettings {
  return {
    ...structuredClone(DEFAULTS),
    ccLayout: normalizeCcLayout({
      version: 9,
      placements: { [PLUGIN_ID]: { order: 8, offsetX: 6, offsetY: -1 } },
    } as unknown as Partial<CcLayoutV3>),
    ccPluginProps: { [PLUGIN_ID]: { size: 18, accent: '#123456' }, 'other.widget': { size: 9 } },
    ccHidden: [...DEFAULTS.ccHidden, PLUGIN_ID],
    ccHiddenEmpty: [...DEFAULTS.ccHiddenEmpty, PLUGIN_ID],
  }
}

describe('#266 CC-13 刀3/刀4 · clear-cc-widget-data（清三样）', () => {
  it('纯 reducer：三样都删得掉；三样都不存在 ⇒ 原样返回同一份 theme（幂等）', () => {
    const theme = themeWithPluginData()
    expect(theme.ccLayout.placements[PLUGIN_ID]).toEqual({ order: 8, offsetX: 6, offsetY: -1 })

    const cleared = reduceAppearanceCommand(theme, { type: 'clear-cc-widget-data', id: PLUGIN_ID })
    expect(cleared.ccLayout.placements[PLUGIN_ID]).toBeUndefined()
    expect(cleared.ccPluginProps[PLUGIN_ID]).toBeUndefined()
    expect(cleared.ccHidden).not.toContain(PLUGIN_ID)
    expect(cleared.ccHiddenEmpty).not.toContain(PLUGIN_ID)
    expect(cleared).not.toBe(theme)

    // ★ 只删该 id：别的元件的三样数据一字不动
    expect(cleared.ccPluginProps['other.widget']).toEqual({ size: 9 })
    expect(cleared.ccLayout.placements.model).toEqual(theme.ccLayout.placements.model)
    expect(cleared.ccLayout.placements['cc-send-button']).toEqual(theme.ccLayout.placements['cc-send-button'])
    expect(cleared.ccHidden).toEqual(theme.ccHidden.filter(id => id !== PLUGIN_ID))
    expect(cleared.ccHiddenEmpty).toEqual(theme.ccHiddenEmpty.filter(id => id !== PLUGIN_ID))

    // 幂等：再删同一条 / 删一条本来就不存在的 ⇒ 两路都"什么也不做"（连对象引用都不换）
    expect(reduceAppearanceCommand(cleared, { type: 'clear-cc-widget-data', id: PLUGIN_ID })).toBe(cleared)
    expect(reduceAppearanceCommand(theme, { type: 'clear-cc-widget-data', id: 'test.no-such-widget' })).toBe(theme)
  })

  it('只动了一样也照清（幂等判据是三样全无）：只改过参数的插件件撤下后参数消失', () => {
    const theme: ThemeSettings = {
      ...structuredClone(DEFAULTS),
      ccPluginProps: { [PLUGIN_ID]: { size: 18 } },
    }
    const cleared = reduceAppearanceCommand(theme, { type: 'clear-cc-widget-data', id: PLUGIN_ID })
    expect(cleared.ccPluginProps[PLUGIN_ID]).toBeUndefined()
    expect(cleared.ccLayout.placements).toEqual(theme.ccLayout.placements)
  })

  it('fixture 路径（static store）：三样一起消失；对不存在的记录派发**不通知订阅者**', () => {
    const store = createStaticWorkbenchAppearanceStore(themeWithPluginData())
    let notified = 0
    const unsubscribe = store.subscribe(() => { notified += 1 })
    expect(store.getSnapshot().ccPluginProps[PLUGIN_ID]).toEqual({ size: 18, accent: '#123456' })

    store.dispatch({ type: 'clear-cc-widget-data', id: PLUGIN_ID })
    const snapshot = store.getSnapshot()
    expect(snapshot.ccLayout.placements[PLUGIN_ID]).toBeUndefined()
    expect(snapshot.ccPluginProps[PLUGIN_ID]).toBeUndefined()
    expect(snapshot.ccHidden).not.toContain(PLUGIN_ID)
    expect(snapshot.ccHiddenEmpty).not.toContain(PLUGIN_ID)
    expect(notified).toBe(1)

    store.dispatch({ type: 'clear-cc-widget-data', id: PLUGIN_ID })
    expect(notified).toBe(1)

    unsubscribe()
    store.destroy()
  })

  it('生产路径（themeStore 真源）：三样都清，且**不**把 cc zone 标成「自定义」', () => {
    const seeded = themeWithPluginData()
    useThemeStore.setState({
      ccLayout: seeded.ccLayout,
      ccPluginProps: seeded.ccPluginProps,
      ccHidden: seeded.ccHidden,
      ccHiddenEmpty: seeded.ccHiddenEmpty,
    })
    const projected = createThemeProjectedWorkbenchAppearanceStore()

    projected.dispatch({ type: 'clear-cc-widget-data', id: PLUGIN_ID })

    const state = useThemeStore.getState()
    expect(state.ccLayout.placements[PLUGIN_ID]).toBeUndefined()
    expect(state.ccPluginProps[PLUGIN_ID]).toBeUndefined()
    expect(state.ccHidden).not.toContain(PLUGIN_ID)
    expect(state.ccHiddenEmpty).not.toContain(PLUGIN_ID)
    // ★ 撤下清数据是**插件侧事件**，不是用户手改该区域 ⇒ 不置 custom（口径见 themeStore 的类型注释）
    expect(state.custom.cc).toBe(false)
    const snapshot = projected.getSnapshot()
    expect(snapshot.ccPluginProps[PLUGIN_ID]).toBeUndefined()
    expect(snapshot.ccHidden).not.toContain(PLUGIN_ID)
    projected.destroy()
  })

  it('两路等价：同一命令序列（改位置 / 改参数 / 两个显隐开关 → 撤下 → 重复撤下）后快照逐字段相等', () => {
    const commands = [
      { type: 'update-cc-placement', id: PLUGIN_ID, placement: { offsetX: 20 } },
      { type: 'set-cc-plugin-prop', id: PLUGIN_ID, key: 'size', value: 22 },
      { type: 'set-cc-hidden', id: PLUGIN_ID, hidden: true, target: 'base' },
      { type: 'set-cc-hidden', id: PLUGIN_ID, hidden: true, target: 'empty' },
      { type: 'clear-cc-widget-data', id: PLUGIN_ID },
      { type: 'clear-cc-widget-data', id: PLUGIN_ID },
      { type: 'update-cc-placement', id: 'model', placement: { order: 3 } },
    ] as const

    const staticStore = createStaticWorkbenchAppearanceStore(themeWithPluginData())
    for (const command of commands) staticStore.dispatch(command)
    const { revision: _staticRevision, ...fromReducer } = staticStore.getSnapshot()
    staticStore.destroy()

    const seeded = themeWithPluginData()
    useThemeStore.setState({
      ccLayout: seeded.ccLayout,
      ccPluginProps: seeded.ccPluginProps,
      ccHidden: seeded.ccHidden,
      ccHiddenEmpty: seeded.ccHiddenEmpty,
    })
    const projected = createThemeProjectedWorkbenchAppearanceStore()
    for (const command of commands) projected.dispatch(command)
    const { revision: _projectedRevision, ...fromThemeStore } = projected.getSnapshot()
    projected.destroy()

    expect(fromThemeStore).toEqual(fromReducer)
    expect(fromReducer.ccLayout.placements[PLUGIN_ID]).toBeUndefined()
    expect(fromReducer.ccPluginProps[PLUGIN_ID]).toBeUndefined()
    expect(fromReducer.ccHidden).not.toContain(PLUGIN_ID)
  })
})
