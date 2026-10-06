/**
 * 生产路径的外观命令处理器：`dispatchAppearanceCommand` 把命令透传 themeStore actions
 * （clamp / settle 落在 themeStore / presetReducer 一侧）。
 * 与 `workbenchAppearanceStore.reduceAppearanceCommand`（测试 / fixture 纯 reducer 路径）
 * 的等价性由 `__tests__/appearanceCommandEquivalence.test.ts` 守卫。
 */
import { useThemeStore } from '../theme/themeStore.ts'
import type { AppearanceCommand, WorkbenchAppearanceStore } from './appearance.ts'
import { createVanillaWorkbenchAppearanceStore } from './workbenchAppearanceStore.ts'

export function createThemeProjectedWorkbenchAppearanceStore(): WorkbenchAppearanceStore {
  // #483：showPet 随宠物链删除退役，外观快照回归纯主题 store 投影。
  const readTheme = () => ({ ...useThemeStore.getState() })
  return createVanillaWorkbenchAppearanceStore(
    {
      getState: readTheme,
      subscribe: listener => {
        const notify = () => { const next = readTheme(); listener(next, next) }
        return useThemeStore.subscribe(notify)
      },
    },
    dispatchAppearanceCommand,
  )
}

function dispatchAppearanceCommand(command: AppearanceCommand): void {
  const state = useThemeStore.getState()
  switch (command.type) {
    case 'set-cc-edit-mode':
      state.setCcEditMode(command.enabled)
      break
    case 'set-cc-hidden':
      // ★ #266 刀4：`target` 原样透传 —— 两个开关各写各的表，写入不认门
      state.setCcHidden(command.id, command.hidden, command.target)
      break
    case 'set-cc-height':
      state.setCcHeight(command.height)
      break
    case 'update-cc-placement':
      state.updateCcPlacement(command.id, command.placement)
      break
    case 'clear-cc-placement':
      state.clearCcPlacement(command.id)
      break
    case 'set-cc-property':
      if (typeof command.value !== 'number' || Number.isFinite(command.value)) {
        state.setZoneField('cc', { [command.key]: command.value })
      }
      break
    case 'reset-cc-layout':
      state.resetCcLayout()
      break
  }
}
