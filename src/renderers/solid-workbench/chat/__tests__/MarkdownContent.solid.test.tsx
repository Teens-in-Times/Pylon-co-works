// @vitest-environment jsdom

/**
 * CSS-04：Solid renderer 真实 DOM 渲染回归测试（CR-325 消化——domains/theme/typographyBaseline（原 css01）headingDomContract 与
 * 工具同源无法捕获 renderer 回归，此测试直接渲染 MarkdownContent 验证 heading class 输出）。
 *
 * 覆盖：`# h1` → h1.term-h1；`###### h6` → h6.term-h6；普通段落不携带 term-h 类。
 * 依赖真实 markdown 解析链（#220 后为 wasm 计算核 parseMarkdown，模型与 hast 基线同构），
 * 非 mock——可捕获 allowedTagName 或 headingClass 派生逻辑被改的回归。
 */

import { cleanup, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'
import { clearMarkdownRenderModelCache } from '../markdownRenderModel.ts'

afterEach(() => {
  cleanup()
})

describe('MarkdownContent heading class contract（CSS-02，CSS-04 回归门）', () => {
  it('`# h1` 输出 h1.term-h1；`###### h6` 输出 h6.term-h6', async () => {
    render(() => <MarkdownContent text="# Title&#10;&#10;###### Small" />)
    const h1 = await waitFor(() => screen.getByRole('heading', { level: 1 }), { timeout: 10_000 })
    expect(h1.tagName).toBe('H1')
    expect(h1.getAttribute('class')).toContain('term-h1')
    const h6 = await waitFor(() => screen.getByRole('heading', { level: 6 }))
    expect(h6.tagName).toBe('H6')
    expect(h6.getAttribute('class')).toContain('term-h6')
  })

  it('普通段落不携带 term-h 类（headingClass 仅派生自 h1-h6）', async () => {
    render(() => <MarkdownContent text="plain text only" />)
    expect(screen.queryByRole('heading')).toBeNull()
    const paragraph = await waitFor(() => screen.getByText('plain text only'))
    expect(paragraph.className).toContain('term-p')
    expect(paragraph.className).not.toContain('term-h')
  })

  it('Bug4：streaming 增量渲染——切分后内容完整、结构正确（标题+段落+代码围栏）', async () => {
    // 流式文本含已完成块 + 增长尾部；增量切分后必须仍完整渲染出所有内容，结构不被劈坏。
    render(() => (
      <MarkdownContent
        text={'# 标题\n\n第一段已完成\n\n```js\nconst x = 1\n```\n\n正在增长的新段落'}
        streaming
      />
    ))
    const h1 = await waitFor(() => screen.getByRole('heading', { level: 1 }))
    expect(h1).toBeTruthy()
    expect(screen.getByText('第一段已完成')).toBeTruthy()
    // 代码块内容与增长尾部都应出现。高亮自 #220 起在测试环境同样真实工作
    // （#241 起是纯 JS 的 Lezer 引擎，无 wasm/oniguruma 装载依赖），代码行被拆成
    // pl-* span——testing-library 的 getByText 只看直接文本节点，这里改按行的
    // textContent 断言同一内容完整性。
    await waitFor(() => {
      const line = [...document.querySelectorAll('.term-code-text')]
        .find(node => node.textContent?.includes('const x = 1'))
      expect(line).toBeTruthy()
    })
    expect(screen.getByText('正在增长的新段落')).toBeTruthy()
  })

  it('streaming 不在带缩进的未闭合代码围栏内部拆块', async () => {
    const { container } = render(() => <MarkdownContent
      text={'前置段落\n\n   ```js\nconst first = 1\n\nconst second = 2'}
      streaming
    />)

    await waitFor(() => expect(container.textContent).toContain('const second = 2'))
    const codeBlock = container.querySelector('.term-code-block')
    expect(codeBlock).not.toBeNull()
    expect(codeBlock).toHaveTextContent('const first = 1')
    expect(codeBlock).toHaveTextContent('const second = 2')
    expect(container.querySelectorAll('.term-code-block')).toHaveLength(1)
  })

  it('流式结束后仍保留 Markdown 诗歌的段落与软换行', async () => {
    const [state, setState] = createSignal({
      text: '**星河**\n\n春风拂过山岗\n月光落在窗\n\n我把远方写进诗行\n让星河在梦里流淌',
      streaming: true,
    })
    const result = render(() => <MarkdownContent text={state().text} streaming={state().streaming} />)

    await waitFor(() => expect(result.container).toHaveTextContent('让星河在梦里流淌'))
    setState(current => ({ ...current, streaming: false }))

    await waitFor(() => {
      const paragraphs = [...result.container.querySelectorAll('p')]
      if (paragraphs.length < 2) throw new Error('final Markdown paragraphs not mounted')
      expect(paragraphs.every(paragraph => paragraph.classList.contains('term-p'))).toBe(true)
      expect(paragraphs.some(paragraph => paragraph.textContent?.includes('春风拂过山岗\n月光落在窗'))).toBe(true)
    })
  })

  it('流式首段的前导空行不渲染为可见空行（与解析路径剥前导空白一致）', async () => {
    const [text, setText] = createSignal('\n\n开始输出')
    const result = render(() => <MarkdownContent text={text()} streaming />)

    await waitFor(() => expect(result.container).toHaveTextContent('开始输出'))
    const blocks = [...result.container.querySelectorAll('.term-p')]
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0]!.textContent?.startsWith('\n')).toBe(false)
    expect(blocks.every(block => (block.textContent ?? '').length > 0)).toBe(true)

    setText('\n\n开始输出\n\n第二段继续')
    await waitFor(() => expect(result.container).toHaveTextContent('第二段继续'))
    const grown = [...result.container.querySelectorAll('.term-p')]
    expect(grown.every(block => (block.textContent ?? '').length > 0)).toBe(true)
  })

  it('单行 fenced code 仍渲染为块级代码而不是 inline code', async () => {
    const { container } = render(() => <MarkdownContent text={'```ts\nconst x = 1\n```'} />)
    await waitFor(() => expect(container.querySelector('.term-code-block')).not.toBeNull())
    expect(container.querySelector('.term-code-block')).toHaveTextContent('const x = 1')
    expect(container.querySelector(':scope > .term-inline-code')).toBeNull()
  })

  it('内联代码保留独立代码字体/着色 class，普通英文仍是正文节点', async () => {
    const { container } = render(() => <MarkdownContent text={'普通 English 与 `inline()` 混排'} />)
    const inline = await waitFor(() => {
      const node = container.querySelector('.term-inline-code')
      if (!node) throw new Error('inline code not mounted')
      return node
    })
    expect(inline).toHaveTextContent('inline()')
    expect(inline.tagName).toBe('CODE')
    expect(container.textContent).toContain('普通 English 与')
  })

  it('保留安全 Markdown 图片并拒绝可执行 source', async () => {
    const safe = render(() => <MarkdownContent text="![diagram](https://example.com/diagram.png)" />)
    await waitFor(() => expect(safe.container.querySelector('img')).not.toBeNull())
    expect(safe.container.querySelector('img')).toHaveAttribute('src', 'https://example.com/diagram.png')
    safe.unmount()

    const unsafe = render(() => <MarkdownContent text="![bad](javascript:alert(1))" />)
    await waitFor(() => expect(unsafe.container).toHaveTextContent('bad'))
    expect(unsafe.container.querySelector('img')).toBeNull()
  })

  it('保留无 scheme 的工作区相对文件链接，供 AgentSheet 捕获并转入 FileSheet', async () => {
    const { container } = render(() => <MarkdownContent text="[main](src/main.ts#L12)" />)
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull())
    expect(container.querySelector('a')).toHaveAttribute('href', 'src/main.ts#L12')
  })

  // P57 S3-R1（R-B1）：三处代码内容 span（流式代码块 + fenced code 回退/高亮）统一
  // 携带 term-code-text 类——CSS contract 只读 CSS 文本，拦不住漏改 span，此处补
  // DOM 类名断言。
  it('P57 S3-R1：流式与终态代码块的每行内容 span 都带 term-code-text 类', async () => {
    const streaming = render(() => (
      <MarkdownContent text={'前置段落\n\n   ```js\nconst indent  = 4\nconst second = 2'} streaming />
    ))
    await waitFor(() => expect(streaming.container.querySelector('.term-code-block')).not.toBeNull())
    for (const block of streaming.container.querySelectorAll('.term-code-block')) {
      expect(block.querySelectorAll('.term-code-line').length).toBeGreaterThan(0)
      for (const line of block.querySelectorAll('.term-code-line')) {
        expect(line.querySelector('.term-code-text')).not.toBeNull()
      }
    }
    streaming.unmount()

    const final = render(() => <MarkdownContent text={'```js\nconst indent  = 4\n```'} />)
    await waitFor(() => expect(final.container.querySelector('.term-code-block')).not.toBeNull())
    await waitFor(() => expect(final.container.querySelector('.term-code-text')).not.toBeNull())
    for (const block of final.container.querySelectorAll('.term-code-block')) {
      for (const line of block.querySelectorAll('.term-code-line')) {
        expect(line.querySelector('.term-code-text')).not.toBeNull()
      }
    }
  })

  // P57 S3-R5（R-B5）：user 文本双路径同构——带反引号（解析路径）与纯文本
  // （回退路径）的多行文本渲染出相同数量的段，且文本内容都保留换行。
  // （jsdom 不做级联计算，white-space 计算样式断言不可靠；此处锁定 DOM 形状，
  //  pre-wrap 语义由 ChatView.css.test 的 contract 层锁定。）
  it('P57 S3-R5：带反引号的多行 user 文本与纯文本路径段数一致', async () => {
    const withBackticks = render(() => (
      <div class="term-user"><div class="term-user-content">
        <MarkdownContent text={'第一行 `code-a`\n第二行 `code-b`'} inline />
      </div></div>
    ))
    await waitFor(() => expect(withBackticks.container.querySelector('p.term-p')).not.toBeNull())
    const plain = render(() => (
      <div class="term-user"><div class="term-user-content">
        <MarkdownContent text={'第一行 plain\n第二行 plain'} inline />
      </div></div>
    ))
    await waitFor(() => expect(plain.container.querySelector('.term-plain-text')).not.toBeNull())

    const parsedSegments = withBackticks.container.querySelectorAll('.term-user p, .term-user .term-p')
    const plainSegments = plain.container.querySelectorAll('.term-user p, .term-user .term-p')
    expect(parsedSegments.length).toBe(plainSegments.length)
    expect(parsedSegments.length).toBe(1)
    expect(withBackticks.container.querySelector('p.term-p')?.textContent).toContain('\n')
    expect(plain.container.querySelector('.term-plain-text')?.textContent).toContain('\n')
  })
})

