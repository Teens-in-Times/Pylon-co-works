// @vitest-environment jsdom
// #515 W1：迁移自 useAgentCandidateProvisioning.test.tsx（React renderHook → Solid 实体直连）。
// 断言改写点登记（断言集零缩减）：
// 1. renderHook → Harness 组件直连 createAgentCandidateProvisioning（Solid 无 renderHook）；
//    hook 句柄在组件体捕获，断言读访问器（candidateErrors()/importedCandidateIds()/…）。
// 2. `options.agents` prop → accessor（`agents: () => AgentEntry[]`）；React 的
//    options.agents 赋值 + rerender() 改 setAgents(...)（createEffect 随 accessor 触发）。
// 3. act 包装移除——Solid 信号写入同步传播；迟到结果续延用宏任务冲刷（flushTask）。
// 4. 显式 afterEach(cleanup())。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { createAgentCandidateProvisioning } from '../useAgentCandidateProvisioning.solid.ts'
import { reportRuntimeError } from '../../../app/runtimeError.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { flushTask } from '../../../test/solidTestHelpers.ts'
import type { AgentRuntimeCandidate } from '../../../domains/agent/agentDetector.ts'
import { appClients } from '../../../app/appClients.ts'
import type { AgentEntry } from '../../../domains/identity/identityStore.ts'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

const candidate: AgentRuntimeCandidate = {
  candidateId: 'detected:hermes', detectorId: 'builtin.detector.hermes', provider: 'hermes',
  suggestedAgentId: 'hermes', name: 'Hermes', executable: 'hermes.exe', args: ['acp'],
  evidence: [], identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [],
}

const HERMES_ENTRY: AgentEntry = { id: 'hermes', name: 'Hermes', transport: 'subprocess', exe: 'hermes.exe', args: ['acp'] }

function mount(agents: AgentEntry[] = []) {
  const [agentsSignal, setAgentsSignal] = createSignal<readonly AgentEntry[]>(agents)
  const options = {
    agentClient: appClients.agent(),
    agents: () => agentsSignal(),
    reportPanelError: reportRuntimeError, resolvePanelError: vi.fn(),
    reportConfigMutationError: vi.fn(), setFeedback: vi.fn(), setConfigConflict: vi.fn(),
    notify: vi.fn(),
  }
  let state: ReturnType<typeof createAgentCandidateProvisioning> | undefined
  const Harness = () => {
    state = createAgentCandidateProvisioning(options)
    return null
  }
  const ui = render(() => <Harness />)
  return {
    get result() {
      if (!state) throw new Error('createAgentCandidateProvisioning has not been captured')
      return state
    },
    options,
    setAgents: setAgentsSignal,
    unmount: ui.unmount,
  }
}

