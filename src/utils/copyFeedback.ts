import { createSignal, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'

/**
 * createCopyFeedback — 「已复制 ✓」一次性反馈计时器（Solid hook）。
 *
 * 消费者在剪贴板写入确认成功后调用 markCopied。重复成功会重置反馈计时，
 * 组件卸载时回收计时器；不承担剪贴板 IO 或错误处理。
 */
export function createCopyFeedback(resetMs = 2000): { copied: Accessor<boolean>; markCopied: () => void } {
  const [copied, setCopied] = createSignal(false)
  let copiedTimer: number | undefined
  onCleanup(() => {
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
  })
  const markCopied = (): void => {
    setCopied(true)
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => setCopied(false), resetMs)
  }
  return { copied, markCopied }
}
