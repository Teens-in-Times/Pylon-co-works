import { describe, expect, it, vi } from 'vitest'
import { createBrowserEventFeed } from '../browserEventFeed.ts'
import type { RuntimeEventClient } from '../runtimeEventClient.ts'
import { createRuntimeEventClient } from '../runtimeEventClient.ts'
import type { Event, listen } from '@tauri-apps/api/event'
import { logWarn } from '../../../contracts/frontendLogSink.ts'

vi.mock('../../../contracts/frontendLogSink.ts', () => ({ logWarn: vi.fn() }))

function fixture() {
  const nativeHandlers = new Map<string, (payload: unknown) => void>()
  const stop = vi.fn()
  const subscribe = vi.fn((event: string, handler: (payload: unknown) => void) => {
    nativeHandlers.set(event, handler)
    return { dispose: stop }
  })
  const feed = createBrowserEventFeed({ subscribe } as RuntimeEventClient)
  return { feed, subscribe, stop, emit: (event: string, payload: unknown) => nativeHandlers.get(event)?.(payload) }
}

describe('window browser event feed', () => {
  it('does not unlisten when a view disappears before native registration settles', async () => {
    let settle!: (stop: () => void) => void
    let deliver!: (event: Event<unknown>) => void
    const nativeListen = vi.fn((_event: string, handler: typeof deliver) => {
      deliver = handler
      return new Promise<() => void>(resolve => { settle = resolve })
    })
    const feed = createBrowserEventFeed(createRuntimeEventClient(nativeListen as typeof listen))
    const old = vi.fn()
    feed.subscribe('pylon:browser-status', old).dispose()
    const stop = vi.fn()
    settle(stop)
    await Promise.resolve()
    expect(stop).not.toHaveBeenCalled()
    deliver({ event: 'pylon:browser-status', id: 1, payload: { phase: 'ready' } })
    expect(old).not.toHaveBeenCalled()
    const current = vi.fn()
    feed.subscribe('pylon:browser-status', current)
    deliver({ event: 'pylon:browser-status', id: 1, payload: { phase: 'ready' } })
    expect(current).toHaveBeenCalledWith({ phase: 'ready' })
    expect(nativeListen).toHaveBeenCalledOnce()
    feed.dispose()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reports a consumer failure without blocking the other live consumers', () => {
    const { feed, emit } = fixture()
    const failure = new Error('view failed')
    const healthy = vi.fn()
    feed.subscribe('pylon:browser-status', () => { throw failure })
    feed.subscribe('pylon:browser-status', healthy)
    emit('pylon:browser-status', { phase: 'ready' })
    expect(logWarn).toHaveBeenCalledWith('处理浏览器事件失败：pylon:browser-status', failure)
    expect(healthy).toHaveBeenCalledWith({ phase: 'ready' })
    feed.dispose()
  })

  it('keeps two fixed native listeners across empty periods and view remounts', () => {
    const { feed, subscribe, stop, emit } = fixture()
    const first = vi.fn()
    const later = vi.fn()
    const status = feed.subscribe('pylon:browser-status', first)
    const page = feed.subscribe('pylon:browser-page', first)
    emit('pylon:browser-status', { phase: 'ready' })
    expect(first).toHaveBeenCalledOnce()
    status.dispose()
    page.dispose()
    emit('pylon:browser-status', { phase: 'idle' })
    emit('pylon:browser-page', { tabId: 1 })
    expect(first).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()

    const next = feed.subscribe('pylon:browser-status', later)
    feed.subscribe('pylon:browser-page', later)
    emit('pylon:browser-status', { phase: 'ready' })
    emit('pylon:browser-page', { tabId: 2 })
    expect(later).toHaveBeenCalledTimes(2)
    expect(subscribe.mock.calls.map(([event]) => event)).toEqual(['pylon:browser-status', 'pylon:browser-page'])
    status.dispose()
    emit('pylon:browser-status', { phase: 'ready' })
    expect(later).toHaveBeenCalledTimes(3)
    next.dispose()
    feed.dispose()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('isolates consumers and removes one immediately during another consumer callback', () => {
    const { feed, emit, subscribe } = fixture()
    const second = vi.fn()
    let removeSecond = () => {}
    const first = feed.subscribe('pylon:browser-status', () => removeSecond())
    const subscription = feed.subscribe('pylon:browser-status', second)
    removeSecond = subscription.dispose
    emit('pylon:browser-status', { phase: 'ready' })
    expect(second).not.toHaveBeenCalled()
    first.dispose()
    const remaining = vi.fn()
    feed.subscribe('pylon:browser-status', remaining)
    subscription.dispose()
    emit('pylon:browser-status', { phase: 'ready' })
    expect(remaining).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledOnce()
    feed.dispose()
  })

  it('explicit shutdown blocks stale transport callbacks and permits a new window lifetime', () => {
    const { feed, subscribe, emit } = fixture()
    const old = vi.fn()
    feed.subscribe('pylon:browser-status', old)
    const stale = subscribe.mock.calls[0]![1]
    feed.dispose()
    const current = vi.fn()
    feed.subscribe('pylon:browser-status', current)
    stale({ phase: 'old' })
    expect(old).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
    emit('pylon:browser-status', { phase: 'ready' })
    expect(current).toHaveBeenCalledOnce()
    feed.dispose()
  })
})
