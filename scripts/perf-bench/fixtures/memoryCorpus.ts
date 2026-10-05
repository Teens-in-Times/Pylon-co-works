/**
 * #376/#375 的合成语料：**一个完整回合**的 canonical 行（与开发记录 §复现方法同一配方）。
 *
 * `user_message_chunk` → `calls` ×（`tool_call` + `beats` × `tool_call_update`，content
 * **逐拍累计**至 `finalBytes`）→ `usage_update` → `done`。
 *
 * 三条硬约束（照抄记录里的两个坑 + 一条量纲口径）：
 * 1. 必须构成完整回合——缺 user 起始帧时工具事件会被终态栅栏判为 late-event 整批丢弃；
 * 2. 事件类型由 `update.sessionUpdate` 推导，不由入参决定（故这里走生产归一化器）；
 * 3. 走**前端 append 轨**的等价形状：没有 turn.unit 行（单元只由 kernel ingest 追加），
 *    因此 compact 读会把全部行下发——这正是要量的形状。
 */
import { normalizeRawEvent } from '../../../src/domains/events/canonicalNormalizer.ts'
import type { CanonicalConversationEvent, CanonicalEventOwner } from '../../../src/domains/events/eventSchema.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../../../src/domains/workbench/events/workbenchEventSchema.ts'

export interface MemoryCorpusOptions {
  readonly calls?: number
  readonly beats?: number
  /** 每次调用最后一拍累计到的 content 字符数（逐拍线性累计）。 */
  readonly finalBytes?: number
  /**
   * assistant.thinking 分块数（#449）。`0`（缺省）= 不生成思考流——既有 case 的语料形状
   * 保持逐字节不变，text/thinking 只由显式传入的新 case 启用。
   */
  readonly thinkingBlocks?: number
  /** thinking 总字符量（在 `thinkingBlocks` 个 chunk 间均分；增量式——每 chunk 只带新文本）。 */
  readonly thinkingChars?: number
  /** assistant.text 总字符量（按 `deltaChars` 分块，增量式）。 */
  readonly textChars?: number
  /** 文本族每 chunk 携带的新字符数（真实 token 流形状；与工具拍的「累计式」相对）。 */
  readonly deltaChars?: number
  readonly owner?: CanonicalEventOwner
}

export interface MemoryCorpus {
  readonly owner: CanonicalEventOwner
  readonly rows: readonly CanonicalConversationEvent[]
  /** Σ**逻辑载荷**：各拍累计 content 的字符数之和（与记录 61.5 MB 同一口径）。 */
  readonly logicalPayloadBytes: number
  readonly calls: number
  readonly beats: number
  /** 文本族（thinking+text）的 chunk 总数——拍数敏感性与粒度对照的量纲。 */
  readonly textChunks: number
}

const DEFAULT_OWNER: CanonicalEventOwner = {
  profileId: 'perf',
  agentId: 'peri',
  localSessionId: 'local:mem',
}

export function buildMemoryCorpus(options: MemoryCorpusOptions = {}): MemoryCorpus {
  const calls = options.calls ?? 100
  const beats = options.beats ?? 20
  const finalBytes = options.finalBytes ?? 60_000
  const thinkingBlocks = options.thinkingBlocks ?? 0
  const thinkingChars = options.thinkingChars ?? 0
  const textChars = options.textChars ?? 0
  const deltaChars = Math.max(1, options.deltaChars ?? 24)
  const owner = options.owner ?? DEFAULT_OWNER
  const wires: unknown[] = [
    { update: { sessionUpdate: 'user_message_chunk', content: { text: '跑一遍内存语料' } } },
  ]
  let logicalPayloadBytes = '跑一遍内存语料'.length
  // 文本族（#449）：真实回合的产出段——thinking 先行、text 随后，**增量式** chunk（每 chunk
  // 只带新文本，与工具拍的累计式相对）。wire 形状与 `acpNormalizer` 的真实 sessionUpdate 名
  // 一致：`agent_thought_chunk` → assistant.thinking.delta、`agent_message_chunk` → text.delta。
  let textChunks = 0
  const pushChunks = (sessionUpdate: 'agent_thought_chunk' | 'agent_message_chunk', total: number, count: number): void => {
    if (count <= 0 || total <= 0) return
    const per = Math.max(1, Math.round(total / count))
    let emitted = 0
    for (let chunk = 0; chunk < count && emitted < total; chunk += 1) {
      const size = Math.min(per, total - emitted)
      emitted += size
      textChunks += 1
      logicalPayloadBytes += size
      wires.push({ update: { sessionUpdate, content: { type: 'text', text: 'x'.repeat(size) } } })
    }
  }
  pushChunks('agent_thought_chunk', thinkingChars, thinkingBlocks)
  pushChunks('agent_message_chunk', textChars, Math.ceil(textChars / deltaChars))
  for (let call = 0; call < calls; call += 1) {
    const toolCallId = `call-${call}`
    wires.push({
      update: { sessionUpdate: 'tool_call', toolCallId, title: 'Bash', kind: 'execute', status: 'in_progress' },
    })
    for (let beat = 1; beat <= beats; beat += 1) {
      const size = Math.round((finalBytes * beat) / beats)
      logicalPayloadBytes += size
      wires.push({
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: beat === beats ? 'completed' : 'in_progress',
          // 累计式回传：每一拍带**到此为止**的全部输出（这正是拍数敏感性的来源）
          rawOutput: { type: 'text', text: 'x'.repeat(size) },
        },
      })
    }
  }
  wires.push({ update: { sessionUpdate: 'usage_update', size: 200_000, used: 12_345 } })
  wires.push({ update: { sessionUpdate: 'done', stopReason: 'end_turn' } })

  const rows = wires.map((raw, index) => normalizeRawEvent(raw, {
    owner,
    clientGeneration: 1,
    sequence: index + 1,
    receivedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, 0) + index * 10).toISOString(),
  }).event)

  return { owner, rows, logicalPayloadBytes, calls, beats, textChunks }
}

/**
 * #375-d 的语料：`count` 个**内容完全相同**的目录快照信封（真机单份 16 132 B），走
 * `createWorkbenchEnvelope`——live 与 journal 两条路的唯一信封出口，正是 intern 生效的那一处。
 */
export function buildMetadataSnapshotEnvelopes(count = 500): {
  readonly envelopes: readonly WorkbenchEventEnvelope[]
  readonly singleBytes: number
} {
  const commands = Array.from({ length: 60 }, (_, index) => ({
    name: `cmd-${index}`,
    description: `第 ${index} 条目录项，用于把单份快照撑到真机量级（16 KB 上下）`,
    input: { hint: 'x'.repeat(120) },
  }))
  const template = { type: 'session.commands-updated', commands }
  // 每行一个**独立**的对象（内容相同、引用不同）——这正是真实日志的形状。若像早期版本那样
  // 把同一个对象引用传给 500 次调用，`envelopes.map(e => e.event)` 会天然去重成一个，
  // 判据无论 intern 在不在都 PASS（门禁成同义反复，评审 M1）。
  const envelopes = Array.from({ length: count }, (_, index) => createWorkbenchEnvelope({
    sessionId: 'metadata',
    sequence: index + 1,
    recordedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, 0) + index * 10).toISOString(),
    source: { provider: 'peri', sourceId: `wire-${index}` },
    identity: {},
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: JSON.parse(JSON.stringify(template)) as WorkbenchSemanticEvent,
  }))
  return { envelopes, singleBytes: JSON.stringify(template).length }
}
