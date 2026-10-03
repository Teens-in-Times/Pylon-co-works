import { describe, expect, expectTypeOf, it } from 'vitest'
import * as sdk from '../index.ts'
import { PluginStorageError } from '../index.ts'
import { createMockContext } from '../testing.ts'
import type {
  CommandApi,
  PluginActivationContext,
  PluginApplicationApi,
  PluginCcWidgetApi,
  PluginContextPanelApi,
  PluginFileWorkbenchApi,
  PluginFontApi,
  PluginHookApi,
  PluginIdentity,
  PluginInterfaceModeApi,
  PluginManagementApi,
  PluginPresetApi,
  PluginPresentationApi,
  PluginProcessApi,
  PluginScope,
  PluginServiceApi,
  PluginSessionCreationApi,
  PluginSessionsApi,
  PluginSettingsApi,
  PluginShellRecipeApi,
  PluginSidebarApi,
  PluginTitlebarApi,
  PluginTurnsApi,
  PluginStorageApi,
  PluginUiApi,
  PluginWorkspaceApi,
  RendererApi,
  RendererSlotContribution,
  RendererSuiteContribution,
} from '../index.ts'
import type {
  RendererSlotContribution as HostRendererSlotContribution,
  RendererSuiteContribution as HostRendererSuiteContribution,
} from '../../plugin-runtime/renderers/rendererSuiteTypes.ts'

/** 编译期恒等断言 helpers（parity 门的机器检查核心）。 */
type Expect<T extends true> = T
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false

/**
 * 防漂移门：activation context 的**每个成员** ↔ SDK 公开出口类型一一对应。
 * 宿主给 context 新增成员而未在 `src/sdk/contract.ts` 补出口时，下面的
 * `Equal<keyof …>` 编译期变红——SDK「跟不上版本」从根上被门禁拦截。
 */
type SdkTypeForMember = {
  identity: PluginIdentity
  scope: PluginScope
  application: PluginApplicationApi
  workspace: PluginWorkspaceApi
  renderer: RendererApi
  commands: CommandApi
  hooks: PluginHookApi
  sessions: PluginSessionsApi
  turns: PluginTurnsApi
  process: PluginProcessApi
  ui: PluginUiApi
  services: PluginServiceApi
  sidebar: PluginSidebarApi
  fileWorkbench: PluginFileWorkbenchApi
  contextPanel: PluginContextPanelApi
  presentation: PluginPresentationApi
  settings: PluginSettingsApi
  fonts: PluginFontApi
  sessionCreation: PluginSessionCreationApi
  interfaceModes: PluginInterfaceModeApi
  shellRecipes: PluginShellRecipeApi
  titlebar: PluginTitlebarApi
  storage: PluginStorageApi
  ccWidget: PluginCcWidgetApi
  presets: PluginPresetApi
  management: PluginManagementApi | undefined
}
type _ParityGate = Expect<Equal<keyof SdkTypeForMember, keyof PluginActivationContext>>
// 门的运行时可读引用（同时满足 noUnusedLocals）：键集不一致时本行编译失败。
const parityGate: _ParityGate = true

/**
 * #520 S4-P1-8：Suite/Slot 贡献类型必须经 SDK barrel 原样可达（与宿主真源
 * `rendererSuiteTypes` 编译期恒等，防止 SDK 面再手写平行类型）。
 */
type _SuiteSlotParityGate = Expect<Equal<RendererSuiteContribution, HostRendererSuiteContribution> & Equal<RendererSlotContribution, HostRendererSlotContribution>>
const suiteSlotParityGate: _SuiteSlotParityGate = true

