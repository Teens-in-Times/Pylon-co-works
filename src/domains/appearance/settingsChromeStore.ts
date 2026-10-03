/**
 * settingsChromeStore — 设置页 chrome 态真值源（A-V12 持久化收敛）。
 *
 * 原 components/settings/settingsChromeState.ts 的四个手写 localStorage key
 * （密度档 / 预览栏折叠 / 折叠记忆 / 收藏置顶）收敛为**域内 persist 单一机制**
 * （初为 zustand persist，#515 批0 起为 Solid 内核 attachSolidPersist；结构审查
 * A-V12：手写 localStorage / zustand persist / 域 envelope 三机制并存，
 * 新偏好字段没有统一落点）。设计约束不变（施工书 09 §K-1）：chrome 态是显示方式
 * 不是设置项，不进 defs/schema/theme store。
 *
 * 旧 key 一次性搬家（首读时）：pylon-settings-{density,preview-collapsed,collapse,pinned}
 * → pylon-settings-chrome（envelope v1），搬完即删旧 key。
 */
import { attachSolidPersist, createSolidStoreKernel, type PersistStringStorage, type SolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'

export type SettingsDensity = 'basic' | 'standard' | 'all'
const DENSITIES: readonly SettingsDensity[] = ['basic', 'standard', 'all']

/** key: `${section}.${groupId}` → 是否折叠 */
export type CollapseMap = Record<string, boolean>

export const PINNED_LIMIT = 3

/** 密度过滤谓词（设计书 08 §四）：basic → 只显 tier:'basic'；standard → 非 advanced；all → 全可见。 */
export function visibleByDensity(
  density: SettingsDensity,
  field: { tier?: string; advanced?: boolean },
): boolean {
  if (density === 'all') return true
  if (density === 'basic') return field.tier === 'basic'
  return field.advanced !== true
}

/** 保序去重 + 上限截断（置顶收藏的规范化，写路径与迁移共用）。 */
export function normalizePinned(ids: readonly unknown[]): readonly string[] {
  const uniq: string[] = []
  for (const id of ids) {
    if (typeof id === 'string' && !uniq.includes(id)) uniq.push(id)
    if (uniq.length >= PINNED_LIMIT) break
  }
  return uniq
}

function normalizeDensity(raw: unknown): SettingsDensity {
  return typeof raw === 'string' && DENSITIES.includes(raw as SettingsDensity)
    ? (raw as SettingsDensity)
    : 'standard'
}

function normalizeCollapseMap(raw: unknown): CollapseMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const map: CollapseMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean') map[key] = value
  }
  return map
}

interface SettingsChromeState {
  density: SettingsDensity
  previewCollapsed: boolean
  collapsedMap: CollapseMap
  pinned: readonly string[]
  setDensity: (density: SettingsDensity) => void
  setPreviewCollapsed: (collapsed: boolean) => void
  setGroupCollapsed: (key: string, collapsed: boolean) => void
  togglePinned: (section: string) => void
}

/**
 * F2 边界加固：禁储/隐私模式下 localStorage 访问可能直接抛异常——
 * 存储适配层整体兜底（读失败返回 null、写失败静默，chrome 态丢失无害）。
 */
function safeLocalStorage(): Storage {
  try {
    const probe = '__pylon_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return localStorage
  } catch {
    const mem = new Map<string, string>()
    return {
      get length() { return mem.size },
      clear: () => { mem.clear() },
      getItem: k => mem.get(k) ?? null,
      key: i => [...mem.keys()][i] ?? null,
      removeItem: k => { mem.delete(k) },
      setItem: (k, v) => { mem.set(k, v) },
    }
  }
}

// ── 旧 key 一次性搬家（模块求值期执行一次；memory 兜底下天然空跑）──

interface LegacyChromeSeed {
  density?: SettingsDensity
  previewCollapsed?: boolean
  collapsedMap?: CollapseMap
  pinned?: readonly string[]
}

