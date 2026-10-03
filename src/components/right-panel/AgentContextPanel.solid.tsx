/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor } from 'solid-js'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import MessageSearchBar from './MessageSearchBar.solid.tsx'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { toAgentContextKey } from '../../domains/agent/agentContext'
import { sessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import { createSessionUiSignal } from '../../renderers/solid-workbench/adapters/sessionUiSignal.solid.tsx'
import { searchValuesMatchQuery } from '../../domains/chat/messageSearchIndex'
import type { SessionUiKey } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchDocument } from '../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchHostPort } from '../../plugin-runtime/renderers/workbenchHostPort.ts'
import {
  getActiveWorkbenchHostPort,
  subscribeActiveWorkbenchHostPort,
} from '../../application/agent-workbench/activeWorkbenchHostPort.ts'
import type { AgentContextPanelProps } from './rightPanelTypes.ts'

/** 按会话作用域的 UI 状态：#520 S2-P1-1 双注册表归一后，legacy 值直接住统一
 * sessionUiStore 单例（订阅完整），signal 为本地读视图（sessionUiSignal 适配器）。 */
function createSessionUiState<T>(
  sessionId: () => string | null,
  key: SessionUiKey,
  initial: T,
): [Accessor<T>, (action: T | ((previous: T) => T)) => void] {
  return createSessionUiSignal(sessionUiStore, sessionId, key, initial)
}

/** 当前 Sheet 发布的 Workbench Host Port（订阅随 sheetId 变化重挂）。 */
function createActiveWorkbenchHostPort(sheetId: () => string): Accessor<WorkbenchHostPort | undefined> {
  const [port, setPort] = createSignal<WorkbenchHostPort | undefined>(getActiveWorkbenchHostPort(sheetId()))
  createEffect(() => {
    const id = sheetId()
    setPort(getActiveWorkbenchHostPort(id))
    onCleanup(subscribeActiveWorkbenchHostPort(id, () => setPort(getActiveWorkbenchHostPort(id))))
  })
  return port
}

/** hostPort.sessionUi 的单键投影（bindingKey 为 null 时回落 fallback；fallback 变化重算）。 */
function createHostSessionUiValue<T>(
  hostPort: () => WorkbenchHostPort | undefined,
  bindingKey: () => string | null,
  key: SessionUiKey,
  fallback: () => T,
): Accessor<T> {
  const [value, setValue] = createSignal<T>(fallback())
  createEffect(() => {
    const port = hostPort()
    const id = bindingKey()
    const fb = fallback()
    // updater 形态：泛型 T 可能是函数值，走 (prev) => next 重载避开 Solid setter 的排除分支。
    setValue(() => (id === null ? fb : (port?.sessionUi.get<T>(key, fb) ?? fb)))
    if (id !== null && port) {
      onCleanup(port.sessionUi.subscribe(key, () => setValue(() => (port.sessionUi.get<T>(key, fb) ?? fb))))
    }
  })
  return value
}

/** hostPort.document 的快照投影（canonical document 变化即更新）。 */
function createHostDocument(hostPort: () => WorkbenchHostPort | undefined): Accessor<WorkbenchDocument | undefined> {
  const [document, setDocument] = createSignal<WorkbenchDocument | undefined>(hostPort()?.document.getSnapshot())
  createEffect(() => {
    const port = hostPort()
    setDocument(port?.document.getSnapshot())
    if (port) {
      onCleanup(port.document.subscribe(() => setDocument(port.document.getSnapshot())))
    }
  })
  return document
}

/**
 * AgentContextPanel — agent 右栏（W2-12，F2-F）。
 *
 * 搜索模式：Renderer Suite 存在时消费当前 Sheet 发布的 Workbench Host Port，
 * 从 canonical document 计算命中并写 namespaced SessionUiPort；legacy ChatView
 * 仍通过原 sessionUiState/controller 回退，切换渲染模式不丢现有搜索能力。
 * 关联模式：touchedFiles 正向（会话→文件）。
 */
