import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore, type Session } from '../domains/identity/identityStore.ts'
import { errorCode as wireErrorCode } from '../infrastructure/tauri/errorPayload.ts'
import { useRuntimeStore } from '../domains/runtime/runtimeStore.ts'
import {
  createAgentClient,
  type AgentCreateConfig,
  type AgentsConfigDocument,
} from '../infrastructure/acp/agentClient.ts'
import { createChatClient } from '../infrastructure/acp/chatClient.ts'
import { createSessionClient } from '../infrastructure/acp/sessionClient.ts'
import { builtinAgentCatalog } from '../domains/agent/agentCatalog.ts'
import {
  selectAcpRuntimeDetectorIds,
  type AgentRuntimeCandidate,
  type AgentRuntimeDetectorMetadata,
} from '../domains/agent/agentDetector.ts'
import { getHookRuntime, getPluginServiceRegistry } from '../plugin-runtime/runtimeServices.ts'
import { enabledHookIds, runSessionNotificationHook, runUserMessageBeforeHook, runSessionBoundaryHook } from '../application/transactions/sessionHookTransactions.ts'
import { buildSendMessagePayload } from '../domains/chat/sessionRuntime.ts'
import { stripHiddenUnicode } from '../utils/unicodeSanitizer.ts'
import type { AgentControlPort, ApprovalControlPort, ApprovalModeSnapshot, InteractionControlPort, InteractionItem, SessionConfigControlPort, SessionControlPort, WireInteractionEntry, WorkspaceRegistryControlPort } from './pylonCliService.ts'
import { normalizeWireInteractionEntry } from './pylonCliService.ts'
import { requestNewSession } from '../application/transactions/requestNewSession.ts'
import { collectProfilePersona } from '../plugins/core/sessionCreation/builtinSessionCreation.ts'
import { provisionAgentTransaction } from '../application/transactions/provisionAgentTransaction.ts'

const transport = { invoke: (command: string, args?: unknown) => invoke(command, args as Record<string, unknown> | undefined) }
const agentClient = createAgentClient(transport)
const chatClient = createChatClient(transport)
const sessionClient = createSessionClient(transport)

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function candidateConfig(candidate: AgentRuntimeCandidate, makeDefault: boolean): AgentCreateConfig {
  return {
    name: candidate.name,
    provider: candidate.provider,
    transport: 'subprocess',
    exe: candidate.executable,
    args: [...candidate.args],
    default: makeDefault,
  }
}

function agentsDocument(agentId: string, config: AgentCreateConfig): AgentsConfigDocument {
  return { agents: { [agentId]: config } }
}

function uniqueAgentId(base: string, existing: readonly { id: string }[]): string {
  let id = base
  let suffix = 2
  while (existing.some(agent => agent.id === id)) id = `${base}-${suffix++}`
  return id
}

async function detectedCandidates(): Promise<AgentRuntimeCandidate[]> {
  const registered = getPluginServiceRegistry().list<AgentRuntimeDetectorMetadata>('agent-detector')
  const detectors = registered.length > 0 ? registered : builtinAgentCatalog.detectors()
  return agentClient.detectAgentRuntimes(selectAcpRuntimeDetectorIds(detectors)).then(report => report.candidates)
}

function resolveSession(sessionId: string): Session | undefined {
  return useIdentityStore.getState().sessions.find(session => session.id === sessionId || session.source === sessionId)
}

function responseSessionId(response: unknown): string | undefined {
  if (typeof response === 'string' && response.trim()) return response
  if (!response || typeof response !== 'object') return undefined
  const value = response as { sessionId?: unknown, periId?: unknown }
  if (typeof value.sessionId === 'string' && value.sessionId.trim()) return value.sessionId
  return typeof value.periId === 'string' && value.periId.trim() ? value.periId : undefined
}