function migrateLegacySettingsChrome(storage: Storage): LegacyChromeSeed {
  const readJson = (key: string): unknown => {
    try {
      const raw = storage.getItem(key)
      return raw === null ? undefined : (JSON.parse(raw) as unknown)
    } catch {
      return undefined
    }
  }
  const seed: LegacyChromeSeed = {}
  const density = normalizeDensity(readJson('pylon-settings-density'))
  if (density !== 'standard') seed.density = density
  if (readJson('pylon-settings-preview-collapsed') === true) seed.previewCollapsed = true
  const collapsedMap = normalizeCollapseMap(readJson('pylon-settings-collapse'))
  if (Object.keys(collapsedMap).length > 0) seed.collapsedMap = collapsedMap
  const pinnedRaw = readJson('pylon-settings-pinned')
  if (Array.isArray(pinnedRaw)) {
    const pinned = normalizePinned(pinnedRaw)
    if (pinned.length > 0) seed.pinned = pinned
  }
  for (const key of [
    'pylon-settings-density',
    'pylon-settings-preview-collapsed',
    'pylon-settings-collapse',
    'pylon-settings-pinned',
  ]) {
    try { storage.removeItem(key) } catch { /* best effort */ }
  }
  return seed
}

const legacySeed = migrateLegacySettingsChrome(safeLocalStorage())
const hasLegacySeed = Object.keys(legacySeed).length > 0

// #515 批0：zustand → Solid 内核置换；W3 起 useSettingsChromeStore 即内核本体（直连，无 shim）。
const settingsChromeKernel = createSolidStoreKernel<SettingsChromeState>({
  density: 'standard',
  previewCollapsed: false,
  collapsedMap: {},
  pinned: [],
  setDensity: density => settingsChromeKernel.setState({ density: normalizeDensity(density) }),
  setPreviewCollapsed: previewCollapsed => settingsChromeKernel.setState({ previewCollapsed }),
  setGroupCollapsed: (key, collapsed) => settingsChromeKernel.setState({ collapsedMap: { ...settingsChromeKernel.getState().collapsedMap, [key]: collapsed } }),
  togglePinned: section => {
    const current = settingsChromeKernel.getState().pinned
    // 与旧 writePinned 语义一致：新置顶排在末尾，超限丢最旧（保最后 PINNED_LIMIT 个）。
    const next = current.includes(section)
      ? current.filter(id => id !== section)
      : [...current, section].slice(-PINNED_LIMIT)
    settingsChromeKernel.setState({ pinned: normalizePinned(next) })
  },
})

const safeLocalStorageWrapper: PersistStringStorage = (() => {
  const storage = safeLocalStorage()
  return {
    getItem: key => { try { return storage.getItem(key) } catch { return null } },
    setItem: (key, value) => { try { storage.setItem(key, value) } catch { /* 禁储静默 */ } },
    removeItem: key => { try { storage.removeItem(key) } catch { /* best effort */ } },
  }
})()

attachSolidPersist(settingsChromeKernel, {
  name: 'pylon-settings-chrome',
  version: 1,
  storage: safeLocalStorageWrapper,
  // 恒跑的 merge 负责规范化（zustand 只在版本号错位时才调 migrate——同版本损坏
  // envelope 也必须被收敛到合法形状，chrome 态缺省即兜底）。
  merge: (persisted, current) => {
    const state = (persisted && typeof persisted === 'object')
      ? persisted as Partial<SettingsChromeState>
      : {}
    return {
      ...current,
      density: normalizeDensity(state.density),
      previewCollapsed: state.previewCollapsed === true,
      collapsedMap: normalizeCollapseMap(state.collapsedMap),
      pinned: normalizePinned(Array.isArray(state.pinned) ? state.pinned : []),
    }
  },
  partialize: state => ({
    density: state.density,
    previewCollapsed: state.previewCollapsed,
    collapsedMap: state.collapsedMap,
    pinned: state.pinned,
  }),
})

export const useSettingsChromeStore: SolidStoreKernel<SettingsChromeState> = settingsChromeKernel

// 首跑搬家：legacy 值存在 ⇒ 写穿新 envelope（persist 同步落盘），旧 key 已在上文删除。
if (hasLegacySeed) {
  useSettingsChromeStore.setState({ ...legacySeed })
}
