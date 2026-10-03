/**
 * workspaceActiveAgentWiring — 应用装配层把 workspace 的 activeAgent 读端口绑定到
 * identity store（#520 S2-P1-5：workspaceEntityStore 迁域后的跨域断链）。装配时机与
 * identityCrossDomainWiring 同链（App 组合根 side-effect import，先于任何 UI 动作）。
 */
import { useIdentityStore } from '../../domains/identity/identityStore.ts'
import { registerWorkspaceActiveAgentPort } from '../../domains/workspace/workspaceActiveAgentPort.ts'

registerWorkspaceActiveAgentPort({
  getActiveAgent: () => useIdentityStore.getState().activeAgent,
})
