import { beforeEach, describe, expect, it } from 'vitest'
import { useRuntimeStore } from '../runtimeStore'
import { toAgentContextKey } from '../../agent/agentContext'
import { EMPTY_PERMISSION_STATE } from '../../permission/permissionState'

/**
 * I01-W2：双 Agent 同名 source 隔离——会话运行时状态（config/mode/stats）
 * 按 AgentContextKey（agentId+source）键控，两个 Agent 使用同名 source 不共享。
 */
describe('I01-W2 runtimeStore 双 Agent 同名 source 隔离', () => {
  const ctxA = { agentId: 'agent-a', source: 'local:same-name' }
  const ctxB = { agentId: 'agent-b', source: 'local:same-name' }

  beforeEach(() => {
    useRuntimeStore.setState({
      sessionConfig: {},
      sessionModes: {},
      sessionLiveStats: {},
      liveGenerating: null,
      liveGeneratingSources: [],
    })
  })

  it('config/mode/stats 按 context 隔离，同名 source 不共享', () => {
    const store = useRuntimeStore.getState()
    store.setSessionConfig(ctxA, { model: 'model-a' })
    store.setSessionMode(ctxA, 'plan')
    store.setSessionLiveStats(ctxA, { tokensUsed: 10 })
    store.setSessionConfig(ctxB, { model: 'model-b' })
    store.setSessionMode(ctxB, 'auto')
    store.setSessionLiveStats(ctxB, { tokensUsed: 99 })

    const s = useRuntimeStore.getState()
    expect(s.sessionConfig[toAgentContextKey(ctxA)]?.model).toBe('model-a')
    expect(s.sessionConfig[toAgentContextKey(ctxB)]?.model).toBe('model-b')
    expect(s.sessionModes[toAgentContextKey(ctxA)]).toBe('plan')
    expect(s.sessionModes[toAgentContextKey(ctxB)]).toBe('auto')
    expect(s.sessionLiveStats[toAgentContextKey(ctxA)]?.tokensUsed).toBe(10)
    expect(s.sessionLiveStats[toAgentContextKey(ctxB)]?.tokensUsed).toBe(99)
  })

  it('AgentContextKey 为 JSON 二元组，source 含冒号不与拼接冲突', () => {
    const ctx = { agentId: 'a', source: 'local:x:y' }
    const key = toAgentContextKey(ctx)
    expect(key).toBe(JSON.stringify(['a', 'local:x:y']))
    expect(key).not.toBe('a:local:x:y')
  })

  it('clearSessionSource 只清指定 context，其他 Agent 同名 source 保留', () => {
    const store = useRuntimeStore.getState()
    store.setSessionConfig(ctxA, { model: 'model-a' })
    store.setSessionConfig(ctxB, { model: 'model-b' })
    store.setSessionMode(ctxB, 'auto')
    store.clearSessionSource(ctxA)

    const s = useRuntimeStore.getState()
    expect(s.sessionConfig[toAgentContextKey(ctxA)]).toBeUndefined()
    expect(s.sessionConfig[toAgentContextKey(ctxB)]?.model).toBe('model-b')
    expect(s.sessionModes[toAgentContextKey(ctxB)]).toBe('auto')
  })

  it('agent status binding snapshot 按 AgentContext 隔离并仅在 Attached 时推进 generation', () => {
    const store = useRuntimeStore.getState()
    store.setBindingGeneration(ctxA, 4)
    store.setAgentStatus('agent-a', {
      agent: 'agent-a', status: 'connected', generation: 5,
      sessionBindings: [{ agentId: 'agent-a', source: ctxA.source, health: 'detached', generation: 5, reason: 'session-probe-timeout', retryable: true }],
    })
    let state = useRuntimeStore.getState()
    expect(state.bindingGenerations[toAgentContextKey(ctxA)]).toBe(4)
    expect(state.sessionBindingHealth[toAgentContextKey(ctxA)]?.health).toBe('detached')

    store.setAgentStatus('agent-a', {
      agent: 'agent-a', status: 'connected', generation: 5,
      sessionBindings: [{ agentId: 'agent-a', source: ctxA.source, health: 'attached', generation: 5, retryable: false }],
    })
    state = useRuntimeStore.getState()
    expect(state.bindingGenerations[toAgentContextKey(ctxA)]).toBe(5)
    expect(state.sessionBindingHealth[toAgentContextKey(ctxA)]?.health).toBe('attached')
  })

  it('resetSessionRuntime 保留 permission 切片（P1-1 停放，WI-05 CR-201 吸收）', () => {
    useRuntimeStore.setState({ permission: EMPTY_PERMISSION_STATE })
    const store = useRuntimeStore.getState()
    store.setPermission({
      type: 'receive',
      request: {
        requestId: '1',
        provider: 'peri',
        agentId: 'peri-a',
        sessionId: 's1',
        clientGeneration: 1,
        options: [{ optionId: 'allow_once' }],
      },
    })
    expect(useRuntimeStore.getState().permission.byAgent['peri-a']?.active?.request.requestId).toBe('1')
    // 切换/设置/会话恢复触发的运行时重置不得清空权限切片（停放，切回继续）
    store.resetSessionRuntime()
    expect(useRuntimeStore.getState().permission.byAgent['peri-a']?.active?.request.requestId).toBe('1')
    useRuntimeStore.setState({ permission: EMPTY_PERMISSION_STATE })
  })
})
