/**
 * 消息渲染契约（施工方案书 v3 §M4）：renderer.message 扩展点。
 *
 * 契约以「类型 + 宿主可查询」为准；内建消息 surface 统一由 Solid 提供，
 * `react` kind 仅作为第三方扩展/历史 manifest 的兼容类型，不代表内建运行时：
 * - MessageRenderer 是渲染器的可查询能力面（facade）；
 * - RenderSurface 是 mount/update/destroy/on 的命令式桥（M8 渲染管线落地后启用）；
 * - 契约层不 import React/Solid，也不 import components/，保证 contracts 纯净。
 *
 * 规则：
 * - core 渲染器插件只做 facade，主 shell 通过统一 Renderer Suite 消费 Solid surface；
 * - 签名插件生态统一 Web Components（M11），届时新增 kind='webcomponent' 实现。
 */

/** renderer.message 扩展点 id。 */
export const MESSAGE_RENDERER_POINT = 'renderer.message'

/** 渲染器实现技术栈。 */
export type MessageRendererKind = 'react' | 'solid' | 'webcomponent' | 'unknown'

export interface RenderNodeSnapshot {
  readonly nodeId: string
  readonly kind: string
  readonly revision: number
  readonly payload: unknown
  /** Transient presentation state; never persisted into canonical payloads. */
  readonly streaming?: boolean
}

export type RenderAppearanceSnapshot = Readonly<Record<string, unknown>>

export interface RenderSemanticCommand {
  readonly type: string
  readonly targetId?: string
  readonly payload?: unknown
}

export interface RenderCommandPort {
  execute(command: RenderSemanticCommand): void | Promise<void>
  /** Optional capability probe so a renderer can disable unavailable actions before dispatch. */
  canExecute?(commandType: RenderSemanticCommand['type']): boolean
}

export type RenderSurfaceEvent = 'error' | 'request-action'

/**
 * 命令式渲染面：由 MessageRenderer.render* 返回。
 * mount 以语义 snapshot/appearance/commands 为载荷，宿主不传组件实例。
 */
export interface RenderSurface {
  readonly rendererId: string
  readonly kind: MessageRendererKind
  /** 单次挂载；后续流式变化只允许经 update 推送 immutable snapshot。 */
  mount(container: HTMLElement, snapshot: RenderNodeSnapshot, appearance: RenderAppearanceSnapshot, commands: RenderCommandPort): unknown
  /** 同步 latest-wins 更新；不得 dispose/remount。 */
  update(handle: unknown, snapshot: RenderNodeSnapshot, appearance: RenderAppearanceSnapshot): void
  /** 销毁句柄并清理容器。 */
  destroy(handle: unknown): void
  /** 订阅渲染器事件；返回取消订阅函数。 */
  on(event: RenderSurfaceEvent, listener: (payload: unknown) => void): () => void
}

/** renderMessage 的语义 props（主壳 RenderMessage 形状见 domains/chat/messageTypes.ts）。 */
export interface MessageRenderProps {
  /** 主壳渲染消息；契约层不反向依赖 components。 */
  renderMessage: unknown
  reduceMotion?: boolean
  highlighted?: boolean
  isStatic?: boolean
  toolVisualState?: unknown
}

/** renderTool 的语义 props（第三方 renderer 的消费面差异由 facade 桥接）。 */
export interface ToolRenderProps {
  message?: unknown
  model?: unknown
  visualState?: unknown
  appearance?: unknown
}

/** renderReasoning 的语义 props。 */
export interface ReasoningRenderProps {
  text: string
  running: boolean
  startedAt?: number
  durationMs?: number
}

/**
 * 消息渲染器能力面：每个 renderer.message 贡献的 impl 实现本接口。
 * core.renderer.solid 为内置 facade；
 * render* 返回绑定到该渲染器的 RenderSurface。
 */
export interface MessageRenderer {
  readonly rendererId: string
  readonly kind: MessageRendererKind
  renderMessage(props: MessageRenderProps): RenderSurface
  renderTool(props: ToolRenderProps): RenderSurface
  renderReasoning(props: ReasoningRenderProps): RenderSurface
}
