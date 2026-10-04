// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { BuiltinSolidContentSlot } from '../../BuiltinSolidContentSlot.solid.tsx'

afterEach(() => cleanup())

describe('C08 content.plan Solid base Slot', () => {
  it('renders canonical five-state plan fields and goal accounting', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'plan-goal', kind: 'content.plan', revision: 1,
        payload: {
          entries: [
            { id: 'active', content: '实现接线', status: 'in_progress', activeForm: '正在接线', priority: 1 },
            { id: 'done', content: '完成模型', status: 'completed' },
            { id: 'blocked', content: '等待验收', status: 'blocked', blockedReason: '依赖 C07' },
            { id: 'cancelled', content: '废弃方案', status: 'cancelled' },
            { id: 'future', content: '未来状态', status: 'unknown', rawStatus: 'paused-by-provider' },
          ],
          goal: {
            goalId: 'goal-1', objective: '闭环 C08', status: 'blocked', tokenBudget: 1000, tokensUsed: 250,
            blockedReason: '等待依赖', accounting: { tokensUsed: 250, timeUsedSeconds: 30, metadata: { cost: 0.2 } },
          },
        },
      }}
      appearance={{ defaultExpanded: true, collapseCompleted: false, showPriority: true, showBudget: true }}
      commands={{ execute: () => {} }}
    />)

    expect(result.getByRole('region', { name: '计划与目标' })).toBeTruthy()
    expect(result.getByRole('tree', { name: '任务列表' })).toBeTruthy()
    expect(result.getByRole('treeitem', { name: /正在接线.*优先级 1/ })).toHaveAttribute('aria-current', 'step')
    expect(result.getByText('依赖 C07')).toBeTruthy()
    expect(result.getByText('paused-by-provider')).toBeTruthy()
    expect(result.getByRole('status', { name: /目标：闭环 C08.*已阻塞.*预算 25%/ })).toBeTruthy()
    expect(result.container.querySelector('.goal-card-budget')).toHaveAttribute('aria-valuenow', '25')
    expect(result.getByRole('progressbar', { name: '计划总体进度' })).toHaveAttribute('value', '1')
    expect(result.container.textContent).toContain('30 秒')
  })

  it('uses accessible disclosure state, completed folding, glyph and reduced-motion settings', async () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'plan-settings', kind: 'content.plan', revision: 1,
        payload: {
          entries: [
            { id: 'pending', content: '待处理项', status: 'pending' },
            { id: 'done', content: '已完成项', status: 'completed' },
          ],
        },
      }}
      appearance={{
        defaultExpanded: true, collapseCompleted: true, nodeGlyph: 'dot', connectorStyle: 'none',
        density: 'compact', reducedMotion: true,
      }}
      commands={{ execute: () => {} }}
    />)

    const region = result.getByRole('region', { name: '计划与目标' })
    expect(region).toHaveAttribute('data-node-glyph', 'dot')
    expect(region).toHaveAttribute('data-connector-style', 'none')
    expect(region).toHaveAttribute('data-density', 'compact')
    expect(region).toHaveAttribute('data-reduced-motion', 'true')
    expect(result.getByRole('treeitem', { name: /待处理项/ })).toBeTruthy()
    expect(result.queryByRole('treeitem', { name: /已完成项/ })).toBeNull()
    expect(result.container.querySelector('.task-tree-status')?.textContent).toBe('•')

    fireEvent.click(result.getByRole('button', { name: '显示 1 个已完成任务' }))
    expect(result.getByRole('treeitem', { name: /已完成项/ })).toBeTruthy()
  })

  it('fails closed to a readable base fallback for malformed provider-shaped payload', () => {
    const result = render(() => <BuiltinSolidContentSlot
      snapshot={{
        nodeId: 'plan-invalid', kind: 'content.plan', revision: 1,
        payload: { update: { sessionUpdate: 'plan', entries: [{ content: 'raw' }] } },
      }}
      appearance={{}}
      commands={{ execute: () => {} }}
    />)

    expect(result.container.querySelector('[data-content-kind="content.plan"].solid-content-unknown')?.textContent)
      .toContain('Invalid content.plan payload')
    expect(result.queryByRole('tree')).toBeNull()
  })
})
