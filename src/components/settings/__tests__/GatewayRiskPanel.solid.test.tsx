/**
 * ISSUE-13 W5 GatewayRiskPanel 测试（#515 迁移为 Solid 实体直连）：
 * - Tauri 模式：加载实例 → 显示实例/凭据状态 + 备份边界提示（不伪装备份加密）
 * - 空实例 / 加载失败可重试 / browser 模式提示需后端（自 browser 专用文件并入）
 * - T13-7：Gateway secret 不进入通用导出（CONFIG_STORAGE_KEYS 无凭据 key）
 * 断言改写点登记：仅 render(() => JSX) 与 afterEach(cleanup) 形态差异，断言集原样。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { FakeInvoke } from '../../../test/fakeInvoke'
import GatewayRiskPanel from '../GatewayRiskPanel.solid.tsx'
import { CONFIG_STORAGE_KEYS } from '../../../application/configExportImport'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
// IS_TAURI 经 getter 暴露，用例可按模式切换（实体 setup 时读取）
const { envState } = vi.hoisted(() => ({ envState: { isTauri: true } }))
vi.mock('../../../infrastructure/tauri/env', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../infrastructure/tauri/env')>()),
  get IS_TAURI() { return envState.isTauri },
}))

/** once 队列：依次返回值；{ reject } 项抛出（对齐 mockRejectedValueOnce） */
function queue<T>(...steps: Array<T | { reject: unknown }>): () => T | undefined {
  const pending = [...steps]
  return () => {
    const step = pending.shift()
    if (step === undefined) return undefined
    if (typeof step === 'object' && step !== null && 'reject' in step) throw (step as { reject: unknown }).reject
    return step as T
  }
}

let fakeInvoke: FakeInvoke

afterEach(() => cleanup())

beforeEach(() => {
  fakeInvoke = new FakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
})

const instances = [
  { id: 'qq-main', platform: 'qq', label: '主 QQ', enabled: true, autoStart: false,
    status: 'connected', lastError: null, credentialStatus: 'configured', credentialRef: 'ref' },
  { id: 'qq-spare', platform: 'qq', label: '备用', enabled: false, autoStart: false,
    status: 'stopped', lastError: null, credentialStatus: 'missing', credentialRef: null },
]

describe('GatewayRiskPanel Tauri 模式', () => {
  beforeEach(() => {
    localStorage.clear()
    envState.isTauri = true
  })

  it('加载实例 → 显示状态与凭据状态 + 备份边界提示（不伪装备份加密）', async () => {
    fakeInvoke.register('gateway_instances', () => instances)
    render(() => <GatewayRiskPanel />)
    expect(await screen.findByText(/实例 2 个：已配置凭据 1、\s*未配置 1/)).toBeInTheDocument()
    expect(screen.getByText(/主 QQ · 已连接 · 凭据：已配置/)).toBeInTheDocument()
    expect(screen.getByText(/备用 · 已停止 · 凭据：未配置/)).toBeInTheDocument()
    // 未配置凭据的实例 → 无法连接提示
    expect(screen.getByText(/有实例未配置凭据，无法连接/)).toBeInTheDocument()
    // 备份边界：准确提示，不假定已加密备份
    expect(screen.getByText(/安全备份能力尚未提供/)).toBeInTheDocument()
    expect(screen.getByText(/不进入通用设置导出/)).toBeInTheDocument()
    expect(screen.getByText(/请勿假定已存在加密备份/)).toBeInTheDocument()
    expect(fakeInvoke.calls[0]?.cmd).toBe('gateway_instances')
  })

  it('空实例 → 提示尚未创建', async () => {
    fakeInvoke.register('gateway_instances', () => [])
    render(() => <GatewayRiskPanel />)
    expect(await screen.findByText(/尚未创建 Gateway 实例/)).toBeInTheDocument()
  })

  it('加载中显示骨架文案', () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise(r => { resolve = r })
    fakeInvoke.register('gateway_instances', () => pending)
    render(() => <GatewayRiskPanel />)
    expect(screen.getByText(/正在加载 Gateway 实例…/)).toBeInTheDocument()
    resolve(instances)
  })

  it('损坏凭据实例与 lastError 展示（CR-002）', async () => {
    fakeInvoke.register('gateway_instances', () => [
      { id: 'qq-broken', platform: 'qq', label: '损坏实例', enabled: true, autoStart: false,
        status: 'error', lastError: '凭据解密失败', credentialStatus: 'invalid', credentialRef: null },
      ...instances,
    ])
    render(() => <GatewayRiskPanel />)
    expect(await screen.findByText(/损坏实例 · 错误 · 凭据解密失败 · 凭据：损坏/)).toBeInTheDocument()
    expect(screen.getByText(/实例 3 个：已配置凭据 1、\s*未配置 1、\s*损坏 1/)).toBeInTheDocument()
  })

  it('加载失败 → 错误 + 重试成功', async () => {
    fakeInvoke.register('gateway_instances', queue(
      { reject: { code: 'gateway_error', message: 'catalog 不可用' } },
      instances,
    ))
    render(() => <GatewayRiskPanel />)
    const alert = await screen.findByRole('status')
    expect(alert.textContent).toContain('读取 Gateway 实例失败')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(screen.getByText(/实例 2 个/)).toBeInTheDocument()
    })
  })
})

describe('GatewayRiskPanel browser 模式（无后端）', () => {
  beforeEach(() => {
    localStorage.clear()
    envState.isTauri = false
  })

  it('提示需要 Tauri 后端，不调 invoke', () => {
    render(() => <GatewayRiskPanel />)
    expect(screen.getByText(/实际消息连接需要在桌面应用中启动/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '管理平台连接' })).toBeInTheDocument()
    expect(fakeInvoke.calls).toHaveLength(0)
  })
})

describe('T13-7：Gateway secret 不进入通用导出', () => {
  it('CONFIG_STORAGE_KEYS 不含任何 gateway/凭据 key', () => {
    const joined = CONFIG_STORAGE_KEYS.join(' ')
    expect(joined).not.toMatch(/gateway/i)
    expect(joined).not.toMatch(/credential/i)
    expect(joined).not.toMatch(/secret/i)
    expect(joined).not.toMatch(/instance/i)
  })
})
