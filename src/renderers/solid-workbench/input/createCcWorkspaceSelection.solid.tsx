/**
 * createCcWorkspaceSelection — 空态工作区**绑定模型**（#520 S3-P0-2 自 ControlCenter 拆出；
 * #266 CC-27+28：选择器 UI 壳（空态工作区组件）随「已关闭的空态工作区控件」一并删除，
 * 本文件只留活着的模型——它承载的是**新会话链路的工作区绑定**，与界面无关）：
 * - **空态预选**：唯一工作区自动选中 / 多个按最近活跃预选 / 列表换成未知项时清空
 *   （不选工作区即创建无 cwd 会话，是合法意图）；
 * - **侧栏意图**：侧栏「在这个工作区下新建会话」派发的 window 广播 `pylon:new-session`
 *   （携带 `workspaceId`）优先于预选（会话创建前派发、选区随后被清，故在此缓存）。
 * 预选结果由 ControlCenter 的提交路径消费（`createSession` 的 `workspaceId` 实参）。
 *
 * 行为验收线 = `mountSolidWorkbench.solid.test.tsx` 三条用例（预选 / 最近活跃 / 意图缓存）。
 */
import { createEffect, createSignal, onCleanup, onMount, type Accessor } from 'solid-js'
import type { WorkbenchWorkspaceOption } from '../../../plugin-runtime/renderers/workbenchRendererFactory.ts'

export interface CcWorkspaceSelection {
  /** 生效的选中值（'' = 不使用工作区）。 */
  value(): string
  dispose(): void
}

export function createCcWorkspaceSelection(deps: {
  workspaces: Accessor<readonly WorkbenchWorkspaceOption[]>
  /** 错误通道（ControlCenter 的 submitError）：新会话意图到达时清掉旧错。 */
  onError: (message: string) => void
}): CcWorkspaceSelection {
  const [workspaceId, setWorkspaceId] = createSignal('')
  /** Workspace carried by Sidebar's create-session intent. The event is
   * intentionally cached because Sidebar clears the active session in the
   * same tick after dispatching it. */
  const [preferredWorkspaceId, setPreferredWorkspaceId] = createSignal('')

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

    // Chat mode may still opt into a workspace. Only repair a stale id or
    // choose an initial value when there is no user/sidebar intent in play
    // （壳删除后 touched 标记随「用户手选」入口一并退场；预选只在无意图时补位）。
    const recent = options.length
      ? options.reduce((a, b) => (b.lastActiveAt ?? 0) > (a.lastActiveAt ?? 0) ? b : a)
      : undefined
    const hasExplicitActivity = options.some(item => item.lastActiveAt !== undefined && item.lastActiveAt !== null)
    const next = options.length === 1
      ? options[0]!.id
      : hasExplicitActivity ? recent?.id ?? '' : ''
    if (current !== next) setWorkspaceId(next)
  })
  onMount(() => {
    // Sidebar 的「新会话」意图携带工作区 id；它到达时中控处于空态（会话尚未建好）。
    const onNewSession = (event: Event) => {
      const workspace = (event as CustomEvent<{ workspaceId?: unknown }>).detail?.workspaceId
      const id = typeof workspace === 'string' ? workspace.trim() : ''
      setPreferredWorkspaceId(id)
      setWorkspaceId(id)
      deps.onError('')
    }
    window.addEventListener('pylon:new-session', onNewSession)
    onCleanup(() => window.removeEventListener('pylon:new-session', onNewSession))
  })

  return {
    value: workspaceId,
    dispose: () => { /* 事件与 effect 都挂在 owner 上；留缝与模型接口对称。 */ },
  }
}
