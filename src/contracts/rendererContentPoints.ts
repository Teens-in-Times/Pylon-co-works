/**
 * 渲染内容管线 P1 契约（施工方案书 v3 §M8）：六个第一类渲染内容扩展点。
 *
 * 契约层不 import 任何 UI 框架，也不 import components/domains；
 * 第一版以「类型 + 宿主可查询」为准，默认视觉不变。
 * 运行时单一真值由 plugin-runtime Renderer Registry 持有；本文件仅保留
 * Renderer Registry 使用的内容渲染类型。
 */

export const RENDERER_CODE_HIGHLIGHT_POINT = 'renderer.codeHighlight'
export const RENDERER_ANSI_POINT = 'renderer.ansi'
export const RENDERER_SPINNER_POINT = 'renderer.spinner'
export const RENDERER_CONTENT_PART_POINT = 'renderer.contentPart'
export const RENDERER_PLAN_POINT = 'renderer.plan'
export const RENDERER_FOOTER_POINT = 'renderer.footer'

/** renderer.codeHighlight：代码高亮 provider（输入语言/代码，输出 HTML 或 null 回退纯文本）。 */
export interface CodeHighlightProvider {
  readonly providerId: string
  highlight(language: string, code: string): Promise<string | null>
}

/** renderer.ansi：ANSI 转义序列 → 已脱敏 HTML。 */
export interface AnsiProvider {
  readonly providerId: string
  render(text: string): string
}

/** renderer.spinner：帧集解析 provider（preset 为 SpinnerFramePreset 字符串，custom 为自定义帧）。 */
export interface SpinnerProvider {
  readonly providerId: string
  resolve(preset: string, custom: string): string[]
}

/** renderer.contentPart：消息内容分区 provider（第一版仅注册元数据，主链路仍用内置组件）。 */
export interface ContentPartProvider {
  readonly providerId: string
  readonly partId: string
  readonly label: string
}

/** renderer.plan：任务树/计划 provider（第一版仅注册元数据；主链路 fallback 是
 *  WorkbenchContent.solid.tsx 的 SolidPlanGoalContent——a212ce84 有意升级所致）。 */
export interface PlanProvider {
  readonly providerId: string
  readonly planKind: string
  readonly label: string
}

/** renderer.footer：生成页脚 provider（第一版仅注册元数据，主链路仍用内置 GenerationFooter）。 */
export interface FooterProvider {
  readonly providerId: string
  readonly footerKind: string
  readonly label: string
}
