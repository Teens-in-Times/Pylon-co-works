/**
 * chatRowPipeline — 消息列表渲染编排（纯函数模块）。
 *
 * 把 preparedMessages + messageLookups 转成每行的渲染描述符
 * （key / 工具视觉状态 / 连续 Tool 连接线 / 搜索命中），Solid 渲染侧（PlainMessageList 等）只消费描述符渲染。
 * 编排逻辑独立于渲染组件、可独立测试（scripts/test-chat-row-pipeline.mts），
 * 输入不变输出不变——渲染行为由测试锁定，拆分不会影响业务。
 */

import type { Message, RenderMessage } from './messageTypes.ts'
import type { MessageLookups } from './messageLookups.ts'
import { normalizeToolStatus, resolveToolPresentationState } from '../tool/status.ts'
import { toolIdFromMessage } from '../tool/id.ts'

export interface ChatRowDescriptor {
  /** 稳定 key：行与连接线共享（key 稳定性语义不变） */
  key: string
  renderMessage: RenderMessage
  /** 当前行的工具视觉状态（动画兼容真实 tool-* id 与浏览器 mock id） */
  toolVisualState?: string
  /** 前一行也是 Tool 时渲染连接线 */
  showConnector: boolean
  /** 连接线状态取上一个 Tool 的解析结果（follow 色用） */
  connectorStatus?: 'ok' | 'err' | 'run'
  connectorVisualState?: string
  isSearchMatch: boolean
}

export function isToolRenderMessage(renderMessage: RenderMessage | undefined): renderMessage is RenderMessage {
  return renderMessage?.type === 'tool_call' || renderMessage?.type === 'tool_result'
}

export function resolveRowToolVisualState(message: Message | undefined, lookups: MessageLookups): string | undefined {
  if (!message || message.role !== 'tool') return undefined
  const toolId = toolIdFromMessage(message)
  if (toolId) {
    if (lookups.failedToolIds.has(toolId)) return 'failed'
    if (lookups.runningToolIds.has(toolId)) return 'running'
    if (lookups.resolvedToolIds.has(toolId)) return 'completed'
  }
  if (message.running === true) return 'running'
  return normalizeToolStatus(message.toolStatus)
}

export function resolveRowToolConnectorStatus(message: Message | undefined): 'ok' | 'err' | 'run' {
  if (!message || message.role !== 'tool') return 'run'
  return resolveToolPresentationState(message.toolStatus, message.toolOutput !== undefined).tone
}

/**
 * 行描述符字段全等判定（P57 S2-R3）。文本 chunk 只应重建受影响行：其余行的
 * renderMessage 包装引用（toRenderMessage WeakMap 复用）与全部标量字段相等时，
 * 上层 items memo 可复用上个 MessageListItem 包装引用，PlainMessageList 行
 * update 因此被引用相等门跳过。
 */
export function isSameChatRowDescriptor(left: ChatRowDescriptor, right: ChatRowDescriptor): boolean {
  return left.renderMessage === right.renderMessage
    && left.toolVisualState === right.toolVisualState
    && left.showConnector === right.showConnector
    && left.connectorStatus === right.connectorStatus
    && left.connectorVisualState === right.connectorVisualState
    && left.isSearchMatch === right.isSearchMatch
}

/**
 * 生成行描述符列表。纯函数：输入（消息列表 + lookups + 搜索命中 id）不变则输出不变。
 * 连接线从上一个连续 Tool 延伸，因此 follow 色也取上一个 Tool 的状态。
 */
export function buildChatRowDescriptors(
  preparedMessages: readonly RenderMessage[],
  messageLookups: MessageLookups,
  searchMatchId: string | undefined,
): ChatRowDescriptor[] {
  return preparedMessages.map((renderMessage, index) =>
    chatRowDescriptorAt(renderMessage, index, preparedMessages, messageLookups, searchMatchId))
}

function chatRowDescriptorAt(
  renderMessage: RenderMessage,
  index: number,
  preparedMessages: readonly RenderMessage[],
  messageLookups: MessageLookups,
  searchMatchId: string | undefined,
): ChatRowDescriptor {
  const previous = preparedMessages[index - 1]
  const isToolRow = isToolRenderMessage(renderMessage)
  const hasPreviousTool = isToolRow && isToolRenderMessage(previous)
  const currentVisualState = resolveRowToolVisualState(renderMessage.message, messageLookups)
  const previousConnectorStatus = hasPreviousTool
    ? resolveRowToolConnectorStatus(previous.message)
    : undefined
  const previousConnectorVisualState = hasPreviousTool
    ? resolveRowToolVisualState(previous.message, messageLookups)
    : undefined
  return {
    key: renderMessage.message.id,
    renderMessage,
    toolVisualState: currentVisualState,
    showConnector: hasPreviousTool,
    connectorStatus: previousConnectorStatus,
    connectorVisualState: previousConnectorVisualState,
    isSearchMatch: searchMatchId === renderMessage.message.id,
  }
}

