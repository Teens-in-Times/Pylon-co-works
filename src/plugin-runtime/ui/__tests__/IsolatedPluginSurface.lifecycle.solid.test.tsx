// @vitest-environment jsdom
/** @jsxImportSource solid-js */
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { getPluginUiRegistry } from '../../runtimeServices.ts'
import type { AsyncDisposable } from '../../registry/types.ts'
import type { PluginUiEventBridge, PluginUiSurface, PluginUiUnmount } from '../pluginUiTypes.ts'
import { IsolatedPluginSurface } from '../IsolatedPluginSurface.solid.tsx'
import { PluginContributionBoundary } from '../PluginContributionBoundary.solid.tsx'

const registrations: AsyncDisposable[] = []
function install(id: string, mount: PluginUiSurface['mount']) {
  const registration = getPluginUiRegistry().register(createPluginIdentity(id, 'test'), {
    id, runtime: { framework: 'webcomponent', version: '1' }, mount,
  })
  registrations.push(registration)
  return registration
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
afterEach(async () => {
  cleanup()
  for (const registration of registrations.splice(0)) await registration.dispose()
  vi.restoreAllMocks()
})

describe('isolated surface lifecycle', () => {
  it('repeated unsubscribe cannot remove a newer listener group for the same event', async () => {
    let bridge!: PluginUiEventBridge
    install('test.unsubscribe', (_container, currentBridge) => { bridge = currentBridge })
    render(() => <IsolatedPluginSurface surfaceId="test.unsubscribe" />)
    await waitFor(() => expect(bridge).toBeDefined())
    const oldListener = vi.fn()
    const nextListener = vi.fn()
    const unsubscribeOld = bridge.on('probe', oldListener)
    unsubscribeOld()
    const unsubscribeNext = bridge.on('probe', nextListener)
    unsubscribeOld()
    bridge.emit('probe', { value: 1 })
    expect(oldListener).not.toHaveBeenCalled()
    expect(nextListener).toHaveBeenCalledExactlyOnceWith({ value: 1 })
    unsubscribeNext()
    bridge.emit('probe', { value: 2 })
    expect(nextListener).toHaveBeenCalledOnce()
  })

  it('delivers only the latest input after mount settles, without remounting', async () => {
    const pending = deferred<PluginUiUnmount>()
    const inputs = vi.fn()
    const mount = vi.fn((_container: HTMLElement, bridge: PluginUiEventBridge) => {
      bridge.on('host:input', inputs)
      return pending.promise
    })
    install('test.input', mount)
    const [input, setInput] = createSignal('initial')
    const view = render(() => <IsolatedPluginSurface surfaceId="test.input" input={input()} />)
    await waitFor(() => expect(mount).toHaveBeenCalledOnce())
    setInput('latest')
    expect(inputs).not.toHaveBeenCalled()
    pending.resolve(undefined)
    await waitFor(() => expect(inputs).toHaveBeenCalledExactlyOnceWith('latest'))
    expect(view.container.querySelector('[data-plugin-ui-surface]')).toHaveAttribute('aria-busy', 'false')
    setInput('next')
    await waitFor(() => expect(inputs).toHaveBeenLastCalledWith('next'))
    expect(mount).toHaveBeenCalledOnce()
  })

  it('retires pending roots and event bridges before mounting a replacement', async () => {
    const pending = deferred<PluginUiUnmount>()
    let oldRoot!: HTMLElement
    let oldBridge!: PluginUiEventBridge
    const oldCleanup = vi.fn(() => oldRoot.replaceChildren())
    const events = vi.fn()
    const registration = install('test.swap', (container, bridge) => {
      oldRoot = container; oldBridge = bridge
      return pending.promise
    })
    const view = render(() => <IsolatedPluginSurface surfaceId="test.swap" onEvent={events} />)
    await waitFor(() => expect(oldRoot).toBeDefined())
    await registration.dispose()
    install('test.swap', container => { container.textContent = 'new surface' })
    await view.findByText('new surface')
    expect(oldRoot.isConnected).toBe(false)
    oldRoot.textContent = 'late old render'
    oldBridge.emit('settings:set', { key: 'x', value: 'late' })
    pending.resolve(oldCleanup)
    await waitFor(() => expect(oldCleanup).toHaveBeenCalledOnce())
    expect(events).not.toHaveBeenCalled()
    expect(view.getByText('new surface')).toBeInTheDocument()
    expect(view.queryByText('late old render')).toBeNull()
  })

  it.each(['sync', 'async'] as const)('shows and retries a %s mount failure without disturbing siblings', async mode => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let attempts = 0
    install('test.failure', container => {
      if (++attempts === 1) {
        if (mode === 'sync') throw new Error('failed')
        return Promise.reject(new Error('failed'))
      }
      container.textContent = 'recovered'
    })
    install('test.healthy', container => { container.textContent = 'healthy' })
    const view = render(() => <>
      <PluginContributionBoundary contributionId="test.failure"><IsolatedPluginSurface surfaceId="test.failure" /></PluginContributionBoundary>
      <IsolatedPluginSurface surfaceId="test.healthy" />
    </>)
    await view.findByRole('alert')
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('渲染插件贡献 test.failure失败', expect.any(Error))
    expect(view.getByText('healthy')).toBeInTheDocument()
    fireEvent.click(view.getByRole('button', { name: '重试加载' }))
    await view.findByText('recovered')
    expect(attempts).toBe(2)
  })

  it('contains asynchronous cleanup failures without clearing a replacement surface', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const teardown = deferred<void>()
    let oldRoot!: HTMLElement
    const dispose = vi.fn(async () => {
      await teardown.promise
      oldRoot.replaceChildren()
    })
    const registration = install('test.cleanup', container => {
      oldRoot = container
      container.textContent = 'old surface'
      return dispose
    })
    const view = render(() => <IsolatedPluginSurface surfaceId="test.cleanup" />)
    await view.findByText('old surface')
    await waitFor(() => expect(oldRoot).toHaveAttribute('aria-busy', 'false'))
    await registration.dispose()
    install('test.cleanup', container => { container.textContent = 'replacement' })
    await view.findByText('replacement')
    teardown.reject(new Error('teardown failed'))
    await waitFor(() => expect(diagnostic).toHaveBeenCalledExactlyOnceWith('卸载插件界面 test.cleanup失败', expect.any(Error)))
    expect(dispose).toHaveBeenCalledOnce()
    expect(view.getByText('replacement')).toBeInTheDocument()
  })

  it('closes the bridge when an input listener fails and runs cleanup once', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dispose = vi.fn()
    let bridge!: PluginUiEventBridge
    const events = vi.fn()
    install('test.listener', (_container, currentBridge) => {
      bridge = currentBridge
      bridge.on('host:input', () => { throw new Error('listener failed') })
      return dispose
    })
    const view = render(() => <PluginContributionBoundary contributionId="test.listener">
      <IsolatedPluginSurface surfaceId="test.listener" onEvent={events} input="probe" />
    </PluginContributionBoundary>)
    await view.findByRole('alert')
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('渲染插件贡献 test.listener失败', expect.any(Error))
    await waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    bridge.emit('settings:set', 'late')
    expect(events).not.toHaveBeenCalled()
  })
})
