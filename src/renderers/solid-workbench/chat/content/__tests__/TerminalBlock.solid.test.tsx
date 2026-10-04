// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidLogBlock, SolidProcessActivity, SolidTerminalBlock } from '../TerminalBlock.solid.tsx'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'
import { createUnknownContentPart, type ContentPart } from '../../../../../domains/workbench/content/contentPartSchema.ts'
import type { WorkbenchActivityNode } from '../../../../../domains/workbench/workbenchProjector.ts'

/**
 * C07 RED：终端/日志卡契约。
 *
 * - stdout/stderr 分列（err 视觉标记），ANSI 转义序列纯文本化；
 * - exit/killed/timeout/non-zero 分开显示；
 * - truncation 显示 captured/omitted；迟到 chunk 标记呈现；
 * - copy capability-gated。
 */

const terminalPart = {
  kind: 'terminal',
  command: 'npm test',
  streams: [
    { stream: 'stdout', text: 'running tests...', ordinal: 0 },
    { stream: 'stderr', text: 'warning: deprecated', ordinal: 1 },
    { stream: 'stdout', text: '\u001b[32m3 passed\u001b[0m', ordinal: 2 },
  ],
  exitCode: 0,
  status: 'completed',
} as unknown as ContentPart

afterEach(() => cleanup())

