import { createSignal, type Accessor } from 'solid-js'

/** 长按多久进入拖拽。太短会被点击误触，太长会让人觉得拖不动。 */
export const LONG_PRESS_MS = 260
/** 长按期间移动超过这个距离（px）即判定为点击/滚动，取消拖拽。 */
export const LONG_PRESS_SLOP_PX = 6
/**
 * 拖拽结束后多久内忽略 click——否则抬起那一下会连带触发标题的展开/进页面。
 *
 * 拖拽时指针已被捕获，`click` 会被改派到模块头（见 `onHeadPointerDown`），标题本就不该收到它；
 * 这条是**兜底**：捕获不可用的环境（如 jsdom、旧 WebView2）里改派不发生，click 会照常落在按钮上。
 */
export const DRAG_CLICK_SUPPRESS_MS = 320

/** 拖拽开始时冻结的模块头几何（中心线）。 */
export interface SidebarDragGeometryEntry {
  readonly id: string
  readonly center: number
}

/**
 * 落点序号（纯函数）：冻结几何里中心线在光标之上的模块个数，钳在钉区之前。
 *
 * 落点用**按下那一刻冻结的布局**计算——实时重排预览会形成反馈环（重排把被拖模块挪到
 * 光标之外 → 目标位置按新布局重算 → 又挪回去），实机表现为疯狂抖动；冻结几何后预览
 * 是一条落点指示线，抖动在结构上不可能发生。
 */
export function computeDropIndex(
  geometry: readonly SidebarDragGeometryEntry[],
  clientY: number,
  pinnedStart: number,
): number {
  let index = 0
  for (const entry of geometry) { if (clientY > entry.center) index += 1 }
  return Math.min(index, pinnedStart)
}

/**
 * 在次序数组上落定一次重排（纯函数）。
 *
 * 落点序号是「插入到第几个之前」；移除自身后，靠后的落点要左移一位。
 * 无需移动（原位 / 找不到被拖模块）返回 `null`，由调用方决定跳过落库。
 */
export function applyReorder(
  ids: readonly string[],
  draggedId: string,
  targetIndex: number,
): readonly string[] | null {
  const from = ids.indexOf(draggedId)
  if (from < 0) return null
  const to = targetIndex > from ? targetIndex - 1 : targetIndex
  if (to === from) return null
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, draggedId)
  return next
}

export interface SidebarDragReorderOptions {
  /** 当前模块栈的 id 次序（响应式）。 */
  moduleIds: () => readonly string[]
  /** 钉区起点：栈里第一个 `alwaysOpen` 模块的下标（无则 = 栈长）；落点被钳在它之前。 */
  pinnedStart: () => number
  /** 钉住的常驻模块不拖：它能去哪儿？钉区之上的位置对它没有意义。 */
  isPinned: (contributionId: string) => boolean
  /** 拖拽落定：宿主把新次序落库（modulePrefs）。返回 `null` 表示原位，不落库。 */
  commitOrder: (nextOrder: readonly string[]) => void
  /**
   * 冻结几何。默认扫 `document` 的 `.sidebar-block[data-module-id]`（长按到点那一刻的
   * 实际 DOM 布局）；测试注入假几何以脱离布局。
   */
  readGeometry?: () => readonly SidebarDragGeometryEntry[]
}

export interface SidebarDragReorderController {
  /** 正在拖拽的模块（`data-dragging` 契约）；无拖拽时 `null`。 */
  drag: Accessor<{ id: string; pointerId: number } | null>
  /** 落点指示线位置（`sidebar-modules-drop` 插入下标）；无拖拽时 `null`。 */
  dropIndex: Accessor<number | null>
  onHeadPointerDown: (event: PointerEvent, contributionId: string) => void
  onHeadPointerLeave: () => void
  onHeadPointerMove: (event: PointerEvent) => void
  endDrag: (event: PointerEvent) => void
  /** 拖拽结束后的短暂窗口内为真：兜底吞掉拖拽补发的 click（无捕获环境）。 */
  suppressClick: () => boolean
}

const defaultReadGeometry = (): SidebarDragGeometryEntry[] =>
  [...document.querySelectorAll<HTMLElement>('.sidebar-block[data-module-id]')].map(node => {
    const rect = node.getBoundingClientRect()
    return { id: node.dataset.moduleId ?? '', center: rect.top + rect.height / 2 }
  })

