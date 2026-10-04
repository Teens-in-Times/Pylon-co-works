/** @jsxImportSource solid-js */
import { Match, Show, Switch } from 'solid-js'
import type {
  RenderAppearanceSnapshot,
  RenderNodeSnapshot,
} from '../../../contracts/messageRenderer.ts'
import {
  isValidLinkContentInput,
  isValidArtifactContentInput,
  isValidDiffContentInput,
  isValidHookSurfaceInput,
  isValidLogContentInput,
  isValidLspDiagnosticContentInput,
  isValidMcpResourceContentInput,
  isValidMemoryContentInput,
  isValidSearchResultContentInput,
  isValidSkillContentInput,
  isValidTerminalContentInput,
  type ContentPart,
  type LspDiagnosticContentPart,
} from '../../../domains/workbench/content/contentPartSchema.ts'
import { SolidAnsiBlock } from './AnsiBlock.solid.tsx'
import { SolidCodeBlock } from './CodeBlock.solid.tsx'
import { MarkdownContent } from './MarkdownContent.solid.tsx'
import { ReasoningBlock } from './MessageRow.solid.tsx'
import { SolidFileReferenceCard } from './content/FileReference.solid.tsx'
import { SolidMediaBlock } from './content/MediaBlock.solid.tsx'
import { BUILTIN_MEDIA_RESOLVER_OPTIONS } from '../mediaAssetAdapter.ts'
import { isValidPlanContentInput } from '../../../domains/workbench/plan/goalModel.ts'
import { SolidPlanGoalContent } from './content/PlanGoalContent.solid.tsx'
import { isValidLifecycleStateInput, isValidNormalizedErrorInput, isValidSystemNoticeInput } from '../../../domains/workbench/lifecycle/lifecycleModel.ts'
import { SolidLifecycleCard, SolidSystemErrorCard, SolidSystemNoticeCard } from './LifecycleCard.solid.tsx'
import { isToolInvocationSnapshotInput } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'
import type { ToolInvocationSnapshot } from '../../../domains/workbench/workbenchProjector.ts'
import { SolidToolInvocationCard, ToolContentPart } from './ToolInvocationCard.solid.tsx'
import { SolidSearchOrLink, type SearchLinkAppearance } from './content/SearchResults.solid.tsx'
import { diffSnapshotFromPart } from '../../../domains/workbench/diffSnapshot.ts'
import { SolidDiffContent, SolidLspDiagnosticContent } from './content/DiffDiagnosticContent.solid.tsx'
import { SolidLogBlock, SolidProcessActivity, SolidTerminalBlock } from './content/TerminalBlock.solid.tsx'
import { SolidSubagentCard } from './content/SubagentCard.solid.tsx'
import { SolidWorkflowActivityCard } from './content/WorkflowCard.solid.tsx'
import { isBackgroundTaskActivitySnapshotInput, isProcessActivitySnapshotInput, isSubagentActivitySnapshotInput, isWorkflowActivitySnapshotInput } from '../../../domains/rendererContent/executionRenderKindCatalog.ts'
import type { WorkbenchActivityNode } from '../../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchInteraction } from '../../../domains/workbench/workbenchProjector.ts'
import { isInteractionSnapshotInput } from '../../../domains/rendererContent/interactionRenderKindCatalog.ts'
import { SolidInteractionCard } from './content/InteractionCard.solid.tsx'
import { SolidSessionSurfaceCard } from './content/SessionSurfaceCard.solid.tsx'
import { BUILTIN_SESSION_RENDER_KINDS } from '../../../domains/rendererContent/sessionRenderKindCatalog.ts'
import { SolidExtensionContentCard, type ExtensionRenderKind } from './content/ExtensionContentCard.solid.tsx'
import { isUnknownContentPart, SolidUnknownContent } from './content/UnknownContent.solid.tsx'
import { isStructuredContentKind, SolidStructuredContent, type StructuredContentKind } from './content/StructuredContent.solid.tsx'
// #520 K 域：commands 臂与 ToolBody 家族共享同一类型面（ToolBodyHostProps）。
import { ToolBodyHostProps } from './tool/toolBodyTypes.ts'

