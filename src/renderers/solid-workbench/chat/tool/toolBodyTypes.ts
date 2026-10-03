import type { RenderCommandPort } from '../../../../contracts/messageRenderer.ts'

/**
 * ToolBody 子组件共享 props 臂（#520 K 域，审查 S3-P2「RenderCommandPort 透传
 * 5+ 层、ToolBody 15 子组件重复」的类型收敛面——只收敛类型，不改传递机制）。
 *
 * ToolBody 的全部子组件（kind summaries / sections / ResourceButton）与
 * ToolObjectInspector 家族逐一重复 `commands?: RenderCommandPort`；统一引用本类型。
 * 宿主链（BuiltinSolidContentSlot / ToolInvocationCard）commands 必带，用
 * ToolBodyHostProps 表达；向下透传给子组件时自然退化为可选臂。
 */
export interface ToolBodySubProps {
  /** 渲染命令口（resource.open / clipboard.write 等）；缺省时动作按钮禁用/隐藏 */
  commands?: RenderCommandPort
}

/** ToolBody 宿主臂：Slot/卡片层装配时 commands 必带。 */
export interface ToolBodyHostProps extends ToolBodySubProps {
  commands: RenderCommandPort
}
