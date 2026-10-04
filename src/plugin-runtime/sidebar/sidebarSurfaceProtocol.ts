import type {
  AgentSidebarPresentation,
} from './sidebarTypes.ts'

/**
 * 左栏模块（`AgentSidebarContribution`）**隔离面**的 wire 协议（`renderKind: 'isolated-surface'`）。
 *
 * 真源纪律：宿主渲染器（`Sidebar.solid.tsx` block 体量 / `AgentSheetPageHost.solid.tsx`
 * page 体量）以
 * `satisfies` 挂本类型，经 `IsolatedPluginSurface` 的 `host:input` 通道推送（每次 input
 * 变化重放一次）；插件侧从 SDK 引用同一类型解析 input，按 `SIDEBAR_SURFACE_EVENTS`
 * 词表回传事件。字段全部是**跨隔离边界可序列化的投影**——不含宿主回调（那是第一方
 * （first-party-solid）实体的 props 面，见 `AgentSidebarContributionProps`）。
 */

/** 会话投影项（wire 最小面：列表渲染 + 定位所需，不含状态机字段）。 */
export interface AgentSidebarSurfaceSession {
  readonly id: string
  readonly name: string
  /** 散会话（不属于任何工作区）缺省。 */
  readonly workspaceId?: string
}

/** 工作区投影项。 */
export interface AgentSidebarSurfaceWorkspace {
  readonly id: string
  readonly name: string
  readonly rootPath: string
}

/** 区块头动作的一次投递。`nonce` 由宿主递增：同一 action 两次点击 nonce 不同，用于去重回放。 */
export interface AgentSidebarSurfaceBlockAction {
  readonly actionId: string
  readonly nonce: number
}

/** `host:input` 推送的模块输入。block 与 page 共用同一形状（差异字段可选）。 */
export interface AgentSidebarSurfaceInput {
  /** 仅 page 体量携带：页面搜索框当前词（宿主头部渲染，插件按需消费）。 */
  readonly query?: string
  readonly activeAgentId: string
  readonly activeSessionId: string | null
  /** 体量标记：`block` 是左栏模块里的小样，`page` 是展开到主区的整页（同一贡献两种密度）。 */
  readonly presentation: AgentSidebarPresentation
  /** 宿主拥有折叠状态；`page` 体量恒为 `false`。 */
  readonly collapsed: boolean
  /** 本模块的整页当前是否被打开（block 体量内据此决定「打开」态呈现）。 */
  readonly pageOpen: boolean
  /** 头部动作投递；无动作时 `null`。 */
  readonly blockAction: AgentSidebarSurfaceBlockAction | null
  readonly sessions: readonly AgentSidebarSurfaceSession[]
  readonly workspaces: readonly AgentSidebarSurfaceWorkspace[]
}

/** 模块可回传的宿主事件词表（`bridge.emit(event, detail)`；detail 形状见注释）。 */
export const SIDEBAR_SURFACE_EVENTS = [
  /** detail: 会话 id（string）——选中会话 */
  'host:select-session',
  /** detail: 无——新建散会话 */
  'host:create-loose-session',
  /** detail: 工作区 id（string）——在该工作区内新建会话 */
  'host:create-workspace-session',
  /** detail: 会话 id（string）——打开会话设置 */
  'host:open-session-settings',
] as const

export type SidebarSurfaceEvent = (typeof SIDEBAR_SURFACE_EVENTS)[number]
