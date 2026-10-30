/** @jsxImportSource solid-js */
import { ErrorBoundary, Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js'
import type { RenderMessage } from '../../../domains/chat/messageTypes.ts'
import { formatThoughtDuration } from '../../../domains/rendererContent/reasoningPresentation.ts'
import { createScrollUserIntent } from '../../../domains/chat/scrollUserIntent.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../domains/appearance/appearance.ts'
import { MarkdownContent } from './MarkdownContent.solid.tsx'
import { SolidCollapsibleRegion } from './CollapsibleRegion.solid.tsx'
import { createCollapsiblePresenter } from './CollapsiblePresenter.solid.tsx'
import { createFrameTask } from '../frameTask.ts'
import { createCopyFeedback } from '../../../utils/copyFeedback.ts'
import { formatMessageClock } from '../../../domains/chat/messageTime.ts'

/** 头像缩写：取显示名的首个字符（`Array.from` 按码点切，避免拆开 emoji/代理对）。 */
export function avatarInitials(name: string): string {
  const first = Array.from(name.trim())[0]
  return (first ?? '?').toUpperCase()
}

export interface SolidMessageRowProps {
  renderMessage: RenderMessage
  appearance: Pick<WorkbenchAppearanceSnapshot,
    'userName' | 'userPrefix' | 'userColor' | 'assistantDot' | 'assistantDotGlyph' | 'assistantDotImage'>
  highlighted?: boolean
  resolveUserName?: (sender: string) => string | undefined
  now?: () => number
  rowRef?: (node: HTMLDivElement | null) => void
  /**
   * #212/#213：这一行现在是否「活」（走增量路径、显示生成态）。
   * 缺省回落到 `message.running`——独立用例与 legacy 宿主行为不变。
   */
  live?: () => boolean
  /** Production Workbench may route canonical content parts through Suite-local Slots. */
  semanticContent?: JSX.Element
}

export function SolidMessageRow(props: SolidMessageRowProps) {
  const message = () => props.renderMessage.message
  const live = () => props.live?.() ?? message().running === true
  onCleanup(() => props.rowRef?.(null))
  return (
    <ErrorBoundary fallback={error => (
      <div class="term-row term-row-error" role="alert">
        消息渲染失败：{error instanceof Error ? error.message : String(error)}
      </div>
    )}>
      <div
        ref={node => props.rowRef?.(node)}
        class={`term-row term-row-${message().role}${props.highlighted ? ' term-row-search-active' : ''}`}
        data-render-type={props.renderMessage.type}
        data-pylon-component="message"
        data-message-role={message().role}
        data-streaming={live() ? 'true' : undefined}
      >
        <Show when={props.renderMessage.type === 'user'}>
          <UserLine
            sender={message().sender}
            content={message().content}
            time={message().time}
            appearance={props.appearance}
            resolveUserName={props.resolveUserName}
            semanticContent={props.semanticContent}
          />
        </Show>
        <Show when={props.renderMessage.type === 'assistant'}>
          <AssistantContent
            sender={message().sender}
            time={message().time}
            text={message().content}
            appearance={props.appearance}
            streaming={live()}
            semanticContent={props.semanticContent}
          />
        </Show>
        <Show when={props.renderMessage.type === 'reasoning'}>
          <Show when={props.semanticContent !== undefined} fallback={
            <ReasoningBlock
              text={message().content}
              running={live()}
              startedAt={message().thoughtStartedAt}
              durationMs={message().thoughtDurationMs}
              now={props.now}
              redacted={message().redacted === true}
              redactedReason={message().redactedReason}
            />
          }>{props.semanticContent}</Show>
        </Show>
        <Show when={props.renderMessage.type === 'error' || props.renderMessage.type === 'system'}>
          <div class="term-row-error" role="alert">{message().content || '系统消息'}</div>
        </Show>
      </div>
    </ErrorBoundary>
  )
}

export function AssistantContent(props: {
  text: string
  sender?: string
  time?: string
  appearance: Pick<WorkbenchAppearanceSnapshot, 'assistantDot' | 'assistantDotGlyph' | 'assistantDotImage'>
  streaming?: boolean
  semanticContent?: JSX.Element
}) {
  const { copied, markCopied } = createCopyFeedback()
  const [completionPhase, setCompletionPhase] = createSignal<'idle' | 'settling' | 'complete'>('idle')
  let wasStreaming = props.streaming === true
  let completed = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let clearTimer: ReturnType<typeof setTimeout> | undefined
  const clearMotionTimers = () => {
    if (settleTimer !== undefined) clearTimeout(settleTimer)
    if (clearTimer !== undefined) clearTimeout(clearTimer)
    settleTimer = undefined
    clearTimer = undefined
  }
  createEffect(() => {
    // The terminal flag can arrive before the display scheduler reveals its
    // remaining text. Each visible growth postpones the single finish cue.
    const visibleText = props.text
    if (props.streaming === true) {
      wasStreaming = true
      completed = false
      clearMotionTimers()
      setCompletionPhase('idle')
      return
    }
    if (!wasStreaming || completed || visibleText.length === 0) return
    clearMotionTimers()
    setCompletionPhase('settling')
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      completed = true
      setCompletionPhase('complete')
      clearTimer = setTimeout(() => {
        clearTimer = undefined
        setCompletionPhase('idle')
      }, 760)
    }, 440)
  })
  onCleanup(clearMotionTimers)

  const copy = () => {
    void navigator.clipboard?.writeText(props.text).catch(() => {})
    markCopied()
  }

  const clock = () => formatMessageClock(props.time)

  return (
    <div class={`term-assistant${props.appearance.assistantDot ? ' has-dot' : ''}`}>
      <Show when={props.appearance.assistantDot}>
        <Show
          when={props.appearance.assistantDotImage}
          fallback={<span class="term-assistant-dot" aria-hidden="true">{props.appearance.assistantDotGlyph || '●'}</span>}
        >
          {src => <img class="term-assistant-dot-img" src={src()} alt="" aria-hidden="true" />}
        </Show>
      </Show>
      <div class="term-assistant-meta">
        <span class="term-assistant-name">{props.sender}</span>
        <Show when={clock()}>
          {value => <time class="term-row-time" datetime={props.time}>{value()}</time>}
        </Show>
      </div>
      <button class="copy-btn" type="button" onClick={copy} aria-label="复制消息">{copied() ? '✓' : '⎘'}</button>
      <div class="term-assistant-body">
        <Show when={props.semanticContent !== undefined} fallback={<MarkdownContent text={props.text} streaming={props.streaming} />}>
          {props.semanticContent}
        </Show>
        <Show when={props.streaming || completionPhase() === 'settling'}>
          <span class="term-stream-sheen" aria-hidden="true" />
        </Show>
        <Show when={completionPhase() === 'complete'}>
          <span class="term-stream-completion" aria-hidden="true" />
        </Show>
      </div>
    </div>
  )
}

