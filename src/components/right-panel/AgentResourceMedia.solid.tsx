/** @jsxImportSource solid-js */
/** Workspace-owned media preview; shares source validation without requiring a renderer plugin's styles. */
import { createEffect, createMemo, createSignal, Match, Show, Switch } from 'solid-js'
import type { ContentPart, ImageContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import { isAllowedMediaPosterUrl, resolveMediaSource } from '../../domains/rendererContent/mediaSourceResolver.ts'
import { resolveBackgroundImage } from '../../infrastructure/skin/backgroundImage.ts'

export default function AgentResourceMedia(props: { part: ContentPart }) {
  const [failed, setFailed] = createSignal(false)
  const media = createMemo<ImageContentPart | null>(() => props.part.kind === 'image' || props.part.kind === 'audio' || props.part.kind === 'video' ? props.part : null)
  const source = createMemo(() => {
    const part = media()
    if (!part) return { ok: false as const, reason: '没有可预览的媒体' }
    const value = part.source.trim()
    return resolveMediaSource({
      url: !part.sourceKind || part.sourceKind === 'url' || part.sourceKind === 'blob' || /^data:/i.test(value) ? value : undefined,
      localPath: part.sourceKind === 'path' ? value : undefined,
      base64: part.sourceKind === 'base64' && !/^data:/i.test(value) ? value : undefined,
      mime: part.mimeType,
    }, { convertLocalPath: path => {
      const result = resolveBackgroundImage(path)
      if (!result.source || result.error) throw new Error(result.error || '本地媒体无法加载')
      return result.source
    } })
  })
  createEffect(() => { source(); setFailed(false) })
  const mediaUrl = () => { const result = source(); return result.ok ? result.source : '' }
  const label = () => media()?.alt || media()?.caption || '会话成果'
  const poster = () => { const value = media()?.poster; return value && isAllowedMediaPosterUrl(value) ? value : undefined }

  return (
    <figure class="my-3 min-w-0 border border-border bg-bg-input p-2">
      <Show when={source().ok && !failed()} fallback={
        <div class="flex flex-col gap-2 text-xs text-text-dim" role="alert"><span>{source().ok ? '媒体加载失败' : (source() as { reason: string }).reason}</span><Show when={source().ok}><button type="button" class="workspace-resource-row text-accent" onClick={() => setFailed(false)}>重新加载媒体</button></Show></div>
      }>
        <Switch>
          <Match when={media()?.kind === 'image'}><img class="block max-h-[360px] w-full object-contain" src={mediaUrl()} alt={label()} loading="lazy" decoding="async" onError={() => setFailed(true)} /></Match>
          <Match when={media()?.kind === 'audio'}><audio class="block max-w-full" src={mediaUrl()} controls preload="metadata" aria-label={label()} onError={() => setFailed(true)} /></Match>
          <Match when={media()?.kind === 'video'}><video class="block max-h-[360px] w-full" src={mediaUrl()} poster={poster()} controls preload="metadata" aria-label={label()} onError={() => setFailed(true)} /></Match>
        </Switch>
      </Show>
      <Show when={media()?.caption}><figcaption class="mt-2 break-words text-[11px] leading-relaxed text-text-dim">{media()?.caption}</figcaption></Show>
      <Show when={media()?.transcript}><p class="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-text-dim">{media()?.transcript}</p></Show>
    </figure>
  )
}
