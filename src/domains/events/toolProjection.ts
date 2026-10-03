/**
 * EVT-04：Message/Tool projection（方案书 §5.11 验收——字段不丢）。
 *
 * §5.11 验收：同一个 ACP event 通过 live、replay、restart 三条路径，最终 ToolProjection 的
 * 以下字段深等：
 *   toolCallId / toolName(title) / kind / rawInput / rawOutput / status / contentBlocks /
 *   owner / clientGeneration
 *
 * 本模块是唯一投影路径（纯域，零框架/零 store，node 可测）：
 * - `toolFieldsFromCanonical`：工具字段一律自 canonical `typedPayload.tool` 提取——live/replay
 *   工具 dispatch 共用同一组字段（§5.11 禁止项"normalizer 能识别的字段 commit 路径识别不了"，
 *   以及禁止项"live/replay 各自读字段"）。caller 不得再读 wire 别名。
 * - `projectToolFromCanonical`：canonical 工具事件 → 全字段 ToolProjection。
 * - `projectToolFromMessage`：controller 三路径落为 tool Message 后投影（验收测试用）。
 *   owner/generation 为 session/binding 维——由调用方以权威 session 解析传入（与 canonical
 *   事件 owner 推导同一来源）。
 */

import type { CanonicalConversationEvent, CanonicalEventOwner } from './eventSchema'
import type { ContentBlock } from '../../infrastructure/acp/chatContracts'

/** §5.11 验收投影字段（9 项，字段不丢）。 */
export interface ToolProjection {
  toolCallId?: string
  /** wire title（§5.11 "toolName/title" 同义）。 */
  toolName?: string
  kind?: string
  rawInput?: unknown
  rawOutput?: unknown
  status?: string
  contentBlocks?: unknown
  owner: CanonicalEventOwner
  clientGeneration: number
}

/** canonical 工具负载的投影字段（自 typedPayload.tool 提取）。 */
export interface ToolFields {
  title?: string
  kind?: string
  rawInput?: unknown
  rawOutput?: unknown
  status?: string
  contentBlocks?: unknown
}

/** 单一路径提取工具字段（§5.11：normalizer 产出的字段，live/replay dispatch 必须识别同一组）。 */
export function toolFieldsFromCanonical(event: { typedPayload?: unknown }): ToolFields {
  const tool = (event.typedPayload as { tool?: Record<string, unknown> } | undefined)?.tool
  return {
    title: typeof tool?.title === 'string' ? tool.title : undefined,
    kind: typeof tool?.kind === 'string' ? tool.kind : undefined,
    rawInput: tool?.rawInput,
    rawOutput: tool?.rawOutput,
    status: typeof tool?.status === 'string' ? tool.status : undefined,
    contentBlocks: tool?.contentBlocks,
  }
}

const TOOL_EVENT_TYPES = new Set<CanonicalConversationEvent['eventType']>([
  'tool.call.started',
  'tool.call.updated',
  'tool.call.completed',
  'tool.call.failed',
])

/** canonical 工具事件 → 全字段 ToolProjection；非工具事件返回 undefined。 */
export function projectToolFromCanonical(event: CanonicalConversationEvent): ToolProjection | undefined {
  if (!TOOL_EVENT_TYPES.has(event.eventType)) return undefined
  const tool = toolFieldsFromCanonical(event)
  return {
    toolCallId: event.identity?.toolCallId,
    toolName: tool.title,
    kind: tool.kind,
    rawInput: tool.rawInput,
    rawOutput: tool.rawOutput,
    status: tool.status,
    contentBlocks: tool.contentBlocks,
    owner: event.owner,
    clientGeneration: event.clientGeneration,
  }
}

/** Message 级投影所需的最小 tool 字段集（controller 落为 tool Message 后投影）。 */
export interface ToolProjectableMessage {
  externalIdentity?: { toolCallId?: string }
  toolName?: string
  toolKind?: string
  rawInput?: unknown
  rawOutput?: unknown
  toolStatus?: string
  contentBlocks?: ContentBlock[]
}

/**
 * Message 级投影（三路径验收：同一 ACP event 经 live/replay/restart 落为 tool Message 后，
 * 以同一 owner/generation 投影深等）。owner 由权威 session 解析（profileId+agentId+localSessionId
 * 与 canonical 事件 owner 同一来源）；clientGeneration 为 binding 快照（bindingGenerations）。
 */
export function projectToolFromMessage(
  message: ToolProjectableMessage,
  owner: CanonicalEventOwner,
  clientGeneration: number,
): ToolProjection | undefined {
  const toolCallId = message.externalIdentity?.toolCallId
  if (toolCallId === undefined && message.toolName === undefined && message.toolKind === undefined) return undefined
  return {
    toolCallId,
    toolName: message.toolName,
    kind: message.toolKind,
    rawInput: message.rawInput,
    rawOutput: message.rawOutput,
    status: message.toolStatus,
    contentBlocks: message.contentBlocks,
    owner,
    clientGeneration,
  }
}
