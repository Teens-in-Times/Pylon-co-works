/**
 * 测试 / fixture 路径的外观命令落点：`reduceAppearanceCommand` 是纯 reducer（clamp / settle 内联），
 * `createStaticWorkbenchAppearanceStore` 用它折叠命令。
 * 与 `themeProjectedWorkbenchAppearanceStore.dispatchAppearanceCommand`（themeStore 真源生产路径）
 * 的等价性由 `__tests__/appearanceCommandEquivalence.test.ts` 守卫。
 */
import { clearCcPlacementState, cloneCcLayout, DEFAULT_CC_LAYOUT, setCcHiddenState, updateCcPlacementState } from '../cc/ccLayoutState.ts'
import { clearCcPluginPropsState, setCcPluginPropState } from '../cc/ccPluginProps.ts'
import type { ThemeSettings } from '../theme/themeStore.ts'
import { clampCcHeight, ccMinHeightInputOf, clampInputTypography } from '../cc/ccHeightState.ts'
import {
  areWorkbenchAppearancesEqual,
  selectWorkbenchAppearance,
  type AppearanceCommand,
  type WorkbenchAppearanceStore,
} from './appearance.ts'

export interface ThemeStateSource {
  getState(): ThemeSettings
  subscribe(listener: (state: ThemeSettings, previousState: ThemeSettings) => void): () => void
}

export function createStaticWorkbenchAppearanceStore(
  initialTheme: ThemeSettings,
): WorkbenchAppearanceStore & { setTheme(theme: ThemeSettings): void } {
  let theme = structuredClone(initialTheme)
  let revision = 0
  let snapshot = selectWorkbenchAppearance(theme, revision)
  const listeners = new Set<() => void>()
  let destroyed = false

  const publish = (nextTheme: ThemeSettings) => {
    if (destroyed) return
    const candidate = selectWorkbenchAppearance(nextTheme, revision + 1)
    if (areWorkbenchAppearancesEqual(snapshot, candidate)) {
      theme = structuredClone(nextTheme)
      return
    }
    theme = structuredClone(nextTheme)
    revision += 1
    snapshot = selectWorkbenchAppearance(theme, revision)
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispatch(command) {
      publish(reduceAppearanceCommand(theme, command))
    },
    setTheme(nextTheme) {
      publish(nextTheme)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      listeners.clear()
    },
  }
}

export function createVanillaWorkbenchAppearanceStore(
  source: ThemeStateSource,
  dispatchCommand: (command: AppearanceCommand) => void = () => {},
): WorkbenchAppearanceStore {
  let revision = 0
  let snapshot = selectWorkbenchAppearance(source.getState(), revision)
  const listeners = new Set<() => void>()
  let destroyed = false

  const unsubscribeSource = source.subscribe(nextTheme => {
    if (destroyed) return
    const candidate = selectWorkbenchAppearance(nextTheme, revision + 1)
    if (areWorkbenchAppearancesEqual(snapshot, candidate)) return
    revision += 1
    snapshot = selectWorkbenchAppearance(nextTheme, revision)
    for (const listener of [...listeners]) listener()
  })

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispatch(command) {
      if (destroyed) return
      dispatchCommand(command)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      unsubscribeSource()
      listeners.clear()
    },
  }
}

