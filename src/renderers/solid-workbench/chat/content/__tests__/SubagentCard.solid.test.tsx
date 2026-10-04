// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidSubagentCard } from '../SubagentCard.solid.tsx'
import type { WorkbenchActivityNode } from '../../../../../domains/workbench/workbenchProjector.ts'

/**
 * C09 RED：子代理卡契约。
 * - rich 字段与层级来自节点列；缺失字段不渲染（不猜）；
 * - cancel/retry 仅 capability 允许且状态匹配时出现；
 * - synthetic provenance 可见；parts 内嵌 terminal/log 复用 C07 层。
 */

const richNode = {
  id: 'sub-1', kind: 'activity', activityKind: 'subagent', semanticKind: 'activity.subagent',
  title: 'Explore repo', status: 'running', parentId: 'tool-1', depth: 2,
  role: 'explorer', model: 'ox-alpha-free', provider: 'opencode-go',
  goal: 'find call sites', progress: { completed: 3, total: 5 },
  usage: { inputTokens: 1200, outputTokens: 340 }, files: ['src/a.ts'],
} as unknown as WorkbenchActivityNode

afterEach(() => cleanup())

describe('C09 SolidSubagentCard', () => {
  it('renders adjacent streamed text output as one semantic paragraph', () => {
    const activity = {
      ...richNode,
      parts: [{ kind: 'text', text: '连续' }, { kind: 'markdown', text: '输出' }],
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={activity} />)

    const output = result.container.querySelector('.term-subagent-output')!
    expect(output).toHaveTextContent('连续输出')
    expect(output.querySelectorAll('.term-subagent-goal')).toHaveLength(1)
  })

  it('renders rich metadata and hierarchy from node columns only', () => {
    const result = render(() => <SolidSubagentCard activity={richNode} />)
    expect(result.container.textContent).toContain('Explore repo')
    expect(result.container.textContent).toContain('explorer')
    expect(result.container.textContent).toContain('ox-alpha-free · opencode-go')
    expect(result.container.textContent).toContain('parent: tool-1')
    expect(result.container.textContent).toContain('find call sites')
    expect(result.container.textContent).toContain('进度 3/5')
    expect(result.getByRole('progressbar', { name: 'Explore repo 进度' })).toHaveAttribute('value', '3')
    expect(result.getByRole('progressbar', { name: 'Explore repo 进度' })).toHaveAttribute('max', '5')
    expect(result.container.querySelector('.term-subagent-kind')).toHaveTextContent('子代理')
    expect(result.container.querySelector('.term-activity-status')).toHaveAttribute('data-status', 'running')
    expect(result.container.textContent).toContain('1200 in · 340 out')
    expect(result.container.textContent).toContain('1 个文件')
    const card = result.container.querySelector('.term-subagent-card') as HTMLElement
    expect(card.dataset.depth).toBe('2')
    expect(card.style.getPropertyValue('--subagent-depth')).toBe('2')
    expect(card.getAttribute('role')).toBe('status')
  })

  it('renders normalized result, metrics, structured files, execution metadata and provenance', () => {
    const activity = {
      ...richNode,
      description: 'Inspect the renderer registry',
      metrics: { toolCount: 4, taskCount: 2, durationMs: 900, costUsd: 0.03 },
      files: { read: ['src/a.ts', 'src/b.ts'], written: ['src/c.ts'], touched: ['src/d.ts'] },
      execution: { mode: 'remote', background: true, worktree: 'review/c09', team: 'renderer' },
      result: { summary: 'Found 12 call sites' },
      output: [{ kind: 'text', text: 'No blocking issues found.' }],
      parts: [{ kind: 'text', text: 'No blocking issues found.' }],
      provenance: { origin: 'recovery-import', trust: 'unverified', orderConfidence: 'observed' },
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={activity} />)
    expect(result.container).toHaveTextContent('Inspect the renderer registry')
    expect(result.container).toHaveTextContent('4 tools · 2 tasks · 900 ms · $0.03')
    expect(result.container).toHaveTextContent('读取 2 · 写入 1 · 触及 1')
    expect(result.container).toHaveTextContent('remote · background · worktree review/c09 · team renderer')
    expect(result.container).toHaveTextContent('Found 12 call sites')
    expect(result.container).toHaveTextContent('No blocking issues found.')
    expect(result.container).toHaveTextContent('来源：recovery-import · unverified · observed')
  })

  it('derives aggregate counts from normalized tool and task children without requiring stored metrics', () => {
    const activity = {
      ...richNode,
      tools: [{ id: 'tool-1' }, { id: 'tool-2' }],
      tasks: [{ id: 'task-1' }],
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={activity} />)
    expect(result.container).toHaveTextContent('2 tools · 1 tasks')
  })

  it('consumes card, tree, marker, aggregate and expansion appearance settings', () => {
    const activity = {
      ...richNode,
      metrics: { toolCount: 4 },
      parts: [{ kind: 'text', text: 'Nested output' }],
      output: [{ kind: 'text', text: 'Nested output' }],
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={activity} appearance={{
      viewMode: 'cards', cardWidth: 420, treeLineStyle: 'dashed', treeLineColor: '#112233', indent: 12,
      identityMarker: 'none', defaultExpandedDepth: 1, showAggregate: false,
    }} />)
    const card = result.container.querySelector('.term-subagent-card') as HTMLElement
    expect(card).toHaveAttribute('data-view-mode', 'cards')
    expect(card).toHaveAttribute('data-tree-line', 'dashed')
    expect(card.style.maxWidth).toBe('420px')
    expect(card.style.getPropertyValue('--subagent-card-width')).toBe('420px')
    expect(card.style.getPropertyValue('--subagent-indent')).toBe('12px')
    expect(card.style.getPropertyValue('--subagent-tree-color')).toBe('#112233')
    expect(result.container.querySelector('.term-subagent-marker')).toBeNull()
    expect(result.container).not.toHaveTextContent('4 tools')
    expect(result.container.querySelector('details.term-subagent-output')).not.toHaveAttribute('open')
  })

  it('degrades a minimal node without fabricating fields', () => {
    const minimal = { id: 'sub-2', kind: 'activity', activityKind: 'team', status: 'failed' } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={minimal} />)
    expect(result.container.querySelector('[data-depth="0"]')).not.toBeNull()
    expect(result.container.textContent).not.toContain('parent:')
    expect(result.container.textContent).not.toContain('目标：')
  })

  it('gates cancel/retry actions behind command capabilities and status', async () => {
    const execute = vi.fn()
    const canExecute = (type: string) => type === 'activity.cancel'
    const withoutNodeCapability = render(() => <SolidSubagentCard activity={richNode} commands={{ execute, canExecute }} />)
    expect(withoutNodeCapability.container.querySelectorAll('button')).toHaveLength(0)

    const cancellable = { ...richNode, capabilities: ['cancel'] } as unknown as WorkbenchActivityNode
    const running = render(() => <SolidSubagentCard activity={cancellable} commands={{ execute, canExecute }} />)
    expect([...running.container.querySelectorAll('button')].map(b => b.title)).toEqual(['取消此子代理'])
    running.container.querySelector('button')!.click()
    expect(execute).toHaveBeenCalledWith({ type: 'activity.cancel', targetId: 'sub-1' })

    // failed 节点：capability 只给了 cancel → retry 按钮仍不可见
    const failed = { ...richNode, status: 'failed' } as unknown as WorkbenchActivityNode
    const failedView = render(() => <SolidSubagentCard activity={failed} commands={{ execute, canExecute }} />)
    expect(failedView.container.querySelectorAll('button').length).toBe(0)

    // 无 commands → 无动作
    const bare = render(() => <SolidSubagentCard activity={richNode} />)
    expect(bare.container.querySelectorAll('button').length).toBe(0)
  })

  it('dispatches focus, open and reconnect only through target-preserving tool actions', async () => {
    const execute = vi.fn()
    const activity = {
      ...richNode, status: 'interrupted', capabilities: ['focus', 'open', 'reconnect'],
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={activity} commands={{
      execute, canExecute: type => type === 'tool.action',
    }} />)
    expect([...result.container.querySelectorAll('button')].map(button => button.title)).toEqual([
      '聚焦此子代理', '打开此子代理', '重新连接此子代理',
    ])
    for (const button of result.container.querySelectorAll('button')) button.click()
    expect(execute.mock.calls.map(call => call[0])).toEqual([
      { type: 'tool.action', targetId: 'sub-1', payload: { action: 'focus' } },
      { type: 'tool.action', targetId: 'sub-1', payload: { action: 'open' } },
      { type: 'tool.action', targetId: 'sub-1', payload: { action: 'reconnect' } },
    ])
  })

  it('supports keyboard navigation across sibling activity cards', async () => {
    const first = { ...richNode, id: 'sub-first', title: 'First' } as unknown as WorkbenchActivityNode
    const second = { ...richNode, id: 'sub-second', title: 'Second' } as unknown as WorkbenchActivityNode
    const result = render(() => <div class="solid-workbench-activities">
      <SolidSubagentCard activity={first} />
      <SolidSubagentCard activity={second} />
    </div>)
    const cards = result.container.querySelectorAll<HTMLElement>('.term-subagent-card')
    cards[0].focus()
    fireEvent.keyDown(cards[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cards[1])
    fireEvent.keyDown(cards[1], { key: 'Home' })
    expect(document.activeElement).toBe(cards[0])
    fireEvent.keyDown(cards[0], { key: 'End' })
    expect(document.activeElement).toBe(cards[1])
    fireEvent.keyDown(cards[1], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(cards[0])
  })

  it('surfaces synthetic provenance and reuses terminal/log part rendering', () => {
    const withParts = {
      ...richNode,
      provenance: { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed' as const, synthetic: { reason: 'terminal response observed' } },
      parts: [
        { kind: 'terminal', streams: [{ stream: 'stdout', text: 'hello' }] },
        { kind: 'log', entries: [{ level: 'info', text: 'logged' }] },
      ],
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={withParts} />)
    expect(result.container.textContent).toContain('合成生命周期：terminal response observed')
    expect(result.container.querySelector('.term-terminal-card')).not.toBeNull()
    expect(result.container.querySelector('.term-log-card')).not.toBeNull()
  })

  it('renders C15 memory/mcp-resource/artifact metadata via the slot branch, never blank', async () => {
    const { BuiltinSolidContentSlot } = await import('../../BuiltinSolidContentSlot.solid.tsx')
    const cases: Array<{ kind: string; payload: Record<string, unknown>; expectText: string }> = [
      { kind: 'content.memory', payload: { kind: 'memory', memoryId: 'memory-dark', title: 'User prefers dark', source: 'hermes', status: 'recalled' }, expectText: 'User prefers dark' },
      { kind: 'content.mcp-resource', payload: { kind: 'mcp-resource', server: 'fs-mcp', resourceUri: 'file:///docs/spec.md' }, expectText: 'fs-mcp' },
      { kind: 'content.artifact', payload: { kind: 'artifact', artifactId: 'artifact-report', title: 'report.pdf', uri: 'https://x/report.pdf', version: 2 }, expectText: 'report.pdf' },
    ]
    for (const c of cases) {
      const view = render(() => <BuiltinSolidContentSlot
        snapshot={{ nodeId: `node-${c.kind}`, kind: c.kind, payload: c.payload } as never}
        appearance={{}} commands={{ execute: () => {}, canExecute: () => false }} />)
      // 完成定义：历史必须可读——不允许 Switch 无命中渲染空白
      expect(view.container.textContent).toContain(c.expectText)
      expect(view.container.querySelector(`[data-content-kind="${c.kind}"]`)).not.toBeNull()
      view.unmount()
    }
  })
})
