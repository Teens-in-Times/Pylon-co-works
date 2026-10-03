/**
 * chunkMerge — 三路径投影深等的 chunk 聚合判据（live flush / replay reducer /
 * canonical projection 共用同一套规则）。
 *
 * live 路径的语义：流式 chunk 经 streaming 缓冲整段合并，只要角色相同就属于
 * 同一条消息（消息边界由 user/tool/turn 事件决定，不由 identity 决定）。
 * identity 只是元数据，取“最后出现的 identity”（`event.externalIdentity ??
 * current.streamingIdentity`）。
 *
 * replay reducer 与 canonical projection 必须同语义，否则同一组事件会投影出
 * 不同数量/顺序的消息，切换会话后 `mergeBase` 会把缺块补到末尾，表现为
 * “思考块错乱/重放错乱”。这里收敛为唯一规则：
 *
 * - last 与 incoming 同角色（assistant / reasoning）→ 聚合；
 * - 聚合后的 identity = incoming ?? last（与 live streamingIdentity 一致）；
 * - 跨角色（assistant ↔ reasoning ↔ tool ↔ user）→ 新建消息。
 *
 * 纯函数域模块：零框架 / 零 store。
 */
import type { OptionalChatEventIdentity } from '../../infrastructure/acp/chatContracts.ts'

export interface ChunkAppendResolution {
  shouldAppend: boolean
  /** 合并后消息的 externalIdentity；双方都无 identity 时为 undefined。 */
  identity?: OptionalChatEventIdentity
}

/** 相邻 chunk 是否应并入上一条消息，以及合并后应采用的 identity（三路径共用）。 */
export function resolveChunkAppend(params: {
  lastRole: string | undefined
  incomingRole: string
  lastIdentity?: OptionalChatEventIdentity
  incomingIdentity?: OptionalChatEventIdentity
}): ChunkAppendResolution {
  if (params.lastRole !== params.incomingRole) return { shouldAppend: false }
  const identity = params.incomingIdentity ?? params.lastIdentity
  return identity
    ? { shouldAppend: true, identity }
    : { shouldAppend: true }
}
