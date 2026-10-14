import { describe, expect, it } from 'vitest'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import type { Session } from '../../../domains/identity/identityStore.ts'
import type { CanonicalTerminalSignal, CanonicalTurnSettledEvent } from '../../../infrastructure/events/canonicalEventFeed.ts'

/**
 * issue #68 残留面：生成摘要**只**由终帧驱动，而终帧只经 per-source IPC Channel
 * 一条路交付。
 *
 * - `src-tauri/src/session/prompt.rs` 的 `send_channel_terminal` 用 `take` 语义
 *   （发送即注销），`lifecycle/mod.rs` 的 `stop_agent_runtime` 会 `clear_update_channels`；
 * - 前端 `activeStreams` 条目也会在 invoke 被拒时被 `close(source)` 移除，此后 Channel
 *   回调 `activeStreams.get(source)?.handler(frame)` 拿不到 handler，帧被静默丢弃；
 * - 而 `pylon:done`/`pylon:error` 的 window 广播在加兜底前**没有任何消费者**。
 *
 * 于是 Channel 一丢，终帧就没有第二次投递：文档投影照旧收敛到「不在生成」，运行时
 * 落到 `generating:false, summary:null`，footer 两样都不渲染（无 spinner、无「处理耗时」），
 * 唯一恢复手段是切 sheet 触发 canonical 重读。
 *
 * 本文件锁两条不依赖 Channel 注册的终态证据：
 * ① window 广播兜底订阅；
 * ② #99 冷挂载 turn 账本（随 `load_persisted_session` 回来，设计意图即「前端不再依赖
 *    一次性的 Tauri event」）。
 */

function session(id: string, source: string): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function runtimeFor(active: Session, overrides: {
  loadAll?: () => Promise<readonly unknown[]>
  listenTerminalFallback?: (listener: (signal: CanonicalTerminalSignal) => void) => () => void
} = {}) {
  return createAgentWorkbenchSessionRuntime({
    loadAll: overrides.loadAll ?? (async () => []),
    subscribe: () => () => {},
    ...(overrides.listenTerminalFallback ? { listenTerminalFallback: overrides.listenTerminalFallback } : {}),
    commands: {
      resolveSession: () => active,
      nextClientMessageId: () => 'client-68-fallback-1',
      sendMessage: async () => {},
      optimisticUser: () => {},
      rejectOptimisticUser: () => {},
      resolvePersona: () => 'default',
      requestCancel: () => {},
    },
  })
}

