/** @jsxImportSource solid-js */
import { Index, Match, Show, Switch, createMemo, createSignal } from 'solid-js'
import { normalizeToolVisualState } from './toolConnectorProjection.ts'
import type { RenderMessage } from '../../domains/chat/messageTypes.ts'
import type { MessageListItem } from '../../domains/workbench/messageListPort.ts'
import { coalesceAdjacentDisplayTextParts, type ContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import { createToolConnectorLayoutPort } from '../../domains/workbench/toolConnectorLayoutPort.ts'
import { ReasoningBlock, SolidMessageRow } from './chat/MessageRow.solid.tsx'
import { SolidToolCard } from './chat/ToolCard.solid.tsx'
import { SolidRendererSlotHost } from './chat/RendererSlotHost.solid.tsx'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { streamingRowKey } from './streamingDisplayScheduler.ts'
import { renderBuiltinContentPart } from './solidBuiltinContentRenderer.solid.tsx'
import { WorkbenchContentSlot } from './WorkbenchContentSlot.solid.tsx'

export function WorkbenchRow(props: {
  descriptor: MessageListItem['descriptor']
  appearance: ReturnType<SolidWorkbenchContextValue['appearanceSnapshot']>
  connectorPort: ReturnType<typeof createToolConnectorLayoutPort>
  context: SolidWorkbenchContextValue
  children?: import('solid-js').JSX.Element
}) {
  const [draftBusy, setDraftBusy] = createSignal(false)
  const [draftError, setDraftError] = createSignal('')
  const current = () => props.descriptor.renderMessage
  const resolveDraft = async (action: 'keep' | 'discard') => {
    const draftId = current().message.draftId
    const sessionId = props.context.runtimeSnapshot().sessionId
    if (!draftId || !sessionId || !props.context.commands.resolveDraft || draftBusy()) return
    setDraftBusy(true)
    setDraftError('')
    try {
      const result = await props.context.commands.resolveDraft(sessionId, draftId, action)
      if (!result.ok) setDraftError(result.error ?? '临时内容处理失败')
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error))
    } finally {
      setDraftBusy(false)
    }
  }
  const visualState = () => normalizeToolVisualState(props.descriptor.toolVisualState)
  // message.* Slots own row framing. Reasoning is a content.* contract and must
  // stay inside the reasoning row, where WorkbenchMessageContent supplies its
  // normalized payload (text/state/duration or redaction reason).
  const messageFrameKind = () => current().message.role === 'user' ? 'message.user'
    : current().message.role === 'assistant' ? 'message.assistant'
      : undefined
  const slotCandidates = () => {
    const kind = messageFrameKind()
    return kind
      ? (props.context.activation?.slots.get(kind) ?? []).filter(entry => entry.value.kinds.includes(kind))
      : []
  }
  return (
    <>
      <Switch>
        <Match when={current().type === 'tool_call' || current().type === 'tool_result'}>
          <div class="term-row term-row-tool" data-render-type={current().type}>
            <SolidToolCard
              message={current().message}
              visualState={visualState()}
              appearance={props.appearance}
              messageId={current().message.id}
              layoutPort={props.connectorPort}
            />
          </div>
        </Match>
        <Match when={slotCandidates().length > 0}>
          <SolidRendererSlotHost
            candidates={slotCandidates()}
            node={{ nodeId: current().message.id, kind: messageFrameKind() ?? 'content.unknown', revision: props.context.runtimeSnapshot().revision, payload: current() }}
            context={props.context}
            fallback={<WorkbenchDefaultMessage
              renderMessage={current()}
              appearance={props.appearance}
              highlighted={props.descriptor.isSearchMatch}
              context={props.context}
            />}
          />
        </Match>
        <Match when={true}>
          <WorkbenchDefaultMessage
            renderMessage={current()}
            appearance={props.appearance}
            highlighted={props.descriptor.isSearchMatch}
            context={props.context}
          />
        </Match>
      </Switch>
      <Show when={current().message.interruptedDraft === true && current().message.draftId}>
        <div class="mt-1 flex items-center gap-2 text-xs opacity-80" role="status">
          <span>临时内容已中断</span>
          <button type="button" disabled={draftBusy()} onClick={() => { void resolveDraft('keep') }}>保留为历史</button>
          <button type="button" disabled={draftBusy()} onClick={() => { void resolveDraft('discard') }}>丢弃</button>
          <Show when={draftError()}><span role="alert">{draftError()}</span></Show>
        </div>
      </Show>
      {props.children}
    </>
  )
}

function WorkbenchDefaultMessage(props: {
  renderMessage: RenderMessage
  appearance: ReturnType<SolidWorkbenchContextValue['appearanceSnapshot']>
  highlighted: boolean
  context: SolidWorkbenchContextValue
}) {
  // Materialise the semantic subtree once. Passing the component expression
  // directly as a JSX prop makes every semanticContent read construct another
  // Slot host before Solid's role branch selects its visible child.
  const semanticContent = <WorkbenchMessageContent renderMessage={props.renderMessage} context={props.context} />
  return <SolidMessageRow
    renderMessage={props.renderMessage}
    appearance={props.appearance}
    highlighted={props.highlighted}
    live={() => isAuthoritativelyLive(props.context, props.renderMessage.message)}
    semanticContent={semanticContent}
  />
}

