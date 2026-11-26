/**
 * 测试夹具自检（阶段 0）：MemoryStorage / FakeInvoke 行为验证。
 * 夹具是后续行为回归测试的基础，先钉死其契约。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from './memoryStorage'
import { FakeInvoke } from './fakeInvoke'

describe('MemoryStorage', () => {
  it('读写删与 dump 快照一致', () => {
    const storage = new MemoryStorage({ initial: { 'a': '1' } })
    expect(storage.getItem('a')).toBe('1')
    storage.setItem('b', '2')
    storage.removeItem('a')
    expect(storage.dump()).toEqual({ b: '2' })
    expect(storage.calls.some(call => call.op === 'setItem' && call.key === 'b')).toBe(true)
  })

  it('quotaExceeded 使 setItem 抛 QuotaExceededError，且可中途恢复', () => {
    const storage = new MemoryStorage()
    storage.setQuotaExceeded(true)
    expect(() => storage.setItem('a', '1')).toThrowError('quota')
    expect(storage.getItem('a')).toBeNull()
    storage.setQuotaExceeded(false)
    storage.setItem('a', '1')
    expect(storage.getItem('a')).toBe('1')
  })

  it('failKeys 使指定 key 写失败，其余正常', () => {
    const storage = new MemoryStorage({ failKeys: ['bad'] })
    expect(() => storage.setItem('bad', 'x')).toThrowError('simulated setItem failure')
    storage.setItem('good', 'y')
    expect(storage.getItem('good')).toBe('y')
  })

  it('可预置损坏 JSON 数据', () => {
    const storage = new MemoryStorage({ initial: { 'corrupt': '{not-json' } })
    expect(() => JSON.parse(storage.getItem('corrupt')!)).toThrow()
  })
})

describe('FakeInvoke', () => {
  afterEach(() => { vi.useRealTimers() })

  it('注册 handler 并记录调用', async () => {
    const invoke = new FakeInvoke().register('echo', args => args.value)
    expect(await invoke.invoke('echo', { value: 42 })).toBe(42)
    expect(invoke.calls).toEqual([{ cmd: 'echo', args: { value: 42 } }])
  })

  it('无 handler 时 reject Command not found', async () => {
    const invoke = new FakeInvoke()
    await expect(invoke.invoke('missing')).rejects.toThrowError('Command not found: missing')
  })

  it('handler 抛错转为 reject', async () => {
    const invoke = new FakeInvoke().register('boom', () => { throw new Error('handler boom') })
    await expect(invoke.invoke('boom')).rejects.toThrowError('handler boom')
  })

  it('rejectAll 使所有 invoke reject', async () => {
    const invoke = new FakeInvoke().register('echo', args => args.value).rejectAll('down')
    await expect(invoke.invoke('echo', { value: 1 })).rejects.toThrowError('down')
  })

  it('delay 在配置的延迟到期后执行 handler 并返回它的结果', async () => {
    vi.useFakeTimers()
    const handler = vi.fn(() => 'ok')
    const invoke = new FakeInvoke().register('slow', handler).setDelay('slow', 20)
    const pending = invoke.invoke('slow')
    await vi.advanceTimersByTimeAsync(19)
    expect(handler).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(handler).toHaveBeenCalledTimes(1)
    await expect(pending).resolves.toBe('ok')
  })

  it('never 在所有待执行定时器跑完后仍挂起', async () => {
    vi.useFakeTimers()
    const handler = vi.fn(() => 'x')
    const settled = vi.fn()
    const invoke = new FakeInvoke({ defaultDelay: 20 }).register('hang', handler).never('hang')
    void invoke.invoke('hang').then(settled, settled)
    await vi.runAllTimersAsync()
    expect(handler).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
  })
})