describe('terminal delivery does not depend on the per-source IPC Channel (issue #68 residue)', () => {
  it('publishes the summary from the window broadcast when no Channel frame ever arrives', async () => {
    const active = session('session-fallback', 'local:fallback')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => {
        listeners.push(listener)
        return () => { listeners.length = 0 }
      },
    })

    const sent = await service.commands.send(active.id, { text: '首条消息' })
    expect(sent.status).toBe('sent')
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(true)
    // 模拟 Channel 注册丢失：feed.onTerminal 一次都不触发（没有 Channel 帧）。
    expect(listeners).toHaveLength(1)

    // 这 5ms 是承重睡（同 agentWorkbenchSession.emptyStateFirstPrompt.test.ts 的既有
    // 约定，#613）：elapsedMs = 终帧 Date.now() − 发送入口 Date.now()（optimisticEcho
    // 的 generationStart，agentWorkbenchOptimisticEcho.ts:87–88 与
    // agentWorkbenchTurnLifecycle.ts:52），两端都是 1ms 分辨率的 Date.now，所以
    // `elapsedMs > 0` 等价于「这条序列真实跨过一个毫秒边界」——是对墙钟分辨率的断言。
    // 冷进程里这段序列要 4–6ms，但本文件属 node-shared（isolate: false）分组，长跑
    // worker 里被同组文件预热后会掉到亚毫秒：实测同进程重复 300 次有 287 次恰为 0。
    // 不睡就是全量偶发红（隔离跑反而绿，因为它是冷进程）。
    // 不能降级成纯微任务冲刷（可落在同一毫秒内）。
    await new Promise(resolve => setTimeout(resolve, 5))

    // 终帧只从 window 广播兜底进来——它带 source，必须照常收敛。
    listeners[0]({ source: active.source, kind: 'done', payload: { source: active.source } })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({
      reason: 'done',
      durationSource: 'live-monotonic',
      durationAvailable: true,
    })
    expect(snapshot.summary?.elapsedMs).toBeGreaterThan(0)
    service.destroy()
  })

  it('keeps the broadcast redundant: a duplicate terminal is a no-op, not a second summary', async () => {
    const active = session('session-fallback-dup', 'local:fallback-dup')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => { listeners.push(listener); return () => {} },
    })

    await service.commands.send(active.id, { text: '首条消息' })
    await service.bind(active)
    const signal: CanonicalTerminalSignal = { source: active.source, kind: 'done', payload: { source: active.source } }
    listeners[0](signal)
    const first = service.runtime.getSnapshot().summary
    listeners[0](signal)
    expect(service.runtime.getSnapshot().summary).toBe(first)
    service.destroy()
  })

  it('#324: a done frame carrying stopReason=cancelled summarizes as cancelled (已停止), not a natural completion', async () => {
    const active = session('session-cancelled', 'local:cancelled')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => { listeners.push(listener); return () => {} },
    })

    await service.commands.send(active.id, { text: '首条消息' })
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // 内核 #324 中性结算：done 帧 + stopReason=cancelled（用户主动停止）。
    listeners[0]({
      source: active.source,
      kind: 'done',
      payload: { source: active.source, data: { stopReason: 'cancelled' } },
    })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({ reason: 'cancelled' })
    service.destroy()
  })
})

describe('#99 cold-mount turn ledger is the second terminal evidence (issue #68 residue)', () => {
  it('publishes a display-only summary when the journal read predates the terminal row', async () => {
    const active = session('session-ledger', 'local:ledger')
    // `loadAll` 返回空 = journal 里还没有终态行（后端 "done 先于 persist"，落盘滞后）。
    const service = runtimeFor(active, { listenTerminalFallback: () => () => {} })

    const sent = await service.commands.send(active.id, { text: '首条消息' })
    expect(sent.status).toBe('sent')
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // 终帧从未到达（Channel 丢失且无广播），但一次 canonical 重载带回权威账本。
    await service.refresh(active, {
      source: active.source,
      turn: { phase: 'terminal', terminal: { cause: 'completed', settledAtMs: 1, detail: null } },
    })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({ reason: 'done', displayOnly: true })
    service.destroy()
  })

  it('carries the ledger terminal cause into the summary reason', async () => {
    const active = session('session-ledger-cancel', 'local:ledger-cancel')
    const service = runtimeFor(active, { listenTerminalFallback: () => () => {} })

    await service.commands.send(active.id, { text: '首条消息' })
    await service.bind(active)
    await service.refresh(active, {
      source: active.source,
      turn: { phase: 'terminal', terminal: { cause: 'cancelled', settledAtMs: 1 } },
    })

    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'cancelled', displayOnly: true })
    service.destroy()
  })

  it('never fabricates a summary while the ledger says the turn is still in flight', async () => {
    const active = session('session-ledger-inflight', 'local:ledger-inflight')
    const service = runtimeFor(active, { listenTerminalFallback: () => () => {} })

    await service.commands.send(active.id, { text: '首条消息' })
    await service.bind(active)
    await service.refresh(active, { source: active.source, turn: { phase: 'streaming' } })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.summary).toBeNull()
    expect(snapshot.generating).toBe(true)
    service.destroy()
  })

  it('drops a previous turn ledger reason once a new turn starts', async () => {
    const active = session('session-ledger-newturn', 'local:ledger-newturn')
    const service = runtimeFor(active, { listenTerminalFallback: () => () => {} })

    // 第一回合：账本已收敛 → displayOnly 摘要。
    await service.commands.send(active.id, { text: '第一回合' })
    await service.bind(active)
    await service.refresh(active, { source: active.source, turn: { phase: 'terminal', terminal: { cause: 'completed', settledAtMs: 1 } } })
    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'done', displayOnly: true })

    // 第二回合开始：上一回合的账本终态必须失效，否则新回合会被判成已收敛。
    await service.commands.send(active.id, { text: '第二回合' })
    await service.refresh(active, { source: active.source, turn: { phase: 'streaming' } })

    expect(service.runtime.getSnapshot().summary).toBeNull()
    expect(service.runtime.getSnapshot().generating).toBe(true)
    service.destroy()
  })
})