function UserLine(props: {
  sender: string
  content: string
  time?: string
  appearance: Pick<WorkbenchAppearanceSnapshot, 'userName' | 'userPrefix' | 'userColor'>
  resolveUserName?: (sender: string) => string | undefined
  semanticContent?: JSX.Element
}) {
  const name = () => props.appearance.userName
    || props.resolveUserName?.(props.sender)
    || props.sender.replace(/^.*:/, '')
  const colorStyle = () => props.appearance.userColor ? { color: props.appearance.userColor } : undefined
  const clock = () => formatMessageClock(props.time)

  return (
    <div class="term-user">
      <span class="term-user-avatar" aria-hidden="true" style={colorStyle()}>{avatarInitials(name())}</span>
      <div class="term-user-meta">
        <span class="term-user-prefix" style={colorStyle()}>{props.appearance.userPrefix || '❯'}</span>
        <span class="term-user-name" style={colorStyle()}>{name()}</span>
        <Show when={clock()}>
          {value => <time class="term-row-time" datetime={props.time}>{value()}</time>}
        </Show>
      </div>
      <div class="term-user-bubble">
        <div class="term-user-content">
          <Show when={props.semanticContent !== undefined} fallback={<MarkdownContent text={props.content} inline />}>
            {props.semanticContent}
          </Show>
        </div>
      </div>
    </div>
  )
}

/**
 * #208：折叠态可惰性渲染的正文长度阈值（字符）。
 *
 * 折叠容器是 `display:none`，但 Solid 仍会为隐藏正文建 DOM 并跑 markdown 解析；实测折叠的
 * reasoning 体渲染 1.6 万字符、单块 20 万字符的解析要 20ms+，长会话累计到 449k 字符 DOM。
 * 超过本阈值才惰性化——短正文保持既有契约（折叠时也在 DOM 里），长正文展开才渲染。
 */
const LAZY_REASONING_BODY_CHARS = 8_000

