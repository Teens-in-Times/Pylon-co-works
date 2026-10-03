/** Single read boundary for legacy identity/workspace layout keys. */
export const PERSISTENCE_KEY_OWNERS = Object.freeze({
  'pylon-profiles': { owner: 'identity', authority: 'sqlite', fallback: 'localStorage', version: 1 },
  'pylon-sessions': { owner: 'identity', authority: 'sqlite', fallback: 'localStorage', version: 2 },
  'pylon-workspace-sheets': { owner: 'workspace', authority: 'localStorage', fallback: 'defaults', version: 2 },
  // ADR-0009 键名钉死不变；envelope version 4（#483 起 showPet 字段已随宠物链退役，
  // 版本号不回退——v3 migrate 仍服务布局字段）。
  'pylon-workspace-layout-v3': { owner: 'right-rail', authority: 'localStorage', fallback: 'legacy-layout', version: 4 },
  'pylon-settings-chrome': { owner: 'settings-chrome', authority: 'localStorage', fallback: 'defaults', version: 1 },
  'pylon-right-rail': { owner: 'right-rail', authority: 'legacy', fallback: 'defaults', version: 1 },
  // #483：'pylon-workspace-show-pet' 随宠物链退役——旧 key 成为无害孤儿，不再登记。
  'pylon-settings-density': { owner: 'settings-chrome', authority: 'legacy', fallback: 'defaults', version: 1 },
  'pylon-settings-preview-collapsed': { owner: 'settings-chrome', authority: 'legacy', fallback: 'defaults', version: 1 },
  'pylon-settings-collapse': { owner: 'settings-chrome', authority: 'legacy', fallback: 'defaults', version: 1 },
  'pylon-settings-pinned': { owner: 'settings-chrome', authority: 'legacy', fallback: 'defaults', version: 1 },
  'pylon-theme': { owner: 'theme', authority: 'localStorage', fallback: 'defaults', version: 4 },
} as const)

/** Written after the application bootstrap has committed all legacy migrations. */
export const PERSISTENCE_MIGRATION_MARKER = 'pylon-persistence-migration-v1'

export interface LegacyLayoutSnapshot {
  rightWidth?: number
  leftWidth?: number
  rightCollapsed?: boolean
  leftCollapsed?: boolean
}

const RIGHT_MIN = 220
const RIGHT_MAX = 560
const LEFT_MIN = 160
const LEFT_MAX = 520
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
// 先 round 再夹取（legacy 迁移域：旧值可能是小数宽度）——与 ccLayoutState 的 clampFinite（非有限落 0）语义不同，勿混用。
const clampRound = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)))

function readJson(storage: Pick<Storage, 'getItem'>, key: string): unknown {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    // A malformed key must not hide valid values from the other legacy owners.
    return undefined
  }
}

/** Reads all legacy layout keys once, with deterministic precedence and field-level fallback. */
export function readLegacyLayoutSnapshot(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage, options: { ignoreMarker?: boolean } = {}): LegacyLayoutSnapshot {
  if (!storage) return {}
  // Once the marker is present, the versioned owners are authoritative.  Do
  // not let a stale legacy key re-enter the state during a later HMR/module
  // evaluation or after a partial storage restore.  Exception: #538 升级缝
  // （workspaceStore hydrate 检测 v3 键缺席）需要绕过标记补读一次，见调用点。
  try {
    if (!options.ignoreMarker && storage.getItem(PERSISTENCE_MIGRATION_MARKER) === '1') return {}
  } catch { /* storage may be readable only through individual keys */ }

  const railValue = readJson(storage, 'pylon-right-rail') as { state?: { width?: unknown } } | undefined
  const workspaceValue = readJson(storage, 'pylon-workspace-sheets') as { layout?: Record<string, unknown> } | undefined
  const themeValue = readJson(storage, 'pylon-theme') as { state?: Record<string, unknown> } | undefined
  const railState = railValue?.state
  const workspaceLayout = workspaceValue?.layout
  const themeState = themeValue?.state
  const rightWidth = finite(railState?.width)
    ? clampRound(railState.width, RIGHT_MIN, RIGHT_MAX)
    : finite(themeState?.rightWidth)
      ? clampRound(themeState.rightWidth, RIGHT_MIN, RIGHT_MAX)
      : undefined
  const leftWidth = finite(workspaceLayout?.sidebarWidth)
    ? clampRound(workspaceLayout.sidebarWidth, LEFT_MIN, LEFT_MAX)
    : finite(themeState?.sidebarWidth)
      ? clampRound(themeState.sidebarWidth, LEFT_MIN, LEFT_MAX)
      : undefined
  return {
    ...(rightWidth === undefined ? {} : { rightWidth }),
    ...(leftWidth === undefined ? {} : { leftWidth }),
    ...(typeof workspaceLayout?.rightPanelCollapsed === 'boolean' ? { rightCollapsed: workspaceLayout.rightPanelCollapsed } : {}),
    ...(typeof workspaceLayout?.sidebarCollapsed === 'boolean' ? { leftCollapsed: workspaceLayout.sidebarCollapsed } : {}),
  }
}

export function markLegacyMigrationComplete(storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem(PERSISTENCE_MIGRATION_MARKER, '1') } catch { /* best effort */ }
}
