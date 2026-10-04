// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushTask } from '../../../../test/solidTestHelpers.ts'
import type {
  RenderAppearanceSnapshot,
  RenderCommandPort,
  RenderNodeSnapshot,
} from '../../../../contracts/messageRenderer.ts'
import { createSolidSurface } from '../solidRenderer.ts'
import { loadSolidMessageRendererComponent } from '../../../../renderers/solid-workbench/loadSolidMessageRenderer.ts'

const appearance: RenderAppearanceSnapshot = Object.freeze({
  userName: 'You', userPrefix: '❯', userColor: '#fff',
  assistantDot: false, assistantDotGlyph: '●', assistantDotImage: '',
  toolIndicator: '●', toolIndicatorGlow: 0, toolIndicatorGlowColor: '#fff',
})
const commands: RenderCommandPort = Object.freeze({ execute: vi.fn() })

function snapshot(revision: number): RenderNodeSnapshot {
  return Object.freeze({
    nodeId: 'streaming-message',
    kind: 'message.assistant',
    revision,
    payload: Object.freeze({
      reduceMotion: true,
      renderMessage: Object.freeze({
        type: 'assistant',
        message: Object.freeze({
          id: 'streaming-message', role: 'assistant', sender: 'peri',
          content: `chunk-${revision}`, time: '10:00',
        }),
      }),
    }),
  })
}

afterEach(() => document.body.replaceChildren())

describe('Solid semantic RenderSurface', () => {
  it('mount 一次后 1000 次 update 保持 DOM identity，destroy 一次后静默清理', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const surface = createSolidSurface()
    const error = vi.fn()
    const unsubscribe = surface.on('error', error)
    // 冷启动（现场转译 + 动态 import 渲染器图，秒级且机器相关，#373）不是本用例被测对象：
    // 先预热把它移出下方预算（由 30s 测试看门狗兜底），2s 只考 warm 首帧刷写（ms 级）。
    await loadSolidMessageRendererComponent()
    const handle = surface.mount(container, snapshot(0), appearance, commands)
    // 预算依据：等待对象是预热后 mount 的首次刷帧（ms 级，createResource 微任务级）；
    // 2s 覆盖满载并发抖动，原 5s 是 P91 期粗放放宽（#175 已消除满载 paging 根因）。
    await vi.waitFor(() => expect(container.textContent).toContain('chunk-0'), { timeout: 2_000 })
    const root = container.firstElementChild
    expect(root).not.toBeNull()

    for (let revision = 1; revision <= 1000; revision += 1) {
      surface.update(handle, snapshot(revision), appearance)
    }

    expect(container.textContent).toContain('chunk-1000')
    expect(container.firstElementChild).toBe(root)
    unsubscribe()
    surface.destroy(handle)
    await vi.waitFor(() => expect(container.childElementCount).toBe(0))
    expect(error).not.toHaveBeenCalled()
  })

  it('异步 renderer loader 尚未完成时 destroy，不复活 DOM 或 error listener', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const surface = createSolidSurface()
    const error = vi.fn()
    surface.on('error', error)
    const handle = surface.mount(container, snapshot(0), appearance, commands)
    surface.destroy(handle)
    await Promise.resolve()
    await flushTask()
    expect(container.childElementCount).toBe(0)
    expect(error).not.toHaveBeenCalled()
  })
})
