import { CommandRegistry } from './commands/commandRegistry.ts'
import { PromptContributionRegistry } from './prompt/promptContributionRegistry.ts'
import { PluginEventBus } from './events/pluginEventBus.ts'
import { HookRuntime } from './hooks/hookRuntime.ts'
import { RendererRegistry } from './renderers/rendererRegistry.ts'
import { createRendererSettingsStore, type RendererSettingsStore } from './renderers/rendererSettingsStore.ts'
import { PluginUiRegistry } from './ui/pluginUiRegistry.ts'
import { PluginServiceRegistry } from './services/pluginServiceRegistry.ts'
import { AgentSidebarRegistry } from './sidebar/sidebarRegistry.ts'
import { FileWorkbenchRegistry } from './file-workbench/fileWorkbenchRegistry.ts'
import { ContextPanelRegistry } from './context-panel/contextPanelRegistry.ts'
import { PresentationProfileRegistry } from './presentation/presentationProfileRegistry.ts'
import { PluginSettingsPageRegistry } from './settings/pluginSettingsRegistry.ts'
import { PluginSettingsStore } from './settings/pluginSettingsStore.ts'
import { PluginSettingOptionsRegistry } from './settings/pluginSettingOptionsRegistry.ts'
import { FontContributionRegistry } from './fonts/fontContributionRegistry.ts'
import { SessionCreationRegistry } from './session-creation/sessionCreationRegistry.ts'
import { InterfaceModeRegistry } from './interface-mode/interfaceModeRegistry.ts'
import { ShellRecipeRegistry } from './shell-recipe/shellRecipeRegistry.ts'
import { TitlebarRegistry } from './titlebar/titlebarRegistry.ts'
import { CcWidgetRegistry } from './cc-widget/ccWidgetRegistry.ts'
import { PresetRegistry } from './preset/presetRegistry.ts'
import {
  setWorkspaceRegistryStore,
  WorkspaceRegistryStore,
} from './workspaces/workspaceRegistry.ts'
import type { RuntimeRegistries } from './pluginHostServices.ts'

export interface RuntimeServices extends RuntimeRegistries {
  readonly hookRuntime: HookRuntime
  readonly rendererSettingsStore: RendererSettingsStore
}

export interface CreateRuntimeServicesOptions {
  hookRuntime?: HookRuntime
  workspaceRegistry?: WorkspaceRegistryStore
  rendererSettingsStore?: RendererSettingsStore
}

export function createRuntimeServices(options: CreateRuntimeServicesOptions = {}): RuntimeServices {
  const workspaceRegistry = options.workspaceRegistry ?? new WorkspaceRegistryStore()
  const services = Object.freeze({
    commandRegistry: new CommandRegistry(),
    promptContributionRegistry: new PromptContributionRegistry(),
    eventBus: new PluginEventBus(),
    hookRuntime: options.hookRuntime ?? new HookRuntime(),
    rendererRegistry: new RendererRegistry(),
    rendererSettingsStore: options.rendererSettingsStore ?? createRendererSettingsStore({
      storage: typeof localStorage === 'undefined' ? undefined : localStorage,
    }),
    pluginUiRegistry: new PluginUiRegistry(),
    pluginServiceRegistry: new PluginServiceRegistry(),
    agentSidebarRegistry: new AgentSidebarRegistry(),
    fileWorkbenchRegistry: new FileWorkbenchRegistry(),
    contextPanelRegistry: new ContextPanelRegistry(),
    presentationProfileRegistry: new PresentationProfileRegistry(),
    pluginSettingsPageRegistry: new PluginSettingsPageRegistry(),
    pluginSettingsStore: new PluginSettingsStore(),
    pluginSettingOptionsRegistry: new PluginSettingOptionsRegistry(),
    fontContributionRegistry: new FontContributionRegistry(),
    sessionCreationRegistry: new SessionCreationRegistry(),
    interfaceModeRegistry: new InterfaceModeRegistry(),
    shellRecipeRegistry: new ShellRecipeRegistry(),
    titlebarRegistry: new TitlebarRegistry(),
    workspaceRegistry,
    ccWidgetRegistry: new CcWidgetRegistry(),
    presetRegistry: new PresetRegistry(),
  })
  if (!options.workspaceRegistry) setWorkspaceRegistryStore(workspaceRegistry)
  return services
}

type PluginDisableHandler = (pluginId: string) => void | Promise<void>

let pluginDisableHandler: PluginDisableHandler | undefined
const runtimeServices = createRuntimeServices({
  hookRuntime: new HookRuntime(undefined, {
    onDisablePlugin: pluginId => {
      if (!pluginDisableHandler) throw new Error('Plugin Runtime disable handler is not bound')
      return pluginDisableHandler(pluginId)
    },
  }),
})

/** Composition-root seam: binds hook failure isolation to the single product runtime. */
export function bindPluginDisableHandler(handler: PluginDisableHandler): void {
  pluginDisableHandler = handler
}

export function getRuntimeServices(): RuntimeServices {
  return runtimeServices
}

export function getCommandRegistry(): CommandRegistry {
  return runtimeServices.commandRegistry
}

/** #201：prompt 注入贡献注册表（插件化 sessionPrompt 扩展段；宿主消费面见 assembleSessionPrompt）。 */
export function getPromptContributionRegistry(): PromptContributionRegistry {
  return runtimeServices.promptContributionRegistry
}

export function getPluginEventBus(): PluginEventBus {
  return runtimeServices.eventBus
}

export function getHookRuntime(): HookRuntime {
  return runtimeServices.hookRuntime
}

export function getRendererRegistry(): RendererRegistry {
  return runtimeServices.rendererRegistry
}

export function getRendererSettingsStore(): RendererSettingsStore {
  return runtimeServices.rendererSettingsStore
}

export function getPluginUiRegistry(): PluginUiRegistry {
  return runtimeServices.pluginUiRegistry
}

export function getPluginServiceRegistry(): PluginServiceRegistry {
  return runtimeServices.pluginServiceRegistry
}

export function getAgentSidebarRegistry(): AgentSidebarRegistry {
  return runtimeServices.agentSidebarRegistry
}

export function getFileWorkbenchRegistry(): FileWorkbenchRegistry { return runtimeServices.fileWorkbenchRegistry }

export function getContextPanelRegistry(): ContextPanelRegistry { return runtimeServices.contextPanelRegistry }

export function getPresentationProfileRegistry(): PresentationProfileRegistry { return runtimeServices.presentationProfileRegistry }
export function getPluginSettingsPageRegistry(): PluginSettingsPageRegistry { return runtimeServices.pluginSettingsPageRegistry }
export function getPluginSettingsStore(): PluginSettingsStore { return runtimeServices.pluginSettingsStore }
export function getPluginSettingOptionsRegistry(): PluginSettingOptionsRegistry { return runtimeServices.pluginSettingOptionsRegistry }
export function getFontContributionRegistry(): FontContributionRegistry { return runtimeServices.fontContributionRegistry }
export function getSessionCreationRegistry(): SessionCreationRegistry { return runtimeServices.sessionCreationRegistry }
export function getInterfaceModeRegistry(): InterfaceModeRegistry { return runtimeServices.interfaceModeRegistry }
export function getShellRecipeRegistry(): ShellRecipeRegistry { return runtimeServices.shellRecipeRegistry }
export function getTitlebarRegistry(): TitlebarRegistry { return runtimeServices.titlebarRegistry }
export function getCcWidgetRegistry(): CcWidgetRegistry { return runtimeServices.ccWidgetRegistry }
export function getPresetRegistry(): PresetRegistry { return runtimeServices.presetRegistry }