export function createCliAgentControlPort(): AgentControlPort {
  return {
    async list() {
      const [agents, candidates] = await Promise.all([agentClient.listAgents(), detectedCandidates()])
      useIdentityStore.getState().setAgents(agents)
      return { agents, candidates, catalog: builtinAgentCatalog.descriptors() }
    },
    async import(input, { signal }) {
      throwIfAborted(signal)
      const [agents, candidates] = await Promise.all([agentClient.listAgents(), detectedCandidates()])
      throwIfAborted(signal)
      const matches = candidates.filter(candidate => (
        candidate.candidateId === input.candidateId || candidate.suggestedAgentId === input.candidateId
      ))
      if (matches.length === 0) throw new Error(`未找到 Agent 探测候选：${input.candidateId}`)
      if (matches.length > 1) throw new Error(`Agent 候选不唯一，请使用 candidateId：${matches.map(value => value.candidateId).join(', ')}`)
      const candidate = matches[0]
      const requestedId = input.agentId?.trim()
      const agentId = requestedId || uniqueAgentId(candidate.suggestedAgentId, agents)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentId)) throw new Error(`Agent id 必须以字母或数字开头，且仅允许字母、数字、点、下划线和连字符：${agentId}`)
      if (agents.some(agent => agent.id === agentId)) throw new Error(`Agent id 已存在：${agentId}`)
      const config = candidateConfig(candidate, agents.length === 0)
      const provisioned = await provisionAgentTransaction({
        candidateId: candidate.candidateId,
        agentId,
        name: candidate.name,
        provider: candidate.provider,
        executable: candidate.executable,
        args: [...candidate.args],
      }, {
        validate: async () => {
          throwIfAborted(signal)
          const validation = await agentClient.testAgentCandidate(agentId, {
            name: candidate.name,
            provider: candidate.provider,
            transport: 'subprocess',
            exe: candidate.executable,
            args: candidate.args,
          })
          throwIfAborted(signal)
          return validation
        },
        persist: async () => {
          throwIfAborted(signal)
          try {
            await agentClient.createAgent(agentId, config)
          } catch (error) {
            if (wireErrorCode(error) !== 'config_read_only') throw error
            await agentClient.initializeAgentsConfig(agentId, agentsDocument(agentId, config))
          }
          throwIfAborted(signal)
        },
        refreshAgents: async () => {
          const refreshed = await agentClient.listAgents()
          throwIfAborted(signal)
          return refreshed
        },
        applyAgents: refreshed => useIdentityStore.getState().setAgents(refreshed),
        activate: async () => true,
      }, { activate: false })
      if (provisioned.kind === 'validation-failed') {
        throw new Error(provisioned.validation.error?.message || `Agent 候选验证失败：${candidate.candidateId}`)
      }
      return { agentId, candidateId: candidate.candidateId, validation: provisioned.validation }
    },
    async setDefault(agentId, { signal }) {
      throwIfAborted(signal)
      try {
        await agentClient.updateAgentFieldPatch(agentId, { default: true })
      } catch (error) {
        if (wireErrorCode(error) !== 'config_read_only') throw error
        await agentClient.initializeAgentFieldPatch(agentId, { default: true })
      }
      throwIfAborted(signal)
      const agents = await agentClient.listAgents()
      useIdentityStore.getState().setAgents(agents)
      return { agentId, default: true }
    },
  }
}

