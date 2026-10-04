
/**
 * 左栏模块的**顺序与显隐**偏好。
 *
 * 与 `sidebarBlockState`（每 Sheet 的折叠/当前页面）分开：模块怎么排、哪些显示是
 * **跨 Sheet 的界面偏好**，跟具体某个 Sheet 无关——放在每 Sheet 的状态里会导致
 * 换个 Sheet 就换一套排布。
 *
 * 独立 localStorage key——A-V12 收敛前的存量手写读写器（新偏好字段一律走域内
 * persist（Solid 内核），不再新增本形状），**不写进 ADR-0009 锁定的
 * `pylon-workspace-layout-v3`**，避免动那个被契约钉住的持久化面。
 */

export const SIDEBAR_MODULES_STORAGE_KEY = 'pylon-sidebar-modules-v1'

export interface SidebarModulePrefs {
  /** 模块 id 的显式次序；未列出的模块按注册顺序接在后面。 */
  readonly order: readonly string[]
  /** 被用户隐藏的模块 id。`alwaysOpen` 的模块不受它影响。 */
  readonly hidden: readonly string[]
}

export const EMPTY_MODULE_PREFS: SidebarModulePrefs = Object.freeze({ order: Object.freeze([]), hidden: Object.freeze([]) })

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function readIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return Object.freeze([...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))])
}

export function normalizeModulePrefs(raw: unknown): SidebarModulePrefs {
  if (raw && typeof raw === 'object') {
    const value = raw as { order?: unknown; hidden?: unknown }
    return Object.freeze({ order: readIds(value.order), hidden: readIds(value.hidden) })
  }
  return EMPTY_MODULE_PREFS
}

export function readModulePrefs(storage: StorageLike): SidebarModulePrefs {
  try {
    const raw = storage.getItem(SIDEBAR_MODULES_STORAGE_KEY)
    return raw == null ? EMPTY_MODULE_PREFS : normalizeModulePrefs(JSON.parse(raw))
  } catch {
    return EMPTY_MODULE_PREFS
  }
}

export function writeModulePrefs(storage: StorageLike, prefs: SidebarModulePrefs): void {
  try {
    storage.setItem(SIDEBAR_MODULES_STORAGE_KEY, JSON.stringify({ order: [...prefs.order], hidden: [...prefs.hidden] }))
  } catch {
    // 存储不可用：静默（内存态仍生效）
  }
}

/**
 * 偏好排序只消费 `id` 与 `alwaysOpen`，因此领域层声明这个最小形状自持——
 * 不反向依赖 plugin-runtime 的贡献契约（A17 R2：projector 禁 import plugin-runtime）。
 */
export interface SidebarModuleLike {
  readonly id: string
  readonly alwaysOpen?: boolean
}

/**
 * 把偏好套到注册表快照上：先按显式次序，再把未列出的模块按注册顺序接在后面
 * （新装的模块因此总是落在末尾，可预期；`order` 只决定初次顺序）。
 *
 * `alwaysOpen` 的模块**不可隐藏**——隐藏了左栏就少了主体。
 *
 * 并且**钉在栈底**（用户要求「始终位于模块最下方」）：用户拖拽写下的次序同样受这条约束，
 * 否则「会话在最后」会随一次拖拽漂移，分界也跟着漂。钉序在这里统一收敛——渲染、拖拽落库、
 * 设置页都从这里取次序，因此旧偏好里把常驻模块排在前面的值也会被纠正回来。
 */
export function applyModulePrefs<T extends SidebarModuleLike>(
  contributions: readonly T[],
  prefs: SidebarModulePrefs,
): readonly T[] {
  const byId = new Map(contributions.map(contribution => [contribution.id, contribution]))
  const ranked = prefs.order.filter(id => byId.has(id))
  const rankedSet = new Set(ranked)
  const rest = contributions.filter(contribution => !rankedSet.has(contribution.id)).map(contribution => contribution.id)
  const hidden = new Set(prefs.hidden)
  const ordered = [...ranked, ...rest]
    .map(id => byId.get(id)!)
    .filter(contribution => contribution.alwaysOpen === true || !hidden.has(contribution.id))
  const pinned = ordered.filter(contribution => contribution.alwaysOpen === true)
  if (pinned.length === 0) return ordered
  const movable = ordered.filter(contribution => contribution.alwaysOpen !== true)
  return [...movable, ...pinned]
}

/** 把 `fromId` 移动到 `toId` 的位置，产出新的完整次序（拖拽落点用）。 */
export function reorderModuleIds(
  sequence: readonly string[],
  fromId: string,
  toId: string,
): readonly string[] {
  const from = sequence.indexOf(fromId)
  const to = sequence.indexOf(toId)
  if (from < 0 || to < 0 || from === to) return sequence
  const next = [...sequence]
  next.splice(from, 1)
  next.splice(to, 0, fromId)
  return Object.freeze(next)
}

interface ModulePrefsStore {
  prefs: SidebarModulePrefs
  setPrefs(next: SidebarModulePrefs): void
}

const listeners = new Set<() => void>()
let prefs: SidebarModulePrefs = typeof localStorage === 'undefined' ? EMPTY_MODULE_PREFS : readModulePrefs(localStorage)

function emit(): void {
  for (const listener of listeners) listener()
}

/** 模块偏好是进程级单一真值：侧栏渲染、拖拽落库、设置页显隐共用它。 */
export const sidebarModulePrefsStore: ModulePrefsStore & { subscribe(listener: () => void): () => void; getSnapshot(): SidebarModulePrefs } = {
  get prefs() { return prefs },
  setPrefs(next) {
    prefs = next
    if (typeof localStorage !== 'undefined') writeModulePrefs(localStorage, next)
    emit()
  },
  subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot() { return prefs },
}

/** 测试与「恢复默认」用：重置内存与持久化。 */
export function resetModulePrefs(next: SidebarModulePrefs = EMPTY_MODULE_PREFS): void {
  prefs = next
  if (typeof localStorage !== 'undefined') writeModulePrefs(localStorage, next)
  emit()
}

