/**
 * identitySessionRecoveryWiring — 应用装配层把 identity 会话 owner 恢复端口绑定到
 * 完整事务装配（#520 S1-P0-2：装配自 identitySessionActions 移回应用层，与事务本体
 * resolveUnresolvedSessionTransaction 同层）。逐字随迁原提交装配：读最新现场 → 校验 →
 * Tauri 后端权威 envelope 先行提交（失败保持原状）→ store 写回；错误可见上报。
 * 装配时机与 identityCrossDomainWiring 同链（App 组合根 side-effect import）。
 */
import { reportRuntimeError, resolveRuntimeErrors } from '../runtimeError.ts'
import { resolveUnresolvedSessionTransaction } from './resolveUnresolvedSessionTransaction.ts'
import { registerIdentitySessionRecoveryPort } from '../../domains/identity/identitySessionRecoveryPort.ts'
import { canMutateIdentityDomain, persistFlag, persistMergingUnresolved } from '../../domains/identity/identityPersistence.ts'
import { SESSION_SCHEMA_VERSION } from '../../domains/identity/sessionPersistence.ts'
import { bumpIdentityMutationSeq } from '../../domains/identity/identityStoreShape.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { userDataRepository } from '../../infrastructure/persistence/identityBackendSync.ts'
import type { Session, SessionHydrationState } from '../../domains/identity/identityTypes.ts'

registerIdentitySessionRecoveryPort({
  resolveSessionOwner: async (sessionId, agentId) => {
    const { getState, setState } = useIdentityStore
    if (!canMutateIdentityDomain(getState().identityPersistence, 'sessions')) return false
    const result = await resolveUnresolvedSessionTransaction(sessionId, agentId, {
      getUnresolved: () => {
        const hydration = getState().sessionHydration
        return hydration?.kind === 'needs-owner-resolution' ? hydration.unresolved : []
      },
      getAgents: () => getState().agents,
      commit: async (legacy, owner) => {
        const current = getState()
        const resolved: Session = {
          ...legacy,
          agentId: owner,
          metadata: legacy.metadata ?? {},
          context: legacy.context ?? {},
        }
        const sessions = [...current.sessions, resolved]
        const unresolved = current.sessionHydration?.kind === 'needs-owner-resolution'
          ? current.sessionHydration.unresolved.filter(item => item.id !== legacy.id)
          : []
        const nextHydration: SessionHydrationState = unresolved.length > 0
          ? { kind: 'needs-owner-resolution', unresolved }
          : { kind: 'ready' }
        // Tauri 模式先提交后端权威 envelope；失败直接抛出，store/unresolved 保持原状。
        // browser 模式无 repository，仍由 localStorage 同步提交。
        if (userDataRepository) {
          await userDataRepository.save('sessions', {
            version: SESSION_SCHEMA_VERSION,
            sessions: [...sessions, ...unresolved],
            turns: current.turns,
          })
        }
        const ok = persistMergingUnresolved(sessions, current.turns, nextHydration)
        bumpIdentityMutationSeq()
        setState({ sessions, sessionHydration: nextHydration, sessionsHydrated: true, lastPersistError: persistFlag(ok, current.lastPersistError) })
      },
    })
    if (!result.ok) {
      if (result.kind === 'transport') {
        reportRuntimeError('恢复遗留会话归属', result.cause ?? result.message, undefined, {
          key: `identity:resolve-session:${sessionId}`, scope: { kind: 'session', id: sessionId }, source: 'identity',
        })
      }
      return false
    }
    resolveRuntimeErrors({ key: `identity:resolve-session:${sessionId}` })
    return true
  },
})
