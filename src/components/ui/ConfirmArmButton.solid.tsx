/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'

export interface ConfirmArmButtonProps {
  /** 首次点击前的稳定文案（如「删除」） */
  label: string
  /** armed（待确认）态的确认文案（如「确认删除」） */
  confirmLabel: string
  /** 确认回调：armed 态二次点击触发；触发后自动回到未 armed */
  onConfirm(): void
  /** armed 后未二次点击的自动回弹时长 ms（默认 3000，误点保护窗口） */
  armTimeoutMs?: number
  /** 未 armed 态按钮 class */
  class?: string
  /** armed 态按钮 class（危险高亮等）；缺省沿用 class */
  confirmClass?: string
  disabled?: boolean
  /** 未 armed 态 aria-label（缺省 = label） */
  ariaLabel?: string
  /** armed 态 aria-label（缺省 = confirmLabel） */
  confirmAriaLabel?: string
  /** armed 态旁注（影响面说明等，随确认按钮一并出现） */
  hint?: string
}

/**
 * ConfirmArmButton — 删除二段确认按钮（定时器式，#520 K 域统一件）。
 *
 * 收拢此前三种手写（#520 结构审查 S3-P2）：GatewaySheetView 的 pendingDeleteId
 * 定时器式、GlobalPresetSection 的内联 alertdialog 式、AgentRuntimePanel 的
 * window.confirm 式。行为口径：首次点击只进入 armed（不执行操作），armed 态
 * 二次点击才触发 onConfirm；armed 超时自动回弹（onCleanup 清理定时器）。
 * 视觉允许向本组件统一：armed 态按钮默认换用 confirmClass（危险高亮），
 * hint 以小字旁注呈现。
 */
export default function ConfirmArmButton(props: ConfirmArmButtonProps) {
  const [armed, setArmed] = createSignal(false)

  // armed 3s 未二次点击自动回弹（原 GatewaySheetView pendingDeleteId effect 口径）。
  createEffect(() => {
    if (!armed()) return
    const timer = window.setTimeout(() => setArmed(false), props.armTimeoutMs ?? 3000)
    onCleanup(() => window.clearTimeout(timer))
  })

  const click = () => {
    if (props.disabled) return
    if (!armed()) {
      setArmed(true)
      return
    }
    setArmed(false)
    props.onConfirm()
  }

  return (
    <>
      <button
        type="button"
        class={armed() ? (props.confirmClass ?? props.class) : props.class}
        disabled={props.disabled}
        aria-label={armed() ? (props.confirmAriaLabel ?? props.confirmLabel) : (props.ariaLabel ?? props.label)}
        onClick={click}
      >
        {armed() ? props.confirmLabel : props.label}
      </button>
      <Show when={armed() && props.hint}>
        <span class="text-[11px] text-text-dim" role="note">{props.hint}</span>
      </Show>
    </>
  )
}
