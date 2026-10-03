/** @jsxImportSource solid-js */
import { For, Index, Show, createEffect, createSignal, onCleanup, onMount, type Accessor, type JSX } from 'solid-js'
import {
  parseSlashCommand,
  type CommandSuggestion,
} from '../../../domains/chat/commandRegistry.ts'
import { subscribePluginCommands } from '../../../application/commandSetResolver.ts'
import type { WorkbenchAttachment } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createSessionUiSignal } from '../adapters/sessionUiSignal.solid.tsx'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import { ASSIST_PREDICTION_CONSUMED_KEY } from '../../../domains/workbench/session/assistPrediction.ts'
import { createCommandPaletteModel, resolvePaletteKeyAction } from './createCommandPaletteModel.solid.tsx'
import { createInputPredictionController } from './createInputPredictionController.solid.tsx'
import type { InputPredictionProvider } from '../../../infrastructure/prediction/inputPredictionProvider.ts'

export interface QueuedWorkbenchMessage {
  id: number
  text: string
  editing: boolean
  attachments?: readonly WorkbenchAttachment[]
}

export interface SolidInputBarProps {
  disabled?: boolean
  /** Optional LLM provider; requests are debounced, cancellable and rate limited. */
  predictionProvider?: InputPredictionProvider
  /** Empty-state configuration. The input DOM stays mounted while a session is created. */
  empty?: {
    before?: JSX.Element
    after?: JSX.Element
    onSubmit: (text: string, attachments: readonly WorkbenchAttachment[]) => Promise<boolean>
    submitting?: Accessor<boolean>
    submitLabel?: Accessor<string>
  } | (() => {
    before?: JSX.Element
    after?: JSX.Element
    onSubmit: (text: string, attachments: readonly WorkbenchAttachment[]) => Promise<boolean>
    submitting?: Accessor<boolean>
    submitLabel?: Accessor<string>
  } | undefined)
}

