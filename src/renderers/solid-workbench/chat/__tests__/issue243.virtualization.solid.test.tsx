// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import type { JSX } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRowDescriptor } from '../../../../domains/chat/chatRowPipeline.ts'
import { toRenderMessage, type Message } from '../../../../domains/chat/messageTypes.ts'
import { createMessageListItems, type MessageListItem, type MessageListPort } from '../../../../domains/workbench/messageListPort.ts'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel, peekMarkdownRenderModel } from '../markdownRenderModel.ts'
import { markdownParseCounters } from '../markdownParseCounters.ts'
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

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }
  emit(entries?: ResizeObserverEntry[]) {
    this.callback(entries ?? [], this as unknown as ResizeObserver)
  }
  unobserve = vi.fn()
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

const rectOf = (top: number, bottom: number) => ({
  top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {},
})

/**
 * 视口 300px、scrollTop 可写的真实滚动容器（引擎的坐标基准）。
 *
 * `mountList` 是**唯一入口**：它渲染进视口后立刻给列表容器接上**忠实的滚动矩形**
 * （视口盒不动、容器随滚动上移 `scrollTop`），使组件的 scrollMargin 实测式
 * `container.top − viewport.top + scrollTop` 恒等于「列表在滚动内容流里的偏移」（此处 0）。
 * 若容器退回 jsdom 的零矩形（常量、不含 scrollTop），该式退化成 `scrollTop`——上层钉底时
 * 恰好等于"视口在列表开头"，按帧批处理的几何重测一旦跑在断言之前就会把窗口算到列表开头
 * （#301：窗外尾行永不物化、用例时红时绿）。接在挂载里而不是逐个用例手动调用，是为了让
 * "忘记接几何"不可能发生。
 */
function mountScroller() {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  let scrollTop = 0
  Object.defineProperty(scroller, 'offsetHeight', { value: 300, configurable: true })
    Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTop, set: (value: number) => { scrollTop = value }, configurable: true,
  })
  scroller.getBoundingClientRect = () => rectOf(0, 300)
  // jsdom 无布局：引擎的 getMaxScrollOffset = scrollHeight - clientHeight，缺桩会把
  // scrollToIndex 的目标偏移钳制到 0
  Object.defineProperty(scroller, 'scrollHeight', { value: 100_000, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })
  scroller.scrollTo = ((options: { top?: number }) => {
    scrollTop = options.top ?? 0
    scroller.dispatchEvent(new Event('scroll'))
  }) as unknown as typeof scroller.scrollTo
  return {
    scroller,
    readScrollTop: () => scrollTop,
    jumpTo: (value: number) => {
      scrollTop = value
      scroller.dispatchEvent(new Event('scroll'))
    },
    mountList: (view: () => JSX.Element) => {
      const result = render(view, { container: scroller })
      const listRoot = scroller.querySelector<HTMLElement>('[data-message-list="plain"]')
      // 缺了列表容器就接不上几何、夹具会退回"撒谎"状态 —— 直接响，不静默跳过
      if (!listRoot) throw new Error('mountList 只用于挂载 PlainMessageList：未找到 [data-message-list="plain"]')
      listRoot.getBoundingClientRect = () => rectOf(-scroller.scrollTop, 300 - scroller.scrollTop)
      return result
    },
  }
}

function makeItems(prefix: string, count: number, content: string): MessageListItem[] {
  return createMessageListItems(Array.from({ length: count }, (_, index) => descriptor({
    id: `${prefix}${index}`, role: 'assistant', sender: 'agent', content: `${content} ${index}`, time: '10:00',
  })))
}

/** 物化行数上界：视口 300px / 估算 76px ≈ 4 行，上下 overscan 各 8 ⇒ 24 是宽松上界。 */
const MATERIALIZED_BOUND = 24

