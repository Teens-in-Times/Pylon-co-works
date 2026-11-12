/** @jsxImportSource solid-js */
import { Show, createMemo } from 'solid-js'
import type { RenderAppearanceSnapshot, RenderCommandPort } from '../../../contracts/messageRenderer.ts'
import { coalesceAdjacentDisplayTextParts, createUnknownContentPart, isValidDiffContentInput, isValidLspDiagnosticContentInput, type ContentPart, type LspDiagnosticContentPart } from '../../../domains/workbench/content/contentPartSchema.ts'
import { diffSnapshotFromPart } from '../../../domains/workbench/diffSnapshot.ts'
import type { ToolInvocationSnapshot } from '../../../domains/workbench/workbenchProjector.ts'
import { normalizeToolStatus, toolStatePresentation } from '../../../domains/tool/status.ts'
import { MarkdownContent } from './MarkdownContent.solid.tsx'
import { SolidCodeBlock } from './CodeBlock.solid.tsx'
import { SolidAnsiBlock } from './AnsiBlock.solid.tsx'
import { SolidFileReferenceCard } from './content/FileReference.solid.tsx'
import { SolidMediaBlock } from './content/MediaBlock.solid.tsx'
import { BUILTIN_MEDIA_RESOLVER_OPTIONS } from '../mediaAssetAdapter.ts'
import { SolidSearchOrLink } from './content/SearchResults.solid.tsx'
import { SolidDiffContent, SolidLspDiagnosticContent } from './content/DiffDiagnosticContent.solid.tsx'
import { SolidLogBlock, SolidTerminalBlock } from './content/TerminalBlock.solid.tsx'
import { ToolBody } from './tool/ToolBody.solid.tsx'
import { ToolObjectInspector } from './tool/ToolObjectInspector.solid.tsx'
import { SolidUnknownContent } from './content/UnknownContent.solid.tsx'
import { isStructuredContentKind, SolidStructuredContent } from './content/StructuredContent.solid.tsx'
import { createCollapsiblePresenter } from './CollapsiblePresenter.solid.tsx'
import { resolveToolIndicatorAssetForTone } from '../../../domains/chat/toolIndicatorAssets.ts'
import { capitalizeToolName } from '../../../domains/chat/toolPresentationModel.ts'
import { safeJson } from '../../../utils/safeJson.ts'
import { toolSummaryUsesCodeFont } from '../../../domains/tool/toolPresentation.ts'
import { buildToolRenderModel } from '../../../domains/tool/toolPresentation.ts'

const NO_COMMANDS: RenderCommandPort = { execute: () => {}, canExecute: () => false }

