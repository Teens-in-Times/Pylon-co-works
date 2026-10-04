/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { createGitStatus } from './useGitStatus.solid.ts'
import { advanceSourceContext, type SourceRequestContext } from './sourceRequestGuard'
import { classifyGitError, normalizeGitHistory, normalizeGitLogPage, normalizeGitOperationResult, normalizeGitStashList, type GitCommit, type GitCommitGraph, type GitErrorDetail, type GitOperationResult, type GitStash, type GitStatusEntry } from '../../infrastructure/tauri/gitContracts.ts'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { FileTypeIconSolid, WorkbenchIcon } from './fileIcons.solid.tsx'

/**
 * GitPanelProps — 名字承自历史 React 契约（GitPanel.tsx，已退役）；本实体即唯一真源。
 */
interface GitPanelProps {
  target: WorkspaceTarget | null
  provider: GitProvider | null
  onOpenDiff: (path: string, staged: boolean) => void
}

interface GitPathNode {
  key: string
  label: string
  path?: string
  children: GitPathNode[]
  status?: string
}

function gitTree(entries: GitStatusEntry[]): GitPathNode[] {
  const root: GitPathNode[] = []
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean)
    let level = root
    parts.forEach((part, index) => {
      let node = level.find(item => item.label === part)
      if (!node) {
        node = { key: parts.slice(0, index + 1).join('/'), label: part, children: [] }
        level.push(node)
      }
      if (index === parts.length - 1) {
        node.path = entry.path
        node.status = entry.status.trim() || '·'
      }
      level = node.children
    })
  }
  return root
}

/** #368：COMMITS 行的公共结构——history 行（无 parents/refs）与图分页行同构。 */
interface CommitRow {
  hash: string
  author: string
  date: number
  subject: string
  parents?: string[]
  refs?: string
}

/** #368：从 stash ref（`stash@{N}`）解析栈索引；损坏形态回退栈顶 0。 */
function stashIndex(id: string): number {
  const match = /stash@\{(\d+)\}/.exec(id)
  return match ? Number(match[1]) : 0
}

/** #368：%D decorations 拆 chip（`HEAD -> main, origin/main` → 逐段徽标）。 */
function parseRefs(refs: string): string[] {
  return refs.split(',').map(ref => ref.trim()).filter(Boolean)
}

function GitStatusTree(props: {
  entries: () => GitStatusEntry[]
  onOpenDiff: (path: string, staged: boolean) => void
  onMutate?: (path: string) => void
  mutationLabel?: string
  disabled: () => boolean
}) {
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())
  const nodes = createMemo(() => gitTree(props.entries()))
  const toggle = (key: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const render = (items: GitPathNode[], depth: number): JSX.Element => (
    <For each={items}>{node => {
      const folder = node.children.length > 0
      const closed = () => collapsed().has(node.key)
      return (
        <li class="git-tree-node">
          <div class="git-tree-row" style={{ '--git-tree-depth': `${Math.min(depth, 7)}` }}>
            <button type="button" class="git-tree-primary" onClick={() => {
              if (folder) toggle(node.key)
              else if (node.path) props.onOpenDiff(node.path, props.entries().find(entry => entry.path === node.path)?.staged === true)
            }} title={node.path || node.key}>
              <span class="git-tree-caret">{folder ? closed()
                ? <WorkbenchIcon name="ChevronRight" size={13} />
                : <WorkbenchIcon name="ChevronDown" size={13} /> : null}</span>
              {node.path
                ? <FileTypeIconSolid path={node.path} size={14} />
                : <span class="git-tree-folder">{node.label[0]?.toUpperCase()}</span>}
              <span class="git-tree-label">{node.label}</span>
              <Show when={node.status}><span class="git-status-code">{node.status}</span></Show>
            </button>
            <Show when={node.path && props.onMutate && props.mutationLabel}>
              <button type="button" class="git-tree-action" disabled={props.disabled()} aria-label={`${props.mutationLabel} ${node.path}`} title={props.mutationLabel} onClick={() => { if (node.path) props.onMutate?.(node.path) }}>
                {props.mutationLabel === '暂存' ? <WorkbenchIcon name="Plus" size={13} /> : <WorkbenchIcon name="Minus" size={13} />}
              </button>
            </Show>
          </div>
          <Show when={folder && !closed()}>
            <ul class="git-tree-list">{render(node.children, depth + 1)}</ul>
          </Show>
        </li>
      )
    }}</For>
  )
  return <Show when={nodes().length > 0} fallback={<p class="file-section-hint file-section-muted">无变更</p>}>
    <ul class="git-tree-list">{render(nodes(), 0)}</ul>
  </Show>
}

