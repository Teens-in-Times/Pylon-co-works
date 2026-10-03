/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { resolveActivityLine } from '../../../domains/activity/activityLine.ts'
import {
  legacyPhaseFromActivity,
  resolveGenerationIndicatorContext,
  resolveGenerationIndicatorCopy,
} from '../../../domains/activity/generationStateMachine.ts'
import {
  chooseGenerationIndicatorVerb,
  createGenerationIndicatorCopyMachine,
  generationIndicatorCopyDueAt,
  generationIndicatorCopyText,
  type GenerationIndicatorCopyEvent,
} from '../../../domains/activity/generationIndicatorCopyMachine.ts'
import { resolveSpinnerMarker } from '../../../domains/chat/spinnerFrames.ts'
import { glimmerIntensity, resolveActivity, resolveFrame, resolveGlimmer, resolveStallProgress } from '../../../domains/chat/spinnerMachine.ts'
import { Spinner, SpinnerSummary } from '../../../components/ui/Spinner.solid.tsx'
import { nextTokenCatchUp } from '../../../domains/chat/tokenCatchUp.ts'
import { segmentGraphemes } from '../../../utils/textWidth.ts'
import {
  browserWorkbenchClock,
  type GenerationFooterInput,
  type GenerationFooterLifecycle,
  type GenerationLiveness,
  type WorkbenchClock,
} from '../../../domains/workbench/generationFooterContracts.ts'

const GLIMMER_CYCLE_MS = 4600
const HOT_TICK_MS = 120
const SLOW_TICK_MS = 1000

export interface SolidGenerationFooterProps extends GenerationFooterInput {
  /** Token usage remains intentionally hidden until the product surface is redesigned. */
  showTokenCount?: boolean
  clock?: WorkbenchClock
  random?: () => number
  onLifecycleReady?: (lifecycle: GenerationFooterLifecycle) => void
}

