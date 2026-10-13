import { applyPresentationProfile } from './applyPresentationProfile.ts'
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

function applyModeProfile(mode: InterfaceMode, profile: PresentationProfileContribution, ports: InterfaceModeTransactionPorts): void {
  const result = applyPresentationProfile(profile, {
    setZoneField: (zone, patch, source) => ports.theme.getState().setZoneField(zone, patch, source),
    setActiveProfileId: profileId => ports.presentation.getState().setActiveProfileId(profileId),
  })
  if (result.status === 'failed') throw new Error(result.message)
  ports.interfaceMode.getState().rememberProfile(mode, profile.id)
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

/** 激活一个明确的 Profile；注册表引用未通过校验时保持偏好与主题不变。 */
export function activatePresentationProfile(profileId: string, ports: InterfaceModeTransactionPorts = defaultPorts): boolean {
  const profile = getPresentationProfileRegistry().resolve(profileId)?.value
  if (!profile) return false
  const mode = presentationProfileInterfaceMode(profile)
  if (!resolveActivatableMode(mode, ports)) return false
  try { applyModeProfile(mode, profile, ports) } catch { return false }
  ports.interfaceMode.getState().setInterfaceMode(mode)
  return true
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
 * ★ #607 刀3a：**不再挑呈现档案**（不读 `profileByMode`、不 `rememberProfile`、
 * 不 `applyPresentationProfile`）——一切值来自落点材料，档案机制本刀一行未删（3b 处置）。
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
 * 清理指向已注销 Interface Mode 的残留 presentation profile 偏好。
 * 只动偏好存储（可重建态），不触碰 registry——registry 权威归插件生命周期所有。
 */
function pruneDanglingPresentationProfiles(): void {
  const modes = new Set(getInterfaceModeRegistry().getSnapshot().entries.map(entry => entry.value.id))
  const { profileByMode, forgetModeProfile } = useInterfaceModeStore.getState()
  for (const [mode, profileId] of Object.entries(profileByMode)) {
    if (modes.has(mode)) continue
    // per-mode 偏好指向的 profile 若已随插件注销，清掉悬挂映射让 DEFAULT profile 接管
    if (!getPresentationProfileRegistry().resolve(profileId)?.value) forgetModeProfile(mode)
  }
}

/** Cold-start/HMR guard: active profile must belong to the persisted Interface Mode. */
export function ensureInterfaceModeProfile(): boolean {
  const mode = useInterfaceModeStore.getState().interfaceMode
  const modeContribution = resolveInterfaceMode(mode)
  if (!modeContribution || !interfaceModeIsUsable(modeContribution)) {
    if (mode === DEFAULT_INTERFACE_MODE) return false
    // A17 韧性：插件卸载可能留下引用已注销 mode 的残留 presentation profile——
    // validateRendererSuiteReferences 会因此拒绝激活。先清理跨注册表悬挂引用再重试，
    // 保证默认模式回退不被半套注销状态卡死。
    const firstAttempt = activateInterfaceMode(DEFAULT_INTERFACE_MODE)
    if (firstAttempt) return true
    pruneDanglingPresentationProfiles()
    return activateInterfaceMode(DEFAULT_INTERFACE_MODE)
  }
  const activeProfile = getPresentationProfileRegistry().resolve(usePresentationPreferenceStore.getState().activeProfileId)?.value
  if (activeProfile && presentationProfileInterfaceMode(activeProfile) === mode) {
    useInterfaceModeStore.getState().rememberProfile(mode, activeProfile.id)
    return true
  }
  return activateInterfaceMode(mode)
}

export function interfaceModeQuickTarget(mode: InterfaceMode): InterfaceModeContribution | undefined {
  const current = resolveInterfaceMode(mode)
  if (!current?.quickSwitchTargetId) return undefined
  const target = resolveInterfaceMode(current.quickSwitchTargetId)
  return target && interfaceModeIsUsable(target) ? target : undefined
}
