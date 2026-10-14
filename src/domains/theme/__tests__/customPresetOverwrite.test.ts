// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useThemeStore } from '../themeStore.ts'
import { useCustomPresetStore } from '../customPresetStore.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { useInterfaceModeStore } from '../../interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../presentation/presentationPreferenceStore.ts'
import { getInterfaceModeRegistry, getPresentationProfileRegistry, getShellRecipeRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { DEFAULT_SHELL_RECIPE } from '../../../plugin-runtime/shell-recipe/shellRecipeTypes.ts'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { BUILTIN_INTERFACE_MODES } from '../../../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { activateInterfaceMode } from '../../../application/transactions/activateInterfaceMode.ts'

describe('custom preset overwrite', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('keeps the selected target after interface-mode transitions and updates only it', async () => {
    const owner = createPluginIdentity(`test.custom-overwrite.${Date.now()}`, '1')
    // The production bootstrap registers these contributions through the
    // plugin host. Register host-compatible fixtures here so the transaction
    // path exercised by the regression is the same one used by the UI.
    const profileRegs = BUILTIN_PRESENTATION_PROFILES.map(profile =>
      getPresentationProfileRegistry().register(owner, profile),
    )
    // 内置模式声明 shellRecipeId；激活期跨注册表校验要求该 recipe 在场。
    const recipeReg = getShellRecipeRegistry().register(owner, DEFAULT_SHELL_RECIPE)
    const modeRegs = BUILTIN_INTERFACE_MODES.map(mode =>
      getInterfaceModeRegistry().register(owner, {
        ...mode,
        workbench: {
          renderKind: 'host',
          renderer: mode.id === 'modern-gui' ? 'modern' : 'terminal',
        },
      }),
    )

    try {
      useThemeStore.getState().setZoneField('chat', { chatFontSize: 17 })
      const firstId = useCustomPresetStore.getState().saveCustomPreset('first')
      useThemeStore.getState().setZoneField('chat', { chatFontSize: 19 })
      const secondId = useCustomPresetStore.getState().saveCustomPreset('second')
      const firstCreatedAt = useCustomPresetStore.getState().customPresets.find(item => item.id === firstId)?.createdAt

      // ★ #607 刀3b：`activatePresentationProfile` 已随档案私路退役——过渡只剩界面模式切换。
      for (const mode of ['terminal-like', 'modern-gui', 'terminal-like'] as const) {
        expect(activateInterfaceMode(mode)).toBe(true)
      }

      useThemeStore.getState().setZoneField('chat', { chatFontSize: 31 })
      expect(useCustomPresetStore.getState().saveCustomPreset('first', firstId)).toBe(firstId)

      const presets = useCustomPresetStore.getState().customPresets
      expect(presets).toHaveLength(2)
      expect(presets.find(item => item.id === firstId)?.theme.chatFontSize).toBe(31)
      expect(presets.find(item => item.id === secondId)?.theme.chatFontSize).toBe(19)
      expect(presets.find(item => item.id === firstId)?.createdAt).toBe(firstCreatedAt)
      expect(presets.find(item => item.id === firstId)?.bundle?.id).toBe(firstId)
    } finally {
      for (const registration of [recipeReg, ...modeRegs, ...profileRegs]) await registration.dispose()
    }
  })

  it('reports a stale explicit overwrite id instead of silently creating another preset', () => {
    expect(() => useCustomPresetStore.getState().saveCustomPreset('stale', 'custom-does-not-exist'))
      .toThrow('要覆盖的自定义预设不存在')
    expect(useCustomPresetStore.getState().customPresets).toHaveLength(0)
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('modern-gui')
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBeTruthy()
  })

  // ★ #607 刀3b：档案私路退役后，旧数据里那条 `builtin.presentation` 段必须**静默忽略**——
  //   既不报错，也不清空整条预设（其余内容照常应用）。
  it('旧预设带 Presentation 段：载入不报错，其余内容照常应用，档案字段不被写回', async () => {
    const legacyId = 'custom-legacy-presentation'
    useCustomPresetStore.setState({
      customPresets: [{
        id: legacyId, name: '旧预设', createdAt: 1, updatedAt: 1,
        theme: { chatFontSize: 19 },
        bundle: {
          manifestVersion: 2, id: legacyId, name: '旧预设', source: 'user',
          contributions: {
            'builtin.theme': { ownerPluginId: 'builtin.pylon-shell', providerVersion: 1, policy: 'complete', payload: { chatFontSize: 19 } },
            'builtin.presentation': {
              ownerPluginId: 'builtin.pylon-shell', providerVersion: 1, policy: 'partial',
              payload: { activeProfileId: 'builtin.presentation.console-glass', rendererSuiteIdByMode: { 'modern-gui': 'builtin.solid' } },
            },
          },
        },
      }],
    } as never)
    const profileBefore = usePresentationPreferenceStore.getState().activeProfileId

    const result = await useCustomPresetStore.getState().applyCustomPreset(legacyId)
    expect(result.status).toBe('applied')
    expect(useThemeStore.getState().chatFontSize).toBe(19)
    // 预设本体没被清空；呈现身份没被旧段改写
    expect(useCustomPresetStore.getState().customPresets.map(item => item.id)).toEqual([legacyId])
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe(profileBefore)
    // 未知段如实登记为 unavailable（不是 error）
    expect(result.status === 'applied' && result.unavailable).toContain('builtin.presentation')
  })

  it('新建自定义预设不再带 Presentation 段', () => {
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 21 })
    const id = useCustomPresetStore.getState().saveCustomPreset('无档案段')
    const bundle = useCustomPresetStore.getState().customPresets.find(item => item.id === id)?.bundle
    expect(bundle).toBeTruthy()
    expect(Object.keys(bundle!.contributions).sort()).toEqual(['builtin.renderer-settings', 'builtin.theme'])
  })
})
