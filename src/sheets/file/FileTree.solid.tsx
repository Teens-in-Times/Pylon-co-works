/** @jsxImportSource solid-js */
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'
import { classifyWorkspaceError, mergeWorkspaceEntries } from '../../infrastructure/tauri/workspaceContracts.ts'
import type { WorkspaceEntry } from '../../components/right-panel/rightPanelTypes'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { FileTypeIconSolid, WorkbenchIcon } from './fileIcons.solid.tsx'
import EmptyState from '../../components/ui/EmptyState.solid.tsx'

/**
 * FileTreeProps — 名字承自历史 React 契约（FileTree.tsx，已退役）；本实体即唯一真源。
 */
interface FileTreeProps {
  target: WorkspaceTarget | null
  provider: FileProvider | null
  activeFile: string | null
  onOpen: (path: string) => void
}

/**
 * FileTree — 懒加载、可双向折叠的工作区文件树（#515 Solid 实体）。
 *
 * 已加载子树保留在内存，折叠只隐藏 descendants；再次展开不重复请求。缩进封顶并强制
 * label ellipsis，深层目录不会撑宽 FileSheet 左栏。行为与 React 版逐行同构：source
 * guard 防串 workspace、错误上报 key、`file-tree:*` 类名与空态文案逐项保留。
 */
