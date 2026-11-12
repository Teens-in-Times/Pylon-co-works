/** @jsxImportSource solid-js */
import { createEffect, createMemo, For, on, Show, untrack, type Component } from 'solid-js'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useThemeStore } from '../domains/theme/themeStore'
import { useHydrationStore } from '../app/bootstrap/hydrationState'
import { resolveSessionSource } from '../domains/chat/sessionCommandState'
import { belongsToProfile } from '../domains/chat/sessionProfile'
import { resolveSheetRender } from './sheetRegistry.ts'
import { activateAgentSheet, isAgentSheetRuntimeReady } from './activateAgentSheet'
import SheetHost from './SheetHost.solid.tsx'
import SheetSidebarSlot from './SheetSidebarSlot.solid.tsx'
import LeftRailResizeHandle from './LeftRailResizeHandle.solid.tsx'
import RightRailHost from '../components/right-panel/RightRailHost.solid.tsx'
import type { SheetContext, SheetRecord } from './sheetTypes'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from '../plugin-runtime/workspaces/workspaceRegistry'
import { closeWorkspace } from './workspaceController'
import { sheetHasLeftColumn } from './sheetSidebarState.ts'
import { useRightRailStore } from '../domains/workspace/layoutRailsStore.ts'
import type { RailLayout } from '../domains/workspace/railLayout.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../app/runtimeError.ts'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'

/**
 * SheetLayout — sheet 布局层（W1-03 侧栏上移，行为敏感）。
 *
 * 接盘 App 布局段：解析 activeSheet、构建 SheetContext、按 registry 声明渲染
 * [侧栏壳 | 主区 | 右栏壳]。profile 投影与会话记忆 effects 从 App 原样搬运（行为不变）。
 * 无 sheet → 空态。Settings/对话框保持 App 单例挂载，不进本层。
 *
 * keep-alive 槽位按稳定 sheet.id 保留实例：
 * 外层 `<For>` 以 sheet.id 串为键（同 id 串引用稳定 ⇒ 行不重建），内层以访问器
 * 响应式更新 sheet/ctx —— sheet 对象被 patch 换引用（如 patchSheetMetadata）时
 * 只换 props 不换实例，组件内状态与 keep-alive display:contents 活性保持。
 */

interface SheetLayoutProps {
  railLayout?: RailLayout
  activeSession: string | null
  onSelectSession: (id: string | null) => void
  onProfileEdit: () => void
  onSessionSettings: (id: string) => void
}

function buildSheetContext(props: SheetLayoutProps, sidebarCollapsed: boolean): SheetContext {
  const { openSheet, focusSheet } = useWorkspaceStore.getState()
  return {
    openSheet,
    focusSheet,
    closeSheet: id => { void closeWorkspace(id) },
    activeSession: props.activeSession,
    selectSession: props.onSelectSession,
    openProfileEdit: props.onProfileEdit,
    openSessionSettings: props.onSessionSettings,
    // ctx 经 createMemo 随折叠状态重建，消费方经响应式 props 读取最新快照。
    sidebarCollapsed,
    // 右栏由应用级 RightRailHost 作为 .layout 的 flex sibling 占位，主区宽度已天然扣除；
    // renderer 再消费 rightInset 会二次挤压内容，并在折叠切换时产生异常跳宽。
    rightInset: 0,
    // active 主区的 context；非 active 的 keep-alive Sheet 会在下方显式覆盖为 false。
    isActive: true,
    sessionSource: sessionId => resolveSessionSource(sessionId, useIdentityStore.getState().sessions),
    sessionBySource: source => useIdentityStore.getState().sessions.find(session => session.source === source),
  }
}