describe('C07 SolidTerminalBlock', () => {
  it('renders separated stdout/stderr lines with stream tags', () => {
    const result = render(() => <SolidTerminalBlock part={terminalPart} />)
    const stdout = result.container.querySelectorAll('.term-stream-stdout')
    const stderr = result.container.querySelectorAll('.term-stream-stderr')
    expect(stdout.length).toBe(2)
    expect(stderr.length).toBe(1)
    // ANSI 序列纯文本化：绿色码不出现
    expect(result.container.textContent).not.toContain('\u001b[32m')
    expect(result.container.textContent).toContain('3 passed')
  })

  it('shows exit 0 for success and non-zero exit distinctly', () => {
    const ok = render(() => <SolidTerminalBlock part={terminalPart} />)
    expect(ok.container.textContent).toContain('exit 0')

    const failed = render(() => <SolidTerminalBlock part={{ ...terminalPart, exitCode: 137 } as unknown as ContentPart} />)
    expect(failed.container.textContent).toContain('exit 137')
    expect(failed.container.querySelector('[data-tone="failed"]')).not.toBeNull()
  })

  it('shows timeout and killed termination reasons separately from exit code', () => {
    const timeout = render(() => <SolidTerminalBlock part={{ ...terminalPart, terminatedBy: 'timeout' } as unknown as ContentPart} />)
    expect(timeout.container.textContent).toContain('超时终止')
    const killed = render(() => <SolidTerminalBlock part={{ ...terminalPart, terminatedBy: 'killed' } as unknown as ContentPart} />)
    expect(killed.container.textContent).toContain('killed')
  })

  it('shows truncation with captured/omitted counts', () => {
    const truncPart = {
      ...terminalPart,
      truncation: { capturedLines: 3, omittedLines: 9999 },
    } as unknown as ContentPart
    const result = render(() => <SolidTerminalBlock part={truncPart} />)
    expect(result.container.textContent).toContain('保留 3 行')
    expect(result.container.textContent).toContain('省略 9999 行')
  })

  it('shows byte-only truncation for a partially retained oversized chunk', () => {
    const result = render(() => <SolidTerminalBlock part={{
      ...terminalPart,
      streams: [{ stream: 'stdout', text: 'retained tail' }],
      truncation: { capturedLines: 1, omittedLines: 0, capturedBytes: 13, omittedBytes: 4096 },
    } as ContentPart} />)

    expect(result.container).toHaveTextContent('输出已截断')
    expect(result.container).toHaveTextContent('保留 1 行')
    expect(result.container).toHaveTextContent('4096 bytes')
  })

  it('consumes declared typography tokens (C13: 声明必须真实消费)', () => {
    const result = render(() => <SolidTerminalBlock part={terminalPart} appearance={{
      fontFamily: 'inherit', fontSize: 17, lineHeight: 2,
    }} />)
    const body = result.container.querySelector('.term-terminal-body') as HTMLElement
    expect(body.style.fontFamily).toBe('inherit')
    expect(body.style.fontSize).toBe('17px')
    expect(body.style.lineHeight).toBe('2')
    // 非法数值回退 kind default，不产生 NaN/undefined 内联样式
    const fallback = render(() => <SolidTerminalBlock part={terminalPart} appearance={{
      fontSize: Number.NaN, lineHeight: undefined as unknown as number,
    }} />)
    const fallbackBody = fallback.container.querySelector('.term-terminal-body') as HTMLElement
    expect(fallbackBody.style.fontSize).toBe('13px')
    expect(fallbackBody.style.lineHeight).toBe('1.5')
    expect(fallbackBody.style.fontFamily).toBe('var(--mono)')
    expect(fallbackBody.innerHTML).not.toContain('NaN')

    const mono = render(() => <SolidTerminalBlock part={terminalPart} appearance={{ fontFamily: 'mono' }} />)
    expect((mono.container.querySelector('.term-terminal-body') as HTMLElement).style.fontFamily).toBe('var(--mono)')
  })

  it('copy goes through injected callback with sanitized text', async () => {
    const copy = vi.fn()
    const result = render(() => <SolidTerminalBlock part={terminalPart} actions={{ copy }} />)
    const button = [...result.container.querySelectorAll('button')].find(b => b.textContent === '复制')!
     button.click()
    expect(copy).toHaveBeenCalled()
    const copiedText = copy.mock.calls[0]![0] as string
    expect(copiedText).toContain('[err] warning: deprecated')
    expect(copiedText).not.toContain('\u001b[')
  })

  it('follows new output only while follow-tail is enabled', async () => {
    const [part, setPart] = createSignal(terminalPart)
    const [followTail, setFollowTail] = createSignal(true)
    const result = render(() => <SolidTerminalBlock part={part()} appearance={{ followTail: followTail() }} />)
    const body = result.container.querySelector<HTMLElement>('.term-terminal-body')!
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 500 })
    body.scrollTop = 0

    setPart({
      ...(terminalPart as unknown as Record<string, unknown>),
      streams: [...(terminalPart as unknown as { streams: unknown[] }).streams, { stream: 'stdout', text: 'new chunk', ordinal: 3 }],
    } as unknown as ContentPart)
    await Promise.resolve()
    expect(body.scrollTop).toBe(500)

    setFollowTail(false)
    body.scrollTop = 120
    setPart({
      ...(part() as unknown as Record<string, unknown>),
      streams: [...((part() as unknown as { streams: unknown[] }).streams), { stream: 'stdout', text: 'paused chunk', ordinal: 4 }],
    } as unknown as ContentPart)
    await Promise.resolve()
    expect(body.scrollTop).toBe(120)
  })

  it('late chunks are flagged and rendered separately', () => {
    const late = {
      ...terminalPart,
      streams: [
        ...(terminalPart as unknown as { streams: unknown[] }).streams,
        { stream: 'stdout', text: 'late arrival', ordinal: 9, lateAfterTerminal: true },
      ],
    } as unknown as ContentPart
    const result = render(() => <SolidTerminalBlock part={late} />)
    expect(result.container.textContent).toContain('迟到输出')
    expect(result.container.querySelectorAll('.term-terminal-line')).toHaveLength(3)
    expect(result.container.querySelectorAll('.term-terminal-late')).toHaveLength(1)
    expect(result.container.textContent?.match(/late arrival/g)).toHaveLength(1)
  })
})

