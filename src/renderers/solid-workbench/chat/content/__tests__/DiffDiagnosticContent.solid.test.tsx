// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'

afterEach(cleanup)

describe('C06 diff and LSP built-in content Slot', () => {
  it('renders a normalized diff snapshot instead of exposing provider raw as unknown content', () => {
    render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'diff-1', kind: 'content.diff', revision: 1,
        payload: {
          kind: 'diff', path: '/src/app.ts', status: 'modified',
          oldText: 'const renderer = "react"\n', newText: 'const renderer = "solid"\n',
          lines: [
            { kind: 'removed', text: 'const renderer = "react"' },
            { kind: 'added', text: 'const renderer = "solid"' },
          ],
          additions: 1, deletions: 1, rawPatch: 'provider-private-patch',
        },
      }}
      appearance={{ defaultExpanded: true }}
      commands={{ execute: vi.fn(), canExecute: () => false }}
    />)

    const card = screen.getByRole('region', { name: 'Diff：/src/app.ts' })
    expect(card).toHaveTextContent('/src/app.ts')
    expect(card).toHaveTextContent('1 additions · 1 deletions')
    expect(card).toHaveTextContent('const renderer = "solid"')
    expect(card).not.toHaveTextContent('provider-private-patch')
  })

  it('consumes diff appearance settings and reduced-motion in the rendered presentation', () => {
    const { container } = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'diff-settings', kind: 'content.diff', revision: 1,
        payload: {
          kind: 'diff', path: '/src/settings.ts',
          lines: [{ kind: 'removed', text: 'old value' }, { kind: 'added', text: 'new value' }],
        },
      }}
      appearance={{
        view: 'split', lineNumbers: false, wordDiff: false, maxHeight: 180,
        wrap: 'soft', addedColor: '#00ff00', removedColor: '#ff0000',
        defaultExpanded: false, reducedMotion: true,
      }}
      commands={{ execute: vi.fn(), canExecute: () => false }}
    />)

    const card = screen.getByRole('region', { name: 'Diff：/src/settings.ts' })
    expect(card).toHaveAttribute('data-view', 'split')
    expect(card).toHaveAttribute('data-line-numbers', 'false')
    expect(card).toHaveAttribute('data-word-diff', 'false')
    expect(card).toHaveAttribute('data-wrap', 'soft')
    expect(card).toHaveAttribute('data-reduced-motion', 'true')
    expect(card).toHaveStyle({ '--diff-added': '#00ff00', '--diff-removed': '#ff0000' })
    expect(screen.getByRole('button', { name: /^\/src\/settings\.ts/ })).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector<HTMLElement>('[data-diff-body]')).toHaveStyle({ maxHeight: '180px' })
  })

  it('applies word-level diff only when the setting enables it', () => {
    const payload = {
      kind: 'diff', path: '/src/words.ts',
      lines: [
        { kind: 'removed', text: 'const renderer = react' },
        { kind: 'added', text: 'const renderer = solid' },
      ],
    }
    const enabled = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'words-on', kind: 'content.diff', revision: 1, payload }}
      appearance={{ wordDiff: true }} commands={{ execute: vi.fn() }} />)
    expect(enabled.container.querySelector('[data-diff-word="removed"]')).toHaveTextContent('react')
    expect(enabled.container.querySelector('[data-diff-word="added"]')).toHaveTextContent('solid')
    enabled.unmount()

    const disabled = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'words-off', kind: 'content.diff', revision: 1, payload }}
      appearance={{ wordDiff: false }} commands={{ execute: vi.fn() }} />)
    expect(disabled.container.querySelector('[data-diff-word]')).toBeNull()
  })

  it('limits unchanged context without hiding changed lines', () => {
    render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'diff-context', kind: 'content.diff', revision: 1,
        payload: {
          kind: 'diff', path: '/src/context.ts', lines: [
            { kind: 'context', text: 'far before' },
            { kind: 'context', text: 'near before' },
            { kind: 'removed', text: 'old value' },
            { kind: 'added', text: 'new value' },
            { kind: 'context', text: 'near after' },
            { kind: 'context', text: 'far after' },
          ],
        },
      }}
      appearance={{ contextLines: 0, wordDiff: false }} commands={{ execute: vi.fn() }} />)

    expect(screen.getByText('old value')).toBeTruthy()
    expect(screen.getByText('new value')).toBeTruthy()
    expect(screen.queryByText('far before')).toBeNull()
    expect(screen.queryByText('near after')).toBeNull()
    expect(screen.getAllByText(/unchanged lines/)).toHaveLength(2)
  })

  it('gates opening the diff target through the semantic command port', async () => {
    const execute = vi.fn()
    const enabled = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'diff-open', kind: 'content.diff', revision: 1,
        payload: { kind: 'diff', path: '/src/open.ts', lines: [{ kind: 'added', text: 'new' }] },
      }}
      appearance={{}}
      commands={{ execute, canExecute: type => type === 'resource.open' }} />)

     fireEvent.click(screen.getByRole('button', { name: '打开 /src/open.ts' }))
    expect(execute).toHaveBeenCalledWith({ type: 'resource.open', payload: { path: '/src/open.ts' } })
    enabled.unmount()

    render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'diff-disabled', kind: 'content.diff', revision: 1,
        payload: { kind: 'diff', path: '/src/disabled.ts', lines: [{ kind: 'added', text: 'new' }] },
      }}
      appearance={{}} commands={{ execute, canExecute: () => false }} />)
    expect(screen.getByRole('button', { name: '打开 /src/disabled.ts' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '打开 /src/disabled.ts' })).toHaveAttribute('title', '宿主未提供打开能力')
  })

  it('shows normalized metadata while keeping raw audit text behind the showRaw setting', () => {
    const payload = {
      kind: 'diff', path: '/src/audit.ts', binary: true, truncated: true,
      unknownFields: ['providerRevision'], rawPatch: 'sanitized raw patch',
    }
    const hidden = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'diff-raw-hidden', kind: 'content.diff', revision: 1, payload }}
      appearance={{ showMetadata: true, showRaw: false }} commands={{ execute: vi.fn() }} />)
    expect(screen.getByText(/binary · truncated/)).toBeTruthy()
    expect(screen.getByText(/providerRevision/)).toBeTruthy()
    expect(screen.queryByText('sanitized raw patch')).toBeNull()
    hidden.unmount()

    render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'diff-raw-visible', kind: 'content.diff', revision: 1, payload }}
      appearance={{ showMetadata: true, showRaw: true }} commands={{ execute: vi.fn() }} />)
    expect(screen.getByText('Raw 审计信息')).toBeTruthy()
    expect(screen.getByText('sanitized raw patch')).toBeTruthy()
  })

  it('renders an accessible LSP diagnostic with related locations and gated open actions', async () => {
    const execute = vi.fn()
    render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'lsp-1', kind: 'diagnostic.lsp', revision: 1,
        payload: {
          kind: 'diagnostic-lsp', severity: 'error', code: 'TS2345', source: 'typescript',
          message: 'Argument is not assignable', path: '/src/app.ts',
          range: { start: { line: 41, character: 12 }, end: { line: 41, character: 30 } },
          related: [{ message: 'target declared here', path: '/src/types.ts', range: { start: { line: 7, character: 0 } } }],
        },
      }}
      appearance={{ severityPalette: 'accent', reducedMotion: true }}
      commands={{ execute, canExecute: type => type === 'resource.open' }} />)

    const card = screen.getByRole('alert', { name: 'LSP error：Argument is not assignable' })
    expect(card).toHaveAttribute('data-severity-palette', 'accent')
    expect(card).toHaveAttribute('data-reduced-motion', 'true')
    expect(card).toHaveTextContent('TS2345 · typescript')
    expect(card).toHaveTextContent('/src/app.ts:42:13–42:31')
    expect(screen.getByRole('list', { name: '关联诊断位置' })).toHaveTextContent('target declared here')
     fireEvent.click(screen.getByRole('button', { name: '打开关联位置 /src/types.ts' }))
    expect(execute).toHaveBeenCalledWith({
      type: 'resource.open', payload: { path: '/src/types.ts', range: { start: { line: 7, character: 0 } } },
    })
  })

  it('keeps malformed diff and LSP payloads visible through explicit fallback text', () => {
    const invalidDiff = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'diff-invalid', kind: 'content.diff', revision: 1,
        payload: { kind: 'diff', path: '/src/invalid.ts', lines: [{ kind: 'vendor', text: 'bad' }] },
      }}
      appearance={{}} commands={{ execute: vi.fn() }} />)
    expect(invalidDiff.container.querySelector('[data-content-kind="content.diff"]')).toHaveTextContent('Invalid content.diff payload')
    invalidDiff.unmount()

    const invalidLsp = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'lsp-invalid', kind: 'diagnostic.lsp', revision: 1, payload: { message: 'missing path' } }}
      appearance={{}} commands={{ execute: vi.fn() }} />)
    expect(invalidLsp.container.querySelector('[data-content-kind="diagnostic.lsp"]')).toHaveTextContent('Invalid diagnostic.lsp payload')
  })

  it('applies LSP visibility, height, and severity palette settings to real presentation', () => {
    const { container } = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'lsp-settings', kind: 'diagnostic.lsp', revision: 1,
        payload: {
          kind: 'diagnostic-lsp', severity: 'warning', code: 'W1', source: 'eslint',
          message: 'unused binding', path: '/src/a.ts',
          related: [{ message: 'declared here', path: '/src/b.ts' }],
        },
      }}
      appearance={{ severityPalette: 'neutral', maxHeight: 140, showCode: false, showSource: false, showRelated: false }}
      commands={{ execute: vi.fn(), canExecute: () => false }} />)

    const card = screen.getByRole('status', { name: 'LSP warning：unused binding' })
    expect(card).toHaveStyle({ maxHeight: '140px', '--lsp-accent': 'var(--text-dim)' })
    expect(card).not.toHaveTextContent('W1')
    expect(card).not.toHaveTextContent('eslint')
    expect(container.querySelector('[aria-label="关联诊断位置"]')).toBeNull()
  })

  it('keeps unified, hunks-only, and binary diff variants readable without parsing rawPatch', () => {
    const unified = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'diff-unified', kind: 'content.diff', revision: 1,
        payload: { kind: 'diff', path: '/src/unified.ts', unified: '@@ -1 +1 @@\n-old\n+new', rawPatch: 'do not parse me' },
      }}
      appearance={{ showRaw: false }} commands={{ execute: vi.fn() }} />)
    expect(unified.container.querySelector('[data-diff-view="unified"]')).toHaveTextContent('@@ -1 +1 @@')
    expect(unified.container.textContent).not.toContain('do not parse me')
    unified.unmount()

    const hunks = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'diff-hunks', kind: 'content.diff', revision: 1,
        payload: { kind: 'diff', path: '/src/hunks.ts', hunks: [{ oldStart: 10, oldLines: 2, newStart: 11, newLines: 3 }] },
      }}
      appearance={{}} commands={{ execute: vi.fn() }} />)
    expect(hunks.container.querySelector('[data-diff-hunks]')).toHaveTextContent('@@ -10,2 +11,3 @@')
    hunks.unmount()

    render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'diff-binary', kind: 'content.diff', revision: 1, payload: { kind: 'diff', path: '/logo.png', binary: true } }}
      appearance={{}} commands={{ execute: vi.fn() }} />)
    expect(screen.getByText('二进制文件发生变更')).toBeTruthy()
  })
})
