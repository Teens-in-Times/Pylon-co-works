// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #607 刀3a：设置页**消息流两行**（样式单 / 配色单）的 DOM 契约。
 *
 * - 消息流区出两行、其余区仍一行；
 * - 「存当前」按行取轴：样式行存的条目只出现在样式行、配色行存的只出现在配色行（轴隔离）。
 */
import { cleanup, fireEvent, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.solid'
import { resetStores } from '../../test/resetStores.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { useCustomPresetStore } from '../../domains/theme/customPresetStore.ts'
import { ZONE_PRESET_POOL, chatPresetsForAxis } from '../../domains/theme/zones/index.ts'

vi.mock('../settings/AgentRuntimePanel.solid.tsx', () => ({ default: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

function groupOf(title: string): HTMLElement {
  return screen.getByText(title).closest('.set-group') as HTMLElement
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
  useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
})

afterEach(() => {
  cleanup()
})

describe('#607 刀3a · 消息流两行', () => {
  it('chat 区出两行（样式单 / 配色单），两行的候选按轴取；其余区仍一行', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'chat' })
    await vi.waitFor(() => {
      expect(screen.getByText('消息流样式单')).toBeInTheDocument()
    })
    expect(screen.getByText('消息流配色单')).toBeInTheDocument()
    // 不再有一行笼统的「局部预设」
    expect(screen.queryByText('局部预设')).not.toBeInTheDocument()

    const styleGroup = within(groupOf('消息流样式单'))
    const colorGroup = within(groupOf('消息流配色单'))
    for (const entry of chatPresetsForAxis(ZONE_PRESET_POOL, 'gui', 'style')) {
      expect(styleGroup.getByRole('button', { name: entry.label }), `样式行 ${entry.id}`).toBeInTheDocument()
    }
    for (const entry of chatPresetsForAxis(ZONE_PRESET_POOL, 'gui', 'color')) {
      expect(colorGroup.getByRole('button', { name: entry.label }), `配色行 ${entry.id}`).toBeInTheDocument()
    }
  })

  it('「存当前」按行取轴：样式行存的条目只出现在样式行（轴隔离）', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'chat' })
    await vi.waitFor(() => {
      expect(screen.getByText('消息流样式单')).toBeInTheDocument()
    })
    const styleGroup = within(groupOf('消息流样式单'))
    const colorGroup = within(groupOf('消息流配色单'))

    fireEvent.input(styleGroup.getByPlaceholderText('区域预设名称'), { target: { value: '我的样式单' } })
    fireEvent.click(styleGroup.getByRole('button', { name: '存当前' }))

    const saved = useCustomPresetStore.getState().zonePresetEntries
    expect(saved).toHaveLength(1)
    expect(saved[0].axis).toBe('style')
    await vi.waitFor(() => {
      expect(styleGroup.getByRole('button', { name: '我的样式单' })).toBeInTheDocument()
      expect(colorGroup.queryByRole('button', { name: '我的样式单' })).not.toBeInTheDocument()
    })

    // 反向：配色行存一条 ⇒ 只在配色行
    fireEvent.input(colorGroup.getByPlaceholderText('区域预设名称'), { target: { value: '我的配色单' } })
    fireEvent.click(colorGroup.getByRole('button', { name: '存当前' }))
    const all = useCustomPresetStore.getState().zonePresetEntries
    expect(all.map(entry => entry.axis).sort()).toEqual(['color', 'style'])
    await vi.waitFor(() => {
      expect(colorGroup.getByRole('button', { name: '我的配色单' })).toBeInTheDocument()
      expect(styleGroup.queryByRole('button', { name: '我的配色单' })).not.toBeInTheDocument()
    })
  })
})
