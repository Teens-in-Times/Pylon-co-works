import { DEFAULT_INTERFACE_MODE, type InterfaceMode, useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getInterfaceModeRegistry, getPluginUiRegistry, getPresentationProfileRegistry, getRendererRegistry, getShellRecipeRegistry } from '../../plugin-runtime/runtimeServices.ts'
import type { PresentationProfileContribution } from '../../plugin-runtime/presentation/presentationProfileTypes.ts'
import type { InterfaceModeContribution } from '../../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { DEFAULT_SHELL_RECIPE, type ShellRecipeContribution } from '../../plugin-runtime/shell-recipe/shellRecipeTypes.ts'
import { useThemeStore } from '../../domains/theme/themeStore.ts'
import { DEFAULTS } from '../../domains/theme/themeDefaults.ts'
import type { SettingWriteSource } from '../../domains/theme/settingProvenance.ts'
import { planModeDefaultForInterfaceMode } from '../../domains/theme/zones/modeLandingPlan.ts'
import { validateRendererSuiteReferences } from '../../plugin-runtime/renderers/rendererSuiteReferences.ts'

export interface InterfaceModeTransactionPorts {
  readonly interfaceMode: Pick<typeof useInterfaceModeStore, 'getState'>
  readonly presentation: Pick<typeof usePresentationPreferenceStore, 'getState'>
  readonly theme: Pick<typeof useThemeStore, 'getState'>
}

const defaultPorts = {
  interfaceMode: useInterfaceModeStore,
  presentation: usePresentationPreferenceStore,
  theme: useThemeStore,
} satisfies InterfaceModeTransactionPorts

export interface InterfaceModeSuiteChoice {
  readonly requestedSuiteId?: string
  readonly activeSuiteId?: string
  readonly unavailable: boolean
}

/** Resolve Suite precedence without mutating the persisted preference. */
export function resolveInterfaceModeSuite(
  mode: InterfaceModeContribution,
  selectedSuiteId: string | undefined,
  availableSuiteIds: readonly string[],
  fallbackSuiteId = 'builtin.solid',
): InterfaceModeSuiteChoice {
  if (mode.workbench.renderKind !== 'renderer-suite') return { unavailable: false }
  const requestedSuiteId = selectedSuiteId || mode.workbench.defaultSuiteId
  const available = new Set(availableSuiteIds)
  if (available.has(requestedSuiteId)) return { requestedSuiteId, activeSuiteId: requestedSuiteId, unavailable: false }
  const activeSuiteId = available.has(fallbackSuiteId) ? fallbackSuiteId : availableSuiteIds[0]
  return { requestedSuiteId, activeSuiteId, unavailable: true }
}

export function presentationProfileInterfaceMode(profile: PresentationProfileContribution): InterfaceMode {
  return profile.interfaceMode ?? 'terminal-like'
}

export function resolveInterfaceMode(mode: InterfaceMode): InterfaceModeContribution | undefined {
  return getInterfaceModeRegistry().resolve(mode)?.value
}

export function interfaceModeIsUsable(mode: InterfaceModeContribution): boolean {
  const ui = getPluginUiRegistry()
  if (mode.workbench.renderKind === 'isolated-surface' && !ui.resolve(mode.workbench.surfaceId)) return false
  if (mode.shellSurface && !ui.resolve(mode.shellSurface.surfaceId)) return false
  if (mode.shellRecipeId !== undefined && !getShellRecipeRegistry().resolve(mode.shellRecipeId)) return false
  return true
}

/**
 * Render-time recipe resolution: registered contribution, else the built-in
 * classic arrangement. Activation already hard-rejects dangling shellRecipeId;
 * this guard only keeps transient states (HMR/plugin hot-swap) from crashing
 * the shell between registry snapshots.
 */
export function resolveShellRecipe(mode: InterfaceModeContribution | undefined): ShellRecipeContribution {
  if (mode?.shellRecipeId !== undefined) {
    return getShellRecipeRegistry().resolve(mode.shellRecipeId)?.value ?? DEFAULT_SHELL_RECIPE
  }
  return DEFAULT_SHELL_RECIPE
}

