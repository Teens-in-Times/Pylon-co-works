import { describe, expect, it } from 'vitest'
import { buildChatRowDescriptors, chatRowDescriptorsOf } from '../chatRowPipeline.ts'
import { messageLookupsOf } from '../messageLookups.ts'
import { prepareMessagesOf } from '../messagePipeline.ts'
import type { Message } from '../messageTypes.ts'
import { createMessageListItems, reuseMessageListItems, type MessageListItem } from '../../workbench/messageListPort.ts'

function message(id: string, content: string): Message {
  return {
    id,
    role: 'assistant',
    sender: 'peri',
    content,
    time: '2026-09-29T00:00:00.000Z',
  } as Message
}

describe('#441-A 显示链单槽引用门', () => {
  it('prepareMessagesOf：输入引用未变时复用输出引用；内容相同但引用不同时重算', () => {
    const messages = [message('a', '第一'), message('b', '第二')]
    const first = prepareMessagesOf(messages)
    expect(prepareMessagesOf(messages)).toBe(first)
    // 内容相同、引用不同（applyLive 每事件换新数组）⇒ 门失效，重新映射
    const next = [...messages]
    const second = prepareMessagesOf(next)
    expect(second).not.toBe(first)
    expect(second).toHaveLength(first.length)
  })

  it('messageLookupsOf：同上', () => {
    const messages = [message('a', '第一')]
    const first = messageLookupsOf(messages)
    expect(messageLookupsOf(messages)).toBe(first)
    expect(messageLookupsOf([message('a', '第一')])).not.toBe(first)
  })

  it('chatRowDescriptorsOf：三元组引用全等才命中；任一成员换代即重算', () => {
    const messages = [message('a', '第一'), message('b', '第二')]
    const prepared = prepareMessagesOf(messages)
    const lookups = messageLookupsOf(messages)
    const first = chatRowDescriptorsOf(prepared, lookups, undefined)
    expect(chatRowDescriptorsOf(prepared, lookups, undefined)).toBe(first)
    expect(chatRowDescriptorsOf(prepared, lookups, 'a')).not.toBe(first)
    const otherPrepared = prepareMessagesOf([...messages])
    expect(chatRowDescriptorsOf(otherPrepared, lookups, undefined)).not.toBe(first)
  })

  it('reuseMessageListItems：稳态「输出喂回」命中；未变行保持 item 引用（P57 S2-R3）', () => {
    const messages = [message('a', '第一'), message('b', '第二')]
    const descriptors = chatRowDescriptorsOf(prepareMessagesOf(messages), messageLookupsOf(messages), undefined)
    const initial = reuseMessageListItems([], descriptors)
    // 组件稳态：上一拍的输出原样喂回当 previous，descriptors 未变 ⇒ 原样返回（#441-A 门）
    expect(reuseMessageListItems(initial, descriptors)).toBe(initial)

    // 文本 delta：尾行 descriptor 换新（其余引用稳定）⇒ 只有尾行换 item，且新输出成为新稳态
    const grownMessages = [...messages.slice(0, -1), message('b', '第二续')]
    const grownDescriptors = chatRowDescriptorsOf(
      prepareMessagesOf(grownMessages),
      messageLookupsOf(grownMessages),
      undefined,
    )
    const grown = reuseMessageListItems(initial, grownDescriptors)
    expect(grown).not.toBe(initial)
    expect(grown[0]).toBe(initial[0])
    expect(grown[1]).not.toBe(initial[1])
    expect(grown[1]?.descriptor.renderMessage.message.content).toBe('第二续')
    expect(reuseMessageListItems(grown, grownDescriptors)).toBe(grown)

    // createMessageListItems（无复用的首构）仍可用
    expect(createMessageListItems(descriptors)).toHaveLength(descriptors.length)
    const unused: readonly MessageListItem[] = createMessageListItems(descriptors)
    expect(unused[0]?.key).toBe('a')
  })

  it('#441-B 前缀增量：尾行变更时前缀 descriptor 对象原样沿用，失配段重建', () => {
    const messages = [message('a', '第一'), message('b', '第二'), message('c', '第三')]
    const first = chatRowDescriptorsOf(prepareMessagesOf(messages), messageLookupsOf(messages), undefined)
    const grown = [...messages.slice(0, 2), message('c', '第三续')]
    const second = chatRowDescriptorsOf(prepareMessagesOf(grown), messageLookupsOf(grown), undefined)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]).not.toBe(first[2])
    expect(second[2]?.renderMessage.message.content).toBe('第三续')
    // 中段变更：前缀到失配下标为止沿用
    const middleChanged = [messages[0]!, message('b', '第二改'), messages[2]!]
    const third = chatRowDescriptorsOf(prepareMessagesOf(middleChanged), messageLookupsOf(middleChanged), undefined)
    expect(third[0]).toBe(first[0])
    expect(third[1]).not.toBe(first[1])
    // 审查轮补锁：增量输出与全量构建逐字段等价（重建段 connector 取新前驱、row 0 语义）
    expect(third).toStrictEqual(buildChatRowDescriptors(
      prepareMessagesOf(middleChanged),
      messageLookupsOf(middleChanged),
      undefined,
    ))
    expect(second).toStrictEqual(buildChatRowDescriptors(
      prepareMessagesOf(grown),
      messageLookupsOf(grown),
      undefined,
    ))
  })

  it('#441-B groupEnd 取后继：尾部缩短时旧尾行重建为组尾，前段引用稳定', () => {
    const messages = [message('a', '第一'), message('b', '第二'), message('c', '第三')]
    const first = chatRowDescriptorsOf(prepareMessagesOf(messages), messageLookupsOf(messages), undefined)
    expect(first.map(d => [d.groupStart, d.groupEnd])).toEqual([[true, false], [false, false], [false, true]])
    const shorter = messages.slice(0, 2)
    const second = chatRowDescriptorsOf(prepareMessagesOf(shorter), messageLookupsOf(shorter), undefined)
    expect(second).toHaveLength(2)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1]?.groupEnd).toBe(true)
    expect(second).toStrictEqual(buildChatRowDescriptors(
      prepareMessagesOf(shorter),
      messageLookupsOf(shorter),
      undefined,
    ))
  })

  it('#441-B 安全阀：lookups 非空（legacy 工具行）回退全量构建', () => {
    const base = [message('a', '第一')]
    const firstLookups = messageLookupsOf(base)
    const first = chatRowDescriptorsOf(prepareMessagesOf(base), firstLookups, undefined)
    // 工具行使 lookups 非空 ⇒ 即便 renderMessage 引用稳定也不复用（工具状态可被他行改写）
    const toolRow = {
      id: 'tool-t1', role: 'tool', sender: 'tool:Read', content: '',
      toolName: 'Read', toolInput: '', toolOutput: 'out', toolOutputLines: 1, toolStatus: 'completed', time: 't',
    } as unknown as Message
    const withTool = [...base, toolRow]
    const toolLookups = messageLookupsOf(withTool)
    expect(toolLookups.resolvedToolIds.size).toBeGreaterThan(0)
    const second = chatRowDescriptorsOf(prepareMessagesOf(withTool), toolLookups, undefined)
    expect(second[0]).not.toBe(first[0])
    expect(second).toHaveLength(2)
  })
})
