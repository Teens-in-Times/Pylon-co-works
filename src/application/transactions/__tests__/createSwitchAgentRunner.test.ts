import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSwitchAgentRunner } from '../openOwnedSessionTransaction'

/**
 * #520 S2-P2：switchAgent 装配共享工厂（openOwnedSessionTransaction 与
 * settingsAgentActions 的 ports 对象逐字重复收敛）。本文件锁定工厂接线契约：
 * invoke → resetRuntime → setActiveAgent → 对账 agent_status → 广播 agent-switched；
 * 失败面（切换 invoke reject / 对账 reject）走注入的错误口径并保持事务语义。
 */
const mocks = vi.hoisted(() => ({
  tauriInvoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  resetSessionRuntime: vi.fn(),
  setAgentStatus: vi.fn(),
  setActiveAgent: vi.fn(),
  dispatchEvent: vi.fn(),
}))

vi.mock('../../../infrastructure/acp/tauriTransport.ts', () => ({ tauriInvokeTransport: mocks.tauriInvoke }))
vi.mock('../../../domains/runtime/runtimeStore.ts', () => ({
  useRuntimeStore: {
    getState: () => ({ resetSessionRuntime: mocks.resetSessionRuntime, setAgentStatus: mocks.setAgentStatus }),
  },
}))
vi.mock('../../../domains/identity/identityStore.ts', () => ({
  useIdentityStore: { getState: () => ({ setActiveAgent: mocks.setActiveAgent }) },
}))

const reportError = vi.fn()
const resolveError = vi.fn()

beforeEach(() => {
  vi.stubGlobal('window', { dispatchEvent: mocks.dispatchEvent })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('createSwitchAgentRunner（共享装配工厂）', () => {
  it('成功路径按序：switch_agent invoke → resetRuntime → setActiveAgent → 对账 → 广播', async () => {
    mocks.tauriInvoke.mockImplementation(cmd => {
      if (cmd === 'switch_agent') return Promise.resolve({})
      if (cmd === 'agent_status') return Promise.resolve({ agent: 'agent-b', status: 'connected', generation: 1 })
      return Promise.reject(new Error(`unexpected command ${cmd}`))
    })
    const calls: string[] = []
    mocks.resetSessionRuntime.mockImplementation(() => { calls.push('reset') })
    mocks.setActiveAgent.mockImplementation(() => { calls.push('activate') })
    mocks.setAgentStatus.mockImplementation(() => { calls.push('apply') })
    mocks.dispatchEvent.mockImplementation(() => { calls.push('dispatch') })
    const run = createSwitchAgentRunner({ reportError, resolveError })
    const result = await run('agent-b')
    expect(result).toEqual({ ok: true, value: 'agent-b' })
    expect(mocks.tauriInvoke).toHaveBeenCalledWith('switch_agent', { name: 'agent-b' })
    expect(calls).toEqual(['reset', 'activate', 'apply', 'dispatch'])
    expect(mocks.dispatchEvent.mock.calls[0][0]).toBeInstanceOf(CustomEvent)
    expect((mocks.dispatchEvent.mock.calls[0][0] as CustomEvent).type).toBe('pylon:agent-switched')
    expect(resolveError).toHaveBeenCalledWith('切换 Agent', 'agent-b')
    expect(resolveError).toHaveBeenCalledWith('对账 Agent 状态', 'agent-b')
    expect(reportError).not.toHaveBeenCalled()
  })

  it('switch_agent reject → 注入错误口径收（action, error, agentId），结果 transport，不 reset 不切 active', async () => {
    const failure = new Error('agent offline')
    mocks.tauriInvoke.mockImplementation(cmd => cmd === 'switch_agent' ? Promise.reject(failure) : Promise.resolve({}))
    const run = createSwitchAgentRunner({ reportError, resolveError })
    const result = await run('agent-b')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('transport')
    expect(reportError).toHaveBeenCalledWith('切换 Agent', failure, 'agent-b')
    expect(mocks.resetSessionRuntime).not.toHaveBeenCalled()
    expect(mocks.setActiveAgent).not.toHaveBeenCalled()
    expect(mocks.dispatchEvent).not.toHaveBeenCalled()
  })

  it('对账 reject 只报告诊断不伪造失败：事务仍 ok、广播照常', async () => {
    const failure = new Error('status unavailable')
    mocks.tauriInvoke.mockImplementation(cmd => {
      if (cmd === 'switch_agent') return Promise.resolve({})
      return Promise.reject(failure)
    })
    const run = createSwitchAgentRunner({ reportError, resolveError })
    const result = await run('agent-b')
    expect(result).toEqual({ ok: true, value: 'agent-b' })
    expect(reportError).toHaveBeenCalledWith('对账 Agent 状态', failure, 'agent-b')
    expect(mocks.dispatchEvent).toHaveBeenCalled()
  })
})
