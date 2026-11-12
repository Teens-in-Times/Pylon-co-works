// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * SheetLauncher Agent 激活事务：选择非 active Agent 时等 switch 成功后才打开 Sheet。
 *
 * #515：迁移自 sheetLauncherAgentSwitch.test.tsx（React RTL → @solidjs/testing-library，
 * 实体直连 SheetLauncher.solid.tsx）。改写点登记：
 * - 实体 props 形态是 `latest: () => SheetLauncherProps` 访问器隧道（照 App.solid.tsx 用法）；
 * - Solid 无 act：pending.resolve 后直接 `waitFor` 断言（事务链经 Promise 微任务
 *   推进，waitFor 轮询 DOM/闭包即可见）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（switch_agent invoke 参数、成功前不开 sheet、成功后开 agent sheet
 *   并关闭 launcher）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SheetLauncher from '../SheetLauncher.solid.tsx'
import type { SheetLauncherProps } from '../SheetLauncher.solid.tsx'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { activateAgentSheet } from '../activateAgentSheet'
import { resetStores } from '../../test/resetStores'

afterEach(cleanup)

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

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

describe('SheetLauncher Agent 激活事务', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.scrollIntoView = vi.fn()
    useIdentityStore.setState({ activeAgent: 'peri' })
  })

  it('选择非 active Agent 时等 switch 成功后才打开 Sheet', async () => {
    const pending = deferred<unknown>()
    invoke.mockReturnValueOnce(pending.promise)
    const onOpenSheet = vi.fn()
    const onOpenChange = vi.fn()
    render(() => <SheetLauncher latest={() => launcherProps({
      agents: [{ id: 'peri', name: 'Peri' }, { id: 'hermes', name: 'Hermes' }],
      onOpenChange,
      onOpenSheet,
    })} />)

    fireEvent.click(screen.getByRole('option', { name: /Hermes/ }))

    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'hermes' })
    expect(onOpenSheet).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    pending.resolve(null)

    await waitFor(() => expect(onOpenSheet).toHaveBeenCalledWith('agent', 'Hermes', 'hermes'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('首个 Agent 已被配置选中但尚未启动时，等待真实激活后再打开', async () => {
    useIdentityStore.setState({ activeAgent: '' })
    useIdentityStore.getState().setAgents([{ id: 'qa-ui', name: 'UI验收Agent', active: true }])
    expect(useIdentityStore.getState().activeAgent).toBe('qa-ui')
    const pending = deferred<unknown>()
    invoke.mockImplementation(command => command === 'switch_agent' ? pending.promise : Promise.resolve({ agent: 'qa-ui', status: 'connected' }))
    const props = launcherProps({ agents: [{ id: 'qa-ui', name: 'UI验收Agent' }] })
    render(() => <SheetLauncher latest={() => props} />)
    fireEvent.click(screen.getByRole('option', { name: /UI验收Agent/ }))
    expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'qa-ui' })
    expect(props.onOpenSheet).not.toHaveBeenCalled()
    pending.resolve(null)
    await waitFor(() => expect(props.onOpenSheet).toHaveBeenCalledWith('agent', 'UI验收Agent', 'qa-ui'))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('同 Agent 激活失败时保留 launcher，不能以配置选中冒充成功', async () => {
    invoke.mockRejectedValueOnce(new Error('Agent 启动失败'))
    const props = launcherProps({ agents: [{ id: 'peri', name: 'Peri' }] })
    render(() => <SheetLauncher latest={() => props} />)
    fireEvent.click(screen.getByRole('option', { name: /Peri/ }))
    await waitFor(() => expect(screen.getByRole('option', { name: /Peri/ })).not.toHaveAttribute('aria-disabled', 'true'))
    expect(props.onOpenSheet).not.toHaveBeenCalled()
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('已连接 Agent 直接打开，不重启运行时', async () => {
    useRuntimeStore.getState().setAgentStatus('peri', { agent: 'peri', status: 'connected' })
    const props = launcherProps({ agents: [{ id: 'peri', name: 'Peri' }] })
    render(() => <SheetLauncher latest={() => props} />)
    fireEvent.click(screen.getByRole('option', { name: /Peri/ }))
    await waitFor(() => expect(props.onOpenSheet).toHaveBeenCalledWith('agent', 'Peri', 'peri'))
    expect(invoke).not.toHaveBeenCalled()
  })

  it('同一 Agent 的并行打开共用一次启动，但各自完成打开动作', async () => {
    const pending = deferred<unknown>()
    invoke.mockImplementation(command => command === 'switch_agent' ? pending.promise : Promise.resolve({ agent: 'peri', status: 'connected' }))
    const open = vi.fn()
    const focus = vi.fn()
    const first = activateAgentSheet('peri', 'Peri', open)
    const second = activateAgentSheet('peri', 'Peri', focus)
    expect(invoke.mock.calls.filter(([command]) => command === 'switch_agent')).toHaveLength(1)
    pending.resolve(null)
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(open).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
  })
})
