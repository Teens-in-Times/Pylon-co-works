/** @jsxImportSource solid-js */
import { Show, createEffect, createSignal } from 'solid-js'
import type { LifecycleState, NormalizedError } from '../../../domains/workbench/lifecycle/lifecycleModel.ts'
import { explainErrorCode } from '../../../app/errorCodeExplanations.ts'
import { LucideIcon } from '../../../components/LucideIcon.solid.tsx'
import { ToolObjectInspector } from './tool/ToolObjectInspector.solid.tsx'

export interface SolidLifecycleAppearance {
  foreground: string
  mutedForeground: string
  background: string
  borderColor: string
  infoColor: string
  warningColor: string
  errorColor: string
  successColor: string
  density: 'compact' | 'comfortable'
  technicalDetailsExpanded: boolean
  noticePlacements: readonly ('inline' | 'timeline' | 'toast')[]
  retryCountdownStyle: 'seconds' | 'compact' | 'hidden'
  showProviderIds: boolean
  showEventIds: boolean
  motion: 'none' | 'subtle'
}

export interface SolidLifecycleCardProps {
  state: LifecycleState
  reducedMotion?: boolean
  appearance?: Partial<SolidLifecycleAppearance>
  onRetry?: () => void
  onRecover?: (strategy: 'reload-plugin' | 'reimport') => void
}

export const DEFAULT_LIFECYCLE_APPEARANCE: SolidLifecycleAppearance = Object.freeze({
  foreground: 'var(--text)', mutedForeground: 'var(--text-dim)', background: 'transparent', borderColor: 'var(--border)',
  infoColor: 'var(--accent)', warningColor: 'var(--warning, #d29922)', errorColor: 'var(--danger, #e5484d)',
  successColor: 'var(--tool-ok, var(--accent))', density: 'comfortable', technicalDetailsExpanded: false,
  noticePlacements: ['inline', 'timeline'] as const, retryCountdownStyle: 'seconds', showProviderIds: false, showEventIds: false, motion: 'none',
})

/**
 * C13：生命周期卡（retry/compact/rewind/suspended/recovered）。
 * 数据来自 document.lifecycle 的 semantic snapshot；技术详情默认折叠；
 * 恢复动作经 command port（capability-gated），本组件不自行决定业务动作。
 */
