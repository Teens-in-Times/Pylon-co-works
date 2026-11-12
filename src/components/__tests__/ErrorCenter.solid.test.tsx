// @vitest-environment jsdom
// #515：迁移自 ErrorCenter.test.tsx（React RTL → Solid 实体直连；断言集原样保留，无改写点）。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import ErrorCenter from '../ErrorCenter.solid.tsx'
import { addError, clearErrors, getErrors } from '../../app/errorCenter'
import { ERROR_CODE_EXPLANATIONS } from '../../app/errorCodeExplanations.ts'

afterEach(() => {
  cleanup()
  clearErrors()
})

describe('ErrorCenter', () => {
  test('恢复动作进行中禁止重复执行，结束后恢复按钮', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const run = vi.fn(() => pending)
    addError({ action: '连接 Agent', message: '连接中断', key: 'agent:retry', recoveryAction: { label: '重新连接', run } })
    render(() => <ErrorCenter />)
    fireEvent.click(screen.getByRole('button', { name: '查看运行错误' }))
    const button = screen.getByRole('button', { name: '重新连接' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(run).toHaveBeenCalledOnce()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent('正在处理…')
    finish()
    await waitFor(() => expect(button).toBeEnabled())
    expect(button).toHaveTextContent('重新连接')
  })

  test('Escape 关闭通知面板并把焦点送回入口', () => {
    addError({ action: '保存配置', message: '请重试' })
    render(() => <ErrorCenter />)
    const badge = screen.getByRole('button', { name: '查看运行错误' })
    fireEvent.click(badge)
    screen.getByRole('button', { name: '关闭错误面板' }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '运行错误通知' })).toBeNull()
    expect(badge).toHaveFocus()
    expect(getErrors()).toHaveLength(1)
  })

  test('无错误时不渲染', () => {
    const { container } = render(() => <ErrorCenter />)
    expect(container.innerHTML).toBe('')
  })

  test('有错误显示 badge，展开列出错误并可清除', () => {
    addError({ action: '读取 Agent 列表', message: 'network down' })
    addError({ action: '保存配置', message: 'io error' })
    render(() => <ErrorCenter />)
    expect(screen.getByText('⚠ 2')).toBeTruthy()
    fireEvent.click(screen.getByText('⚠ 2'))
    expect(screen.getByText(/读取 Agent 列表/)).toBeTruthy()
    expect(screen.getByText(/保存配置/)).toBeTruthy()
    // 逐条关闭 → badge 变 1
    fireEvent.click(screen.getAllByLabelText('关闭该错误')[0])
    expect(screen.getByText('⚠ 1')).toBeTruthy()
    // 全部清除 → 组件消失
    fireEvent.click(screen.getByText('全部清除'))
    expect(screen.queryByText(/⚠/)).toBeNull()
  })

  test('容量上限 50', () => {
    for (let i = 0; i < 60; i++) addError({ action: 'a', message: `e${i}` })
    render(() => <ErrorCenter />)
    expect(screen.getByText('⚠ 50')).toBeTruthy()
    fireEvent.click(screen.getByText('⚠ 50'))
    expect(screen.getByText('e59')).toBeTruthy() // 最新在顶
    expect(screen.queryByText('e9')).toBeNull() // 最旧被丢弃
  })

  test('恢复按钮派发 pylon:open-settings 事件（施工文档 §5.3）', () => {
    const listener = vi.fn()
    window.addEventListener('pylon:open-settings', listener)
    addError({
      action: '切换 Agent',
      message: 'exe 路径不存在',
      code: 'agent_executable_missing',
      recovery: { kind: 'select-agent-executable', agentId: 'peri' },
    })
    render(() => <ErrorCenter />)
    fireEvent.click(screen.getByText('⚠ 1'))
    fireEvent.click(screen.getByText('选择可执行文件'))
    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0][0] as CustomEvent
    expect(event.detail).toMatchObject({ domain: 'agents-connections', section: 'agent', agentId: 'peri' })
    window.removeEventListener('pylon:open-settings', listener)
  })

  test('摘要可展开技术详情，隐藏只影响通知列表', () => {
    addError({
      action: '恢复会话',
      message: '本地历史已恢复，远端补充失败',
      code: 'replay_unavailable',
      scope: { kind: 'session', id: 'session-1' },
      technicalMessage: 'load_persisted_session: ECONNRESET',
      metadata: { retryable: true },
    })
    render(() => <ErrorCenter />)
    fireEvent.click(screen.getByRole('button', { name: '查看运行错误' }))
    expect(screen.getByText('本地历史已恢复，远端补充失败')).toBeTruthy()
    fireEvent.click(screen.getByText('详细信息'))
    expect(screen.getByText(/ECONNRESET/)).toBeTruthy()
    expect(screen.getByText(/replay_unavailable/)).toBeTruthy()
    expect(screen.getByText(/session-1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭该错误' }))
    expect(screen.queryByText('本地历史已恢复，远端补充失败')).toBeNull()
  })

  // #325：技术详情区的码旁边必须有人话解释；未知码保留原文（不编解释、不留空行）。
  test('技术详情区给已知码配人话解释，未知码只留原文', () => {
    addError({
      action: '保存配置', message: '配置写入被拒', code: 'config_revision_conflict',
      scope: { kind: 'app', id: 'settings' }, key: 'settings:save:app',
    })
    addError({
      action: '未知操作', message: '未知失败', code: 'brand_new_failure',
      scope: { kind: 'app', id: 'settings' }, key: 'settings:unknown:app',
    })
    render(() => <ErrorCenter />)
    fireEvent.click(screen.getByRole('button', { name: '查看运行错误' }))

    fireEvent.click(screen.getAllByText('详细信息')[0]!)
    expect(screen.getByText(ERROR_CODE_EXPLANATIONS.config_revision_conflict.summary)).toBeTruthy()
    expect(screen.getByText(ERROR_CODE_EXPLANATIONS.config_revision_conflict.hint!)).toBeTruthy()

    fireEvent.click(screen.getAllByText('详细信息')[1]!)
    expect(screen.getByText(/brand_new_failure/)).toBeTruthy()
    expect(screen.queryByText(/brand_new_failure 的人话/)).toBeNull()
  })

  test('diagnostic 错误不显示全局 badge', () => {
    addError({ action: '恢复会话', message: '仅诊断', visibility: 'diagnostic', severity: 'warning' })
    const { container } = render(() => <ErrorCenter />)
    expect(container.innerHTML).toBe('')
  })

  test('恢复动作拒绝时仍进入同一错误中心且不产生未处理 rejection', async () => {
    addError({
      action: '恢复会话', message: '需要重试', key: 'session-recovery:retry',
      scope: { kind: 'session', id: 'session-recovery' },
      recoveryAction: { label: '重试', run: async () => { throw new Error('重试仍失败') } },
    })
    render(() => <ErrorCenter />)
    fireEvent.click(screen.getByRole('button', { name: '查看运行错误' }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(getErrors()).toHaveLength(2))
    expect(getErrors().find(entry => entry.source === 'error-center.recovery')).toMatchObject({
      message: '重试仍失败', scope: { kind: 'session', id: 'session-recovery' },
    })
  })
})
