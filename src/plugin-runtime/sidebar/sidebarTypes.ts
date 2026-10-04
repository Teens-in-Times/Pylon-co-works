import type { Component } from 'solid-js'
import type { RegistryEntry } from '../registry/types.ts'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'
import type { Workspace } from '../../domains/workspace/workspaceEntities.ts'

/**
 * 左栏是**一个有序的模块栈**。
 *
 * 曾经是「两个分区（modules / sessions）纵向堆叠」，而 `sessions` 分区里又只有一个贡献。
 * 用户要求「把会话抽取成一个常开模块」，于是分区这一层被删掉：会话就是栈里的一个模块，
 * 与其它模块同构（同一条注册表、同一套图标/点击语义/拖拽/显隐），区别只在于它声明了
 * `alwaysOpen` 与较大的 `order`，因而默认常开且排在最后。
 *
 * 这么做的收益是「模块」这件事只有一种形状：插件注册的模块与内置的会话模块走同一条路，
 * 拖拽重排、显隐设置、图标、点击语义都不需要为会话开特例。
 */
export type AgentSidebarPresentation = 'block' | 'page'

/**
 * 点击模块标题的语义。用户在需求里把它归纳为三种可选方案：
 * - `expand`：点击展开/折叠（默认）。若模块同时声明了 `page`，宿主会在头部自动补一个
 *   「打开」按钮——这即用户说的「都要」。
 * - `page`：点击进入新页面（替换聊天视图的整页）。此时若模块可折叠，宿主会渲染一个
 *   独立的折叠钮，因为标题已被「进入页面」占用。
 */
export type AgentSidebarTitleAction = 'expand' | 'page'

export interface AgentSidebarContributionContext {
  readonly activeAgentId: string
  readonly activeSessionId: string | null
}

/**
 * 区块头部的动作按钮。声明成数据而不是让贡献自己画，是因为：
 * ① 宿主拥有区块外壳（标题 + 折叠），贡献只画内容，头部才不会有第二份标题；
 * ② 外置插件是隔离表面，无法往宿主头部塞任意组件节点。
 * `icon` 是由宿主解释的稳定字符串键（与 Workspace launch icon 同一约定），未知键安全降级。
 */
export interface AgentSidebarHeaderAction {
  readonly id: string
  readonly label: string
  readonly title?: string
  readonly icon?: string
  readonly disabled?: boolean
}

export interface AgentSidebarContributionProps {
  readonly activeAgentId: string
  readonly activeSessionId: string | null
  readonly sessions: readonly WorkspaceSession[]
  readonly workspaces: readonly Workspace[]
  readonly liveGeneratingSources: readonly string[]
  /**
   * 同一份内容以两种体量出现：`block` 是左栏模块里的小样，`page` 是它展开到主区后的整页。
   * 贡献据此决定渲染密度（模块里紧凑、整页里铺开），而不是维护两份组件。
   */
  readonly presentation: AgentSidebarPresentation
  /** 宿主拥有折叠状态；贡献据此决定是否跳过昂贵渲染。`page` 体量下恒为 `false`。 */
  readonly collapsed: boolean
  /**
   * 注册「模块头动作」的处理器。宿主渲染头部（标题 + 折叠钮 + `headerActions`），
   * 但动作语义属于贡献，因此由贡献在挂载期把处理器注册回来、卸载时传 `null` 注销。
   */
  readonly registerBlockActionHandler: (handler: ((actionId: string) => void) | null) => void
  /** 宿主头部的 `headerActions` 被点击时回调，参数是该 action 的 id。 */
  readonly onBlockAction: (actionId: string) => void
  readonly onSelectSession: (id: string) => void
  readonly onDeleteSession: (id: string) => Promise<void>
  readonly onExportSession?: (id: string) => Promise<void>
  readonly onArchiveSession?: (id: string) => Promise<void> | void
  readonly onOpenSessionSettings: (id: string) => void
  /** 切换会话置顶（在所属工作区内排最前）。 */
  readonly onToggleSessionPin?: (id: string) => void
  readonly onRenameSession: (id: string, name: string) => void
  readonly onCreateLooseSession: () => void
  readonly onCreateWorkspace: (name: string, rootPath: string) => Promise<void>
  readonly onCreateWorkspaceSession: (workspaceId: string) => void
}

export interface AgentSidebarPage {
  /** 页面头部标题；宿主渲染头部与返回控件，贡献只画内容。 */
  readonly title: string
}

interface AgentSidebarContributionBase {
  readonly id: string
  /** 模块标题。由**宿主**渲染成模块头——贡献不得再画一份自己的标题。 */
  readonly label: string
  /** 稳定图标键（与 Workspace launch 同一映射）。省略时模块头不画图标。 */
  readonly icon?: string
  readonly order?: number
  /** 标题点击语义；省略为 `expand`。 */
  readonly onTitleClick?: AgentSidebarTitleAction
  /** 是否可折叠，默认 `true`（含 `alwaysOpen` 的模块）。 */
  readonly collapsible?: boolean
  readonly defaultCollapsed?: boolean
  /**
   * 常驻：**不可隐藏**、不出现在显隐设置的可改项里、首次出现时默认展开。会话模块用它——
   * 左栏没有会话列表就失去了主体。**不压制折叠**（会话模块也可折叠成一行）与拖拽重排。
   */
  readonly alwaysOpen?: boolean
  /**
   * 声明本模块**可以展开成主区整页**：点击进入（`onTitleClick: 'page'`）或由宿主在头部
   * 提供的「打开」按钮进入。页面替换该 Sheet 的聊天视图（不开新 Sheet），渲染的是
   * **同一个贡献组件**，只是 `presentation: 'page'`。
   */
  readonly page?: AgentSidebarPage
  readonly headerActions?: readonly AgentSidebarHeaderAction[]
  readonly when?: (context: AgentSidebarContributionContext) => boolean
}

export interface FirstPartyAgentSidebarContribution extends AgentSidebarContributionBase {
  readonly renderKind: 'first-party-solid'
  /**
   * #520 S4-P1-6：typed component（对齐 contextPanelTypes 既有范式，不再 opaque）。
   * 第一方贡献组件是 Solid `Component<AgentSidebarContributionProps>`，宿主
   * （Sidebar / AgentSheetPageHost）经 PluginContributionBody 直连渲染——
   * 宿主侧的 `as Component` 断言随 opaque 收窄一并退役。
   */
  readonly component: Component<AgentSidebarContributionProps>
}

export interface IsolatedAgentSidebarContribution extends AgentSidebarContributionBase {
  readonly renderKind: 'isolated-surface'
  readonly surfaceId: string
}

export type AgentSidebarContribution =
  | FirstPartyAgentSidebarContribution
  | IsolatedAgentSidebarContribution

export type AgentSidebarRegistryEntry = RegistryEntry<AgentSidebarContribution>
