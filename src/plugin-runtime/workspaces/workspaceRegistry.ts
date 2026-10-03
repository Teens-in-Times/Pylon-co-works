/**
 * workspaceRegistry — Workspace 元数据响应式注册表（阶段 6 首个切片）。
 *
 * 单一真值：完整 WorkspaceTypeDefinition（metadata + component + state codec）。
 * v2 plugin 经 PluginScope 注册/注销；revision 驱动 Solid 信号消费。
 */
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { AsyncDisposable } from '../registry/types.ts'
import type { SheetInput } from '../../contracts/sheets.ts'
import type { WorkspaceLaunchOption, WorkspaceTypeDefinition } from './workspaceTypes.ts'
import { notifyRegistryListener } from '../registry/registryBatch.ts'
import { createDeferrableDisposable } from '../../utils/deferrableDisposable.ts'

export interface WorkspaceRegistryEntry {
  readonly ownerPluginId: string
  readonly ownerRuntimeInstanceId: string
  readonly descriptor: WorkspaceTypeDefinition
}

export interface WorkspaceRegistrySnapshot {
  readonly revision: number
  readonly entries: readonly WorkspaceRegistryEntry[]
  readonly workspaces: readonly WorkspaceTypeDefinition[]
  readonly launchOptions: readonly WorkspaceLaunchOption[]
}

export interface WorkspaceRegistryTransaction {
  register(descriptor: WorkspaceTypeDefinition): AsyncDisposable
  validate(): void
  commit(): void
  rollback(): void
  revert(): void
}

function normalizeDescriptor(descriptor: WorkspaceTypeDefinition): WorkspaceTypeDefinition {
  if (!descriptor.kind || descriptor.kind !== descriptor.kind.trim()) {
    throw new Error('workspace kind 必须是非空且无首尾空格的字符串')
  }
  if (!descriptor.label?.trim()) throw new Error(`workspace label 不能为空：${descriptor.kind}`)
  if (typeof descriptor.getSingletonKey !== 'function') {
    throw new Error(`workspace getSingletonKey 必须是函数：${descriptor.kind}`)
  }
  if (!['workspace', 'sheet', 'none'].includes(descriptor.sidebarMode)) {
    throw new Error(`workspace sidebarMode 非法：${descriptor.kind}`)
  }
  if (descriptor.launch && descriptor.launch.kind !== descriptor.kind) {
    throw new Error(`workspace launch kind 必须与 descriptor.kind 一致：${descriptor.kind}`)
  }
  if (descriptor.launch?.category !== undefined && !descriptor.launch.category.trim()) {
    throw new Error(`workspace launch category 不能为空：${descriptor.kind}`)
  }
  if (descriptor.launch?.order !== undefined && !Number.isFinite(descriptor.launch.order)) {
    throw new Error(`workspace launch order 必须是有限数字：${descriptor.kind}`)
  }
  if (descriptor.launch?.categoryOrder !== undefined && !Number.isFinite(descriptor.launch.categoryOrder)) {
    throw new Error(`workspace launch categoryOrder 必须是有限数字：${descriptor.kind}`)
  }
  if (typeof descriptor.component !== 'function' && typeof descriptor.component !== 'object') {
    throw new Error(`workspace component 非法：${descriptor.kind}`)
  }
  for (const method of ['createInitialState', 'serialize', 'deserialize'] as const) {
    if (typeof descriptor[method] !== 'function') throw new Error(`workspace ${method} 必须是函数：${descriptor.kind}`)
  }
  return Object.freeze({
    ...descriptor,
    ...(descriptor.launch ? { launch: Object.freeze({
      ...descriptor.launch,
      ...(descriptor.launch.keywords ? { keywords: Object.freeze([...descriptor.launch.keywords]) } : {}),
    }) } : {}),
  })
}

export class WorkspaceRegistryStore {
  private readonly entries = new Map<string, WorkspaceRegistryEntry>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private snapshot: WorkspaceRegistrySnapshot = Object.freeze({
    revision: 0,
    entries: Object.freeze([]),
    workspaces: Object.freeze([]),
    launchOptions: Object.freeze([]),
  })

