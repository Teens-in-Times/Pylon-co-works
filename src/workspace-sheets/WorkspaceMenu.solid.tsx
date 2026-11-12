/** @jsxImportSource solid-js */
import { createEffect, onCleanup, Show } from 'solid-js'
import type { SheetRecord } from './sheetTypes'

export interface WorkspaceMenuActions {
  onTogglePin: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  onReopen: () => void
}

export interface WorkspaceMenuProps extends WorkspaceMenuActions {
  sheet: SheetRecord | null
  canReopen: boolean
  open: boolean
  onCloseMenu: () => void
  className?: string
  /** fixed 定位坐标（跟随右键位置）；缺省回退 CSS 定位 */
  position?: { x: number; y: number } | null
}

/** Sheet actions with roving keyboard navigation and focus restoration. */
export default function WorkspaceMenu(props: WorkspaceMenuProps) {
  let menuElement: HTMLDivElement | undefined

  createEffect(() => {
    if (!props.open) return
    const onPointerDown = (event: PointerEvent) => { if (!menuElement?.contains(event.target as Node)) props.onCloseMenu() }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const items = () => [...(menuElement?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    let closed = false
    queueMicrotask(() => { if (!closed) items()[0]?.focus() })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        props.onCloseMenu()
        previous?.focus()
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const buttons = items()
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      } else if (event.key === 'Tab') props.onCloseMenu()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      closed = true
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    })
  })

  const run = (action: () => void) => { action(); props.onCloseMenu() }
  const disabled = () => !props.sheet

  return (
    <Show when={props.open}>
      <div
        ref={element => { menuElement = element }}
        class={`workspace-menu ${props.className ?? ''}`}
        role="menu"
        style={props.position ? { position: 'fixed', left: `${props.position.x}px`, top: `${props.position.y}px` } : undefined}
      >
        <button type="button" role="menuitem" disabled={disabled()} onClick={() => props.sheet && run(() => props.onTogglePin(props.sheet!.id))}>{props.sheet?.pinned ? '取消固定 Sheet' : '固定 Sheet'}</button>
        <div class="workspace-menu-separator" />
        <button type="button" role="menuitem" disabled={disabled() || Boolean(props.sheet?.pinned)} onClick={() => props.sheet && run(() => props.onClose(props.sheet!.id))}>关闭当前 Sheet</button>
        <button type="button" role="menuitem" disabled={disabled()} onClick={() => props.sheet && run(() => props.onCloseOthers(props.sheet!.id))}>关闭其他 Sheet</button>
        <button type="button" role="menuitem" disabled={disabled()} onClick={() => props.sheet && run(() => props.onCloseRight(props.sheet!.id))}>关闭右侧 Sheet</button>
        <div class="workspace-menu-separator" />
        <button type="button" role="menuitem" disabled={!props.canReopen} onClick={() => run(props.onReopen)}>重开最近关闭的 Sheet</button>
      </div>
    </Show>
  )
}
