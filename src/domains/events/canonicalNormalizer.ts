/**
 * EVT-03：live/replay/restart 统一 canonical normalizer（方案书 §5.11）。
 *
 * 单一入口：live、replay、SQLite recovery（restart）三类原始 wire envelope 全部进入
 * `normalizeRawEvent`，产出 EVT-01 canonical 事件（§5.10 最小 schema）。
 *
 * §5.11 禁止项落点：
 * - 禁止 live 直接读取 `upd.toolCallId`、replay 读取另一套 alias → 工具 identity 唯一
 *   解析路径 `resolveToolCallId`（本模块），live/replay 共用（单一路径解析 tool identity）。
 * - 禁止正式 commitReplaySnapshot 自己维护一份 switch → replay/restart 路径经
 *   `normalizeRawEvent` 分类，不再自带 sessionUpdate switch。
 * - 禁止 malformed event 直接跳过且不落 raw → malformed/unknown 恒产出
 *   `eventType: 'unknown'` 的 canonical 事件，`rawPayload` 恒为原始 wire（§5.10 原则 5）。
 *
 * 纯域模块：仅依赖 EVT-01 eventSchema（`./eventSchema`），零框架 / 零 store。
 *
 * 工具 identity 解析顺序（单一路径，与既有 replay 路径 `replayToolId` 一致，保序）：
 *   toolCallId  root → content → _meta（root 优先——Peri 工具 id 在 update 根）；
 *   messageId/eventId/turnId  content → root → _meta（content 优先——Peri 消息 id 在 content）。
 *   别名均含 snake_case / toolUseId 兼容（ID_ALIASES）。
 */

import {
  createCanonicalEvent,
  type CanonicalConversationEvent,
  type CanonicalEventIdentity,
  type CanonicalEventOwner,
  type CanonicalEventType,
} from './eventSchema.ts'
import {
  CANONICAL_TYPE_FOR_WIRE,
  canonicalTypeForToolCallUpdate,
  type StandardWireSessionUpdateKind,
} from './wireSemanticCorrespondence.ts'

/** 各 identity 字段的 wire 别名（单一路径源；禁止在调用方再维护第二套）。
 * 注：wire 的 eventId 属"事件自身 id"概念（§5.10 施工注意 2：eventId/toolCallId/messageId
 * 是不同概念），不落入 canonical identity（canonical eventId 由 owner+sequence 推导）。 */
const ID_ALIASES: Record<keyof CanonicalEventIdentity, readonly string[]> = {
  messageId: ['messageId', 'message_id'],
  turnId: ['turnId', 'turn_id'],
  toolCallId: ['toolCallId', 'tool_call_id', 'toolUseId', 'tool_use_id'],
  requestId: ['requestId', 'request_id'],
}

/** 记录扫描顺序：toolCallId 根优先（保既有 replay 路径语义），其余 content 优先。 */
const TOOL_CALL_ID_RECORDS = ['root', 'content', 'meta'] as const
const OTHER_ID_RECORDS = ['content', 'root', 'meta'] as const

/** canonical normalize 输入上下文（调用方组装 owner/generation/sequence——§5.10 rule 3）。 */
export interface CanonicalNormalizeContext {
  owner: CanonicalEventOwner
  clientGeneration: number
  sequence: number
  /** 接收时间；缺省取当前时间。 */
  receivedAt?: string
}

/** canonical normalize 结果：事件恒存在（malformed/unknown 亦产出，raw 不丢）+ 分类元信息。 */
export interface CanonicalNormalizeResult {
  event: CanonicalConversationEvent
  /** 原始 wire 判别符（wire-only 类型如 usage/session_info 经此区分，canonical 归 'unknown'）。 */
  sessionUpdate?: string
  /** 解析出的原始 update 对象（调用方做能力门控 identity/usage 等 wire 专属处理的原始依据）。 */
  update?: Record<string, unknown>
  malformed: boolean
  warning?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = nonEmptyString(record[key])
    if (value) return value
  }
  return undefined
}

/**
 * 从任意 wire envelope 提取 update 对象（宽容：`$.params.update` / `$.update` /
 * 裸 SessionUpdate——与已收敛删除的旧 replayNormalizer.extractEnvelope 同宽容度）。
 */
function extractUpdate(raw: unknown): { update?: Record<string, unknown> } {
  if (!isObject(raw)) return {}
  const params = isObject(raw.params) ? raw.params : undefined
  const paramsUpdate = params?.update
  if (isObject(paramsUpdate)) return { update: paramsUpdate }
  if (isObject(raw.update)) return { update: raw.update }
  if (typeof raw.sessionUpdate === 'string') return { update: raw }
  if (typeof params?.sessionUpdate === 'string') return { update: params }
  return {}
}