export function SolidToolInvocationCard(props: {
  snapshot: ToolInvocationSnapshot
  appearance: RenderAppearanceSnapshot
  renderKind: string
  commands?: RenderCommandPort
}) {
  const state = () => normalizeToolStatus(props.snapshot.status ?? props.snapshot.result?.status)
  const hasOutput = () => Boolean(props.snapshot.result && (
    props.snapshot.result.parts !== undefined
    || props.snapshot.result.rawOutput !== undefined
    || props.snapshot.result.error !== undefined
  ))
  const presentation = () => toolStatePresentation(state(), hasOutput())
  const renderModel = createMemo(() => buildToolRenderModel({
    // Resolve summaries from the wire/canonical machine name so provider
    // dictionaries (Hermes `execute_code` → `code`, `terminal` → `command`)
    // remain available even when a localized display title is present.
    name: props.snapshot.name || props.snapshot.canonicalName || props.snapshot.title || '未知工具',
    toolKind: props.snapshot.kind,
    input: props.snapshot.input,
  }))
  const displayName = () => capitalizeToolName(props.snapshot.title
    || props.snapshot.canonicalName
    || props.snapshot.name
    || '未知工具')
  const providerName = () => {
    const wireName = props.snapshot.name?.trim()
    if (!props.snapshot.title || !wireName) return ''
    const canonicalDisplay = renderModel().resolution.displayName?.trim().toLowerCase()
    if (canonicalDisplay && canonicalDisplay === displayName().trim().toLowerCase()) return ''
    return wireName.toLowerCase() !== displayName().trim().toLowerCase() ? wireName : ''
  }
  const summary = () => {
    // Keep generic cards collapsed/quiet (their input remains in the body).
    // The compact header summary is reserved for Hermes' command-like tools,
    // where hiding the command used to make `terminal` look unparsed.
    const wireName = props.snapshot.name?.trim().toLowerCase()
    return props.snapshot.kind === 'execute'
      && (wireName === 'terminal' || wireName === 'process' || wireName === 'execute_code')
      ? renderModel().summary
      : ''
  }
  const collapse = createCollapsiblePresenter({
    defaultOpen: () => !booleanSetting(props.appearance, 'defaultCollapsed', true),
    resetKey: () => props.snapshot.id,
    bodyId: () => `solid-tool-snapshot-${safeDomId(props.snapshot.id)}`,
  })
  const parts = createMemo<readonly ContentPart[]>(() => coalesceAdjacentDisplayTextParts(
    Array.isArray(props.snapshot.result?.parts)
      ? props.snapshot.result!.parts!.filter(isContentPart) as readonly ContentPart[]
      : [],
  ))
  const inputParts = createMemo<readonly ContentPart[] | undefined>(() => contentParts(props.snapshot.input))
  const duration = () => booleanSetting(props.appearance, 'showDuration', true)
    ? formatDuration(props.snapshot.result?.durationMs)
    : ''

  return <article
    class="term-tool solid-tool-invocation"
    role="status"
    aria-label={`工具：${displayName()}，${presentation().label}`}
    data-content-kind={props.renderKind}
    data-tool-call-id={props.snapshot.id}
    data-tool-state={state()}
    data-status-label={presentation().label}
    data-status={presentation().tone}
    data-status-palette={stringSetting(props.appearance, 'statusPalette', 'semantic')}
    data-density={props.appearance.density === 'compact' ? 'compact' : 'comfortable'}
    data-reduced-motion={props.appearance.reducedMotion === true ? 'true' : 'false'}
    style={{
      color: stringSetting(props.appearance, 'foreground', 'var(--text)'),
      background: stringSetting(props.appearance, 'background', 'transparent'),
      'border-color': stringSetting(props.appearance, 'borderColor', 'var(--border)'),
      'max-width': `${numberSetting(props.appearance, 'maxWidth', 960)}px`,
    }}
  >
    <button class="term-tool-head" type="button" aria-expanded={collapse.open()} aria-controls={collapse.bodyId}
      onClick={collapse.toggle}>
      <Show when={stringSetting(props.appearance, 'indicator', 'glyph') !== 'none'}>
        <span class={`term-tool-indicator ${presentation().tone}`} aria-hidden="true">
          {resolveToolIndicatorGlyph(stringSetting(props.appearance, 'indicator', 'glyph'), presentation().tone, props.appearance)}
        </span>
      </Show>
      <span class="term-tool-name">{displayName()}</span>
      <Show when={providerName()}>{value => <span class="term-tool-summary term-tool-summary-code"> ({value()})</span>}</Show>
      <Show when={summary()}>{value => <span class={`term-tool-summary${toolSummaryUsesCodeFont(renderModel().kind) ? ' term-tool-summary-code' : ''}`}> ({value()})</span>}</Show>
      <span class="term-tool-state-label"> — {presentation().label}</span>
      <Show when={duration()}>{value => <span class="term-tool-duration"> · {value()}</span>}</Show>
    </button>
    <Show when={collapse.open()}>
      <div id={collapse.bodyId} class="term-tool-body" style={{ 'max-height': `${numberSetting(props.appearance, 'maxHeight', 420)}px`, overflow: 'auto' }}>
        <ToolBody
          snapshot={props.snapshot}
          renderKind={props.renderKind}
          parts={parts()}
          inputParts={inputParts()}
          commands={props.commands}
          renderPart={(part, index, source) => <ToolContentPart
            part={part} appearance={props.appearance} commands={props.commands}
            nodeId={`${props.snapshot.id}:${source}:${index}`}
          />}
        />
        <Show when={props.snapshot.result?.error}>
          {error => <ToolError error={error()} />}
        </Show>
        <Show when={booleanSetting(props.appearance, 'showMetadata', true) && metadata(props.snapshot)}>
          {value => <small class="solid-tool-metadata">{value()}</small>}
        </Show>
        <Show when={booleanSetting(props.appearance, 'showRaw', false) && (
          props.snapshot.rawInput !== undefined || props.snapshot.result?.rawOutput !== undefined
        )}>
          <details class="solid-tool-raw"><summary>Raw 审计信息</summary><pre>{safeRawSummary({
            ...(props.snapshot.rawInput !== undefined ? { input: props.snapshot.rawInput } : {}),
            ...(props.snapshot.result?.rawOutput !== undefined ? { output: props.snapshot.result.rawOutput } : {}),
          })}</pre></details>
        </Show>
      </div>
    </Show>
  </article>
}

