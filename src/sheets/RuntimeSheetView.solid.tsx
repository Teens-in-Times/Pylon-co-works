/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { appClients } from '../app/appClients.ts'
import { runtimeEventClient } from '../infrastructure/tauri/runtimeEventClient.ts'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../app/runtimeError'
import { getDiagnosticErrors, getErrorHistory, subscribeErrorCenter, type ErrorEntry } from '../app/errorCenter.ts'
import { normalizeRuntimeLogEntry, normalizeRuntimeLogList, normalizeStartupDiagnostics, type StartupDiagnostics } from '../infrastructure/tauri/runtimeLogContracts.ts'
import { collectRuntimeLogFacets, deriveCrashMarkers, filterRuntimeLogs, mergeRuntimeLogs, RUNTIME_LOG_RENDER_WINDOW, type CrashMarker, type RuntimeLogEntry, type RuntimeLogFilter } from '../domains/runtime/runtimeLogs.ts'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'

export interface RuntimeSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/**
 * RuntimeSheetView — 运行日志观察面（W1-08，§6 定稿）。
 *
 * list 回放 + pylon:runtime-log 增量（按 id 去重、固定上限）；左栏 source/level/search
 * 纯过滤；主区日志流 + clear；详情主区展开（无右栏）。unmount 清理 listener。
 * #515：实体自 React 版逐行为同构迁移——agentStatuses 经 createZustandSignal，
 * 错误事实经 createRegistrySignal 订阅 errorCenter 快照缝，卸载清理经 onCleanup。
 */