/** 工具事件负载（title/kind/rawInput/rawOutput/status/contentBlocks 全保留，字段不丢）。 */
function toolPayload(update: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!update || (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')) return undefined
  const tool: Record<string, unknown> = {}
  const title = nonEmptyString(update.title)
  const kind = nonEmptyString(update.kind)
  const status = nonEmptyString(update.status)
  if (title) tool.title = title
  if (kind) tool.kind = kind
  if (update.rawInput !== undefined) tool.rawInput = update.rawInput
  if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput
  if (status) tool.status = status
  if (update.content !== undefined) tool.contentBlocks = update.content
  return tool
}

/** 文本类事件负载（user/assistant-text/assistant-thinking）。原样保留空格（live/replay 投影深等依赖）。 */
function textOf(update: Record<string, unknown> | undefined): string | undefined {
  if (!update) return undefined
  const content = isObject(update.content) ? update.content : undefined
  const text = content?.text ?? update.text
  return typeof text === 'string' && text.length > 0 ? text : undefined
}

/** 单一权威身份解析：按 ID_ALIASES 与字段级记录顺序提取 messageId/eventId/turnId/toolCallId。 */
export function resolveEventIdentity(update: unknown): CanonicalEventIdentity | undefined {
  if (!isObject(update)) return undefined
  const root = update
  const content = isObject(update.content) ? update.content : undefined
  const meta = isObject(update._meta) ? update._meta : undefined
  const result: CanonicalEventIdentity = {}
  const pick = (
    field: keyof CanonicalEventIdentity,
    records: readonly ('root' | 'content' | 'meta')[],
  ) => {
    for (const recordName of records) {
      const record = recordName === 'root' ? root : recordName === 'content' ? content : meta
      const value = firstString(record, ID_ALIASES[field])
      if (value) {
        result[field] = value
        return
      }
    }
  }
  pick('toolCallId', TOOL_CALL_ID_RECORDS)
  pick('messageId', OTHER_ID_RECORDS)
  pick('turnId', OTHER_ID_RECORDS)
  pick('requestId', OTHER_ID_RECORDS)
  return Object.keys(result).length > 0 ? result : undefined
}

/** 工具 identity 唯一解析路径（§5.11 禁止项 1：live/replay 共用，不得各自读字段）。 */
export function resolveToolCallId(update: unknown): string | undefined {
  return resolveEventIdentity(update)?.toolCallId
}

/** wire sessionUpdate → canonical eventType 映射。
 *  #315 P2：映射表单源化至 `wireSemanticCorrespondence.ts`（与 workbench
 *  acpNormalizer 的 parity 由对应表钉住）；本函数只保留委托与 tool_call_update
 *  的 status 细化规则。 */
export function canonicalEventTypeFor(sessionUpdate: unknown, status: unknown): CanonicalEventType {
  if (sessionUpdate === 'tool_call_update') return canonicalTypeForToolCallUpdate(status)
  const kind = typeof sessionUpdate === 'string' ? sessionUpdate : undefined
  return kind !== undefined
    ? CANONICAL_TYPE_FOR_WIRE[kind as StandardWireSessionUpdateKind] ?? 'unknown'
    : 'unknown'
}

/**
 * 统一 canonical normalize 入口（live / replay / SQLite recovery 三路径共用）。
 * 恒产出 canonical 事件：malformed/unknown 亦产出 `eventType: 'unknown'`，
 * `rawPayload` 恒为原始 wire（§5.10 原则 5——unknown 不静默丢弃）。
 */
export function normalizeRawEvent(raw: unknown, context: CanonicalNormalizeContext): CanonicalNormalizeResult {
  const { update } = extractUpdate(raw)
  const malformed = update === undefined
  const sessionUpdate = malformed ? undefined
    : typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined
  const eventType = canonicalEventTypeFor(sessionUpdate, update?.status)
  const identity = resolveEventIdentity(update)
  const tool = toolPayload(update)
  const text = textOf(update)
  const typedPayload: Record<string, unknown> = {}
  if (text !== undefined) typedPayload.text = text
  if (tool) typedPayload.tool = tool
  if (sessionUpdate === 'error') {
    const error = nonEmptyString(update?.error) ?? nonEmptyString(update?.message)
    if (error) typedPayload.error = error
  }
  if (sessionUpdate === 'cancelled') {
    // Cancellation is represented by the canonical failure family. Keep the
    // reason in typed payload so replay can distinguish it without parsing
    // provider text.
    typedPayload.stopReason = 'cancelled'
  }
  if (sessionUpdate === 'done') {
    // D5: completion metadata is additive and keeps payloadVersion stable.
    for (const field of ['stopReason', 'usage', 'model'] as const) {
      if (update?.[field] !== undefined) typedPayload[field] = update[field]
    }
  }
  if (sessionUpdate === 'session_info_update') {
    // 与内核 `event_repo::normalize` 同源：ACP `SessionInfoUpdate.title/updatedAt`
    // 是 `MaybeUndefined`，键存在即落 typed（`null` 原样保留 = 显式清空），缺席不落。
    // 压平任一侧都会让两栈对「Agent 要求清空标题」给出不同事实。
    for (const field of ['title', 'updatedAt'] as const) {
      if (update !== undefined && field in update) typedPayload[field] = update[field]
    }
  }
  const event = createCanonicalEvent({
    owner: context.owner,
    clientGeneration: context.clientGeneration,
    sequence: context.sequence,
    occurredAt: context.receivedAt ?? new Date().toISOString(),
    receivedAt: context.receivedAt,
    eventType,
    payloadVersion: 1,
    identity,
    typedPayload: Object.keys(typedPayload).length > 0 ? typedPayload : undefined,
    rawPayload: raw,
  })
  return {
    event,
    sessionUpdate,
    update,
    malformed,
    warning: malformed ? '未找到可解析的 update envelope（raw 已保留）' : undefined,
  }
}
