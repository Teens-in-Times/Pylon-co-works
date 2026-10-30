import { describe, expect, it } from 'vitest'
import { createFakeMessageListPort } from '../../../test-utils/fakeMessageListPort.ts'
import { createMessageListItems, type MessageViewportState } from '../messageListPort.ts'
import { selectMessageViewportState } from '../messageViewportState.ts'
import type { ChatRowDescriptor } from '../../chat/chatRowPipeline.ts'
import { toRenderMessage, type Message } from '../../chat/messageTypes.ts'

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

const MESSAGES: Message[] = [
  { id: 'm1', role: 'user', sender: 'user', content: 'one', time: '10:00' },
  { id: 'm2', role: 'assistant', sender: 'agent', content: 'two', time: '10:01' },
]

describe('MessageListPort domain contract', () => {
  it('descriptor 转换保留稳定 key 与引用', () => {
    const descriptors = MESSAGES.map(descriptor)
    const items = createMessageListItems(descriptors)
    expect(items.map(item => item.key)).toEqual(['m1', 'm2'])
    expect(items[0]?.descriptor).toBe(descriptors[0])
  })

  it('Fake port 记录 set/scroll/invalidation，destroy 后静默', async () => {
    const port = createFakeMessageListPort()
    port.setItems(createMessageListItems(MESSAGES.map(descriptor)))
    expect(await port.scrollTo({ messageId: 'm2', align: 'center' })).toBe(true)
    expect(await port.scrollTo({ messageId: 'missing', align: 'nearest' })).toBe(false)
    port.scrollToBottom('smooth')
    port.invalidateMeasurements('font-changed')
    port.destroy()
    port.destroy()
    port.scrollToBottom('auto')

    expect(port.calls).toEqual([
      { type: 'set-items', itemKeys: ['m1', 'm2'] },
      { type: 'scroll-to', anchor: { messageId: 'm2', align: 'center' } },
      { type: 'scroll-to', anchor: { messageId: 'missing', align: 'nearest' } },
      { type: 'scroll-to-bottom', behavior: 'smooth' },
      { type: 'invalidate', reason: 'font-changed' },
      { type: 'destroy' },
    ])
  })

  it('Fake port 可注入 viewport state', () => {
    const port = createFakeMessageListPort()
    const viewport: MessageViewportState = {
      scrollTop: 50,
      scrollHeight: 500,
      clientHeight: 200,
      distanceFromBottom: 250,
      atBottom: false,
      firstVisibleMessageId: 'm1',
      lastVisibleMessageId: 'm2',
    }
    port.setViewportState(viewport)
    expect(port.getViewportState()).toEqual(viewport)
  })
})

describe('selectMessageViewportState', () => {
  it('计算可见首尾行和距底距离', () => {
    expect(selectMessageViewportState({
      scrollTop: 100,
      scrollHeight: 500,
      clientHeight: 200,
      rows: [
        { messageId: 'before', top: 0, bottom: 100 },
        { messageId: 'm1', top: 100, bottom: 180 },
        { messageId: 'm2', top: 180, bottom: 310 },
        { messageId: 'after', top: 310, bottom: 400 },
      ],
    })).toEqual({
      scrollTop: 100,
      scrollHeight: 500,
      clientHeight: 200,
      distanceFromBottom: 200,
      atBottom: false,
      firstVisibleMessageId: 'm1',
      lastVisibleMessageId: 'm2',
    })
  })

  it('距底 48px 内判定贴底，并收窄非法数值', () => {
    const state = selectMessageViewportState({
      scrollTop: Number.NaN,
      scrollHeight: 248,
      clientHeight: 200,
      rows: [],
    })
    expect(state.distanceFromBottom).toBe(48)
    expect(state.atBottom).toBe(true)
    expect(state.scrollTop).toBe(0)
  })
})
