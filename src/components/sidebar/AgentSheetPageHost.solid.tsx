/** @jsxImportSource solid-js */
import { createMemo, onCleanup, onMount, Show } from 'solid-js'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { PluginContributionBody } from '../../plugin-runtime/ui/PluginContributionBody.solid.tsx'
import type { AgentSidebarSurfaceInput } from '../../plugin-runtime/sidebar/sidebarSurfaceProtocol.ts'
import type { AgentSheetPageHostProps } from './sidebarBridgeTypes.ts'
import {
  createAgentSidebarSharedProps,
  projectAgentSidebarSurfaceInput,
} from './useSidebarContributionProps.ts'

/**
 * 主区整页宿主：把声明了 `page` 的左栏区块内容展开成 AgentSheet 的整页。
 *
 * **不是新 Sheet**——它替换当前 Sheet 的聊天视图，左栏仍是该 Sheet 的左栏。
 * 页面渲染的是**同一个贡献组件**，只是 `presentation: 'page'`；因此「区块里的小样」
 * 与「整页」共享同一批会话/工作区数据与回调。
 *
 * 头部（返回 + 标题）由宿主渲染，贡献只画内容——与左栏区块外壳同一条约定。
 *
 * #520 S4-P1-4：贡献 props 接线恢复共享工厂 `createAgentSidebarSharedProps`
 * （与 `Sidebar.solid.tsx` 同源，#515 拆 Solid hook 时内联造成的 ~100 行逐字重复
 * 在此收口）；S4-P1-5：贡献体分发走 PluginContributionBody——wire 输入的 page 体量
 * 显式带 `query: ''`（漂移点参数化，见 projectAgentSidebarSurfaceInput）。
 */
export default function AgentSheetPageHost(props: AgentSheetPageHostProps) {
  const sharedSnapshot = createAgentSidebarSharedProps(props.ctx)

  const close = () => {
    // 整页是 Sheet 级状态，只写 activePageId；模块折叠在全局 store（issue #202），与此无关。
    useWorkspaceStore.getState().patchSheetState(props.sheet.id, { activePageId: null })
  }

  // Esc 关闭：整页是「临时离开聊天」，键盘用户需要一个不依赖指针的退路。
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  const pageDecl = createMemo(() => props.page.page)

  // isolated-surface 的 wire 输入投影（字段见 sidebarSurfaceProtocol，page 体量）。
  const surfaceInput = (): AgentSidebarSurfaceInput => projectAgentSidebarSurfaceInput(sharedSnapshot(), {
    presentation: 'page',
    collapsed: false,
    pageOpen: true,
    blockAction: null,
    query: '',
  })
  const onSurfaceEvent = (event: string, detail: unknown) => {
    const shared = sharedSnapshot()
    if (event === 'host:select-session' && typeof detail === 'string') shared.onSelectSession(detail)
    if (event === 'host:create-loose-session') shared.onCreateLooseSession()
    if (event === 'host:create-workspace-session' && typeof detail === 'string') shared.onCreateWorkspaceSession(detail)
    if (event === 'host:open-session-settings' && typeof detail === 'string') shared.onOpenSessionSettings(detail)
  }

  /** page 体量的贡献 props（体量覆盖 + 空动作注册；memo 供 JSX 展开保持细粒度响应）。 */
  const contributionProps = createMemo(() => ({
    ...sharedSnapshot(),
    presentation: 'page' as const,
    collapsed: false,
    onBlockAction: () => {},
    registerBlockActionHandler: () => {},
  }))

  return (
    <Show when={pageDecl()}>{decl => (
      <div class="main agent-sheet-page" data-page-id={props.page.id}>
        <div class="agent-sheet-page-head">
          <button type="button" class="agent-sheet-page-back" onClick={close} title="返回聊天" aria-label="返回聊天">
            <LucideIcon name="ArrowLeft" size={14} />
            <span>返回</span>
          </button>
          <h2 class="agent-sheet-page-title">{decl().title}</h2>
        </div>
        <div class="agent-sheet-page-body">
          {/* #515 岛退役：贡献体直连渲染——分发/边界/keyed 收进 PluginContributionBody
              （#520 S4-P1-5；keyed on 贡献对象：热替换/换贡献时边界（含错误态）整体重置）。 */}
          <PluginContributionBody
            contributionId={props.page.id}
            contribution={props.page}
            surfaceClass="agent-sheet-page-surface"
            surfaceInput={surfaceInput}
            onSurfaceEvent={onSurfaceEvent}
            componentProps={contributionProps}
          />
        </div>
      </div>
    )}</Show>
  )
}
