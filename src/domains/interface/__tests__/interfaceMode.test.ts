// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateInterfaceMode, ensureInterfaceModeProfile, interfaceModeIsUsable, presentationProfileInterfaceMode, resetThemeForActiveInterfaceMode, resolveInterfaceMode, resolveInterfaceModeSuite, resolveShellRecipe } from '../../../application/transactions/activateInterfaceMode.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { getInterfaceModeRegistry, getPresentationProfileRegistry, getRendererRegistry, getShellRecipeRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { DEFAULT_SHELL_RECIPE, type ShellRecipeContribution } from '../../../plugin-runtime/shell-recipe/shellRecipeTypes.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { usePresentationPreferenceStore } from '../../presentation/presentationPreferenceStore.ts'
import { useThemeStore } from '../../theme/themeStore.ts'
import { DEFAULT_INTERFACE_MODE, DEFAULT_INTERFACE_PROFILES, useInterfaceModeStore } from '../interfaceModeStore.ts'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { BUILTIN_INTERFACE_MODES } from '../../../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { useIdentityStore } from '../../identity/identityStore.ts'

const registrations: AsyncDisposable[] = []

// ★ #266 刀9~11：原列表含 `inputMode` / `inputVariant` / `footerLayout` 三项 —— 字段已删除
//   ⇒ 摘掉；其余输入 token 仍锁「方案切换会写入 / 切回会恢复」这件事。
const CC_INPUT_TOKEN_KEYS = [
  'inputBg', 'inputBorderColor', 'inputFocusBorder',
  'inputRadius', 'cliHintMode',
] as const

function resetAppearanceState(): void {
  useThemeStore.setState(useThemeStore.getInitialState(), true)
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
  usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)
}

function appearanceSnapshot(): Record<string, unknown> {
  const theme = useThemeStore.getState()
  return {
    interfaceMode: useInterfaceModeStore.getState().interfaceMode,
    activeProfileId: usePresentationPreferenceStore.getState().activeProfileId,
    ...Object.fromEntries(CC_INPUT_TOKEN_KEYS.map(key => [key, theme[key]])),
  }
}

function registerBuiltinAppearanceContributions(): void {
  const owner = createPluginIdentity('test.interface.builtins', 'one')
  const profiles = getPresentationProfileRegistry()
  const modes = getInterfaceModeRegistry()
  const renderers = getRendererRegistry()
  registrations.push(renderers.registerSuite(owner, {
    id: 'builtin.solid', label: 'Test Solid Suite', apiVersion: 1,
    runtime: { framework: 'solid', version: '1.0.0' },
    compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
    requiredKinds: ['content.unknown'],
    // factory 只剩 prepare 工厂形态（#520 S4-P2 函数臂塌缩）；本测试不挂载实现。
    factory: { prepare: async () => { throw new Error('not mounted in test') } },
  }))
  const recipes = getShellRecipeRegistry()
  registrations.push(recipes.register(owner, DEFAULT_SHELL_RECIPE))
  for (const profile of BUILTIN_PRESENTATION_PROFILES) registrations.push(profiles.register(owner, profile))
  for (const mode of BUILTIN_INTERFACE_MODES) registrations.push(modes.register(owner, mode))
}

function registerModeWithRecipe(modeId: string, recipe: ShellRecipeContribution | undefined): void {
  const owner = createPluginIdentity(`test.${modeId}`, 'one')
  const profiles = getPresentationProfileRegistry()
  const modes = getInterfaceModeRegistry()
  registrations.push(profiles.register(owner, {
    id: `${modeId}.profile`, label: modeId, family: 'custom', interfaceMode: modeId, tokens: {},
  }))
  registrations.push(modes.register(owner, {
    id: modeId,
    label: modeId,
    defaultPresentationProfileId: `${modeId}.profile`,
    chromeStyle: 'icons',
    workbench: { renderKind: 'host', renderer: 'modern' },
    ...(recipe ? { shellRecipeId: recipe.id } : {}),
  }))
  if (recipe) registrations.push(getShellRecipeRegistry().register(owner, recipe))
}

beforeEach(() => {
  localStorage.clear()
  resetAppearanceState()
})

afterEach(async () => {
  while (registrations.length > 0) await registrations.pop()?.dispose()
})

