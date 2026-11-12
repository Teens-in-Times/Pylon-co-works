/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import { Portal } from 'solid-js/web'
import { LucideIcon } from '../components/LucideIcon.solid.tsx'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import { activateAgentSheet } from './activateAgentSheet'
import { selectAgentStatus, type AgentStatus } from '../contracts/agentTypes'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'

import type { SheetRecord } from './sheetTypes'
import WorkspaceMenu, { type WorkspaceMenuActions } from './WorkspaceMenu.solid.tsx'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'

export interface SheetTabStripProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  /** Agent 状态仅保留语义/无障碍信息，不再渲染可见圆点。 */
  agentStatuses?: Record<string, AgentStatus>
  onFocus: (id: string) => void
  onClose: (id: string) => void
  menuActions: WorkspaceMenuActions
  canReopen: boolean
}

function resolveSheetTitle(
  sheet: SheetRecord,
  agents: { id: string; name: string }[],
  profiles: { id: string; name: string }[],
  activeAgent: string,
  activeProfileId: string,
  sheetAgentStates: Record<string, { activeProfileId?: string }>,
) {
  if (sheet.kind !== 'agent' || !sheet.agentId) return sheet.title
  const agentName = agents.find(agent => agent.id === sheet.agentId)?.name || sheet.title || sheet.agentId
  const profileId = sheetAgentStates[sheet.agentId]?.activeProfileId
    || (sheet.agentId === activeAgent ? activeProfileId : '')
  const profileName = profiles.find(profile => profile.id === profileId)?.name || profileId || 'default'
  return `${agentName}\\${profileName}`
}

