// @vitest-environment jsdom
// #520 S3-P1-5：Sidebar 拖拽重排状态机抽为 createSidebarDragReorder 后的**控制器级**
// 行为测试。Sidebar.blocks.solid.test.tsx 已从组件面覆盖长按/钉区/捕获时机/slop 取消
// （真实 DOM 事件路径）；本文件补控制器面：几何冻结→落点计算→落库的完整闭环、
// click 抑制窗口、以及落点/重排两个纯函数的边界语义——这些此前没有直接断言。
import { describe, expect, it, vi } from 'vitest'
import {
  applyReorder,
  computeDropIndex,
  createSidebarDragReorder,
  DRAG_CLICK_SUPPRESS_MS,
  LONG_PRESS_MS,
  type SidebarDragReorderOptions,
} from '../sidebar/createSidebarDragReorder.ts'

/** 三模块栈：a、b 可拖，sessions 常驻钉住（钉区起点 = 2）。几何中心线等距可预测。 */
function makeController(overrides: Partial<SidebarDragReorderOptions> = {}) {
  const committed: string[][] = []
  const controller = createSidebarDragReorder({
    moduleIds: () => ['a', 'b', 'sessions'],
    pinnedStart: () => 2,
    isPinned: id => id === 'sessions',
    commitOrder: next => committed.push([...next]),
    readGeometry: () => [
      { id: 'a', center: 50 },
      { id: 'b', center: 150 },
      { id: 'sessions', center: 250 },
    ],
    ...overrides,
  })
  return { controller, committed }
}

/** 控制器只读 currentTarget 的捕获方法（全部 optional call），桩对象即可。 */
const headStub = {} as HTMLElement

const pointerDown = (pointerId = 1) =>
  ({ button: 0, pointerId, clientX: 12, clientY: 10, currentTarget: headStub }) as unknown as PointerEvent
const pointerMove = (clientY: number, pointerId = 1) =>
  ({ pointerId, clientX: 12, clientY, currentTarget: headStub }) as unknown as PointerEvent
const pointerUp = (pointerId = 1) =>
  ({ pointerId, currentTarget: headStub }) as unknown as PointerEvent

describe('拖拽重排纯函数', () => {
  it('computeDropIndex：落点 = 中心线在光标之上的模块个数，钳在钉区之前', () => {
    const geometry = [{ id: 'a', center: 50 }, { id: 'b', center: 150 }, { id: 'sessions', center: 250 }]
    expect(computeDropIndex(geometry, 10, 2)).toBe(0)
    expect(computeDropIndex(geometry, 100, 2)).toBe(1)
    expect(computeDropIndex(geometry, 200, 2)).toBe(2)
    // 光标再低也落不进钉区（常驻模块之后）。
    expect(computeDropIndex(geometry, 10_000, 2)).toBe(2)
    expect(computeDropIndex(geometry, 10_000, 3)).toBe(3)
  })

  it('applyReorder：落点序号是「插入到第几个之前」，移除自身后靠后落点左移一位', () => {
    expect(applyReorder(['a', 'b', 'sessions'], 'a', 2)).toEqual(['b', 'a', 'sessions'])
    expect(applyReorder(['a', 'b', 'sessions'], 'b', 0)).toEqual(['b', 'a', 'sessions'])
    // 原位落点 → null（调用方跳过落库）。
    expect(applyReorder(['a', 'b', 'sessions'], 'a', 0)).toBeNull()
    expect(applyReorder(['a', 'b', 'sessions'], 'a', 1)).toBeNull()
    // 被拖模块不在栈里 → null。
    expect(applyReorder(['a', 'b', 'sessions'], 'gone', 1)).toBeNull()
  })
})

describe('拖拽重排控制器', () => {
  it('长按到点进入拖拽，拖动更新落点，抬起落库新次序', () => {
    vi.useFakeTimers()
    try {
      const { controller, committed } = makeController()
      controller.onHeadPointerDown(pointerDown(), 'a')
      expect(controller.drag()).toBeNull()

      vi.advanceTimersByTime(LONG_PRESS_MS)
      expect(controller.drag()).toEqual({ id: 'a', pointerId: 1 })
      // 初始落点 = 被拖模块当前位置。
      expect(controller.dropIndex()).toBe(0)

      // 拖到栈底（光标越过所有几何）——落点被钳在钉区之前（index 2）。
      controller.onHeadPointerMove(pointerMove(300))
      expect(controller.dropIndex()).toBe(2)

      controller.endDrag(pointerUp())
      expect(committed).toEqual([['b', 'a', 'sessions']])
      expect(controller.drag()).toBeNull()
      expect(controller.dropIndex()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('原位抬起不落库；抬起后短窗内吞补发 click，窗口过后恢复', () => {
    vi.useFakeTimers()
    try {
      const { controller, committed } = makeController()
      controller.onHeadPointerDown(pointerDown(), 'a')
      vi.advanceTimersByTime(LONG_PRESS_MS)
      expect(controller.drag()).toEqual({ id: 'a', pointerId: 1 })

      // 光标停在原位 → applyReorder 返回 null → 不 commit。
      controller.endDrag(pointerUp())
      expect(committed).toEqual([])
      expect(controller.suppressClick()).toBe(true)

      vi.advanceTimersByTime(DRAG_CLICK_SUPPRESS_MS + 1)
      expect(controller.suppressClick()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('长按期间移动超过 slop 取消（点击/滚动不误判成拖拽）；钉住的模块不进拖拽', () => {
    vi.useFakeTimers()
    try {
      const { controller, committed } = makeController()
      controller.onHeadPointerDown(pointerDown(), 'a')
      controller.onHeadPointerMove(pointerMove(10 + 100)) // 超过 LONG_PRESS_SLOP_PX
      vi.advanceTimersByTime(LONG_PRESS_MS + 100)
      expect(controller.drag()).toBeNull()

      // 常驻模块：长按也不进拖拽（它能去哪儿？钉区之上对会话没有意义）。
      controller.onHeadPointerDown(pointerDown(2), 'sessions')
      vi.advanceTimersByTime(LONG_PRESS_MS + 100)
      expect(controller.drag()).toBeNull()
      controller.endDrag(pointerUp(2))
      expect(committed).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
