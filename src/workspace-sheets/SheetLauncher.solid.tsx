/** @jsxImportSource solid-js */
import { createDialogFocus } from '../components/ui/dialogFocus'
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show, untrack } from 'solid-js'
import { resolveLaunchIconName } from './launchIcons.solid.tsx'
import { LucideIcon } from '../components/LucideIcon.solid.tsx'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from '../plugin-runtime/workspaces/workspaceRegistry'
import { activateAgentSheet } from './activateAgentSheet'
import type { SheetRecord, SheetKind } from './sheetTypes'
import type { WorkspaceLaunchOption } from '../plugin-runtime/workspaces/workspaceTypes'

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

const LAUNCH_ICON_SIZE = 20

function LaunchIcon(props: { icon?: string }) {
  return <span class="sheet-launcher-icon" data-launch-icon={props.icon || 'workspace'}><LucideIcon name={resolveLaunchIconName(props.icon)} size={LAUNCH_ICON_SIZE} strokeWidth={1.8} /></span>
}

interface LaunchGroup {
  key: string
  label: string
  options: WorkspaceLaunchOption[]
}

/** 扁平可见项（键盘环选顺序 = 渲染顺序）。 */
interface LauncherItem {
  key: string
  disabled: boolean
  onSelect: () => void
}

/**
 * SheetLauncher — Sheet 启动命令面板（#279 第 3 梯队 Solid 化实体）。
 *
 * 原实现基于 cmdk（React 生态）；本实体按其**可见行为契约**手写：
 * 过滤 = 索引串大小写不敏感子串匹配、不匹配项从 DOM 移除、
 * 组内全隐藏则整组隐藏、全空显示 Empty；DOM 携带 App.css 消费的 cmdk 属性词汇
 * （[cmdk-input]/[cmdk-group-heading]/[cmdk-group-items]/[cmdk-item] + data-selected/
 * data-disabled）。键盘 ↑↓ 循环选区、Enter 选中、Esc/遮罩点击关闭。
 *
 * 索引串 = **所有可搜字段的并集**：条目标题 + 描述 + 种类 + 注册处声明的 `keywords`。
 * 描述是中文而条目标题多为英文，故必须并入索引，否则中文界面下搜索不可达
 * （#327）；`keywords` 承载注册处声明的中英双语同义词。
 */
