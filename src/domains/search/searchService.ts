/**
 * searchService — 跨会话搜索统一入口。
 *
 * A1-c P5/B6 + #445：Tauri 模式两阶段 canonical 搜索——后端 evt_search 在
 * raw/typed payload + eventType 上 LIKE 出**命中行**（owner 定位 + sequence，limit 50），
 * 前端按 owner 分组后对命中行定向 `evt_load_compact` 拉行 → projectMessagesFromCanonical
 * → 消息文本精确复核。匹配与命中同源（投影复核），IPC 从「候选 owner 全量流」降为
 * 「命中行集」。browser 模式回退本地快照扫描（snapshotSearch）。
 */
import { IS_TAURI } from '../../infrastructure/tauri/env.ts'
import { useIdentityStore, type Session } from '../identity/identityStore.ts'
import { getMessageSearchText } from '../chat/messageSearchIndex.ts'
import { toCanonicalOwnerKey } from '../events/eventSchema.ts'
import { projectMessagesFromCanonical } from '../events/messageProjection.ts'
import type { CanonicalEventRow } from '../events/canonicalEventRow.ts'
import {
  tauriCanonicalEventRepository,
  type CanonicalEventSearchHit,
} from '../../infrastructure/events/canonicalEventRepository.ts'
import { collectSnapshotKeys, snapshotSearch, type SnapshotSearchResult } from './snapshotSearch.ts'
import type { SearchProvider } from '../../contracts/searchProvider.ts'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'

/** 单次搜索返回上限（同 limit 语义；达上限视为截断）。 */
export const BACKEND_SEARCH_LIMIT = 50

/** UI 搜索命中：统一形状（含 owner agentId 供 owner-aware 导航）。 */
export type SearchHitUi = SnapshotSearchResult & { agentId?: string; snippet: string }

/** Unicode 安全 snippet：命中处前后 40 字符（不劈代理对/组合字符）。 */
function snippetAround(text: string, needle: string): string {
  const lower = text.toLocaleLowerCase()
  const index = lower.indexOf(needle.toLocaleLowerCase())
  if (index < 0) return text.slice(0, 120)
  const radius = 40
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + needle.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Tauri 模式：命中行两阶段搜索（内置实现，core.search.tauri 包装）。 */
export async function searchAllMessagesTauri(query: string): Promise<{ results: SearchHitUi[]; truncated: boolean }> {
  const needle = query.trim()
  if (!needle) return { results: [], truncated: false }
  const sessions = useIdentityStore.getState().sessions
  const repository = tauriCanonicalEventRepository()
  const sessionByOwner = new Map<string, Session>()
  for (const session of sessions) {
    sessionByOwner.set(toCanonicalOwnerKey({
      profileId: session.profileId,
      agentId: session.agentId,
      localSessionId: session.source,
    }), session)
  }
  // 阶段 1：后端命中行（payload/eventType；recall 与候选 owner 版一致）
  const hits: CanonicalEventSearchHit[] = await repository.searchHits(needle, BACKEND_SEARCH_LIMIT)
  // 阶段 2：按 owner 分组去重 sequence，定向单行 compact 读（单元覆盖的行由
  // compact 语义解析出单元行）→ 该 owner 行集合流投影 → 消息搜索文本精确复核。
  const sequencesByOwner = new Map<string, number[]>()
  for (const hit of hits) {
    const ownerKey = toCanonicalOwnerKey(hit)
    const sequences = sequencesByOwner.get(ownerKey) ?? []
    if (!sequences.includes(hit.sequence)) sequences.push(hit.sequence)
    sequencesByOwner.set(ownerKey, sequences)
  }
  const results: SearchHitUi[] = []
  for (const [ownerKey, sequences] of sequencesByOwner) {
    const session = sessionByOwner.get(ownerKey)
    if (!session) continue
    const rowBySequence = new Map<number, CanonicalEventRow>()
    await Promise.all(sequences.map(async sequence => {
      // Failures belong to the caller's retry state; incomplete reads must not
      // masquerade as a successful search with missing matches.
      const page = await repository.listCompact(ownerKey, sequence - 1, 1)
      const row = page.events[0]
      if (row) rowBySequence.set(row.sequence, row)
    }))
    if (rowBySequence.size === 0) continue
    const rows = [...rowBySequence.values()].sort((a, b) => a.sequence - b.sequence)
    // #81 L2：投影读走 compact 语义（单元展开在 effectiveCanonicalProjectionEvents 内完成）。
    const messages = projectMessagesFromCanonical(rows)
    for (const message of messages) {
      const searchable = getMessageSearchText(message)
      if (!searchable.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) continue
      // IDs belong to this partial projection. Navigation passes the query to
      // the full conversation search instead of treating these IDs as anchors.
      results.push({
        sessionId: session.id,
        messageId: message.id,
        snippet: snippetAround(searchable, needle),
        time: message.time,
        agentId: session.agentId,
      })
      if (results.length >= BACKEND_SEARCH_LIMIT) {
        return { results, truncated: true }
      }
    }
  }
  return { results, truncated: false }
}

/** browser 模式：本地快照扫描（内置实现，core.search.snapshot 包装）。 */
export async function searchAllMessagesSnapshot(query: string): Promise<{ results: SearchHitUi[]; truncated: boolean }> {
  const needle = query.trim()
  if (!needle) return { results: [], truncated: false }
  const { results, truncated } = snapshotSearch(localStorage, needle, collectSnapshotKeys())
  return { results, truncated }
}

/** 无插件回退：按运行时环境选择内置实现。 */
export async function searchAllMessagesBuiltin(query: string): Promise<{ results: SearchHitUi[]; truncated: boolean }> {
  return IS_TAURI ? searchAllMessagesTauri(query) : searchAllMessagesSnapshot(query)
}

/**
 * 跨会话搜索（统一入口）。旧响应不覆盖新 query 由调用方（SearchSheetView）用
 * request generation 保证。
 */
export async function searchAllMessages(query: string): Promise<{ results: SearchHitUi[]; truncated: boolean }> {
  const providers = getPluginServiceRegistry().list<SearchProvider>('search')
  const mode = IS_TAURI ? 'tauri' : 'browser'
  const provider = providers.find(candidate => candidate.mode === mode)
    ?? providers.find(candidate => candidate.mode === 'all')
  if (!provider) return searchAllMessagesBuiltin(query)
  const result = await provider.search(query)
  return { results: result.results as SearchHitUi[], truncated: result.truncated }
}
