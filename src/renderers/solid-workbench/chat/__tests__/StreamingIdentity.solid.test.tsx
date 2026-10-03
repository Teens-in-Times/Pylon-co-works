// @vitest-environment jsdom
import { createSignal } from 'solid-js'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'

/**
 * C00 验收：1000 chunk 流式追加不 remount。
 *
 * 契约：stable 前缀不变时，其 DOM 节点身份保持不变（不重解析、不重建）；
 * 只有 unstable 尾块随内容增长更新。锚定 stable 区的 h1 元素验证身份。
 *
 * 注意：waitFor 回调返回 null 会直接 resolve(null)（不轮询），
 * 必须以 throw 表达"未就绪"。
 * 预算依据：等待对象是 MarkdownContent 的 createResource 解析与 Solid 调度器
 * 刷帧（微任务级，常态 <50ms）；2s 是满载并发下的调度抖动余量（#175
 * maxWorkers=50% 已消除 paging 冻结根因），原 5s 是 P91 retry 退役期的粗放放宽。
 */
const FLUSH_BUDGET = { timeout: 2_000 }
afterEach(() => cleanup())

describe('C00 streaming root identity (1000 chunks)', () => {
  it('places one zero-text cursor at the live plain-text tip and clears it after the last reveal', () => {
    vi.useFakeTimers()
    try {
      const [state, setState] = createSignal({ text: '首段', streaming: true })
      const result = render(() => <MarkdownContent text={state().text} streaming={state().streaming} />)
      const paragraph = result.container.querySelector('.term-plain-text')
      expect(paragraph?.querySelector('.term-typewriter-cursor')).toHaveAttribute('aria-hidden', 'true')
      expect(paragraph).toHaveTextContent('首段')
      vi.advanceTimersByTime(420)
      expect(paragraph?.querySelector('.term-typewriter-cursor')).toBeNull()

      setState({ text: '首段继续', streaming: false })
      expect(result.container.querySelector('.term-plain-text')).toBe(paragraph)
      expect(paragraph?.querySelector('.term-typewriter-cursor')).not.toBeNull()
      vi.advanceTimersByTime(420)
      expect(paragraph?.querySelector('.term-typewriter-cursor')).toBeNull()
      expect(result.container.textContent).toBe('首段继续')
      setState({ text: '历史替换', streaming: false })
      expect(result.container.querySelector('.term-typewriter-cursor')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the cursor on the last parsed text leaf without touching stable blocks', async () => {
    const [text, setText] = createSignal('# 稳定标题\n\n**粗体**')
    const result = render(() => <MarkdownContent text={text()} streaming />)
    const heading = await waitFor(() => {
      const node = result.container.querySelector('h1')
      if (!node) throw new Error('heading not ready')
      return node
    }, FLUSH_BUDGET)
    await waitFor(() => expect(result.container.querySelector('strong')).not.toBeNull(), FLUSH_BUDGET)
    setText('# 稳定标题\n\n**粗体** 追加')
    await waitFor(() => expect(result.container.querySelector('p .term-typewriter-cursor')).not.toBeNull(), FLUSH_BUDGET)
    expect(result.container.querySelectorAll('.term-typewriter-cursor')).toHaveLength(1)
    expect(heading.querySelector('.term-typewriter-cursor')).toBeNull()
    expect(result.container.querySelector('h1')).toBe(heading)
  })

  it('anchors the cursor to only the final line of an open code fence', () => {
    const result = render(() => <MarkdownContent text={'```ts\nsame\nsame'} streaming />)
    const lines = result.container.querySelectorAll('.term-code-line')
    expect(lines).toHaveLength(2)
    expect(lines[0]?.querySelector('.term-typewriter-cursor')).toBeNull()
    expect(lines[1]?.querySelector('.term-typewriter-cursor')).not.toBeNull()
  })

  it('marks a newly stable list once while preserving an earlier stable heading', async () => {
    const [state, setState] = createSignal({ text: '# 已稳定\n\n- 第一项', streaming: true })
    const result = render(() => <MarkdownContent text={state().text} streaming={state().streaming} />)
    const heading = await waitFor(() => {
      const node = result.container.querySelector('h1')
      if (!node) throw new Error('heading not ready')
      return node
    }, FLUSH_BUDGET)
    await waitFor(() => expect(result.container.querySelector('ul')).not.toBeNull(), FLUSH_BUDGET)
    expect(result.container.querySelector('[data-md-settle]')).toBeNull()

    // settle 标记由 620ms setTimeout 清除（MarkdownContent createStreamingBlockRow.pulseSettle）。
    // 必须在触发 settle 的 setState **之前**切 fake timers，清除定时器才会落在假时钟上；
    // advance 650ms 越过清除窗（650 > 620），负断言依旧真实推进了时间窗。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      setState({ text: '# 已稳定\n\n- 第一项', streaming: false })
      expect(result.container.querySelector('ul')).toHaveAttribute('data-md-settle', 'true')
      expect(result.container.querySelector('h1')).toBe(heading)
      await vi.advanceTimersByTimeAsync(650)
      expect(result.container.querySelector('[data-md-settle]')).toBeNull()
      setState({ text: '# 已稳定\n\n- 第一项修订', streaming: false })
      expect(result.container.querySelector('[data-md-settle]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a code fence when its closing delimiter appears', async () => {
    const [text, setText] = createSignal('```ts\nconst value = 1')
    const result = render(() => <MarkdownContent text={text()} streaming />)
    expect(result.container.querySelector('[data-streaming-code="true"]')).not.toBeNull()
    setText('```ts\nconst value = 1\n```')
    await waitFor(() => expect(result.container.querySelector('.term-code-block')).toHaveAttribute('data-md-settle', 'true'), FLUSH_BUDGET)
  })

  it.each([
    '- **父项**\n\n  - **子项**\n\n    子项续写。',
    '> **引用**\n\n> 续写引用。',
  ])('places a parsed container cursor inside its last visible paragraph', async text => {
    const result = render(() => <MarkdownContent text={text} streaming />)
    const cursor = await waitFor(() => {
      const node = result.container.querySelector('.term-typewriter-cursor')
      if (!node) throw new Error('typing cursor not ready')
      return node
    }, FLUSH_BUDGET)
    expect(cursor.closest('p')).not.toBeNull()
    expect(result.container.querySelectorAll('.term-typewriter-cursor')).toHaveLength(1)
  })

  it('keeps stable heading identity across 1000 tail appends', async () => {
    // 初始即含一个已完成块边界；此后 1000 chunk 全部落在 unstable 尾块内
    const [text, setText] = createSignal('# 稳定标题\n\n尾块起点。')
    const result = render(() => <MarkdownContent text={text()} streaming />)

    const headingBefore = await waitFor(() => {
      const found = result.container.querySelector('h1')
      if (!found) throw new Error('h1 not mounted yet')
      return found
    }, FLUSH_BUDGET)
    expect(headingBefore.textContent).toBe('稳定标题')

    for (let i = 0; i < 1000; i += 1) {
      setText(current => `${current}chunk-${i} `)
    }

    await waitFor(() => {
      if (!result.container.textContent?.includes('chunk-999')) throw new Error('tail not flushed')
    }, FLUSH_BUDGET)
    const headingAfter = result.container.querySelector('h1')!
    // stable 段 DOM 身份不变——1000 chunk 零 remount
    expect(headingAfter).toBe(headingBefore)
  })

  it('keeps plain-text streaming paragraph identity when no markdown structure appears', async () => {
    const [text, setText] = createSignal('纯文本流')
    const result = render(() => <MarkdownContent text={text()} streaming />)
    const paragraphBefore = await waitFor(() => {
      const found = result.container.querySelector('.term-plain-text')
      if (!found) throw new Error('paragraph not mounted yet')
      return found
    }, FLUSH_BUDGET)
    for (let i = 0; i < 1000; i += 1) {
      setText(current => `${current} 第${i}句`)
    }
    await waitFor(() => {
      if (!result.container.textContent?.includes('第999句')) throw new Error('tail not flushed')
    }, FLUSH_BUDGET)
    const paragraphAfter = result.container.querySelector('.term-plain-text')!
    expect(paragraphAfter).toBe(paragraphBefore)
  })

  it('does not mount an empty paragraph before the first streaming chunk', async () => {
    const result = render(() => <MarkdownContent text="首个流式片段" streaming />)
    await waitFor(() => {
      if (!result.container.textContent?.includes('首个流式片段')) throw new Error('tail not flushed')
    })
    expect(result.container.querySelectorAll('.term-plain-text')).toHaveLength(1)
    expect(result.container.querySelector('.term-plain-text')).toHaveTextContent('首个流式片段')
  })

  it('promotes a completed tail block and terminal update without remounting prior block DOM', async () => {
    const [state, setState] = createSignal({ text: '# 标题\n\n尾段', streaming: true })
    const result = render(() => <MarkdownContent text={state().text} streaming={state().streaming} />)
    const heading = await waitFor(() => {
      const node = result.container.querySelector('h1')
      if (!node) throw new Error('heading not ready')
      return node
    })
    const tail = await waitFor(() => {
      const node = [...result.container.querySelectorAll('p')].find(item => item.textContent?.trim() === '尾段')
      if (!node) throw new Error('tail not ready')
      return node
    })

    setState({ text: '# 标题\n\n尾段\n\n新尾段', streaming: true })
    await waitFor(() => expect(result.container).toHaveTextContent('新尾段'))
    expect(result.container.querySelector('h1')).toBe(heading)
    expect([...result.container.querySelectorAll('p')].find(item => item.textContent?.trim() === '尾段')).toBe(tail)

    setState({ text: '# 标题\n\n尾段\n\n新尾段', streaming: false })
    await waitFor(() => expect(result.container).toHaveTextContent('新尾段'))
    expect(result.container.querySelector('h1')).toBe(heading)
    expect([...result.container.querySelectorAll('p')].find(item => item.textContent?.trim() === '尾段')).toBe(tail)
  })
})