describe('C07 SolidLogBlock', () => {
  it('renders entries with levels and synthetic timestamp flag', () => {
    const logPart = {
      kind: 'log',
      source: 'build-worker',
      entries: [
        { level: 'info', text: 'compiling', timestampConfidence: 'observed' },
        { level: 'warn', text: 'slow transform', timestampConfidence: 'synthetic' },
      ],
    } as unknown as ContentPart
    const result = render(() => <SolidLogBlock part={logPart} />)
    expect(result.container.textContent).toContain('compiling')
    expect(result.container.textContent).toContain('时间戳为合成')
    expect(result.container.querySelector('.term-log-warn')).not.toBeNull()
  })

  it('makes structured log truncation accounting visible', () => {
    const result = render(() => <SolidLogBlock part={{
      kind: 'log', source: 'bounded-worker',
      entries: [{ level: 'error', text: 'retained tail' }],
      truncation: { capturedLines: 1, omittedLines: 99, capturedBytes: 13, omittedBytes: 4096 },
    } as ContentPart} />)

    expect(result.container).toHaveTextContent('日志已截断')
    expect(result.container).toHaveTextContent('保留 1 行')
    expect(result.container).toHaveTextContent('省略 99 行')
    expect(result.container).toHaveTextContent('4096 bytes')
  })
})

describe('C07 SolidProcessActivity', () => {
  it('keeps bounded unknown process evidence visible instead of reducing it to a kind label', () => {
    const activity = {
      id: 'process-unknown', kind: 'activity', activityKind: 'process', semanticKind: 'activity.process',
      title: 'unsafe worker', status: 'failed', orphan: false, sequence: 1,
      parts: [createUnknownContentPart('terminal', {
        kind: 'terminal', streams: [{ stream: 'stdin', text: 'malformed evidence' }],
      })],
    } as WorkbenchActivityNode
    const result = render(() => <SolidProcessActivity activity={activity} />)
    const unknown = result.container.querySelector('[data-content-kind="content.unknown"]')

    expect(unknown).toHaveTextContent('未知内容：terminal')
    expect(unknown?.querySelector('.tool-object-inspector')).not.toBeNull()
    const nested = unknown!.querySelector<HTMLDetailsElement>('.tool-object-branch .tool-object-branch')!
    nested.open = true
    fireEvent(nested, new Event('toggle'))
    expect(unknown).toHaveTextContent('malformed evidence')
    expect(unknown?.querySelector('details')).not.toHaveAttribute('open')
  })

  it('renders process progress as structured fields rather than serialized JSON', () => {
    const activity = {
      id: 'process-progress', kind: 'activity', activityKind: 'process', semanticKind: 'activity.process',
      title: 'test worker', status: 'running', orphan: false, sequence: 1,
      progress: { completed: 2, total: 5, phase: 'testing' },
    } as WorkbenchActivityNode
    const result = render(() => <SolidProcessActivity activity={activity} />)

    expect(result.container.querySelector('.term-process-progress .tool-object-inspector')).toHaveTextContent('testing')
    expect(result.container.querySelector('.term-process-progress pre')).toBeNull()
  })
})

