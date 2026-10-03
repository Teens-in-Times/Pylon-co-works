/** @jsxImportSource solid-js */
import { Show, type JSX } from 'solid-js'

/**
 * EmptyState — 统一空态（#520 K 域，审查 S3-P2「空态手写 15+ 处」收敛件）。
 *
 * DOM 词汇沿 `sheet-empty-state / sheet-empty-mark`（FileTree/SearchSheetView
 * 既有的 sheet 空态样式契约）：顶部标记 + 主标题 + 次级提示 + 可选操作区。
 * 纯品牌向空态（workbench 招牌位）可覆写 role/ariaLabel 与 class 锚点。
 */
export interface EmptyStateProps {
  /** 主文案：字符串以 strong 呈现；传 JSX 时原样输出（如 brand 空态的 eyebrow+h2） */
  title: string | JSX.Element
  /** 次级提示（span） */
  hint?: string
  /** 操作区（按钮等） */
  action?: JSX.Element
  /** 顶部标记（默认 ⌁ 字符） */
  mark?: JSX.Element
  /** 附加 class（域内锚点类，如 file-tree-empty-state） */
  class?: string
  /** 容器 role（默认 status；纯图形空态可覆写为 img） */
  role?: 'status' | 'img'
  /** role=img 时的可访问名 */
  ariaLabel?: string
}

export default function EmptyState(props: EmptyStateProps) {
  return (
    <div class={`sheet-empty-state${props.class ? ` ${props.class}` : ''}`} role={props.role ?? 'status'} aria-label={props.ariaLabel}>
      <div class="sheet-empty-mark" aria-hidden="true">{props.mark ?? '⌁'}</div>
      <Show when={typeof props.title === 'string'} fallback={props.title}>
        <strong>{props.title}</strong>
      </Show>
      <Show when={props.hint}>
        <span>{props.hint}</span>
      </Show>
      <Show when={props.action}>
        {props.action}
      </Show>
    </div>
  )
}
