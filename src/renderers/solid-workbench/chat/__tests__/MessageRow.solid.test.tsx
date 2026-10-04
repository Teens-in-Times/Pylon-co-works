// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { toRenderMessage, type Message } from '../../../../domains/chat/messageTypes.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../../domains/appearance/appearance.ts'
import { clearMarkdownRenderModelCache } from '../markdownRenderModel.ts'
import { FLUSH_BUDGET } from '../../../../test/solidTestHelpers.ts'
import { AssistantContent, ReasoningBlock, SolidMessageRow } from '../MessageRow.solid.tsx'

const APPEARANCE: Pick<WorkbenchAppearanceSnapshot,
  'userName' | 'userPrefix' | 'userColor' | 'assistantDot' | 'assistantDotGlyph' | 'assistantDotImage'> = {
  userName: '',
  userPrefix: '❯',
  userColor: '#aabbcc',
  assistantDot: false,
  assistantDotGlyph: '●',
  assistantDotImage: '',
}

function row(message: Message, appearance = APPEARANCE) {
  return render(() => (
    <SolidMessageRow renderMessage={toRenderMessage(message)} appearance={appearance} />
  ))
}

afterEach(() => {
  cleanup()
  clearMarkdownRenderModelCache()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SolidMessageRow', () => {
  it('finishes only after terminal text stops growing and never replays for a settled row', () => {
    vi.useFakeTimers()
    try {
      const [state, setState] = createSignal({ text: 'live', streaming: true })
      const result = render(() => <AssistantContent
        text={state().text}
        appearance={APPEARANCE}
        streaming={state().streaming}
        semanticContent={<span data-testid="stable-content">live</span>}
      />)
      const body = result.container.querySelector('.term-assistant-body')
      const content = result.getByTestId('stable-content')
      expect(body?.querySelector('.term-stream-sheen')).toHaveAttribute('aria-hidden', 'true')
      setState({ text: 'live', streaming: false })
      vi.advanceTimersByTime(300)
      expect(body?.querySelector('.term-stream-sheen')).not.toBeNull()
      expect(body?.querySelector('.term-stream-completion')).toBeNull()
      setState({ text: 'live tail', streaming: false })
      vi.advanceTimersByTime(439)
      expect(body?.querySelector('.term-stream-completion')).toBeNull()
      vi.advanceTimersByTime(1)
      expect(body?.querySelector('.term-stream-sheen')).toBeNull()
      expect(body?.querySelector('.term-stream-completion')).toHaveAttribute('aria-hidden', 'true')
      vi.advanceTimersByTime(760)
      expect(body?.querySelector('.term-stream-completion')).toBeNull()
      setState({ text: 'live tail corrected', streaming: false })
      vi.advanceTimersByTime(500)
      expect(body?.querySelector('.term-stream-completion')).toBeNull()
      expect(result.getByTestId('stable-content')).toBe(content)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a history-mounted assistant free of completion motion', () => {
    const result = render(() => <AssistantContent text="history" appearance={APPEARANCE} streaming={false} />)
    expect(result.container.querySelector('.term-stream-sheen')).toBeNull()
    expect(result.container.querySelector('.term-stream-completion')).toBeNull()
  })

  it.each(['wheel', 'touch', 'keyboard'])('inner reasoning respects %s intent inside its 24px sticky band (#74)', async inputKind => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => callbacks.push(fn))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const [text, setText] = createSignal('thinking')
    const result = render(() => <ReasoningBlock text={text()} running defaultCollapsed={false} />)
    const body = result.container.querySelector('.term-reasoning-body') as HTMLElement
    Object.defineProperties(body, { scrollHeight: { value: 400 }, clientHeight: { value: 100 } })
    callbacks.splice(0).forEach(fn => fn())
    expect(body.scrollTop).toBe(300)
    setText('queued before gesture')
    if (inputKind === 'wheel') fireEvent.wheel(body, { deltaY: -2 })
    else if (inputKind === 'keyboard') fireEvent.keyDown(body, { key: 'ArrowUp' })
    else {
      fireEvent.touchStart(body, { touches: [{ clientY: 100 }] })
      fireEvent.touchMove(body, { touches: [{ clientY: 110 }] })
    }
    fireEvent.scroll(body)
    body.scrollTop = 298
    fireEvent.scroll(body)
    callbacks.splice(0).forEach(fn => fn())
    expect(body.scrollTop).toBe(298)
    setText('more content after gesture')
    callbacks.splice(0).forEach(fn => fn())
    expect(body.scrollTop).toBe(298)
    body.scrollTop = 300
    fireEvent.scroll(body)
    setText('resumed at endpoint')
    callbacks.splice(0).forEach(fn => fn())
    expect(body.scrollTop).toBe(300)
  })

  it.each(['frame', 'microtask'])('follows active reasoning with %s scheduling', async mode => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', mode === 'frame' ? (fn: () => void) => callbacks.push(fn) : undefined)
    const result = render(() => <ReasoningBlock text="thinking" running defaultCollapsed={false} />)
    const body = result.container.querySelector('.term-reasoning-body') as HTMLElement
    Object.defineProperties(body, { scrollHeight: { value: 400 }, clientHeight: { value: 100 } })
    callbacks.splice(0).forEach(fn => fn())
    await Promise.resolve()
    expect(body.scrollTop).toBe(300)
  })

  it.each(['frame', 'microtask'].flatMap(mode => ['collapse', 'stop', 'redact', 'unmount'].map(action => [mode, action])))(
    'does not scroll after %s work is invalidated by %s', async (mode, action) => {
    const callbacks: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', mode === 'frame' ? (fn: () => void) => callbacks.push(fn) : undefined)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const [running, setRunning] = createSignal(true)
    const [redacted, setRedacted] = createSignal(false)
    const result = render(() => <ReasoningBlock text="thinking" running={running()} redacted={redacted()} defaultCollapsed={false} />)
    const body = result.container.querySelector('.term-reasoning-body') as HTMLElement
    const write = vi.fn()
    Object.defineProperties(body, {
      scrollHeight: { value: 400 }, clientHeight: { value: 100 }, scrollTop: { get: () => 0, set: write },
    })
    if (action === 'collapse') result.getByRole('button').click()
    else if (action === 'stop') setRunning(false)
    else if (action === 'redact') setRedacted(true)
    else result.unmount()
    callbacks.splice(0).forEach(fn => fn()) // A canceled frame may already be queued by the host.
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
  })

  it('渲染 user，并保持旧 class 与内联颜色 contract', () => {
    const result = row({ id: 'u1', role: 'user', sender: 'local:demo', content: '用户提问', time: 't' })
    expect(result.getByText('demo')).toBeTruthy()
    expect(result.getByText('用户提问')).toBeTruthy()
    expect(result.container.querySelector('.term-row-user')?.getAttribute('data-render-type')).toBe('user')
    expect((result.container.querySelector('.term-user-prefix') as HTMLElement).style.color).toBe('rgb(170, 187, 204)')
  })

  it('渲染 assistant dot glyph 与 image 两种结构', () => {
    const glyph = row(
      { id: 'a1', role: 'assistant', sender: 'peri', content: '带圆点', time: 't' },
      { ...APPEARANCE, assistantDot: true },
    )
    expect(glyph.container.querySelector('.term-assistant-dot')?.textContent).toBe('●')
    glyph.unmount()

    const image = row(
      { id: 'a2', role: 'assistant', sender: 'peri', content: '带图片', time: 't' },
      { ...APPEARANCE, assistantDot: true, assistantDotImage: '/dot.png' },
    )
    expect(image.container.querySelector('.term-assistant-dot-img')?.getAttribute('src')).toBe('/dot.png')
  })

  it('异步渲染 GFM Markdown，并拒绝 javascript 链接', async () => {
    const result = row({
      id: 'a3', role: 'assistant', sender: 'peri',
      content: '## 标题\n\n- 项目\n\n[安全](https://example.com) [危险](javascript:alert(1))', time: 't',
    })

    await waitFor(
      () => expect(result.getByRole('heading', { name: '标题' })).toBeTruthy(),
      { timeout: 10_000 },
    )
    expect(result.getByText('项目').closest('li')).not.toBeNull()
    expect(result.getByRole('link', { name: '安全' }).getAttribute('rel')).toBe('noopener noreferrer')
    expect(result.container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(result.getByText('危险').tagName).toBe('SPAN')
  })

  it('代码块复用旧 gutter DOM，并在高亮未完成时显示纯文本 fallback', async () => {
    const result = row({
      id: 'a4', role: 'assistant', sender: 'peri',
      content: '```unknown\nconst value = 1\nreturn value\n```', time: 't',
    })

    await waitFor(() => expect(result.container.querySelector('.term-code-block')).not.toBeNull())
    expect(result.container.querySelectorAll('.term-code-line')).toHaveLength(2)
    expect(result.container.textContent).toContain('const value = 1')
  })

  it('reasoning 展开后显示正文和完成时长（C01：duration 标签）', async () => {
    const result = row({
      id: 'r1', role: 'reasoning', sender: 'peri', content: '第一行\n第二行', time: 't',
      thoughtDurationMs: 2400,
    })
    // C01：label 从 chars 计数改为 duration 呈现
    const button = result.getByRole('button', { name: /Thought for 2\.4s/ })
    expect(button.getAttribute('aria-expanded')).toBe('false')
     fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // 正文经 C00 MarkdownContent 异步渲染，等待出现。等待对象是 createResource
    // 解析 + Solid 刷帧（微任务级）；统一冲刷预算见 solidTestHelpers 的 FLUSH_BUDGET。
    await waitFor(() => {
      if (!result.container.textContent?.includes('第二行')) throw new Error('markdown not flushed')
    }, FLUSH_BUDGET)
  })

  it('reasoning duration normalizes rounded seconds across the minute boundary', () => {
    const result = row({
      id: 'r-minute', role: 'reasoning', sender: 'peri', content: '边界', time: 't',
      thoughtDurationMs: 119_600,
    })
    expect(result.getByRole('button', { name: /Thought for 2m 0s/ })).toBeTruthy()
    expect(result.container.textContent).not.toContain('1m 60s')
  })

  it('system error 使用 alert 结构', () => {
    const result = row({ id: 'e1', role: 'assistant', sender: 'system', content: '后端错误', time: 't' })
    expect(result.getByRole('alert').textContent).toContain('后端错误')
    expect(result.container.querySelector('[data-render-type="error"]')).not.toBeNull()
  })
})
