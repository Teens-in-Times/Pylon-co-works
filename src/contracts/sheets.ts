/**
 * sheets — Sheet/Workspace 记录与布局上下文契约（自 workspace-sheets/sheetTypes 抽出）。
 *
 * 纯类型中立落点：workspace-sheets（视图实现）与 plugin-runtime（workspace registry、
 * context-panel/file-workbench 贡献契约）共用同一份形状，消除 runtime→视图目录的
 * 类型反向依赖（结构审查 B-2/A 域外指涉）。SheetContext.sessionBySource 对身份域
 * Session 为 type-only 引用（契约层纪律只禁 UI 框架与 components/ 实现依赖）。
 */
import type { Session } from '../domains/identity/identityStore.ts'

export type SheetKind = string

export type SheetId = string

export interface SheetRecord {
  id: SheetId
  kind: SheetKind
  title: string
  agentId?: string
  singletonKey?: string
  pinned?: boolean
  createdAt: number
  lastFocusedAt: number
  metadata?: Record<string, string>
  /** Workspace type definition 序列化后的插件状态；内存与持久化共用稳定 wire 形态。 */
  state?: unknown
}

export interface SheetInput {
  id?: SheetId
  kind: SheetKind | string
  title: string
  agentId?: string
  singletonKey?: string
  pinned?: boolean
  metadata?: Record<string, string>
  /** 传给 WorkspaceTypeDefinition.createInitialState 的插件输入。 */
  state?: unknown
}

// ── W1-02：SheetContext（布局上下文）——只含「sheet 无法自己获得、必须由布局层给」的东西 ──

export interface SheetContext {
  // sheet 间导航（F1-D 联动的公开面）
  openSheet: (input: SheetInput) => SheetId | null
  focusSheet: (id: SheetId) => void
  closeSheet: (id: SheetId) => void
  // 会话选择（profile 投影状态机配套——App.tsx 现有 effect 链的宿主）
  activeSession: string | null
  selectSession: (id: string | null) => void
  // 对话框打开器（保留 App 单例挂载语义）
  openProfileEdit: () => void
  openSessionSettings: (id: string) => void
  // 布局态（布局层所有，sheet 只读）
  sidebarCollapsed: boolean
  rightInset: number
  /**
   * 当前 Sheet 是否位于活动主区。原生子 WebView 不受父 DOM 的 display:none
   * 影响，因此 Browser Sheet 用这个只读标记同步 show/hide；旧调用方省略时
   * 按活动态处理，保持第三方/测试上下文兼容。
   */
  isActive?: boolean
  // source 解析（identity sessionId ↔ ACP source 唯一换算口，禁止 sheet 自写 find）
  sessionSource: (sessionId: string | null) => string | null
  sessionBySource: (source: string) => Session | undefined
}

/** I09-A-FE-01：Sheet 左栏能力（方案 A，ISSUE-09.md）——'workspace'=布局层公共左栏 / 'sheet'=Sheet 内部自绘侧栏 / 'none'=无侧栏 */
export type SidebarMode = 'workspace' | 'sheet' | 'none'
