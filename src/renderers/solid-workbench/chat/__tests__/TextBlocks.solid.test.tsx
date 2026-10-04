// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidAnsiBlock } from '../AnsiBlock.solid.tsx'
import { SolidCodeBlock } from '../CodeBlock.solid.tsx'

afterEach(() => cleanup())

/**
 * C00 RED：content.code / content.ansi 的 Solid surface 契约。
 * code：语言标签、高亮失败回退 escaped plain、copy 按钮、oversize 折叠。
 * ansi：脱敏渲染、原始文本可复制、reduced-motion 标记。
 */
describe('SolidCodeBlock (C00)', () => {
  it('shows language label and renders highlighted lines without remounting on update', async () => {
    const result = render(() => <SolidCodeBlock code={'const a = 1\nconst b = 2'} language="ts" />)
    expect(result.container.querySelector('.term-code-lang')?.textContent).toBe('ts')
    // 高亮是异步资源；至少原始行可见（回退路径）
    expect(result.container.textContent).toContain('const a = 1')
  })

  it('falls back to escaped plain text when language is unknown', () => {
    const result = render(() => <SolidCodeBlock code={'<img src=x onerror=alert(1)>'} language="definitely-not-a-language" />)
    const block = result.container.querySelector('.term-code-block')!
    expect(block.textContent).toContain('<img src=x onerror=alert(1)>')
    // 不产生任何注入元素
    expect(block.querySelector('img')).toBeNull()
  })

  it('folds oversize code with explicit truncation notice and keeps full text for copy', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n')
    const result = render(() => <SolidCodeBlock code={long} language="text" maxLines={50} />)
    const visible = result.container.querySelectorAll('.term-code-line').length
    // 折叠点在行边界：可见行数 ≤ maxLines + 1（截断行本身）
    expect(visible).toBeLessThanOrEqual(52)
    expect(result.container.textContent).toContain('已折叠')
    // 复制按钮携带完整原文（data-copy-text），搜索/复制不受折叠影响
    const copyButton = result.getByRole('button', { name: /复制/ })
    expect(copyButton.getAttribute('data-copy-text')).toBe(long)
  })

  it('#208：折叠提示可展开（有界步长）与收起——长正文不再只能靠复制才能读全', async () => {
    const { fireEvent } = await import('@solidjs/testing-library')
    const long = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n')
    const result = render(() => <SolidCodeBlock code={long} language="text" maxLines={50} />)
    const block = result.container.querySelector('.term-code-block')!
    const visibleLines = () => result.container.querySelectorAll('.term-code-line').length
    const foldedLines = () => Number((result.container.querySelector('.term-code-folded span')?.textContent ?? '').replace(/\D/g, ''))

    // 默认折叠态与改造前一致：可见行 ≤ maxLines + 1 个截断行，提示含「已折叠」
    expect(visibleLines()).toBeLessThanOrEqual(52)
    expect(block.getAttribute('data-folded')).toBe('true')
    const firstFoldVisible = visibleLines()

    // 展开一步：增量有界（≤ maxLines + 1），仍处于折叠态
    fireEvent.click(result.getByRole('button', { name: /显示更多/ }))
    const afterOneStep = visibleLines()
    expect(afterOneStep).toBeGreaterThan(firstFoldVisible)
    expect(afterOneStep - firstFoldVisible).toBeLessThanOrEqual(52)
    expect(block.getAttribute('data-folded')).toBe('true')
    expect(foldedLines()).toBeGreaterThan(0)

    // 收起：回到默认折叠态
    fireEvent.click(result.getByRole('button', { name: '收起' }))
    expect(visibleLines()).toBe(firstFoldVisible)
    expect(block.getAttribute('data-folded')).toBe('true')

    // 连续展开到底：可见行 = 全文行数、折叠提示消失、data-folded=false
    for (let step = 0; step < 12 && block.getAttribute('data-folded') === 'true'; step += 1) {
      fireEvent.click(result.getByRole('button', { name: /显示更多/ }))
    }
    expect(block.getAttribute('data-folded')).toBe('false')
    expect(visibleLines()).toBe(400)
    expect(result.container.textContent).not.toContain('已折叠')
    // 复制始终携带全文（与是否展开无关）
    expect(result.getByRole('button', { name: /复制/ }).getAttribute('data-copy-text')).toBe(long)
  })

  it('copies via clipboard adapter and shows copied feedback', async () => {
    let copiedText: string | undefined
    const result = render(() => <SolidCodeBlock code="hello" language="txt" onCopy={text => { copiedText = text }} />)
    const { fireEvent } = await import('@solidjs/testing-library')
    fireEvent.click(result.getByRole('button', { name: /复制/ }))
    expect(copiedText).toBe('hello')
    expect(result.getByRole('button', { name: '已复制' })).toBeTruthy()
  })

  it('applies resolved code appearance without changing the document payload', () => {
    const code = Array.from({ length: 30 }, (_, index) => `line-${index}`).join('\n')
    const result = render(() => <SolidCodeBlock
      code={code} language="ts" maxLines={20}
      showLanguage={false} showCopyButton={false} wrap="none" palette="solarized"
    />)
    const block = result.container.querySelector('.term-code-block')!
    expect(block.getAttribute('data-wrap')).toBe('none')
    expect(block.getAttribute('data-palette')).toBe('solarized')
    expect(block.querySelector('.term-code-lang')).toBeNull()
    expect(block.querySelector('.term-code-copy')).toBeNull()
    expect(block.textContent).toContain('已折叠')
  })
})