export function SolidGenerationFooter(props: SolidGenerationFooterProps) {
  const clock = () => props.clock ?? browserWorkbenchClock
  const [now, setNow] = createSignal(clock().now())
  const [displayedTokens, setDisplayedTokens] = createSignal(0)
  const [paused, setPaused] = createSignal(false)
  // (#260-C9) memo 化：line/copy 两个每 tick 重算的 memo 都经 fallbackVerb 调到这里，
  // 此前每次调用都 map+filter 重新分配；verbs 来自冻结的 appearance 快照（整体替换）。
  const configuredVerbs = createMemo(() => {
    const verbs = props.appearance.verbs.map(value => value.trim()).filter(Boolean)
    return verbs.length > 0 ? verbs : ['思考中']
  })
  const verbSignature = createMemo(() => `${props.appearance.verbSet}\u0000${configuredVerbs().join('\u0001')}`)
  /**
   * #390：回合身份取自宿主（`generationKey` + `turnEpoch`），不再本地铸号。
   * `turnEpoch` 由会话层在每个真实回合推进恰好一次（发送入口的乐观投影与 live user
   * 起手），因此同一回合内该值稳定、跨回合必变。
   */
  const turnToken = () => `${props.generationKey ?? ''}\u0000${props.turnId ?? 0}`
  const generationIdOf = (token: string) => `turn:${token}`
  const copyMachine = createGenerationIndicatorCopyMachine()
  let initialGenerationId = ''
  let initialPresetVerb = ''
  if (props.running) {
    initialGenerationId = generationIdOf(turnToken())
    initialPresetVerb = chooseGenerationIndicatorVerb(configuredVerbs(), props.random ?? Math.random)
    copyMachine.dispatch({
      type: 'start',
      generationId: initialGenerationId,
      text: initialPresetVerb,
      at: clock().now(),
    })
  }
  const [selectedPresetVerb, setSelectedPresetVerb] = createSignal(initialPresetVerb)
  const [currentGenerationId, setCurrentGenerationId] = createSignal(initialGenerationId)
  const [displayedVerb, setDisplayedVerb] = createSignal(generationIndicatorCopyText(copyMachine.getState()))
  let hotTimer: unknown | null = null
  let slowTimer: unknown | null = null
  let verbTimer: unknown | null = null
  let destroyed = false
  let observedStartTime = props.startTime
  let observedGenerationRunning = props.running
  let observedGenerationKey = props.generationKey ?? ''
  let observedTurnToken = turnToken()
  let observedVerbSignature = verbSignature()
  let observedCopyPrimary: string | undefined
  let observedCopyLiveness: GenerationLiveness | undefined
  let observedContextSignature = ''
  const [effectiveStartTime, setEffectiveStartTime] = createSignal(
    normalizeGenerationStart(props.startTime, clock().now()),
  )

  const clearHotTimer = () => {
    if (hotTimer !== null) clock().clearInterval(hotTimer)
    hotTimer = null
  }
  const clearSlowTimer = () => {
    if (slowTimer !== null) clock().clearInterval(slowTimer)
    slowTimer = null
  }
  const clearVerbTimer = () => {
    if (verbTimer !== null) clock().clearTimeout(verbTimer)
    verbTimer = null
  }
  const scheduleCopyTimer = () => {
    clearVerbTimer()
    const state = copyMachine.getState()
    const dueAt = generationIndicatorCopyDueAt(state)
    if (dueAt === undefined || destroyed || paused() || !props.running) return
    const generationId = state.status === 'pending' ? state.generationId : ''
    verbTimer = clock().setTimeout(() => {
      verbTimer = null
      if (destroyed || paused() || !generationId) return
      dispatchCopy({ type: 'tick', generationId, at: clock().now() })
    }, Math.max(0, dueAt - clock().now()))
  }
  const dispatchCopy = (event: GenerationIndicatorCopyEvent) => {
    const previous = copyMachine.getState()
    const next = copyMachine.dispatch(event)
    if (next === previous) return
    setDisplayedVerb(generationIndicatorCopyText(next))
    scheduleCopyTimer()
  }
  const syncTimers = () => {
    clearHotTimer()
    clearSlowTimer()
    if (destroyed || paused() || !props.running) return
    hotTimer = clock().setInterval(() => {
      setNow(clock().now())
      setDisplayedTokens(previous => nextTokenCatchUp(previous, props.tokenCount))
    // `intervalMs` controls frame phase speed, not the UI clock. Keep the
    // repaint cadence bounded so a 1s frame preset cannot make elapsed time
    // and the spark marker look frozen.
    }, Math.max(40, Math.min(HOT_TICK_MS, props.appearance.intervalMs || HOT_TICK_MS)))
    slowTimer = clock().setInterval(() => setNow(clock().now()), SLOW_TICK_MS)
  }

  const lifecycle: GenerationFooterLifecycle = {
    pause() {
      if (destroyed || paused()) return
      setPaused(true)
      clearHotTimer()
      clearSlowTimer()
      clearVerbTimer()
    },
    resume() {
      if (destroyed || !paused()) return
      setPaused(false)
      setNow(clock().now())
      syncTimers()
      scheduleCopyTimer()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      clearHotTimer()
      clearSlowTimer()
      clearVerbTimer()
    },
  }

  onMount(() => {
    setNow(clock().now())
    syncTimers()
    scheduleCopyTimer()
    props.onLifecycleReady?.(lifecycle)
  })
  onCleanup(() => lifecycle.destroy())

  createEffect(() => {
    const timerInputs = [props.running, props.appearance.intervalMs, paused()] as const
    if (timerInputs.length > 0) syncTimers()
  })

  createEffect(() => {
    const nextStartTime = props.startTime
    if (nextStartTime === observedStartTime) return
    observedStartTime = nextStartTime
    // `startTime` is projected by a different host reader than the live
    // generation flag. During a turn that projection can briefly publish its
    // zero/current-time sentinel. The running edge below owns lifecycle
    // boundaries; never let a mid-turn hint reset the clock (the reset would
    // surface as an elapsed value stuck at 0–1s). While idle, keep the latest
    // hint ready for the next run.
    if (!props.running) setEffectiveStartTime(normalizeGenerationStart(nextStartTime, clock().now()))
  })

  createEffect(() => {
    const real = Math.max(0, props.tokenCount)
    if (!props.running) setDisplayedTokens(real)
    else if (displayedTokens() > real) setDisplayedTokens(real)
  })

  const fallbackVerb = () => selectedPresetVerb() || configuredVerbs()[0]!
  const idleMs = () => props.running
    ? Math.max(0, now() - (props.lastTokenAt ?? props.startTime))
    : 0
  const line = createMemo(() => resolveActivityLine({
    activeTaskContent: props.activeTaskContent,
    toolTitle: (props.activity?.activeTools.at(-1)?.name ?? (props.phase?.kind === 'tool' ? props.phase.name : undefined)),
    phase: (legacyPhaseFromActivity(props.activity) ?? props.phase)?.kind,
    thinkingStart: props.thinkingStart,
    now: now(),
    fallbackVerb: fallbackVerb(),
  }))
  const indicatorContext = createMemo(() => resolveGenerationIndicatorContext({
    activity: props.activity,
    phase: props.phase,
    activeTaskContent: props.activeTaskContent,
  }))
  const activity = () => indicatorContext().kind === 'tooling' || line().stallSuppressed
    ? 'active'
    : resolveActivity(idleMs())
  const copy = createMemo(() => resolveGenerationIndicatorCopy({
    running: props.running,
    liveness: activity(),
    presetVerb: fallbackVerb(),
    context: indicatorContext(),
  }))
  const secondaryContext = () => copy().secondary

  // 生成生命周期只在 running 由 false→true、宿主回合身份（owner/session + turnEpoch）
  // 变化，或 Footer 尚未建立 generation 时开启。generation id 不暴露给协议，
  // 专门用于阻断旧定时器回写新回合。
  createEffect(() => {
    const running = props.running
    const generationKey = props.generationKey ?? ''
    const token = turnToken()
    const previousRunning = observedGenerationRunning
    const previousGenerationKey = observedGenerationKey
    const generationKeyChanged = generationKey !== previousGenerationKey
    // #390：宿主回合身份变化也算新回合（同一 owner 上换回合）。此前只认 false→true
    // 边沿 + owner 变化，本地的"回合"观感与宿主可能漂移——多算一次边沿就会重开最短
    // 展示计时、重抽预设词（用户看到的「状态混乱」）。
    const turnTokenChanged = token !== observedTurnToken
    // A generation is a lifecycle edge, not every projection write.  The
    // document and live-controller readers may publish different start times
    // for a few microtasks; treating that write as a new generation resets the
    // footer to one second. A stable owner/session key is the one exception:
    // it tells us that two sessions are being viewed while both remain
    // running, so the local footer state must be isolated for the new owner.
    const startsNewGeneration = running && (
      !previousRunning || !currentGenerationId() || generationKeyChanged || turnTokenChanged
    )

    observedGenerationRunning = running
    observedGenerationKey = generationKey
    observedTurnToken = token

    if (startsNewGeneration) {
      const previousId = currentGenerationId()
      if (previousId && (generationKeyChanged || turnTokenChanged)) {
        // A key switch can happen without a false→true edge. Finish the old
        // copy state first so a pending timer cannot leak its text into the
        // newly selected session; `dispatchCopy` also clears that timer.
        dispatchCopy({ type: 'finish', generationId: previousId, at: clock().now() })
      }
      const id = generationIdOf(token)
      const preset = chooseGenerationIndicatorVerb(configuredVerbs(), props.random ?? Math.random)
      setEffectiveStartTime(normalizeGenerationStart(props.startTime, clock().now()))
      // `effectiveStartTime` is intentionally updated only at lifecycle
      // boundaries (it must not react to every projected timestamp write).
      // Publishing it through a signal also forces one repaint when a real
      // key switch happens while the footer remains mounted.
      setNow(clock().now())
      setDisplayedTokens(0)
      setCurrentGenerationId(id)
      setSelectedPresetVerb(preset)
      observedCopyPrimary = undefined
      observedCopyLiveness = undefined
      observedContextSignature = ''
      dispatchCopy({ type: 'start', generationId: id, text: preset, at: clock().now() })
    } else if (!running && previousRunning) {
      const id = currentGenerationId()
      if (id) dispatchCopy({ type: 'finish', generationId: id, at: clock().now() })
      setCurrentGenerationId('')
      setSelectedPresetVerb('')
    }

    // Keep an idle footer ready for the next owner without starting a copy
    // machine generation before the host reports `running`.
    if (!running && generationKeyChanged) {
      setEffectiveStartTime(normalizeGenerationStart(props.startTime, clock().now()))
    }
  })

  // 设置变化只重新选择一次 preset；同一回合内保留仍然有效的当前词，
  // 避免用户调整其它外观项时主文案无意义地跳变。
  createEffect(() => {
    const signature = verbSignature()
    const previousSignature = observedVerbSignature
    observedVerbSignature = signature
    if (signature === previousSignature || !props.running) return
    const id = currentGenerationId()
    if (!id) return
    const candidates = configuredVerbs()
    const current = selectedPresetVerb()
    const next = candidates.includes(current)
      ? current
      : chooseGenerationIndicatorVerb(candidates, props.random ?? Math.random)
    if (next === current) return
    setSelectedPresetVerb(next)
    // waiting/stalled 时主文案由 liveness 提示占用；先只更新候选词，
    // 待恢复 active 的 liveness-change 再按最短展示时间切入新词。
    if (activity() !== 'active') return
    dispatchCopy({ type: 'preset-change', generationId: id, text: next, at: clock().now() })
  })

  // 主文案只监听 liveness；工具/阶段切换通过 context-change 走独立通道，
  // 不会重置最短展示计时。
  createEffect(() => {
    const running = props.running
    const id = currentGenerationId()
    const context = indicatorContext()
    const liveness = activity()
    const primary = copy().primary
    const contextSignature = `${context.kind ?? ''}\u0000${context.label ?? ''}\u0000${[...context.toolNames].sort().join('\u0001')}`

    if (contextSignature !== observedContextSignature) {
      observedContextSignature = contextSignature
      if (running && id) dispatchCopy({ type: 'context-change', generationId: id, at: clock().now() })
    }
    if (!running || !id) return
    if (primary === observedCopyPrimary && liveness === observedCopyLiveness) return
    observedCopyPrimary = primary
    observedCopyLiveness = liveness
    dispatchCopy({ type: 'liveness-change', generationId: id, liveness, text: primary, at: clock().now() })
  })

  const elapsedMs = () => Math.max(0, now() - effectiveStartTime())
  // (#260-C9) frames 来自冻结的 appearance 快照（resolveFrame/resolveSpinnerMarker
  // 只读不突变），防御性展开是每 tick 一次的纯拷贝，删除。
  const frame = () => resolveFrame(
    props.appearance.frames,
    elapsedMs(),
    props.appearance.intervalMs,
    props.reducedMotion ? 'static' : props.appearance.motion,
    props.appearance.direction,
  ).char
  const stallProgress = () => resolveStallProgress(idleMs())
  const shownTokens = () => Math.min(displayedTokens(), Math.max(0, props.tokenCount))
  const summaryMarker = () => props.summary
    ? resolveSpinnerMarker(
      props.appearance.frames,
      props.summary.reason === 'cancelled'
        ? props.appearance.cancelledMarkerMode
        : props.summary.reason === 'error'
          ? props.appearance.errorMarkerMode
          : props.appearance.doneMarkerMode,
      props.summary.reason === 'cancelled'
        ? props.appearance.cancelledMarker
        : props.summary.reason === 'error'
          ? props.appearance.errorMarker
          : props.appearance.doneMarker,
    )
    : ''

  return (
    <Show when={props.running} fallback={<GenerationSummaryView input={props} marker={summaryMarker()} />}>
      {/* #520 K 域：spinner DOM 词汇由 ui/Spinner 统一承载（帧字符/耗时不归组件管，
          仍由本组件的 spinnerMachine 时钟解析）。 */}
      <Spinner
        frame={frame()}
        size={props.appearance.size}
        color={props.appearance.color}
        activity={activity()}
        phase={props.appearance.framePreset === 'cc' ? undefined : (legacyPhaseFromActivity(props.activity) ?? props.phase)?.kind || 'idle'}
        stallProgress={stallProgress()}
        actions={
          <Show when={props.onStop}>
            {onStop => <button class="spinner-stop-btn" type="button" title="停止生成 (Esc / Ctrl+C)" onClick={onStop()}>
              <span aria-hidden="true">■</span> 停止
            </button>}
          </Show>
        }
      >
        <SolidSpinnerGlimmer
          text={displayedVerb()}
          elapsedMs={elapsedMs()}
          active={activity() === 'active'}
          reducedMotion={props.reducedMotion === true}
          color={props.appearance.color}
        />
        <Show when={secondaryContext()}>
          {secondary => <span class="spinner-context" title={secondary()}>{secondary()}</span>}
        </Show>
        <span class="spinner-meta">(
          <span>{formatElapsed(elapsedMs())}</span>
          <Show when={(legacyPhaseFromActivity(props.activity) ?? props.phase)?.kind === 'thinking' && props.thinkingStart != null}>
            <span> · </span><span>思考 {formatElapsed(Math.max(0, now() - (props.thinkingStart ?? now())))}</span>
          </Show>
          <Show when={props.showTokenCount === true && props.tokenCount > 0}>
            <span> · </span><span>↓ {formatTokens(shownTokens())} tokens</span>
          </Show>
        )</span>
        <Show when={activity() !== 'active'}><span class="spinner-activity" aria-live="polite">…</span></Show>
      </Spinner>
    </Show>
  )
}