export default function AgentContextPanel(props: AgentContextPanelProps) {
  const sessionId = () => props.ctx.activeSession
  const source = () => props.ctx.sessionSource(sessionId())
  const hostPort = createActiveWorkbenchHostPort(() => props.sheet.id)
  const hostDocument = createHostDocument(hostPort)
  const [legacySearchQuery, setLegacySearchQuery] = createSessionUiState(sessionId, 'search-query', '')
  const [legacySearchIndex, setLegacySearchIndex] = createSessionUiState(sessionId, 'search-index', 0)
  const searchQuery = createHostSessionUiValue(hostPort, sessionId, 'search-query', legacySearchQuery)
  const searchIndex = createHostSessionUiValue(hostPort, sessionId, 'search-index', legacySearchIndex)
  const [mode, setMode] = createSignal<'search' | 'relations'>('search')

  // Host 出现时把 legacy 会话状态桥接进 Host Port namespace。仅「同一会话上出现
  // （首个/更换的）Host」才桥；会话切换必须从新 owner namespace 起步。
  let initializedHostBinding = false
  let previousHostPort: WorkbenchHostPort | undefined
  let previousSessionId: string | null = sessionId()
  createEffect(() => {
    const port = hostPort()
    const id = sessionId()
    const firstBinding = !initializedHostBinding
    initializedHostBinding = true
    const hostChanged = previousHostPort !== port
    const sessionChanged = previousSessionId !== id
    previousHostPort = port
    previousSessionId = id
    if (port && id && (firstBinding || hostChanged) && !sessionChanged) {
      if (port.sessionUi.get<string | undefined>('search-query', undefined) === undefined) {
        port.sessionUi.set('search-query', legacySearchQuery())
      }
      if (port.sessionUi.get<number | undefined>('search-index', undefined) === undefined) {
        port.sessionUi.set('search-index', legacySearchIndex())
      }
    }
  })

  // P52 D4：controller legacy 消息回退已退役——搜索命中只来自当前 Sheet 发布的
  // Workbench Host Port（canonical document）；无 Host Port 时无命中。
  const matches = createMemo(() => {
    const query = searchQuery()
    if (!query.trim() || !hostPort()) return []
    return (hostDocument()?.messages ?? []).filter(message => searchValuesMatchQuery([
      message.source.provider,
      message.content,
      message.parts,
    ], query))
  })
  const setSearchQuery = (value: string) => {
    setLegacySearchQuery(value)
    hostPort()?.sessionUi.set('search-query', value)
  }
  const setSearchIndex = (valueOrUpdater: number | ((previous: number) => number)) => {
    const next = typeof valueOrUpdater === 'function' ? valueOrUpdater(searchIndex()) : valueOrUpdater
    setLegacySearchIndex(next)
    hostPort()?.sessionUi.set('search-index', next)
  }
  const moveSearch = (direction: 1 | -1) => {
    if (matches().length === 0) return
    setSearchIndex(index => (index + direction + matches().length) % matches().length)
  }
  // I01-W3：touchedFiles 按 AgentContextKey（agentId+source）隔离读取。selector 不读
  // 组件局部响应式状态（solidStoreBridge ⚠️）：sessions 订阅在 store 侧，find 留在 memo。
  const touchedFilesRecord = createZustandSignal(useWorkspaceStore, s => s.touchedFiles)
  // CR-002：经订阅读 sessions（getState 不经订阅不响应变更）
  const identitySessions = createZustandSignal(useIdentityStore, s => s.sessions)
  const touchedFiles = createMemo(() => {
    const id = sessionId()
    const touchedSession = id ? identitySessions().find(item => item.id === id) : undefined
    const touchedSource = source()
    const touchedContext = touchedSession && touchedSource
      ? { agentId: touchedSession.agentId, source: touchedSource }
      : null
    return touchedContext ? touchedFilesRecord()[toAgentContextKey(touchedContext)] ?? [] : []
  })

  return (
    <div class="context-panel-contribution agent-context-panel">
      <div class="context-panel-subnav">
        <button type="button" aria-pressed={mode() === 'search'} class={`context-panel-mode ${mode() === 'search' ? 'active' : ''}`} onClick={() => setMode('search')}><LucideIcon name="Search" size={14} />搜索</button>
        <button type="button" aria-pressed={mode() === 'relations'} class={`context-panel-mode ${mode() === 'relations' ? 'active' : ''}`} onClick={() => setMode('relations')}><LucideIcon name="Files" size={14} />关联</button>
      </div>
      <Show when={mode() === 'search'}>
        <MessageSearchBar
          query={searchQuery()}
          matchIndex={searchIndex()}
          matchCount={matches().length}
          onQueryChange={setSearchQuery}
          onPrevious={() => moveSearch(-1)}
          onNext={() => moveSearch(1)}
          onClose={() => { setSearchQuery(''); setSearchIndex(0) }}
        />
      </Show>
      <Show when={mode() === 'search' && (!searchQuery().trim() || matches().length === 0)}>
        <div class="agent-context-empty flex flex-col items-start gap-3 p-4">
          <LucideIcon name="Search" size={24} strokeWidth={1.5} />
          <strong class="text-sm font-medium text-text">{searchQuery().trim() ? '没有匹配的消息' : '查找当前会话'}</strong>
          <p class="m-0 text-sm leading-relaxed text-text-dim">{searchQuery().trim() ? '尝试缩短关键词，或换一种表述。' : '输入关键词定位消息，使用 Enter / Shift+Enter 切换结果。'}</p>
        </div>
      </Show>
      <Show when={mode() === 'relations'}>
        <div class="agent-relations">
          <div class="file-section-title">关联文件</div>
          <Show when={touchedFiles().length === 0} fallback={
            <ul class="search-result-list">
              <For each={touchedFiles()}>{file => (
                <li>
                  <LucideIcon name="FileCode2" size={14} class="shrink-0 text-text-dim" />
                  <span class="search-result-path min-w-0 break-all font-[family-name:var(--mono)]">{file.path}</span>
                </li>
              )}</For>
            </ul>
          }>
            <div class="agent-context-empty flex flex-col items-start gap-3 p-4"><LucideIcon name="Files" size={24} strokeWidth={1.5} /><p class="m-0 text-sm leading-relaxed text-text-dim">agent 尚未改动文件</p></div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