export function SolidLifecycleCard(props: SolidLifecycleCardProps) {
  const appearance = () => ({ ...DEFAULT_LIFECYCLE_APPEARANCE, ...props.appearance })
  const motion = () => props.reducedMotion ? 'none' : appearance().motion
  const severityColor = () => props.state.suspended || props.state.retry
    ? appearance().warningColor
    : props.state.compact?.phase === 'completed' || props.state.rewind?.phase === 'completed' || props.state.lastRecovery
      ? appearance().successColor
      : appearance().infoColor
  const phase = () => props.state.suspended ? 'suspended'
    : props.state.retry ? 'retry'
      : props.state.rewind ? 'rewind'
        : props.state.compact ? 'compact'
          : props.state.lastRecovery ? 'recovered' : undefined
  return (
    <Show when={phase()}>
      {current => (
        <div
          class="lifecycle-card"
          data-phase={current()}
          data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
          data-density={appearance().density}
          data-motion={motion()}
          data-placements={appearance().noticePlacements.join(' ')}
          role="status"
          aria-label={`生命周期：${phaseLabel(props.state)}`}
          style={{
            color: appearance().foreground,
            background: appearance().background,
            'border-color': appearance().borderColor,
            '--lifecycle-severity-color': severityColor(),
            '--lifecycle-muted-foreground': appearance().mutedForeground,
          }}
        >
          <Show when={props.state.retry}>
            {retry => (
              <div class="lifecycle-retry">
                <span class="lifecycle-label">第 {retry().attempt}{retry().maxAttempts !== undefined ? `/${retry().maxAttempts}` : ''} 次重试</span>
                <Show when={retry().delayMs !== undefined}>
                  <Show when={appearance().retryCountdownStyle !== 'hidden'}>
                    <span class="lifecycle-delay">{appearance().retryCountdownStyle === 'compact'
                      ? `${Math.round(retry()!.delayMs! / 1000)}s`
                      : `约 ${Math.round(retry()!.delayMs! / 1000)} 秒后自动继续`}</span>
                  </Show>
                </Show>
                <Show when={retry().error}>
                  {error => <ErrorDetails error={error()} appearance={appearance()} />}
                </Show>
                <RecoveryActions error={retry().error} onRetry={props.onRetry} onRecover={props.onRecover} />
              </div>
            )}
          </Show>
          <Show when={props.state.suspended}>
            {suspended => (
              <div class="lifecycle-suspended">
                <span class="lifecycle-label">已暂停</span>
                <Show when={suspended().reason}><span class="lifecycle-reason">{suspended().reason}</span></Show>
              </div>
            )}
          </Show>
          <Show when={props.state.compact?.phase === 'started'}>
            <div class="lifecycle-compacting"><span class="lifecycle-label">正在压缩上下文{props.state.compact?.strategy ? `（${props.state.compact.strategy}）` : ''}…</span></div>
          </Show>
          <Show when={props.state.compact?.phase === 'completed'}>
            <div class="lifecycle-compact-completed">
              <span class="lifecycle-label">上下文压缩完成</span>
              <Show when={props.state.compact?.tokensBefore !== undefined && props.state.compact?.tokensAfter !== undefined}>
                <span class="lifecycle-reason">{`${props.state.compact!.tokensBefore}→${props.state.compact!.tokensAfter} tokens`}</span>
              </Show>
              <Show when={props.state.compact?.summary}><span class="lifecycle-reason">{props.state.compact!.summary}</span></Show>
            </div>
          </Show>
          <Show when={props.state.rewind?.phase === 'preview'}>
            <div class="lifecycle-rewind-preview">
              <span class="lifecycle-label">回退预览</span>
              <Show when={(props.state.rewind?.files?.length ?? 0) > 0}>
                <span class="lifecycle-files">{`${props.state.rewind!.files!.length} 个文件将被还原`}</span>
              </Show>
              <Show when={props.state.rewind?.summary}><span class="lifecycle-reason">{props.state.rewind!.summary}</span></Show>
            </div>
          </Show>
          <Show when={props.state.rewind?.phase === 'completed'}>
            <div class="lifecycle-rewind-completed">
              <span class="lifecycle-label">回退完成</span>
              <Show when={(props.state.rewind?.files?.length ?? 0) > 0 || (props.state.rewind?.messages?.length ?? 0) > 0}>
                <span class="lifecycle-reason">{`已还原 ${props.state.rewind?.files?.length ?? 0} 个文件、${props.state.rewind?.messages?.length ?? 0} 条消息`}</span>
              </Show>
              <Show when={props.state.rewind?.summary}><span class="lifecycle-reason">{props.state.rewind!.summary}</span></Show>
            </div>
          </Show>
          <Show when={current() === 'recovered' && props.state.history.filter(item => item.kind === 'compact').at(-1)}>
            {compact => (
              <div class="lifecycle-history">
                <span class="lifecycle-reason">{`压缩完成${compact().tokensBefore !== undefined && compact().tokensAfter !== undefined ? `（${compact().tokensBefore}→${compact().tokensAfter} tokens）` : ''}${compact().summary ? ` — ${compact().summary}` : ''}`}</span>
              </div>
            )}
          </Show>
          <Show when={props.state.lastRecovery}>
            {recovery => (
              <div class="lifecycle-recovery">
                <span class="lifecycle-label">{recovery().source === 'agent-import' ? '已从回放导入恢复' : '已从本地记录恢复'}</span>
                <Show when={recovery().importedEvents !== undefined}>
                  <span class="lifecycle-reason">{`导入 ${recovery()!.importedEvents} 条事件（未验证来源）`}</span>
                </Show>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

export function SolidSystemErrorCard(props: {
  error: NormalizedError
  reducedMotion?: boolean
  appearance?: Partial<SolidLifecycleAppearance>
  onRetry?: () => void
  onRecover?: (strategy: 'reload-plugin' | 'reimport') => void
  /** Display-only dismissal; the canonical system error remains in the document. */
  dismissible?: boolean
  onDismiss?: () => void
  onOpenDiagnostics?: () => void
}) {
  const appearance = () => ({ ...DEFAULT_LIFECYCLE_APPEARANCE, ...props.appearance })
  const motion = () => props.reducedMotion ? 'none' : appearance().motion
  const [hidden, setHidden] = createSignal(false)
  let hiddenForKey = ''
  createEffect(() => {
    const errorKey = `${props.error.userSummary}\u0000${props.error.code ?? ''}\u0000${props.error.phase ?? ''}\u0000${props.error.eventId ?? ''}\u0000${props.error.runtimeInstanceId ?? ''}`
    if (errorKey !== hiddenForKey) {
      hiddenForKey = errorKey
      setHidden(false)
    }
  })
  return (
    <Show when={!hidden()}>
      <section
        class="system-error-card"
        role="alert"
        aria-label={`系统错误：${props.error.userSummary}`}
        data-recoverability={props.error.recoverability}
        data-phase={props.error.phase}
        data-density={appearance().density}
        data-motion={motion()}
        data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
        style={{
          color: appearance().foreground,
          background: appearance().background,
          'border-color': appearance().borderColor,
          '--lifecycle-severity-color': appearance().errorColor,
          '--lifecycle-muted-foreground': appearance().mutedForeground,
        }}
      >
        <header class="system-feedback-header">
          <strong>{props.error.userSummary}</strong>
          <Show when={props.dismissible}>
            <DismissErrorButton onClick={() => {
              if (props.onDismiss) props.onDismiss()
              else setHidden(true)
            }} />
          </Show>
        </header>
        <ErrorDetails error={props.error} appearance={appearance()} />
        <RecoveryActions error={props.error} onRetry={props.onRetry} onRecover={props.onRecover} />
        <Show when={props.onOpenDiagnostics}>
          <div class="system-error-card-actions">
            <button type="button" onClick={() => props.onOpenDiagnostics?.()}>在错误中心查看</button>
          </div>
        </Show>
      </section>
    </Show>
  )
}

export function SolidSystemNoticeCard(props: {
  notice: { readonly code: string; readonly message: string; readonly eventId: string; readonly sequence: number; readonly level: 'info' | 'warning' | 'error'; readonly data?: unknown }
  reducedMotion?: boolean
  appearance?: Partial<SolidLifecycleAppearance>
  onDismiss?: () => void
}) {
  const appearance = () => ({ ...DEFAULT_LIFECYCLE_APPEARANCE, ...props.appearance })
  const severityColor = () => props.notice.level === 'error'
    ? appearance().errorColor
    : props.notice.level === 'warning' ? appearance().warningColor : appearance().infoColor
  const motion = () => props.reducedMotion ? 'none' : appearance().motion
  const details = () => noticeDetails(props.notice.data)
  return (
    <section
      class="system-notice-card"
      role={props.notice.level === 'error' ? 'alert' : 'status'}
      aria-label={`系统通知：${props.notice.message}`}
      data-severity={props.notice.level}
      data-density={appearance().density}
      data-motion={motion()}
      data-placements={appearance().noticePlacements.join(' ')}
      data-reduced-motion={props.reducedMotion ? 'true' : 'false'}
      style={{
        color: appearance().foreground,
        background: appearance().background,
        'border-color': appearance().borderColor,
        '--lifecycle-severity-color': severityColor(),
        '--lifecycle-muted-foreground': appearance().mutedForeground,
      }}
    >
      <header class="system-feedback-header">
        <strong>{props.notice.message}</strong>
        <Show when={props.onDismiss}>
          <DismissErrorButton onClick={() => props.onDismiss?.()} />
        </Show>
      </header>
      <code>{props.notice.code}</code>
      <Show when={appearance().showEventIds}><small class="lifecycle-identifiers">{props.notice.eventId}</small></Show>
      <Show when={details()}>
        <details class="system-notice-data" open={appearance().technicalDetailsExpanded}>
          <summary>事件详情</summary>
          <ToolObjectInspector value={details()} />
        </details>
      </Show>
    </section>
  )
}

function DismissErrorButton(props: { onClick: () => void }) {
  return <button type="button" class="system-feedback-dismiss" aria-label="隐藏错误" title="隐藏错误" onClick={props.onClick}>
    <LucideIcon name="X" size={15} />
  </button>
}

function noticeDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value === undefined ? undefined : { value }
  const redundant = new Set(['type', 'level', 'message', 'code'])
  const details = Object.fromEntries(Object.entries(value).filter(([key]) => !redundant.has(key)))
  return Object.keys(details).length > 0 ? details : undefined
}

function ErrorDetails(props: { error: NormalizedError; appearance: SolidLifecycleAppearance }) {
  const identifiers = () => [
    ...(props.appearance.showProviderIds
      ? [props.error.provider, props.error.pluginId, props.error.rendererSuiteId, props.error.rendererSlotId, props.error.runtimeInstanceId]
      : []),
    props.appearance.showEventIds ? props.error.eventId : undefined,
  ].filter(Boolean).join(' · ')
  // #325：技术详情里的裸码旁边给人话解释；未知码保留原文（不编解释）。
  const explanation = () => explainErrorCode(props.error.code)
  return (
    <details class="lifecycle-technical" open={props.appearance.technicalDetailsExpanded}>
      <summary>{props.error.userSummary}</summary>
      <pre>{props.error.technicalMessage ?? props.error.userSummary}{props.error.code ? `\ncode: ${props.error.code}` : ''}</pre>
      <Show when={explanation()}>{value => <small class="lifecycle-code-meaning">{value().summary}{value().hint ? ` · ${value().hint}` : ''}</small>}</Show>
      <Show when={identifiers()}>{value => <small class="lifecycle-identifiers">{value()}</small>}</Show>
      <Show when={props.error.cause}>
        {cause => <div class="lifecycle-cause"><span>原因</span><ErrorDetails error={cause()} appearance={props.appearance} /></div>}
      </Show>
      <Show when={props.error.metadata !== undefined}>
        <div class="lifecycle-metadata"><ToolObjectInspector value={props.error.metadata} /></div>
      </Show>
    </details>
  )
}

function RecoveryActions(props: {
  error: NormalizedError | undefined
  onRetry?: () => void
  onRecover?: (strategy: 'reload-plugin' | 'reimport') => void
}) {
  const recoverability = () => props.error?.recoverability
  return (
    <Show when={recoverability() !== undefined && recoverability() !== 'none'}>
      <div class="lifecycle-actions">
        <Show when={recoverability() === 'retry' && props.onRetry}>
          <button type="button" onClick={() => props.onRetry?.()}>重试</button>
        </Show>
        <Show when={recoverability() === 'reload-plugin' && props.onRecover}>
          <button type="button" onClick={() => props.onRecover?.('reload-plugin')}>重新加载插件</button>
        </Show>
        <Show when={recoverability() === 'reimport' && props.onRecover}>
          <button type="button" onClick={() => props.onRecover?.('reimport')}>重新导入</button>
        </Show>
      </div>
    </Show>
  )
}

function phaseLabel(state: LifecycleState): string {
  if (state.suspended) return `已暂停${state.suspended.reason ? `：${state.suspended.reason}` : ''}`
  if (state.retry) return `第 ${state.retry.attempt}${state.retry.maxAttempts !== undefined ? `/${state.retry.maxAttempts}` : ''} 次重试`
  if (state.rewind) return state.rewind.phase === 'completed' ? '回退完成' : '回退预览'
  if (state.compact) return state.compact.phase === 'completed' ? '上下文压缩完成' : '正在压缩上下文'
  return '已恢复'
}
