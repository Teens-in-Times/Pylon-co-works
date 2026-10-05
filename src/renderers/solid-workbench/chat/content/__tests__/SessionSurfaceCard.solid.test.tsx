// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidSessionSurfaceCard } from '../SessionSurfaceCard.solid.tsx'

afterEach(cleanup)

describe('C14 Solid session surface', () => {
  it('renders structured usage and budget without fabricating missing values', () => {
    const { container } = render(() => <SolidSessionSurfaceCard kind="session.usage" payload={{
      inputTokens: 1_200, outputTokens: 30, cacheReadTokens: 12,
      contextUsed: 150, contextLimit: 1000, costUsd: 0.02, currency: 'USD',
    }} appearance={{ units: 'compact', visibleMetrics: ['input', 'cacheRead', 'context', 'cost'], showContext: true, showCost: true }} commands={{ execute() {} }} />)
    expect(screen.getByLabelText('会话用量')).toHaveTextContent('输入 1.2K')
    expect(screen.getByLabelText('会话用量')).not.toHaveTextContent('输出 30')
    expect(screen.getByLabelText('会话用量')).toHaveTextContent('缓存读取 12')
    expect(screen.getByLabelText('会话用量')).toHaveTextContent('上下文 150 / 1K')
    expect(screen.getByLabelText('会话用量')).toHaveTextContent('0.02 USD')
    expect(container.textContent).not.toContain('推理 0')

    container.replaceChildren()
    render(() => <SolidSessionSurfaceCard kind="session.budget" payload={{ used: 8, limit: 10, remaining: 2, percent: 80, exhausted: false }}
      appearance={{ warningThreshold: 80, warningPalette: 'semantic' }} commands={{ execute() {} }} />)
    expect(screen.getByRole('status', { name: '会话预算' })).toHaveAttribute('data-warning', 'true')
    expect(screen.getByRole('status', { name: '会话预算' })).toHaveAttribute('data-exhausted', 'false')
    expect(screen.getByRole('status', { name: '会话预算' })).toHaveTextContent('剩余 2')
  })

  it('renders config/commands and consumes layout/density settings', () => {
    const { container } = render(() => <>
      <SolidSessionSurfaceCard kind="session.config" payload={{ options: [
        { id: 'model', label: 'Model', value: 'gpt-5', valueType: 'select', editable: true, version: 3,
          schema: { options: [{ value: 'gpt-5', label: 'GPT-5' }, { value: 'gpt-4', label: 'GPT-4' }] } },
      ] }} appearance={{ layout: 'inline', showUnknown: true }} commands={{ execute() {} }} />
      <SolidSessionSurfaceCard kind="session.commands" payload={{ commands: [
        { id: 'review', name: '/review', description: '审查改动', availability: true },
      ] }} appearance={{ density: 'compact' }} commands={{ execute() {} }} />
    </>)
    expect(screen.getByLabelText('会话配置')).toHaveAttribute('data-layout', 'inline')
    expect(screen.getByLabelText('会话配置')).toHaveTextContent('Model')
    expect(screen.getByRole('combobox', { name: '编辑 Model' })).toHaveValue('gpt-5')
    expect(screen.getByLabelText('会话命令')).toHaveAttribute('data-density', 'compact')
    expect(container.textContent).toContain('/review')
  })

  it('submits editable config through the semantic port with expected value/version', () => {
    const execute = vi.fn()
    render(() => <SolidSessionSurfaceCard kind="session.config" payload={{ options: [
      { id: 'thinking', label: 'Thinking', value: true, valueType: 'boolean', editable: true, version: 3 },
      { id: 'locked', label: 'Locked', value: 'fixed', editable: false },
    ] }} appearance={{ layout: 'list' }} commands={{ execute, canExecute: type => type === 'session.config.update' }} />)
    const input = screen.getByRole('combobox', { name: '编辑 Thinking' })
    fireEvent.change(input, { target: { value: 'false' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Thinking' }))
    expect(execute).toHaveBeenCalledWith({
      type: 'session.config.update', targetId: 'thinking',
      payload: { value: false, expectedValue: true, expectedVersion: 3 },
    })
    expect(screen.getByRole('button', { name: '保存 Locked' })).toBeDisabled()
  })

  it('does not offer writes for config values the ACP command cannot represent', () => {
    render(() => <SolidSessionSurfaceCard kind="session.config" payload={{ options: [
      { id: 'vendor', label: 'Vendor shape', value: { mode: 'adaptive' }, valueType: 'provider.custom', editable: true },
    ] }} appearance={{ layout: 'list' }} commands={{ execute() {}, canExecute: () => true }} />)

    expect(screen.getByLabelText('编辑 Vendor shape')).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存 Vendor shape' })).toBeDisabled()
    expect(screen.getByText('协议不支持编辑')).toBeInTheDocument()
  })

  it('renders ephemeral assist and emits normalized accept/reject actions', () => {
    const execute = vi.fn()
    render(() => <SolidSessionSurfaceCard kind="assist.prediction" payload={{
      prediction: { placeholder: '继续完成审计', actions: [{ id: 'vendor-action', secret: 'opaque' }] },
      files: ['src/a.ts'], queuedCommand: '/compact',
    }} appearance={{ opacity: 0.65, showFiles: true }} commands={{ execute, canExecute: type => type.startsWith('assist.') }} />)
    const card = screen.getByRole('status', { name: '输入预测' })
    expect(card).toHaveStyle({ opacity: '0.65' })
    expect(card).toHaveTextContent('继续完成审计')
    fireEvent.click(screen.getByRole('button', { name: '接受输入建议' }))
    fireEvent.click(screen.getByRole('button', { name: '忽略输入建议' }))
    expect(execute).toHaveBeenNthCalledWith(1, { type: 'assist.accept', payload: { text: '继续完成审计' } })
    expect(execute).toHaveBeenNthCalledWith(2, { type: 'assist.reject' })
    expect(JSON.stringify(execute.mock.calls)).not.toContain('opaque')
  })

  it('limits file suggestions through the declared assist setting', () => {
    render(() => <SolidSessionSurfaceCard kind="assist.file-suggestions" payload={{
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    }} appearance={{ showFiles: true, fileSuggestionMaxCount: 2 }} commands={{ execute() {} }} />)

    const list = screen.getByRole('list', { name: '建议文件列表' })
    expect(list).toHaveTextContent('src/a.ts')
    expect(list).toHaveTextContent('src/b.ts')
    expect(list).not.toHaveTextContent('src/c.ts')
  })

  it('#394：排队命令没有预测按钮，也不触发空文本接受行为', () => {
    const execute = vi.fn()
    render(() => <SolidSessionSurfaceCard kind="assist.prediction" payload={{ files: [], queuedCommand: '/compact' }}
      appearance={{ acceptKey: 'enter' }} commands={{ execute, canExecute: () => true }} />)
    const card = screen.getByRole('status', { name: '排队命令' })
    expect(card).toHaveTextContent('/compact')
    expect(card).not.toHaveAttribute('tabindex')
    expect(card.querySelector('button')).toBeNull()
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: 'Tab' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('accepts a prediction from the declared keyboard shortcut', () => {
    const execute = vi.fn()
    render(() => <SolidSessionSurfaceCard kind="assist.prediction" payload={{
      prediction: { placeholder: '继续审计', actions: [] }, files: [],
    }} appearance={{ acceptKey: 'enter' }} commands={{ execute, canExecute: type => type === 'assist.accept' }} />)

    const card = screen.getByRole('status', { name: '输入预测' })
    card.focus()
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(execute).toHaveBeenCalledWith({ type: 'assist.accept', payload: { text: '继续审计' } })
  })

  it('uses the structured inspector for provider-specific usage and config fields', () => {
    const { container } = render(() => <>
      <SolidSessionSurfaceCard kind="session.usage" payload={{
        inputTokens: 4, raw: { providerTier: 'priority', cache: { hits: 3 } },
      }} appearance={{ showRaw: true }} commands={{ execute() {} }} />
      <SolidSessionSurfaceCard kind="session.config" payload={{ options: [{
        id: 'vendor', label: 'Vendor', value: 'stable', editable: false, raw: { source: 'provider', revision: 2 },
      }] }} appearance={{ showUnknown: true }} commands={{ execute() {} }} />
    </>)

    expect(container.querySelector('.solid-session-usage > details > .tool-object-inspector')).not.toBeNull()
    expect(container.querySelector('.solid-session-config-option > details > .tool-object-inspector')).not.toBeNull()
    expect(container).toHaveTextContent('priority')
    expect(container).toHaveTextContent('revision')
    expect(container.querySelector('.solid-session-usage details pre')).toBeNull()
    expect(container.querySelector('.solid-session-config-option details pre')).toBeNull()
  })
})