export function ToolContentPart(props: { part: ContentPart; appearance?: RenderAppearanceSnapshot; commands?: RenderCommandPort; nodeId?: string; class?: string }) {
  if (props.part.kind === 'code' && 'text' in props.part && typeof props.part.text === 'string') {
    return <SolidCodeBlock code={props.part.text} language={props.part.language} />
  }
  if (props.part.kind === 'ansi' && 'text' in props.part && typeof props.part.text === 'string') {
    return <SolidAnsiBlock text={props.part.text} />
  }
  if ((props.part.kind === 'text' || props.part.kind === 'markdown') && 'text' in props.part && typeof props.part.text === 'string') {
    return <div class={`term-tool-prose${props.class ? ` ${props.class}` : ''}`} data-tool-part-kind={props.part.kind}><MarkdownContent text={props.part.text} /></div>
  }
  if (props.part.kind === 'file-reference' || props.part.kind === 'file-selection' || props.part.kind === 'document' || props.part.kind === 'resource') {
    const canOpen = props.commands?.canExecute?.('resource.open') === true
    const canReveal = props.commands?.canExecute?.('resource.reveal') === true
    const canCopy = props.commands?.canExecute?.('clipboard.write') === true
    return <SolidFileReferenceCard part={props.part} actions={{
      canOpen, canReveal, canCopy,
      open: canOpen ? target => { void props.commands?.execute({ type: 'resource.open', payload: target }) } : undefined,
      reveal: canReveal ? target => { void props.commands?.execute({ type: 'resource.reveal', payload: target }) } : undefined,
      copyPath: canCopy ? text => { void props.commands?.execute({ type: 'clipboard.write', payload: { text } }) } : undefined,
    }} />
  }
  if (props.part.kind === 'image' || props.part.kind === 'audio' || props.part.kind === 'video') {
    return <SolidMediaBlock part={props.part} resolverOptions={BUILTIN_MEDIA_RESOLVER_OPTIONS} />
  }
  if (props.part.kind === 'search-result' || props.part.kind === 'link') {
    const canOpen = props.commands?.canExecute?.('resource.open') === true
    const canCopy = props.commands?.canExecute?.('clipboard.write') === true
    return <SolidSearchOrLink part={props.part} actions={{
      open: canOpen ? url => { void props.commands?.execute({ type: 'resource.open', payload: { uri: url } }) } : undefined,
      copy: canCopy ? text => { void props.commands?.execute({ type: 'clipboard.write', payload: { text } }) } : undefined,
    }} appearance={{
      foreground: stringSetting(props.appearance ?? {}, 'foreground', 'var(--text)'),
      mutedForeground: stringSetting(props.appearance ?? {}, 'mutedForeground', 'var(--text-dim)'),
      background: stringSetting(props.appearance ?? {}, 'background', 'transparent'),
      borderColor: stringSetting(props.appearance ?? {}, 'borderColor', 'var(--border)'),
      maxWidth: numberSetting(props.appearance ?? {}, 'maxWidth', 960),
      maxHeight: numberSetting(props.appearance ?? {}, 'maxHeight', 420),
      density: props.appearance?.density === 'compact' ? 'compact' : 'comfortable',
      defaultExpanded: !booleanSetting(props.appearance ?? {}, 'defaultCollapsed', true),
      reducedMotion: props.appearance?.reducedMotion === true,
    }} />
  }
  if (props.part.kind === 'diff') {
    const snapshot = isValidDiffContentInput(props.part) ? diffSnapshotFromPart(props.part) : null
    return snapshot
      ? <SolidDiffContent snapshot={snapshot} nodeId={props.nodeId ?? 'tool-diff'}
          appearance={props.appearance ?? {}} commands={props.commands ?? NO_COMMANDS} />
      : <pre data-tool-part-kind="diff">Invalid content.diff payload</pre>
  }
  if (props.part.kind === 'diagnostic-lsp') {
    return isValidLspDiagnosticContentInput(props.part)
      ? <SolidLspDiagnosticContent diagnostic={props.part as LspDiagnosticContentPart}
          appearance={props.appearance ?? {}} commands={props.commands ?? NO_COMMANDS} />
      : <pre data-tool-part-kind="diagnostic-lsp">Invalid diagnostic.lsp payload</pre>
  }
  if (props.part.kind === 'terminal') {
    const canCopy = props.commands?.canExecute?.('clipboard.write') === true
    return <SolidTerminalBlock part={props.part} appearance={props.appearance} actions={{
      copy: canCopy ? text => { void props.commands?.execute({ type: 'clipboard.write', payload: { text } }) } : undefined,
    }} />
  }
  if (props.part.kind === 'log') {
    return <SolidLogBlock part={props.part} appearance={props.appearance} />
  }
  const structuredKind = props.part.kind.includes('.') ? props.part.kind : `content.${props.part.kind}`
  if (isStructuredContentKind(structuredKind)) {
    return <SolidStructuredContent kind={structuredKind} payload={props.part} commands={props.commands}
      renderPart={(part, index) => <ToolContentPart part={part} appearance={props.appearance} commands={props.commands}
        nodeId={`${props.nodeId ?? 'tool-structured'}:${index}`} />} />
  }
  if (props.part.kind === 'unknown') {
    return <div data-tool-part-kind="unknown"><SolidUnknownContent part={props.part} commands={props.commands} /></div>
  }
  return <div data-tool-part-kind={props.part.kind}><ToolObjectInspector value={props.part} commands={props.commands} /></div>
}

