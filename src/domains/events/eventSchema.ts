/**
 * EVT-01：CanonicalConversationEvent schema（方案书 §5.10）。
 *
 * append-only 事件模型 —— 纯域模块，零框架/零 store 依赖，node 可测。
 *
 * 施工注意（§5.10）落点：
 * 1. 禁止以 content 哈希作为唯一 event identity → eventId 由 owner key + sequence
 *    确定性推导（`${ownerKey}#${sequence}`），与消息内容无关。
 * 2. eventId / toolCallId / messageId 是不同概念 → identity 子对象各自原样保存，
 *    eventId 绝不改写/复用它们。
 * 3. sequence 必须由 owner/session 范围内分配，不能依赖前端数组 index →
 *    toCanonicalOwnerKey 按 OwnerKey 维度分配（owner key = profileId+agentId+localSessionId，
 *    JSON 数组序列化，禁止冒号拼接——source 可含冒号）；allocateEventSequence 纯函数分配。
 * 4. payload schema 必须版本化 → payloadVersion 必填，禁止后续直接改旧事件解释。
 * 5. unknown event 不得静默丢弃 → eventType 含 'unknown'，rawPayload 恒保留。
 */

/** owner 维（OwnerKey = profileId+agentId+localSessionId；remoteSessionId 属 binding 维，随重连变化）。 */
export interface CanonicalEventOwner {
  profileId: string
  agentId: string
  localSessionId: string
  remoteSessionId?: string
  /** CWD-03：Workspace 实体绑定（方案 C；绑定会话携带，事件流可还原 workdir 来源）。 */
  workspaceId?: string
}

/**
 * §5.10 事件判别联合；history.snapshot 是同 journal 内的 replay reconciliation checkpoint。
 *
 * #220 WP1：词表**单源在 Rust**（`src-tauri/pylon-canonical-types`，写入侧
 * `event_repo.rs` 与 WASM 计算核 `pylon-compute` 共用），本文件只做再导出，
 * 不再手抄——此前两边各一份且无门禁，漂移只能靠人读。
 * 改词表：改 Rust 侧 → `bun run build:canonical-types`；`bun run check:canonical-types`
 * 与 `src/infrastructure/compute/__tests__/pylonCompute.test.ts` 分别在静态与运行期兜漂移。
 */
// 同时需要本地绑定（下面 `typeof` 用）与再导出，故 import + export 分开写。
import { CANONICAL_EVENT_TYPES } from './canonicalEventTypes.generated.ts'

export { CANONICAL_EVENT_TYPES }

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number]

/** 跨概念 identity：messageId / turnId / toolCallId / requestId 互相独立，原样保留。 */
export interface CanonicalEventIdentity {
  messageId?: string
  turnId?: string
  toolCallId?: string
  requestId?: string
}

export interface CanonicalConversationEvent {
  eventId: string
  owner: CanonicalEventOwner
  /** Versioned journal envelope metadata (A03); absent only on pre-A03 rows. */
  schemaVersion?: number
  provenance?: {
    origin: 'local-observed' | 'optimistic-local' | 'recovery-import' | 'migration' | 'plugin' | 'external-import'
    trust: 'authoritative' | 'unverified'
    provider?: string
    importId?: string
  }
  rawMetadata?: {
    truncated: boolean
    originalBytes: number
    retainedBytes: number
    omittedBytes: number
    reason?: string
  }
  clientGeneration: number
  sequence: number
  occurredAt: string
  receivedAt: string
  eventType: CanonicalEventType
  payloadVersion: number
  identity?: CanonicalEventIdentity
  typedPayload?: unknown
  rawPayload: unknown
}

/** 事件表序列化键（key 索引用）——与 AgentContextKey/owner key 同纪律：JSON 数组，禁止冒号拼接。 */
export function toCanonicalOwnerKey(owner: CanonicalEventOwner): string {
  return JSON.stringify([owner.profileId, owner.agentId, owner.localSessionId])
}

/** 事件唯一标识（owner key + sequence 确定性推导；与内容无关，禁止 content 哈希）。 */
export function toCanonicalEventId(owner: CanonicalEventOwner, sequence: number): string {
  return `${toCanonicalOwnerKey(owner)}#${sequence}`
}