describe('SolidAnsiBlock (C00)', () => {
  it('renders sanitized colored spans and strips injection payloads', () => {
    const result = render(() => <SolidAnsiBlock text={'\u001b[31mERROR\u001b[0m \u001b]0;evil\u0007done'} />)
    const root = result.container.querySelector('.term-ansi-block')!
    expect(root.querySelector('.term-ansi-fg-red')?.textContent).toContain('ERROR')
    expect(JSON.stringify(root.innerHTML)).not.toContain('evil')
    expect(root.textContent).toContain('done')
  })

  it('exposes raw accessible text (controls stripped) and reduced-motion marker', () => {
    const result = render(() => <SolidAnsiBlock text={'\u001b[32mOK\u001b[0m'} reducedMotion={true} />)
    const root = result.container.querySelector('.term-ansi-block')!
    expect(root.getAttribute('data-reduced-motion')).toBe('true')
    expect(root.getAttribute('aria-label')).toBe('OK')
  })

  it('renders validated 256/truecolor values instead of emitting unstyled dynamic class names', () => {
    const result = render(() => <SolidAnsiBlock text={'\u001b[38;2;17;34;51mRGB\u001b[0m \u001b[48;5;196mBG\u001b[0m'} />)
    const rgb = [...result.container.querySelectorAll<HTMLElement>('.term-ansi-block span')]
      .find(node => node.textContent === 'RGB')!
    const background = [...result.container.querySelectorAll<HTMLElement>('.term-ansi-block span')]
      .find(node => node.textContent === 'BG')!
    expect(rgb.style.color).toBe('rgb(17, 34, 51)')
    expect(background.style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('applies resolved ANSI wrap, line cap, background and palette', () => {
    const result = render(() => <SolidAnsiBlock
      text={'one\ntwo'} wrap="none" maxLines={40} background="#112233" palette="accessible"
    />)
    const root = result.container.querySelector<HTMLElement>('.term-ansi-block')!
    expect(root.getAttribute('data-wrap')).toBe('none')
    expect(root.getAttribute('data-palette')).toBe('accessible')
    expect(root.style.whiteSpace).toBe('pre')
    expect(root.style.maxHeight).toBe('40em')
    expect(root.style.backgroundColor).toBe('rgb(17, 34, 51)')
  })
})
