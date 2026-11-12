import { toolIdFromMessage } from '../tool/id.ts'
import type { ContentBlock, OptionalChatEventIdentity } from '../../infrastructure/acp/chatContracts.ts'
import type { ContentPart } from '../workbench/content/contentPartSchema.ts'

export function assertNever(value: never, context = '未处理的消息状态'): never {
  throw new Error(`${context}: ${String(value)}`)
}

/** 消息角色单一真值数组（Skin Schema componentVariants 等动态枚举来源） */
export const MESSAGE_ROLES = ['user', 'assistant', 'tool', 'reasoning'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

export interface Message {
  id: string
  role: MessageRole
  sender: string
  content: string
  time: string
  /** P0-2：owner AgentContext 的 agentId（reducer 按 agentId+source 隔离时事件已携带；
   * 旧消息/持久化会话缺省 → 渲染回退按名称解析 provider）。 */
  agentId?: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolOutputLines?: number
  running?: boolean
  interruptedDraft?: boolean
  draftId?: string
  thoughtStartedAt?: number
  thoughtDurationMs?: number
  /** C01：provider 隐去推理——渲染层据此显示安全占位，不显示正文。 */
  redacted?: boolean
  redactedReason?: string
  toolStatus?: string
  /** P1-04：语义工具 kind（协议化渲染主键；旧消息无此字段 → 渲染回退按名字，向后兼容） */
  toolKind?: string
  /** P1-04：结构化内容块（含 tool_diff_content；raw 保留，消费方式后变） */
  contentBlocks?: ContentBlock[]
  /** Typed display parts carried by a Workbench projection or browser snapshot. */
  semanticParts?: readonly ContentPart[]
  /** EVT-04：工具 wire 原始 input/output（字段不丢——toolInput/toolOutput 为投影字符串，
   * raw 原样保留供 ToolProjection；live/replay/restart 三路径深等验收 §5.11） */
  rawInput?: unknown
  rawOutput?: unknown
  /** EVT-04：该消息所属 binding 建立时的 agent generation 快照（OWNER-04；canonical
   * clientGeneration 落 Message——三路径投影深等字段） */
  clientGeneration?: number
  /** 乐观渲染标识（release-issues #1 方案 B）：发送即渲染的用户消息带 clientMsgId，
   * 后端 `pylon:user` 到达时按 id 去重确认，避免重复显示。 */
  clientMsgId?: string
  /** 通用 ACP adapter 明确提供时的可选外部身份。 */
  externalIdentity?: OptionalChatEventIdentity
}

export type RenderMessage =
  | { type: 'user'; message: Message }
  | { type: 'assistant'; message: Message }
  | { type: 'reasoning'; message: Message }
  | { type: 'tool_call'; message: Message; toolId: string | null }
  | { type: 'tool_result'; message: Message; toolId: string | null }
  | { type: 'error'; message: Message }
  | { type: 'system'; message: Message; reason: 'unknown-role' }

export type RenderDecision =
  | { kind: 'render'; message: RenderMessage }
  | { kind: 'skip'; reason: VisibilityReason }

export type VisibilityReason = 'empty-assistant'

export function renderDecisionKind(decision: RenderDecision): RenderDecision['kind'] {
  switch (decision.kind) {
    case 'render':
    case 'skip':
      return decision.kind
    default:
      return assertNever(decision, '未处理的渲染决策')
  }
}

// P57 S2-R3：RenderMessage 包装按 Message 引用复用。canonical 链路的 Message
// 引用稳定性由 runtime 侧 freezeItems/legacyFields memo 保证；包装引用稳定后，
// 行级 descriptor 字段比较才有稳定键，未变化行可零成本通过显示链。
const renderMessageCache = new WeakMap<Message, RenderMessage>()

export function toRenderMessage(message: Message): RenderMessage {
  const cached = renderMessageCache.get(message)
  if (cached) return cached
  const built = toRenderMessageUncached(message)
  renderMessageCache.set(message, built)
  return built
}

function toRenderMessageUncached(message: Message): RenderMessage {
  if (message.sender === 'system' && message.role === 'assistant') {
    return { type: 'error', message }
  }

  switch (message.role) {
    case 'user':
      return { type: 'user', message }
    case 'assistant':
      return { type: 'assistant', message }
    case 'reasoning':
      return { type: 'reasoning', message }
    case 'tool':
      return message.toolOutput !== undefined
        ? { type: 'tool_result', message, toolId: toolIdFromMessage(message) }
        : { type: 'tool_call', message, toolId: toolIdFromMessage(message) }
    default:
      return { type: 'system', reason: 'unknown-role', message }
  }
}
