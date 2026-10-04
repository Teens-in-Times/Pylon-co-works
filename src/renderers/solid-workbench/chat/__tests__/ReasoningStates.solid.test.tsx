// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import type { RenderMessage } from '../../../../domains/chat/messageTypes.ts'
import type { Message } from '../../../../domains/chat/messageTypes.ts'
import { BuiltinSolidContentSlot } from '../BuiltinSolidContentSlot.solid.tsx'
import { FLUSH_BUDGET } from '../../../../test/solidTestHelpers.ts'
import { SolidMessageRow } from '../MessageRow.solid.tsx'

/**
 * C01 RED：ReasoningBlock 四态契约。
 *
 * 卡面要求：用户能区分 正在思考 / 已完成 / 被 provider 隐去 / 数据缺失；
 * redacted 只显示安全占位和可用原因；完成后按设置折叠；
 * 正文复用 C00 markdown renderer（不建第二管线）。
 */

function row(message: Partial<Message>): ReturnType<typeof render> {
  const full: Message = { id: 'r1', role: 'reasoning', sender: 'peri', content: '', time: 't' }
  return render(() => (
    <SolidMessageRow
      renderMessage={{ type: 'reasoning', message: { ...full, ...message } } as RenderMessage}
      appearance={{} as Parameters<typeof SolidMessageRow>[0]['appearance']}
    />
  ))
}

afterEach(() => cleanup())

describe('C01 ReasoningBlock states', () => {
  it('running state shows thinking label with reduced-motion safe indicator', () => {
    const result = row({ content: '思考中内容', running: true })
    const label = result.getByText('正在思考…')
    expect(label).toBeTruthy()
    expect(result.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    // running 指示物是纯 CSS（reduced-motion 由样式层 media query 关闭），DOM 无自动动画元素
    expect(result.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('completed state shows duration and collapses body until expanded', async () => {
    const result = row({ content: '已完成思考正文', running: false, thoughtDurationMs: 2400 })
    const button = result.getByRole('button')
    expect(button.textContent).toContain('2.4s')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(result.container.textContent).toContain('已完成思考正文')
  })

  it('redacted state shows safe placeholder and reason, never raw content', () => {
    const result = row({ content: '机密推理原文', running: false, redacted: true, redactedReason: 'provider_redacted' })
    // 占位文案可见、原因可见
    expect(result.container.textContent).toContain('推理已被隐藏')
    expect(result.container.textContent).toContain('provider_redacted')
    // 原文不得出现在 DOM 任何位置
    expect(result.container.textContent).not.toContain('机密推理原文')
    // 展开也不产生原文——redacted 没有 body 可展开
    const buttons = result.container.querySelectorAll('button')
    for (const button of buttons) {
      expect(button.textContent).not.toContain('机密推理原文')
    }
  })

  it('missing data state (no content, not running) shows data-unavailable hint', () => {
    const result = row({ content: '', running: false })
    expect(result.container.textContent).toContain('暂无')
  })

  it('renders body via C00 MarkdownContent instead of a second pipeline', async () => {
    const result = row({ content: '# 标题思考\n\n- 要点**加粗**', running: false })
    const button = result.getByRole('button')
    fireEvent.click(button)
    // MarkdownContent 异步解析，等待 h1 出现（复用 C00 语义标签，非纯文本行）。
    // 等待对象是 createResource 解析 + Solid 刷帧（微任务级）；统一冲刷预算见
    // solidTestHelpers 的 FLUSH_BUDGET。
    await waitFor(() => {
      if (!result.container.querySelector('.term-h1')) throw new Error('markdown not parsed yet')
    }, FLUSH_BUDGET)
    expect(result.container.querySelectorAll('.term-reasoning-line')).toHaveLength(0)
  })

  it('consumes resolved C01 appearance and behaviour tokens in the built-in content Slot', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'reasoning-slot', kind: 'content.reasoning', revision: 1,
        payload: { text: '已完成推理', state: 'complete', durationMs: 2_400 },
      }}
      appearance={{
        foreground: '#112233', background: '#f1f2f3', borderColor: '#445566',
        fontSize: 17, lineHeight: 1.8, defaultCollapsed: false, maxHeight: 480,
        runningAnimation: 'shimmer', showDuration: false,
      }}
      commands={{ execute: () => {} }}
    />)

    const reasoning = result.container.querySelector<HTMLElement>('.term-reasoning')!
    expect(reasoning.style.color).toBe('rgb(17, 34, 51)')
    expect(reasoning.style.backgroundColor).toBe('rgb(241, 242, 243)')
    expect(reasoning.style.fontSize).toBe('17px')
    expect(reasoning.style.lineHeight).toBe('1.8')
    expect(reasoning.getAttribute('data-running-animation')).toBe('shimmer')
    expect(result.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(result.getByRole('button').textContent).not.toContain('2.4s')
    const body = result.container.querySelector<HTMLElement>('.term-reasoning-body')!
    expect(body.style.maxHeight).toBe('480px')
    expect(body.style.borderColor).toBe('rgb(68, 85, 102)')
  })

  it('forces configured running animation off when reduced motion is active', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'reasoning-running', kind: 'content.reasoning', revision: 1,
        payload: { text: '流式推理', state: 'running' },
      }}
      appearance={{ runningAnimation: 'shimmer', reducedMotion: true }}
      commands={{ execute: () => {} }}
    />)
    const reasoning = result.container.querySelector('.term-reasoning')!
    expect(reasoning.getAttribute('data-state')).toBe('running')
    expect(reasoning.getAttribute('data-running-animation')).toBe('none')
    expect(reasoning.querySelector('.term-reasoning-label')?.getAttribute('aria-live')).toBe('polite')
    expect(reasoning.querySelector('.term-reasoning-body')?.getAttribute('aria-live')).toBeNull()
  })

  it('keeps the user expansion while content and running state update in place', async () => {
    const [snapshot, setSnapshot] = createSignal({
      nodeId: 'reasoning-transition', kind: 'content.reasoning', revision: 1,
      payload: { text: '流式推理', state: 'running' },
    })
    const [appearance, setAppearance] = createSignal({ defaultCollapsed: true })
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={snapshot()}
      appearance={appearance()}
      commands={{ execute: () => {} }}
    />)
    const button = result.getByRole('button')
    const reasoning = result.container.querySelector('.term-reasoning')!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')

    setSnapshot({
      nodeId: 'reasoning-transition', kind: 'content.reasoning', revision: 2,
      payload: { text: '流式推理，新增正文', state: 'running' },
    })
    await waitFor(() => expect(result.container).toHaveTextContent('流式推理，新增正文'))
    expect(result.container.querySelector('.term-reasoning')).toBe(reasoning)
    expect(button.getAttribute('aria-expanded')).toBe('true')

    setSnapshot({
      nodeId: 'reasoning-transition', kind: 'content.reasoning', revision: 3,
      payload: { text: '流式推理，新增正文', state: 'complete' },
    })
    await waitFor(() => expect(result.container.querySelector('.term-reasoning')).toHaveAttribute('data-state', 'complete'))
    expect(result.container.querySelector('.term-reasoning')).toBe(reasoning)
    expect(button.getAttribute('aria-expanded')).toBe('true')

    setAppearance({ defaultCollapsed: false })
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'))
    expect(result.container.querySelector('.term-reasoning')).toBe(reasoning)
  })
})
