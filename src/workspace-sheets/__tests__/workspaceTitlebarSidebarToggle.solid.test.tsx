// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * I09-A-FE-01（AC-1 / 方案 B）：无 sidebar 的 Sheet 不生成可操作折叠按钮。
 * #154（统一侧栏模型）改写：判据从「按 sidebarMode 给按钮 disabled」收紧为
 * 「按注册表是否真的提供 sidebar 组件决定按钮是否存在」，且按钮**移到右侧应用
 * 控制簇**——折叠后左轨道为 0 宽，按钮若留在左格会随轨道一起消失，用户将无法
 * 再展开。断言强度不降：原「禁用 + 不发事件」改为「不存在 + 恰好没有该按钮」，
 * 并新增按钮归属簇与 aria-expanded 的断言。
 *
 * #515：迁移自 workspaceTitlebarSidebarToggle.test.tsx（React RTL → @solidjs/testing-library，
 * 实体直连 WorkspaceTitlebar.solid.tsx）。改写点登记：
 * - 实体 props 形态是 `latest: () => WorkspaceTitlebarProps` 访问器隧道（照 App.solid.tsx
 *   用法）：`render(() => <WorkspaceTitlebar latest={() => props} />)`；
 * - rerender 用例（折叠按钮节点复用）改为 createSignal 驱动 latest 隧道：Solid 无
 *   rerender，`setCollapsed(true)` 后断言同一 DOM 节点换标注——同一契约的 Solid 原生
 *   等价（Solid 属性更新不重建节点）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 几何/DOM 断言逐字保留（.workspace-titlebar-sidebar 左格首位、三灯 brand 类、
 *   app-controls 簇归属、窗口控制三按钮顺序、aria-expanded/title/sidebar-collapsed 类）。
 */
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import WorkspaceTitlebar from '../WorkspaceTitlebar.solid.tsx'
import type { WorkspaceTitlebarProps } from '../WorkspaceTitlebar.solid.tsx'
import { resetStores } from '../../test/resetStores'
import type { SheetRecord } from '../sheetTypes'
import { getContextPanelRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../../plugin-runtime/registry/types.ts'

const registrations: AsyncDisposable[] = []
afterEach(async () => {
  cleanup()
  await Promise.all(registrations.splice(0).map(registration => registration.dispose()))
})

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
const sheets: SheetRecord[] = []

function makeTitlebarProps(overrides?: Partial<WorkspaceTitlebarProps>): WorkspaceTitlebarProps {
  return {
    sheets,
    activeSheetId: null,
    activeAgent: 'peri',
    sidebarCollapsed: false,
    sidebarEnabled: false,
    onToggleSidebar: vi.fn(),
    onFocusSheet: vi.fn(),
    onCloseSheet: vi.fn(),
    menuActions: { onTogglePin: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReopen: vi.fn() },
    onOpenSheet: vi.fn(),
    onToggleRightPanel: vi.fn(),
    onOpenSettingsDomain: vi.fn(),
    onMinimize: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onCloseWindow: vi.fn(),
    ...overrides,
  }
}

function renderTitlebar(props: WorkspaceTitlebarProps): void {
  render(() => <WorkspaceTitlebar latest={() => props} />)
}

const toggleButton = () => document.querySelector<HTMLButtonElement>('[data-sidebar-toggle="true"]')

describe('I09-A-FE-01 / #154 titlebar 折叠按钮 capability', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('active Sheet 有侧栏 → 折叠按钮可操作，点击折叠', () => {
    const onToggleSidebar = vi.fn()
    renderTitlebar(makeTitlebarProps({ sidebarEnabled: true, onToggleSidebar }))
    const button = screen.getByRole('button', { name: '收起左栏' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onToggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('active Sheet 无侧栏 → 折叠按钮禁用（保留位置，不忽隐忽现）', () => {
    const onToggleSidebar = vi.fn()
    renderTitlebar(makeTitlebarProps({ sidebarEnabled: false, onToggleSidebar }))
    const button = toggleButton()
    expect(button).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', '当前 Sheet 无侧栏')
    expect(document.querySelector('.workspace-titlebar')).toHaveClass('sidebar-disabled')
    expect(screen.queryByLabelText('Agent 状态')).toBeNull()
    fireEvent.click(button!)
    expect(onToggleSidebar).not.toHaveBeenCalled()
  })

  it('折叠按钮在最左、三灯在其右，且**不在**右侧应用控制簇内（三菜单与窗口控制位置不受影响）', () => {
    renderTitlebar(makeTitlebarProps({ sidebarEnabled: true }))
    const button = toggleButton()
    expect(button).not.toBeNull()
    const cell = button!.closest('.workspace-titlebar-sidebar')
    expect(cell).not.toBeNull()
    // 顺序：按钮是左格首个元素，三灯紧随其右。
    expect(cell!.firstElementChild).toBe(button)
    expect(button!.nextElementSibling).toHaveClass('workspace-titlebar-brand')
    expect(button!.closest('.workspace-window-app-controls')).toBeNull()
    expect(button!.closest('.workspace-window-controls')).toBeNull()
    expect(button!.closest('.workspace-titlebar-workspace')).toBeNull()

    // 应用控制簇里只有一个齿轮菜单触发（外加右栏折叠钮与插件贡献），不得混入左栏折叠按钮。
    const appControls = document.querySelector('.workspace-window-app-controls')!
    expect(appControls.querySelectorAll('[data-sidebar-toggle="true"]').length).toBe(0)
    expect([...appControls.querySelectorAll('[data-menu-trigger]')].map(b => b.getAttribute('data-menu-trigger')))
      .toEqual(['app-menu'])
    expect([...appControls.querySelectorAll('[data-right-rail-toggle="true"]')].length).toBe(1)

    // 窗口控制三按钮照旧存在且顺序不变。
    const nativeControls = document.querySelector('.workspace-window-native-controls')!
    expect([...nativeControls.querySelectorAll('button')].map(b => b.getAttribute('aria-label')))
      .toEqual(['最小化', '最大化或还原', '关闭窗口'])
  })

  it('折叠态按钮仍在左格首位（位置折叠前后不变），三灯隐藏', () => {
    renderTitlebar(makeTitlebarProps({ sidebarEnabled: true, sidebarCollapsed: true }))
    const button = toggleButton()
    // 左格折叠时收窄到按钮宽度而不是归零，所以按钮仍在原位、可点。
    expect(button).not.toBeNull()
    expect(button!.closest('.workspace-titlebar-sidebar')).not.toBeNull()
    expect(button!.closest('.workspace-titlebar-sidebar')!.firstElementChild).toBe(button)
    expect(button).not.toBeDisabled()
    expect(screen.getByRole('button', { name: '展开左栏' })).toBe(button)
    // 折叠后三灯不显示。
    expect(document.querySelector('.workspace-titlebar-brand')).toBeNull()
  })

  it('已折叠且有侧栏 → 按钮标注展开，且状态灯一并隐藏', () => {
    renderTitlebar(makeTitlebarProps({ sidebarEnabled: true, sidebarCollapsed: true }))
    const button = screen.getByRole('button', { name: '展开左栏' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button.closest('.workspace-titlebar')).toHaveClass('sidebar-collapsed')
    // #154：折叠后状态灯不显示（左格不参与布局）。
    expect(button.closest('.workspace-titlebar')?.querySelector('.workspace-titlebar-brand')).toBeNull()
  })

  it('展开且有侧栏 → 状态灯可见、aria-expanded 为真', () => {
    renderTitlebar(makeTitlebarProps({ sidebarEnabled: true }))
    const button = screen.getByRole('button', { name: '收起左栏' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(button.closest('.workspace-titlebar')).toHaveClass('sidebar-expanded')
    expect(button.closest('.workspace-titlebar')?.querySelector('.workspace-titlebar-brand')).not.toBeNull()
  })

  it('Agent 展开和折叠复用同一个折叠按钮节点', () => {
    // Solid 无 rerender：sidebarCollapsed 走 signal 驱动 latest 隧道（App.solid 同款），
    // 断言同一契约——prop 更新只换按钮标注，不重建节点。
    const onToggleSidebar = vi.fn()
    const [collapsed, setCollapsed] = createSignal(false)
    render(() => (
      <WorkspaceTitlebar latest={() => makeTitlebarProps({ sidebarEnabled: true, sidebarCollapsed: collapsed(), onToggleSidebar })} />
    ))
    const expandedButton = screen.getByRole('button', { name: '收起左栏' })
    setCollapsed(true)
    expect(screen.getByRole('button', { name: '展开左栏' })).toBe(expandedButton)
  })

  it('active Sheet 无右栏贡献时禁用右栏按钮', () => {
    const onToggleRightPanel = vi.fn()
    renderTitlebar(makeTitlebarProps({ rightPanelEnabled: false, onToggleRightPanel }))
    const button = document.querySelector<HTMLButtonElement>('[data-right-rail-toggle="true"]')!
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-label', '当前没有可用右侧栏')
    expect(button).toHaveAttribute('title', '当前没有可用右侧栏')
    fireEvent.click(button)
    expect(onToggleRightPanel).not.toHaveBeenCalled()
  })

  it('reflects effective rail visibility and explains when the viewport cannot open a rail', () => {
    registrations.push(getContextPanelRegistry().register(createPluginIdentity('test.responsive-titlebar', 'run'), {
      id: 'global', scope: 'global', label: '工具', order: 100, renderKind: 'first-party-solid', component: () => null,
    }))
    const [narrow, setNarrow] = createSignal(true)
    render(() => <WorkspaceTitlebar latest={() => makeTitlebarProps({
      sidebarEnabled: true, sidebarCollapsed: narrow(), sidebarCanExpand: !narrow(),
      rightPanelEnabled: true, rightPanelCollapsed: narrow(), rightPanelCanExpand: !narrow(),
    })} />)
    const left = screen.getByRole('button', { name: '放大窗口以展开左栏' })
    const right = screen.getByRole('button', { name: '放大窗口以展开右侧栏' })
    expect(left).toBeDisabled()
    expect(right).toBeDisabled()
    expect(left).toHaveAttribute('aria-expanded', 'false')
    expect(right).toHaveAttribute('aria-expanded', 'false')
    setNarrow(false)
    expect(left).not.toBeDisabled()
    expect(right).not.toBeDisabled()
    expect(left).toHaveAttribute('aria-expanded', 'true')
    expect(right).toHaveAttribute('aria-expanded', 'true')
  })
})
