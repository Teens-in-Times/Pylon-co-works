// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within, cleanup } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import type { GitOperationResult, GitStatusWithBranch } from '../../../infrastructure/tauri/gitContracts.ts'
import type { GitProvider } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { WorkspaceTarget } from '../../../domains/workspace/workspaceTarget.ts'
import GitPanel from '../GitPanel.solid.tsx'
import { reportRuntimeError } from '../../../app/runtimeError.ts'

afterEach(() => cleanup())

// #515：迁移自 gitPanelMutations.test.tsx（React RTL → Solid 实体直连）。
// 断言改写点登记：
// 1. render(<JSX/>) → render(() => JSX)；rerender(nextProps) → 信号驱动
//    （setTargetSignal 切 workspace，等价 React 父组件重渲染）；
// 2. fireEvent.change → fireEvent.input（Solid onInput ≡ React onChange 的即时输入流）。
// 其余断言集与 DOM 契约不变。

vi.mock('../../../app/runtimeError', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))

const target: WorkspaceTarget = {
  sessionId: 'session-a',
  agentId: 'agent-a',
  source: 'source-a',
  legacyWorkdir: 'C:/repo',
}

const branch = { branch: 'main', detached: false, head: 'abc123' }
const status = (entries: GitStatusWithBranch['entries'], name = 'main'): GitStatusWithBranch => ({
  branch: { ...branch, branch: name },
  entries,
})
const result = (next: GitStatusWithBranch, summary: string): GitOperationResult => ({ status: next, summary })

function provider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    id: 'test.git',
    canHandle: () => true,
    status: vi.fn().mockResolvedValue(status([{ path: 'src/a.ts', status: ' M', staged: false }])),
    history: vi.fn().mockResolvedValue([]),
    diff: vi.fn().mockResolvedValue('diff'),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function renderGitPanel(initialTarget: WorkspaceTarget, git: GitProvider) {
  const [targetSignal, setTargetSignal] = createSignal<WorkspaceTarget>(initialTarget)
  render(() => <GitPanel target={targetSignal()} provider={git} onOpenDiff={vi.fn()} />)
  return setTargetSignal
}

