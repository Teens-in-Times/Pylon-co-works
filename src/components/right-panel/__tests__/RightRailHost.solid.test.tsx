// @vitest-environment jsdom
// 右栏折叠态的可聚焦性契约：面板折叠后仍挂在 DOM 里保留内部状态，但必须整体退出
// 命中测试、tab 序与可访问性树。`aria-hidden` 单独挡不住键盘（实测折叠态仍可 focus
// 6 个控件），所以折叠 = `inert`（且与 `aria-hidden` 同进同出）。
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RightRailHost from '../RightRailHost.solid.tsx'
import { getContextPanelRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import { useRightRailStore } from '../../../domains/workspace/layoutRailsStore.ts'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes.ts'

const registrations: AsyncDisposable[] = []

const sheet: SheetRecord = {
  id: 'rail-sheet',
  kind: 'agent',
  title: '右栏折叠测试',
  createdAt: 1,
  lastFocusedAt: 1,
}

const ctx: SheetContext = {
  openSheet: vi.fn(() => null),
  focusSheet: vi.fn(),
  closeSheet: vi.fn(),
  activeSession: null,
  selectSession: vi.fn(),
  openProfileEdit: vi.fn(),
  openSessionSettings: vi.fn(),
  sidebarCollapsed: false,
  rightInset: 0,
  sessionSource: vi.fn(() => null),
  sessionBySource: vi.fn(() => undefined),
}

function registerPanel(): void {
  const identity = createPluginIdentity('test.right-rail', 'run-1')
  registrations.push(getContextPanelRegistry().register(identity, {
    id: 'rail-panel',
    workspaceKind: sheet.kind,
    label: '上下文',
    order: 100,
    renderKind: 'first-party-solid',
    component: () => <button type="button">面板按钮</button>,
  }))
}

afterEach(async () => {
  cleanup()
  await Promise.all(registrations.splice(0).map(registration => registration.dispose()))
  useRightRailStore.getState().setCollapsed(false)
  vi.restoreAllMocks()
})

const hostOf = () => document.querySelector<HTMLElement>('.right-rail-host')

describe('RightRailHost 折叠可聚焦性（#699 折叠缺陷）', () => {
  it('折叠时挂 inert 并保留 aria-hidden，展开时一并移除', async () => {
    registerPanel()
    useRightRailStore.getState().setCollapsed(false)
    render(() => <RightRailHost sheet={sheet} ctx={ctx} activeAgent="peri" />)

    const host = hostOf()!
    expect(host).not.toBeNull()
    expect(host).toHaveAttribute('data-collapsed', 'false')
    expect(host).not.toHaveAttribute('inert')
    expect(host).not.toHaveAttribute('aria-hidden')

    useRightRailStore.getState().setCollapsed(true)
    expect(host).toHaveAttribute('data-collapsed', 'true')
    expect(host).toHaveAttribute('inert')
    expect(host).toHaveAttribute('aria-hidden', 'true')

    useRightRailStore.getState().setCollapsed(false)
    expect(host).not.toHaveAttribute('inert')
    expect(host).not.toHaveAttribute('aria-hidden')
  })

  it('折叠时宽度手柄同时退出 tab 序', () => {
    registerPanel()
    useRightRailStore.getState().setCollapsed(true)
    render(() => <RightRailHost sheet={sheet} ctx={ctx} activeAgent="peri" />)

    const handle = document.querySelector<HTMLElement>('.right-rail-resize-handle')!
    expect(handle).toHaveAttribute('tabindex', '-1')

    useRightRailStore.getState().setCollapsed(false)
    expect(handle).toHaveAttribute('tabindex', '0')
  })
})
