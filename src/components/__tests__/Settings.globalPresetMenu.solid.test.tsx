// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// 刀5（#201，UI 二次修订 2026-09-19）：预设区不放「GUI / 终端」选项按钮——直接显示
// 当前界面模式对应的预设（presetsForInterfaceMode），随模式切换自动跟随；
// tactical-blue（不在归属表内）⇒ 预设组不出现。
// #515 改写点登记（迁移自 Settings.globalPresetMenu.test.tsx，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library；补显式 afterEach(cleanup)。
// - AgentRuntimePanel 的 vi.mock 工厂改 Solid 空组件（#515 W1 起实体直连，mock 不产 React 元素）。
// - React 的 act 包装改直调 setState + vi.waitFor：solid 的 DOM 更新是微任务异步，
//   换桶断言等待 DOM 到位后再跑；断言语义不变、集合不缩减。
import { cleanup, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.solid'
import { resetStores } from '../../test/resetStores.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'

vi.mock('../settings/AgentRuntimePanel.solid.tsx', () => ({ default: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const GUI_LABELS = ['Glass Light', 'Solarized Light', 'Agent 指挥台', 'Agent 关系图', '专注流程']
const TERMINAL_LABELS = ['Claude 风格', 'Nord Frost', 'Tokyo Night', 'Amber CRT', 'Matrix 磷绿']

function presetGroup() {
  const title = screen.getByText('全局预设')
  return within(title.closest('.set-group') as HTMLElement)
}

describe('Settings 全局预设菜单（#201）', () => {
  beforeEach(() => {
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  afterEach(async () => {
    cleanup()
  })

  it('modern-gui 下直接显示 GUI 桶的 5 个预设，终端桶不出现；顺序 = 界面模式在前、全局预设紧随其下', () => {
    mountSettingsSheet()
    const group = presetGroup()
    for (const label of GUI_LABELS) expect(group.getByRole('button', { name: label })).toBeInTheDocument()
    for (const label of TERMINAL_LABELS) expect(group.queryByRole('button', { name: label })).not.toBeInTheDocument()
    // 预设区内无「GUI / 终端」选项按钮（UI 二次修订）
    expect(group.queryByRole('radio')).not.toBeInTheDocument()
    expect(group.queryByRole('button', { name: 'GUI' })).not.toBeInTheDocument()
    expect(group.queryByRole('button', { name: '终端' })).not.toBeInTheDocument()
    const body = document.querySelector('.settings-body') as HTMLElement
    const groupTitles = [...body.querySelectorAll('.set-group-title')]
      .map(el => el.textContent?.replace(/^[▾▸]/, '').trim())
    // 顺序三次修订（2026-09-19）：界面模式在前、全局预设紧随其下
    expect(groupTitles.indexOf('界面模式')).toBeGreaterThanOrEqual(0)
    expect(groupTitles.indexOf('全局预设')).toBeGreaterThan(groupTitles.indexOf('界面模式'))
  })

  it('界面模式 modern-gui ⇄ terminal-like 切换 ⇒ 第二级跟随换桶', async () => {
    mountSettingsSheet()
    expect(presetGroup().getByRole('button', { name: 'Glass Light' })).toBeInTheDocument()
    useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' })
    await vi.waitFor(() => {
      const group = presetGroup()
      for (const label of TERMINAL_LABELS) expect(group.getByRole('button', { name: label })).toBeInTheDocument()
      for (const label of GUI_LABELS) expect(group.queryByRole('button', { name: label })).not.toBeInTheDocument()
    })
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
    await vi.waitFor(() => {
      const group = presetGroup()
      expect(group.getByRole('button', { name: 'Glass Light' })).toBeInTheDocument()
      expect(group.queryByRole('button', { name: 'Claude 风格' })).not.toBeInTheDocument()
    })
  })

  it('★ #607 刀3a：tactical-blue 已入归属桶 ⇒ 预设组出现，但出厂 chip 为空且不亮假账 chip', () => {
    useInterfaceModeStore.setState({ interfaceMode: 'tactical-blue' })
    mountSettingsSheet()
    // 家族内暂只有隐藏默认一员 ⇒ 组在、出厂 chip 一条也没有
    const group = presetGroup()
    for (const label of [...GUI_LABELS, ...TERMINAL_LABELS]) {
      expect(group.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
    // 也不亮兜底「自定义 / 未知预设」假账 chip
    expect(group.queryByText('自定义')).not.toBeInTheDocument()
    expect(group.queryByText('未知预设')).not.toBeInTheDocument()
    // 界面模式 Group 保持原样
    expect(screen.getByText('界面模式')).toBeInTheDocument()
  })
})
