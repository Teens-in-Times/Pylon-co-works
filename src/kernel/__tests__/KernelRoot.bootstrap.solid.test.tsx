// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * #515：迁移自 KernelRoot.bootstrap.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - 动态 `await import('../KernelRoot.tsx')`（React 实体，已随根翻转删除）→ 静态
 *   `import { KernelRoot } from '../KernelRoot.solid.tsx'`（solid 实体直连）；
 * - `render(<KernelRoot/>)` → `render(() => <KernelRoot/>)`；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（recovery 层在 startNormal 前渲染、文案「正在启动 Pylon」、
 *   startNormal 恰一次）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelRoot } from '../KernelRoot.solid.tsx'
import { createApplicationRuntime } from '../../application/applicationRuntime.ts'
import type { KernelBootstrap } from '../kernelBootstrap.ts'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

describe('KernelRoot bootstrap boundary', () => {
  it('界面崩溃显示可恢复摘要，重试后重新挂载应用', () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let broken = true
    const runtime = createApplicationRuntime()
    runtime.registerBuiltin({ id: 'test.crash', component: () => {
      if (broken) throw new Error('render failed')
      return <div>恢复后的工作界面</div>
    } })
    runtime.mount('test.crash')
    const bootstrap: KernelBootstrap = {
      getSnapshot: () => ({ kind: 'idle' }), subscribe: () => () => {},
      startNormal: vi.fn(async () => {}), startSafeMode: vi.fn(async () => {}), retryPlugin: vi.fn(async () => {}),
    }
    render(() => <KernelRoot bootstrap={bootstrap} runtime={runtime} />)
    expect(screen.getByRole('alert')).toHaveTextContent('工作界面暂时无法显示')
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('Pylon crashed:', expect.any(Error))
    broken = false
    fireEvent.click(screen.getByRole('button', { name: '重新加载界面' }))
    expect(screen.getByText('恢复后的工作界面')).toBeInTheDocument()
    diagnostic.mockRestore()
  })

  it('renders the Kernel recovery surface before starting plugins in an effect', async () => {
    const startNormal = vi.fn(async () => undefined)
    const idle = { kind: 'idle' as const }
    const bootstrap: KernelBootstrap = {
      getSnapshot: () => idle,
      subscribe: () => () => undefined,
      startNormal,
      startSafeMode: vi.fn(async () => undefined),
      retryPlugin: vi.fn(async () => undefined),
    }

    render(() => <KernelRoot bootstrap={bootstrap} runtime={createApplicationRuntime()} />)

    expect(screen.getByTestId('kernel-recovery-layer')).toHaveTextContent('正在启动 Pylon')
    await waitFor(() => expect(startNormal).toHaveBeenCalledOnce())
  })
})
