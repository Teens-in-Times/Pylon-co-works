/** @jsxImportSource solid-js */
import { createMemo, Show } from 'solid-js'
import { useThemeStore } from '../domains/theme/themeStore'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import type { SheetContext, SheetRecord } from './sheetTypes'
import { resolveSheetRender } from './sheetRegistry.ts'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from '../plugin-runtime/workspaces/workspaceRegistry'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'

/**
 * 根据活动 Sheet 的注册表贡献选择左栏；缺少贡献、主题关闭或反序列化失败时不挂载。
 * 以 Sidebar 组件身份作为 keyed Show 的键：贡献替换时重挂，ctx/state 更新时复用实例。
 * 布局层拥有轨道宽度、拖拽与 data-sidebar 折叠状态；各贡献的 .sidebar 外壳由工作区
 * 样式统一呈现边界。本槽只负责贡献生命周期，不另设几何或折叠真值。
 */
export default function SheetSidebarSlot(props: { sheet: SheetRecord; ctx: SheetContext }) {
  const showSidebar = createZustandSignal(useThemeStore, s => s.showSidebar !== false)
  const registry = createRegistrySignal({ subscribe: subscribeWorkspaceRegistry }, getWorkspaceRegistrySnapshot)
  type SidebarEntry = NonNullable<NonNullable<ReturnType<typeof resolveSheetRender>>['sidebar']>
  const resolvedSidebar = createMemo<SidebarEntry | null>(() => {
    try {
      registry()
      if (!showSidebar()) return null
      const entry = resolveSheetRender(props.sheet.kind)
      if (!entry?.sidebar) return null
      entry.deserialize(props.sheet.state)
      return entry.sidebar
    } catch {
      return null
    }
  })
  const sidebarState = createMemo<unknown>(() => {
    try {
      const entry = resolveSheetRender(props.sheet.kind)
      return entry ? entry.deserialize(props.sheet.state) : null
    } catch {
      return null
    }
  })
  return (
    <Show when={resolvedSidebar()} keyed>
      {Sidebar => <Sidebar sheet={props.sheet} ctx={props.ctx} state={sidebarState()} />}
    </Show>
  )
}