/** SheetTabStrip — 页签条（#279 第 3 梯队 Solid 化实体）。 */
export default function SheetTabStrip(p: { latest: () => SheetTabStripProps }) {
  const value = p.latest
  // 事件回调/异步路径取最新 props（untrack：不把 props 信号泄进依赖集）。
  const latest = () => untrack(value)

  const sheets = createMemo(() => value().sheets)
  const activeSheetId = createMemo(() => value().activeSheetId)
  const activeAgent = createMemo(() => value().activeAgent)
  const agentStatuses = createMemo(() => value().agentStatuses ?? {})
  const canReopen = createMemo(() => value().canReopen)

  const agents = createZustandSignal(useIdentityStore, state => state.agents)
  const profiles = createZustandSignal(useIdentityStore, state => state.profiles)
  const activeProfileId = createZustandSignal(useIdentityStore, state => state.activeProfileId)
  const sheetAgentStates = createZustandSignal(useWorkspaceStore, state => state.sheetAgentStates)
  const modernGui = createZustandSignal(useInterfaceModeStore, state => state.interfaceMode === 'modern-gui')

  const tabRefs = new Map<string, HTMLDivElement>()
  let stripElement: HTMLDivElement | undefined
  let regionElement: HTMLDivElement | undefined
  let overflowMenuElement: HTMLDivElement | undefined
  let switchingSheetRef: string | null = null
  const [switchingSheetId, setSwitchingSheetId] = createSignal<string | null>(null)
  const [menuSheetId, setMenuSheetId] = createSignal<string | null>(null)
  const [menuPosition, setMenuPosition] = createSignal<{ x: number; y: number } | null>(null)
  const [visibleCount, setVisibleCount] = createSignal(sheets().length)
  const [overflowMenuOpen, setOverflowMenuOpen] = createSignal(false)
  const [overflowMenuPosition, setOverflowMenuPosition] = createSignal({ top: 0, right: 0 })
  // 稳定回调：避免菜单打开期间父组件重渲染导致 document 监听反复重绑
  const onCloseMenu = () => {
    setMenuSheetId(null)
    setMenuPosition(null)
  }

  /**
   * 装得下几个页签。
   *
   * 页签先按 flex **自动压缩**（CSS：基准宽度 → 最小宽度）；压到最小仍装不下时**不滚动**，
   * 而是把装不下的收进「···」选单——否则容器右缘会留一个被切掉一半的页签（用户两次实机
   * 点名「有 sheet 被截断」）。
   *
   * 可用宽度取**标题栏中格**减去启动器与拖拽区的最小宽，而不是页签区自己的宽度：页签区是
   * 按内容撑开的（`flex:0 1 auto`），拿它自己当尺子会形成「内容决定尺子、尺子决定内容」的
   * 自指。中格宽度只由栅格与窗口决定，与渲染多少个页签无关，所以这里没有反馈环。
   *
   * 最小宽度等常量从 CSS 自定义属性读（`--sheet-tab-min-width` 等），避免 JS 里再抄一份
   * 与样式表各说各话。量不到宽度时（首帧、jsdom）一律按「全放得下」处理，不做假定。
   */
  const measureFit = () => {
    const region = regionElement
    const strip = stripElement
    const cell = region?.parentElement
    if (!region || !strip || !cell) return
    const stripStyle = getComputedStyle(strip)
    const number = (value: string, fallback: number) => {
      const parsed = Number.parseFloat(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const gap = number(stripStyle.columnGap || stripStyle.gap, 0)
    const baseMin = number(stripStyle.getPropertyValue('--sheet-tab-min-width'), 96)
    const agentMin = number(stripStyle.getPropertyValue('--sheet-tab-agent-min-width'), baseMin)
    const triggerWidth = number(getComputedStyle(region).getPropertyValue('--sheet-tab-overflow-trigger-width'), 32)
    const launchersWidth = cell.querySelector('.workspace-titlebar-launchers')?.getBoundingClientRect().width ?? 0
    const drag = cell.querySelector('.workspace-titlebar-drag')
    const dragMin = drag ? number(getComputedStyle(drag).minWidth, 18) : 18
    const available = cell.clientWidth - launchersWidth - dragMin
    if (!(available > 0)) { setVisibleCount(sheets().length); return }
    const minOf = (sheet: SheetRecord) => sheet.kind === 'agent' ? agentMin : baseMin
    const currentSheets = sheets()
    const needed = currentSheets.reduce((sum, sheet, index) => sum + minOf(sheet) + (index > 0 ? gap : 0), 0)
    if (needed <= available) { setVisibleCount(currentSheets.length); return }
    const budget = available - triggerWidth
    let used = 0
    let count = 0
    for (const sheet of currentSheets) {
      const next = used + minOf(sheet) + (count > 0 ? gap : 0)
      if (next > budget) break
      used = next
      count += 1
    }
    // 至少留一个：极窄窗口下宁可压缩一个页签，也不留一个空壳子。
    setVisibleCount(Math.max(1, count))
  }

  createEffect(() => {
    // sheets 集合变化 → 重新量测；容器尺寸变化走 ResizeObserver。
    sheets()
    measureFit()
    const cell = regionElement?.parentElement
    const observer = typeof ResizeObserver === 'undefined' || !cell ? null : new ResizeObserver(measureFit)
    if (cell) observer?.observe(cell)
    window.addEventListener('resize', measureFit)
    onCleanup(() => {
      observer?.disconnect()
      window.removeEventListener('resize', measureFit)
    })
  })

  createEffect(() => {
    if (!overflowMenuOpen()) return
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node
      if (!regionElement?.contains(target) && !overflowMenuElement?.contains(target)) setOverflowMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverflowMenuOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    onCleanup(() => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
    })
  })

  const focusSheet = async (sheet: SheetRecord): Promise<boolean> => {
    const targetAgentId = sheet.kind === 'agent' ? sheet.agentId : undefined
    if (!targetAgentId) {
      latest().onFocus(sheet.id)
      return true
    }
    if (switchingSheetRef) return false

    switchingSheetRef = sheet.id
    setSwitchingSheetId(sheet.id)
    const agentName = agents().find(agent => agent.id === targetAgentId)?.name || sheet.title || targetAgentId
    const activated = await activateAgentSheet(targetAgentId, agentName, () => latest().onFocus(sheet.id))
    switchingSheetRef = null
    setSwitchingSheetId(null)
    return activated
  }

  const moveFocus = (sheetId: string, direction: -1 | 1) => {
    const currentSheets = sheets()
    const index = currentSheets.findIndex(sheet => sheet.id === sheetId)
    if (index < 0 || currentSheets.length < 2) return
    const next = currentSheets[(index + direction + currentSheets.length) % currentSheets.length]
    void focusSheet(next).then(focused => {
      if (focused) requestAnimationFrame(() => tabRefs.get(next.id)?.querySelector<HTMLButtonElement>('.sheet-tab-focus')?.focus())
    })
  }

  /**
   * 渲染窗口：默认从头开始；**活动页签一旦落在窗口之外，窗口整体平移把它带进来**
   * （否则切到被收起的页签时，标题栏上看不到当前是谁）。
   */
  const windowStart = createMemo(() => {
    if (visibleCount() >= sheets().length) return 0
    const activeIndex = sheets().findIndex(sheet => sheet.id === activeSheetId())
    return activeIndex >= visibleCount() ? activeIndex - visibleCount() + 1 : 0
  })
  const shownSheets = createMemo(() => sheets().slice(windowStart(), windowStart() + visibleCount()))
  const overflowed = createMemo(() => shownSheets().length < sheets().length)

  return (
    <div ref={element => { regionElement = element }} class={`sheet-tab-region ${overflowed() ? 'overflowed' : ''}`}>
    <div ref={element => { stripElement = element }} class="sheet-tab-strip" role="tablist" aria-label="Workspace Sheets">
      <For each={shownSheets()}>{sheet => {
        // 行内派生值一律访问器：activeSheetId/agents 等 变化时逐行重算（React 版按渲染
        // 重算的语义在这里由信号粒度承担，避免整行重挂）。
        const active = () => sheet.id === activeSheetId()
        const agentState = () => sheet.kind === 'agent' && sheet.agentId
          ? selectAgentStatus(sheet.agentId, activeAgent(), agentStatuses()).status
          : undefined
        const displayTitle = () => resolveSheetTitle(sheet, agents(), profiles(), activeAgent(), activeProfileId(), sheetAgentStates())
        onCleanup(() => tabRefs.delete(sheet.id))
        return (
          <div
            ref={node => { tabRefs.set(sheet.id, node) }}
            class={`sheet-tab ${active() ? 'active' : ''}`}
            data-kind={sheet.kind}
            data-agent-state={agentState()}

            role="presentation"
            onContextMenu={event => {
              event.preventDefault()
              const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0
              const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0
              setMenuPosition({
                x: Math.max(0, Math.min(event.clientX, viewportWidth - 210)),
                y: Math.max(0, Math.min(event.clientY, viewportHeight - 160)),
              })
              setMenuSheetId(sheet.id)
            }}
          >
            <button
              type="button"
              class="sheet-tab-focus"
              role="tab"
              aria-selected={active()}
              aria-busy={switchingSheetId() === sheet.id}
              disabled={switchingSheetId() === sheet.id}
              tabIndex={active() ? 0 : -1}
              onClick={() => { void focusSheet(sheet) }}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault()
                  moveFocus(sheet.id, -1)
                } else if (event.key === 'ArrowRight') {
                  event.preventDefault()
                  moveFocus(sheet.id, 1)
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  const target = event.key === 'Home' ? sheets()[0] : sheets().at(-1)
                  if (target) void focusSheet(target).then(focused => {
                    if (focused) requestAnimationFrame(() => tabRefs.get(target.id)?.querySelector<HTMLButtonElement>('.sheet-tab-focus')?.focus())
                  })
                } else if ((event.key === 'Delete' || event.key === 'Backspace') && !sheet.pinned) {
                  event.preventDefault()
                  latest().onClose(sheet.id)
                }
              }}
              title={displayTitle()}
            >
              <SheetKindMark kind={sheet.kind} modern={modernGui()} />
              <span class="sheet-tab-title">{displayTitle()}</span>
              <Show when={agentState()}><span class="sr-only" aria-label={`Agent 状态：${agentState()}`} /></Show>

            </button>
            <Show when={!sheet.pinned}>
              <button
                type="button"
                class="sheet-tab-close"
                onClick={event => {
                  event.stopPropagation()
                  latest().onClose(sheet.id)
                }}
                title={`关闭 ${sheet.title}`}
                aria-label={`关闭 ${sheet.title}`}
              >
                {modernGui() ? <LucideIcon name="X" size={13} aria-hidden="true" /> : '×'}
              </button>
            </Show>
          </div>
        )
      }}</For>
      <WorkspaceMenu
        {...latest().menuActions}
        sheet={sheets().find(sheet => sheet.id === menuSheetId()) || null}
        canReopen={canReopen()}
        open={menuSheetId() !== null}
        onCloseMenu={onCloseMenu}
        className="workspace-menu-tab-context"
        position={menuPosition()}
      />
    </div>
    <Show when={overflowed()}>
      <button type="button" class="sheet-tab-overflow-trigger" aria-label="显示所有 Sheet" aria-expanded={overflowMenuOpen()} onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        setOverflowMenuPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) })
        setOverflowMenuOpen(open => !open)
      }}><LucideIcon name="MoreHorizontal" size={17} /></button>
    </Show>
    <Show when={overflowMenuOpen()}>
      <Portal>
        <div ref={element => { overflowMenuElement = element }} class="sheet-tab-overflow-menu" role="menu" aria-label="所有 Sheet" style={{ top: `${overflowMenuPosition().top}px`, right: `${overflowMenuPosition().right}px` }}>
          <For each={sheets()}>{sheet => {
            const displayTitle = () => resolveSheetTitle(sheet, agents(), profiles(), activeAgent(), activeProfileId(), sheetAgentStates())
            return <button type="button" role="menuitem" class={sheet.id === activeSheetId() ? 'active' : ''} onClick={() => {
              setOverflowMenuOpen(false)
              void focusSheet(sheet)
            }}><SheetKindMark kind={sheet.kind} modern={modernGui()} /><span>{displayTitle()}</span></button>
          }}</For>
        </div>
      </Portal>
    </Show>
    </div>
  )
}

function SheetKindMark(props: { kind: string; modern: boolean }) {
  // 审查 P2-2 修正：组件体早返回会在 untrack 语境单次读 props.modern（编译为 getter，
  // 读一次即冻结）——模式切换时 kind-mark 不随更新。改 Show 让分支随信号重算。
  const iconName = () => props.kind === 'agent' ? 'Bot'
    : props.kind === 'overview' ? 'LayoutDashboard'
      : props.kind === 'file' ? 'FileCode2'
        : props.kind === 'search' ? 'Search'
          : props.kind === 'history' ? 'History'
            : props.kind === 'browser' ? 'Globe2'
              : props.kind === 'runtime' ? 'Activity'
                : props.kind === 'gateway' ? 'Network'
                  : 'Puzzle'
  return (
    <Show when={props.modern} fallback={<span class="sheet-tab-kind-mark" aria-hidden="true" />}>
      <span class="sheet-tab-kind-mark sheet-tab-kind-icon" aria-hidden="true"><LucideIcon name={iconName()} size={14} strokeWidth={1.8} /></span>
    </Show>
  )
}