/** GitPanel — 完整 Git 树、状态和提交历史（#515 Solid 实体；行为与 React 版逐行同构）。 */
export default function GitPanel(props: GitPanelProps) {
  // 0-C3：status 数据源收敛到 createGitStatus（行为不变重构）
  const gitStatus = createGitStatus(() => props.target, () => props.provider)
  const statusError = gitStatus.error
  const entries = gitStatus.entries
  const staged = createMemo(() => entries().filter(entry => entry.staged))
  const unstaged = createMemo(() => entries().filter(entry => !entry.staged))
  const [history, setHistory] = createSignal<GitCommit[]>([])
  const [historyError, setHistoryError] = createSignal<GitErrorDetail | null>(null)
  // #368：provider 有 logGraph 时 COMMITS 段走结构化图分页（parents/refs 驱动），
  // null = 无该能力（回退 history()）
  const [graphCommits, setGraphCommits] = createSignal<GitCommitGraph[] | null>(null)
  const [graphHasMore, setGraphHasMore] = createSignal(false)
  // #368：stash 列表（provider.stashList 能力探测）
  const [stashes, setStashes] = createSignal<GitStash[]>([])
  const [expandedCommit, setExpandedCommit] = createSignal<string | null>(null)
  const [commitMessage, setCommitMessage] = createSignal('')
  const [branchDraft, setBranchDraft] = createSignal('')
  const [branchEditorOpen, setBranchEditorOpen] = createSignal(false)
  const [busyAction, setBusyAction] = createSignal<string | null>(null)
  const [feedback, setFeedback] = createSignal<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [refreshRevision, setRefreshRevision] = createSignal(0)
  let requestContext: SourceRequestContext = { source: null, generation: 0 }
  let previousTargetKey: string | null | undefined = undefined
  const targetKey = () => workspaceTargetKey(props.target)
  const errorKey = (action: string) => `git:${targetKey() ?? 'none'}:${action}`

  // #368：结构化图分页页大小（与 history 默认 50 同口径）
  const GRAPH_PAGE_SIZE = 50

  const error = createMemo(() => statusError() ?? historyError())
  // #368：COMMITS 行数据源——图分页优先（含 parents/refs），否则回退 history()
  const visibleCommits = createMemo<CommitRow[]>(() => graphCommits() ?? history())

  const loadGraphPage = async (
    currentTarget: NonNullable<GitPanelProps['target']>,
    currentProvider: NonNullable<GitPanelProps['provider']>,
    skip: number,
    sourceAtStart: string | null,
    append = false,
  ) => {
    try {
      const page = normalizeGitLogPage(await currentProvider.logGraph!(currentTarget, { skip, limit: GRAPH_PAGE_SIZE }))
      if (requestContext.source !== sourceAtStart) return
      setGraphCommits(previous => append && previous ? [...previous, ...page.commits] : page.commits)
      setGraphHasMore(page.hasMore)
      setHistoryError(null)
    } catch (err) {
      if (requestContext.source !== sourceAtStart) return
      // 图日志是增强面而非门面：首页失败回退 history()（历史也失败才进面板错误态），
      // 续页失败保留已加载页可重试——图加载故障不得盖掉工作区树。
      if (append) {
        reportRuntimeError('读取 Git 信息', err, undefined, {
          key: errorKey('读取 Git 信息'),
          scope: { kind: 'sheet', id: `git:${sourceAtStart ?? 'none'}` },
          source: 'git.panel',
        })
        return
      }
      setGraphCommits(null)
      setGraphHasMore(false)
      loadHistory(currentTarget, currentProvider, sourceAtStart)
    }
  }

  const loadHistory = (
    currentTarget: NonNullable<GitPanelProps['target']>,
    currentProvider: NonNullable<GitPanelProps['provider']>,
    sourceAtStart: string | null,
  ) => {
    currentProvider.history(currentTarget).then(historyRaw => {
      if (requestContext.source !== sourceAtStart) return
      setHistory(normalizeGitHistory(historyRaw))
    }).catch(err => {
      if (requestContext.source !== sourceAtStart) return
      setHistoryError(classifyGitError(err))
      reportRuntimeError('读取 Git 信息', err, undefined, {
        key: errorKey('读取 Git 信息'),
        scope: { kind: 'sheet', id: `git:${sourceAtStart ?? 'none'}` },
        source: 'git.panel',
      })
    })
  }

  const refreshStashes = async (
    currentTarget: NonNullable<GitPanelProps['target']>,
    currentProvider: NonNullable<GitPanelProps['provider']>,
    sourceAtStart: string | null,
  ) => {
    if (!currentProvider.stashList) {
      setStashes([])
      return
    }
    try {
      const list = normalizeGitStashList(await currentProvider.stashList(currentTarget))
      if (requestContext.source !== sourceAtStart) return
      setStashes(list)
    } catch (err) {
      if (requestContext.source !== sourceAtStart) return
      setStashes([])
      // 非仓库场景面板已呈现 not-repo 视图，贮藏清单失败不再追加错误中心噪音
      if (classifyGitError(err).kind === 'not-repo') return
      reportRuntimeError('读取贮藏列表', err, undefined, {
        key: errorKey('读取贮藏列表'),
        scope: { kind: 'sheet', id: `git:${sourceAtStart ?? 'none'}` },
        source: 'git.panel',
      })
    }
  }

  createEffect(() => {
    const currentTarget = props.target
    const currentProvider = props.provider
    const currentTargetKey = targetKey()
    void refreshRevision()
    const targetChanged = previousTargetKey !== currentTargetKey
    previousTargetKey = currentTargetKey
    // runMutation 的迟到守卫依赖本 context 的推进（status 拉取已归 createGitStatus）
    requestContext = advanceSourceContext(requestContext, currentTargetKey)
    if (targetChanged) {
      // Status rows and write drafts are workspace-bound. Leaving them visible while
      // the next target loads can execute an A path/message against workspace B.
      setHistory([])
      setExpandedCommit(null)
      setCommitMessage('')
      setBranchDraft('')
      setBranchEditorOpen(false)
      setStashes([])
      setGraphCommits(null)
      setGraphHasMore(false)
    }
    if (!currentTarget || !currentProvider) {
      setHistory([])
      setExpandedCommit(null)
      setCommitMessage('')
      setBranchDraft('')
      setBranchEditorOpen(false)
      setHistoryError(null)
      return
    }
    setHistoryError(null)
    setFeedback(null)
    setBusyAction(null)
    void refreshStashes(currentTarget, currentProvider, currentTargetKey)
    // #368：logGraph 能力探测——有则图分页为 COMMITS 数据源，无则回退 history()
    if (currentProvider.logGraph) {
      void loadGraphPage(currentTarget, currentProvider, 0, currentTargetKey)
      return
    }
    setGraphCommits(null)
    setGraphHasMore(false)
    // 0-C3：status 已由 createGitStatus 拉取，本 effect 只负责 history
    loadHistory(currentTarget, currentProvider, currentTargetKey)
  })

  const runMutation = async (action: string, request: () => Promise<GitOperationResult>, refreshHistory = false) => {
    const currentTarget = props.target
    const currentProvider = props.provider
    if (!currentTarget || !currentProvider || busyAction()) return
    const sourceAtStart = targetKey()
    setBusyAction(action)
    setFeedback(null)
    try {
      const result = normalizeGitOperationResult(await request())
      if (requestContext.source !== sourceAtStart) return
      gitStatus.applyStatus(result.status)
      if (refreshHistory) {
        // #368：logGraph 能力下 COMMITS 数据源是图分页，刷新走 loadGraphPage 归零
        if (currentProvider.logGraph) {
          await loadGraphPage(currentTarget, currentProvider, 0, sourceAtStart)
        } else {
          const nextHistory = normalizeGitHistory(await currentProvider.history(currentTarget))
          if (requestContext.source !== sourceAtStart) return
          setHistory(nextHistory)
        }
      }
      setFeedback({ kind: 'success', message: result.summary || `${action}完成` })
      resolveRuntimeErrors({ key: `git:${sourceAtStart ?? 'none'}:${action}` })
      if (action === '提交') setCommitMessage('')
      if (action === '创建分支' || action === '切换分支' || action === '删除分支') {
        setBranchDraft('')
        setBranchEditorOpen(false)
      }
    } catch (cause) {
      if (requestContext.source !== sourceAtStart) return
      setFeedback({ kind: 'error', message: '操作失败，详情见右下角错误中心' })
      reportRuntimeError(action, cause, undefined, {
        key: `git:${sourceAtStart ?? 'none'}:${action}`,
        scope: { kind: 'sheet', id: `git:${sourceAtStart ?? 'none'}` },
        source: 'git.panel',
      })
    } finally {
      if (requestContext.source === sourceAtStart) setBusyAction(null)
    }
  }

  // #368：stash 变更后同步刷新贮藏列表（push/pop 都改变列表内容）
  const runStashMutation = (action: string, request: () => Promise<GitOperationResult>) => {
    void runMutation(action, request).then(() => {
      const currentTarget = props.target
      const currentProvider = props.provider
      if (currentTarget && currentProvider) void refreshStashes(currentTarget, currentProvider, targetKey())
    })
  }

  const loadMoreCommits = () => {
    const currentTarget = props.target
    const currentProvider = props.provider
    if (!currentTarget || !currentProvider?.logGraph) return
    void loadGraphPage(currentTarget, currentProvider, graphCommits()?.length ?? 0, targetKey(), true)
  }

  const writable = createMemo(() => Boolean(props.provider?.stage || props.provider?.unstage || props.provider?.commit || props.provider?.createBranch || props.provider?.switchBranch || props.provider?.pull || props.provider?.push))

  const viewMode = createMemo<'no-provider' | 'not-repo' | 'error' | 'ready'>(() => {
    if (!props.target || !props.provider) return 'no-provider'
    const currentError = error()
    if (currentError?.kind === 'not-repo') return 'not-repo'
    if (currentError) return 'error'
    return 'ready'
  })

  const stageSection = () => (
    <section class="git-section">
      <div class="file-panel-heading"><span>STAGED</span><span class="file-panel-count">{staged().length}</span>
        <Show when={props.provider?.unstage && staged().length > 0}>
          <button type="button" class="git-section-action" disabled={Boolean(busyAction())} onClick={() => void runMutation('取消暂存', () => props.provider!.unstage!(props.target!, staged().map(entry => entry.path)))}>全部取消</button>
        </Show>
      </div>
      <GitStatusTree entries={staged} onOpenDiff={props.onOpenDiff} onMutate={props.provider?.unstage ? path => void runMutation('取消暂存', () => props.provider!.unstage!(props.target!, [path])) : undefined} mutationLabel="取消暂存" disabled={() => Boolean(busyAction())} />
    </section>
  )

  const unstagedSection = () => (
    <section class="git-section">
      <div class="file-panel-heading"><span>WORKING TREE</span><span class="file-panel-count">{unstaged().length}</span>
        <Show when={props.provider?.stage && unstaged().length > 0}>
          <button type="button" class="git-section-action" disabled={Boolean(busyAction())} onClick={() => void runMutation('暂存', () => props.provider!.stage!(props.target!, unstaged().map(entry => entry.path)))}>全部暂存</button>
        </Show>
      </div>
      <GitStatusTree entries={unstaged} onOpenDiff={props.onOpenDiff} onMutate={props.provider?.stage ? path => void runMutation('暂存', () => props.provider!.stage!(props.target!, [path])) : undefined} mutationLabel="暂存" disabled={() => Boolean(busyAction())} />
    </section>
  )

  const readyPanel = () => (
    <div class="file-section-panel git-panel">
      <div class="git-summary-card">
        <WorkbenchIcon name="GitBranch" size={17} />
        <div><span class="git-summary-kicker">REPOSITORY</span><strong>{gitStatus.branchName() ?? '—'}</strong></div>
        <span class="file-panel-count">{staged().length + unstaged().length}</span>
      </div>
      <div class="git-command-bar" aria-label="Git 操作">
        <button type="button" disabled={Boolean(busyAction())} onClick={() => { gitStatus.refresh(); setRefreshRevision(value => value + 1) }} title="刷新"><WorkbenchIcon name="RefreshCw" size={14} /></button>
        <Show when={props.provider?.pull}><button type="button" disabled={Boolean(busyAction())} onClick={() => void runMutation('拉取', () => props.provider!.pull!(props.target!), true)}><WorkbenchIcon name="Download" size={14} />拉取</button></Show>
        <Show when={props.provider?.push}><button type="button" disabled={Boolean(busyAction())} onClick={() => void runMutation('推送', () => props.provider!.push!(props.target!))}><WorkbenchIcon name="Upload" size={14} />推送</button></Show>
        <Show when={props.provider?.stashPush}>
          <button type="button" disabled={Boolean(busyAction())} onClick={() => runStashMutation('贮藏', () => props.provider!.stashPush!(props.target!))} title="贮藏工作区变更"><WorkbenchIcon name="Archive" size={14} />贮藏</button>
        </Show>
        <Show when={props.provider?.createBranch || props.provider?.switchBranch || props.provider?.deleteBranch}>
          <button type="button" class={branchEditorOpen() ? 'active' : ''} disabled={Boolean(busyAction())} aria-expanded={branchEditorOpen()} onClick={() => setBranchEditorOpen(value => !value)}><WorkbenchIcon name="GitBranch" size={14} />分支</button>
        </Show>
      </div>
      <Show when={branchEditorOpen()}>
        <form class="git-branch-editor" onSubmit={event => {
          event.preventDefault()
          if (props.provider?.createBranch && branchDraft().trim()) void runMutation('创建分支', () => props.provider!.createBranch!(props.target!, branchDraft()))
        }}>
          <label for="git-branch-name">分支名称</label>
          <input id="git-branch-name" value={branchDraft()} onInput={event => setBranchDraft(event.currentTarget.value)} placeholder="feature/name" autocomplete="off" />
          <div>
            <Show when={props.provider?.createBranch}><button type="submit" disabled={Boolean(busyAction()) || !branchDraft().trim()}>创建并切换</button></Show>
            <Show when={props.provider?.switchBranch}><button type="button" disabled={Boolean(busyAction()) || !branchDraft().trim()} onClick={() => void runMutation('切换分支', () => props.provider!.switchBranch!(props.target!, branchDraft()))}>切换已有分支</button></Show>
            {/* #368：删除走后端「未落地工作」保护（未并入/树不等的分支被拒并回显原因） */}
            <Show when={props.provider?.deleteBranch}>
              <button type="button" class="git-branch-delete" disabled={Boolean(busyAction()) || !branchDraft().trim()} onClick={() => void runMutation('删除分支', () => props.provider!.deleteBranch!(props.target!, branchDraft()))}>删除分支</button>
            </Show>
          </div>
        </form>
      </Show>
      <Show when={feedback()}>
        <div class={`git-feedback ${feedback()!.kind}`} role="status">{feedback()!.message}</div>
      </Show>
      <Show when={writable() && props.provider?.commit}>
        <form class="git-commit-box" onSubmit={event => {
          event.preventDefault()
          if (commitMessage().trim()) void runMutation('提交', () => props.provider!.commit!(props.target!, commitMessage()), true)
        }}>
          <label for="git-commit-message">提交说明</label>
          <textarea id="git-commit-message" rows={3} maxLength={10_000} value={commitMessage()} onInput={event => setCommitMessage(event.currentTarget.value)} placeholder="说明本次变更…" />
          <button type="submit" disabled={Boolean(busyAction()) || staged().length === 0 || !commitMessage().trim()}>{busyAction() === '提交' ? '提交中…' : `提交 ${staged().length} 项变更`}</button>
        </form>
      </Show>
      {stageSection()}
      {unstagedSection()}
      <Show when={props.provider?.stashList}>
        <section class="git-section">
          <div class="file-panel-heading"><span>STASHES</span><span class="file-panel-count">{stashes().length}</span></div>
          <Show when={stashes().length > 0} fallback={<p class="file-section-hint file-section-muted">无贮藏</p>}>
            <ul class="git-stash-list">
              <For each={stashes()}>{stash => (
                <li class="git-stash-row">
                  <span class="git-stash-id">{stash.id}</span>
                  <span class="git-stash-subject" title={stash.subject}>{stash.subject}</span>
                  <Show when={props.provider?.stashPop}>
                    <button type="button" class="git-tree-action" disabled={Boolean(busyAction())} aria-label={`恢复 ${stash.id}`} title="恢复此贮藏到工作区" onClick={() => runStashMutation('恢复贮藏', () => props.provider!.stashPop!(props.target!, stashIndex(stash.id)))}>
                      <WorkbenchIcon name="RotateCcw" size={13} />
                    </button>
                  </Show>
                </li>
              )}</For>
            </ul>
          </Show>
        </section>
      </Show>
      <section class="git-section">
        <div class="file-panel-heading"><span>COMMITS</span><span class="file-panel-count">{visibleCommits().length}</span></div>
        <ul class="git-history-list">
          <For each={visibleCommits()}>{commit => (
            <li class={`git-history-row ${expandedCommit() === commit.hash ? 'expanded' : ''}`}>
              <button type="button" class="git-history-head" aria-expanded={expandedCommit() === commit.hash} onClick={() => setExpandedCommit(current => current === commit.hash ? null : commit.hash)}>
                <span class="git-history-caret">{expandedCommit() === commit.hash ? <WorkbenchIcon name="ChevronDown" size={13} /> : <WorkbenchIcon name="ChevronRight" size={13} />}</span>
                <Show when={commit.parents && commit.parents.length > 1} fallback={<WorkbenchIcon name="GitCommitHorizontal" size={14} />}>
                  <WorkbenchIcon name="GitMerge" size={14} />
                </Show>
                <span class="git-history-subject" title={commit.subject}>{commit.subject || '无提交说明'}</span>
                <Show when={commit.refs}>
                  <span class="git-history-refs">
                    <For each={parseRefs(commit.refs ?? '')}>{ref => <span class="git-history-ref" title={ref}>{ref}</span>}</For>
                  </span>
                </Show>
                <span class="git-history-hash">{commit.hash.slice(0, 7)}</span>
              </button>
              <Show when={expandedCommit() === commit.hash}>
                <div class="git-history-detail">
                  <span><strong>COMMIT</strong>{commit.hash}</span>
                  <span><strong>AUTHOR</strong>{commit.author || '—'}</span>
                  <span><strong>DATE</strong>{commit.date ? new Date(commit.date * 1000).toLocaleString() : '—'}</span>
                  <Show when={commit.parents && commit.parents.length > 0}>
                    <span><strong>PARENTS</strong>{commit.parents!.map(parent => parent.slice(0, 7)).join(' ')}</span>
                  </Show>
                </div>
              </Show>
            </li>
          )}</For>
        </ul>
        <Show when={graphCommits() && graphHasMore()}>
          <button type="button" class="git-history-more" disabled={Boolean(busyAction())} onClick={loadMoreCommits}>加载更多</button>
        </Show>
      </section>
    </div>
  )

  return (
    <Show when={viewMode()} keyed>
      {mode => {
        if (mode === 'no-provider') return <div class="file-section-panel"><p class="file-section-hint">未安装可用的 Git provider</p></div>
        if (mode === 'not-repo') return <div class="file-section-panel"><p class="file-section-hint">当前工作区不是 Git 仓库</p></div>
        if (mode === 'error') return <div class="file-section-panel"><p class="file-section-hint file-tree-error-reference" role="status">Git 信息读取失败，详情见右下角错误中心</p></div>
        return readyPanel()
      }}
    </Show>
  )
}
