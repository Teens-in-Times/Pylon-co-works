import { describe, expect, it } from 'vitest'
import { toRenderMessage } from '../../../../domains/chat/messageTypes.ts'
import { estimateRowHeight } from '../rowHeightEstimate.ts'
import type { ChatRowDescriptor } from '../../../../domains/chat/chatRowPipeline.ts'
import type { MessageListItem } from '../../../../domains/workbench/messageListPort.ts'
import type { Message } from '../../../../domains/chat/messageTypes.ts'

function item(message: Partial<Message> & Pick<Message, 'id' | 'role'>, estimatedHeight?: number): MessageListItem {
  const full: Message = { sender: 'user', content: '', time: '10:00', ...message } as Message
  const descriptor: ChatRowDescriptor = {
    key: full.id,
    renderMessage: toRenderMessage(full),
    showConnector: false,
    isSearchMatch: false,
    groupStart: true,
    groupEnd: true,
  }
  return estimatedHeight === undefined ? { key: descriptor.key, descriptor } : { key: descriptor.key, descriptor, estimatedHeight }
}

describe('rowHeightEstimate', () => {
  it('确定性：同一 item 恒出同一值', () => {
    const message = item({ id: 'm1', role: 'assistant', content: 'hello world' })
    expect(estimateRowHeight(message)).toBe(estimateRowHeight(message))
  })

  it('单调性：内容越长估值越高（滚动条刻度方向不能反）', () => {
    const short = estimateRowHeight(item({ id: 'm1', role: 'assistant', content: 'x'.repeat(50) }))
    const medium = estimateRowHeight(item({ id: 'm2', role: 'assistant', content: 'x'.repeat(500) }))
    const long = estimateRowHeight(item({ id: 'm3', role: 'assistant', content: 'x'.repeat(5000) }))
    expect(short).toBeLessThan(medium)
    expect(medium).toBeLessThan(long)
  })

  it('代码块抬高估算（``` 围栏成对计块）', () => {
    const plain = estimateRowHeight(item({ id: 'm1', role: 'assistant', content: 'x'.repeat(200) }))
    const withCode = estimateRowHeight(item({ id: 'm2', role: 'assistant', content: `text\n\`\`\`js\n${'x'.repeat(200)}\n\`\`\`` }))
    expect(withCode).toBeGreaterThan(plain)
  })

  it('reasoning 折叠封顶（#208：>8000 字符默认折叠，估算不按全量展开）', () => {
    const folded = estimateRowHeight(item({ id: 'm1', role: 'reasoning', content: 'x'.repeat(20000) }))
    expect(folded).toBeLessThan(estimateRowHeight(item({ id: 'm2', role: 'assistant', content: 'x'.repeat(20000) })))
  })

  it('tool_result 优先采用投影层声明的 toolOutputLines', () => {
    const declared = estimateRowHeight(item({ id: 'm1', role: 'tool', content: '', toolOutput: 'out', toolOutputLines: 40 }))
    const undeclared = estimateRowHeight(item({ id: 'm2', role: 'tool', content: '', toolOutput: 'out' }))
    expect(declared).toBeGreaterThan(undeclared)
  })

  it('redacted 消息只剩安全占位（C01 隐去推理不按内容长度估算）', () => {
    const redacted = estimateRowHeight(item({ id: 'm1', role: 'reasoning', content: 'x'.repeat(5000), redacted: true }))
    const normal = estimateRowHeight(item({ id: 'm2', role: 'reasoning', content: 'x'.repeat(5000) }))
    expect(redacted).toBeLessThan(normal)
  })

  it('estimatedHeight 缝显式给值时优先于本地公式', () => {
    const seam = item({ id: 'm1', role: 'assistant', content: 'x'.repeat(5000) }, 123)
    expect(estimateRowHeight(seam)).toBe(123)
  })
})
