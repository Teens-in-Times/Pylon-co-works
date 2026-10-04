/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import SheetTabStrip from './SheetTabStrip.solid.tsx'
import { PluginContributionBody } from '../plugin-runtime/ui/PluginContributionBody.solid.tsx'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { useThemeStore } from '../domains/theme/themeStore'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import AgentStatusLights from '../components/AgentStatusLights.solid.tsx'
import type { SheetRecord } from './sheetTypes'
import { selectAgentStatus } from '../contracts/agentTypes'
import { LucideIcon } from '../components/LucideIcon.solid.tsx'
import type { InterfaceMode } from '../domains/interface/interfaceModeStore.ts'
import type { InterfaceModeChromeStyle } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { getCommandRegistry, getContextPanelRegistry, getInterfaceModeRegistry, getTitlebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import { selectContextPanels } from '../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore } from '../domains/workspace/layoutRailsStore.ts'
import { activateInterfaceMode } from '../application/transactions/activateInterfaceMode.ts'
import type { TitlebarContext, TitlebarRegistryEntry } from '../plugin-runtime/titlebar/titlebarTypes.ts'
import { resolveLaunchIcon } from './launchIcons.solid.tsx'
import { SETTINGS_DOMAINS, SETTINGS_DOMAIN_MENU_META, SETTINGS_DOMAIN_SHORT_LABELS, type SettingsDomainId } from '../components/settings/settingsDomains.ts'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'

export interface WorkspaceMenuActions {
  onTogglePin: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  onReopen: () => void
}

export interface WorkspaceTitlebarProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  activeSheetKind?: string
  activeSessionId?: string | null
  sidebarCollapsed: boolean
  /** active Sheet 是否真的会渲染左栏；无左栏时左格不占轨道、折叠按钮不出现。 */
  sidebarEnabled: boolean
  rightPanelEnabled?: boolean
  onToggleSidebar: () => void
  onFocusSheet: (id: string) => void
  onCloseSheet: (id: string) => void
  menuActions: WorkspaceMenuActions
  onOpenSheet: () => void
  onToggleRightPanel: () => void
  /** Open Settings directly at one of the four top-level domains：齿轮菜单里设置域项的唯一去处（幂等开/聚焦，ADR-0013）。 */
  onOpenSettingsDomain: (domain: SettingsDomainId) => void
  interfaceMode?: InterfaceMode
  chromeStyle?: InterfaceModeChromeStyle
  quickSwitchLabel?: string
  onToggleInterfaceMode?: () => void
  onMinimize(event: unknown): void
  onToggleFullscreen(event: unknown): void
  onCloseWindow(event: unknown): void
}

/** 右簇只有一个菜单：齿轮（界面 + 设置 + 插件项）。右栏的类型切换在右栏内部，标题栏不再有一份。 */
type WorkspaceMenuKind = 'app-menu'

let titlebarSequence = 0

/**
 * WorkspaceTitlebar — 标题栏（#279 第 3 梯队 Solid 化实体；与 React 版逐行为同构）。
 *
 * 插件贡献簇（app-actions）直连渲染（#515 岛退役，原 WorkspaceTitlebarPluginIsland
 * 已删；#520 S4-P1-5 分发块收进 PluginContributionBody）：command 贡献不进标题栏、
 * isolated-surface 挂 IsolatedPluginSurface、first-party 组件包边界 + Suspense——
 * 见 TitlebarPluginActions。
 * 其余全部 Solid：store 经 createZustandSignal 订阅，三个插件 registry 经
 * createRegistrySignal（快照引用等值）。
 */
