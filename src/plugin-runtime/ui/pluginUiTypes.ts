export interface PluginUiEventBridge {
  emit(event: string, detail?: unknown): void
  on(event: string, listener: (detail: unknown) => void): () => void
}

export type PluginUiUnmount = void | (() => void | Promise<void>) | {
  unmount(): void | Promise<void>
}

export type PluginUiFramework = 'solid' | 'react' | 'webcomponent'

export interface PluginUiRuntime {
  readonly framework: PluginUiFramework
  readonly version: string
}

export interface PluginUiRuntimeResolution {
  readonly runtime: PluginUiRuntime
  readonly deprecated: boolean
}

/**
 * The mount function belongs to the plugin bundle. It declares its UI runtime
 * via `runtime: { framework: 'solid', version: '1.9' }` (the regular form) and
 * may close over any framework version bundled by that plugin; the host never
 * receives a framework-bound component.
 */
export interface PluginUiSurface {
  readonly id: string
  /** Framework-neutral runtime metadata. */
  readonly runtime?: PluginUiRuntime
  /** @deprecated API 1.0 compatibility alias; normalized into runtime. */
  readonly reactVersion?: string
  readonly mount: (
    container: HTMLElement,
    bridge: PluginUiEventBridge,
  ) => PluginUiUnmount | Promise<PluginUiUnmount>
}

export function resolvePluginUiRuntime(surface: Pick<PluginUiSurface, 'runtime' | 'reactVersion'>): PluginUiRuntimeResolution {
  if (surface.runtime) {
    if (!surface.runtime.version.trim()) throw new Error('Plugin UI runtime version 不能为空')
    return { runtime: Object.freeze({ ...surface.runtime }), deprecated: false }
  }
  if (surface.reactVersion?.trim()) {
    return { runtime: Object.freeze({ framework: 'react', version: surface.reactVersion }), deprecated: true }
  }
  throw new Error('Plugin UI 缺少 runtime/framework version')
}
