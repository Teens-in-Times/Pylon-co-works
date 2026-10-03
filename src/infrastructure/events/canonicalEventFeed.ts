/**
 * canonicalEventFeed — canonical 已提交行的单一入口（P52 D2）。
 *
 * 职责（从 chatEventController 迁入，语义逐条保留）：
 * - 持有唯一的 CanonicalEventCursor（per-owner 串行、gap 回填、去重），
 *   kernel-committed 行在投影之前逐条 publishPluginEvent（durable-before-project）；
 *   #439 起前端自写轨（canonical sink）已退役，journal 写路径严格归 kernel；
 * - 持有 `pylon:user` window 广播兜底（未注册 Channel 的来源，如平台 ingest）；
 * - 对外转发原始帧给消费方（过渡期 = legacy ChatController 的 handleStreamFrame），
 *   kernelCommitted 标记随帧传递——消费方据此跳过自写 canonical；
 * - 终帧信号 onTerminal（done/error），供 D3 TurnClock 收编。
 *
 * 不负责：帧投影本身、load 事务缓冲（经 onCanonicalRow 订阅回传）、
 * recovered 行重放（经 onRecoveredRow 订阅回传）。
 *
 * 框架无关：不 import React/Solid/store；错误统一走 reportRuntimeError。
 */
import { listen } from '@tauri-apps/api/event'
import { IS_TAURI } from '../tauri/env.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import { PYLON_STREAM_WIRE_EVENTS } from './pylonStreamWireEvents.ts'
import { CanonicalEventCursor } from './canonicalEventCursor.ts'
import { tauriCanonicalEventRepository } from './canonicalEventRepository.ts'
import type { CanonicalEventRow } from '../../domains/events/canonicalEventRow.ts'
import { publishPluginEvent } from './pluginEventBusHost.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'

export type CanonicalTerminalKind = 'done' | 'error'

export interface CanonicalTerminalSignal {
  readonly source: string | undefined
  readonly kind: CanonicalTerminalKind
  readonly payload: unknown
  /**
   * #442 Step2：终帧 additive 回合身份（后端 settle/失败路径注入的出站 request
   * id）。缺省 = 旧内核终帧（消费方回退 stamps 猜测轨）。
   */
  readonly turnId?: number
}

/** Channel 帧 / pylon:user 广播事件的同构信封（streamChannel.StreamFrame 的结构子集）。 */
export interface CanonicalFeedFrame {
  readonly event: string
  readonly payload: unknown
}

export interface CanonicalFeedForward {
  readonly frame: CanonicalFeedFrame
  /** true = 本帧携带 kernel-committed 行且该行即本帧通知；消费方跳过 canonical 自写。 */
  readonly kernelCommitted: boolean
}

export type CanonicalFeedRowListener = (event: CanonicalEventRow) => void
export type CanonicalFeedForwardListener = (forward: CanonicalFeedForward) => void | Promise<void>
export type CanonicalFeedTerminalListener = (signal: CanonicalTerminalSignal) => void
export interface CanonicalDraftChunkNotification {
  ownerKey: string
  draftId: string
  chunkIndex: number
  clientGeneration: number
  source: string
  raw: unknown
}
export type CanonicalFeedDraftListener = (chunk: CanonicalDraftChunkNotification) => void
export type CanonicalFeedDraftCommitListener = (ownerKey: string, draftId: string) => void
/** 帧归属源门（迁移前 controller 的 isActiveSource 前置过滤）：false = 整帧丢弃（含 cursor/publish）。 */
export type CanonicalFeedSourceGate = (source: string | undefined) => boolean

export interface CanonicalEventFeed {
  /** Channel 帧唯一入口：先 source gate，再 cursor/publish，再转发；终帧附送 terminal 信号。 */
  acceptFrame(frame: CanonicalFeedFrame): Promise<void>
  /** cursor.forget（owner 级清理，prune/删除会话共用）。#439 起 sink.discard 随自写轨退役。 */
  discard(ownerKey: string): void
  seed(ownerKey: string, sequence: number): void
  /** 帧源门（controller 注入 isActiveSource；null = 接受全部——D4 controller 退役后的终态）。 */
  setSourceGate(gate: CanonicalFeedSourceGate | null): void
  onCanonicalRow(listener: CanonicalFeedRowListener): () => void
  onRecoveredRow(listener: CanonicalFeedRowListener): () => void
  onForward(listener: CanonicalFeedForwardListener): () => void
  onTerminal(listener: CanonicalFeedTerminalListener): () => void
  onDraftChunk(listener: CanonicalFeedDraftListener): () => void
  onDraftCommit(listener: CanonicalFeedDraftCommitListener): () => void
}

