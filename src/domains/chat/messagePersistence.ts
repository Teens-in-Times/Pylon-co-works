import type { Message } from './messageTypes'
import { wireErrorParts } from '../../infrastructure/tauri/errorPayload'

// 注意：本模块被 legacy Node 脚本直接 import（scripts/*.test.mts，node --experimental-strip-types）。
// 因此不得有顶层 value import（会触发扩展名缺失的 ESM 解析错误）——只允许 `import type`
// （strip-types 会移除）与函数内动态 import。tauri 探测逻辑内联复制自 infrastructure/tauri/env。

/** Tauri 运行时探测（与 infrastructure/tauri/env 同逻辑，延迟求值）。 */
export function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && (typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
        || typeof (window as { __TAURI__?: unknown }).__TAURI__ !== 'undefined')
}

export interface MessagePersistenceOwner {
  ownerId: string | null
  source: string | null
  renderedSessionId: string | null
  renderedSource: string | null
}

export function canPersistMessages({ ownerId, source, renderedSessionId, renderedSource }: MessagePersistenceOwner): boolean {
  return Boolean(
    ownerId
    && source
    && renderedSessionId
    && renderedSource
    && ownerId === renderedSessionId
    && source === renderedSource,
  )
}

export function messageStorageKey(sessionId: string): string {
  return `pylon-msgs-${sessionId}`
}

export interface MessageStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

// 2026-08-02：消息快照加版本 envelope（旧数据为裸数组，读取时兼容迁移——
// 下次写入自动升级为 envelope；schema 变更时 bump 版本并在 parse 里分支迁移）。
export const MESSAGE_SNAPSHOT_VERSION = 1

interface MessageSnapshotEnvelope<T> {
  version: number
  messages: T[]
}

function isEnvelope(value: unknown): value is MessageSnapshotEnvelope<unknown> {
  return !!value && typeof value === 'object' && 'version' in value && Array.isArray((value as { messages?: unknown }).messages)
}

/** 读取并解析快照：envelope（新）与裸数组（v1 前旧数据）均接受；损坏返回 null。 */
export function parseMessageSnapshot<T>(raw: string | null): T[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isEnvelope(parsed)) return parsed.messages as T[]
    if (Array.isArray(parsed)) return parsed as T[]
    return null
  } catch {
    return null
  }
}

export function persistMessageSnapshot<T>(sessionId: string, messages: T[], storage: MessageStorage): void {
  const key = messageStorageKey(sessionId)
  try {
    if (messages.length === 0) {
      storage.removeItem(key)
      return
    }
    const envelope: MessageSnapshotEnvelope<T> = { version: MESSAGE_SNAPSHOT_VERSION, messages }
    storage.setItem(key, JSON.stringify(envelope))
  } catch {
    // 存储不可用/写满：静默降级——落盘失败不应让渲染 effect 或 controller 抛异常
  }
}

export function clearMessageStorage(sessionId: string, storage: Pick<MessageStorage, 'removeItem'>): void {
  try {
    storage.removeItem(messageStorageKey(sessionId))
  } catch { /* 存储不可用：跳过清除 */ }
}

/** 消息快照 key 前缀（与 domains/search/snapshotSearch 的 MESSAGE_SNAPSHOT_KEY_PREFIX 同值）。 */
export const MESSAGE_STORAGE_KEY_PREFIX = 'pylon-msgs-'

/** 具备键枚举能力的 storage（localStorage 形状；枚举能力缺失时 GC 静默跳过）。 */
export interface EnumerableMessageStorage extends MessageStorage {
  readonly length?: number
  key?: (index: number) => string | null
}

/**
 * #110 F6：孤儿消息快照 GC。
 *
 * 删除会话链路（removeSessionTransaction → clearMessages）只清理「正在被删除的
 * 那一条」；早于该联动落地的删除、以及中途失败/异常退出的删除会留下孤儿键而永不
 * 回收（体检实证：`pylon-msgs-smstyclin`、`pylon-msgs-smsplz710` 两条孤儿，且其
 * 会话已不在 `pylon-sessions` 列表中）。水合完成后按活会话集合回收，返回被删除的
 * 键（便于记账/断言）。
 *
 * 只删 `pylon-msgs-` 前缀的键——运行态之外的任何 localStorage 内容都不在本职责内。
 */
export function pruneOrphanMessageSnapshots(
  liveSessionIds: Iterable<string>,
  storage: EnumerableMessageStorage,
): string[] {
  const live = new Set(liveSessionIds)
  const keys: string[] = []
  try {
    const length = typeof storage.length === 'number' ? storage.length : 0
    for (let index = 0; index < length; index += 1) {
      const key = storage.key?.(index)
      if (typeof key === 'string') keys.push(key)
    }
  } catch {
    // 枚举不可用（隐私模式等）：放弃本次 GC，不影响启动。
    return []
  }
  const removed: string[] = []
  for (const key of keys) {
    if (!key.startsWith(MESSAGE_STORAGE_KEY_PREFIX)) continue
    if (live.has(key.slice(MESSAGE_STORAGE_KEY_PREFIX.length))) continue
    try {
      storage.removeItem(key)
      removed.push(key)
    } catch { /* 存储不可用：跳过该键 */ }
  }
  return removed
}

/** 恢复时参与中断归一的字段子集（不把 Message 类型拖进本模块）。 */
export interface RestorableRunningMessage {
  running?: boolean
  role?: string
  toolStatus?: string
}

