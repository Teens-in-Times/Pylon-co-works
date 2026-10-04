/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { open } from '@tauri-apps/plugin-dialog'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import { formatTime } from '../../utils/relativeTime'
import { isAbsolutePath, type Workspace } from '../../domains/workspace/workspaceEntities'
import { useModalOverlayStore } from '../../app/modalOverlayStore'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'
import { resolveSessionDisplayName } from '../../domains/identity/identityStore.ts'

// #515 批7：CwdSettingsPanel 已是 Solid 实体（settings 批）——React 岛退役，直连实体。
import CwdSettingsPanel from '../settings/CwdSettingsPanel.solid.tsx'

function workspaceNameFromPath(rootPath: string): string {
  const withoutTrailingSeparators = rootPath.replace(/[\\/]+$/, '')
  const finalSegment = withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return finalSegment.replace(/:$/, '') || '新工作区'
}

const WORKSPACE_TREE_STATE_KEY = 'pylon-workspace-tree:v1'

/** 无 cwd 会话分组的伪 id，与真实工作区 id 共用一个折叠集合。 */
const LOOSE_GROUP_ID = '__loose__'
const LOOSE_GROUP_LABEL = '无工作区'

function loadCollapsedWorkspaces(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_TREE_STATE_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

/** 工作区设置弹窗体：#515 批7 起 CwdSettingsPanel 为 Solid 实体，直连渲染。 */
function CwdSettingsDialogBody(props: { workspace: Workspace; onClose: () => void }) {
  return <CwdSettingsPanel workspace={props.workspace} onClose={props.onClose} showHeader={false} />
}

/**
 * 会话区块。一个区块同时承载两个族群，按 cwd 分组：
 * 挂在工作区上的会话归各自工作区组，没有工作区的（旧模型的「聊天」）落在**最底部的
 * 无 cwd 组**。
 *
 * 排版按「一行一条」收敛：组头是单行的 `文件夹 + 名称`（目录路径降级为 tooltip，
 * 不再占一行 9.5px 的不可读小字）；会话行也是单行 `名称 + 右对齐时间`，不再两行堆叠。
 * 组内不再渲染「暂无会话」提示——空组本身已经说明了这件事，逐组提示只贡献高度。
 *
 * 本组件**不画区块头**——标题、折叠钮、头部动作都由宿主渲染（见 `Sidebar.tsx`）。
 */
export default function SessionsPanel(props: AgentSidebarContributionProps) {
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const [renameValue, setRenameValue] = createSignal('')
  const [newCwdName, setNewCwdName] = createSignal('')
  const [newCwdRoot, setNewCwdRoot] = createSignal('')
  const [cwdError, setCwdError] = createSignal<string | null>(null)
  const [showNewCwd, setShowNewCwd] = createSignal(false)
  const [pickingCwd, setPickingCwd] = createSignal(false)
  const [collapsedCwd, setCollapsedCwd] = createSignal<Set<string>>(loadCollapsedWorkspaces())
  const [editingCwdId, setEditingCwdId] = createSignal<string | null>(null)

  createEffect(() => {
    const collapsed = collapsedCwd()
    try {
      localStorage.setItem(WORKSPACE_TREE_STATE_KEY, JSON.stringify([...collapsed]))
    } catch {
      // 展开状态属于易失 UI 偏好，存储不可用时保持当前会话可用。
    }
  })

  const pickWorkspaceDirectory = async () => {
    setPickingCwd(true)
    setCwdError(null)
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择工作区文件夹',
      })
      if (typeof selected !== 'string') return
      setNewCwdRoot(selected)
      setNewCwdName(workspaceNameFromPath(selected))
      setShowNewCwd(true)
    } catch {
      setShowNewCwd(true)
      setCwdError('无法打开文件夹选择器，请重试')
    } finally {
      setPickingCwd(false)
    }
  }

  // 区块头的「工作区」按钮由宿主渲染，语义在这里——只有本组件知道要弹目录选择器。
  // useBlockActionHandler 的 Solid 形态（原 React hook 已随 #515 删除）：最新处理器走
  // 可变变量，挂载期注册、卸载期注销，避免每次重挂注册出现「点了没反应」的窗口。
  let blockActionHandler: (actionId: string) => void = () => {}
  onMount(() => {
    props.registerBlockActionHandler(actionId => blockActionHandler(actionId))
    onCleanup(() => props.registerBlockActionHandler(null))
  })
  blockActionHandler = actionId => {
    if (actionId === 'new-workspace') void pickWorkspaceDirectory()
  }

  const createWorkspace = async () => {
    const name = newCwdName().trim()
    const root = newCwdRoot().trim()
    if (!name) { setCwdError('请输入工作区名称'); return }
    if (!root || !isAbsolutePath(root)) { setCwdError('工作目录必须是绝对路径'); return }
    setCwdError(null)
    try {
      await props.onCreateWorkspace(name, root)
      setNewCwdName('')
      setNewCwdRoot('')
      setShowNewCwd(false)
    } catch (error) {
      setCwdError(error instanceof Error ? error.message : '创建工作区失败')
    }
  }

  const cancelCreateWorkspace = () => {
    setShowNewCwd(false)
    setNewCwdName('')
    setNewCwdRoot('')
    setCwdError(null)
  }

  const toggleCwd = (groupId: string) => setCollapsedCwd(previous => {
    const next = new Set(previous)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    return next
  })

  const editingWorkspace = createMemo(() => props.workspaces.find(workspace => workspace.id === editingCwdId()))
  // #309：工作区设置弹窗是覆盖主区的模态层——打开期间让原生子视图暂时隐藏。
  createEffect(() => {
    const veilOpen = Boolean(editingWorkspace())
    useModalOverlayStore.getState().setOverlayOpen('workspace-settings', veilOpen)
    onCleanup(() => useModalOverlayStore.getState().setOverlayOpen('workspace-settings', false))
  })
  // 手写 Dialog 的 Escape 退路（radix 原行为：无论焦点在哪，Esc 都关闭）。
  createEffect(() => {
    if (!editingWorkspace()) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setEditingCwdId(null) }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  // 会话列表**不再被搜索过滤**：搜索已是独立模块、自己呈现结果（一个查询驱动两处呈现
  // 会让人分不清哪边是「结果」）。这里只负责分组与选择。
  // (#260-C10) 一次遍历完成「按工作区分组 + 无工作区组」，组内保持 props.sessions
  // 原序——与旧的 loose filter + 每工作区一次全量 filter 逐条等价，O(会话+工作区)。
  const grouping = createMemo(() => {
    const byWorkspace = new Map<string, WorkspaceSession[]>()
    const loose: WorkspaceSession[] = []
    for (const session of props.sessions) {
      if (session.workspaceId) {
        const group = byWorkspace.get(session.workspaceId)
        if (group) group.push(session)
        else byWorkspace.set(session.workspaceId, [session])
      } else {
        loose.push(session)
      }
    }
    return { byWorkspace, loose }
  })
  const liveGenerating = createMemo(() => new Set(props.liveGeneratingSources))

  const hasAnything = () => props.workspaces.length > 0 || grouping().loose.length > 0

  /**
   * 会话行：`[置顶] 名称 … ● 时间 / 设置`。
   *
   * 两个按钮**平时不可见**，悬停/聚焦才显形（与组头动作同一手法：opacity + visibility
   * 同步门控，未显形时不参与命中测试）。用户点名过「四个按钮常驻会把名字挤成 sessio…」，
   * 也点名过现在这两个按钮「完全不见了」——所以除了显形门控，还给了足够的对比度
   * （旧写法叠了 `opacity:.62` 与 `--text-dim`，等于两层压暗）。
   *
   * 置顶图标占的是**工作区图标那一列**（15px 槽），会话名因此与工作区名同列——见 CSS。
   */
  const renderSession = (session: WorkspaceSession) => {
    const pinned = () => session.pinned === true
    // #393：显示名与存储名分口径——Agent 标题优先，用户改过名则恒用 `name`。
    const displayName = () => resolveSessionDisplayName(session)
    return (
      <div role="treeitem" tabIndex={0} class={`session-item ${props.activeSessionId === session.id ? 'active' : ''}`}
        data-pinned={pinned() ? 'true' : undefined}
        onClick={() => props.onSelectSession(session.id)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onSelectSession(session.id) }
          // 改名输入框预填**当前显示名**（用户看到什么就改什么）；提交后 name 即新名、
          // 并置 renamedByUser，显示从此不再被 Agent 标题顶替。
          if (event.key === 'F2') { event.preventDefault(); setRenaming(session.id); setRenameValue(displayName()) }
        }}
        onDblClick={event => { event.stopPropagation(); setRenaming(session.id); setRenameValue(displayName()) }}>
        <button
          type="button"
          class="session-pin"
          aria-pressed={pinned()}
          title={pinned() ? '取消置顶' : '置顶会话（移到本工作区最前）'}
          aria-label={pinned() ? `取消置顶 ${displayName()}` : `置顶 ${displayName()}`}
          onClick={event => { event.stopPropagation(); props.onToggleSessionPin?.(session.id) }}
        >
          <Show when={pinned()} fallback={<LucideIcon name="Pin" size={12} />}><LucideIcon name="PinOff" size={12} /></Show>
        </button>
        <Show when={renaming() === session.id} fallback={<span class="session-name">{displayName()}</span>}>
          <input class="session-rename-input" value={renameValue()} ref={element => element.focus()}
            onInput={event => setRenameValue(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && renameValue().trim()) { props.onRenameSession(session.id, renameValue().trim()); setRenaming(null) }
              if (event.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => setRenaming(null)} onClick={event => event.stopPropagation()} />
        </Show>
        {/* 运行指示点跟着时间走（不再占名字左边的列）：那一列让位给置顶图标，
            名字才能与工作区名对齐。 */}
        <span class="session-dot" data-running={liveGenerating().has(session.source) ? 'true' : undefined} />
        {/* 时间与设置钮共用一个流内格子：默认只显示时间，悬停/聚焦时按钮淡入顶替。 */}
        <span class="session-tail">
          <span class="session-meta">{formatTime(session.lastReplyAt || session.lastActiveAt || session.createdAt)}</span>
          <span class="session-actions">
            <button class="session-action" onClick={event => { event.stopPropagation(); props.onOpenSessionSettings(session.id) }} title="会话设置（重命名 / 归档 / 导出）" aria-label={session.name + " 会话设置"}><LucideIcon name="Settings" size={13} /></button>
          </span>
        </span>
      </div>
    )
  }

  const renderGroupHead = (
    groupId: string,
    label: string,
    rootPath: string,
    icon: 'folder' | 'inbox',
    onAdd: () => void,
    onSettings?: () => void,
  ) => {
    const folded = () => collapsedCwd().has(groupId)
    return (
      <div class="cwd-group-head">
        {/* 折叠**没有**独立按钮：整个组头就是开关（用户要求去掉最左侧那个 `>`）。
            目录路径保留为 tooltip。 */}
        <button class="cwd-group-toggle" type="button" onClick={() => toggleCwd(groupId)} title={rootPath} aria-label={`${folded() ? '展开' : '折叠'} ${label}`} aria-expanded={!folded()}>
          <span class="cwd-group-folder" aria-hidden="true">
            <Show when={icon === 'inbox'} fallback={
              <Show when={folded()} fallback={<LucideIcon name="FolderOpen" size={15} />}><LucideIcon name="Folder" size={15} /></Show>
            }><LucideIcon name="Inbox" size={15} /></Show>
          </span>
          <span class="cwd-group-name">{label}</span>
        </button>
        <div class="cwd-group-meta">
          <span class="cwd-group-actions">
            <button class="cwd-group-add" onClick={event => { event.stopPropagation(); onAdd() }} title={`在 ${label} 中新建会话`} aria-label={`在 ${label} 中新建会话`}><LucideIcon name="Plus" size={13} /></button>
            <Show when={onSettings}>
              <button class="cwd-group-add cwd-group-settings" onClick={event => { event.stopPropagation(); onSettings?.() }} title={`${label} 工作区设置`} aria-label={`${label} 工作区设置`}><LucideIcon name="Settings" size={13} /></button>
            </Show>
          </span>
        </div>
      </div>
    )
  }

  const renderGroup = (groupId: string, sessions: () => readonly WorkspaceSession[], head: JSX.Element) => {
    const folded = () => collapsedCwd().has(groupId)
    return (
      <div class="cwd-group" role="treeitem" aria-expanded={!folded()}>
        {head}
        {/* 空组不渲染会话容器：它自带 1px/2px 内边距，展开态比折叠态高几像素，
            于是「点空工作区的折叠/展开」会引起一次细微跳动（用户实机报的）。 */}
        <Show when={sessions().length > 0}>
          <div class={`cwd-group-sessions${folded() ? ' is-collapsed' : ''}`} role="group" aria-hidden={folded()}>
            <div class="cwd-group-sessions-inner"><For each={sessions()}>{renderSession}</For></div>
          </div>
        </Show>
      </div>
    )
  }

  return (
    <>
      <div class="session-list" role="tree" aria-label="工作区与会话">
        <Show when={showNewCwd()}>
          <div class="cwd-new">
            <input class="cwd-new-input" aria-label="工作区名称" placeholder="工作区名称" value={newCwdName()} onInput={event => setNewCwdName(event.currentTarget.value)} />
            <div class="cwd-new-directory">
              <span class="cwd-new-directory-path" title={newCwdRoot()}>{newCwdRoot() || '尚未选择文件夹'}</span>
              <button class="settings-action" type="button" disabled={pickingCwd()} onClick={() => void pickWorkspaceDirectory()} aria-label="重新选择工作区文件夹">更换…</button>
            </div>
            <Show when={cwdError()}><div class="set-hint" role="alert">{cwdError()}</div></Show>
            <div class="cwd-new-actions">
              <button class="settings-action primary" type="button" onClick={() => void createWorkspace()}>创建</button>
              <button class="settings-action" type="button" onClick={cancelCreateWorkspace}>取消</button>
            </div>
          </div>
        </Show>

        <For each={props.workspaces}>{workspace => renderGroup(
          workspace.id,
          () => grouping().byWorkspace.get(workspace.id) ?? [],
          renderGroupHead(
            workspace.id, workspace.name, workspace.rootPath, 'folder',
            () => props.onCreateWorkspaceSession(workspace.id),
            () => setEditingCwdId(workspace.id),
          ),
        )}</For>

        <Show when={hasAnything()}>
          {renderGroup(
            LOOSE_GROUP_ID,
            () => grouping().loose,
            renderGroupHead(
              LOOSE_GROUP_ID, LOOSE_GROUP_LABEL, '未绑定目录的会话', 'inbox',
              () => props.onCreateLooseSession(),
            ),
          )}
        </Show>

        <Show when={!hasAnything()}>
          <div class="workspace-empty">
            <LucideIcon name="Folder" size={24} />
            <strong>从一个文件夹开始</strong>
            <span>工作区会把项目与它的 Agent 会话放在一起。</span>
            <button type="button" class="settings-action primary" disabled={pickingCwd()} onClick={() => void pickWorkspaceDirectory()}>选择文件夹</button>
          </div>
        </Show>
      </div>
      {/* 手写 Dialog 最小等价（#515 §3）：Portal 到 body、遮罩点击/Esc 关闭，
          role=dialog + aria-modal + aria-describedby（aria-label="工作区设置"）。 */}
      <Show when={editingWorkspace()}>{workspace => (
        <Portal>
          <div class="dialog-overlay" onClick={() => setEditingCwdId(null)} />
          <div
            class="dialog-content settings-surface agent-settings-dialog cwd-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="工作区设置"
            aria-describedby="cwd-settings-description"
          >
            <header class="session-settings-header settings-dialog-header">
              <div>
                <h3 class="settings-dialog-title">工作区设置</h3>
                <p id="cwd-settings-description" class="settings-dialog-description">管理工作区目录、能力与默认上下文。</p>
              </div>
              <button type="button" class="modal-close settings-dialog-close" aria-label="关闭工作区设置" onClick={() => setEditingCwdId(null)}><LucideIcon name="X" size={16} /></button>
            </header>
            <div class="cwd-settings-dialog-identity">
              <LucideIcon name="FolderOpen" size={16} />
              <strong>{workspace().name}</strong>
              <span title={workspace().rootPath}>{workspace().rootPath}</span>
            </div>
            <CwdSettingsDialogBody workspace={workspace()} onClose={() => setEditingCwdId(null)} />
          </div>
        </Portal>
      )}</Show>
    </>
  )
}