function extractCanonicalNotification(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  return (payload as { canonicalEvent?: unknown }).canonicalEvent
}

function extractSource(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const source = (payload as { source?: unknown }).source
  return typeof source === 'string' ? source : undefined
}

function extractDraftChunk(payload: unknown): CanonicalDraftChunkNotification | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const draft = record.draftChunk
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return undefined
  const value = draft as Record<string, unknown>
  if (typeof value.ownerKey !== 'string' || typeof value.draftId !== 'string'
    || !Number.isSafeInteger(value.chunkIndex) || !Number.isSafeInteger(value.clientGeneration)
    || typeof record.source !== 'string') return undefined
  const { draftChunk: _marker, ...raw } = record
  return {
    ownerKey: value.ownerKey, draftId: value.draftId,
    chunkIndex: value.chunkIndex as number,
    clientGeneration: value.clientGeneration as number,
    source: record.source, raw,
  }
}

/** 帧事件名 → 终帧类目（非终帧返回 undefined）。 */
export function canonicalTerminalKindFromEvent(event: string): CanonicalTerminalKind | undefined {
  return event === PYLON_STREAM_WIRE_EVENTS.done ? 'done' : event === PYLON_STREAM_WIRE_EVENTS.error ? 'error' : undefined
}

/** 终帧载荷 → 归属源（非字符串或缺省一律 undefined，调用方据此丢弃）。 */
export function canonicalTerminalSourceFromPayload(payload: unknown): string | undefined {
  return extractSource(payload)
}

/** 终帧载荷顶层的回合身份（#442 Step2 additive `turnId`；非负安全整数才接受）。 */
function terminalTurnIdFromPayload(payload: unknown): number | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const turnId = (payload as { turnId?: unknown }).turnId
  return typeof turnId === 'number' && Number.isSafeInteger(turnId) && turnId >= 0 ? turnId : undefined
}

/**
 * 终帧帧信封 → 终态信号。Channel 主轨（`acceptFrame`）与 window 广播兜底轨共用
 * 这一构造，两条路的终帧判定不得各自演化。
 */
export function canonicalTerminalSignalFromFrame(frame: CanonicalFeedFrame): CanonicalTerminalSignal | undefined {
  const kind = canonicalTerminalKindFromEvent(frame.event)
  if (!kind) return undefined
  const source = extractSource(frame.payload)
  const turnId = terminalTurnIdFromPayload(frame.payload)
  return {
    source,
    kind,
    payload: frame.payload,
    ...(turnId !== undefined ? { turnId } : {}),
  }
}

/**
 * 终帧 window 广播订阅（兜底轨）。
 *
 * 后端两条收尾路径（`finalize_response` → DONE、`publish_prompt_failure` → ERROR）都
 * 无条件走 `emit_event_all` 广播，所以这条路与 Channel 注册是否存在无关。主轨是
 * per-source IPC Channel：`send_message_streaming` 注册、终帧 `take` 注销，且
 * `stop_agent_runtime` 会 `clear_update_channels`——注册一丢，Channel 帧就没有第二次
 * 投递。本订阅让终态收敛不再单点依赖那条注册。
 *
 * 与主轨共用 `canonicalTerminalSignalFromFrame`，两条路的终帧判定不各自演化；
 * 重复投递由消费方（TurnClock 幂等）吸收。非 Tauri 环境为 no-op。
 */
export function subscribeWindowTerminalFrames(listener: CanonicalFeedTerminalListener): () => void {
  if (!IS_TAURI) return () => {}
  const stops: Array<() => void> = []
  let disposed = false
  for (const event of [PYLON_STREAM_WIRE_EVENTS.done, PYLON_STREAM_WIRE_EVENTS.error] as const) {
    void listen(event, payload => {
      const signal = canonicalTerminalSignalFromFrame({ event, payload: payload.payload })
      if (signal) listener(signal)
    }).then(stop => {
      if (disposed) stop()
      else stops.push(stop)
    }).catch(() => {
      // 兜底订阅失败只损失冗余，Channel 主轨不受影响。
    })
  }
  return () => {
    disposed = true
    for (const stop of stops) stop()
    stops.length = 0
  }
}

