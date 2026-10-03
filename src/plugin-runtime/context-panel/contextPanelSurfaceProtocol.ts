/**
 * 右栏上下文面板（`ContextPanelContribution`）**隔离面**的 wire 协议
 * （`renderKind: 'isolated-surface'`）。
 *
 * 真源纪律：宿主渲染器（`ContextPanelHost.solid.tsx`）以 `satisfies` 挂本类型，经
 * `IsolatedPluginSurface` 的 `host:input` 通道推送（每次 input 变化重放一次，因此
 * settings 值回流天然走同一通道）；插件侧从 SDK 引用同一类型解析 input，按
 * `CONTEXT_PANEL_SURFACE_EVENTS` 词表回传事件。字段全部是**跨隔离边界可序列化的
 * 投影**——第一方（first-party-solid）实体的完整 props 见 `ContextPanelContributionProps`。
 */

/** 当前 Sheet 的投影（wire 最小面；完整 SheetRecord 含持久化/状态机字段，不跨边界）。 */
export interface ContextPanelSurfaceSheet {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly agentId?: string
  readonly metadata?: Record<string, string>
}

/** `host:input` 推送的面板输入。 */
export interface ContextPanelSurfaceInput {
  /** 当前 Sheet 种类（2.2 起为自动选中的亲和，不再是可用性闸门）。 */
  readonly workspaceKind: string
  readonly sheet: ContextPanelSurfaceSheet
  /** 当前激活会话；无会话时 `null`。 */
  readonly activeSessionId: string | null
  /**
   * 面板 settings 适配器的当前值快照（声明了 `schema` 的面板才有内容；来自
   * `host:input` 重放通道，schema 渲染的表单无需自管状态）。
   */
  readonly values: Readonly<Record<string, unknown>>
}

/** 面板可回传的宿主事件词表（`bridge.emit(event, detail)`；detail 形状见注释）。 */
export const CONTEXT_PANEL_SURFACE_EVENTS = [
  /** detail: 无——折叠右栏 */
  'host:collapse',
  /** detail: 会话 id（string | null）——选中会话；`null` 清除选中 */
  'host:select-session',
  /** detail: `{ key: string; value: unknown }`——写面板设置（声明了 schema + 适配器时生效） */
  'settings:set',
  /** detail: 设置键（string）——删面板设置 */
  'settings:remove',
] as const

export type ContextPanelSurfaceEvent = (typeof CONTEXT_PANEL_SURFACE_EVENTS)[number]