/**
 * #110 F6：快照恢复时的中断终态归一。
 *
 * 进程重启后仍标 `running` 的消息，其终态事件不会跨进程补发——它只可能属于一个
 * 被中断的回合（体检实证：`pylon-msgs-smstyclin` 里一条 `running:true` 的僵尸工具
 * 消息）。恢复时统一收敛为终态：工具消息补 `cancelled`（视觉状态表里的「已取消」，
 * 而不是把未知结局谎报成 `completed`），其余清 `running`。
 */
export function settleInterruptedSnapshot<T extends RestorableRunningMessage>(messages: readonly T[]): T[] {
  return messages.map(message => {
    if (!message.running) return message
    if (message.role === 'tool') {
      return { ...message, running: false, toolStatus: message.toolStatus || 'cancelled' }
    }
    return { ...message, running: false }
  })
}

// ============================================================================
// I14-W2：MessageRepository 抽象（分层见 ISSUE-14「参考解决方案」）。
// Solid 组件 → scheduler → MessageRepository → browser(adapter localStorage)
// | tauri(adapter typed invoke) → Rust command → MessageService → MsgRepo。
// adapter 在 composition root（messagePersistScheduler 单例）按 IS_TAURI 选择；
// 组件不直接 invoke、不直接知道 SQLite。
// ============================================================================

/** SQLite 消息行 wire 形状（后端 MessageRecord camelCase；seq 由仓库分配）。 */
export interface MessageRecord {
  messageId: string
  sessionId: string
  /** 仓库统一分配；输入可省略（后端忽略并重分配）。 */
  seq?: number
  role: string
  content: string
  clientMsgId?: string | null
  createdAt: number
}

/** 批量 append 结果：实际写入消息（message_id 去重）+ 会话最新 revision。 */
export interface AppendResult {
  messages: MessageRecord[]
  revision: number
}

/** 消息页（游标分页，升序）+ 下一页游标（null = 已到最早）。 */
export interface MessagePage {
  messages: MessageRecord[]
  nextBeforeSeq: number | null
}

/** 写失败结构化错误：code 供分支（message_revision_conflict / message_db_unavailable）。 */
export class MessageRepositoryError extends Error {
  readonly code: string | undefined
  constructor(code: string | undefined, message: string) {
    super(message)
    this.name = 'MessageRepositoryError'
    this.code = code
  }
}

/** Tauri invoke 拒绝值（后端 {code,message} 结构化错误）→ MessageRepositoryError。 */
export function asRepositoryError(error: unknown): MessageRepositoryError {
  if (error instanceof MessageRepositoryError) return error
  const parts = wireErrorParts(error)
  return new MessageRepositoryError(parts.code, parts.message)
}

/** invoke 失败必须以 reject 传播（asRepositoryError 只是归一化；不得把失败变成功）。 */
export function rejectRepositoryError(error: unknown): never {
  throw asRepositoryError(error)
}

/** 前端 Message → wire MessageRecord（createdAt 取当前毫秒——W2 排序以仓库 seq 为准）。 */
export function toWireRecord(message: Message, sessionId: string): MessageRecord {
  return {
    messageId: message.id,
    sessionId,
    role: message.role,
    content: message.content,
    clientMsgId: message.clientMsgId ?? null,
    createdAt: Date.now(),
  }
}

/** wire MessageRecord → 前端 Message（W2 load 基础映射；time 从 createdAt 派生展示）。 */
export function fromWireRecord(record: MessageRecord): Message {
  const role = record.role === 'user' || record.role === 'assistant'
    || record.role === 'tool' || record.role === 'reasoning'
    ? record.role
    : 'assistant'
  return {
    id: record.messageId,
    role,
    sender: role === 'user' ? 'user' : 'assistant',
    content: record.content,
    time: record.createdAt > 0 ? new Date(record.createdAt).toLocaleTimeString() : '',
  }
}

/**
 * MessageRepository：消息持久化 client（仅 browser/demo 使用）。
 * A1-c 后 Tauri 会话数据由 canonical_events 承载，messages 表不再由前端写入。
 */
export interface MessageRepository {
  /** 加载会话消息；无数据返回 null。 */
  load(sessionId: string): Promise<Message[] | null>
  /** 保存全量快照（browser 语义）。 */
  save(sessionId: string, messages: readonly Message[]): Promise<void>
  /** 覆盖快照；返回 revision（browser 恒 0）。 */
  append(sessionId: string, messages: readonly Message[], expectedRevision: number | null): Promise<number>
  /** 删除会话消息。 */
  delete(sessionId: string): Promise<void>
  /** 会话当前 revision（browser 无跨写者冲突，恒 0）。 */
  revision(sessionId: string): Promise<number>
}

/** browser adapter：localStorage 快照（demo/浏览器预览模式）。 */
export function browserMessageRepository(storage: MessageStorage = localStorage): MessageRepository {
  return {
    async load(sessionId) {
      // #110 F6：快照恢复即中断归一——跨进程残留的 running 只可能是被中断的回合。
      const snapshot = parseMessageSnapshot<Message>(storage.getItem(messageStorageKey(sessionId)))
      return snapshot === null ? null : settleInterruptedSnapshot(snapshot)
    },
    async save(sessionId, messages) {
      persistMessageSnapshot(sessionId, messages as never[], storage)
    },
    async append(sessionId, messages, _expectedRevision) {
      persistMessageSnapshot(sessionId, messages as never[], storage)
      return 0
    },
    async delete(sessionId) {
      clearMessageStorage(sessionId, storage)
    },
    async revision() {
      return 0
    },
  }
}
