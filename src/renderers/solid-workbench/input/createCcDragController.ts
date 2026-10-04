/**
 * createCcDragController — 编辑态「拖拽 / 高度拖把 / Escape 键盘」的行为控制器（#520 S3-P0-2）。
 *
 * 从 ControlCenter.solid.tsx 原样搬出，职责不变：
 * - **控件拖拽**（#266 刀5 阈值 + #238 刀4 占区守卫）：「点一下」永远只是选中，
 *   越阈值才进拖拽；位移提交走 `updatePlacement`（与属性面板共用的守卫入口）。
 * - **高度拖把**（编辑头）：上移加高，实时 dispatch。
 * - **Escape**（window 级）：有选中先清选中，否则退出编辑模式。
 *
 * 纯 ts（无 JSX）；DOM 依赖收敛在 `ports.getRoot()` 与事件监听两处，
 * 事件目标可注入 ⇒ 单测可喂合成事件（见 `__tests__/createCcDragController.test.ts`）。
 * 生命周期：构造即挂事件监听，`dispose()` 统一摘除（组件侧 onCleanup 调用）。
 */
import { CC_FLOATING_WIDGET_IDS, CC_REGISTERED_SLOT_IDS, CC_WIDGET_IDS } from '../../../domains/cc/widgetDefinitions.ts'
import type { CcLayoutWidgetId, CcWidgetPlacement } from '../../../domains/cc/ccLayoutState.ts'
import { parseTranslateOffset, resolveAllowedOffset, shouldBypassCollisionConstraint, type CcOffsetPair, type CcRectLike } from './ccPlacementCollision.ts'

/**
 * ★ #266 刀5：编辑态拖拽的**位移阈值**（直线距离，px）—— 越过它才算拖拽，阈值内松开只算选中。
 * 3px 的依据：见 `.agents/records/266-cc-visibility-drag-threshold.md`（翻译定值；实机手感复核）。
 */
export const CC_DRAG_THRESHOLD_PX = 3

/**
 * 编辑态可编辑控件 = 内置轨 ∪ 注册轨中**占槽位**的控件（刀4 的「内置轨 ∪ 注册轨」）——
 * 两者都由定义表（`domains/cc/widgetDefinitions.ts`）派生。
 * 「基础」`cc-surface` 不参与排布、无 order/offset/显隐，故不进工具栏。
 * 它同时是拖拽守卫的**障碍集全集**（悬浮件由算法侧豁免）。
 */
export const CC_EDIT_TOOLBAR_IDS: readonly CcLayoutWidgetId[] = [
  ...CC_WIDGET_IDS,
  ...CC_REGISTERED_SLOT_IDS,
]

/** 直线距离是否越过拖拽阈值（≥ 阈值即进拖拽，不是等 pointerup 才判）。 */
export function exceedsDragThreshold(
  startX: number,
  startY: number,
  x: number,
  y: number,
  threshold: number = CC_DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(x - startX, y - startY) >= threshold
}

/** 控制器对组件状态与提交通道的最小依赖面（响应式读取由组件的 accessor 保证）。 */
export interface CcDragPorts {
  /** 编辑态是否开启（关闭时拖拽/键盘全部短路）。 */
  isEditMode(): boolean
  /** 布局快照里的当前 placement（拖拽起点与守卫的回退值）。 */
  placementOf(id: CcLayoutWidgetId): CcWidgetPlacement
  /** 背景板当前高度（高度拖把的起点）。 */
  currentHeight(): number
  /** 拖拽即选中；传 undefined = 清选中（Escape 第一击）。 */
  select(id: CcLayoutWidgetId | undefined): void
  isSelected(): CcLayoutWidgetId | undefined
  /** 走占区守卫后的 placement 提交（组件侧 dispatch）。 */
  submitPlacement(id: CcLayoutWidgetId, placement: Partial<CcWidgetPlacement>): void
  /** 高度提交（组件侧 dispatch）。 */
  submitHeight(height: number): void
  /** Escape 兜底的退出编辑模式（组件侧 dispatch）。 */
  exitEditMode(): void
  /** 中控根元素（守卫测量的 DOM 缝；缺省/未挂载 ⇒ 守卫拿不到占区 ⇒ 原样放行）。 */
  getRoot(): HTMLElement | undefined
}

export interface CcDragController {
  /** 控件拖拽入口（widget 的 onPointerDown）。 */
  beginWidgetDrag(event: PointerEvent, id: CcLayoutWidgetId): void
  /** 高度拖把入口（编辑头的 onPointerDown）。 */
  beginHeightDrag(event: PointerEvent): void
  /**
   * ★★ #238 刀4「占区不叠加」——**两条通路共用**的守卫（拖拽与属性面板都走它）：
   * 改偏移的两条路曾一条直连 dispatch、一条走守卫 ⇒ 等于留后门。放行条件：
   * ① 非编辑态 ② 悬浮件（`CC_FLOATING_WIDGET_IDS`）③ 只改 order（没碰偏移）。
   */
  updatePlacement(id: CcLayoutWidgetId, placement: Partial<CcWidgetPlacement>): void
  /** 事件 keydown 逻辑体（Escape 两段式）。 */
  handleKeydown(event: { key: string }): void
  /** 摘除在途拖拽监听（退出编辑态时由组件 effect 调用）。 */
  cancelActiveDrag(): void
  /** 摘除全部事件监听并结束在途拖拽。 */
  dispose(): void
}