  register(owner: PluginIdentity, descriptor: WorkspaceTypeDefinition): AsyncDisposable {
    const normalized = normalizeDescriptor(descriptor)
    if (this.entries.has(descriptor.kind)) throw new Error(`workspace 已注册：${descriptor.kind}`)
    const entry = Object.freeze({
      ownerPluginId: owner.pluginId,
      ownerRuntimeInstanceId: owner.key,
      descriptor: normalized,
    })
    this.entries.set(descriptor.kind, entry)
    this.publish()
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        if (this.entries.get(descriptor.kind) !== entry) return
        this.entries.delete(descriptor.kind)
        this.publish()
      },
    }
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): WorkspaceRegistryTransaction {
    const staged: Array<{
      entry: WorkspaceRegistryEntry
      proxy: AsyncDisposable
      cancelled: boolean
    }> = []
    let settled = false
    let committed = false
    let reverted = false
    let previousEntries: Map<string, WorkspaceRegistryEntry> | undefined
    const candidate = () => {
      const next = new Map(this.entries)
      for (const [kind, entry] of next) {
        if (entry.ownerRuntimeInstanceId === replacingRuntimeInstanceId) next.delete(kind)
      }
      for (const item of staged) {
        if (item.cancelled) continue
        if (next.has(item.entry.descriptor.kind)) {
          throw new Error(`workspace 已注册：${item.entry.descriptor.kind}`)
        }
        next.set(item.entry.descriptor.kind, item.entry)
      }
      return next
    }
    return {
      register: descriptor => {
        if (settled) throw new Error(`Workspace transaction 已结算：${owner.key}`)
        const entry = Object.freeze({
          ownerPluginId: owner.pluginId,
          ownerRuntimeInstanceId: owner.key,
          descriptor: normalizeDescriptor(descriptor),
        })
        const item = {
          entry,
          cancelled: false,
          proxy: createDeferrableDisposable(),
        }
        item.proxy = {
          dispose: () => {
            if (item.cancelled) return
            item.cancelled = true
            const kind = item.entry.descriptor.kind
            if (!committed || this.entries.get(kind) !== item.entry) return
            this.entries.delete(kind)
            this.publish()
          },
        }
        staged.push(item)
        return item.proxy
      },
      validate: () => {
        if (settled) throw new Error(`Workspace transaction 已结算：${owner.key}`)
        candidate()
      },
      commit: () => {
        if (settled) throw new Error(`Workspace transaction 已结算：${owner.key}`)
        const next = candidate()
        settled = true
        committed = true
        previousEntries = new Map(this.entries)
        this.entries.clear()
        for (const [kind, entry] of next) this.entries.set(kind, entry)
        this.publish()
      },
      rollback: () => {
        if (settled) throw new Error(`Workspace transaction 已结算：${owner.key}`)
        settled = true
      },
      revert: () => {
        if (!committed || !previousEntries) {
          throw new Error(`Workspace transaction 尚未 commit：${owner.key}`)
        }
        if (reverted) return
        reverted = true
        this.entries.clear()
        for (const [kind, entry] of previousEntries) this.entries.set(kind, entry)
        this.publish()
      },
    }
  }

  resolve(kind: unknown): WorkspaceTypeDefinition | undefined {
    return typeof kind === 'string' ? this.entries.get(kind)?.descriptor : undefined
  }

  list(): readonly WorkspaceTypeDefinition[] {
    return this.snapshot.workspaces
  }

  listLaunchOptions(): readonly WorkspaceLaunchOption[] {
    return this.snapshot.launchOptions
  }

  resolveSingletonKey(input: Pick<SheetInput, 'kind' | 'agentId' | 'singletonKey' | 'metadata'>): string | undefined {
    return this.resolve(input.kind)?.getSingletonKey(input)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): WorkspaceRegistrySnapshot {
    return this.snapshot
  }

  /** Clears entries and subscriptions for HMR/test teardown. */
  dispose(): void {
    this.entries.clear()
    this.listeners.clear()
    this.publish()
  }

  private publish(): void {
    this.revision += 1
    const entries = [...this.entries.values()].sort((a, b) => (
      a.descriptor.kind < b.descriptor.kind ? -1 : a.descriptor.kind > b.descriptor.kind ? 1 : 0
    ))
    const workspaces = entries.map(entry => entry.descriptor)
    const launchOptions = workspaces
      .filter(workspace => workspace.launch)
      .map(workspace => workspace.launch!)
      .sort((a, b) => {
        const categoryOrder = (a.categoryOrder ?? 100) - (b.categoryOrder ?? 100)
        if (categoryOrder !== 0) return categoryOrder
        const category = (a.category ?? 'other').localeCompare(b.category ?? 'other')
        if (category !== 0) return category
        const order = (a.order ?? 100) - (b.order ?? 100)
        if (order !== 0) return order
        return a.kind.localeCompare(b.kind)
      })
    this.snapshot = Object.freeze({
      revision: this.revision,
      entries: Object.freeze(entries),
      workspaces: Object.freeze(workspaces),
      launchOptions: Object.freeze(launchOptions),
    })
    for (const listener of [...this.listeners]) notifyRegistryListener(listener)
  }
}

let store = new WorkspaceRegistryStore()

/** RuntimeServices composition root may replace the compatibility owner. */
export function setWorkspaceRegistryStore(next: WorkspaceRegistryStore): void {
  store = next
}

export function getWorkspaceRegistryStore(): WorkspaceRegistryStore {
  return store
}

export function registerWorkspace(owner: PluginIdentity, descriptor: WorkspaceTypeDefinition): AsyncDisposable {
  return store.register(owner, descriptor)
}

export function resolveWorkspace(kind: unknown): WorkspaceTypeDefinition | undefined {
  return store.resolve(kind)
}

export function listWorkspaces(): readonly WorkspaceTypeDefinition[] {
  return store.list()
}

export function listWorkspaceLaunchOptions(): readonly WorkspaceLaunchOption[] {
  return store.listLaunchOptions()
}

export function resolveSheetSingletonKey(input: Pick<SheetInput, 'kind' | 'agentId' | 'singletonKey' | 'metadata'>): string | undefined {
  return store.resolveSingletonKey(input)
}

export function subscribeWorkspaceRegistry(listener: () => void): () => void {
  return store.subscribe(listener)
}

export function getWorkspaceRegistrySnapshot(): WorkspaceRegistrySnapshot {
  return store.getSnapshot()
}

export function beginWorkspaceShadowTransaction(
  owner: PluginIdentity,
  replacingRuntimeInstanceId: string,
): WorkspaceRegistryTransaction {
  return store.beginShadowTransaction(owner, replacingRuntimeInstanceId)
}

/** Sheet kind 有效性（原 workspace-sheets/sheetTypes 值件；与 registry 同源防漂移）。 */
export function isSheetKind(value: unknown): value is string {
  return typeof value === 'string' && resolveWorkspace(value) !== undefined
}
