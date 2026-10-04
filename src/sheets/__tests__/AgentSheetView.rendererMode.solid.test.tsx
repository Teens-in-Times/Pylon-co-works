// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 AgentSheetView.rendererMode.test.tsx，React RTL → Solid；36 用例断言集不缩减）：
// 1. RTL 导入改 @solidjs/testing-library；render(() => <X/>) 传函数；显式 afterEach(cleanup)。
// 2. 「从空态选择 mock 会话并重入」三连 rerender（无会话→有→无→有）→ 卸载重挂（语义等价：
//    solid 实体以 props 响应，实例边界由 mount 决定；快照恢复/清除/再恢复断言逐条保留）。
// 3. 「切换 Session 只 update」「候选 prepare 期间旧实例 namespace」「update fatal 原地重建」
//    三处 view.rerender(ctx 换引用) → 信号驱动 ctx（createSignal + JSX 内 ctx={liveCtx()}，
//    renderAgentSheetViewReactive）：断言依赖同一实例收到 update 而非 remount，
//    mounts/prepareCount/destroyed 计数逐条保留。
// 4. 「Interface Mode 切换复用 Host」的 rerender 与 setState 后 props 完全相同，仅用于强制
//    flush；Solid 无此 API——store 信号直接传播，节点同一性断言（toBe(firstSolid)）保留。
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { resetStores } from '../../test/resetStores.ts'
import AgentSheetView from '../AgentSheetView.solid.tsx'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { activateBuiltinPlugin, getPackageInstallationService, getPluginRuntime } from '../../plugin-runtime/pluginCompositionRoot.ts'
import { getPluginEventBus, getPresentationProfileRegistry, getRendererRegistry, getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { useIdentityStore, type Session } from '../../domains/identity/identityStore.ts'
import type { WorkbenchRendererFactory, WorkbenchRendererInstance } from '../../renderers/solid-workbench/workbenchContracts.ts'
import type { BuiltinPluginDefinition } from '../../plugin-runtime/pluginRuntime.ts'
import { normalizeRawEvent } from '../../domains/events/canonicalNormalizer.ts'
import { publishPluginEvent as publishCanonicalPluginEvent } from '../../infrastructure/events/pluginEventBusHost.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore.ts'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import { clearErrors, getErrors } from '../../app/errorCenter.ts'
import { messageStorageKey, persistMessageSnapshot } from '../../domains/chat/messagePersistence.ts'
import { FakeInvoke } from '../../test/fakeInvoke'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve undefined（对齐原内联 mock `vi.fn(async () => undefined)` 的宽松路径） */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

let fakeInvoke: TolerantFakeInvoke
const invokeLog: string[] = []

/**
 * Production publishes CanonicalConversationEvent through the compatibility
 * API. A few projector-focused integration fixtures intentionally inject an
 * already-normalized Workbench envelope, which the session runtime also
 * accepts during migration; keep that test-only path on the untyped bus.
 */
function publishPluginEvent(event: Parameters<typeof publishCanonicalPluginEvent>[0] | WorkbenchEventEnvelope): void {
  if ('owner' in event) publishCanonicalPluginEvent(event)
  else void getPluginEventBus().publish('canonical.conversation', event)
}

function suitePlugin(pluginId: string, label: string, failPrepare = false, destroy = () => {}): BuiltinPluginDefinition {
  return {
    id: pluginId,
    kind: 'renderer',
    hotSwapMode: 'parallel',
    activate: ({ renderer }) => {
      renderer.registerSuite({
        id: `${pluginId}.suite`, label, apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            if (failPrepare) throw new Error(`${label} prepare failed`)
            return { mount(container) {
              container.replaceChildren(Object.assign(document.createElement('div'), { textContent: label }))
              return { update() {}, pause() {}, resume() {}, destroy, on(event, listener) { if (event === 'ready') listener({}); return () => {} } }
            } }
          },
        },
      })
    },
  }
}

beforeAll(async () => {
  await activateBuiltinPlugin('builtin.pylon-renderers')
})

afterAll(async () => {
  const active = getPluginRuntime().snapshot().active.find(item => item.pluginId === 'builtin.pylon-renderers')
  if (active) await getPluginRuntime().deactivate(active.key)
})

const ctx: SheetContext = {
  openSheet: () => 'x', focusSheet() {}, closeSheet() {},
  activeSession: 'session-1', selectSession() {},
  openProfileEdit() {}, openSessionSettings() {},
  sidebarCollapsed: false, rightInset: 0,
  sessionSource: () => 'local:s1', sessionBySource: () => undefined,
}

function sheet(state: unknown): SheetRecord {
  return {
    id: 'agent-sheet', kind: 'agent', title: 'Peri', agentId: 'peri',
    createdAt: 1, lastFocusedAt: 1, state,
  }
}

afterEach(() => cleanup())

/**
 * #515 改写点：RTL `view.rerender(<AgentSheetView ctx={新引用}/>)` 的 Solid 等价——
 * ctx 存进 signal，翻转时 JSX 的 `ctx={liveCtx()}` 产出新引用；AgentSheetView 与
 * AgentRendererSuiteWorkbench 在 createMemo/effect/JSX 里逐层读 props.ctx，getter
 * 重估即把新 mount input 以 instance.update() 推给现行 Suite（不 remount），与
 * React 版「同一实例内 props 变化」语义对齐。
 */
function renderAgentSheetViewReactive(initialCtx: SheetContext) {
  const [liveCtx, setLiveCtx] = createSignal(initialCtx)
  const view = render(() => <AgentSheetView sheet={sheet({})} ctx={liveCtx()} />)
  return { ...view, rerenderCtx: (next: SheetContext) => setLiveCtx(next) }
}

function session(id: string, source: string): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '',
    sessionPrompt: '', skills: [], hooks: [], autoName: '',
  }
}

function planSlotSummary(payload: unknown): string {
  const value = payload as {
    entries?: readonly { id?: unknown; blockedReason?: unknown }[]
    goal?: { objective?: unknown; accounting?: { timeUsedSeconds?: unknown } }
  }
  const entry = value.entries?.[0]
  return `plan slot: ${String(entry?.id)} / ${String(entry?.blockedReason)} / ${String(value.goal?.objective)} / ${String(value.goal?.accounting?.timeUsedSeconds)}`
}

function systemErrorSlotSummary(payload: unknown): string {
  const value = payload as { userSummary?: unknown; recoverability?: unknown }
  return `system error slot: ${String(value.userSummary)} / ${String(value.recoverability)}`
}

