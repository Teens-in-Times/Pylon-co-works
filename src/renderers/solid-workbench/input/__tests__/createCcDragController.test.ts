// @vitest-environment jsdom
/**
 * createCcDragController 单测（#520 S3-P0-2 拆分配套）。
 *
 * 与 `ccPlacementCollision.test.ts`（纯几何，node）互补：本文件测**接线层**——
 * 阈值门、占区守卫在真实 DOM 元素上的测量路径、高度拖把、Escape 两段式、
 * 生命周期（dispose 后监听摘除）。事件用 MouseEvent 冒泡合成（jsdom 无 PointerEvent，
 * 处理器只读 clientX/clientY/pointerId/key）。
 */
import { describe, expect, it } from 'vitest'
import { CC_DRAG_THRESHOLD_PX, createCcDragController, exceedsDragThreshold, type CcDragPorts } from '../createCcDragController.ts'
import type { CcLayoutWidgetId, CcWidgetPlacement } from '../../../../domains/cc/ccLayoutState.ts'
import { resolveCcDraggableWidgetIds, resolveCcWidgetRoster } from '../../../../domains/cc/ccWidgetRoster.ts'
import { CC_REGISTERED_SLOT_IDS, CC_WIDGET_IDS } from '../../../../domains/cc/widgetDefinitions.ts'

const placement = (order = 0, offsetX = 0, offsetY = 0): CcWidgetPlacement => ({ order, offsetX, offsetY })

/** 无插件登记时的可拖件 id 序（= 生产同源派生：内置表序在前、插件登记序在后）。 */
const BUILTIN_DRAGGABLE_IDS = resolveCcDraggableWidgetIds(resolveCcWidgetRoster([]))

/** 最小 ports：布局快照存内存，提交记录进 calls。 */
function makePorts(overrides: Partial<CcDragPorts> = {}) {
  const placements = new Map<CcLayoutWidgetId, CcWidgetPlacement>()
  const calls: Array<{ kind: 'placement' | 'height' | 'exit' | 'select'; args: unknown[] }> = []
  const ports: CcDragPorts = {
    isEditMode: () => true,
    draggableIds: () => BUILTIN_DRAGGABLE_IDS,
    placementOf: id => placements.get(id) ?? placement(),
    currentHeight: () => 150,
    select: id => { calls.push({ kind: 'select', args: [id] }) },
    isSelected: () => undefined,
    submitPlacement: (id, partial) => {
      const current = placements.get(id) ?? placement()
      placements.set(id, { ...current, ...partial })
      calls.push({ kind: 'placement', args: [id, partial] })
    },
    submitHeight: height => { calls.push({ kind: 'height', args: [height] }) },
    exitEditMode: () => { calls.push({ kind: 'exit', args: [] }) },
    getRoot: () => document.querySelector<HTMLElement>('#cc-root') ?? undefined,
    ...overrides,
  }
  return { ports, placements, calls }
}

/** root + 三块控件；rect/style 可按 id 覆写（守卫测量路径的真实消费者）。 */
function mountWidgets(rects: Record<string, { left: number; right: number; top: number; bottom: number }> = {}) {
  const root = document.createElement('div')
  root.id = 'cc-root'
  for (const id of ['model', 'reasoning', 'mode']) {
    const widget = document.createElement('div')
    widget.dataset.widgetId = id
    const rect = rects[id]
    if (rect) {
      widget.getBoundingClientRect = () => ({
        ...DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }),
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        toJSON: () => ({}),
      })
    }
    root.appendChild(widget)
  }
  document.body.appendChild(root)
  return root
}

const pointer = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })

describe('createCcDragController · 阈值（#266 刀5）', () => {
  it('直线距离 ≥ 3px 即越过；阈值内不算', () => {
    expect(exceedsDragThreshold(0, 0, 3, 0)).toBe(true)
    expect(exceedsDragThreshold(0, 0, 2, 2)).toBe(false) // √8 ≈ 2.83 < 3
    expect(exceedsDragThreshold(0, 0, 3, 4, CC_DRAG_THRESHOLD_PX)).toBe(true)
    expect(exceedsDragThreshold(0, 0, 1, 1, CC_DRAG_THRESHOLD_PX)).toBe(false)
  })

  it('非编辑态：pointerdown 不选中也不挂监听', () => {
    const { ports, calls } = makePorts({ isEditMode: () => false })
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 10, 10) as unknown as PointerEvent, 'model')
    expect(calls).toHaveLength(0)
    window.dispatchEvent(pointer('pointermove', 50, 50))
    expect(calls).toHaveLength(0)
    controller.dispose()
  })

  it('阈值内松开只选中，不发任何 placement', () => {
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 10, 10) as unknown as PointerEvent, 'model')
    expect(calls[0]).toEqual({ kind: 'select', args: ['model'] })
    window.dispatchEvent(pointer('pointermove', 11, 11))
    window.dispatchEvent(pointer('pointerup', 11, 11))
    expect(calls.filter(call => call.kind === 'placement')).toHaveLength(0)
    controller.dispose()
  })

  it('越阈值即进入拖拽：位移逐帧累计提交（不是 pointerup 才算）', () => {
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 10, 10) as unknown as PointerEvent, 'model')
    window.dispatchEvent(pointer('pointermove', 30, 20))
    window.dispatchEvent(pointer('pointermove', 40, 15))
    const submissions = calls.filter(call => call.kind === 'placement')
    expect(submissions[0]?.args).toEqual(['model', { offsetX: 20, offsetY: 10 }])
    expect(submissions[1]?.args).toEqual(['model', { offsetX: 30, offsetY: 5 }])
    window.dispatchEvent(pointer('pointerup', 40, 15))
    controller.dispose()
  })

  it('其它 pointer 的 move/up 不干扰在途拖拽', () => {
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    const down = new MouseEvent('pointerdown', { clientX: 0, clientY: 0 })
    Object.defineProperty(down, 'pointerId', { value: 7 })
    controller.beginWidgetDrag(down as unknown as PointerEvent, 'model')
    const stray = new MouseEvent('pointermove', { clientX: 50, clientY: 50 })
    Object.defineProperty(stray, 'pointerId', { value: 9 })
    window.dispatchEvent(stray)
    expect(calls.filter(call => call.kind === 'placement')).toHaveLength(0)
    const own = new MouseEvent('pointermove', { clientX: 50, clientY: 50 })
    Object.defineProperty(own, 'pointerId', { value: 7 })
    window.dispatchEvent(own)
    expect(calls.filter(call => call.kind === 'placement')).toHaveLength(1)
    controller.dispose()
  })
})

