/** A mounted plugin owns a revocable bridge and a private DOM root, including during asynchronous teardown. */
import type { PluginUiEventBridge, PluginUiSurface, PluginUiUnmount } from './pluginUiTypes.ts'

interface SurfaceSessionOptions {
  container: HTMLElement
  surface: PluginUiSurface
  input: unknown
  onEvent: (event: string, detail: unknown) => void
  onReady: () => void
  onError: (error: unknown) => void
  onCleanupError: (error: unknown) => void
}

export function createPluginSurfaceSession(options: SurfaceSessionOptions) {
  const listeners = new Map<string, Set<(detail: unknown) => void>>()
  let disposed = false
  let mounted = false
  let started = false
  let input = options.input
  let result: PluginUiUnmount

  const fail = (error: unknown) => {
    if (disposed) return
    dispose()
    options.onError(error)
  }
  const deliver = (event: string, detail: unknown) => {
    if (disposed) return
    try {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        if (disposed) break
        listener(detail)
      }
    } catch (error) { fail(error) }
  }
  const bridge: PluginUiEventBridge = {
    emit(event, detail) {
      if (disposed) return
      try { options.onEvent(event, detail) } catch (error) { fail(error) }
      deliver(event, detail)
    },
    on(event, listener) {
      if (disposed) return () => {}
      const group = listeners.get(event) ?? new Set()
      group.add(listener)
      listeners.set(event, group)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        group.delete(listener)
        if (!group.size && listeners.get(event) === group) listeners.delete(event)
      }
    },
  }
  const cleanup = async (value: PluginUiUnmount) => {
    try {
      if (typeof value === 'function') await value()
      else if (value) await value.unmount()
    } catch (error) { options.onCleanupError(error) }
    finally { options.container.replaceChildren() }
  }
  function dispose() {
    if (disposed) return
    disposed = true
    listeners.clear()
    options.container.replaceChildren()
    if (mounted) void cleanup(result)
  }

  return {
    mount() {
      if (disposed || started) return
      started = true
      // The promise captures sync throws and async rejections without letting
      // plugin signal reads subscribe a host computation.
      void Promise.resolve().then(() => {
        if (!disposed) return options.surface.mount(options.container, bridge)
      }).then(value => {
        if (disposed) { void cleanup(value); return }
        result = value
        mounted = true
        deliver('host:input', input)
        if (!disposed) options.onReady()
      }).catch(fail)
    },
    update(value: unknown) {
      input = value
      if (mounted) deliver('host:input', value)
    },
    dispose,
  }
}
