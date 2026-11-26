// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/** Registry-driven discovery, search, keyboard selection and icon fallback. */
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SheetLauncher from '../SheetLauncher.solid.tsx'
import type { SheetLauncherProps } from '../SheetLauncher.solid.tsx'
import { resetStores } from '../../test/resetStores'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity'
import { registerWorkspace } from '../../plugin-runtime/workspaces/workspaceRegistry'

afterEach(cleanup)

function launcherProps(overrides?: Partial<SheetLauncherProps>): SheetLauncherProps {
  return {
    open: true,
    agents: [],
    sheets: [],
    onOpenChange: vi.fn(),
    onFocusSheet: vi.fn(),
    onOpenSheet: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenProfiles: vi.fn(),
    ...overrides,
  }
}

function renderLauncher(props: SheetLauncherProps): void {
  render(() => <SheetLauncher latest={() => props} />)
}

describe('SheetLauncher Registry 卡片', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('按注册分类显示图标卡片，并可打开包含新增 Overview 在内的 Sheet', () => {
    const onOpenSheet = vi.fn()
    const onOpenChange = vi.fn()
    renderLauncher(launcherProps({ onOpenSheet, onOpenChange }))

    expect(screen.getByText('工作台')).toBeInTheDocument()
    expect(screen.getByText('观察与诊断')).toBeInTheDocument()
    expect(screen.getByText('系统与管理')).toBeInTheDocument()
    const overview = screen.getByRole('option', { name: /Overview.*工作状态与最近会话概览/ })
    expect(overview.querySelector('[data-launch-icon="layout-dashboard"]')).not.toBeNull()
    fireEvent.click(overview)
    expect(onOpenSheet).toHaveBeenCalledWith('overview', 'Overview')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('输入框向辅助技术暴露当前键盘选项并执行该项', () => {
    const onOpenSheet = vi.fn()
    renderLauncher(launcherProps({ onOpenSheet }))
    const input = screen.getByRole('combobox', { name: '搜索 Sheet、Agent 或管理入口' })
    fireEvent.input(input, { target: { value: '运行日志' } })
    const option = screen.getByRole('option', { name: /Runtime/, selected: true })
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)).toBe(option)
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpenSheet).toHaveBeenCalledWith('runtime', 'Runtime')
  })

  it('注册关键词参与 Command 搜索', () => {
    renderLauncher(launcherProps())
    fireEvent.input(screen.getByRole('combobox', { name: '搜索 Sheet、Agent 或管理入口' }), { target: { value: 'diagnostic' } })
    expect(screen.getByRole('option', { name: /Runtime/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Browser/ })).toBeNull()
  })

  // #327：中文界面下英文条目标题不可搜——描述与中英关键词都必须进索引串。
  it('中文关键词与中文描述均可命中条目', () => {
    renderLauncher(launcherProps())
    const input = screen.getByRole('combobox', { name: '搜索 Sheet、Agent 或管理入口' })

    fireEvent.input(input, { target: { value: '设置' } })
    expect(screen.getByRole('option', { name: /设置.*主题、Agent/ })).toBeInTheDocument()

    fireEvent.input(input, { target: { value: '运行日志' } })
    expect(screen.getByRole('option', { name: /Runtime/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Browser/ })).toBeNull()

    fireEvent.input(input, { target: { value: '网关' } })
    expect(screen.getByRole('option', { name: /Gateway/ })).toBeInTheDocument()
  })

  it('无 Agent 时空态不露内部术语', () => {
    renderLauncher(launcherProps())
    expect(screen.getByText('还没有可用的 Agent')).toBeInTheDocument()
    expect(screen.queryByText(/list_agents/)).toBeNull()
  })

  it('搜索无命中时只有一个空态，清空后恢复可选结果', () => {
    renderLauncher(launcherProps({ agents: [{ id: 'peri', name: 'Peri' }] }))
    const input = screen.getByRole('combobox')
    fireEvent.input(input, { target: { value: 'zzz-无此条目' } })
    expect(screen.getByRole('status')).toHaveTextContent('没有匹配项')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(input).not.toHaveAttribute('aria-activedescendant')
    fireEvent.input(input, { target: { value: '' } })
    expect(screen.getByRole('option', { name: /Peri/, selected: true })).toHaveAttribute('id', input.getAttribute('aria-activedescendant'))
  })

  it('鼠标和键盘使用同一选区，向下循环越过不可用项后 Enter 打开高亮条目', () => {
    const registration = registerWorkspace(createPluginIdentity('test.launcher-disabled', 'disabled-card'), {
      kind: 'test.disabled',
      label: 'Disabled',
      singleton: true,
      getSingletonKey: () => 'test.disabled',
      sidebarMode: 'none',
      launch: { kind: 'test.disabled', title: 'Disabled Sheet', description: '不可启动的条目标记', launchable: false, icon: 'activity' },
      component: () => null,
      createInitialState: () => undefined,
      serialize: state => state,
      deserialize: state => state,
    })
    try {
      const props = launcherProps()
      renderLauncher(props)
      const input = screen.getByRole('combobox')
      const options = screen.getAllByRole('option')
      const disabled = screen.getByRole('option', { name: /Disabled Sheet.*暂不可用/ })
      expect(disabled).toHaveAttribute('aria-disabled', 'true')
      const index = options.indexOf(disabled)
      const previous = options.slice(0, index).reverse().find(option => option.getAttribute('aria-disabled') !== 'true')!
      fireEvent.pointerMove(previous)
      expect(previous).toHaveAttribute('aria-selected', 'true')
      fireEvent.pointerMove(disabled)
      fireEvent.click(disabled)
      expect(props.onOpenChange).not.toHaveBeenCalled()
      expect(previous).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      const next = options.slice(index + 1).find(option => option.getAttribute('aria-disabled') !== 'true')!
      expect(screen.getByRole('option', { selected: true })).toBe(next)
      fireEvent.input(input, { target: { value: 'Disabled Sheet' } })
      expect(input).not.toHaveAttribute('aria-activedescendant')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(props.onOpenChange).not.toHaveBeenCalled()
      fireEvent.input(input, { target: { value: '' } })
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(screen.getByRole('option', { selected: true, name: /当前身份/ })).toHaveAttribute('id', input.getAttribute('aria-activedescendant'))
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(props.onOpenProfiles).toHaveBeenCalledOnce()
    } finally {
      registration.dispose()
    }
  })

  it('插件声明未知图标键时使用 host 通用图标，不加载插件 React 组件', () => {
    const registration = registerWorkspace(createPluginIdentity('test.launcher-card', 'unknown-icon'), {
      kind: 'test.unknown-icon',
      label: 'Future',
      singleton: true,
      getSingletonKey: () => 'test.unknown-icon',
      sidebarMode: 'none',
      launch: { kind: 'test.unknown-icon', title: 'Future Sheet', description: '插件未来图标', launchable: true, icon: 'future-glyph' },
      component: () => null,
      createInitialState: () => undefined,
      serialize: state => state,
      deserialize: state => state,
    })
    try {
      renderLauncher(launcherProps())
      const future = screen.getByRole('option', { name: /Future Sheet/ })
      expect(future.querySelector('[data-launch-icon="future-glyph"] .lucide-square-stack')).not.toBeNull()
    } finally {
      registration.dispose()
    }
  })
})