export function createCliSessionControlPort(): SessionControlPort {
  return {
    list: () => useIdentityStore.getState().sessions,
    async create(input, { signal }) {
      throwIfAborted(signal)
      const state = useIdentityStore.getState()
      const agentId = input.agentId?.trim() || state.activeAgent
      if (!agentId) throw new Error('agentId 必须是非空字符串')
      const title = input.title?.trim() || `session-${Date.now().toString(36)}`
      const creating = await getHookRuntime().invoke('session.creating', { ...input, agentId, title })
      if (creating.action === 'cancel') throw new Error(creating.reason || 'Session 创建已被插件拦截')
      const effective = creating.event as typeof input & { agentId: string, title: string }
      const effectiveAgentId = typeof effective.agentId === 'string' ? effective.agentId.trim() : ''
      const effectiveTitle = typeof effective.title === 'string' ? effective.title.trim() : ''
      if (!effectiveAgentId || !effectiveTitle) throw new Error('Session hook 返回的 agentId / title 无效')
      throwIfAborted(signal)
      const sessionId = state.addSession(effectiveTitle, effectiveAgentId, {
        ...(effective.cwd ? { workdir: effective.cwd } : {}),
        ...(effective.workspaceId ? { workspaceId: effective.workspaceId } : {}),
      })
      if (!sessionId) throw new Error('Session 创建被本地持久化状态拒绝')
      const session = resolveSession(sessionId)
      if (!session) throw new Error(`Session 本地创建失败：${sessionId}`)
      try {
        throwIfAborted(signal)
        const current = useIdentityStore.getState()
        const profile = current.profiles.find(value => value.id === session.profileId)
        const response = await requestNewSession(session, sessionClient, () => ({
          persona: collectProfilePersona(session.creationSnapshot) || profile?.persona,
          model: profile?.model,
        }), signal)
        throwIfAborted(signal)
        const remoteId = responseSessionId(response)
        if (remoteId) useIdentityStore.getState().setSessionPeriId(session.id, remoteId)
        await runSessionBoundaryHook('session.created', session)
        return { sessionId: session.id, source: session.source, remoteId: remoteId ?? null }
      } catch (error) {
        useIdentityStore.getState().removeSession(session.id)
        throw error
      }
    },
    async send(sessionId, rawContent, { signal }) {
      const session = resolveSession(sessionId)
      if (!session) throw new Error(`Session 不存在：${sessionId}`)
      throwIfAborted(signal)
      const before = await runUserMessageBeforeHook(session, stripHiddenUnicode(rawContent))
      if (before.blocked) throw new Error(before.reason || '消息已被会话钩子拦截')
      throwIfAborted(signal)
      const state = useIdentityStore.getState()
      const profile = state.profiles.find(value => value.id === session.profileId)
      const cancel = () => { void chatClient.cancelPrompt({ agentId: session.agentId, source: session.source }) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const result = await chatClient.sendMessage(buildSendMessagePayload({
          session,
          content: before.content,
          persona: profile?.persona || '',
          attachments: [],
        }))
        throwIfAborted(signal)
        // API 1.3 fail-closed：通知锚点同样只对 opt-in 会话派发（空 hooks 零 invoke）。
        const notifyIds = enabledHookIds(session)
        if (notifyIds) void getHookRuntime().invoke('message.user.sent', { session, content: before.content }, notifyIds)
        return result
      } catch (error) {
        const notifyIds = enabledHookIds(session)
        if (notifyIds) void getHookRuntime().invoke('message.user.sendFailed', { session, content: before.content, error: String(error) }, notifyIds)
        throw error
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
    async close(sessionId, { signal }) {
      const session = resolveSession(sessionId)
      if (!session) return false
      throwIfAborted(signal)
      await runSessionNotificationHook('session.closing', session)
      await sessionClient.closeSession({ agentId: session.agentId, source: session.source })
      throwIfAborted(signal)
      await runSessionBoundaryHook('session.closed', session)
      return true
    },
    async cancel(sessionId) {
      const session = resolveSession(sessionId)
      if (!session) return false
      await chatClient.cancelPrompt({ agentId: session.agentId, source: session.source })
      return true
    },
    async inspect(sessionId) {
      const session = resolveSession(sessionId)
      if (!session) throw new Error(`Session 不存在：${sessionId}`)
      // CLI 增强：实时状态并入——runtimeStore 的 generating/liveStats 是观测维度，
      // 静态元数据不含。ownerKey 供外部进一步调 evt_list。
      const runtime = useRuntimeStore.getState()
      const generating = (runtime.liveGeneratingSources ?? []).includes(session.source)
      return {
        ...session,
        generating,
        liveStats: session.source ? undefined : undefined,
        ownerKey: JSON.stringify([session.profileId, session.agentId, session.source]),
      }
    },
    async messages(sessionId, options) {
      const session = resolveSession(sessionId)
      if (!session) throw new Error(`Session 不存在：${sessionId}`)
      throwIfAborted(options.signal ?? new AbortController().signal)
      const ownerKey = JSON.stringify([session.profileId, session.agentId, session.source])
      // evt_list 升序分页（before_sequence=null 取最新页）。AI 轮询场景：
      // afterSeq 给定 → 取该序列之后的增量；未给定 → 最新 limit 条。
      const page = await invoke('evt_list', {
        ownerKey,
        beforeSequence: null,
        limit: options.limit ?? 100,
      }) as { events: Array<Record<string, unknown>>, nextBeforeSequence: number | null }
      const afterSeq = options.afterSeq
      const events = page.events
        .filter(event => afterSeq === undefined || Number(event.sequence) > afterSeq)
        .map(event => ({
          sequence: Number(event.sequence),
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          receivedAt: event.receivedAt,
          clientGeneration: event.clientGeneration,
          typedPayload: event.typedPayload,
          rawPayload: event.rawPayload,
        }))
      return {
        sessionId,
        ownerKey,
        events,
        lastSequence: events.length > 0 ? Number(events[events.length - 1]!.sequence) : (afterSeq ?? 0),
      }
    },
  }
}

/** CLI 增强：全局审批模式 port（get 此前缺失，外部自动化无法确认模式）。
 *  #463 审查项 3：get/set 均透传后端快照 {mode, persisted}——persisted=false
 *  即落盘降级（重启回退），外部可查。 */
export function createCliApprovalControlPort(): ApprovalControlPort {
  return {
    async get() {
      return invoke<ApprovalModeSnapshot>('get_approval_mode')
    },
    async set(mode) {
      return invoke<ApprovalModeSnapshot>('set_approval_mode', { mode })
    },
  }
}

/** CLI 增强：挂起权限交互 port——list 快照 + respond 应答（桥牌等外部自动化前置）。
 *  #423 快照面单源：后端 `interaction_list` 输出 wire 形状（统一队列 snapshot
 *  投影，与 agent_status 的 pendingInteractions 同源），此处经
 *  `normalizeWireInteractionEntry` 重建 CLI 消费形状（identity + 展示字段 +
 *  应答 options 白名单），对外表面与旧后端两 store 投影逐字段等价（parity
 *  测试钉住）。 */
export function createCliInteractionControlPort(): InteractionControlPort {
  return {
    async list() {
      const wire = await invoke<{ items: WireInteractionEntry[] }>('interaction_list')
      const items = (wire.items ?? [])
        .map(normalizeWireInteractionEntry)
        .filter((item): item is InteractionItem => item !== null)
      return { items }
    },
    async respond(identity, kind, answer) {
      await invoke('respond_interaction', { identity, kind, answer })
    },
  }
}

/** CLI 增强：注册表工作区 CRUD port（workspace_cmds 直通）。 */
export function createCliWorkspaceRegistryControlPort(): WorkspaceRegistryControlPort {
  return {
    async list() {
      return invoke('workspace_list')
    },
    async create({ agentId, name, rootPath }) {
      return invoke('workspace_create', { agentId, name, rootPath })
    },
    async update({ workspaceId, name, rootPath }) {
      return invoke('workspace_update', { workspaceId, name, rootPath })
    },
    async remove(workspaceId) {
      return invoke('workspace_delete', { workspaceId })
    },
    async search(query, maxResults) {
      return invoke('workspace_search', { query, maxResults })
    },
  }
}

/** CLI 增强：会话级 config option + journal 导出 port。 */
export function createCliSessionConfigControlPort(): SessionConfigControlPort {
  return {
    async setOption({ agentId, sessionId, key, value }) {
      return invoke('set_config_option', { agentId, source: sessionId, key, value })
    },
    async exportSession({ agentId, periId, format, outputPath }) {
      await invoke('export_session', { agentId, periId, format, outputPath })
    },
  }
}
