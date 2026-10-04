/**
 * skinRuntimeServices — SkinRuntime 前端单例与 Theme Store 基线接线（阶段 5 S5-C）。
 *
 * 唯一 SkinRuntime 实例由本模块持有；Solid 组件经信号订阅，
 * 禁止各组件自建 Runtime 或直接 useThemeStore.setState 驱动皮肤。
 */
import { SkinRuntime } from '../../plugin-runtime/skin/skinRuntime.ts'
import { logWarn } from '../../contracts/frontendLogSink.ts'
import { DEFAULTS } from '../../domains/theme/themeDefaults.ts'
import { THEME_SETTING_KEYS } from '../../domains/theme/themeFieldDefs.ts'
import {
  loadSkinState,
  persistSkinState,
  restoreSkinState,
  type SkinStorage,
} from './skinPersistence.ts'

const skinRuntime = new SkinRuntime()

/** 启动时把 DEFAULTS 作为默认 global 基线（Theme Store 水合后由 App 覆盖） */
skinRuntime.setGlobalBaseline(DEFAULTS as unknown as Record<string, unknown>)

export function getSkinRuntime(): SkinRuntime {
  return skinRuntime
}

/** 启动恢复：按当前 schema 清洗 pylon-skins；失败时保留当前 Theme Store 外观并返回可诊断错误 */
export function restoreSkinFromStorage(storage?: SkinStorage): string | undefined {
  try {
    const target = storage ?? (globalThis as { localStorage?: SkinStorage }).localStorage
    if (!target) return 'localStorage 不可用'
    const loaded = loadSkinState(target, skinRuntime.schemaSnapshot())
    if (loaded.state) restoreSkinState(skinRuntime, loaded.state)
    return loaded.error
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** commit/rollback/binding 变化后把 committed skins/bindings/drafts 写入 pylon-skins */
export function bindSkinPersistence(storage?: SkinStorage): () => void {
  const target = storage ?? (globalThis as { localStorage?: SkinStorage }).localStorage
  if (!target) return () => {}

  const persist = () => {
    try {
      persistSkinState(target, skinRuntime)
    } catch (error) {
      logWarn('pylon-skins 持久化失败', error)
    }
  }
  return skinRuntime.subscribe(persist)
}

/** 从 Theme Store 提取 Skin 基线字段（只取 THEME_SETTING_KEYS 白名单，不带 actions） */
export function pickThemeBaseline(state: Record<string, unknown>): Record<string, unknown> {
  const baseline: Record<string, unknown> = {}
  for (const key of THEME_SETTING_KEYS) baseline[key] = state[key]
  return baseline
}