function SolidSpinnerGlimmer(props: {
  text: string
  elapsedMs: number
  active: boolean
  reducedMotion: boolean
  color?: string
}) {
  // (#260-C9) 每 tick 只重算一次：此前 activeIndex 在 data 属性与每字素的
  // intensity 里各调一次，每次都整段重新切分并重算光扫窗口。
  const graphemes = createMemo(() => segmentGraphemes(props.text))
  const activeIndex = createMemo(() => props.reducedMotion || !props.active || graphemes().length === 0
    ? -1
    : resolveGlimmer(props.text, props.elapsedMs, GLIMMER_CYCLE_MS).glimmerIndex)
  return (
    <span
      class="spinner-verb"
      data-glimmer-active={activeIndex() >= 0 ? 'true' : 'false'}
      style={{ '--spinner-glimmer-color': props.color || undefined }}
    >
      <For each={graphemes()}>{(grapheme, index) => {
        const intensity = () => glimmerIntensity(index(), activeIndex())
        const className = () => intensity() === 2
          ? 'spinner-glimmer spinner-glimmer-core'
          : intensity() === 1
            ? 'spinner-glimmer spinner-glimmer-edge'
            : undefined
        return <span class={className()}>{grapheme}</span>
      }}</For>
    </span>
  )
}

