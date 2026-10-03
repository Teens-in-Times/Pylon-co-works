/**
 * identityBackendSyncWiring — 应用装配层把 identity 后端写穿端口绑定到 infra 实现
 * （#520 S1-P0-2 端口化）。identityStore 与 identity*Actions 不再 import
 * `infrastructure/persistence/identityBackendSync`；本模块以 store accessor 装配
 * createIdentityBackendSync，并注入域持久化契约（envelope 版本常量 / cache-meta 写入，
 * infra 不再反向 import 域持久化模块的运行时值）。装配时机与 identityCrossDomainWiring
 * 同链：App 组合根 side-effect import，先于任何 identity hydration/mutation。
 */
import { registerIdentityBackendSyncPort } from '../../domains/identity/identityBackendSyncPort.ts'
import { updateIdentityCacheMeta } from '../../domains/identity/identityPersistence.ts'
import { PROFILE_ENVELOPE_VERSION } from '../../domains/identity/profilePersistence.ts'
import { SESSION_SCHEMA_VERSION } from '../../domains/identity/sessionPersistence.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { createIdentityBackendSync } from '../../infrastructure/persistence/identityBackendSync.ts'

registerIdentityBackendSyncPort(createIdentityBackendSync(
  {
    getState: () => useIdentityStore.getState(),
    setState: patch => useIdentityStore.setState(patch),
  },
  {
    profileEnvelopeVersion: PROFILE_ENVELOPE_VERSION,
    sessionSchemaVersion: SESSION_SCHEMA_VERSION,
    updateCacheMeta: updateIdentityCacheMeta,
  },
))
