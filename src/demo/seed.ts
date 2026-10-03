/**
 * seed — 浏览器模式演示数据种入（非纯接线：store + localStorage，App seed effect 调用）。
 *
 * 内部幂等：agents/状态灯/模式不持久化（agents 来自 list_agents 后端，runtime 是瞬态），
 * 每次启动都必须补；sessions/消息缓存/sheets 持久化（hydrateSessions/openSheet 落盘），
 * 仅首次（sessions 为空）种入——否则二次启动 agents 空 → 主页「没有可用 Agent」。
 * 顺序关键：① setAgents 必须先（内部 pruneAgentSheets 清无效 agent sheets）
 * ② sessions 持久化 ③ 每会话消息缓存（ChatView 恢复 + search 快照可查）
 * ④ sheets（agent 先开聚焦）⑤ setActiveSession（SheetLayout 子 effect 先跑，
 * 写回 effect 随其持久化）⑥ 每次补 runtime 状态灯/模式/权限。
 */
import { useIdentityStore } from '../domains/identity/identityStore.ts'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore.ts'
import { useRuntimeStore } from '../domains/runtime/runtimeStore.ts'
import { persistSessions } from '../domains/identity/sessionPersistence.ts'
import { messageStorageKey, persistMessageSnapshot } from '../domains/chat/messagePersistence.ts'
import { buildDemoAgents, buildDemoMessages, buildDemoPermissionRequest, buildDemoSessions } from './demoData.ts'
import { buildVisualQaMessages, buildVisualQaSessions, buildVisualQaWorkspaces } from './visualQaData.ts'
import { createSheetState } from '../domains/workspace/sheetState.ts'
import type { AgentStatus } from '../contracts/agentTypes.ts'
import { useWorkspaceEntityStore } from '../domains/workspace/workspaceEntityStore.ts'
import { serializeWorkspaces, WORKSPACE_STORAGE_KEY } from '../domains/workspace/workspaceEntities.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'

export interface DemoSeedOptions {
  /** ?demo-permission=1 时种一条待审权限请求（弹窗无关闭路径，仅 opt-in 展示） */
  withPermission?: boolean
  /** Dev 浏览器默认使用 visual；standard 保留原 4 会话轻量演示。 */
  scenario?: 'standard' | 'visual'
  /** ?demo-reset=1：只重建浏览器 mock 的会话与 Sheet，不碰主题设置。 */
  reset?: boolean
}

export function seedDemo(setActiveSession: (id: string | null) => void, options: DemoSeedOptions = {}): void {
  const scenario = options.scenario ?? 'standard'
  const identity = useIdentityStore.getState()
  // 每次：agents 非持久化（二次启动 sessions 已持久化、会话种入跳过时仍必须补）
  identity.setAgents(buildDemoAgents())

  if (scenario === 'visual') {
    // 浏览器视觉验收默认锁定任务契约要求的 terminal-like；用户仍可在设置中切换，
    // 但刷新后再次进入视觉场景会回到同一验收基线，避免误验 modern GUI。
    useInterfaceModeStore.getState().setInterfaceMode('terminal-like')
    seedVisualQaDemo(setActiveSession, options)
    return
  }

  // 仅首次（无会话）：种会话/消息缓存/sheets
  if (identity.sessions.length === 0) {
    const sessions = buildDemoSessions()
    useIdentityStore.setState({ sessions, sessionsHydrated: true })
    persistSessions(localStorage, sessions)
    for (const session of sessions) {
      persistMessageSnapshot(session.id, buildDemoMessages(session.id), localStorage)
    }
    const workspace = useWorkspaceStore.getState()
    const agentSheetId = workspace.openSheet({ kind: 'agent', title: 'Peri', agentId: 'peri' })
    // file sheet 绑演示会话 source（singletonKey=file:<source>），打开即见文件树/git/搜索
    workspace.openSheet({ kind: 'file', title: 'File', agentId: 'peri', singletonKey: `file:${sessions[0].source}` })
    workspace.openSheet({ kind: 'gateway', title: 'Gateway' })
    workspace.openSheet({ kind: 'history', title: 'History' })
    workspace.openSheet({ kind: 'runtime', title: 'Runtime' })
    workspace.openSheet({ kind: 'search', title: 'Search' })
    if (agentSheetId) workspace.focusSheet(agentSheetId)
    workspace.setSheetAgentState('peri', { activeProfileId: 'default', activeSessionId: sessions[0].id })
    setActiveSession(sessions[0].id)
  }

  // 每次：runtime 状态灯/模式非持久化
  const runtime = useRuntimeStore.getState()
  const periStatus: AgentStatus = { agent: 'peri', agentId: 'peri', status: 'connected', transport: 'qq', cwd: '/path/to/project', lastConnectedAt: Date.now() }
  const hermesStatus: AgentStatus = { agent: 'hermes', agentId: 'hermes', status: 'error', transport: 'webhook', recentError: '心跳超时，等待重连', cwd: '/path/to/ops' }
  runtime.setAgentStatus('peri', periStatus)
  runtime.setAgentStatus('hermes', hermesStatus)
  const firstSession = identity.sessions[0] ?? buildDemoSessions()[0]
  runtime.setSessionMode({ agentId: firstSession.agentId, source: firstSession.source }, 'auto')
  if (options.withPermission) {
    runtime.setPermission({ type: 'receive', request: buildDemoPermissionRequest(), now: Date.now() })
  }
}

