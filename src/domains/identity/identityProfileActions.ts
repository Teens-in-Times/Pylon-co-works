import { loadProfiles, parseProfileEnvelope, persistProfiles, PROFILE_STORAGE_KEY, type PersistedProfile } from './profilePersistence'
import { normalizeSessions } from './sessionPersistence'
import { logError } from '../../contracts/frontendLogSink.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { identityCrossDomain } from '../../app/ports/identityCrossDomainPort'
import {
  canMutateIdentityDomain,
  hasBackend,
  persistFlag,
  persistMergingUnresolved,
  updateIdentityCacheMeta,
} from './identityPersistence.ts'
import { identityBackendSync } from './identityBackendSyncPort.ts'
import { DEFAULT_PROFILES, type SessionHydrationState } from './identityTypes.ts'
import { bumpIdentityMutationSeq, currentIdentityMutationSeq, ownerHintsFromSheetStates, type IdentityStoreAccessor, type IdentityStoreState } from './identityStoreShape.ts'

/**
 * identityProfileActions — Profile 子域动作（B-8a 自 identityStore 拆出，逐字随迁）：
 * 持久化事务 + 后端原子删除/读回 + 三个 hydrate 路径。经 accessor 读写 store，
 * 与 session/agent 动作同装配进 useIdentityStore，消费面 import 面不变。
 */
export function createProfileActions(accessor: IdentityStoreAccessor): Pick<IdentityStoreState,
  'setActiveProfile' | 'addProfile' | 'removeProfile' | 'hydrateProfiles' | 'hydrateProfilesLocal' | 'hydrateFromLocal'