function resolveActivatableMode(mode: InterfaceMode, ports: InterfaceModeTransactionPorts): InterfaceModeContribution | undefined {
  const modeContribution = resolveInterfaceMode(mode)
  if (!modeContribution || !interfaceModeIsUsable(modeContribution)) return undefined
  try {
    const services = {
      suites: getRendererRegistry().snapshot().rendererSuites.map(entry => entry.value),
      modes: getInterfaceModeRegistry().getSnapshot().entries.map(entry => entry.value),
      profiles: getPresentationProfileRegistry().getSnapshot().entries.map(entry => entry.value),
      shellRecipes: getShellRecipeRegistry().getSnapshot().entries.map(entry => entry.value),
    }
    validateRendererSuiteReferences(services)
  } catch {
    return undefined
  }
  if (modeContribution.workbench.renderKind === 'renderer-suite') {
    const selectedSuiteId = ports.presentation.getState().rendererSuiteIdByMode[mode]
    resolveInterfaceModeSuite(modeContribution, selectedSuiteId, getRendererRegistry().snapshot().rendererSuites.map(entry => entry.value.id))
  }
  return modeContribution
}

/**
 * ★ #607 刀3a：切换 / 重置的**唯一落点** —— 应用本大类的**隐藏默认单**（整份主题 + 清账），
 * 身份取自材料里生效的消息流样式单。
 *
 * - 未登记该模式的默认单（插件模式）⇒ 回落整份 `DEFAULTS`（不报错、不悬空）；
 * - 材料不带身份 ⇒ 不写 `activeProfileId`（保持原值）。
 */
function applyModeDefaultLanding(
  mode: InterfaceMode,
  ports: InterfaceModeTransactionPorts,
  source: SettingWriteSource,
): void {
  const plan = planModeDefaultForInterfaceMode(mode)
  ports.theme.getState().applyLandingPlan(plan?.theme ?? structuredClone(DEFAULTS), source)
  if (plan?.styleProfileId !== undefined) {
    ports.presentation.getState().setActiveProfileId(plan.styleProfileId)
  }
}

/**
 * 切换界面模式 = 应用本大类隐藏默认单。
 *
 * ★ #607：**不挑呈现档案**——一切值来自落点材料，身份取自材料里生效的消息流样式单。
 * 档案私路（选择器 / 命令 / 记忆链 / bundle 段）已随刀3b 整体退役。
 */
export function activateInterfaceMode(mode: InterfaceMode, ports: InterfaceModeTransactionPorts = defaultPorts): boolean {
  const modeContribution = resolveActivatableMode(mode, ports)
  if (!modeContribution) return false
  try { applyModeDefaultLanding(mode, ports, 'interface-mode') } catch { return false }
  ports.interfaceMode.getState().setInterfaceMode(mode)
  return true
}

/** 重置主题 = 应用当前界面模式的隐藏默认单（与切换**同一条路径**，#607 刀3a）。 */
export function resetThemeForActiveInterfaceMode(ports: InterfaceModeTransactionPorts = defaultPorts): boolean {
  const mode = ports.interfaceMode.getState().interfaceMode
  const modeContribution = resolveActivatableMode(mode, ports)
  if (!modeContribution) return false
  try { applyModeDefaultLanding(mode, ports, 'theme-reset') } catch { return false }
  return true
}

/**
 * Cold-start/HMR guard（#607 刀3b）：**只对齐界面模式**。
 *
 * 档案记忆链退役后本守卫不再解析 / 记忆呈现档案：模式可用即通过；不可用（插件卸载
 * 留下的悬空引用）时回退默认模式（A17 韧性语义）。
 */
export function ensureInterfaceModeProfile(): boolean {
  const mode = useInterfaceModeStore.getState().interfaceMode
  const modeContribution = resolveInterfaceMode(mode)
  if (!modeContribution || !interfaceModeIsUsable(modeContribution)) {
    if (mode === DEFAULT_INTERFACE_MODE) return false
    return activateInterfaceMode(DEFAULT_INTERFACE_MODE)
  }
  return true
}

export function interfaceModeQuickTarget(mode: InterfaceMode): InterfaceModeContribution | undefined {
  const current = resolveInterfaceMode(mode)
  if (!current?.quickSwitchTargetId) return undefined
  const target = resolveInterfaceMode(current.quickSwitchTargetId)
  return target && interfaceModeIsUsable(target) ? target : undefined
}
