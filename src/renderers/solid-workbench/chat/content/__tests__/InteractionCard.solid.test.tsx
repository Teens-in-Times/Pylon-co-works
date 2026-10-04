// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidInteractionCard } from '../InteractionCard.solid.tsx'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'
import type { WorkbenchInteraction } from '../../../../../domains/workbench/workbenchProjector.ts'

/**
 * C11 RED：交互卡契约。
 * - pending 才可提交，resolved/expired 呈现终态；
 * - response 经 command port 携带 interactionId；
 * - 危险按钮 tabindex 后置；capability 缺失时禁用并说明原因。
 */

const permissionPending = {
  id: 'int-1', status: 'requested', sequence: 1,
  request: {
    kind: 'permission', prompt: 'Allow rm -rf?', danger: true, capability: 'fs.write',
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝', danger: true },
    ],
  },
} as unknown as WorkbenchInteraction

afterEach(() => cleanup())

describe('C11 SolidInteractionCard', () => {
  it('renders structured request fields with danger demotion and capability-gated actions', async () => {
    const execute = vi.fn()
    const result = render(() => <SolidInteractionCard
      interaction={permissionPending}
      commands={{ execute, canExecute: type => type === 'interaction.respond' }}
    />)
    expect(result.container.textContent).toContain('Allow rm -rf?')
    expect(result.container.textContent).toContain('fs.write')
    const buttons = [...result.container.querySelectorAll('button')]
    expect(buttons.map(b => b.textContent)).toEqual(['允许', '拒绝'])
    // 危险选项 tabindex 后置
    expect(buttons[0]!.getAttribute('tabindex')).toBe('0')
    expect(buttons[1]!.getAttribute('tabindex')).toBe('2')
    buttons[0]!.click()
    expect(execute).toHaveBeenCalledWith({
      type: 'interaction.respond', targetId: 'int-1', payload: { optionId: 'allow', expectedRevision: 1 },
    })
  })

  it('shows normalized danger reason, scope, command, and path context before action', () => {
    const result = render(() => <SolidInteractionCard
      interaction={{ ...permissionPending, request: {
        ...permissionPending.request as Record<string, unknown>,
        reason: '需要修改构建产物', scope: 'workspace', command: 'rm -rf dist', path: '/workspace/dist',
      } } as unknown as WorkbenchInteraction}
      commands={{ execute: vi.fn(), canExecute: () => true }}
    />)
    expect(result.container.textContent).toContain('需要修改构建产物')
    expect(result.container.textContent).toContain('workspace')
    expect(result.container.textContent).toContain('rm -rf dist')
    expect(result.container.textContent).toContain('/workspace/dist')
  })

  it('orders confirmation options according to the resolved confirmOrder setting', () => {
    const interaction = { ...permissionPending, request: {
      ...permissionPending.request as Record<string, unknown>,
      options: [{ id: 'deny', label: '拒绝', danger: true }, { id: 'allow', label: '允许' }],
    } } as unknown as WorkbenchInteraction
    const safeFirst = render(() => <SolidInteractionCard interaction={interaction}
      appearance={{ confirmOrder: 'safe-first' }} commands={{ execute: vi.fn(), canExecute: () => true }} />)
    expect([...safeFirst.container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['允许', '拒绝'])

    const source = render(() => <SolidInteractionCard interaction={interaction}
      appearance={{ confirmOrder: 'source' }} commands={{ execute: vi.fn(), canExecute: () => true }} />)
    expect([...source.container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['拒绝', '允许'])
  })

  it('traps keyboard focus inside modal presentation without focusing the dangerous action first', () => {
    const result = render(() => <SolidInteractionCard interaction={permissionPending}
      appearance={{ presentation: 'modal', confirmOrder: 'safe-first' }}
      commands={{ execute: vi.fn(), canExecute: () => true }} />)
    const dialog = result.getByRole('dialog')
    const buttons = [...dialog.querySelectorAll('button')]
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    buttons.at(-1)!.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(buttons[0])
    expect(buttons[0]).toHaveTextContent('允许')
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(buttons.at(-1))
  })

  it('disables actions when the command capability is absent, explaining why', () => {
    const result = render(() => <SolidInteractionCard interaction={permissionPending} />)
    for (const button of result.container.querySelectorAll('button')) {
      expect(button.disabled).toBe(true)
      expect(button.title).toContain('能力未接入')
    }
  })

  it('shows terminal states read-only without submit affordances', () => {
    const resolved = { ...permissionPending, status: 'resolved', response: { optionId: 'deny' } } as unknown as WorkbenchInteraction
    const resolvedView = render(() => <SolidInteractionCard interaction={resolved} commands={{ execute: vi.fn(), canExecute: () => true }} />)
    expect(resolvedView.container.textContent).toContain('已响应')
    expect(resolvedView.container.querySelector('.interaction-response .tool-object-inspector')).toHaveTextContent('optionId')
    expect(resolvedView.container.querySelector('.interaction-response .tool-object-inspector')).toHaveTextContent('deny')
    expect(resolvedView.container.querySelectorAll('.interaction-options button')).toHaveLength(0)

    const expired = { ...permissionPending, status: 'expired', reason: 'ttl elapsed' } as unknown as WorkbenchInteraction
    const expiredView = render(() => <SolidInteractionCard interaction={expired} />)
    expect(expiredView.container.textContent).toContain('已过期')
    expect(expiredView.container.textContent).toContain('ttl elapsed')
  })

  it('consumes resolved and expired status colors on terminal interaction cards', () => {
    const resolved = render(() => <SolidInteractionCard
      interaction={{ ...permissionPending, status: 'resolved' } as unknown as WorkbenchInteraction}
      appearance={{ pendingColor: '#111', resolvedColor: '#222', expiredColor: '#333' }} />)
    expect(resolved.container.querySelector('.interaction-card')?.getAttribute('style')).toContain('--interaction-status-color: #222')

    const expired = render(() => <SolidInteractionCard
      interaction={{ ...permissionPending, status: 'expired' } as unknown as WorkbenchInteraction}
      appearance={{ pendingColor: '#111', resolvedColor: '#222', expiredColor: '#333' }} />)
    expect(expired.container.querySelector('.interaction-card')?.getAttribute('style')).toContain('--interaction-status-color: #333')
  })

  it('renders secret prompts as password inputs that clear after submit (C12)', async () => {
    const execute = vi.fn()
    const secret = {
      id: 'sec-1', status: 'requested', sequence: 3,
      request: { kind: 'secret', prompt: 'API token' },
    } as unknown as WorkbenchInteraction
    const result = render(() => <SolidInteractionCard
      interaction={secret} commands={{ execute, canExecute: () => true }} />)
    const input = result.container.querySelector('input') as HTMLInputElement
    expect(input.type).toBe('password')
    input.value = 'sk-secret'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
    expect(execute).toHaveBeenCalledWith({
      type: 'interaction.respond', targetId: 'sec-1', payload: { value: 'sk-secret', expectedRevision: 3 },
    })
    // 提交后本地输入立即清空
    expect(input.value).toBe('')
  })

  it('shows sudo command context and oauth url with capability-gated open (C12)', () => {
    const execute = vi.fn()
    const sudo = {
      id: 'sudo-1', status: 'requested', sequence: 4,
      request: { kind: 'sudo', command: 'apt install build-essential', reason: 'build deps' },
    } as unknown as WorkbenchInteraction
    const sudoView = render(() => <SolidInteractionCard interaction={sudo}
      commands={{ execute, canExecute: t => t === 'interaction.respond' }} />)
    expect(sudoView.container.textContent).toContain('apt install build-essential')
    expect(sudoView.container.textContent).toContain('原因：build deps')

    const oauth = {
      id: 'oauth-1', status: 'requested', sequence: 5,
      request: { kind: 'oauth', url: 'https://github.com/login/oauth/authorize?state=x' },
    } as unknown as WorkbenchInteraction
    const oauthView = render(() => <SolidInteractionCard interaction={oauth}
      // 打开授权页同时需要 interaction.respond（响应交互）与 resource.open（外链）两个能力位
      commands={{ execute, canExecute: t => t === 'resource.open' || t === 'interaction.respond' }} />)
    const openBtn = [...oauthView.container.querySelectorAll('button')].find(b => b.textContent === '打开授权页')!
    openBtn.click()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource.open' }))
    // 无 resource.open capability 时按钮不渲染
    const denied = render(() => <SolidInteractionCard interaction={oauth}
      commands={{ execute, canExecute: () => false }} />)
    expect([...denied.container.querySelectorAll('button')].map(b => b.textContent)).not.toContain('打开授权页')
  })

  it('shows sudo scope/timeout and OAuth redacted URL state without exposing unsafe URL', () => {
    const sudoView = render(() => <SolidInteractionCard interaction={{
      id: 'sudo-2', status: 'requested', sequence: 6,
      request: { kind: 'sudo', command: 'make install', reason: 'system change', scope: 'workspace', timeoutMs: 30_000 },
    } as unknown as WorkbenchInteraction} />)
    expect(sudoView.container.textContent).toContain('范围：workspace')
    expect(sudoView.container.textContent).toContain('超时：30s')

    const oauthView = render(() => <SolidInteractionCard interaction={{
      id: 'oauth-unsafe', status: 'requested', sequence: 7,
      request: { kind: 'oauth', provider: 'peri', urlRedacted: true, stateSummary: '授权链接已拒绝', status: 'failed' },
    } as unknown as WorkbenchInteraction} />)
    expect(oauthView.container.textContent).toContain('授权链接已拒绝')
    expect(oauthView.container.textContent).toContain('链接已隐藏')
    expect(oauthView.container.textContent).not.toContain('javascript:')
  })

  it('copies OAuth URL only through the Host semantic command port', () => {
    const execute = vi.fn()
    const view = render(() => <SolidInteractionCard interaction={{
      id: 'oauth-copy', status: 'requested', sequence: 8,
      request: { kind: 'oauth', url: 'https://example.com/oauth' },
    } as unknown as WorkbenchInteraction} commands={{
      execute, canExecute: type => type === 'interaction.respond' || type === 'clipboard.write',
    }} />)
    const button = [...view.container.querySelectorAll('button')].find(item => item.textContent === '复制授权链接')!
    button.click()
    expect(execute).toHaveBeenCalledWith({
      type: 'clipboard.write', targetId: 'oauth-copy', payload: { text: 'https://example.com/oauth' },
    })
  })

  it('consumes C12 warning/provider/countdown presentation settings', () => {
    const interaction = {
      id: 'sudo-settings', status: 'requested', sequence: 9,
      request: { kind: 'sudo', command: 'make install', timeoutMs: 30_000,
        identity: { provider: 'peri' } },
    } as unknown as WorkbenchInteraction
    const defaultView = render(() => <SolidInteractionCard interaction={interaction} />)
    expect(defaultView.container.textContent).toContain('Provider：peri')

    const view = render(() => <SolidInteractionCard interaction={interaction} appearance={{
      warningColor: '#ffaa00', showProviderMetadata: false, countdownStyle: 'hidden',
    }} />)
    const card = view.container.querySelector('.interaction-card')!
    expect(card.getAttribute('style')).toContain('--interaction-warning-color: #ffaa00')
    expect(card.getAttribute('data-countdown-style')).toBe('hidden')
    expect(view.container.textContent).not.toContain('Provider：peri')
    expect(view.container.textContent).not.toContain('超时：')
  })

  it('distinguishes observed sudo cancellation and timeout terminal facts', () => {
    const cancelled = render(() => <SolidInteractionCard interaction={{
      id: 'sudo-cancelled', status: 'resolved', sequence: 10,
      request: { kind: 'sudo', command: 'make install' }, response: { cancelled: true },
    } as unknown as WorkbenchInteraction} />)
    expect(cancelled.container.textContent).toContain('已取消')

    const timedOut = render(() => <SolidInteractionCard interaction={{
      id: 'sudo-timeout', status: 'expired', sequence: 11,
      request: { kind: 'sudo', command: 'make install', timeoutMs: 30_000 }, reason: 'timeout',
    } as unknown as WorkbenchInteraction} />)
    expect(timedOut.container.textContent).toContain('已超时')
  })

  it('falls back to a free-text answer when the request carries no options', async () => {
    const execute = vi.fn()
    const question = {
      id: 'int-2', status: 'requested', sequence: 2,
      request: { kind: 'questions', prompt: '项目代号是什么？' },
    } as unknown as WorkbenchInteraction
    const result = render(() => <SolidInteractionCard
      interaction={question}
      commands={{ execute, canExecute: () => true }}
    />)
    const input = result.container.querySelector('input') as HTMLInputElement
    input.value = 'Pylon'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
    expect(execute).toHaveBeenCalledWith({
      type: 'interaction.respond', targetId: 'int-2', payload: { text: 'Pylon', expectedRevision: 2 },
    })
  })

  it('submits normalized multi-question answers as one batch response', async () => {
    const execute = vi.fn()
    const result = render(() => <SolidInteractionCard
      interaction={{
        id: 'batch-1', status: 'requested', sequence: 8,
        request: {
          surface: 'interaction', kind: 'questions', state: 'waiting',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'req', sessionId: 'session', clientGeneration: 1 },
          questions: [
            { id: 'mode', question: '运行模式？', allowMultiple: false, allowFreeform: false,
              options: [{ id: 'safe', label: '安全' }, { id: 'fast', label: '快速' }] },
            { id: 'scope', question: '影响范围？', allowMultiple: true, allowFreeform: true,
              options: [{ id: 'repo', label: '仓库' }, { id: 'docs', label: '文档' }], placeholder: '补充范围' },
          ],
        },
      } as unknown as WorkbenchInteraction}
      commands={{ execute, canExecute: () => true }}
    />)

    expect(result.container.textContent).toContain('运行模式？')
    expect(result.container.textContent).toContain('影响范围？')
    ;(result.container.querySelector('input[value="safe"]') as HTMLInputElement).click()
    ;(result.container.querySelector('input[value="repo"]') as HTMLInputElement).click()
    ;(result.container.querySelector('input[value="docs"]') as HTMLInputElement).click()
    const freeform = result.container.querySelector('input[placeholder="补充范围"]') as HTMLInputElement
    fireEvent.input(freeform, { target: { value: '配置文件' } })
    const submit = [...result.container.querySelectorAll('button')].find(button => button.textContent === '提交回答')!
    submit.click()

    expect(execute).toHaveBeenCalledWith({
      type: 'interaction.respond', targetId: 'batch-1',
      payload: {
        values: { mode: 'safe', scope: ['repo', 'docs', '配置文件'] },
        expectedRevision: 8,
      },
    })
  })

  it('renders a single normalized multi-select question as a checklist with freeform', async () => {
    const execute = vi.fn()
    const result = render(() => <SolidInteractionCard
      interaction={{
        id: 'multi-1', status: 'requested', sequence: 9,
        request: {
          surface: 'interaction', kind: 'questions', state: 'waiting',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'req-multi', sessionId: 'session', clientGeneration: 1 },
          questions: [{ id: 'scope', question: '影响范围？', allowMultiple: true, allowFreeform: true,
            options: [{ id: 'repo', label: '仓库' }, { id: 'docs', label: '文档' }] }],
        },
      } as unknown as WorkbenchInteraction}
      commands={{ execute, canExecute: () => true }}
    />)
    expect(result.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    expect(result.container.querySelector('button[type="submit"]')).not.toBeNull()
  })

  it('ignores a second submit while the first interaction response is pending', async () => {
    let resolve: (() => void) | undefined
    const execute = vi.fn(() => new Promise<void>(done => { resolve = done }))
    const result = render(() => <SolidInteractionCard
      interaction={permissionPending}
      commands={{ execute, canExecute: () => true }}
    />)
    const allow = [...result.container.querySelectorAll('button')].find(button => button.textContent === '允许')!

    allow.click()
    allow.click()

    expect(execute).toHaveBeenCalledTimes(1)
    resolve?.()
    await Promise.resolve()
  })

  it('consumes resolved C11 appearance settings in the production base Slot', () => {
    const interaction = {
      id: 'settings-1', status: 'requested', sequence: 4,
      request: {
        surface: 'interaction', kind: 'approval', state: 'waiting',
        identity: { provider: 'peri', agentId: 'agent-a', requestId: 'request-a', sessionId: 'session-a', toolCallId: null, clientGeneration: 2 },
        questions: [{ id: 'approval', question: '允许修改？', allowMultiple: false, allowFreeform: false,
          options: [{ id: 'allow', label: '允许', description: '只允许本次修改' }, { id: 'deny', label: '拒绝' }] }],
      },
    } as unknown as WorkbenchInteraction
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'settings-1', kind: 'interaction.approval', revision: 4, payload: interaction }}
      appearance={{
        presentation: 'modal', maxWidth: 560, optionDensity: 'compact', confirmOrder: 'safe-first',
        dangerColor: '#aa1122', pendingColor: '#2277aa', descriptionsExpanded: false, showTechnicalMetadata: true,
      }}
      commands={{ execute: vi.fn(), canExecute: () => true }}
    />)

    const card = result.getByRole('dialog', { name: /交互：允许修改？/ })
    expect(card).toHaveAttribute('data-presentation', 'modal')
    expect(card).toHaveAttribute('data-option-density', 'compact')
    expect(card).toHaveStyle({ maxWidth: '560px' })
    expect(card.style.getPropertyValue('--interaction-danger-color')).toBe('#aa1122')
    expect(card.style.getPropertyValue('--interaction-status-color')).toBe('#2277aa')
    expect(card).toHaveTextContent('request-a')
    expect(result.container.querySelector('details.interaction-option-description')).not.toHaveAttribute('open')
  })

  it('fails closed to a visible unknown fallback for malformed request identity', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'malformed-interaction', kind: 'interaction.permission', revision: 1, payload: {
        id: 'malformed-interaction', status: 'requested', sequence: 1,
        request: { surface: 'interaction', kind: 'permission', state: 'waiting', identity: { provider: 'peri' },
          questions: [{ id: 'approval', question: '不可提交的请求', options: [], allowMultiple: false, allowFreeform: true }] },
      } }} appearance={{}} commands={{ execute: vi.fn(), canExecute: () => true }} />)

    expect(result.container.querySelector('.solid-content-unknown')).toHaveTextContent('Invalid interaction snapshot')
    expect(result.container.querySelector('.interaction-card')).toBeNull()

    const malformedOption = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'malformed-option', kind: 'interaction.questions', revision: 1, payload: {
        id: 'malformed-option', status: 'requested', sequence: 1,
        request: { surface: 'interaction', kind: 'questions', state: 'waiting',
          identity: { provider: null, agentId: null, requestId: null, sessionId: null, toolCallId: null, clientGeneration: null },
          questions: [{ id: 'q', question: '坏选项', options: [{ id: 1, label: '坏' }], allowMultiple: false, allowFreeform: false }] },
      } }} appearance={{}} commands={{ execute: vi.fn(), canExecute: () => true }} />)
    expect(malformedOption.container.querySelector('.solid-content-unknown')).toHaveTextContent('Invalid interaction snapshot')
  })
})
