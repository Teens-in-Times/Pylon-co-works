// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRowDescriptor } from '../../../../domains/chat/chatRowPipeline.ts'
import { toRenderMessage, type Message } from '../../../../domains/chat/messageTypes.ts'
import { createMessageListItems, type MessageListItem, type MessageListPort } from '../../../../domains/workbench/messageListPort.ts'
import { PlainMessageList } from '../PlainMessageList.solid.tsx'

function descriptor(message: Message): ChatRowDescriptor {
  return {
    key: message.id,
    renderMessage: toRenderMessage(message),
    showConnector: false,
    isSearchMatch: false,
    groupStart: true,
    groupEnd: true,
  }
}

const ITEMS = createMessageListItems([
  descriptor({ id: 'm1', role: 'user', sender: 'user', content: 'one', time: '10:00' }),
  descriptor({ id: 'm2', role: 'assistant', sender: 'agent', content: 'two', time: '10:01' }),
])

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }
  /** #409：entries 可省略（=空数组，不构成任何 target 信号）；给 target 时按 contentRect 构造 entry。 */
  emit(entries: Array<{ target: HTMLElement; width?: number; height?: number }> = []) {
    const resolved = entries.map(entry => ({
      target: entry.target,
      contentRect: {
        width: entry.width ?? entry.target.getBoundingClientRect().width,
        height: entry.height ?? entry.target.getBoundingClientRect().height,
        top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}),
      },
      borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
    }))
    this.callback(resolved as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
  }
  unobserve = vi.fn()
}

/** 组件自己的 RO：引擎（有 scrollViewport 时 adapter onMount 先建）与 #243 的内容
 * 容器观察器也在 instances 里，以「观察了列表容器」这一特征定位，不依赖顺序。 */
function componentObserver() {
  return ResizeObserverMock.instances.find(m =>
    m.observe.mock.calls.some(c => (c[0] as HTMLElement | undefined)?.classList?.contains('plain-message-list')))!
}

