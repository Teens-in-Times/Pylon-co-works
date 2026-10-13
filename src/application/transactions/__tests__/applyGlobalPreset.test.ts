// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { getInterfaceModeRegistry, getPresentationProfileRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { useInterfaceModeStore } from '../../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../../domains/presentation/presentationPreferenceStore.ts'
import { useThemeStore } from '../../../domains/theme/themeStore.ts'
import { applyGlobalPreset } from '../applyGlobalPreset.ts'

const registrations: AsyncDisposable[] = []

beforeEach(() => {
  localStorage.clear()
  useThemeStore.setState(useThemeStore.getInitialState(), true)
  useInterfaceModeStore.setState(useInterfaceModeStore.getInitialState(), true)
  usePresentationPreferenceStore.setState(usePresentationPreferenceStore.getInitialState(), true)

  const owner = createPluginIdentity('test.global-preset', 'one')
  const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === 'builtin.presentation.agent-command')
  if (!profile) throw new Error('missing Agent command profile fixture')
  registrations.push(getPresentationProfileRegistry().register(owner, profile))
  registrations.push(getInterfaceModeRegistry().register(owner, {
    id: 'modern-gui',
    label: 'Modern GUI',
    defaultPresentationProfileId: 'builtin.presentation.agent-command',
    chromeStyle: 'icons',
    workbench: { renderKind: 'host', renderer: 'modern' },
  }))
})

afterEach(async () => {
  while (registrations.length > 0) await registrations.pop()?.dispose()
})

describe('applyGlobalPreset', () => {
  it('一次应用 Agent 全局预设会写主题（含档案货物）并更新活动身份', () => {
    expect(applyGlobalPreset('agent-command')).toBe(true)

    expect(useThemeStore.getState()).toMatchObject({
      accent: '#38bdf8',
      globalBgColor: '#08111f',
      msgStyle: 'bubble',
      // ★ #607 刀3a：档案货物（这里是消息流配色货物）由**合并材料**给出，
      //   不再是应用时现场叠档案 tokens —— 值与本单前逐字段相同。
      messageUserBg: 'rgba(59,130,246,0.12)',
      inputFocusBorder: 'rgba(99,102,241,0.72)',
      appliedPreset: {
        global: 'agent-command', sidebar: 'agent-command', chat: 'agent-command',
        cc: 'agent-command', right: 'agent-command',
      },
      custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
    })
    // 身份链的唯一来源 = 生效的 chat 样式单材料（`styleMaterial.profileId`）
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.agent-command')
  })

  it('★ #607 刀3a：应用预设不再挑呈现档案 —— 界面模式与记忆表都不被它改动', () => {
    useInterfaceModeStore.setState({
      interfaceMode: 'terminal-like',
      profileByMode: { 'terminal-like': 'builtin.presentation.terminal-classic' },
    })
    expect(applyGlobalPreset('agent-command')).toBe(true)
    // 模式切换归界面模式开关 / 选择器；本路径只写主题与身份
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('terminal-like')
    // 记忆表：本路径不再写 `rememberProfile`（表本身保留，留待刀3b 处置）
    expect(useInterfaceModeStore.getState().profileByMode).toEqual({
      'terminal-like': 'builtin.presentation.terminal-classic',
    })
  })

  it('无身份的预设（普通 7 套）⇒ 不写 activeProfileId，保持原值', () => {
    usePresentationPreferenceStore.getState().setActiveProfileId('builtin.presentation.console-glass')
    expect(applyGlobalPreset('claude')).toBe(true)
    expect(usePresentationPreferenceStore.getState().activeProfileId).toBe('builtin.presentation.console-glass')
  })
})
