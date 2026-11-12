/** @jsxImportSource solid-js */
/** Session-owned file browsing and read-only preview. FileSheet remains the editing owner. */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import { createRegistrySignal } from '../../infrastructure/state/solidSheetSupport.solid.tsx'
import { getFileWorkbenchRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { resolveFileProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchResolver.ts'
import { workspaceTargetFromSession, workspaceTargetKey } from '../../domains/workspace/workspaceTarget.ts'
import { openResourceInFileSheet, resolveFileNavigationTarget } from '../../sheets/file/fileSheetNavigation.ts'
import FileTree from '../../sheets/file/FileTree.solid.tsx'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'
import type { WorkspaceTextPreview } from '../../contracts/workspaceFiles.ts'

export default function AgentFileResources(props: {
  session: WorkspaceSession | undefined
  rootPath?: string
  touchedFiles: readonly { path: string }[]
}) {
  const registry = getFileWorkbenchRegistry()
  const snapshot = createRegistrySignal(registry, () => registry.getSnapshot())
  const target = createMemo(() => {
    const current = workspaceTargetFromSession(props.session)
    return current?.workspaceId || current?.legacyWorkdir ? current : null
  })
  const provider = createMemo(() => { snapshot(); return resolveFileProvider(target()) })
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null)
  const [preview, setPreview] = createSignal<WorkspaceTextPreview | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [revision, setRevision] = createSignal(0)

  createEffect(() => {
    workspaceTargetKey(target())
    setSelectedPath(null)
  })
  createEffect(() => {
    const path = selectedPath()
    const currentTarget = target()
    const currentProvider = provider()
    revision()
    const request = new AbortController()
    setPreview(null)
    setError('')
    setLoading(false)
    onCleanup(() => request.abort())
    if (!path || !currentTarget || !currentProvider) return
    setLoading(true)
    void (async () => {
      try {
        const value = await currentProvider.readText(currentTarget, path, request.signal)
        if (request.signal.aborted) return
        setPreview(value)
        if (!value) setError('该文件暂不支持文本预览，可在文件工作台中查看。')
      } catch (reason) {
        if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      } finally { if (!request.signal.aborted) setLoading(false) }
    })()
  })

  const selectFile = (path: string) => {
    const resolved = resolveFileNavigationTarget(path, props.rootPath)
    if (resolved) setSelectedPath(resolved.path)
  }
  const openEditor = () => {
    const path = selectedPath()
    if (path && props.session) openResourceInFileSheet(props.session.id, path)
  }

  return (
    <div class="agent-file-resources min-w-0">
      <Show when={selectedPath()} fallback={
        <>
          <div class="px-1 pb-3">
            <strong class="block truncate text-xs font-semibold text-text">{props.session?.name || '当前工作区'}</strong>
            <p class="mt-1 truncate font-[family-name:var(--mono)] text-[11px] text-text-dim" title={props.rootPath}>{props.rootPath || (target() ? '当前会话工作目录' : '绑定工作目录后即可浏览文件')}</p>
          </div>
          <Show when={target() && provider() && props.touchedFiles.length > 0}>
            <div class="mb-3 border-b border-border pb-2">
              <p class="px-1 py-2 text-[11px] font-semibold text-text-dim">本次关联 · {props.touchedFiles.length}</p>
              <For each={props.touchedFiles.slice(0, 8)}>{file => (
                <button type="button" class="workspace-resource-row text-text" disabled={!resolveFileNavigationTarget(file.path, props.rootPath)} onClick={() => selectFile(file.path)} title={resolveFileNavigationTarget(file.path, props.rootPath) ? file.path : `${file.path}（不在当前工作目录内）`}>
                  <LucideIcon name="FileCode2" size={14} /><span class="min-w-0 truncate">{file.path.replace(/\\/g, '/').split('/').at(-1)}</span>
                </button>
              )}</For>
            </div>
          </Show>
          <Show when={target() && provider()} fallback={
            <div class="agent-context-empty flex flex-col gap-3 px-1 py-5 text-text-dim"><LucideIcon name="FolderTree" size={25} strokeWidth={1.5} /><strong class="text-sm font-medium text-text">{target() ? '文件能力暂不可用' : props.session ? '尚未绑定工作目录' : '选择一个工作区会话'}</strong><p class="text-xs leading-relaxed">{target() ? '当前没有可读取此工作区的文件插件。启用文件能力后可继续浏览。' : '从左侧工作区选择会话，或添加文件夹开始工作。'}</p></div>
          }>
            <FileTree target={target()} provider={provider()} activeFile={null} onOpen={selectFile} />
          </Show>
        </>
      }>
        <div class="mb-3 flex items-center gap-1 border-b border-border pb-2">
          <button type="button" class="workspace-resource-icon" aria-label="返回文件列表" onClick={() => setSelectedPath(null)}><LucideIcon name="ArrowLeft" size={15} /></button>
          <span class="min-w-0 flex-1 truncate text-xs font-medium" title={selectedPath() ?? ''}>{selectedPath()?.replace(/\\/g, '/').split('/').at(-1)}</span>
          <button type="button" class="workspace-resource-icon" aria-label="刷新文件预览" disabled={loading()} onClick={() => setRevision(value => value + 1)}><LucideIcon name="RefreshCw" size={14} /></button>
          <button type="button" class="workspace-resource-icon" aria-label="在文件工作台中编辑" title="在文件工作台中编辑" onClick={openEditor}><LucideIcon name="ArrowUpRight" size={14} /></button>
        </div>
        <p class="mb-3 break-all font-[family-name:var(--mono)] text-[10px] leading-relaxed text-text-dim">{selectedPath()}</p>
        <Show when={loading()}><p role="status" class="py-4 text-xs text-text-dim">正在读取文件…</p></Show>
        <Show when={error()}><p role="alert" class="py-3 text-xs leading-relaxed text-text-dim">{error()}</p></Show>
        <Show when={preview()}>{value => (
          <>
            <div class="mb-2 flex items-center justify-between text-[10px] text-text-dim"><span>只读预览</span><span>{value().encoding} · {value().totalBytes.toLocaleString()} B</span></div>
            <pre class="workspace-resource-preview" tabIndex={0}>{value().content || '（空文件）'}</pre>
            <Show when={value().truncated}><p class="mt-2 text-xs text-text-dim">预览已截断，在文件工作台中查看完整内容。</p></Show>
          </>
        )}</Show>
      </Show>
    </div>
  )
}
