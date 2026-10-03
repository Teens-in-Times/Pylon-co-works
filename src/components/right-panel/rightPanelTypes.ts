import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'

// ── right-panel 域共享 props 类型（纯类型、零 JSX 的中立落点，
//    实体间互不把对方的 JSX 拉进自己的编译面）──

/** MessageSearchBar 的 props。 */
export interface MessageSearchBarProps {
  query: string
  matchIndex: number
  matchCount: number
  onQueryChange: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}

/** AgentContextPanel 的 props。 */
export interface AgentContextPanelProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/** ContextPanelHost 的 props。 */
export interface ContextPanelHostProps {
  sheet: SheetRecord
  ctx: SheetContext
  activePanelId?: string | null
}

/**
 * RightRailHost 的 props。
 */
export interface RightRailHostProps {
  sheet: SheetRecord | null
  ctx: SheetContext
  activeAgent?: string
}

/** Backend-agnostic data used to render the Workspace tree. */
export type { WorkspaceEntry, WorkspaceTextPreview, WorkspaceTree } from '../../contracts/workspaceFiles.ts'
