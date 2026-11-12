/** @jsxImportSource solid-js */
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { clearErrors, dismissError, subscribeErrorCenter, getErrors, type ErrorEntry } from '../app/errorCenter'
import { reportRuntimeError, resolveRuntimeErrors } from '../app/runtimeError.ts'
import { explainErrorCode } from '../app/errorCodeExplanations.ts'
import { safeJson } from '../utils/safeJson.ts'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'

function recoveryLabel(kind: NonNullable<ErrorEntry['recovery']>['kind']): string {
  return {
    'open-agent-settings': '打开 Agent 设置',
    'select-agent-executable': '选择可执行文件',
    'open-runtime-log': '查看运行日志',
  }[kind]
}

function openRecovery(recovery: NonNullable<ErrorEntry['recovery']>): void {
  const { kind, agentId } = recovery
  if (kind === 'open-runtime-log') {
    window.dispatchEvent(new CustomEvent('pylon:open-runtime-sheet'))
    return
  }
  window.dispatchEvent(new CustomEvent('pylon:open-settings', {
    detail: { domain: 'agents-connections', section: 'agent', agentId },
  }))
}

function scopeLabel(entry: ErrorEntry): string | undefined {
  if (!entry.scope) return undefined
  const labels: Record<NonNullable<ErrorEntry['scope']>['kind'], string> = {
    app: '应用', agent: 'Agent', session: '会话', sheet: 'Sheet', operation: '操作',
  }
  return `${labels[entry.scope.kind]} · ${entry.scope.id}`
}

