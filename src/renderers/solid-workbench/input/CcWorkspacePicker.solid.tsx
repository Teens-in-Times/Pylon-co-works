/** @jsxImportSource solid-js */
/**
 * CcWorkspacePicker — 空态「选择 / 新建工作区」段（#520 S3-P0-2 自 ControlCenter 拆出）。
 *
 * 原 `workspace` 控件已从定义表移除（刀4），但它承载的空态工作区入口（含 cwd 绑定）
 * 是新会话链路的一部分，故改为**宿主渲染元素**：不占槽位、不进 ccLayout、
 * 不进编辑工具栏、不参与显隐与缩放。
 *
 * 状态与副作用住 `createCcWorkspaceSelection`（模型），本文件只留 UI 壳：
 * - 模型：选中值 + 侧栏「新会话」意图缓存 + 选过与否的标记 + 新建草稿 + 创建 IO；
 *   以及三条既有行为——工作区自动择一 effect、原生 select 的 DOM 修复 effect、
 *   `pylon:workspace-folder-picked` / `pylon:new-session` 两个 window 事件。
 * - 组件：select + 新建按钮 + 草稿气泡（名称输入 / 路径 / 创建）。
 *
 * ⚠ 04b：空态选择器由 `SHOW_EMPTY_WORKSPACE_CONTROL` 门隐藏（用户 2026-09-19 拍板
 * 「先隐藏」），但模型照常创建——`pylon:new-session` 携带的工作区意图即使选择器
 * 隐藏也要进 `createSession`（ControlCenter 的提交路径消费它）。
 */
import { createEffect, createSignal, onCleanup, onMount, type Accessor } from 'solid-js'
import { For, Show } from 'solid-js'
import { errorMessage } from '../../../infrastructure/tauri/errorPayload.ts'
import type { WorkbenchWorkspaceOption } from '../../../plugin-runtime/renderers/workbenchRendererFactory.ts'

/** 04b：置 true 即恢复空态工作区选择器显示（选择器实现与它的命令全部保留）。 */
export const SHOW_EMPTY_WORKSPACE_CONTROL = false

export interface CcWorkspaceSelection {
  /** 生效的选中值（'' = 不使用工作区）。 */
  value(): string
  /** 用户在 select 里改选（含宿主侧 select.value 修复后的回写）。 */
  choose(id: string): void
  /** select 元素注册（ref 回调；DOM 修复 effect 只修它）。 */
  registerSelect(node: HTMLSelectElement | undefined): void
  /** 新建草稿（undefined = 无在途草稿）。 */
  draft(): { name: string; path: string } | undefined
  editDraft(next: { name: string; path: string }): void
  /** 请求宿主开目录选择器（结果经 `pylon:workspace-folder-picked` 回来）。 */
  pickFolder(): void
  /** 创建工作区：成功即选中并清草稿；失败经 `onError` 上报。 */
  create(): Promise<void>
  dispose(): void
}

