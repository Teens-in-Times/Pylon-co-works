/**
 * snapshotSearch — 跨会话快照搜索纯域（W3-03）。
 *
 * 扫描 localStorage 的 pylon-msgs-* 消息快照（复用 messagePersistence 的 key/parse 语义，
 * 纯函数接受 storage-like 可测）；匹配 toLocaleLowerCase + includes（首版不分词）；
 * 扫描上限为纯常量。**范围**：仅本地会话快照（平台会话扫描范围与上限为产品未决项——
 * 未拍板前不猜平台策略）。
 */

import { createSearchSnippetMatcher } from './searchSnippet.ts'

export interface SnapshotSearchResult {
  sessionId: string
  messageId: string
  snippet: string
  time?: string
}

export const SNAPSHOT_SCAN_LIMIT = 2000
export const MESSAGE_SNAPSHOT_KEY_PREFIX = 'pylon-msgs-'

export interface SnapshotSearchStorage {
  getItem(key: string): string | null
}

export function isMessageSnapshotKey(key: string): boolean {
  return key.startsWith(MESSAGE_SNAPSHOT_KEY_PREFIX)
}

/** 快照 parse（复用 messagePersistence 的 envelope/裸数组语义——损坏返回空） */
export function parseMessageSnapshotRaw<T>(raw: string | null): T[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as T[]
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages)) {
      return (parsed as { messages: T[] }).messages
    }
    return []
  } catch {
    return []
  }
}

export interface SnapshotSearchOptions {
  /** 扫描上限（纯常量；超限截断并在结果外记录） */
  limit?: number
  /** 会话 id → 可显示名（本地会话映射） */
  sessionName?: (sessionId: string) => string | undefined
}

export function snapshotSearch(
  storage: SnapshotSearchStorage,
  query: string,
  keys: readonly string[],
  options: SnapshotSearchOptions = {},
): { results: SnapshotSearchResult[]; truncated: boolean } {
  const needle = query.trim()
  if (!needle) return { results: [], truncated: false }
  const snippetFor = createSearchSnippetMatcher(needle)
  const limit = options.limit ?? SNAPSHOT_SCAN_LIMIT
  const results: SnapshotSearchResult[] = []
  let scanned = 0
  let truncated = false
  for (const key of keys) {
    if (!isMessageSnapshotKey(key)) continue
    const sessionId = key.slice(MESSAGE_SNAPSHOT_KEY_PREFIX.length)
    const messages = parseMessageSnapshotRaw<{ id?: string; content?: string; time?: string; role?: string }>(storage.getItem(key))
    for (const message of messages) {
      if (scanned >= limit) { truncated = true; break }
      scanned += 1
      const content = typeof message.content === 'string' ? message.content : ''
      const snippet = snippetFor(content)
      if (snippet === undefined) continue
      results.push({
        sessionId,
        messageId: typeof message.id === 'string' ? message.id : `msg-${results.length}`,
        snippet,
        ...(typeof message.time === 'string' ? { time: message.time } : {}),
      })
    }
    if (truncated) break
  }
  return { results, truncated }
}

/** 枚举 pylon-msgs-* 快照 key（browser 回退搜索用）。 */
export function collectSnapshotKeys(): string[] {
  if (typeof localStorage === 'undefined') return []
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key && isMessageSnapshotKey(key)) keys.push(key)
  }
  return keys
}
