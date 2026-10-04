import { CORE_COMMAND_SET_PLUGIN_ID } from '../../contracts/agentCommandSet.ts'
import { loadSessions, normalizeSessions } from './sessionPersistence'
import { logError } from '../../contracts/frontendLogSink.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { identityCrossDomain } from '../../app/ports/identityCrossDomainPort'
import { identitySessionRecovery } from './identitySessionRecoveryPort.ts'
import { identityBackendSync } from './identityBackendSyncPort.ts'
import {
  canMutateIdentityDomain,
  hasBackend,
  persistFlag,
  persistMergingUnresolved,
  updateIdentityCacheMeta,
} from './identityPersistence.ts'
import { mergePluginNamespace } from '../pluginData/pluginNamespace.ts'
import { getSessionCreationRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { compileSessionCreationSnapshot } from '../../plugin-runtime/session-creation/compileSessionCreationSnapshot.ts'
import type { SessionCreationSnapshot } from '../../plugin-runtime/session-creation/sessionCreationTypes.ts'
import type { Session, SessionHydrationState } from './identityTypes.ts'
import { bumpIdentityMutationSeq, currentIdentityMutationSeq, ownerHintsFromSheetStates, type IdentityStoreAccessor, type IdentityStoreState } from './identityStoreShape.ts'

/**
 * identitySessionActions — Session/Turn 子域动作（B-8a 自 identityStore 拆出，逐字随迁）：
 * 创建/分叉/删除/更新、插件数据命名空间写、owner 恢复事务、两个 hydrate 路径。
 */
export function createSessionActions(accessor: IdentityStoreAccessor): Pick<IdentityStoreState,
  'addSession' | 'forkSession' | 'removeSession' | 'updateSession' | 'updateSessionPluginData'
  | 'ensureTurn' | 'updateTurnPluginData' | 'setSessionPeriId' | 'resolveSessionOwner'
  | 'hydrateSessions' | 'hydrateSessionsLocal'
> {
  const { get, set } = accessor
  const syncToBackend = (domains?: Array<'profiles' | 'sessions'>) => accessor.syncToBackend(domains)

  return {
    addSession: (name, agentId, cwd) => {
      if (!canMutateIdentityDomain(get().identityPersistence, 'sessions')) return ''
      if (get().sessionHydration?.kind === 'corrupt') return ''
      const profileId = get().activeProfileId
      // ISSUE-01：归属 Agent 由调用方显式传入，缺省取当前 activeAgent；创建后 owner 不变
      const owner = agentId ?? get().activeAgent
      const now = Date.now()
      const baseId = 's' + now.toString(36)
      let id = baseId
      let suffix = 1
      while (get().sessions.some(session => session.id === id)) {
        id = `${baseId}-${suffix}`
        suffix += 1
      }
      const profile = get().profiles.find(value => value.id === profileId)
        ?? { id: profileId, name: profileId, persona: '', model: '' }
      let creationSnapshot: SessionCreationSnapshot
      try {
        creationSnapshot = compileSessionCreationSnapshot(getSessionCreationRegistry().getSnapshot(), {
          sessionId: id,
          source: `local:${id}`,
          title: name,
          agentId: owner,
          profile: { ...profile },
          platform: 'local',
          workdir: cwd?.workdir ?? '',
          ...(cwd?.workspaceId ? { workspaceId: cwd.workspaceId } : {}),
          ...(cwd?.skills ? { workspaceSkills: [...cwd.skills] } : {}),
          ...(cwd?.mcpServerIds ? { workspaceMcpServerIds: [...cwd.mcpServerIds] } : {}),
          ...(cwd?.hookPluginIds ? { workspaceHookPluginIds: [...cwd.hookPluginIds] } : {}),
        }, now)
      } catch (error) {
        reportRuntimeError('准备会话插件贡献', error, owner, {
          key: `identity:create-session:${id}`,
          scope: { kind: 'operation', id: `session:${id}` },
          source: 'identity.session',
        })
        return ''
      }
      // source = 'local:' + id（唯一）：会话重放/运行时状态按 AgentContextKey（agentId+source）
      // 隔离，source 必须全局唯一——'local:' + name 在同 agent 同名会话（自动命名/跨 profile 同名）
      // 下冲突导致 controller/runtime 状态串会话（复读/串消息，ISSUE-06）。name 独立用于显示。
      const s: Session = {
        id,
        agentId: owner,
        name,
        source: 'local:' + id,
        profileId,
        createdAt: now,
        lastActiveAt: now,
        platform: 'local',
        workdir: cwd?.workdir ?? '',
        ...(cwd?.workspaceId ? { workspaceId: cwd.workspaceId } : {}),
        sessionPrompt: '',
        skills: cwd?.skills ?? [],
        hooks: cwd?.hookPluginIds ?? [],
        commandSetPlugins: [CORE_COMMAND_SET_PLUGIN_ID],
        autoName: '',
        metadata: {},
        context: {},
        creationSnapshot,
      }
      set(state => {
        const sessions = [...state.sessions, s]
        const ok = persistMergingUnresolved(sessions, state.turns, state.sessionHydration)
        bumpIdentityMutationSeq()
        queueMicrotask(() => syncToBackend())
        return { sessions, lastPersistError: persistFlag(ok, state.lastPersistError) }
      })
      resolveRuntimeErrors({ key: `identity:create-session:${id}` })
      return id
    },
    forkSession: (sourceId) => {
      const state = get()
      if (!canMutateIdentityDomain(state.identityPersistence, 'sessions')) return ''
      if (state.sessionHydration?.kind === 'corrupt') return ''
      const original = state.sessions.find(session => session.id === sourceId)
      if (!original) return ''

      const now = Date.now()
      const baseId = 's' + now.toString(36)
      let id = baseId
      let suffix = 1
      while (state.sessions.some(session => session.id === id)) {
        id = `${baseId}-${suffix}`
        suffix += 1
      }
      const name = `${original.name} (分叉)`
      const profile = state.profiles.find(value => value.id === original.profileId)
        ?? { id: original.profileId, name: original.profileId, persona: '', model: '' }
      let creationSnapshot: SessionCreationSnapshot
      try {
        creationSnapshot = compileSessionCreationSnapshot(getSessionCreationRegistry().getSnapshot(), {
          sessionId: id,
          source: `local:${id}`,
          title: name,
          agentId: original.agentId,
          profile: { ...profile },
          platform: 'local',
          workdir: original.workdir,
          ...(original.workspaceId ? { workspaceId: original.workspaceId } : {}),
        }, now)
      } catch (error) {
        reportRuntimeError('准备分叉会话插件贡献', error, original.agentId, {
          key: `identity:fork-session:${id}`,
          scope: { kind: 'operation', id: `session:${id}` },
          source: 'identity.session',
        })
        return ''
      }

      const fork: Session = {
        id,
        agentId: original.agentId,
        name,
        source: `local:${id}`,
        profileId: original.profileId,
        createdAt: now,
        lastActiveAt: now,
        platform: 'local',
        workdir: original.workdir,
        ...(original.workspaceId ? { workspaceId: original.workspaceId } : {}),
        sessionPrompt: original.sessionPrompt,
        skills: [...original.skills],
        hooks: [...original.hooks],
        ...(original.commandSetPlugins ? { commandSetPlugins: [...original.commandSetPlugins] } : {}),
        autoName: '',
        metadata: {},
        context: {},
        creationSnapshot,
      }
      const sessions = [...state.sessions, fork]
      const ok = persistMergingUnresolved(sessions, state.turns, state.sessionHydration)
      set({ sessions, lastPersistError: persistFlag(ok, state.lastPersistError) })
      bumpIdentityMutationSeq()
      queueMicrotask(() => syncToBackend())
      resolveRuntimeErrors({ key: `identity:fork-session:${id}` })
      return id
    },
    removeSession: (id) => set(state => {
      if (!canMutateIdentityDomain(state.identityPersistence, 'sessions')) return state
      if (state.sessionHydration?.kind === 'corrupt') return state
      const removed = state.sessions.find(session => session.id === id)
      const sessions = state.sessions.filter(session => session.id !== id)
      const turns = state.turns.filter(turn => turn.sessionId !== id)
      const sessionsOk = persistMergingUnresolved(sessions, turns, state.sessionHydration)
      if (!removed) return { sessions, turns, lastPersistError: persistFlag(sessionsOk, state.lastPersistError) }
      // 联动：清 runtime（live stats/modes/config/generating）、sheet 状态与会话级 UI 状态
      // I01-W2：按 AgentContext（agentId+source）清理，同名 source 其他 Agent 的会话不受影响
      identityCrossDomain().clearSessionSource({ agentId: removed.agentId, source: removed.source })
      // #520 S2-P1-2：会话级 UI 注册表条目回收经跨域端口（原 chat/sessionUiState 直连已退役）
      identityCrossDomain().clearSessionUiState(id)
      const agentStates = Object.fromEntries(Object.entries(identityCrossDomain().sheetAgentStates()).map(([agentId, sheetState]) => [
        agentId,
        sheetState.activeSessionId === id ? { ...sheetState, activeSessionId: undefined } : sheetState,
      ]))
      identityCrossDomain().patchSheetAgentStates(agentStates)
      bumpIdentityMutationSeq()
      queueMicrotask(() => syncToBackend())
      return { sessions, turns, lastPersistError: persistFlag(sessionsOk, state.lastPersistError) }
    }),
    updateSession: (id, partial) => set(s => {
      if (!canMutateIdentityDomain(s.identityPersistence, 'sessions')) return s
      if (s.sessionHydration?.kind === 'corrupt') return s
      const sessions = s.sessions.map(session => session.id === id ? { ...session, ...partial } : session)
      const ok = persistMergingUnresolved(sessions, s.turns, s.sessionHydration)
      bumpIdentityMutationSeq()
      queueMicrotask(() => syncToBackend())
      return { sessions, lastPersistError: persistFlag(ok, s.lastPersistError) }
    }),
    updateSessionPluginData: (id, pluginId, plane, patch) => {
      const current = get()
      if (!canMutateIdentityDomain(current.identityPersistence, 'sessions')) return false
      const target = current.sessions.find(session => session.id === id)
      if (!target || current.sessionHydration?.kind === 'corrupt') return false
      const merged = mergePluginNamespace(target.metadata ?? {}, target.context ?? {}, plane, pluginId, patch)
      const sessions = current.sessions.map(session => session.id === id ? { ...session, ...merged } : session)
      const ok = persistMergingUnresolved(sessions, current.turns, current.sessionHydration)
      bumpIdentityMutationSeq()
      set({ sessions, lastPersistError: persistFlag(ok, current.lastPersistError) })
      queueMicrotask(() => syncToBackend())
      return true
    },
    ensureTurn: (input) => {
      const current = get()
      if (!canMutateIdentityDomain(current.identityPersistence, 'sessions')) return false
      if (!current.sessions.some(session => session.id === input.sessionId)) return false
      const existing = current.turns.find(turn => turn.id === input.id)
      const turns = existing
        ? current.turns.map(turn => turn.id === input.id ? { ...turn, ...input } : turn)
        : [...current.turns, { ...input, metadata: {}, context: {} }]
      const ok = persistMergingUnresolved(current.sessions, turns, current.sessionHydration)
      bumpIdentityMutationSeq()
      set({ turns, lastPersistError: persistFlag(ok, current.lastPersistError) })
      queueMicrotask(() => syncToBackend())
      return true
    },
    updateTurnPluginData: (id, pluginId, plane, patch) => {
      const current = get()
      if (!canMutateIdentityDomain(current.identityPersistence, 'sessions')) return false
      const target = current.turns.find(turn => turn.id === id)
      if (!target || current.sessionHydration?.kind === 'corrupt') return false
      const merged = mergePluginNamespace(target.metadata, target.context, plane, pluginId, patch)
      const turns = current.turns.map(turn => turn.id === id ? { ...turn, ...merged } : turn)
      const ok = persistMergingUnresolved(current.sessions, turns, current.sessionHydration)
      bumpIdentityMutationSeq()
      set({ turns, lastPersistError: persistFlag(ok, current.lastPersistError) })
      queueMicrotask(() => syncToBackend())
      return true
    },
    setSessionPeriId: (id, periId) => set(s => {
      if (!canMutateIdentityDomain(s.identityPersistence, 'sessions')) return s
      if (s.sessionHydration?.kind === 'corrupt') return s
      const sessions = s.sessions.map(ss => ss.id === id ? { ...ss, periId } : ss)
      const ok = persistMergingUnresolved(sessions, s.turns, s.sessionHydration)
      bumpIdentityMutationSeq()
      queueMicrotask(() => syncToBackend())
      return { sessions, lastPersistError: persistFlag(ok, s.lastPersistError) }
    }),
    resolveSessionOwner: (sessionId, agentId) => {
      // #520 S1-P0-2：owner 恢复事务的校验与提交装配在应用层
      //（app/bootstrap/identitySessionRecoveryWiring），域侧只经端口触发。
      return identitySessionRecovery().resolveSessionOwner(sessionId, agentId)
    },
    hydrateSessions: async () => {
      // I14-W6：Tauri 模式后端读回优先；无行才冷启动导入，失败时缓存只读；seq 守卫防旧读回覆盖 mutation。
      const userDataRepository = identityBackendSync().userDataRepository
      if (hasBackend() && userDataRepository) {
        const startSeq = currentIdentityMutationSeq()
        try {
          const envelope = await userDataRepository.load('sessions')
          if (envelope) {
            if (currentIdentityMutationSeq() !== startSeq) {
              set(state => ({ identityPersistence: { ...state.identityPersistence, sessions: 'ready' } }))
              queueMicrotask(() => syncToBackend())
              return
            }
            const hints = ownerHintsFromSheetStates()
            const result = normalizeSessions(envelope.payload, get().profiles, hints)
            const sessionHydration: SessionHydrationState = result.kind === 'ready'
              ? { kind: 'ready' }
              : result.kind === 'corrupt'
                ? { kind: 'corrupt', message: result.message }
                : { kind: 'needs-owner-resolution', unresolved: result.unresolved }
            // corrupt 结果无 sessions 字段：显式回退空列表，避免写入 undefined
            set(state => ({
              sessions: result.kind === 'corrupt' ? [] : result.sessions,
              turns: result.kind === 'corrupt' ? [] : result.turns ?? [],
              sessionHydration,
              sessionsHydrated: true,
              lastPersistError: state.identityPersistence.profiles === 'degraded-readonly' ? state.lastPersistError : null,
              identityPersistence: { ...state.identityPersistence, sessions: 'ready' },
            }))
            persistMergingUnresolved(
              result.kind === 'corrupt' ? [] : result.sessions,
              result.kind === 'corrupt' ? [] : result.turns ?? [],
              sessionHydration,
            )
            updateIdentityCacheMeta('sessions', 'clean', envelope.revision)
            return
          }
        } catch (error) {
          logError('从后端读取 Sessions 失败，仅以本地缓存只读降级', error)
          get().hydrateSessionsLocal()
          updateIdentityCacheMeta('sessions', 'stale')
          set(state => ({
            lastPersistError: 'SQLite 用户数据不可用；本地缓存为只读，请重试恢复',
            identityPersistence: { ...state.identityPersistence, sessions: 'degraded-readonly' },
          }))
          throw error
        }
      }
      get().hydrateSessionsLocal()
      if (hasBackend() && userDataRepository) {
        set(state => ({
          lastPersistError: state.identityPersistence.profiles === 'degraded-readonly' ? state.lastPersistError : null,
          identityPersistence: { ...state.identityPersistence, sessions: 'ready' },
        }))
        updateIdentityCacheMeta('sessions', 'clean', 0)
        syncToBackend(['sessions'])
      }
    },
    hydrateSessionsLocal: () => {
      // 本地路径（browser / 后端无数据 / 后端失败 / 导入强制本地）：原同步逻辑
      try {
        // ISSUE-01：owner 推断 hint 来自 workspace sheet 状态（唯一 Agent 的 activeSessionId）
        const hints = ownerHintsFromSheetStates()
        const result = loadSessions(localStorage, get().profiles, hints)
        const sessionHydration: SessionHydrationState = result.kind === 'ready'
          ? { kind: 'ready' }
          : result.kind === 'corrupt'
            ? { kind: 'corrupt', message: result.message }
            : { kind: 'needs-owner-resolution', unresolved: result.unresolved }
        // corrupt 结果无 sessions 字段：显式回退空列表，避免写入 undefined
        set({
          sessions: result.kind === 'corrupt' ? [] : result.sessions,
          turns: result.kind === 'corrupt' ? [] : result.turns ?? [],
          sessionHydration,
          sessionsHydrated: true,
        })
      } catch (error) {
        logError('Session 持久化读取失败', error)
        set({ sessions: [], turns: [], sessionHydration: { kind: 'corrupt', message: error instanceof Error ? error.message : '会话数据损坏' }, sessionsHydrated: true })
      }
    },
  }
}
