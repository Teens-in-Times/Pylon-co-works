/**
 * identitySessionRecoveryPort — identity 域对「遗留会话 owner 恢复事务」的端口
 * （#520 S1-P0-2：事务本体与提交装配移回应用装配层，域侧经本端口调用）。
 *
 * 断裂 `identitySessionActions → app/bootstrap/resolveUnresolvedSessionTransaction`
 * 的运行时 import（identity 域不得依赖 app/bootstrap）；装配由应用层
 * （`app/bootstrap/identitySessionRecoveryWiring`）注册，其中完成事务校验 + 后端
 * 权威提交 + store 写回。未注册即抛错——不提供静默降级，装配遗漏必须显性失败
 * （跟随 identityCrossDomainPort 约定；恢复动作只由 UI 在装配后触发）。
 */

export interface IdentitySessionRecoveryPort {
  /** 单条 unresolved owner 指定事务：成功 true；校验失败/后端失败 false（现场保留）。 */
  resolveSessionOwner(sessionId: string, agentId: string): Promise<boolean>
}

let port: IdentitySessionRecoveryPort | null = null

export function registerIdentitySessionRecoveryPort(implementation: IdentitySessionRecoveryPort): void {
  port = implementation
}

export function identitySessionRecovery(): IdentitySessionRecoveryPort {
  if (!port) {
    throw new Error('identitySessionRecoveryPort 未注册：应用装配层（identitySessionRecoveryWiring）须先于任何 owner 恢复动作装配')
  }
  return port
}
