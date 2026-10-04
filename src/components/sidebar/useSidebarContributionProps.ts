import { createMemo } from 'solid-js'
import { save } from '@tauri-apps/plugin-dialog'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { appClients } from '../../app/appClients.ts'
import { refreshSessionsBackend, useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore'
import { reportRuntimeError } from '../../app/runtimeError'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../../application/transactions/removeSessionTransaction'
import { runSessionNotificationHook } from '../../application/transactions/sessionHookTransactions'
import { getCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'
import { clearMessageStorage } from '../../domains/chat/messagePersistence'
import { validateExportPath } from '../../domains/overview/persistedHistory.ts'
import type { Session } from '../../domains/identity/identityTypes.ts'
import type { SheetContext } from '../../workspace-sheets/sheetTypes.ts'
import type { AgentSidebarContributionProps, AgentSidebarPresentation } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import type {
  AgentSidebarSurfaceBlockAction,
  AgentSidebarSurfaceInput,
} from '../../plugin-runtime/sidebar/sidebarSurfaceProtocol.ts'

/** 除逐区块字段（`presentation` / `collapsed` / 动作注册）之外的贡献 props。 */
export type AgentSidebarSharedProps = Omit<
  AgentSidebarContributionProps,
  'presentation' | 'collapsed' | 'onBlockAction' | 'registerBlockActionHandler'
>

const NO_GENERATING_SOURCES: readonly string[] = []

/**
 * ownSessions 的**唯一真源**（#520 S2-P2：此前 Sidebar 与 AgentSheetPageHost 各写一份
 * 过滤+排序，真源二重复制）：当前 profile + 当前 agent 名下、未归档的会话；
 * 置顶的排在各自工作区最前，其余按最近活跃（`sort` 稳定，同档内保持原序）。
 */
export function selectOwnSessions(
  sessions: readonly Session[],
  profileId: string,
  agentId: string,
): Session[] {
  return sessions
    .filter(s => s.profileId === profileId && s.agentId === agentId && !s.archivedAt)
    .sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
      || ((b.lastActiveAt || 0) - (a.lastActiveAt || 0)))
}

/**
 * 贡献 props 的**唯一接线处**（#520 S4-P1-4 恢复共享工厂——#515 拆除 Solid hook 时
 * 留下的 ~100 行逐字重复洞）。
 *
 * 同一份内容会以两种体量出现——左栏区块里的小样（`Sidebar.solid.tsx`），与主区整页
 * （`AgentSheetPageHost.solid.tsx`，`presentation: 'page'`）。两处必须拿到**同一批**
 * 会话/工作区数据与回调，否则「整页里删掉的会话，区块里还显示」这类分裂迟早出现。
 * 须在响应式 owner 内调用（组件体 / createRoot）。
 */
export function createAgentSidebarSharedProps(ctx: SheetContext): () => AgentSidebarSharedProps {
  const activeProfileId = createZustandSignal(useIdentityStore, s => s.activeProfileId)
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const sessions = createZustandSignal(useIdentityStore, s => s.sessions)
  const workspaces = createZustandSignal(useWorkspaceEntityStore, s => s.workspaces)
  const liveGeneratingSources = createZustandSignal(useRuntimeStore, s => s.liveGeneratingSources ?? NO_GENERATING_SOURCES)

  const ownSessions = createMemo(() => selectOwnSessions(sessions(), activeProfileId(), activeAgent()))

  const handleDelete = async (id: string) => {
    if (!window.confirm('删除会话？')) return
    const sessionClient = appClients.session()
    const sessionsNow = sessions()
    const result = await removeSessionTransaction(id, {
      findSession: sessionId => sessionsNow.find(s => s.id === sessionId),
      deleteSessionLocal: s => sessionClient.deleteUserSessionLocal({ sessionId: s.id, ownerKey: sessionDurableOwnerKey(s) }),
      refreshSessionsBackend,
      // tombstone 成功后立即封住在途 canonical 写；revision 刷新可能仍在等待。
      markSessionDeleting: sessionId => {
        const target = sessionsNow.find(session => session.id === sessionId)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
        }
      },
      markSessionDeleted: sessionId => {
        const target = sessionsNow.find(s => s.id === sessionId)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
        }
      },
      closeSession: s => sessionClient.closeSession({ agentId: s.agentId, source: s.source }),
      // #398：agent 侧 session/delete（close 之后）；periId 缺失（从未连接 agent）跳过。
      deleteSessionRemote: s => s.periId
        ? sessionClient.deleteSessionAgentSide({ agentId: s.agentId, source: s.source, periId: s.periId })
        : Promise.resolve(),
      finalizeSessionDelete: s => sessionClient.finalizeUserSessionDelete({ sessionId: s.id, ownerKey: sessionDurableOwnerKey(s) }),
      removeSession: sessionId => useIdentityStore.getState().removeSession(sessionId),
      clearMessages: sessionId => clearMessageStorage(sessionId, localStorage),
      reportError: (action, error) => reportRuntimeError(action, error),
      // API 1.3 生命周期通知:closing→deleting→deleted→closed(观察语义)。
      notifySessionHook: runSessionNotificationHook,
    })
    if (!result.ok) return
    if (ctx.activeSession === id) ctx.selectSession(null)
  }

  const createSessionUnderCwd = (workspaceId: string) => {
    if (!workspaces().some(workspace => workspace.id === workspaceId)) return
    window.dispatchEvent(new CustomEvent('pylon:new-session', { detail: { workspaceId } }))
    ctx.selectSession(null)
  }

  const handleArchive = (id: string) => {
    const target = sessions().find(session => session.id === id)
    if (!target || !window.confirm(`归档会话“${target.name}”？可在存档页回放。`)) return
    useIdentityStore.getState().updateSession(id, { archivedAt: Date.now(), lastActiveAt: Date.now() })
    if (ctx.activeSession === id) ctx.selectSession(null)
  }

  const handleExport = async (id: string) => {
    const target = sessions().find(session => session.id === id)
    if (!target?.periId) return
    try {
      const outputPath = await save({ defaultPath: `session-${target.periId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (!outputPath) return
      const validation = validateExportPath(outputPath)
      if (validation) { reportRuntimeError('导出会话', validation); return }
      await appClients.session().exportSession({ agentId: target.agentId, periId: target.periId, format: 'markdown', outputPath })
    } catch (error) { reportRuntimeError('导出会话', error) }
  }

  return () => ({
    activeAgentId: activeAgent(),
    activeSessionId: ctx.activeSession,
    // 会话区里两个族群（挂在工作区上的 / 无 cwd 的）由同一个贡献渲染并按 cwd 分组，
    // 因此给它全集，分组语义留在面板里，宿主不再做 work/chat 预切分。
    sessions: ownSessions(),
    workspaces: workspaces(),
    liveGeneratingSources: liveGeneratingSources(),
    onSelectSession: id => ctx.selectSession(id),
    onDeleteSession: handleDelete,
    onExportSession: handleExport,
    onArchiveSession: handleArchive,
    onOpenSessionSettings: id => ctx.openSessionSettings(id),
    onToggleSessionPin: (id: string) => {
      const target = sessions().find(session => session.id === id)
      if (!target) return
      useIdentityStore.getState().updateSession(id, { pinned: !target.pinned })
    },
    // #393：改名是用户意图，置 `renamedByUser` 后显示恒以 `name` 为准——
    // Agent 后续推的标题只更新 `autoName`（存储以 Agent 为准，显示以用户为准）。
    onRenameSession: (id: string, name: string) => useIdentityStore.getState().updateSession(id, { name, renamedByUser: true, lastActiveAt: Date.now() }),
    onCreateLooseSession: () => { window.dispatchEvent(new CustomEvent('pylon:new-session')); ctx.selectSession(null) },
    onCreateWorkspace: async (name: string, rootPath: string) => { await useWorkspaceEntityStore.getState().createWorkspace(name, rootPath) },
    onCreateWorkspaceSession: createSessionUnderCwd,
  })
}

/** isolated 表面 wire 输入的**逐体量差异**（宿主只投影这些，其余字段统一拼装）。 */
export interface AgentSidebarSurfaceInputFlavor {
  readonly presentation: AgentSidebarPresentation
  /** 宿主拥有的折叠态；page 体量恒 false。 */
  readonly collapsed: boolean
  /** 本模块整页是否被打开；page 体量恒 true。 */
  readonly pageOpen: boolean
  readonly blockAction: AgentSidebarSurfaceBlockAction | null
  /**
   * **已知漂移点的显式化**：page 体量的 wire 输入多带 `query: ''`（宿主头部搜索词，
   * 整页宿主渲染搜索框、区块小样没有），block 体量不写字段——两体量共用同一形状，
   * 差异字段由宿主显式传入而不是藏在各自手写的投影里。
   */
  readonly query?: string
}

/**
 * isolated 表面（`renderKind: 'isolated-surface'`）wire 输入的统一投影：
 * 会话/工作区按 wire 最小面收窄，逐体量差异见 {@link AgentSidebarSurfaceInputFlavor}。
 */
export function projectAgentSidebarSurfaceInput(
  shared: AgentSidebarSharedProps,
  flavor: AgentSidebarSurfaceInputFlavor,
): AgentSidebarSurfaceInput {
  return {
    ...(flavor.query === undefined ? {} : { query: flavor.query }),
    activeAgentId: shared.activeAgentId,
    activeSessionId: shared.activeSessionId,
    presentation: flavor.presentation,
    collapsed: flavor.collapsed,
    pageOpen: flavor.pageOpen,
    blockAction: flavor.blockAction,
    sessions: shared.sessions.map(session => ({ id: session.id, name: session.name, workspaceId: session.workspaceId })),
    workspaces: shared.workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, rootPath: workspace.rootPath })),
  }
}
