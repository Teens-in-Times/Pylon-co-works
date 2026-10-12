/** @jsxImportSource solid-js */
import { For, Show, createEffect, createSignal } from 'solid-js'
import type { RenderAppearanceSnapshot, RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import type { AssistSnapshot, BudgetSnapshot, SessionCommand, SessionConfigOption, UsageSnapshot } from '../../../../domains/workbench/session/sessionSurface.ts'
import { resolveContextUsage } from '../../../../domains/workbench/session/sessionSurface.ts'
import type { JsonValue } from '../../../../domains/workbench/events/workbenchEventSchema.ts'
import { ToolObjectInspector } from '../tool/ToolObjectInspector.solid.tsx'

export function SolidSessionSurfaceCard(props: {
  kind: 'session.usage' | 'session.budget' | 'session.config' | 'session.commands' | 'assist.prediction' | 'assist.file-suggestions'
  payload: unknown
  appearance: RenderAppearanceSnapshot
  commands: RenderCommandPort
}) {
  if (props.kind === 'session.usage') return <UsageCard usage={props.payload as UsageSnapshot} appearance={props.appearance} />
  if (props.kind === 'session.budget') return <BudgetCard budget={props.payload as BudgetSnapshot} appearance={props.appearance} />
  if (props.kind === 'session.config') return <ConfigCard options={recordArray<SessionConfigOption>(props.payload, 'options')} appearance={props.appearance} commands={props.commands} />
  if (props.kind === 'session.commands') return <CommandsCard commands={recordArray<SessionCommand>(props.payload, 'commands')} appearance={props.appearance} />
  return <AssistCard kind={props.kind} assist={props.payload as AssistSnapshot} appearance={props.appearance} commands={props.commands} />
}

function UsageCard(props: { usage: UsageSnapshot; appearance: RenderAppearanceSnapshot }) {
  const usage = () => props.usage ?? {}
  // #110 F4：上下文用量走单一派生源（同一快照的 contextUsed/contextLimit/percent），
  // 不在此处另选 token 字段——否则与状态条百分比读出两组互不相干的数。
  const contextUsage = () => resolveContextUsage(usage())
  const visible = (metric: string) => !Array.isArray(props.appearance.visibleMetrics)
    || props.appearance.visibleMetrics.includes(metric)
  const formatMetric = (value: number | undefined) => props.appearance.units === 'compact'
    ? formatCompact(value)
    : formatNumber(value)
  const showCost = () => props.appearance.showCost !== false
  const showContext = () => props.appearance.showContext !== false
  const showRaw = () => props.appearance.showRaw === true
  return <section class="solid-session-surface solid-session-usage" aria-label="会话用量">
    <strong>用量</strong>
    <div class="solid-session-metrics">
      <Show when={visible('input')}><Metric label="输入" value={usage().inputTokens} format={formatMetric} /></Show>
      <Show when={visible('output')}><Metric label="输出" value={usage().outputTokens} format={formatMetric} /></Show>
      <Show when={visible('reasoning')}><Metric label="推理" value={usage().reasoningTokens} format={formatMetric} /></Show>
      <Show when={visible('cacheRead')}><Metric label="缓存读取" value={usage().cacheReadTokens} format={formatMetric} /></Show>
      <Show when={visible('cacheWrite')}><Metric label="缓存写入" value={usage().cacheWriteTokens} format={formatMetric} /></Show>
      <Show when={visible('context') && showContext() && (contextUsage().used !== undefined || contextUsage().limit !== undefined)}>
        <span>上下文 {formatMetric(contextUsage().used)} / {formatMetric(contextUsage().limit)}</span>
      </Show>
      <Show when={visible('cost') && showCost() && usage().costUsd !== undefined}>
        <span>{formatNumber(usage().costUsd)} {usage().currency ?? ''}</span>
      </Show>
    </div>
    <Show when={showRaw() && usage().raw}>
      <details><summary>未知字段</summary><ToolObjectInspector value={usage().raw} /></details>
    </Show>
  </section>
}

function BudgetCard(props: { budget: BudgetSnapshot; appearance: RenderAppearanceSnapshot }) {
  const budget = () => props.budget ?? {}
  const exhausted = () => budget().exhausted === true
  const percent = () => budget().percent
  const warningThreshold = () => typeof props.appearance.warningThreshold === 'number'
    ? Math.max(0, Math.min(100, props.appearance.warningThreshold))
    : 80
  const warning = () => exhausted() || (percent() !== undefined && percent()! >= warningThreshold())
  return <section class="solid-session-surface solid-session-budget" role="status" aria-label="会话预算"
    data-warning={warning() ? 'true' : 'false'} data-exhausted={exhausted() ? 'true' : 'false'}
    data-palette={typeof props.appearance.warningPalette === 'string' ? props.appearance.warningPalette : 'semantic'}>
    <strong>预算</strong>
    <span>已用 {formatOptional(budget().used)} / {formatOptional(budget().limit)}</span>
    <span>剩余 {formatOptional(budget().remaining)}</span>
    <Show when={percent() !== undefined}><span>占用 {formatNumber(percent())}%</span></Show>
    <Show when={budget().type}><span>{budget().type}</span></Show>
    <Show when={budget().resetAt}><span>重置 {budget().resetAt}</span></Show>
    <Show when={exhausted()}><strong role="alert">已耗尽</strong></Show>
  </section>
}

function ConfigCard(props: { options: readonly SessionConfigOption[]; appearance: RenderAppearanceSnapshot; commands?: RenderCommandPort }) {
  const showRaw = () => props.appearance.showUnknown !== false
  return <section class="solid-session-surface solid-session-config" aria-label="会话配置" data-layout={props.appearance.layout === 'inline' ? 'inline' : 'list'}>
    <strong>配置</strong>
    <For each={props.options}>{option => <ConfigOptionEditor option={option} commands={props.commands} showRaw={showRaw()} />}</For>
  </section>
}

function ConfigOptionEditor(props: { option: SessionConfigOption; commands?: RenderCommandPort; showRaw: boolean }) {
  const [draft, setDraft] = createSignal(formatValue(props.option.value))
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal('')
  const choices = () => configChoices(props.option)
  const protocolWritable = () => isProtocolWritableConfig(props.option)
  const canUpdate = () => props.option.editable === true && protocolWritable()
    && props.commands?.canExecute?.('session.config.update') === true
  createEffect(() => {
    const value = props.option.value
    if (!saving()) setDraft(formatValue(value))
  })
  const save = async () => {
    if (!canUpdate() || saving()) return
    setSaving(true); setError('')
    try {
      await props.commands!.execute({
        type: 'session.config.update', targetId: props.option.id,
        payload: {
          value: parseConfigDraft(draft(), props.option.valueType, props.option.value),
          expectedValue: props.option.value,
          ...(props.option.version !== undefined ? { expectedVersion: props.option.version } : {}),
        },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setSaving(false) }
  }
  return <div class="solid-session-config-option">
    <span>{props.option.label}</span>
    <Show when={choices().length > 0} fallback={
      <input aria-label={`编辑 ${props.option.label}`} value={draft()} disabled={!canUpdate() || saving()}
        onInput={event => setDraft(event.currentTarget.value)} />
    }>
      <select aria-label={`编辑 ${props.option.label}`} value={draft()} disabled={!canUpdate() || saving()}
        onChange={event => setDraft(event.currentTarget.value)}>
        <For each={choices()}>{choice => <option value={choice.value}>{choice.label}</option>}</For>
      </select>
    </Show>
    <button type="button" aria-label={`保存 ${props.option.label}`} disabled={!canUpdate() || saving()} onClick={() => void save()}>
      {saving() ? '保存中…' : '保存'}
    </button>
    <Show when={props.option.valueType}><small>{props.option.valueType}</small></Show>
    <Show when={props.option.editable === true && !protocolWritable()}><small>协议不支持编辑</small></Show>
    <Show when={props.option.editable === false}><small>只读</small></Show>
    <Show when={error()}>{message => <small role="alert">{message()}</small>}</Show>
    <Show when={props.showRaw && props.option.raw}><details><summary>未知字段</summary><ToolObjectInspector value={props.option.raw} commands={props.commands} /></details></Show>
  </div>
}

function isProtocolWritableConfig(option: SessionConfigOption): boolean {
  return option.valueType === 'boolean' ? typeof option.value === 'boolean'
    : option.valueType === 'select' ? typeof option.value === 'string' && configChoices(option).length > 0
      : false
}

function configChoices(option: SessionConfigOption): readonly { value: string; label: string }[] {
  if (option.valueType === 'boolean') return [
    { value: 'true', label: '开启' },
    { value: 'false', label: '关闭' },
  ]
  if (option.valueType !== 'select' || !option.schema || typeof option.schema !== 'object' || Array.isArray(option.schema)) return []
  const options = (option.schema as Record<string, JsonValue>).options
  return flattenConfigChoices(options)
}

function flattenConfigChoices(value: JsonValue | undefined): readonly { value: string; label: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const nested = 'options' in item ? flattenConfigChoices(item.options) : []
    if (nested.length > 0) return nested
    const candidate = typeof item.value === 'string' ? item.value : typeof item.id === 'string' ? item.id : undefined
    if (!candidate) return []
    return [{ value: candidate, label: typeof item.label === 'string' ? item.label : typeof item.name === 'string' ? item.name : candidate }]
  })
}

function CommandsCard(props: { commands: readonly SessionCommand[]; appearance: RenderAppearanceSnapshot }) {
  return <section class="solid-session-surface solid-session-commands" aria-label="会话命令" data-density={props.appearance.density === 'compact' ? 'compact' : 'comfortable'}>
    <strong>命令</strong>
    <For each={props.commands}>{command => <div class="solid-session-command">
      <code>{command.name.startsWith('/') ? command.name : `/${command.name}`}{command.inputHint ?? ''}</code>
      <span>{command.description ?? command.capability ?? '会话命令'}</span>
      <Show when={command.availability === false || command.availability === 'unavailable'}><small>当前不可用</small></Show>
    </div>}</For>
  </section>
}

function AssistCard(props: { kind: 'assist.prediction' | 'assist.file-suggestions'; assist: AssistSnapshot; appearance: RenderAppearanceSnapshot; commands: RenderCommandPort }) {
  const prediction = () => props.assist?.prediction
  const text = () => prediction()?.placeholder ?? ''
  const canAccept = () => props.commands.canExecute?.('assist.accept') === true
  const canReject = () => props.commands.canExecute?.('assist.reject') === true
  const predictionSurface = () => props.kind === 'assist.prediction'
  const label = () => predictionSurface() ? (prediction() ? '输入预测' : '排队命令') : '文件建议'
  const fileLimit = () => typeof props.appearance.fileSuggestionMaxCount === 'number'
    ? Math.max(0, Math.min(20, Math.floor(props.appearance.fileSuggestionMaxCount)))
    : 5
  const visibleFiles = () => (props.assist?.files ?? []).slice(0, fileLimit())
  const acceptKey = () => props.appearance.acceptKey === 'tab' ? 'Tab'
    : props.appearance.acceptKey === 'none' ? undefined : 'Enter'
  const accept = () => {
    if (canAccept()) void props.commands.execute({ type: 'assist.accept', payload: { text: text() } })
  }
  return <section class="solid-session-surface solid-session-assist" role="status" aria-label={label()}
    tabIndex={predictionSurface() && prediction() ? 0 : undefined}
    onKeyDown={event => {
      if (predictionSurface() && prediction() && acceptKey() === event.key && canAccept()) { event.preventDefault(); accept() }
    }}
    style={{ opacity: String(typeof props.appearance.opacity === 'number' ? props.appearance.opacity : 1) }}>
    <strong>{label()}</strong>
    <Show when={predictionSurface() && text()}><p>{text()}</p></Show>
    <Show when={!predictionSurface() && props.appearance.showFiles !== false && visibleFiles().length > 0}>
      <ul aria-label="建议文件列表"><For each={visibleFiles()}>{file => <li><code>{file}</code></li>}</For></ul>
    </Show>
    <Show when={predictionSurface() && props.assist.queuedCommand}><small>排队命令：{props.assist.queuedCommand}</small></Show>
    <Show when={predictionSurface() && prediction()}>
      <div class="solid-session-assist-actions">
        <button type="button" disabled={!canAccept()} aria-label="接受输入建议" title={!canAccept() ? '宿主未提供输入辅助能力' : undefined}
          onClick={accept}>接受</button>
        <button type="button" disabled={!canReject()} aria-label="忽略输入建议" title={!canReject() ? '宿主未提供输入辅助能力' : undefined}
          onClick={() => { if (canReject()) void props.commands.execute({ type: 'assist.reject' }) }}>忽略</button>
      </div>
    </Show>
  </section>
}

function Metric(props: { label: string; value: number | undefined; format?: (value: number | undefined) => string }) {
  return <Show when={props.value !== undefined}><span>{props.label} {props.format?.(props.value) ?? formatNumber(props.value)}</span></Show>
}

function recordArray<T>(value: unknown, key: string): readonly T[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const list = (value as Record<string, unknown>)[key]
  return Array.isArray(list) ? list as readonly T[] : []
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? '未知' : formatNumber(value)
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? '未知' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
}

function formatCompact(value: number | undefined): string {
  return value === undefined ? '未知' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatValue(value: unknown): string {
  if (value === undefined) return '未知'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value) } catch { return '[不可显示]' }
}

function parseConfigDraft(draft: string, valueType: string | undefined, previous: unknown): unknown {
  if (valueType === 'number' || typeof previous === 'number') {
    const parsed = Number(draft)
    return Number.isFinite(parsed) ? parsed : draft
  }
  if (valueType === 'boolean' || typeof previous === 'boolean') return draft === 'true' ? true : draft === 'false' ? false : draft
  if (valueType === 'json' || (previous !== null && typeof previous === 'object')) {
    try { return JSON.parse(draft) } catch { return draft }
  }
  return draft
}
