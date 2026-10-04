// @vitest-environment jsdom
// createAgentPanelFeedback 的 notify 单元契约：toast 2.5s 自动消失 + 连续 notify
// 时新 toast 不被上一条的 timer 提前清掉（timer 互斥）；owner 释放时残余 timer 兜底清理。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'solid-js'
import { createAgentPanelFeedback } from '../useAgentPanelFeedback.solid.ts'

function createFeedback() {
  const holder: { feedback?: ReturnType<typeof createAgentPanelFeedback>, dispose?: () => void } = {}
  createRoot(dispose => {
    holder.feedback = createAgentPanelFeedback({ reportPanelError: vi.fn() })
    holder.dispose = dispose
  })
  return holder
}

describe('createAgentPanelFeedback notify', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('toast 在 2.5s 后自动消失', () => {
    const { feedback, dispose } = createFeedback()
    feedback!.notify('已保存')
    expect(feedback!.toast()).toBe('已保存')
    vi.advanceTimersByTime(2499)
    expect(feedback!.toast()).toBe('已保存')
    vi.advanceTimersByTime(1)
    expect(feedback!.toast()).toBeNull()
    dispose!()
  })

  it('连续 notify：第二条不被第一条的 timer 掐灭，且按第二条自己的节奏消失', () => {
    const { feedback, dispose } = createFeedback()
    feedback!.notify('第一条')
    vi.advanceTimersByTime(2000)
    feedback!.notify('第二条')
    // 第一条的 timer 在 500ms 后到期——不得把第二条 toast 提前清掉。
    vi.advanceTimersByTime(500)
    expect(feedback!.toast()).toBe('第二条')
    vi.advanceTimersByTime(1999)
    expect(feedback!.toast()).toBe('第二条')
    vi.advanceTimersByTime(1)
    expect(feedback!.toast()).toBeNull()
    dispose!()
  })

  it('owner 释放即清掉残余 timer：到期后不再改写 toast', () => {
    const { feedback, dispose } = createFeedback()
    feedback!.notify('已保存')
    dispose!()
    expect(() => vi.advanceTimersByTime(2500)).not.toThrow()
    // timer 已被 onCleanup 掐掉：到点不再有「清空」写入，toast 停留在最后值。
    expect(feedback!.toast()).toBe('已保存')
  })
})