describe('AgentSheetView renderer mode context', () => {
  beforeEach(() => {
    fakeInvoke = new TolerantFakeInvoke()
    invokeLog.length = 0
    invokeRef.current = (cmd, args) => {
      invokeLog.push(cmd)
      return fakeInvoke.invoke(cmd, args)
    }
    resetStores()
    clearErrors()
  })

  it('从空态选择浏览器 mock 会话并重入时恢复消息且保留快照', async () => {
    const mock = session('mock-from-empty', 'local:mock-from-empty')
    useWorkspaceStore.setState({ workspaceSheets: { ...useWorkspaceStore.getState().workspaceSheets, activeSheetId: 'agent-sheet' } })
    useIdentityStore.setState({ sessions: [mock], sessionsHydrated: true })
    persistMessageSnapshot(mock.id, [{ id: 'mock-recovery-body', role: 'assistant', sender: 'peri', content: 'mock 从空态恢复的正文', time: '12:00' }], localStorage)
    // #515：React 版以 rerender 三连（无会话→有→无→有）推同一实例的 props 变化；Solid 侧
    // 按登记规则改卸载重挂——实例边界由 mount 决定，恢复/清除/再恢复断言逐条保留。
    const first = render(() => <AgentSheetView sheet={sheet({})} ctx={{ ...ctx, activeSession: null }} />)
    await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
    expect(screen.queryByText('mock 从空态恢复的正文')).toBeNull()

    first.unmount()
    const second = render(() => <AgentSheetView sheet={sheet({})} ctx={{ ...ctx, activeSession: mock.id, sessionSource: () => mock.source }} />)
    expect(await screen.findByText('mock 从空态恢复的正文')).toBeVisible()
    expect(localStorage.getItem(messageStorageKey(mock.id))).toContain('mock 从空态恢复的正文')

    second.unmount()
    const third = render(() => <AgentSheetView sheet={sheet({})} ctx={{ ...ctx, activeSession: null }} />)
    await waitFor(() => expect(screen.queryByText('mock 从空态恢复的正文')).toBeNull())
    third.unmount()
    render(() => <AgentSheetView sheet={sheet({})} ctx={{ ...ctx, activeSession: mock.id, sessionSource: () => mock.source }} />)
    expect(await screen.findByText('mock 从空态恢复的正文')).toBeVisible()
  })

  it('默认 Interface Mode 经 Renderer Suite Host 挂载内置 Solid Workbench', async () => {
    const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)

    expect(await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })).toHaveAttribute('data-renderer', 'solid')
    expect(container.querySelector('[data-pylon-workbench="modern-gui"]')).toBeNull()
  })

  it('内置 Solid Suite 在生产 Registry 注册并消费 C00–C08 base Slot', async () => {
    const baseSlot = getRendererRegistry().snapshot().rendererSlots.find(entry => entry.value.id === 'builtin.solid.content.base')
    expect(baseSlot?.value).toMatchObject({
      targetSuites: ['builtin.solid'],
      fallback: true,
      kinds: expect.arrayContaining([
        'content.text', 'content.reasoning', 'content.file-reference', 'content.document', 'content.image', 'content.plan',
        'lifecycle.retry', 'system.notice', 'system.error',
      ]),
    })

    useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
    useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
    const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
    await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
    publishPluginEvent(normalizeRawEvent(
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'base slot answer' } } },
      { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
    ).event)

    expect(await screen.findByText('base slot answer')).toBeInTheDocument()
    expect(container.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()
  })

  it('C04 canonical read snapshot reaches the C05 specialized tool.read Slot settings without remount', async () => {
    const settings = getRendererSettingsStore()
    settings.reset()
    settings.setOverride('kind.tool.read.defaultCollapsed', false)
    settings.setOverride('kind.tool.read.maxHeight', 180)
    settings.setOverride('kind.tool.read.showMetadata', true)
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(normalizeRawEvent(
        {
          update: {
            sessionUpdate: 'tool_call', toolCallId: 'tool-production-c04', title: '读取文件',
            rawInput: { path: '/workspace/production.ts' },
            _meta: { pylon: { toolName: 'read_file' } },
          },
        },
        { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
      ).event)

      const card = await screen.findByRole('status', { name: '工具：读取文件，运行中' })
      expect(card).toHaveTextContent('/workspace/production.ts')
      expect(card.closest('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()
      expect(card.querySelector('.solid-tool-metadata')).toHaveTextContent('canonical: read_file')
      expect(card.querySelector('.term-tool-body')).toHaveStyle({ maxHeight: '180px' })

      settings.setOverride('kind.tool.read.maxHeight', 260)
      settings.setOverride('kind.tool.read.showMetadata', false)

      await waitFor(() => {
        expect(card.querySelector('.term-tool-body')).toHaveStyle({ maxHeight: '260px' })
        expect(card.querySelector('.solid-tool-metadata')).toBeNull()
      })
      expect(screen.getByRole('status', { name: '工具：读取文件，运行中' })).toBe(card)
      expect(container.querySelector('.solid-workbench-activity')).toBeNull()
    } finally {
      settings.reset()
    }
  })

  it('targeted tool.generic Slot receives typed snapshot and owner cleanup restores C04 base Slot', async () => {
    const destroyed = vi.fn()
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-tool-slot', 'runtime'),
      {
        id: 'test.production-tool-slot.generic', targetSuites: ['builtin.solid'],
        kinds: ['tool.generic'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'tool.generic',
        createSurface: () => ({
          rendererId: 'test.production-tool-slot', kind: 'solid',
          mount(container, snapshot) {
            const value = snapshot.payload as { id?: unknown; name?: unknown; input?: { path?: unknown } }
            const node = document.createElement('div')
            node.dataset.productionToolSlot = 'true'
            node.textContent = `tool overlay: ${String(value.id)} / ${String(value.name)} / ${String(value.input?.path)}`
            container.append(node)
            return node
          },
          update(handle, snapshot) {
            const value = snapshot.payload as { id?: unknown; name?: unknown; input?: { path?: unknown } }
            ;(handle as HTMLElement).textContent = `tool overlay: ${String(value.id)} / ${String(value.name)} / ${String(value.input?.path)}`
          },
          destroy(handle) { destroyed(handle); (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(normalizeRawEvent(
        {
          update: {
            sessionUpdate: 'tool_call', toolCallId: 'tool-overlay-c04', name: 'FutureTool',
            title: '未来工具', rawInput: { path: '/workspace/future.data' },
          },
        },
        { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
      ).event)

      expect(await screen.findByText('tool overlay: tool-overlay-c04 / FutureTool / /workspace/future.data')).toBeInTheDocument()
      await registration.dispose()

      await waitFor(() => expect(container.querySelector('[data-production-tool-slot="true"]')).toBeNull())
      const fallbackCard = await screen.findByRole('status', { name: '工具：未来工具，运行中' })
      const fallbackHead = fallbackCard.querySelector<HTMLButtonElement>('.term-tool-head')!
      expect(fallbackHead).toHaveAttribute('aria-expanded', 'false')
      expect(fallbackCard).not.toHaveTextContent('/workspace/future.data')
      fireEvent.click(fallbackHead)
      expect(fallbackCard).toHaveTextContent('/workspace/future.data')
      expect(container.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()
      expect(destroyed).toHaveBeenCalled()
      const handles = destroyed.mock.calls.map(call => call[0])
      expect(new Set(handles).size).toBe(handles.length)
    } finally {
      await registration.dispose()
    }
  })

  it('C05 search content and semantic tool kinds reach the production base Slot with hot settings', async () => {
    const baseSlot = getRendererRegistry().snapshot().rendererSlots.find(entry => entry.value.id === 'builtin.solid.content.base')
    expect(baseSlot?.value.kinds).toEqual(expect.arrayContaining([
      'content.search-result', 'content.link', 'tool.read', 'tool.search', 'tool.fetch',
    ]))
    const settings = getRendererSettingsStore()
    settings.reset()
    settings.setOverride('kind.content.search-result.defaultExpanded', true)
    settings.setOverride('kind.content.search-result.pageSize', 1)
    settings.setOverride('kind.content.search-result.pathDisplay', 'basename')
    settings.setOverride('kind.content.search-result.maxWidth', 420)
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'hermes', sourceId: 'search-settings' }, identity: { messageId: 'message-search-settings' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'message.delta', role: 'assistant', parts: [{
          kind: 'search-result', query: 'renderer', total: 2, results: [
            { source: '/workspace/src/app.tsx', rank: 1, snippet: 'first' },
            { source: '/workspace/src/host.ts', rank: 2, snippet: 'second' },
          ],
        }] },
      }))

      const card = await waitFor(() => {
        const node = container.querySelector<HTMLElement>('[data-content-kind="content.search-result"] .term-search-results')
        expect(node?.style.maxWidth).toBe('420px')
        expect(node?.textContent).toContain('app.tsx')
        expect(node?.textContent).not.toContain('/workspace/src/app.tsx')
        expect(node?.querySelectorAll('.term-search-item')).toHaveLength(1)
        return node!
      })
      expect(card.closest('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()

      settings.setOverride('kind.content.search-result.pageSize', 2)
      settings.setOverride('kind.content.search-result.pathDisplay', 'full')
      settings.setOverride('kind.content.search-result.maxWidth', 680)
      await waitFor(() => {
        expect(card.style.maxWidth).toBe('680px')
        expect(card.textContent).toContain('/workspace/src/app.tsx')
        expect(card.querySelectorAll('.term-search-item')).toHaveLength(2)
      })
      expect(container.querySelector('[data-content-kind="content.search-result"] .term-search-results')).toBe(card)

      publishPluginEvent(normalizeRawEvent(
        { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-search-c05', title: '搜索代码', _meta: { pylon: { toolName: 'grep' } }, rawInput: { query: 'renderer' } } },
        { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 2, receivedAt: '2026-08-22T00:00:02.000Z' },
      ).event)
      expect(await screen.findByRole('status', { name: '工具：搜索代码，运行中' })).toHaveAttribute('data-content-kind', 'tool.search')
    } finally {
      settings.reset()
    }
  })

  it('targeted content.link Slot owner cleanup restores the C05 base Slot', async () => {
    const destroyed = vi.fn()
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-link-slot', 'runtime'),
      {
        id: 'test.production-link-slot.content', targetSuites: ['builtin.solid'],
        kinds: ['content.link'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'content.link',
        createSurface: () => ({
          rendererId: 'test.production-link-slot', kind: 'solid',
          mount(container, snapshot) {
            const node = document.createElement('div')
            node.dataset.productionLinkSlot = 'true'
            node.textContent = `link overlay: ${String((snapshot.payload as { url?: unknown }).url)}`
            container.append(node)
            return node
          },
          update(handle, snapshot) { ;(handle as HTMLElement).textContent = `link overlay: ${String((snapshot.payload as { url?: unknown }).url)}` },
          destroy(handle) { destroyed(handle); (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'hermes', sourceId: 'link-overlay' }, identity: { messageId: 'message-link-overlay' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'link', url: 'https://example.com/guide', title: 'Guide' }] },
      }))

      expect(await screen.findByText('link overlay: https://example.com/guide')).toBeInTheDocument()
      await registration.dispose()
      await waitFor(() => expect(container.querySelector('[data-production-link-slot="true"]')).toBeNull())
      expect(await screen.findByText('Guide')).toBeInTheDocument()
      expect(container.querySelector('[data-content-kind="content.link"] .term-link-card')).not.toBeNull()
      expect(container.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()
      expect(destroyed).toHaveBeenCalled()
    } finally {
      await registration.dispose()
    }
  })

  it('C00 kind 设置经共享 store 与 Host Port 实时作用于生产 content Slot', async () => {
    const settings = getRendererSettingsStore()
    settings.reset()
    settings.setOverride('kind.content.text.fontSize', 22)
    useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
    useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
    const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
    await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
    publishPluginEvent(normalizeRawEvent(
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'configured content' } } },
      { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
    ).event)

    const configured = await waitFor(() => {
      const node = container.querySelector<HTMLElement>('[data-content-kind="content.text"]')
      expect(node).not.toBeNull()
      expect(node!.style.fontSize).toBe('22px')
      return node!
    })
    settings.setOverride('kind.content.text.fontSize', 18)
    await waitFor(() => expect(configured.style.fontSize).toBe('18px'))
    expect(container.querySelector('[data-content-kind="content.text"]')).toBe(configured)
    settings.reset()
  })

  it('生产 content Slot 遵循 kind default < Profile < user < session preview', async () => {
    const profile = getPresentationProfileRegistry().register(
      createPluginIdentity('test.c00-profile', 'runtime'),
      {
        id: 'test.c00-profile', label: 'C00 profile', family: 'custom', tokens: {},
        kindTokens: { 'content.text': { fontSize: 16 } },
      },
    )
    const settings = getRendererSettingsStore()
    try {
      settings.reset()
      settings.setSessionPreview({})
      usePresentationPreferenceStore.setState({ activeProfileId: 'test.c00-profile' })
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(normalizeRawEvent(
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'profile content' } } },
        { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
      ).event)
      const node = await waitFor(() => {
        const value = container.querySelector<HTMLElement>('[data-content-kind="content.text"]')
        expect(value?.style.fontSize).toBe('16px')
        return value!
      })
      settings.setOverride('kind.content.text.fontSize', 18)
      await waitFor(() => expect(node.style.fontSize).toBe('18px'))
      settings.setSessionPreview({ 'kind.content.text.fontSize': 20 })
      await waitFor(() => expect(node.style.fontSize).toBe('20px'))
    } finally {
      settings.setSessionPreview({})
      settings.reset()
      await profile.dispose()
    }
  })

  it('切换 Session 只 update 当前 Suite instance，不重建 renderer', async () => {
    const mounts: string[] = []
    const updates: Array<string | null> = []
    const ownerKeys: Array<string | null> = []
    const factory: WorkbenchRendererFactory = {
      async prepare() {
        return {
          mount(container, input) {
            mounts.push(input.sessionId ?? '')
            ownerKeys.push(input.sessionOwnerKey)
            container.replaceChildren(Object.assign(document.createElement('div'), { textContent: 'session-aware-suite' }))
            const instance: WorkbenchRendererInstance = {
              update: next => updates.push(next.sessionId),
              pause() {}, resume() {}, destroy() {},
              on(event, listener) {
                if (event === 'ready') listener({})
                return () => {}
              },
            }
            return instance
          },
        }
      },
    }
    const registration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.session-suite', 'runtime'),
      {
        id: 'test.session-suite', label: 'Session Suite', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'], factory,
      },
    )
    try {
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.session-suite')
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a'), session('session-2', 'local:b')] })
      const firstCtx = { ...ctx, activeSession: 'session-1' }
      const view = renderAgentSheetViewReactive(firstCtx)
      await screen.findByText('session-aware-suite')

      // #515：view.rerender(ctx 换引用) → 信号驱动；本用例断言依赖同一实例收到 update
      // 而非 remount（mounts 必须恒为 ['session-1']）。
      view.rerenderCtx({ ...ctx, activeSession: 'session-2' })

      await waitFor(() => expect(updates).toContain('session-2'))
      expect(mounts).toEqual(['session-1'])
      expect(ownerKeys).toEqual([JSON.stringify(['profile-a', 'peri', 'local:a'])])
    } finally {
      await registration.dispose()
    }
  })

  it('活动 third-party package 经 production uninstall 后由同一 Host 原子回退 builtin Solid', async () => {
    const pluginId = 'test.removable-suite'
    const destroyed = vi.fn()
    await getPluginRuntime().activateBuiltin(suitePlugin(pluginId, 'removable-suite', false, destroyed))
    usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', `${pluginId}.suite`)
    render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
    await screen.findByText('removable-suite')

    fakeInvoke.register('plugin_package_list', () => [{
      enabled: true,
      package: {
        pluginId, version: '1.0.0', packageInstanceId: `${pluginId}@1.0.0-test`, active: true,
        manifest: { schema: 1, id: pluginId, name: 'Removable Suite', version: '1.0.0', api: '1.0', kind: 'renderer', web: { entry: './dist/entry.js' } },
        files: [], totalBytes: 1,
      },
    }])
    await expect(getPackageInstallationService().uninstall(pluginId)).resolves.toEqual({ ok: true })

    expect(await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })).toHaveAttribute('data-renderer', 'solid')
    await waitFor(() => expect(destroyed).toHaveBeenCalledOnce())
    expect(fakeInvoke.calls).toContainEqual({ cmd: 'plugin_package_uninstall', args: { pluginId, purgeData: false } })
    expect(usePresentationPreferenceStore.getState().rendererSuiteIdByMode['modern-gui']).toBe(`${pluginId}.suite`)
  })

  it('真实插件热更新候选失败时保留健康旧实例，disable 后回退且不覆盖用户偏好', async () => {
    const pluginId = 'test.production-suite-lifecycle'
    const runtime = getPluginRuntime()
    await runtime.activateBuiltin(suitePlugin(pluginId, 'healthy-suite-v1'))
    usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', `${pluginId}.suite`)
    try {
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByText('healthy-suite-v1')

      await runtime.update(suitePlugin(pluginId, 'broken-suite-v2', true))
      await waitFor(() => expect(getErrors()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: 'Renderer Suite 回退',
          source: 'renderer-suite',
          key: expect.stringMatching(new RegExp(`^renderer-suite:agent-sheet:none:${pluginId}\\.suite:`)),
        }),
      ])))
      // P91 C2：真实 250ms 等待改为 waitFor 可观察条件——健康实例保持挂载且宿主仍指向本 suite。
      await waitFor(() => {
        expect(screen.getByText('healthy-suite-v1')).toBeInTheDocument()
        expect(container.querySelector('[data-renderer-suite-host="true"]')).toHaveAttribute('data-suite-id', `${pluginId}.suite`)
      })
      expect(usePresentationPreferenceStore.getState().rendererSuiteIdByMode['modern-gui']).toBe(`${pluginId}.suite`)
      // Ordinary Suite fallback errors have one presentation: the application
      // ErrorCenter. The healthy renderer remains mounted without a local
      // banner or duplicate recovery controls.
      expect(container.querySelector('.renderer-suite-fallback-banner')).toBeNull()
      expect(screen.queryByRole('button', { name: '重试 Solid' })).toBeNull()
      expect(screen.queryByRole('button', { name: '切换 Suite' })).toBeNull()
      expect(screen.queryByRole('button', { name: '打开诊断' })).toBeNull()

      await runtime.disable(pluginId)

      expect(await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })).toHaveAttribute('data-renderer', 'solid')
      expect(usePresentationPreferenceStore.getState().rendererSuiteIdByMode['modern-gui']).toBe(`${pluginId}.suite`)
      clearErrors()
    } finally {
      await runtime.disable(pluginId)
      clearErrors()
    }
  })

  it('Suite 候选 prepare 期间旧实例继续读写自己的 Session UI namespace', async () => {
    let releaseCandidate!: () => void
    const candidateReady = new Promise<void>(resolve => { releaseCandidate = resolve })
    const oldRegistration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.namespace-old', 'runtime'),
      {
        id: 'test.namespace-old', label: 'Namespace Old', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            return { mount(container, _input, host) {
              const node = Object.assign(document.createElement('div'), { textContent: 'namespace-old' })
              container.replaceChildren(node)
              host.sessionUi.set('draft', 'old-owned-draft')
              return {
                update() { node.textContent = host.sessionUi.get('draft', 'namespace-leaked') },
                pause() {}, resume() {}, destroy() {},
                on(event, listener) { if (event === 'ready') listener({}); return () => {} },
              }
            } }
          },
        },
      },
    )
    const candidateRegistration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.namespace-candidate', 'runtime'),
      {
        id: 'test.namespace-candidate', label: 'Namespace Candidate', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            await candidateReady
            return { mount(container) {
              container.replaceChildren(Object.assign(document.createElement('div'), { textContent: 'namespace-candidate' }))
              return { update() {}, pause() {}, resume() {}, destroy() {}, on(event, listener) { if (event === 'ready') listener({}); return () => {} } }
            } }
          },
        },
      },
    )
    try {
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.namespace-old')
      const view = renderAgentSheetViewReactive(ctx)
      // RendererSuiteHost 先把候选挂进 display:none 的 staging，提交（phase=active）才搬进容器。
      // findByText 对隐藏 staging 照样命中，若在此放行，下一段切候选会把旧激活打成
      // StaleSuiteRequest 连提交机会都没有——必须等旧实例真正可见（已提交）。
      await waitFor(() => expect(screen.getByText('namespace-old')).toBeVisible())

      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.namespace-candidate')
      await waitFor(() => expect(view.container.querySelector('[data-renderer-suite-staging="test.namespace-candidate"]')).not.toBeNull())
      // 触发一次真实更新传播（切会话 → mount input 变化 → 旧实例收到 update）。
      // 这里原本改的是 sheet state 的 `sidebarMode`；左栏模型换代后 AgentSheetView 不再读
      // sheet state，那条路径断了，改用文件内既有的 activeSession 切换写法。
      // #515：view.rerender(ctx 换引用) → 信号驱动；旧实例必须原地收到 update（候选
      // prepare 仍被门闩挡住，remount 会把旧实例一并拆掉）。
      view.rerenderCtx({ ...ctx, activeSession: 'session-2' })

      await waitFor(() => expect(screen.getByText('old-owned-draft')).toBeInTheDocument())
    } finally {
      releaseCandidate()
      await candidateRegistration.dispose()
      await oldRegistration.dispose()
    }
  })

  it('third-party prepare fatal 自动回退 builtin Solid，并公开实际活动 Suite', async () => {
    let prepareCount = 0
    const fallbackRegistration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.missing-explicit-fallback', 'runtime'),
      {
        id: 'test.missing-explicit-fallback', label: 'Temporary Explicit Fallback', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: { async prepare() { throw new Error('temporary fallback must be unavailable before mount') } },
      },
    )
    const registration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.failing-suite', 'runtime'),
      {
        id: 'test.failing-suite', label: 'Failing Suite', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'], fallbackSuiteId: 'test.missing-explicit-fallback',
        factory: { async prepare() { prepareCount += 1; throw new Error('third-party prepare failed') } },
      },
    )
    try {
      await fallbackRegistration.dispose()
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.failing-suite')
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)

      expect(await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })).toHaveAttribute('data-renderer', 'solid')
      // staging 里的回退工作台照样能被 findByLabelText 命中；data-suite-id 要等
      // phase=active 的监听才翻转——等它到位再断言，避免与提交竞速。
      await waitFor(() => expect(container.querySelector('[data-renderer-suite-host="true"]')).toHaveAttribute('data-suite-id', 'builtin.solid'))
      expect(prepareCount).toBe(3)
    } finally {
      await registration.dispose()
      await fallbackRegistration.dispose()
    }
  })

  it('targeted Slot overlay 在真实 AgentSheet 的内置 Solid 行生效，清理后恢复基础渲染', async () => {
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-slot-overlay', 'runtime'),
      {
        id: 'test.production-slot-overlay.assistant', targetSuites: ['builtin.solid'],
        kinds: ['message.assistant'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'message.assistant',
        createSurface: () => ({
          rendererId: 'test.production-slot-overlay', kind: 'solid',
          mount(container) {
            const node = document.createElement('div')
            node.dataset.productionSlotOverlay = 'true'
            node.textContent = 'assistant rendered by overlay'
            container.append(node)
            return node
          },
          update() {}, destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
    useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
    const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
    await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
    publishPluginEvent(normalizeRawEvent(
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'slot answer' } } },
      { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
    ).event)

    await waitFor(() => expect(container.querySelector('[data-production-slot-overlay="true"]')).not.toBeNull())
    await registration.dispose()

    await waitFor(() => expect(container.querySelector('[data-production-slot-overlay="true"]')).toBeNull())
    expect(await screen.findByText('slot answer')).toBeInTheDocument()
  })

  it('targeted content.reasoning Slot receives normalized payload and owner cleanup restores C01 base Slot', async () => {
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-reasoning-slot', 'runtime'),
      {
        id: 'test.production-reasoning-slot.content', targetSuites: ['builtin.solid'],
        kinds: ['content.reasoning'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'content.reasoning',
        createSurface: () => ({
          rendererId: 'test.production-reasoning-slot', kind: 'solid',
          mount(container, snapshot) {
            const node = document.createElement('div')
            node.dataset.productionReasoningSlot = 'true'
            node.textContent = `reasoning overlay: ${String((snapshot.payload as { text?: unknown }).text)}`
            container.append(node)
            return node
          },
          update(handle, snapshot) {
            ;(handle as HTMLElement).textContent = `reasoning overlay: ${String((snapshot.payload as { text?: unknown }).text)}`
          },
          destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(normalizeRawEvent(
        { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'normalized thought payload' } } },
        { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
      ).event)

      expect(await screen.findByText('reasoning overlay: normalized thought payload')).toBeInTheDocument()
      expect(container.querySelector('[data-message-role="reasoning"]')).not.toBeNull()
      await registration.dispose()

      await waitFor(() => expect(container.querySelector('[data-production-reasoning-slot="true"]')).toBeNull())
      expect(await screen.findByText('正在思考…')).toBeInTheDocument()
      expect(container.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()
    } finally {
      await registration.dispose()
    }
  })

  it('keeps the session.usage Slot registered without mounting usage in ChatView', async () => {
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-session-usage-slot', 'runtime'),
      {
        id: 'test.production-session-usage-slot.content', targetSuites: ['builtin.solid'],
        kinds: ['session.usage'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'session.usage',
        createSurface: () => ({
          rendererId: 'test.production-session-usage-slot', kind: 'solid',
          mount(container, snapshot) {
            const usage = snapshot.payload as { inputTokens?: unknown; raw?: { vendorFuture?: unknown } }
            const node = document.createElement('div')
            node.dataset.productionSessionUsageSlot = 'true'
            node.textContent = `usage overlay: ${String(usage.inputTokens)} / ${String(usage.raw?.vendorFuture)}`
            container.append(node)
            return node
          },
          update(handle, snapshot) {
            const usage = snapshot.payload as { inputTokens?: unknown; raw?: { vendorFuture?: unknown } }
            ;(handle as HTMLElement).textContent = `usage overlay: ${String(usage.inputTokens)} / ${String(usage.raw?.vendorFuture)}`
          },
          destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-24T00:00:01.000Z', sequence: 1,
        source: { provider: 'peri', sourceId: 'session-usage' }, identity: {},
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'usage.updated', usage: { inputTokens: 8, vendorFuture: 9 } },
      }))

      await waitFor(() => {
        expect(container.querySelector('[data-production-session-usage-slot="true"]')).toBeNull()
        expect(screen.queryByLabelText('会话用量')).toBeNull()
      })
      await registration.dispose()

      expect(container.querySelector('[data-production-session-usage-slot="true"]')).toBeNull()
      expect(screen.queryByLabelText('会话用量')).toBeNull()
      expect(container.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()
    } finally {
      await registration.dispose()
    }
  })

  it('C01 settings update the mounted production reasoning Slot without remounting', async () => {
    const settings = getRendererSettingsStore()
    settings.reset()
    settings.setOverride('kind.content.reasoning.fontSize', 18)
    settings.setOverride('kind.content.reasoning.runningAnimation', 'shimmer')
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(normalizeRawEvent(
        { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'configured reasoning' } } },
        { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
      ).event)

      const reasoning = await waitFor(() => {
        const node = container.querySelector<HTMLElement>('[data-content-kind="content.reasoning"] .term-reasoning')
        expect(node?.style.fontSize).toBe('18px')
        expect(node?.dataset.runningAnimation).toBe('shimmer')
        return node!
      })
      settings.setOverride('kind.content.reasoning.fontSize', 20)
      settings.setOverride('kind.content.reasoning.runningAnimation', 'none')

      await waitFor(() => {
        expect(reasoning.style.fontSize).toBe('20px')
        expect(reasoning.dataset.runningAnimation).toBe('none')
      })
      expect(container.querySelector('[data-content-kind="content.reasoning"] .term-reasoning')).toBe(reasoning)
    } finally {
      settings.reset()
    }
  })

  it('targeted content.document Slot receives canonical payload and owner cleanup restores the C02 base Slot', async () => {
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-document-slot', 'runtime'),
      {
        id: 'test.production-document-slot.content', targetSuites: ['builtin.solid'],
        kinds: ['content.document'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'content.document',
        createSurface: () => ({
          rendererId: 'test.production-document-slot', kind: 'solid',
          mount(container, snapshot) {
            const node = document.createElement('div')
            node.dataset.productionDocumentSlot = 'true'
            node.textContent = `document overlay: ${String((snapshot.payload as { title?: unknown }).title)}`
            container.append(node)
            return node
          },
          update(handle, snapshot) {
            ;(handle as HTMLElement).textContent = `document overlay: ${String((snapshot.payload as { title?: unknown }).title)}`
          },
          destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'peri', sourceId: 'document-a' }, identity: { messageId: 'message-document-a' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: {
          type: 'message.delta', role: 'assistant',
          parts: [{ kind: 'document', title: 'canonical-spec.md', text: 'safe document body', mimeType: 'text/markdown' }],
        },
      }))

      expect(await screen.findByText('document overlay: canonical-spec.md')).toBeInTheDocument()
      expect(container.querySelector('[data-message-role="assistant"]')).not.toBeNull()
      await registration.dispose()

      await waitFor(() => expect(container.querySelector('[data-production-document-slot="true"]')).toBeNull())
      expect(await screen.findByText('canonical-spec.md')).toBeInTheDocument()
      expect(await screen.findByText('safe document body')).toBeInTheDocument()
      expect(container.querySelector('[data-content-kind="content.document"] [data-part-kind="document"]')).not.toBeNull()
    } finally {
      await registration.dispose()
    }
  })

  it('C02 settings update the mounted production document Slot without remounting', async () => {
    const settings = getRendererSettingsStore()
    settings.reset()
    settings.setOverride('kind.content.document.fontSize', 18)
    settings.setOverride('kind.content.document.showMetadata', false)
    settings.setOverride('kind.content.document.groupLayout', 'grid')
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'peri', sourceId: 'document-settings' }, identity: { messageId: 'message-document-settings' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: {
          type: 'message.delta', role: 'assistant',
          parts: [{ kind: 'document', title: 'settings-spec.md', text: 'settings document', mimeType: 'text/markdown' }],
        },
      }))

      const documentCard = await waitFor(() => {
        const node = container.querySelector<HTMLElement>('[data-content-kind="content.document"] [data-part-kind="document"]')
        expect(node?.style.fontSize).toBe('18px')
        expect(node?.dataset.groupLayout).toBe('grid')
        expect(node?.textContent).not.toContain('text/markdown')
        return node!
      })
      settings.setOverride('kind.content.document.fontSize', 20)
      settings.setOverride('kind.content.document.showMetadata', true)
      settings.setOverride('kind.content.document.groupLayout', 'stack')

      await waitFor(() => {
        expect(documentCard.style.fontSize).toBe('20px')
        expect(documentCard.dataset.groupLayout).toBe('stack')
        expect(documentCard.textContent).toContain('text/markdown')
      })
      expect(container.querySelector('[data-content-kind="content.document"] [data-part-kind="document"]')).toBe(documentCard)
    } finally {
      settings.reset()
    }
  })

  it('C03 settings update the mounted production media Slot without remounting', async () => {
    const settings = getRendererSettingsStore()
    settings.reset()
    settings.setOverride('kind.content.image.maxWidth', 420)
    settings.setOverride('kind.content.image.fit', 'cover')
    settings.setOverride('kind.content.image.showCaption', false)
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'hermes', sourceId: 'media-settings' }, identity: { messageId: 'message-media-settings' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: {
          type: 'message.delta', role: 'assistant',
          parts: [{
            kind: 'image', source: 'https://cdn.example.com/settings.png', mimeType: 'image/png',
            alt: '设置图片', caption: '可切换说明',
          }],
        },
      }))

      const media = await waitFor(() => {
        const node = container.querySelector<HTMLElement>('[data-content-kind="content.image"] figure.term-media')
        expect(node?.style.maxWidth).toBe('420px')
        expect(node?.dataset.fit).toBe('cover')
        expect(node?.textContent).not.toContain('可切换说明')
        return node!
      })
      settings.setOverride('kind.content.image.maxWidth', 680)
      settings.setOverride('kind.content.image.fit', 'contain')
      settings.setOverride('kind.content.image.showCaption', true)

      await waitFor(() => {
        expect(media.style.maxWidth).toBe('680px')
        expect(media.dataset.fit).toBe('contain')
        expect(media.textContent).toContain('可切换说明')
      })
      expect(container.querySelector('[data-content-kind="content.image"] figure.term-media')).toBe(media)
    } finally {
      settings.reset()
    }
  })

  it('targeted content.image Slot owner cleanup restores the C03 base Slot', async () => {
    const destroyed = vi.fn()
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-media-slot', 'runtime'),
      {
        id: 'test.production-media-slot.content', targetSuites: ['builtin.solid'],
        kinds: ['content.image'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'content.image',
        createSurface: () => ({
          rendererId: 'test.production-media-slot', kind: 'solid',
          mount(container, snapshot) {
            const node = document.createElement('div')
            node.dataset.productionMediaSlot = 'true'
            node.textContent = `media overlay: ${String((snapshot.payload as { alt?: unknown }).alt)}`
            container.append(node)
            return node
          },
          update(handle, snapshot) {
            ;(handle as HTMLElement).textContent = `media overlay: ${String((snapshot.payload as { alt?: unknown }).alt)}`
          },
          destroy(handle) { destroyed(handle); (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'hermes', sourceId: 'media-overlay' }, identity: { messageId: 'message-media-overlay' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: {
          type: 'message.delta', role: 'assistant',
          parts: [{ kind: 'image', source: 'https://cdn.example.com/overlay.png', mimeType: 'image/png', alt: '覆盖图' }],
        },
      }))

      expect(await screen.findByText('media overlay: 覆盖图')).toBeInTheDocument()
      await registration.dispose()

      await waitFor(() => expect(container.querySelector('[data-production-media-slot="true"]')).toBeNull())
      expect(await screen.findByRole('img', { name: '覆盖图' })).toHaveAttribute('src', 'https://cdn.example.com/overlay.png')
      expect(container.querySelector('[data-renderer-slot-id="builtin.solid.content.base"]')).not.toBeNull()
      expect(destroyed).toHaveBeenCalled()
      const destroyedHandles = destroyed.mock.calls.map(call => call[0])
      expect(new Set(destroyedHandles).size).toBe(destroyedHandles.length)
    } finally {
      await registration.dispose()
    }
  })

  it('canonical message parts 经 content.text Slot seam 消费且保留消息 role framing', async () => {
    localStorage.clear()
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-content-slot', 'runtime'),
      {
        id: 'test.production-content-slot.text', targetSuites: ['builtin.solid'],
        kinds: ['content.text'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'content.text',
        createSurface: snapshot => ({
          rendererId: 'test.production-content-slot', kind: 'solid',
          mount(container) {
            const node = document.createElement('div')
            node.dataset.productionContentSlot = 'true'
            const initialText = String((snapshot.payload as { text?: unknown }).text)
            node.textContent = `content slot: ${initialText}`
            container.append(node)
            return node
          },
          update(handle, next) {
            const nextText = String((next.payload as { text?: unknown }).text)
            ;(handle as HTMLElement).textContent = `content slot: ${nextText}`
          }, destroy(handle) { (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      const slotCtx = { ...ctx, activeSession: 'content-slot-session', sessionSource: () => 'local:content-slot' }
      useIdentityStore.setState({ sessions: [session('content-slot-session', 'local:content-slot')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={slotCtx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      const normalizedContentEvent = normalizeRawEvent(
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part payload' } } },
        { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:content-slot' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
      )
      publishPluginEvent(normalizedContentEvent.event)
      expect(await screen.findByText(/content slot:\s*part payload/, {}, { timeout: 5_000 })).toBeInTheDocument()
      expect(container.querySelector('[data-message-role="assistant"]')).not.toBeNull()
      await registration.dispose()
      await waitFor(() => expect(container.querySelector('[data-production-content-slot="true"]')).toBeNull())
      expect(await screen.findByText('part payload')).toBeInTheDocument()
    } finally {
      await registration.dispose()
    }
  })

  it('canonical plan/goal snapshot 经 content.plan Slot seam 消费', async () => {
    const destroyed = vi.fn()
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-plan-slot', 'runtime'),
      {
        id: 'test.production-plan-slot.plan', targetSuites: ['builtin.solid'],
        kinds: ['content.plan'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'content.plan',
        createSurface: snapshot => ({
          rendererId: 'test.production-plan-slot', kind: 'solid',
          mount(container) {
            const node = document.createElement('div')
            node.textContent = planSlotSummary(snapshot.payload)
            container.append(node)
            return node
          },
          update(handle, next) {
            ;(handle as HTMLElement).textContent = planSlotSummary(next.payload)
          },
          destroy(handle) { destroyed(handle); (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'hermes', sourceId: 'plan-1' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: {
          type: 'plan.replaced',
          entries: [{ id: 'task-1', content: 'Wire plan', status: 'blocked', blockedReason: 'dependency' }],
        },
      }))
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:02.000Z', sequence: 2,
        source: { provider: 'peri', sourceId: 'goal-1' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: {
          type: 'goal.updated',
          goal: { goalId: 'goal-1', objective: 'Production goal', status: 'active', accounting: { timeUsedSeconds: 12 } },
        },
      }))

      expect(await screen.findByText('plan slot: task-1 / dependency / Production goal / 12')).toBeInTheDocument()
      await registration.dispose()

      await waitFor(() => expect(screen.queryByText('plan slot: task-1 / dependency / Production goal / 12')).toBeNull())
      // slot 卸载到 fallback（content.plan 的 SolidPlanGoalContent）挂载之间隔着一次
      // Solid 微任务，文本消失即可观察时按钮可能尚未进场——用 findBy 等它。
      ;(await screen.findByRole('button', { name: /1 任务.*1 阻塞/ })).click()
      expect(await screen.findByRole('treeitem', { name: /Wire plan.*已阻塞/ })).toBeInTheDocument()
      expect(screen.getByRole('status', { name: /目标：Production goal.*进行中/ })).toBeInTheDocument()
      expect(destroyed).toHaveBeenCalled()
      const handles = destroyed.mock.calls.map(call => call[0])
      expect(new Set(handles).size).toBe(handles.length)
    } finally {
      await registration.dispose()
    }
  })

  it('C08 settings update the mounted production plan Slot without remounting or changing business state', async () => {
    const settings = getRendererSettingsStore()
    settings.reset()
    settings.setOverride('kind.content.plan.defaultExpanded', true)
    settings.setOverride('kind.content.plan.collapseCompleted', false)
    settings.setOverride('kind.content.plan.showPriority', false)
    settings.setOverride('kind.content.plan.showBudget', false)
    settings.setOverride('kind.content.plan.density', 'compact')
    settings.setOverride('kind.content.plan.connectorStyle', 'dashed')
    settings.setOverride('kind.content.plan.indent', 28)
    settings.setOverride('kind.content.plan.activeColor', '#112233')
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'claude', sourceId: 'plan-settings' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'plan.replaced', entries: [{ id: 'active', content: 'Stable plan state', status: 'in_progress', priority: 2 }] },
      }))
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:02.000Z', sequence: 2,
        source: { provider: 'peri', sourceId: 'goal-settings' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'goal.updated', goal: { goalId: 'g', objective: 'Stable goal', status: 'active', tokenBudget: 100, tokensUsed: 25 } },
      }))

      const region = await screen.findByRole('region', { name: '计划与目标' })
      expect(region).toHaveAttribute('data-density', 'compact')
      expect(region).toHaveAttribute('data-connector-style', 'dashed')
      expect(region.style.getPropertyValue('--plan-indent')).toBe('28px')
      expect(screen.getByRole('treeitem', { name: /Stable plan state/ })).toBeInTheDocument()
      expect(container.querySelector('.task-tree-priority')).toBeNull()
      expect(container.querySelector('.goal-card-budget')).toBeNull()

      settings.setOverride('kind.content.plan.showPriority', true)
      settings.setOverride('kind.content.plan.showBudget', true)
      settings.setOverride('kind.content.plan.density', 'comfortable')
      settings.setOverride('kind.content.plan.connectorStyle', 'solid')
      settings.setOverride('kind.content.plan.indent', 36)
      settings.setOverride('kind.content.plan.activeColor', '#445566')

      await waitFor(() => {
        expect(region).toHaveAttribute('data-density', 'comfortable')
        expect(region).toHaveAttribute('data-connector-style', 'solid')
        expect(region.style.getPropertyValue('--plan-indent')).toBe('36px')
        expect(container.querySelector('.task-tree-priority')?.textContent).toBe('P2')
        expect(container.querySelector('.goal-card-budget')).toHaveAttribute('aria-valuenow', '25')
      })
      expect(screen.getByRole('region', { name: '计划与目标' })).toBe(region)
      expect(screen.getByText('Stable plan state')).toBeInTheDocument()
      expect(screen.getByText('Stable goal')).toBeInTheDocument()
    } finally {
      settings.reset()
    }
  })

  it('canonical systemErrors use the C13 targeted Slot and cleanup restores the base Slot', async () => {
    const destroyed = vi.fn()
    const registration = getRendererRegistry().registerSlot(
      createPluginIdentity('test.production-system-error-slot', 'runtime'),
      {
        id: 'test.production-system-error-slot.error', targetSuites: ['builtin.solid'],
        kinds: ['system.error'], priority: 1, fallback: false,
        canRender: snapshot => snapshot.kind === 'system.error',
        createSurface: snapshot => ({
          rendererId: 'test.production-system-error-slot', kind: 'solid',
          mount(container) {
            const node = document.createElement('div')
            node.dataset.productionSystemErrorSlot = 'true'
            node.textContent = systemErrorSlotSummary(snapshot.payload)
            container.append(node)
            return node
          },
          update(handle, next) { ;(handle as HTMLElement).textContent = systemErrorSlotSummary(next.payload) },
          destroy(handle) { destroyed(handle); (handle as HTMLElement).remove() }, on: () => () => {},
        }),
      },
    )
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'peri', sourceId: 'error-1' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: { type: 'diagnostic.notice', level: 'error', code: 'agent_connection_timeout', message: '连接失败' },
      }))

      expect(await screen.findByText('system error slot: 连接失败 / retry')).toBeInTheDocument()
      await registration.dispose()

      await waitFor(() => expect(container.querySelector('[data-production-system-error-slot="true"]')).toBeNull())
      expect(await screen.findByRole('alert', { name: '系统错误：连接失败' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
      expect(destroyed).toHaveBeenCalled()
      const handles = destroyed.mock.calls.map(call => call[0])
      expect(new Set(handles).size).toBe(handles.length)
    } finally {
      await registration.dispose()
    }
  })

  it('C13 settings update the mounted lifecycle Slot without remounting or changing retry state', async () => {
    const settings = getRendererSettingsStore()
    settings.reset()
    settings.setOverride('kind.lifecycle.retry.density', 'compact')
    settings.setOverride('kind.lifecycle.retry.technicalDetailsExpanded', true)
    settings.setOverride('kind.lifecycle.retry.retryCountdownStyle', 'compact')
    settings.setOverride('kind.lifecycle.retry.showProviderIds', true)
    settings.setOverride('kind.lifecycle.retry.showEventIds', true)
    settings.setOverride('kind.lifecycle.retry.motion', 'subtle')
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(createWorkbenchEnvelope({
        sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
        source: { provider: 'peri', sourceId: 'retry-settings' },
        provenance: { origin: 'local-observed', trust: 'authoritative' },
        event: {
          type: 'lifecycle.retrying', attempt: 2, maxAttempts: 3, delayMs: 4000,
          error: {
            userSummary: 'Stable retry error', technicalMessage: '429 stable', provider: 'peri', eventId: 'event-stable',
            recoverability: 'retry',
          },
        },
      }))

      const card = await screen.findByRole('status', { name: /生命周期：第 2\/3 次重试/ })
      expect(card).toHaveAttribute('data-density', 'compact')
      expect(card).toHaveAttribute('data-motion', 'subtle')
      expect(card).toHaveTextContent('4s')
      expect(card).toHaveTextContent('peri')
      expect(card).toHaveTextContent('event-stable')
      expect(container.querySelector('details.lifecycle-technical')).toHaveAttribute('open')
      expect(screen.queryByRole('button', { name: '重试' })).toBeNull()

      settings.setOverride('kind.lifecycle.retry.density', 'comfortable')
      settings.setOverride('kind.lifecycle.retry.technicalDetailsExpanded', false)
      settings.setOverride('kind.lifecycle.retry.retryCountdownStyle', 'hidden')
      settings.setOverride('kind.lifecycle.retry.showProviderIds', false)
      settings.setOverride('kind.lifecycle.retry.showEventIds', false)
      settings.setOverride('kind.lifecycle.retry.motion', 'none')

      await waitFor(() => {
        expect(card).toHaveAttribute('data-density', 'comfortable')
        expect(card).toHaveAttribute('data-motion', 'none')
        expect(card).not.toHaveTextContent('4s')
        expect(card).not.toHaveTextContent('event-stable')
        expect(container.querySelector('details.lifecycle-technical')).not.toHaveAttribute('open')
      })
      expect(screen.getByRole('status', { name: /生命周期：第 2\/3 次重试/ })).toBe(card)
      expect(card).toHaveTextContent('Stable retry error')
      expect(card).toHaveTextContent('429 stable')
    } finally {
      settings.reset()
    }
  })

  it('AgentSheet interaction command 穿过 Host gate 与统一 production transport', async () => {
    useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
    useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
    render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
    await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
    publishPluginEvent(createWorkbenchEnvelope({
      sessionId: 'local:a', recordedAt: '2026-08-22T00:00:01.000Z', sequence: 1,
      source: { provider: 'peri', sourceId: 'interaction-a' }, identity: { interactionId: 'interaction-a' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'interaction.requested', interactionId: 'interaction-a',
        request: {
          surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'peri', requestId: 'request-a', sessionId: 'local:a', clientGeneration: 1 },
          questions: [{ id: 'approval', question: 'Allow?', allowMultiple: false, allowFreeform: false,
            options: [{ id: 'allow_once', label: 'Allow production action' }] }],
        },
      },
    }) as never)

    ;(await screen.findByRole('button', { name: 'Allow production action' })).click()

    await waitFor(() => expect(fakeInvoke.calls).toContainEqual({
      cmd: 'respond_interaction',
      args: {
        identity: { provider: 'peri', agentId: 'peri', requestId: 'request-a', sessionId: 'local:a', clientGeneration: 1 },
        kind: 'approval', answer: { optionId: 'allow_once' },
      },
    }))
  })

  it('Slot 运行期失败先切到同 Suite 下一 candidate，不越级触发 Suite fatal', async () => {
    const owner = createPluginIdentity('test.production-slot-recovery', 'runtime')
    const secondaryUnsubscribed = vi.fn()
    const primary = getRendererRegistry().registerSlot(owner, {
      id: 'test.production-slot-recovery.primary', targetSuites: ['builtin.solid'],
      kinds: ['message.assistant'], priority: 1, fallback: false,
      canRender: snapshot => snapshot.kind === 'message.assistant',
      createSurface: () => ({
        rendererId: 'test.production-slot-recovery.primary', kind: 'solid',
        mount(container) {
          const node = document.createElement('div'); node.textContent = 'primary-slot'; container.append(node); return node
        },
        update() {}, destroy(handle) { (handle as HTMLElement).remove() },
        on(event, listener) {
          if (event === 'error') listener(new Error('primary slot runtime failed'))
          return () => {}
        },
      }),
    })
    const secondary = getRendererRegistry().registerSlot(owner, {
      id: 'test.production-slot-recovery.secondary', targetSuites: ['builtin.solid'],
      kinds: ['message.assistant'], priority: 2, fallback: true,
      canRender: snapshot => snapshot.kind === 'message.assistant',
      createSurface: () => ({
        rendererId: 'test.production-slot-recovery.secondary', kind: 'solid',
        mount(container) {
          const node = document.createElement('div'); node.textContent = 'secondary-slot'; container.append(node); return node
        },
        update() {}, destroy(handle) { (handle as HTMLElement).remove() }, on: () => secondaryUnsubscribed,
      }),
    })
    try {
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a')] })
      useWorkspaceStore.setState(state => ({ workspaceSheets: { ...state.workspaceSheets, activeSheetId: 'agent-sheet' } }))
      const view = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
      await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
      publishPluginEvent(normalizeRawEvent(
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recoverable slot answer' } } },
        { owner: { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }, clientGeneration: 1, sequence: 1, receivedAt: '2026-08-22T00:00:01.000Z' },
      ).event)

      expect(await screen.findByText('secondary-slot')).toBeInTheDocument()
      expect(screen.queryByLabelText('React Workbench fatal fallback')).toBeNull()
      view.unmount()
      await waitFor(() => expect(secondaryUnsubscribed).toHaveBeenCalledTimes(2))
    } finally {
      await secondary.dispose()
      await primary.dispose()
    }
  })

  it('third-party update fatal 先重建同一 Suite，重试成功不越级回退', async () => {
    let prepareCount = 0
    const destroyed = vi.fn()
    const registration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.update-failing-suite', 'runtime'),
      {
        id: 'test.update-failing-suite', label: 'Update Failing Suite', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            prepareCount += 1
            return {
              mount(container) {
                container.replaceChildren(Object.assign(document.createElement('div'), { textContent: 'update-failing-suite' }))
                return {
                  update() { throw new Error('third-party update failed') }, pause() {}, resume() {}, destroy: destroyed,
                  on(event, listener) { if (event === 'ready') listener({}); return () => {} },
                }
              },
            }
          },
        },
      },
    )
    try {
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.update-failing-suite')
      useIdentityStore.setState({ sessions: [session('session-1', 'local:a'), session('session-2', 'local:b')] })
      const view = renderAgentSheetViewReactive({ ...ctx, activeSession: 'session-1' })
      await screen.findByText('update-failing-suite')

      // #515：view.rerender(ctx 换引用) → 信号驱动；update() 抛错触发同 Suite 原地重建
      // 的路径必须保真（prepareCount=2 来自重试链路，不能来自 remount）。
      view.rerenderCtx({ ...ctx, activeSession: 'session-2' })

      await waitFor(() => expect(prepareCount).toBe(2), { timeout: 5_000 })
      expect(await screen.findByText('update-failing-suite')).toBeInTheDocument()
      expect(screen.queryByLabelText('Solid Agent Workbench')).toBeNull()
      expect(destroyed).toHaveBeenCalledOnce()
    } finally {
      await registration.dispose()
    }
  })

  it('third-party runtime fatal 的同 activation 重试耗尽后才回退 builtin Solid', async () => {
    let prepareCount = 0
    const registration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.runtime-failing-suite', 'runtime'),
      {
        id: 'test.runtime-failing-suite', label: 'Runtime Failing Suite', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            prepareCount += 1
            return {
              mount(container) {
                container.replaceChildren(Object.assign(document.createElement('div'), { textContent: 'runtime-failing-suite' }))
                const listeners = new Map<string, Set<(payload: unknown) => void>>()
                let fatalTimer: ReturnType<typeof setTimeout> | undefined
                return {
                  update() {}, pause() {}, resume() {}, destroy() { if (fatalTimer) clearTimeout(fatalTimer) },
                  on(event, listener) {
                    const group = listeners.get(event) ?? new Set()
                    group.add(listener); listeners.set(event, group)
                    if (event === 'ready') {
                      listener({})
                      fatalTimer = setTimeout(() => {
                        for (const notify of listeners.get('error') ?? []) notify(new Error('third-party runtime failed'))
                      }, 0)
                    }
                    return () => group.delete(listener)
                  },
                }
              },
            }
          },
        },
      },
    )
    try {
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.runtime-failing-suite')
      render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)

      expect(await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })).toHaveAttribute('data-renderer', 'solid')
      expect(prepareCount).toBe(3)
    } finally {
      await registration.dispose()
    }
  })

  it('runtime fatal 后的重建候选失败继续消耗重试预算，不能误留损坏旧实例', async () => {
    let prepareCount = 0
    const registration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.runtime-recovery-prepare-failing-suite', 'runtime'),
      {
        id: 'test.runtime-recovery-prepare-failing-suite', label: 'Runtime Recovery Prepare Failing Suite', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            prepareCount += 1
            if (prepareCount > 1) throw new Error('recovery candidate prepare failed')
            return {
              mount(container) {
                container.replaceChildren(Object.assign(document.createElement('div'), { textContent: 'runtime-recovery-source' }))
                const listeners = new Map<string, Set<(payload: unknown) => void>>()
                return {
                  update() {}, pause() {}, resume() {}, destroy() {},
                  on(event, listener) {
                    const group = listeners.get(event) ?? new Set()
                    group.add(listener); listeners.set(event, group)
                    if (event === 'ready') {
                      listener({})
                      setTimeout(() => {
                        for (const notify of listeners.get('error') ?? []) notify(new Error('source runtime failed'))
                      }, 0)
                    }
                    return () => group.delete(listener)
                  },
                }
              },
            }
          },
        },
      },
    )
    try {
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.runtime-recovery-prepare-failing-suite')
      render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)

      expect(await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })).toHaveAttribute('data-renderer', 'solid')
      expect(prepareCount).toBe(3)
      // findByLabelText 命中的是 staging 里的回退工作台；旧 source 实例要等回退提交
      // 时才被销毁、文本才离场——等真条件而不是立刻断言。
      await waitFor(() => expect(screen.queryByText('runtime-recovery-source')).toBeNull())
    } finally {
      await registration.dispose()
    }
  })

  it('third-party Suite 的显式完整 fallback 优先于 builtin Solid', async () => {
    const fallbackRegistration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.explicit-fallback', 'runtime'),
      {
        id: 'test.explicit-fallback', label: 'Explicit Fallback', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'],
        factory: {
          async prepare() {
            return { mount(container) {
              container.replaceChildren(Object.assign(document.createElement('div'), { textContent: 'explicit-fallback-suite' }))
              return { update() {}, pause() {}, resume() {}, destroy() {}, on(event, listener) { if (event === 'ready') listener({}); return () => {} } }
            } }
          },
        },
      },
    )
    const failingRegistration = getRendererRegistry().registerSuite(
      createPluginIdentity('test.explicit-source', 'runtime'),
      {
        id: 'test.explicit-source', label: 'Explicit Source', apiVersion: 1,
        runtime: { framework: 'solid', version: '1.0.0' },
        compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
        requiredKinds: ['content.unknown'], fallbackSuiteId: 'test.explicit-fallback',
        factory: { async prepare() { throw new Error('source failed') } },
      },
    )
    try {
      usePresentationPreferenceStore.getState().setRendererSuiteId('modern-gui', 'test.explicit-source')
      const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)

      await screen.findByText('explicit-fallback-suite', {}, { timeout: 5_000 })
      // staging 命中 ≠ 已提交；data-suite-id 在 phase=active 才翻转，等它。
      await waitFor(() => expect(container.querySelector('[data-renderer-suite-host="true"]')).toHaveAttribute('data-suite-id', 'test.explicit-fallback'))
    } finally {
      await failingRegistration.dispose()
      await fallbackRegistration.dispose()
    }
  })

  // 旧断言「Agent Workspace state 的 sidebarMode 经 Host input 传给 Solid」已随左栏模型换代删除：
  // `sidebarMode ('work'|'chat')` 与它派生的 `data-workspace-mode` 都不再存在，Solid 也没了这个输入。
  // 等价强度的替代断言在 `src/components/__tests__/Sidebar.blocks.test.tsx`（全局折叠偏好到达左栏、
  // 损坏值回落空映射、跨 Sheet 同态）与 `workspace-sheets/__tests__/workspaceStore.integration.test.ts`
  // 的 codec 往返用例里。

  it('Solid 空态提交首条请求后创建并选中会话，再向同一 owner 发送消息', async () => {
    const selectSession = vi.fn((id: string | null) => { invokeLog.push(`selectSession:${id}`) })
    fakeInvoke.register('new_session', () => Promise.resolve({ sessionId: 'remote-created' }))

    render(() => <AgentSheetView
      sheet={sheet({})}
      ctx={{ ...ctx, activeSession: null, selectSession }}
    />)

    // Empty state reuses the production input bar.  Submitting the first
    // prompt is the same Enter interaction as an active session; there is no
    // separate "开始新会话" button anymore.
    const prompt = await screen.findByRole('textbox', { name: '消息输入' }, { timeout: 5_000 })
    fireEvent.input(prompt, { target: { value: '检查当前项目的测试状态' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', charCode: 13 })

    await waitFor(() => expect(selectSession).toHaveBeenCalledTimes(1))
    const sessionId = selectSession.mock.calls[0]?.[0]
    const created = useIdentityStore.getState().sessions.find(item => item.id === sessionId)
    expect(created).toMatchObject({ agentId: 'peri', periId: 'remote-created' })
    expect(fakeInvoke.calls).toContainEqual({ cmd: 'new_session', args: expect.objectContaining({
      agentId: 'peri', source: created?.source,
    }) })
    expect(fakeInvoke.calls).toContainEqual({ cmd: 'send_message', args: expect.objectContaining({
      agentId: 'peri', source: created?.source, content: '检查当前项目的测试状态',
    }) })
    // 顺序契约（原 invocationCallOrder）：先 selectSession 选中，再向同一 owner 发送消息
    expect(invokeLog.indexOf(`selectSession:${sessionId}`)).toBeGreaterThanOrEqual(0)
    expect(invokeLog.indexOf('send_message')).toBeGreaterThan(invokeLog.indexOf(`selectSession:${sessionId}`))
  })

  it('Solid 工作空态只在选择工作区后创建带 cwd 绑定的会话', async () => {
    const selectSession = vi.fn()
    useWorkspaceEntityStore.setState({
      workspaces: [{
        id: 'workspace-a', agentId: 'peri', name: 'Pylon', rootPath: 'G:/Project/Pylon',
        createdAt: 1, lastActiveAt: 1, skills: ['tdd'], mcpServerIds: [], hookPluginIds: ['hook-a'],
      }],
      hydrated: true,
    })
    fakeInvoke.register('new_session', () => Promise.resolve({ sessionId: 'remote-work' }))

    render(() => <AgentSheetView
      sheet={sheet({})}
      ctx={{ ...ctx, activeSession: null, selectSession }}
    />)

    // 04b：空态工作区选择器已隐藏 —— 改由下方 new_session 实参断言预选结果；
    // 先等空态挂载完成，避免在未挂载时输入。
    await screen.findByRole('region', { name: 'Agent 工作台空态' }, { timeout: 5_000 })
    const prompt = screen.getByRole('textbox', { name: '消息输入' })
    fireEvent.input(prompt, { target: { value: '修复构建' } })
    fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter', charCode: 13 })

    await waitFor(() => expect(selectSession).toHaveBeenCalledTimes(1))
    const created = useIdentityStore.getState().sessions.find(item => item.id === selectSession.mock.calls[0]?.[0])
    expect(created).toMatchObject({
      workspaceId: 'workspace-a', workdir: 'G:/Project/Pylon', skills: ['tdd'], hooks: ['hook-a'],
    })
    expect(fakeInvoke.calls).toContainEqual({ cmd: 'new_session', args: expect.objectContaining({
      workspaceId: 'workspace-a', cwd: 'G:/Project/Pylon', source: created?.source,
    }) })
  })

  it('Interface Mode 切换仍复用 Renderer Suite Host，不回到硬编码 React 工作台', async () => {
    const { container } = render(() => <AgentSheetView sheet={sheet({})} ctx={ctx} />)
    const firstSolid = await screen.findByLabelText('Solid Agent Workbench', {}, { timeout: 5_000 })
    expect(container.querySelector('[data-renderer-suite-host="true"]')).toHaveAttribute('data-suite-id', 'builtin.solid')

    useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' })
    // #515：React 版 rerender 与 setState 后的 props 完全相同，仅用于强制 flush；Solid 无
    // 此 API，store 信号直接传播——「同一 DOM 节点存活」断言（toBe(firstSolid)）保留。
    await waitFor(() => expect(screen.getByLabelText('Solid Agent Workbench')).toBe(firstSolid))
    expect(container.querySelector('[data-pylon-workbench="modern-gui"]')).toBeNull()
    expect(container.querySelector('[data-pylon-workbench="terminal-like"]')).toBeNull()
  })
})
