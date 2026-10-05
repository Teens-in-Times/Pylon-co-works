/** @jsxImportSource solid-js */
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { chatRowDescriptorsOf } from '../../domains/chat/chatRowPipeline.ts'
import { messageLookupsOf } from '../../domains/chat/messageLookups.ts'
import { prepareMessagesOf } from '../../domains/chat/messagePipeline.ts'
import type { Message } from '../../domains/chat/messageTypes.ts'
import type { MessageListItem } from '../../domains/workbench/messageListPort.ts'
import { reuseMessageListItems } from '../../domains/workbench/messageListPort.ts'
import type { WorkbenchMessage } from '../../domains/workbench/workbenchProjector.ts'
import { createToolConnectorLayoutPort } from '../../domains/workbench/toolConnectorLayoutPort.ts'
import { buildLegacyToolConnectorEdges, buildCanonicalToolConnectorEdges, mergeToolConnectorEdges } from './toolConnectorProjection.ts'
import { PlainMessageList } from './chat/PlainMessageList.solid.tsx'
import { SolidToolConnectorLayer } from './chat/ToolConnector.solid.tsx'
import type { SolidToolConnectorEdge } from './toolConnectorContracts.ts'
import { SolidGenerationFooter } from './chat/GenerationFooter.solid.tsx'
import { SolidControlCenter } from './input/ControlCenter.solid.tsx'
import type { SolidWorkbenchContextValue } from './SolidWorkbenchContext.solid.tsx'
import { SolidPlanGoalContent } from './chat/content/PlanGoalContent.solid.tsx'
import { messageMatchesQuery } from '../../domains/chat/messageSearchIndex.ts'
import { createSessionUiSignal } from './adapters/sessionUiSignal.solid.tsx'
import { selectAgentEmptyState } from '../../domains/workbench/agentEmptyState.ts'
import { canonicalTokenCount, selectActivityTimelinePlacement, toSolidMessage } from './solidWorkbenchProjectionSupport.ts'
import type { WorkbenchSessionCreationSnapshot } from '../../domains/workbench/workbenchCommandFacade.ts'
import { CanonicalActivityList } from './CanonicalActivityList.solid.tsx'
import { WorkbenchDocumentSurface } from './WorkbenchDocumentSurface.solid.tsx'
import { WorkbenchRow, isAuthoritativelyLive } from './WorkbenchRow.solid.tsx'
import { WorkbenchContentSlot } from './WorkbenchContentSlot.solid.tsx'
import EmptyState from '../../components/ui/EmptyState.solid.tsx'
// #486 项4：滚动跟随状态机与滚动条轨道交互拆出（本组件只保留投影与接线）。
import { createChatScrollController } from './chat/createChatScrollController.solid.tsx'
import { SolidScrollRail } from './chat/ScrollRail.solid.tsx'
import { readingColumnMaxWidth } from './chat/readingColumnWidth.ts'

export interface WorkbenchContentProps {
  context: SolidWorkbenchContextValue
}

