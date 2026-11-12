/** @jsxImportSource solid-js */
/** Canonical artifact inspector; arbitrary HTML is displayed as source, never executed. */
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import AgentResourceMedia from './AgentResourceMedia.solid.tsx'
import { openResourceInFileSheet, resolveFileNavigationTarget } from '../../sheets/file/fileSheetNavigation.ts'
import { resourcePreviewMedia, resourcePreviewText, resourceWebUrl, type WorkspaceResource } from './workspaceResources.ts'

export default function AgentArtifactResources(props: {
  sessionId: string | null
  rootPath?: string
  resources: readonly WorkspaceResource[]
  onOpenBrowser: (url: string) => void
}) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [limit, setLimit] = createSignal(30)
  const selected = createMemo(() => props.resources.find(resource => resource.id === selectedId()))
  createEffect(() => { void props.sessionId; setSelectedId(null); setLimit(30) })
  const typeLabel = (resource: WorkspaceResource) => ({ artifact: '成果', document: '文档', resource: '资源', image: '图片', audio: '音频', video: '视频' }[resource.kind])

  return (
    <Show when={selected()} fallback={
      <>
        <div class="flex items-center justify-between px-1 pb-3"><strong class="text-xs font-semibold">会话成果</strong><span class="text-[11px] text-text-dim">{props.resources.length}</span></div>
        <Show when={props.resources.length > 0} fallback={
          <div class="agent-context-empty flex flex-col gap-3 px-1 py-5 text-text-dim"><LucideIcon name="SquareStack" size={25} strokeWidth={1.5} /><strong class="text-sm font-medium text-text">成果会出现在这里</strong><p class="text-xs leading-relaxed">Agent 返回的文档、图片和结构化成果会汇集到这里，可以一边对话一边查看。</p></div>
        }>
          <For each={props.resources.slice(0, limit())}>{resource => (
            <button type="button" class="workspace-resource-row workspace-resource-entry text-text" onClick={() => setSelectedId(resource.id)}>
              <LucideIcon name={resource.kind === 'image' ? 'FileText' : resource.kind === 'artifact' ? 'SquareStack' : 'FileText'} size={16} />
              <span class="min-w-0 flex-1"><strong class="block truncate text-xs font-medium">{resource.title}</strong><span class="mt-1 block truncate text-[10px] text-text-dim">{typeLabel(resource)}{resource.summary ? ` · ${resource.summary}` : ''}</span></span>
              <LucideIcon name="ChevronRight" size={13} />
            </button>
          )}</For>
          <Show when={props.resources.length > limit()}><button type="button" class="workspace-resource-row text-accent" onClick={() => setLimit(value => value + 30)}>显示更多成果</button></Show>
        </Show>
      </>
    }>{resource => (
      <>
        <div class="mb-3 flex items-center gap-2 border-b border-border pb-2"><button type="button" class="workspace-resource-icon" aria-label="返回成果列表" onClick={() => setSelectedId(null)}><LucideIcon name="ArrowLeft" size={15} /></button><strong class="min-w-0 flex-1 truncate text-xs font-semibold">{resource().title}</strong></div>
        <Show when={resource().summary}><p class="mb-3 text-xs leading-relaxed text-text-dim">{resource().summary}</p></Show>
        <Show when={resourcePreviewText(resource().part) || resourcePreviewMedia(resource().part).length > 0} fallback={<p class="py-4 text-xs leading-relaxed text-text-dim">此成果未包含可预览的内容。可通过下方位置打开。</p>}>
          <Show when={resourcePreviewText(resource().part)}>
            <pre class="workspace-resource-preview" tabIndex={0}>{resourcePreviewText(resource().part).slice(0, 100_000)}</pre>
            <Show when={resourcePreviewText(resource().part).length > 100_000}><p class="mt-2 text-xs text-text-dim">内容较长，当前显示前 100,000 个字符。</p></Show>
          </Show>
          <For each={resourcePreviewMedia(resource().part)}>{part => <AgentResourceMedia part={part} />}</For>
        </Show>
        <Show when={resource().location}><p class="mt-3 break-all font-[family-name:var(--mono)] text-[10px] leading-relaxed text-text-dim">{resource().location}</p></Show>
        <Show when={resourceWebUrl(resource())}><button type="button" class="workspace-resource-row mt-2 text-accent" onClick={() => props.onOpenBrowser(resourceWebUrl(resource())!)}><LucideIcon name="Globe" size={14} />在内置浏览器打开</button></Show>
        <Show when={props.sessionId && resource().location && resolveFileNavigationTarget(resource().location, props.rootPath)}><button type="button" class="workspace-resource-row mt-2 text-accent" onClick={() => openResourceInFileSheet(props.sessionId!, resource().location)}><LucideIcon name="FileCode2" size={14} />在文件工作台打开</button></Show>
      </>
    )}</Show>
  )
}
