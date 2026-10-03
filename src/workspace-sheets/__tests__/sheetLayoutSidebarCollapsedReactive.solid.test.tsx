// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * I09-A-FE-01（L1：响应式 SheetContext，6.10 问题 #4 等级 1）
 * + #154 改写：折叠可见性从「各 Sheet 自己加 collapsed 类」收归布局层状态。
 *
 * 旧观察点是 `Sidebar` 的 `<aside className="sidebar collapsed">`——每个 Sheet 各持
 * 一份折叠类，这正是分割线对不齐的成因。新观察点是布局层唯一状态
 * `.layout[data-sidebar="expanded" | "collapsed"]`：它同时驱动唯一宽度真值
 * （--sheet-sidebar-track-width）、唯一竖直分割线与内部可见性。
 *
 * 被测风险不变，且更集中：sidebarCollapsed 变化后必须**立即**反映到布局状态，
 * 不能依赖 buildSheetContext 里 getState() 的陈旧快照（ISSUE-09.md 施工点 2）。
 *
 * #515：迁移自 sheetLayoutSidebarCollapsedReactive.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - `render(<SheetLayout/>)` → `render(() => <SheetLayout/>)`，实体直连 SheetLayout.solid.tsx；
 * - `act(() => setLeftRailCollapsed(...)/focusSheet(...))` → 直接调用 store action
 *   （Solid 无 act；布局状态经 createZustandSignal 订阅同步落 DOM——本测试的被测点
 *   恰是「立即响应」，同步落盘即断言即见；#538 起折叠真源在 layoutRailsStore，
 *   workspaceStore 侧的镜像 setter 已退役）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 几何/DOM 断言逐字保留（data-sidebar 值、.left-rail-resize-handle 存在性、
 *   .sidebar/.file-sidebar 跨 Sheet 共享同一折叠状态）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import SheetLayout from '../SheetLayout.solid.tsx'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { useRightRailStore } from '../../domains/workspace/layoutRailsStore'
import { resetStores } from '../../test/resetStores'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

function renderLayout() {
  return render(() => (
    <SheetLayout
      activeSession={null}
      onSelectSession={() => {}}
      onProfileEdit={() => {}}
      onSessionSettings={() => {}}
    />
  ))
}

const layoutOf = (container: HTMLElement) => container.querySelector('.layout') as HTMLElement

describe('I09-A-FE-01 / #154 SheetLayout sidebarCollapsed 响应式订阅', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('sidebarCollapsed 变化后布局状态立即响应（不经 getState 旧快照）', async () => {
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    expect(agentId).not.toBeNull()
    useWorkspaceStore.getState().focusSheet(agentId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'expanded')

    // 折叠：若 SheetLayout 仅 getState() 快照（不订阅），此处不重渲染 → 状态不翻转
    useRightRailStore.getState().setLeftRailCollapsed(true)
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'collapsed')

    // 展开：响应式订阅同样立即可见
    useRightRailStore.getState().setLeftRailCollapsed(false)
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'expanded')
  })

  it('拖拽手柄只在左列可见时存在（折叠后不残留热区）', async () => {
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    useWorkspaceStore.getState().focusSheet(agentId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.left-rail-resize-handle')).toBeTruthy(), { timeout: 10_000 })
    useRightRailStore.getState().setLeftRailCollapsed(true)
    expect(container.querySelector('.left-rail-resize-handle')).toBeNull()
  })

  it('FileSheet 与 AgentSheet 共享同一折叠状态（同一布局状态，不是两份 Sheet 私有类）', async () => {
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    const fileId = useWorkspaceStore.getState().openSheet({ kind: 'file', title: 'Files', singletonKey: 'file:workspace' })
    expect(agentId).not.toBeNull()
    expect(fileId).not.toBeNull()
    useWorkspaceStore.getState().focusSheet(fileId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.file-sidebar')).toBeTruthy(), { timeout: 10_000 })
    useRightRailStore.getState().setLeftRailCollapsed(true)
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'collapsed')

    useWorkspaceStore.getState().focusSheet(agentId!)
    await waitFor(() => expect(container.querySelector('.sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'collapsed')

    useRightRailStore.getState().setLeftRailCollapsed(false)
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'expanded')

    useWorkspaceStore.getState().focusSheet(fileId!)
    await waitFor(() => expect(container.querySelector('.file-sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'expanded')
  })
})