describe('候选验证与导入生命周期', () => {
  beforeEach(() => {
    resetStores()
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'test_agent_candidate') return { ok: true, agentId: 'hermes', durationMs: 10 }
      if (command === 'agent_config_snapshot') return { revision: 'rev-1', agents: [] }
      if (command === 'update_agents_config') return { applied: true, revision: 'rev-2' }
      if (command === 'list_agents') return [{ id: 'hermes', name: 'Hermes', transport: 'subprocess', exe: 'hermes.exe', args: ['acp'] }]
      return null
    })
  })

  afterEach(() => cleanup())

  it('导入只保存配置，使用动作才切换运行时', async () => {
    const h = mount()
    await h.result.validateAndImportCandidate(candidate)
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([command]) => command === 'switch_agent')).toHaveLength(0)
    expect(h.options.notify).toHaveBeenCalledWith(expect.stringContaining('已导入'))
  })

  it('不同提供方的标识冲突提示修改标识，不误报已导入', async () => {
    const h = mount([{ id: 'hermes', name: 'Another', provider: 'peri' }])
    await h.result.validateAndImportCandidate(candidate)
    expect(h.result.candidateErrors()[candidate.candidateId]).toContain('请调整标识')
    expect(h.result.importedCandidateIds()[candidate.candidateId]).toBeUndefined()
    expect(invoke.mock.calls.filter(([command]) => command === 'test_agent_candidate')).toHaveLength(0)
  })

  it('已配置相同提供方时展示可使用状态，不创建重复实例', async () => {
    const h = mount([{ id: 'existing-hermes', name: 'Hermes', provider: 'hermes' }])
    await h.result.validateAndImportCandidate(candidate)
    expect(h.result.importedCandidateIds()[candidate.candidateId]).toBe('existing-hermes')
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(0)
  })

  it('报告没有 imported id 时也可激活当前注册表中同 provider 的 Agent', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((command: string, args?: unknown) => command === 'agent_status'
      ? { agent: 'existing-hermes', agentId: 'existing-hermes', status: 'connected', generation: 1 }
      : original(command, args))
    const h = mount([{ id: 'existing-hermes', name: 'Existing Hermes', provider: 'hermes' }])
    await h.result.activateImportedCandidate(candidate)
    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'existing-hermes' })
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(0)
  })

  it('验证期间编辑草稿，迟到成功不得落盘', async () => {
    let finish: ((value: unknown) => void) | undefined
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((command: string, args?: unknown) => command === 'test_agent_candidate'
      ? new Promise(resolve => { finish = resolve }) : original(command, args))
    const h = mount()
    const operation = h.result.validateAndImportCandidate(candidate)
    await waitFor(() => expect(finish).toBeDefined())
    h.result.updateCandidateDraft(candidate, { executable: 'other.exe' })
    finish?.({ ok: true, agentId: 'hermes', durationMs: 10 })
    await operation
    await flushTask()
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(0)
    expect(h.result.candidateValidation()[candidate.candidateId]).toBeUndefined()
  })

  it('卸载后的成功验证不得继续保存配置', async () => {
    let finish: ((value: unknown) => void) | undefined
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((command: string, args?: unknown) => command === 'test_agent_candidate'
      ? new Promise(resolve => { finish = resolve }) : original(command, args))
    const h = mount()
    const operation = h.result.validateAndImportCandidate(candidate)
    h.unmount()
    finish?.({ ok: true, agentId: 'hermes', durationMs: 10 })
    await operation
    await flushTask()
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(0)
  })

  it('保存失败后重试复用同一草稿的成功握手', async () => {
    const original = invoke.getMockImplementation()!
    let writes = 0
    invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'update_agents_config' && writes++ === 0) throw new Error('disk full')
      return original(command, args)
    })
    const h = mount()
    await h.result.validateAndImportCandidate(candidate)
    await h.result.validateAndImportCandidate(candidate)
    expect(invoke.mock.calls.filter(([command]) => command === 'test_agent_candidate')).toHaveLength(1)
    expect(writes).toBe(2)
  })

  it('取消验证后的迟到成功不会落盘，也不覆盖下一次验证', async () => {
    let finishOld: ((value: unknown) => void) | undefined
    const original = invoke.getMockImplementation()!
    let tests = 0
    invoke.mockImplementation((command: string, args?: unknown) => command === 'test_agent_candidate' && tests++ === 0
      ? new Promise(resolve => { finishOld = resolve }) : original(command, args))
    const h = mount()
    const oldOperation = h.result.validateAndImportCandidate(candidate)
    h.result.cancelCandidateValidation()
    await h.result.validateAndImportCandidate(candidate)
    finishOld?.({ ok: true, agentId: 'hermes', durationMs: 10 })
    await oldOperation
    await flushTask()
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(1)
    expect(h.result.importedCandidateIds()[candidate.candidateId]).toBe('hermes')
  })

  it('写盘成功但列表刷新失败，仍记住已导入，重试不创建第二份配置', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'list_agents') throw new Error('list unavailable')
      return original(command, args)
    })
    const h = mount()
    await h.result.validateAndImportCandidate(candidate)
    expect(h.result.candidateErrors()[candidate.candidateId]).toContain('配置已保存')
    await h.result.validateAndImportCandidate(candidate)
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(1)
  })

  it('配置重载删除已导入 Agent 后可以重新导入', async () => {
    const h = mount()
    await h.result.validateAndImportCandidate(candidate)
    h.setAgents([HERMES_ENTRY])
    // Solid effect 为异步批处理：用 waitFor 等待退休（原 React rerender 后效果同步生效）。
    await waitFor(() => expect(h.result.importedCandidateIds()[candidate.candidateId]).toBe('hermes'))
    h.setAgents([])
    await waitFor(() => expect(h.result.importedCandidateIds()[candidate.candidateId]).toBeUndefined())
    await h.result.validateAndImportCandidate({ ...candidate, alreadyImportedAgentId: 'hermes' })
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(2)
  })
})
