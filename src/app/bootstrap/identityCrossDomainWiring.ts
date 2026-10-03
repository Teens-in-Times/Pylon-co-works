/**
 * identityCrossDomainWiring — 应用装配层把 identity 联动端口绑定到 workspace/runtime
 * 域 store（#351）。各委托体与断链前的 `identityStore` 直连调用逐字一致；同步性由
 * 端口契约（`app/ports/identityCrossDomainPort`）保持。生产在 App.tsx 以 side-effect
 * import 装配（先于 hydrate 与任何 identity mutation）；测试经 `src/test/resetStores`
 * 获得同一装配。
 *
 * #520 G 域：identity 域其余装配随本入口一并加载（组合根与 resetStores 均经此模块
 * 进入装配链）——后端写穿、owner 恢复事务、workspace activeAgent 注入。
 */
import './identityBackendSyncWiring'
import './identitySessionRecoveryWiring'
import './workspaceActiveAgentWiring'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { sessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import { registerIdentityCrossDomainPort } from '../ports/identityCrossDomainPort'

registerIdentityCrossDomainPort({
  sheetAgentStates: () => useWorkspaceStore.getState().sheetAgentStates,
  patchSheetAgentState: (agentId, patch) => useWorkspaceStore.getState().patchSheetAgentState(agentId, patch),
  patchSheetAgentStates: states => useWorkspaceStore.getState().patchSheetAgentStates(states),
  pruneAgentSheets: agentIds => useWorkspaceStore.getState().pruneAgentSheets(agentIds),
  clearSessionSource: context => useRuntimeStore.getState().clearSessionSource(context),
  // #520 S2-P1-1/2：会话删除清空链纳入端口——统一 sessionUi 注册表（原 chat
  // sessionUiState 的继任者）条目回收，keep-alive workbench 侧的回收见
  // agentWorkbenchSession bind 的删除判定。
  clearSessionUiState: sessionId => sessionUiStore.clear(sessionId),
})
