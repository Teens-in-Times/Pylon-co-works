// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidFileReferenceCard } from '../FileReference.solid.tsx'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'
import type { ContentPart } from '../../../../../domains/workbench/content/contentPartSchema.ts'

/**
 * C02 RED：Solid 文件卡契约。
 *
 * 卡面要求：路径/范围/metadata 可见；动作经 capability gate——不可用 disabled + 原因；
 * 资源卡不渲染 blob；路径原样呈现。
 */

function card(part: ContentPart, actions?: Parameters<typeof SolidFileReferenceCard>[0]['actions']) {
  return render(() => <SolidFileReferenceCard part={part} actions={actions} />)
}

afterEach(() => cleanup())

describe('C02 SolidFileReferenceCard', () => {
  it('shows file name and raw path without URI rewriting', () => {
    const result = card({ kind: 'file-reference', path: 'C:\\Users\\demo\\report.md', displayName: 'report.md' })
    expect(result.container.textContent).toContain('report.md')
    expect(result.container.textContent).toContain('C:\\Users\\demo\\report.md')
    // 不做 file:/// 猜测互转
    expect(result.container.textContent).not.toContain('file://')
  })

  it('shows selection range and language', () => {
    const result = card({
      kind: 'file-selection',
      path: '/workspace/src/main.ts',
      selection: { start: { line: 10, column: 4 }, end: { line: 24 } },
      language: 'ts',
    })
    expect(result.container.textContent).toContain('L10:4–L24')
    expect(result.container.textContent).toContain('ts')
  })

  it('disables actions with reasons when capabilities are missing', () => {
    const result = card({ kind: 'file-reference', path: '/a/b.txt' }, {})
    const buttons = result.container.querySelectorAll('button.term-file-action')
    expect(buttons.length).toBe(3)
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(true)
      expect(button.getAttribute('title')).toContain('未接入')
    }
  })

  it('invokes command port actions only when enabled', async () => {
    const open = vi.fn()
    const copyPath = vi.fn()
    const result = card(
      { kind: 'file-reference', path: '/a/b.txt' },
      { canOpen: true, canCopy: true, canReveal: false, open, copyPath },
    )
    const buttons = [...result.container.querySelectorAll('button.term-file-action')] as HTMLButtonElement[]
    const byLabel = (label: string) => buttons.find(button => button.textContent === label)!
    byLabel('打开').click()
    expect(open).toHaveBeenCalled()
    byLabel('复制路径').click()
    expect(copyPath).toHaveBeenCalledWith('/a/b.txt')
    // reveal 未启用——disabled 且点击无效
    const reveal = byLabel('定位')
    expect(reveal.hasAttribute('disabled')).toBe(true)
  })

  it('renders resource metadata without exposing blob content', () => {
    const result = card({
      kind: 'resource' as never,
      uri: 'file:///docs/spec.pdf',
      mimeType: 'application/pdf',
      hasBlob: true,
    } as ContentPart)
    expect(result.container.textContent).toContain('spec.pdf')
    expect(result.container.textContent).toContain('application/pdf')
    expect(result.container.textContent).toContain('二进制内容不内联展示')
    expect(result.container.textContent).not.toContain('JVBERi0xLjQK')
  })

  it('renders canonical documents and consumes resolved C02 settings in the base Slot', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'document-1', kind: 'content.document', revision: 1,
        payload: {
          kind: 'document', title: 'spec.md', path: '/workspace/docs/spec.md',
          mimeType: 'text/markdown', text: 'line one\nline two\nline three',
        },
      }}
      appearance={{
        foreground: '#112233', mutedForeground: '#445566', background: '#f1f2f3',
        borderColor: '#778899', fontSize: 17, iconSize: 24, maxWidth: 720, maxHeight: 180,
        pathCollapse: 'basename', previewLines: 2, showAbsolutePath: false,
        showMetadata: false, fileTypePalette: 'accent', groupLayout: 'grid',
      }}
      commands={{ execute: () => {} }}
    />)

    const cardNode = result.container.querySelector<HTMLElement>('[data-part-kind="document"]')!
    expect(cardNode).not.toBeNull()
    expect(cardNode.dataset.fileTypePalette).toBe('accent')
    expect(cardNode.dataset.groupLayout).toBe('grid')
    expect(cardNode.style.color).toBe('rgb(17, 34, 51)')
    expect(cardNode.style.backgroundColor).toBe('rgb(241, 242, 243)')
    expect(cardNode.style.borderColor).toBe('rgb(119, 136, 153)')
    expect(cardNode.style.fontSize).toBe('17px')
    expect(cardNode.style.maxWidth).toBe('720px')
    expect(result.getByText('spec.md')).toBeTruthy()
    expect(result.container.querySelector('.term-file-path')).toBeNull()
    expect(result.container.textContent).not.toContain('text/markdown')
    const preview = result.container.querySelector<HTMLElement>('.term-file-preview')!
    expect(preview.textContent).toBe('line one\nline two')
    expect(preview.style.maxHeight).toBe('180px')
    expect(result.container.textContent).not.toContain('line three')
  })

  it('routes enabled file actions through the base Slot semantic command port', async () => {
    const execute = vi.fn()
    const part = { kind: 'file-reference', path: '/workspace/readme.md', displayName: 'readme.md' }
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'file-action', kind: 'content.file-reference', revision: 1, payload: part }}
      appearance={{}}
      commands={{
        canExecute: type => type === 'resource.open' || type === 'clipboard.write',
        execute,
      }}
    />)

    result.getByRole('button', { name: '打开' }).click()
    result.getByRole('button', { name: '复制路径' }).click()
    expect(result.getByRole('button', { name: '定位' })).toBeDisabled()
    expect(execute).toHaveBeenNthCalledWith(1, { type: 'resource.open', payload: part })
    expect(execute).toHaveBeenNthCalledWith(2, { type: 'clipboard.write', payload: { text: '/workspace/readme.md' } })
  })

  it('keeps embedded resource text visible within the configured preview boundary', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'resource-text', kind: 'content.resource', revision: 1,
        payload: { kind: 'resource', uri: 'mcp://guide', mimeType: 'text/plain', text: 'first\nsecond\nthird' },
      }}
      appearance={{ previewLines: 2, maxHeight: 120 }}
      commands={{ execute: () => {} }}
    />)

    const preview = result.container.querySelector<HTMLElement>('.term-file-preview')!
    expect(preview.textContent).toBe('first\nsecond')
    expect(preview.style.maxHeight).toBe('120px')
    expect(result.container.textContent).not.toContain('third')
  })

  it('keeps file-selection preview text visible within the configured preview boundary', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'selection-preview', kind: 'content.file-selection', revision: 1,
        payload: {
          kind: 'file-selection', path: '/workspace/a.ts', selection: { start: { line: 1 }, end: { line: 3 } },
          previewText: 'const a = 1\nconst b = 2\nconst c = 3', language: 'ts',
        },
      }}
      appearance={{ previewLines: 2, maxHeight: 140 }}
      commands={{ execute: () => {} }}
    />)

    const preview = result.container.querySelector<HTMLElement>('.term-file-preview')!
    expect(preview.textContent).toBe('const a = 1\nconst b = 2')
    expect(preview.style.maxHeight).toBe('140px')
    expect(result.container.textContent).not.toContain('const c = 3')
  })
})
