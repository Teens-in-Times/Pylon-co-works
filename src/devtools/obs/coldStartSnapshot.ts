/**
 * OBS-05：P3 冷启动状态快照取证工具（方案书任务表 OBS-05，§11 完成判据 #6）。
 *
 * 目的：冷启动时采集 workspace envelope / activeSheetId / activeAgent / agent_status /
 * 实际 invoke payload，供 P3（重启后 Sheet 恢复但 Agent 断开或串路由，方案书 §1.4）
 * 现场验证"本次是否实际错发 Agent / Sheet 恢复是否等于 Agent 激活"。
 *
 * 四域快照（任务范围 Sheet/Agent/runtime/IPC）：
 *   workspace（Sheet）：workspaceSheets（activeSheetId + sheets 摘要 + recentlyClosed 数）
 *                       与 sheetAgentStates（每 agent 的 activeProfileId/activeSessionId）
 *   agent           ：identityStore 的 activeAgent / activeProfileId / profiles 摘要 /
 *                      agents / sessions（含 owner.agentId + periId）与 owner 计数
 *   runtime         ：agentStatuses（含 generation，对齐 OBS-02 correlation）/
 *                      liveGenerating / approvalMode / session 作用域状态计数
 *   ipc             ：DEV-only 对 window.__TAURI_INTERNALS__.invoke 的只读包裹记录
 *                     （实际 cmd+args，脱敏后），ring 上限 500
 *
 * P3 判定（摘要 p3Checks）：
 *   - sheetRestoredNotActivated：sheetAgentStates 有 activeSessionId 但对应 agent 状态
 *     非 connected（Sheet 恢复 ≠ Agent 激活的现场信号）
 *   - sessionsOwnedByOtherAgent：owner.agentId != activeAgent 的会话（多 Agent 下记录
 *     不判错；单 Agent 错发风险信号）
 *   - sendMessageIncludesAgentId：结构证据——send_message payload 是否携带 agentId
 *     （chatClient.ts SendMessagePayload）。OWNER-02 起为 true（显式 agentId 路由，
 *     方案书 §5.8）；false 即回归信号（payload 退化为 source-only 的串线风险）。
 *
 * 纪律（方案书 §2 阶段 M0）：只读取证；不修改任何业务语义；隔离生产路径（仅 DEV 钩子
 * 挂载，生产 tree-shake）；脱敏复用 OBS-04 的 sanitizeExportValue（镜像 Rust sanitize.rs
 * Strip 语义）。
 */

import type { Session } from '../../domains/identity/identityStore'
// #520 K 域：SheetRecord 取契约正身（contracts/sheets.ts），不再向视图层
// workspace-sheets/sheetTypes 伸手（sheetTypes 本就是它的再出口）。
import type { SheetRecord } from '../../contracts/sheets'
import type { SheetWorkspaceState } from '../../domains/workspace/sheetPersistence'
import type { AgentStatus } from '../../contracts/agentTypes'
import type { SessionConfig } from '../../domains/runtime/runtimeStore'
import type { SessionLiveStats } from '../../domains/chat/sessionRuntime'
import type { AgentEntry } from '../../domains/identity/identityStore'
import { sanitizeExportValue, redactAbsolutePath } from '../../domains/export/threeSourceExport'

// ============================================================================
// 工件类型（artifact wire 形状）
// ============================================================================

export interface WorkspaceSection {
  activeSheetId: string | null
  sheets: Array<{
    id: string
    kind: string
    title: string
    agentId?: string
    singletonKey?: string
    pinned?: boolean
  }>
  recentlyClosedCount: number
  sheetAgentStates: Record<string, { activeProfileId?: string; activeSessionId?: string }>
}

export interface AgentSection {
  activeAgent: string
  activeProfileId: string
  profiles: Array<{ id: string; name: string; model: string }>
  agents: Array<{ id: string; name: string; provider?: string }>
  sessions: Array<{
    id: string
    agentId: string
    name: string
    source: string
    profileId: string
    periId?: string | null
    createdAt: number
    lastActiveAt: number
  }>
  sessionOwnerCounts: Record<string, number>
}

export interface RuntimeSection {
  agentStatuses: Record<string, {
    agent: string
    status: string
    transport?: string
    cwd?: string
    generation?: number
    lastConnectedAt?: string | number
    recentError?: string
  }>
  liveGenerating: string | null
  liveGeneratingSources: string[]
  approvalMode: string
  sessionScoped: { modes: number; configs: number; liveStats: number }
}

