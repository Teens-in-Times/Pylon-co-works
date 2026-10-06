// @vitest-environment jsdom
/**
 * #266 CC-13 刀3 · `clear-cc-placement` 的**三段接线**守卫（施工单 §4.4）。
 *
 * 三段 = 命令联合（编译期，由本文件的类型化派发间接锁住）→
 * `reduceAppearanceCommand`（纯 reducer / fixture 路径）→
 * `themeProjectedWorkbenchAppearanceStore.dispatchAppearanceCommand`（生产路径）。
 * 口径两条：
 * - **删得掉**：记录存在 ⇒ 数据里那条消失（重装回来 = 回到计算默认，排最后）；
 * - **幂等**：记录不存在 ⇒ **原样返回**（不产发布 / 不置 zone custom）。
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

/** 一份带插件位置记录的主题（插件件 id 走**未知键保留**那条路进数据）。 */
function themeWithPluginPlacement(): ThemeSettings {
  return {
    ...structuredClone(DEFAULTS),
    ccLayout: normalizeCcLayout({
      version: 9,
      placements: { 'test.plugin-alpha': { order: 8, offsetX: 6, offsetY: -1 } },
    } as unknown as Partial<CcLayoutV3>),
  }
}

describe('#266 CC-13 刀3 · clear-cc-placement', () => {
  it('纯 reducer：删得掉；不存在 ⇒ 原样返回同一份 theme（幂等）', () => {
    const theme = themeWithPluginPlacement()
    expect(theme.ccLayout.placements['test.plugin-alpha']).toEqual({ order: 8, offsetX: 6, offsetY: -1 })

    const cleared = reduceAppearanceCommand(theme, { type: 'clear-cc-placement', id: 'test.plugin-alpha' })
    expect(cleared.ccLayout.placements['test.plugin-alpha']).toBeUndefined()
    expect(cleared).not.toBe(theme)

    // 幂等：再删同一条 / 删一条本来就不存在的 ⇒ 两路都"什么也不做"
    expect(reduceAppearanceCommand(cleared, { type: 'clear-cc-placement', id: 'test.plugin-alpha' })).toBe(cleared)
    expect(reduceAppearanceCommand(theme, { type: 'clear-cc-placement', id: 'test.no-such-widget' })).toBe(theme)

    // 只删那一条：内置件的位置与其它字段一字不动
    expect(cleared.ccLayout.placements.model).toEqual(theme.ccLayout.placements.model)
    expect(cleared.ccLayout.placements['cc-send-button']).toEqual(theme.ccLayout.placements['cc-send-button'])
  })

  it('fixture 路径（static store）：快照里那条消失；对不存在的记录派发**不通知订阅者**', () => {
    const store = createStaticWorkbenchAppearanceStore(themeWithPluginPlacement())
    let notified = 0
    const unsubscribe = store.subscribe(() => { notified += 1 })
    expect(store.getSnapshot().ccLayout.placements['test.plugin-alpha']).toBeTruthy()

    store.dispatch({ type: 'clear-cc-placement', id: 'test.plugin-alpha' })
    expect(store.getSnapshot().ccLayout.placements['test.plugin-alpha']).toBeUndefined()
    expect(notified).toBe(1)

    store.dispatch({ type: 'clear-cc-placement', id: 'test.plugin-alpha' })
    expect(notified).toBe(1)

    unsubscribe()
    store.destroy()
  })

  it('生产路径（themeStore 真源）：删得掉，且**不**把 cc zone 标成「自定义」', () => {
    useThemeStore.setState({ ccLayout: themeWithPluginPlacement().ccLayout })
    const projected = createThemeProjectedWorkbenchAppearanceStore()

    projected.dispatch({ type: 'clear-cc-placement', id: 'test.plugin-alpha' })

    expect(useThemeStore.getState().ccLayout.placements['test.plugin-alpha']).toBeUndefined()
    // ★ 撤下清位是**插件侧事件**，不是用户手改该区域 ⇒ 不置 custom（口径见 themeStore 的类型注释）
    expect(useThemeStore.getState().custom.cc).toBe(false)
    expect(projected.getSnapshot().ccLayout.placements['test.plugin-alpha']).toBeUndefined()
    projected.destroy()
  })

  it('两路等价：同一命令序列（改位置 → 撤下 → 重复撤下）后快照逐字段相等', () => {
    const commands = [
      { type: 'update-cc-placement', id: 'test.plugin-alpha', placement: { offsetX: 20 } },
      { type: 'clear-cc-placement', id: 'test.plugin-alpha' },
      { type: 'clear-cc-placement', id: 'test.plugin-alpha' },
      { type: 'update-cc-placement', id: 'model', placement: { order: 3 } },
    ] as const

    const staticStore = createStaticWorkbenchAppearanceStore(themeWithPluginPlacement())
    for (const command of commands) staticStore.dispatch(command)
    const { revision: _staticRevision, ...fromReducer } = staticStore.getSnapshot()
    staticStore.destroy()

    useThemeStore.setState({ ccLayout: themeWithPluginPlacement().ccLayout })
    const projected = createThemeProjectedWorkbenchAppearanceStore()
    for (const command of commands) projected.dispatch(command)
    const { revision: _projectedRevision, ...fromThemeStore } = projected.getSnapshot()
    projected.destroy()

    expect(fromThemeStore).toEqual(fromReducer)
    expect(fromReducer.ccLayout.placements['test.plugin-alpha']).toBeUndefined()
  })
})