function seedVisualQaDemo(setActiveSession: (id: string | null) => void, options: DemoSeedOptions): void {
  const identity = useIdentityStore.getState()
  const demoSessions = buildDemoSessions()
  const visualSessions = buildVisualQaSessions()
  const ownedIds = new Set([...demoSessions, ...visualSessions].map(session => session.id))
  const preserved = options.reset ? [] : identity.sessions.filter(session => !ownedIds.has(session.id))
  const sessions = [...visualSessions, ...demoSessions, ...preserved]

  useIdentityStore.setState({ sessions, sessionsHydrated: true })
  persistSessions(localStorage, sessions)
  const visualWorkspaces = buildVisualQaWorkspaces()
  localStorage.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspaces(visualWorkspaces))
  useWorkspaceEntityStore.setState({ workspaces: visualWorkspaces, hydrated: true })
  const visualSessionIds = new Set(visualSessions.map(session => session.id))
  for (const session of [...visualSessions, ...demoSessions]) {
    // Visual QA is a deterministic fixture, not user-owned history. Always
    // refresh it so a stale/empty snapshot left by an earlier build cannot
    // mask the current mock dataset (the exact failure seen in Edge).
    // Standard demo sessions remain user-persistent unless an explicit reset
    // was requested.
    if (!options.reset && !visualSessionIds.has(session.id)
      && localStorage.getItem(messageStorageKey(session.id))) continue
    const messages = session.id.startsWith('demo-visual')
      || visualSessions.some(candidate => candidate.id === session.id)
      ? buildVisualQaMessages(session.id)
      : buildDemoMessages(session.id)
    persistMessageSnapshot(session.id, messages, localStorage)
  }

  if (options.reset) {
    useWorkspaceStore.setState({
      workspaceSheets: createSheetState(),
      sheetAgentStates: {},
      touchedFiles: {},
      touchVersions: {},
    })
  }

  const agentSheets = buildDemoAgents().map(agent => ({
    agent,
    sheetId: useWorkspaceStore.getState().openSheet({ kind: 'agent', title: agent.name, agentId: agent.id }),
  }))
  const visual = visualSessions[0]
  useWorkspaceStore.getState().openSheet({ kind: 'file', title: 'File', agentId: visual.agentId, singletonKey: `file:session:${visual.id}` })
  useWorkspaceStore.getState().openSheet({ kind: 'overview', title: 'Overview' })
  useWorkspaceStore.getState().openSheet({ kind: 'gateway', title: 'Gateway' })
  useWorkspaceStore.getState().openSheet({ kind: 'history', title: 'History' })
  useWorkspaceStore.getState().openSheet({ kind: 'runtime', title: 'Runtime' })
  useWorkspaceStore.getState().openSheet({ kind: 'search', title: 'Search' })
  useWorkspaceStore.getState().openSheet({
    kind: 'browser',
    title: 'Browser',
    metadata: { visualQaBrowser: 'tabs' },
  })

  for (const agent of buildDemoAgents()) {
    const active = sessions.find(session => session.agentId === agent.id)
    useWorkspaceStore.getState().setSheetAgentState(agent.id, {
      activeProfileId: active?.profileId ?? 'default',
      activeSessionId: active?.id,
    })
  }
  const periSheet = agentSheets.find(item => item.agent.id === 'peri')?.sheetId
  if (periSheet) useWorkspaceStore.getState().focusSheet(periSheet)
  setActiveSession(visual.id)

  const statuses: Record<string, AgentStatus> = {
    peri: { agent: 'peri', agentId: 'peri', status: 'connected', transport: 'acp', cwd: '/path/to/project', generation: 12, lastConnectedAt: Date.now(), capabilities: { loadSession: true, promptCapabilities: { image: true, audio: true } } },
    hermes: { agent: 'hermes', agentId: 'hermes', status: 'error', transport: 'acp', cwd: '/path/to/ops', generation: 4, recentError: '健康检查失败：HTTP 503' },
    claude: { agent: 'claude', agentId: 'claude', status: 'reconnecting', transport: 'acp', cwd: '/path/to/agent-runtime', generation: 8, recentError: '连接已重置，正在重新协商能力' },
    pi: { agent: 'pi', agentId: 'pi', status: 'connecting', transport: 'acp', cwd: '/path/to/agent-runtime', generation: 2 },
    gm: { agent: 'gm', agentId: 'gm', status: 'disconnected', transport: 'web', cwd: '/path/to/worldbook', generation: 6, recentError: '远端暂未上线' },
  }
  const runtime = useRuntimeStore.getState()
  for (const [agentId, status] of Object.entries(statuses)) runtime.setAgentStatus(agentId, status)
  const running = visualSessions.find(session => session.id === 'demo-task-swarm')
  runtime.setLiveStats({ liveGenerating: running?.source ?? null, liveGeneratingSources: running ? [running.source] : [] })
  for (const session of sessions) {
    runtime.setSessionMode({ agentId: session.agentId, source: session.source }, session.id.includes('plugin') ? 'edit' : 'auto')
    runtime.setSessionConfig({ agentId: session.agentId, source: session.source }, {
      model: session.agentId === 'claude' ? 'claude-sonnet-4-6' : session.agentId === 'pi' ? 'gpt-5.5' : 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'claude-sonnet-4-6', 'gpt-5.5'],
      // P56/D3：demo 模拟「已宣告模型面」的真实会话形态——无 modelChoices 时
      // 模型控件按发送不变量降级为只读徽章，demo 会失去可交互 selector。
      modelChoices: [
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { id: 'gpt-5.5', label: 'GPT-5.5' },
      ],
    })
  }
  if (options.withPermission) {
    runtime.setPermission({ type: 'receive', request: buildDemoPermissionRequest(), now: Date.now() })
  }
}