export interface IpcEntry {
  seq: number
  at: number
  cmd: string
  args: unknown
}

export interface IpcSection {
  enabled: boolean
  startAt: number | null
  endAt: number | null
  count: number
  truncated: boolean
  entries: IpcEntry[]
}

export interface P3Checks {
  activeAgent: string
  /** Sheet 恢复但 Agent 未连接：sheetAgentStates 有 activeSessionId 且 agentStatuses 非 connected */
  sheetRestoredNotActivated: string[]
  /** owner.agentId != activeAgent 的会话（多 Agent 下仅记录） */
  sessionsOwnedByOtherAgent: string[]
  /** 结构证据：send_message payload 是否显式携带 agentId（OWNER-02 起必须为 true） */
  sendMessageIncludesAgentId: boolean
  ipcTraceCount: number
}

export interface ColdStartArtifact {
  tool: 'obs05-cold-start-snapshot'
  schemaVersion: 1
  capturedAt: number
  phase: string
  workspace: WorkspaceSection
  agent: AgentSection
  runtime: RuntimeSection
  ipc: IpcSection
  p3Checks: P3Checks
}

// ============================================================================
// IPC 只读 trace（DEV-only，包裹 window.__TAURI_INTERNALS__.invoke）
// ============================================================================

const IPC_TRACE_MAX = 500
export const IPC_TRACE_MAX_EXPORTED = IPC_TRACE_MAX

export interface IpcTrace {
  push(cmd: string, args: unknown): void
  stop(): void
  snapshot(): IpcSection
  enabled: boolean
}

export function createIpcTrace(): IpcTrace {
  let stopped = false
  let seq = 0
  let startAt: number | null = null
  let endAt: number | null = null
  const entries: IpcEntry[] = []
  return {
    get enabled() { return !stopped },
    push(cmd, args) {
      if (stopped) return
      if (startAt === null) startAt = Date.now()
      endAt = Date.now()
      seq += 1
      entries.push({ seq, at: endAt, cmd, args: sanitizeExportValue(args) })
      while (entries.length > IPC_TRACE_MAX) entries.shift()
    },
    stop() {
      stopped = true
    },
    snapshot() {
      return {
        enabled: !stopped,
        startAt,
        endAt,
        count: entries.length,
        truncated: seq > IPC_TRACE_MAX,
        entries: [...entries],
      }
    },
  }
}

/**
 * 只读包裹 Tauri IPC invoke：记录 (cmd, args) 后透传调用原函数。
 * 仅 DEV 构建调用（生产 tree-shake）；浏览器 mock 无 __TAURI_INTERNALS__ 时返回 false。
 * 幂等：重复安装返回 true 不二次包裹。
 */
export function installIpcTraceWrapper(trace: IpcTrace): boolean {
  if (typeof window === 'undefined') return false
  // SAFETY: `__TAURI_INTERNALS__` 由运行时注入，不在 DOM lib 类型内，故按实际形状探测。
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') return false
  /** 幂等标记是本模块自加的私有属性，不属于被包装函数的类型，故并入局部别名。 */
  type WrappedInvoke = ((cmd: string, args?: unknown, options?: unknown) => Promise<unknown>) & { __obs05Wrapped?: boolean }
  const original = internals.invoke as WrappedInvoke
  if (original.__obs05Wrapped) return true
  const wrapped = ((cmd: string, args?: unknown, options?: unknown) => {
    trace.push(cmd, args)
    return original(cmd, args, options)
  }) as WrappedInvoke
  wrapped.__obs05Wrapped = true
  internals.invoke = wrapped
  return true
}

// ============================================================================
// 纯 section 构建（fixture 可测）
// ============================================================================

export function buildWorkspaceSection(sources: {
  sheets: readonly SheetRecord[]
  activeSheetId: string | null
  recentlyClosed: readonly SheetRecord[]
  sheetAgentStates: Record<string, SheetWorkspaceState>
}): WorkspaceSection {
  return {
    activeSheetId: sources.activeSheetId,
    sheets: sources.sheets.map(sheet => ({
      id: sheet.id,
      kind: sheet.kind,
      title: sheet.title,
      ...(sheet.agentId ? { agentId: sheet.agentId } : {}),
      ...(sheet.singletonKey ? { singletonKey: sheet.singletonKey } : {}),
      ...(sheet.pinned !== undefined ? { pinned: sheet.pinned } : {}),
    })),
    recentlyClosedCount: sources.recentlyClosed.length,
    sheetAgentStates: sources.sheetAgentStates,
  }
}

