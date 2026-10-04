// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * SheetLayout 级回归钉：agent ↔ settings 互切时左栏内容必须跟随 kind 切换。
 *
 * #520 的 SheetSidebarSlot 单体级回归钉（sheetSidebarSlot.switch）覆盖了「同一 Slot
 * 直接换 sheet prop」的场景；本测试补全**宿主链路**——SheetLayout 的非键控 Show
 * 包裹 + keep-alive agent 槽位同时在场时，settings ↔ agent 互切左栏互斥切换。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import SheetLayout from '../SheetLayout.solid.tsx'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { resetStores } from '../../test/resetStores'

afterEach(cleanup)

function renderLayout() {
  return render(() => (
    <SheetLayout
      activeSession={null}
      onSelectSession={() => {}}
      onProfileEdit={() => {}}
      onSessionSettings={() => {}}
    />
  ))
}

describe('SheetLayout 切 kind 左栏切换（agent ↔ settings）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('agent → settings → agent：左栏随 activeSheet.kind 互斥切换', async () => {
    const store = useWorkspaceStore.getState()
    const agentId = store.openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    const settingsId = store.openSheet({ kind: 'settings', title: '设置' })
    expect(agentId).not.toBeNull()
    expect(settingsId).not.toBeNull()
    store.focusSheet(agentId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.agent-sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(container.querySelector('.settings-sheet-nav')).toBeNull()

    store.focusSheet(settingsId!)
    await waitFor(() => expect(container.querySelector('.settings-sheet-nav')).toBeTruthy(), { timeout: 10_000 })
    expect(container.querySelector('.agent-sidebar')).toBeNull()

    store.focusSheet(agentId!)
    await waitFor(() => expect(container.querySelector('.agent-sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(container.querySelector('.settings-sheet-nav')).toBeNull()
  })
})
