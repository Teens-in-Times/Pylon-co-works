// @vitest-environment jsdom
/**
 * P79 Gateway 页交互优化行为回归：
 * 1. 凭据表单按 catalog credentialFields 动态渲染（QQ = App ID + Client Secret 两框），
 *    提交按字段顺序 join ':' 写入 gateway_instance_set_credentials；
 * 2. 删除二段确认：第一次点击不触发删除（仅进入确认态），二次点击才调用命令；
 * 3. 实例状态轮询：sheet 挂载期间每 3s 重新拉取 gateway_instances（状态翻转可见性）。
 * 4. 知识注入区只读：注入事实来自 gateway_status 快照，区块内不提供任何可编辑控件
 *    （取代原 legacy 脚本中的文案字面量断言 `/归 Prism 管理，只读/`——那条断言管文案标点，
 *    P82 视觉精修或任何文案调整都会把它撞红，而它对“区块被改成可编辑”反而一声不响）。
 *
 * #515：自 React 测试逐用例移植为 Solid 实体原生测试（断言集不缩减）。改写点：
 * - React `act` 刷效 → 微任务 flush（Solid 信号同步通知，无 act 等价物）；
 * - 文本输入 fireEvent.change → fireEvent.input（实体 onInput 契约）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@solidjs/testing-library'
import { FakeInvoke } from '../../../test/fakeInvoke'
import GatewaySheetView from '../GatewaySheetView.solid'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import { clearErrors } from '../../../app/errorCenter.ts'

const fakeInvoke = new FakeInvoke()

const CATALOG = [
  {
    platform: 'qq',
    label: 'QQ',
    availability: 'builtIn',
    credentialFields: [
      { key: 'appId', label: 'App ID', secret: false, required: true },
      { key: 'clientSecret', label: 'Client Secret', secret: true, required: true },
    ],
    capabilities: { deliverText: true, deliverEvent: true, ingest: true, maxMessageLen: 4000 },
  },
]

function installHandlers(instances: Array<Record<string, unknown>>): void {
  fakeInvoke.registerMany({
    gateway_status: () => ({ adapters: [], routes: [], inject: null }),
    gateway_sessions: () => [],
    gateway_instances: () => instances,
    gateway_catalog: () => CATALOG,
  })
}

function renderSheet(): void {
  const sheet: SheetRecord = { id: 'gw', kind: 'gateway', title: 'Gateway', createdAt: 0, lastFocusedAt: 0 }
  render(() => <GatewaySheetView sheet={sheet} ctx={{} as SheetContext} />)
}

/** 刷掉挂载期的 promise 链（原 React act(async () => {}) 的等价）。
 * 只冲微任务——setTimeout 会被 vi.useFakeTimers 冻结（轮询用例在假定时器下 flush）。 */