export default function RuntimeSheetView(props: RuntimeSheetViewProps) {
  const [entries, setEntries] = createSignal<RuntimeLogEntry[]>([])
  const [filter, setFilter] = createSignal<RuntimeLogFilter>({})
  const [expandedId, setExpandedId] = createSignal<number | null>(null)
  const [diagnostics, setDiagnostics] = createSignal<StartupDiagnostics | null>(null)
  const [markers, setMarkers] = createSignal<CrashMarker[]>([])
  const agentStatuses = createZustandSignal(useRuntimeStore, state => state.agentStatuses)
  const errorCenter = { subscribe: subscribeErrorCenter }
  const diagnosticErrors = createRegistrySignal(errorCenter, getDiagnosticErrors)
  const errorHistory = createRegistrySignal(errorCenter, getErrorHistory)
  const runtimeErrorKey = (operation: string) => `runtime-sheet:${props.sheet.id}:${operation}`
  // W1-09：crashed/error → 本地诊断 marker（按 agentId:status:generation 去重）
  createEffect(() => {
    const statuses = agentStatuses()
    setMarkers(previous => deriveCrashMarkers(previous, statuses))
  })

  createEffect(() => {
    // 浏览器模式 mock 后端已装（demo）：invoke/listen 经假 __TAURI_INTERNALS__ 返回 mock 数据
    const sheetId = props.sheet.id
    let disposed = false
    appClients.runtime.startupDiagnostics().then(raw => {
      if (!disposed) {
        setDiagnostics(normalizeStartupDiagnostics(raw))
        resolveRuntimeErrors({ key: runtimeErrorKey('读取启动诊断') })
      }
    }).catch(error => {
      if (!disposed) reportRuntimeError('读取启动诊断', error, undefined, {
        key: runtimeErrorKey('读取启动诊断'),
        scope: { kind: 'sheet', id: sheetId },
        source: 'runtime.sheet',
      })
    })
    appClients.runtime.listRuntimeLogs().then(raw => {
      if (!disposed) {
        setEntries(previous => mergeRuntimeLogs(previous, normalizeRuntimeLogList(raw)))
        resolveRuntimeErrors({ key: runtimeErrorKey('读取运行日志') })
      }
    }).catch(error => {
      if (!disposed) reportRuntimeError('读取运行日志', error, undefined, {
        key: runtimeErrorKey('读取运行日志'),
        scope: { kind: 'sheet', id: sheetId },
        source: 'runtime.sheet',
      })
    })
    // B2：挂载时开 live 推送、卸载时关（ringbuffer pull 兜底不受影响）。
    // #520 S1-P1：事件订阅改经 infrastructure 传输层 runtimeEventClient（行为零变化）。
    const runtimeClient = appClients.runtime
    void runtimeClient.setRuntimeLogLive(true).catch(() => {})
    const liveLog = runtimeEventClient.subscribe<unknown>('pylon:runtime-log', payload => {
      if (disposed) return
      const entry = normalizeRuntimeLogEntry(payload)
      if (entry) setEntries(previous => mergeRuntimeLogs(previous, [entry]))
    })
    onCleanup(() => {
      disposed = true
      void runtimeClient.setRuntimeLogLive(false).catch(() => {})
      liveLog.dispose()
    })
  })

  const facets = createMemo(() => collectRuntimeLogFacets(entries()))
  const filtered = createMemo(() => filterRuntimeLogs(entries(), filter()))
  const recentErrorHistory = createMemo(() => errorHistory().slice(0, 20))
  // #409：渲染窗口。过滤后的列表上限仍是 1000，错误风暴时每条增量都会全量
  // reconcile 整个 <ul>；DOM 只物化最近 RENDER_WINDOW 条，更早的按需展开。
  const [renderLimit, setRenderLimit] = createSignal(RUNTIME_LOG_RENDER_WINDOW)
  const renderedEntries = createMemo(
    () => filtered().length > renderLimit() ? filtered().slice(0, renderLimit()) : filtered(),
  )

  const clear = async () => {
    try {
      await appClients.runtime.clearRuntimeLogs()
      setEntries([])
      resolveRuntimeErrors({ key: runtimeErrorKey('清空运行日志') })
    } catch (error) {
      reportRuntimeError('清空运行日志', error, undefined, {
        key: runtimeErrorKey('清空运行日志'),
        scope: { kind: 'sheet', id: props.sheet.id },
        source: 'runtime.sheet',
      })
    }
  }

  return (
    <div class="runtime-sheet flex flex-1 min-w-0 text-text font-[family-name:var(--font)]">
      {/* #154：左列几何（宽度/竖直分割线/折叠可见性）归布局层的 .sidebar；本类只管内容样式。 */}
      <aside class="sidebar runtime-sidebar bg-[color-mix(in_srgb,var(--bg-panel)_70%,transparent)]">
        <div class="runtime-sidebar-head pt-[var(--ui-space-4)] px-[var(--ui-space-3)] pb-[var(--ui-space-3)] border-b border-border">
          <div class="runtime-sidebar-kicker text-accent font-bold text-[10px] leading-none font-[family-name:var(--mono)] tracking-[0.14em] opacity-80">OBSERVE</div>
          <div class="runtime-sidebar-title mt-[var(--ui-space-2)] text-[15px] font-[650]">日志筛选</div>
          <div class="runtime-sidebar-summary mt-[var(--ui-space-1)] text-text-dim text-[11px] leading-[1.4] font-[family-name:var(--mono)]">{filtered().length} / {entries().length} 条</div>
        </div>
        <div class="runtime-filter flex flex-col gap-[var(--ui-space-2)] p-[var(--ui-space-3)]">
          <label class="runtime-filter-label mt-[var(--ui-space-1)] text-[11px] font-semibold text-text-dim">级别</label>
          <select class="runtime-filter-select w-full h-[var(--ui-control-standard)] font-[family-name:var(--font)] text-[13px] text-text bg-bg-input border border-border rounded-none px-[var(--ui-space-3)] outline-none transition-[border-color,box-shadow,background] duration-150 ease-[ease] hover:border-border-focus focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]" value={filter().level || ''} onChange={event => setFilter(f => ({ ...f, level: event.currentTarget.value || undefined }))}>
            <option value="">全部</option>
            <For each={facets().levels}>{level => <option value={level}>{level}</option>}</For>
          </select>
          <label class="runtime-filter-label mt-[var(--ui-space-1)] text-[11px] font-semibold text-text-dim">来源</label>
          <select class="runtime-filter-select w-full h-[var(--ui-control-standard)] font-[family-name:var(--font)] text-[13px] text-text bg-bg-input border border-border rounded-none px-[var(--ui-space-3)] outline-none transition-[border-color,box-shadow,background] duration-150 ease-[ease] hover:border-border-focus focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]" value={filter().source || ''} onChange={event => setFilter(f => ({ ...f, source: event.currentTarget.value || undefined }))}>
            <option value="">全部</option>
            <For each={facets().sources}>{source => <option value={source}>{source}</option>}</For>
          </select>
          <label class="runtime-filter-label mt-[var(--ui-space-1)] text-[11px] font-semibold text-text-dim">搜索</label>
          <input class="runtime-filter-input w-full h-[var(--ui-control-standard)] font-[family-name:var(--font)] text-[13px] text-text bg-bg-input border border-border rounded-none px-[var(--ui-space-3)] outline-none transition-[border-color,box-shadow,background] duration-150 ease-[ease] hover:border-border-focus focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]" type="search" placeholder="搜索日志…"
            value={filter().search || ''} onInput={event => setFilter(f => ({ ...f, search: event.currentTarget.value || undefined }))} />
          <button type="button" class="runtime-clear h-[var(--ui-control-standard)] mt-[var(--ui-space-2)] px-[var(--ui-space-3)] text-[13px] font-[family-name:var(--font)] text-text bg-bg-panel border border-border rounded-none cursor-pointer transition-[background,border-color] duration-150 ease-[ease] hover:bg-bg-hover hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={clear}>清空日志</button>
        </div>
      </aside>
      <main class="runtime-main flex flex-1 min-w-0 flex-col overflow-hidden">
        <Show when={diagnostics()}>
          {diagnostic => (
            <div class="runtime-diagnostics p-[var(--ui-space-3)] border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_78%,transparent)]">
              <div class="runtime-diagnostics-title text-[12px] font-[650] text-text mb-[var(--ui-space-2)]">启动诊断</div>
              <div class="runtime-diagnostics-row flex gap-[var(--ui-space-2)] items-center flex-wrap">
                <DiagnosticChip label="agent" entry={diagnostic().agentConfig} />
                <DiagnosticChip label="gateway" entry={diagnostic().gatewayConfig} />
                <DiagnosticChip label="prism" entry={diagnostic().prism} />
                <Show when={diagnostic().configSource}><span class="runtime-diagnostics-source text-[11px] text-text-dim">config: {diagnostic().configSource!.fileName || diagnostic().configSource!.kind}</span></Show>
              </div>
            </div>
          )}
        </Show>
        <Show when={markers().length > 0}>
          <div class="runtime-markers p-[var(--ui-space-3)] border-b border-border bg-[color-mix(in_srgb,var(--danger)_5%,var(--bg-input))]">
            <div class="runtime-markers-title text-[12px] font-[650] text-text mb-[var(--ui-space-2)]">本地诊断标记（非后端日志）</div>
            <For each={markers()}>{marker => (
              <div class="runtime-marker flex gap-[var(--ui-space-2)] font-[family-name:var(--mono)] text-[11px] py-[var(--ui-space-1)]">
                <span class="runtime-marker-status text-[var(--danger,#e5484d)]">{marker.status}</span>
                <span class="runtime-marker-agent text-accent">{marker.agentId}</span>
                <Show when={marker.detail}><span class="runtime-marker-detail text-text-dim">{marker.detail}</span></Show>
              </div>
            )}</For>
          </div>
        </Show>
        <Show when={diagnosticErrors().length > 0 || recentErrorHistory().length > 0}>
          <RuntimeErrorFacts diagnostics={diagnosticErrors()} history={recentErrorHistory()} />
        </Show>
        <div class="runtime-count min-h-[var(--ui-control-standard)] flex items-center justify-between px-[var(--ui-space-3)] text-[11px] leading-none font-[family-name:var(--mono)] text-text-dim border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_46%,transparent)]">
          <span>实时日志</span>
          <span>{filtered().length} 条</span>
        </div>
        <ul class="runtime-log-list list-none m-0 p-0 overflow-y-auto flex-1 bg-[color-mix(in_srgb,var(--global-bg-color)_16%,transparent)]">
          <For each={renderedEntries()}>{entry => (
            <li class="border-b border-b-[color-mix(in_srgb,var(--border)_64%,transparent)]">
              <button
                type="button"
                class={`runtime-log-row runtime-log-${entry.level} flex gap-[var(--ui-space-2)] items-baseline min-h-[30px] w-full text-left px-[var(--ui-space-3)] py-[5px] text-[12px] leading-[1.55] font-[family-name:var(--mono)] text-text bg-transparent border-none cursor-pointer outline-none transition-[background] duration-100 ease-[ease] hover:bg-bg-hover aria-expanded:bg-bg-active aria-expanded:shadow-[inset_3px_0_0_var(--accent)] focus-visible:shadow-[inset_3px_0_0_var(--accent)] focus-visible:bg-bg-hover max-[760px]:flex-wrap ${entry.level === 'error' ? 'text-[var(--danger,#e5484d)]' : entry.level === 'warn' ? 'text-[var(--state-warning,#fbbf24)]' : entry.level === 'debug' || entry.level === 'trace' ? 'text-text-dim' : ''}`}
                onClick={() => setExpandedId(expandedId() === entry.id ? null : entry.id)}
              >
                <span class="runtime-log-id text-text-dim w-[3em] basis-[3em] shrink grow-0">{entry.id}</span>
                <span class="runtime-log-level w-[4em] basis-[4em] shrink grow-0 font-bold uppercase">{entry.level}</span>
                {/* #116 子项 3：缺 whitespace-nowrap 时 agent-stderr 会在连字符处断成
                    两行（单元格 19→37px、整行 30→37px），与含下划线不可断行的
                    prism_desktop_lib 同一列两种表现。同文件 runtime-log-chip 已有该 utiliy。 */}
                <span class="runtime-log-source w-[6em] basis-[6em] shrink grow-0 overflow-hidden text-ellipsis whitespace-nowrap">{entry.source || '—'}</span>
                <span class="runtime-log-time text-text-dim w-[8em] basis-[8em] shrink grow-0">{formatTime(entry.timestamp)}</span>
                <Show when={entry.category}><span class="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.category}</span></Show>
                <span class="runtime-log-message flex-1 min-w-0 [word-break:break-word] max-[760px]:basis-full max-[760px]:[overflow-wrap:anywhere]">{entry.message}</span>
              </button>
              <Show when={expandedId() === entry.id && hasLogDetail(entry)}>
                <div class="runtime-log-detail mt-[var(--ui-space-1)] mx-[var(--ui-space-3)] mb-[var(--ui-space-2)] py-[var(--ui-space-2)] px-[var(--ui-space-3)] text-[11px] bg-bg-input border border-border rounded-none text-text-dim max-[760px]:[overflow-wrap:anywhere]">
                  <Show when={entry.category || entry.code || entry.recoverable !== undefined || entry.userActionRequired !== undefined || entry.rawAvailable !== undefined}>
                    <div class="runtime-log-tags flex flex-wrap gap-[var(--ui-space-1)] mb-[var(--ui-space-2)]">
                      <Show when={entry.category}><span class="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.category}</span></Show>
                      <Show when={entry.code}><span class="runtime-log-chip runtime-log-code flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-[var(--danger,#e5484d)] border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.code}</span></Show>
                      <Show when={entry.rawAvailable !== undefined}><span class="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.rawAvailable ? '原文可用' : '占位文本'}</span></Show>
                      <Show when={entry.recoverable !== undefined}><span class="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.recoverable ? '可重试' : '不可重试'}</span></Show>
                      <Show when={entry.userActionRequired !== undefined}><span class="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.userActionRequired ? '需用户操作' : '无需用户操作'}</span></Show>
                    </div>
                  </Show>
                  <Show when={entry.correlation}>
                    {correlation => (
                      <div class="runtime-log-section [&+&]:mt-[var(--ui-space-2)]">
                        <div class="runtime-log-section-title mb-[var(--ui-space-1)] text-[11px] font-[650] text-text">身份（OBS-02）</div>
                        <div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>agentId</code> = {correlation().agentId}</div>
                        <div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>source</code> = {correlation().source}</div>
                        <div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>generation</code> = {correlation().clientGeneration}</div>
                        <Show when={correlation().provider}><div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>provider</code> = {correlation().provider}</div></Show>
                        <Show when={correlation().localSessionId}><div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>localSessionId</code> = {correlation().localSessionId}</div></Show>
                        <Show when={correlation().remoteSessionId}><div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>remoteSessionId</code> = {correlation().remoteSessionId}</div></Show>
                        <Show when={correlation().periId}><div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>periId</code> = {correlation().periId}</div></Show>
                        <Show when={correlation().requestId}><div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>requestId</code> = {correlation().requestId}</div></Show>
                        <Show when={correlation().toolCallId}><div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>toolCallId</code> = {correlation().toolCallId}</div></Show>
                      </div>
                    )}
                  </Show>
                  <Show when={entry.fields && Object.keys(entry.fields).length > 0}>
                    <div class="runtime-log-section [&+&]:mt-[var(--ui-space-2)]">
                      <div class="runtime-log-section-title mb-[var(--ui-space-1)] text-[11px] font-[650] text-text">字段</div>
                      <For each={Object.entries(entry.fields ?? {})}>{([key, value]) => (
                        <div class="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>{key}</code> = {value}</div>
                      )}</For>
                    </div>
                  </Show>
                </div>
              </Show>
            </li>
          )}</For>
        </ul>
        <Show when={filtered().length > renderedEntries().length}>
          <button
            type="button"
            class="flex-none mx-[var(--ui-space-3)] mb-[var(--ui-space-2)] py-[var(--ui-space-1)] px-[var(--ui-space-3)] text-[11px] text-text-dim bg-transparent border border-border rounded-none cursor-pointer hover:border-border-focus hover:text-text"
            onClick={() => setRenderLimit(limit => limit + RUNTIME_LOG_RENDER_WINDOW)}
          >
            显示更早日志（还有 {filtered().length - renderedEntries().length} 条）
          </button>
        </Show>
      </main>
    </div>
  )
}

