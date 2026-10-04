// @vitest-environment jsdom
// #515：AgentSheetPageHost 测试的 Solid 版（断言集与 React 版逐一对应，未缩减）。
// 改写点登记：
// - 组件 render 用 `@solidjs/testing-library`（传函数）；
// - 注册表贡献组件为 Solid 面（#515 岛退役）：PresentationProbe 用 Solid JSX 构造。
// （原「整页解析回落」两条例证经 useOpenSidebarPage 渲染探针，随该 hook 于 #520
//   死代码二批退役一并删除。）
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentSheetPageHost from '../sidebar/AgentSheetPageHost.solid.tsx'
import { resetStores } from '../../test/resetStores'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import type { AgentSidebarContribution, AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

const ctx = {
  openSheet: () => null,
  focusSheet: () => {},
  closeSheet: () => {},
  activeSession: null,
  selectSession: () => {},
  openProfileEdit: () => {},
  openSessionSettings: () => {},
  sidebarCollapsed: false,
  rightInset: 0,
  sessionSource: () => null,
  sessionBySource: () => undefined,
} as SheetContext

const SHEET_ID = 'sheet-page'

let identitySeq = 0
const disposals: Array<{ dispose(): void | Promise<void> }> = []

function register(contribution: Partial<AgentSidebarContribution> & { id: string }) {
  const registry = getAgentSidebarRegistry()
  identitySeq += 1
  disposals.push(registry.register(createPluginIdentity('test.page-host', `run-${identitySeq}`), {
    label: contribution.id,
    renderKind: 'first-party-solid',
    component: () => null,
    ...contribution,
  } as AgentSidebarContribution))
}

/** 观察贡献拿到的 presentation——「区块小样 / 主区整页」是同一组件两种体量。 */
function PresentationProbe(props: Partial<AgentSidebarContributionProps>) {
  return <div data-testid="probe">{props.presentation}</div>
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
  useIdentityStore.setState({
    activeAgent: 'peri',
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: 'Default', persona: '', model: '' }],
    sessions: [],
  })
})

afterEach(() => {
  cleanup()
  while (disposals.length > 0) void disposals.pop()!.dispose()
})

describe('AgentSheet 主区整页宿主', () => {
  it('渲染页面标题与内容，并以 presentation=page 交给同一个贡献组件', async () => {
    register({ id: 'scheduled', label: '定时', page: { title: '定时任务' }, component: PresentationProbe })
    render(() => <AgentSheetPageHost page={getAgentSidebarRegistry().list()[0]} ctx={ctx} sheet={{ id: SHEET_ID }} />)

    expect(screen.getByRole('heading', { name: '定时任务' })).toBeInTheDocument()
    // Solid 实体直连后挂载是同步的（无 React 并发调度，Suspense 下也没有异步 resource）：
    // probe 同帧就在 DOM 里，用同步断言钉住这一契约。
    expect(screen.getByTestId('probe')).toHaveTextContent('page')
  })

  it('「返回」只清整页状态（折叠已迁出为全局偏好，与 Sheet 级整页互不牵挂，issue #202）', () => {
    const patchSheetState = vi.fn()
    useWorkspaceStore.setState({ patchSheetState })
    register({ id: 'scheduled', label: '定时', page: { title: '定时任务' }, component: PresentationProbe })
    render(() => <AgentSheetPageHost page={getAgentSidebarRegistry().list()[0]} ctx={ctx} sheet={{ id: SHEET_ID }} />)

    fireEvent.click(screen.getByRole('button', { name: '返回聊天' }))
    expect(patchSheetState).toHaveBeenCalledWith(SHEET_ID, { activePageId: null })
  })

  it('Esc 也能关闭整页（键盘用户的退路）', () => {
    const patchSheetState = vi.fn()
    useWorkspaceStore.setState({ patchSheetState })
    register({ id: 'scheduled', label: '定时', page: { title: '定时任务' }, component: PresentationProbe })
    render(() => <AgentSheetPageHost page={getAgentSidebarRegistry().list()[0]} ctx={ctx} sheet={{ id: SHEET_ID }} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(patchSheetState).toHaveBeenCalledWith(SHEET_ID, { activePageId: null })
  })
})