export function reduceAppearanceCommand(
  theme: ThemeSettings,
  command: AppearanceCommand,
): ThemeSettings {
  switch (command.type) {
    case 'set-cc-edit-mode':
      return { ...theme, ccEditMode: command.enabled }
    case 'set-cc-hidden':
      // ★ #266 刀4（结构 C）：按 `target` 写**对应那一份表** —— 主管（两种门态都生效）/ 再藏（只在空态加一层）。
      //   写入不认门（旧版两份表平权、由门二选一读 ⇒ 写入必须知道你此刻在哪个状态）。
      return settleCcHeight(command.target === 'base'
        ? { ...theme, ccHidden: setCcHiddenState(theme.ccHidden, command.id, command.hidden) }
        : { ...theme, ccHiddenEmpty: setCcHiddenState(theme.ccHiddenEmpty, command.id, command.hidden) })
    case 'set-cc-height': {
      // ★ #266 刀3：下界 = 按边算取最大（算式见 `ccHeightState.resolveCcMinHeight`）。
      //   原先那条「把 ccHeight 抬到容得下输入栏」的规则（`Math.max(h, inputOffsetTop + inputHeight)`）
      //   已并入算式 —— 它正是算式里"输入栏那一组"的这一项，留着就是同一规则维护两遍。
      const ccHeight = clampCcHeight(command.height, ccMinHeightInputOf(theme))
      return settleCcInputBounds({ ...theme, ccHeight }, 'ccHeight')
    }
    case 'update-cc-placement':
      return { ...theme, ccLayout: updateCcPlacementState(theme.ccLayout, command.id, command.placement) }
    case 'set-cc-plugin-prop': {
      // ★ CC-13 刀4：插件件的属性写入（只写该元件那一条；同值 ⇒ 原样返回同一份 theme = 不广播）
      const ccPluginProps = setCcPluginPropState(theme.ccPluginProps, command.id, command.key, command.value)
      return ccPluginProps === theme.ccPluginProps ? theme : { ...theme, ccPluginProps }
    }
    case 'clear-cc-widget-data': {
      // ★★ CC-13 刀3 立、刀4 泛化：**清三样**（位置 / 插件属性 / 两份显隐表里的该 id）。
      //   三样都不存在 ⇒ **原样返回同一份 theme**（幂等、不产无谓发布）。
      //   ★ 显隐两份表用 `includes` 先判：`setCcHiddenState(…, false)` 的 filter 恒产新数组，
      //     不判会让"什么都没清"也变成一次新对象（幂等就废了）。
      const ccLayout = clearCcPlacementState(theme.ccLayout, command.id)
      const ccPluginProps = clearCcPluginPropsState(theme.ccPluginProps, command.id)
      const ccHidden = theme.ccHidden.includes(command.id) ? setCcHiddenState(theme.ccHidden, command.id, false) : theme.ccHidden
      const ccHiddenEmpty = theme.ccHiddenEmpty.includes(command.id) ? setCcHiddenState(theme.ccHiddenEmpty, command.id, false) : theme.ccHiddenEmpty
      return ccLayout === theme.ccLayout && ccPluginProps === theme.ccPluginProps
        && ccHidden === theme.ccHidden && ccHiddenEmpty === theme.ccHiddenEmpty
        ? theme
        : { ...theme, ccLayout, ccPluginProps, ccHidden, ccHiddenEmpty }
    }
    case 'set-cc-property':
      return typeof command.value === 'number' && !Number.isFinite(command.value)
        ? theme
        : settleCcInputBounds({ ...theme, [command.key]: command.value }, command.key)
    case 'reset-cc-layout':
      return { ...theme, ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT) }
  }
}

function settleCcHeight(theme: ThemeSettings): ThemeSettings {
  // ★ #266 刀3：显隐一变（`set-cc-hidden`）必须重过 clamp ⇒ 下界按**两态各算一遍取 max** 算
  //   （同 `themeStore.setCcHidden`）：常态那一份变了则常态算式变，而空态那一份可能仍咬住下界。
  const ccHeight = clampCcHeight(theme.ccHeight, ccMinHeightInputOf(theme))
  return { ...theme, ccHeight }
}

function settleCcInputBounds(theme: ThemeSettings, changedKey: string): ThemeSettings {
  const next = clampInputTypography({ ...theme }, changedKey)
  // ★ #266 刀3：原先这里有一条"把 ccHeight 抬到容得下输入栏"的规则
  //   （`min(400, max(ccHeight, inputOffsetTop + inputHeight))`）—— 它已并入最小高算式
  //   （算式的"输入栏那一组"正是这一项），故整条删除，只留下面那段"输入框让位"与末尾的 settle。
  if (next.inputHeight + next.inputOffsetTop > next.ccHeight) {
    if (changedKey === 'inputHeight') {
      next.inputHeight = Math.max(0, next.ccHeight - next.inputOffsetTop)
    } else if (changedKey === 'inputOffsetTop') {
      next.inputOffsetTop = Math.max(0, next.ccHeight - next.inputHeight)
    }
  }
  return settleCcHeight(next)
}