describe('createCcDragController · 占区守卫接线（#238 刀4）', () => {
  it('真实测量：全量候选撞障碍 ⇒ 只垂直滑走的候选被提交', () => {
    // self 占 0..100（宽100），障碍 reasoning 正右占 140..240：候选 (50, 60) 全量撞，
    // 只水平 (50, previous.y=0) 也撞，只垂直 (previous.x=0, 60) 放行 —— 与几何单测③同一场景走真 DOM。
    mountWidgets({
      model: { left: 0, right: 100, top: 0, bottom: 40 },
      reasoning: { left: 140, right: 240, top: 0, bottom: 90 },
    })
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 0, 0) as unknown as PointerEvent, 'model')
    window.dispatchEvent(pointer('pointermove', 50, 60))
    expect(calls.filter(call => call.kind === 'placement')[0]?.args).toEqual(['model', { offsetX: 0, offsetY: 60 }])
    controller.dispose()
  })

  it('悬浮件（cc-send-button）绕过约束，候选原样提交', () => {
    mountWidgets()
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 0, 0) as unknown as PointerEvent, 'cc-send-button')
    window.dispatchEvent(pointer('pointermove', 80, 40))
    expect(calls.filter(call => call.kind === 'placement')[0]?.args).toEqual(['cc-send-button', { offsetX: 80, offsetY: 40 }])
    controller.dispose()
  })

  it('只改 order（没碰偏移）不进约束', () => {
    mountWidgets()
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.updatePlacement('model', { order: 5 })
    expect(calls[0]?.args).toEqual(['model', { order: 5 }])
    controller.dispose()
  })

  it('障碍集取自端口（`draggableIds`）：名单里没有的件当场退出障碍集', () => {
    mountWidgets({
      model: { left: 0, right: 100, top: 0, bottom: 40 },
      reasoning: { left: 140, right: 240, top: 0, bottom: 90 },
    })
    // 同一个几何场景，只把障碍名单缩到 ['model'] ⇒ 原障碍 reasoning 不再参与 ⇒ 候选取值原样放行
    const { ports, calls } = makePorts({ draggableIds: () => ['model'] })
    const controller = createCcDragController(ports)
    controller.updatePlacement('model', { offsetX: 50, offsetY: 60 })
    expect(calls[0]?.args).toEqual(['model', { offsetX: 50, offsetY: 60 }])
    controller.dispose()
  })

  it('根元素缺席（未挂载）⇒ 守卫拿不到占区，原样放行', () => {
    document.body.innerHTML = ''
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 0, 0) as unknown as PointerEvent, 'model')
    window.dispatchEvent(pointer('pointermove', 30, 30))
    expect(calls.filter(call => call.kind === 'placement')[0]?.args).toEqual(['model', { offsetX: 30, offsetY: 30 }])
    controller.dispose()
  })

  it('属性面板的 offset 写入同走守卫（两通路共用入口的回归锁）', () => {
    mountWidgets({
      model: { left: 0, right: 100, top: 0, bottom: 40 },
      reasoning: { left: 140, right: 240, top: 0, bottom: 40 },
    })
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    // 候选 (50, 0) 与正右障碍 140..240 撞 ⇒ 全量/水平/垂直全撞（垂直 (0,0)=原位）⇒ 保持原位
    controller.updatePlacement('model', { offsetX: 50 })
    expect(calls[0]?.args).toEqual(['model', { offsetX: 0, offsetY: 0 }])
    controller.dispose()
  })
})

describe('createCcDragController · 高度拖把', () => {
  it('上移加高：以按下点为基准实时提交', () => {
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginHeightDrag(pointer('pointerdown', 0, 200) as unknown as PointerEvent)
    window.dispatchEvent(pointer('pointermove', 0, 170))
    window.dispatchEvent(pointer('pointermove', 0, 160))
    const submissions = calls.filter(call => call.kind === 'height')
    expect(submissions.map(call => call.args[0])).toEqual([180, 190])
    window.dispatchEvent(pointer('pointerup', 0, 160))
    controller.dispose()
  })

  it('开始高度拖把会先掐掉在途控件拖拽', () => {
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 0, 0) as unknown as PointerEvent, 'model')
    controller.beginHeightDrag(pointer('pointerdown', 0, 200) as unknown as PointerEvent)
    // 旧控件拖拽的 move 不再生效
    window.dispatchEvent(pointer('pointermove', 50, 50))
    expect(calls.filter(call => call.kind === 'placement')).toHaveLength(0)
    controller.dispose()
  })
})

