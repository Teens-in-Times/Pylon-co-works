import { appClients } from '../../app/appClients.ts'
import type { SendMessagePayload } from '../../infrastructure/acp/chatClient.ts'
import { useIdentityStore, type Session } from '../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore.ts'
import { buildSendMessagePayload } from '../../domains/chat/sessionRuntime.ts'
import { collectProfilePersona } from '../../plugins/core/sessionCreation/builtinSessionCreation.ts'
import { createWorkbenchSessionCreationStore, type WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.ts'
import { setSessionModel } from '../../domains/chat/sessionModel.ts'
import { setSessionMode } from '../../domains/chat/sessionMode.ts'
import type { InteractionResponseAnswer, InteractionResponseIdentity } from '../../domains/agent/agentContracts.ts'
import type { AgentContext } from '../../domains/agent/agentContext.ts'
import { sendMessageWithStream } from '../../domains/chat/streamingSend.ts'
import { formatRuntimeError, reportRuntimeError } from '../../app/runtimeError.ts'
import type { LocalSessionFact } from './agentWorkbenchProjection.ts'
import { createAgentWorkbenchSession, discardAgentWorkbenchSession } from './agentWorkbenchSessionCreation.ts'

export interface ResolvedWorkbenchInteraction {
  readonly identity: InteractionResponseIdentity
  readonly kind: string
  readonly revision?: number
}

export interface AgentWorkbenchCommandDependencies {
  resolveSession(sessionId: string): Session | undefined
  resolvePersona(session: Session): string
  sendMessage(payload: SendMessagePayload): Promise<unknown>
  /** P52 D4：controller React 状态面已死——乐观 echo 只有 document 侧投影。 */
  optimisticUser(source: string, content: string, clientMessageId: string, options?: { persistCanonical?: boolean }): void
  rejectOptimisticUser(source: string, clientMessageId: string): void
  optimisticDocument(source: string, content: string, clientMessageId: string): void
  /**
   * #380：被拒回滚走 canonical 重读，因此可能是异步的。`send` 会 await 它，好让
   * `send()` 的 promise 落地时「乐观行已撤销」成立（其余调用方可以不管返回值）。
   */
  rejectOptimisticDocument(source: string, clientMessageId: string): void | Promise<void>
  nextClientMessageId(source: string): string
  /** P52 D4：cancel 状态机由 facade 持有（原 controller requestCancel 迁入）。 */
  requestCancel(source: string, agentId: string): void
  setModel(context: AgentContext, modelId: string): Promise<void>
  setMode(context: AgentContext, modeId: string): Promise<void>
  setConfigOption(context: AgentContext, key: string, value: unknown): Promise<void>
  resolveConfigOption(sessionId: string, key: string): { readonly value?: unknown; readonly version?: number } | undefined
  resolveInteraction(sessionId: string, interactionId: string): ResolvedWorkbenchInteraction | undefined
  respondInteraction(request: ResolvedWorkbenchInteraction, answer: InteractionResponseAnswer): Promise<void>
  openResource(session: Session, resource: unknown): Promise<void>
  revealResource(session: Session, resource: unknown): Promise<void>
  createSession(input?: Parameters<WorkbenchCommandFacade['createSession']>[0]): Promise<{ sessionId: string }>
  selectSession(sessionId: string | null): void
  discardSession(sessionId: string): Promise<void>
}

function productionDependencies(): AgentWorkbenchCommandDependencies {
  return {
    resolveSession: sessionId => useIdentityStore.getState().sessions.find(item => item.id === sessionId),
    resolvePersona: session => {
      const profile = useIdentityStore.getState().profiles.find(item => item.id === session.profileId)
      return collectProfilePersona(session.creationSnapshot) || profile?.persona || ''
    },
    sendMessage: payload => sendMessageWithStream(payload),
    optimisticUser: () => {},
    rejectOptimisticUser: () => {},
    optimisticDocument: () => {},
    rejectOptimisticDocument: () => {},
    nextClientMessageId: source => `${source}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    requestCancel: (source, agentId) => {
      // P52 D4：原 controller requestCancel 状态机迁入。begin-cancel 去重
      // （非生成态不调后端）由调用方 generating 守卫承担（footer 只在 running
      // 时渲染 onStop）；后端取消结果的收敛由终帧（pylon:error cancelled）驱动。
      void appClients.chat
        .cancelPrompt({ agentId, source })
        .catch(error => { reportRuntimeError('取消生成', error) })
    },
    setModel: (context, modelId) => setSessionModel(context, modelId),
    setMode: (context, modeId) => setSessionMode(context, modeId),
    setConfigOption: async (context, key, value) => {
      await appClients.chat
        .setConfigOption({ agentId: context.agentId, source: context.source, key, value })
    },
    resolveConfigOption: () => undefined,
    resolveInteraction: () => undefined,
    respondInteraction: (request, answer) => appClients.interactionResponse().respond(request, answer),
    async openResource() { throw new Error('production_command_not_connected') },
    async revealResource() { throw new Error('production_command_not_connected') },
    async createSession() { throw new Error('production_command_not_connected') },
    selectSession() {},
    async discardSession() {},
  }
}

const rejected = (error: string) => ({ ok: false, error })

function commandError(error: unknown): string {
  return formatRuntimeError('工作台命令', error).message
}

function interactionAnswer(value: unknown): InteractionResponseAnswer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const answer: InteractionResponseAnswer = {}
  if (typeof input.optionId === 'string' && input.optionId.trim()) answer.optionId = input.optionId
  if (typeof input.text === 'string') answer.text = input.text
  if (input.values && typeof input.values === 'object' && !Array.isArray(input.values)) {
    const values = Object.fromEntries(Object.entries(input.values as Record<string, unknown>).filter((entry): entry is [string, string | string[]] =>
      typeof entry[1] === 'string' || (Array.isArray(entry[1]) && entry[1].every(item => typeof item === 'string')),
    ))
    if (Object.keys(values).length > 0) answer.values = values
  }
  return answer.optionId !== undefined || answer.text !== undefined || answer.values !== undefined ? answer : undefined
}

export function createAgentWorkbenchCommandFacade(
  overrides: Partial<AgentWorkbenchCommandDependencies> = {},
): WorkbenchCommandFacade {
  const dependencies: AgentWorkbenchCommandDependencies = { ...productionDependencies(), ...overrides }
  const sessionCreation = createWorkbenchSessionCreationStore()
  const send: WorkbenchCommandFacade['send'] = async (sessionId, command) => {
    const session = dependencies.resolveSession(sessionId)
    const content = command.text.trim()
    if (!session) return { status: 'rejected', error: 'session_not_found' }
    if (!content) return { status: 'rejected', error: 'message_empty' }
    // #270：窗口先见——默认 agent 初始连接在后台进行，connecting 期间禁止发送
    //（用户裁定：不做排队、不做自动触发连接）。给出明确提示而非后端错误栈；
    // send_message 对未就绪连接的失败仍是后端兜底，其余状态维持既有行为。
    const agentStatus = useRuntimeStore.getState().agentStatuses[session.agentId]
    if (agentStatus?.status === 'connecting') {
      return { status: 'rejected', error: 'Agent 正在连接，请稍候再发送' }
    }
    const clientMessageId = dependencies.nextClientMessageId(session.source)
    // Solid renders the Kernel-committed WorkbenchDocument, not the legacy chat
    // runtime. Persisting this temporary echo would race the Kernel user row and
    // create a second durable user event; keep it runtime-local on this path.
    dependencies.optimisticDocument(session.source, content, clientMessageId)
    dependencies.optimisticUser(session.source, content, clientMessageId, { persistCanonical: false })
    try {
      await dependencies.sendMessage(buildSendMessagePayload({
        session, content, persona: dependencies.resolvePersona(session),
        attachments: command.attachments?.map(item => item.path) ?? [],
      }))
      return { status: 'sent', messageId: clientMessageId }
    } catch (error) {
      dependencies.rejectOptimisticUser(session.source, clientMessageId)
      // #380：回滚要等 canonical 重读落地——这样 `send()` 返回 rejected 时文档里已经
      // 没有那条乐观行（修前是同步整页重折，同样是「返回时已撤销」的时序）。
      await dependencies.rejectOptimisticDocument(session.source, clientMessageId)
      return { status: 'rejected', messageId: clientMessageId, error: commandError(error) }
    }
  }
  return {
    sessionCreation,
    prompt: send, send,
    async cancel(sessionId) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return { status: 'rejected', error: 'session_not_found' }
      dependencies.requestCancel(session.source, session.agentId)
      return { status: 'cancelled' }
    },
    async attach() { return [] },
    async setModel(sessionId, modelId) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return rejected('session_not_found')
      if (!modelId.trim()) return rejected('model_empty')
      try { await dependencies.setModel({ agentId: session.agentId, source: session.source }, modelId); return { ok: true } }
      catch (error) { return rejected(commandError(error)) }
    },
    async setMode(sessionId, modeId) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return rejected('session_not_found')
      if (!modeId.trim()) return rejected('mode_empty')
      try { await dependencies.setMode({ agentId: session.agentId, source: session.source }, modeId); return { ok: true } }
      catch (error) { return rejected(commandError(error)) }
    },
    async setConfigOption(sessionId, key, value, options) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return rejected('session_not_found')
      if (!key.trim()) return rejected('config_key_empty')
      if (typeof value !== 'string' && typeof value !== 'boolean') return rejected('config_value_unsupported')
      const current = dependencies.resolveConfigOption(sessionId, key)
      if (options && !current) return rejected('config_option_not_found')
      if (options && 'expectedValue' in options && !sameConfigValue(options.expectedValue, current?.value)) return rejected('config_value_stale')
      if (options?.expectedVersion !== undefined && options.expectedVersion !== current?.version) return rejected('config_version_stale')
      try {
        await dependencies.setConfigOption({ agentId: session.agentId, source: session.source }, key, value)
        return { ok: true }
      } catch (error) { return rejected(commandError(error)) }
    },
    async createSession(input) {
      const attempt = sessionCreation.begin()
      try {
        const created = await dependencies.createSession(input)
        if (!created.sessionId) throw new Error('会话创建未返回有效标识')

        // Selecting the local session is the end of the empty-state creation
        // phase.  Do this before starting the potentially long first prompt so
        // the renderer can switch to the normal chat surface immediately.
        dependencies.selectSession(created.sessionId)
        sessionCreation.markSessionSelected(attempt, created.sessionId)
        if (input?.initialPrompt) {
          sessionCreation.markPromptRunning(attempt, created.sessionId)
          // The first prompt owns the ordinary generation footer.  Keep it
          // detached from the creation command's completion promise so a slow
          // provider cannot keep the empty-state progress animation alive.
          const initialPromptOutcome = send(created.sessionId, input.initialPrompt)
          void initialPromptOutcome.then(result => {
            if (result.status === 'rejected') {
              sessionCreation.markFailed(attempt, result.error || '首条请求发送失败', created.sessionId)
              return
            }
            sessionCreation.markPromptTerminal(attempt, created.sessionId)
          }, error => {
            sessionCreation.markFailed(attempt, commandError(error), created.sessionId)
          })
          return { ...created, initialPromptOutcome }
        } else {
          sessionCreation.markPromptTerminal(attempt, created.sessionId)
        }
        return created
      } catch (error) {
        sessionCreation.markFailed(attempt, commandError(error), null)
        throw error
      }
    },
    async compact() { return rejected('production_command_not_connected') },
    async exportSession() { return rejected('production_command_not_connected') },
    async clearSession() { return rejected('production_command_not_connected') },
    async toolAction() { return rejected('production_command_not_connected') },
    async respondInteraction(sessionId, interactionId, response, options) {
      if (!dependencies.resolveSession(sessionId)) return rejected('session_not_found')
      const request = dependencies.resolveInteraction(sessionId, interactionId)
      if (!request) return rejected('interaction_not_found')
      if (options?.expectedRevision !== undefined && request.revision !== undefined
        && options.expectedRevision !== request.revision) return rejected('interaction_revision_stale')
      const answer = interactionAnswer(response)
      if (!answer) return rejected('interaction_response_invalid')
      try { await dependencies.respondInteraction(request, answer); return { ok: true } }
      catch (error) { return rejected(commandError(error)) }
    },
    async openResource(sessionId, resource) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return rejected('session_not_found')
      try { await dependencies.openResource(session, resource); return { ok: true } }
      catch (error) { return rejected(commandError(error)) }
    },
    async revealResource(sessionId, resource) {
      const session = dependencies.resolveSession(sessionId)
      if (!session) return rejected('session_not_found')
      try { await dependencies.revealResource(session, resource); return { ok: true } }
      catch (error) { return rejected(commandError(error)) }
    },
    async copy(_sessionId, text) {
      try { await navigator.clipboard.writeText(text); return { ok: true } }
      catch (error) { return rejected(commandError(error)) }
    },
    async retry() { return rejected('production_command_not_connected') },
    async recover() { return rejected('production_command_not_connected') },
  }
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}

/** 会话运行时宿主中命令装配需要的最小结构面（宿主晚绑定——组件体 const 尚在构造）。 */
export interface AgentWorkbenchSessionControlHost {
  applySessionResponse(response: unknown, targetSessionId?: string, options?: { syntheticReason?: string }): void
  runSessionControl(
    context: { agentId: string; source: string },
    fact: LocalSessionFact,
    request: () => Promise<unknown>,
  ): Promise<void>
}

export interface AgentWorkbenchHostCommandSeams {
  /** sheet 绑定的归属 Agent；空回落当前活动 Agent（由本装配读 identity store）。 */
  resolveSheetAgentId(): string | undefined
  /** 会话选中缝（SheetContext 由视图持有）。 */
  selectSession(sessionId: string | null): void
  /** 晚绑定的会话运行时；回调仅在构造完成后被调用，闭包引用无 TDZ 问题。 */
  runtime(): AgentWorkbenchSessionControlHost
  /**
   * 视图层资源导航（file sheet 打开/揭示；返回 false = 未受理）。application 禁
   * import 视图层（check-layer-boundaries），故由视图注入而非直接依赖。
   */
  openResourceInFileSheet(sessionId: string, resource: unknown): boolean
}

/**
 * #520 S3-P1：AgentRendererSuiteWorkbench 组件体内联的 IPC 命令装配（逐条
 * appClients.chat.* + 会话事务 + 资源导航分流）收拢到 application 层；视图只提供
 * 视图域缝（sheet Agent / 会话选中 / file-sheet 导航）并消费装配产物。
 */
export function createAgentWorkbenchHostCommands(seams: AgentWorkbenchHostCommandSeams): Partial<AgentWorkbenchCommandDependencies> {
  return {
    createSession: request => {
      return createAgentWorkbenchSession(request, {
        agentId: seams.resolveSheetAgentId() || useIdentityStore.getState().activeAgent,
        applySessionResponse: (sessionId, response) => seams.runtime().applySessionResponse(response, sessionId),
      })
    },
    selectSession: id => seams.selectSession(id),
    setModel: async (context, modelId) => {
      await seams.runtime().runSessionControl(context, { kind: 'model', model: modelId },
        () => appClients.chat.setConfigOption({ ...context, key: 'model', value: modelId }))
    },
    setMode: async (context, modeId) => {
      await seams.runtime().runSessionControl(context, { kind: 'mode', mode: modeId },
        () => appClients.chat.setMode({ ...context, mode: modeId }))
    },
    setConfigOption: async (context, key, value) => {
      if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error('config_value_unsupported')
      await seams.runtime().runSessionControl(context, { kind: 'option', id: key, value },
        () => appClients.chat.setConfigOption({ ...context, key, value }))
    },
    discardSession: discardAgentWorkbenchSession,
    async openResource(session, resource) {
      if (seams.openResourceInFileSheet(session.id, resource)) return
      const uri = resource && typeof resource === 'object' && !Array.isArray(resource) && 'uri' in resource
        ? (resource as { uri?: unknown }).uri
        : undefined
      if (typeof uri === 'string' && /^(?:https?:|mailto:)/i.test(uri)) {
        window.open(uri, '_blank', 'noopener,noreferrer')
        return
      }
      throw new Error('resource_not_openable')
    },
    async revealResource(session, resource) {
      if (!seams.openResourceInFileSheet(session.id, resource)) throw new Error('resource_not_revealable')
    },
  }
}
