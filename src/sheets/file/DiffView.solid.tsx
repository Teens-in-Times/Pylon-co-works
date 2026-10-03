/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { reportRuntimeError } from '../../app/runtimeError'
import { classifyGitError } from '../../infrastructure/tauri/gitContracts.ts'
import { SolidDiffCard } from '../../renderers/solid-workbench/chat/DiffCard.solid.tsx'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/**
 * DiffViewProps — 名字承自历史 React 契约（DiffView.tsx，已退役）；本实体即唯一真源。
 */
interface DiffViewProps {
  target: WorkspaceTarget | null
  provider: GitProvider | null
  path: string
  staged: boolean
  onClose: () => void
}

/**
 * DiffView — Git diff 展示（W2-05；#515 Solid 实体）。
 *
 * 点击 staged/unstaged 条目 → git_diff(source, path, staged) → 复用 DiffCard
 * （DiffPayload 统一渲染，不新造 diff 渲染器）。只读。DiffCard 唯一实体是
 * solid-workbench 的 `SolidDiffCard`（原 React components/file/DiffCard.tsx 已随
 * #515 判重退役）。
 */
export default function DiffView(props: DiffViewProps) {
  const [output, setOutput] = createSignal('')
  const [error, setError] = createSignal('')
  let requestContext: SourceRequestContext = { source: null, generation: 0 }
  const targetKey = () => workspaceTargetKey(props.target)

  createEffect(() => {
    const currentTarget = props.target
    const currentTargetKey = targetKey()
    const currentProvider = props.provider
    const currentPath = props.path
    const currentStaged = props.staged
    void currentPath
    void currentStaged
    requestContext = advanceSourceContext(requestContext, currentTargetKey)
    if (!currentTarget || !currentTargetKey || !currentProvider) return
    const token = beginSourceRequest(requestContext, currentTargetKey)
    let disposed = false
    setOutput('')
    setError('')
    currentProvider.diff(currentTarget, { path: currentPath, staged: currentStaged }).then(text => {
      if (!disposed && isCurrentSourceRequest(requestContext, token)) setOutput(typeof text === 'string' ? text : '')
    }).catch(err => {
      if (disposed || !isCurrentSourceRequest(requestContext, token)) return
      setError(classifyGitError(err).message)
      reportRuntimeError('读取 Git diff', err)
    })
    onCleanup(() => { disposed = true })
  })

  return (
    <div class="git-diff-view">
      <div class="git-diff-head">
        <span class="git-diff-path">{props.path}（{props.staged ? 'staged' : 'unstaged'}）</span>
        <button type="button" class="git-diff-close" onClick={() => props.onClose()} aria-label="关闭 diff">✕</button>
      </div>
      <Show when={error()} fallback={<SolidDiffCard output={output()} />}>
        <div class="file-tree-error" role="alert">{error()}</div>
      </Show>
    </div>
  )
}
