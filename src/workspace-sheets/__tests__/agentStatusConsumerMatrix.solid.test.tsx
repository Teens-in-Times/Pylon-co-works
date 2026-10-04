// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 agentStatusConsumerMatrix.test.tsx，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library；显式 afterEach(cleanup)。
// - WorkspaceTitlebar 直连 Solid 实体（latest 隧道形态，照 App.solid.tsx:495 的用法；
//   React 薄桥 WorkspaceTitlebar.tsx 随本迁移退役）。
// - Settings 侧的 AgentRuntimePanel 是避让域 Solid 实体（经 AgentSettingsSection 直连挂载），
//   渲染提交异步：状态文案断言包 vi.waitFor；断言语义不变、集合不缩减。
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { resetStores } from '../../test/resetStores'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.solid'
import { openOrFocusSettingsSheet } from '../../sheets/settingsSheetNavigation'
import WorkspaceTitlebar from '../WorkspaceTitlebar.solid.tsx'
import type { SheetRecord } from '../sheetTypes'
import type { AgentStatus } from '../../contracts/agentTypes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
const sheets: SheetRecord[] = [
  { id: 'peri-sheet', kind: 'agent', title: 'Peri', agentId: 'peri', createdAt: 1, lastFocusedAt: 1 },
  { id: 'hermes-sheet', kind: 'agent', title: 'Hermes', agentId: 'hermes', createdAt: 2, lastFocusedAt: 2 },
]

const status = (lifecycle: AgentStatus['status']): AgentStatus => ({
  agent: 'peri',
  agentId: 'peri',
  status: lifecycle,
})

const titlebarActions = {
  onToggleSidebar: vi.fn(),
  onFocusSheet: vi.fn(),
  onCloseSheet: vi.fn(),
  menuActions: {
    onTogglePin: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseRight: vi.fn(),
    onReopen: vi.fn(),
  },
  onOpenSheet: vi.fn(),
  onToggleRightPanel: vi.fn(),
  onOpenSettingsDomain: vi.fn(),
  onMinimize: vi.fn(),
  onToggleFullscreen: vi.fn(),
  onCloseWindow: vi.fn(),
}

function renderTitlebar() {
  render(() => (
    <WorkspaceTitlebar latest={() => ({
      ...titlebarActions,
      sheets,
      activeSheetId: 'peri-sheet',
      activeAgent: 'peri',
      sidebarCollapsed: false,
      sidebarEnabled: true,
    })} />
  ))
}

describe('全消费方一致性（ISSUE-03 §6.4 L1：Settings、titlebar 对同一输入得到同一语义）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    Element.prototype.scrollIntoView = vi.fn()
    useIdentityStore.setState({
      agents: [
        { id: 'peri', name: 'Peri' },
        { id: 'hermes', name: 'Hermes' },
      ],
      activeAgent: 'peri',
    })
  })

  afterEach(async () => {
    cleanup()
  })

  describe('WorkspaceTitlebar（状态灯）', () => {
    it('无快照 → 状态灯全灰（mode none），不出现假绿 ok 灯', () => {
      renderTitlebar()

      const lights = document.querySelector('.agent-status-lights') as HTMLElement
      expect(lights.dataset.mode).toBe('none')
      expect(document.querySelector('.agent-light-ok')).toBeNull()
    })

    it('快照 connected → 状态灯进入 ok（cascade 模式，出现 ok 灯）', async () => {
      useRuntimeStore.setState({ agentStatuses: { peri: status('connected') } })
      renderTitlebar()

      await vi.waitFor(() => {
        const lights = document.querySelector('.agent-status-lights') as HTMLElement
        expect(lights.dataset.mode).toBe('cascade')
        expect(document.querySelector('.agent-light-ok')).not.toBeNull()
      })
    })
  })

  describe('Settings（Agent 状态区）', () => {
    // #154 阶段 4 改写：open-settings intent 不再由 Settings 组件内监听消费，
    // 挂载即带归一意图（openOrFocusSettingsSheet 同一入口的落点），语义不变。
    const openAgentTab = () => {
      openOrFocusSettingsSheet({ domain: 'agents-connections', section: 'agent' })
    }

    it('无快照 → 状态显示“状态未知”，不出现假绿“已连接”', async () => {
      mountSettingsSheet()
      openAgentTab()

      await vi.waitFor(() => {
        expect(screen.getByText('状态：状态未知')).toBeInTheDocument()
      })
      expect(screen.queryByText('状态：已连接')).toBeNull()
    })

    it('快照 connected → 状态显示“已连接”', async () => {
      useRuntimeStore.setState({ agentStatuses: { peri: status('connected') } })
      mountSettingsSheet()
      openAgentTab()

      await vi.waitFor(() => {
        expect(screen.getByText('状态：已连接')).toBeInTheDocument()
      })
    })

    it('失败事件（error + 诊断）→ 状态错误且显示最近错误', async () => {
      useRuntimeStore.setState({
        agentStatuses: {
          peri: { agent: 'peri', agentId: 'peri', status: 'error', recentError: '心跳超时' },
        },
      })
      mountSettingsSheet()
      openAgentTab()

      await vi.waitFor(() => {
        expect(screen.getByText('状态：错误')).toBeInTheDocument()
      })
      expect(screen.getByRole('alert')).toHaveTextContent('最近错误：心跳超时')
    })
  })
})
