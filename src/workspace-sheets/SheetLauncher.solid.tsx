/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'
import { LucideIcon } from '../components/LucideIcon.solid.tsx'
import { createDialogFocus } from '../components/ui/dialogFocus'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from '../plugin-runtime/workspaces/workspaceRegistry'
import { activateAgentSheet } from './activateAgentSheet'
import { resolveLaunchIconName } from './launchIcons.solid.tsx'
import type { SheetRecord, SheetKind } from './sheetTypes'

interface AgentOption {
  id: string
  name: string
}

export interface SheetLauncherProps {
  open: boolean
  agents: AgentOption[]
  sheets: SheetRecord[]
  onOpenChange: (open: boolean) => void
  onFocusSheet: (id: string) => void
  onOpenSheet: (kind: SheetKind | string, title: string, agentId?: string) => void
  onOpenSettings: () => void
  onOpenProfiles: () => void
}

interface LauncherItem {
  key: string
  title: string
  detail: string
  keywords: string
  icon?: string
  disabled?: boolean
  badge?: string
  open: () => void
}

interface LaunchGroup {
  label: string
  items: LauncherItem[]
  emptyAgentHint?: boolean
}

function LaunchIcon(props: { icon?: string }) {
  return <span class="sheet-launcher-icon" aria-hidden="true" data-launch-icon={props.icon || 'workspace'}><LucideIcon name={resolveLaunchIconName(props.icon)} size={18} strokeWidth={1.8} /></span>
}

/** Each opening owns its query, keyboard selection and pending navigation. */
export default function SheetLauncher(p: { latest: () => SheetLauncherProps }) {
  return <Show when={p.latest().open}><LauncherDialog latest={p.latest} /></Show>
}

