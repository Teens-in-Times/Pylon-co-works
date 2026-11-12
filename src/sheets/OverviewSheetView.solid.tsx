/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { appClients } from '../app/appClients.ts'
import { IS_TAURI } from '../infrastructure/tauri/env'
import { useIdentityStore, type AgentEntry, type Session } from '../domains/identity/identityStore'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../app/runtimeError'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import { createStandardSwitchAgent, openOwnedSessionTransaction } from '../application/transactions/openOwnedSessionTransaction'
import PylonMark from '../components/PylonMark.solid.tsx'
import { LucideIcon } from '../components/LucideIcon.solid.tsx'
import { statusLabel } from '../contracts/agentTypes.ts'
import { recentPersistedSessions, type PersistedSessionSummary } from '../domains/overview/persistedSessions.ts'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import { useWorkspaceEntityStore } from '../domains/workspace/workspaceEntityStore.ts'
import { isAgentInvocationConfigured } from '../contracts/agentEntry.ts'
import { INTERFACE_MODE_CAPABILITY_OVERVIEW_DECK } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { createActiveInterfaceModeContribution } from '../infrastructure/state/solidSheetSupport.solid.tsx'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import TacticalCommandDeck from './TacticalCommandDeck.solid.tsx'
import AgentConfigEditor from '../components/settings/AgentConfigEditor.solid.tsx'

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

type TacticalPanel = 'home' | 'agents' | 'recent' | 'workspaces'

interface TacticalCommandDeckProps {
  agents: number
  connected: number
  sessions: number
  workspaces: number
  primaryLabel: string
  primaryDescription: string
  busy: boolean
  onPrimary(): void
  onPanel(panel: TacticalPanel): void
  onSettings(): void
  onDiagnostics(): void
}

interface OverviewSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/**
 * OverviewSheetView — 启动选择器（W1-05/06，§5.1）。
 *
 * 虚拟空态（不写入持久 sheet 数组）：无 active sheet 时 SheetLayout 直接渲染 overview。
 * 三入口：选择 Agent（list_agents → switch_agent → 无缝 open agent sheet，失败保持
 * overview 并报错）/ 配置 Agent（W1-07 接线）/ 继续会话（list_persisted_sessions →
 * 最近 5 个 → 找/建 identity row → selectSession + open agent sheet；load 由 agentWorkbenchLifecycle
 * 挂载后的 controller lifecycle 承担——listener 就绪后才 load）。
 */
