/**
 * Stateless canonical/workbench projection helpers for the agent workbench
 * session host: canonical journal row → workbench envelope expansion (#81 L1/L2),
 * turn-duration reads, local session-fact event synthesis. Pure functions —
 * they cannot mutate lifecycle state or access persistence.
 */
import { toCanonicalOwnerKey, validateCanonicalEvent, type CanonicalConversationEvent } from '../../domains/events/eventSchema.ts'
import { parseTurnUnitPayload } from '../../domains/events/canonicalUnit.ts'
import {
  canonicalBatchChunksOf,
  canonicalBatchSpanOf,
  isCanonicalBatchDeltaType,
} from '../../infrastructure/events/canonicalEventBatch.ts'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal, latestTurnBoundary, type CanonicalTurnBoundaryEvent, type LatestTurnBoundary } from '../../domains/events/canonicalTurnDuration.ts'
import { createWorkbenchEnvelope, migrateWorkbenchEnvelope, type JsonValue, type SessionEvent, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import type { ContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import { normalizeAgentEvent } from '../../domains/workbench/normalizers/agentEventNormalizer.ts'
import type { WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import { findConfigOption } from '../../infrastructure/acp/chatContracts.ts'
import type { SessionConfigOption } from '../../domains/workbench/session/sessionSurface.ts'

/** A write Pylon performed itself and the provider confirmed. */
export type LocalSessionFact =
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'mode'; readonly mode: string }
  | { readonly kind: 'option'; readonly id: string; readonly value: string | boolean }

function normalizeCanonicalRowToEnvelopes(
  event: CanonicalConversationEvent,
  raw: unknown,
  sequence: number,
  eventId: string,
  coverage?: readonly [number, number],
): readonly WorkbenchEventEnvelope[] {
  const provider = event.provenance?.provider ?? event.owner.agentId
  const optimistic = isOptimisticUserEvent(raw)
  const normalized = normalizeAgentEvent(raw, {
    provider,
    sessionId: event.owner.localSessionId,
    sourceId: eventId,
    sequence,
    recordedAt: event.receivedAt,
    occurredAt: event.occurredAt,
    agentId: event.owner.agentId,
    provenance: optimistic
      ? { origin: 'optimistic-local', trust: 'unverified', provider }
      : event.provenance ?? { origin: 'migration', trust: 'unverified', provider },
  })
  return normalized.events.map((envelope, index) => Object.freeze({
    ...envelope,
    eventId: normalized.events.length === 1 ? eventId : envelope.eventId,
    identity: Object.freeze({ ...event.identity, ...envelope.identity }),
    // coverage 是**行级**幂等键（投影器按"跨度是否已覆盖"整条丢弃），所以一行只能盖一条：
    // 一个 config 包会产出多条语义事件（options + 当前 mode/model），若全都盖 [seq,seq]，
    // 投影器会把同行的其余事件当成重复丢掉 —— 重放后就只剩一条，中控与配置面板各说各话。
    // 其余事件按 eventId 幂等（同一次重放不会重复入账）。
    ...(coverage && index === 0 ? { coverage: Object.freeze([coverage[0], coverage[1]]) as readonly [number, number] } : {}),
  }))
}

/**
 * #81 L1 → #226：sink 的 batch 行（typedPayload.seqSpan + rawPayload = 原始 chunk 数组）
 * 展开。归一规则**不另起第二套**：仍逐 chunk 过 `normalizeAgentEvent`（方言/扩展归一原样
 * 生效），但只收割语义 parts 与 identity，随后把整段 run 合成**一个**段级信封——对齐
 * `turn.unit` delta-run 段的形状（coverage=[seqStart, seqEnd]、sourceId=`ownerKey#seqEnd`）。
 *
 * 与逐 chunk 展开的投影终态逐字节等价：
 * - run 内 sequence 相邻 ⇒ chunk 之间不存在 timeline 边界条目 ⇒ fold 决策单次求值等价；
 * - parts 拼接满足结合律 ⇒ 投影器一次性 coalesce 与逐 chunk 增量 coalesce 终态一致；
 * - message identity 终态 = 末个非空 chunk（append 覆盖语义）；time/occurredAt 取行值
 *   （= 首 chunk，`buildBatchRow` 保留首条时间戳）。
 * 收益：per-chunk 的信封冻结、投影归约与单点 coverage 全部消失——冷重放信封数随
 * 折叠比（最高 2000×）下降。任一 chunk 归一偏离期望形状（方言跨界/多事件/角色不符）
 * → 整行退回逐 chunk 展开，raw 保真不丢。
 */
function expandCanonicalBatchRow(event: CanonicalConversationEvent): readonly WorkbenchEventEnvelope[] {
  const ownerKey = toCanonicalOwnerKey(event.owner)
  const chunks = canonicalBatchChunksOf(event)
  if (!chunks) {
    return normalizeCanonicalRowToEnvelopes(event, event.rawPayload, event.sequence, event.eventId, [event.sequence, event.sequence])
  }
  const span = canonicalBatchSpanOf(event)!
  const perChunk = (): readonly WorkbenchEventEnvelope[] => chunks.flatMap((raw, index) => {
    const sequence = span[0] + index
    const eventId = `${ownerKey}#${sequence}`
    return normalizeCanonicalRowToEnvelopes(event, raw, sequence, eventId, [sequence, sequence])
  })
  const provider = event.provenance?.provider ?? event.owner.agentId
  const provenance = event.provenance ?? { origin: 'migration' as const, trust: 'unverified' as const, provider }
  const expectedType = event.eventType === 'assistant.text.delta.batch' ? 'message.delta' : 'reasoning.delta'
  const parts: ContentPart[] = []
  let lastIdentity: WorkbenchEventEnvelope['identity'] | undefined
  for (let index = 0; index < chunks.length; index += 1) {
    const sequence = span[0] + index
    const normalized = normalizeAgentEvent(chunks[index], {
      provider,
      sessionId: event.owner.localSessionId,
      sourceId: `${ownerKey}#${sequence}`,
      sequence,
      recordedAt: event.receivedAt,
      occurredAt: event.occurredAt,
      agentId: event.owner.agentId,
      provenance,
    })
    if (normalized.events.length !== 1) return perChunk()
    const semantic = normalized.events[0]!
    // 期望类型按字面量分支判定（TS 对联合类型变量的比较不收窄 event 联合）。
    if (expectedType === 'message.delta') {
      if (semantic.event.type !== 'message.delta' || semantic.event.role !== 'assistant') return perChunk()
    } else if (semantic.event.type !== 'reasoning.delta') {
      return perChunk()
    }
    parts.push(...(semantic.event.parts ?? []))
    if (Object.keys(semantic.identity).length > 0) lastIdentity = semantic.identity
  }
  return [Object.freeze(createWorkbenchEnvelope({
    sessionId: event.owner.localSessionId,
    sequence: span[1],
    recordedAt: event.receivedAt,
    occurredAt: event.occurredAt,
    source: { provider, sourceId: `${ownerKey}#${span[1]}` },
    identity: Object.freeze({ ...event.identity, ...(lastIdentity ?? {}) }),
    provenance,
    coverage: [span[0], span[1]],
    event: expectedType === 'message.delta'
      ? { type: 'message.delta', role: 'assistant', parts }
      : { type: 'reasoning.delta', parts },
  }))]
}

/**
 * #81 L2：turn.unit 单元行按 segments 展开为 segment 级信封——delta-run 段重建为
 * message/reasoning delta 信封（coverage = [seqStart, seqEnd]，journal 权威跨度，
 * appliedRanges 覆盖判断据此与逐 chunk 行互斥）；整行 segment 递归走既有单行路径。
 * 形状损坏的单元行退回单行归一（产出 event.unknown，不丢证据）。
 *
 * **段级隔离**：单个整行 segment 不可读（形状损坏/校验失败）时，只把**该段**退化为
 * `event.unknown`（raw 保留、coverage 取该段自身跨度），其余段照常展开——一个坏段
 * 不得吞掉整轮的正文内容（#81 回归的放大源：形状不匹配曾使整轮塌成一条 unknown）。
 */
function expandCanonicalUnitRow(event: CanonicalConversationEvent, ownerKey: string): readonly WorkbenchEventEnvelope[] {
  const payload = parseTurnUnitPayload(event)
  if (!payload) {
    return normalizeCanonicalRowToEnvelopes(event, event.rawPayload, event.sequence, event.eventId, [event.sequence, event.sequence])
  }
  const provider = event.provenance?.provider ?? event.owner.agentId
  const provenance = event.provenance ?? { origin: 'migration' as const, trust: 'unverified' as const, provider }
  return payload.segments.flatMap((segment, index) => {
    if (segment.kind === 'event') {
      const inner = canonicalRowToWorkbench(segment.event)
      if (inner?.ok) return inner.envelopes
      // 段级隔离：该段退化为单行归一。eventId 缺失时用 `<unit>#segment-<i>` 保唯一，
      // 否则两条坏段会共用同一 id 而被 appliedEventIds 去重吃掉一条。
      const innerEventId = segment.event.eventId
      return normalizeCanonicalRowToEnvelopes(
        segment.event,
        segment.event.rawPayload,
        segment.event.sequence,
        typeof innerEventId === 'string' && innerEventId.length > 0 ? innerEventId : `${event.eventId}#segment-${index}`,
        [segment.event.sequence, segment.event.sequence],
      )
    }
    if (segment.kind === 'tool-run') {
      // #380-b：压缩段展开成**末拍那一行**（中间拍在投影语义上被末拍取代，正文无损——写侧的
      // 前缀判据保证了这点）。两处必须与逐拍路径对齐：
      // 1. 信封序取 `seqStart`：活动节点的 placement 是「创建时刻」事实（投影器取信封 sequence，
      //    见 workbenchProjector 的 `sequence: previous?.sequence ?? envelope.sequence`），用末拍序
      //    会让卡片在刷新后的消息流里跳位；
      // 2. coverage 取整个 run 跨度：appliedRanges 幂等据此与逐拍行互斥（同 delta-run 段）。
      const runEnvelopes = normalizeCanonicalRowToEnvelopes(
        segment.event,
        segment.event.rawPayload,
        segment.seqStart,
        segment.event.eventId,
        [segment.seqStart, segment.seqEnd],
      )
      if (runEnvelopes.length > 0) return runEnvelopes
      // 段级隔离（与 `event` 段同策）：该段不可读时退化为单行归一，不让一个坏段吞掉整轮。
      const fallback = canonicalRowToWorkbench(segment.event)
      if (fallback?.ok) return fallback.envelopes
      return normalizeCanonicalRowToEnvelopes(
        segment.event,
        segment.event.rawPayload,
        segment.seqStart,
        `${event.eventId}#segment-${index}`,
        [segment.seqStart, segment.seqEnd],
      )
    }
    const seqEnd = segment.seqEnd
    const part: { kind: 'text' | 'markdown'; text: string } = { kind: segment.markdown ? 'markdown' : 'text', text: segment.text }
    return [Object.freeze(createWorkbenchEnvelope({
      sessionId: event.owner.localSessionId,
      sequence: seqEnd,
      recordedAt: segment.occurredAt,
      occurredAt: segment.occurredAt,
      source: { provider, sourceId: `${ownerKey}#${seqEnd}` },
      identity: segment.identity ?? {},
      provenance,
      coverage: [segment.seqStart, segment.seqEnd],
      event: segment.eventType === 'assistant.text.delta'
        ? { type: 'message.delta', role: 'assistant', parts: [part] }
        : { type: 'reasoning.delta', parts: [part] },
    }))]
  })
}

/** A valid row can intentionally carry no timeline fact (for example Peri bookkeeping). */
export type WorkbenchRowReadResult =
  | { readonly ok: true; readonly envelopes: readonly WorkbenchEventEnvelope[] }
  | { readonly ok: false }

function canonicalRowToWorkbench(row: unknown): WorkbenchRowReadResult | undefined {
  if (!row || typeof row !== 'object' || !('owner' in row) || !('rawPayload' in row) || !('eventType' in row)) return undefined
  if (validateCanonicalEvent(row).length > 0) return { ok: false }
  const event = row as CanonicalConversationEvent
  const envelopes = event.eventType === 'turn.unit'
    ? expandCanonicalUnitRow(event, toCanonicalOwnerKey(event.owner))
    : isCanonicalBatchDeltaType(event.eventType)
      ? expandCanonicalBatchRow(event)
      : normalizeCanonicalRowToEnvelopes(event, event.rawPayload, event.sequence, event.eventId, [event.sequence, event.sequence])
  return { ok: true, envelopes }
}

function isOptimisticUserEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const envelope = raw as Record<string, unknown>
  const params = envelope.params && typeof envelope.params === 'object' ? envelope.params as Record<string, unknown> : undefined
  const updateValue = envelope.update ?? params?.update
  if (!updateValue || typeof updateValue !== 'object') return false
  const update = updateValue as Record<string, unknown>
  const meta = update._meta && typeof update._meta === 'object' ? update._meta as Record<string, unknown> : undefined
  return update.sessionUpdate === 'user_message_chunk' && meta?.pylonOptimisticUser === true
}

export function readWorkbenchRow(value: unknown): WorkbenchRowReadResult {
  const canonical = canonicalRowToWorkbench(value)
  if (canonical !== undefined) return canonical
  const migrated = migrateWorkbenchEnvelope(value)
  return migrated.ok ? { ok: true, envelopes: [migrated.value] } : { ok: false }
}

/** 持久化 draft 只供 Workbench 临时投影；不生成 canonical coverage。 */
export function draftChunkToWorkbenchEnvelopes(input: {
  provider: string
  source: string
  draftId: string
  chunkIndex: number
  raw: unknown
  sequence: number
  recordedAt: string
}): readonly WorkbenchEventEnvelope[] {
  return normalizeAgentEvent(input.raw, {
    provider: input.provider,
    sessionId: input.source,
    sourceId: `draft:${input.draftId}:${input.chunkIndex}`,
    sequence: input.sequence,
    recordedAt: input.recordedAt,
    occurredAt: input.recordedAt,
    agentId: input.provider,
    provenance: { origin: 'local-observed', trust: 'authoritative', provider: input.provider },
  }).events
}

function canonicalBoundaryRows(rows: readonly unknown[]): CanonicalTurnBoundaryEvent[] {
  return rows.filter((row): row is CanonicalTurnBoundaryEvent => (
    isRecord(row)
    && typeof row.sequence === 'number'
    && typeof row.eventType === 'string'
  ))
}

export function canonicalDurationFromRows(rows: readonly unknown[]) {
  return deriveCanonicalTurnDuration(canonicalBoundaryRows(rows))
}

export function canonicalHasTerminalFromRows(rows: readonly unknown[]): boolean {
  return hasCanonicalTurnTerminal(canonicalBoundaryRows(rows))
}

/**
 * 回合作用域的终态判据（#390）。封存回合时钟、决定「当前回合是否已收敛」只能用它；
 * `canonicalHasTerminalFromRows` 的回合无关语义会把上一轮的终态行当成本轮的证据。
 */
export function canonicalLatestBoundaryFromRows(rows: readonly unknown[]): LatestTurnBoundary {
  return latestTurnBoundary(canonicalBoundaryRows(rows))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function withJournalDiagnostic(document: WorkbenchDocument, count: number): WorkbenchDocument {
  const message = `canonical journal 有 ${count} 条事件无法解析`
  return {
    ...document,
    diagnostics: [
      ...document.diagnostics.filter(item => item.code !== 'canonical.journal.malformed'),
      {
        code: 'canonical.journal.malformed', message, level: 'error',
        eventId: `canonical-load:${document.sessionId}`, sequence: document.revision,
        data: { malformedCount: count },
      },
    ],
  }
}

/**
 * #213：实时**产出**帧——agent 正在写正文/思考（乐观帧与 user 回声另走各自的时钟通道）。
 *
 * 刻意排除 `role === 'user'`：user 帧不是"agent 在产出"的证据，而 `runningTailStartTime`
 * 取的是文档里最早的 running 行，含陈旧截断行 ⇒ 会算出虚胖的 elapsed。
 */
export function isLiveTextDelta(envelope: WorkbenchEventEnvelope): boolean {
  const type = envelope.event.type
  if (type !== 'message.delta' && type !== 'reasoning.delta') return false
  const role = (envelope.event as { role?: string }).role
  return type === 'reasoning.delta' || role === 'assistant'
}

/** #213 补强：文档里首个 running 行的时间——他端已在进行中的回合，其起点不是"我们看见它"的时刻。 */
export function runningTailStartTime(document: WorkbenchDocument | undefined): number | undefined {
  let earliest: number | undefined
  for (const message of document?.messages ?? []) {
    if (message.running !== true) continue
    const at = Date.parse(message.time ?? '')
    if (!Number.isFinite(at)) continue
    if (earliest === undefined || at < earliest) earliest = at
  }
  return earliest
}

/** SessionConfigOption is JSON by construction; its readonly index signature is just
 * what stops TS from unifying it with JsonValue on its own. */
function withOptionValue(
  options: readonly SessionConfigOption[],
  index: number,
  value: string | boolean,
): readonly JsonValue[] {
  return options.map((option, at) => (at === index ? { ...option, value } : option)) as unknown as readonly JsonValue[]
}

/** The option a semantic resolves to (shared ACP classifier), carrying a new value. */
function withSemanticValue(
  options: readonly SessionConfigOption[],
  semantic: 'model' | 'mode',
  value: string,
): readonly JsonValue[] | undefined {
  const index = options.findIndex(option => findConfigOption([option], semantic) !== undefined)
  return index < 0 ? undefined : withOptionValue(options, index, value)
}

export function localSessionFactEvent(fact: LocalSessionFact, document: WorkbenchDocument): SessionEvent | undefined {
  const options = document.session.options
  // The control center reads `session.mode` / `session.model` while the config panel
  // reads the option's `value`, and nothing synchronises the two fields — so a local
  // write has to fill both, or the two surfaces disagree (after a reload only the
  // provider's advertisement survives and the control center falls back).
  if (fact.kind === 'model') {
    const merged = withSemanticValue(options, 'model', fact.model)
    return { type: 'session.model-updated', model: fact.model, ...(merged ? { options: merged } : {}) }
  }
  if (fact.kind === 'mode') {
    const merged = withSemanticValue(options, 'mode', fact.mode)
    return { type: 'session.mode-updated', mode: fact.mode, ...(merged ? { options: merged } : {}) }
  }
  // `session.config-updated` replaces the whole option list, so a single-option
  // write carries the merged list — the other options are not ours to drop.
  const index = options.findIndex(option => option.id === fact.id)
  if (index < 0) return undefined
  return { type: 'session.config-updated', options: withOptionValue(options, index, fact.value) }
}
