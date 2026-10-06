/**
 * Framework-neutral property metadata; product layers may refine this shape.
 *
 * ★ #266 CC-13 刀4：中控这一层的**定形处**在 `domains/cc/ccWidgetRoster.ts` 的
 * `CcWidgetPropertyFieldDecl` —— 四种 kind（`section` / `number` / `color` / `chips`），
 * `key` 为插件自定义短键（值进主题 cc 区的 `ccPluginProps`）；声明非法 ⇒ 该字段被丢弃
 * 并走诊断（`cc-widget.property-field.rejected`），**不静默**。
 * 本类型保持不透明：契约（SDK 层）不把四种形状钉死，登记项的写法由产品层校验。
 */
export type CcWidgetPropertyField = Readonly<Record<string, unknown>>

/**
 * 元件在定义表里的默认位置（插件作者看到的词表）。
 * ★ #238 刀3：原来的四值 `slot`（输入区/状态左/状态右/操作区）**整层拆除** ——
 * 位置改成声明式「贴谁 + 哪一侧」，不再有"先分槽、再在槽里排序"两段式。
 * 侧别的完整语义见 `domains/cc/widgetDefinitions.ts` 的 `CcAxisX` / `CcAxisY`。
 */
export interface CcWidgetPlacement {
  /** 贴谁（表内 id，如 `cc-surface` / `input`） */
  readonly anchor: string
  /** 贴那一侧的哪条边（`left`/`right`/`center`/`stretch`｜`top`/`bottom`/`center`/`stretch`） */
  readonly side?: string
  readonly order: number
  readonly offsetX: number
  readonly offsetY: number
}

export type CcWidgetRenderSpec =
  | { readonly kind: 'host-renderer'; readonly rendererKey: string }
  | { readonly kind: 'isolated-surface'; readonly surfaceId: string }

export interface CcWidgetContribution {
  readonly id: string
  readonly label: string
  readonly category?: string
  readonly render?: CcWidgetRenderSpec
  readonly propertyFields?: readonly CcWidgetPropertyField[]
  readonly defaultPlacement?: CcWidgetPlacement
}

export interface ResolvedCcWidget extends CcWidgetContribution {
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly contributionId: string
}
