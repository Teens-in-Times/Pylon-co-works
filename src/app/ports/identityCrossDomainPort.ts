/**
 * identityCrossDomainPort — identity 域对外部域（workspace sheet 状态 / runtime 会话源 /
 * 统一 sessionUi 注册表）的同步联动端口（#351；#520 S2-P1-2 扩 clearSessionUiState）。
 *
 * 断裂 `identityStore → workspaceStore/runtimeStore` 的横向 import：identity 的组合
 * action 在**原调用点**经本端口发同步调用，读写时序逐点不变；具体实现由应用装配层
 * （`app/bootstrap/identityCrossDomainWiring`）注册。未注册即抛错——不提供静默降级，
 * 装配遗漏必须显性失败而不是变成隐性行为变更。测试经 `src/test/resetStores`（或显式
 * import wiring 模块）获得与生产一致的装配。
 */

/** identity 侧只消费这两个字段；实现侧传入的是完整 sheet agent state（结构超集）。 */
export interface IdentitySheetAgentStateView {
  activeSessionId?: string
  activeProfileId?: string
}

export interface IdentityCrossDomainPort {
  /** workspace sheet 各 Agent 状态快照（同步读，一次调用一次快照）。 */
  sheetAgentStates(): Record<string, IdentitySheetAgentStateView>
  patchSheetAgentState(agentId: string, patch: { activeProfileId?: string }): void
  patchSheetAgentStates(states: Record<string, IdentitySheetAgentStateView>): void
  pruneAgentSheets(agentIds: string[]): void
  clearSessionSource(context: { agentId: string; source: string }): void
  /** #520 S2-P1-2：会话删除时回收会话级 UI 注册表条目（统一 sessionUiStore；原
   * identitySessionActions 对 chat/sessionUiState 的域间直连改经本端口）。 */
  clearSessionUiState(sessionId: string): void
}

let port: IdentityCrossDomainPort | null = null

export function registerIdentityCrossDomainPort(implementation: IdentityCrossDomainPort): void {
  port = implementation
}

export function identityCrossDomain(): IdentityCrossDomainPort {
  if (!port) {
    throw new Error('identityCrossDomainPort 未注册：应用装配层（identityCrossDomainWiring）须先于任何 identity mutation 装配')
  }
  return port
}