describe('#208 遗留：流式代码块刻意不折叠（用户裁决：看着它继续长）', () => {
  it('未闭合围栏在流式期全量渲染，不出现折叠提示', async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `const value${index} = ${index}`)
    const text = ['```js', ...lines].join(String.fromCharCode(10))
    const streaming = render(() => <MarkdownContent text={text} streaming />)

    const block = await waitFor(() => {
      const node = streaming.container.querySelector('.term-code-block[data-streaming-code="true"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    // 过渡态：生成期不折叠、不挂展开入口；结算后由 #208 的头部折叠接管
    expect(block.querySelectorAll('.term-code-line')).toHaveLength(lines.length)
    expect(block.querySelector('.term-code-folded')).toBeNull()
    expect(block.getAttribute('data-folded')).toBeNull()
    streaming.unmount()
  })
})

describe('#212：命中已结算缓存时同步渲染，不出现骨架', () => {
  it('同一文本第二次挂载在第一个微任务之前就已渲染内容', async () => {
    clearMarkdownRenderModelCache()
    const text = ['## 缓存命中标题', '', '正文一段'].join('\n')
    const first = render(() => <MarkdownContent text={text} />)
    // 首次：走真实解析，等它结算并登记进 settledModels
    await waitFor(() => expect(first.container.querySelector('h2')?.textContent).toBe('缓存命中标题'))

    const second = render(() => <MarkdownContent text={text} />)
    // 同步断言：不给任何微任务机会——命中已结算模型时内容应已就位，且没有骨架
    expect(second.container.querySelector('.term-md-skeleton')).toBeNull()
    expect(second.container.querySelector('h2')?.textContent).toBe('缓存命中标题')
    clearMarkdownRenderModelCache()
  })
})