function formatTime(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function actionLabel(entry: ErrorEntry): string {
  const action = entry.action.trim()
  if (entry.severity === 'warning') return /(?:提醒|警告)$/.test(action) ? action : `${action}提醒`
  if (entry.severity === 'info') return action
  // Callers sometimes include a terminal failure word already. Avoid
  // displaying awkward "失败失败" while keeping the legacy default suffix.
  return /(?:失败|错误|异常|拒绝|不可用|超时)$/.test(action) ? action : `${action}失败`
}

function highestSeverity(errors: readonly ErrorEntry[]): NonNullable<ErrorEntry['severity']> {
  if (errors.some(entry => entry.severity === 'error' || !entry.severity)) return 'error'
  if (errors.some(entry => entry.severity === 'warning')) return 'warning'
  return 'info'
}

const recoveryErrorKey = (entry: ErrorEntry): string => `error-center:recovery:${entry.key}`

async function runRecoveryAction(entry: ErrorEntry): Promise<void> {
  const action = entry.recoveryAction
  if (!action) return
  try {
    await action.run()
    resolveRuntimeErrors({ key: recoveryErrorKey(entry), source: 'error-center.recovery' })
  } catch (error) {
    // A recovery button is an asynchronous operation too. Keep a failed
    // recovery visible in the same tray instead of creating an unhandled
    // rejection or silently making the original notice look fixed.
    reportRuntimeError('执行恢复动作', error, undefined, {
      key: recoveryErrorKey(entry),
      scope: entry.scope ?? { kind: 'operation', id: entry.key },
      source: 'error-center.recovery',
      metadata: { originKey: entry.key, recoveryLabel: action.label },
      recovery: entry.recovery,
    })
  }
}

function ErrorTechnicalDetails(props: { entry: ErrorEntry }) {
  const entry = () => props.entry
  const scope = () => scopeLabel(entry())
  // #325：错误码旁边给人话解释——裸码（config_revision_conflict / provider.error…）用户
  // 无从下手。未知码保留原文，不编解释。
  const explanation = () => explainErrorCode(entry().code)
  return (
    <details class="error-center-details">
      <summary>详细信息</summary>
      <dl class="error-center-detail-list">
        <Show when={entry().code}><div><dt>错误码</dt><dd><code>{entry().code}</code><Show when={explanation()}><span class="error-center-code-meaning">{explanation()!.summary}</span></Show></dd></div></Show>
        <Show when={explanation()?.hint}><div><dt>可以这样处理</dt><dd>{explanation()!.hint}</dd></div></Show>
        <Show when={entry().source}><div><dt>来源</dt><dd>{entry().source}</dd></div></Show>
        <Show when={scope()}><div><dt>作用域</dt><dd>{scope()}</dd></div></Show>
        <Show when={entry().recovery}><div><dt>恢复动作</dt><dd><code>{entry().recovery!.kind}</code></dd></div></Show>
        <div><dt>首次发生</dt><dd>{formatTime(entry().firstAt)}</dd></div>
        <Show when={entry().count > 1}><div><dt>最近发生</dt><dd>{formatTime(entry().lastAt)} · {entry().count} 次</dd></div></Show>
      </dl>
      <Show when={entry().technicalMessage}><pre class="error-center-technical">{entry().technicalMessage}</pre></Show>
      <Show when={entry().metadata}><pre class="error-center-technical">{safeJson(entry().metadata, { fallback: '[详情不可用]', maxChars: 8_192, truncationSuffix: '\n…（详情已截断）' })}</pre></Show>
    </details>
  )
}

/**
 * 全局运行错误中心：普通 runtime/application 错误的唯一展示宿主。
 * 它是非模态 tray，不遮挡工作区；错误事实仍由 canonical/runtime/log 保留。
 *
 * #515：Solid 实体（错误列表经 subscribeErrorCenter 缝的注册表信号消费）。
 */
export default function ErrorCenter() {
  const errors = createRegistrySignal({ subscribe: subscribeErrorCenter }, getErrors)
  const [open, setOpen] = createSignal(false)
  const [dockBottom, setDockBottom] = createSignal(130)
  const [pendingRecovery, setPendingRecovery] = createSignal<ReadonlySet<string>>(new Set())
  let badge: HTMLButtonElement | undefined
  const closePanel = () => { setOpen(false); badge?.focus() }
  const recover = async (entry: ErrorEntry) => {
    if (pendingRecovery().has(entry.key)) return
    setPendingRecovery(current => new Set([...current, entry.key]))
    try { await runRecoveryAction(entry) }
    finally { setPendingRecovery(current => { const next = new Set(current); next.delete(entry.key); return next }) }
  }
  createEffect(() => {
    if (!open()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })
  // Clearing notices closes the tray; the diagnostic history remains unchanged.
  createEffect(() => {
    if (errors().length === 0) setOpen(false)
  })
  // 有通知期间测量底部 dock（中控）并把 tray
  // 垫在其上方；尺寸/位置变化经 resize + ResizeObserver 跟随。计数归零即不测量。
  createEffect(() => {
    if (errors().length === 0 || typeof window === 'undefined') return
    const measureDock = () => {
      const dock = document.querySelector<HTMLElement>('.control-center, .solid-workbench-control-center-slot')
      if (!dock) {
        setDockBottom(130)
        return
      }
      const rect = dock.getBoundingClientRect()
      if (!Number.isFinite(rect.top) || rect.height <= 0) {
        setDockBottom(130)
        return
      }
      // Reserve the complete space below the dock's top edge plus a gap. This
      // follows user-adjusted control-center heights and remains safe when a
      // custom layout grows beyond the compact default. Empty-state composers
      // are intentionally centered; they are not a bottom dock, so reserving
      // their entire lower half would push the tray over the chat center.
      const isBottomDock = rect.top >= window.innerHeight * 0.55
      // Keep all arithmetic in JS instead of relying on CSS max()/env()
      // evaluation, which is inconsistent in a few embedded WebViews. The
      // tray remains above a real bottom dock and falls back to a compact,
      // deterministic offset when the composer is centered or absent.
      setDockBottom(isBottomDock ? Math.max(88, Math.ceil(window.innerHeight - rect.top + 10)) : 130)
    }
    measureDock()
    window.addEventListener('resize', measureDock)
    const dock = document.querySelector<HTMLElement>('.control-center, .solid-workbench-control-center-slot')
    const observer = typeof ResizeObserver !== 'undefined' && dock ? new ResizeObserver(measureDock) : undefined
    observer?.observe(dock!)
    onCleanup(() => {
      window.removeEventListener('resize', measureDock)
      observer?.disconnect()
    })
  })

  const severity = () => highestSeverity(errors())
  return (
    <Show when={errors().length > 0}>
      <button ref={element => { badge = element }} type="button" class={`error-center-badge severity-${severity()}`} onClick={() => setOpen(value => !value)}
        title={`${errors().length} 个待处理运行错误`} aria-label="查看运行错误" aria-live="polite" aria-controls="pylon-error-center" aria-expanded={open()}>⚠ {errors().length}</button>
      <Show when={open()}>
        <section
          class={`error-center severity-${severity()}`}
          id="pylon-error-center"
          role="region"
          aria-label="运行错误通知"
          style={{ '--error-center-bottom': `${dockBottom()}px` } as JSX.CSSProperties}
        >
          <div class="error-center-head">
            <strong>运行错误（{errors().length}）</strong>
            <span class="error-center-head-hint">可在这里处理问题，隐藏通知不会删除运行记录</span>
            <button type="button" class="error-center-action" title="隐藏当前通知，历史事实仍保留" onClick={clearErrors}>全部清除</button>
            <button type="button" class="error-center-action" aria-label="关闭错误面板" onClick={closePanel}>✕</button>
          </div>
          <ul class="error-center-list" aria-live="polite">
            <For each={errors()}>{entry => (
              <li class={`error-center-item severity-${entry.severity ?? 'error'}`} data-error-key={entry.key} data-error-scope={entry.scope ? `${entry.scope.kind}:${entry.scope.id}` : undefined}>
                <div class="error-center-item-main">
                  <strong>{actionLabel(entry)}</strong>
                  <span class="error-center-msg">{entry.message}</span>
                  <Show when={entry.count > 1}><small class="error-center-count">×{entry.count}</small></Show>
                  <ErrorTechnicalDetails entry={entry} />
                </div>
                <div class="flex w-full flex-wrap items-center gap-2">
                  <Show when={entry.recovery}>
                    <button
                      type="button"
                      class="error-center-action"
                      onClick={() => openRecovery(entry.recovery!)}
                    >{recoveryLabel(entry.recovery!.kind)}</button>
                  </Show>
                  <Show when={entry.recoveryAction}>
                    <button
                      type="button"
                      class="error-center-action"
                      disabled={pendingRecovery().has(entry.key)}
                      aria-busy={pendingRecovery().has(entry.key)}
                      onClick={() => { void recover(entry) }}
                    >{pendingRecovery().has(entry.key) ? '正在处理…' : entry.recoveryAction!.label}</button>
                  </Show>
                  <button type="button" class="error-center-action error-center-dismiss" aria-label="关闭该错误" onClick={() => dismissError(entry.id)}>隐藏</button>
                </div>
              </li>
            )}</For>
          </ul>
        </section>
      </Show>
    </Show>
  )
}
