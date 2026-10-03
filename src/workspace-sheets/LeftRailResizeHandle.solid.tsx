/** @jsxImportSource solid-js */
import { onCleanup, createSignal } from 'solid-js'
import {
  useRightRailStore,
  clampLeftRailWidth,
  LEFT_RAIL_MAX_WIDTH,
  LEFT_RAIL_MIN_WIDTH,
} from '../domains/workspace/layoutRailsStore.ts'

/**
 * LeftRailResizeHandle — 左栏拖拽实时调宽（#154，#279 第 3 梯队 Solid 化实体；与
 * React 版逐行为同构）。
 *
 * 与右栏手柄同形（`role="separator"` + 指针捕获 + 方向键），但**实时**改宽：
 * 拖拽过程中直接把唯一宽度真值 `--sheet-sidebar-track-width` 写到 `.app` 上，
 * 标题栏左轨道、左列外壳、布局分割线因此同一帧一起动。
 *
 * 为什么用命令式写 CSS 变量而不是响应式状态：
 * - 宽度真值住在 `.app`（skin surface），而手柄在 `.layout` 里；用状态驱动就得把它
 *   提回 App 或加 context，且每次 pointermove 都要重渲染整棵 Sheet 子树。
 * - 这里同时给 `.layout` 挂 `is-resizing` 关掉宽度过渡，否则每个 pointermove 的过渡
 *   会互相打断，拖出尾迹。
 *
 * 落库仍走既有单一事务：`setLeftRailWidth`（clamp 160/520 + v3 持久化）。与右栏一样
 * **只在抬起时提交**，避免每帧写一次 localStorage。
 */
export default function LeftRailResizeHandle() {
  const width = createSignalWidth()
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null

  const container = (element: HTMLElement | null) => ({
    app: element?.closest('.app') as HTMLElement | null,
    layout: element?.closest('.layout') as HTMLElement | null,
  })

  // 实时值只写在 .app 上，不改 store——store 是持久化真值，拖拽只是它的预览。
  const paint = (element: HTMLElement | null, next: number) => {
    container(element).app?.style.setProperty('--sheet-sidebar-track-width', `${next}px`)
  }

  const beginDrag = (element: HTMLElement | null) => {
    container(element).layout?.classList.add('is-resizing')
  }

  const endDrag = (element: HTMLElement | null) => {
    const { app, layout } = container(element)
    app?.style.removeProperty('--sheet-sidebar-track-width')
    layout?.classList.remove('is-resizing')
  }

  const widthFromPointer = (dragState: { startX: number; startWidth: number }, clientX: number) =>
    clampLeftRailWidth(dragState.startWidth + clientX - dragState.startX)

  const onPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.button !== 0 || drag) return
    event.preventDefault()
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width() }
    beginDrag(event.currentTarget)
    paint(event.currentTarget, width())
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    paint(event.currentTarget, widthFromPointer(drag, event.clientX))
  }

  const onPointerUp = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = widthFromPointer(drag, event.clientX)
    endDrag(event.currentTarget)
    drag = null
    // #537：左栏手柄只准写左栏字段——此前误写 setWidth（右栏宽度，clamp 220/560），
    // 左栏窄于 220 的拖拽被右栏 clamp 吞掉，右栏宽度还被意外改写。
    useRightRailStore.getState().setLeftRailWidth(next)
  }

  const cancelDrag = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return
    endDrag(event.target as HTMLElement)
    drag = null
  }

  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    // 键盘步进/边界与拖拽同写左栏字段（#537 同源缺陷：此前走右栏 setWidth）。
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      useRightRailStore.getState().setLeftRailWidth(width() + (event.key === 'ArrowRight' ? 8 : -8))
    } else if (event.key === 'Home') {
      event.preventDefault()
      useRightRailStore.getState().setLeftRailWidth(LEFT_RAIL_MIN_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      useRightRailStore.getState().setLeftRailWidth(LEFT_RAIL_MAX_WIDTH)
    }
  }

  return (
    <div
      class="left-rail-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整左栏宽度"
      aria-valuemin={LEFT_RAIL_MIN_WIDTH}
      aria-valuemax={LEFT_RAIL_MAX_WIDTH}
      aria-valuenow={width()}
      tabIndex={0}
      data-left-rail-resize="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelDrag}
      on:lostpointercapture={cancelDrag}
      onKeyDown={onKeyDown}
    />
  )
}

/** rightRailStore（Solid 内核）订阅 → 信号（宽度渲染值；落库走 getState().setLeftRailWidth）。 */
function createSignalWidth(): () => number {
  const [value, setValue] = createSignal(useRightRailStore.getState().leftRailWidth)
  onCleanup(useRightRailStore.subscribe(state => setValue(state.leftRailWidth)))
  return value
}
