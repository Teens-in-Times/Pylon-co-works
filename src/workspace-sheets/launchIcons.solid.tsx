/** @jsxImportSource solid-js */
import { LucideIcon } from '../components/LucideIcon.solid.tsx'
import { type LaunchIconKey } from './launchIconKeys.ts'

/**
 * 稳定图标键 → 图标的唯一映射（Solid 终态；键表 ./launchIconKeys.ts 编译期穷举，防漂移）。
 *
 * 由 **Workspace launch 项**（SheetLauncher.solid）消费；未知键安全降级为通用图标。
 */
export const LAUNCH_ICONS: Readonly<Record<LaunchIconKey, string>> = {
  activity: 'Activity',
  agent: 'Bot',
  'book-open': 'BookOpen',
  boxes: 'Boxes',
  clock: 'Clock',
  'folder-tree': 'FolderTree',
  globe: 'Globe',
  history: 'History',
  'layout-dashboard': 'LayoutDashboard',
  messages: 'MessageSquare',
  plus: 'Plus',
  search: 'Search',
  settings: 'Settings',
  sliders: 'SlidersHorizontal',
  waypoints: 'Waypoints',
}

/** 图标键 → lucide 核心 PASCAL 图标名（未知键安全降级为通用图标 square-stack）。 */
export function resolveLaunchIconName(icon?: string): string {
  return (icon && LAUNCH_ICONS[icon as LaunchIconKey]) || 'SquareStack'
}

export function resolveLaunchIcon(icon?: string): (props: { size?: number; strokeWidth?: number; class?: string }) => ReturnType<typeof LucideIcon> {
  const name = resolveLaunchIconName(icon)
  return iconProps => LucideIcon({ ...iconProps, name })
}
