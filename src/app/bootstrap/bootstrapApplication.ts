/**
 * bootstrapApplication — 单一启动事务（报告阶段 2 / FE-AUD-005）。
 *
 * 顺序固定：迁移配置（store.ts persist rehydrate 已完成）→ hydrate domains →
 * 获取 agents → 应用 agents（F13 起为 prune，不重复全量 hydrate）→ 注册全局
 * listener → ready。Agent 列表失败属 degraded：不清空本地工作区，可重试。
 * 纯函数（node 可测）：不直接依赖 Tauri，传输与 store 经 deps 注入。
 */
import type { AgentEntry } from '../../domains/identity/identityStore'
import type { HydrationStatus } from './hydrationState'

function isPluginServiceUnavailable(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'plugin_service_unavailable'
}

export type BootstrapResult = 'ready' | 'degraded' | 'fatal' | 'cancelled'

export interface BootstrapDeps {
  isTauri: boolean
  /** 迁移配置 → hydrate domains（profiles/sessions/workspace）；应幂等。
   * I14-W6：可为 async——bootstrap 等待 identity hydration 完成后才进入
   * agents/listener 阶段（目标行为 #5）。 */
  hydrateDomains: () => void | Promise<void>
  fetchAgents: () => Promise<AgentEntry[]>
  /** 应用 agents 结果（阶段 2 后为 prune 语义，不再全量替换 hydrate） */
  applyAgents: (agents: AgentEntry[]) => void
  /** 读取后端下发的工具归一化字典（agents.yaml `tool_dictionary`）。可选——缺失时保留前端内置 fallback。 */
  fetchToolDictionary?: () => Promise<unknown>
  /** 将工具字典写入 toolRegistry（按 provider 覆盖内置项）。 */
  applyToolDictionary?: (payload: unknown) => void
  /** 冷启动 Agent 状态快照（release-issues #1 方案 A）：list_agents 后查询一次
   * agent_status，补上 listener 注册前的初始状态缺失。可选——失败不降级，
   * 状态灯保持缺失态直到后续事件增量（纯函数便于测试）。 */
  fetchAgentStatus?: () => Promise<unknown>
  /** 应用初始状态快照：写入 runtimeStore.agentStatuses（与事件 listener 同构） */
  applyAgentStatus?: (payload: unknown) => void
  /** 注册全局 controller/listener，返回 dispose handle（阶段 2.8） */
  registerListeners: () => Promise<() => void>
  reportError: (action: string, error: unknown) => void
  /** Optional success seam used to resolve a matching active notification. */
  resolveError?: (action: string) => void
  setStatus: (status: HydrationStatus, error?: string | null) => void
  /** 组件卸载后为 true：不再应用迟到的 agents/listener 结果 */
  cancelled: () => boolean
}

export async function bootstrapApplication(deps: BootstrapDeps): Promise<BootstrapResult> {
  deps.setStatus('loading')
  try {
    await deps.hydrateDomains()
    if (deps.cancelled()) return 'cancelled'
    deps.resolveError?.('恢复本地数据')
  } catch (error) {
    // An unmounted Application must not turn a late rejection from its old
    // bootstrap run into a new notification for the remounted tree.
    if (deps.cancelled()) return 'cancelled'
    deps.reportError('恢复本地数据', error)
    deps.setStatus('degraded', '本地数据恢复失败')
    return 'degraded'
  }

  if (!deps.isTauri) {
    deps.setStatus('ready')
    return 'ready'
  }

  let agents: AgentEntry[]
  try {
    agents = await deps.fetchAgents()
    if (deps.cancelled()) return 'cancelled'
    deps.resolveError?.('读取 Agent 列表')
  } catch (error) {
    if (deps.cancelled()) return 'cancelled'
    // degraded：本地工作区保留，可重试（报告阶段 2.4）
    deps.reportError('读取 Agent 列表', error)
    deps.setStatus('degraded', '读取 Agent 列表失败')
    return 'degraded'
  }
  if (deps.cancelled()) return 'cancelled'
  try {
    deps.applyAgents(agents)
    if (deps.cancelled()) return 'cancelled'
    deps.resolveError?.('应用 Agent 列表')
  } catch (error) {
    if (deps.cancelled()) return 'cancelled'
    deps.reportError('应用 Agent 列表', error)
    deps.setStatus('degraded', isPluginServiceUnavailable(error)
      ? 'Agent 插件服务不可用'
      : '应用 Agent 列表失败')
    return 'degraded'
  }

  // 工具归一化字典：后端下发的字典覆盖前端内置注册项；读取失败不降级
  // （保留前端 builtin fallback，后续 reload 可重试）。
  if (deps.fetchToolDictionary && deps.applyToolDictionary) {
    let dictionary: unknown
    let dictionaryLoaded = false
    try {
      dictionary = await deps.fetchToolDictionary()
      dictionaryLoaded = true
      if (deps.cancelled()) return 'cancelled'
      deps.resolveError?.('读取工具归一化字典')
      if (deps.cancelled()) return 'cancelled'
    } catch (error) {
      if (deps.cancelled()) return 'cancelled'
      deps.reportError('读取工具归一化字典', error)
    }
    if (dictionaryLoaded) {
      try {
        deps.applyToolDictionary(dictionary)
        if (deps.cancelled()) return 'cancelled'
        deps.resolveError?.('应用工具归一化字典')
      } catch (error) {
        if (deps.cancelled()) return 'cancelled'
        deps.reportError('应用工具归一化字典', error)
        deps.setStatus('degraded', isPluginServiceUnavailable(error)
          ? '工具字典插件服务不可用'
          : '应用工具归一化字典失败')
        return 'degraded'
      }
    }
  }

  // 冷启动状态快照（方案 A）：list_agents 之后、listener 注册之前查询一次初始状态。
  // 失败不降级——缺失状态只影响启动首帧的状态灯，后续事件增量会补齐。
  if (deps.fetchAgentStatus && deps.applyAgentStatus) {
    try {
      const payload = await deps.fetchAgentStatus()
      if (deps.cancelled()) return 'cancelled'
      deps.applyAgentStatus(payload)
      if (deps.cancelled()) return 'cancelled'
      deps.resolveError?.('读取 Agent 状态')
    } catch (error) {
      if (deps.cancelled()) return 'cancelled'
      deps.reportError('读取 Agent 状态', error)
    }
  }

  let dispose: () => void
  try {
    dispose = await deps.registerListeners()
    if (deps.cancelled()) {
      dispose()
      return 'cancelled'
    }
    deps.resolveError?.('注册事件监听')
  } catch (error) {
    if (deps.cancelled()) return 'cancelled'
    deps.reportError('注册事件监听', error)
    deps.setStatus('degraded', '注册事件监听失败')
    return 'degraded'
  }
  if (deps.cancelled()) {
    dispose()
    return 'cancelled'
  }
  deps.setStatus('ready')
  return 'ready'
}
