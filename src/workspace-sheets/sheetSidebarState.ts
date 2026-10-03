import type { SheetRecord } from './sheetTypes.ts'
import { resolveSheetRender } from './sheetRegistry.ts'

/**
 * #154：布局层是否会为这个 Sheet 渲染左列。
 *
 * 判据是 `sidebarMode`（`'workspace'` / `'sheet'` 两类都渲染左列；`'none'` 显式不要）。
 * 不要用「注册表是否声明了 `sidebar` 组件」判——`sidebar:` 只是把*内容*交给布局层
 * 渲染的通道（agent 走这条），其余 7 个 kind 由各自的视图渲染左栏内容。两者都要求
 * 那个左列外壳挂共享几何类 `.sidebar`，这正是 `src/sheets/__tests__/SheetInternalSidebars`
 * 与 `src/workspace-sheets/__tests__/sidebarUnifiedModel.css.test.ts` 钉住的契约。
 *
 * 本函数是 App（标题栏轨道是否占位）与 SheetLayout（`data-sidebar` 状态）的**同一份**
 * 判据——两处各算一套会让标题栏与左列对「本 Sheet 有没有左栏」得出两个结论。
 */
export function sheetHasLeftColumn(sheet: SheetRecord | undefined): boolean {
  if (!sheet) return false
  const entry = resolveSheetRender(sheet.kind)
  if (!entry) return false
  return entry.sidebarMode !== 'none'
}