export function WorkbenchContent(props: WorkbenchContentProps) {
  const snapshot = () => props.context.runtimeSnapshot()
  const appearance = () => props.context.appearanceSnapshot()
  const readingWidth = createMemo(() => {
    appearance()
    return readingColumnMaxWidth(props.context.activation, props.context.hostPort?.appearance.resolve)
  })
  const connectorPort = createToolConnectorLayoutPort()
  const [messageListPort, setMessageListPort] = createSignal<import('../../domains/workbench/messageListPort.ts').MessageListPort>()
  const sessionId = () => props.context.input().sessionId
  // #486 项4：吸底跟随/写迹/锁/smooth 守卫/轨道拖拽等滚动状态机整体在控制器内。
  const scroll = createChatScrollController({
    sessionId,
    snapshotRevision: () => snapshot().revision,
    reducedMotion: () => props.context.input().reducedMotion,
  })
  const sessionCreationReader = () => props.context.sessionCreation ?? props.context.commands.sessionCreation
  const [sessionCreation, setSessionCreation] = createSignal<WorkbenchSessionCreationSnapshot>(
    sessionCreationReader()?.getSnapshot() ?? { phase: 'idle', sessionId: null, error: null, attempt: 0 },
  )
  onMount(() => {
    const reader = sessionCreationReader()
    if (!reader) return
    const sync = () => setSessionCreation(reader.getSnapshot())
    sync()
    onCleanup(reader.subscribe(sync))
  })
  const creationProgressVisible = () => sessionCreation().phase === 'creating-session' && !sessionId()
  const [searchQuery] = createSessionUiSignal(props.context.sessionUi, sessionId, 'search-query', '')
  const [searchIndex, setSearchIndex] = createSessionUiSignal(props.context.sessionUi, sessionId, 'search-index', 0)
  let bottomAnchor: HTMLDivElement | undefined
  onCleanup(() => {
    bottomAnchor = undefined
    connectorPort.destroy()
  })
  const document = () => snapshot().document
  // P52 D5：transient 流字段已死（D3 后无生产写入者）——canonical running 行
  // 是唯一流式显示；此前的 transient 兜底 memo 与 appendTransient 注入随之退役。
  // #441-A：canonical 数组引用未变时直接复用上次结果（tool/usage 等事件的
  // 发布不改 messages 引用，`reduceTool` 只换 activities/timeline）。安全性前提与
  // `prepareMessagesOf` 同：快照冻结数组 + COW 纪律。
  // #487：legacy 快照 messages 面（含预览宿主 tool 行合并）退役——document.messages
  // 是唯一消息所有者，与生产/预览/回放同构。
  let lastViewCanonical: readonly WorkbenchMessage[] | undefined
  let lastView: readonly Message[] = []
  const viewMessages = createMemo<readonly Message[]>(() => {
    const canonical = document()?.messages ?? []
    if (lastViewCanonical === canonical) return lastView
    lastViewCanonical = canonical
    lastView = canonical.map(toSolidMessage)
    return lastView
  })
  const renderMessages = createMemo(() => prepareMessagesOf(viewMessages()))
  const searchMatches = createMemo(() => {
    if (!searchQuery().trim()) return []
    return viewMessages().filter(message => messageMatchesQuery(message, searchQuery()))
  })
  const activeSearchMessageId = createMemo(() => searchMatches()[searchIndex()]?.id)
  const descriptors = createMemo(() => chatRowDescriptorsOf(
    renderMessages(),
    messageLookupsOf(viewMessages()),
    activeSearchMessageId(),
  ))
  // P57 S2-R3：items per-key 复用——descriptor 全字段相等时沿用上个 MessageListItem
  // 引用，PlainMessageList 的引用相等门随之跳过行 update 与测量失效。
  // 复用循环在 `reuseMessageListItems`（#441 起抽出：显示链基准的接线出口，行为不变）。
  let lastItems: readonly MessageListItem[] = []
  const items = createMemo<readonly MessageListItem[]>(() => {
    const next = reuseMessageListItems(lastItems, descriptors())
    lastItems = next
    return next
  })
  const activityPlacement = createMemo(() => selectActivityTimelinePlacement(
    document(),
  ))
  const connectorEdges = createMemo<readonly SolidToolConnectorEdge[]>(() => mergeToolConnectorEdges(
    buildLegacyToolConnectorEdges(descriptors(), appearance()),
    buildCanonicalToolConnectorEdges(activityPlacement(), document(), props.context),
  ))

  createEffect(() => messageListPort()?.setItems(items()))
  createEffect(() => {
    const matchCount = searchMatches().length
    const currentIndex = searchIndex()
    const clampedIndex = matchCount === 0 || !Number.isSafeInteger(currentIndex)
      ? 0
      : Math.max(0, Math.min(currentIndex, matchCount - 1))
    if (clampedIndex !== currentIndex) setSearchIndex(clampedIndex)
  })
  createEffect(() => {
    const port = messageListPort()
    const messageId = activeSearchMessageId()
    if (port && messageId) void port.scrollTo({ messageId, align: 'center' })
  })

  return (
    <section
      class="solid-agent-workbench"
      data-renderer="solid"
      data-preview={props.context.input().preview ? 'true' : 'false'}
      data-paused={props.context.paused() ? 'true' : 'false'}
      data-session-id={props.context.input().sessionId ?? undefined}
      data-status={snapshot().status}
      data-creation-state={sessionCreation().phase}
      style={{
        '--right-panel-inset': `${Math.max(0, props.context.input().rightInset ?? 0)}px`,
      }}
      aria-label="Solid Agent Workbench"
    >
      <Show
        when={props.context.input().sessionId}
        fallback={<div class="solid-workbench-chat-shell solid-workbench-empty-chat-shell" data-chat-viewport="empty">
          <div
            ref={node => { scroll.registerViewport(node) }}
            class="chat-view solid-workbench-chat solid-workbench-empty-chat-viewport"
            data-chat-viewport="scroll"
            onScroll={scroll.onViewportScroll}
            onWheel={scroll.scrollIntent.onWheel}
            onTouchStart={scroll.scrollIntent.onTouchStart}
            onTouchMove={scroll.scrollIntent.onTouchMove}
            onTouchEnd={scroll.scrollIntent.onTouchEnd}
            onTouchCancel={scroll.scrollIntent.onTouchEnd}
            onKeyDown={scroll.scrollIntent.onKeyDown}
          >
            <div class="solid-workbench-empty-space">
              <WorkbenchEmptyBrand />
            </div>
          </div>
          <CreationOverlayHost
            visible={creationProgressVisible()}
            reducedMotion={props.context.input().reducedMotion === true}
          />
        </div>}
      >
        <div class="solid-workbench-chat-shell" data-chat-viewport="session">
          <div
            ref={node => { scroll.registerViewport(node) }}
            class="chat-view solid-workbench-chat"
            data-chat-viewport="scroll"
            data-reduced-motion={props.context.input().reducedMotion ? 'true' : 'false'}
            onScroll={scroll.onViewportScroll}
            onWheel={scroll.scrollIntent.onWheel}
            onTouchStart={scroll.scrollIntent.onTouchStart}
            onTouchMove={scroll.scrollIntent.onTouchMove}
            onTouchEnd={scroll.scrollIntent.onTouchEnd}
            onTouchCancel={scroll.scrollIntent.onTouchEnd}
            onKeyDown={scroll.scrollIntent.onKeyDown}
          >
            <div ref={node => { scroll.registerContent(node) }} class="term">
              <SolidToolConnectorLayer edges={connectorEdges()} layoutPort={connectorPort} />
              <div class="solid-workbench-reading-column mx-auto w-full min-w-0" style={{ 'max-width': `${readingWidth()}px` }}>
                <CanonicalActivityList
                  activities={activityPlacement().leading}
                  document={document()}
                  context={props.context}
                  connectorPort={connectorPort}
                />
                <PlainMessageList
                  initialItems={items()}
                  renderItem={item => <WorkbenchRow
                    descriptor={item.descriptor}
                    appearance={appearance()}
                    connectorPort={connectorPort}
                    context={props.context}
                  >
                    <CanonicalActivityList
                      activities={activityPlacement().afterMessage.get(item.descriptor.renderMessage.message.id) ?? []}
                      document={document()}
                      context={props.context}
                      connectorPort={connectorPort}
                    />
                  </WorkbenchRow>}
                  onPortReady={port => {
                    setMessageListPort(() => port)
                    port.setItems(items())
                  }}
                  onContentResize={scroll.onContentResize}
                  rowLive={item => isAuthoritativelyLive(props.context, item.descriptor.renderMessage.message)}
                  animateEntry={() => snapshot().generating
                    && !props.context.input().replayReadonly
                    && !props.context.input().reducedMotion}
                  scrollViewport={scroll.viewport}
                  scrollPosture={() => scroll.followBottom() ? 'follow' : 'pin'}
                />
                <WorkbenchDocumentSurface document={document()} context={props.context} commands={props.context.commands} sessionId={props.context.input().sessionId} reducedMotion={props.context.input().reducedMotion ?? false} />
                <SolidGenerationFooter
                  running={snapshot().generating}
                  // The runtime snapshot carries the document and live
                  // generation projection together.  Use its session identity
                  // (rather than the independently-updated mount input) so a
                  // session switch cannot reset the footer against the previous
                  // session's start timestamp for one render.
                  generationKey={snapshot().sessionId ?? ''}
                  // #390：回合身份也由宿主给出（`turnEpoch` 每回合 +1），footer 不再本地铸号。
                  turnId={snapshot().turnEpoch ?? 0}
                  tokenCount={canonicalTokenCount(document()?.session.usage, snapshot().tokenCount)}
                  startTime={snapshot().generationStart}
                  lastTokenAt={snapshot().lastTokenAt}
                  summary={snapshot().summary}
                  phase={snapshot().generationPhase}
                  activity={snapshot().generationActivity}
                  thinkingStart={snapshot().thinkingStart}
                  activeTaskContent={snapshot().tasks.find(task => task.status === 'in_progress')?.content}
                  appearance={appearance().spinner}
                  reducedMotion={props.context.input().reducedMotion}
                  onStop={props.context.input().preview ? undefined : () => {
                    const sessionId = props.context.input().sessionId
                    if (sessionId) void props.context.commands.cancel(sessionId)
                  }}
                />
                <WorkbenchContentSlot
                  nodeId={`${props.context.input().sessionId ?? 'none'}:plan`}
                  kind="content.plan"
                  payload={{ entries: document()?.plan.entries ?? [], goal: document()?.goal.current }}
                  context={props.context}
                  fallback={<SolidPlanGoalContent payload={{ entries: document()?.plan.entries ?? [], goal: document()?.goal.current }} />}
                />
              </div>
            </div>
            <div ref={bottomAnchor} class="solid-workbench-bottom-anchor" aria-hidden="true" />
          </div>
          <CreationOverlayHost
            visible={creationProgressVisible()}
            reducedMotion={props.context.input().reducedMotion === true}
          />
          <SolidScrollRail controller={scroll} />
        </div>
      </Show>
      <Show when={!props.context.input().replayReadonly}>
        <SolidControlCenter />
      </Show>
      <Show when={props.context.input().replayReadonly && props.context.input().sessionId}>
        <div class="solid-workbench-replay-overlay" role="status">历史回放 · 只读</div>
      </Show>
    </section>
  )
}

