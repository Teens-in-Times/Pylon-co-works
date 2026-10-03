/**
 * I05-A-TEST-01 — 切换状态竞态测试（AC-1）。
 *
 * 覆盖切换事务与 `pylon:agent-status` 事件的时序竞争：事件早到/晚到、
 * 事件在快照查询挂起期间到达、以及快照查询失败不伪造 connected。
 *
 * 用真实 runtimeStore + 真实 switchAgentTransaction，deps 接线对齐
 * Settings / OverviewSheetView（resetRuntime → resetSessionRuntime，
 * applyAgentStatus → setAgentStatus）。事件写入路径对齐 App.tsx listener。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore'
import { toAgentContextKey } from '../../../domains/agent/agentContext'
import { switchAgentTransaction } from '../switchAgentTransaction'
import { selectAgentStatus, type AgentStatus, type AgentStatusPayload } from '../../../contracts/agentTypes'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createStoreDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const deps = {
    switchAgent: async (id: string) => { calls.push(`switch:${id}`) },
    resetRuntime: () => { calls.push('reset'); useRuntimeStore.getState().resetSessionRuntime() },
    setActiveAgent: (id: string) => { calls.push(`setActive:${id}`) },
    fetchAgentStatus: async () => { calls.push('fetchStatus'); return { status: 'connected', generation: 5 } },
    applyAgentStatus: (id: string, status: AgentStatus) => {
      calls.push(`applyStatus:${id}`)
      useRuntimeStore.getState().setAgentStatus(id, status)
    },
    reportError: vi.fn(),
    dispatchSwitched: () => { calls.push('dispatch') },
    ...overrides,
  }
  return { deps, calls }
}

beforeEach(() => {
  useRuntimeStore.setState({
    liveGenerating: null,
    liveGeneratingSources: [],
    sessionLiveStats: {},
    sessionModes: {},
    sessionConfig: {},
    agentStatuses: {},
  })
})

describe('switch agent status race（事件早到/晚到/查询失败）', () => {
  it('事件早到：switch 挂起期间到达的 connected 事件不被 reset 清空，最终以快照对账且不变 unknown', async () => {
    useRuntimeStore.setState({
      liveGenerating: 'old:session',
      liveGeneratingSources: ['old:session'],
      sessionConfig: { [toAgentContextKey({ agentId: 'old', source: 'session' })]: { model: 'model-a' } },
      sessionLiveStats: { [toAgentContextKey({ agentId: 'old', source: 'session' })]: { tokensUsed: 1, tokensMax: 100, cacheReadTokens: 0, commands: [] } },
    })
    const gate = deferred<void>()
    const { deps, calls } = createStoreDeps()
    deps.switchAgent = (id: string) => { calls.push(`switch:${id}`); return gate.promise }
    const pending = switchAgentTransaction('peri', 'Peri', deps)

    // 事件在 switch command resolve 前到达（App.tsx listener 写入路径）
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 4 })
    gate.resolve()
    const result = await pending

    expect(result).toEqual({ ok: true, value: 'peri' })
    expect(calls).toEqual(['switch:peri', 'reset', 'setActive:peri', 'fetchStatus', 'applyStatus:peri', 'dispatch'])
    const next = useRuntimeStore.getState()
    // reset 只清会话 runtime，早到事件与末尾快照都保留
    expect(next.liveGenerating).toBeNull()
    expect(next.sessionConfig).toEqual({})
    expect(next.sessionLiveStats).toEqual({})
    expect(next.agentStatuses.peri).toMatchObject({ status: 'connected', generation: 5 })
    expect(selectAgentStatus('peri', 'peri', next.agentStatuses).status).toBe('connected')
  })

  it('事件在快照查询挂起期间到达：末尾快照以对账为准收敛，不回退 unknown', async () => {
    const fetchGate = deferred<AgentStatusPayload>()
    const { deps } = createStoreDeps({ fetchAgentStatus: () => fetchGate.promise })
    const pending = switchAgentTransaction('peri', 'Peri', deps)

    // switch 已 resolve（reset/setActive 已执行），fetch 挂起期间事件到达
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connecting', generation: 4 })
    fetchGate.resolve({ status: 'connected', generation: 5 })
    const result = await pending

    expect(result.ok).toBe(true)
    expect(useRuntimeStore.getState().agentStatuses.peri).toMatchObject({ status: 'connected', generation: 5 })
  })

  it('事件晚到：快照 apply 后到达的低代次事件被 generation guard 拒绝，保持 connected', async () => {
    const { deps } = createStoreDeps()
    const result = await switchAgentTransaction('peri', 'Peri', deps)
    expect(result.ok).toBe(true)
    expect(useRuntimeStore.getState().agentStatuses.peri).toMatchObject({ status: 'connected', generation: 5 })

    // 晚到旧事件（connecting gen 4 < 快照 gen 5）→ 拒绝，不回退
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connecting', generation: 4 })
    expect(useRuntimeStore.getState().agentStatuses.peri).toMatchObject({ status: 'connected', generation: 5 })
  })

  it('事件晚到：快照后到达的新代次事件被接受，状态单调收敛', async () => {
    const { deps } = createStoreDeps()
    await switchAgentTransaction('peri', 'Peri', deps)

    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connected', generation: 6 })
    expect(useRuntimeStore.getState().agentStatuses.peri).toMatchObject({ status: 'connected', generation: 6 })
  })

  it('查询失败：不伪造 connected，切换仍成功，状态保持 unknown 并报告对账错误', async () => {
    const reportError = vi.fn()
    const { deps } = createStoreDeps({
      reportError,
      fetchAgentStatus: async () => { throw new Error('status unavailable') },
    })
    const result = await switchAgentTransaction('peri', 'Peri', deps)

    expect(result).toEqual({ ok: true, value: 'peri' })
    expect(reportError).toHaveBeenCalledWith('对账 Agent 状态', expect.any(Error))
    // 无任何事件/快照 → 不伪造 connected；selectAgentStatus 归为 unknown
    expect(useRuntimeStore.getState().agentStatuses.peri).toBeUndefined()
    expect(selectAgentStatus('peri', 'peri', useRuntimeStore.getState().agentStatuses).status).toBe('unknown')
  })

  it('查询失败：早到 connecting 事件保留原值，不被清空也不被伪造为 connected', async () => {
    const reportError = vi.fn()
    const gate = deferred<void>()
    const { deps } = createStoreDeps({
      reportError,
      fetchAgentStatus: async () => { throw new Error('status unavailable') },
    })
    deps.switchAgent = (id: string) => { void id; return gate.promise }
    const pending = switchAgentTransaction('peri', 'Peri', deps)

    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', agentId: 'peri', status: 'connecting', generation: 3 })
    gate.resolve()
    const result = await pending

    expect(result.ok).toBe(true)
    expect(reportError).toHaveBeenCalledWith('对账 Agent 状态', expect.any(Error))
    expect(useRuntimeStore.getState().agentStatuses.peri).toMatchObject({ status: 'connecting', generation: 3 })
  })
})
