/** @jsxImportSource solid-js */
import { createSignal, ErrorBoundary, onCleanup, onMount } from 'solid-js'
import SkinPreviewBar from '../components/kernel/SkinPreviewBar.solid.tsx'
import ApplicationMount from './ApplicationMount.solid.tsx'
import KernelRecoveryLayer from './KernelRecoveryLayer.solid.tsx'
import { applicationRuntime } from '../application/applicationRuntimeServices.ts'
import { shouldExposeKernelAcceptanceControls } from '../application/acceptanceControls.ts'
import { listRendererDiagnosticsKeys, readRendererDiagnostics } from '../plugin-runtime/renderers/rendererDiagnosticsRegistry.ts'
import { BUILTIN_PYLON_SHELL_ID } from '../plugins/product/productPluginIds.ts'
import { kernelBootstrap } from './kernelBootstrapServices.ts'
import { startupMark } from '../app/startupTiming.ts'
import type { KernelBootstrap } from './kernelBootstrap.ts'
import type { ApplicationRuntime } from '../application/applicationRuntime.ts'

export const BUILTIN_PYLON_APPLICATION_ID = BUILTIN_PYLON_SHELL_ID
export { applicationRuntime } from '../application/applicationRuntimeServices.ts'

export interface KernelRootProps {
  bootstrap?: KernelBootstrap
  runtime?: ApplicationRuntime
}

/** Kernel bootstrap and crash recovery remain available when the product shell fails. */
export function KernelRoot(props: KernelRootProps = {}) {
  let reportedCrash: unknown
  const bootstrap = () => props.bootstrap ?? kernelBootstrap
  const runtime = () => props.runtime ?? applicationRuntime
  const [bootstrapState, setBootstrapState] = createSignal(bootstrap().getSnapshot())
  onCleanup(bootstrap().subscribe(() => setBootstrapState(bootstrap().getSnapshot())))

  onMount(() => {
    startupMark('kernel_root_effect')
    void bootstrap().startNormal()
  })

  onMount(() => {
    if (typeof window === 'undefined') return
    if (!shouldExposeKernelAcceptanceControls(import.meta.env.DEV, window.localStorage)) return
    const rt = runtime()
    const controls = {
      unmountApplication: () => rt.unmount(),
      remountApplication: () => rt.mount(BUILTIN_PYLON_APPLICATION_ID),
      getSnapshot: () => rt.getSnapshot(),
      /**
       * P89/S0 只读诊断读数：子系统登记、调用时懒取。
       * 例：`__PYLON_KERNEL_DEV__.diagnostics.read('streamingDisplay')`
       */
      diagnostics: {
        keys: () => listRendererDiagnosticsKeys(),
        read: (key: string) => readRendererDiagnostics(key),
      },
    }
    window.__PYLON_KERNEL_DEV__ = controls
    onCleanup(() => {
      if (window.__PYLON_KERNEL_DEV__ === controls) delete window.__PYLON_KERNEL_DEV__
    })
  })

  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        // One diagnostic per crash, including reactive fallback reevaluations.
        if (reportedCrash !== error) {
          reportedCrash = error
          console.error('Pylon crashed:', error)
        }
        return (
          <main class="flex h-full min-h-0 items-center justify-center overflow-auto bg-surface-canvas px-6 py-8 text-content-text max-[600px]:items-start">
            <section class="my-auto grid w-full max-w-[560px] gap-5 border-l-2 border-danger pl-6" role="alert">
              <span class="text-xs font-semibold tracking-widest text-content-muted">PYLON</span>
              <h1 class="m-0 text-2xl font-semibold">工作界面暂时无法显示</h1>
              <p class="m-0 text-sm leading-relaxed text-content-muted">可以尝试重新加载界面。若问题再次出现，请保留错误详情以便排查。</p>
              <details class="min-w-0 text-sm text-content-muted">
                <summary class="w-fit cursor-pointer">查看错误详情</summary>
                <pre class="max-h-[35vh] overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{error instanceof Error ? error.message : String(error)}</pre>
              </details>
              <button type="button" onClick={reset} class="w-fit cursor-pointer rounded-sm border border-stroke-default bg-surface-raised px-4 py-2 text-sm text-content-text hover:bg-hover-bg focus-visible:outline-2 focus-visible:outline-focus-ring">重新加载界面</button>
            </section>
          </main>
        )
      }}
    >
      <ApplicationMount
        runtime={runtime()}
        recovery={(
          <KernelRecoveryLayer
            state={bootstrapState()}
            onRetry={pluginId => { void bootstrap().retryPlugin(pluginId) }}
            onSafeMode={() => { void bootstrap().startSafeMode() }}
            onStartNormal={() => { void bootstrap().startNormal() }}
          />
        )}
      />
      {/* S5-D：Skin 预览作业面位于 Kernel 边界内，App 卸载/重挂不丢 preview 状态 */}
      <SkinPreviewBar />
    </ErrorBoundary>
  )
}

export default KernelRoot

declare global {
  interface Window {
    __PYLON_KERNEL_DEV__?: {
      unmountApplication: () => void
      remountApplication: () => void
      getSnapshot: () => ReturnType<typeof applicationRuntime.getSnapshot>
      diagnostics: {
        keys: () => readonly string[]
        read: (key: string) => ReturnType<typeof readRendererDiagnostics>
      }
    }
  }
}