beforeEach(() => {
  ResizeObserverMock.instances = []
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PlainMessageList', () => {
  it('marks only live tail appends and expires the entry before a row can remount', () => {
    vi.useFakeTimers()
    try {
      let live = false
      let port!: MessageListPort
      const result = render(() => <PlainMessageList initialItems={ITEMS} animateEntry={() => live}
        onPortReady={value => { port = value }} renderItem={item => item.key} />)
      const third = createMessageListItems([descriptor({ id: 'm3', role: 'assistant', sender: 'agent', content: 'three', time: '10:02' })])[0]!
      const fourth = createMessageListItems([descriptor({ id: 'm4', role: 'assistant', sender: 'agent', content: 'four', time: '10:03' })])[0]!

      expect(result.container.querySelector('[data-entry="new"]')).toBeNull()
      port.setItems([...ITEMS, third])
      expect(result.container.querySelector('[data-message-id="m3"]')).not.toHaveAttribute('data-entry')

      live = true
      port.setItems([...ITEMS, third, fourth])
      const row = result.container.querySelector('[data-message-id="m4"]')
      expect(row).toHaveAttribute('data-entry', 'new')
      port.setItems([...ITEMS, third, createMessageListItems([descriptor({
        id: 'm4', role: 'assistant', sender: 'agent', content: 'four updated', time: '10:03',
      })])[0]!])
      expect(result.container.querySelector('[data-message-id="m4"]')).toBe(row)
      expect(row).toHaveAttribute('data-entry', 'new')

      vi.advanceTimersByTime(760)
      expect(row).not.toHaveAttribute('data-entry')
      port.setItems([createMessageListItems([descriptor({
        id: 'history', role: 'assistant', sender: 'agent', content: 'old session', time: '09:00',
      })])[0]!])
      expect(result.container.querySelector('[data-message-id="history"]')).not.toHaveAttribute('data-entry')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not revisit keys when the immutable input array is unchanged', () => {
    let reads = 0
    const items = ITEMS.map(item => ({ get key() { reads++; return item.key }, descriptor: item.descriptor }))
    let port!: MessageListPort
    render(() => <PlainMessageList initialItems={items} onPortReady={value => { port = value }} renderItem={item => item.key} />)
    const before = reads
    for (let index = 0; index < 10; index++) port.setItems(items)
    expect(reads).toBe(before)
  })

  it('keeps row identity and content across reordering, insertion and trimming', () => {
    let port!: MessageListPort
    const result = render(() => <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }}
      renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>} />)
    const original = result.container.querySelector('[data-message-id="m2"]')
    const inserted = createMessageListItems([descriptor({ id: 'm3', role: 'user', sender: 'user', content: 'three', time: '10:02' })])[0]
    port.setItems([ITEMS[1], inserted, ITEMS[0]])
    expect([...result.container.querySelectorAll('[data-message-id]')].map(node => node.getAttribute('data-message-id'))).toEqual(['m2', 'm3', 'm1'])
    port.setItems([ITEMS[1]])
    expect(result.container.querySelector('[data-message-id="m2"]')).toBe(original)
    expect(result.container.querySelectorAll('[data-message-id]')).toHaveLength(1)
    expect(result.container.textContent).toBe('two')
  })

  it('把分组标记输出到行容器（data-group-start/end）', () => {
    const first = { ...descriptor({ id: 'g1', role: 'user', sender: 'user', content: 'one', time: '10:00' }), groupEnd: false }
    const second = { ...descriptor({ id: 'g2', role: 'user', sender: 'user', content: 'two', time: '10:01' }), groupStart: false }
    const result = render(() => (
      <PlainMessageList initialItems={createMessageListItems([first, second])} renderItem={item => item.key} />
    ))
    const firstRow = result.container.querySelector('[data-message-id="g1"]')
    const secondRow = result.container.querySelector('[data-message-id="g2"]')
    expect(firstRow).toHaveAttribute('data-group-start', 'true')
    expect(firstRow).not.toHaveAttribute('data-group-end')
    expect(secondRow).not.toHaveAttribute('data-group-start')
    expect(secondRow).toHaveAttribute('data-group-end', 'true')
  })

  it('用 Solid For 渲染全部 item，并通过 port 替换列表', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList
        initialItems={ITEMS}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))

    expect(result.container.querySelectorAll('[data-message-id]')).toHaveLength(2)
    expect(result.container.textContent).toContain('one')
    expect(result.container.textContent).toContain('two')

    port!.setItems([ITEMS[1]!])
    expect(result.container.querySelectorAll('[data-message-id]')).toHaveLength(1)
    expect(result.container.textContent).not.toContain('one')
  })

  it('反复用新对象替换同一消息列表时不累积 DOM 行', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList
        initialItems={ITEMS}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))

    for (let iteration = 0; iteration < 100; iteration += 1) {
      port!.setItems(createMessageListItems(ITEMS.map(item => ({
        ...item.descriptor,
        renderMessage: toRenderMessage({ ...item.descriptor.renderMessage.message }),
      }))))
    }

    const rows = result.container.querySelectorAll('[data-message-id]')
    expect(rows).toHaveLength(2)
    expect(result.container.querySelectorAll('[data-message-id="m1"]')).toHaveLength(1)
    expect(result.container.querySelectorAll('[data-message-id="m2"]')).toHaveLength(1)
  })

  it('同一 key 更新 descriptor 时保持行 DOM 身份并显示最新内容', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList
        initialItems={ITEMS}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))
    const row = result.container.querySelector('[data-message-id="m2"]')
    const updated = descriptor({
      ...ITEMS[1]!.descriptor.renderMessage.message,
      content: 'two updated incrementally',
    })

    port!.setItems(createMessageListItems([ITEMS[0]!.descriptor, updated]))

    expect(result.container.querySelector('[data-message-id="m2"]')).toBe(row)
    expect(row).toHaveTextContent('two updated incrementally')
  })

  // P57 S2-R3：引用相等喂入零成本通过——不调用行 update（descriptor getter 不再
  // 被读取）、不失效测量；引用变化的行照常更新。
  it('引用相等的 setItems 跳过行 update 与测量失效', async () => {
    let descriptorReads = 0
    const tracked: MessageListItem = {
      key: ITEMS[0]!.key,
      get descriptor() {
        descriptorReads += 1
        return ITEMS[0]!.descriptor
      },
    }
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList
        initialItems={[tracked, ITEMS[1]!]}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))
    const container = result.container.querySelector('[data-message-list="plain"]') as HTMLDivElement
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const baselineRevision = container.dataset.measurementRevision
    const baselineReads = descriptorReads

    // 全等引用喂入（上层 items memo per-key 复用后的形态）
    port!.setItems([tracked, ITEMS[1]!])
    await nextFrame()
    expect(container.dataset.measurementRevision).toBe(baselineRevision)
    expect(descriptorReads).toBe(baselineReads)

    // 引用变化喂入照常生效
    const updated = descriptor({ ...ITEMS[1]!.descriptor.renderMessage.message, content: 'changed' })
    port!.setItems([tracked, { key: updated.key, descriptor: updated }])
    await nextFrame()
    expect(container.dataset.measurementRevision).toBe(String(Number(baselineRevision) + 1))
    expect(result.container.querySelector('[data-message-id="m2"]')).toHaveTextContent('changed')
    // 未变化的 tracked 行不被牵连
    expect(descriptorReads).toBe(baselineReads)
  })

  it('scrollTo 只通过 messageId 定位内部行，不暴露 DOM', async () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const row = result.container.querySelector('[data-message-id="m2"]') as HTMLElement

    expect(await port!.scrollTo({ messageId: 'm2', align: 'center' })).toBe(true)
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(await port!.scrollTo({ messageId: 'missing', align: 'nearest' })).toBe(false)
  })

  it('scrollToBottom 使用内部 bottom anchor', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const bottom = result.container.querySelector('.plain-message-list__bottom') as HTMLElement

    port!.scrollToBottom('smooth')
    expect(bottom.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' })
  })

  it('读取 viewport state，返回可见首尾消息', () => {
    let port: MessageListPort | undefined
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const container = result.container.querySelector('[data-message-list="plain"]') as HTMLDivElement
    const rows = [...result.container.querySelectorAll<HTMLElement>('[data-message-id]')]

    Object.defineProperties(container, {
      scrollTop: { value: 100, configurable: true },
      scrollHeight: { value: 500, configurable: true },
      clientHeight: { value: 200, configurable: true },
    })
    container.getBoundingClientRect = () => ({ top: 20, bottom: 220, left: 0, right: 100, width: 100, height: 200, x: 0, y: 20, toJSON() {} })
    rows[0]!.getBoundingClientRect = () => ({ top: 20, bottom: 100, left: 0, right: 100, width: 100, height: 80, x: 0, y: 20, toJSON() {} })
    rows[1]!.getBoundingClientRect = () => ({ top: 100, bottom: 230, left: 0, right: 100, width: 100, height: 130, x: 0, y: 100, toJSON() {} })

    expect(port!.getViewportState()).toMatchObject({
      distanceFromBottom: 200,
      atBottom: false,
      firstVisibleMessageId: 'm1',
      lastVisibleMessageId: 'm2',
    })
  })

  const rectOf = (top: number, bottom: number) => ({
    top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {},
  })

  /**
   * #243 长会话视口夹具（两条窗口用例同一挂载形态）：视口高 300px、scrollTop 可写。
   *
   * **几何必须忠实（#301）**：视口盒的矩形不随滚动移动（真实浏览器行为），列表容器的矩形
   * 随滚动上移 `scrollTop`——组件的 scrollMargin 实测式
   * `container.top − viewport.top + scrollTop` 因此恒等于「列表在滚动内容流里的偏移」
   * （本夹具无 leading 内容 ⇒ 0），与何时重测无关。
   *
   * 若容器退回 jsdom 的零矩形（常量、不含 scrollTop），该式就退化成 `scrollTop`：上层钉底时
   * 它恰好等于"视口在列表开头"，于是**按帧批处理**的几何重测只要跑在断言之前，引擎就把
   * 窗口算到新会话开头（`b0…b11`、`padding-top: 0`），尾行永不物化。那是夹具造的假状态，
   * 与并行度无关、只随帧调度时红时绿——#301 的成因，不是产品缺陷。
   */
  function mountVirtualizedList() {
    const scroller = document.createElement('div')
    document.body.append(scroller)
    let scrollTop = 0
    Object.defineProperty(scroller, 'offsetHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop, set: (value: number) => { scrollTop = value }, configurable: true,
    })
    // 视口高 300px；「row N」行估算高 76px ⇒ 视口内 ~4 行 + 上下 overscan 各 8
    scroller.getBoundingClientRect = () => rectOf(0, 300)
    let port!: MessageListPort
    render(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }} renderItem={item => item.key}
      />
    ), { container: scroller })
    // 列表容器**随滚动内容上移**（生产真实几何：它自己不滚动）。矩形在读取时取当前
    // scrollTop，故几何在整条用例期间始终成立，而不是只在桩建立的那一刻。
    const listRoot = scroller.querySelector<HTMLElement>('[data-message-list="plain"]')!
    listRoot.getBoundingClientRect = () => rectOf(-scrollTop, 300 - scrollTop)
    return {
      port,
      ids: () => [...scroller.querySelectorAll('[data-message-id]')].map(node => node.getAttribute('data-message-id')),
      jumpTo: (value: number) => { scrollTop = value; scroller.dispatchEvent(new Event('scroll')) },
    }
  }

  /**
   * #243 改写（原 #212 S3b「冷开时按窗口渐进挂载（尾部优先），逐帧扩满」）：
   * 长会话的窗口语义从「尾部只增」改为「视口窗口」——冷开只物化尾部一个有界窗
   * （视口 + overscan，「尾部优先」由上层贴底姿态把 scrollTop 钉到底部实现），
   * 其余行是等高占位盒；不再有「逐帧扩满」——DOM 规模从此不随历史行数增长。
   * 改写理由逐条登记于 .agents/records/243-long-session-row-virtualization.md。
   */
  it('#243：冷开长会话只物化尾部有界窗，其余为占位盒；窗口随滚动步进（D2）', async () => {
    const { port, ids, jumpTo } = mountVirtualizedList()
    const hundred = createMessageListItems(Array.from({ length: 100 }, (_, index) => descriptor({
      id: `m${index}`, role: 'assistant', sender: 'agent', content: `row ${index}`, time: '10:00',
    })))

    port.setItems(hundred)
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    // 物化行有界（≤ 视口 + 2×overscan），窗外行不驻留 DOM
    expect(ids().length).toBeLessThanOrEqual(24)
    // 上层贴底姿态钉住 scrollTop ⇒ 尾部行在窗内
    jumpTo(99999)
    await waitFor(() => expect(ids()).toContain('m99'))
    expect(ids().length).toBeLessThanOrEqual(24)

    // 滚到中部：窗口随视口步进（增量回卷 = 窗随滚动逐行扩出历史），物化行仍有界
    jumpTo(3000)
    await waitFor(() => expect(ids()).toContain('m40'))
    expect(ids().length).toBeLessThanOrEqual(24)
  })

  /**
   * #243 改写（原 #212 S3b「增量增长不缩窗（小列表整挂）」，断言原样保留）：
   * 该用例钉的是**短会话**（低于 D3 双阈值 ⇒ 虚拟化不启用）的既有契约——整挂且
   * 追加不缩窗，属「短会话行为逐字节不变」验收的一部分。标题更新以点明路径归属。
   * 改写理由逐条登记于 .agents/records/243-long-session-row-virtualization.md。
   */
  it('#243：短会话（低于阈值，legacy 路径）整挂且追加不缩窗', () => {
    let port!: MessageListPort
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} renderItem={item => item.key} />
    ))
    const ids = () => [...result.container.querySelectorAll('[data-message-id]')]
      .map(node => node.getAttribute('data-message-id'))
    const three = createMessageListItems([
      descriptor({ id: 'm3', role: 'user', sender: 'user', content: 'three', time: '10:02' }),
    ])
    port.setItems([...ITEMS, three[0]!])
    expect(ids()).toEqual(['m1', 'm2', 'm3'])
  })

  /** 真实滚动容器：坐标基准必须是 scroller，不是列表容器（审核 M2）。 */
  function mountInScroller(props: { posture: 'follow' | 'pin' }) {
    const scroller = document.createElement('div')
    document.body.append(scroller)
    let scrollTop = 100
    Object.defineProperty(scroller, 'offsetHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop, set: (value: number) => { scrollTop = value }, configurable: true,
    })
    scroller.getBoundingClientRect = () => rectOf(0, 645)
    const result = render(() => (
      <PlainMessageList
        initialItems={ITEMS}
        scrollViewport={() => scroller}
        scrollPosture={() => props.posture}
        renderItem={item => item.key}
      />
    ), { container: scroller })
    // 列表容器**随内容一起平移**（生产的真实几何：它自己不滚动，上方内容长高会把它连同
    // 行一起推下去）。不模拟这一点，"用容器当基准"的错误实现会因为 jsdom 的零 rect
    // 退化成同样结果而蒙混过关——审核 M2 指出的正是旧用例把错误坐标系钉住了。
    let contentShift = 0
    const listContainer = scroller.querySelector<HTMLElement>('[data-message-list="plain"]')!
    listContainer.getBoundingClientRect = () => rectOf(contentShift, 645 + contentShift)
    return {
      scroller, result, readScrollTop: () => scrollTop,
      shiftContent: (value: number) => { contentShift = value },
    }
  }

  it('#212 S4：pin 姿态下上方行高度变化时补偿 scrollTop（自管锚点）', () => {
    const { scroller, readScrollTop, shiftContent } = mountInScroller({ posture: 'pin' })
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')]
    const observer = componentObserver()
    // 文档空间 top = rect.top - 视口顶(0) + scrollTop(100)。row0 全在视口上方 ⇒ 不参与；
    // row1 从视口顶开始 ⇒ 它是锚。
    rows[0]!.getBoundingClientRect = () => rectOf(-180, -100)
    rows[1]!.getBoundingClientRect = () => rectOf(-100, 30)
    observer.emit()
    expect(readScrollTop()).toBe(100)

    // 上方行长高 50 ⇒ 行与容器一起下移 50（容器基准会抵掉这个位移，视口基准不会）⇒ 补偿 50
    shiftContent(50)
    rows[0]!.getBoundingClientRect = () => rectOf(-180, -50)
    rows[1]!.getBoundingClientRect = () => rectOf(-50, 80)
    observer.emit()
    expect(readScrollTop()).toBe(150)
  })

  it('#212 S4：follow 姿态不补偿（贴底跟随才是意图）', () => {
    const { scroller, readScrollTop } = mountInScroller({ posture: 'follow' })
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')]
    const observer = componentObserver()
    rows[0]!.getBoundingClientRect = () => rectOf(-180, -100)
    rows[1]!.getBoundingClientRect = () => rectOf(-100, 30)
    observer.emit()
    rows[1]!.getBoundingClientRect = () => rectOf(-50, 80)
    observer.emit()
    expect(readScrollTop()).toBe(100)
  })

  it('#213：包装层 data-streaming 跟随权威活性（缺省仍回落 running）', async () => {
    const live = createMessageListItems([descriptor({ id: 'm9', role: 'assistant', sender: 'agent', content: '旧回合的残行', time: '10:00' })])
    // 投影语义仍是"未见终态"，但权威活性说"不在途"——包装层不得再播流式装饰。
    Object.assign(live[0]!.descriptor.renderMessage.message as object, { running: true })
    const first = render(() => (
      <PlainMessageList initialItems={live} onPortReady={() => {}} rowLive={() => false} renderItem={item => item.key} />
    ))
    await Promise.resolve()
    expect(first.container.querySelector('[data-streaming]')).toBeNull()

    // 缺省（不传 rowLive）回落 running ⇒ legacy 行为不变
    const second = render(() => (
      <PlainMessageList initialItems={live} onPortReady={() => {}} renderItem={item => item.key} />
    ))
    await Promise.resolve()
    expect(second.container.querySelector('[data-streaming="true"]')).not.toBeNull()
  })

  /**
   * #243 改写（原 #212 S3b「换代中途挂起的扩窗不得按旧会话行数收敛」）：
   * 虚拟化路径没有「挂起的扩窗」可被旧总长污染，但同一威胁换了形态——换代必须把
   * 窗口收敛到**新会话尾部**的有界窗，而不是沿用旧会话的滚动位置/窗口规模全开。
   * 改写理由逐条登记于 .agents/records/243-long-session-row-virtualization.md。
   */
  it('#243：换代把窗口收敛到新会话尾部，不按旧会话规模扩满', async () => {
    const { port, ids, jumpTo } = mountVirtualizedList()
    const mk = (count: number, prefix: string) => createMessageListItems(Array.from({ length: count }, (_, index) => descriptor({
      id: `${prefix}${index}`, role: 'assistant', sender: 'agent', content: `row ${index}`, time: '10:00',
    })))
    port.setItems(mk(100, 'a'))
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))
    // 上层贴底姿态钉住 scrollTop ⇒ 尾部行在窗内
    jumpTo(99999)
    await waitFor(() => expect(ids()).toContain('a99'))

    // 同一 流 内换到更长的会话：窗口必须收敛到新会话尾部附近的有界窗
    port.setItems(mk(300, 'b'))
    await waitFor(() => expect(ids()).toContain('b299'))
    expect(ids().length).toBeLessThanOrEqual(24)
  })

  it('invalidation 与 ResizeObserver 更新 revision；destroy 幂等并清理 observer/DOM', () => {
    let port: MessageListPort | undefined
    const onContentResize = vi.fn()
    const result = render(() => (
      <PlainMessageList initialItems={ITEMS} onPortReady={value => { port = value }} onContentResize={onContentResize} renderItem={item => item.key} />
    ))
    const container = result.container.querySelector('[data-message-list="plain"]') as HTMLDivElement
    const observer = componentObserver()

    port!.invalidateMeasurements('theme-changed')
    expect(container.dataset.measurementRevision).toBe('1')
    expect(container.dataset.measurementReason).toBe('theme-changed')

    // #409 口径：首次回调整立宽度基线（真实 RO 挂载即发初始尺寸），不构成失效
    observer.emit([{ target: container, width: 800, height: 500 }])
    expect(container.dataset.measurementRevision).toBe('1')
    expect(onContentResize).toHaveBeenCalledTimes(1)

    // container **宽度**变化的 entry 才走 container-resized 全量失效
    observer.emit([{ target: container, width: 760, height: 500 }])
    expect(container.dataset.measurementRevision).toBe('2')
    expect(container.dataset.measurementReason).toBe('container-resized')
    expect(observer.observe).toHaveBeenCalledTimes(3)

    // 行条目 / container 纯高度变化（行增高的级联）不触发全量失效，onContentResize 照常
    const before = container.dataset.measurementRevision
    const rowNode = container.querySelector('[data-message-id]') as HTMLElement
    observer.emit([{ target: rowNode, width: 760, height: 120 }])
    observer.emit([{ target: container, width: 760, height: 620 }])
    expect(container.dataset.measurementRevision).toBe(before)
    expect(onContentResize).toHaveBeenCalledTimes(4)

    port!.destroy()
    port!.destroy()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(container.childElementCount).toBe(0)
  })
})
