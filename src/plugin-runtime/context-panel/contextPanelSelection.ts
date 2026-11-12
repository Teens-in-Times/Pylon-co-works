import type {
  ContextPanelContributionContext,
  ContextPanelRegistryEntry,
} from './contextPanelTypes.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'

const reportedWhenFailures = new WeakSet<NonNullable<ContextPanelRegistryEntry['value']['when']>>()

/**
 * 当前上下文下**可以显示**的右栏面板（chrome、布局槽与宿主共用同一条选择器）。
 *
 * `workspaceKind` 表达默认选中的亲和性；可用性由 `when` 声明，不由宿主猜测。
 * 内置上下文/文件关联通过 `when` 限定匹配工作区，插件可提供跨工作区的面板。
 * 没有活动 Sheet 时只保留显式 global 贡献，避免无意义的上下文空壳占宽。
 */
export function selectContextPanels(
  entries: readonly ContextPanelRegistryEntry[],
  context: ContextPanelContributionContext,
): readonly ContextPanelRegistryEntry[] {
  return entries.filter(entry => {
    // With no active Sheet only explicitly global contributions have a context to render.
    if (context.sheetId === null && entry.value.scope !== 'global') return false
    try {
      return entry.value.when?.(context) ?? true
    } catch (error) {
      const predicate = entry.value.when
      if (predicate && !reportedWhenFailures.has(predicate)) {
        reportedWhenFailures.add(predicate)
        reportRuntimeError(`右栏贡献 ${entry.contributionId} 判断可用性`, error)
      }
      return false
    }
  })
}

/**
 * 用户没有显式选择过面板时，右栏默认显示谁。
 *
 * 优先级：声明了**当前 Sheet 种类**的面板（`workspaceKind` 的亲和语义）→ 第一个 `global`
 * 面板 → 列表第一个。用户一旦在切换器里选过，`rightRailStore.activePanelId` 就是显式选择，
 * 跨 Sheet 保持——切 Sheet 不该把用户刚选的栏抢回默认值。
 */
export function resolveContextPanelDefault(
  entries: readonly ContextPanelRegistryEntry[],
  workspaceKind: string | undefined,
): ContextPanelRegistryEntry | undefined {
  if (workspaceKind) {
    const affine = entries.find(entry => entry.value.workspaceKind === workspaceKind)
    if (affine) return affine
  }
  return entries.find(entry => entry.value.scope === 'global') ?? entries[0]
}