/**
 * 左栏模块栈的拖拽重排状态机（#520 S3-P1-5 自 Sidebar.solid 抽出；行为契约不变）：
 * **长按**进入拖拽（无独立手柄）、拖拽期间只改渲染次序预览（抬起才落库）、
 * 钉区（alwaysOpen）不可拖也不可越过、抬起后短窗内吞补发 click。
 *
 * 指针捕获时机是行为契约：**捕获只能发生在真的进入拖拽那一刻，绝不能在按下时。**
 * 捕获会把 `pointerup` 的目标改写成捕获元素（模块头），而 `click` 派发在「按下目标」
 * 与「抬起目标」的最近公共祖先上——于是头内部的按钮（标题、折叠钮、「打开」、头部动作）
 * 全都收不到 click，实机表现为「左栏所有按钮点了没反应」。实测捕获在按时：
 * pointerdown@.sidebar-block-toggle → pointerup@.sidebar-block-head → click@.sidebar-block-head。
 * jsdom 不实现指针捕获，这个改派在单测里复现不出来，所以由 `Sidebar.blocks.solid.test.tsx`
 * 对**捕获时机**本身下断言。
 */
export function createSidebarDragReorder(options: SidebarDragReorderOptions): SidebarDragReorderController {
  const readGeometry = options.readGeometry ?? defaultReadGeometry

  const [drag, setDrag] = createSignal<{ id: string; pointerId: number } | null>(null)
  const [dropIndex, setDropIndex] = createSignal<number | null>(null)
  let pressRef: { timer: number; pointerId: number; startX: number; startY: number } | null = null
  let dragEndedAt = 0
  let dragGeometry: readonly SidebarDragGeometryEntry[] | null = null

  /** 落点序号：冻结几何里中心线在光标之上的模块个数，钳在钉区之前。 */
  const dropIndexAt = (clientY: number): number => {
    const geometry = dragGeometry
    if (!geometry) return 0
    return computeDropIndex(geometry, clientY, options.pinnedStart())
  }

  const cancelPress = () => {
    const press = pressRef
    if (!press) return
    window.clearTimeout(press.timer)
    pressRef = null
  }

  /**
   * **长按**模块头进入拖拽——不再有独立的拖拽手柄。
   *
   * 手柄方案有两个代价：常驻一个抓取图标是噪声（用户点名过「折叠按钮太显眼」同一类问题），
   * 而按需显形就必须给它 `visibility/pointer-events` 门控，否则是个看不见却能拖的靶子。
   * 长按把手势和「点击标题」区分开，头部因此可以完全干净。
   */
  const onHeadPointerDown = (event: PointerEvent, contributionId: string) => {
    if (event.button !== 0) return
    if (options.isPinned(contributionId)) return
    const head = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    const timer = window.setTimeout(() => {
      pressRef = null
      // 指针仍按着才可能走到这里——抬起与取消都会清掉这个计时器。
      // 捕获是「拖出元素外仍收得到 pointermove」的关键，但并非所有环境都实现
      // （jsdom 就没有）。缺了它拖拽退化但仍可用，不该整个拖不动。
      head.setPointerCapture?.(pointerId)
      dragGeometry = readGeometry()
      setDrag({ id: contributionId, pointerId })
      setDropIndex(options.moduleIds().indexOf(contributionId))
    }, LONG_PRESS_MS)
    pressRef = { timer, pointerId, startX: event.clientX, startY: event.clientY }
  }

  /**
   * 按下后指针离开模块头就取消长按。
   *
   * 取消捕获之后，头以外的 pointermove 收不到了，`LONG_PRESS_SLOP_PX` 也就测不到——用户按住
   * 又快速移开（其实是想滚动或点别处）时计时器仍会照常触发拖拽。`pointerleave` 补上这个信号：
   * 它只在真的离开头的边界时触发，在头内部的子元素之间移动不会触发。
   */
  const onHeadPointerLeave = () => {
    // 已经在拖拽（几何已冻结）时不取消：捕获之后指针本就该自由移动。
    if (dragGeometry === null) cancelPress()
  }

  const onHeadPointerMove = (event: PointerEvent) => {
    const press = pressRef
    if (press) {
      if (press.pointerId !== event.pointerId) return
      if (Math.abs(event.clientX - press.startX) > LONG_PRESS_SLOP_PX || Math.abs(event.clientY - press.startY) > LONG_PRESS_SLOP_PX) cancelPress()
      return
    }
    const current = drag()
    if (!current || event.pointerId !== current.pointerId) return
    const next = dropIndexAt(event.clientY)
    if (next !== dropIndex()) setDropIndex(next)
  }

  const endDrag = (event: PointerEvent) => {
    cancelPress()
    const current = drag()
    if (!current) return
    const head = event.currentTarget as HTMLElement
    if (head.hasPointerCapture?.(event.pointerId)) head.releasePointerCapture?.(event.pointerId)
    const targetIndex = dropIndex()
    if (targetIndex !== null) {
      const next = applyReorder(options.moduleIds(), current.id, targetIndex)
      if (next) options.commitOrder(next)
    }
    dragGeometry = null
    dragEndedAt = Date.now()
    setDrag(null)
    setDropIndex(null)
  }

  const suppressClick = () => Date.now() - dragEndedAt < DRAG_CLICK_SUPPRESS_MS

  return { drag, dropIndex, onHeadPointerDown, onHeadPointerLeave, onHeadPointerMove, endDrag, suppressClick }
}
