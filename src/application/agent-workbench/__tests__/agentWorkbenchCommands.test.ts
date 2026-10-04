import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore.ts'
import { createAgentWorkbenchCommandFacade } from '../agentWorkbenchCommands.ts'
import type { InteractionResponseIdentity } from '../../../domains/agent/agentContracts.ts'
import { flushTask } from '../../../test/solidTestHelpers.ts'

const session: Session = {
  id: 'session-a', source: 'local:a', agentId: 'peri', profileId: 'profile-a', name: 'A',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: 'session rules',
  skills: [], hooks: [], autoName: '',
}

describe('Agent Workbench production commands', () => {
  it('首条请求仍在流式传输时立即选中新会话并结束创建阶段', async () => {
    let resolveSend!: () => void
    const sendMessage = vi.fn(() => new Promise<void>(resolve => { resolveSend = resolve }))
    const selectSession = vi.fn()
    const commands = createAgentWorkbenchCommandFacade({
      createSession: vi.fn(async () => ({ sessionId: session.id })),
      resolveSession: id => id === session.id ? session : undefined,
      sendMessage,
      selectSession,
    })

    const creating = commands.createSession({ initialPrompt: { text: 'hello' } })
    await Promise.resolve()
    expect(selectSession).toHaveBeenCalledWith(session.id)
    expect(selectSession).toHaveBeenCalledTimes(1)
    const early = await Promise.race([
      creating.then(value => ({ settled: true, value })),
      new Promise<{ settled: false }>(resolve => setTimeout(() => resolve({ settled: false }), 25)),
    ])
    expect(early).toMatchObject({ settled: true, value: { sessionId: session.id } })
    if (!early.settled) throw new Error('createSession did not settle at the session-selected boundary')
    expect(commands.sessionCreation?.getSnapshot()).toMatchObject({
      phase: 'prompt-running', sessionId: session.id,
    })

    resolveSend()
    await flushTask()
    await early.value.initialPromptOutcome
    expect(commands.sessionCreation?.getSnapshot()).toMatchObject({
      phase: 'prompt-terminal', sessionId: session.id,
    })
  })

  it('首条请求失败时保留已选会话并暴露可见失败状态', async () => {
    const discardSession = vi.fn(async () => undefined)
    const selectSession = vi.fn()
    const commands = createAgentWorkbenchCommandFacade({
      createSession: vi.fn(async () => ({ sessionId: session.id })),
      resolveSession: id => id === session.id ? session : undefined,
      sendMessage: vi.fn(async () => { throw new Error('transport failed') }),
      discardSession,
      selectSession,
    })

    const created = await commands.createSession({ initialPrompt: { text: 'hello' } })
    await expect(created.initialPromptOutcome).resolves.toMatchObject({ status: 'rejected', error: 'transport failed' })
    expect(discardSession).not.toHaveBeenCalled()
    expect(selectSession).toHaveBeenNthCalledWith(1, session.id)
    expect(selectSession).toHaveBeenCalledTimes(1)
    expect(commands.sessionCreation?.getSnapshot()).toMatchObject({
      phase: 'creation-failed', sessionId: session.id, error: 'transport failed',
    })
  })

  it('send 以本地 Session 解析 durable owner，并在 ACP 调用前写入 optimistic user', async () => {
    const optimistic = vi.fn()
    const sendMessage = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      resolvePersona: () => 'profile persona',
      sendMessage,
      optimisticUser: optimistic,
      nextClientMessageId: () => 'client-1',
    })

    await expect(commands.send('session-a', {
      text: 'hello',
      attachments: [{ id: 'a', path: 'G:/note.md' }],
    })).resolves.toEqual({ status: 'sent', messageId: 'client-1' })
    expect(optimistic).toHaveBeenCalledWith('local:a', 'hello', 'client-1', { persistCanonical: false })
    expect(sendMessage).toHaveBeenCalledWith({
      agentId: 'peri', profileId: 'profile-a', source: 'local:a', content: 'hello',
      persona: 'profile persona', sessionPrompt: 'profile persona\n\nsession rules', attachments: ['G:/note.md'],
    })
    expect(optimistic.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0])
  })

  it('send 失败时按同一 clientMsgId 对称撤销 user 与 document optimistic rows', async () => {
    const optimisticUser = vi.fn()
    const rejectOptimisticUser = vi.fn()
    const optimisticDocument = vi.fn()
    const rejectOptimisticDocument = vi.fn()
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      sendMessage: vi.fn(async () => { throw new Error('transport failed') }),
      optimisticUser,
      rejectOptimisticUser,
      optimisticDocument,
      rejectOptimisticDocument,
      nextClientMessageId: () => 'client-rejected',
    })

    await expect(commands.send(session.id, { text: '失败后撤销' })).resolves.toEqual({
      status: 'rejected', messageId: 'client-rejected', error: 'transport failed',
    })
    expect(optimisticUser).toHaveBeenCalledWith('local:a', '失败后撤销', 'client-rejected', { persistCanonical: false })
    expect(optimisticDocument).toHaveBeenCalledWith('local:a', '失败后撤销', 'client-rejected')
    expect(rejectOptimisticUser).toHaveBeenCalledWith('local:a', 'client-rejected')
    expect(rejectOptimisticDocument).toHaveBeenCalledWith('local:a', 'client-rejected')
  })

  it('model/mode 命令只通过 Session owner 对应的既有 ACP seam', async () => {
    const setModel = vi.fn(async () => undefined)
    const setMode = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      setModel,
      setMode,
    })

    await expect(commands.setModel(session.id, 'model-a')).resolves.toEqual({ ok: true })
    await expect(commands.setMode(session.id, 'plan')).resolves.toEqual({ ok: true })
    expect(setModel).toHaveBeenCalledWith({ agentId: 'peri', source: 'local:a' }, 'model-a')
    expect(setMode).toHaveBeenCalledWith({ agentId: 'peri', source: 'local:a' }, 'plan')
  })

  it('结构化 ACP reject 不再泄漏为 [object Object]', async () => {
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      setMode: vi.fn(async () => { throw { code: 'config_error', message: 'reasoning option unavailable' } }),
    })

    await expect(commands.setMode(session.id, 'plan')).resolves.toEqual({
      ok: false,
      error: 'reasoning option unavailable',
    })
  })

  it('interaction command 从同一 document 解析完整事务 identity，再走统一 response transport', async () => {
    const identity: InteractionResponseIdentity = {
      provider: 'peri', agentId: 'peri', requestId: 'request-a', sessionId: 'local:a', clientGeneration: 7,
    }
    const respondInteraction = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      resolveInteraction: (sessionId, interactionId) => sessionId === session.id && interactionId === 'interaction-a'
        ? { identity, kind: 'approval' }
        : undefined,
      respondInteraction,
    })

    await expect(commands.respondInteraction(session.id, 'interaction-a', { optionId: 'allow_once' })).resolves.toEqual({ ok: true })
    expect(respondInteraction).toHaveBeenCalledWith({ identity, kind: 'approval' }, { optionId: 'allow_once' })
    await expect(commands.respondInteraction(session.id, 'missing', { optionId: 'allow_once' }))
      .resolves.toEqual({ ok: false, error: 'interaction_not_found' })
  })

  it('在 transport 前拒绝与当前 canonical interaction 不一致的 stale revision', async () => {
    const identity: InteractionResponseIdentity = {
      provider: 'peri', agentId: 'peri', requestId: 'request-a', sessionId: 'local:a', clientGeneration: 7,
    }
    const respondInteraction = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      resolveInteraction: () => ({ identity, kind: 'approval', revision: 12 }),
      respondInteraction,
    })

    await expect(commands.respondInteraction(session.id, 'interaction-a', { optionId: 'allow_once' }, { expectedRevision: 11 }))
      .resolves.toEqual({ ok: false, error: 'interaction_revision_stale' })
    expect(respondInteraction).not.toHaveBeenCalled()
  })

  it('在 config RPC 前拒绝与 canonical option 不一致的 expected value/version', async () => {
    const setConfigOption = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      resolveConfigOption: (_sessionId, key) => key === 'model' ? { value: 'gpt-4', version: 4 } : undefined,
      setConfigOption,
    })
    await expect(commands.setConfigOption(session.id, 'model', 'gpt-5', { expectedValue: 'gpt-3', expectedVersion: 4 }))
      .resolves.toEqual({ ok: false, error: 'config_value_stale' })
    await expect(commands.setConfigOption(session.id, 'model', 'gpt-5', { expectedValue: 'gpt-4', expectedVersion: 3 }))
      .resolves.toEqual({ ok: false, error: 'config_version_stale' })
    expect(setConfigOption).not.toHaveBeenCalled()

    await expect(commands.setConfigOption(session.id, 'model', 'gpt-5', { expectedValue: 'gpt-4', expectedVersion: 4 }))
      .resolves.toEqual({ ok: true })
    expect(setConfigOption).toHaveBeenCalledWith({ agentId: 'peri', source: 'local:a' }, 'model', 'gpt-5')
  })

  it('在 config RPC 前拒绝 ACP 无法表达的 value', async () => {
    const setConfigOption = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      setConfigOption,
    })

    await expect(commands.setConfigOption(session.id, 'temperature', 0.4))
      .resolves.toEqual({ ok: false, error: 'config_value_unsupported' })
    expect(setConfigOption).not.toHaveBeenCalled()
  })

  it('resource commands resolve the bound Session before delegating FileSheet navigation', async () => {
    const openResource = vi.fn(async () => undefined)
    const revealResource = vi.fn(async () => undefined)
    const commands = createAgentWorkbenchCommandFacade({
      resolveSession: id => id === session.id ? session : undefined,
      openResource,
      revealResource,
    })
    const resource = { path: 'src/main.ts', selection: { start: { line: 12 } } }

    await expect(commands.openResource(session.id, resource)).resolves.toEqual({ ok: true })
    await expect(commands.revealResource(session.id, resource)).resolves.toEqual({ ok: true })
    expect(openResource).toHaveBeenCalledWith(session, resource)
    expect(revealResource).toHaveBeenCalledWith(session, resource)
    await expect(commands.openResource('missing', resource)).resolves.toEqual({ ok: false, error: 'session_not_found' })
  })

  it('#270 窗口先见：agent 连接中（connecting）时发送被阻断且不触达后端', async () => {
    const sendMessage = vi.fn(async () => undefined)
    useRuntimeStore.setState({
      agentStatuses: { peri: { agent: 'peri', agentId: 'peri', status: 'connecting' } },
    })
    try {
      const commands = createAgentWorkbenchCommandFacade({
        resolveSession: id => id === session.id ? session : undefined,
        sendMessage,
      })

      await expect(commands.send(session.id, { text: 'hello' }))
        .resolves.toMatchObject({ status: 'rejected', error: 'Agent 正在连接，请稍候再发送' })
      expect(sendMessage).not.toHaveBeenCalled()
    } finally {
      // 门控读的是真实 zustand store——用例后清掉，不污染同文件其它用例。
      useRuntimeStore.setState({ agentStatuses: {} })
    }
  })

  it('#270 窗口先见：connected 状态发送不受门控影响', async () => {
    const sendMessage = vi.fn(async () => undefined)
    useRuntimeStore.setState({
      agentStatuses: { peri: { agent: 'peri', agentId: 'peri', status: 'connected' } },
    })
    try {
      const commands = createAgentWorkbenchCommandFacade({
        resolveSession: id => id === session.id ? session : undefined,
        sendMessage,
      })

      await expect(commands.send(session.id, { text: 'hello' }))
        .resolves.toMatchObject({ status: 'sent' })
      expect(sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      useRuntimeStore.setState({ agentStatuses: {} })
    }
  })
})
