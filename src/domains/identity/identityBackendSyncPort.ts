/**
 * identityBackendSyncPort — identity 域对后端写穿（Tauri SQLite user store）的端口
 * （#520 S1-P0-2 端口化，跟随 #351 identityCrossDomain 端口形态）。
 *
 * 断裂 `identityStore/identity*Actions → infrastructure/persistence/identityBackendSync`
 * 的运行时 import：域侧动作经本端口做写穿/flush/读仓储；具体实现由应用装配层
 * （`app/bootstrap/identityBackendSyncWiring`）以 infra 的 createIdentityBackendSync 注册。
 *
 * 未注册时回落 browser 基线（无后端仓储、写穿 no-op）——与装配后 browser 模式行为
 * 逐字一致（browser 模式装配实现的后端仓储同样为 null）。这里不抛错是有意偏离
 * identityCrossDomainPort 的「未注册即抛」约定：identity 的持久化动作在未装配的
 * 纯单元测试环境必须保持 browser 路径可用（否则全域测试都要补装配面）；生产装配
 * 序由组合根 side-effect import 保证（与 identityCrossDomainWiring 同点、同链加载），
 * Tauri 模式下不存在「先 mutation 后装配」的窗口。
 */
import type { UserDataRepository } from '../../infrastructure/persistence/userDataRepository.ts'

export interface IdentityBackendSyncPort {
  /** 后端仓储（Tauri 模式非 null；browser 模式 null——动作据此走 localStorage 路径）。 */
  readonly userDataRepository: UserDataRepository | null
  /** I14-W5 写穿：把 profiles/sessions 当前状态写透到后端 versioned user store。 */
  syncIdentityToBackend(domains?: Array<'profiles' | 'sessions'>): void
  /** 等待全部写穿链落定（关闭前 flush / 测试收敛）。 */
  flushIdentityBackend(): Promise<void>
  /** 删除会话等外部后端事务完成后，刷新 sessions revision baseline。 */
  refreshSessionsBackend(): Promise<void>
}

/** browser 基线：无后端、全部 no-op（与 browser 模式装配实现行为一致）。 */
const browserBaseline: IdentityBackendSyncPort = {
  userDataRepository: null,
  syncIdentityToBackend: () => {},
  flushIdentityBackend: async () => {},
  refreshSessionsBackend: async () => {},
}

let port: IdentityBackendSyncPort = browserBaseline

export function registerIdentityBackendSyncPort(implementation: IdentityBackendSyncPort): void {
  port = implementation
}

export function identityBackendSync(): IdentityBackendSyncPort {
  return port
}