export function buildAgentSection(sources: {
  activeAgent: string
  activeProfileId: string
  profiles: Array<{ id: string; name: string; model: string }>
  agents: readonly AgentEntry[]
  sessions: readonly Session[]
}): AgentSection {
  const ownerCounts: Record<string, number> = {}
  for (const session of sources.sessions) {
    ownerCounts[session.agentId] = (ownerCounts[session.agentId] ?? 0) + 1
  }
  return {
    activeAgent: sources.activeAgent,
    activeProfileId: sources.activeProfileId,
    profiles: sources.profiles.map(profile => ({ id: profile.id, name: profile.name, model: profile.model })),
    agents: sources.agents.map(agent => ({ id: agent.id, name: agent.name, ...(agent.provider ? { provider: agent.provider } : {}) })),
    sessions: sources.sessions.map(session => ({
      id: session.id,
      agentId: session.agentId,
      name: session.name,
      source: session.source,
      profileId: session.profileId,
      ...(session.periId ? { periId: session.periId } : { periId: null }),
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    })),
    sessionOwnerCounts: ownerCounts,
  }
}

export function buildRuntimeSection(sources: {
  agentStatuses: Record<string, AgentStatus>
  liveGenerating: string | null
  liveGeneratingSources: readonly string[]
  approvalMode: string
  sessionModes: Readonly<Record<string, string>>
  sessionConfig: Readonly<Record<string, SessionConfig>>
  sessionLiveStats: Readonly<Record<string, SessionLiveStats>>
}): RuntimeSection {
  const statuses: RuntimeSection['agentStatuses'] = {}
  for (const [agentId, status] of Object.entries(sources.agentStatuses)) {
    statuses[agentId] = {
      agent: status.agent,
      status: status.status,
      ...(status.transport ? { transport: status.transport } : {}),
      ...(status.cwd ? { cwd: redactAbsolutePath(status.cwd) } : {}),
      ...(status.generation !== undefined ? { generation: status.generation } : {}),
      ...(status.lastConnectedAt !== undefined && status.lastConnectedAt !== null ? { lastConnectedAt: status.lastConnectedAt } : {}),
      ...(status.recentError ? { recentError: status.recentError } : {}),
    }
  }
  return {
    agentStatuses: statuses,
    liveGenerating: sources.liveGenerating,
    liveGeneratingSources: [...sources.liveGeneratingSources],
    approvalMode: sources.approvalMode,
    sessionScoped: {
      modes: Object.keys(sources.sessionModes).length,
      configs: Object.keys(sources.sessionConfig).length,
      liveStats: Object.keys(sources.sessionLiveStats).length,
    },
  }
}

export function buildIpcSection(trace: IpcTrace | null | undefined): IpcSection {
  if (!trace) return { enabled: false, startAt: null, endAt: null, count: 0, truncated: false, entries: [] }
  return trace.snapshot()
}

// ============================================================================
// 三源对账式 P3 判定（Sheet 恢复 ≠ Agent 激活）
// ============================================================================

const CONNECTED_STATUSES: ReadonlySet<string> = new Set(['connected'])

export function buildP3Checks(sources: {
  activeAgent: string
  sheetAgentStates: Record<string, SheetWorkspaceState>
  sessions: readonly Session[]
  agentStatuses: Record<string, AgentStatus>
  ipcTraceCount: number
}): P3Checks {
  const sheetRestoredNotActivated: string[] = []
  for (const [agentId, sheetState] of Object.entries(sources.sheetAgentStates)) {
    if (!sheetState.activeSessionId) continue
    const status = sources.agentStatuses[agentId]?.status
    if (!CONNECTED_STATUSES.has(status ?? '')) {
      sheetRestoredNotActivated.push(`${agentId}（activeSessionId=${sheetState.activeSessionId}, status=${status ?? 'unknown'}）`)
    }
  }
  const sessionsOwnedByOtherAgent = sources.sessions
    .filter(session => session.agentId !== sources.activeAgent)
    .map(session => `${session.id}（owner=${session.agentId}, active=${sources.activeAgent}）`)
  return {
    activeAgent: sources.activeAgent,
    sheetRestoredNotActivated,
    sessionsOwnedByOtherAgent,
    // OWNER-02：send_message 显式 agentId 路由（chatClient SendMessagePayload 含 agentId）。
    sendMessageIncludesAgentId: true,
    ipcTraceCount: sources.ipcTraceCount,
  }
}