/**
 * #442 Step2：终帧 additive `turnId` → stamps 归属退役。
 *
 * 终帧原本不带回合身份，身份戳只能猜「最近一次 active 快照」；后端在
 * settle/失败路径注入 `turnId` 后，匹配走精确身份，错配宁可不落 settled
 * （留给内核后续 false 快照收敛），旧内核缺省帧维持猜测回退轨。
 */
describe('#442 Step2 terminal frame turnId retires the stamp guess', () => {
  const snapshotInFlight = (turnId: number) => ({
    source: 'x',
    turn: { phase: 'streaming', key: { generation: 1, turnId } },
    turnInFlight: true,
  })

  it('matching turnId settles exactly that stamp; a stale in-flight snapshot of the same turn stays rejected', async () => {
    const active = session('session-tid-match', 'local:tid-match')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => { listeners.push(listener); return () => {} },
    })

    await service.bind(active)
    await service.refresh(active, snapshotInFlight(7))
    await service.commands.send(active.id, { text: '回合消息' })
    expect(service.runtime.getSnapshot().generating).toBe(true)

    listeners[0]({ source: active.source, kind: 'done', payload: { source: active.source }, turnId: 7 })
    expect(service.runtime.getSnapshot().generating).toBe(false)

    // 新回合开跑后，上一回合（同身份）的 stale true 快照不得复活内核在途。
    await service.commands.send(active.id, { text: '第二回合' })
    await service.refresh(active, snapshotInFlight(7))
    expect(service.runtime.getSnapshot().generating).toBe(true)
    service.destroy()
  })

  it('mismatching turnId keeps the stamp unset: the real in-flight turn is not masked by a late frame', async () => {
    const active = session('session-tid-mismatch', 'local:tid-mismatch')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => { listeners.push(listener); return () => {} },
    })

    await service.bind(active)
    // 内核条目 + 身份戳（无时钟条目：本轮从未 send）。
    await service.refresh(active, snapshotInFlight(7))

    // 迟到的旧回合终帧（turnId 8 ≠ active 戳的 7）：不得把 7 记成 settled。
    listeners[0]({ source: active.source, kind: 'error', payload: { source: active.source, code: 'protocol_error' }, turnId: 8 })

    // turn 7 的真实在途快照随后到达：必须照常采纳（内核说 7 还在跑）。
    await service.refresh(active, snapshotInFlight(7))
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('kernel')
    expect(snapshot.generating).toBe(true)
    service.destroy()
  })

  it('a frame without turnId (old kernel) keeps the guess fallback: settled = most recent active stamp', async () => {
    const active = session('session-tid-legacy', 'local:tid-legacy')
    const listeners: Array<(signal: CanonicalTerminalSignal) => void> = []
    const service = runtimeFor(active, {
      listenTerminalFallback: listener => { listeners.push(listener); return () => {} },
    })

    await service.bind(active)
    await service.refresh(active, snapshotInFlight(7))

    // 旧内核终帧不携带 turnId → 回退猜测轨（settled = 最近 active 戳）。
    listeners[0]({ source: active.source, kind: 'done', payload: { source: active.source } })

    // 同身份的 stale true 快照被猜测轨挡住（与既有行为逐字一致）。
    await service.refresh(active, snapshotInFlight(7))
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.livenessSource).toBe('kernel')
    expect(snapshot.generating).toBe(false)
    service.destroy()
  })
})

