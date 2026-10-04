/** @jsxImportSource solid-js */
import { For, Show, type JSX } from 'solid-js'
import type { FileActivityContribution } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { WorkbenchIcon } from './fileIcons.solid.tsx'

/**
 * FileSheetSidebarProps — 名字承自历史 React 契约（FileSheetSidebar.tsx，已退役）；本实体即唯一真源。
 */
interface FileSheetSidebarProps {
  activeSection: string
  activities: readonly FileActivityContribution[]
  collapsed: boolean
  onSelectSection: (section: string) => void
  children?: JSX.Element
}

const ICON_NAMES: Record<FileActivityContribution['icon'], string> = {
  sessions: 'MessageSquare',
  files: 'Files',
  search: 'Search',
  scm: 'GitBranch',
  views: 'Clock3',
}

/**
 * FileSheetSidebar — 左列内容（#154：宽度/竖直分割线/折叠可见性归布局层的 .sidebar）。
 * #515 Solid 实体；原 React 原件（FileSheetSidebar.tsx）已随批7 退役
 * （唯一消费者 FileSheetView 直连本实体）。
 */
export default function FileSheetSidebar(props: FileSheetSidebarProps) {
  const selected = () => props.activities.find(activity => activity.id === props.activeSection) ?? props.activities[0]

  // I09-A-FE-02：折叠由 titlebar 统一控制（ctx.sidebarCollapsed），点击分区图标不再触发展开/收起
  const selectSection = (section: string) => {
    props.onSelectSection(section)
  }

  return (
    <aside class="sidebar file-sidebar">
      <nav class="file-activity-bar" aria-label="FileSheet 分区">
        <For each={props.activities}>{activity => (
          <button
            type="button"
            class={`file-activity-item ${props.activeSection === activity.id ? 'active' : ''}`}
            onClick={() => selectSection(activity.id)}
            title={`${activity.label}：${activity.description}`}
            aria-label={`${activity.label}：${activity.description}`}
          >
            <span class="file-activity-icon" aria-hidden="true">
              <WorkbenchIcon name={ICON_NAMES[activity.icon]} size={21} />
            </span>
          </button>
        )}</For>
      </nav>

      <Show when={!props.collapsed}>
        <div class="file-sidebar-panel">
          <header class="file-sidebar-header">
            <div>
              <span class="file-sidebar-kicker">{selected()?.label ?? '能力不可用'}</span>
              <strong>{selected()?.description ?? '插件已停用，请选择其他分区'}</strong>
            </div>
          </header>

          <div class="file-section-content">{props.children}</div>
        </div>
      </Show>
    </aside>
  )
}
