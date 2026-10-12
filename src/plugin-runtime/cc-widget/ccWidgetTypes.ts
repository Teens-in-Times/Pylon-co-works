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
 * ★ #266 CC-13 刀5：插件自报的**尺寸声明**（px；两维都可选、各维独立）。
 *
 * ★ 与 `propertyFields` 同款：契约只声明形状，**校验 / 定形处**在
 *   `domains/cc/ccWidgetRoster.ts`（`resolvePluginWidgetSizing`）——各维须为**有限且 > 0** 的数；
 *   非法 ⇒ **忽略该维度** + 诊断（`cc-widget.sizing.rejected`），**不丢件、不丢另一维**。
 * ★ 用途 = 中控的「最小高 / 最小宽 / 显示前校验」三处算式（同一套纯函数，见 `domains/cc/ccHeightState.ts`）：
 *   报了 ⇒ 并入**状态区**（高取 max、宽求和）；**没报 ⇒ 按 0 计**（= 内置「内容撑」件同待遇，结果是下界）。
 *   ★ 有意**不做**"实测尺寸回哺算式"——那会引入渲染 ↔ 算式的回环。
 */
export type CcWidgetSizing = Readonly<{
  readonly width?: number
  readonly height?: number
}>

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
  /** ★ CC-13 刀5：自报尺寸（px）—— 见 `CcWidgetSizing`；不报 = 按 0 计（下界） */
  readonly sizing?: CcWidgetSizing
  readonly defaultPlacement?: CcWidgetPlacement
}

export interface ResolvedCcWidget extends CcWidgetContribution {
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly contributionId: string
}
