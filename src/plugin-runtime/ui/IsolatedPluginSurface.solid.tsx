/** @jsxImportSource solid-js */
/** Owns one DOM root and event bridge per registry entry; late work only touches its retired root. */
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import { createRegistrySignal } from '../../infrastructure/state/solidSheetSupport.solid.tsx'
import type { RegistryEntry } from '../registry/types.ts'
import { getPluginUiRegistry } from '../runtimeServices.ts'
import { createPluginSurfaceSession } from './pluginSurfaceSession.ts'
import type { PluginUiSurface } from './pluginUiTypes.ts'
import { resolvePluginUiRuntime } from './pluginUiTypes.ts'

interface IsolatedPluginSurfaceProps {
  surfaceId: string
  className?: string
  input?: unknown
  onEvent?: (event: string, detail: unknown) => void
}

function MountedSurface(props: IsolatedPluginSurfaceProps & { entry: RegistryEntry<PluginUiSurface> }) {
  const runtime = resolvePluginUiRuntime(props.entry.value).runtime
  const [ready, setReady] = createSignal(false)
  const [failure, setFailure] = createSignal<{ error: unknown }>()
  let container!: HTMLDivElement
  let session: ReturnType<typeof createPluginSurfaceSession> | undefined

  // Rethrow on the Solid owner so async failures reach the contribution boundary.
  createEffect(() => { const value = failure(); if (value) throw value.error })
  createEffect(() => { const input = props.input; session?.update(input) })
  onCleanup(() => session?.dispose())
  onMount(() => {
    session = createPluginSurfaceSession({
      container,
      surface: props.entry.value,
      input: props.input,
      onEvent: (event, detail) => props.onEvent?.(event, detail),
      onReady: () => setReady(true),
      onError: error => setFailure({ error }),
      onCleanupError: error => reportRuntimeError(`卸载插件界面 ${props.surfaceId}`, error, undefined, {
        key: `plugin-surface-cleanup:${props.surfaceId}`,
        source: 'plugin.surface',
        visibility: 'diagnostic',
      }),
    })
    session.mount()
  })

  return <>
    <Show when={!ready()}><div role="status" class="px-3 py-2 text-sm text-content-muted">正在加载插件界面…</div></Show>
    <div
      ref={element => { container = element }}
      class={props.className}
      aria-busy={!ready()}
      data-plugin-ui-surface={props.surfaceId}
      data-plugin-ui-owner={props.entry.ownerPluginId}
      data-plugin-framework={runtime.framework}
      data-plugin-runtime-version={runtime.version}
      data-plugin-react-version={runtime.framework === 'react' ? runtime.version : undefined}
    />
  </>
}

export function IsolatedPluginSurface(props: IsolatedPluginSurfaceProps) {
  const registry = getPluginUiRegistry()
  const snapshot = createRegistrySignal(registry, () => registry.getSnapshot())
  const entry = createMemo(() => snapshot().entries.find(candidate => candidate.value.id === props.surfaceId))
  return <Show when={entry()} keyed fallback={
    <div class={props.className} role="status">插件界面尚未就绪</div>
  }>
    {current => <MountedSurface {...props} entry={current} />}
  </Show>
}
