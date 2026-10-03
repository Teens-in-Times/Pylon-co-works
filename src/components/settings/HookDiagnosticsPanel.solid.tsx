/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'

/**
 * HookDiagnosticsPanel — 插件 hook 运行诊断（设置 › 插件 › Hook 诊断）。
 *
 * #515：Solid 实体（原 HookDiagnosticsPanel.tsx 为 React 薄桥）。
 *
 * 消费唯一产品 HookRuntime 的三个只读投影：
 * - trace 快照（最近 200 条调用：锚点/插件/handler/结局/耗时/错误）；
 * - 熔断快照（per-plugin 失败计数与开启时间）；
 * - 注册表快照（每锚点当前注册者清单）。
 * 「锚点没触发 / 为什么被拦截」类问题的第一诊断入口（#37 类问题回溯面）。
 */


const OUTCOME_LABELS: Record<string, string> = {
  continued: '放行',
  transformed: '改写',
  cancelled: '拦截',
  responded: '应答',
  failed: '失败',
  'timed-out': '超时',
  skipped: '跳过',
  'plugin-disable-failed': '停用失败',
}

/** revision 计数信号：外部快照投影的失效源（对齐 React useSyncExternalStore 订阅）。 */
function createRevisionSignal(subscribe: (listener: () => void) => () => void, read: () => number) {
  const [rev, setRev] = createSignal(read())
  onCleanup(subscribe(() => setRev(n => n + 1)))
  return rev
}

export default function HookDiagnosticsPanel() {
  const runtime = getHookRuntime()
  const traceRev = createRevisionSignal(l => runtime.subscribeTrace(l), () => runtime.traceSnapshot().revision)
  const registryRev = createRevisionSignal(l => runtime.registry.subscribe(l), () => runtime.registry.getSnapshot().revision)

  const traces = createMemo(() => {
    traceRev()
    return runtime.traceSnapshot().entries
  })
  const circuits = createMemo(() => {
    traceRev()
    registryRev()
    return runtime.circuitsSnapshot()
  })
  const registrations = createMemo(() => {
    registryRev()
    return runtime.registry.getSnapshot().entries
  })

  const byAnchor = createMemo(() => {
    const map = new Map<string, string[]>()
    for (const entry of registrations()) {
      const list = map.get(entry.value.hookName) ?? []
      list.push(`${entry.ownerPluginId} · ${entry.value.id}（${entry.value.mode}）`)
      map.set(entry.value.hookName, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })

  return (
    <div class="settings-surface" data-testid="hook-diagnostics">
      <section aria-labelledby="hook-circuits-title" style={{ 'margin-bottom': '16px' }}>
        <h3 id="hook-circuits-title">熔断状态</h3>
        <Show when={circuits().length > 0} fallback={<p class="set-hint">当前没有插件处于熔断状态。</p>}>
          <For each={circuits()}>{circuit => (
            <p class="set-hint" role="status">
              <strong>{circuit.pluginId}</strong>：连续失败 {circuit.failures} 次
              <Show when={circuit.openedAt !== null}>，熔断中</Show>
            </p>
          )}</For>
        </Show>
      </section>

      <section aria-labelledby="hook-registry-title" style={{ 'margin-bottom': '16px' }}>
        <h3 id="hook-registry-title">锚点注册者</h3>
        <Show when={byAnchor().length > 0} fallback={<p class="set-hint">当前没有任何插件注册钩子。</p>}>
          <For each={byAnchor()}>{([anchor, owners]) => (
            <div class="set-hint">
              <strong>{anchor}</strong>
              <ul style={{ margin: '2px 0 8px', 'padding-left': '18px' }}>
                <For each={owners}>{owner => <li>{owner}</li>}</For>
              </ul>
            </div>
          )}</For>
        </Show>
      </section>

      <section aria-labelledby="hook-trace-title">
        <h3 id="hook-trace-title">最近调用（{traces().length} 条）</h3>
        <Show when={traces().length > 0} fallback={<p class="set-hint">暂无钩子调用记录。</p>}>
          <table style={{ width: '100%', 'border-collapse': 'collapse', 'font-size': '12px' }}>
            <thead>
              <tr>
                <th style={{ 'text-align': 'left', padding: '4px' }}>时间</th>
                <th style={{ 'text-align': 'left', padding: '4px' }}>锚点</th>
                <th style={{ 'text-align': 'left', padding: '4px' }}>插件 · handler</th>
                <th style={{ 'text-align': 'left', padding: '4px' }}>结局</th>
                <th style={{ 'text-align': 'right', padding: '4px' }}>耗时</th>
              </tr>
            </thead>
            <tbody>
              <For each={[...traces()].reverse()}>{trace => (
                <tr title={trace.error ?? undefined}>
                  <td style={{ padding: '4px' }}>{new Date(trace.startedAt).toLocaleTimeString()}</td>
                  <td style={{ padding: '4px' }}>{trace.hookName}</td>
                  <td style={{ padding: '4px' }}>{trace.pluginId} · {trace.handlerId}</td>
                  <td style={{ padding: '4px' }}>
                    {OUTCOME_LABELS[trace.outcome] ?? trace.outcome}
                    <Show when={trace.error}>（{trace.error}）</Show>
                  </td>
                  <td style={{ padding: '4px', 'text-align': 'right' }}>{trace.durationMs} ms</td>
                </tr>
              )}</For>
            </tbody>
          </table>
        </Show>
      </section>
    </div>
  )
}