describe('createCcDragController · Escape 两段式（#266 刀5）', () => {
  it('有选中先清选中，仍留编辑态', () => {
    let selected: CcLayoutWidgetId | undefined = 'model'
    const { ports, calls } = makePorts({
      isSelected: () => selected,
      select: id => { selected = id; calls.push({ kind: 'select', args: [id] }) },
    })
    const controller = createCcDragController(ports)
    controller.handleKeydown({ key: 'Escape' })
    expect(selected).toBeUndefined()
    expect(calls.filter(call => call.kind === 'exit')).toHaveLength(0)
    controller.dispose()
  })

  it('无选中第二击退出编辑模式', () => {
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.handleKeydown({ key: 'Escape' })
    expect(calls.filter(call => call.kind === 'exit')).toHaveLength(1)
    controller.dispose()
  })

  it('非编辑态或非 Escape 键不响应', () => {
    const { ports, calls } = makePorts({ isEditMode: () => false })
    const controller = createCcDragController(ports)
    controller.handleKeydown({ key: 'Escape' })
    controller.handleKeydown({ key: 'Enter' })
    expect(calls).toHaveLength(0)
    controller.dispose()
  })
})

describe('createCcDragController · 生命周期', () => {
  it('dispose 摘除键盘监听并结束在途拖拽', () => {
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 0, 0) as unknown as PointerEvent, 'model')
    controller.dispose()
    window.dispatchEvent(pointer('pointermove', 50, 50))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(calls.filter(call => call.kind === 'placement')).toHaveLength(0)
    expect(calls.filter(call => call.kind === 'exit')).toHaveLength(0)
  })

  it('cancelActiveDrag 掐掉在途拖拽但控制器仍可用', () => {
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports)
    controller.beginWidgetDrag(pointer('pointerdown', 0, 0) as unknown as PointerEvent, 'model')
    controller.cancelActiveDrag()
    window.dispatchEvent(pointer('pointermove', 50, 50))
    expect(calls.filter(call => call.kind === 'placement')).toHaveLength(0)
    // 新一轮拖拽照常工作（退出编辑态再进场的路径）
    controller.beginWidgetDrag(pointer('pointerdown', 0, 0) as unknown as PointerEvent, 'model')
    window.dispatchEvent(pointer('pointermove', 10, 0))
    expect(calls.filter(call => call.kind === 'placement')).toHaveLength(1)
    controller.dispose()
  })

  // ★ #266 CC-13 刀3：障碍集不再是编译期常量 —— 改读**活名单派生**（`resolveCcDraggableWidgetIds`：
  //   内置表序在前、插件登记序在后）。本用例锁「内置那一半」；插件那一半见下面第二条。
  it('障碍集全集 = 活名单派生的可拖件序（内置轨 ∪ 注册槽位轨，不含 cc-surface）', () => {
    expect(BUILTIN_DRAGGABLE_IDS).toContain('model')
    expect(BUILTIN_DRAGGABLE_IDS).toContain('input')
    expect(BUILTIN_DRAGGABLE_IDS).toContain('cc-send-button')
    expect(BUILTIN_DRAGGABLE_IDS).not.toContain('cc-surface')
    // 表序在前、与定义表派生逐项一致（不是手写的第二份名单）
    expect(BUILTIN_DRAGGABLE_IDS).toEqual([...CC_WIDGET_IDS, ...CC_REGISTERED_SLOT_IDS])
  })

  it('障碍集含插件件：登记的插件 id 追加在内置之后（同一派生函数）', () => {
    const derived = resolveCcDraggableWidgetIds(resolveCcWidgetRoster([
      { ownerPluginId: 'test.cc', value: { id: 'test.cc-alpha', label: '插件件甲', render: { kind: 'host-renderer', rendererKey: 'tokens' } } },
    ]))
    expect(derived).toEqual([...BUILTIN_DRAGGABLE_IDS, 'test.cc-alpha'])
  })

  it('事件目标可注入（不碰 window 的嵌入宿主）', () => {
    const target = new EventTarget()
    const { ports, calls } = makePorts()
    const controller = createCcDragController(ports, { eventTarget: target })
    controller.beginWidgetDrag(pointer('pointerdown', 0, 0) as unknown as PointerEvent, 'model')
    target.dispatchEvent(pointer('pointermove', 10, 0))
    expect(calls.filter(call => call.kind === 'placement')).toHaveLength(1)
    controller.dispose()
  })
})
