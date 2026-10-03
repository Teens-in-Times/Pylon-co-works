/**
 * Pylon 插件 SDK 契约面（纯类型再出口；`export type` 编译期消失，零运行时代价）。
 *
 * 真源纪律：本文件是宿主契约（`src/plugin-runtime/**`）与插件作者之间的唯一类型通道，
 * **每个域标注契约面自哪个 API minor 起存在**（`@since`）；allowlist 全表见
 * `PYLON_PLUGIN_API_SUPPORTED`（runtime.ts 再出口）。
 *
 * 防漂移门：`sdkExports.test.ts` 的 parity 断言强制「`BuiltinPluginActivationContext`
 * 的每个成员在本文件（或 runtime.ts）有对应出口」——宿主新增 context 成员而未补出口时，
 * 测试编译期变红。隔离面协议类型（sidebar / context-panel）随宿主协议文件同步。
 */
import type {
  PylonPluginManifest,
  PylonPluginCapability,
  PylonPluginApiVersion,
} from '../plugin-runtime/packageManifest.ts'
import type { BuiltinPluginActivationContext as PluginActivationContext } from '../plugin-runtime/pluginActivationContext.ts'
import type { PackagePluginModule } from '../plugin-runtime/packagePluginRuntime.ts'
import type { PluginIdentity } from '../plugin-runtime/pluginIdentity.ts'

// ── 生命周期与身份（API 1.0）──
export type {
  PluginActivationContext,
  PackagePluginModule,
  PylonPluginManifest,
  PylonPluginApiVersion,
  PylonPluginCapability,
  PluginIdentity,
}
export type {
  PluginScope,
  PluginResourceDisposable,
  PluginResourceMetadata,
  PluginCleanupError,
  PluginScopeDisposeResult,
} from '../plugin-runtime/pluginScope.ts'

// ── 命令（API 1.0；`keywords` / `tier` 自 2.4 起为契约表面）──
export type {
  CommandDefinition,
  CommandExecutionContext,
  CommandDescriptor,
  CommandFilter,
  CommandRegisterOptions,
} from '../plugin-runtime/commands/commandRegistry.ts'
export type { PluginCommandApi as CommandApi } from '../plugin-runtime/commands/pluginCommandApi.ts'

// ── Hook（API 1.0；锚点词表 1.3 定稿，§6.2）──
export type {
  HookName,
  HookMode,
  HookExecution,
  HookFailurePolicy,
  HookInvocationContext,
  HookActionResult,
  HookDefinition,
  HookInvocationResult,
} from '../plugin-runtime/hooks/hookTypes.ts'
export type { PluginHookApi } from '../plugin-runtime/hooks/pluginHookApi.ts'

// ── 应用 / 工作区 / 服务（API 1.0）──
export type { PluginApplicationApi } from '../plugin-runtime/application/pluginApplicationApi.ts'
export type { PluginWorkspaceApi } from '../plugin-runtime/workspaces/pluginWorkspaceApi.ts'
export type { PluginServiceApi } from '../plugin-runtime/services/pluginServiceApi.ts'
export type { PluginServiceContribution, PluginServiceKind } from '../plugin-runtime/services/pluginServiceRegistry.ts'

// ── 左栏模块（API 1.0 按 mode 注册；2.0 起为 region 模块栈——破坏性主轴，
//    引用旧 `mode` 的贡献需按 2.0 重写，见说明书 §6.8）──
export type { PluginSidebarApi } from '../plugin-runtime/sidebar/pluginSidebarApi.ts'
export type { AgentSidebarContribution } from '../plugin-runtime/sidebar/sidebarTypes.ts'
export type {
  AgentSidebarPresentation,
  AgentSidebarTitleAction,
  AgentSidebarHeaderAction,
  AgentSidebarPage,
  AgentSidebarContributionProps,
} from '../plugin-runtime/sidebar/sidebarTypes.ts'
/** 左栏模块隔离面 wire 协议（`renderKind: 'isolated-surface'` 的 input 与事件词表）。 */
export type {
  AgentSidebarSurfaceInput,
  AgentSidebarSurfaceSession,
  AgentSidebarSurfaceWorkspace,
  AgentSidebarSurfaceBlockAction,
  SidebarSurfaceEvent,
} from '../plugin-runtime/sidebar/sidebarSurfaceProtocol.ts'

// ── 文件工作台 / 右栏上下文面板（API 1.0；2.2 起 `workspaceKind` 为自动亲和非闸门）──
export type { PluginFileWorkbenchApi } from '../plugin-runtime/file-workbench/pluginFileWorkbenchApi.ts'
export type { FileWorkbenchContribution } from '../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
export type { PluginContextPanelApi } from '../plugin-runtime/context-panel/pluginContextPanelApi.ts'
export type { ContextPanelContribution } from '../plugin-runtime/context-panel/contextPanelTypes.ts'
/** 上下文面板隔离面 wire 协议（input 与事件词表；settings 回流同通道）。 */
export type {
  ContextPanelSurfaceInput,
  ContextPanelSurfaceSheet,
  ContextPanelSurfaceEvent,
} from '../plugin-runtime/context-panel/contextPanelSurfaceProtocol.ts'

// ── UI surface（API 1.0；隔离表面通用挂载协议）──
export type {
  PluginUiSurface,
  PluginUiEventBridge,
  PluginUiUnmount,
  PluginUiFramework,
} from '../plugin-runtime/ui/pluginUiTypes.ts'
export type { PluginUiApi } from '../plugin-runtime/ui/pluginUiApi.ts'

