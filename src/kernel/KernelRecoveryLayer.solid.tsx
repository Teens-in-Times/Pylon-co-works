/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js'
import type { KernelBootstrapState } from './kernelBootstrap.ts'

interface KernelRecoveryLayerProps {
  onRemount?: () => void
  state?: KernelBootstrapState
  onRetry?: (pluginId: string) => void
  onSafeMode?: () => void
  onStartNormal?: () => void
}

/** Recovery stays available independently of the product shell and its styles. */
export default function KernelRecoveryLayer(props: KernelRecoveryLayerProps) {
  const starting = () => props.state?.kind === 'idle' || props.state?.kind === 'starting'
  const degraded = () => props.state?.kind === 'degraded' ? props.state : undefined
  const safeMode = () => props.state?.kind === 'safe-mode'
  const buttonClass = 'min-h-9 cursor-pointer rounded-sm border border-stroke-default bg-surface-raised px-4 py-2 text-sm text-content-text hover:bg-hover-bg focus-visible:outline-2 focus-visible:outline-focus-ring'
  return (
    <main data-testid="kernel-recovery-layer" class="flex h-full min-h-0 items-center justify-center overflow-auto bg-surface-canvas px-6 py-8 text-content-text max-[600px]:items-start max-[600px]:px-4">
      <section class="my-auto grid w-full max-w-[640px] gap-6 border-l-2 border-accent pl-6 max-[600px]:pl-4" aria-busy={starting()}>
        <header class="grid gap-3">
          <span class="text-xs font-semibold tracking-widest text-content-muted">PYLON</span>
          <h1 class="m-0 text-2xl font-semibold tracking-tight">
            {starting() ? '正在启动 Pylon'
              : degraded() ? '部分扩展未能启动'
                : safeMode() ? '安全模式'
                  : '工作界面已关闭'}
          </h1>
          <p class="m-0 text-sm leading-relaxed text-content-muted" role={starting() ? 'status' : undefined}>
            {starting() ? '正在准备工作区与扩展，请稍候。'
              : degraded() ? '可以重试失败的扩展，或进入安全模式逐项恢复。'
                : safeMode() ? '工作界面与扩展尚未自动加载。可以正常启动，或选择要恢复的扩展。'
                  : '应用仍在运行，可以重新打开工作界面继续使用。'}
          </p>
        </header>
        <Show when={degraded()}>
          <ul class="m-0 grid max-h-[40vh] list-none gap-3 overflow-auto p-0">
            <For each={degraded()?.failures ?? []}>{failure => (
              <li class="grid min-w-0 gap-3 border-y border-stroke-subtle py-4" role="alert">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <strong class="min-w-0 break-all text-sm">{failure.pluginId}</strong>
                  <Show when={failure.retryable && props.onRetry}>
                    <button type="button" class={buttonClass} onClick={() => props.onRetry?.(failure.pluginId)}>重试加载</button>
                  </Show>
                </div>
                <details class="text-xs text-content-muted">
                  <summary class="w-fit cursor-pointer">查看错误详情</summary>
                  <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">{failure.stage} · {failure.message}</pre>
                </details>
              </li>
            )}</For>
          </ul>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Show when={degraded() && props.onSafeMode}>
            <button type="button" class={buttonClass} onClick={() => props.onSafeMode?.()}>进入安全模式</button>
          </Show>
          <Show when={safeMode() && props.onStartNormal}>
            <button type="button" class={`${buttonClass} border-accent text-accent`} onClick={() => props.onStartNormal?.()}>正常启动</button>
          </Show>
          <Show when={!props.state && props.onRemount}>
            <button type="button" class={buttonClass} onClick={() => props.onRemount?.()}>重新挂载 Pylon</button>
          </Show>
        </div>
        <Show when={props.state?.kind === 'safe-mode' && props.onRetry}>
          <details class="border-t border-stroke-subtle pt-4 text-sm text-content-muted">
            <summary class="w-fit cursor-pointer">逐项恢复扩展</summary>
            <div class="mt-3 flex flex-wrap gap-2">
              <For each={props.state?.kind === 'safe-mode' ? props.state.skippedPluginIds : []}>{pluginId => (
                <button type="button" class={buttonClass} onClick={() => props.onRetry?.(pluginId)}>启动 {pluginId}</button>
              )}</For>
            </div>
          </details>
        </Show>
      </section>
    </main>
  )
}
