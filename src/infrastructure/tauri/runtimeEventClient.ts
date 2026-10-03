/**
 * runtimeEventClient — Tauri window event 订阅的最小收口（#520 S1-P1「视图直订
 * Tauri event 绕过传输层」）。
 *
 * 此前视图各自 `import { listen } from '@tauri-apps/api/event'` 直订（
 * check-runtime-boundaries 只管 invoke 不管 listen），事件订阅无传输层入口。
 * 本 client 把 listen/unlisten 包成带 disposal 语义的订阅：
 * - `dispose()` 幂等；注册 promise 已 settle 时立即注销，尚未 settle 时 settle 后
 *   自动注销；
 * - dispose 前到达的事件照常投递，dispose 后不再投递；
 * - 注册失败的拒绝只在 dispose 处吸收（与原视图 onCleanup 里逐条
 *   `.catch(() => {})` 的语义对应），不在订阅路径上新增错误上报——行为零变化。
 */
import { listen as tauriListen } from '@tauri-apps/api/event'

export interface RuntimeEventSubscription {
  /** 停止投递并注销底层 listener；重复调用为 no-op。 */
  dispose(): void
}

export interface RuntimeEventClient {
  /** 订阅一个 Tauri window event；payload 经类型参数标注，原样交给 handler。 */
  subscribe<T>(event: string, onPayload: (payload: T) => void): RuntimeEventSubscription
}

export function createRuntimeEventClient(listen: typeof tauriListen = tauriListen): RuntimeEventClient {
  return {
    subscribe<T>(event: string, onPayload: (payload: T) => void): RuntimeEventSubscription {
      let disposed = false
      let unlisten: (() => void) | undefined
      const registration = listen<T>(event, event => {
        if (!disposed) onPayload(event.payload)
      })
      void registration.then(stop => {
        // dispose 跑在注册 settle 之前：settle 后补注销。
        if (disposed) stop()
        else unlisten = stop
      })
      return {
        dispose() {
          if (disposed) return
          disposed = true
          const stop = unlisten
          unlisten = undefined
          void registration.catch(() => {})
          stop?.()
        },
      }
    },
  }
}

/** 进程级单例：视图订阅经此取用，不再各自 import listen。 */
export const runtimeEventClient: RuntimeEventClient = createRuntimeEventClient()
