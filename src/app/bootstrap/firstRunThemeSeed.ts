/**
 * firstRunThemeSeed — 首启主题种子（CC-14）。
 *
 * 持久化里没有主题存档（pylon-theme 键不存在）时，把界面模式落「终端」并套用
 * 「终端默认预设」的值；已有存档（含第二次启动、重试重跑）⇒ no-op 返回 false。
 *
 * 动作**顺序写死**：先 setInterfaceMode('terminal-like') 再 resetTheme() ——
 * resetTheme 的落点是「当前界面模式的默认预设」（themeStore.resetTheme 内经
 * defaultPresetForInterfaceMode 解析），顺序颠倒会落到 GUI 默认预设。
 *
 * 呈现方案不在这里管：既有 ensureInterfaceModeProfile()（App.solid.tsx）会在模式
 * 就绪后自动激活 terminal-classic 呈现方案。DEFAULT_INTERFACE_MODE（modern-gui）
 * 不受影响——种子只在首启改一次，A17 兜底行为不变。
 */
import { resolveLocalStorage, type PersistStringStorage } from '../../infrastructure/state/solidStoreKernel'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { useThemeStore } from '../../domains/theme/themeStore.ts'

/** 主题域持久化键（themeStore attachSolidPersist 的 name）。 */
const THEME_PERSIST_KEY = 'pylon-theme'

/** 首启落定的界面模式（终端）。 */
export const FIRST_RUN_INTERFACE_MODE = 'terminal-like'

/**
 * 首启判定 + 种子动作。返回是否执行了种子（true = 首启）。
 *
 * 判定用 resolveLocalStorage()（不裸碰 localStorage，node 无存储环境返回 null
 * ⇒ 按「无存档」处理，与 persist 的空环境语义一致）。接线点 = `main.solid.tsx`
 * 的 `startupMark('main_module_eval')` 之后、`render(<KernelRoot/>)` 之前：
 * 主题域 persist 随模块求值同步 rehydrate（硬约束「rehydrate 完成之后」在此满足），
 * 而挂载期 effect（ensureInterfaceModeProfile 等）尚未运行——它们一旦先跑就会经
 * persist writeBack 落盘 pylon-theme，把首启误判成已有存档（实测踩过，勿后移）。
 */
export function applyFirstRunThemeSeed(
  storage: PersistStringStorage | null = resolveLocalStorage(),
): boolean {
  if (storage?.getItem(THEME_PERSIST_KEY) != null) return false
  useInterfaceModeStore.getState().setInterfaceMode(FIRST_RUN_INTERFACE_MODE)
  useThemeStore.getState().resetTheme()
  return true
}
