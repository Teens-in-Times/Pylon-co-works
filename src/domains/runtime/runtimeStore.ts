import { createSolidStoreKernel, type SolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'
import type { ConfigOption, ModelChoice } from '../../infrastructure/acp/chatContracts.ts'
import { clearSessionSourceState, updateSessionLiveStats, type SessionLiveStats } from '../chat/sessionRuntime.ts'
import { shouldAcceptAgentStatus, type AgentStatus, type SessionBindingSnapshot } from '../../contracts/agentTypes.ts'
import { permissionReducer, EMPTY_PERMISSION_STATE, type PermissionAction, type PermissionState } from '../permission/permissionState.ts'
import { normalizeApprovalMode, persistApprovalMode, readPersistedApprovalMode, type ApprovalMode } from '../permission/approvalMode.ts'
import type { AgentContext, AgentContextKey } from '../agent/agentContext.ts'
import { toAgentContextKey } from '../agent/agentContext.ts'

// 后端配置选项（来自 new_session 返回 & config_option_update 事件）
export interface SessionConfig {
  model?: string           // 当前 model 值
  models?: string[]        // 可选 model 列表（modelChoices 的 id 投影，兼容既有消费方）
  /** P56/D3：宣告的模型选项（id/label 分离真源；id 为上 wire 的 machine id） */
  modelChoices?: ModelChoice[]
  thinkingEffort?: string
  reasoning?: string[]
  context1m?: boolean
  raw?: ConfigOption[]     // 原始 configOptions（兜底/调试）
}

/**
 * runtimeStore — 运行时状态域。
 *
 * 承载：live 用量/生成源、每会话 live stats/modes/config、Agent 状态。
 * 本 store 不走 persist 信封；唯一持久化例外是 approvalMode 的本地镜像
 * （`pylon-approval-mode` 手写键，store 侧 seed + 写回，见 attachApprovalModePersistence）。
 * 其余 persist 域各自独立：themeStore（pylon-theme）之外另有
 * workspaceStore（pylon-workspace-sheets）、interface-mode、presentation-preferences 等。
 * 跨域联动（会话删除清 runtime 等）由调用方（identityStore 组合 action）经 getState 触发。
 */

// EG：顶层 live* 死镜像清理——用量/模式/命令数据一律走 session 作用域
// （sessionLiveStats/sessionModes/sessionConfig），顶层只保留生成源（InputBar 取消用）
export interface LiveStatsPayload {
  liveGenerating?: string | null
  liveGeneratingSources?: string[]
}

interface RuntimeStoreState {
  liveGenerating: string | null
  liveGeneratingSources: string[]
  /** I01-W2：会话运行时状态一律按 AgentContextKey（agentId+source）隔离——双 Agent 同名 source 不共享 */
  sessionLiveStats: Record<AgentContextKey, SessionLiveStats>
  sessionModes: Record<AgentContextKey, string>
  sessionConfig: Record<AgentContextKey, SessionConfig>
  agentStatuses: Record<string, AgentStatus>
  /**
   * OWNER-04：每会话绑定建立时的 agent generation 快照（load_persisted_session /
   * new_session 成功时由 agentWorkbenchLifecycle 记录）；重连后 agentStatus.generation
   * 递增，新值必须重新记录后发送链路才继续用旧 remote id（§5.9 rule 4）。
   */
  bindingGenerations: Record<string, number | undefined>
  /** Kernel continuity probe 的瞬态健康快照；不持久化、不替代 Session metadata。 */
  sessionBindingHealth: Record<AgentContextKey, SessionBindingSnapshot | undefined>
  /**
   * CWD-03：会话原地 reload 令牌（rootPath 变更 → binding invalidate → close → load/new）。
   * agentWorkbenchLifecycle 以 [sessionId, reloadToken] 为依赖；令牌递增即强制
   * 同会话重跑 load 路径（读取已同步的新 workdir/workspaceId，InputBar 恢复）。
   */
  sessionReloadTokens: Record<string, number>
  /** 权限请求状态（非持久化；P0-02 controller 经 setPermission 驱动纯 reducer） */
  permission: PermissionState
  setPermission: (action: PermissionAction) => void
  /** 全局审批模式（P0-04，set_approval_mode；默认 default；本地镜像持久化见模块尾） */
  approvalMode: ApprovalMode
  setApprovalMode: (mode: string) => void
  setLiveStats: (stats: Partial<LiveStatsPayload>) => void
  setSessionLiveStats: (context: AgentContext, stats: Partial<SessionLiveStats>) => void
  setSessionMode: (context: AgentContext, mode?: string) => void
  setSessionConfig: (context: AgentContext, cfg: Partial<SessionConfig>) => void
  setAgentStatus: (id: string, status: AgentStatus) => void
  /** OWNER-04：记录会话绑定建立时的 agent generation（undefined = 清除记录） */
  setBindingGeneration: (context: AgentContext, generation: number | undefined) => void
  /** CWD-03：递增会话 reload 令牌（rootPath 变更触发同会话原地重载） */
  bumpSessionReload: (context: AgentContext) => void
  /**
   * 会话删除：清该 context 的全部 runtime 状态（identityStore.removeSession 联动调用）。
   * #520 S2-P2：本名即 identityCrossDomain port 契约名（原 `clearSessionRuntime`
   * 纯别名已删，调用点全部对齐本名）。
   */
  clearSessionSource: (context: AgentContext) => void
  /** Agent 切换成功：只清会话运行时状态，保留 agentStatuses 供末尾快照对账。 */
  resetSessionRuntime: () => void
}

// #515 批0：zustand → Solid 内核置换；W3 起 useRuntimeStore 即内核本体（直连，无 shim）。
const runtimeKernel = createSolidStoreKernel<RuntimeStoreState>({
  liveGenerating: null,
  liveGeneratingSources: [],
  sessionLiveStats: {},
  sessionModes: {},
  sessionConfig: {},
  agentStatuses: {},
  bindingGenerations: {},
  sessionBindingHealth: {},
  sessionReloadTokens: {},
  permission: EMPTY_PERMISSION_STATE,
  approvalMode: 'default',

  setPermission: (action) => runtimeKernel.setState(state => ({ permission: permissionReducer(state.permission, action) })),
  setApprovalMode: (mode) => runtimeKernel.setState(state => ({
    approvalMode: normalizeApprovalMode(mode) || state.approvalMode,
  })),
  setLiveStats: (stats) => runtimeKernel.setState(stats as Partial<RuntimeStoreState>),
  setSessionLiveStats: (context, stats) => runtimeKernel.setState(state => ({
    sessionLiveStats: updateSessionLiveStats(state.sessionLiveStats, context, stats),
  })),
  clearSessionSource: (context) => runtimeKernel.setState(state => {
    const cleared = clearSessionSourceState({
      context,
      sessionLiveStats: state.sessionLiveStats,
      sessionModes: state.sessionModes,
      sessionConfig: state.sessionConfig,
      generatingSources: state.liveGeneratingSources,
    })
    // OWNER-04：会话运行时清除时同步丢弃 binding generation 快照（binding 随会话重建）
    const key = toAgentContextKey(context)
    const bindingGenerations = { ...state.bindingGenerations }
    delete bindingGenerations[key]
    const sessionReloadTokens = { ...state.sessionReloadTokens }
    const sessionBindingHealth = { ...state.sessionBindingHealth }
    delete sessionBindingHealth[key]
    delete sessionReloadTokens[key]
    return {
      sessionLiveStats: cleared.sessionLiveStats,
      sessionModes: cleared.sessionModes,
      sessionConfig: cleared.sessionConfig,
      liveGeneratingSources: cleared.generatingSources,
      liveGenerating: cleared.generatingSources[cleared.generatingSources.length - 1] || null,
      bindingGenerations,
      sessionBindingHealth,
      sessionReloadTokens,
    }
  }),
  setSessionMode: (context, mode) => runtimeKernel.setState(state => {
    const sessionModes = { ...state.sessionModes }
    const key = toAgentContextKey(context)
    if (mode) sessionModes[key] = mode
    else delete sessionModes[key]
    return { sessionModes }
  }),
  setSessionConfig: (context, cfg) => runtimeKernel.setState(s => {
    const key = toAgentContextKey(context)
    return { sessionConfig: { ...s.sessionConfig, [key]: { ...s.sessionConfig[key], ...cfg } } }
  }),
  setAgentStatus: (id, status) => runtimeKernel.setState(state => {
    if (!shouldAcceptAgentStatus(state.agentStatuses[id], status)) return state
    if (status.sessionBindings === undefined) {
      return { agentStatuses: { ...state.agentStatuses, [id]: status } }
    }
    const sessionBindingHealth = { ...state.sessionBindingHealth }
    const bindingGenerations = { ...state.bindingGenerations }
    for (const [key, value] of Object.entries(sessionBindingHealth)) {
      if (value?.agentId === id) delete sessionBindingHealth[key as AgentContextKey]
    }
    for (const binding of status.sessionBindings) {
      if (binding.agentId !== id) continue
      const key = toAgentContextKey({ agentId: binding.agentId, source: binding.source })
      sessionBindingHealth[key] = binding
      if (binding.health === 'attached') bindingGenerations[key] = binding.generation
    }
    return {
      agentStatuses: { ...state.agentStatuses, [id]: status },
      sessionBindingHealth,
      bindingGenerations,
    }
  }),
  setBindingGeneration: (context, generation) => runtimeKernel.setState(state => {
    const key = toAgentContextKey(context)
    const bindingGenerations = { ...state.bindingGenerations }
    const sessionBindingHealth = { ...state.sessionBindingHealth }
    if (generation == null) {
      delete bindingGenerations[key]
      delete sessionBindingHealth[key]
    } else {
      bindingGenerations[key] = generation
      sessionBindingHealth[key] = {
        agentId: context.agentId,
        source: context.source,
        health: 'attached',
        generation,
        retryable: false,
      }
    }
    return { bindingGenerations, sessionBindingHealth }
  }),
  bumpSessionReload: (context) => runtimeKernel.setState(state => {
    const key = toAgentContextKey(context)
    return { sessionReloadTokens: { ...state.sessionReloadTokens, [key]: (state.sessionReloadTokens[key] ?? 0) + 1 } }
  }),
  resetSessionRuntime: () => runtimeKernel.setState({
    sessionConfig: {},
    sessionModes: {},
    sessionLiveStats: {},
    bindingGenerations: {},
    sessionBindingHealth: {},
    sessionReloadTokens: {},
    liveGenerating: null,
    liveGeneratingSources: [],
    // P1-1（WI-05 CR-201 吸收）：permission 切片不随运行时重置清空——agent 切换/
    // 设置/会话恢复后旧 agent 的挂起请求停放，切回继续；stale generation 由
    // reducer receive 失效，超时/应答由 controller 与后端保护。
    approvalMode: 'default',
  }),
})

export const useRuntimeStore: SolidStoreKernel<RuntimeStoreState> = runtimeKernel

/**
 * approvalMode 持久化收口（#520 S2-P1：原「App.solid 启动读一次手写键」只覆盖 Tauri
 * 且仅作后端权威事务的种子/降级源，browser 模式重启即丢）。改为 store 侧接管：
 * - **seed**：模块装配期读 `pylon-approval-mode`（旧手写键）恢复一次——Tauri 与
 *   browser 模式都有初始值；Tauri 侧 App.solid 的后端权威恢复事务（#321）异步在后，
 *   仍以后端为权威，本 seed 只消除首帧空档；
 * - **mirror**：订阅写回，值变化才落盘（runtimeStore 写入高频——agent status/live
 *   stats——不做值级守卫会给每次 set 挂一次同步 localStorage 写）。
 * 键名与值格式（裸枚举字符串，非 persist 信封）与旧手写键逐字兼容，存量数据原地可读；
 * 因此不复用 attachSolidPersist（其信封格式会破坏兼容）。storage 注入仅供测试。
 */
export function attachApprovalModePersistence(
  kernel: Pick<SolidStoreKernel<{ approvalMode: ApprovalMode }>, 'getState' | 'setState' | 'subscribe'>,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): void {
  const seeded = readPersistedApprovalMode(storage)
  let mirrored: ApprovalMode | null = seeded
  if (seeded) kernel.setState({ approvalMode: seeded })
  kernel.subscribe(state => {
    if (state.approvalMode === mirrored) return
    mirrored = state.approvalMode
    persistApprovalMode(state.approvalMode, storage)
  })
}

attachApprovalModePersistence(runtimeKernel)
