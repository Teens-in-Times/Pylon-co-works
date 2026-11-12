import { runtimeEventClient, type RuntimeEventClient, type RuntimeEventSubscription } from './runtimeEventClient.ts'
import { logWarn } from '../../contracts/frontendLogSink.ts'

type BrowserEvent = 'pylon:browser-status' | 'pylon:browser-page'
type Consumer = (payload: unknown) => void

/** Window-lifetime browser transport. Views own only local subscriptions; changing
 * Sheets or Agents must not tear down Tauri listeners while IPC is in flight. */
export function createBrowserEventFeed(client: RuntimeEventClient = runtimeEventClient) {
  const groups = new Map<BrowserEvent, Set<Consumer>>()
  const sources = new Map<BrowserEvent, RuntimeEventSubscription>()

  return {
    subscribe<T>(event: BrowserEvent, onPayload: (payload: T) => void): RuntimeEventSubscription {
      let consumers = groups.get(event)
      if (!consumers) {
        consumers = new Set()
        groups.set(event, consumers)
      }
      const group = consumers
      const consumer: Consumer = payload => onPayload(payload as T)
      group.add(consumer)
      if (!sources.has(event)) {
        sources.set(event, client.subscribe<unknown>(event, payload => {
          for (const notify of [...group]) {
            if (!group.has(notify)) continue
            try { notify(payload) }
            catch (error) { logWarn(`处理浏览器事件失败：${event}`, error) }
          }
        }))
      }
      return { dispose: () => { group.delete(consumer) } }
    },
    /** Explicit transport shutdown, never a view cleanup or a zero-consumer action. */
    dispose(): void {
      for (const group of groups.values()) group.clear()
      groups.clear()
      for (const source of sources.values()) source.dispose()
      sources.clear()
    },
  }
}

/** Two fixed events at most for this window. No Agent/session snapshots are retained. */
export const browserEventFeed = createBrowserEventFeed()