export function createCcWorkspaceSelection(deps: {
  workspaces: Accessor<readonly WorkbenchWorkspaceOption[]>
  /** 创建 IO（createCcSources 聚合的 workspace 实体 store 入口）。 */
  createWorkspace: (name: string, rootPath: string) => Promise<{ id: string }>
  /** 错误通道（ControlCenter 的 submitError）：成功清错也走它（传 ''）。 */
  onError: (message: string) => void
}): CcWorkspaceSelection {
  const [workspaceId, setWorkspaceId] = createSignal('')
  /** Workspace carried by Sidebar's create-session intent. The event is
   * intentionally cached because Sidebar clears the active session in the
   * same tick after dispatching it. */
  const [preferredWorkspaceId, setPreferredWorkspaceId] = createSignal('')
  const [workspaceSelectionTouched, setWorkspaceSelectionTouched] = createSignal(false)
  const [workspaceDraft, setWorkspaceDraft] = createSignal<{ name: string; path: string }>()
  let workspaceSelect: HTMLSelectElement | undefined
  let workspaceSyncRevision = 0

  createEffect(() => {
    const options = deps.workspaces()
    const current = workspaceId()
    const preferred = preferredWorkspaceId()
    const valid = (id: string) => Boolean(id) && options.some(item => item.id === id)

    // A workspace intent from the sidebar has priority over the generic
    // "most recently active" heuristic, but only for this empty-state entry.
    if (valid(preferred)) {
      if (current !== preferred) setWorkspaceId(preferred)
      return
    }
    if (current && valid(current)) return

    // Chat mode may still opt into a workspace. Never erase a user choice just
    // because the mode is chat; only repair a stale id or choose an initial
    // value when the user has not touched the selector.
    if (workspaceSelectionTouched()) {
      if (current && !valid(current)) setWorkspaceId('')
      return
    }

    const recent = options.length
      ? options.reduce((a, b) => (b.lastActiveAt ?? 0) > (a.lastActiveAt ?? 0) ? b : a)
      : undefined
    const hasExplicitActivity = options.some(item => item.lastActiveAt !== undefined && item.lastActiveAt !== null)
    const next = options.length === 1
      ? options[0]!.id
      : hasExplicitActivity ? recent?.id ?? '' : ''
    if (current !== next) setWorkspaceId(next)
  })
  // Reconcile the native select after its <option> children have been
  // reconciled. Browsers reset select.value to the empty option when a keyed
  // option list is replaced, even though the Solid signal did not change.
  // Keeping this as a DOM-boundary repair preserves the signal as the source
  // of truth without stealing a user's explicit selection.
  createEffect(() => {
    const desired = workspaceId()
    const options = deps.workspaces()
    const revision = ++workspaceSyncRevision
    queueMicrotask(() => {
      if (revision !== workspaceSyncRevision) return
      const select = workspaceSelect
      if (!select) return
      const valid = desired === '' || options.some(item => item.id === desired)
      if (valid && select.value !== desired) select.value = desired
    })
  })
  onMount(() => {
    const onFolderPicked = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (path) setWorkspaceDraft({ name: path.split(/[\\/]/).filter(Boolean).at(-1) || '新工作区', path })
    }
    // Sidebar 的「新会话」意图携带工作区 id；空态工作区控件是宿主渲染元素
    // （刀4 后 `workspace` 控件已不在名单里，见 emptyWorkspaceControl）。
    const onNewSession = (event: Event) => {
      const workspace = (event as CustomEvent<{ workspaceId?: unknown }>).detail?.workspaceId
      const id = typeof workspace === 'string' ? workspace.trim() : ''
      setPreferredWorkspaceId(id)
      setWorkspaceSelectionTouched(false)
      setWorkspaceId(id)
      setWorkspaceDraft()
      deps.onError('')
    }
    window.addEventListener('pylon:workspace-folder-picked', onFolderPicked)
    window.addEventListener('pylon:new-session', onNewSession)
    onCleanup(() => {
      window.removeEventListener('pylon:workspace-folder-picked', onFolderPicked)
      window.removeEventListener('pylon:new-session', onNewSession)
    })
  })

  return {
    value: workspaceId,
    choose: id => {
      setWorkspaceSelectionTouched(true)
      setPreferredWorkspaceId(id)
      setWorkspaceId(id)
    },
    registerSelect: node => { workspaceSelect = node },
    draft: workspaceDraft,
    editDraft: next => setWorkspaceDraft(next),
    pickFolder: () => window.dispatchEvent(new CustomEvent('pylon:pick-workspace-folder')),
    create: async () => {
      const draft = workspaceDraft(); if (!draft?.name.trim() || !draft.path) return
      try {
        const workspace = await deps.createWorkspace(draft.name.trim(), draft.path)
        setWorkspaceId(workspace.id)
        setPreferredWorkspaceId(workspace.id)
        setWorkspaceSelectionTouched(true)
        setWorkspaceDraft()
        deps.onError('')
      }
      catch (error) { deps.onError(errorMessage(error, '创建工作区失败')) }
    },
    dispose: () => { /* 事件与 effect 都挂在 owner 上；留缝与模型接口对称。 */ },
  }
}

export function CcWorkspacePicker(props: {
  selection: CcWorkspaceSelection
  workspaces: Accessor<readonly WorkbenchWorkspaceOption[]>
  disabled?: boolean
}) {
  return (
    <div class="cc-empty-workspace-control">
      <label class="cc-empty-workspace-select">
        <span aria-hidden="true">▣</span>
        <select
          ref={node => { props.selection.registerSelect(node) }}
          aria-label="新会话工作区"
          disabled={props.disabled || props.workspaces().length === 0}
          value={props.selection.value()}
          onInput={event => props.selection.choose(event.currentTarget.value)}
          onChange={event => props.selection.choose(event.currentTarget.value)}
        >
          <option value="" selected={props.selection.value() === ''}>不使用工作区</option>
          <For each={props.workspaces()}>{item => (
            <option value={item.id} selected={item.id === props.selection.value()}>{item.label} · {item.path}</option>
          )}</For>
        </select>
      </label>
      <button type="button" class="cc-empty-workspace-create" disabled={props.disabled} onClick={props.selection.pickFolder} aria-label="新建工作区">＋</button>
      <Show when={props.selection.draft()}>{draft => <div class="cc-empty-workspace-popover">
        <input aria-label="新工作区名称" disabled={props.disabled} value={draft().name} onInput={event => props.selection.editDraft({ ...draft(), name: event.currentTarget.value })} />
        <code title={draft().path}>{draft().path}</code>
        <button type="button" disabled={props.disabled} onClick={() => void props.selection.create()}>创建</button>
      </div>}</Show>
    </div>
  )
}
