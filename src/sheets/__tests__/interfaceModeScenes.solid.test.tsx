// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import {
  BUILTIN_INTERFACE_MODES,
  BUILTIN_TACTICAL_SCENE_SURFACE_ID,
} from '../../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { INTERFACE_MODE_CAPABILITY_OVERVIEW_DECK } from '../../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { InterfaceModeSceneHost, resolveInterfaceModeScene } from '../interfaceModeScenes.solid.tsx'

afterEach(() => cleanup())

describe('InterfaceModeScenes（A-V9 声明位 ↔ 宿主场景注册表）', () => {
  it('tactical-blue 声明的 sceneSurface surfaceId 在宿主注册表中登记', () => {
    const tactical = BUILTIN_INTERFACE_MODES.find(mode => mode.id === 'tactical-blue')
    expect(tactical?.sceneSurface?.surfaceId).toBe(BUILTIN_TACTICAL_SCENE_SURFACE_ID)
    expect(resolveInterfaceModeScene(BUILTIN_TACTICAL_SCENE_SURFACE_ID)).toBeDefined()
    // 其余内置模式不声明装饰场景
    for (const mode of BUILTIN_INTERFACE_MODES) {
      if (mode.id !== 'tactical-blue') expect(mode.sceneSurface).toBeUndefined()
    }
  })

  it('tactical-blue 声明 Overview 指挥台能力位；其余内置模式不声明', () => {
    for (const mode of BUILTIN_INTERFACE_MODES) {
      const declared = mode.capabilities?.[INTERFACE_MODE_CAPABILITY_OVERVIEW_DECK] === true
      expect(declared).toBe(mode.id === 'tactical-blue')
    }
  })

  it('宿主为已登记 surfaceId 挂载装饰场景（懒加载 resolve 后出现）', async () => {
    const { container } = render(() => <InterfaceModeSceneHost surfaceId={BUILTIN_TACTICAL_SCENE_SURFACE_ID} />)
    await vi.dynamicImportSettled()
    expect(container.querySelector('.tactical-scene')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('未登记 surfaceId 静默不渲染', () => {
    const { container } = render(() => <InterfaceModeSceneHost surfaceId="plugin.scene.missing" />)
    expect(container.querySelector('.tactical-scene')).toBeNull()
  })
})
