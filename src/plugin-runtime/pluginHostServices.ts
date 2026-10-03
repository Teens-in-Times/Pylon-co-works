import type { PluginProcessClient } from '../infrastructure/plugins/pluginProcessClient.ts'
import type { PromptContributionRegistry } from './prompt/promptContributionRegistry.ts'
import type { WorkspaceRegistryStore } from './workspaces/workspaceRegistry.ts'
import type { PluginApplicationHost } from './application/applicationHost.ts'
import type { CommandRegistry } from './commands/commandRegistry.ts'
import type { ContextPanelRegistry } from './context-panel/contextPanelRegistry.ts'
import type { PluginEventBus } from './events/pluginEventBus.ts'
import type { FileWorkbenchRegistry } from './file-workbench/fileWorkbenchRegistry.ts'
import type { FontContributionRegistry } from './fonts/fontContributionRegistry.ts'
import type { HookRuntime } from './hooks/hookRuntime.ts'
import type { InterfaceModeRegistry } from './interface-mode/interfaceModeRegistry.ts'
import type { ShellRecipeRegistry } from './shell-recipe/shellRecipeRegistry.ts'
import type { PresentationProfileRegistry } from './presentation/presentationProfileRegistry.ts'
import type { RendererRegistry } from './renderers/rendererRegistry.ts'
import type { SessionCreationRegistry } from './session-creation/sessionCreationRegistry.ts'
import type { PluginServiceRegistry } from './services/pluginServiceRegistry.ts'
import type { PluginSettingOptionsRegistry } from './settings/pluginSettingOptionsRegistry.ts'
import type { PluginSettingsPageRegistry } from './settings/pluginSettingsRegistry.ts'
import type { PluginSettingsStore } from './settings/pluginSettingsStore.ts'
import type { AgentSidebarRegistry } from './sidebar/sidebarRegistry.ts'
import type { PluginUiRegistry } from './ui/pluginUiRegistry.ts'
import type { TitlebarRegistry } from './titlebar/titlebarRegistry.ts'
import type { CcWidgetRegistry } from './cc-widget/ccWidgetRegistry.ts'
import type { PresetRegistry } from './preset/presetRegistry.ts'

export interface RuntimeRegistries {
  readonly commandRegistry: CommandRegistry
  readonly promptContributionRegistry: PromptContributionRegistry
  readonly eventBus: PluginEventBus
  readonly rendererRegistry: RendererRegistry
  readonly pluginUiRegistry: PluginUiRegistry
  readonly pluginServiceRegistry: PluginServiceRegistry
  readonly agentSidebarRegistry: AgentSidebarRegistry
  readonly fileWorkbenchRegistry: FileWorkbenchRegistry
  readonly contextPanelRegistry: ContextPanelRegistry
  readonly presentationProfileRegistry: PresentationProfileRegistry
  readonly pluginSettingsPageRegistry: PluginSettingsPageRegistry
  readonly pluginSettingsStore: PluginSettingsStore
  readonly pluginSettingOptionsRegistry: PluginSettingOptionsRegistry
  readonly fontContributionRegistry: FontContributionRegistry
  readonly sessionCreationRegistry: SessionCreationRegistry
  readonly interfaceModeRegistry: InterfaceModeRegistry
  readonly shellRecipeRegistry: ShellRecipeRegistry
  readonly titlebarRegistry: TitlebarRegistry
  readonly workspaceRegistry: WorkspaceRegistryStore
  readonly ccWidgetRegistry: CcWidgetRegistry
  readonly presetRegistry: PresetRegistry
}

export interface PluginHostServices {
  readonly application: PluginApplicationHost
  readonly registries: RuntimeRegistries
  readonly hooks: HookRuntime
  readonly processClient: PluginProcessClient
  readonly requestSoftRemount?: () => void | Promise<void>
}
