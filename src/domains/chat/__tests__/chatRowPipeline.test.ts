// 迁移自 scripts/test-chat-row-pipeline.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { buildChatRowDescriptors, isToolRenderMessage, resolveRowToolConnectorStatus } from '../chatRowPipeline.ts'
import { buildMessageLookups } from '../messageLookups.ts'
import { toRenderMessage, type Message } from '../messageTypes.ts'

function toolMessage(id: string, status: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'tool', sender: 'tool:Read', content: '', toolName: 'Read', toolInput: '', toolOutput: 'out', toolOutputLines: 1, toolStatus: status, time: 't', ...extra }
}

const user: Message = { id: 'u1', role: 'user', sender: 'local', content: 'hi', time: 't' }
const assistant: Message = { id: 'a1', role: 'assistant', sender: 'peri', content: 'reply', time: 't' }
const reasoning: Message = { id: 'r1', role: 'reasoning', sender: 'peri', content: 'think', time: 't' }
const toolRunning: Message = toolMessage('tool-1', 'in_progress', { running: true })
const toolDone: Message = toolMessage('tool-2', 'completed')

describe('chatRowPipeline 纯辅助函数', () => {
  it('isToolRenderMessage 只认 tool_call/tool_result 包装', () => {
    expect(isToolRenderMessage(toRenderMessage(toolRunning))).toBe(true)
    expect(isToolRenderMessage(toRenderMessage(user))).toBe(false)
    expect(isToolRenderMessage(undefined)).toBe(false)
  })

  it('resolveRowToolConnectorStatus：completed → ok，非 tool → run', () => {
    expect(resolveRowToolConnectorStatus(toolDone)).toBe('ok')
    expect(resolveRowToolConnectorStatus(user)).toBe('run')
  })
})

describe('chatRowPipeline 编排：连续 Tool 连接线 + 视觉状态 + 搜索命中', () => {
  const messages = [user, reasoning, toolRunning, toolDone, assistant]
  const prepared = messages.map(toRenderMessage)
  const lookups = buildMessageLookups(messages)
  const descs = buildChatRowDescriptors(prepared, lookups, 'a1')

  it('描述符数量 = 消息数，key = 消息 id（稳定）', () => {
    expect(descs.length).toBe(5)
    expect(descs.map(d => d.key)).toEqual(messages.map(m => m.id))
  })

  it('连续 Tool 渲染连接线，状态取上一个 tool，当前 tool 视觉状态独立', () => {
    // tool-2 前一行是 tool-1 → 显示连接线，状态取上一个 tool（running）
    expect(descs[3].showConnector).toBe(true)
    expect(descs[3].connectorStatus).toBe('run')
    expect(descs[3].toolVisualState).toBe('completed')
    // tool-1 前一行是 reasoning → 无连接线
    expect(descs[2].showConnector).toBe(false)
  })

  it('搜索命中只落在命中 id 的行', () => {
    expect(descs[4].isSearchMatch).toBe(true)
    expect(descs[0].isSearchMatch).toBe(false)
  })

  it('纯函数不变性：同输入同输出（深等）', () => {
    const again = buildChatRowDescriptors(prepared, lookups, 'a1')
    expect(again).toEqual(descs)
  })

  it('无搜索命中：所有行 isSearchMatch 为 false', () => {
    const noMatch = buildChatRowDescriptors(prepared, lookups, undefined)
    expect(noMatch.every(d => d.isSearchMatch === false)).toBe(true)
  })
})

describe('chatRowPipeline 编排：消息分组（同角色 + 5 分钟窗口）', () => {
  const time = (iso: string) => `2026-10-30T${iso}.000Z`
  const at = (id: string, role: Message['role'], iso: string, extra: Partial<Message> = {}): Message =>
    ({ id, role, sender: role === 'user' ? 'local' : 'peri', content: id, time: time(iso), ...extra })
  const groupFlags = (messages: Message[]) => {
    const descs = buildChatRowDescriptors(messages.map(toRenderMessage), buildMessageLookups(messages), undefined)
    return descs.map(d => [d.groupStart, d.groupEnd])
  }

  it('同角色且间隔 ≤ 5 分钟：只有首行 groupStart、末行 groupEnd', () => {
    const messages = [
      at('u1', 'user', '10:00:00'),
      at('u2', 'user', '10:04:59'),
      at('u3', 'user', '10:09:58'),
    ]
    expect(groupFlags(messages)).toEqual([[true, false], [false, false], [false, true]])
  })

  it('间隔超过 5 分钟或角色切换即断开分组', () => {
    const messages = [
      at('u1', 'user', '10:00:00'),
      at('u2', 'user', '10:05:01'),
      at('a1', 'assistant', '10:05:02'),
      at('a2', 'assistant', '10:05:03'),
    ]
    expect(groupFlags(messages)).toEqual([
      [true, true],
      [true, true],
      [true, false],
      [false, true],
    ])
  })

  it('system/error 行自身不可分组，并中断两侧的同角色连续段', () => {
    const error = at('e1', 'assistant', '10:00:30', { sender: 'system' })
    const messages = [at('u1', 'user', '10:00:00'), at('u2', 'user', '10:01:00'), error, at('u3', 'user', '10:02:00')]
    expect(groupFlags(messages)).toEqual([
      [true, false],
      [false, true],
      [true, true],
      [true, true],
    ])
  })

  it('时间不可解析（非法 ISO）不并入分组', () => {
    const messages = [
      at('a1', 'assistant', '10:00:00'),
      { id: 'a2', role: 'assistant', sender: 'peri', content: 'a2', time: 'not-a-date' } as Message,
    ]
    expect(groupFlags(messages)).toEqual([[true, true], [true, true]])
  })
})
