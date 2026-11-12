import type { ContextPanelContribution } from '../../plugin-runtime/context-panel/contextPanelTypes.ts'
import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import { BUILTIN_WORKSPACE_TYPES } from '../core/sheet/builtinWorkspacePlugins.ts'
import { BUILTIN_SEARCH_PROVIDERS } from '../core/search/builtinSearchProviders.ts'
import { BUILTIN_EXPORT_SOURCES } from '../core/export/builtinExportSources.ts'
import { BUILTIN_CANONICAL_MESSAGE_PROJECTOR } from '../core/projector/builtinProjector.ts'
import { BUILTIN_PYLON_WORKSPACE_ID } from './productPluginIds.ts'
import { mountFirstPartyStyleAssets } from './firstPartyStyleRuntime.ts'
import { loadBuiltinPylonWorkspaceStyles } from './packages/builtin.pylon-workspace/styleAssets.ts'
import { lazy, type Component } from 'solid-js'
import { BUILTIN_FILE_WORKBENCH_CONTRIBUTIONS } from '../core/file/builtinFileWorkbench.ts'
import { createBuiltinFileCommandDefinitions } from '../core/file/builtinFileCommands.ts'
import { createBuiltinWorkspaceCommandDefinitions } from '../core/sheet/builtinWorkspaceCommands.ts'
import { createBuiltinBrowserCommandDefinitions } from '../core/browser/builtinBrowserCommands.ts'
import { registerBuiltinBrowserAgentSessionAccess } from '../core/browser/builtinBrowserAgentSessionAccess.ts'

// First-party Solid panels are lazy-loaded so inactive workspace surfaces do not enter the initial bundle.
const SessionsPanel = lazy(() => {
  const load = import.meta.glob<{ default: Component }>('../../components/sidebar/SessionsPanel.solid.tsx')['../../components/sidebar/SessionsPanel.solid.tsx']
  if (!load) return Promise.reject(new Error('SessionsPanel Solid 实体未进入 Vite module graph'))
  return load()
})
const SearchPanel = lazy(() => {
  const load = import.meta.glob<{ default: Component }>('../../components/sidebar/SearchPanel.solid.tsx')['../../components/sidebar/SearchPanel.solid.tsx']
  if (!load) return Promise.reject(new Error('SearchPanel Solid 实体未进入 Vite module graph'))
  return load()
})
const AgentContextPanel = lazy(() => {
  const load = import.meta.glob<{ default: Component }>('../../components/right-panel/AgentContextPanel.solid.tsx')['../../components/right-panel/AgentContextPanel.solid.tsx']
  if (!load) return Promise.reject(new Error('AgentContextPanel Solid 实体未进入 Vite module graph'))
  return load()
})
const FileContextPanel = lazy(() => {
  const load = import.meta.glob<{ default: Component }>('../../components/right-panel/FileContextPanel.solid.tsx')['../../components/right-panel/FileContextPanel.solid.tsx']
  if (!load) return Promise.reject(new Error('FileContextPanel Solid 实体未进入 Vite module graph'))
  return load()
})

/** Built-in inspectors require their matching workspace; global plugin panels remain independent. */
export const BUILTIN_CONTEXT_PANEL_CONTRIBUTIONS: readonly ContextPanelContribution[] = [
  {
    id: 'builtin.context-panel.agent',
    workspaceKind: 'agent',
    label: '工作资源',
    when: context => context.workspaceKind === 'agent',
    order: 100,
    renderKind: 'first-party-solid',
    component: AgentContextPanel,
  },
  {
    id: 'builtin.context-panel.file',
    workspaceKind: 'file',
    label: '关联',
    when: context => context.workspaceKind === 'file',
    order: 100,
    renderKind: 'first-party-solid',
    component: FileContextPanel,
  },
]

/**
 * 左栏「模块区」的真实模块（搜索 + 会话）。搜索是独立面板（可隐藏/拖走），
 * 会话是常开模块——同一条注册表、同一套折叠/图标/点击语义。
 */
export function createBuiltinPylonWorkspacePlugin(): BuiltinPluginDefinition {
  return {
    id: BUILTIN_PYLON_WORKSPACE_ID,
    kind: 'workspace',
    firstParty: true,
    hotSwapMode: 'parallel',
    activate: context => {
      mountFirstPartyStyleAssets(BUILTIN_PYLON_WORKSPACE_ID, context.identity.key, context.scope, loadBuiltinPylonWorkspaceStyles())
      for (const definition of BUILTIN_WORKSPACE_TYPES) context.workspace.registerType(definition)
      // 搜索是**独立模块**（VSCode 搜索侧栏那一类专属面板）：自己拥有查询、自己呈现结果。
      // 它排在会话模块之前，可被用户隐藏或拖走（不是常驻）。
      context.sidebar.registerAgentSidebarContribution({
        id: 'builtin.sidebar.module.search',
        label: '搜索',
        icon: 'search',
        order: 800,
        renderKind: 'first-party-solid',
        component: SearchPanel,
      })
      context.sidebar.registerAgentSidebarContribution({
        id: 'builtin.sidebar.module.sessions',
        label: '会话',
        icon: 'messages',
        // 会话是**常开模块**：不可折叠、不可隐藏、默认排在最后，但仍是普通模块
        // ——同一条注册表、同一套图标/点击语义/拖拽/显隐，不为它开特例。
        alwaysOpen: true,
        order: 900,
        headerActions: [{ id: 'new-workspace', label: '工作区', title: '新建工作区', icon: 'plus' }],
        renderKind: 'first-party-solid',
        component: SessionsPanel,
      })
      for (const contribution of BUILTIN_FILE_WORKBENCH_CONTRIBUTIONS) context.fileWorkbench.register(contribution)
      for (const command of [...createBuiltinFileCommandDefinitions(), ...createBuiltinWorkspaceCommandDefinitions(), ...createBuiltinBrowserCommandDefinitions()]) {
        context.commands.register(command, { contributionId: `${BUILTIN_PYLON_WORKSPACE_ID}.${command.id}`, layer: 'feature', priority: command.priority })
      }
      // issue #82：浏览器 Agent 会话贡献——session/new 前按档位注入浏览器 MCP 桥。
      registerBuiltinBrowserAgentSessionAccess(context.sessionCreation)
      for (const panel of BUILTIN_CONTEXT_PANEL_CONTRIBUTIONS) context.contextPanel.register(panel)
      for (const provider of BUILTIN_SEARCH_PROVIDERS) {
        context.services.register('search', provider.providerId, provider)
      }
      for (const source of BUILTIN_EXPORT_SOURCES) {
        context.services.register('export', source.sourceId, source)
      }
      context.services.register(
        'event-projector',
        BUILTIN_CANONICAL_MESSAGE_PROJECTOR.projectorId,
        BUILTIN_CANONICAL_MESSAGE_PROJECTOR,
      )
    },
  }
}
