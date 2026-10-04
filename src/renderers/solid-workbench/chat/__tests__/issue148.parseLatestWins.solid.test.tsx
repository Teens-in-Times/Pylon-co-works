// @vitest-environment jsdom
/**
 * issue #148：流式尾块解析「最新即胜」+ 只读成本计数。
 *
 * 锁定三件事：
 * 1. 判据为假（请求已被取代）时**不跑解析器**：返回空模型、计入 `skipped`，不算 `parsed`。
 *    Solid 的 `createResource` 只在 `pr === p` 时提交结果，所以这些请求的结果本来就会被丢弃。
 * 2. 跳过结果**不进 LRU**：同文本的下一次请求仍会真正解析（否则缓存里的空模型会把行渲染成空）。
 * 3. 判据只出现在**增长尾块**（`cache: false`）路径上：一 tick 内多次发布时中间态被挡下
 *    （突发退化到 O(1) 次解析），而每次发布之间让出事件循环的帧节奏下 0 次跳过（零副作用）。
 */
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownRenderModelOptions } from '../markdownRenderModel.ts'

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ readonly text: string; readonly options: MarkdownRenderModelOptions | undefined }>,
}))

// 记录调用参数后转交真实实现：让「调用契约」与「真实解析行为」在同一份夹具里都能断言。
vi.mock('../markdownRenderModel.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../markdownRenderModel.ts')>()
  return {
    ...actual,
    async getMarkdownRenderModel(markdown: string, options?: MarkdownRenderModelOptions) {
      harness.calls.push({ text: markdown, options })
      return actual.getMarkdownRenderModel(markdown, options)
    },
  }
})

import { MarkdownContent } from '../MarkdownContent.solid.tsx'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel } from '../markdownRenderModel.ts'
import { markdownParseCounters, resetMarkdownParseCounters } from '../markdownParseCounters.ts'
import { flushTask } from '../../../../test/solidTestHelpers.ts'

beforeEach(() => {
  harness.calls.length = 0
  resetMarkdownParseCounters()
  clearMarkdownRenderModelCache()
})

afterEach(cleanup)

/** 每 2 字一片的 token 级切片（切点落在词中间，与真机到达节奏同形）。 */
function slices(text: string, size = 2): string[] {
  const prefixes: string[] = []
  for (let end = size; end < text.length; end += size) prefixes.push(text.slice(0, end))
  prefixes.push(text)
  return prefixes
}

describe('issue 148: 解析请求最新即胜（模型层）', () => {
  it('判据为假时跳过解析：返回空模型并计入 skipped，不计 parsed', async () => {
    const text = '**粗体** 正文'
    const skipped = await getMarkdownRenderModel(text, { cache: false, isCurrent: () => false })
    expect(skipped).toEqual({ type: 'root', children: [] })
    expect(markdownParseCounters()).toMatchObject({ parsed: 0, skipped: 1, maxTextLength: 0 })

    const parsed = await getMarkdownRenderModel(text, { cache: false, isCurrent: () => true })
    expect(parsed.children.length).toBeGreaterThan(0)
    // 成本读数：真正解析的那次才有耗时与文本长度
    const counters = markdownParseCounters()
    expect(counters).toMatchObject({ parsed: 1, skipped: 1, maxTextLength: text.length })
    expect(counters.parseMs).toBeGreaterThanOrEqual(0)
  })

  it('跳过结果不进 LRU：同文本的下一次请求仍会真正解析', async () => {
    const text = '**粗体** 缓存安全'
    // cache 默认为真（走 LRU）：跳过返回的哨兵不得留在缓存里，否则下一次请求会复用空模型
    const skipped = await getMarkdownRenderModel(text, { isCurrent: () => false })
    expect(skipped).toEqual({ type: 'root', children: [] })

    const model = await getMarkdownRenderModel(text)
    expect(model.children.length).toBeGreaterThan(0)
    expect(markdownParseCounters()).toMatchObject({ parsed: 1, skipped: 1 })
  })

  it('不传判据时行为不变（缓存命中复用，不再解析）', async () => {
    const text = '**粗体** 无判据'
    const first = await getMarkdownRenderModel(text)
    const second = await getMarkdownRenderModel(text)
    expect(second).toBe(first)
    expect(markdownParseCounters()).toMatchObject({ parsed: 1, cacheHits: 1, skipped: 0 })
  })
})

describe('issue 148: 解析请求最新即胜（组件层）', () => {
  it('同步突发只解析最后一次：中间态在判据处被挡下', async () => {
    const full = '**粗体** 与 `code` 与 [链接](https://example.com) 构成的一段需要解析的正文。'
    const prefixes = slices(full)
    const [text, setText] = createSignal(prefixes[0] ?? '')
    const { container } = render(() => <MarkdownContent text={text()} streaming />)

    // 一次 tick 内喂完全部切片：解析只能落到最后一次请求上（此前每次的结果都会被 Solid 丢弃）
    for (const prefix of prefixes) setText(prefix)
    await waitFor(() => expect(container.textContent).toContain('正文'))

    const counters = markdownParseCounters()
    expect(counters.parsed).toBe(1)
    expect(counters.skipped).toBeGreaterThan(0)
    expect(container.textContent).toContain('粗体')
    expect(container.textContent).not.toContain('**')

    // 判据只出现在尾块（cache: false）路径上——缓存路径传它会毒化同文本的其他行
    const tailCalls = harness.calls.filter(call => call.options?.cache === false)
    expect(tailCalls.length).toBeGreaterThan(1)
    expect(tailCalls.every(call => call.options?.isCurrent !== undefined)).toBe(true)
    for (const call of harness.calls) {
      if (call.options?.cache !== false) expect(call.options?.isCurrent).toBeUndefined()
    }
  })

  it('帧节奏（每次发布之间让出事件循环）不跳过：判据只在同一 tick 内多次发布时生效', async () => {
    const full = '**粗体** 逐帧揭示的正文，带 `code` 标记。'
    const [text, setText] = createSignal('')
    const { container } = render(() => <MarkdownContent text={text()} streaming />)

    for (let end = 2; end <= full.length; end += 2) {
      setText(full.slice(0, end))
      // 让出一个宏任务：判据是「解析任务启动时信号文本是否仍等于请求文本」，
      // 只需 tick 分离，与真实毫秒数无关（#545：原先 5ms 真实休眠是过量预算）。
      await flushTask()
    }
    await waitFor(() => expect(container.textContent).toContain('标记'))

    expect(markdownParseCounters().skipped).toBe(0)
    expect(markdownParseCounters().parsed).toBeGreaterThan(1)
  })

  it('非流式（已提交消息）路径不传判据，且默认走缓存', async () => {
    const { container } = render(() => <MarkdownContent text="**已提交** 正文" />)
    await waitFor(() => expect(container.textContent).toContain('正文'))

    expect(harness.calls.length).toBeGreaterThan(0)
    expect(harness.calls.every(call => call.options?.isCurrent === undefined)).toBe(true)
    expect(harness.calls.every(call => call.options?.cache !== false)).toBe(true)
  })
})
