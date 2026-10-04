/**
 * resetStores — 测试间共享状态统一清理（阶段 0 测试夹具）。
 *
 * 清理范围：四个 Zustand store 回初始态（zustand v5 getInitialState）、
 * 统一 sessionUi 注册表。测试 beforeEach/afterEach 调用。
 */

import { useThemeStore } from '../domains/theme/themeStore'
import { useCustomPresetStore } from '../domains/theme/customPresetStore'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import { sessionUiStore } from '../domains/workbench/sessionUiStore.ts'
import { usePresentationPreferenceStore } from '../domains/presentation/presentationPreferenceStore.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { useWorkspaceEntityStore } from '../domains/workspace/workspaceEntityStore.ts'
import { getRendererSettingsStore } from '../plugin-runtime/runtimeServices.ts'
import { useRightRailStore } from '../domains/workspace/layoutRailsStore.ts'
import { useSettingsChromeStore } from '../domains/appearance/settingsChromeStore.ts'
import '../app/bootstrap/identityCrossDomainWiring'
import '../app/bootstrap/workspaceControllerWiring'

export function resetStores(): void {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true)
  // Persist middleware writes synchronously.  A test may intentionally leave
  // a quota-failing MemoryStorage installed after exercising the error path;
  // resetting in-memory state must still proceed and must not turn that
  // intentional fault into a cross-test failure.
  try {
    useRightRailStore.setState(useRightRailStore.getInitialState(), true)
  } catch {
    // The state update happens before persist's storage write.  Ignore only
    // the storage exception here; production actions retain their error path.
  }
  try {
    useSettingsChromeStore.setState(useSettingsChromeStore.getInitialState(), true)
  } catch {
    // 同 useRightRailStore：persist 存储故障不应把测试间重置变成跨用例失败。
  }
  useIdentityStore.setState(useIdentityStore.getInitialState(), true)
  useRuntimeStore.setState(useRuntimeStore.getInitialState(), true)
  useThemeStore.setState(useThemeStore.getInitialState(), true)
  // #448 PR5：customPresets/zonePresetEntries 拆出的独立持久化域一并重置
  useCustomPresetStore.setState(useCustomPresetStore.getInitialState(), true)
  usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
  useWorkspaceEntityStore.setState(useWorkspaceEntityStore.getInitialState(), true)
  getRendererSettingsStore().setSessionPreview({})
  getRendererSettingsStore().reset()
  // #520 S2-P1-1：统一 sessionUi 注册表（原 chat/sessionUiState 的继任者）一并清场
  sessionUiStore.clearAll()
}