describe('C07 built-in content Slot', () => {
  it('renders canonical terminal/log payloads and gates copy through the command port', async () => {
    const execute = vi.fn()
    const terminal = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'terminal-slot', kind: 'content.terminal', revision: 1, payload: terminalPart }}
      appearance={{}}
      commands={{ execute, canExecute: type => type === 'clipboard.write' }}
    />)

    expect(terminal.container.querySelector('.term-terminal-card')).not.toBeNull()
     terminal.getByRole('button', { name: '复制' }).click()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: 'clipboard.write',
      payload: expect.objectContaining({ text: expect.stringContaining('[err] warning: deprecated') }),
    }))

    const log = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'log-slot', kind: 'content.log', revision: 1,
        payload: { kind: 'log', source: 'worker', entries: [{ level: 'info', text: 'ready' }] },
      }}
      appearance={{}}
      commands={{ execute: vi.fn(), canExecute: () => false }}
    />)
    expect(log.container.querySelector('.term-log-card')).toHaveTextContent('ready')
  })

  it('consumes terminal appearance and behaviour settings', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'terminal-settings', kind: 'content.terminal', revision: 1,
        payload: {
          kind: 'terminal', processId: 'proc-7', sessionId: 'shell-9',
          streams: [
            { stream: 'stdout', text: 'old', ordinal: 0, timestamp: '10:00' },
            { stream: 'stderr', text: 'latest', ordinal: 1, timestamp: '10:01' },
          ],
        },
      }}
      appearance={{
        wrap: 'soft', maxHeight: 222, retainedLines: 1,
        stdoutColor: '#112233', stderrColor: '#aabbcc', background: '#010203',
        timestamps: true, followTail: false, density: 'compact', showCopy: false, showIdentity: true,
      }}
      commands={{ execute: vi.fn(), canExecute: () => true }}
    />)

    const card = result.container.querySelector<HTMLElement>('.term-terminal-card')!
    const body = result.container.querySelector<HTMLElement>('.term-terminal-body')!
    expect(card).toHaveAttribute('data-density', 'compact')
    expect(card).toHaveTextContent('proc-7')
    expect(card).toHaveTextContent('shell-9')
    expect(card).toHaveTextContent('10:01')
    expect(card).not.toHaveTextContent('old')
    expect(card.querySelector('button')).toBeNull()
    expect(body).toHaveAttribute('data-wrap', 'soft')
    expect(body).toHaveAttribute('data-follow-tail', 'false')
    expect(body.style.maxHeight).toBe('222px')
    expect(body.style.background).toBe('rgb(1, 2, 3)')
    expect(card.querySelector<HTMLElement>('.term-stream-stderr')?.style.color).toBe('rgb(170, 187, 204)')
  })

  it('filters and styles structured logs from renderer settings', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'log-settings', kind: 'content.log', revision: 1,
        payload: {
          kind: 'log', source: 'worker',
          entries: [
            { level: 'info', text: 'hidden info', ordinal: 0, timestamp: '10:00' },
            { level: 'warn', text: 'older warning', ordinal: 1, timestamp: '10:01' },
            { level: 'error', text: 'latest error', ordinal: 2, timestamp: '10:02' },
          ],
        },
      }}
      appearance={{
        logLevels: ['warn', 'error'], retainedLines: 1, timestamps: true,
        density: 'compact', maxHeight: 180, background: '#010203', stderrColor: '#aabbcc',
      }}
      commands={{ execute: vi.fn(), canExecute: () => false }}
    />)

    const card = result.container.querySelector<HTMLElement>('.term-log-card')!
    const entries = result.container.querySelector<HTMLElement>('.term-log-entries')!
    expect(card).toHaveAttribute('data-density', 'compact')
    expect(card).toHaveTextContent('latest error')
    expect(card).toHaveTextContent('10:02')
    expect(card).not.toHaveTextContent('hidden info')
    expect(card).not.toHaveTextContent('older warning')
    expect(entries.style.maxHeight).toBe('180px')
    expect(entries.style.background).toBe('rgb(1, 2, 3)')
    expect(card.querySelector<HTMLElement>('.term-log-error')?.style.color).toBe('rgb(170, 187, 204)')
  })

  it('shows a diagnostic fallback for malformed terminal/log payloads', () => {
    const terminal = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'bad-terminal', kind: 'content.terminal', revision: 1, payload: { streams: [{ stream: 'stdin', text: 'bad' }] } }}
      appearance={{}} commands={{ execute: vi.fn(), canExecute: () => false }}
    />)
    expect(terminal.container.querySelector('[data-content-kind="content.terminal"]')).toHaveTextContent('Invalid content.terminal payload')
    expect(terminal.container.querySelector('.term-terminal-card')).toBeNull()

    const log = render(() => <BuiltinSolidContentSlot
      snapshot={{ nodeId: 'bad-log', kind: 'content.log', revision: 1, payload: { entries: [] } }}
      appearance={{}} commands={{ execute: vi.fn(), canExecute: () => false }}
    />)
    expect(log.container.querySelector('[data-content-kind="content.log"]')).toHaveTextContent('Invalid content.log payload')
    expect(log.container.querySelector('.term-log-card')).toBeNull()
  })
})
