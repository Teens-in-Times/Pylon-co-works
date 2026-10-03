/** @jsxImportSource solid-js */
import { createEffect, createMemo, Show } from 'solid-js'
import { useReplayPostureStore } from '../domains/chat/replayPostureStore'
import AgentSheetPageHost from '../components/sidebar/AgentSheetPageHost.solid.tsx'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { getAgentSidebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import { normalizePageState, resolveOpenPage } from '../plugin-runtime/sidebar/sidebarBlockState.ts'
import { openResourceInFileSheet } from './file/fileSheetNavigation.ts'
import { createActiveInterfaceModeContribution, createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'
import { PluginContributionBody } from '../plugin-runtime/ui/PluginContributionBody.solid.tsx'
import AgentRendererSuiteWorkbench from './agent-workbench/AgentRendererSuiteWorkbench.solid.tsx'

// ---- #515 批7：整页宿主与隔离表面均已 Solid 实体化（批1-C/批3-E），React 岛退役，
// solid-in-solid 直连。IsolatedPluginSurface 的 props 面名字承自历史 React 契约，
// 本实体即唯一真源（className→class 由实体内部映射）。 ----

interface AgentSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/**
 * AgentSheetView — agent 主工作台（W1-03 侧栏上移后只留主区）。
 *
 * 侧栏已上移 SheetLayout（entry.sidebar → SheetSidebarSlot）；本组件只渲染主区
 * （Solid Renderer Suite + 右栏宿主），props 收敛为 { sheet, ctx }。
 * #515：实体自 React 版逐行为同构迁移——姿态 store 经 createZustandSignal，整页解析
 * 与界面模式投影经注册表信号；三分支（整页宿主/隔离表面/Renderer Suite）均 solid
 * 实体直连（批7：React 岛退役）。
 *
 * W4-02（姿态二拍板）：历史回放以「只读姿态」直接进入本 sheet——Solid Workbench
 * 经现成 lifecycle 恢复消息，但输入宿主隐藏，改渲染「只读回放 · 点击继续」占位条；
 * 点击 clear 姿态 → ControlCenter 出现 → 首次 send 即 live。姿态是一次性手势：
 * 离开该会话/关闭 sheet 即清除，防 tab 重开误回只读。
 */
export default function AgentSheetView(props: AgentSheetViewProps) {
  const postureSession = createZustandSignal(useReplayPostureStore, s => s.sessionId)
  const sidebarRegistry = getAgentSidebarRegistry()
  const sidebarSnapshot = createRegistrySignal(sidebarRegistry, () => sidebarRegistry.getSnapshot())
  // 左栏模块可以把自己的内容展开成「主区整页」——它**替换**聊天视图，但不开新 Sheet。
  // 这里只解析；解析在 memo 里（原实现刻意不在 hook 前早退，分支切换不改变订阅面）。
  const openPage = createMemo(() => resolveOpenPage(
    sidebarSnapshot().entries.map(entry => entry.value),
    normalizePageState(props.sheet.state),
  ))
  const contribution = createActiveInterfaceModeContribution()
  // 姿态只对进入时的会话生效（非 null 且匹配 activeSession）
  const isReplay = createMemo(() => props.ctx.activeSession !== null && postureSession() === props.ctx.activeSession)
  // 姿态是一次性手势：会话不匹配即清（原 useEffect [postureSession, ctx.activeSession]）。
  createEffect(() => {
    const posture = postureSession()
    const active = props.ctx.activeSession
    if (posture !== null && posture !== active) useReplayPostureStore.getState().clear()
  })

  const isolatedWorkbench = createMemo(() => {
    const workbench = contribution().workbench
    return workbench.renderKind === 'isolated-surface' ? workbench : null
  })
  const suiteRequest = createMemo(() => {
    const mode = contribution()
    return mode.workbench.renderKind === 'renderer-suite'
      ? mode.workbench.defaultSuiteId
      // Chat is Solid-only. Even host-mode contributions fall back to the built-in
      // Solid suite, so the chat area never mounts the legacy React chat renderer.
      : 'builtin.solid'
  })

  return (
    // 页面打开时聊天区整体不挂载（与切会话同一条路径：历史在返回时经 lifecycle 重读）。
    <Show when={openPage()} fallback={
      <Show when={isolatedWorkbench()} fallback={
        // 工作台分支：Solid 实体直连（实体内 ctx/sheet props 响应式透传，原岛重渲
        // 触发注释随 ReactIslandHost 一并退役——不再需要手写字段追踪）。
        <AgentRendererSuiteWorkbench
          sheet={props.sheet}
          ctx={props.ctx}
          modeId={contribution().id}
          defaultSuiteId={suiteRequest()}
          isReplay={isReplay()}
        />
      }>
        {workbench => (
          // #520 S4-P1-5：isolated workbench 挂载走 PluginContributionBody（分发 + 错误
          // 边界统一；此前此处是裸 IsolatedPluginSurface，崩溃会直接炸整张 Sheet）。
          <PluginContributionBody
            contributionId={contribution().id}
            contribution={workbench()}
            surfaceClass="main interface-mode-workbench-surface"
            surfaceInput={() => ({
              modeId: contribution().id,
              sheet: { id: props.sheet.id, kind: props.sheet.kind, title: props.sheet.title, agentId: props.sheet.agentId },
              activeSessionId: props.ctx.activeSession,
              sessionSource: props.ctx.activeSession ? props.ctx.sessionSource(props.ctx.activeSession) : undefined,
              isReplay: isReplay(),
            })}
            onSurfaceEvent={(event: string, detail: unknown) => {
              if (event === 'workbench:continue-replay') useReplayPostureStore.getState().clear()
              else if (event === 'workbench:select-session' && typeof detail === 'string') props.ctx.selectSession(detail)
              else if (event === 'workbench:open-profile') props.ctx.openProfileEdit()
              else if (event === 'workbench:open-session-settings' && typeof detail === 'string') props.ctx.openSessionSettings(detail)
              else if ((event === 'workbench:open-resource' || event === 'workbench:reveal-resource') && props.ctx.activeSession) {
                openResourceInFileSheet(props.ctx.activeSession, detail)
              }
              else if (event === 'workbench:open-sheet' && detail && typeof detail === 'object') {
                const input = detail as { kind?: unknown, title?: unknown, agentId?: unknown }
                if (typeof input.kind === 'string' && typeof input.title === 'string') {
                  props.ctx.openSheet({
                    kind: input.kind,
                    title: input.title,
                    ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}),
                  })
                }
              }
            }}
          />
        )}
      </Show>
    }>
      {page => (
        <AgentSheetPageHost page={page()} ctx={props.ctx} sheet={{ id: props.sheet.id }} />
      )}
    </Show>
  )
}
