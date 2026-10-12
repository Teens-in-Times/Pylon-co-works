/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js'
import type { WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import { SolidLifecycleCard, SolidSystemErrorCard, SolidSystemNoticeCard } from './chat/LifecycleCard.solid.tsx'
import { SolidSessionSurfaceCard } from './chat/content/SessionSurfaceCard.solid.tsx'
import { SolidInteractionCard } from './chat/content/InteractionCard.solid.tsx'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { fallbackRenderCommands, renderExtensionFallback, sessionSurfaceAppearance } from './solidBuiltinContentRenderer.solid.tsx'
import { interactionRenderKind, lifecycleRenderKind, visibleDiagnostics } from './solidWorkbenchProjectionSupport.ts'
import { isControlCenterConfigOption } from './input/workbenchOptionCatalog.ts'
import { WorkbenchContentSlot } from './WorkbenchContentSlot.solid.tsx'
import type { AssistSnapshot } from '../../domains/workbench/session/sessionSurface.ts'

export function WorkbenchDocumentSurface(props: {
  document: WorkbenchDocument | undefined
  context: SolidWorkbenchContextValue
  commands: SolidWorkbenchContextValue['commands']
  sessionId: string | null
  reducedMotion: boolean
}) {
  /**
   * `session.started` carries the ACP negotiation catalogue.  Those model /
   * mode / reasoning entries are consumed by the control-center selectors and
   * must not become a second, persistent config form below the conversation.
   * A later ordinary `session.config-updated` event is intentionally kept
   * visible when there was no startup negotiation; existing agents use that
   * event for editable runtime settings and it must retain its editor.
   *
   * Keep this check on the projected timeline rather than guessing from the
   * option id alone.  `id: "model"` is also a valid ordinary config option,
   * and filtering it unconditionally regresses the normal config surface.
   */
  const hasSessionStartNegotiation = () => props.document?.timeline.some(entry => {
    if (entry.kind !== 'session' || !entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) return false
    const event = entry.data as { type?: unknown; options?: unknown }
    return event.type === 'session.started' && Array.isArray(event.options)
  }) ?? false
  const visibleConfigOptions = () => {
    const options = props.document?.session.options ?? []
    return hasSessionStartNegotiation()
      ? options.filter(option => !isControlCenterConfigOption(option))
      : options
  }
  /** #394 修订：预测只在输入框呈现。排队命令沿用辅助 slot，但不携带预测文本/按钮。 */
  const queuedAssist = (): AssistSnapshot | undefined => {
    const command = props.document?.assist.queuedCommand
    return command ? { files: [], queuedCommand: command } : undefined
  }
  return (
    <Show when={props.document}>
      {document => (
        <>
          <Show when={document().timeline.length > 0}>
            <div class="solid-workbench-timeline" aria-label="事件时间线" data-timeline-count={document().timeline.length} />
          </Show>
          <Show when={lifecycleRenderKind(document().lifecycle)}>
            {kind => <WorkbenchContentSlot
              nodeId={`${props.sessionId ?? 'none'}:lifecycle`}
              kind={kind()}
              payload={document().lifecycle}
              context={props.context}
              fallback={<SolidLifecycleCard
                state={document().lifecycle}
                reducedMotion={props.reducedMotion}
                onRetry={props.sessionId && props.context.hostPort?.capabilities.has('retry')
                  ? () => { void props.commands.retry(props.sessionId!) }
                  : undefined}
                onRecover={props.sessionId && props.context.hostPort?.capabilities.has('recovery')
                  ? strategy => { void props.commands.recover(props.sessionId!, strategy) }
                  : undefined}
              />}
            />}
          </Show>
          <For each={document().systemErrors}>{(error, index) => (
            <WorkbenchContentSlot
              nodeId={`${props.sessionId ?? 'none'}:system-error:${error.eventId ?? error.code ?? index()}`}
              kind="system.error"
              payload={error}
              context={props.context}
              fallback={<SolidSystemErrorCard
                error={error}
                reducedMotion={props.reducedMotion}
                onRetry={props.sessionId && props.context.hostPort?.capabilities.has('retry')
                  ? () => { void props.commands.retry(props.sessionId!) }
                  : undefined}
                onRecover={props.sessionId && props.context.hostPort?.capabilities.has('recovery')
                  ? strategy => { void props.commands.recover(props.sessionId!, strategy) }
                  : undefined}
                onOpenDiagnostics={() => { void fallbackRenderCommands(props.context).execute({ type: 'diagnostics.open' }) }}
                dismissible
              />}
            />
          )}</For>
          <Show when={queuedAssist()}>{assist => (
            <WorkbenchContentSlot
              nodeId={`${props.sessionId ?? 'none'}:assist:queued-command`}
              kind="assist.prediction"
              payload={assist()}
              context={props.context}
              fallback={<SolidSessionSurfaceCard kind="assist.prediction" payload={assist()}
                appearance={sessionSurfaceAppearance(props.context, 'assist.prediction')}
                commands={fallbackRenderCommands(props.context)} />}
            />
          )}</Show>
          <Show when={(document().assist?.files?.length ?? 0) > 0}>
            <WorkbenchContentSlot
              nodeId={`${props.sessionId ?? 'none'}:assist:files`}
              kind="assist.file-suggestions"
              payload={document().assist}
              context={props.context}
              fallback={<SolidSessionSurfaceCard kind="assist.file-suggestions" payload={document().assist}
                appearance={sessionSurfaceAppearance(props.context, 'assist.file-suggestions')}
                commands={fallbackRenderCommands(props.context)} />}
            />
          </Show>
          <Show when={document().interactions.length > 0}>
            <div class="solid-workbench-interactions" aria-label="交互">
              <For each={document().interactions}>{interaction => (
                <WorkbenchContentSlot
                  nodeId={`${props.sessionId ?? 'none'}:interaction:${interaction.id}`}
                  kind={interactionRenderKind(interaction)}
                  payload={interaction}
                  context={props.context}
                  fallback={<SolidInteractionCard
                    interaction={interaction}
                    appearance={{ ...props.context.appearanceSnapshot(), reducedMotion: props.reducedMotion }}
                    commands={fallbackRenderCommands(props.context)}
                  />}
                />
              )}</For>
            </div>
          </Show>
          <Show when={document().extensions.length > 0}>
            <div class="solid-workbench-extensions" aria-label="扩展事件" data-extension-count={document().extensions.length}>
              <For each={document().extensions}>{extension => (
                <WorkbenchContentSlot
                  nodeId={`${props.sessionId ?? 'none'}:extension:${extension.id}`}
                  kind={extension.kind}
                  payload={extension.payload}
                  context={props.context}
                  fallback={renderExtensionFallback(extension, props.context)}
                />
              )}</For>
            </div>
          </Show>
          <Show when={visibleConfigOptions().length > 0}>
            <div class="solid-workbench-config" data-config-count={visibleConfigOptions().length}>
              <WorkbenchContentSlot
                nodeId={`${props.sessionId ?? 'none'}:session:config`}
                kind="session.config"
                payload={{ options: visibleConfigOptions() }}
                context={props.context}
                fallback={<SolidSessionSurfaceCard kind="session.config" payload={{ options: visibleConfigOptions() }}
                  appearance={sessionSurfaceAppearance(props.context, 'session.config')}
                  commands={fallbackRenderCommands(props.context)} />}
              />
            </div>
          </Show>
          <Show when={(document().session.commands?.length ?? 0) > 0}>
            <div class="solid-workbench-commands" data-command-count={document().session.commands?.length ?? 0}>
              <WorkbenchContentSlot
                nodeId={`${props.sessionId ?? 'none'}:session:commands`}
                kind="session.commands"
                payload={{ commands: document().session.commands ?? [] }}
                context={props.context}
                fallback={<SolidSessionSurfaceCard kind="session.commands" payload={{ commands: document().session.commands ?? [] }}
                  appearance={sessionSurfaceAppearance(props.context, 'session.commands')}
                  commands={fallbackRenderCommands(props.context)} />}
              />
            </div>
          </Show>
          <Show when={visibleDiagnostics(document()).length > 0}>
            <div class="solid-workbench-diagnostics" aria-label="诊断">
              <For each={visibleDiagnostics(document())}>{diagnostic => (
                <WorkbenchContentSlot
                  nodeId={`${props.sessionId ?? 'none'}:notice:${diagnostic.eventId}`}
                  kind="system.notice"
                  payload={diagnostic}
                  context={props.context}
                  fallback={<SolidSystemNoticeCard notice={diagnostic} reducedMotion={props.reducedMotion} />}
                />
              )}</For>
            </div>
          </Show>
        </>
      )}
    </Show>
  )
}
