/**
 * errorCenter — 运行错误聚合存储（模块级单例 + 订阅缝）。
 *
 * reportRuntimeError 产生的错误统一收口为可回溯列表（带时间戳、可单个关闭/全部清除），
 * 替代"只显示最新一条"的单 banner。容量上限 50，超出丢弃最旧。
 *
 * #515：React hook 面（useErrors/useDiagnosticErrors/useErrorHistory）已随消费方
 * Solid 化删除——ErrorCenter.solid 与 RuntimeSheetView.solid 经 {@link subscribeErrorCenter}
 * 非 React 缝消费；本文件不再依赖 React。
 */

import type {
  RuntimeErrorDetail,
  RuntimeErrorScope,
  RuntimeErrorVisibility,
} from './runtimeError'

export type ErrorEntryState = 'active' | 'resolved' | 'dismissed'

export type RuntimeErrorMatcher = {
  key?: string
  action?: string
  code?: string
  source?: string
  visibility?: RuntimeErrorVisibility
  scope?: RuntimeErrorScope | string
} | ((entry: ErrorEntry) => boolean)

export interface ErrorEntry extends RuntimeErrorDetail {
  id: number
  /** Stable operation identity; display text is not used for resolution. */
  key: string
  at: number
  state: ErrorEntryState
  resolvedAt?: number
  dismissedAt?: number
  /** 报告 8.3：同作用域/来源指纹的次数、首次与最后时间——去重聚合 */
  count: number
  firstAt: number
  lastAt: number
}

const MAX_ERRORS = 50
let nextId = 1
let errors: ErrorEntry[] = []
let activeGlobalSnapshot: readonly ErrorEntry[] = Object.freeze([])
let activeDiagnosticSnapshot: readonly ErrorEntry[] = Object.freeze([])
let errorHistorySnapshot: readonly ErrorEntry[] = Object.freeze([])
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function scopeKey(scope: RuntimeErrorScope | undefined): string {
  return scope ? `${scope.kind}:${scope.id}` : ''
}

function sameErrorScope(left: ErrorEntry, right: RuntimeErrorDetail): boolean {
  return scopeKey(left.scope) === scopeKey(right.scope) && (left.source ?? '') === (right.source ?? '')
}

export function errorEntryKey(detail: RuntimeErrorDetail): string {
  return detail.key ?? `${scopeKey(detail.scope)}:${detail.source ?? ''}:${detail.action}:${detail.code ?? ''}:${detail.message}`
}

function rebuildSnapshots(): void {
  activeGlobalSnapshot = Object.freeze(errors.filter(entry => entry.state === 'active' && (entry.visibility ?? 'global') === 'global'))
  activeDiagnosticSnapshot = Object.freeze(errors.filter(entry => entry.state === 'active' && entry.visibility === 'diagnostic'))
  errorHistorySnapshot = Object.freeze([...errors])
}

function matches(entry: ErrorEntry, matcher: RuntimeErrorMatcher): boolean {
  if (typeof matcher === 'function') return matcher(entry)
  if (matcher.key !== undefined && entry.key !== matcher.key) return false
  if (matcher.action !== undefined && entry.action !== matcher.action) return false
  if (matcher.code !== undefined && entry.code !== matcher.code) return false
  if (matcher.source !== undefined && entry.source !== matcher.source) return false
  if (matcher.visibility !== undefined && (entry.visibility ?? 'global') !== matcher.visibility) return false
  if (matcher.scope !== undefined) {
    const expected = typeof matcher.scope === 'string' ? matcher.scope : scopeKey(matcher.scope)
    if (scopeKey(entry.scope) !== expected) return false
  }
  return true
}

function withoutRecoveryAction(entry: ErrorEntry): Omit<ErrorEntry, 'recoveryAction'> {
  const { recoveryAction: _recoveryAction, ...fact } = entry
  void _recoveryAction
  return fact
}

export function addError(detail: RuntimeErrorDetail): void {
  const now = Date.now()
  const key = errorEntryKey(detail)
  const incomingVisibility = detail.visibility ?? 'global'
  // A diagnostic may be promoted to a visible failure, but a quiet replay
  // diagnostic must never downgrade an already-visible failure that shares an
  // operation key. Scope/source are part of the identity even when a caller
  // supplies a shorthand key, preventing one session/provider from merging
  // another session's notice.
  const existing = errors.find(entry => entry.state === 'active'
    && entry.key === key
    && sameErrorScope(entry, detail)
    && ((entry.visibility ?? 'global') === incomingVisibility
      || (entry.visibility === 'diagnostic' && incomingVisibility === 'global')))
  if (existing) {
    errors = errors.map(entry => entry === existing
      ? {
        ...entry,
        ...detail,
        key,
        count: entry.count + 1,
        lastAt: now,
        at: now,
        state: 'active' as const,
        resolvedAt: undefined,
        dismissedAt: undefined,
      }
      : entry)
    rebuildSnapshots()
    emit()
    return
  }
  errors = [{
    ...detail,
    id: nextId++,
    at: now,
    count: 1,
    firstAt: now,
    lastAt: now,
    key,
    state: 'active' as const,
    visibility: detail.visibility ?? 'global',
    severity: detail.severity ?? 'error',
  }, ...errors].slice(0, MAX_ERRORS)
  rebuildSnapshots()
  emit()
}

export function clearErrors(): void {
  // "全部清除" is a presentation action. Keep the indexed facts so a
  // Runtime/diagnostics surface can still explain what happened after the
  // tray is hidden; a later event with the same key must create a fresh
  // active entry instead of silently reviving the dismissed one.
  const now = Date.now()
  errors = errors.map(entry => entry.state === 'active' && (entry.visibility ?? 'global') === 'global'
    ? { ...withoutRecoveryAction(entry), state: 'dismissed' as const, dismissedAt: now }
    : entry)
  rebuildSnapshots()
  emit()
}

export function dismissError(id: number): void {
  const now = Date.now()
  errors = errors.map(entry => entry.id === id && entry.state === 'active'
    ? { ...withoutRecoveryAction(entry), state: 'dismissed', dismissedAt: now }
    : entry)
  rebuildSnapshots()
  emit()
}

/** Mark matching notifications resolved without deleting their audit history. */
export function resolveRuntimeErrors(matcher: RuntimeErrorMatcher): void {
  const now = Date.now()
  errors = errors.map(entry => matches(entry, matcher) && entry.state === 'active'
    ? { ...withoutRecoveryAction(entry), state: 'resolved', resolvedAt: now }
    : entry)
  rebuildSnapshots()
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** #515：非组件世界的订阅缝（RuntimeSheetView.solid 经 createRegistrySignal 消费）。 */
export function subscribeErrorCenter(listener: () => void): () => void {
  return subscribe(listener)
}

export function getErrors(): readonly ErrorEntry[] {
  return activeGlobalSnapshot
}

export function getDiagnosticErrors(): readonly ErrorEntry[] {
  return activeDiagnosticSnapshot
}

export function getErrorHistory(): readonly ErrorEntry[] {
  return errorHistorySnapshot
}
