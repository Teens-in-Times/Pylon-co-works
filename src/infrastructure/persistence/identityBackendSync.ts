/**
 * identityBackendSync — identity 域的后端（Tauri SQLite user store）同步 boundary
 * （#228 批次D 自 identityStore 切出；#520 S1-P0-2 端口化改造）。
 *
 * 承载：composition root（repository 选择）、I14-W5 mutation 写穿、flush/refresh。
 * 与 store 的关系经 IdentityBackendSyncHost 注入（getState/setState accessor）；
 * 域侧不再 import 本模块——实现经 `domains/identity/identityBackendSyncPort` 由
 * 应用装配层（app/bootstrap/identityBackendSyncWiring）注册进端口。域持久化契约
 * （envelope 版本常量 / cache-meta 写入）以 IdentityBackendSyncContracts 注入，
 * 本模块对 domains/identity 只余 type-only 引用（编译期擦除，无运行时环）。
 */
import { resolveRuntimeErrors, reportRuntimeError } from '../../app/runtimeError.ts'
import { selectUserDataRepository, type UserDataRepository } from './userDataRepository.ts'
import type { IdentityBackendSyncPort } from '../../domains/identity/identityBackendSyncPort.ts'
import type { IdentityPersistenceState, Profile, Session, SessionHydrationState, Turn } from '../../domains/identity/identityTypes.ts'

// ── I14-W5：后端 user store 写穿（Tauri 模式） ──
// composition root 选择：Tauri 走后端 versioned store；browser 模式 null（不经本仓库）。
export const userDataRepository: UserDataRepository | null = selectUserDataRepository()

/** syncIdentityToBackend 读取并写回的 store 状态切片。 */
export interface IdentityBackendSyncSnapshot {
  profiles: Profile[]
  activeProfileId: string
  sessions: Session[]
  turns: Turn[]
  sessionHydration: SessionHydrationState | null
  identityPersistence: IdentityPersistenceState
  lastPersistError: string | null
}

/** 局部写回：partial 对象或（读当前状态的）updater，语义同 zustand setState。 */
export type IdentityBackendSyncPatch =
  | Partial<IdentityBackendSyncSnapshot>
  | ((current: IdentityBackendSyncSnapshot) => Partial<IdentityBackendSyncSnapshot>)

/** store 注入的读写通道（由装配层以 getState/setState accessor 装配）。 */
export interface IdentityBackendSyncHost {
  getState: () => IdentityBackendSyncSnapshot
  setState: (patch: IdentityBackendSyncPatch) => void
}

/** 域侧持久化契约（原 domain import 的运行时值，端口化后经装配注入）。 */
export interface IdentityBackendSyncContracts {
  /** profile envelope wire 版本（domains/identity/profilePersistence PROFILE_ENVELOPE_VERSION）。 */
  profileEnvelopeVersion: number
  /** sessions envelope wire 版本（domains/identity/sessionPersistence SESSION_SCHEMA_VERSION）。 */
  sessionSchemaVersion: number
  /** localStorage cache-meta 写入（domains/identity/identityPersistence updateIdentityCacheMeta）。 */
  updateCacheMeta(domain: 'profiles' | 'sessions', state: 'clean' | 'pending' | 'stale', revision?: number): void
}

/**
 * I14-W5：把当前 identity 状态（profiles/activeProfileId/sessions + unresolved）写穿到
 * 后端 versioned user store。经 host.getState() 读最新状态（调用方在 set() 应用后经
 * queueMicrotask 触发）；browser 模式直接跳过（localStorage 仍是主存储，W6 再接读回）。
 * 后端失败可见上报（reportRuntimeError → ErrorCenter），localStorage 写盘不受影响。
 */
export function createIdentityBackendSync(host: IdentityBackendSyncHost, contracts: IdentityBackendSyncContracts): IdentityBackendSyncPort {
  const { updateCacheMeta } = contracts
  const syncIdentityToBackend = (
    domains: Array<keyof IdentityPersistenceState> = ['profiles', 'sessions'],
  ): void => {
    if (!userDataRepository) return
    const state = host.getState()
    const unresolved = state.sessionHydration?.kind === 'needs-owner-resolution' ? state.sessionHydration.unresolved : []
    const handleError = (domain: 'profiles' | 'sessions', error: unknown): void => {
      updateCacheMeta(domain, 'stale')
      host.setState(current => ({
        lastPersistError: 'SQLite 用户数据同步失败；已切换为只读，请重试恢复',
        identityPersistence: { ...current.identityPersistence, [domain]: 'degraded-readonly' },
      }))
      reportRuntimeError(`同步用户数据到后端失败（${domain}）`, error, undefined, {
        key: `identity:sync:${domain}`, scope: { kind: 'app', id: 'identity' }, source: 'identity.sync',
      })
    }
    if (domains.includes('profiles') && state.identityPersistence.profiles !== 'degraded-readonly') {
      updateCacheMeta('profiles', 'pending')
      void userDataRepository.save('profiles', {
        version: contracts.profileEnvelopeVersion,
        profiles: state.profiles,
        activeProfileId: state.activeProfileId,
      }).then((revision) => {
        updateCacheMeta('profiles', 'clean', revision)
        host.setState(current => ({
          lastPersistError: current.identityPersistence.sessions === 'degraded-readonly' ? current.lastPersistError : null,
          identityPersistence: { ...current.identityPersistence, profiles: 'ready' },
        }))
        resolveRuntimeErrors({ key: 'identity:sync:profiles' })
      }).catch((error) => {
        handleError('profiles', error)
      })
    }
    if (domains.includes('sessions') && state.identityPersistence.sessions !== 'degraded-readonly') {
      updateCacheMeta('sessions', 'pending')
      void userDataRepository.save('sessions', {
        version: contracts.sessionSchemaVersion,
        sessions: [...state.sessions, ...unresolved],
        turns: state.turns,
      }).then((revision) => {
        updateCacheMeta('sessions', 'clean', revision)
        host.setState(current => ({
          lastPersistError: current.identityPersistence.profiles === 'degraded-readonly' ? current.lastPersistError : null,
          identityPersistence: { ...current.identityPersistence, sessions: 'ready' },
        }))
        resolveRuntimeErrors({ key: 'identity:sync:sessions' })
      }).catch((error) => {
        handleError('sessions', error)
      })
    }
  }
  return {
    userDataRepository,
    syncIdentityToBackend,
    /** browser 模式 no-op； hydrateFromLocal 等路径的写穿是 fire-and-forget，调用方需要
     * 确定性落库时显式 flush。 */
    flushIdentityBackend: async () => { await userDataRepository?.flush() },
    refreshSessionsBackend: async () => { await userDataRepository?.load('sessions') },
  }
}