export default function WorkspaceTitlebar(p: { latest: () => WorkspaceTitlebarProps }) {
  const value = p.latest
  const latest = () => untrack(value)

  const sheets = createMemo(() => value().sheets)
  const activeSheetId = createMemo(() => value().activeSheetId)
  const activeAgent = createMemo(() => value().activeAgent)
  const activeSheetKind = createMemo(() => value().activeSheetKind)
  const activeSessionId = createMemo(() => value().activeSessionId ?? null)
  const sidebarCollapsed = createMemo(() => value().sidebarCollapsed)
  const sidebarEnabled = createMemo(() => value().sidebarEnabled)
  const rightPanelEnabled = createMemo(() => value().rightPanelEnabled !== false)
  const interfaceMode = createMemo(() => value().interfaceMode ?? 'terminal-like')
  const chromeStyle = createMemo<InterfaceModeChromeStyle>(() => value().chromeStyle ?? (interfaceMode() === 'modern-gui' ? 'icons' : 'glyphs'))

  const agentStatuses = createZustandSignal(useRuntimeStore, s => s.agentStatuses)
  const showTabBar = createZustandSignal(useThemeStore, s => s.showTabBar !== false)
  // 「有最近关闭的 Sheet」只服务于**页签右键菜单**里的重开项：标题栏上那个重开按钮已删除
  // （能力没删——命令 `workspace.sheet.reopen` 与页签右键都还在）。
  const canReopenSheet = createZustandSignal(useWorkspaceStore, state => state.workspaceSheets.recentlyClosed.length > 0)
  const rightRailCollapsed = createZustandSignal(useRightRailStore, state => state.collapsed)

  const contextPanelRegistry = getContextPanelRegistry()
  const interfaceModeRegistry = getInterfaceModeRegistry()
  const titlebarRegistry = getTitlebarRegistry()
  const panelSnapshot = createRegistrySignal(contextPanelRegistry, () => contextPanelRegistry.getSnapshot())
  const modeSnapshot = createRegistrySignal(interfaceModeRegistry, () => interfaceModeRegistry.getSnapshot())
  const titlebarSnapshot = createRegistrySignal(titlebarRegistry, () => titlebarRegistry.getSnapshot())

  const [openMenu, setOpenMenu] = createSignal<WorkspaceMenuKind | null>(null)
  let menuElement: HTMLDivElement | undefined
  let menuTriggerElement: HTMLButtonElement | null = null
  let previousOpenMenu: WorkspaceMenuKind | null = null
  const titlebarId = `workspace-titlebar-${++titlebarSequence}`

  // TitlebarContext.settingsOpen 是插件 API 面（说明书「标题栏」节）：设置是否为活动 sheet，
  // 由 kind 派生——它只供插件 when 谓词读取，宿主自己不再据此锁标题栏交互（#195）。
  const settingsOpen = createMemo(() => activeSheetKind() === 'settings')
  const titlebarContext = createMemo<TitlebarContext>(() => ({
    interfaceMode: interfaceMode(),
    workspaceKind: activeSheetKind(),
    sheetId: activeSheetId(),
    settingsOpen: settingsOpen(),
  }))
  const contributedActions = createMemo(() => {
    const context = titlebarContext()
    return titlebarSnapshot().entries.filter(entry => {
      if (entry.value.slot !== 'app-actions') return false
      try { return entry.value.when?.(context) ?? true } catch { return false }
    })
  })
  const availablePanels = createMemo(() => selectContextPanels(panelSnapshot().entries, {
    workspaceKind: activeSheetKind(),
    sheetId: activeSheetId(),
    activeSessionId: activeSessionId(),
    activeAgent: activeAgent(),
  }))
  const rightPanelAvailable = createMemo(() => rightPanelEnabled() && availablePanels().length > 0)
  // 插件注册的齿轮菜单项（API 2.1）：数据化贡献，点了跑命令。
  const pluginMenuItems = createMemo(() => {
    const context = titlebarContext()
    return titlebarSnapshot().entries.flatMap(entry => {
      const contribution = entry.value
      if (contribution.slot !== 'app-menu' || contribution.renderKind !== 'command') return []
      try { return (contribution.when?.(context) ?? true) ? [contribution] : [] } catch { return [] }
    })
  })
  const runMenuCommand = (commandId: string) => {
    // 菜单项的命令可能属于已停用插件或因故不可执行——失败记账但不炸标题栏。
    void getCommandRegistry().execute(commandId).catch(error => {
      console.error('标题栏菜单命令执行失败', commandId, error)
    })
  }
  const menuId = (kind: WorkspaceMenuKind) => `${titlebarId}-menu-${kind}`
  const toggleMenu = (kind: WorkspaceMenuKind, trigger: HTMLButtonElement) => {
    menuTriggerElement = trigger
    setOpenMenu(current => current === kind ? null : kind)
  }
  const closeMenu = () => setOpenMenu(null)
  const menuItems = (menu: HTMLDivElement | null): HTMLButtonElement[] => menu
    ? [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')]
    : []
  const handleMenuKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const menu = event.currentTarget
    const items = menuItems(menu)
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowUp'
          ? (current <= 0 ? items.length - 1 : current - 1)
          : (current < 0 || current === items.length - 1 ? 0 : current + 1)
    items[next]?.focus()
  }
  createEffect(() => {
    const current = openMenu()
    const previousOpenMenuValue = previousOpenMenu
    if (current) {
      const menu = document.getElementById(`${titlebarId}-menu-${current}`)
      const selected = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ;(selected ?? menu?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'))?.focus()
    } else if (previousOpenMenuValue) {
      const trigger = menuTriggerElement
      if (trigger && document.contains(trigger)) trigger.focus()
    }
    previousOpenMenu = current
  })
  createEffect(() => {
    if (!openMenu()) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuElement && !menuElement.contains(event.target as Node)) setOpenMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpenMenu(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    })
  })

  // #515 岛退役：app-actions 插件贡献簇直连渲染（见 JSX 尾部 TitlebarPluginActions）。

  // #154：左格只在左列真的可见时占轨道——折叠后轨道宽度由
  // --sheet-sidebar-track-width 归零，整格不参与布局，于是既没有空列也没有悬空分割线。
  const sidebarExpanded = createMemo(() => sidebarEnabled() && !sidebarCollapsed())
  const sidebarToggleLabel = createMemo(() => sidebarCollapsed() ? '展开左栏' : '收起左栏')

  return (
    <header class={`workspace-titlebar ${sidebarExpanded() ? 'sidebar-expanded' : 'sidebar-collapsed'} ${sidebarEnabled() ? 'sidebar-enabled' : 'sidebar-disabled'}`} data-tauri-drag-region>
      <div class="workspace-titlebar-sidebar" data-tauri-drag-region>
        {/* 折叠按钮在最左、三灯在其右，顺序固定。它留在左格里的前提是左格折叠时**不收成 0**
            而是收窄到按钮宽度（标题栏 grid 第 1 列用 `max(轨道宽, 按钮宽)`），否则按钮会随
            轨道一起消失、位置也不再稳定。始终渲染（本 Sheet 无左栏时禁用），
            避免随 Sheet 能力忽隐忽现。 */}
        <button
          type="button"
          class="workspace-titlebar-icon workspace-sidebar-toggle"
          onClick={() => latest().onToggleSidebar()}
          disabled={!sidebarEnabled()}
          title={sidebarEnabled() ? sidebarToggleLabel() : '当前 Sheet 无侧栏'}
          aria-label={sidebarEnabled() ? sidebarToggleLabel() : '当前 Sheet 无侧栏'}
          aria-expanded={sidebarEnabled() ? sidebarExpanded() : undefined}
          data-sidebar-toggle="true"
        >
          {/* 图标表达「左栏在/不在」而不是汉堡菜单：☰ 会读成「打开菜单」。 */}
          <Show when={chromeStyle() === 'icons'} fallback={<span aria-hidden="true">{sidebarExpanded() ? '▤' : '▢'}</span>}>
            <Show when={sidebarExpanded()} fallback={<LucideIcon name="PanelLeftOpen" size={17} />}><LucideIcon name="PanelLeftClose" size={17} /></Show>
          </Show>
        </button>
        <Show when={sidebarExpanded()}>
          <span class="workspace-titlebar-brand" aria-label="Agent 状态">
            <AgentStatusLights status={selectAgentStatus(activeAgent(), activeAgent(), agentStatuses()).status} size={12} />
          </span>
        </Show>
      </div>

      <div class="workspace-titlebar-workspace">
        <Show when={showTabBar()}>
          <SheetTabStrip latest={() => ({
            sheets: sheets(),
            activeSheetId: activeSheetId(),
            activeAgent: activeAgent(),
            agentStatuses: agentStatuses(),
            onFocus: id => latest().onFocusSheet(id),
            onClose: id => latest().onCloseSheet(id),
            menuActions: latest().menuActions,
            canReopen: canReopenSheet(),
          })} />
        </Show>
        <div class="workspace-titlebar-launchers">
          {/* 新建 Sheet 是**浏览器式**的：紧贴最后一个页签右侧（页签区收缩到内容宽度，
              空档全部让给右侧拖拽区），不是被推到窗口右端。 */}
          <button type="button" class="workspace-titlebar-icon workspace-open-trigger" onClick={() => latest().onOpenSheet()} title="打开 Sheet" aria-label="打开 Sheet"><LucideIcon name="Plus" size={16} /></button>
        </div>
        <div class="workspace-titlebar-drag" data-tauri-drag-region />
      </div>

      <div class="workspace-window-controls" ref={element => { menuElement = element }}>
        <div class="workspace-window-app-controls">
          {/* 右栏按钮**只负责折叠**：类型切换在右栏内部（`.context-panel-tabs`），标题栏不再持有第二处
              切换入口。图标与左栏折叠钮同构，只是朝向镜像。 */}
          <button
            type="button"
            class="workspace-titlebar-icon workspace-right-rail-toggle"
            onClick={() => latest().onToggleRightPanel()}
            disabled={!rightPanelAvailable()}
            title={rightPanelAvailable() ? (rightRailCollapsed() ? '展开右侧栏' : '收起右侧栏') : '当前没有可用右侧栏'}
            aria-label={rightPanelAvailable() ? (rightRailCollapsed() ? '展开右侧栏' : '收起右侧栏') : '当前没有可用右侧栏'}
            aria-expanded={rightPanelAvailable() ? !rightRailCollapsed() : undefined}
            data-right-rail-toggle="true"
          >
            {/* 图标是**画出来的**面板符号（右侧一道实心条 = 右栏在），不是 `»` 箭头：
                箭头和窗口控制、以及右栏内部那个折叠钮撞脸，用户点名要「个别的图标」。 */}
            <Show when={chromeStyle() === 'icons'} fallback={<span class="workspace-rail-glyph" aria-hidden="true" />}>
              <Show when={rightRailCollapsed()} fallback={<LucideIcon name="PanelRightClose" size={17} />}><LucideIcon name="PanelRightOpen" size={17} /></Show>
            </Show>
          </button>
          <div class="workspace-titlebar-menu-anchor">
            <button
              type="button"
              class="workspace-titlebar-icon workspace-titlebar-menu-icon"
              onClick={event => toggleMenu('app-menu', event.currentTarget)}
              title="界面与设置"
              aria-label="界面与设置"
              aria-haspopup="menu"
              aria-expanded={openMenu() === 'app-menu'}
              aria-controls={menuId('app-menu')}
              data-menu-trigger="app-menu"
            >
              <Show when={chromeStyle() === 'icons'} fallback={<span aria-hidden="true">⚙</span>}><LucideIcon name="Settings" size={16} /></Show>
            </button>
            <Show when={openMenu() === 'app-menu'}>
              <div id={menuId('app-menu')} class="workspace-menu workspace-menu-chrome" role="menu" data-menu-kind="app-menu" onKeyDown={handleMenuKeyDown}>
                {/* 二级内容分三段：界面模式（radio）/ 设置域（跳转）/ 插件项（命令）。 */}
                <div class="workspace-menu-heading">界面模式</div>
                <For each={modeSnapshot().entries}>{entry => (
                  <button type="button" role="menuitemradio" aria-checked={entry.value.id === interfaceMode()} data-selected={entry.value.id === interfaceMode() ? 'true' : undefined} onClick={() => { try { const ok = activateInterfaceMode(entry.value.id); if (ok) closeMenu() } catch { /* activation failure is reported by the transaction */ } }}><span class="workspace-menu-check" aria-hidden="true">{entry.value.id === interfaceMode() ? '✓' : ''}</span><span>{entry.value.label}</span></button>
                )}</For>
                <span class="workspace-menu-separator" />
                <div class="workspace-menu-subheading">设置</div>
                <For each={SETTINGS_DOMAINS}>{domain => {
                  const meta = SETTINGS_DOMAIN_MENU_META[domain.id]
                  const label = SETTINGS_DOMAIN_SHORT_LABELS[domain.id]
                  return <button
                    type="button"
                    role="menuitem"
                    class="workspace-menu-domain-item"
                    aria-label={label}
                    title={`${domain.label}：${meta.description}`}
                    data-settings-domain={domain.id}
                    onClick={() => {
                      closeMenu()
                      latest().onOpenSettingsDomain(domain.id)
                    }}
                  >
                    <span class="workspace-menu-check workspace-menu-domain-glyph" aria-hidden="true">{meta.glyph}</span>
                    <span class="workspace-menu-item-copy"><strong>{label}</strong><small>{meta.description}</small></span>
                    <span class="workspace-menu-chevron" aria-hidden="true">›</span>
                  </button>
                }}</For>
                <Show when={pluginMenuItems().length > 0}>
                  <span class="workspace-menu-separator" />
                  <div class="workspace-menu-subheading">插件</div>
                  <For each={pluginMenuItems()}>{contribution => {
                    const ContributionIcon = resolveLaunchIcon(contribution.icon)
                    return <button
                      type="button"
                      role="menuitem"
                      class="workspace-menu-command-item"
                      title={contribution.label}
                      aria-label={contribution.label}
                      data-menu-command={contribution.commandId}
                      onClick={() => { closeMenu(); runMenuCommand(contribution.commandId) }}
                    >
                      <span class="workspace-menu-check workspace-menu-command-glyph" aria-hidden="true">{contribution.icon ? <ContributionIcon size={13} /> : ''}</span>
                      <span>{contribution.label}</span>
                    </button>
                  }}</For>
                </Show>
              </div>
            </Show>
          </div>
          <TitlebarPluginActions entries={contributedActions()} context={titlebarContext()} />
        </div>
        <span class="workspace-window-controls-divider" aria-hidden="true" />
        <div class="workspace-window-native-controls" aria-label="窗口控制">
          <button type="button" class="titlebar-window-btn titlebar-window-btn-start" onClick={event => latest().onMinimize(event)} title="最小化" aria-label="最小化"><LucideIcon name="Minus" size={14} /></button>
          <button type="button" class="titlebar-window-btn" onClick={event => latest().onToggleFullscreen(event)} title="最大化或还原" aria-label="最大化或还原"><LucideIcon name="Square" size={12} /></button>
          <button type="button" class="titlebar-window-btn close" onClick={event => latest().onCloseWindow(event)} title="关闭" aria-label="关闭窗口"><LucideIcon name="X" size={15} /></button>
        </div>
      </div>
    </header>
  )
}

/**
 * TitlebarPluginActions — app-actions 插件贡献簇（#515 岛退役：原 React 岛
 * WorkspaceTitlebarPluginIsland 直连化；#520 S4-P1-5 起分发块收进
 * PluginContributionBody——command 菜单项不进标题栏的守卫留在宿主，isolated /
 * first-party 分支、边界与 Suspense 全部由 body 承载；DOM 契约逐项保留——
 * isolated-surface 挂 workspace-titlebar-plugin-action）。
 */
function TitlebarPluginActions(props: { entries: TitlebarRegistryEntry[]; context: TitlebarContext }) {
  return (
    <For each={props.entries}>{entry => {
      const contribution = entry.value
      // 菜单项不进标题栏按钮簇：它是数据化贡献，渲染在齿轮菜单里。
      if (contribution.renderKind === 'command') return null
      return (
        <PluginContributionBody
          contributionId={entry.contributionId}
          contribution={contribution}
          surfaceClass="workspace-titlebar-plugin-action"
          surfaceInput={() => ({ titlebarContext: props.context })}
          componentProps={() => ({ context: props.context })}
        />
      )
    }}</For>
  )
}