export default function FileTree(props: FileTreeProps) {
  const [tree, setTree] = createSignal<{ entries: readonly WorkspaceEntry[]; selectedPath: string | null }>({ entries: [], selectedPath: null })
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [loading, setLoading] = createSignal<Set<string>>(new Set())
  const [error, setError] = createSignal('')
  let requestContext: SourceRequestContext = { source: null, generation: 0 }
  const targetKey = () => workspaceTargetKey(props.target)
  const errorKey = (relativePath = '') => `file-tree:${targetKey() ?? 'none'}:${relativePath}`

  const load = async (relativePath?: string) => {
    const currentTarget = props.target
    const currentTargetKey = targetKey()
    const currentProvider = props.provider
    if (!currentTarget || !currentTargetKey || !currentProvider) return
    const token = beginSourceRequest(requestContext, currentTargetKey)
    const key = relativePath ?? ''
    setLoading(previous => new Set(previous).add(key))
    try {
      const entries = await currentProvider.listEntries(currentTarget, relativePath ?? '')
      if (!isCurrentSourceRequest(requestContext, token)) return
      setTree(previous => relativePath
        ? { entries: mergeWorkspaceEntries(previous.entries, relativePath, entries), selectedPath: previous.selectedPath }
        : { entries, selectedPath: previous.selectedPath })
      setError('')
      resolveRuntimeErrors({ key: errorKey(relativePath ?? '') })
    } catch (err) {
      if (!isCurrentSourceRequest(requestContext, token)) return
      setError(classifyWorkspaceError(err).message)
      reportRuntimeError('读取工作区', err, undefined, {
        key: errorKey(relativePath ?? ''),
        scope: { kind: 'sheet', id: `file-tree:${currentTargetKey ?? 'none'}` },
        source: 'file.tree',
      })
    } finally {
      if (isCurrentSourceRequest(requestContext, token)) {
        setLoading(previous => {
          const next = new Set(previous)
          next.delete(key)
          return next
        })
      }
    }
  }

  // 目标变化 → 全量重置 + 根目录读取（React 版 effect deps [load, targetKey] 同语义）；
  // 卸载/切换推进 source guard 使在途请求失效。
  createEffect(() => {
    requestContext = advanceSourceContext(requestContext, targetKey())
    setTree({ entries: [], selectedPath: null })
    setExpanded(new Set<string>())
    setLoading(new Set<string>())
    setError('')
    void load()
    onCleanup(() => {
      requestContext = advanceSourceContext(requestContext, null)
    })
  })

  const refresh = () => {
    if (!props.target || !props.provider || loading().has('')) return
    requestContext = advanceSourceContext(requestContext, targetKey())
    setTree({ entries: [], selectedPath: null })
    setExpanded(new Set<string>())
    setLoading(new Set<string>())
    setError('')
    void load()
  }

  const toggleFolder = async (entry: WorkspaceEntry) => {
    if (expanded().has(entry.path)) {
      setExpanded(previous => {
        const next = new Set(previous)
        next.delete(entry.path)
        return next
      })
      return
    }
    if (!entry.entries) await load(entry.path)
    setExpanded(previous => new Set(previous).add(entry.path))
  }

  const openFile = (path: string) => {
    if (!props.target || !props.provider) return
    setTree(previous => ({ ...previous, selectedPath: path }))
    // FileTabView is the single owner of file reads, request guarding and errors.
    // Pre-reading here doubled IPC and could surface a stale error after target switch.
    props.onOpen(path)
  }

  const renderEntries = (entries: readonly WorkspaceEntry[], depth: number): JSX.Element => (
    <For each={entries}>{entry => {
      const isFolder = entry.kind === 'folder'
      const isExpanded = () => expanded().has(entry.path)
      const isLoading = () => loading().has(entry.path)
      const isActive = () => !isFolder && (props.activeFile === entry.path || tree().selectedPath === entry.path)
      return (
        <div class="file-tree-node">
          <button
            type="button"
            class={`file-tree-row ${isFolder ? 'file-tree-folder' : 'file-tree-file'} ${isActive() ? 'active' : ''}`}
            style={{ '--file-tree-depth': `${Math.min(depth, 8)}` }}
            onClick={() => isFolder ? void toggleFolder(entry) : openFile(entry.path)}
            title={entry.path}
            aria-expanded={isFolder ? isExpanded() : undefined}
          >
            <span class={`file-tree-caret ${!isFolder ? 'file-tree-caret-spacer' : ''}`} aria-hidden="true">
              {isFolder ? (isLoading() ? '…' : isExpanded()
                ? <WorkbenchIcon name="ChevronDown" size={14} />
                : <WorkbenchIcon name="ChevronRight" size={14} />) : ''}
            </span>
            <span class="file-tree-kind" aria-hidden="true">
              {isFolder
                ? isExpanded() ? <WorkbenchIcon name="FolderOpen" size={15} /> : <WorkbenchIcon name="Folder" size={15} />
                : <FileTypeIconSolid path={entry.path} size={14} />}
            </span>
            <span class="file-tree-label">{entry.label}</span>
          </button>
          <Show when={isFolder && isExpanded() && entry.entries}>
            <div class="file-tree-children">{renderEntries(entry.entries!, depth + 1)}</div>
          </Show>
        </div>
      )
    }}</For>
  )

  return (
    <div class="file-tree">
      <div class="file-panel-heading">
        <span>EXPLORER</span>
        <span class="file-panel-count">{tree().entries.length}</span>
        <button type="button" class="file-tree-refresh" aria-label="刷新文件树" title="刷新文件树" disabled={!props.target || !props.provider || loading().has('')} onClick={refresh}>
          <WorkbenchIcon name="RefreshCw" size={13} />
        </button>
      </div>
      <Show when={error()}>
        <p class="file-section-hint file-tree-error-reference" role="status">文件树读取失败，详情见右下角错误中心</p>
      </Show>
      <Show when={!props.target || !props.provider}>
        <EmptyState class="file-tree-empty-state" title="尚未选择工作区" hint="先从会话分区选择一个工作区会话，再浏览文件。" />
      </Show>
      <Show when={props.target && tree().entries.length === 0 && !error() && !loading().has('')}>
        <EmptyState class="file-tree-empty-state" title="工作区为空" hint="当前工作区没有可浏览的文件。" />
      </Show>
      <div class="file-tree-rows">{renderEntries(tree().entries, 0)}</div>
    </div>
  )
}
