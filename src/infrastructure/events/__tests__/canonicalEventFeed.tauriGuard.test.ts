// @vitest-environment jsdom
/**
 * #542：feed 创建时两条广播兜底 listen 的 Tauri 环境守卫。
 *
 * jsdom 测试环境（有 window、无 Tauri 宿主）必须静默跳过注册。守卫漏判时
 * listen 被调用并 reject → reportRuntimeError → console.error ×2，被测试
 * 看门狗记到「当次在跑的测试文件」头上，背锅者随 worker 调度漂移——CI 分片
 * 确定性红的根因。守卫判据与本文件 subscribeWindowTerminalFrames /
 * subscribeTurnSettled 同形（IS_TAURI 探测单点）。
 *
 * listen mock 为 spy 而非 reject：直接断言守卫的效果（非 Tauri 环境不触达
 * 注册面），不依赖真实 listen 的失败链路。
 */
import { describe, expect, it, vi } from 'vitest'

const listenSpy = vi.hoisted(() => vi.fn((_event: string, _handler: (e: { payload: unknown }) => void) => Promise.resolve(() => {})))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenSpy }))

import { createCanonicalEventFeed } from '../canonicalEventFeed.ts'

describe('canonicalEventFeed 广播兜底注册守卫（#542）', () => {
  it('jsdom（有 window、无 Tauri 宿主）下创建 feed 不注册兜底监听', () => {
    // 钉住前提：本测试的有效性依赖「jsdom 有 window 且无 Tauri globals」。
    expect(typeof window).not.toBe('undefined')
    expect('__TAURI_INTERNALS__' in window).toBe(false)

    const consoleSpy = vi.spyOn(console, 'error')
    createCanonicalEventFeed()

    expect(listenSpy).not.toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
