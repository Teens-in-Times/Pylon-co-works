/**
 * runtimeEventClient 行为测试（#520 S1-P1）：投递、dispose 后停投递、
 * 注册未 settle 即 dispose 的补注销、dispose 幂等。
 */
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeEventClient } from '../runtimeEventClient.ts'
import type { RuntimeEventClient } from '../runtimeEventClient.ts'

type Handler = (event: { payload: unknown }) => void

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn<(event: string, handler: Handler) => Promise<() => void>>(),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

/** 可手动投递的注册表版 listen。 */
function installRegistryListen() {
  const handlers = new Map<string, Set<Handler>>()
  listenMock.mockImplementation(async (event: string, handler: Handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set())
    handlers.get(event)!.add(handler)
    return () => {
      handlers.get(event)?.delete(handler)
    }
  })
  return {
    emit: (event: string, payload: unknown) => {
      for (const handler of [...(handlers.get(event) ?? [])]) handler({ payload })
    },
    registeredCount: (event: string) => handlers.get(event)?.size ?? 0,
  }
}

function clientWithRegistryListen(): RuntimeEventClient {
  return createRuntimeEventClient(listenMock as unknown as typeof import('@tauri-apps/api/event').listen)
}

describe('runtimeEventClient', () => {
  it('投递事件 payload 给 handler；dispose 后注销', async () => {
    const registry = installRegistryListen()
    const received: unknown[] = []
    const subscription = clientWithRegistryListen().subscribe<{ n: number }>('pylon:test', payload => {
      received.push(payload)
    })
    await Promise.resolve()
    registry.emit('pylon:test', { n: 1 })
    expect(received).toEqual([{ n: 1 }])
    subscription.dispose()
    expect(registry.registeredCount('pylon:test')).toBe(0)
  })

  it('dispose 后不再投递', async () => {
    const registry = installRegistryListen()
    const received: unknown[] = []
    const subscription = clientWithRegistryListen().subscribe<number>('pylon:test', payload => {
      received.push(payload)
    })
    await Promise.resolve()
    subscription.dispose()
    registry.emit('pylon:test', 1)
    expect(received).toEqual([])
    expect(registry.registeredCount('pylon:test')).toBe(0)
  })

  it('注册 settle 前 dispose：settle 后补注销，且只注销一次', async () => {
    const stop = vi.fn()
    let releaseRegistration!: () => void
    listenMock.mockImplementationOnce(() => new Promise<() => void>(resolve => {
      releaseRegistration = () => resolve(stop)
    }))
    const subscription = clientWithRegistryListen().subscribe('pylon:deferred', () => {})
    subscription.dispose()
    releaseRegistration()
    await Promise.resolve()
    await Promise.resolve()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('dispose 幂等：重复调用不抛错', async () => {
    const registry = installRegistryListen()
    const subscription = clientWithRegistryListen().subscribe('pylon:idem', () => {})
    await Promise.resolve()
    subscription.dispose()
    subscription.dispose()
    subscription.dispose()
    expect(registry.registeredCount('pylon:idem')).toBe(0)
  })
})
