// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'

afterEach(() => cleanup())

describe('C13 lifecycle/system Solid base Slot', () => {
  it('renders structured retry details and gates retry through the semantic command port', async () => {
    const execute = vi.fn()
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'retry-1', kind: 'lifecycle.retry', revision: 1,
        payload: {
          retry: {
            attempt: 2, maxAttempts: 3, delayMs: 4000,
            error: {
              userSummary: 'Provider 过载', technicalMessage: '429 overloaded', code: 'provider_overloaded',
              provider: 'peri', eventId: 'event-retry', recoverability: 'retry',
              cause: { userSummary: '上游限流', technicalMessage: 'quota exhausted', recoverability: 'none' },
            },
          },
          history: [],
        },
      }}
      appearance={{
        foreground: '#112233', mutedForeground: '#445566', background: '#f1f2f3', borderColor: '#778899', density: 'compact',
        technicalDetailsExpanded: true, retryCountdownStyle: 'compact', showProviderIds: true,
        showEventIds: true, motion: 'subtle', reducedMotion: true,
      }}
      commands={{ canExecute: type => type === 'message.retry', execute }}
    />)

    const card = result.getByRole('status', { name: /生命周期：第 2\/3 次重试/ })
    expect(card).toHaveAttribute('data-density', 'compact')
    expect(card).toHaveAttribute('data-motion', 'none')
    expect(card).toHaveStyle({ color: 'rgb(17, 34, 51)', background: 'rgb(241, 242, 243)', borderColor: 'rgb(119, 136, 153)' })
    expect(card.style.getPropertyValue('--lifecycle-muted-foreground')).toBe('#445566')
    expect(card).toHaveTextContent('4s')
    expect(card).toHaveTextContent('peri')
    expect(card).toHaveTextContent('event-retry')
    expect(card).toHaveTextContent('上游限流')
    expect(result.container.querySelector('details.lifecycle-technical')).toHaveAttribute('open')

    fireEvent.click(result.getByRole('button', { name: '重试' }))
    expect(execute).toHaveBeenCalledWith({ type: 'message.retry' })
  })

  it('renders system errors and derives recovery actions only from recoverability plus capability', async () => {
    const execute = vi.fn()
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'error-1', kind: 'system.error', revision: 1,
        payload: {
          userSummary: '插件渲染失败', technicalMessage: 'mount threw', code: 'renderer.mount.failed',
          pluginId: 'plugin.example', rendererSlotId: 'slot-a', phase: 'mount', recoverability: 'reload-plugin',
          cause: { userSummary: '组件异常', technicalMessage: 'boom', recoverability: 'none' },
        },
      }}
      appearance={{ technicalDetailsExpanded: false, showProviderIds: true, errorColor: '#aa1122' }}
      commands={{ canExecute: type => type === 'session.recover', execute }}
    />)

    const card = result.getByRole('alert', { name: '系统错误：插件渲染失败' })
    expect(card).toHaveAttribute('data-recoverability', 'reload-plugin')
    expect(card.style.getPropertyValue('--lifecycle-severity-color')).toBe('#aa1122')
    expect(card).toHaveTextContent('plugin.example')
    expect(card).toHaveTextContent('slot-a')
    expect(card).toHaveTextContent('组件异常')
    expect(result.container.querySelector('details.lifecycle-technical')).not.toHaveAttribute('open')

    fireEvent.click(result.getByRole('button', { name: '重新加载插件' }))
    expect(execute).toHaveBeenCalledWith({ type: 'session.recover', payload: { strategy: 'reload-plugin' } })

    const denied = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'error-denied', kind: 'system.error', revision: 1,
        payload: { userSummary: '请重试这段文本但不可执行', recoverability: 'retry' },
      }}
      appearance={{}}
      commands={{ canExecute: () => false, execute }}
    />)
    expect(denied.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders projection notices with severity, placement and optional audit identifiers', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'notice-1', kind: 'system.notice', revision: 1,
        payload: {
          code: 'compact.complete', message: '上下文压缩完成', eventId: 'event-notice', sequence: 4,
          level: 'warning', data: { tokensBefore: 1000, tokensAfter: 300 },
        },
      }}
      appearance={{
        warningColor: '#bb7722', noticePlacements: ['timeline'], showEventIds: true,
        technicalDetailsExpanded: true, density: 'compact',
      }}
      commands={{ execute: () => {} }}
    />)

    const notice = result.getByRole('status', { name: '系统通知：上下文压缩完成' })
    expect(notice).toHaveAttribute('data-severity', 'warning')
    expect(notice).toHaveAttribute('data-placements', 'timeline')
    expect(notice.style.getPropertyValue('--lifecycle-severity-color')).toBe('#bb7722')
    expect(notice).toHaveTextContent('compact.complete')
    expect(notice).toHaveTextContent('event-notice')
    expect(notice).toHaveTextContent('1000')
    expect(result.container.querySelector('details.system-notice-data')).toHaveAttribute('open')

    const malformed = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'notice-raw', kind: 'system.notice', revision: 1, payload: { providerEvent: 'raw' } }}
      appearance={{}}
      commands={{ execute: () => {} }}
    />)
    expect(malformed.container.querySelector('[data-content-kind="system.notice"].solid-content-unknown')?.textContent)
      .toContain('Invalid system.notice payload')
  })
})
