/** @jsxImportSource solid-js */
import type { JSX } from 'solid-js'

/**
 * Spinner — 生成期 ASCII 帧 spinner 的统一呈现件（#520 K 域，审查 S3-P2
 * 「spinner 4 处各写各的」收敛件）。
 *
 * 组件只管 DOM 词汇（`term-spinner-row > term-spinner > spinner-frame`，样式
 * 归 ChatView.css），不拥有 spinnerMachine 时钟：帧字符/字号/颜色由调用方
 * 解析后传入（live 路径来自 appearance 快照 + spinnerMachine，预览路径来自
 * themeStore + spinnerFrames）。此前的手写分散在 SettingsPreview（静态预览）
 * 与 GenerationFooter（live 指示器），DOM 结构逐项保持。
 */
export interface SpinnerProps {
  /** 当前帧字符（调用方解析：resolveFrame / frames()[0]） */
  frame: string
  /** 帧字号 px（theme.spinnerSize / appearance.size） */
  size?: number
  /** 帧颜色（live 路径的 appearance.color；预览路径缺省继承） */
  color?: string
  /** 活跃度（term-spinner data-activity；缺省 active） */
  activity?: string
  /** 阶段（term-spinner data-phase；cc preset 下调用方传 undefined） */
  phase?: string
  /** 停滞进度 0..1（--stall-progress CSS 变量） */
  stallProgress?: number
  class?: string
  /** spinner 框内追加内容（glimmer 动词/上下文/耗时 meta 等） */
  children?: JSX.Element
  /** 行内按钮区（渲染在 spinner 框之后，如「停止」） */
  actions?: JSX.Element
}

export function Spinner(props: SpinnerProps) {
  return (
    <div class={`term-spinner-row${props.class ? ` ${props.class}` : ''}`}>
      <div
        class="term-spinner"
        data-activity={props.activity ?? 'active'}
        data-phase={props.phase}
        style={props.stallProgress !== undefined ? { '--stall-progress': props.stallProgress.toFixed(3) } : undefined}
      >
        <span class="spinner-frame" style={{ color: props.color || undefined, 'font-size': props.size !== undefined ? `${props.size}px` : undefined }}>
          {props.frame}
        </span>
        {props.children}
      </div>
      {props.actions}
    </div>
  )
}

/**
 * SpinnerSummary — 终态摘要行（`term-summary term-summary-{reason}`：完成/停止/
 * 失败标记 + 文案）。SettingsPreview 三终态预览与 GenerationFooter 结算视图共用。
 */
export interface SpinnerSummaryProps {
  /** 终态 reason（term-summary-{reason} 修饰类） */
  reason: string
  /** 终态标记字符（调用方 resolveSpinnerMarker 解析） */
  marker: string
  /** 标记字号 px */
  size?: number
  children?: JSX.Element
}

export function SpinnerSummary(props: SpinnerSummaryProps) {
  return (
    <div class={`term-summary term-summary-${props.reason}`}>
      <span class="term-summary-frame" style={{ 'font-size': props.size !== undefined ? `${props.size}px` : undefined }}>
        {props.marker}
      </span>
      <span>{props.children}</span>
    </div>
  )
}