export function SolidInputBar(props: SolidInputBarProps) {
  const workbench = useSolidWorkbench()
  const sessionId = () => workbench.input().sessionId
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const [draft, setDraft] = createSessionUiSignal(workbench.sessionUi, sessionId, 'draft', '')
  const [queue, setQueue] = createSessionUiSignal<QueuedWorkbenchMessage[]>(workbench.sessionUi, sessionId, 'queued-messages', [])
  const [history] = createSessionUiSignal<string[]>(workbench.sessionUi, sessionId, 'input-history', [])
  const [historyIndex, setHistoryIndex] = createSessionUiSignal(workbench.sessionUi, sessionId, 'input-history-index', -1)
  const [attachments, setAttachments] = createSessionUiSignal<readonly WorkbenchAttachment[]>(workbench.sessionUi, sessionId, 'attachments', [])
  const [sendError, setSendError] = createSessionUiSignal(workbench.sessionUi, sessionId, 'input-error', '')
  const [queueSendingSessions, setQueueSendingSessions] = createSignal<ReadonlySet<string>>(new Set())
  // #394：原生预测的消费标记（per-session）——接受/拒绝后 ghost 与卡片同时收敛。
  const [consumedPrediction, setConsumedPrediction] = createSessionUiSignal(workbench.sessionUi, sessionId, ASSIST_PREDICTION_CONSUMED_KEY, '')
  let textarea: HTMLTextAreaElement | undefined
  let inputBar: HTMLDivElement | undefined
  let composing = false
  let historyDraft = ''
  let autoQueueSessionId: string | null | undefined
  let autoQueueArmed = false
  const emptyState = () => typeof props.empty === 'function' ? props.empty() : props.empty
  const isDisabled = () => Boolean(props.disabled || emptyState()?.submitting?.())

  const resizeInput = () => {
    if (!textarea) return
    const slot = textarea.closest<HTMLElement>('.cc-input-slot')
    if (!slot) return
    const styles = getComputedStyle(slot)
    const staticHeight = Number.parseFloat(styles.getPropertyValue('--cc-input-height')) || textarea.clientHeight || 40
    const controlCenter = slot.closest<HTMLElement>('.control-center')
    // ★ #266 刀10：原先命令行有一次提前 `return`（清空高度 ⇒ 冻在 CSS 的 22px）。
    //   那个 `return` 随 `cliOverflowMode` 字段退场 —— 命令行现在也走「随内容增高」这一套：
    //   底边不动、上边延伸、3 倍静态高封顶、超出后内部滚动（不显示滚动条）。
    const maxHeight = staticHeight * 3
    textarea.style.height = 'auto'
    const contentHeight = Math.max(textarea.scrollHeight, staticHeight)
    const nextHeight = Math.min(maxHeight, Math.max(staticHeight, contentHeight))
    slot.style.height = `${nextHeight}px`
    const extraHeight = nextHeight - staticHeight
    if (extraHeight > 0) controlCenter?.style.setProperty('--cc-input-extra-height', `${extraHeight}px`)
    else controlCenter?.style.removeProperty('--cc-input-extra-height')
    textarea.style.height = '100%'
    textarea.style.maxHeight = `${maxHeight}px`
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
    if (inputBar) inputBar.dataset.expanded = String(nextHeight > staticHeight)
  }

  createEffect(() => {
    const inputHeight = appearance().inputHeight
    const inputFontSize = appearance().inputFontSize
    const inputLineHeight = appearance().inputLineHeight
    const currentDraft = draft()
    void inputHeight
    void inputFontSize
    void inputLineHeight
    void currentDraft
    queueMicrotask(resizeInput)
  })
  onMount(() => queueMicrotask(resizeInput))

  // ── 命令面板模型（#520 拆出：过滤/分层/环选/键位判定，见 createCommandPaletteModel.solid.tsx）──
  const [commandRevision, setCommandRevision] = createSignal(0)
  const palette = createCommandPaletteModel({
    draft,
    sessionCommands: () => runtime().document?.session?.commands ?? [],
    commandRevision,
  })
  // 展开后列表可能高于面板：键盘选中的行必须可见（否则是「选中了但看不见」）。
  createEffect(() => {
    const index = palette.activeIndex()
    if (!draft().trimStart().startsWith('/')) return
    const rows = inputBar?.querySelectorAll('.command-palette .cmd-item')
    rows?.[index]?.scrollIntoView({ block: 'nearest' })
  })
  // ── 三源预测控制器（#520 拆出：history/native/llm 仲裁 + scheduler 接线）────────
  const predictionController = createInputPredictionController({
    sessionId,
    runtime,
    sessionSource: () => workbench.input().sessionSource ?? null,
    draft,
    history,
    hasAttachments: () => attachments().length > 0,
    hasActiveSuggestions: () => palette.visibleSuggestions().length > 0,
    consumed: consumedPrediction,
    consume: key => setConsumedPrediction(key),
    provider: props.predictionProvider,
  })
  // ★ #266 刀9：输入形态固定为命令行（`inputVariant` / `inputMode` 两字段已删除）。
  // Placeholder copy is deferred to the send/indicator work; keep the
  // textarea free of a standalone instruction line.
  const placeholder = () => ''

  onMount(() => {
    textarea?.focus()
    const unsubscribeCommands = subscribePluginCommands(() => setCommandRevision(value => value + 1))
    const sendFromWidget = () => void send()
    const resetEmptyDraft = () => {
      if (!emptyState()) return
      setDraft('')
      setAttachments([])
      setSendError('')
      queueMicrotask(() => textarea?.focus())
    }
    window.addEventListener('pylon:solid-input-send', sendFromWidget)
    window.addEventListener('pylon:new-session', resetEmptyDraft)
    onCleanup(() => {
      unsubscribeCommands()
      window.removeEventListener('pylon:solid-input-send', sendFromWidget)
      window.removeEventListener('pylon:new-session', resetEmptyDraft)
    })
  })

  createEffect(() => {
    const error = sendError()
    const id = sessionId()
    if (!error || !id) return
    // A first-prompt failure can arrive after the empty composer has switched
    // to its session namespace. Restore keyboard focus only if the user is
    // still on that same session and the input is usable.
    queueMicrotask(() => {
      if (id === sessionId() && !isDisabled()) textarea?.focus()
    })
  })

  const recordHistory = (text: string, ui: ReturnType<typeof workbench.sessionUi.capture>) => {
    ui.update<string[]>('input-history', [], previous => [...previous.filter(item => item !== text), text].slice(-50))
    ui.set('input-history-index', -1)
  }

  const runSlashCommand = async (text: string): Promise<boolean> => {
    const parsed = parseSlashCommand(text)
    if (!parsed) return false
    const id = sessionId()
    if (!id) return false
    switch (parsed.name) {
      case '/model': {
        if (!parsed.args.trim()) throw new Error('请输入模型名称')
        const result = await workbench.commands.setModel(id, parsed.args.trim())
        if (!result.ok) throw new Error(result.error || '模型切换失败')
        return true
      }
      case '/mode': {
        if (!parsed.args.trim()) throw new Error('请输入权限模式')
        const result = await workbench.commands.setMode(id, parsed.args.trim())
        if (!result.ok) throw new Error(result.error || '权限模式切换失败')
        return true
      }
      case '/new':
        await workbench.commands.createSession()
        return true
      case '/compact': {
        const result = await workbench.commands.compact(id)
        if (!result.ok) throw new Error(result.error || '压缩失败')
        return true
      }
      case '/export': {
        const result = await workbench.commands.exportSession(id, { format: 'markdown' })
        if (!result.ok) throw new Error(result.error || '导出失败')
        return true
      }
      case '/clear': {
        const result = await workbench.commands.clearSession(id)
        if (!result.ok) throw new Error(result.error || '清屏失败')
        return true
      }
      default:
        return false
    }
  }

  const sendText = async (
    text: string,
    messageAttachments: readonly WorkbenchAttachment[] = attachments(),
    clearComposer = true,
  ): Promise<boolean> => {
    if (isDisabled()) return false
    const id = sessionId()
    const normalized = text.trim()
    if (!normalized) return false
    const wasEmptySession = !id
    if (wasEmptySession && emptyState()) {
      const ok = await emptyState()!.onSubmit(normalized, messageAttachments)
      if (ok && clearComposer) {
        // createSession may select the new session before this continuation
        // resumes. Do not route the empty-state cleanup into the new session's
        // namespace; an async first-prompt failure may need to restore this
        // exact draft for retry.
        if (!wasEmptySession || !sessionId()) {
          setDraft('')
          setAttachments([])
        }
      }
      if (!ok) queueMicrotask(() => textarea?.focus())
      return ok
    }
    if (!id) return false
    const ui = workbench.sessionUi.capture(id)
    const shouldRunSlashCommand = normalized.startsWith('/') && palette.visibleSuggestions().length > 0
    let clearedDraft = false
    let clearedAttachments = false
    if (clearComposer) {
      ui.update('draft', '', current => {
        if (current !== text) return current
        clearedDraft = true
        return ''
      })
      ui.update<readonly WorkbenchAttachment[]>('attachments', [], current => {
        if (!sameAttachments(current, messageAttachments)) return current
        clearedAttachments = true
        return []
      })
    }
    try {
      const handled = shouldRunSlashCommand
        ? await runSlashCommand(normalized)
        : false
      if (!handled) {
        const result = await workbench.commands.send(id, {
          text: normalized,
          attachments: messageAttachments,
        })
        if (result.status === 'rejected') throw new Error(result.error || '发送失败')
      }
      recordHistory(normalized, ui)
      ui.set('input-error', '')
      if (sessionId() === id) palette.resetIndex()
      return true
    } catch (error) {
      if (clearComposer && clearedDraft && ui.get('draft', '') === '') {
        ui.set('draft', text)
        if (clearedAttachments && ui.get<readonly WorkbenchAttachment[]>('attachments', []).length === 0) {
          ui.set('attachments', messageAttachments)
        }
      }
      ui.set('input-error', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  const enqueue = (text: string) => {
    const normalized = text.trim()
    if (!normalized) return
    const queuedAttachments = attachments()
    setQueue(previous => [...previous, {
      id: Math.max(0, ...previous.map(item => item.id)) + 1,
      text: normalized,
      editing: false,
      attachments: queuedAttachments,
    }])
    setDraft('')
    setAttachments([])
    setSendError('')
  }

  const sendQueued = async (item: QueuedWorkbenchMessage): Promise<boolean> => {
    const id = sessionId()
    if (!id) return false
    if (queueSendingSessions().has(id)) return false
    setQueueSendingSessions(previous => new Set([...previous, id]))
    const ui = workbench.sessionUi.capture(id)
    try {
      if (await sendText(item.text, item.attachments ?? [], false)) {
        ui.update<QueuedWorkbenchMessage[]>('queued-messages', [], previous => previous.filter(current => current.id !== item.id))
        return true
      }
      return false
    } finally {
      setQueueSendingSessions(previous => new Set([...previous].filter(session => session !== id)))
    }
  }

  createEffect(() => {
    const id = sessionId()
    const generating = runtime().generating
    const first = queue()[0]
    const sending = id ? queueSendingSessions().has(id) : false
    if (id !== autoQueueSessionId) {
      autoQueueSessionId = id
      autoQueueArmed = generating || Boolean(first)
    }
    if (generating) {
      autoQueueArmed = true
      return
    }
    if (!id || !autoQueueArmed || sending || !first || first.editing) return
    autoQueueArmed = false
    void sendQueued(first)
  })

  const send = async () => {
    if (isDisabled()) return
    if (emptyState()) {
      await sendText(draft())
      return
    }
    if (runtime().generating) {
      enqueue(draft())
      return
    }
    await sendText(draft())
  }

  const cancel = async () => {
    if (isDisabled()) return
    const id = sessionId()
    if (!id) return
    const ui = workbench.sessionUi.capture(id)
    const result = await workbench.commands.cancel(id)
    if (result.status === 'rejected') ui.set('input-error', result.error || '取消失败')
  }

  const browseHistory = (direction: 'up' | 'down') => {
    const entries = history()
    if (entries.length === 0) return
    if (historyIndex() < 0) historyDraft = draft()
    const next = direction === 'up'
      ? Math.min(historyIndex() + 1, entries.length - 1)
      : Math.max(historyIndex() - 1, -1)
    setHistoryIndex(next)
    setDraft(next < 0 ? historyDraft : entries[entries.length - 1 - next] ?? '')
  }

  const canBrowseHistory = (direction: 'up' | 'down') => {
    if (history().length === 0 || !textarea || textarea.selectionStart !== textarea.selectionEnd) return false
    return direction === 'up'
      ? !textarea.value.slice(0, textarea.selectionStart).includes('\n')
      : !textarea.value.slice(textarea.selectionEnd).includes('\n')
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && runtime().generating) {
      event.preventDefault()
      void cancel()
      return
    }
    if (event.ctrlKey && (event.key === 'c' || event.key === 'C') && runtime().generating && !window.getSelection()?.toString()) {
      event.preventDefault()
      void cancel()
      return
    }
    // 命令面板键位（#520：判定收敛进 createCommandPaletteModel，纯函数可单测）。
    const paletteAction = resolvePaletteKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      composing,
      index: palette.activeIndex(),
      rows: palette.rows(),
      suggestions: palette.suggestions(),
      draft: draft(),
    })
    if (paletteAction) {
      event.preventDefault()
      if (paletteAction.type === 'toggle-layer') {
        palette.toggleLayer()
      } else if (paletteAction.type === 'apply') {
        // 中文命令的已输入参数由判定层带回（#327），这里只负责落草稿与聚焦。
        applySuggestion(paletteAction.suggestion, paletteAction.args)
      } else if (paletteAction.type === 'move') {
        palette.setIndex(paletteAction.index)
      }
      return
    }
    const currentPrediction = predictionController.prediction()
    const atEnd = !textarea || (textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length)
    if (currentPrediction && (event.key === 'Tab' || (event.key === 'ArrowRight' && atEnd))) {
      event.preventDefault()
      setDraft(currentPrediction.text)
      // #394：接受＝消费该预测实例（卡片与 ghost 同时收敛，不再横在会话流里）。
      if (currentPrediction.instanceKey) setConsumedPrediction(currentPrediction.instanceKey)
      predictionController.clearDismissed()
      setHistoryIndex(-1)
      textarea?.focus()
      return
    }
    // #394：退格即拒绝（代码补全语义）。空草稿上没有可删字符，这一击就是对建议说「不要」。
    if (currentPrediction && event.key === 'Backspace' && !draft()) {
      event.preventDefault()
      if (currentPrediction.instanceKey) setConsumedPrediction(currentPrediction.instanceKey)
      predictionController.dismiss(currentPrediction, draft())
      return
    }
    if (currentPrediction && event.key === 'Escape') {
      event.preventDefault()
      if (currentPrediction.instanceKey) setConsumedPrediction(currentPrediction.instanceKey)
      predictionController.dismiss(currentPrediction, draft())
      return
    }
    // 空草稿上按 Enter = 采纳并直接发出（ghost 与 llm 同形，键位语义保持一致）。
    if (currentPrediction && (currentPrediction.source === 'llm' || currentPrediction.source === 'native')
      && !draft() && event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault()
      setDraft(currentPrediction.text)
      if (currentPrediction.instanceKey) setConsumedPrediction(currentPrediction.instanceKey)
      predictionController.clearDismissed()
      void sendText(currentPrediction.text)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const direction = event.key === 'ArrowUp' ? 'up' : 'down'
      if (!canBrowseHistory(direction)) return
      event.preventDefault()
      browseHistory(direction)
      return
    }
    if (event.key === 'Escape' && historyIndex() >= 0) {
      event.preventDefault()
      setHistoryIndex(-1)
      setDraft(historyDraft)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault()
      void send()
    }
  }

  /** `typedArgs` = 用户已输入的参数（如 `/模型 deepseek` 的 `deepseek`）；缺省用提示串。 */
  const applySuggestion = (suggestion: CommandSuggestion, typedArgs?: string) => {
    const args = typedArgs?.trim() || suggestion.args.trim()
    setDraft(`${suggestion.cmd}${args ? ` ${args}` : ''} `)
    palette.resetIndex()
    textarea?.focus()
  }

  /** 点选/键盘补全共用：把草稿里已输入的参数一并带过去。 */
  const pickSuggestion = (suggestion: CommandSuggestion) => {
    applySuggestion(suggestion, parseSlashCommand(draft())?.args)
  }

  return (
    <div
      ref={inputBar}
      class={`input-bar input-variant-cli cli-mode${emptyState() ? ' input-empty' : ''}`}
      data-expanded="false"
    >
      {/* Empty state is intentionally quiet: the control-center itself already
          communicates the affordance, so keyboard-hint chrome would make the
          centered composer look like a second instruction panel. */}
      <Show when={sendError()}>{error => <div class="input-error" role="alert">{error()}</div>}</Show>
      <Show when={workbench.input().bindingHint}>{hint => (
        <div class={`input-binding-status${hint().error ? ' input-binding-status--error' : ''}`} role="status">{hint().text}</div>
      )}</Show>
      <Show when={!emptyState() && palette.rows().length > 0}>
        <div class="command-palette" role="listbox" aria-label="命令建议">
          <For each={palette.rows()}>{(row, index) => (
            row.kind === 'toggle'
              ? <button
                  type="button"
                  role="option"
                  aria-label={palette.showAll() ? '只看常用命令' : `显示全部命令，含内部 ${palette.hiddenInternalCount()} 条`}
                  class={`cmd-item cmd-toggle${index() === palette.activeIndex() ? ' active' : ''}`}
                  onClick={palette.toggleLayer}
                >
                  <span class="cmd-name">{palette.showAll() ? '只看常用命令' : `显示全部命令（含内部 ${palette.hiddenInternalCount()} 条）`}</span>
                </button>
              : <button
                  type="button"
                  role="option"
                  aria-selected={index() === palette.activeIndex()}
                  class={`cmd-item${index() === palette.activeIndex() ? ' active' : ''}`}
                  onClick={() => pickSuggestion(row.suggestion)}
                >
                  <span class="cmd-name">{row.suggestion.cmd}{row.suggestion.args}</span>
                  <span class="cmd-info">{row.suggestion.info}</span>
                </button>
          )}</For>
        </div>
      </Show>
      <Show when={!emptyState() && appearance().inputShowHistoryHint && historyIndex() >= 0 && history().length > 0}>
        <div class="input-history-hint" aria-live="polite">
          历史记录 {historyIndex() + 1}/{history().length} · ↑/↓ 浏览 · Esc 返回草稿
        </div>
      </Show>
      <Show when={!emptyState() && queue().length > 0}>
        <div class="queued-message-list" aria-label="待发送消息">
          <div class="queued-message-title">待发送 · {queue().length}</div>
          <Index each={queue()}>{item => (
            <div class="queued-message" data-queue-id={item().id}>
              <Show when={item().editing} fallback={<span class="queued-message-text">{item().text}</span>}>
                <textarea
                  ref={element => queueMicrotask(() => element.focus())}
                  class="queued-message-editor"
                  value={item().text}
                  onInput={event => setQueue(previous => previous.map(current => current.id === item().id
                    ? { ...current, text: event.currentTarget.value }
                    : current))}
                  onKeyDown={event => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    const editButton = event.currentTarget.closest('.queued-message')
                      ?.querySelector<HTMLButtonElement>('.queued-message-actions button')
                    setQueue(previous => previous.map(current => current.id === item().id
                      ? { ...current, editing: false }
                      : current))
                    queueMicrotask(() => editButton?.focus())
                  }}
                  aria-label="编辑待发送消息"
                />
              </Show>
              <div class="queued-message-actions">
                <button type="button" onClick={() => setQueue(previous => previous.map(current => current.id === item().id ? { ...current, editing: !current.editing } : current))} aria-label={item().editing ? '完成编辑待发送消息' : '编辑待发送消息'}>{item().editing ? '完成' : '编辑'}</button>
                <button type="button" disabled={runtime().generating || item().editing || queueSendingSessions().has(sessionId() ?? '') || !item().text.trim()} onClick={() => void sendQueued(item())} aria-label="发送待发送消息">发送</button>
                <button type="button" onClick={() => setQueue(previous => previous.filter(current => current.id !== item().id))} aria-label="取消待发送消息">取消</button>
              </div>
            </div>
          )}</Index>
          <button type="button" class="queued-message-clear" onClick={() => setQueue([])}>清空队列</button>
        </div>
      </Show>
      <Show when={emptyState()?.before}>{content => <div class="input-empty-before">{content()}</div>}</Show>
      <div class="input-row">
        <span class="cli-prefix">❯</span>
        <div class="input-editor-stack">
          <Show when={predictionController.prediction()}>{candidate => (
            <div class="input-ghost-suggestion" aria-hidden="true" data-prediction-source={candidate().source}>
              <span class="input-ghost-prefix">{draft()}</span><span>{candidate().text.slice(draft().length)}</span>
            </div>
          )}</Show>
          <textarea
            ref={textarea}
            class="input-textarea"
            aria-label="消息输入"
            value={draft()}
            onInput={event => {
              setDraft(event.currentTarget.value)
              predictionController.clearDismissed()
              palette.resetIndex()
              if (historyIndex() >= 0) setHistoryIndex(-1)
              resizeInput()
            }}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composing = true }}
            onCompositionEnd={() => { composing = false }}
            placeholder={placeholder()}
            rows={1}
            disabled={isDisabled()}
          />
        </div>
      </div>
      <Show when={emptyState()?.after}>{content => <div class="input-empty-after">{content()}</div>}</Show>
    </div>
  )
}

function sameAttachments(left: readonly WorkbenchAttachment[], right: readonly WorkbenchAttachment[]): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item.path === right[index]?.path)
}