export default function SheetLauncher(p: { latest: () => SheetLauncherProps }) {
  const value = p.latest
  const latest = () => untrack(value)

  const [query, setQuery] = createSignal('')
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null)
  const switchingAgentRef = { current: false }
  const [switchingAgentId, setSwitchingAgentId] = createSignal<string | null>(null)

  // Registry 快照 → 工具项（与 React 版 useSyncExternalStore 同语义：订阅写信号，
  // 快照引用等值去重。审查 P2-1 修正：memo 无响应式依赖只会求值一次，订阅回调读
  // memo 是 no-op——launcher 打开期间的插件注册/重载不会反映）
  const [workspaceSnapshot, setWorkspaceSnapshot] = createSignal(getWorkspaceRegistrySnapshot())
  onCleanup(subscribeWorkspaceRegistry(() => setWorkspaceSnapshot(getWorkspaceRegistrySnapshot())))

  const matches = (itemValue: string) => {
    const needle = query().trim().toLowerCase()
    return !needle || itemValue.toLowerCase().includes(needle)
  }

  const closeThen = (action: () => void) => {
    action()
    latest().onOpenChange(false)
  }

  const focusSheet = async (sheet: SheetRecord) => {
    const targetAgentId = sheet.kind === 'agent' ? sheet.agentId : undefined
    if (!targetAgentId) {
      latest().onFocusSheet(sheet.id)
      latest().onOpenChange(false)
      return
    }
    if (switchingAgentRef.current) return
    switchingAgentRef.current = true
    setSwitchingAgentId(targetAgentId)
    const agentName = value().agents.find(agent => agent.id === targetAgentId)?.name || sheet.title || targetAgentId
    const activated = await activateAgentSheet(targetAgentId, agentName, () => latest().onFocusSheet(sheet.id))
    switchingAgentRef.current = false
    setSwitchingAgentId(null)
    if (activated) latest().onOpenChange(false)
  }

  const openAgentSheet = async (agent: AgentOption) => {
    if (switchingAgentRef.current) return
    switchingAgentRef.current = true
    setSwitchingAgentId(agent.id)
    const activated = await activateAgentSheet(agent.id, agent.name, () => latest().onOpenSheet('agent', agent.name, agent.id))
    switchingAgentRef.current = false
    setSwitchingAgentId(null)
    if (activated) latest().onOpenChange(false)
  }

  const tools = createMemo(() => workspaceSnapshot().launchOptions)
  const launchGroups = createMemo(() => {
    const groups = new Map<string, LaunchGroup>()
    for (const tool of tools()) {
      const key = tool.category || 'other'
      const group = groups.get(key) ?? { key, label: tool.categoryLabel || '其他', options: [] }
      group.options.push(tool)
      groups.set(key, group)
    }
    return [...groups.values()]
  })
  const launchByKind = createMemo(() => new Map(tools().map(tool => [tool.kind, tool])))
  const openAgentIds = createMemo(() => new Set(value().sheets.filter(sheet => sheet.kind === 'agent').map(sheet => sheet.agentId)))
  const agentsToOpen = createMemo(() => value().agents.filter(agent => !openAgentIds().has(agent.id)))
  const recentSheets = createMemo(() => [...value().sheets].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt).slice(0, 5))

  const recentVisible = createMemo(() => recentSheets().filter(sheet => matches(`recent ${sheet.title} ${sheet.kind}`)))
  const agentsVisible = createMemo(() => agentsToOpen().filter(agent => matches(`agent ${agent.name} ${agent.id}`)))
  const groupsVisible = createMemo(() => launchGroups()
    .map(group => ({
      ...group,
      options: group.options.filter(tool => matches(`tool ${tool.title} ${tool.description} ${tool.kind} ${tool.categoryLabel || ''} ${(tool.keywords || []).join(' ')}`)),
    }))
    .filter(group => group.options.length > 0))
  // 管理入口是宿主自有卡片（非插件贡献），中英双语检索词直接写进索引串。
  const settingsVisible = createMemo(() => matches('management settings theme agent 设置 主题 外观 偏好 配置 管理'))
  const profilesVisible = createMemo(() => matches('management profiles profile 档案 身份 用户 配置 管理'))

  // Agent 组的两套空态文案：真无 Agent（引导去设置新建）与查询无命中（提示换词）
  // 语义不同，不能共用一句。
  const agentsFallback = createMemo(() => value().agents.length === 0
    ? { title: '还没有可用的 Agent', detail: '在设置中新建 Agent 后，可在这里直接打开' }
    : { title: '没有匹配的 Agent', detail: '换个关键词试试' })

  // 扁平可见项（键盘环选顺序 = 渲染顺序）；查询变化后选区归首项
  const flatItems = createMemo<LauncherItem[]>(() => [
    ...recentVisible().map(sheet => ({
      key: `recent:${sheet.id}`,
      disabled: switchingAgentId() !== null,
      onSelect: () => { void focusSheet(sheet) },
    })),
    ...agentsVisible().map(agent => ({
      key: `agent:${agent.id}`,
      disabled: switchingAgentId() !== null,
      onSelect: () => { void openAgentSheet(agent) },
    })),
    ...groupsVisible().flatMap(group => group.options.map(tool => ({
      key: `tool:${tool.kind}`,
      disabled: !tool.launchable,
      onSelect: () => closeThen(() => latest().onOpenSheet(tool.kind, tool.title)),
    }))),
    ...(settingsVisible() ? [{ key: 'manage:settings', disabled: false, onSelect: () => closeThen(latest().onOpenSettings) }] : []),
    ...(profilesVisible() ? [{ key: 'manage:profiles', disabled: false, onSelect: () => closeThen(latest().onOpenProfiles) }] : []),
  ])

  // 打开时清空查询；键盘焦点由共享 dialogFocus 管理。
  // 依赖面必须只含 open（memo 引用等值去重）：体内读了 flatItems()（经 memo 链依赖
  // query），若被追踪则「输入 → 效果重跑 → setQuery('') 自我清零」——其余一律 untrack。
  const launcherOpen = createMemo(() => value().open === true)
  createEffect(() => {
    if (!launcherOpen()) return
    untrack(() => {
      setQuery('')
      setSelectedKey(flatItems()[0]?.key ?? null)
    })
  })

  createEffect(() => {
    query()
    setSelectedKey(flatItems()[0]?.key ?? null)
  })

  let dialogRef: HTMLDivElement | undefined
  createDialogFocus(() => dialogRef, launcherOpen, () => latest().onOpenChange(false))

  const onInputKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const items = flatItems()
      if (items.length === 0) return
      const current = items.findIndex(item => item.key === selectedKey())
      const next = event.key === 'ArrowDown'
        ? (current < 0 ? 0 : (current + 1) % items.length)
        : (current <= 0 ? items.length - 1 : current - 1)
      setSelectedKey(items[next]!.key)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = flatItems().find(candidate => candidate.key === selectedKey())
      if (item && !item.disabled) item.onSelect()
    }
  }

  const listboxId = `sheet-launcher-${createUniqueId()}`
  const optionId = (key: string) => `${listboxId}-${encodeURIComponent(key)}`
  const selectedAttr = (key: string) => selectedKey() === key ? 'true' : undefined
  const disabledAttr = (disabled: boolean) => disabled ? 'true' : undefined

  return (
    <Show when={value().open}>
      <div class="sheet-launcher-overlay" onClick={event => { if (event.target === event.currentTarget) latest().onOpenChange(false) }}>
        <div ref={node => { dialogRef = node }} class="sheet-launcher-dialog" role="dialog" aria-modal="true" aria-label="打开 Sheet">
          <div class="sheet-launcher-input-row">
            <LaunchIcon icon="search" />
            <input
              cmdk-input=""
              role="combobox"
              aria-label="搜索 Sheet、Agent 或管理入口"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={selectedKey() ? optionId(selectedKey()!) : undefined}
              placeholder="搜索工作页、Agent 或设置…"
              value={query()}
              onInput={event => setQuery(event.currentTarget.value)}
              onKeyDown={onInputKeyDown}
            />
            <kbd>Esc</kbd>
          </div>
          <div id={listboxId} class="sheet-launcher-list" cmdk-list="" role="listbox" aria-label="可打开的工作页面">
            <Show when={flatItems().length === 0}>
              <div class="sheet-launcher-empty" cmdk-empty="">没有匹配项</div>
            </Show>

            <Show when={recentVisible().length > 0}>
              <div class="sheet-launcher-section sheet-launcher-recent" cmdk-group="">
                <div class="sheet-launcher-group-heading" cmdk-group-heading="">最近打开</div>
                <div class="sheet-launcher-group-items" cmdk-group-items="">
                  <For each={recentVisible()}>{sheet => (
                    <div
                      class="sheet-launcher-item"
                      cmdk-item=""
                      role="option"
                      aria-disabled={disabledAttr(switchingAgentId() !== null)}
                      data-disabled={disabledAttr(switchingAgentId() !== null)}
                      id={optionId(`recent:${sheet.id}`)} aria-selected={selectedKey() === `recent:${sheet.id}`} data-selected={selectedAttr(`recent:${sheet.id}`)}
                      onClick={() => { if (switchingAgentId() === null) void focusSheet(sheet) }}
                    >
                      <LaunchIcon icon={sheet.kind === 'agent' ? 'agent' : launchByKind().get(sheet.kind)?.icon} />
                      <span class="sheet-launcher-copy">
                        <span class="sheet-launcher-card-title"><strong>{sheet.title}</strong></span>
                        <small>返回已打开的工作页</small>
                      </span>
                    </div>
                  )}</For>
                </div>
              </div>
            </Show>

            <Show when={agentsToOpen().length > 0 || value().agents.length === 0}>
              <div class="sheet-launcher-section" cmdk-group="">
                <div class="sheet-launcher-group-heading" cmdk-group-heading="">Agent</div>
                <div class="sheet-launcher-group-items" cmdk-group-items="">
                  <Show when={agentsVisible().length > 0} fallback={
                    <div class="sheet-launcher-item" cmdk-item="" role="option" aria-disabled="true" data-disabled="true">
                      <LaunchIcon icon="agent" />
                      <span class="sheet-launcher-copy">
                        <strong>{agentsFallback().title}</strong>
                        <small>{agentsFallback().detail}</small>
                      </span>
                    </div>
                  }>
                    <For each={agentsVisible()}>{agent => (
                      <div
                        class="sheet-launcher-item"
                        cmdk-item=""
                        role="option"
                        aria-disabled={disabledAttr(switchingAgentId() !== null)}
                        data-disabled={disabledAttr(switchingAgentId() !== null)}
                        id={optionId(`agent:${agent.id}`)} aria-selected={selectedKey() === `agent:${agent.id}`} data-selected={selectedAttr(`agent:${agent.id}`)}
                        onClick={() => { if (switchingAgentId() === null) void openAgentSheet(agent) }}
                      >
                        <LaunchIcon icon="agent" />
                        <span class="sheet-launcher-copy">
                          <span class="sheet-launcher-card-title"><strong>{agent.name}</strong></span>
                          <small>{switchingAgentId() === agent.id ? '正在连接…' : '连接并开始对话'}</small>
                        </span>
                      </div>
                    )}</For>
                  </Show>
                </div>
              </div>
            </Show>

            <For each={groupsVisible()}>{group => (
              <div class="sheet-launcher-section" cmdk-group="">
                <div class="sheet-launcher-group-heading" cmdk-group-heading="">{group.label}</div>
                <div class="sheet-launcher-group-items" cmdk-group-items="">
                  <For each={group.options}>{tool => (
                    <div
                      class="sheet-launcher-item"
                      cmdk-item=""
                      role="option"
                      aria-disabled={disabledAttr(!tool.launchable)}
                      data-disabled={disabledAttr(!tool.launchable)}
                      id={optionId(`tool:${tool.kind}`)} aria-selected={selectedKey() === `tool:${tool.kind}`} data-selected={selectedAttr(`tool:${tool.kind}`)}
                      onClick={() => { if (tool.launchable) closeThen(() => latest().onOpenSheet(tool.kind, tool.title)) }}
                    >
                      <LaunchIcon icon={tool.icon} />
                      <span class="sheet-launcher-copy">
                        <span class="sheet-launcher-card-title"><strong>{tool.title}</strong></span>
                        <small>{tool.description}</small>
                      </span>
                      <Show when={!tool.launchable}><span class="sheet-launcher-badge">暂不可用</span></Show>
                    </div>
                  )}</For>
                </div>
              </div>
            )}</For>

            <Show when={settingsVisible() || profilesVisible()}>
              <div class="sheet-launcher-section sheet-launcher-management" cmdk-group="">
                <div class="sheet-launcher-group-heading" cmdk-group-heading="">应用设置</div>
                <div class="sheet-launcher-group-items" cmdk-group-items="">
                  <Show when={settingsVisible()}>
                    <div class="sheet-launcher-item" cmdk-item="" role="option" id={optionId('manage:settings')} aria-selected={selectedKey() === 'manage:settings'} data-selected={selectedAttr('manage:settings')} onClick={() => closeThen(latest().onOpenSettings)}>
                      <LaunchIcon icon="settings" />
                      <span class="sheet-launcher-copy"><span class="sheet-launcher-card-title"><strong>设置</strong></span><small>主题、Agent 与应用设置</small></span>
                    </div>
                  </Show>
                  <Show when={profilesVisible()}>
                    <div class="sheet-launcher-item" cmdk-item="" role="option" id={optionId('manage:profiles')} aria-selected={selectedKey() === 'manage:profiles'} data-selected={selectedAttr('manage:profiles')} onClick={() => closeThen(latest().onOpenProfiles)}>
                      <LaunchIcon icon="sliders" />
                      <span class="sheet-launcher-copy"><span class="sheet-launcher-card-title"><strong>当前身份</strong></span><small>编辑当前 Profile 的名称与偏好</small></span>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>
          </div>
          <div class="sheet-launcher-footer">
            <span><kbd>↑↓</kbd> 选择</span>
            <span><kbd>Enter</kbd> 打开</span>
            <span>中文与英文关键词均可搜索</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
