// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * 重启会话恢复回归（用户报告 2026-09-05）：重启应用后回到会话，
 * 历史不加载且发消息新建了会话。
 *
 * 恢复链：hydration ready → SheetLayout 从 sheetAgentStates[agent].activeSessionId
 * 恢复会话选择。本测试锁两件事：
 * 1) belongsToProfile 清理 effect 不得在 sessions 尚未水合（空列表）时把
 *    App 级 activeSession 清成 null——恢复的目标会话在 sessions=[] 中
 *    必然找不到，先到的清理会撤销紧随其后的恢复。
 * 2) 恢复效应在 sessions 到位后仍能正常选中记忆中的会话。
 *
 * #515：迁移自 sheetLayoutRestartSessionRestore.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - `render(<SheetLayout/>)` → `render(() => <SheetLayout/>)`，实体直连 SheetLayout.solid.tsx；
 * - `act(() => store.setState(...)/setStatus/hydrate)` → 直接调用（Solid 无 act，
 *   store 通知 → 信号 → effect 同步重跑）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（空 sessions 不撤销恢复、记忆会话选中、跨 profile 清理仍生效）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { cleanup, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import SheetLayout from '../SheetLayout.solid.tsx'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { useHydrationStore } from '../../app/bootstrap/hydrationState'
import { resetStores } from '../../test/resetStores'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

function seedRememberedSession(sessionId: string, agentId = 'peri') {
  // 预置持久化 sheet 状态：上次退出时记忆的当前会话
  const open = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId, title: agentId })
  useWorkspaceStore.getState().setSheetAgentState(agentId, { activeSessionId: sessionId })
  return open
}

function seedSession(sessionId: string, agentId = 'peri', profileId = 'default') {
  useIdentityStore.setState({
    sessions: [{
      id: sessionId, source: `local:${sessionId}`, agentId, profileId, name: sessionId,
      createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
      skills: [], hooks: [], autoName: '',
    }],
    activeProfileId: profileId,
  })
}

describe('重启后 activeSession 恢复不被 hydration 竞态清空', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useHydrationStore.getState().setStatus('idle')
    // These cases exercise session hydration after the Agent has connected.
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', status: 'connected' })
  })

  it('sessions 未水合时清理 effect 不得清空恢复中的 activeSession', () => {
    seedRememberedSession('session-restored')
    let selected: string | null = null
    const selectSession = vi.fn((id: string | null) => { selected = id })

    render(() => (
      <SheetLayout
        activeSession={null}
        onSelectSession={selectSession}
        onProfileEdit={() => {}}
        onSessionSettings={() => {}}
      />
    ))

    // 模拟重启时序：hydration ready（记忆可读），但 sessions 列表仍为空
    //（hydrateSessions 尚未完成）。恢复 effect 会选中记忆会话；
    // 清理 effect 若无守卫，会因 sessions=[] 查无此会话而立刻清回 null。
    useHydrationStore.getState().setStatus('ready')
    useWorkspaceStore.getState().hydrateWorkspaceSheets()

    // 恢复选择应当存活：清理 effect 不允许用空 sessions 撤销它
    expect(selected).toBe('session-restored')

    // sessions 到位后状态依旧成立
    seedSession('session-restored')
    expect(selected).toBe('session-restored')
  })

  it('记忆会话确实不属于当前 profile 时（用户显式切 profile）仍清理', () => {
    seedRememberedSession('session-other-profile')
    seedSession('session-other-profile', 'peri', 'local')
    useIdentityStore.setState({ activeProfileId: 'default' })

    let selected: string | null = 'session-other-profile'
    const selectSession = vi.fn((id: string | null) => { selected = id })
    render(() => (
      <SheetLayout
        activeSession="session-other-profile"
        onSelectSession={selectSession}
        onProfileEdit={() => {}}
        onSessionSettings={() => {}}
      />
    ))
    useHydrationStore.getState().setStatus('ready')
    useWorkspaceStore.getState().hydrateWorkspaceSheets()
    expect(selected).toBe(null)
  })

  it('reactive selection remains pending until its session row hydrates', () => {
    seedRememberedSession('session-pending')
    const [selected, select] = createSignal<string | null>(null)
    render(() => <SheetLayout activeSession={selected()} onSelectSession={select} onProfileEdit={() => {}} onSessionSettings={() => {}} />)

    useHydrationStore.getState().setStatus('ready')
    expect(selected()).toBe('session-pending')
    expect(useWorkspaceStore.getState().sheetAgentStates.peri.activeSessionId).toBe('session-pending')
    seedSession('session-pending')
    expect(selected()).toBe('session-pending')
  })
})