/** #442 Step3：`pylon:turn-settled` 载荷投影（逐字段守卫，畸形整体丢弃）。 */
export interface CanonicalTurnSettledEvent {
  readonly source: string
  /** 后端 `TurnRecord`（camelCase Serialize：phase/startedAtMs/terminal{cause,settledAtMs}/key）。 */
  readonly turn: Record<string, unknown>
}

export type CanonicalTurnSettledListener = (event: CanonicalTurnSettledEvent) => void

/** 载荷守卫：source 非空字符串 + turn 为对象才接受（缺失不伪造，调用方据此丢弃）。 */
export function canonicalTurnSettledFromPayload(payload: unknown): CanonicalTurnSettledEvent | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const source = extractSource(payload)
  if (source === undefined) return undefined
  const turn = (payload as { turn?: unknown }).turn
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) return undefined
  return { source, turn: turn as Record<string, unknown> }
}

/**
 * #442 Step3：账本 settle 广播订阅——终态收敛**主轨**。
 *
 * `pylon:turn-settled {source, turn}` 由后端在账本 CAS `Published` 时发射（至多
 * 一次），只走窗口广播、与 per-source IPC Channel 的注册生命周期无关——
 * `stop_agent_runtime` 清空注册后仍可投递，终帧丢失场景由此收敛（无永久假在途）。
 * done/error 帧自此退化为正文/usage 载体（双发变无害，TurnClock 幂等吸收）。
 * 非 Tauri 环境为 no-op。
 */
export function subscribeTurnSettled(listener: CanonicalTurnSettledListener): () => void {
  if (!IS_TAURI) return () => {}
  let disposed = false
  let stop: (() => void) | undefined
  void listen(PYLON_STREAM_WIRE_EVENTS.turnSettled, payload => {
    const event = canonicalTurnSettledFromPayload(payload.payload)
    if (event) listener(event)
  }).then(unlisten => {
    if (disposed) unlisten()
    else stop = unlisten
  }).catch(() => {
    // 主轨订阅失败只损失冗余，done/error 帧与账本快照仍可用。
  })
  return () => {
    disposed = true
    stop?.()
    stop = undefined
  }
}

