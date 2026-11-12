import { selectActivityDisplayOrder, type WorkbenchActivityNode, type WorkbenchDocument, type WorkbenchInteraction } from '../../domains/workbench/workbenchProjector.ts'
import type { LifecycleState } from '../../domains/workbench/lifecycle/lifecycleModel.ts'
import type { Message } from '../../domains/chat/messageTypes.ts'
export function canonicalTokenCount(
  usage: WorkbenchDocument['session']['usage'],
  fallback: number,
): number {
  if (!usage) return fallback
  if (usage.totalTokens !== undefined) return usage.totalTokens
  const known = [usage.inputTokens, usage.outputTokens, usage.reasoningTokens]
    .filter((value): value is number => value !== undefined)
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : fallback
}

export interface ActivityTimelinePlacement {
  readonly leading: readonly WorkbenchActivityNode[]
  readonly afterMessage: ReadonlyMap<string, readonly WorkbenchActivityNode[]>
}

export function selectActivityTimelinePlacement(document: WorkbenchDocument | undefined): ActivityTimelinePlacement {
  if (!document || document.activities.length === 0) return { leading: [], afterMessage: new Map() }
  const leading: WorkbenchActivityNode[] = []
  const afterMessage = new Map<string, WorkbenchActivityNode[]>()
  // #409：原实现对每个活动线性扫全部消息找锚（O(活动×消息)，随每次发布重算）。
  // 消息序列收集一次，每活动两次二分：上界定位「sequence < activity.sequence」的
  // 最大值，下界回到该最大值的**首现位置**。平 sequence 时原扫描的严格 `>` 判据
  // 保留数组序第一条，稳定排序保序 ⇒ 下界首现即原取值，语义逐条一致。
  const messages = document.messages
  const sequences = messages.map(message => message.sequence)
  const ascending = sequences.every((value, index) => index === 0 || sequences[index - 1]! <= value!)
  const orderedMessages = ascending
    ? messages
    : sequences.map((_, index) => index).sort((left, right) => sequences[left]! - sequences[right]!).map(index => messages[index]!)
  const orderedSequences = ascending ? sequences : orderedMessages.map(message => message.sequence)
  const firstIndexAtOrAfter = (sequence: number, high: number): number => {
    let low = 0
    while (low < high) {
      const middle = (low + high) >>> 1
      if (orderedSequences[middle]! < sequence) low = middle + 1
      else high = middle
    }
    return low
  }
  for (const activity of selectActivityDisplayOrder(document)) {
    const upper = firstIndexAtOrAfter(activity.sequence, orderedSequences.length)
    if (upper === 0) {
      leading.push(activity)
      continue
    }
    const maxSequence = orderedSequences[upper - 1]!
    const anchor = orderedMessages[firstIndexAtOrAfter(maxSequence, upper)]
    const anchored = afterMessage.get(anchor.id) ?? []
    anchored.push(activity)
    afterMessage.set(anchor.id, anchored)
  }
  return { leading, afterMessage }
}

/** Derive incoming edges for one canonical activity segment. */
export function deriveCanonicalToolConnectorSources(
  activities: readonly WorkbenchActivityNode[],
): ReadonlyMap<string, string> {
  const sources = new Map<string, string>()
  let previousToolId: string | undefined
  for (const activity of activities) {
    if (activity.kind !== 'tool') {
      previousToolId = undefined
      continue
    }
    const parentId = activity.parentToolCallId
    if (parentId && parentId !== activity.id) sources.set(activity.id, parentId)
    else if (!parentId && previousToolId) sources.set(activity.id, previousToolId)
    previousToolId = activity.id
  }
  return sources
}

export function lifecycleRenderKind(state: LifecycleState): string | undefined {
  if (state.suspended) return 'lifecycle.suspended'
  if (state.retry) return 'lifecycle.retry'
  if (state.rewind) return 'lifecycle.rewind'
  if (state.compact) return 'lifecycle.compact'
  if (state.lastRecovery) return 'lifecycle.recovered'
  return undefined
}

export function interactionRenderKind(interaction: WorkbenchInteraction): string {
  if (!interaction.request || typeof interaction.request !== 'object' || Array.isArray(interaction.request)) return 'interaction.questions'
  switch ((interaction.request as Record<string, unknown>).kind) {
    case 'approval': return 'interaction.approval'
    case 'confirm': return 'interaction.confirm'
    case 'permission': return 'interaction.permission'
    case 'oauth': return 'interaction.oauth'
    case 'secret': return 'interaction.secret'
    case 'sudo': return 'interaction.sudo'
    case 'clarify':
    case 'ask-question':
    default: return 'interaction.questions'
  }
}

// P57 S2-R3：显示链包装复用。键是冻结的 WorkbenchMessage（引用稳定性由
// workbenchRuntime freezeItems 的全等短路保证）；同一冻结条目重复包装是
// 每-chunk O(n) 放大器，WeakMap 命中后引用跨 revision 稳定。
const solidMessageCache = new WeakMap<WorkbenchDocument['messages'][number], Message>()

export function toSolidMessage(message: WorkbenchDocument['messages'][number]): Message {
  const cached = solidMessageCache.get(message)
  if (cached) return cached
  const wrapped: Message = {
    id: message.id,
    role: message.role === 'user' ? 'user' : message.role === 'reasoning' ? 'reasoning' : 'assistant',
    sender: message.role === 'user' ? 'user' : message.source.provider,
    content: message.content,
    time: message.time,
    running: message.running,
    interruptedDraft: message.interruptedDraft,
    draftId: message.draftId,
    thoughtStartedAt: message.thoughtStartedAtMs,
    thoughtDurationMs: message.thoughtDurationMs,
    redacted: message.redacted,
    redactedReason: message.redactedReason,
    semanticParts: message.parts,
  }
  solidMessageCache.set(message, wrapped)
  return wrapped
}

/** #324：info 级诊断不进对话面（如 peri.turn-done 传输层留痕）——数据仍在
 * document.diagnostics 与 Runtime 日志可观测；warning/error 照常呈现。
 * systemErrors 已覆盖的 eventId 不重复出卡。 */
export function visibleDiagnostics(document: WorkbenchDocument) {
  const errorEventIds = new Set(document.systemErrors.flatMap(error => error.eventId ? [error.eventId] : []))
  return document.diagnostics.filter(diagnostic =>
    diagnostic.level !== 'info' && !errorEventIds.has(diagnostic.eventId))
}
