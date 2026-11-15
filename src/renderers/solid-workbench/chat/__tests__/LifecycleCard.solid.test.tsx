// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { SolidLifecycleCard, SolidSystemErrorCard, SolidSystemNoticeCard } from '../LifecycleCard.solid.tsx'
import type { LifecycleState } from '../../../../domains/workbench/lifecycle/lifecycleModel.ts'
import { explainErrorCode } from '../../../../app/errorCodeExplanations.ts'

afterEach(() => cleanup())

const RETRYING: LifecycleState = {
  history: [],
  retry: {
    attempt: 2,
    maxAttempts: 3,
    delayMs: 4000,
    error: {
      userSummary: 'Provider 过载',
      technicalMessage: '429 overloaded',
      code: 'provider_overloaded',
      recoverability: 'retry',
    },
  },
}

describe('SolidLifecycleCard (C13)', () => {
  it('renders retry attempt with countdown semantics and technical detail collapsed', () => {
    const result = render(() => <SolidLifecycleCard state={RETRYING} reducedMotion={true} />)
    const root = result.container.querySelector('.lifecycle-card')!
    expect(root.getAttribute('data-phase')).toBe('retry')
    expect(root.getAttribute('data-reduced-motion')).toBe('true')
    // alert 语义：retry 是活动状态，需要被辅助技术感知
    expect(root.getAttribute('role')).toBe('status')
    expect(result.container.textContent).toContain('第 2/3 次重试')
    expect(result.container.textContent).toContain('Provider 过载')
    // 技术详情默认折叠
    const details = result.container.querySelector('details.lifecycle-technical')!
    expect(details.hasAttribute('open')).toBe(false)
    expect(details.textContent).toContain('429 overloaded')
  })

  it('renders recovered summary and hides when idle', () => {
    const empty = render(() => <SolidLifecycleCard state={{ history: [] }} />)
    expect(empty.container.querySelector('.lifecycle-card')).toBeNull()
    empty.unmount()

    const recovered = render(() => <SolidLifecycleCard state={{
      history: [
        { kind: 'compact', phase: 'completed', summary: '保留最近 40 条', tokensBefore: 180000, tokensAfter: 42000 },
        { kind: 'recovered', source: 'agent-import', importedEvents: 42 },
      ],
      lastRecovery: { source: 'agent-import', importedEvents: 42 },
    }} />)
    expect(recovered.container.querySelector('.lifecycle-card')?.getAttribute('data-phase')).toBe('recovered')
    expect(recovered.container.textContent).toContain('保留最近 40 条')
    expect(recovered.container.textContent).toContain('42')
  })

  it('renders suspended reason without crashing on unknown shapes', () => {
    const result = render(() => <SolidLifecycleCard state={{
      history: [{ kind: 'suspended' }],
      suspended: { reason: '等待用户输入' },
    }} />)
    expect(result.container.querySelector('.lifecycle-card')?.getAttribute('data-phase')).toBe('suspended')
    expect(result.container.textContent).toContain('等待用户输入')
  })

  it('keeps completed compact and rewind results visible as terminal lifecycle states', () => {
    const compact = render(() => <SolidLifecycleCard state={{
      history: [],
      compact: {
        phase: 'completed',
        tokensBefore: 180000,
        tokensAfter: 42000,
        summary: '保留最近 40 条',
      },
    }} />)
    expect(compact.getByRole('status', { name: '生命周期：上下文压缩完成' })).toHaveAttribute('data-phase', 'compact')
    expect(compact.container).toHaveTextContent('180000→42000 tokens')
    expect(compact.container).toHaveTextContent('保留最近 40 条')
    compact.unmount()

    const rewind = render(() => <SolidLifecycleCard state={{
      history: [],
      rewind: {
        phase: 'completed',
        files: [{ path: 'src/app.tsx' }],
        messages: [{ id: 'message-1' }],
        summary: '恢复到检查点',
      },
    }} />)
    expect(rewind.getByRole('status', { name: '生命周期：回退完成' })).toHaveAttribute('data-phase', 'rewind')
    expect(rewind.container).toHaveTextContent('已还原 1 个文件、1 条消息')
    expect(rewind.container).toHaveTextContent('恢复到检查点')
  })

  it('renders notice and error metadata as structured fields instead of JSON blobs', () => {
    const notice = render(() => <SolidSystemNoticeCard notice={{
      code: 'provider.event', message: 'Provider 状态更新', eventId: 'event-1', sequence: 1, level: 'info',
      data: { phase: 'warming', retry: 2 },
    }} appearance={{ technicalDetailsExpanded: true }} />)
    expect(notice.container.querySelector('.system-notice-data .tool-object-inspector')).toHaveTextContent('warming')
    expect(notice.container.querySelector('.system-notice-data pre')).toBeNull()
    notice.unmount()

    const error = render(() => <SolidSystemErrorCard error={{
      userSummary: '渲染失败', recoverability: 'none', metadata: { renderer: 'solid', attempts: 3 },
    }} />)
    expect(error.container.querySelector('.lifecycle-metadata .tool-object-inspector')).toHaveTextContent('solid')
    expect(error.container.querySelector('.lifecycle-metadata pre')).toBeNull()
  })

  // #325：技术详情区的裸码旁边要有人话解释；未知码保留原文、不渲染空元素。
  it('技术详情给已知码配人话解释，未知码不渲染解释元素', () => {
    const known = render(() => <SolidSystemErrorCard error={{
      userSummary: 'Agent 起不来', code: 'agent_executable_missing', recoverability: 'none',
      technicalMessage: 'spawn failed',
    }} appearance={{ technicalDetailsExpanded: true }} />)
    const meaning = known.container.querySelector('.lifecycle-code-meaning')
    expect(meaning).not.toBeNull()
    expect(meaning!.textContent).toContain(explainErrorCode('agent_executable_missing')!.summary)
    // 含 hint 的码把「可以这样处理」一并带上
    expect(meaning!.textContent).toContain(explainErrorCode('agent_executable_missing')!.hint!)
    known.unmount()

    const unknown = render(() => <SolidSystemErrorCard error={{
      userSummary: '未知失败', code: 'brand_new_failure', recoverability: 'none',
    }} appearance={{ technicalDetailsExpanded: true }} />)
    expect(unknown.container.querySelector('.lifecycle-code-meaning')).toBeNull()
  })

  it('does not repeat notice title fields inside technical details', () => {
    const notice = render(() => <SolidSystemNoticeCard notice={{
      code: 'demo.warning', message: 'canonical warning', eventId: 'event-2', sequence: 2, level: 'warning',
      data: { type: 'diagnostic.notice', code: 'demo.warning', message: 'canonical warning', level: 'warning' },
    }} />)

    expect(notice.getAllByText('canonical warning')).toHaveLength(1)
    expect(notice.container.querySelector('.system-notice-data')).toBeNull()
  })

  it('只隐藏 system error 的展示，不改变传入事实，并提供错误中心入口', () => {
    const opened = vi.fn()
    const error = render(() => <SolidSystemErrorCard
      error={{ userSummary: 'canonical failure', recoverability: 'none' }}
      onOpenDiagnostics={opened}
      dismissible
    />)
    expect(error.container.querySelector('.system-error-card')).toBeTruthy()
    error.getByRole('button', { name: '在错误中心查看' }).click()
    expect(opened).toHaveBeenCalledOnce()
    error.getByRole('button', { name: '隐藏错误' }).click()
    expect(error.container.querySelector('.system-error-card')).toBeNull()
  })

  it('错误事实更换后重新显示此前隐藏的卡片', () => {
    const [currentError, setCurrentError] = createSignal({ userSummary: 'first failure', recoverability: 'none' as const })
    const error = render(() => <SolidSystemErrorCard error={currentError()} dismissible />)
    error.getByRole('button', { name: '隐藏错误' }).click()
    expect(error.container.querySelector('.system-error-card')).toBeNull()
    setCurrentError({ userSummary: 'second failure', recoverability: 'none' })
    expect(error.container.querySelector('.system-error-card')).toHaveTextContent('second failure')
  })
})
