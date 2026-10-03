// @vitest-environment jsdom
/**
 * ★ #266 刀3 退改②：**生产通路**的高度落点。
 *
 * 生产 App 的显隐/高度写入走**主题 store 投影**：`createThemeProjectedWorkbenchAppearanceStore()` →
 * `store.ts` 的 `setCcHidden` / `setCcHeight`（见 `agentWorkbenchSession.ts`），
 * 而 `workbenchAppearanceStore.createStaticWorkbenchAppearanceStore` 那一套是**预览 / 测试**用的另一条实现。
 * 两条实现各自持一份 clamp 落点 —— 刀3 两套都改了，但此前单测只覆盖静态那套
 * （`appearance.test.ts`），**生产这条没有直达用例**（一次反向验证"打错位置却不变红"就是这么暴露的）。
 * 本文件补上这条缝：只断言**生产通路**（主题投影动作 + 订阅回推），不碰静态实现。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createThemeProjectedWorkbenchAppearanceStore } from '../themeProjectedWorkbenchAppearanceStore.ts'
import { useThemeStore } from '../../theme/themeStore.ts'
import { resetStores } from '../../../test/resetStores.ts'

/** 起一片"生产态"的重置：四个 store 回初始态 + 清持久化。 */
beforeEach(() => {
  localStorage.clear()
  resetStores()
})

describe('#266 刀3 · 生产通路（主题投影）：高度下界按算式走', () => {
  it('★ 改显隐 ⇒ 最小高跟着变（藏 / 显那件高的前后各一读数）', () => {
    // 下边组里放一件高 60（其余两件 28）⇒ 它在场时下边组需求 = ccMarginBottom 15 + 60 = 75。
    // 空态切面按出厂口径也藏着它（出厂那 6 件含 model）⇒ 两态算式同值，读数干净。
    useThemeStore.setState({ ccHeight: 20, modelHeight: 60, ccHidden: [], ccHiddenEmpty: ['model'] })
    const appearance = createThemeProjectedWorkbenchAppearanceStore()

    // 藏掉那件高的（两态都藏）⇒ 行高回落到 28 ⇒ 下界 = max(64, 10+40, 15+28) = **64**
    appearance.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: true, target: 'base' })
    expect(useThemeStore.getState().ccHidden).toEqual(['model'])
    expect(useThemeStore.getState().ccHeight, '生产通路：显隐一变高度要重过 clamp').toBe(64)
    expect(appearance.getSnapshot().ccHeight, '回推的快照与 store 同步').toBe(64)

    // 放出来 ⇒ 常态下边组需求 75 成为绑定项（空态仍藏着它、只算 43）⇒ 两态取 max = **75**
    appearance.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: false, target: 'base' })
    expect(useThemeStore.getState().ccHidden).toEqual([])
    expect(useThemeStore.getState().ccHeight).toBe(75)
    expect(appearance.getSnapshot().ccHeight).toBe(75)

    appearance.destroy()
  })

  it('★ set-cc-height 也走算式下界（不是常量 64）', () => {
    useThemeStore.setState({ ccHeight: 20, modelHeight: 60, ccHidden: [], ccHiddenEmpty: [] })
    const appearance = createThemeProjectedWorkbenchAppearanceStore()

    appearance.dispatch({ type: 'set-cc-height', height: 20 })
    expect(useThemeStore.getState().ccHeight).toBe(75)

    // 区间内原样 / 上界仍 400
    appearance.dispatch({ type: 'set-cc-height', height: 200 })
    expect(useThemeStore.getState().ccHeight).toBe(200)
    appearance.dispatch({ type: 'set-cc-height', height: 999 })
    expect(useThemeStore.getState().ccHeight).toBe(400)

    appearance.destroy()
  })

  it('★ 两态取 max：下界由**要求更高的那一份**决定（生产通路同样）', () => {
    // ★ 退改 D1（改口径）：两态 = 常态 `ccHidden` / 空态 **`ccHidden ∪ ccHiddenEmpty`**。
    //   所以"常态藏着、空态放出来"这种组合在 C 下**不存在** —— 本用例按 C 改成：
    //   常态不藏（在场最多）⇒ 常态那一份是绑定项。
    useThemeStore.setState({ ccHeight: 20, modelHeight: 60, ccHidden: [], ccHiddenEmpty: [] })
    const appearance = createThemeProjectedWorkbenchAppearanceStore()

    // 触发一次 clamp（改高度即可）：下界 = 两态 max = 75（常态那一份：ccMarginBottom 15 + modelHeight 60）
    appearance.dispatch({ type: 'set-cc-height', height: 20 })
    expect(useThemeStore.getState().ccHeight).toBe(75)

    // 常态也把它藏掉 ⇒ 两态名单都藏它 ⇒ 下边组回落到 28 的行兜底 ⇒ 下界 64
    useThemeStore.setState({ ccHidden: ['model'] })
    appearance.dispatch({ type: 'set-cc-height', height: 20 })
    expect(useThemeStore.getState().ccHeight).toBe(64)

    // ★ 再藏表**加不出**"放回"的语义（D1 的核心）：常态藏着它时，空态也藏着（并集）⇒ 仍是 64
    useThemeStore.setState({ ccHidden: ['model'], ccHiddenEmpty: [] })
    appearance.dispatch({ type: 'set-cc-height', height: 20 })
    expect(useThemeStore.getState().ccHeight).toBe(64)

    appearance.destroy()
  })

  it('★ #266 刀4（结构 C）：生产通路同样"两个开关各写各表"（主管 / 再藏互不覆盖）', () => {
    useThemeStore.setState({ ccHeight: 20, ccHidden: [], ccHiddenEmpty: [] })
    const appearance = createThemeProjectedWorkbenchAppearanceStore()

    // 开关①「隐藏」⇒ 只写主管表
    appearance.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: true, target: 'base' })
    expect(useThemeStore.getState().ccHidden).toEqual(['model'])
    expect(useThemeStore.getState().ccHiddenEmpty, '主管表的写入不许落到再藏表').toEqual([])

    // 开关②「空态里再藏」⇒ 只写再藏表
    appearance.dispatch({ type: 'set-cc-hidden', id: 'tokens', hidden: true, target: 'empty' })
    expect(useThemeStore.getState().ccHiddenEmpty).toEqual(['tokens'])
    expect(useThemeStore.getState().ccHidden, '再藏表的写入不许落到主管表').toEqual(['model'])

    // 快照把两份表**平铺**（合并在读侧做，快照不预先选边）
    expect(appearance.getSnapshot().ccHidden).toEqual(['model'])
    expect(appearance.getSnapshot().ccHiddenEmpty).toEqual(['tokens'])

    appearance.destroy()
  })
})
