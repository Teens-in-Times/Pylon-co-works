// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #515：迁移自 ApplicationMount.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - DemoApplication 为 Solid Component（#515 application 贡献契约翻转）；
 * - `render(<ApplicationMount .../>)` → `render(() => <ApplicationMount .../>)`，
 *   实体直连 ApplicationMount.solid.tsx / KernelRecoveryLayer.solid.tsx；
 * - `act(() => runtime.unmount())` → 直接调用（registry 通知 → Solid 信号同步落 DOM）；
 * - 「React Root 宿主不变」断言保留：宿主 div 由测试自身 JSX 提供
 *   （`render(() => <div data-testid="kernel-root-host">…</div>)`，语义同 React 版）；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（demo-application 出现/消失、重新挂载按钮、宿主同一性、
 *   safe-mode「启动 <pluginId>」回调参数）。
 */
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { lazy, type Component } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApplicationMount from '../ApplicationMount.solid.tsx'
import KernelRecoveryLayer from '../KernelRecoveryLayer.solid.tsx'
import { createApplicationRuntime } from '../../application/applicationRuntime.ts'

function DemoApplication() {
  return <div data-testid="demo-application">Pylon Application</div>
}

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

describe('ApplicationMount', () => {
  it('加载延迟应用时显示状态，就绪后显示工作界面', async () => {
    let complete!: (module: { default: Component }) => void
    const loading = new Promise<{ default: Component }>(resolve => { complete = resolve })
    const runtime = createApplicationRuntime()
    runtime.registerBuiltin({ id: 'test.lazy-app', component: lazy(() => loading) })
    runtime.mount('test.lazy-app')
    render(() => <ApplicationMount runtime={runtime} recovery={<KernelRecoveryLayer />} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载工作界面')
    complete({ default: DemoApplication })
    await screen.findByTestId('demo-application')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('挂载 active Application，卸载后显示 Kernel Recovery UI', () => {
    const runtime = createApplicationRuntime()
    runtime.registerBuiltin({ id: 'builtin.pylon-app', component: DemoApplication })
    runtime.mount('builtin.pylon-app')

    render(() => (
      <ApplicationMount
        runtime={runtime}
        recovery={<KernelRecoveryLayer onRemount={() => runtime.mount('builtin.pylon-app')} />}
      />
    ))

    expect(screen.getByTestId('demo-application')).toBeInTheDocument()

    runtime.unmount()

    expect(screen.queryByTestId('demo-application')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新挂载 Pylon' })).toBeInTheDocument()
  })

  it('Recovery UI 可重新挂载同一 Application，且 React Root 宿主不变', () => {
    const runtime = createApplicationRuntime()
    runtime.registerBuiltin({ id: 'builtin.pylon-app', component: DemoApplication })
    runtime.mount('builtin.pylon-app')
    const view = render(() => (
      <div data-testid="kernel-root-host">
        <ApplicationMount
          runtime={runtime}
          recovery={<KernelRecoveryLayer onRemount={() => runtime.mount('builtin.pylon-app')} />}
        />
      </div>
    ))
    const host = screen.getByTestId('kernel-root-host')

    runtime.unmount()
    fireEvent.click(screen.getByRole('button', { name: '重新挂载 Pylon' }))

    expect(screen.getByTestId('kernel-root-host')).toBe(host)
    expect(screen.getByTestId('demo-application')).toBeInTheDocument()
    view.unmount()
  })

  it('Safe Mode lets the user explicitly start one first-party plugin', () => {
    const onRetry = vi.fn()
    render(() => <KernelRecoveryLayer
      state={{ kind: 'safe-mode', skippedPluginIds: ['builtin.pylon-shell'] }}
      onRetry={onRetry}
      onStartNormal={vi.fn()}
    />)

    fireEvent.click(screen.getByText('逐项恢复扩展'))
    fireEvent.click(screen.getByRole('button', { name: '启动 builtin.pylon-shell' }))

    expect(onRetry).toHaveBeenCalledWith('builtin.pylon-shell')
  })
})
