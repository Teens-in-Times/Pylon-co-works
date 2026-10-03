/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { LucideIcon } from './LucideIcon.solid.tsx'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'

import type { SheetContext } from '../workspace-sheets/sheetTypes'
import type { LaunchIconKey } from '../workspace-sheets/launchIconKeys.ts'
import { getAgentSidebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import type { AgentSidebarContribution } from '../plugin-runtime/sidebar/sidebarTypes.ts'
import type { AgentSidebarSurfaceInput } from '../plugin-runtime/sidebar/sidebarSurfaceProtocol.ts'
import {
  isBlockCollapsed,
  isBlockPageOpen,
  normalizePageState,
  openBlockPage,
  resolveBlockCollapsible,
  resolveTitleAction,
  shouldShowOpenPageAction,
  toggleBlockCollapsed,
} from '../plugin-runtime/sidebar/sidebarBlockState.ts'
import {
  applyModulePrefs,
  sidebarModulePrefsStore,
} from '../domains/appearance/sidebarModulePrefs.ts'
import { sidebarBlockCollapseStore } from '../domains/appearance/sidebarBlockCollapse.ts'
import { PluginContributionBody } from '../plugin-runtime/ui/PluginContributionBody.solid.tsx'
import { createSidebarDragReorder } from './sidebar/createSidebarDragReorder.ts'
import {
  createAgentSidebarSharedProps,
  projectAgentSidebarSurfaceInput,
} from './sidebar/useSidebarContributionProps.ts'

// ---- 插件贡献体（#515 岛退役）：贡献组件是 **Solid 组件**，宿主直连渲染。 ----

/**
 * 稳定图标键 → LucideIcon 具名的映射（launchIcons.tsx 的 LAUNCH_ICONS 同键表，
 * Solid 侧渲染走 LucideIcon.solid；键集与 launchIconKeys.ts 编译期穷举，漂移会在此
 * 表缺失时安全降级为 SquareStack）。
 */
const LAUNCH_ICON_NAMES: Readonly<Record<LaunchIconKey, string>> = {
  activity: 'Activity',
  'book-open': 'BookOpen',
  agent: 'Bot',
  boxes: 'Boxes',
  clock: 'Clock',
  'folder-tree': 'FolderTree',
  globe: 'Globe',
  history: 'History',
  'layout-dashboard': 'LayoutDashboard',
  messages: 'MessageSquare',
  plus: 'Plus',
  search: 'Search',
  settings: 'Settings',
  sliders: 'SlidersHorizontal',
  waypoints: 'Waypoints',
}

const launchIconName = (icon?: string): string | null =>
  (icon && (LAUNCH_ICON_NAMES as Readonly<Record<string, string>>)[icon]) || (icon ? 'SquareStack' : null)

type BlockActionHandler = (actionId: string) => void

/** 自动补的「打开整页」动作 id——贡献自己的动作 id 不得与它冲突（注册期不校验，宿主这里避开即可）。 */
const OPEN_PAGE_ACTION = '__open_page__'

export interface SidebarProps {
  ctx: SheetContext
  state?: unknown
  sheet?: { id: string }
}

/**
 * Agent Sheet 左栏。
 *
 * 左栏是**一个有序的模块栈**：会话就是其中一个模块（声明 `alwaysOpen`，因此不可折叠、
 * 不可隐藏、默认排在最后），与插件注册的模块走同一条路——同一套图标、点击语义、
 * 拖拽重排与显隐设置，不为会话开特例。
 *
 * **模块外壳（标题 + 折叠钮 + 头部动作 + 拖拽手柄）归宿主渲染，贡献只画内容。**
 * 标题的唯一来源是贡献声明的 `label`。
 *
 * 点击语义由贡献声明（`onTitleClick`）：`expand` 时标题展开/折叠，若同时声明了 `page`，
 * 宿主在头部自动补一个「打开」按钮（用户所说「都要」）；`page` 时标题进入主区整页，
 * 折叠改由独立折叠钮负责。
 *
 * **折叠/展开是跨 Sheet 的应用级偏好**（`sidebarBlockCollapseStore`，独立持久化 key）：
 * 任意 Sheet 里收起/展开某模块，切到别的 Sheet、乃至重启应用都不改变（issue #202）。
 * 整页（`activePageId`）则相反——它是「这张 Sheet 的主区此刻显示什么」，留在 Sheet 级。
 *
 * #515：Solid 实体——偏好 store 经注册表信号订阅；first-party 贡献体为 Solid 组件
 * 经 PluginContributionBody 直挂（isolated 贡献走 IsolatedPluginSurface）。#520 S4-P1-4：
 * 贡献 props 接线恢复共享工厂 `createAgentSidebarSharedProps`（与 AgentSheetPageHost
 * 同源）；S4-P1-5：贡献体分发统一走 PluginContributionBody。DOM/aria/data-* 契约：
 * aside.sidebar.agent-sidebar > div.sidebar-modules[role=list] > section.sidebar-block
 * [data-module-id][data-collapsed]，模块外壳（.sidebar-block-head 等）归宿主渲染，
 * 贡献只画 .sidebar-block-body-inner。
 */
export default function Sidebar(props: SidebarProps) {
  const pageState = createMemo(() => normalizePageState(props.state))
  // 折叠/显隐偏好是框架无关外部 store：原 useSyncExternalStore 订阅内联为注册表信号。
  const collapsedMap = createRegistrySignal(sidebarBlockCollapseStore, () => sidebarBlockCollapseStore.getSnapshot())
  const modulePrefs = createRegistrySignal(sidebarModulePrefsStore, () => sidebarModulePrefsStore.getSnapshot())
  const profiles = createZustandSignal(useIdentityStore, s => s.profiles)
  const activeProfileId = createZustandSignal(useIdentityStore, s => s.activeProfileId)
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const sharedProps = createAgentSidebarSharedProps(props.ctx)

  const sidebarRegistry = getAgentSidebarRegistry()
  const sidebarSnapshot = createRegistrySignal(sidebarRegistry, () => sidebarRegistry.getSnapshot())

  // 模块头动作：头部由宿主渲染，语义在贡献组件里。贡献在挂载期把处理器注册回来，
  // 宿主持有 ref 并在点击时调用。隔离表面走不了这条路（它是独立文档），改为把请求
  // 塞进 `input`，靠既有的 `host:input` 重放通道送达。
  const actionHandlers = new Map<string, BlockActionHandler>()
  const [pendingSurfaceAction, setPendingSurfaceAction] = createSignal<{ contributionId: string; actionId: string; nonce: number } | null>(null)
  let surfaceActionNonce = 0

  const modules = createMemo(() => {
    const visible = applyModulePrefs(
      sidebarSnapshot().entries.map(entry => entry.value),
      modulePrefs(),
    )
    return visible.filter(contribution => contribution.when?.({ activeAgentId: activeAgent(), activeSessionId: props.ctx.activeSession }) ?? true)
  })

  // ── 拖拽重排（状态机见 createSidebarDragReorder，#520 S3-P1-5）──
  // 拖拽期间只改**渲染次序**（预览），抬起才落库——与左栏调宽同一取舍：每帧写
  // localStorage 没有意义，而 live 预览是拖拽体感的关键。
  const dragReorder = createSidebarDragReorder({
    moduleIds: () => modules().map(contribution => contribution.id),
    pinnedStart: () => {
      const index = modules().findIndex(contribution => contribution.alwaysOpen === true)
      return index < 0 ? modules().length : index
    },
    // 钉住的常驻模块不拖：它能去哪儿？钉区之上的位置对它没有意义，又会让「会话永远在最后」失效。
    isPinned: contributionId => modules().find(contribution => contribution.id === contributionId)?.alwaysOpen === true,
    commitOrder: next => sidebarModulePrefsStore.setPrefs({ order: [...next], hidden: modulePrefs().hidden }),
  })
  const drag = dragReorder.drag
  const dropIndex = dragReorder.dropIndex

  // 折叠写全局 store（跨 Sheet 共享 + 独立持久化）；整页写 Sheet 级状态。
  const toggleBlock = (contribution: AgentSidebarContribution) => {
    sidebarBlockCollapseStore.setCollapseMap(toggleBlockCollapsed(contribution, collapsedMap()))
  }

  const openPage = (contribution: AgentSidebarContribution) => {
    if (!props.sheet) return
    const next = openBlockPage(contribution, pageState())
    useWorkspaceStore.getState().patchSheetState(props.sheet.id, { activePageId: next.activePageId })
  }

  const dispatchBlockAction = (contribution: AgentSidebarContribution, actionId: string) => {
    if (actionId === OPEN_PAGE_ACTION) { openPage(contribution); return }
    if (contribution.renderKind === 'isolated-surface') {
      surfaceActionNonce += 1
      setPendingSurfaceAction({ contributionId: contribution.id, actionId, nonce: surfaceActionNonce })
      return
    }
    actionHandlers.get(contribution.id)?.(actionId)
  }

  const renderBlock = (contribution: AgentSidebarContribution) => {
    const contributionId = contribution.id
    const collapsible = () => resolveBlockCollapsible(contribution)
    const collapsed = () => isBlockCollapsed(contribution, collapsedMap())
    const pageOpen = () => isBlockPageOpen(contribution, pageState())
    const titleAction = resolveTitleAction(contribution)
    const streamedAction = () => pendingSurfaceAction()?.contributionId === contributionId ? pendingSurfaceAction() : null
    const openPageAction = shouldShowOpenPageAction(contribution)

    const surfaceInput = (): AgentSidebarSurfaceInput => projectAgentSidebarSurfaceInput(sharedProps(), {
      presentation: 'block',
      collapsed: collapsed(),
      pageOpen: pageOpen(),
      blockAction: streamedAction() ? { actionId: streamedAction()!.actionId, nonce: streamedAction()!.nonce } : null,
    })

    // 贡献体直连渲染（#515 岛退役）：共享 props / 折叠态 / wire 输入经细粒度响应直通
    // 贡献组件；错误边界 + Suspense 语义收进 PluginContributionBody（#520 S4-P1-5）。
    const contributionProps = () => ({
      ...sharedProps(),
      presentation: 'block' as const,
      collapsed: collapsed(),
      onBlockAction: () => {},
      registerBlockActionHandler: (handler: ((actionId: string) => void) | null) => {
        if (handler) actionHandlers.set(contributionId, handler)
        else actionHandlers.delete(contributionId)
      },
    })
    const onSurfaceEvent = (event: string, detail: unknown) => {
      const shared = sharedProps()
      if (event === 'host:select-session' && typeof detail === 'string') shared.onSelectSession(detail)
      if (event === 'host:create-loose-session') shared.onCreateLooseSession()
      if (event === 'host:create-workspace-session' && typeof detail === 'string') shared.onCreateWorkspaceSession(detail)
      if (event === 'host:open-session-settings' && typeof detail === 'string') shared.onOpenSessionSettings(detail)
    }
    const body = () => (
      <PluginContributionBody
        contributionId={contributionId}
        contribution={contribution}
        surfaceClass="sidebar-block-body-surface"
        surfaceInput={surfaceInput}
        onSurfaceEvent={onSurfaceEvent}
        componentProps={contributionProps}
      />
    )

    const iconName = launchIconName(contribution.icon)
    const dragging = () => drag()?.id === contributionId

    return (
      <section
        class="sidebar-block"
        data-module-id={contributionId}
        data-collapsed={collapsed() ? 'true' : 'false'}
        data-page-open={pageOpen() ? 'true' : 'false'}
        data-always-open={contribution.alwaysOpen === true ? 'true' : 'false'}
        data-dragging={dragging() ? 'true' : 'false'}
        aria-label={contribution.label}
      >
        <div
          class="sidebar-block-head"
          title={contribution.alwaysOpen === true ? '常驻模块固定在栈底' : '长按可拖动调整模块次序'}
          onPointerDown={event => dragReorder.onHeadPointerDown(event, contributionId)}
          onPointerMove={dragReorder.onHeadPointerMove}
          onPointerLeave={dragReorder.onHeadPointerLeave}
          onPointerUp={dragReorder.endDrag}
          onPointerCancel={dragReorder.endDrag}
        >
          <button
            class="sidebar-block-toggle"
            type="button"
            aria-pressed={titleAction === 'page' ? pageOpen() : undefined}
            aria-expanded={titleAction === 'expand' && collapsible() ? (collapsed() ? 'false' : 'true') : undefined}
            onClick={() => {
              // 拖拽抬起那一下会补一个 click；不吞掉就会连带展开/进页面。
              if (dragReorder.suppressClick()) return
              if (titleAction === 'page') openPage(contribution)
              else if (collapsible()) toggleBlock(contribution)
            }}
          >
            <Show when={iconName}>
              <span class="sidebar-block-icon" aria-hidden="true"><LucideIcon name={iconName!} size={13} /></span>
            </Show>
            <span class="sidebar-block-title">{contribution.label}</span>
          </button>
          {/* 标题被「进入页面」占用时，折叠必须另给一个控件。 */}
          <Show when={collapsible() && titleAction === 'page'}>
            <button
              class="sidebar-block-collapse"
              type="button"
              aria-expanded={collapsed() ? 'false' : 'true'}
              aria-label={`${collapsed() ? '展开' : '折叠'} ${contribution.label}`}
              onClick={() => toggleBlock(contribution)}
            >
              <LucideIcon name="ChevronsUpDown" size={12} />
            </button>
          </Show>
          <div class="sidebar-block-actions">
            <Show when={openPageAction}>
              <button
                class="sidebar-block-action"
                type="button"
                title={`打开 ${contribution.label} 页面`}
                aria-label={`打开 ${contribution.label} 页面`}
                onClick={() => dispatchBlockAction(contribution, OPEN_PAGE_ACTION)}
              >
                <LucideIcon name="ChevronsUpDown" size={13} />
                <span>打开</span>
              </button>
            </Show>
            <For each={contribution.headerActions ?? []}>{action => (
              <button
                class="sidebar-block-action"
                type="button"
                disabled={action.disabled}
                title={action.title ?? action.label}
                aria-label={action.title ?? action.label}
                onClick={() => dispatchBlockAction(contribution, action.id)}
              >
                <Show when={action.icon}><LucideIcon name={launchIconName(action.icon) ?? 'SquareStack'} size={13} /></Show>
                <span>{action.label}</span>
              </button>
            )}</For>
          </div>
        </div>
        {/* body **常驻**，折叠靠 CSS 把行高收到 0（`grid-template-rows: 1fr → 0fr` + 淡出），
            于是展开/折叠有过渡——此前是「折叠即卸载」，动作是瞬跳的，而同一栏里的工作区组
            早就有收起动画（用户：「折叠动效…只有部分地方有」）。
            折叠时必须 `inert`：高度 0 挡不住键盘焦点，本仓踩过「宽度 0 的按钮照样 focusable」。
            副作用是贡献在折叠期间保持挂载——与右栏「折叠不卸载面板」同一取舍，模块内状态
            （如搜索词）因此跨折叠保留。 */}
        <div class="sidebar-block-body" ref={el => createEffect(() => {
          // inert 是属性而非 DOM property（jsdom 的 property 不反射）：折叠置 inert、
          // 展开移除——契约由 Sidebar.blocks.solid.test 的 hasAttribute 断言锁定。
          if (collapsed()) el.setAttribute('inert', '')
          else el.removeAttribute('inert')
        })}>
          <div class="sidebar-block-body-inner">{body()}</div>
        </div>
      </section>
    )
  }

  // #154：本组件提供左栏内容；外壳挂共享几何类 .sidebar（宽度/竖直分割线/折叠可见性
  // 全归布局层，各 Sheet 不得自带宽度或边框）。
  return (
    <aside class="sidebar agent-sidebar">
      {/* 单一滚动容器：各模块都是内容高度，整栈一起滚。这样「模块」只有一种形状，
          会话不再是「另一个会自己滚动的分区」。 */}
      <div class="sidebar-modules" role="list">
        <For each={modules()}>{(contribution, index) => (
          <>
            <Show when={drag() && dropIndex() === index()}>
              <div class="sidebar-modules-drop" aria-hidden="true" />
            </Show>
            {renderBlock(contribution)}
          </>
        )}</For>
        <Show when={drag() && dropIndex() === modules().length}>
          <div class="sidebar-modules-drop" aria-hidden="true" />
        </Show>
        <Show when={modules().length === 0}>
          <div class="session-empty">暂无模块</div>
        </Show>
      </div>

      <div class="profile-bar">
        <div class="profile-list flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Profiles">
          <For each={profiles()}>{p => (
            <button class={`profile-avatar ${p.id === activeProfileId() ? 'active' : ''}`}
              type="button" title={p.name} aria-label={p.name} aria-pressed={p.id === activeProfileId()}
              onClick={() => useIdentityStore.getState().setActiveProfile(p.id)}>
              <Show when={p.avatar} fallback={<>{p.name[0]}</>}>
                <img src={p.avatar} alt={p.name} />
              </Show>
            </button>
          )}</For>
        </div>
        <button type="button" class="profile-edit" title="编辑当前 Profile" aria-label="编辑当前 Profile" onClick={() => props.ctx.openProfileEdit()}><LucideIcon name="SlidersHorizontal" size={15} /></button>
      </div>
    </aside>
  )
}