export function ReasoningBlock(props: {
  text: string
  running: boolean
  startedAt?: number
  durationMs?: number
  now?: () => number
  /** C01：provider 隐去推理——显示安全占位与原因，正文不可见。 */
  redacted?: boolean
  redactedReason?: string
  foreground?: string
  background?: string
  borderColor?: string
  fontSize?: number
  lineHeight?: number
  defaultCollapsed?: boolean
  maxHeight?: number
  runningAnimation?: 'pulse' | 'shimmer' | 'none'
  showDuration?: boolean
  reducedMotion?: boolean
}) {
  const collapsedByDefault = () => props.defaultCollapsed !== false
  const collapse = createCollapsiblePresenter({
    defaultOpen: () => !collapsedByDefault(),
    resetOnDefaultChange: true,
    idPrefix: 'solid-reasoning',
  })
  // C01 四态：running / complete(duration) / redacted(reason) / missing(无内容且非 running)
  const label = () => {
    if (props.redacted) return '推理已被隐藏'
    if (props.running) return '正在思考…'
    if (props.showDuration !== false && props.durationMs !== undefined) return formatThoughtDuration(props.durationMs)
    if (props.text.trim()) return '思考过程'
    return '暂无思考内容'
  }
  const state = () => props.redacted ? 'redacted' : props.running ? 'running' : props.text.trim() ? 'complete' : 'missing'
  const runningAnimation = () => props.reducedMotion || props.runningAnimation === 'none'
    ? 'none'
    : props.runningAnimation === 'shimmer' ? 'shimmer' : 'pulse'
  const rootStyle = () => ({
    '--reasoning-foreground': props.foreground ?? 'var(--text-dim)',
    color: props.foreground ?? 'var(--text-dim)',
    'background-color': props.background ?? 'transparent',
    // Leave typography unset by default so the reasoning row inherits the
    // same message font/line-height as user and assistant rows.  Renderer
    // settings can still provide an explicit override when requested.
    ...(props.fontSize !== undefined ? { 'font-size': `${props.fontSize}px` } : {}),
    ...(props.lineHeight !== undefined ? { 'line-height': String(props.lineHeight) } : {}),
  })
  const bodyStyle = () => ({
    'max-height': `${props.maxHeight ?? 320}px`,
    'border-color': props.borderColor ?? 'color-mix(in srgb, var(--border) 72%, transparent)',
  })
  let bodyElement: HTMLDivElement | undefined
  let followBottom = true
  let lastFollowTop: number | undefined
  let lastObservedScrollTop = 0
  const follow = createFrameTask(() => {
    if (!bodyElement || !followBottom || !props.running || !collapse.open() || props.redacted) return
    const top = Math.max(0, bodyElement.scrollHeight - bodyElement.clientHeight)
    // Duplicate markdown/highlight notifications must not fight the outer rail.
    if (lastFollowTop !== undefined && Math.abs(lastFollowTop - top) <= 0.5
      && Math.abs(bodyElement.scrollTop - top) <= 0.5) return
    bodyElement.scrollTop = top
    lastFollowTop = top
  })
  onCleanup(follow.dispose)
  const scrollIntent = createScrollUserIntent(() => {
    lastObservedScrollTop = bodyElement?.scrollTop ?? 0
    followBottom = false
    lastFollowTop = undefined
    follow.cancel()
  })
  const onBodyScroll = () => {
    if (!bodyElement) return
    const movingDown = bodyElement.scrollTop > lastObservedScrollTop
    lastObservedScrollTop = bodyElement.scrollTop
    const distance = bodyElement.scrollHeight - bodyElement.scrollTop - bodyElement.clientHeight
    followBottom = followBottom ? distance < 24 : movingDown && distance <= 1
    if (!followBottom) lastFollowTop = undefined
  }
  createEffect(() => {
    const text = props.text
    const running = props.running
    const open = collapse.open()
    if (!text || !running || !open || !bodyElement || !followBottom || props.redacted) follow.cancel()
    else follow.schedule()
  })

  return (
    <div
      class="term-reasoning"
      data-state={state()}
      data-running-animation={runningAnimation()}
      style={rootStyle()}
    >
      <Show when={state() !== 'redacted' && state() !== 'missing'} fallback={
        // redacted/missing：无 body 可展开，原因作为可见说明文本
        <div class="term-reasoning-head term-reasoning-static">
          <span class="term-reasoning-label" aria-live={props.running ? 'polite' : undefined}>{label()}</span>
          <Show when={props.redacted && props.redactedReason}>
            {reason => <span class="term-reasoning-reason">{reason()}</span>}
          </Show>
        </div>
      }>
        <button class="term-reasoning-head" type="button" onClick={collapse.toggle} aria-expanded={collapse.open()} aria-controls={collapse.bodyId}>
          <span class="term-reasoning-label" aria-live={props.running ? 'polite' : undefined}>{label()}</span>
          <span class="term-reasoning-toggle" aria-hidden="true">{collapse.open() ? '−' : '+'}</span>
        </button>
        <SolidCollapsibleRegion open={collapse.open()} id={collapse.bodyId}>
          {/* C01 步骤4：正文复用 C00 markdown 管线，不建第二套渲染 */}
          <div class="term-reasoning-body" ref={element => { bodyElement = element }} onScroll={onBodyScroll}
            onWheel={scrollIntent.onWheel} onKeyDown={scrollIntent.onKeyDown}
            onTouchStart={scrollIntent.onTouchStart} onTouchMove={scrollIntent.onTouchMove}
            onTouchEnd={scrollIntent.onTouchEnd} onTouchCancel={scrollIntent.onTouchEnd} style={bodyStyle()}>
            {/* #208：大正文在折叠态不渲染。折叠容器只是 `display:none`，Solid 仍会建整棵正文 DOM
                并触发 markdown 解析——实机实测折叠的 reasoning 体照样渲染了 1.6 万字符、全会话累计
                449k 字符的正文 DOM，而单个 20 万字符块一次解析就要 20ms+。
                只对**超阈值**正文惰性化：短正文保持既有的「折叠也在 DOM 里」契约（页面查找、
                既有断言、诊断几何都依赖它），长正文改为展开才解析/渲染。复制不受影响（走 props.text）。 */}
            <Show when={collapse.open() || props.text.length <= LAZY_REASONING_BODY_CHARS}>
              <MarkdownContent text={props.text} streaming={props.running} typewriter={false} settleMotion={false} />
            </Show>
          </div>
        </SolidCollapsibleRegion>
      </Show>
    </div>
  )
}
