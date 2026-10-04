// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SolidWorkflowActivityCard } from '../WorkflowCard.solid.tsx'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'
import type { WorkbenchActivityNode } from '../../../../../domains/workbench/workbenchProjector.ts'

/**
 * C10：后台任务/工作流 Solid 渲染——phase/agent relation、progress、合成 provenance。
 * SubagentCard 是数据驱动的活动卡：semanticKind 只决定 catalog 路由，卡面按节点列渲染。
 */

afterEach(() => cleanup())

describe('C10 workflow activity rendering', () => {
  it('renders adjacent streamed text output as one semantic paragraph', () => {
    const workflow = {
      id: 'workflow-streamed-output', kind: 'activity', activityKind: 'workflow', semanticKind: 'activity.workflow',
      title: 'streamed workflow', status: 'running',
      output: [{ kind: 'text', text: '连续' }, { kind: 'markdown', text: '输出' }],
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidWorkflowActivityCard activity={workflow} />)

    expect(result.container).toHaveTextContent('连续输出')
    expect(result.container.querySelectorAll('.term-workflow-result')).toHaveLength(1)
  })

  it('renders a workflow phase with parent relation and progress', () => {
    const phase = {
      id: 'phase-1', kind: 'activity', activityKind: 'workflow-phase', semanticKind: 'activity.workflow-phase',
      title: 'build', status: 'running', parentId: 'wf-1',
      progress: { completed: 2, total: 4 },
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidWorkflowActivityCard activity={phase} />)
    expect(result.container.textContent).toContain('build')
    expect(result.container.textContent).toContain('parent: wf-1')
    expect(result.container.textContent).toContain('进度 2/4')
    const card = result.container.querySelector('.term-workflow-card') as HTMLElement
    expect(card.getAttribute('data-part-kind')).toBe('activity.workflow-phase')
    expect(card.getAttribute('role')).toBe('status')
    expect(result.getByRole('progressbar', { name: 'build 进度' })).toHaveAttribute('value', '2')
    expect(result.getByRole('progressbar', { name: 'build 进度' })).toHaveAttribute('max', '4')
    expect(result.container.querySelector('.term-workflow-kind')).toHaveTextContent('阶段')
    expect(result.container.querySelector('.term-activity-status')).toHaveAttribute('data-status', 'running')
  })

  it('marks synthetic terminal provenance on a workflow agent', () => {
    const agent = {
      id: 'agent-1', kind: 'activity', activityKind: 'workflow-agent', semanticKind: 'activity.workflow-agent',
      title: 'reviewer bot', status: 'failed', parentId: 'wf-1', role: 'reviewer',
      reason: 'connection lost', orphan: true,
      provenance: { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed' as const, synthetic: { reason: 'terminal response observed' } },
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidWorkflowActivityCard activity={agent} />)
    expect(result.container.textContent).toContain('合成生命周期：terminal response observed')
    // reason 是 journal 事实，卡面呈现的是 status + 合成 provenance（error 才走 role=alert）
    expect(result.container.textContent).toContain('failed')
  })

  it('renders progress result and explicit killed/timeout termination evidence', () => {
    const workflow = {
      id: 'workflow-1', kind: 'activity', activityKind: 'workflow', semanticKind: 'activity.workflow',
      title: 'release pipeline', status: 'timeout',
      result: { summary: 'partial output' }, killed: true, timeout: true,
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidWorkflowActivityCard activity={workflow} />)
    expect(result.container.textContent).toContain('partial output')
    expect(result.container.textContent).toContain('已终止')
    expect(result.container.textContent).toContain('超时')
  })

  it('consumes the selected usage, tools and duration statistics', () => {
    const workflow = {
      id: 'workflow-stats', kind: 'activity', activityKind: 'workflow', semanticKind: 'activity.workflow',
      title: 'release pipeline', status: 'running',
      usage: { totalTokens: 420 }, metrics: { toolCount: 3, durationMs: 1500 },
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidWorkflowActivityCard activity={workflow} appearance={{
      stats: ['usage', 'tools', 'duration'],
    }} />)
    expect(result.container.querySelector('.term-workflow-stats')).toHaveTextContent('420 tokens')
    expect(result.container.querySelector('.term-workflow-stats')).toHaveTextContent('3 tools')
    expect(result.container.querySelector('.term-workflow-stats')).toHaveTextContent('1.5s')
  })

  it('consumes workflow layout, connector, indent, collapse and animation settings', () => {
    const phase = {
      id: 'phase-complete', kind: 'activity', activityKind: 'workflow-phase', semanticKind: 'activity.workflow-phase',
      title: 'build', status: 'completed', parentId: 'workflow-1', depth: 2, result: { summary: 'built' },
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidWorkflowActivityCard activity={phase} appearance={{
      workflowLayout: 'lanes', workflowConnector: false, indent: 12,
      collapseCompleted: true, animateProgress: false, density: 'compact', statusPalette: 'mono',
    }} />)
    const card = result.container.querySelector('.term-workflow-card') as HTMLElement
    expect(card).toHaveAttribute('data-layout', 'lanes')
    expect(card).toHaveAttribute('data-connector', 'none')
    expect(card).toHaveAttribute('data-motion', 'none')
    expect(card).toHaveAttribute('data-density', 'compact')
    expect(card).toHaveAttribute('data-palette', 'mono')
    expect(card).toHaveAttribute('data-depth', '2')
    expect(card.style.getPropertyValue('--workflow-indent')).toBe('12px')
    expect(card.style.getPropertyValue('--workflow-depth')).toBe('2')
    expect(card.querySelector('details.term-workflow-details')).not.toHaveAttribute('open')
  })

  it('renders schema-validated output, bounded unknown evidence and normalized errors', () => {
    const task = {
      id: 'background-output', kind: 'activity', activityKind: 'background-task', semanticKind: 'activity.background-task',
      title: 'index workspace', status: 'failed',
      output: [
        { kind: 'text', text: 'indexed 12 files' },
        { kind: 'unknown', originalType: 'vendor-step', summary: 'Unknown vendor-step', raw: { state: 'odd' }, truncated: false },
      ],
      error: { userSummary: 'index failed', recoverability: 'retry' },
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidWorkflowActivityCard activity={task} />)
    expect(result.container).toHaveTextContent('indexed 12 files')
    expect(result.container).toHaveTextContent('未知内容：vendor-step')
    expect(result.container.querySelector('.tool-object-inspector')).toHaveTextContent('state')
    expect(result.container.querySelector('.tool-object-inspector')).toHaveTextContent('odd')
    expect(result.container.textContent).not.toContain('"state": "odd"')
    expect(result.getByRole('alert')).toHaveTextContent('index failed')
  })

  it('gates workflow actions and preserves the target activity identity', async () => {
    const execute = vi.fn()
    const running = {
      id: 'workflow-running', kind: 'activity', activityKind: 'workflow', semanticKind: 'activity.workflow',
      title: 'release', status: 'running', capabilities: ['detach', 'cancel'],
    } as unknown as WorkbenchActivityNode
    const live = render(() => <SolidWorkflowActivityCard activity={running} commands={{
      execute, canExecute: type => type === 'tool.action' || type === 'activity.cancel',
    }} />)
    expect([...live.container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['分离', '取消'])
    for (const button of live.container.querySelectorAll('button'))  button.click()
    expect(execute.mock.calls.map(call => call[0])).toEqual([
      { type: 'tool.action', targetId: 'workflow-running', payload: { action: 'detach' } },
      { type: 'activity.cancel', targetId: 'workflow-running' },
    ])

    const failed = { ...running, id: 'workflow-failed', status: 'failed', capabilities: ['reconnect', 'retry'] } as unknown as WorkbenchActivityNode
    const terminal = render(() => <SolidWorkflowActivityCard activity={failed} commands={{
      execute, canExecute: type => type === 'tool.action' || type === 'activity.retry',
    }} />)
    expect([...terminal.container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['重连', '重试'])
    for (const button of terminal.container.querySelectorAll('button'))  button.click()
    expect(execute.mock.calls.slice(2).map(call => call[0])).toEqual([
      { type: 'tool.action', targetId: 'workflow-failed', payload: { action: 'reconnect' } },
      { type: 'activity.retry', targetId: 'workflow-failed' },
    ])

    const readonly = render(() => <SolidWorkflowActivityCard activity={{ ...running, capabilities: undefined }} commands={{
      execute, canExecute: () => true,
    }} />)
    expect(readonly.container.querySelectorAll('button')).toHaveLength(0)
  })

  it('mounts workflow activities through the production base Slot', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'workflow-slot', kind: 'activity.workflow-phase', revision: 1,
        payload: {
          id: 'phase-slot', kind: 'activity', activityKind: 'workflow-phase', semanticKind: 'activity.workflow-phase',
          title: 'build', status: 'running', parentId: 'workflow-slot-parent',
        },
      }}
      appearance={{}}
      commands={{ execute: vi.fn(), canExecute: () => false }}
    />)
    expect(result.container.querySelector('.term-workflow-card')).not.toBeNull()
    expect(result.container.querySelector('.term-subagent-card')).toBeNull()
  })

  it('mounts background tasks through the production base Slot', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'background-slot', kind: 'activity.background-task', revision: 1,
        payload: {
          id: 'background-slot', kind: 'activity', activityKind: 'background-task', semanticKind: 'activity.background-task',
          title: 'index workspace', status: 'running',
        },
      }}
      appearance={{}}
      commands={{ execute: vi.fn(), canExecute: () => false }}
    />)
    expect(result.container.querySelector('.term-workflow-card')).toHaveTextContent('index workspace')
  })
})