export function BuiltinSolidContentSlot(props: ToolBodyHostProps & {
  snapshot: RenderNodeSnapshot
  appearance: RenderAppearanceSnapshot
}) {
  const kind = () => props.snapshot.kind
  const payload = () => props.snapshot.payload as ContentPart
  const record = () => props.snapshot.payload as Record<string, unknown>
  const text = () => typeof record().text === 'string' ? record().text as string : ''
  const can = (commandType: string) => props.commands.canExecute?.(commandType) === true
  const execute = (type: string, payloadValue: unknown) => {
    void props.commands.execute(payloadValue === undefined ? { type } : { type, payload: payloadValue })
  }
  const numberSetting = (key: string, fallback: number) => typeof props.appearance[key] === 'number'
    ? props.appearance[key] as number
    : fallback
  const stringSetting = (key: string, fallback: string) => typeof props.appearance[key] === 'string'
    ? props.appearance[key] as string
    : fallback
  const booleanSetting = (key: string, fallback: boolean) => typeof props.appearance[key] === 'boolean'
    ? props.appearance[key] as boolean
    : fallback
  const isProseKind = () => kind() === 'content.text'
    || kind() === 'content.markdown'
    || kind() === 'content.reasoning'
    || kind() === 'content.redacted-reasoning'
  const fontFamily = () => {
    // Conversation prose always starts from the message rail.  A legacy
    // renderer snapshot may still carry `fontFamily: mono`; treating that as
    // the default here is what caused ordinary English to inherit code
    // metrics.  An explicit per-kind user/session override remains honored.
    if (isProseKind() && !explicitProseTypographySetting('fontFamily')) return 'inherit'
    switch (props.appearance.fontFamily) {
      case 'mono': return 'var(--mono)'
      case 'sans': return 'var(--font)'
      case 'serif': return 'serif'
      default: return 'inherit'
    }
  }
  const contentStyle = () => ({
    'font-family': fontFamily(),
    'font-size': isProseKind()
      ? (explicitProseTypographySetting('fontSize') ? `${numberSetting('fontSize', 14)}px` : 'inherit')
      : (explicitKindSetting('fontSize') ? `${numberSetting('fontSize', 14)}px` : 'inherit'),
    'line-height': isProseKind() && !explicitProseTypographySetting('lineHeight')
      ? 'inherit'
      : String(numberSetting('lineHeight', 1.6)),
    'max-width': `${numberSetting('maxWidth', 1600)}px`,
  })
  const explicitKindSetting = (key: string) => {
    const renderSettings = props.appearance.renderSettings
    if (!renderSettings || typeof renderSettings !== 'object' || Array.isArray(renderSettings)) return false
    const sources = (renderSettings as Record<string, unknown>).sources
    if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return false
    const kindSources = (sources as Record<string, unknown>).kind
    if (!kindSources || typeof kindSources !== 'object' || Array.isArray(kindSources)) return false
    const source = (kindSources as Record<string, unknown>)[key]
    return source === 'profile' || source === 'user-override' || source === 'session-preview'
  }
  const explicitProseTypographySetting = (key: string) => {
    const renderSettings = props.appearance.renderSettings
    // Direct callers may intentionally provide a numeric value without the
    // production source metadata; preserve that compatibility seam.
    if (!renderSettings || typeof renderSettings !== 'object' || Array.isArray(renderSettings)) {
      const direct = props.appearance[key]
      // The catalog defaults (14px / 1.6) are indistinguishable from a
      // legacy snapshot that merely copied host values. Treat those defaults
      // as inherited; non-default direct values remain an explicit override.
      return typeof direct === 'number'
        && ((key === 'fontSize' && direct !== 14) || (key === 'lineHeight' && direct !== 1.6))
    }
    const sources = (renderSettings as Record<string, unknown>).sources
    if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return false
    const kindSources = (sources as Record<string, unknown>).kind
    if (!kindSources || typeof kindSources !== 'object' || Array.isArray(kindSources)) return false
    const source = (kindSources as Record<string, unknown>)[key]
    if (source === undefined) return false
    // Profile kind tokens may intentionally tune numeric prose metrics (for
    // example a larger reading size), so keep those values visible to the
    // Slot.  A profile-provided font family is different: ordinary prose must
    // continue to inherit the message rail even when a legacy/profile snapshot
    // carries a mono family; code semantics opt into mono at their own nodes.
    return source === 'user-override' || source === 'session-preview'
      || (source === 'profile' && key !== 'fontFamily')
  }
  const optionalTypographySetting = (key: string, fallback: number) => (
    explicitProseTypographySetting(key) ? numberSetting(key, fallback) : undefined
  )

  return (
    <div
      class="solid-content-kind"
      data-content-kind={kind()}
      data-link-style={stringSetting('linkStyle', 'underline')}
      style={contentStyle()}
    >
      <Switch fallback={
        <pre class="solid-content-unknown">{unknownSummary(props.snapshot.payload, kind())}</pre>
      }>
      <Match when={kind() === 'content.text' || kind() === 'content.markdown'}>
        <MarkdownContent text={text()} streaming={props.snapshot.streaming === true} />
      </Match>
      <Match when={kind() === 'content.code'}>
        <SolidCodeBlock
          code={text()}
          language={typeof record().language === 'string' ? record().language as string : undefined}
          maxLines={numberSetting('maxLines', 400)}
          showLanguage={booleanSetting('showLanguage', true)}
          showCopyButton={booleanSetting('showCopyButton', true)}
          wrap={stringSetting('wrap', 'soft') === 'none' ? 'none' : 'soft'}
          palette={stringSetting('palette', 'auto')}
        />
      </Match>
      <Match when={kind() === 'content.ansi'}>
        <SolidAnsiBlock
          text={text()}
          reducedMotion={props.appearance.reducedMotion === true}
          wrap={stringSetting('wrap', 'soft') === 'none' ? 'none' : 'soft'}
          maxLines={numberSetting('maxLines', 800)}
          background={stringSetting('background', 'transparent')}
          palette={stringSetting('palette', 'terminal')}
        />
      </Match>
      <Match when={kind() === 'content.reasoning'}>
        <ReasoningBlock
          text={text()}
          running={record().state === 'running'}
          durationMs={typeof record().durationMs === 'number' ? record().durationMs as number : undefined}
          foreground={stringSetting('foreground', 'var(--text-dim)')}
          background={stringSetting('background', 'transparent')}
          borderColor={stringSetting('borderColor', 'color-mix(in srgb, var(--border) 72%, transparent)')}
          fontSize={optionalTypographySetting('fontSize', 13)}
          lineHeight={optionalTypographySetting('lineHeight', 1.6)}
          defaultCollapsed={booleanSetting('defaultCollapsed', true)}
          maxHeight={numberSetting('maxHeight', 320)}
          runningAnimation={reasoningAnimation(props.appearance.runningAnimation)}
          showDuration={booleanSetting('showDuration', true)}
          reducedMotion={props.appearance.reducedMotion === true}
        />
      </Match>
      <Match when={kind() === 'content.redacted-reasoning'}>
        <ReasoningBlock
          text=""
          running={false}
          redacted
          redactedReason={typeof record().reason === 'string' ? record().reason as string : 'provider_redacted'}
          foreground={stringSetting('foreground', 'var(--text-dim)')}
          background={stringSetting('background', 'transparent')}
          borderColor={stringSetting('borderColor', 'color-mix(in srgb, var(--border) 72%, transparent)')}
          fontSize={optionalTypographySetting('fontSize', 13)}
          lineHeight={optionalTypographySetting('lineHeight', 1.6)}
          defaultCollapsed={booleanSetting('defaultCollapsed', true)}
          maxHeight={numberSetting('maxHeight', 320)}
          runningAnimation={reasoningAnimation(props.appearance.runningAnimation)}
          showDuration={booleanSetting('showDuration', true)}
          reducedMotion={props.appearance.reducedMotion === true}
        />
      </Match>
      <Match when={kind() === 'content.file-reference' || kind() === 'content.file-selection' || kind() === 'content.document' || kind() === 'content.resource'}>
        <SolidFileReferenceCard part={payload()} actions={{
          canOpen: can('resource.open'),
          canReveal: can('resource.reveal'),
          canCopy: can('clipboard.write'),
          open: target => execute('resource.open', target),
          reveal: target => execute('resource.reveal', target),
          copyPath: path => execute('clipboard.write', { text: path }),
        }} appearance={{
          foreground: stringSetting('foreground', 'var(--text)'),
          mutedForeground: stringSetting('mutedForeground', 'var(--text-dim)'),
          background: stringSetting('background', 'transparent'),
          borderColor: stringSetting('borderColor', 'var(--border)'),
          fontSize: numberSetting('fontSize', 13),
          iconSize: numberSetting('iconSize', 18),
          maxWidth: numberSetting('maxWidth', 960),
          maxHeight: numberSetting('maxHeight', 360),
          pathCollapse: filePathCollapse(props.appearance.pathCollapse),
          previewLines: numberSetting('previewLines', 12),
          showAbsolutePath: booleanSetting('showAbsolutePath', true),
          showMetadata: booleanSetting('showMetadata', true),
          fileTypePalette: fileTypePalette(props.appearance.fileTypePalette),
          groupLayout: fileGroupLayout(props.appearance.groupLayout),
        }} />
      </Match>
      <Match when={kind() === 'content.image' || kind() === 'content.audio' || kind() === 'content.video'}>
        <SolidMediaBlock
          part={payload()}
          resolverOptions={BUILTIN_MEDIA_RESOLVER_OPTIONS}
          onOpenExternal={can('resource.open') ? url => execute('resource.open', { uri: url }) : undefined}
          onDownload={can('resource.open') ? part => execute('resource.open', { ...part, disposition: 'download' }) : undefined}
          appearance={{
            foreground: stringSetting('foreground', 'var(--text)'),
            mutedForeground: stringSetting('mutedForeground', 'var(--text-dim)'),
            background: stringSetting('background', 'transparent'),
            borderColor: stringSetting('borderColor', 'var(--border)'),
            maxWidth: numberSetting('maxWidth', 960),
            maxHeight: numberSetting('maxHeight', 640),
            fit: mediaFit(props.appearance.fit),
            radius: numberSetting('radius', 8),
            defaultExpanded: booleanSetting('defaultExpanded', true),
            showCaption: booleanSetting('showCaption', true),
            showDownload: booleanSetting('showDownload', true),
            autoplay: booleanSetting('autoplay', false),
            controls: booleanSetting('controls', true),
            transcriptStyle: mediaTranscriptStyle(props.appearance.transcriptStyle),
            showMetadata: booleanSetting('showMetadata', true),
            reducedMotion: props.appearance.reducedMotion === true,
          }}
        />
      </Match>
      <Match when={kind() === 'content.search-result' || kind() === 'content.link'}>
        <Show when={kind() === 'content.search-result'
          ? isValidSearchResultContentInput(props.snapshot.payload) ? payload() : undefined
          : isValidLinkContentInput(props.snapshot.payload) ? payload() : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid {kind()} payload</pre>}>
          {part => <SolidSearchOrLink
            part={part()}
            actions={{
              open: can('resource.open') ? url => execute('resource.open', { uri: url }) : undefined,
              copy: can('clipboard.write') ? value => execute('clipboard.write', { text: value }) : undefined,
            }}
            appearance={searchLinkAppearance(props.appearance)}
          />}
        </Show>
      </Match>
      <Match when={kind() === 'content.diff'}>
        <Show when={isValidDiffContentInput(props.snapshot.payload) ? diffSnapshotFromPart(props.snapshot.payload) : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="content.diff">Invalid content.diff payload</pre>}>
          {snapshot => <SolidDiffContent snapshot={snapshot()} nodeId={props.snapshot.nodeId} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={kind() === 'content.terminal'}>
        <Show when={isValidTerminalContentInput(props.snapshot.payload) ? payload() : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="content.terminal">Invalid content.terminal payload</pre>}>
          {part => <SolidTerminalBlock
            part={part()}
            appearance={props.appearance}
            actions={{
              copy: can('clipboard.write')
                ? value => execute('clipboard.write', { text: value })
                : undefined,
            }}
          />}
        </Show>
      </Match>
      <Match when={kind() === 'content.log'}>
        <Show when={isValidLogContentInput(props.snapshot.payload) ? payload() : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="content.log">Invalid content.log payload</pre>}>
          {part => <SolidLogBlock part={part()} appearance={props.appearance} />}
        </Show>
      </Match>
      <Match when={kind() === 'diagnostic.lsp'}>
        <Show when={isValidLspDiagnosticContentInput(props.snapshot.payload)
          ? props.snapshot.payload as LspDiagnosticContentPart : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="diagnostic.lsp">Invalid diagnostic.lsp payload</pre>}>
          {diagnostic => <SolidLspDiagnosticContent diagnostic={diagnostic()} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={kind().startsWith('tool.')}>
        <Show
          when={isToolInvocationSnapshotInput(props.snapshot.payload) ? props.snapshot.payload as ToolInvocationSnapshot : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid tool snapshot</pre>}
        >
          {snapshot => <SolidToolInvocationCard snapshot={snapshot()} appearance={props.appearance} renderKind={kind()} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={kind() === 'activity.process'}>
        <Show
          when={isProcessActivitySnapshotInput(props.snapshot.payload)
            ? props.snapshot.payload as WorkbenchActivityNode : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="activity.process">Invalid process activity snapshot</pre>}
        >
          {activity => <SolidProcessActivity activity={activity()} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={[
        'activity.subagent', 'activity.delegation', 'activity.team',
      ].includes(kind())}>
        <Show
          when={isSubagentActivitySnapshotInput(props.snapshot.payload) || isWorkflowActivitySnapshotInput(props.snapshot.payload)
            ? props.snapshot.payload as WorkbenchActivityNode : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid subagent activity snapshot</pre>}
        >
          {activity => <SolidSubagentCard activity={activity()} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={[
        'activity.workflow', 'activity.workflow-phase', 'activity.workflow-agent',
      ].includes(kind())}>
        <Show
          when={isWorkflowActivitySnapshotInput(props.snapshot.payload)
            ? props.snapshot.payload as WorkbenchActivityNode : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid workflow activity snapshot</pre>}
        >
          {activity => <SolidWorkflowActivityCard activity={activity()} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={kind() === 'activity.background-task'}>
        <Show
          when={isBackgroundTaskActivitySnapshotInput(props.snapshot.payload)
            ? props.snapshot.payload as WorkbenchActivityNode : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid background task snapshot</pre>}
        >
          {activity => <SolidWorkflowActivityCard activity={activity()} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={kind().startsWith('interaction.')}>
        <Show
          when={isInteractionSnapshotInput(props.snapshot.payload) ? props.snapshot.payload as WorkbenchInteraction : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid interaction snapshot</pre>}
        >
          {interaction => <SolidInteractionCard interaction={interaction()} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={kind().startsWith('session.') || kind().startsWith('assist.')}>
        <Show
          when={BUILTIN_SESSION_RENDER_KINDS.find(definition => definition.id === kind())?.validateInput(props.snapshot.payload)
            ? props.snapshot.payload : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid {kind()} payload</pre>}
        >
          {value => <SolidSessionSurfaceCard
            kind={kind() as 'session.usage' | 'session.budget' | 'session.config' | 'session.commands' | 'assist.prediction' | 'assist.file-suggestions'}
            payload={value()}
            appearance={props.appearance}
            commands={props.commands}
          />}
        </Show>
      </Match>
      <Match when={kind() === 'content.plan'}>
        <Show
          when={isValidPlanContentInput(props.snapshot.payload) ? props.snapshot.payload : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="content.plan">Invalid content.plan payload</pre>}
        >
          {plan => <SolidPlanGoalContent payload={plan()} appearance={{
            foreground: stringSetting('foreground', 'var(--text)'),
            mutedForeground: stringSetting('mutedForeground', 'var(--text-dim)'),
            background: stringSetting('background', 'transparent'),
            borderColor: stringSetting('borderColor', 'var(--border)'),
            pendingColor: stringSetting('pendingColor', 'var(--text-dim)'),
            activeColor: stringSetting('activeColor', 'var(--accent)'),
            completedColor: stringSetting('completedColor', 'var(--tool-ok, var(--accent))'),
            cancelledColor: stringSetting('cancelledColor', 'var(--danger, #e5484d)'),
            blockedColor: stringSetting('blockedColor', 'var(--warning, #d29922)'),
            unknownColor: stringSetting('unknownColor', 'var(--text-dim)'),
            nodeGlyph: planNodeGlyph(props.appearance.nodeGlyph),
            connectorStyle: planConnectorStyle(props.appearance.connectorStyle),
            connectorColor: stringSetting('connectorColor', 'var(--border)'),
            connectorWidth: numberSetting('connectorWidth', 1),
            indent: numberSetting('indent', 20),
            defaultExpanded: booleanSetting('defaultExpanded', false),
            collapseCompleted: booleanSetting('collapseCompleted', true),
            showPriority: booleanSetting('showPriority', true),
            showBudget: booleanSetting('showBudget', true),
            density: props.appearance.density === 'compact' ? 'compact' : 'comfortable',
            reducedMotion: props.appearance.reducedMotion === true,
          }} />}
        </Show>
      </Match>
      <Match when={kind().startsWith('lifecycle.')}>
        <Show
          when={isValidLifecycleStateInput(props.snapshot.payload) ? props.snapshot.payload : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid lifecycle payload</pre>}
        >
          {state => <SolidLifecycleCard
            state={state()}
            reducedMotion={props.appearance.reducedMotion === true}
            appearance={lifecycleAppearance(props.appearance, stringSetting, booleanSetting)}
            onRetry={can('message.retry') ? () => execute('message.retry', undefined) : undefined}
            onRecover={can('session.recover') ? strategy => execute('session.recover', { strategy }) : undefined}
          />}
        </Show>
      </Match>
      <Match when={kind() === 'system.error'}>
        <Show
          when={isValidNormalizedErrorInput(props.snapshot.payload) ? props.snapshot.payload : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="system.error">Invalid system.error payload</pre>}
        >
          {error => <SolidSystemErrorCard
            error={error()}
            reducedMotion={props.appearance.reducedMotion === true}
            appearance={lifecycleAppearance(props.appearance, stringSetting, booleanSetting)}
            onRetry={can('message.retry') ? () => execute('message.retry', undefined) : undefined}
            onRecover={can('session.recover') ? strategy => execute('session.recover', { strategy }) : undefined}
            onOpenDiagnostics={() => execute('diagnostics.open', undefined)}
            dismissible
          />}
        </Show>
      </Match>
      <Match when={kind() === 'system.notice'}>
        <Show
          when={isValidSystemNoticeInput(props.snapshot.payload) ? props.snapshot.payload : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="system.notice">Invalid system.notice payload</pre>}
        >
          {notice => <SolidSystemNoticeCard
            notice={notice()}
            reducedMotion={props.appearance.reducedMotion === true}
            appearance={lifecycleAppearance(props.appearance, stringSetting, booleanSetting)}
          />}
        </Show>
      </Match>
      <Match when={[
        'content.memory', 'content.skill', 'content.mcp-resource', 'content.artifact',
      ].includes(kind())}>
        <Show when={isValidExtensionContent(kind(), props.snapshot.payload) ? props.snapshot.payload : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>Invalid {kind()} payload</pre>}>
          {data => <SolidExtensionContentCard kind={kind() as ExtensionRenderKind} payload={data()} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={kind() === 'system.hook'}>
        <Show when={isValidHookSurfaceInput(props.snapshot.payload) ? props.snapshot.payload : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind="system.hook">Invalid system.hook payload</pre>}>
          {hook => <SolidExtensionContentCard kind="system.hook" payload={hook()} appearance={props.appearance} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={kind() === 'content.unknown'}>
        <Show when={isUnknownContentPart(props.snapshot.payload) ? props.snapshot.payload : undefined}
          fallback={<pre class="solid-content-unknown" data-content-kind={kind()}>{unknownSummary(props.snapshot.payload, kind())}</pre>}>
          {part => <SolidUnknownContent part={part()} commands={props.commands} />}
        </Show>
      </Match>
      <Match when={isStructuredContentKind(kind())}>
        <SolidStructuredContent kind={kind() as StructuredContentKind}
          payload={props.snapshot.payload} commands={props.commands}
          renderPart={(part, index) => <ToolContentPart part={part} appearance={props.appearance} commands={props.commands}
            nodeId={`${props.snapshot.nodeId}:structured:${index}`} />} />
      </Match>
      </Switch>
    </div>
  )
}

function isValidExtensionContent(kind: string, payload: unknown): boolean {
  if (kind === 'content.memory') return isValidMemoryContentInput(payload)
  if (kind === 'content.skill') return isValidSkillContentInput(payload)
  if (kind === 'content.mcp-resource') return isValidMcpResourceContentInput(payload)
  if (kind === 'content.artifact') return isValidArtifactContentInput(payload)
  return false
}

function searchLinkAppearance(appearance: RenderAppearanceSnapshot): SearchLinkAppearance {
  return {
    foreground: appearanceString(appearance, 'foreground'),
    mutedForeground: appearanceString(appearance, 'mutedForeground'),
    background: appearanceString(appearance, 'background'),
    borderColor: appearanceString(appearance, 'borderColor'),
    fontSize: appearanceNumber(appearance, 'fontSize'),
    maxWidth: appearanceNumber(appearance, 'maxWidth'),
    maxHeight: appearanceNumber(appearance, 'maxHeight'),
    density: appearanceChoice(appearance, 'density', ['comfortable', 'compact']),
    grouped: appearanceBoolean(appearance, 'grouped'),
    highlightPalette: appearanceChoice(appearance, 'highlightPalette', ['semantic', 'accent', 'neutral']),
    defaultExpanded: appearanceBoolean(appearance, 'defaultExpanded'),
    pageSize: appearanceNumber(appearance, 'pageSize'),
    snippetLines: appearanceNumber(appearance, 'snippetLines'),
    pathDisplay: appearanceChoice(appearance, 'pathDisplay', ['full', 'basename', 'hidden']),
    linkOpenMode: appearanceChoice(appearance, 'linkOpenMode', ['external', 'copy-first']),
    showStatus: appearanceBoolean(appearance, 'showStatus'),
    reducedMotion: appearance.reducedMotion === true,
  }
}

function appearanceString(appearance: RenderAppearanceSnapshot, key: string): string | undefined {
  return typeof appearance[key] === 'string' ? appearance[key] : undefined
}

function appearanceNumber(appearance: RenderAppearanceSnapshot, key: string): number | undefined {
  return typeof appearance[key] === 'number' && Number.isFinite(appearance[key]) ? appearance[key] : undefined
}

function appearanceBoolean(appearance: RenderAppearanceSnapshot, key: string): boolean | undefined {
  return typeof appearance[key] === 'boolean' ? appearance[key] : undefined
}

function appearanceChoice<const Value extends string>(
  appearance: RenderAppearanceSnapshot,
  key: string,
  values: readonly Value[],
): Value | undefined {
  const value = appearance[key]
  return typeof value === 'string' && values.includes(value as Value) ? value as Value : undefined
}

function reasoningAnimation(value: unknown): 'pulse' | 'shimmer' | 'none' {
  return value === 'shimmer' || value === 'none' ? value : 'pulse'
}

function filePathCollapse(value: unknown): 'full' | 'middle' | 'basename' {
  return value === 'full' || value === 'basename' ? value : 'middle'
}

function fileTypePalette(value: unknown): 'auto' | 'neutral' | 'accent' {
  return value === 'neutral' || value === 'accent' ? value : 'auto'
}

function fileGroupLayout(value: unknown): 'stack' | 'grid' {
  return value === 'grid' ? 'grid' : 'stack'
}

function mediaFit(value: unknown): 'contain' | 'cover' | 'original' {
  return value === 'cover' || value === 'original' ? value : 'contain'
}

function mediaTranscriptStyle(value: unknown): 'panel' | 'plain' | 'compact' {
  return value === 'plain' || value === 'compact' ? value : 'panel'
}

function planNodeGlyph(value: unknown): 'status' | 'dot' | 'none' {
  return value === 'dot' || value === 'none' ? value : 'status'
}

function planConnectorStyle(value: unknown): 'solid' | 'dashed' | 'none' {
  return value === 'dashed' || value === 'none' ? value : 'solid'
}

function lifecycleAppearance(
  appearance: RenderAppearanceSnapshot,
  stringSetting: (key: string, fallback: string) => string,
  booleanSetting: (key: string, fallback: boolean) => boolean,
) {
  return {
    foreground: stringSetting('foreground', 'var(--text)'), mutedForeground: stringSetting('mutedForeground', 'var(--text-dim)'),
    background: stringSetting('background', 'transparent'), borderColor: stringSetting('borderColor', 'var(--border)'),
    infoColor: stringSetting('infoColor', 'var(--accent)'), warningColor: stringSetting('warningColor', 'var(--warning, #d29922)'),
    errorColor: stringSetting('errorColor', 'var(--danger, #e5484d)'), successColor: stringSetting('successColor', 'var(--tool-ok, var(--accent))'),
    density: appearance.density === 'compact' ? 'compact' as const : 'comfortable' as const,
    technicalDetailsExpanded: booleanSetting('technicalDetailsExpanded', false),
    noticePlacements: lifecyclePlacements(appearance.noticePlacements),
    retryCountdownStyle: lifecycleCountdownStyle(appearance.retryCountdownStyle),
    showProviderIds: booleanSetting('showProviderIds', false), showEventIds: booleanSetting('showEventIds', false),
    motion: appearance.motion === 'subtle' ? 'subtle' as const : 'none' as const,
  }
}

function lifecyclePlacements(value: unknown): readonly ('inline' | 'timeline' | 'toast')[] {
  if (!Array.isArray(value)) return ['inline', 'timeline']
  const placements = value.filter((item): item is 'inline' | 'timeline' | 'toast' => item === 'inline' || item === 'timeline' || item === 'toast')
  return placements.length > 0 ? placements : ['inline']
}

function lifecycleCountdownStyle(value: unknown): 'seconds' | 'compact' | 'hidden' {
  return value === 'compact' || value === 'hidden' ? value : 'seconds'
}

function unknownSummary(payload: unknown, kind: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const summary = (payload as Record<string, unknown>).summary
    if (typeof summary === 'string' && summary.trim()) return summary
  }
  return `Unsupported content kind: ${kind}`
}