export default function SheetLayout(props: SheetLayoutProps) {
  // SheetHost/SheetSidebarSlot/EmptyLayout 分别持有 registry 订阅，布局不重复订阅。
  const sheets = createZustandSignal(useWorkspaceStore, s => s.workspaceSheets.sheets)
  const activeSheetId = createZustandSignal(useWorkspaceStore, s => s.workspaceSheets.activeSheetId)
  const activeSheet = createMemo(() => sheets().find(sheet => sheet.id === activeSheetId()))
  // 左栏是统一应用布局；切换任何 Sheet 都保持同一折叠状态。
  const preferredSidebarCollapsed = createZustandSignal(useRightRailStore, s => s.leftRailCollapsed)
  const sidebarCollapsed = () => props.railLayout?.leftCollapsed ?? preferredSidebarCollapsed()

  const identityActiveAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const sheetOwnerAgentId = createMemo(() => {
    const sheet = activeSheet()
    return sheet?.kind === 'agent' ? sheet.agentId : undefined
  })
  // 冷启动：激活 agent sheet 时，activeAgent 以恢复出的 sheet owner 为准。空串 = 没有 Agent
  //（#326 零 Agent 首跑），不得回落硬编码 'peri' 造出一个不存在的 Agent。
  const activeAgent = createMemo(() => sheetOwnerAgentId() ?? identityActiveAgent())
  const activeProfileId = createZustandSignal(useIdentityStore, s => s.activeProfileId)
  const sessions = createZustandSignal(useIdentityStore, s => s.sessions)
  const sheetAgentStates = createZustandSignal(useWorkspaceStore, s => s.sheetAgentStates)
  // 报告 2.3：ready 前禁止 Workspace 写操作——避免启动期用未 hydrate 状态覆盖持久化
  const hydrationReady = createZustandSignal(useHydrationStore, s => s.status === 'ready')
  let didColdStartActivate = false

  // hydrate 就绪后恢复激活 Sheet 的 owner；身份相同但 runtime 尚未连接也需启动。
  createEffect(() => {
    if (!hydrationReady() || didColdStartActivate) return
    const owner = sheetOwnerAgentId()
    if (!owner) return
    if (untrack(() => isAgentSheetRuntimeReady(owner))) return
    didColdStartActivate = true
    const agentName = useIdentityStore.getState().agents.find(agent => agent.id === owner)?.name ?? owner
    void activateAgentSheet(owner, agentName, () => {}, { silent: true })
  })

  // Restore on hydration and Agent Sheet changes. A global selection belonging
  // to another Agent must never become this Sheet's remembered selection.
  createEffect(on(() => [hydrationReady(), activeAgent()] as const, ([ready, agent]) => {
    if (!ready) return
    // #326：空串 = 没有 Agent（零 Agent 首跑）。它不是实体：读写 sheetAgentStates[''] 会
    // 把「没有 Agent」写进持久化记忆（重启后仍在），并喂给会话归属推断。
    if (!agent) return
    const currentSession: string | null = untrack(() => props.activeSession)
    const current = useIdentityStore.getState().sessions.find(session => session.id === currentSession)
    const memory = useWorkspaceStore.getState().sheetAgentStates[agent]
    const currentProfileId = untrack(activeProfileId)
    const targetProfileId = memory?.activeProfileId ?? currentProfileId
    if (current?.agentId === agent && current.profileId === targetProfileId) return
    if (memory?.activeProfileId && memory.activeProfileId !== currentProfileId) {
      useIdentityStore.getState().setActiveProfile(memory.activeProfileId)
    }
    const remembered = useIdentityStore.getState().sessions.find(session => session.id === memory?.activeSessionId)
    const rememberedId = remembered && (remembered.agentId !== agent || remembered.profileId !== targetProfileId)
      ? null : memory?.activeSessionId ?? null
    if (rememberedId !== currentSession) {
      props.onSelectSession(rememberedId)
    }
  }))

  // W1-03 原样搬运：会话选择持久化到该 agent 记忆（profile 已由 setActiveProfile 同步）。
  // 修复：hydrate 就绪前跳过——否则用初始空 sheets 覆盖持久化（刷新丢 sheets → 启动页）
  createEffect(() => {
    const agent = sheetOwnerAgentId()
    if (!hydrationReady() || !agent) return
    // Runtime switching and Sheet focus are separate steps. Until they agree,
    // neither the old session nor the switch's temporary null may overwrite memory.
    if (identityActiveAgent() !== agent) return
    const selected = props.activeSession
    const selectedSession = sessions().find(session => session.id === selected)
    if (selected && (selectedSession?.agentId !== agent || selectedSession.profileId !== activeProfileId())) return
    useWorkspaceStore.getState().setSheetAgentState(agent, { activeSessionId: props.activeSession || undefined })
  })

  // W1-03 原样搬运：profile 越界清理（切 profile 后 activeSession 不属于新 profile → 清空）
  createEffect(() => {
    const profileId = activeProfileId()
    const session = props.activeSession
    const currentSessions = sessions()
    // Hydration may restore an id before the corresponding session rows arrive.
    // Absence is not evidence of a different profile.
    if (session && !currentSessions.some(item => item.id === session || item.source === session)) return
    if (!belongsToProfile(session, profileId, currentSessions)) props.onSelectSession(null)
  })

  // Context snapshots change only when their tracked inputs change.
  const ctx = createMemo(() => buildSheetContext(props, sidebarCollapsed()))
  const activeSessionOwner = createMemo(() => sessions().find(session => session.id === props.activeSession)?.agentId)
  const contextForAgentSheet = (sheet: SheetRecord): SheetContext => {
    const memory = sheet.agentId ? sheetAgentStates()[sheet.agentId] : undefined
    const remembered = sessions().find(session => session.id === memory?.activeSessionId)
    const rememberedSession = remembered && remembered.agentId === sheet.agentId
      && (!memory?.activeProfileId || remembered.profileId === memory.activeProfileId) ? remembered.id : null
    const selected = sessions().find(session => session.id === props.activeSession)
    const sessionId = activeSessionOwner() === sheet.agentId
      && selected?.profileId === (memory?.activeProfileId ?? activeProfileId()) ? props.activeSession : rememberedSession
    const active = sheet.id === activeSheetId()
    return {
      ...ctx(),
      activeSession: sessionId,
      selectSession: id => {
        if (sheet.agentId) useWorkspaceStore.getState().setSheetAgentState(sheet.agentId, { activeSessionId: id ?? undefined })
        if (active) props.onSelectSession(id)
      },
    }
  }
  const activeSheetContext = createMemo(() => {
    const sheet = activeSheet()
    return sheet?.kind === 'agent' ? contextForAgentSheet(sheet) : ctx()
  })
  const ccEditMode = createZustandSignal(useThemeStore, s => s.ccEditMode)
  const showSidebar = createZustandSignal(useThemeStore, s => s.showSidebar !== false)
  // #154：左列的可见性是布局层的状态——宽度、竖直分割线与 a11y 可见性都据它决定，
  // 各 Sheet 不再自行判断折叠。判定与 App 的 sidebarEnabled 同源（sheetHasLeftColumn），
  // 避免标题栏与左列对「本 Sheet 有没有左栏」得出两个结论。
  const leftColumnVisible = createMemo(() => {
    const sheet = activeSheet()
    return !!sheet && sheetHasLeftColumn(sheet) && showSidebar() !== false && !sidebarCollapsed()
  })
  // FE-AUD-001 / 1C L1：工作区与用户配置（Profile/Session）写盘失败可见（报告 1A.5/1C）
  const workspacePersistError = createZustandSignal(useWorkspaceStore, s => s.lastPersistError)
  const identityPersistError = createZustandSignal(useIdentityStore, s => s.lastPersistError)
  createEffect(() => {
    const message = workspacePersistError() ?? identityPersistError()
    const matcher = { action: '保存本地配置', scope: { kind: 'app' as const, id: 'persistence' } }
    if (!message) {
      resolveRuntimeErrors(matcher)
      return
    }
    reportRuntimeError('保存本地配置', new Error(message), undefined, {
      scope: matcher.scope,
      key: 'app:persistence',
      source: 'persistence',
    })
  })

  // keep-alive 槽位：以 id 串为键保实例（见文件头注）。收集 = 各槽位 kind 过滤后扁平。
  const keepAliveSheets = createMemo(() => {
    const all = sheets()
    return KEEP_ALIVE_SHEET_SLOT.flatMap(slot =>
      all.filter(sheet => sheet.kind === slot.kind).map(sheet => ({ slot, sheet })))
  })

  return (
    <>
    <Show when={!activeSheet()} keyed>
      {_empty => (
        <EmptyLayout ctx={ctx()} activeAgent={activeAgent()} ccEditMode={ccEditMode()} railLayout={props.railLayout} />
      )}
    </Show>
    <Show when={activeSheet()} fallback={null}>
      {sheet => (
        <div class={`layout ${ccEditMode() ? 'cc-editing-app' : ''}`} data-sidebar={leftColumnVisible() ? 'expanded' : 'collapsed'} data-pylon-surface="workspace" data-agent-id={activeAgent()}>
          <SheetSidebarSlot sheet={sheet()} ctx={activeSheetContext()} />
          <Show when={leftColumnVisible()}>
            <LeftRailResizeHandle maxWidth={props.railLayout?.leftMaxWidth} renderedWidth={props.railLayout?.leftWidth} />
          </Show>
          <Show when={sheet().kind !== 'agent' && sheet().kind !== 'file' && sheet().kind !== 'browser'}>
            <SheetHost sheet={sheet()} ctx={ctx()} />
          </Show>
          {/* keep-alive 槽位统一数据驱动（结构审查 A-V10）：哪些 kind 保活只有 KEEP_ALIVE_SHEET_SLOT
              一处真相；槽位各自的 class/data 属性是存量 DOM 契约（样式与测试按它定位），逐 kind 保留。
              browser 块改经 SheetHost 渲染——错误边界覆盖与其他保活 kind 对齐。
              G5（FE-AUD-006）：browser 保活语义不变——非活动态只隐藏 DOM，真正 close 才卸载。 */}
          <For each={keepAliveSheets().map(entry => entry.sheet.id)}>
            {id => {
              const entry = createMemo(() => keepAliveSheets().find(item => item.sheet.id === id)!)
              const active = createMemo(() => entry().sheet.id === activeSheetId())
              // Own the projection in this keep-alive slot. A conditional JSX
              // prop compiles to lazy memos that would otherwise be created
              // when native resize/timer callbacks read ctx outside an owner.
              const sheetContext = createMemo(() => {
                const current = entry()
                if (current.slot.kind === 'agent') return contextForAgentSheet(current.sheet)
                return current.slot.passIsActive ? { ...ctx(), isActive: active() } : ctx()
              })
              return (
                <div
                  class={entry().slot.className}
                  {...(entry().slot.kind === 'file' ? { 'data-file-sheet-id': id } : { 'data-sheet-id': id })}
                  aria-hidden={active() ? undefined : true}
                  style={{ display: active() ? 'contents' : 'none' }}
                >
                  <SheetHost
                    sheet={entry().sheet}
                    ctx={sheetContext()}
                  />
                </div>
              )
            }}
          </For>
          <RightRailHost sheet={sheet()} ctx={activeSheetContext()} activeAgent={activeAgent()} railLayout={props.railLayout} />
        </div>
      )}
    </Show>
    </>
  )
}
/**
 * 空态分支独立于 Show fallback（solid 1.9 的 fallback 不支持函数形态、JSX 元素形态会
 * 在组件体急切求值——OverviewSheetView 的挂载 effect 不能在未插入时就跑）。以 keyed
 * Show 的子回调实现惰性创建：仅在无 active sheet 时才实例化空态子树。
 */
