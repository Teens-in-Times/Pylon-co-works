/** @jsxImportSource solid-js */
import { createSignal, onCleanup, Show, Suspense, type JSX } from 'solid-js'
import type { ApplicationRuntime } from '../application/applicationRuntime.ts'

interface ApplicationMountProps {
  runtime: ApplicationRuntime
  /** recovery 兜底层（Kernel 恢复界面）；无激活应用时渲染。 */
  recovery: JSX.Element
}

/** Projects the active application with a visible loading and recovery state. */
export default function ApplicationMount(props: ApplicationMountProps): JSX.Element {
  const [snapshot, setSnapshot] = createSignal(props.runtime.getSnapshot())
  onCleanup(props.runtime.subscribe(() => setSnapshot(props.runtime.getSnapshot())))
  return (
    <Show
      when={snapshot().activeApplicationId ? props.runtime.resolve(snapshot().activeApplicationId!) : null}
      fallback={props.recovery}
    >
      {contribution => {
        const Application = contribution().component
        return <Suspense fallback={<div role="status" class="flex h-full items-center justify-center px-6 py-8 text-sm text-content-muted">正在加载工作界面…</div>}><Application /></Suspense>
      }}
    </Show>
  )
}