export function createCcDragController(
  ports: CcDragPorts,
  options: { eventTarget?: EventTarget } = {},
): CcDragController {
  const eventTarget = options.eventTarget ?? globalThis.window
  let stopActive: (() => void) | undefined

  // 处理器的参数类型各不相同（PointerEvent / { key }），统一按 EventListener 挂。
  const listen = (type: string, handler: (event: never) => void) => {
    const listener = handler as EventListener
    eventTarget.addEventListener(type, listener)
    return () => eventTarget.removeEventListener(type, listener)
  }

  /** 元件占区 + 自身 inline transform 读回的偏移（同一 DOM 快照，见 ccPlacementCollision 头注）。 */
  const measureWidgetBox = (id: string): { rect: CcRectLike; offset: CcOffsetPair } | undefined => {
    const element = ports.getRoot()?.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)
    if (!element) return undefined
    const box = element.getBoundingClientRect()
    return {
      rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      offset: parseTranslateOffset(element.style.transform),
    }
  }

  const allowedPlacement = (id: CcLayoutWidgetId, partial: Partial<CcWidgetPlacement>): Partial<CcWidgetPlacement> => {
    if (shouldBypassCollisionConstraint({
      editMode: ports.isEditMode(),
      id,
      floatingIds: CC_FLOATING_WIDGET_IDS,
      touchesOffset: partial.offsetX !== undefined || partial.offsetY !== undefined,
    })) return partial
    const self = measureWidgetBox(id)
    if (!self) return partial
    const current = ports.placementOf(id)
    const candidate = {
      offsetX: partial.offsetX ?? current.offsetX,
      offsetY: partial.offsetY ?? current.offsetY,
    }
    // 障碍集 = 其他可拖元件里**不在悬浮名单**的（悬浮件既不当障碍也不受约束）。
    // ★ 每次调用重新测量：拖动中其它元件可能换落脚处/被声明脱离（rect 因此变）。
    const obstacles = CC_EDIT_TOOLBAR_IDS
      .filter(other => other !== id && !CC_FLOATING_WIDGET_IDS.includes(other))
      .map(other => measureWidgetBox(other)?.rect)
      .filter((rect): rect is CcRectLike => rect !== undefined)
    const allowed = resolveAllowedOffset({
      applied: self.offset,
      baseRect: self.rect,
      candidate,
      // 上一次被接受的位置 = 元素此刻渲染出来的位置（状态由 DOM 承载，无需另记）
      previous: self.offset,
      obstacles,
    })
    return { ...partial, offsetX: allowed.offsetX, offsetY: allowed.offsetY }
  }

  // ★★ #238 刀4：位移提交的唯一入口（拖拽与属性面板共用一条守卫过的路）。
  const updatePlacement = (id: CcLayoutWidgetId, placement: Partial<CcWidgetPlacement>) => {
    ports.submitPlacement(id, allowedPlacement(id, placement))
  }

  const beginWidgetDrag = (event: PointerEvent, id: CcLayoutWidgetId) => {
    if (!ports.isEditMode()) return
    event.preventDefault()
    event.stopPropagation()
    ports.select(id)
    stopActive?.()
    const startX = event.clientX
    const startY = event.clientY
    const pointerId = event.pointerId
    const start = ports.placementOf(id)
    // ★★ #266 刀5：越阈值前**一次 updatePlacement 都不发** ⇒ 不写 offset，
    // `markZoneCustom` 也不会被触发（0 偏移写入也会把它标记成"自定义过"）。
    // 判定是「越过阈值即进入拖拽」，不是「等到 pointerup 才判」。
    let dragging = false
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      if (!dragging) {
        if (!exceedsDragThreshold(startX, startY, next.clientX, next.clientY)) return
        dragging = true
      }
      updatePlacement(id, {
        offsetX: start.offsetX + next.clientX - startX,
        offsetY: start.offsetY + next.clientY - startY,
      })
    }
    const stop = (next?: PointerEvent) => {
      if (next && next.pointerId !== pointerId) return
      off()
      if (stopActive === stop) stopActive = undefined
    }
    const off = () => {
      unlistenMove()
      unlistenUp()
      unlistenCancel()
    }
    const unlistenMove = listen('pointermove', move)
    const unlistenUp = listen('pointerup', stop)
    const unlistenCancel = listen('pointercancel', stop)
    stopActive = stop
  }

  const beginHeightDrag = (event: PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const pointerId = event.pointerId
    const startHeight = ports.currentHeight()
    stopActive?.()
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      ports.submitHeight(startHeight + startY - next.clientY)
    }
    const stop = (next?: PointerEvent) => {
      if (next && next.pointerId !== pointerId) return
      off()
      if (stopActive === stop) stopActive = undefined
    }
    const off = () => {
      unlistenMove()
      unlistenUp()
      unlistenCancel()
    }
    const unlistenMove = listen('pointermove', move)
    const unlistenUp = listen('pointerup', stop)
    const unlistenCancel = listen('pointercancel', stop)
    stopActive = stop
  }

  // ★ #266 刀5：Escape 两段式 —— 第一击清选中，第二击退出编辑模式。
  const handleKeydown = (event: { key: string }) => {
    if (event.key !== 'Escape' || !ports.isEditMode()) return
    if (ports.isSelected()) ports.select(undefined)
    else {
      stopActive?.()
      ports.exitEditMode()
    }
  }

  const unlistenKeydown = listen('keydown', handleKeydown)

  return {
    beginWidgetDrag,
    beginHeightDrag,
    updatePlacement,
    handleKeydown,
    cancelActiveDrag: () => stopActive?.(),
    dispose: () => {
      stopActive?.()
      stopActive = undefined
      unlistenKeydown()
    },
  }
}