describe('PlainMessageList #243 行虚拟化', () => {
  it('验收：1000 行会话下物化行 ≤ 视口 + overscan，其余行为占位盒', async () => {
    const { scroller, jumpTo, mountList } = mountScroller()
    let port!: MessageListPort
    const result = mountList(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }} renderItem={item => item.key}
      />
    ))
    const ids = () => result.container.querySelectorAll('[data-message-id]')
    port.setItems(makeItems('m', 1000, 'row'))
    await waitFor(() => expect(ids().length).toBeGreaterThan(0))

    jumpTo(999999) // 上层贴底姿态钉底
    await waitFor(() => expect([...ids()].at(-1)?.getAttribute('data-message-id')).toBe('m999'))
    expect(ids().length).toBeLessThanOrEqual(MATERIALIZED_BOUND)
    // 窗外行不驻留 DOM：总节点 = 窗内行；几何由容器 spacer（内联 padding）承载
    const list = result.container.querySelector<HTMLElement>('[data-message-list="plain"]')!
    expect(list.style.paddingBottom).toMatch(/px$/)
  })

  it('窗外行不驻留 DOM，几何由容器 spacer 承载；滚回即重物化', async () => {
    const { scroller, jumpTo, mountList } = mountScroller()
    let port!: MessageListPort
    const result = mountList(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }} renderItem={item => item.key}
      />
    ))
    port.setItems(makeItems('m', 500, 'row'))
    await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))

    // scrollTop=0 ⇒ 头部窗口物化；spacer 以内联 padding 承载窗外几何
    const list = result.container.querySelector<HTMLElement>('[data-message-list="plain"]')!
    expect(list.style.paddingTop).toMatch(/px$/)
    expect(result.container.querySelector('[data-message-id="m0"]')).not.toBeNull()

    // 跳到尾部：m0 卸载（窗外不驻留 DOM）；再回首部：重物化
    jumpTo(999999)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m499"]')).not.toBeNull())
    expect(result.container.querySelector('[data-message-id="m0"]')).toBeNull()
    jumpTo(0)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m0"]')).not.toBeNull())
  })

  it('D3 双阈值（取「与」）：行多字少不启用；行多字多自动启用', async () => {
    const lightScroller = mountScroller()
    // 300 行 × ~7 字符 = 远低于 100k 字符门槛 ⇒ 不启用（legacy 整挂路径）
    const light = lightScroller.mountList(() => (
      <PlainMessageList initialItems={makeItems('a', 300, 'row')} virtualization="auto"
        scrollViewport={() => lightScroller.scroller} renderItem={item => item.key} />
    ))
    expect(light.container.querySelectorAll('[data-row-placeholder]')).toHaveLength(0)
    expect(light.container.querySelectorAll('[data-message-id]')).toHaveLength(300)

    // 300 行 × 420 字符 ≈ 126k 字符 ≥ 门槛 ⇒ 自动启用
    const heavyScroller = mountScroller()
    const heavy = heavyScroller.mountList(() => (
      <PlainMessageList initialItems={makeItems('b', 300, 'x'.repeat(420))} virtualization="auto"
        scrollViewport={() => heavyScroller.scroller} renderItem={item => item.key} />
    ))
    await waitFor(() => expect(heavy.container.querySelectorAll('[data-message-id]').length).toBeLessThanOrEqual(MATERIALIZED_BOUND))
    expect(Number(heavy.container.querySelectorAll('[data-message-id]').length)).toBeGreaterThan(0)
  })

  it('杀停开关：祖先带 data-row-virtualization="off" 时整挂（#221 先例形态）', async () => {
    const { scroller } = mountScroller()
    const host = document.createElement('div')
    host.setAttribute('data-row-virtualization', 'off')
    document.body.append(host)
    const result = render(() => (
      <PlainMessageList initialItems={makeItems('m', 500, 'row')} virtualization="on"
        scrollViewport={() => scroller} renderItem={item => item.key} />
    ), { container: host })
    await Promise.resolve()
    expect(result.container.querySelectorAll('[data-message-id]')).toHaveLength(500)
    expect(result.container.querySelectorAll('[data-row-placeholder]')).toHaveLength(0)
  })

  it('scrollTo 命中占位区：只物化目标附近（不再全开），返回 true', async () => {
    const { scroller, mountList } = mountScroller()
    let port!: MessageListPort
    const result = mountList(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }} renderItem={item => item.key}
      />
    ))
    port.setItems(makeItems('m', 1000, 'row'))
    await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))

    const hit = await port.scrollTo({ messageId: 'm600', align: 'start' })
    expect(hit).toBe(true)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m600"]')).not.toBeNull())
    expect(result.container.querySelectorAll('[data-message-id]').length).toBeLessThanOrEqual(MATERIALIZED_BOUND)
    expect(result.container.querySelector('[data-message-id="m0"]')).toBeNull()
  })

  it('虚拟化下持续物化的行跨 setItems 保持 DOM 身份（P57 S2-R3 不因虚拟化松动）', async () => {
    const { scroller, mountList } = mountScroller()
    let port!: MessageListPort
    const result = mountList(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }}
        renderItem={item => <span>{item.descriptor.renderMessage.message.content}</span>}
      />
    ))
    port.setItems(makeItems('m', 500, 'row'))
    await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))

    // 记住当前在窗内的一个行节点，原引用喂入内容更新 ⇒ 节点引用必须不变
    ;(globalThis as { __probeTag?: string }).__probeTag = 'first-mount'
    const stable = result.container.querySelector('[data-message-id="m0"]')
    if (stable === null) {
      // m0 可能不在初始窗内（窗锚在头部的 scrollTop=0 起点必含 m0）——此处必在
      throw new Error('m0 应在初始窗内')
    }
    const items = makeItems('m', 500, 'row')
    const updatedDescriptor = descriptor({
      ...items[0]!.descriptor.renderMessage.message,
      content: 'row 0 updated',
    })
    ;(globalThis as { __probeTag?: string }).__probeTag = 'before-update'
    port.setItems([{ key: updatedDescriptor.key, descriptor: updatedDescriptor }, ...items.slice(1)])
    ;(globalThis as { __probeTag?: string }).__probeTag = 'after-update'
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m0"]')).toHaveTextContent('row 0 updated'))
    expect(result.container.querySelector('[data-message-id="m0"]')).toBe(stable)
  })

  it('#243 实测回填：pin 姿态下视口起点之上的行按实测差值补偿 scrollTop（引擎修正链路）', async () => {
    // 行元素真实高度 76px（与估算一致）；jsdom 无布局，桩在 HTMLElement 原型上
    const proto = HTMLElement.prototype
    Object.defineProperty(proto, 'offsetHeight', { get: () => 76, configurable: true })
    try {
      const { scroller, readScrollTop, jumpTo, mountList } = mountScroller()
      let port!: MessageListPort
      const result = mountList(() => (
        <PlainMessageList
          initialItems={[]} virtualization="on" scrollViewport={() => scroller}
          scrollPosture={() => 'pin'}
          onPortReady={value => { port = value }} renderItem={item => item.key}
        />
      ))
      port.setItems(makeItems('m', 200, 'row'))
      await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))

      // 视口下移 400px：m0/m1 整体位于视口起点之上（76+76 ≤ 400）
      jumpTo(400)
      await waitFor(() => expect(readScrollTop()).toBe(400))

      // m1 实测长高 100px：经引擎 RO → resizeItem → 姿态门控（pin）→ scrollTop +100
      const m1 = result.container.querySelector<HTMLElement>('[data-message-id="m1"]')!
      Object.defineProperty(m1, 'offsetHeight', { value: 176, configurable: true })
      const entry = { target: m1, borderBoxSize: [{ inlineSize: 100, blockSize: 176 }] } as unknown as ResizeObserverEntry
      ResizeObserverMock.instances.at(-1)!.emit([entry])
      await waitFor(() => expect(readScrollTop()).toBe(500))
    } finally {
      delete (proto as { offsetHeight?: unknown }).offsetHeight
    }
  })

  it('#243 切片4：行卸载后再挂载不重解析（markdown LRU 计数证明，D7 改口径②）', async () => {
    clearMarkdownRenderModelCache()
    const { scroller, jumpTo, mountList } = mountScroller()
    let port!: MessageListPort
    // 全部行共享同一 markdown 串 ⇒ LRU 里只有一条目：任何重挂载若走解析即计 parsed+1，
    // 走缓存即计 cacheHits+1——往返一趟后 parsed 零增长就是「不重解析」的计数证明。
    const mdContent = '# 共享标题\n\n共享正文段落'
    const result = mountList(() => (
      <PlainMessageList
        initialItems={[]} virtualization="on" scrollViewport={() => scroller}
        onPortReady={value => { port = value }}
        renderItem={item => {
          void getMarkdownRenderModel(mdContent)
          return <span>{item.descriptor.renderMessage.message.id}</span>
        }}
      />
    ))
    port.setItems(makeItems('m', 500, 'row'))
    await waitFor(() => expect(result.container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0))
    // 等首解析落地
    await waitFor(() => expect(peekMarkdownRenderModel(mdContent) !== undefined).toBe(true))

    const baseline = markdownParseCounters()
    // 滚到尾部：m0 卸载；再回首部：m0 重挂载
    jumpTo(999999)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m499"]')).not.toBeNull())
    jumpTo(0)
    await waitFor(() => expect(result.container.querySelector('[data-message-id="m0"]')).not.toBeNull())

    const after = markdownParseCounters()
    expect(after.parsed).toBe(baseline.parsed) // 重挂载零解析
    expect(after.cacheHits).toBeGreaterThan(baseline.cacheHits) // 命中 LRU
  })
})