/** sequence 纯原语：undefined → 1（首事件），否则 +1。 */
export function nextEventSequence(previous: number | undefined): number {
  return previous === undefined ? 1 : previous + 1
}

/** owner/session 范围 sequence 分配器（§5.10 rule 3）。返回新状态，不就地修改。 */
export type EventSequenceMap = Record<string, number>

export function allocateEventSequence(
  state: EventSequenceMap,
  owner: CanonicalEventOwner,
): { state: EventSequenceMap; sequence: number } {
  const key = toCanonicalOwnerKey(owner)
  const sequence = nextEventSequence(state[key])
  return { state: { ...state, [key]: sequence }, sequence }
}

export interface CreateCanonicalEventInput {
  owner: CanonicalEventOwner
  clientGeneration: number
  sequence: number
  occurredAt: string
  receivedAt?: string
  eventType: CanonicalEventType
  payloadVersion: number
  identity?: CanonicalEventIdentity
  typedPayload?: unknown
  rawPayload: unknown
}

/** 工厂：收口 schema，eventId 由 owner+sequence 推导，optional 字段按存在性落位。 */
export function createCanonicalEvent(input: CreateCanonicalEventInput): CanonicalConversationEvent {
  return {
    eventId: toCanonicalEventId(input.owner, input.sequence),
    owner: { ...input.owner },
    clientGeneration: input.clientGeneration,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    receivedAt: input.receivedAt ?? input.occurredAt,
    eventType: input.eventType,
    payloadVersion: input.payloadVersion,
    ...(input.identity ? { identity: { ...input.identity } } : {}),
    ...(input.typedPayload !== undefined ? { typedPayload: input.typedPayload } : {}),
    rawPayload: input.rawPayload,
  }
}

export function isUnknownEvent(event: CanonicalConversationEvent): boolean {
  return event.eventType === 'unknown'
}

/**
 * 完整性校验（append-only 守卫）。返回问题列表，空 = 合法；不抛异常。
 * 输入按 unknown 处理（EVT-02 持久化/JSON.parse 边界数据，TS 类型在此失效）——
 * 坏形状（null / 非对象 / owner 节点缺失或 null）返回问题项而非抛异常（CR-1）。
 * 覆盖：owner 必填、sequence/generation 正整数域、eventType 枚举、
 * payloadVersion 版本化、时间戳 ISO、eventId 与 owner+sequence 推导一致性。
 */
export function validateCanonicalEvent(event: unknown): string[] {
  const problems: string[] = []
  if (!event || typeof event !== 'object') {
    problems.push('event 必须是对象')
    return problems
  }
  const candidate = event as Partial<CanonicalConversationEvent>
  const owner = candidate.owner
  if (!owner || !owner.profileId || !owner.agentId || !owner.localSessionId) {
    problems.push('owner 必填 profileId/agentId/localSessionId')
  }
  if (!Number.isInteger(candidate.sequence) || (candidate.sequence ?? 0) < 1) {
    problems.push('sequence 必须为正整数')
  }
  if (!Number.isInteger(candidate.clientGeneration) || (candidate.clientGeneration ?? 0) < 0) {
    problems.push('clientGeneration 必须为非负整数')
  }
  if (!(CANONICAL_EVENT_TYPES as readonly string[]).includes(candidate.eventType as string)) {
    problems.push(`eventType 不在枚举内: ${String(candidate.eventType)}`)
  }
  if (!Number.isInteger(candidate.payloadVersion) || (candidate.payloadVersion ?? 0) < 1) {
    problems.push('payloadVersion 必须为正整数（schema 版本化）')
  }
  if (!Number.isInteger(Date.parse(candidate.occurredAt ?? ''))) {
    problems.push(`occurredAt 非法 ISO: ${String(candidate.occurredAt)}`)
  }
  if (!Number.isInteger(Date.parse(candidate.receivedAt ?? ''))) {
    problems.push(`receivedAt 非法 ISO: ${String(candidate.receivedAt)}`)
  }
  if (owner && Number.isInteger(candidate.sequence)) {
    if (candidate.eventId !== toCanonicalEventId(owner, candidate.sequence as number)) {
      problems.push('eventId 与 owner+sequence 推导不一致')
    }
  }
  return problems
}
