/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import { WorkbenchIcon, FileTypeIconSolid } from './fileIcons.solid.tsx'
import { reportRuntimeError } from '../../app/runtimeError'
import { classifyWorkspaceSearchError, normalizeWorkspaceSearchResults, type WorkspaceSearchResult, type WorkspaceSearchSaveStatus } from '../../infrastructure/tauri/workspaceSearchContracts.ts'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/**
 * WorkspaceSearchPanelProps — 名字承自历史 React 契约（WorkspaceSearchPanel.tsx，
 * 已退役）；本实体即唯一真源。
 */
interface WorkspaceSearchPanelProps {
  target: WorkspaceTarget | null
  provider: FileProvider | null
  onOpenResult: (path: string, line: number) => void
}

function highlightedText(text: string, query: string): JSX.Element[] {
  const keyword = query.trim()
  if (!keyword) return [text]
  const lower = text.toLowerCase()
  const needle = keyword.toLowerCase()
  const parts: JSX.Element[] = []
  let cursor = 0
  let index = lower.indexOf(needle)
  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push(<mark>{text.slice(index, index + keyword.length)}</mark>)
    cursor = index + keyword.length
    index = lower.indexOf(needle, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

/** WorkspaceSearchPanel — 工作区全文搜索与横向结果列表（#515 Solid 实体）。 */
export default function WorkspaceSearchPanel(props: WorkspaceSearchPanelProps) {
  const [query, setQuery] = createSignal('')
  const [results, setResults] = createSignal<WorkspaceSearchResult[]>([])
  const [status, setStatus] = createSignal<WorkspaceSearchSaveStatus>({ kind: 'idle' })
  const errorMessage = createMemo(() => {
    const current = status()
    return current.kind === 'error' ? current.message : ''
  })
  let requestContext: SourceRequestContext = { source: null, generation: 0 }
  let searchRequestId = 0
  const targetKey = () => workspaceTargetKey(props.target)

  createEffect(() => {
    const currentTargetKey = targetKey()
    requestContext = advanceSourceContext(requestContext, currentTargetKey)
    searchRequestId += 1
    setResults([])
    setStatus({ kind: 'idle' })
  })

  const search = async () => {
    const currentTarget = props.target
    const currentTargetKey = targetKey()
    const currentProvider = props.provider
    const trimmed = query().trim()
    if (!currentTarget || !currentTargetKey || !currentProvider?.search || !trimmed) return
    const token = beginSourceRequest(requestContext, currentTargetKey)
    const requestId = ++searchRequestId
    setStatus({ kind: 'searching' })
    try {
      const raw = await currentProvider.search(currentTarget, trimmed)
      if (!isCurrentSourceRequest(requestContext, token) || searchRequestId !== requestId) return
      setResults(normalizeWorkspaceSearchResults(raw))
      setStatus({ kind: 'idle' })
    } catch (caught) {
      if (!isCurrentSourceRequest(requestContext, token) || searchRequestId !== requestId) return
      const classified = classifyWorkspaceSearchError(caught)
      setStatus(classified)
      if (classified.kind === 'error') reportRuntimeError('搜索工作区', caught)
    }
  }

  return (
    <div class="file-section-panel file-search-panel">
      <div class="file-search-toolbar">
        <input
          class="file-search-input"
          type="search"
          placeholder="搜索文件内容…"
          value={query()}
          onInput={event => setQuery(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') void search() }}
          aria-label="工作区搜索"
        />
        <button type="button" class="file-search-submit" onClick={() => void search()} disabled={status().kind === 'searching' || !props.target || !props.provider?.search || !query().trim()} aria-label="搜索">
          <WorkbenchIcon name="Search" size={15} />
        </button>
      </div>
      <div class="file-panel-heading"><span>RESULTS</span><span class="file-panel-count">{results().length}</span></div>
      <Show when={status().kind === 'blocked'}>
        <p class="file-section-hint" role="status">后端命令不可用：workspace_search（请检查应用版本）</p>
      </Show>
      <Show when={status().kind === 'error'}>
        <div class="file-tree-error" role="alert">{errorMessage()}</div>
      </Show>
      <Show when={status().kind === 'searching'}><p class="file-section-hint">正在搜索…</p></Show>
      <Show when={status().kind === 'idle' && query().trim() && results().length === 0}>
        <p class="file-section-hint">没有匹配结果</p>
      </Show>
      <ul class="search-result-list">
        <For each={results()}>{result => {
          const fileName = result.path.split('/').pop() || result.path
          return (
            <li>
              <button type="button" class="search-result-row" onClick={() => props.onOpenResult(result.path, result.line)} title={`${result.path}:${result.line}`}>
                <span class="search-result-file">
                  <FileTypeIconSolid path={result.path} size={15} />
                  <span>
                    <strong>{fileName}</strong>
                    <small>L{result.line}</small>
                  </span>
                </span>
                <span class="search-result-text">{highlightedText(result.lineText, query())}</span>
              </button>
            </li>
          )
        }}</For>
      </ul>
    </div>
  )
}