export function createCanonicalEventFeed(): CanonicalEventFeed {
  const cursor = new CanonicalEventCursor(tauriCanonicalEventRepository())
  const rowListeners = new Set<CanonicalFeedRowListener>()
  const recoveredRowListeners = new Set<CanonicalFeedRowListener>()
  const forwardListeners = new Set<CanonicalFeedForwardListener>()
  const terminalListeners = new Set<CanonicalFeedTerminalListener>()
  const draftListeners = new Set<CanonicalFeedDraftListener>()
  const draftCommitListeners = new Set<CanonicalFeedDraftCommitListener>()
  let sourceGate: CanonicalFeedSourceGate | null = null

  const forward = async (frame: CanonicalFeedFrame, kernelCommitted: boolean): Promise<void> => {
    for (const listener of forwardListeners) {
      await listener({ frame, kernelCommitted })
    }
  }

  const emitTerminal = (frame: CanonicalFeedFrame): void => {
    const signal = canonicalTerminalSignalFromFrame(frame)
    if (!signal) return
    for (const listener of terminalListeners) listener(signal)
  }

  const feed: CanonicalEventFeed = {
    async acceptFrame(frame) {
      try {
        // isActiveSource 前置门随迁移保留：未 initSource 的源整帧丢弃（含
        // cursor/publish），与迁移前 handler 入口语义一致。
        const source = extractSource(frame.payload)
        if (sourceGate && !sourceGate(source)) return
        const draftChunk = extractDraftChunk(frame.payload)
        if (draftChunk) {
          for (const listener of draftListeners) listener(draftChunk)
          await forward(frame, true)
          return
        }
        const value = extractCanonicalNotification(frame.payload)
        if (value === undefined) {
          await forward(frame, false)
          emitTerminal(frame)
          return
        }
        // 与迁移前 processCommittedOrLegacy 同构：投影在 cursor consume 回调内
        // await，保持 per-owner tail 串行（cursor → publish → 投影 → 推进）。
        await cursor.accept(value, async (event, isCurrentNotification) => {
          const committedDraftId = frame.payload && typeof frame.payload === 'object'
            ? (frame.payload as { committedDraftId?: unknown }).committedDraftId
            : undefined
          if (isCurrentNotification && typeof committedDraftId === 'string') {
            for (const listener of draftCommitListeners) listener(toCanonicalOwnerKey(event.owner), committedDraftId)
          }
          publishPluginEvent(event)
          for (const listener of rowListeners) listener(event)
          if (isCurrentNotification) {
            await forward(frame, true)
          }
          else {
            for (const listener of recoveredRowListeners) listener(event)
          }
        })
        emitTerminal(frame)
      }
      catch (error) {
        // cursor 校验失败 / gap 不可恢复：帧丢弃并上报（与迁移前 handler 的
        // per-event catch 语义一致），不向上抛——channel 回调是 fire-and-forget。
        reportRuntimeError('消费 Kernel committed 事件', error)
      }
    },
    discard: ownerKey => {
      cursor.forget(ownerKey)
    },
    seed: (ownerKey, sequence) => cursor.seed(ownerKey, sequence),
    setSourceGate: gate => {
      sourceGate = gate
    },
    onCanonicalRow(listener) {
      rowListeners.add(listener)
      return () => rowListeners.delete(listener)
    },
    onRecoveredRow(listener) {
      recoveredRowListeners.add(listener)
      return () => recoveredRowListeners.delete(listener)
    },
    onForward(listener) {
      forwardListeners.add(listener)
      return () => forwardListeners.delete(listener)
    },
    onTerminal(listener) {
      terminalListeners.add(listener)
      return () => terminalListeners.delete(listener)
    },
    onDraftChunk(listener) {
      draftListeners.add(listener)
      return () => draftListeners.delete(listener)
    },
    onDraftCommit(listener) {
      draftCommitListeners.add(listener)
      return () => draftCommitListeners.delete(listener)
    },
  }

  // 两条广播兜底都依赖 Tauri 事件宿主（`listen` 需要 window + __TAURI_INTERNALS__）。
  // node 纯单元环境（无 window）里注册必然失败且失败只化为噪音上报（#228 B 类
  // console.error 的根因），故按环境守卫静默跳过；浏览器/Tauri 环境 window 恒在，
  // 守卫不改变任何行为。
  if (typeof window !== 'undefined') {
    // B1：user echo 后端已 Channel 优先（send_update_frame 单轨）；本广播兜底
    // 服务未注册 Channel 的来源（平台 ingest / 非 Tauri 环境）。feed 为应用级
    // 单例，监听随 feed 生命周期注册一次；失败仅上报（Channel 主轨不受影响）。
    void listen(PYLON_STREAM_WIRE_EVENTS.user, event => {
      void feed.acceptFrame({ event: PYLON_STREAM_WIRE_EVENTS.user, payload: event.payload })
    }).catch(error => {
      reportRuntimeError('注册 canonical feed user 兜底监听', error)
    })

  // #310：`pylon:update` 同样需要广播兜底。后端对**未注册 per-source Channel** 的来源
  // 整回合改走 `emit_event_all` 广播（与 Channel 互斥，见 dispatcher 的
  // `send_update_frame`/`emit_event_all` 分叉）——FileSheet 发令（`send_message`）、
  // 平台 ingest、`pylon_cli session send` 都属这一类，且它们从不注册 Channel。
  // 缺这条兜底时，整回合的助手正文/思考帧进不了 feed（不 publish、不投影），只有
  // `pylon:done` 的兜底轨到得了 → 界面只剩「处理耗时」页脚，正文要等重启冷装载
  // 读 journal 才出现（issue #310 实机复现：回合内 DOM 4 行／重载后 6 行）。
  // 与 `pylon:user` 兜底同形：重复投递由 cursor 的 sequence 去重与投影器幂等吸收。
    void listen(PYLON_STREAM_WIRE_EVENTS.update, event => {
      void feed.acceptFrame({ event: PYLON_STREAM_WIRE_EVENTS.update, payload: event.payload })
    }).catch(error => {
      reportRuntimeError('注册 canonical feed update 兜底监听', error)
    })
  }

  return feed
}

// ---------------------------------------------------------------------------
// 应用级单例：App 关窗 drain、Sidebar/SessionSettings discard、streamingSend
// 帧入口都经此访问，不再穿透 legacy controller。
// ---------------------------------------------------------------------------

let canonicalEventFeedSingleton: CanonicalEventFeed | null = null

export function getCanonicalEventFeed(): CanonicalEventFeed {
  if (!canonicalEventFeedSingleton) {
    canonicalEventFeedSingleton = createCanonicalEventFeed()
  }
  return canonicalEventFeedSingleton
}