async function flushEffects(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

describe('P79 Gateway 页交互优化', () => {
  beforeEach(() => {
    fakeInvoke.calls.length = 0
    const w = window as unknown as Record<string, unknown>
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => fakeInvoke.invoke(cmd, args ?? {}),
      transformCallback: () => 0,
      unregisterCallback: () => {},
      convertFileSrc: (path: string) => path,
    }
  })

  afterEach(() => {
    clearErrors()
    vi.useRealTimers()
  })

  it('知识注入区只读：显示 gateway 上报事实且不提供任何可编辑控件', async () => {
    fakeInvoke.registerMany({
      gateway_status: () => ({
        adapters: [],
        routes: [],
        qq: null,
        inject: { enabled: true, scenario: 'gateway-inject', sources: ['memory'], persist: 'prism' },
      }),
      gateway_sessions: () => [],
      gateway_instances: () => [],
      gateway_catalog: () => CATALOG,
    })
    renderSheet()
    await flushEffects()

    // 以“快照里的值”定位区块（不按标题文案定位，改文案不会让本断言变红）。
    const section = screen.getByText('gateway-inject').closest('section')
    expect(section).not.toBeNull()
    // 只读契约：整个知识注入区块里没有任何可编辑控件（输入/下拉/按钮/contenteditable）。
    expect(section!.querySelectorAll('input, select, textarea, button, [contenteditable="true"]')).toHaveLength(0)
  })

  it('creation stays single-flight and retains the form after a failed request', async () => {
    installHandlers([])
    let rejectCreate!: (reason: Error) => void
    fakeInvoke.register('gateway_instance_create', () => new Promise((_, reject) => { rejectCreate = reject }))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderSheet()
    await flushEffects()
    const platform = screen.getByLabelText('平台')
    const id = screen.getByLabelText('实例 id') as HTMLInputElement
    const label = screen.getByLabelText('实例标签') as HTMLInputElement
    expect(id.closest('label')?.textContent).toContain('实例标识')
    expect(screen.getByLabelText('路由 source').closest('label')?.textContent).toContain('消息来源')
    fireEvent.change(platform, { target: { value: 'qq' } })
    fireEvent.input(id, { target: { value: 'qq-new' } })
    fireEvent.input(label, { target: { value: '新助手' } })
    const create = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement
    fireEvent.click(create)
    fireEvent.click(create)
    await flushEffects()
    expect(create.disabled).toBe(true)
    expect(fakeInvoke.calls.filter(call => call.cmd === 'gateway_instance_create')).toHaveLength(1)
    rejectCreate(new Error('实例标识已存在'))
    await flushEffects()
    expect(id.value).toBe('qq-new')
    expect(label.value).toBe('新助手')
    expect(screen.getByText('实例标识已存在')).toBeDefined()
    expect(create.disabled).toBe(false)
    expect(errorLog).toHaveBeenCalledWith('创建网关实例失败', expect.any(Error))
    errorLog.mockRestore()
  })

  it('凭据表单按 catalog 渲染双字段，提交按字段顺序 join ":"', async () => {
    installHandlers([
      { id: 'qq-acc', platform: 'qq', label: 'QQ', enabled: true, autoStart: false, status: 'stopped', lastError: null, credentialStatus: 'missing', credentialRef: null },
    ])
    renderSheet()
    await flushEffects()

    // 双字段渲染：App ID 明文框 + Client Secret 密码框（aria-label 带 instance id）
    const appId = screen.getByLabelText('qq-acc App ID') as HTMLInputElement
    const clientSecret = screen.getByLabelText('qq-acc Client Secret') as HTMLInputElement
    expect(appId).toBeDefined()
    expect(clientSecret.type).toBe('password')

    // 必填字段未填齐 → 保存凭据禁用
    expect((screen.getByRole('button', { name: '保存凭据' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.input(appId, { target: { value: 'app123' } })
    fireEvent.input(clientSecret, { target: { value: 'secretXYZ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }))
    await flushEffects()

    const call = fakeInvoke.calls.find(entry => entry.cmd === 'gateway_instance_set_credentials')
    expect(call).toBeDefined()
    expect(call!.args).toEqual({ id: 'qq-acc', secret: 'app123:secretXYZ' })
  })

  it('删除需要二次确认：首次点击不删，确认后才调用命令', async () => {
    installHandlers([
      { id: 'qq-del', platform: 'qq', label: 'QQ', enabled: true, autoStart: false, status: 'stopped', lastError: null, credentialStatus: 'configured', credentialRef: 'r1' },
    ])
    renderSheet()
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: '删除 qq-del' }))
    await flushEffects()
    expect(fakeInvoke.calls.some(entry => entry.cmd === 'gateway_instance_remove')).toBe(false)
    expect(screen.getByRole('button', { name: '确认删除 qq-del' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '确认删除 qq-del' }))
    await flushEffects()
    const call = fakeInvoke.calls.find(entry => entry.cmd === 'gateway_instance_remove')
    expect(call).toBeDefined()
    expect(call!.args).toEqual({ id: 'qq-del' })
  })

  it('实例状态轮询：挂载期间定时重拉 gateway_instances', async () => {
    vi.useFakeTimers()
    installHandlers([
      { id: 'qq-acc', platform: 'qq', label: 'QQ', enabled: true, autoStart: false, status: 'starting', lastError: null, credentialStatus: 'configured', credentialRef: 'r1' },
    ])
    renderSheet()
    await flushEffects()
    const instancesCallsBefore = fakeInvoke.calls.filter(entry => entry.cmd === 'gateway_instances').length

    await vi.advanceTimersByTimeAsync(3100)
    await flushEffects()
    const instancesCallsAfter = fakeInvoke.calls.filter(entry => entry.cmd === 'gateway_instances').length
    expect(instancesCallsAfter).toBeGreaterThan(instancesCallsBefore)
  })
})