function EmptyLayout(props: { ctx: SheetContext; activeAgent: string; ccEditMode: boolean; railLayout?: RailLayout }) {
  // W1-05：无 active sheet → 虚拟 overview 接管空态（不写入持久 sheet 数组）
  const registry = createRegistrySignal({ subscribe: subscribeWorkspaceRegistry }, getWorkspaceRegistrySnapshot)
  const overviewEntry = createMemo(() => {
    registry()
    return resolveSheetRender('overview')
  })
  return (
    <div class={`layout ${props.ccEditMode ? 'cc-editing-app' : ''}`} data-sidebar="collapsed" data-pylon-surface="workspace" data-agent-id={props.activeAgent}>
      <Show when={overviewEntry()} fallback={<EmptySheetHost />}>
        {entry => {
          const Overview = entry().component as Component<{ sheet: SheetRecord; ctx: SheetContext; state: unknown }>
          return <Overview sheet={VIRTUAL_OVERVIEW_SHEET} ctx={props.ctx} state={entry().deserialize(undefined)} />
        }}
      </Show>
      <RightRailHost sheet={null} ctx={props.ctx} activeAgent={props.activeAgent} railLayout={props.railLayout} />
    </div>
  )
}

/**
 * keep-alive 槽位表（结构审查 A-V10）——「哪些 sheet kind 保活」的唯一真相。
 * 旧实现是三段手写近似 JSX + 一条反向否定链；class/data 属性是存量 DOM 契约逐 kind 保留
 * （browser historic 名不带 -sheet、file 用 data-file-sheet-id）。passIsActive 仅 browser
 * 声明（原块语义）；file 维持原样不注入 isActive，agent 走 contextForAgentSheet 特化。
 */
const KEEP_ALIVE_SHEET_SLOT: readonly { kind: string; className: string; passIsActive?: boolean }[] = [
  { kind: 'agent', className: 'agent-sheet-keep-alive' },
  { kind: 'file', className: 'file-sheet-keep-alive' },
  { kind: 'browser', className: 'browser-keep-alive', passIsActive: true },
]

/** 虚拟 overview sheet（空态专用，不持久化） */
const VIRTUAL_OVERVIEW_SHEET: SheetRecord = {
  id: 'overview-virtual',
  kind: 'overview',
  title: 'Overview',
  createdAt: 0,
  lastFocusedAt: 0,
}

function EmptySheetHost() {
  return (
    <div class="sheet-empty-host">
      <div class="sheet-empty-kicker">WORKSPACE</div>
      <h2>没有打开的 Sheet</h2>
      <p>打开一个 Agent 工作现场，或从工具入口选择 Sheet。</p>
      <button type="button" onClick={() => useWorkspaceStore.getState().openSheet({ kind: 'overview', title: 'Overview' })}>
        打开 Overview
      </button>
    </div>
  )
}