> {
  const { get, set } = accessor
  const syncToBackend = (domains?: Array<'profiles' | 'sessions'>) => accessor.syncToBackend(domains)

  return {
    setActiveProfile: (id) => set(state => {
      if (!canMutateIdentityDomain(state.identityPersistence, 'profiles')) return state
      if (!state.profiles.some(profile => profile.id === id)) return state
      const activeProfileId = id
      // 联动：同步当前 agent 的 sheet 状态并持久化
      identityCrossDomain().patchSheetAgentState(state.activeAgent, { activeProfileId })
      // FE-AUD-002：activeProfileId 落 pylon-profiles
      const ok = persistProfiles(localStorage, { profiles: state.profiles, activeProfileId })
      bumpIdentityMutationSeq()
      queueMicrotask(() => syncToBackend())
      return { activeProfileId, lastPersistError: persistFlag(ok, state.lastPersistError) }
    }),
    addProfile: (p) => {
      const state = get()
      if (!canMutateIdentityDomain(state.identityPersistence, 'profiles')) return ''
      const profiles = [...state.profiles.filter(profile => profile.id !== p.id), p]
      const ok = persistProfiles(localStorage, { profiles, activeProfileId: state.activeProfileId })
      set({ profiles, lastPersistError: persistFlag(ok, state.lastPersistError) })
      bumpIdentityMutationSeq()
      queueMicrotask(() => syncToBackend())
      return p.id
    },
    removeProfile: async (id) => {
      if (!canMutateIdentityDomain(get().identityPersistence, 'profiles', 'sessions')) return
      // I14-W7 CR-03：两路径统一 guard——最后 profile 不可删（browser 与 Tauri 语义一致，
      // 避免空库 + activeProfileId="" + sessions ghost 引用）
      if (get().profiles.length <= 1) return
      // I14-W7：Tauri 模式删除走后端原子事务（fallback/重绑定/activeProfileId 单事务，
      // 见 user_data.rs delete_profile），成功后从后端重读权威状态（内存/localStorage/
      // adapter baseline 同步）；失败可见（reportRuntimeError），状态不变。
      const userDataRepository = identityBackendSync().userDataRepository
      if (userDataRepository) {
        try {
          await userDataRepository.deleteProfile(id)
        } catch (error) {
          reportRuntimeError('删除 Profile（后端事务）', error, undefined, {
            key: `identity:delete-profile:${id}`, scope: { kind: 'app', id: 'identity' }, source: 'identity',
          })
          return
        }
        resolveRuntimeErrors({ key: `identity:delete-profile:${id}` })
        bumpIdentityMutationSeq()
        const [profilesEnv, sessionsEnv] = await Promise.all([
          userDataRepository.load('profiles'),
          userDataRepository.load('sessions'),
        ])
        if (profilesEnv) {
          const parsed = parseProfileEnvelope(JSON.stringify(profilesEnv.payload), DEFAULT_PROFILES)
          persistProfiles(localStorage, { profiles: parsed.profiles, activeProfileId: parsed.activeProfileId })
          set({ profiles: parsed.profiles, activeProfileId: parsed.activeProfileId, lastPersistError: null })
          // I14-W7 CR-03：sheet 状态里的 activeProfileId 同步（引用已删 profile → fallback，
          // 与 browser 路径语义一致）
          const fallback = parsed.activeProfileId
          const agentStates = Object.fromEntries(Object.entries(identityCrossDomain().sheetAgentStates()).map(([agentId, sheetState]) => [
            agentId,
            sheetState.activeProfileId === id ? { ...sheetState, activeProfileId: fallback } : sheetState,
          ]))
          identityCrossDomain().patchSheetAgentStates(agentStates)
        }
        if (sessionsEnv) {
          const hints = ownerHintsFromSheetStates()
          const result = normalizeSessions(sessionsEnv.payload, get().profiles, hints)
          const sessionHydration: SessionHydrationState = result.kind === 'ready'
            ? { kind: 'ready' }
            : result.kind === 'corrupt'
              ? { kind: 'corrupt', message: result.message }
              : { kind: 'needs-owner-resolution', unresolved: result.unresolved }
          const turns = result.kind === 'corrupt' ? [] : result.turns ?? []
          persistMergingUnresolved(result.kind === 'corrupt' ? [] : result.sessions, turns, sessionHydration)
          set({ sessions: result.kind === 'corrupt' ? [] : result.sessions, turns, sessionHydration, sessionsHydrated: true })
        }
        return
      }
      // browser 模式本地路径；Tauri degraded-readonly 已在上方 guard 阻断。
      if (get().sessionHydration?.kind === 'corrupt') return
      set(state => {
        if (!state.profiles.some(profile => profile.id === id) || state.profiles.length <= 1) return state
        const profiles = state.profiles.filter(profile => profile.id !== id)
        const fallbackProfileId = profiles[0].id
        const sessions = state.sessions.map(session => session.profileId === id ? { ...session, profileId: fallbackProfileId } : session)
        const sessionsOk = persistMergingUnresolved(sessions, state.turns, state.sessionHydration)
        // 联动：sheet 状态里的 activeProfileId 同步
        const agentStates = Object.fromEntries(Object.entries(identityCrossDomain().sheetAgentStates()).map(([agentId, sheetState]) => [
          agentId,
          sheetState.activeProfileId === id ? { ...sheetState, activeProfileId: fallbackProfileId } : sheetState,
        ]))
        identityCrossDomain().patchSheetAgentStates(agentStates)
        // FE-AUD-002：删除原子完成 active fallback 并写盘
        const activeProfileId = state.activeProfileId === id ? fallbackProfileId : state.activeProfileId
        const profilesOk = persistProfiles(localStorage, { profiles, activeProfileId })
        bumpIdentityMutationSeq()
        queueMicrotask(() => syncToBackend())
        return {
          profiles,
          sessions,
          activeProfileId,
          lastPersistError: persistFlag(sessionsOk && profilesOk, state.lastPersistError),
        }
      })
    },
    hydrateProfiles: async (legacy) => {
      // I14-W6：Tauri 模式以后端 versioned store 读回为权威源；后端明确无行时才从
      // 本地缓存做 CAS=0 冷启动导入，读取失败则只读降级。seq 守卫：hydrate 期间发生 mutation →
      // 读回丢弃（旧 response 不覆盖新 mutation）。
      const userDataRepository = identityBackendSync().userDataRepository
      if (hasBackend() && userDataRepository) {
        const startSeq = currentIdentityMutationSeq()
        try {
          const envelope = await userDataRepository.load('profiles')
          if (envelope) {
            if (currentIdentityMutationSeq() !== startSeq) {
              set(state => ({ identityPersistence: { ...state.identityPersistence, profiles: 'ready' } }))
              queueMicrotask(() => syncToBackend())
              return
            }
            const parsed = parseProfileEnvelope(JSON.stringify(envelope.payload), DEFAULT_PROFILES)
            persistProfiles(localStorage, { profiles: parsed.profiles, activeProfileId: parsed.activeProfileId })
            updateIdentityCacheMeta('profiles', 'clean', envelope.revision)
            set(state => ({
              profiles: parsed.profiles,
              activeProfileId: parsed.activeProfileId,
              lastPersistError: state.identityPersistence.sessions === 'degraded-readonly' ? state.lastPersistError : null,
              identityPersistence: { ...state.identityPersistence, profiles: 'ready' },
            }))
            return
          }
        } catch (error) {
          logError('从后端读取 Profile 失败，仅以本地缓存只读降级', error)
          get().hydrateProfilesLocal(legacy)
          updateIdentityCacheMeta('profiles', 'stale')
          set(state => ({
            lastPersistError: 'SQLite 用户数据不可用；本地缓存为只读，请重试恢复',
            identityPersistence: { ...state.identityPersistence, profiles: 'degraded-readonly' },
          }))
          throw error
        }
      }
      get().hydrateProfilesLocal(legacy)
      if (hasBackend() && userDataRepository) {
        set(state => ({
          lastPersistError: state.identityPersistence.sessions === 'degraded-readonly' ? state.lastPersistError : null,
          identityPersistence: { ...state.identityPersistence, profiles: 'ready' },
        }))
        updateIdentityCacheMeta('profiles', 'clean', 0)
        syncToBackend(['profiles'])
      }
    },
    hydrateProfilesLocal: (legacy) => {
      // 本地路径（browser / 后端无数据 / 后端失败 / 导入强制本地）：
      const loaded = loadProfiles(localStorage, DEFAULT_PROFILES)
      if (localStorage.getItem(PROFILE_STORAGE_KEY) !== null) {
        set({ profiles: loaded.profiles, activeProfileId: loaded.activeProfileId })
        return
      }
      // 迁移：旧 theme 内嵌 profile 一次性落新 key（无 legacy 时用默认值）
      const source = legacy && legacy.profiles.length > 0
        ? { profiles: legacy.profiles as PersistedProfile[], activeProfileId: legacy.activeProfileId }
        : { profiles: DEFAULT_PROFILES, activeProfileId: DEFAULT_PROFILES[0].id }
      persistProfiles(localStorage, source)
      set({ profiles: source.profiles, activeProfileId: source.activeProfileId })
    },
    hydrateFromLocal: async (legacy) => {
      if (!canMutateIdentityDomain(get().identityPersistence, 'profiles', 'sessions')) {
        reportRuntimeError('导入用户数据', new Error('SQLite 用户数据处于只读降级状态，请先重试恢复'), undefined, {
          key: 'identity:import',
          scope: { kind: 'app', id: 'identity' },
          source: 'identity',
        })
        return
      }
      // I14-W6 CR-01：导入等"本地已写入"场景——强制本地路径读回（读取刚写入的
      // localStorage），再写穿后端（Tauri 权威源同步），避免导入值被后端陈旧读回覆盖。
      // CR-05：递增 mutation-seq——若启动 hydration 的后端读回仍在飞，落地时 seq 已变
      // → 读回被守卫丢弃，不覆盖导入值（与 mutation 守卫同一保护语义）。
      bumpIdentityMutationSeq()
      get().hydrateProfilesLocal(legacy)
      get().hydrateSessionsLocal()
      syncToBackend()
    },
  }
}