function RuntimeErrorFacts(props: { diagnostics: readonly ErrorEntry[]; history: readonly ErrorEntry[] }) {
  return (
    <section class="runtime-error-facts flex-none max-h-[min(32vh,360px)] overflow-auto p-[var(--ui-space-3)] border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_78%,transparent)]" aria-label="应用错误事实">
      <div class="runtime-error-facts-head flex items-baseline justify-between gap-[var(--ui-space-2)] mb-[var(--ui-space-2)]">
        <strong>应用错误事实</strong>
        <span class="text-text-dim text-[11px]">{props.diagnostics.length > 0 ? `${props.diagnostics.length} 条待诊断` : '无待诊断'} · 保留最近 {props.history.length} 条</span>
      </div>
      <ul class="runtime-error-facts-list grid gap-[var(--ui-space-1)] list-none m-0 p-0">
        <For each={props.history}>{entry => (
          <li class={`runtime-error-fact p-[var(--ui-space-2)] border border-border bg-[color-mix(in_srgb,var(--bg-input)_60%,transparent)] ${entry.state === 'active' ? 'border-s-[3px] border-s-[var(--danger,#e5484d)]' : entry.state === 'resolved' ? 'border-s-[3px] border-s-[var(--tool-ok,#1e9646)]' : entry.state === 'dismissed' ? 'border-s-[3px] border-s-[var(--text-dim)]' : ''}`}>
            <div class="runtime-error-fact-summary grid grid-cols-[auto_minmax(0,1fr)_auto] gap-[var(--ui-space-2)] items-baseline text-[12px]">
              <strong>{entry.action}</strong>
              <span class="min-w-0 [overflow-wrap:anywhere] text-text-dim">{entry.message}</span>
              <small class="text-text-dim whitespace-nowrap">{entry.state === 'active' ? '待处理' : entry.state === 'resolved' ? '已恢复' : '已隐藏'}</small>
            </div>
            <details class="mt-[var(--ui-space-1)] text-[11px]">
              <summary class="cursor-pointer text-text-dim">详细信息</summary>
              <div class="runtime-error-fact-detail grid gap-[var(--ui-space-1)] mt-[var(--ui-space-1)] text-text-dim [overflow-wrap:anywhere]">
                <Show when={entry.code}><div><code>code</code> = {entry.code}</div></Show>
                <Show when={entry.source}><div><code>source</code> = {entry.source}</div></Show>
                <Show when={entry.scope} keyed>{scope => <div><code>scope</code> = {scope.kind}:{scope.id}</div>}</Show>
                <Show when={entry.technicalMessage}><pre class="max-h-[120px] overflow-auto m-0 p-[var(--ui-space-1)] whitespace-pre-wrap bg-bg-input font-[family-name:var(--mono)] text-[11px] leading-[1.4]">{entry.technicalMessage}</pre></Show>
                <Show when={entry.metadata}><pre class="max-h-[120px] overflow-auto m-0 p-[var(--ui-space-1)] whitespace-pre-wrap bg-bg-input font-[family-name:var(--mono)] text-[11px] leading-[1.4]">{safeErrorJson(entry.metadata)}</pre></Show>
              </div>
            </details>
          </li>
        )}</For>
      </ul>
    </section>
  )
}

function safeErrorJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2)
    if (typeof serialized !== 'string') return '[详情不可用]'
    return serialized.length <= 8_192 ? serialized : `${serialized.slice(0, 8_192)}\n…（详情已截断）`
  } catch { return '[详情不可用]' }
}

function formatTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

/** LOG-03：详情区是否可展开——增量字段 / correlation / fields 任一存在即展开。 */
function hasLogDetail(entry: RuntimeLogEntry): boolean {
  return Boolean(
    entry.code ||
    entry.category ||
    entry.recoverable !== undefined ||
    entry.userActionRequired !== undefined ||
    entry.rawAvailable !== undefined ||
    entry.correlation ||
    (entry.fields && Object.keys(entry.fields).length > 0),
  )
}

function DiagnosticChip(props: { label: string; entry: { status: string; message?: string } | null }) {
  return (
    <Show when={props.entry}>
      {entry => {
        const ok = entry().status === 'ready'
        return (
          <span class={`runtime-diag-chip font-[family-name:var(--mono)] text-[11px] px-[9px] py-[4px] rounded-none border bg-[color-mix(in_srgb,var(--bg-input)_80%,transparent)] ${ok ? 'text-[var(--tool-ok,#1e9646)] border-[color-mix(in_srgb,var(--tool-ok,#1e9646)_30%,var(--border))]' : 'text-[var(--danger,#e5484d)] border-[color-mix(in_srgb,var(--danger,#e5484d)_30%,var(--border))]'}`} title={entry().message || ''}>
            {props.label}: {entry().status}
          </span>
        )
      }}
    </Show>
  )
}