/**
 * #213 权威活性：本进程有在途回合、且这一行还没终结。
 *
 * **插件契约与生成态显示**用这个：终态即假——`data-streaming`、reasoning 的
 * `state`/pulse、Slot 的 `streaming` 标志都必须随终态收，不能粘滞。
 */
export function isAuthoritativelyLive(
  context: SolidWorkbenchContextValue,
  message: { running?: boolean },
): boolean {
  return context.runtimeSnapshot().generating === true && message.running === true
}

/**
 * #212 判据 C：**渲染路径**判据——权威活性之外，再加「被观察到在增长」的粘滞。
 *
 * 只用于内置 markdown 的增量/静态分流：被观察到真的在长的行必须留在增量（graft）路径，
 * 否则每一拍的新前缀都会走静态路径整段重解析（O(N²)）。它是 #213 权威判据的兜底
 * （例如某条 live 流没能建立时钟），不参与任何对外语义。缺省（legacy 夹具）只认权威活性。
 */
function isIncrementalRow(
  context: SolidWorkbenchContextValue,
  message: { id: string; role: string; running?: boolean },
): boolean {
  if (isAuthoritativelyLive(context, message)) return true
  return context.revealingRows?.().has(streamingRowKey(message.id, message.role)) === true
}

function WorkbenchMessageContent(props: {
  renderMessage: RenderMessage
  context: SolidWorkbenchContextValue
}) {
  const message = () => props.renderMessage.message
  const parts = () => {
    const canonical = message().semanticParts
    if (canonical && canonical.length > 0) return canonical
    return [{ kind: 'markdown', text: message().content }] as const satisfies readonly ContentPart[]
  }
  if (props.renderMessage.type === 'reasoning') {
    const redacted = () => message().redacted === true
    const kind = () => redacted() ? 'content.redacted-reasoning' : 'content.reasoning'
    const live = () => isAuthoritativelyLive(props.context, message())
    const payload = () => redacted()
      ? { reason: message().redactedReason ?? 'provider_redacted' }
      : {
          text: message().content,
          state: live() ? 'running' : message().content.trim() ? 'complete' : 'missing',
          ...(message().thoughtDurationMs !== undefined ? { durationMs: message().thoughtDurationMs } : {}),
        }
    return <Show keyed when={kind()}>{renderKind => <WorkbenchContentSlot
        nodeId={`${message().id}:reasoning`} kind={renderKind} payload={payload()}
        context={props.context}
        fallback={<ReasoningBlock
          text={message().content} running={live()}
          startedAt={message().thoughtStartedAt} durationMs={message().thoughtDurationMs}
          redacted={redacted()} redactedReason={message().redactedReason}
        />}
      />}</Show>
  }
  const inline = props.renderMessage.type === 'user'
  // A provider stream commonly emits one semantic text part per delta. Each
  // part used to be parsed as an independent Markdown document, which made
  // every few-token chunk become its own block/line. Merge adjacent textual
  // parts before dispatching to the renderer; non-text parts stay boundaries.
  const renderParts = createMemo(() => coalesceAdjacentDisplayTextParts(parts()))
  return <Index each={renderParts()}>{(part, index) => (
    <WorkbenchMessagePart
      part={part}
      index={index}
      renderMessage={props.renderMessage}
      inline={inline}
      context={props.context}
    />
  )}</Index>
}

function WorkbenchMessagePart(props: {
  part: () => ContentPart
  index: number
  renderMessage: RenderMessage
  inline: boolean
  context: SolidWorkbenchContextValue
}) {
  const message = () => props.renderMessage.message
  const kind = () => contentRenderKind(props.part())
  // 插件契约：这一行是否仍在被生产——权威活性，不含判据 C 的粘滞（终态即假）。
  const streaming = () => props.renderMessage.type === 'assistant'
    && isAuthoritativelyLive(props.context, message())
    && (props.part().kind === 'text' || props.part().kind === 'markdown')
  // 渲染路径：#212 判据 C，被观察到在增长的行留在增量（graft）路径上。
  const incrementalPath = () => props.renderMessage.type === 'assistant'
    && isIncrementalRow(props.context, message())
    && (props.part().kind === 'text' || props.part().kind === 'markdown')
  // A payload update keeps the Slot instance. A semantic kind change is a real
  // boundary and must remount so candidate selection cannot retain the old kind.
  return <Show keyed when={kind()}>{renderKind => (
    <WorkbenchContentSlot
      nodeId={`${message().id}:part:${props.index}`}
      kind={renderKind}
      payload={props.part()}
      streaming={streaming()}
      context={props.context}
      fallback={renderBuiltinContentPart(props.part(), props.inline, props.context, incrementalPath())}
    />
  )}</Show>
}

function contentRenderKind(part: ContentPart): string {
  if (part.kind === 'unknown') return 'content.unknown'
  if (part.kind === 'diagnostic-lsp') return 'diagnostic.lsp'
  return part.kind.includes('.') ? part.kind : `content.${part.kind}`
}