function LauncherDialog(p: { latest: () => SheetLauncherProps }) {
  const [query, setQuery] = createSignal('')
  const needle = createMemo(() => query().trim().toLowerCase())
  const [preferredKey, setPreferredKey] = createSignal<string | null>(null)
  const [switchingAgentId, setSwitchingAgentId] = createSignal<string | null>(null)
  const [snapshot, setSnapshot] = createSignal(getWorkspaceRegistrySnapshot())
  onCleanup(subscribeWorkspaceRegistry(() => setSnapshot(getWorkspaceRegistrySnapshot())))

  let dialogRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  const listboxId = `sheet-launcher-${createUniqueId()}`
  const optionId = (key: string) => `${listboxId}-${encodeURIComponent(key)}`
  const close = () => p.latest().onOpenChange(false)
  createDialogFocus(() => dialogRef, () => true, close)

  let mounted = true
  onCleanup(() => { mounted = false })
  const openAgent = async (agentId: string, name: string, navigate: () => void) => {
    if (switchingAgentId() !== null) return
    setSwitchingAgentId(agentId)
    try {
      await activateAgentSheet(agentId, name, () => {
        if (mounted) {
          navigate()
          close()
        }
      })
    } finally {
      if (mounted) setSwitchingAgentId(null)
    }
  }
  const openAndClose = (action: () => void) => { action(); close() }

  // Search, pointer and keyboard use the same ordered option objects, including availability.
  const groups = createMemo<LaunchGroup[]>(() => {
    const { agents, sheets } = p.latest()
    const tools = snapshot().launchOptions
    const toolsByKind = new Map(tools.map(tool => [tool.kind, tool]))
    const openAgents = new Set(sheets.filter(sheet => sheet.kind === 'agent').map(sheet => sheet.agentId))
    const switching = switchingAgentId()
    const recent = [...sheets].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt).slice(0, 5)
    const sections: LaunchGroup[] = [
      {
        label: '最近打开',
        items: recent.map(sheet => {
          const agentId = sheet.kind === 'agent' ? sheet.agentId : undefined
          const focus = () => p.latest().onFocusSheet(sheet.id)
          return {
            key: `recent:${sheet.id}`, title: sheet.title, icon: sheet.kind === 'agent' ? 'agent' : toolsByKind.get(sheet.kind)?.icon,
            detail: '返回已打开的工作页', keywords: `recent ${sheet.kind}`, disabled: switching !== null,
            open: () => agentId ? void openAgent(agentId, agents.find(agent => agent.id === agentId)?.name || sheet.title || agentId, focus) : openAndClose(focus),
          }
        }),
      },
      {
        label: 'Agent', emptyAgentHint: agents.length === 0,
        items: agents.filter(agent => !openAgents.has(agent.id)).map(agent => ({
          key: `agent:${agent.id}`, title: agent.name, icon: 'agent', keywords: `agent ${agent.id}`,
          detail: switching === agent.id ? '正在连接…' : '连接并开始对话', disabled: switching !== null,
          open: () => void openAgent(agent.id, agent.name, () => p.latest().onOpenSheet('agent', agent.name, agent.id)),
        })),
      },
    ]
    const categories = new Map<string, LaunchGroup>()
    for (const tool of tools) {
      const key = tool.category || 'other'
      let group = categories.get(key)
      if (!group) {
        group = { label: tool.categoryLabel || '其他', items: [] }
        categories.set(key, group)
      }
      group.items.push({
        key: `tool:${tool.kind}`, title: tool.title, detail: tool.description, icon: tool.icon,
        keywords: `tool ${tool.kind} ${tool.categoryLabel || ''} ${(tool.keywords || []).join(' ')}`,
        disabled: !tool.launchable, badge: tool.launchable ? undefined : '暂不可用',
        open: () => openAndClose(() => p.latest().onOpenSheet(tool.kind, tool.title)),
      })
    }
    return [...sections, ...categories.values(), {
      label: '应用设置',
      items: [
        { key: 'manage:settings', title: '设置', detail: '主题、Agent 与应用设置', icon: 'settings', keywords: 'management settings theme agent 外观 偏好 配置 管理', open: () => openAndClose(p.latest().onOpenSettings) },
        { key: 'manage:profiles', title: '当前身份', detail: '编辑当前 Profile 的名称与偏好', icon: 'sliders', keywords: 'management profiles profile 档案 用户 配置 管理', open: () => openAndClose(p.latest().onOpenProfiles) },
      ],
    }]
  })

  const visibleGroups = createMemo(() => {
    const term = needle()
    return groups().map(group => ({
      ...group,
      items: term ? group.items.filter(item => `${item.title} ${item.detail} ${item.keywords}`.toLowerCase().includes(term)) : group.items,
    })).filter(group => group.items.length || (!term && group.emptyAgentHint))
  })
  const available = createMemo(() => visibleGroups().flatMap(group => group.items.filter(item => !item.disabled)))
  const active = createMemo(() => available().find(item => item.key === preferredKey()) ?? available()[0])

  // Keep the visible portion consistent with the active descendant after a new search.
  createEffect(() => {
    needle()
    setPreferredKey(null)
    listRef.scrollTop = 0
  })

  const onInputKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return
    const items = available()
    if (event.key === 'Enter') {
      event.preventDefault()
      active()?.open()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const next = items[(items.indexOf(active()!) + direction + items.length) % items.length]!
      setPreferredKey(next.key)
      dialogRef.ownerDocument.getElementById(optionId(next.key))?.scrollIntoView({ block: 'nearest' })
    }
  }

  return (
    <div class="sheet-launcher-overlay" onClick={event => { if (event.target === event.currentTarget) close() }}>
      <div ref={node => { dialogRef = node }} class="sheet-launcher-dialog" role="dialog" aria-modal="true" aria-label="打开 Sheet">
        <div class="sheet-launcher-input-row">
          <LaunchIcon icon="search" />
          <input
            cmdk-input="" role="combobox" aria-label="搜索 Sheet、Agent 或管理入口"
            aria-autocomplete="list" aria-expanded="true" aria-controls={listboxId}
            aria-activedescendant={active() ? optionId(active()!.key) : undefined}
            placeholder="搜索工作页、Agent 或设置…" value={query()}
            onInput={event => setQuery(event.currentTarget.value)} onKeyDown={onInputKeyDown}
          />
          <button type="button" class="sheet-launcher-close" aria-label="关闭启动器" title="关闭启动器 (Esc)" onClick={close}>
            <LucideIcon name="X" size={16} />
          </button>
        </div>
        <div ref={node => { listRef = node }} class="sheet-launcher-list">
          <div id={listboxId} cmdk-list="" role="listbox" aria-label="可打开的工作页面">
            <For each={visibleGroups()}>{group => (
              <div class="sheet-launcher-section" cmdk-group="" role="group" aria-label={group.label}>
                <div class="sheet-launcher-group-heading" cmdk-group-heading="" aria-hidden="true">{group.label}</div>
                <div class="grid min-w-0 gap-0.5" cmdk-group-items="">
                  <For each={group.items}>{item => (
                    <div
                      class="sheet-launcher-item" cmdk-item="" role="option" id={optionId(item.key)}
                      aria-disabled={item.disabled || undefined} data-disabled={item.disabled || undefined}
                      aria-selected={active()?.key === item.key} data-selected={active()?.key === item.key || undefined}
                      onPointerMove={event => { if (!item.disabled && event.pointerType !== 'touch') setPreferredKey(item.key) }}
                      onClick={() => { if (!item.disabled) item.open() }}
                    >
                      <LaunchIcon icon={item.icon} />
                      <span class="sheet-launcher-copy flex min-w-0 flex-1 flex-col">
                        <strong class="truncate font-semibold text-text">{item.title}</strong>
                        <small class="truncate text-text-dim">{item.detail}</small>
                      </span>
                      <Show when={item.badge}><span class="sheet-launcher-badge">{item.badge}</span></Show>
                    </div>
                  )}</For>
                  <Show when={group.emptyAgentHint && !needle()}>
                    <div class="sheet-launcher-agent-hint">
                      <LaunchIcon icon="agent" />
                      <span class="sheet-launcher-copy flex min-w-0 flex-col"><strong>还没有可用的 Agent</strong><small>在设置中新建 Agent 后，可在这里直接打开</small></span>
                    </div>
                  </Show>
                </div>
              </div>
            )}</For>
          </div>
          <Show when={visibleGroups().length === 0}>
            <div class="sheet-launcher-empty" cmdk-empty="" role="status">
              <LaunchIcon icon="search" />
              <strong>没有匹配项</strong>
              <span>试试工作页名称、Agent 名称或其他关键词。</span>
            </div>
          </Show>
        </div>
        <div class="sheet-launcher-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  )
}