/** Brand-only empty-state layer. The control center remains the sole input
 * surface; this block provides recognition without duplicating instructions,
 * context rows, or creation controls.
 * #520 K 域：容器/标记/文案骨架由 ui/EmptyState 统一承载；本块只保留 brand
 * lockup（aria-hidden 装饰位）与 agent-empty-* CSS 锚点类（tactical-blue 覆写）。 */
function WorkbenchEmptyBrand() {
  const model = () => selectAgentEmptyState()
  return <EmptyState
    class="agent-empty-state solid-workbench-empty-brand"
    role="img"
    ariaLabel="Pylon Agent"
    mark={
      <div class="agent-empty-lockup" aria-hidden="true">
        <div class="agent-empty-brand">
          <svg class="pylon-mark" width="52" height="52" viewBox="0 0 64 64">
          <path class="pylon-mark-frame" d="M32 7 53 19v26L32 57 11 45V19Z" />
          <circle class="pylon-mark-node" cx="32" cy="21.215" r="4" />
          <circle class="pylon-mark-node" cx="20" cy="42" r="4" />
          <circle class="pylon-mark-node" cx="44" cy="42" r="4" />
          <path class="pylon-mark-links" d="m30 24.679-8 13.857m20 0-8-13.857M24 42h16" />
          </svg>
        </div>
        <span class="agent-empty-wordmark">PYLON</span>
      </div>
    }
    title={<>
      <div class="agent-empty-eyebrow">{model().eyebrow}</div>
      <h2 class="agent-empty-title">{model().title}</h2>
    </>}
  />
}

/** Creation feedback belongs to the chat viewport, not the control-center layout. */
function CreationOverlayHost(props: { visible: boolean; reducedMotion: boolean }) {
  return <div
    class="solid-workbench-creation-overlay-host"
    data-creation-overlay-host
    data-visible={props.visible ? 'true' : 'false'}
    data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
  >
    <Show when={props.visible}>
      <div class="solid-workbench-creation-progress" data-creation-progress role="status" aria-label="正在创建会话" aria-live="polite">
        <span class="solid-workbench-creation-progress-track" aria-hidden="true"><span class="solid-workbench-creation-progress-bar" /></span>
        <span class="solid-workbench-creation-progress-label">正在建立会话…</span>
      </div>
    </Show>
  </div>
}