describe('Interface Mode contract', () => {
  it('resolves mode default < per-mode preference and reports unavailable without overwriting it', () => {
    const mode = {
      id: 'modern-gui', label: 'Modern', defaultPresentationProfileId: 'p', chromeStyle: 'icons' as const,
      workbench: { renderKind: 'renderer-suite' as const, defaultSuiteId: 'suite.mode' },
    }
    expect(resolveInterfaceModeSuite(mode, 'suite.user', ['suite.user'])).toMatchObject({
      requestedSuiteId: 'suite.user', activeSuiteId: 'suite.user', unavailable: false,
    })
    expect(resolveInterfaceModeSuite(mode, 'suite.missing', ['builtin.solid'])).toMatchObject({
      requestedSuiteId: 'suite.missing', activeSuiteId: 'builtin.solid', unavailable: true,
    })
  })

  it('默认为 modern-gui，两种模式分别记忆 Presentation Profile', () => {
    expect(useInterfaceModeStore.getState().interfaceMode).toBe(DEFAULT_INTERFACE_MODE)
    expect(useInterfaceModeStore.getState().profileByMode).toEqual(DEFAULT_INTERFACE_PROFILES)
    useInterfaceModeStore.getState().rememberProfile('terminal-like', 'terminal.custom')
    expect(useInterfaceModeStore.getState().profileByMode['modern-gui']).toBe('builtin.presentation.modern-gui')
    expect(useInterfaceModeStore.getState().profileByMode['terminal-like']).toBe('terminal.custom')
  })

  it('遗留 Profile 默认归 terminal-like，显式元数据可归 modern-gui', () => {
    expect(presentationProfileInterfaceMode({ id: 'legacy', label: 'Legacy', family: 'terminal', tokens: {} })).toBe('terminal-like')
    expect(presentationProfileInterfaceMode({ id: 'modern', label: 'Modern', family: 'gui', interfaceMode: 'modern-gui', tokens: {} })).toBe('modern-gui')
  })

  it('切换模式时原子应用该模式记忆的 Profile，不卸载应用', () => {
    const registry = getPresentationProfileRegistry()
    const owner = createPluginIdentity('test.interface', 'one')
    registrations.push(registry.register(owner, {
      id: 'builtin.presentation.modern-gui', label: 'Modern', family: 'gui', interfaceMode: 'modern-gui',
      // ★ #266 刀9：原样本含 `inputVariant`（`composer` / `cli`）—— 该字段已删除、不再是合法 token
      tokens: { msgStyle: 'bubble' },
    }))
    registrations.push(registry.register(owner, {
      id: 'builtin.presentation.terminal-classic', label: 'Classic', family: 'terminal',
      tokens: { msgStyle: 'terminal' },
    }))
    const modes = getInterfaceModeRegistry()
    registrations.push(modes.register(owner, {
      id: 'modern-gui', label: 'Modern GUI', defaultPresentationProfileId: 'builtin.presentation.modern-gui',
      chromeStyle: 'icons', workbench: { renderKind: 'host', renderer: 'modern' },
    }))
    registrations.push(modes.register(owner, {
      id: 'terminal-like', label: 'Terminal-like', defaultPresentationProfileId: 'builtin.presentation.terminal-classic',
      chromeStyle: 'glyphs', workbench: { renderKind: 'host', renderer: 'terminal' },
    }))

    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('terminal-like')
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.terminal-classic')
    // ★ #266 刀9：原断言还比对 `inputVariant`（'cli' / 'composer'）—— 该字段已删除，
    //   样例 profile 也不再声明它 ⇒ 断言收缩到仍在的 `msgStyle`（切换确实落地了该 profile 的 token）。
    expect(useThemeStore.getState()).toMatchObject({ msgStyle: 'terminal' })

    expect(activateInterfaceMode('modern-gui')).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.modern-gui')
    expect(useThemeStore.getState()).toMatchObject({ msgStyle: 'bubble' })
  })

  it('四条重置/切换路径回到 Modern 后得到同一套中控与输入 token', () => {
    registerBuiltinAppearanceContributions()

    resetAppearanceState()
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    const resetThenModern = appearanceSnapshot()

    resetAppearanceState()
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    const terminalThenModern = appearanceSnapshot()

    resetAppearanceState()
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    const terminalResetThenModern = appearanceSnapshot()

    resetAppearanceState()
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    expect(resetThemeForActiveInterfaceMode()).toBe(true)
    const terminalModernThenReset = appearanceSnapshot()

    expect(resetThenModern).toMatchObject({
      interfaceMode: 'modern-gui',
      activeProfileId: 'builtin.presentation.modern-gui',
    })
    expect(terminalThenModern).toEqual(resetThenModern)
    expect(terminalResetThenModern).toEqual(resetThenModern)
    expect(terminalModernThenReset).toEqual(resetThenModern)
  })

  it('Shell Recipe：引用已注册 recipe 的模式可激活，悬空引用被拒绝并回退', () => {
    registerBuiltinAppearanceContributions()
    const mirrored: ShellRecipeContribution = {
      id: 'test.shell.mirrored', label: 'Mirrored', sidebarSide: 'right', contextPanelSide: 'left',
    }
    registerModeWithRecipe('recipe.ok', mirrored)
    expect(activateInterfaceMode('recipe.ok')).toBe(true)
    expect(resolveShellRecipe(resolveInterfaceMode('recipe.ok'))).toMatchObject({
      id: 'test.shell.mirrored', sidebarSide: 'right', contextPanelSide: 'left',
    })
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('recipe.ok')

    // recipe.dangling 声明了不存在的 recipe id：注册表接受（结构合法），但可用性为假。
    // 先注册再激活——跨注册表校验遍历全图，悬空引用在场时任何激活都被拒绝（既有语义）。
    const danglingOwner = createPluginIdentity('test.recipe.dangling', 'one')
    registrations.push(getPresentationProfileRegistry().register(danglingOwner, {
      id: 'recipe.dangling.profile', label: 'dangling', family: 'custom', interfaceMode: 'recipe.dangling', tokens: {},
    }))
    registrations.push(getInterfaceModeRegistry().register(danglingOwner, {
      id: 'recipe.dangling',
      label: 'dangling',
      defaultPresentationProfileId: 'recipe.dangling.profile',
      chromeStyle: 'icons',
      workbench: { renderKind: 'host', renderer: 'modern' },
      shellRecipeId: 'missing.recipe',
    }))
    expect(interfaceModeIsUsable(resolveInterfaceMode('recipe.dangling')!)).toBe(false)
    expect(activateInterfaceMode('recipe.dangling')).toBe(false)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('recipe.ok')

    // 渲染期兜底：模式缺失或引用悬空都解析到内置 classic，瞬态不崩壳
    expect(resolveShellRecipe(undefined)).toMatchObject({ id: 'builtin.shell.classic', sidebarSide: 'left' })
    expect(resolveShellRecipe(resolveInterfaceMode('recipe.dangling'))).toMatchObject({ id: 'builtin.shell.classic' })
  })

  it('插件注销携带的 recipe 后，active 模式在冷启动守卫下回退默认模式', async () => {
    registerBuiltinAppearanceContributions()
    const builtinMark = registrations.length
    const mirrored: ShellRecipeContribution = {
      id: 'test.shell.mirrored', label: 'Mirrored', sidebarSide: 'right', contextPanelSide: 'left',
    }
    registerModeWithRecipe('recipe.ok', mirrored)
    expect(activateInterfaceMode('recipe.ok')).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('recipe.ok')
    // 原子注销该插件的 mode + profile + recipe（模拟插件卸载）；内置贡献保持在场
    while (registrations.length > builtinMark) await registrations.pop()?.dispose()
    expect(ensureInterfaceModeProfile()).toBe(true)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe(DEFAULT_INTERFACE_MODE)
  })

  it('蓝调战术沿用 Solid，切回原模式恢复输入，且不写入会话身份与用户配色', () => {
    registerBuiltinAppearanceContributions()
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    const original = appearanceSnapshot()
    const identity = useIdentityStore.getState()
    const palette = { accent: useThemeStore.getState().accent, chatBg: useThemeStore.getState().chatBg }
    expect(activateInterfaceMode('tactical-blue')).toBe(true)
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.tactical-blue')
    // ★ #266 刀9：原断言 `inputVariant === 'composer'`（那是该 profile 写下的输入 token）；
    //   字段已删除 ⇒ 换成同一 profile 里仍在的输入 token，锁的仍是「它的输入 token 确实落地」。
    expect(appearanceSnapshot().inputBg).not.toBe(original.inputBg)
    const mode = BUILTIN_INTERFACE_MODES.find(item => item.id === 'tactical-blue')!
    expect(resolveInterfaceModeSuite(mode, undefined, ['builtin.solid']).activeSuiteId).toBe('builtin.solid')
    expect(useIdentityStore.getState()).toBe(identity)
    expect({ accent: useThemeStore.getState().accent, chatBg: useThemeStore.getState().chatBg }).toEqual(palette)
    expect(activateInterfaceMode('modern-gui')).toBe(true)
    expect(appearanceSnapshot()).toEqual(original)
    expect(useIdentityStore.getState()).toBe(identity)
  })
})