describe('SDK public exports', () => {
  it('keeps every activation-context member reachable from the SDK index (parity gate)', () => {
    // 键集一致性门的运行时可读值（编译期由 SdkTypeForMember 的 keyof Equal 强制）。
    expect(parityGate).toBe(true)
    // 逐成员编译期断言：context 成员类型可赋给公开出口类型（management 因 C3
    // 门控含 undefined；其余成员严格对应）。
    expectTypeOf<PluginActivationContext['identity']>().toExtend<PluginIdentity>()
    expectTypeOf<PluginActivationContext['scope']>().toExtend<PluginScope>()
    expectTypeOf<PluginActivationContext['application']>().toExtend<PluginApplicationApi>()
    expectTypeOf<PluginActivationContext['workspace']>().toExtend<PluginWorkspaceApi>()
    expectTypeOf<PluginActivationContext['renderer']>().toExtend<RendererApi>()
    expectTypeOf<PluginActivationContext['commands']>().toExtend<CommandApi>()
    expectTypeOf<PluginActivationContext['hooks']>().toExtend<PluginHookApi>()
    expectTypeOf<PluginActivationContext['sessions']>().toExtend<PluginSessionsApi>()
    expectTypeOf<PluginActivationContext['turns']>().toExtend<PluginTurnsApi>()
    expectTypeOf<PluginActivationContext['process']>().toExtend<PluginProcessApi>()
    expectTypeOf<PluginActivationContext['ui']>().toExtend<PluginUiApi>()
    expectTypeOf<PluginActivationContext['services']>().toExtend<PluginServiceApi>()
    expectTypeOf<PluginActivationContext['sidebar']>().toExtend<PluginSidebarApi>()
    expectTypeOf<PluginActivationContext['fileWorkbench']>().toExtend<PluginFileWorkbenchApi>()
    expectTypeOf<PluginActivationContext['contextPanel']>().toExtend<PluginContextPanelApi>()
    expectTypeOf<PluginActivationContext['presentation']>().toExtend<PluginPresentationApi>()
    expectTypeOf<PluginActivationContext['settings']>().toExtend<PluginSettingsApi>()
    expectTypeOf<PluginActivationContext['fonts']>().toExtend<PluginFontApi>()
    expectTypeOf<PluginActivationContext['sessionCreation']>().toExtend<PluginSessionCreationApi>()
    expectTypeOf<PluginActivationContext['interfaceModes']>().toExtend<PluginInterfaceModeApi>()
    expectTypeOf<PluginActivationContext['shellRecipes']>().toExtend<PluginShellRecipeApi>()
    expectTypeOf<PluginActivationContext['titlebar']>().toExtend<PluginTitlebarApi>()
    expectTypeOf<PluginActivationContext['storage']>().toExtend<PluginStorageApi>()
    expectTypeOf<PluginActivationContext['ccWidget']>().toExtend<PluginCcWidgetApi>()
    expectTypeOf<PluginActivationContext['presets']>().toExtend<PluginPresetApi>()
    expectTypeOf<PluginActivationContext['management']>().toExtend<PluginManagementApi | undefined>()
  })

  it('keeps the mock context member set aligned with the activation context', () => {
    // 运行时侧门：mock 必须覆盖 context 全部成员；management 缺省不装配（C3），
    // 显式开启才存在。
    const keys = Object.keys(createMockContext())
    expect(keys).toContain('identity')
    expect(keys).not.toContain('management')
    expect(Object.keys(createMockContext({ management: true }))).toContain('management')
    expect(keys.length).toBe(Object.keys(createMockContext({ management: true })).length - 1)
  })

  it('exposes the renderer Suite/Slot contribution types verbatim from the host catalog', () => {
    // 编译期由 _SuiteSlotParityGate 强制恒等；此处补运行时可读引用。
    expect(suiteSlotParityGate).toBe(true)
  })

  it('exposes the runtime-value export surface of the SDK barrel', () => {
    expect(typeof sdk.definePlugin).toBe('function')
    expect(typeof sdk.validatePluginManifest).toBe('function')
    expect(typeof sdk.defineManifest).toBe('function')
    expect(typeof sdk.createPluginLogger).toBe('function')
    expect(typeof sdk.createSettingsSurface).toBe('function')
    expect(sdk.PYLON_PLUGIN_CAPABILITIES.length).toBeGreaterThan(0)
    expect(sdk.PLUGIN_STORAGE_BUDGET_BYTES).toBeGreaterThan(0)
    // 隔离面协议事件词表（宿主真源的运行时再出口）
    expect(sdk.SIDEBAR_SURFACE_EVENTS).toContain('host:select-session')
    expect(sdk.CONTEXT_PANEL_SURFACE_EVENTS).toContain('host:collapse')
  })

  it('exports the runtime-neutral storage error contract', () => {
    expect(new PluginStorageError('quota', 'over budget')).toBeInstanceOf(Error)
  })
})
