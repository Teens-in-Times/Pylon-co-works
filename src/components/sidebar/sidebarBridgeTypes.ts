/**
 * sidebarBridgeTypes — sidebar 域共享 props 类型的中立落点。
 *
 * 纯类型、零 JSX、零框架依赖；实体（.solid.tsx）与纯 ts 模块互不把对方的
 * JSX 拉进自己的编译面，共享 props 类型一律放本文件、双方 import 这份唯一事实。
 */
import type { SheetContext } from '../../workspace-sheets/sheetTypes.ts'
import type { AgentSidebarContribution } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/** AgentSheetPageHost 的 props。 */
export interface AgentSheetPageHostProps {
  page: AgentSidebarContribution
  ctx: SheetContext
  sheet: { id: string }
}