// ============================================================================
// 工件组装（纯，store 读取由调用方注入）
// ============================================================================

export interface ColdStartSources {
  phase: string
  workspace: {
    sheets: readonly SheetRecord[]
    activeSheetId: string | null
    recentlyClosed: readonly SheetRecord[]
    sheetAgentStates: Record<string, SheetWorkspaceState>
  }
  identity: {
    activeAgent: string
    activeProfileId: string
    profiles: Array<{ id: string; name: string; model: string }>
    agents: readonly AgentEntry[]
    sessions: readonly Session[]
  }
  runtime: {
    agentStatuses: Record<string, AgentStatus>
    liveGenerating: string | null
    liveGeneratingSources: readonly string[]
    approvalMode: string
    sessionModes: Readonly<Record<string, string>>
    sessionConfig: Readonly<Record<string, SessionConfig>>
    sessionLiveStats: Readonly<Record<string, SessionLiveStats>>
  }
  ipcTrace?: IpcTrace | null
}

export function buildColdStartArtifact(sources: ColdStartSources): ColdStartArtifact {
  const workspace = buildWorkspaceSection(sources.workspace)
  const agent = buildAgentSection(sources.identity)
  const runtime = buildRuntimeSection(sources.runtime)
  const ipc = buildIpcSection(sources.ipcTrace)
  const p3Checks = buildP3Checks({
    activeAgent: sources.identity.activeAgent,
    sheetAgentStates: sources.workspace.sheetAgentStates,
    sessions: sources.identity.sessions,
    agentStatuses: sources.runtime.agentStatuses,
    ipcTraceCount: ipc.count,
  })
  // CR-001（玉衡 OBS-05 审查）：脱敏后整体再做绝对路径收窄——sanitizeExportValue 对绝对
  // 路径形态不生效（cwd / ipc.args 内的盘符/UNC/根相对路径会原样进入工件）。
  return narrowPathValues({
    tool: 'obs05-cold-start-snapshot',
    schemaVersion: 1,
    capturedAt: Date.now(),
    phase: sources.phase,
    workspace: sanitizeExportValue(workspace) as WorkspaceSection,
    agent: sanitizeExportValue(agent) as AgentSection,
    runtime: sanitizeExportValue(runtime) as RuntimeSection,
    ipc,
    p3Checks,
  }) as ColdStartArtifact
}

/**
 * 递归绝对路径收窄（CR-001 闭环）：对"绝对路径形态"的字符串值收窄为 `…/目录名`。
 * 与 OBS-04 redactAbsolutePath 判定对齐（盘符/UNC/根相对），但要求 ≥2 个路径段——
 * 避免 '/help'、'/quote' 之类命令形态被误伤（redactAbsolutePath 对单段根路径也会收窄）。
 * 深拷贝纯函数，仅 DEV 取证路径执行。
 */
/** 保形收窄：把“绝对路径形态”的字符串值改写为 `…/目录名`，其余类型原样递归。
 *
 *  类型上严格保形：string→string、array→同长数组、object→同键对象、其余恒等，
 *  故 `T`（而非 `unknown`）才是精确契约——原先的 `unknown` 抹掉了调用方类型。
 *  内部三处 `as T` 即表达该不变性：三个分支都返回与入参同形的值。 */
export function narrowPathValues<T>(value: T): T {
  if (typeof value === 'string') {
    if (!/^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith('/') && !value.startsWith('\\')) return value
    const trimmed = value.replace(/[\\/]+$/, '')
    const segments = trimmed.split(/[\\/]+/).filter(Boolean)
    if (segments.length < 2) return value
    // SAFETY: 改写后的仍是 string，与入参同型（本函数仅用于已解析的 JSON 树，
    // 调用方传的是宽化为 string 的成员，不涉及字符串字面量类型）。
    return `…/${segments[segments.length - 1]}` as T
  }
  if (Array.isArray(value)) {
    // SAFETY: map 逐元素递归，长度与元素类型均不变，仍是同型数组。
    return value.map(narrowPathValues) as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = narrowPathValues(child)
    }
    // SAFETY: 逐键递归、键集不变，仍是同型对象。
    return out as T
  }
  return value
}
