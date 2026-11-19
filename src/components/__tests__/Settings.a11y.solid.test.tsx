// @vitest-environment jsdom
/** @jsxImportSource solid-js */
import { cleanup, fireEvent, screen, within } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.solid'

vi.mock('../settings/AgentRuntimePanel.solid.tsx', () => ({
  default: () => <div data-testid="agent-runtime-panel">runtime onboarding</div>,
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(async () => null)
})

describe('Settings 宿主分区标题与导航的可访问性', () => {
  afterEach(cleanup)

  it('侧栏模块标题通过按钮折叠和展开模块组', async () => {
    const { kernelBootstrap } = await import('../../kernel/kernelBootstrapServices.ts')
    await kernelBootstrap.startNormal()
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const body = within(screen.getByRole('region', { name: '设置内容' }))
    const title = await body.findByRole('button', { name: /模块$/, expanded: true })
    expect(body.getByRole('group', { name: '侧栏模块显隐' })).toBeVisible()
    fireEvent.click(title)
    expect(title).toHaveAttribute('aria-expanded', 'false')
    expect(body.queryByRole('group', { name: '侧栏模块显隐' })).toBeNull()
    fireEvent.click(title)
    expect(body.getByRole('group', { name: '侧栏模块显隐' })).toBeVisible()
  })

  it('设置域与分区导航可聚焦，选择分区后更新当前位置', async () => {
    const { kernelBootstrap } = await import('../../kernel/kernelBootstrapServices.ts')
    await kernelBootstrap.startNormal()
    mountSettingsSheet({ domain: 'appearance' })
    const navigation = within(screen.getByRole('navigation', { name: '设置域' }))
    for (const button of navigation.getAllByRole('button')) {
      button.focus()
      expect(button).toHaveFocus()
    }
    const sidebar = screen.getByRole('button', { name: '侧栏' })
    sidebar.focus()
    expect(sidebar).toHaveFocus()
    fireEvent.click(sidebar)
    expect(sidebar).toHaveAttribute('aria-current', 'page')
  })
})