/**
 * #442 Step3：`pylon:turn-settled` 账本广播是终态收敛**主轨**——内核事实，与
 * Channel 注册生命周期无关（后端账本 CAS Published 时窗口广播，至多一次）。
 * 终帧丢失场景（stop_agent_runtime 清注册 / activeStreams 条目被移除）由此收敛，
 * 无永久假在途；done/error 帧退化为正文/usage 载体，双到由 TurnClock 幂等吸收。
 */
describe('#442 Step3 turn-settled broadcast is the convergence main track', () => {
  const settledTurn = (turnId: number, cause = 'completed') => ({
    phase: 'terminal',
    startedAtMs: 1,
    terminal: { cause, settledAtMs: Date.parse('2026-09-05T00:00:05.000Z') },
    key: { generation: 1, turnId },
  })

  function serviceWithTurnSettled(active: Session, listeners: Array<(event: CanonicalTurnSettledEvent) => void>) {
    return createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      subscribe: () => () => {},
      // Channel 丢失形态：终帧永不到达（feed.onTerminal 与广播兜底都保持静默）。
      listenTerminalFallback: () => () => {},
      listenTurnSettled: listener => { listeners.push(listener); return () => {} },
      commands: {
        resolveSession: () => active,
        nextClientMessageId: () => 'client-442-turn-settled',
        sendMessage: async () => {},
        optimisticUser: () => {},
        rejectOptimisticUser: () => {},
        resolvePersona: () => 'default',
        requestCancel: () => {},
      },
    })
  }

  it('converges a lost-terminal-frame turn from the broadcast (no permanent fake in-flight)', async () => {
    const active = session('session-ts-main', 'local:ts-main')
    const listeners: Array<(event: CanonicalTurnSettledEvent) => void> = []
    const service = serviceWithTurnSettled(active, listeners)

    await service.commands.send(active.id, { text: '唯一消息' })
    await service.bind(active)
    expect(service.runtime.getSnapshot().generating).toBe(true)

    // 终帧永不到达；账本 settle 广播先到（内核事实主轨）。
    listeners[0]({ source: active.source, turn: settledTurn(5) })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating, '账本广播必须收敛假在途').toBe(false)
    expect(snapshot.summary).toMatchObject({
      reason: 'done',
      durationSource: 'live-monotonic',
      durationAvailable: true,
    })
    service.destroy()
  })

  it('carries the ledger cause into the summary reason (cancelled stays 已停止)', async () => {
    const active = session('session-ts-cancel', 'local:ts-cancel')
    const listeners: Array<(event: CanonicalTurnSettledEvent) => void> = []
    const service = serviceWithTurnSettled(active, listeners)

    await service.commands.send(active.id, { text: '消息' })
    await service.bind(active)
    listeners[0]({ source: active.source, turn: settledTurn(6, 'cancelled') })

    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'cancelled' })
    service.destroy()
  })

  it('unmapped cause still stops the spinner but never fabricates a summary reason', async () => {
    const active = session('session-ts-unknown', 'local:ts-unknown')
    const listeners: Array<(event: CanonicalTurnSettledEvent) => void> = []
    const service = serviceWithTurnSettled(active, listeners)

    await service.commands.send(active.id, { text: '消息' })
    await service.bind(active)
    listeners[0]({ source: active.source, turn: settledTurn(7, 'zombieProtocol') })

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating, '内核说 settle 就是 settle：活性必须落静').toBe(false)
    expect(snapshot.summary, '认不出的 cause 不得伪造 reason 摘要').toBeNull()
    service.destroy()
  })

  it('duplicate broadcasts are absorbed idempotently (first summary wins)', async () => {
    const active = session('session-ts-dup', 'local:ts-dup')
    const listeners: Array<(event: CanonicalTurnSettledEvent) => void> = []
    const service = serviceWithTurnSettled(active, listeners)

    await service.commands.send(active.id, { text: '消息' })
    await service.bind(active)
    listeners[0]({ source: active.source, turn: settledTurn(8) })
    const first = service.runtime.getSnapshot().summary
    listeners[0]({ source: active.source, turn: settledTurn(8) })
    expect(service.runtime.getSnapshot().summary).toBe(first)
    service.destroy()
  })
})