export default function OverviewSheetView(props: OverviewSheetViewProps) {
  // A-V9：指挥台 UI 按 contribution 能力位挂载，不再特判模式 id——
  // 任何声明 overview.command-deck 能力的模式（内置或插件）获得等价 Overview 指挥台。
  const contribution = createActiveInterfaceModeContribution()
  const commandDeck = createMemo(() => contribution().capabilities?.[INTERFACE_MODE_CAPABILITY_OVERVIEW_DECK] === true)
  const [tacticalPanel, setTacticalPanel] = createSignal<TacticalPanel>('home')
  const agents = createZustandSignal(useIdentityStore, s => s.agents)
  const sessions = createZustandSignal(useIdentityStore, s => s.sessions)
  // #326：空串 = 没有 Agent（零 Agent 首跑）。空串下所有按 agent 的查找自然不命中。
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const activeProfileId = createZustandSignal(useIdentityStore, s => s.activeProfileId)
  const agentStatuses = createZustandSignal(useRuntimeStore, s => s.agentStatuses)
  const workspaces = createZustandSignal(useWorkspaceEntityStore, s => s.workspaces)
  const [switchingId, setSwitchingId] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  const [errorIsValidation, setErrorIsValidation] = createSignal(false)
  const [recent, setRecent] = createSignal<PersistedSessionSummary[]>([])
  const [showConfigEditor, setShowConfigEditor] = createSignal(false)

  // The store starts with a placeholder active id. Only a real catalog member
  // can own the backend's agent-scoped archive request.
  const recentAgentId = createZustandSignal(useIdentityStore, state =>
    state.agents.some(agent => agent.id === state.activeAgent) ? state.activeAgent : '',
  )
  createEffect(() => {
    const agentId = recentAgentId()
    setRecent([])
    if (!IS_TAURI || !agentId) return
    let disposed = false
    const client = appClients.session()
    client.listPersistedSessions().then(all => {
      if (!disposed) {
        setRecent(recentPersistedSessions(all))
        resolveRuntimeErrors({ key: 'overview:recent-sessions' })
      }
    }).catch(err => {
      if (!disposed) reportRuntimeError('读取最近会话', err, undefined, {
        key: 'overview:recent-sessions', scope: { kind: 'sheet', id: 'overview' }, source: 'overview',
      })
    })
    onCleanup(() => { disposed = true })
  })

  const selectAgent = async (agent: AgentEntry) => {
    if (switchingId()) return
    setSwitchingId(agent.id)
    setError('')
    setErrorIsValidation(false)
    const agentClient = appClients.agent()
    const result = await switchAgentTransaction(agent.id, agent.name, {
      switchAgent: () => agentClient.switchAgent(agent.id),
      resetRuntime: () => useRuntimeStore.getState().resetSessionRuntime(),
      setActiveAgent: id => useIdentityStore.getState().setActiveAgent(id),
      fetchAgentStatus: () => agentClient.agentStatus(),
      applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
      reportError: (action, err) => {
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError(action, err, agent.id, {
          key: `overview:agent:${agent.id}:${action}`,
          scope: { kind: 'agent', id: agent.id },
          source: 'overview.agent-switch',
        })
      },
      resolveError: action => resolveRuntimeErrors({ key: `overview:agent:${agent.id}:${action}` }),
      dispatchSwitched: () => window.dispatchEvent(new CustomEvent('pylon:agent-switched')),
      // 无缝进 sheet：成功后 open agent sheet（失败保持 overview）
      openAgentSheet: (id, title) => props.ctx.openSheet({ kind: 'agent', title, agentId: id }),
    })
    if (!result.ok) setSwitchingId(null)
  }

  // W1-06：复用现有 identity session；无则创建 row 并纠正 source/periId（不直接 load——
  // 由 agentWorkbenchLifecycle 执行 load，保证 listener/controller 就绪）。
  // FE-AUD-010：找/建逻辑收敛到 resumePersistedSessionTransaction，不靠数组长度定位。
  const resumeSession = async (p: PersistedSessionSummary) => {
    setError('')
    setErrorIsValidation(false)
    // I01-W4：owner-aware 打开——owner 无法确定时 blocked，不静默归 active Agent
    const result = await openOwnedSessionTransaction(
      { source: p.source, periId: p.periId, title: p.title, updatedAt: p.updatedAt },
      {
        getSessions: () => useIdentityStore.getState().sessions,
        activeAgent: useIdentityStore.getState().activeAgent,
        addSession: (name, agentId) => useIdentityStore.getState().addSession(name, agentId),
        updateSession: (id, partial) => useIdentityStore.getState().updateSession(id, partial),
        switchAgent: createStandardSwitchAgent(id => useIdentityStore.getState().agents.find(a => a.id === id)?.name),
        selectSession: id => props.ctx.selectSession(id),
        openAgentSheet: ({ title, agentId }) => props.ctx.openSheet({ kind: 'agent', title, agentId }),
      },
    )
    if (!result.ok) {
      setError(result.message)
      // Transport failures are already represented by the central ErrorCenter
      // (the standard owner-switch transaction reports there). Keep only
      // validation/ownership facts as assertive inline guidance.
      setErrorIsValidation(result.kind !== 'transport')
      return
    }
  }

  const openKnownSession = (session: Session) => resumeSession({
    id: session.id,
    source: session.source,
    periId: session.periId,
    title: session.name,
    updatedAt: session.lastActiveAt,
  })

  const localRecent = createMemo(
    () => [...sessions()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 6),
  )
  const persistedRecent = createMemo(
    () => recent().filter(item => !sessions().some(session => session.source === item.source)).slice(0, Math.max(0, 6 - localRecent().length)),
  )
  const connectedCount = createMemo(() => agents().filter(agent => agentStatuses()[agent.id]?.status === 'connected').length)
  const activeAgentEntry = createMemo(() => agents().find(agent => agent.id === activeAgent()))
  const activeAgentConfigured = createMemo(() => isAgentInvocationConfigured(activeAgentEntry()))

  const openAgentSettings = () => window.dispatchEvent(new CustomEvent('pylon:open-settings', {
    detail: { domain: 'agents-connections', section: 'agent', agentId: activeAgent() },
  }))

  const openWorkspace = (workspaceId: string, ownerAgentId: string) => {
    const linked = localRecent().find(session => session.workspaceId === workspaceId)
    if (linked) {
      void openKnownSession(linked)
      return
    }
    const resolvedOwnerId = ownerAgentId || activeAgent()
    const owner = agents().find(agent => agent.id === resolvedOwnerId)
    // #326：没有可用 owner（零 Agent 首跑）时不铸「无主 agent sheet」——那会写入一份
    // 没有主人的会话归属记忆。改为把用户送到配置入口。
    if (!owner) { openAgentSettings(); return }
    props.ctx.openSheet({ kind: 'agent', title: owner.name, agentId: owner.id })
  }

  const navigateTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  // 指挥台（TacticalCommandDeck.solid 直连）的 props 工厂：effect 追踪本 memo，任一依赖变化即原位重渲。
  const deckProps = createMemo<TacticalCommandDeckProps>(() => ({
    agents: agents().length,
    connected: connectedCount(),
    workspaces: workspaces().length,
    sessions: localRecent().length + persistedRecent().length,
    busy: switchingId() !== null,
    primaryLabel: localRecent()[0] ? '继续行动' : activeAgentConfigured() ? '开始行动' : '接入 Agent',
    primaryDescription: localRecent()[0]?.name ?? (activeAgentConfigured() ? `进入 ${activeAgentEntry()?.name ?? activeAgent()} 工作台` : '先配置一个 ACP 运行时'),
    onPrimary: () => {
      if (localRecent()[0]) void openKnownSession(localRecent()[0])
      else {
        const entry = activeAgentEntry()
        if (activeAgentConfigured() && entry) void selectAgent(entry)
        else openAgentSettings()
      }
    },
    onPanel: panel => setTacticalPanel(panel),
    onSettings: openAgentSettings,
    onDiagnostics: () => props.ctx.openSheet({ kind: 'runtime', title: '运行诊断' }),
  }))

  // 面包屑文案（tacticalPanel 为 home 时不渲染面包屑，故无 home 键）。
  const TACTICAL_PANEL_LABELS: Readonly<Record<Exclude<TacticalPanel, 'home'>, string>> = {
    agents: 'Agent 编队', recent: '会话档案', workspaces: '工作区',
  }
  const topWorkspaces = createMemo(() => [...workspaces()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 5))

  return (
    <div class="overview-sheet" data-tactical-panel={commandDeck() ? tacticalPanel() : undefined}>
      {/* #154：左列几何（宽度/竖直分割线/折叠可见性）归布局层的 .sidebar；本类只管内容样式。 */}
      <aside class="sidebar overview-sidebar" aria-label="Overview 分区">
        <div class="overview-sidebar-head">
          <span>工作台</span>
          <strong>工作台导航</strong>
        </div>
        <nav>
          <button type="button" onClick={() => navigateTo('overview-home')}><LucideIcon name="LayoutDashboard" size={15} /><span>概览</span></button>
          <button type="button" onClick={() => navigateTo('overview-agents')}><LucideIcon name="Bot" size={15} /><span>Agent</span><small>{agents().length}</small></button>
          <button type="button" onClick={() => navigateTo('overview-recent')}><LucideIcon name="MessageSquare" size={15} /><span>最近会话</span><small>{localRecent().length + persistedRecent().length}</small></button>
          <button type="button" onClick={() => navigateTo('overview-workspaces')}><LucideIcon name="Folder" size={15} /><span>工作区</span><small>{workspaces().length}</small></button>
          <button type="button" onClick={() => navigateTo('overview-advanced')}><LucideIcon name="Settings2" size={15} /><span>高级配置</span></button>
        </nav>
        <div class="overview-sidebar-foot"><LucideIcon name="Activity" size={14} />{connectedCount()} 个 Agent 在线</div>
      </aside>
      <main class="overview-main">
        <div class="overview-shell">
          <Show when={commandDeck()}>
            <Show when={tacticalPanel() === 'home'} fallback={
              <nav class="tactical-breadcrumb" aria-label="战术页面导航">
                <button onClick={() => setTacticalPanel('home')}>← 返回指挥台</button>
                <span>/</span><strong>{TACTICAL_PANEL_LABELS[tacticalPanel() as Exclude<TacticalPanel, 'home'>]}</strong>
                <button onClick={openAgentSettings}>配置 Agent <LucideIcon name="ArrowUpRight" size={14} /></button>
              </nav>
            }>
              <TacticalCommandDeck {...deckProps()} />
            </Show>
          </Show>
          <section class="overview-hero" id="overview-home" aria-labelledby="overview-title">
            <div class="overview-hero-brand">
              <div class="overview-mark-stage">
                <PylonMark size={34} className="overview-brand-mark" title="Pylon" />
              </div>
              <div class="overview-hero-copy">
                <h1 class="overview-title" id="overview-title">{agents().length ? '欢迎回到工作台' : '开始你的工作'}</h1>
                <p class="overview-lede">{agents().length ? '继续最近的会话，或选择 Agent 开始新的任务。' : '连接你的 Agent，把对话、文件与工作进度放在同一个工作台。'}</p>
                <div class="overview-hero-actions">
                  <Show when={localRecent()[0]} fallback={
                    <Show when={activeAgentEntry() && activeAgentConfigured()} fallback={
                      <button type="button" class="overview-primary-action" onClick={openAgentSettings}>
                        配置 Agent <LucideIcon name="ArrowUpRight" size={15} />
                      </button>
                    }>
                      <button type="button" class="overview-primary-action" onClick={() => void selectAgent(activeAgentEntry()!)}>
                        打开 {activeAgentEntry()!.name} <LucideIcon name="ArrowUpRight" size={15} />
                      </button>
                    </Show>
                  }>
                    {latest => (
                      <button type="button" class="overview-primary-action" onClick={() => void openKnownSession(latest())}>
                        继续「{latest().name}」 <LucideIcon name="ArrowUpRight" size={15} />
                      </button>
                    )}
                  </Show>
                  <Show when={agents().length > 0}><button type="button" class="overview-secondary-action" onClick={openAgentSettings}>
                    <LucideIcon name="Settings2" size={14} /> Agent 设置
                  </button></Show>
                </div>
              </div>
            </div>
            <Show when={agents().length > 0}>
              <p class="overview-pulse" aria-label={`${connectedCount()} 个 Agent 已连接，${workspaces().length} 个工作区`}>
                <span>{connectedCount()} 个 Agent 在线</span><span>{workspaces().length} 个工作区</span><span>{sessions().length} 个会话</span>
              </p>
            </Show>
          </section>
          <Show when={agents().length > 0} fallback={
            <ol class="overview-start-steps" id="overview-agents" aria-label="开始工作步骤">
              <li><span>01</span><div><strong>连接 Agent</strong><p>选择已安装的 Agent，完成连接配置。</p></div></li>
              <li><span>02</span><div><strong>选择工作目录</strong><p>让 Agent 在项目上下文中工作。</p></div></li>
              <li><span>03</span><div><strong>开始对话</strong><p>会话和工作区会自动保留在这里。</p></div></li>
            </ol>
          }>
            <section class="overview-section overview-agent-section" id="overview-agents">
              <div class="overview-section-heading"><h2>选择 Agent</h2><span class="overview-section-meta">{agents().length} 个可选</span></div>
              <div class="overview-agent-grid">
                <For each={agents()}>{agent => {
                  const status = () => agentStatuses()[agent.id]?.status ?? (agent.id === activeAgent() ? 'unknown' : 'inactive')
                  const sessionCount = () => sessions().filter(session => session.agentId === agent.id).length
                  return (
                    <button
                      type="button"
                      class={`overview-agent-card ${agent.id === activeAgent() ? 'is-active' : ''}`}
                      data-status={status()}
                      disabled={switchingId() === agent.id}
                      onClick={() => void selectAgent(agent)}
                    >
                      <span class="overview-agent-glyph" aria-hidden="true">{agent.name.slice(0, 1).toUpperCase()}</span>
                      <span class="overview-agent-copy">
                        <strong>{agent.name}</strong>
                        {/* #254：副标题用 agentId——同名 Agent（如 hermes/hermes-2）靠它区分，
                            与「打开 Sheet」面板的 Agent 卡口径一致。 */}
                        <span>{agent.id} · {sessionCount()} 个会话</span>
                      </span>
                      <span class="overview-agent-state"><i aria-hidden="true" />{switchingId() === agent.id ? '切换中' : statusLabel(status())}</span>
                      <LucideIcon name="ArrowUpRight" class="overview-card-arrow" size={14} />
                    </button>
                  )
                }}</For>
              </div>

            </section>
          </Show>

          <div class="overview-content-grid">
            <section class="overview-section overview-recent-section" id="overview-recent">
              <div class="overview-section-heading">
                <div>
                  <h2>最近会话</h2>
                </div>
                <LucideIcon name="MessageSquare" size={17} />
              </div>
              <Show when={localRecent().length === 0 && persistedRecent().length === 0} fallback={
                <div class="overview-session-list">
                  <For each={localRecent()}>{session => {
                    const agent = () => agents().find(item => item.id === session.agentId)
                    const workspace = () => workspaces().find(item => item.id === session.workspaceId)
                    return (
                      <button type="button" class="overview-session-row" onClick={() => void openKnownSession(session)}>
                        <span class="overview-session-icon"><LucideIcon name="MessageSquare" size={14} /></span>
                        <span class="overview-session-copy"><strong>{session.name}</strong><span>{(workspace()?.name ?? session.workdir) || '未绑定工作区'} · {agent()?.name ?? session.agentId}</span></span>
                        <time>{relativeTime(session.lastActiveAt)}</time>
                        <LucideIcon name="ArrowUpRight" size={14} />
                      </button>
                    )
                  }}</For>
                  <For each={persistedRecent()}>{item => (
                    <button type="button" class="overview-session-row" onClick={() => void resumeSession(item)}>
                      <span class="overview-session-icon"><LucideIcon name="MessageSquare" size={14} /></span>
                      <span class="overview-session-copy"><strong>{item.title || item.source || item.id}</strong><span>持久化会话</span></span>
                      <time>{relativeTime(item.updatedAt)}</time>
                      <LucideIcon name="ArrowUpRight" size={14} />
                    </button>
                  )}</For>
                </div>
              }>
                <div class="overview-list-empty"><LucideIcon name="MessageSquare" size={20} /><div><strong>还没有可继续的会话</strong><p>开始一次对话后，就能从这里接着工作。</p></div></div>
              </Show>
            </section>

            <section class="overview-section overview-workspace-section" id="overview-workspaces">
              <div class="overview-section-heading">
                <div>
                  <h2>工作区</h2>
                </div>
                <LucideIcon name="Folder" size={17} />
              </div>
              <Show when={workspaces().length === 0} fallback={
                <div class="overview-workspace-list">
                  <For each={topWorkspaces()}>{workspace => {
                    const linkedSessions = () => sessions().filter(session => session.workspaceId === workspace.id)
                    // #255：与左栏树同口径的「当前可见」数（当前 Profile+Agent、未归档）。
                    // 两数一致时退回单数字，避免噪音。
                    const currentCount = () => linkedSessions().filter(session =>
                      session.profileId === activeProfileId()
                      && session.agentId === activeAgent()
                      && !session.archivedAt).length
                    const countLabel = createMemo(() => currentCount() === linkedSessions().length
                      ? `${linkedSessions().length} 会话`
                      : `${linkedSessions().length} 关联 · ${currentCount()} 当前`)
                    return (
                      <button type="button" class="overview-workspace-row" onClick={() => openWorkspace(workspace.id, workspace.agentId)}>
                        <span class="overview-folder-icon"><LucideIcon name="Folder" size={15} /></span>
                        <span class="overview-workspace-copy"><strong>{workspace.name}</strong><span title={workspace.rootPath}>{workspace.rootPath}</span></span>
                        <span
                          class="overview-workspace-count"
                          title={`关联 ${linkedSessions().length} 个会话（全部 Profile/Agent，含归档）；当前 Profile/Agent 下可见 ${currentCount()} 个（与左栏树一致）`}
                        >{countLabel()}</span>
                        <LucideIcon name="ArrowUpRight" size={14} />
                      </button>
                    )
                  }}</For>
                </div>
              }>
                <div class="overview-list-empty"><LucideIcon name="Folder" size={20} /><div><strong>还没有工作区</strong><p>{commandDeck() ? '进入 Agent 工作台后，选择你的项目目录。' : '打开 Agent 后，在左栏添加项目目录。'}</p></div></div>
              </Show>
            </section>
          </div>

          <Show when={agents().length > 0}><section class="overview-config-strip" id="overview-advanced">
            <div>
              <span class="overview-section-eyebrow">高级</span>
              <strong>当前 Agent：{activeAgentEntry()?.name ?? activeAgent()}</strong>
              <span>需要直接检查底层配置时再展开 YAML 编辑器。</span>
            </div>
            <button type="button" class="overview-secondary-action" onClick={() => setShowConfigEditor(value => !value)}>
              <LucideIcon name="Settings2" size={14} /> {showConfigEditor() ? '收起编辑器' : '编辑高级配置'}
            </button>
          </section>
          </Show>
          <Show when={showConfigEditor()}>
            <div class="overview-config-editor"><AgentConfigEditor agentId={activeAgent()} /></div>
          </Show>
          <Show when={error()}>
            <Show when={errorIsValidation()} fallback={
              <p class="overview-error overview-error-reference" role="status">操作失败，详情见右下角错误中心</p>
            }>
              <div class="overview-error" role="alert">{error()}<Show when={error().includes('归属不明')}><button type="button" class="settings-action" onClick={openAgentSettings}>打开 Agent 设置并选择归属</button></Show></div>
            </Show>
          </Show>
        </div>
      </main>
    </div>
  )
}