function lookupsEmpty(messageLookups: MessageLookups): boolean {
  return messageLookups.resolvedToolIds.size === 0
    && messageLookups.failedToolIds.size === 0
    && messageLookups.runningToolIds.size === 0
}

export interface PreviousDescriptors {
  /** 上一次构建的 prepared 数组（元素引用由 toRenderMessage WeakMap 保证稳定）。 */
  readonly renderMessages: readonly RenderMessage[]
  readonly descriptors: readonly ChatRowDescriptor[]
  readonly lookups: MessageLookups
  readonly searchMatchId: string | undefined
}

/**
 * #441-B：descriptors 的前缀增量构建。文本 delta 只动尾行（尾部行 renderMessage 引用
 * 换代，前缀行经 toRenderMessage WeakMap 保持引用稳定），于是按下标对齐：前缀沿用
 * 上一次的 descriptor **对象**（零分配），首个失配下标起整段重建（connector 字段依赖
 * 前一行，重建段天然取新前驱）。
 *
 * 安全阀：lookups 任一非空（legacy 预览宿主有工具行）或 searchMatchId 变化时整段回退
 * 全量构建——工具行的视觉状态可被**别的**消息（同 toolId 的 result 行）改写，引用稳定
 * 推不出内容稳定，那里不复用。canonical 生产路径三 Set 恒空 ⇒ 恒走增量。
 */
export function buildChatRowDescriptorsIncremental(
  preparedMessages: readonly RenderMessage[],
  messageLookups: MessageLookups,
  searchMatchId: string | undefined,
  previous: PreviousDescriptors | undefined,
): readonly ChatRowDescriptor[] {
  if (previous === undefined || searchMatchId !== previous.searchMatchId
    || !lookupsEmpty(messageLookups) || !lookupsEmpty(previous.lookups)) {
    return buildChatRowDescriptors(preparedMessages, messageLookups, searchMatchId)
  }
  const out: ChatRowDescriptor[] = new Array(preparedMessages.length)
  const limit = Math.min(preparedMessages.length, previous.descriptors.length)
  let index = 0
  while (index < limit && preparedMessages[index] === previous.renderMessages[index]) {
    out[index] = previous.descriptors[index]!
    index += 1
  }
  for (let rest = index; rest < preparedMessages.length; rest += 1) {
    out[rest] = chatRowDescriptorAt(preparedMessages[rest]!, rest, preparedMessages, messageLookups, searchMatchId)
  }
  return out
}

/**
 * #441-A：`buildChatRowDescriptors` 的单槽引用门，键是三元组（prepared / lookups /
 * searchMatchId）。上游 `prepareMessagesOf` 与 `messageLookupsOf` 在 messages 引用未变时
 * 返回同引用 ⇒ 本门随之命中，descriptors 不再每发布分配 N 个对象。中段行变更时上游引用
 * 必然换代，门自动失效——「只有尾部变」不必成立，这里不依赖任何尾部不变式。
 * 门未命中时走 #441-B 的增量构建（memo 携带上一次的 prepared/descriptors/lookups）。
 */
let descriptorsMemo: {
  readonly prepared: readonly RenderMessage[]
  readonly lookups: MessageLookups
  readonly searchMatchId: string | undefined
  readonly out: readonly ChatRowDescriptor[]
} | undefined

export function chatRowDescriptorsOf(
  preparedMessages: readonly RenderMessage[],
  messageLookups: MessageLookups,
  searchMatchId: string | undefined,
): readonly ChatRowDescriptor[] {
  const memo = descriptorsMemo
  if (memo !== undefined && memo.prepared === preparedMessages && memo.lookups === messageLookups
    && memo.searchMatchId === searchMatchId) return memo.out
  const out = buildChatRowDescriptorsIncremental(preparedMessages, messageLookups, searchMatchId, memo === undefined
    ? undefined
    : { renderMessages: memo.prepared, descriptors: memo.out, lookups: memo.lookups, searchMatchId: memo.searchMatchId })
  descriptorsMemo = { prepared: preparedMessages, lookups: messageLookups, searchMatchId, out }
  return out
}
