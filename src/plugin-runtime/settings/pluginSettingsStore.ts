import type { PluginSettingValue } from './pluginSettingsTypes.ts'
import type { SettingsValueAdapter } from '../../contracts/rendererSettingsSchema.ts'
import { validatePluginKey } from './pluginKeyValidation.ts'

const STORAGE_KEY = 'pylon-plugin-settings-v1'

function cloneValue(value: PluginSettingValue): PluginSettingValue {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('插件设置必须可 JSON 序列化')
  return JSON.parse(json) as PluginSettingValue
}

export class PluginSettingsStore {
  private hydrated = false
  private values: Record<string, Readonly<Record<string, PluginSettingValue>>> = {}
  private readonly listeners = new Map<string, Set<() => void>>()
  /** 从未写过值的 namespace 共享同一空快照：useSyncExternalStore 的
   *  getSnapshot 要求引用稳定，每次新建 {} 会触发 React #185 无限重渲染
   *  （真实缺陷：无 schema 插件设置页首次渲染即崩）。 */
  private static readonly EMPTY_NAMESPACE: Readonly<Record<string, PluginSettingValue>> = Object.freeze({})

  getSnapshot(pluginId: string): Readonly<Record<string, PluginSettingValue>> {
    this.hydrate()
    return this.values[pluginId] ?? PluginSettingsStore.EMPTY_NAMESPACE
  }

  get(pluginId: string, key: string): PluginSettingValue | undefined {
    validatePluginKey(key, '插件设置')
    return this.getSnapshot(pluginId)[key]
  }

  set(pluginId: string, key: string, value: PluginSettingValue): void {
    validatePluginKey(key, '插件设置')
    const next = Object.freeze({ ...this.getSnapshot(pluginId), [key]: cloneValue(value) })
    this.values = { ...this.values, [pluginId]: next }
    this.persist()
    this.publish(pluginId)
  }

  remove(pluginId: string, key: string): void {
    validatePluginKey(key, '插件设置')
    const current = this.getSnapshot(pluginId)
    if (!(key in current)) return
    const next = { ...current }
    delete next[key]
    this.values = { ...this.values, [pluginId]: Object.freeze(next) }
    this.persist()
    this.publish(pluginId)
  }

  subscribe(pluginId: string, listener: () => void): () => void {
    const group = this.listeners.get(pluginId) ?? new Set()
    group.add(listener)
    this.listeners.set(pluginId, group)
    return () => {
      group.delete(listener)
      if (group.size === 0) this.listeners.delete(pluginId)
    }
  }

  private hydrate(): void {
    if (this.hydrated) return
    this.hydrated = true
    if (typeof localStorage === 'undefined') return
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, Record<string, PluginSettingValue>>
      this.values = Object.fromEntries(Object.entries(parsed).map(([pluginId, values]) => [pluginId, Object.freeze({ ...values })]))
    } catch {
      this.values = {}
    }
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values))
  }

  private publish(pluginId: string): void {
    for (const listener of [...(this.listeners.get(pluginId) ?? [])]) listener()
  }
}

/** Host-owned adapter that isolates each page/panel by plugin + contribution. */
export function createPluginSettingsValueAdapter(input: {
  readonly store: PluginSettingsStore
  readonly ownerPluginId: string
  readonly contributionId: string
  readonly namespace: 'plugin-page' | 'context-panel'
}): SettingsValueAdapter {
  // Length-delimited key prevents `a::b::c` collisions while keeping the
  // bucket opaque to plugin code. Legacy pluginId buckets remain available to
  // opaque pages and are not implicitly copied into a schema contribution.
  const bucket = `pylon:${input.ownerPluginId.length}:${input.ownerPluginId}:${input.contributionId.length}:${input.contributionId}`
  let revision = 0
  const unavailable: Record<string, { value?: PluginSettingValue; code: string; message: string }> = {}
  let snapshot: ReturnType<SettingsValueAdapter['getSnapshot']> | undefined
  let selfMutation = false
  const listeners = new Set<() => void>()
  let externalUnsubscribe: (() => void) | undefined
  const invalidate = () => { snapshot = undefined; revision += 1 }
  const notify = () => { invalidate(); for (const listener of [...listeners]) listener() }
  const ensureExternalSubscription = () => {
    if (externalUnsubscribe) return
    externalUnsubscribe = input.store.subscribe(bucket, () => {
      if (selfMutation) return
      notify()
    })
  }
  const adapter: SettingsValueAdapter = {
    namespace: input.namespace,
    ownerPluginId: input.ownerPluginId,
    contributionId: input.contributionId,
    getSnapshot: () => {
      if (!snapshot) snapshot = Object.freeze({
        values: Object.freeze({ ...input.store.getSnapshot(bucket) }) as Readonly<Record<string, PluginSettingValue>>,
        unavailable: Object.freeze(Object.fromEntries(Object.entries(unavailable).map(([key, value]) => [key, Object.freeze({ ...value })]))),
        revision,
      })
      return snapshot
    },
    setValue: (fieldKey, value) => {
      selfMutation = true
      try {
        input.store.set(bucket, fieldKey, value as PluginSettingValue)
      } finally {
        selfMutation = false
      }
      delete unavailable[fieldKey]
      notify()
    },
    removeValue: fieldKey => {
      if (!(fieldKey in input.store.getSnapshot(bucket))) return
      selfMutation = true
      try { input.store.remove(bucket, fieldKey) } finally { selfMutation = false }
      notify()
    },
    reset: fieldKey => {
      if (!(fieldKey in input.store.getSnapshot(bucket))) return
      selfMutation = true
      try { input.store.remove(bucket, fieldKey) } finally { selfMutation = false }
      notify()
    },
    markUnavailable: (fieldKey, value, code, message) => {
      unavailable[fieldKey] = { value: value as PluginSettingValue, code, message }
      notify()
    },
    restoreUnavailable: fieldKey => {
      const item = unavailable[fieldKey]
      if (!item) return
      if (item.value !== undefined) {
        selfMutation = true
        try { input.store.set(bucket, fieldKey, item.value) } finally { selfMutation = false }
      }
      delete unavailable[fieldKey]
      notify()
    },
    subscribe: listener => {
      ensureExternalSubscription()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          externalUnsubscribe?.()
          externalUnsubscribe = undefined
        }
      }
    },
  }
  return adapter
}