function GenerationSummaryView(props: { input: GenerationFooterInput; marker: string }) {
  return (
    <Show when={props.input.summary}>
      {summary => (
        <SpinnerSummary reason={summary().reason} marker={props.marker} size={props.input.appearance.size}>
          {summary().reason === 'cancelled' ? '已停止' : summary().reason === 'error' ? '处理失败' : '处理耗时'} {formatSummaryElapsed(summary())}
        </SpinnerSummary>
      )}
    </Show>
  )
}

export function formatElapsed(elapsedMs: number): string {
  const elapsed = Math.floor(Math.max(0, elapsedMs) / 1000)
  return elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
}

function formatSummaryElapsed(summary: NonNullable<GenerationFooterInput['summary']>): string {
  return summary.durationAvailable === false ? '耗时不可用' : formatElapsed(summary.elapsedMs)
}

export function formatTokens(value: number): string {
  const n = Math.max(0, value)
  if (n >= 1000) {
    const thousands = n / 1000
    return thousands >= 10 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1)}k`
  }
  return `${Math.floor(n)}`
}

function normalizeGenerationStart(startTime: number, now: number): number {
  if (Number.isFinite(startTime) && startTime >= 0) {
    // Epoch zero is valid for deterministic tests, but never for a real 2020+
    // browser clock. Treat missing/legacy zero as "started now".
    if (startTime > 0 || now < 86_400_000) return Math.min(startTime, now)
  }
  return now
}
