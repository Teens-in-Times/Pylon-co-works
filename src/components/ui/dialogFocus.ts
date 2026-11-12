/** Modal keyboard ownership. Installs and releases document listeners per visible dialog. */
import { createEffect, onCleanup } from 'solid-js'

const dialogStacks = new WeakMap<Document, HTMLElement[]>()
const focusableSelector = 'button, [href], input, select, textarea, [tabindex]'

export function createDialogFocus(
  element: () => HTMLElement | undefined | null,
  active: () => unknown,
  onEscape?: () => void,
): void {
  createEffect(() => {
    if (!active()) return
    const dialog = element()
    if (!dialog) return
    const doc = dialog.ownerDocument
    const previous = doc.activeElement instanceof HTMLElement ? doc.activeElement : null
    const stack = dialogStacks.get(doc) ?? []
    dialogStacks.set(doc, stack)
    stack.push(dialog)
    const isTop = () => stack.at(-1) === dialog
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(node => {
      if (node.tabIndex < 0 || node.matches(':disabled') || node.closest('[inert], [hidden], [aria-hidden="true"]')) return false
      if (getComputedStyle(node).visibility === 'hidden') return false
      for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).display === 'none') return false
        if (ancestor === dialog) break
      }
      return true
    })
    const focusFirst = () => {
      const candidates = controls()
      const target = candidates.find(node => node.hasAttribute('autofocus')) ?? candidates[0] ?? dialog
      target.focus({ preventScroll: true })
    }
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1
    const keydown = (event: KeyboardEvent) => {
      if (!isTop() || event.defaultPrevented || event.isComposing) return
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault()
        event.stopPropagation()
        onEscape()
      } else if (event.key === 'Tab') {
        const candidates = controls()
        const first = candidates[0]
        const last = candidates.at(-1)
        if (!first) { event.preventDefault(); dialog.focus(); return }
        if (event.shiftKey && (doc.activeElement === first || !dialog.contains(doc.activeElement) || doc.activeElement === dialog)) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (doc.activeElement === last || !dialog.contains(doc.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    doc.addEventListener('keydown', keydown)
    // Ref assignment precedes insertion; defer focus until the dialog is connected.
    let disposed = false
    queueMicrotask(() => { if (!disposed && isTop() && dialog.isConnected) focusFirst() })
    onCleanup(() => {
      disposed = true
      const wasTop = isTop()
      const index = stack.indexOf(dialog)
      if (index >= 0) stack.splice(index, 1)
      doc.removeEventListener('keydown', keydown)
      if (stack.length === 0) dialogStacks.delete(doc)
      if (wasTop && previous?.isConnected) previous.focus({ preventScroll: true })
    })
  })
}
