/**
 * Draft application subsystem for the agent workbench session host (#520
 * S3-P0-1): folds canonical draft chunks (live notifications and recovered
 * fragments from the cold-load read) into the workbench document via the
 * injected `applyLive` seam, and marks messages continued by interrupted
 * drafts. Owns the draft dedupe/continuity state (`AgentWorkbenchDraftState`);
 * the factory (agentWorkbenchSession.ts) creates it and shares it with the
 * replay subsystem, which consumes the projection helpers during reloads.
 */
import type { WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import type { WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchRuntime } from './agentWorkbenchTurnClock.ts'
import type { AgentWorkbenchBindingState } from './agentWorkbenchOptimisticEcho.ts'
import { draftChunkToWorkbenchEnvelopes } from './agentWorkbenchProjection.ts'
import type { CanonicalDraftFragment } from '../../infrastructure/events/canonicalEventRepository.ts'
import type { CanonicalDraftChunkNotification } from '../../infrastructure/events/canonicalEventFeed.ts'

/** 草稿去重/续写状态（原工厂散落闭包对象；宿主与 replay 子系统共同读写）。 */
export interface AgentWorkbenchDraftState {
  seen: Set<string>
  activeIds: Set<string>
  interruptedIds: Set<string>
  reconcilePending: boolean
  liveDuringReconcile: WorkbenchEventEnvelope[]
}

export interface AgentWorkbenchDraftsDeps {
  runtime: WorkbenchRuntime
  binding: AgentWorkbenchBindingState
  draft: AgentWorkbenchDraftState
  /** 宿主持有的瞬态序列记账（draft/live-fact/session-response 共用单调递增）。 */
  transientSequenceBySource: Map<string, number>
  /** live 应用缝（宿主 `applyLive`：时钟/乐观 echo/文档发布都在那边）。 */
  applyLive(envelope: WorkbenchEventEnvelope): void
}

export interface AgentWorkbenchDrafts {
  /** feed 草稿块通知 → 去重后逐块走 live 折叠。 */
  applyDraftChunk(chunk: CanonicalDraftChunkNotification): void
  /** 冷装载/重读时把已恢复的草稿碎片投影成信封（按序收集，不触 live 缝）。 */
  projectRecoveredDrafts(
    fragments: readonly CanonicalDraftFragment[], startSequence: number,
  ): WorkbenchEventEnvelope[]
  /** 给被中断草稿续写的消息打 `interruptedDraft` 标记（发布前最后一步修饰）。 */
  withInterruptedDraftMarker(
    document: WorkbenchDocument,
    envelopes: readonly WorkbenchEventEnvelope[],
  ): WorkbenchDocument
}

export function createAgentWorkbenchDrafts(deps: AgentWorkbenchDraftsDeps): AgentWorkbenchDrafts {
  const { runtime, binding, draft, transientSequenceBySource, applyLive } = deps

  const applyDraftChunk = (chunk: CanonicalDraftChunkNotification): void => {
    if (binding.destroyed || binding.ownerKey !== chunk.ownerKey || binding.source !== chunk.source) return
    const key = `${chunk.draftId}:${chunk.chunkIndex}`
    if (draft.seen.has(key)) return
    draft.seen.add(key)
    draft.activeIds.add(chunk.draftId)
    const current = runtime.getSnapshot().document
    const sequence = Math.max(current?.revision ?? 0, transientSequenceBySource.get(chunk.source) ?? 0) + 1
    transientSequenceBySource.set(chunk.source, sequence)
    const envelopes = draftChunkToWorkbenchEnvelopes({
      provider: binding.boundProvider, source: chunk.source,
      draftId: chunk.draftId, chunkIndex: chunk.chunkIndex,
      raw: chunk.raw, sequence, recordedAt: new Date().toISOString(),
    })
    envelopes.forEach(applyLive)
  }

  const projectRecoveredDrafts = (
    fragments: readonly CanonicalDraftFragment[], startSequence: number,
  ): WorkbenchEventEnvelope[] => {
    const envelopes: WorkbenchEventEnvelope[] = []
    let sequence = startSequence
    const chunkIndexByDraft = new Map<string, number>()
    for (const fragment of fragments) {
      if (fragment.interrupted) draft.interruptedIds.add(fragment.draftId)
      draft.activeIds.add(fragment.draftId)
      for (const raw of fragment.rawPayload) {
        const chunkIndex = chunkIndexByDraft.get(fragment.draftId) ?? 0
        chunkIndexByDraft.set(fragment.draftId, chunkIndex + 1)
        const key = `${fragment.draftId}:${chunkIndex}`
        if (draft.seen.has(key)) continue
        draft.seen.add(key)
        sequence += 1
        envelopes.push(...draftChunkToWorkbenchEnvelopes({
          provider: binding.boundProvider, source: binding.source ?? '',
          draftId: fragment.draftId, chunkIndex,
          raw, sequence, recordedAt: fragment.firstReceivedAt,
        }))
      }
    }
    return envelopes
  }

  const withInterruptedDraftMarker = (
    document: WorkbenchDocument,
    envelopes: readonly WorkbenchEventEnvelope[],
  ): WorkbenchDocument => {
    if (draft.interruptedIds.size === 0) return document
    // A draft can continue a message whose first chunks are already canonical
    // (for example after the 48 KiB split). The projected message then keeps
    // the first canonical source, so identify the provisional tail by its
    // latest sequence as well.
    const draftBySequence = new Map<number, string>()
    for (const envelope of envelopes) {
      const sourceId = envelope.source.sourceId
      if (!sourceId.startsWith('draft:')) continue
      const draftId = sourceId.slice('draft:'.length).split(':')[0]
      if (draft.interruptedIds.has(draftId)) draftBySequence.set(envelope.sequence, draftId)
    }
    return {
      ...document,
      messages: document.messages.map(message => {
        const sourceId = message.source.sourceId
        const draftId = sourceId.startsWith('draft:')
          ? sourceId.slice('draft:'.length).split(':')[0]
          : draftBySequence.get(message.sequence)
        return draftId && draft.interruptedIds.has(draftId)
          ? { ...message, running: false, interruptedDraft: true, draftId }
          : message
      }),
    }
  }

  return { applyDraftChunk, projectRecoveredDrafts, withInterruptedDraftMarker }
}