function ToolError(props: { error: NonNullable<NonNullable<ToolInvocationSnapshot['result']>['error']> }) {
  const hasTechnicalDetail = () => Boolean(props.error.technicalMessage && props.error.technicalMessage !== props.error.userSummary)
  return <section class="solid-tool-error" role="alert">
    <span class="term-tool-label term-tool-label-error">错误</span>
    <pre>{props.error.userSummary}</pre>
    <Show when={props.error.code}><small>code: {props.error.code}</small></Show>
    <Show when={hasTechnicalDetail()}>
      <details><summary>技术细节</summary><pre>{props.error.technicalMessage}</pre></details>
    </Show>
  </section>
}

function isContentPart(value: unknown): value is ContentPart {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).kind === 'string'
}

function contentParts(value: unknown): readonly ContentPart[] | undefined {
  if (isContentPart(value)) return [value]
  if (!Array.isArray(value) || value.length === 0 || !value.every(isContentPart)) return undefined
  return coalesceAdjacentDisplayTextParts(value)
}

function metadata(snapshot: ToolInvocationSnapshot): string {
  return [
    snapshot.canonicalName ? `canonical: ${snapshot.canonicalName}` : undefined,
    snapshot.action ? `action: ${snapshot.action}` : undefined,
    snapshot.parentToolCallId ? `parent: ${snapshot.parentToolCallId}` : undefined,
    Array.isArray(snapshot.locations) && snapshot.locations.length > 0 ? `locations: ${snapshot.locations.length}` : undefined,
  ].filter(Boolean).join(' · ')
}

function safeRawSummary(value: unknown): string {
  const safe = createUnknownContentPart('tool.raw', value, { maxRawBytes: 8 * 1024 })
  return safeJson(safe.raw, { fallback: '[unavailable]' })
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return ''
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
}

/** Shared with aggregate activity headers so indicator mode/asset resolution
 * cannot drift from the ordinary tool card. */
export function resolveToolIndicatorGlyph(indicator: string, tone: 'run' | 'ok' | 'err', appearance: RenderAppearanceSnapshot): string {
  if (indicator === 'dot') return '•'
  if (indicator !== 'glyph') return indicator
  return resolveToolIndicatorAssetForTone(tone, {
    toolIndicator: stringSetting(appearance, 'toolIndicator', 'circle'),
    toolIndicatorRun: stringSetting(appearance, 'toolIndicatorRun', ''),
    toolIndicatorOk: stringSetting(appearance, 'toolIndicatorOk', ''),
    toolIndicatorErr: stringSetting(appearance, 'toolIndicatorErr', ''),
  }).glyph
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, character => `%${character.charCodeAt(0).toString(16).padStart(4, '0')}%`)
}

function stringSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: string): string {
  return typeof appearance[key] === 'string' ? appearance[key] as string : fallback
}

function numberSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: number): number {
  return typeof appearance[key] === 'number' && Number.isFinite(appearance[key]) ? appearance[key] as number : fallback
}

function booleanSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: boolean): boolean {
  return typeof appearance[key] === 'boolean' ? appearance[key] as boolean : fallback
}
