/** @jsxImportSource solid-js */
import { createEffect, createMemo, on, onCleanup } from 'solid-js'
import { getPluginUiRegistry } from '../runtimeServices.ts'
import { createRegistrySignal } from '../../infrastructure/state/solidSheetSupport.solid.tsx'
import type { PluginUiEventBridge, PluginUiUnmount } from './pluginUiTypes.ts'
import { resolvePluginUiRuntime } from './pluginUiTypes.ts'

function createBridge(onEvent?: (event: string, detail: unknown) => void): PluginUiEventBridge & { clear(): void } {
  const listeners = new Map<string, Set<(detail: unknown) => void>>()
  return {
    emit(event, detail) {
      onEvent?.(event, detail)
      for (const listener of [...(listeners.get(event) ?? [])]) listener(detail)
    },
    on(event, listener) {
      const group = listeners.get(event) ?? new Set()
      group.add(listener)
      listeners.set(event, group)
      return () => {
        group.delete(listener)
        if (group.size === 0) listeners.delete(event)
      }
    },
    clear: () => listeners.clear(),
  }
}

async function unmount(result: PluginUiUnmount): Promise<void> {
  if (typeof result === 'function') await result()
  else if (result) await result.unmount()
}

/**
 * IsolatedPluginSurfaceProps — 插件 isolated-surface 贡献的挂载输入（wire 契约见
 * pluginUiApi/pluginUiRegistry，DOM data-* 属性是存量契约，禁止漂移）。
 */
interface IsolatedPluginSurfaceProps {
  surfaceId: string
  className?: string
  input?: unknown
  onEvent?: (event: string, detail: unknown) => void
}

/**
 * IsolatedPluginSurface — 插件 isolated-surface 贡献的 Solid 挂载实体（#515 贡献面翻转：
 * 本文件自 sheets/file/isolatedPluginSurface.solid.tsx 晋升为正式实现，file 域副本删除；
 * 原件是 React 版 IsolatedPluginSurface.tsx 的逐行 Solid 移植——注册表订阅/挂载生命周期/
 * host:input 推流语义与 data-* DOM 契约逐字节保持）。React 世界（App 的 interface-mode
 * shell surface）仍经同名薄桥挂载本实体，批7 拆桥后直连。
 */
export function IsolatedPluginSurface(props: IsolatedPluginSurfaceProps) {
  const pluginUiRegistry = getPluginUiRegistry()
  const snapshot = createRegistrySignal(pluginUiRegistry, () => pluginUiRegistry.getSnapshot())
  const entry = createMemo(() => snapshot().entries.find(candidate => candidate.value.id === props.surfaceId))
  const runtime = createMemo(() => entry() ? resolvePluginUiRuntime(entry()!.value).runtime : undefined)

  let containerElement: HTMLDivElement | undefined
  let bridgeRef: (PluginUiEventBridge & { clear(): void }) | null = null

  createEffect(() => {
    const currentEntry = entry()
    const container = containerElement
    if (!container || !currentEntry) return
    const bridge = createBridge((event, detail) => props.onEvent?.(event, detail))
    bridgeRef = bridge
    let disposed = false
    let result: PluginUiUnmount
    void Promise.resolve(currentEntry.value.mount(container, bridge)).then(value => {
      if (disposed) void unmount(value)
      else {
        result = value
        bridge.emit('host:input', props.input)
      }
    })
    onCleanup(() => {
      disposed = true
      bridge.clear()
      bridgeRef = null
      void unmount(result)
      container.replaceChildren()
    })
  })

  // input 变化 → 推流 host:input（挂载初期 bridge 未就绪时静默跳过，由 mount 兑现回调补发）。
  createEffect(on(() => props.input, currentInput => {
    bridgeRef?.emit('host:input', currentInput)
  }))

  return (
    <div
      ref={element => { containerElement = element }}
      class={props.className}
      data-plugin-ui-surface={props.surfaceId}
      data-plugin-ui-owner={entry()?.ownerPluginId}
      data-plugin-framework={runtime()?.framework}
      data-plugin-runtime-version={runtime()?.version}
      data-plugin-react-version={runtime()?.framework === 'react' ? runtime()?.version : undefined}
    />
  )
}
