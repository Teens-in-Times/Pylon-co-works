export type SessionUiKey =
  | 'draft'
  | 'attachments'
  | 'input-error'
  | 'queued-messages'
  | 'search-open'
  | 'search-query'
  | 'search-index'
  | 'locate-target'
  | 'locate-error'
  | 'pendingMessageLocation'
  | 'task-tree-open'
  | 'input-history'
  | 'input-history-index'
  | 'message-expansion'
  | 'selector-pending'
  /** #394：Agent 推送预测的消费标记（值 = 预测实例键，见 `session/assistPrediction.ts`）。 */
  | 'assist-prediction-consumed'

export interface SessionUiStore {
  get<T>(sessionId: string, key: SessionUiKey, fallback: T): T
  set<T>(sessionId: string, key: SessionUiKey, value: T): void
  update<T>(sessionId: string, key: SessionUiKey, fallback: T, updater: (previous: T) => T): T
  subscribe(sessionId: string, key: SessionUiKey, listener: () => void): () => void
  capture(sessionId: string): SessionUiScope
  clear(sessionId: string): void
  clearAll(): void
  destroy(): void
}

export interface SessionUiScope {
  get<T>(key: SessionUiKey, fallback: T): T
  set<T>(key: SessionUiKey, value: T): void
  update<T>(key: SessionUiKey, fallback: T, updater: (previous: T) => T): T
  subscribe(key: SessionUiKey, listener: () => void): () => void
  clear(): void
}

function entryKey(sessionId: string, key: SessionUiKey): string {
  return `${sessionId}\u0000${key}`
}

export function createSessionUiStore(): SessionUiStore {
  const registry = new Map<string, Map<SessionUiKey, unknown>>()
  const listeners = new Map<string, Set<() => void>>()
  let destroyed = false

  const publish = (sessionId: string, key: SessionUiKey) => {
    if (destroyed) return
    const current = listeners.get(entryKey(sessionId, key))
    if (!current) return
    for (const listener of [...current]) listener()
  }

  const get = <T>(sessionId: string, key: SessionUiKey, fallback: T): T => {
    const session = registry.get(sessionId)
    return session?.has(key) ? session.get(key) as T : fallback
  }

  const set = <T>(sessionId: string, key: SessionUiKey, value: T): void => {
    if (destroyed) return
    const session = registry.get(sessionId) ?? new Map<SessionUiKey, unknown>()
    const previous = session.get(key)
    const existed = session.has(key)
    if (existed && Object.is(previous, value)) return
    session.set(key, value)
    registry.set(sessionId, session)
    publish(sessionId, key)
  }

  return {
    get,
    set,
    update<T>(sessionId: string, key: SessionUiKey, fallback: T, updater: (previous: T) => T): T {
      const next = updater(get(sessionId, key, fallback))
      set(sessionId, key, next)
      return next
    },
    subscribe(sessionId, key, listener) {
      if (destroyed) return () => {}
      const id = entryKey(sessionId, key)
      const current = listeners.get(id) ?? new Set<() => void>()
      current.add(listener)
      listeners.set(id, current)
      return () => {
        current.delete(listener)
        if (current.size === 0) listeners.delete(id)
      }
    },
    capture(sessionId) {
      return Object.freeze({
        get: <T>(key: SessionUiKey, fallback: T) => get(sessionId, key, fallback),
        set: <T>(key: SessionUiKey, value: T) => set(sessionId, key, value),
        update: <T>(key: SessionUiKey, fallback: T, updater: (previous: T) => T) => {
          const next = updater(get(sessionId, key, fallback))
          set(sessionId, key, next)
          return next
        },
        subscribe: (key: SessionUiKey, listener: () => void) => {
          if (destroyed) return () => {}
          const id = entryKey(sessionId, key)
          const current = listeners.get(id) ?? new Set<() => void>()
          current.add(listener)
          listeners.set(id, current)
          return () => {
            current.delete(listener)
            if (current.size === 0) listeners.delete(id)
          }
        },
        clear: () => {
          if (destroyed) return
          const session = registry.get(sessionId)
          if (!session) return
          const keys = [...session.keys()]
          registry.delete(sessionId)
          for (const key of keys) publish(sessionId, key)
        },
      })
    },
    clear(sessionId) {
      if (destroyed) return
      const session = registry.get(sessionId)
      if (!session) return
      const keys = [...session.keys()]
      registry.delete(sessionId)
      for (const key of keys) publish(sessionId, key)
    },
    clearAll() {
      if (destroyed || registry.size === 0) return
      const affected = [...registry].flatMap(([sessionId, session]) =>
        [...session.keys()].map(key => [sessionId, key] as const))
      registry.clear()
      for (const [sessionId, key] of affected) publish(sessionId, key)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      registry.clear()
      listeners.clear()
    },
  }
}

/**
 * 模块级单例（#520 S2-P1-1：会话级 UI 双注册表归一）——原 chat/sessionUiState 的
 * 无响应 Map 退役，其全部键（draft、search-query 等）迁入本注册表；
 * 面板/搜索等跨 workbench 的消费方经此单例读写并获得订阅语义。会话宿主
 * （agentWorkbenchSession）仍按 runtime 各自 createSessionUiStore 作 port 命名空间，
 * 不受本单例影响。测试 resetStores 经 clearAll() 清场。
 */
export const sessionUiStore: SessionUiStore = createSessionUiStore()
