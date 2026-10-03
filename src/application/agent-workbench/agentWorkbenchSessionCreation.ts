import { appClients } from '../../app/appClients.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore.ts'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore.ts'
import type { SessionCreateInput } from '../../domains/workbench/workbenchCommandFacade.ts'
import { sessionResponseObject } from '../../infrastructure/acp/chatContracts.ts'
import { applySessionStateResponse } from '../../domains/session/sessionStateSync.ts'
import { collectProfilePersona } from '../../plugins/core/sessionCreation/builtinSessionCreation.ts'
import { requestNewSession } from '../../application/transactions/requestNewSession.ts'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'

export interface AgentWorkbenchSessionCreationContext {
  readonly agentId: string
  /**
   * Optional Solid Workbench projection seam.  The host receives the full ACP
   * response before the newly-created Session is selected; implementations may
   * buffer it until their session binding is ready.
   */
  readonly applySessionResponse?: (sessionId: string, response: unknown) => void
}

/** Host-owned creation transaction used by the Solid workbench. */
export async function createAgentWorkbenchSession(
  request: SessionCreateInput | undefined,
  context: AgentWorkbenchSessionCreationContext,
): Promise<{ sessionId: string }> {
  const title = request?.title?.trim() || `session-${Date.now().toString(36)}`
  const workspace = request?.workspaceId
    ? useWorkspaceEntityStore.getState().workspaces.find(item => item.id === request.workspaceId)
    : undefined
  // 旧模型按「当前是否处于工作页签」拦截无工作区的创建（`请先选择工作区`）。左栏已不再
  // 分互斥视图：创建一个不归属任何工作区的会话是合法意图，因此前置校验删除。
  // 「在某个工作区下新建」这条路径由调用方带上 workspaceId，工作区存在性由上面这次查找兜住。

  const creating = await getHookRuntime().invoke('session.creating', {
    agentId: context.agentId,
    title,
    ...(workspace ? { workspaceId: workspace.id, cwd: workspace.rootPath, skills: workspace.skills, mcpServerIds: workspace.mcpServerIds, hookPluginIds: workspace.hookPluginIds } : {}),
  }, workspace?.hookPluginIds)
  if (creating.action === 'cancel') throw new Error(creating.reason || 'Session 创建已被插件拦截')
  const effective = creating.event as { agentId?: unknown; title?: unknown; workspaceSkills?: unknown; workspaceMcpServerIds?: unknown; workspaceHookPluginIds?: unknown; skills?: unknown; mcpServerIds?: unknown; hookPluginIds?: unknown }
  const effectiveAgentId = typeof effective.agentId === 'string' ? effective.agentId.trim() : ''
  const effectiveTitle = typeof effective.title === 'string' ? effective.title.trim() : ''
  if (!effectiveAgentId || !effectiveTitle) throw new Error('Session hook 返回的 agentId / title 无效')

  const identity = useIdentityStore.getState()
  const sessionId = identity.addSession(effectiveTitle, effectiveAgentId, workspace ? {
    workdir: workspace.rootPath,
    workspaceId: workspace.id,
    skills: [...workspace.skills],
    mcpServerIds: [...workspace.mcpServerIds],
    hookPluginIds: [...workspace.hookPluginIds],
  } : undefined)
  if (!sessionId) throw new Error('Session 创建被本地持久化状态拒绝')
  const session = useIdentityStore.getState().sessions.find(item => item.id === sessionId)
  if (!session) throw new Error(`Session 本地创建失败：${sessionId}`)

  try {
    const profile = useIdentityStore.getState().profiles.find(item => item.id === session.profileId)
    const response = await requestNewSession(session, appClients.session(), () => ({
      persona: collectProfilePersona(session.creationSnapshot) || profile?.persona,
      model: request?.model || profile?.model,
      ...(request?.reasoningLevel ? { reasoningLevel: request.reasoningLevel } : {}),
      ...(request?.mode ? { mode: request.mode } : {}),
    }))
    const normalized = sessionResponseObject(response)
    const remoteId = normalized.sessionId ?? normalized.periId
    if (remoteId) useIdentityStore.getState().setSessionPeriId(session.id, remoteId)
    const owner = { agentId: session.agentId, source: session.source }
    applySessionStateResponse(owner, normalized)
    context.applySessionResponse?.(session.id, normalized)
    useRuntimeStore.getState().setBindingGeneration(
      owner,
      useRuntimeStore.getState().agentStatuses[session.agentId]?.generation,
    )
    return { sessionId: session.id }
  } catch (error) {
    useIdentityStore.getState().removeSession(session.id)
    throw error
  }
}

/** Roll back a remotely-created session when its atomic first prompt fails. */
export async function discardAgentWorkbenchSession(sessionId: string): Promise<void> {
  const session = useIdentityStore.getState().sessions.find(item => item.id === sessionId)
  if (!session) return
  try {
    await appClients.session().closeSession({ agentId: session.agentId, source: session.source })
  } catch (error) {
    reportRuntimeError('回滚空态新会话', error)
  } finally {
    useIdentityStore.getState().removeSession(session.id)
  }
}