// ── 工作区类型定义 / 渲染器（API 1.0）──
export type { WorkspaceTypeDefinition } from '../plugin-runtime/workspaces/workspaceTypes.ts'
export type {
  CodeHighlighterDefinition,
  RendererApi,
} from '../plugin-runtime/renderers/rendererRegistry.ts'
/** Renderer Suite/Slot 贡献类型（随 `RendererApi.registerSuite/registerSlot` 的
 * 注册通道存在；类型出口补齐于 #520 S4-P1-8）。 */
export type {
  RendererSuiteContribution,
  RendererSlotContribution,
} from '../plugin-runtime/renderers/rendererSuiteTypes.ts'

// ── 呈现档 / 设置（API 1.0；设置目标语法 helpers 在 runtime.ts）──
export type {
  PluginPresentationApi,
} from '../plugin-runtime/presentation/pluginPresentationApi.ts'
export type { PresentationProfileContribution } from '../plugin-runtime/presentation/presentationProfileTypes.ts'
export type {
  PluginSettingsPageContribution,
  PluginSettingOptionsContribution,
  PluginSettingValue,
} from '../plugin-runtime/settings/pluginSettingsTypes.ts'
export type { PluginSettingsApi } from '../plugin-runtime/settings/pluginSettingsApi.ts'
/** Framework-neutral settings schema/adapter contract（正身住
 * `src/contracts/rendererSettingsSchema.ts`，#520 S4-P0-3 起 B-5 破环范式）。
 * Renderer-prefixed 兼容别名保留在 plugin-runtime 侧再出口。 */
export type {
  SettingsSchema,
  SettingsField,
  SettingsValue,
  SettingsValueAdapter,
  SettingValue,
  SettingOption,
  SettingsPlacement,
  SettingsPresentation,
  SettingsDensity,
} from '../contracts/rendererSettingsSchema.ts'
export type {
  RendererSettingsSchema,
  RenderSettingField,
  RendererSettingValue,
  RendererSettingOption,
  RendererSettingsPlacement,
} from '../plugin-runtime/renderers/rendererSettingsTypes.ts'
export type { SettingsTarget } from '../plugin-runtime/settings/settingsTargetGrammar.ts'

// ── 字体（API 1.0）──
export type { PluginFontApi } from '../plugin-runtime/fonts/pluginFontApi.ts'
export type {
  FontContribution,
  FontRole,
} from '../plugin-runtime/fonts/fontContributionTypes.ts'

// ── 会话元数据 / 会话创建（API 1.0）──
export type { PluginSessionsApi, PluginTurnsApi } from '../plugin-runtime/sessionData/pluginSessionDataApi.ts'
export type { PluginSessionCreationApi } from '../plugin-runtime/session-creation/pluginSessionCreationApi.ts'
export type {
  SessionCreationContribution,
  SessionCreationCompiler,
  SessionCreationArtifactHandler,
} from '../plugin-runtime/session-creation/sessionCreationTypes.ts'

// ── 进程（API 1.0）──
export type { PluginProcessApi, PluginProcessHandle } from '../plugin-runtime/process/processTypes.ts'

// ── 界面模式 / Shell 配方（API 1.0）──
export type { PluginInterfaceModeApi } from '../plugin-runtime/interface-mode/pluginInterfaceModeApi.ts'
export type {
  InterfaceModeContribution,
  InterfaceModeShellSurface,
} from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
export type { PluginShellRecipeApi } from '../plugin-runtime/shell-recipe/pluginShellRecipeApi.ts'
export type { ShellRecipeContribution, ShellRailSide } from '../plugin-runtime/shell-recipe/shellRecipeTypes.ts'

// ── 标题栏（API 1.0；2.1 起新增数据化 `app-menu` 槽 = `CommandTitlebarContribution`）──
export type { PluginTitlebarApi } from '../plugin-runtime/titlebar/pluginTitlebarApi.ts'
export type {
  TitlebarContribution,
  CommandTitlebarContribution,
  TitlebarSlot,
  TitlebarContext,
} from '../plugin-runtime/titlebar/titlebarTypes.ts'

// ── 存储（API 1.1 新增：插件私有 KV，按 pluginId 隔离）──
export type { PluginStorageApi } from '../plugin-runtime/storage/pluginStorageTypes.ts'

// ── 中控元件（cc-widget；声明式「贴谁 + 哪一侧」placement）──
export type { PluginCcWidgetApi } from '../plugin-runtime/cc-widget/pluginCcWidgetApi.ts'
export type {
  CcWidgetContribution,
  CcWidgetPlacement,
  CcWidgetRenderSpec,
} from '../plugin-runtime/cc-widget/ccWidgetTypes.ts'

// ── 预设（#109 `context.presets` 能力槽：注册通道，框架中立 payload）──
export type { PluginPresetApi } from '../plugin-runtime/preset/pluginPresetApi.ts'
export type {
  PresetContribution,
  PresetPayload,
} from '../plugin-runtime/preset/presetTypes.ts'

// ── 管理（API 1.2 新增：capability-gated；仅当 manifest 声明 `plugin.management`
//    且用户对该版本授权后，activation context 才装配 `management` 属性）──
export type { PluginManagementApi } from '../plugin-runtime/management/pluginManagementTypes.ts'
export type {
  PluginManagementErrorCode,
  PluginRuntimeOverview,
  PluginRuntimeOverviewEntry,
  PluginBootstrapOverview,
  PluginBootstrapOverviewEntry,
  PluginContractDiagnostics,
  PluginCapabilityGrantFact,
  PluginContributionFact,
  PluginProcessOverviewEntry,
  PluginStorageUsageEntry,
  PluginDependencyNode,
} from '../plugin-runtime/management/pluginManagementTypes.ts'