describe('GitPanel 写操作', () => {
  beforeEach(() => vi.clearAllMocks())

  it('按文件暂存并用操作回执原子刷新分区', async () => {
    const stage = vi.fn().mockResolvedValue(result(status([{ path: 'src/a.ts', status: 'M ', staged: true }]), '已暂存'))
    const git = provider({ stage })
    render(() => <GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '暂存 src/a.ts' }))
    await waitFor(() => expect(stage).toHaveBeenCalledWith(target, ['src/a.ts']))
    expect(await screen.findByRole('status')).toHaveTextContent('已暂存')
    expect(within(screen.getByText('STAGED').closest('section')!).getByTitle('src/a.ts')).toBeTruthy()
  })

  it('提交只在有暂存内容且说明非空时启用，并刷新历史', async () => {
    const initial = status([{ path: 'a.ts', status: 'M ', staged: true }])
    const commit = vi.fn().mockResolvedValue(result(status([]), '提交成功'))
    const history = vi.fn().mockResolvedValue([{ hash: 'abcdef123', author: 'Pylon', date: 1, subject: 'done' }])
    const git = provider({ status: vi.fn().mockResolvedValue(initial), commit, history })
    render(() => <GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    const submit = await screen.findByRole('button', { name: '提交 1 项变更' })
    expect(submit).toBeDisabled()
    fireEvent.input(screen.getByLabelText('提交说明'), { target: { value: 'describe change' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(commit).toHaveBeenCalledWith(target, 'describe change'))
    await screen.findByText('done')
    expect(screen.getByLabelText('提交说明')).toHaveValue('')
  })

  it('创建/切换分支与 pull/push 都经 provider 能力调用', async () => {
    const createBranch = vi.fn().mockResolvedValue(result(status([], 'feature/gui'), '已创建分支'))
    const switchBranch = vi.fn().mockResolvedValue(result(status([], 'main'), '已切换分支'))
    const pull = vi.fn().mockResolvedValue(result(status([], '已经是最新版本'), '已是最新'))
    const push = vi.fn().mockResolvedValue(result(status([], 'main'), '推送完成'))
    const git = provider({ createBranch, switchBranch, pull, push })
    render(() => <GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '分支' }))
    fireEvent.input(screen.getByLabelText('分支名称'), { target: { value: 'feature/gui' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并切换' }))
    await waitFor(() => expect(createBranch).toHaveBeenCalledWith(target, 'feature/gui'))
    await screen.findByText('feature/gui')

    fireEvent.click(screen.getByRole('button', { name: '拉取' }))
    await waitFor(() => expect(pull).toHaveBeenCalledWith(target))
    // pull 调用记录先于事务收敛（busy 复位在 await 续体里）；busy 未清时写操作按钮
    // 仍禁用，点击会被吞。等按钮恢复可点再继续——React 版靠 act 冲刷掩盖了这一拍。
    await waitFor(() => expect(screen.getByRole('button', { name: '推送' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '推送' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith(target))
    await waitFor(() => expect(screen.getByRole('button', { name: '分支' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: '分支' }))
    fireEvent.input(screen.getByLabelText('分支名称'), { target: { value: 'main' } })
    fireEvent.click(screen.getByRole('button', { name: '切换已有分支' }))
    await waitFor(() => expect(switchBranch).toHaveBeenCalledWith(target, 'main'))
  })

  it('只读 provider 不渲染写入口，diff 行为保持可用', async () => {
    const onOpenDiff = vi.fn()
    render(() => <GitPanel target={target} provider={provider()} onOpenDiff={onOpenDiff} />)
    fireEvent.click(await screen.findByTitle('src/a.ts'))
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts', false)
    expect(screen.queryByLabelText('提交说明')).toBeNull()
    expect(screen.queryByRole('button', { name: '推送' })).toBeNull()
  })

  it('切换 workspace 后忽略旧 Git 写操作的迟到失败', async () => {
    const operation = deferred<GitOperationResult>()
    const stage = vi.fn(() => operation.promise)
    const git = provider({ stage })
    const setTarget = renderGitPanel(target, git)
    fireEvent.click(await screen.findByRole('button', { name: '暂存 src/a.ts' }))

    const nextTarget = { ...target, sessionId: 'session-b', source: 'source-b', legacyWorkdir: 'C:/repo-b' }
    setTarget(nextTarget)
    operation.reject(new Error('stale workspace failure'))
    await waitFor(() => expect(screen.getByText('WORKING TREE')).toBeTruthy())

    expect(screen.queryByText('stale workspace failure')).toBeNull()
    expect(reportRuntimeError).not.toHaveBeenCalledWith('暂存', expect.anything())
  })

  it('切换 workspace 会清空提交与分支草稿，避免把 A 的写入意图带到 B', async () => {
    const git = provider({
      status: vi.fn().mockResolvedValue(status([{ path: 'a.ts', status: 'M ', staged: true }])),
      commit: vi.fn().mockResolvedValue(result(status([]), 'ok')),
      createBranch: vi.fn().mockResolvedValue(result(status([]), 'ok')),
    })
    const setTarget = renderGitPanel(target, git)
    await screen.findByRole('button', { name: '提交 1 项变更' })
    fireEvent.input(screen.getByLabelText('提交说明'), { target: { value: 'workspace a commit' } })
    fireEvent.click(screen.getByRole('button', { name: '分支' }))
    fireEvent.input(screen.getByLabelText('分支名称'), { target: { value: 'workspace-a-branch' } })

    const nextTarget = { ...target, sessionId: 'session-b', source: 'source-b', legacyWorkdir: 'C:/repo-b' }
    setTarget(nextTarget)

    await waitFor(() => expect(screen.getByLabelText('提交说明')).toHaveValue(''))
    expect(screen.queryByDisplayValue('workspace-a-branch')).toBeNull()
  })

  // ── #368：stash 三件套 / 删分支 / 结构化 log 图 ─────────────────────────

  it('stash：列表渲染，pop 按解析索引调用并刷新列表，push 走能力调用', async () => {
    const stashList = vi.fn()
      .mockResolvedValueOnce([{ id: 'stash@{0}', subject: 'WIP on main: a1b2c3d subject' }])
      .mockResolvedValue([])
    const stashPop = vi.fn().mockResolvedValue(result(status([]), 'restored'))
    const stashPush = vi.fn().mockResolvedValue(result(status([]), 'Saved'))
    const git = provider({ stashList, stashPop, stashPush })
    render(() => <GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    await screen.findByText('WIP on main: a1b2c3d subject')
    expect(stashList).toHaveBeenCalledWith(target)

    fireEvent.click(screen.getByRole('button', { name: '恢复 stash@{0}' }))
    await waitFor(() => expect(stashPop).toHaveBeenCalledWith(target, 0))
    // pop 成功后贮藏列表刷新 → 条目消失
    await waitFor(() => expect(screen.queryByText('WIP on main: a1b2c3d subject')).toBeNull())

    await waitFor(() => expect(screen.getByRole('button', { name: '贮藏' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '贮藏' }))
    await waitFor(() => expect(stashPush).toHaveBeenCalledWith(target))
    await waitFor(() => expect(stashList).toHaveBeenCalledTimes(3))
  })

  it('logGraph：refs 徽标 + merge 指示 + 加载更多续页；history 不再作为数据源', async () => {
    const logGraph = vi.fn()
      .mockResolvedValueOnce({
        commits: [
          { hash: 'aaaaaaaaaaa', parents: ['bbbbbbbbbbb', 'ccccccccccc'], author: 'P', date: 1700000000, subject: 'merge side', refs: 'HEAD -> main, origin/main' },
        ],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        commits: [
          { hash: 'ddddddddddd', parents: [], author: 'P', date: 1700000001, subject: 'root', refs: '' },
        ],
        hasMore: false,
      })
    const history = vi.fn().mockResolvedValue([])
    const git = provider({ logGraph, history })
    render(() => <GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    await screen.findByText('merge side')
    expect(logGraph).toHaveBeenCalledWith(target, { skip: 0, limit: 50 })
    expect(screen.getByText('HEAD -> main')).toBeTruthy()
    expect(screen.getByText('origin/main')).toBeTruthy()
    expect(history).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(logGraph).toHaveBeenLastCalledWith(target, { skip: 1, limit: 50 }))
    await screen.findByText('root')
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it('删除分支经能力调用，成功后草稿清空且编辑器收起', async () => {
    const deleteBranch = vi.fn().mockResolvedValue(result(status([]), '已删除分支 feature/a'))
    const git = provider({ deleteBranch })
    render(() => <GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '分支' }))
    const del = screen.getByRole('button', { name: '删除分支' })
    expect(del).toBeDisabled()
    fireEvent.input(screen.getByLabelText('分支名称'), { target: { value: 'feature/a' } })
    expect(del).toBeEnabled()
    fireEvent.click(del)
    await waitFor(() => expect(deleteBranch).toHaveBeenCalledWith(target, 'feature/a'))
    await waitFor(() => expect(screen.queryByLabelText('分支名称')).toBeNull())
  })

  it('能力缺失时 stash/删除/图入口不渲染（设计好的降级路径）', async () => {
    const git = provider({ createBranch: vi.fn().mockResolvedValue(result(status([]), 'ok')) })
    render(() => <GitPanel target={target} provider={git} onOpenDiff={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '分支' }))
    await screen.findByLabelText('分支名称')
    expect(screen.queryByRole('button', { name: '删除分支' })).toBeNull()
    expect(screen.queryByRole('button', { name: '贮藏' })).toBeNull()
    expect(screen.queryByText('STASHES')).toBeNull()
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })
})
