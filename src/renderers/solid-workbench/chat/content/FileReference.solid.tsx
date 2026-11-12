/** @jsxImportSource solid-js */
import { Show, createMemo, type JSX } from 'solid-js'
import { LucideIcon } from '../../../../components/LucideIcon.solid.tsx'
import type { ContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import { MarkdownContent } from '../MarkdownContent.solid.tsx'
import {
  fileContentLastSegment,
  formatFileSelectionRange,
  isBinaryFileContent,
  presentFileContentPath,
  previewFileContentText,
} from '../../../../domains/rendererContent/fileContentPresentation.ts'

/**
 * C02：文件引用/选择区/资源卡（Solid）。
 *
 * 卡面要求：显示路径、范围、摘要和来源；动作（open/reveal/copy）经 command port
 * capability，不可用时 disabled 并解释原因；PDF/二进制只显示安全 metadata。
 * 路径保持原样呈现——不做 Windows/URI 字符串猜测互转。
 */

export interface FileReferenceActions {
  /** command port capability 快照；缺失的动作用 disabled + 原因呈现。 */
  canOpen?: boolean
  canReveal?: boolean
  canCopy?: boolean
  open?: (target: unknown) => void
  reveal?: (target: unknown) => void
  copyPath?: (path: string) => void
}

export interface FileReferenceAppearance {
  foreground?: string
  mutedForeground?: string
  background?: string
  borderColor?: string
  fontSize?: number
  iconSize?: number
  maxWidth?: number
  maxHeight?: number
  pathCollapse?: 'full' | 'middle' | 'basename'
  previewLines?: number
  showAbsolutePath?: boolean
  showMetadata?: boolean
  fileTypePalette?: 'auto' | 'neutral' | 'accent'
  groupLayout?: 'stack' | 'grid'
}

export function SolidFileReferenceCard(props: { part: ContentPart; actions?: FileReferenceActions; appearance?: FileReferenceAppearance }) {
  const part = createMemo(() => props.part)
  const filePath = () => asFileish(part()).path

  return (
    <Show
      when={part().kind === 'file-reference' || part().kind === 'file-selection'}
      fallback={<Show when={part().kind === 'document'} fallback={<SolidResourceCard part={part()} actions={props.actions} appearance={props.appearance} />}>
        <SolidDocumentCard part={part()} actions={props.actions} appearance={props.appearance} />
      </Show>}
    >
      <article
        class="term-file-card"
        data-part-kind={part().kind}
        data-file-type-palette={fileTypePalette(props.appearance)}
        data-group-layout={groupLayout(props.appearance)}
        style={cardStyle(props.appearance)}
        aria-label={part().kind === 'file-selection' ? '文件选择区' : '文件引用'}
      >
        <span class="term-file-icon" aria-hidden="true" style={iconStyle(props.appearance)}><LucideIcon name="FileText" size={numberAppearance(props.appearance?.iconSize, 18)} /></span>
        <div class="term-file-meta">
          <span class="term-file-name">{displayTitle(part())}</span>
          <Show when={visiblePath(filePath(), props.appearance)}>
            {path => <span class="term-file-path" style={mutedStyle(props.appearance)} title={filePath()}>{path()}</span>}
          </Show>
          <Show when={part().kind === 'file-selection'}>
            <span class="term-file-range" style={mutedStyle(props.appearance)}>{rangeText(asFileish(part()))}</span>
          </Show>
          <Show when={showMetadata(props.appearance) ? metaLine(part()) : undefined}>
            {meta => <span class="term-file-meta-line" style={mutedStyle(props.appearance)}>{meta()}</span>}
          </Show>
          <Show when={selectionPreview(part(), props.appearance)}>
            {text => <pre class="term-file-preview" style={{ 'max-height': `${numberAppearance(props.appearance?.maxHeight, 360)}px` }}>{text()}</pre>}
          </Show>
        </div>
        <div class="term-file-actions" role="group" aria-label="文件操作">
          <ActionButton
            label="打开"
            enabled={props.actions?.canOpen === true && props.actions?.open !== undefined}
            disabledReason="打开能力未接入"
            onClick={() => props.actions?.open?.(part())}
          />
          <ActionButton
            label="定位"
            enabled={props.actions?.canReveal === true && props.actions?.reveal !== undefined}
            disabledReason="定位能力未接入"
            onClick={() => props.actions?.reveal?.(part())}
          />
          <ActionButton
            label="复制路径"
            enabled={props.actions?.canCopy === true && props.actions?.copyPath !== undefined}
            disabledReason="剪贴板能力未接入"
            onClick={() => props.actions?.copyPath?.(asFileish(part()).path ?? '')}
          />
        </div>
      </article>
    </Show>
  )
}

function SolidResourceCard(props: { part: ContentPart; actions?: FileReferenceActions; appearance?: FileReferenceAppearance }) {
  const res = () => props.part as { kind: string; uri: string; title?: string; mimeType?: string; text?: string; hasBlob?: boolean }
  // C02 步骤5：二进制/PDF 只显示安全 metadata；blob 永不渲染
  const isBinary = () => isBinaryFileContent(res())
  const preview = () => typeof res().text === 'string'
    ? previewFileContentText(res().text!, props.appearance?.previewLines)
    : undefined
  return (
    <article
      class="term-file-card term-resource-card"
      data-part-kind={props.part.kind}
      data-file-type-palette={fileTypePalette(props.appearance)}
      data-group-layout={groupLayout(props.appearance)}
      style={cardStyle(props.appearance)}
      aria-label="外部资源"
    >
      <span class="term-file-icon" aria-hidden="true" style={iconStyle(props.appearance)}><LucideIcon name="Globe" size={numberAppearance(props.appearance?.iconSize, 18)} /></span>
      <div class="term-file-meta">
        <span class="term-file-name">{res().title || fileContentLastSegment(res().uri)}</span>
        <Show when={visiblePath(res().uri, props.appearance)}>
          {uri => <span class="term-file-path" style={mutedStyle(props.appearance)} title={res().uri}>{uri()}</span>}
        </Show>
        <Show when={showMetadata(props.appearance) ? res().mimeType : undefined}>
          {mime => <span class="term-file-meta-line" style={mutedStyle(props.appearance)}>{mime()}</span>}
        </Show>
        <Show when={preview()}>
          {text => <ContentPreview text={text()} mimeType={res().mimeType} maxHeight={props.appearance?.maxHeight} />}
        </Show>
        <Show when={!preview() && isBinary()}>
          <span class="term-file-meta-line term-file-binary-note" style={mutedStyle(props.appearance)}>二进制内容不内联展示</span>
        </Show>
      </div>
      <div class="term-file-actions" role="group" aria-label="资源操作">
        <ActionButton
          label="打开"
          enabled={props.actions?.canOpen === true && props.actions?.open !== undefined}
          disabledReason="打开能力未接入"
          onClick={() => props.actions?.open?.(props.part)}
        />
      </div>
    </article>
  )
}

function SolidDocumentCard(props: { part: ContentPart; actions?: FileReferenceActions; appearance?: FileReferenceAppearance }) {
  const document = () => asDocument(props.part)
  const source = () => document().path ?? document().uri
  const preview = () => {
    if (typeof document().text !== 'string') return undefined
    return previewFileContentText(document().text!, props.appearance?.previewLines)
  }
  const isBinary = () => isBinaryFileContent(document())
  return (
    <article
      class="term-file-card term-document-card"
      data-part-kind="document"
      data-file-type-palette={fileTypePalette(props.appearance)}
      data-group-layout={groupLayout(props.appearance)}
      style={cardStyle(props.appearance)}
      aria-label="内联文档"
    >
      <span class="term-file-icon" aria-hidden="true" style={iconStyle(props.appearance)}><LucideIcon name="FileText" size={numberAppearance(props.appearance?.iconSize, 18)} /></span>
      <div class="term-file-meta">
        <span class="term-file-name">{document().title || (source() ? fileContentLastSegment(source()!) : '文档')}</span>
        <Show when={source() ? visiblePath(source()!, props.appearance) : undefined}>
          {path => <span class="term-file-path" style={mutedStyle(props.appearance)} title={source()}>{path()}</span>}
        </Show>
        <Show when={showMetadata(props.appearance) ? document().mimeType : undefined}>
          {mime => <span class="term-file-meta-line" style={mutedStyle(props.appearance)}>{mime()}</span>}
        </Show>
        <Show when={preview()}>
          {text => <ContentPreview text={text()} mimeType={document().mimeType} maxHeight={props.appearance?.maxHeight} />}
        </Show>
        <Show when={!preview() && isBinary()}>
          <span class="term-file-meta-line term-file-binary-note" style={mutedStyle(props.appearance)}>二进制内容不内联展示</span>
        </Show>
      </div>
      <Show when={source()}>
        <div class="term-file-actions" role="group" aria-label="文档操作">
          <ActionButton
            label="打开"
            enabled={props.actions?.canOpen === true && props.actions?.open !== undefined}
            disabledReason="打开能力未接入"
            onClick={() => props.actions?.open?.(props.part)}
          />
          <ActionButton
            label="复制来源"
            enabled={props.actions?.canCopy === true && props.actions?.copyPath !== undefined}
            disabledReason="剪贴板能力未接入"
            onClick={() => props.actions?.copyPath?.(source() ?? '')}
          />
        </div>
      </Show>
    </article>
  )
}

function ContentPreview(props: { text: string; mimeType?: string; maxHeight?: number }) {
  const isMarkdown = () => /^text\/(?:markdown|x-markdown)(?:;|$)/i.test(props.mimeType ?? '')
  const style = (): JSX.CSSProperties => ({ 'max-height': `${numberAppearance(props.maxHeight, 360)}px` })
  return (
    <Show when={isMarkdown()} fallback={<pre class="term-file-preview" style={style()}>{props.text}</pre>}>
      <div class="term-file-preview term-file-preview-markdown" style={style()}>
        <MarkdownContent text={props.text} typewriter={false} settleMotion={false} />
      </div>
    </Show>
  )
}

function ActionButton(props: { label: string; enabled: boolean; disabledReason: string; onClick: () => void }) {
  return (
    <button
      class="term-file-action"
      type="button"
      disabled={!props.enabled}
      title={props.enabled ? props.label : props.disabledReason}
      aria-disabled={!props.enabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

type FileishPart = { path?: string; displayName?: string; mime?: string; size?: number; language?: string; previewText?: string; selection?: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } } }

function asFileish(part: ContentPart): FileishPart {
  return part as unknown as FileishPart
}

type DocumentPart = { title?: string; path?: string; uri?: string; mimeType?: string; text?: string; hasBlob?: boolean }

function asDocument(part: ContentPart): DocumentPart {
  return part as unknown as DocumentPart
}

function displayTitle(part: ContentPart): string {
  const p = asFileish(part)
  if (!p.path) return ''
  return p.displayName || fileContentLastSegment(p.path)
}

function rangeText(part: FileishPart): string | undefined {
  return formatFileSelectionRange(part.selection)
}

function selectionPreview(part: ContentPart, appearance: FileReferenceAppearance | undefined): string | undefined {
  if (part.kind !== 'file-selection') return undefined
  const text = asFileish(part).previewText
  return typeof text === 'string' ? previewFileContentText(text, appearance?.previewLines) : undefined
}

function metaLine(part: ContentPart): string | undefined {
  const p = asFileish(part)
  const segments: string[] = []
  if (p.mime) segments.push(p.mime)
  if (p.size !== undefined) segments.push(formatBytes(p.size))
  if (part.kind === 'file-selection' && p.language) segments.push(p.language)
  return segments.join(' · ') || undefined
}

function numberAppearance(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function showMetadata(appearance: FileReferenceAppearance | undefined): boolean {
  return appearance?.showMetadata !== false
}

function fileTypePalette(appearance: FileReferenceAppearance | undefined): 'auto' | 'neutral' | 'accent' {
  return appearance?.fileTypePalette === 'neutral' || appearance?.fileTypePalette === 'accent'
    ? appearance.fileTypePalette
    : 'auto'
}

function groupLayout(appearance: FileReferenceAppearance | undefined): 'stack' | 'grid' {
  return appearance?.groupLayout === 'grid' ? 'grid' : 'stack'
}

function visiblePath(path: string | undefined, appearance: FileReferenceAppearance | undefined): string | undefined {
  if (path === undefined) return undefined
  return presentFileContentPath(path, appearance)
}

function cardStyle(appearance: FileReferenceAppearance | undefined): JSX.CSSProperties {
  return {
    '--file-muted-foreground': appearance?.mutedForeground ?? 'var(--text-dim)',
    color: appearance?.foreground ?? 'var(--text)',
    'background-color': appearance?.background ?? 'transparent',
    'border-color': appearance?.borderColor ?? 'var(--border)',
    'font-size': `${numberAppearance(appearance?.fontSize, 13)}px`,
    'max-width': `${numberAppearance(appearance?.maxWidth, 960)}px`,
  }
}

function mutedStyle(appearance: FileReferenceAppearance | undefined): JSX.CSSProperties {
  return { color: appearance?.mutedForeground ?? 'var(--text-dim)' }
}

function iconStyle(appearance: FileReferenceAppearance | undefined): JSX.CSSProperties {
  const size = `${numberAppearance(appearance?.iconSize, 18)}px`
  return { 'font-size': size, width: size, height: size }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
