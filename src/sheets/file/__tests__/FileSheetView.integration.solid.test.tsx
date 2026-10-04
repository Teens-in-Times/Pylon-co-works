// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { fireEvent, render, screen, waitFor, cleanup } from '@solidjs/testing-library'
import { createZustandSignal } from '../../../infrastructure/state/solidStoreBridge.ts'
import FileSheetView from '../FileSheetView.solid.tsx'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore'
import { toAgentContextKey } from '../../../domains/agent/agentContext'
import { resetStores } from '../../../test/resetStores'
import { createSheetState } from '../../../domains/workspace/sheetState'
import { fileTabKey, parseFileTabs, serializeFileTabs, type FileTabRecord, type FileTabState } from '../fileSheetState'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import { useIdentityStore } from '../../../domains/identity/identityStore'
import { replaceFileEditorValue, waitForFileEditor } from './codeMirrorTestUtils.solid.ts'
import { closeWorkspace } from '../../../workspace-sheets/workspaceController.ts'
import { FILE_NAVIGATION_METADATA_KEY } from '../fileSheetNavigation.ts'

afterEach(() => cleanup())

// #515：迁移自 FileSheetView.integration.test.tsx（React RTL → Solid 实体直连）。
// 断言改写点登记：
// 1. render(<FileSheetHarness/>)（React zustand hook）→ render(() => <FileSheetHarness/>)
//  （createZustandSignal 订阅——useXxxStore(selector) 是 React shim hook，Solid 组件内
//  不可用）；
// 2. act() 包装退役——store 写入经 createZustandSignal 同步传播；
// 3. fireEvent.change → fireEvent.input（Solid onInput ≡ React onChange 的即时输入流）；
// 4. replaceFileEditorValue 改用 codeMirrorTestUtils.solid（无 React act 包装）；
// 5. closeWorkspace 直接 await（React act 拍对齐由微任务天然满足）。
// 其余断言集与 DOM 契约不变。

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
vi.mock('../../../domains/chat/codeHighlight', () => ({ highlightCode: vi.fn().mockResolvedValue(null) }))

const ctx: SheetContext = {
  openSheet: vi.fn(),
  focusSheet: vi.fn(),
  closeSheet: vi.fn(),
  activeSession: null,
  selectSession: vi.fn(),
  openProfileEdit: vi.fn(),
  openSessionSettings: vi.fn(),
  sidebarCollapsed: false,
  rightInset: 0,
  sessionSource: () => 'ws-a',
  sessionBySource: source => useIdentityStore.getState().sessions.find(session => session.source === source),
}

function seedSheet(metadata: Record<string, string>) {
  const sheet: SheetRecord = {
    id: 'file-1',
    kind: 'file',
    title: '文件',
    agentId: 'agent-test',
    singletonKey: 'file:ws-a',
    createdAt: 0,
    lastFocusedAt: 0,
    metadata,
  }
  useWorkspaceStore.setState({ workspaceSheets: createSheetState([sheet], 'file-1') })
}

function seedUnboundSheet() {
  const sheet: SheetRecord = {
    id: 'file-1',
    kind: 'file',
    title: '文件',
    agentId: 'agent-test',
    createdAt: 0,
    lastFocusedAt: 0,
    metadata: {},
  }
  useWorkspaceStore.setState({ workspaceSheets: createSheetState([sheet], 'file-1') })
}

function FileSheetHarness() {
  const sheet = createZustandSignal(useWorkspaceStore, s => s.workspaceSheets.sheets.find(item => item.id === 'file-1'))
  // 不用 keyed Show：sheet 每次写盘都是新对象，keyed 会销毁重建整棵 FileSheetView
  //（React 版为同实例重渲染，组件状态必须跨 patch 存活）——测试始终先 seed 再渲染。
  return <FileSheetView sheet={sheet()!} ctx={ctx} />
}

function renderHarness() {
  return render(() => <FileSheetHarness />)
}

function readTextResult(relativePath: string, content: string) {
  return { relativePath, content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('FileSheetView 版本化 tab 集成（D-02/D-04）', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({ sessions: [{ id: 'session-a', agentId: 'agent-test', source: 'ws-a', name: 'Workspace A', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/workspace', sessionPrompt: '', skills: [], hooks: [], autoName: '' }] })
    localStorage.clear()
    invoke.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    invoke.mockImplementation((cmd: string, args: { source?: string; relativePath?: string } | undefined) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'read_workspace_text') {
        const content = args?.relativePath === 'src/c.ts' ? 'const c = 3' : 'const x = 1'
        return Promise.resolve(readTextResult(args?.relativePath ?? '', content))
      }
      if (cmd === 'git_status_with_branch') {
        return Promise.resolve({ branch: { branch: null, detached: false, head: null }, entries: [{ path: 'src/c.ts', status: 'M', staged: true }] })
      }
      if (cmd === 'git_history') return Promise.resolve([])
      // #368：builtin provider 带 stash/logGraph 能力，SCM 视图挂载即探测
      if (cmd === 'git_stash_list') return Promise.resolve([])
      if (cmd === 'git_log_graph') return Promise.resolve({ commits: [], hasMore: false })
      if (cmd === 'git_diff') return Promise.resolve('--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1,1 +1,1 @@\n-const c = 2\n+const c = 3')
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
  })

  it('v1 openTabs:string[] 迁移为 file-mode tabs，activeKey 取最后一条', async () => {
    seedSheet({ openTabs: JSON.stringify(['src/a.ts', 'src/b.ts']) })
    renderHarness()
    await screen.findByText('src/b.ts', {}, { timeout: 10_000 })
    expect(screen.getByTitle('src/a.ts')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/b.ts'))
  })

  it('从会话分区选择工作区会话后自动展示文件树，并以 workspaceId 请求根目录', async () => {
    useIdentityStore.setState({ sessions: [{
      id: 'session-workspace', agentId: 'agent-test', source: 'workspace-source', name: 'Pylon Workspace',
      profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/stale-snapshot',
      workspaceId: 'workspace-1', sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }] })
    seedUnboundSheet()
    const view = renderHarness()

    fireEvent.click(screen.getByLabelText('会话：切换工作区会话'))
    fireEvent.click(await screen.findByText('Pylon Workspace'))

    await screen.findByText('EXPLORER')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_workspace_entries', {
      target: {
        sessionId: 'session-workspace',
        agentId: 'agent-test',
        source: 'workspace-source',
        workspaceId: 'workspace-1',
      },
      relativePath: '',
    }))
    expect(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.targetSessionId).toBe('session-workspace')

    invoke.mockClear()
    view.unmount()
    renderHarness()
    await screen.findByText('EXPLORER')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_workspace_entries', expect.objectContaining({
      target: expect.objectContaining({ workspaceId: 'workspace-1' }),
    })))
  })

  it('文件 provider 返回规范化 WorkspaceEntry 时不会被二次归一化清空', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([
        { name: 'src', relativePath: 'src', kind: 'directory' },
        { name: 'package.json', relativePath: 'package.json', kind: 'file' },
      ])
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    seedSheet({})
    renderHarness()

    expect(await screen.findByTitle('src')).toBeTruthy()
    expect(screen.getByTitle('package.json')).toBeTruthy()
    expect(screen.queryByText('工作区为空')).toBeNull()
  })

  it('从文件树打开文件只由活动 tab 发起一次读取', async () => {
    invoke.mockImplementation((cmd: string, args: { relativePath?: string } | undefined) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([
        { name: 'a.ts', relativePath: 'src/a.ts', kind: 'file' },
      ])
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult(args?.relativePath ?? '', 'single read'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    seedSheet({})
    renderHarness()
    fireEvent.click(await screen.findByTitle('src/a.ts'))
    await screen.findByText('single read')

    expect(invoke.mock.calls.filter(([command]) => command === 'read_workspace_text')).toHaveLength(1)
  })

  it('文件树支持显式刷新并替换陈旧目录快照', async () => {
    let reads = 0
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'list_workspace_entries') {
        reads += 1
        return Promise.resolve(reads === 1
          ? [{ name: 'old.ts', relativePath: 'old.ts', kind: 'file' }]
          : [{ name: 'new.ts', relativePath: 'new.ts', kind: 'file' }])
      }
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    seedSheet({})
    renderHarness()
    await screen.findByTitle('old.ts')

    fireEvent.click(screen.getByRole('button', { name: '刷新文件树' }))

    expect(await screen.findByTitle('new.ts')).toBeTruthy()
    expect(screen.queryByTitle('old.ts')).toBeNull()
  })

  it('快速连续打开两个文件不会因 render 快照丢失第一个 tab', async () => {
    invoke.mockImplementation((cmd: string, args: { relativePath?: string } | undefined) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([
        { name: 'a.ts', relativePath: 'src/a.ts', kind: 'file' },
        { name: 'b.ts', relativePath: 'src/b.ts', kind: 'file' },
      ])
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult(args?.relativePath ?? '', 'content'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    seedSheet({})
    renderHarness()

    const first = await screen.findByTitle('src/a.ts')
    const second = screen.getByTitle('src/b.ts')
    fireEvent.click(first)
    fireEvent.click(second)

    await waitFor(() => {
      expect(screen.getAllByTitle('src/a.ts').length).toBeGreaterThan(0)
      expect(screen.getAllByTitle('src/b.ts').length).toBeGreaterThan(0)
    })
  })

  it('切换目标 Session 会清空旧 workspace 的 tab，且不在新 workspace 读取旧路径', async () => {
    useIdentityStore.setState({ sessions: [
      { id: 'session-a', agentId: 'agent-test', source: 'ws-a', name: 'Workspace A', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/workspace-a', sessionPrompt: '', skills: [], hooks: [], autoName: '' },
      { id: 'session-b', agentId: 'agent-test', source: 'ws-b', name: 'Workspace B', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/workspace-b', sessionPrompt: '', skills: [], hooks: [], autoName: '' },
    ] })
    const tab: FileTabRecord = { path: 'src/a.ts', viewType: 'file.text' }
    seedSheet({
      targetSessionId: 'session-a',
      openTabs: serializeFileTabs({ version: 3, tabs: [tab], activeKey: fileTabKey(tab) }),
    })
    renderHarness()
    await screen.findByText('const x = 1')

    fireEvent.click(screen.getByLabelText('会话：切换工作区会话'))
    fireEvent.click(await screen.findByText('Workspace B'))

    await screen.findByText('打开一个文件开始阅读')
    expect(screen.queryByTitle('src/a.ts')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('read_workspace_text', expect.objectContaining({
      target: expect.objectContaining({ sessionId: 'session-b' }),
      relativePath: 'src/a.ts',
    }))
  })

  it('AgentSheet 导航回原 Session 时先清空被重定向工作区的 tab，再打开目标文件', async () => {
    useIdentityStore.setState({ sessions: [
      { id: 'session-a', agentId: 'agent-test', source: 'ws-a', name: 'Workspace A', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/workspace-a', sessionPrompt: '', skills: [], hooks: [], autoName: '' },
      { id: 'session-b', agentId: 'agent-test', source: 'ws-b', name: 'Workspace B', profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:/workspace-b', sessionPrompt: '', skills: [], hooks: [], autoName: '' },
    ] })
    const oldTab: FileTabRecord = { path: 'src/only-in-b.ts', viewType: 'file.text' }
    seedSheet({
      targetSessionId: 'session-b',
      openTabs: serializeFileTabs({ version: 3, tabs: [oldTab], activeKey: fileTabKey(oldTab) }),
      [FILE_NAVIGATION_METADATA_KEY]: JSON.stringify({ version: 1, requestId: 'return-to-a', sessionId: 'session-a', path: 'src/a.ts' }),
    })
    renderHarness()

    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/a.ts'))
    expect(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.targetSessionId).toBe('session-a')
    expect(invoke).not.toHaveBeenCalledWith('read_workspace_text', expect.objectContaining({
      target: expect.objectContaining({ sessionId: 'session-a' }),
      relativePath: 'src/only-in-b.ts',
    }))
  })

  it('未保存编辑会阻止 tab 切换，用户确认放弃后才允许离开', async () => {
    const tabs: FileTabRecord[] = [
      { path: 'src/a.ts', viewType: 'file.text' },
      { path: 'src/b.ts', viewType: 'file.text' },
    ]
    seedSheet({ openTabs: serializeFileTabs({ version: 3, tabs, activeKey: fileTabKey(tabs[0]) }) })
    renderHarness()
    // 0-A2：默认可写——直接制造未保存修改
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'unsaved edit')
    await screen.findByText(/未保存/)

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    fireEvent.click(screen.getByTitle('src/b.ts'))
    expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/a.ts')
    expect(editor.state.doc.toString()).toBe('unsaved edit')

    vi.mocked(window.confirm).mockReturnValueOnce(true)
    fireEvent.click(screen.getByTitle('src/b.ts'))
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/b.ts'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('未保存'))
  })

  it('消费 AgentSheet 文件导航意图，并让未保存保护决定是否切换', async () => {
    const tab: FileTabRecord = { path: 'src/a.ts', viewType: 'file.text' }
    seedSheet({
      targetSessionId: 'session-a',
      openTabs: serializeFileTabs({ version: 3, tabs: [tab], activeKey: fileTabKey(tab) }),
    })
    renderHarness()
    replaceFileEditorValue(await waitForFileEditor('const x = 1'), 'unsaved edit')
    await screen.findByText(/未保存/)

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    useWorkspaceStore.getState().patchSheetMetadata('file-1', {
      [FILE_NAVIGATION_METADATA_KEY]: JSON.stringify({ version: 1, requestId: 'request-1', sessionId: 'session-a', path: 'src/b.ts', line: 5 }),
    })
    await waitFor(() => expect(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.[FILE_NAVIGATION_METADATA_KEY]).toBe(''))
    expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/a.ts')

    vi.mocked(window.confirm).mockReturnValueOnce(true)
    useWorkspaceStore.getState().patchSheetMetadata('file-1', {
      [FILE_NAVIGATION_METADATA_KEY]: JSON.stringify({ version: 1, requestId: 'request-2', sessionId: 'session-a', path: 'src/b.ts', line: 5 }),
    })
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/b.ts'))
    expect(parseFileTabs(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.openTabs).tabs)
      .toContainEqual(expect.objectContaining({ path: 'src/b.ts', line: 5 }))
  })

  it('保存请求在途时阻止 tab 切换、关闭 tab 与关闭 FileSheet', async () => {
    const write = deferred<ReturnType<typeof readTextResult>>()
    invoke.mockImplementation((cmd: string, args: { relativePath?: string } | undefined) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult(args?.relativePath ?? '', 'const x = 1'))
      if (cmd === 'write_workspace_text') return write.promise
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    const tabs: FileTabRecord[] = [
      { path: 'src/a.ts', viewType: 'file.text' },
      { path: 'src/b.ts', viewType: 'file.text' },
    ]
    seedSheet({ openTabs: serializeFileTabs({ version: 3, tabs, activeKey: fileTabKey(tabs[0]) }) })
    renderHarness()
    replaceFileEditorValue(await waitForFileEditor('const x = 1'), 'const x = 2')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('保存中…')
    vi.mocked(window.confirm).mockClear()

    useWorkspaceStore.getState().patchSheetMetadata('file-1', {
      [FILE_NAVIGATION_METADATA_KEY]: JSON.stringify({ version: 1, requestId: 'saving-request', sessionId: 'session-a', path: 'src/b.ts' }),
    })

    fireEvent.click(screen.getByTitle('src/b.ts'))
    fireEvent.click(screen.getByRole('button', { name: '关闭 src/a.ts' }))
    expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/a.ts')
    expect(screen.getAllByTitle('src/a.ts').length).toBeGreaterThan(0)
    expect(window.confirm).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.[FILE_NAVIGATION_METADATA_KEY]).not.toBe('')

    const closed = await closeWorkspace('file-1')
    expect(closed).toBe(false)
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.some(sheet => sheet.id === 'file-1')).toBe(true)

    write.resolve(readTextResult('src/a.ts', 'const x = 2'))
    await write.promise
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/b.ts'))
    expect(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.[FILE_NAVIGATION_METADATA_KEY]).toBe('')
  })

  it('SCM 点击变更 → 打开 diff-mode tab（tab 条保留，主区显示 diff，git_diff 带 staged）', async () => {
    seedSheet({})
    renderHarness()
    fireEvent.click(screen.getByLabelText('SCM：查看完整 Git 状态和历史'))
    const row = await screen.findByTitle('src/c.ts')
    fireEvent.click(row)
    await screen.findByText('变更预览')
    // tab 条：diff-mode tab 保留（非替换主区）
    expect(screen.getByTitle('src/c.ts（diff）')).toBeTruthy()
    expect(screen.getByText('src/c.ts（staged）')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('git_diff', {
      target: { sessionId: 'session-a', agentId: 'agent-test', source: 'ws-a', legacyWorkdir: 'C:/workspace' },
      path: 'src/c.ts',
      staged: true,
    })
  })

  it('同路径 file/diff tab 并存，切换不串 mode', async () => {
    const tabs: FileTabRecord[] = [
      { path: 'src/a.ts', mode: 'file' },
      { path: 'src/a.ts', mode: 'diff', staged: true },
    ]
    const state: FileTabState = { version: 2, tabs, activeKey: fileTabKey(tabs[1]) }
    seedSheet({ openTabs: serializeFileTabs(state) })
    renderHarness()
    await screen.findByText('变更预览')
    expect(screen.getByTitle('src/a.ts')).toBeTruthy()
    expect(screen.getByTitle('src/a.ts（diff）')).toBeTruthy()
    fireEvent.click(screen.getByTitle('src/a.ts'))
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/a.ts'))
    expect(screen.queryByText('变更预览')).toBeNull()
    // 切回 diff tab → diff 恢复，文件视图不再
    fireEvent.click(screen.getByTitle('src/a.ts（diff）'))
    await screen.findByText('变更预览')
    expect(document.querySelector('.file-tab-view')).toBeNull()
  })

  it('Views 点击触碰文件 → file-mode tab（普通文件视图）', async () => {
    seedSheet({})
    useWorkspaceStore.setState({ touchedFiles: { [toAgentContextKey({ agentId: 'agent-test', source: 'ws-a' })]: [{ source: 'ws-a', path: 'src/touched.ts', toolKind: 'Edit', at: 1000 }] } })
    renderHarness()
    fireEvent.click(screen.getByLabelText('视图：查看 Agent 最近触碰文件'))
    fireEvent.click(await screen.findByText('src/touched.ts'))
    await waitFor(() => expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/touched.ts'))
    expect(screen.getAllByTitle('src/touched.ts').length).toBeGreaterThan(0)
  })

  it('搜索结果会把行号传入文件 tab，并定位到对应代码行', async () => {
    const content = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n')
    invoke.mockImplementation((cmd: string, args: { relativePath?: string } | undefined) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'workspace_search') return Promise.resolve([{ path: 'src/result.ts', line: 42, lineText: 'line 42' }])
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult(args?.relativePath ?? '', content))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    seedSheet({})
    renderHarness()
    fireEvent.click(screen.getByLabelText('搜索：搜索工作区内容'))
    fireEvent.input(await screen.findByLabelText('工作区搜索'), { target: { value: 'line 42' } })
    fireEvent.click(screen.getByLabelText('搜索'))
    fireEvent.click(await screen.findByTitle('src/result.ts:42'))

    // 0-A1 内核合一：行级 reveal 收编为内核 scrollIntoView + 选区锚（锚定目标行行首）
    await waitFor(() => {
      expect(document.querySelector('.file-tab-view')?.getAttribute('data-path')).toBe('src/result.ts')
      const editor = document.querySelector<HTMLElement>('.file-code-editor .cm-editor')
      const view = editor ? EditorView.findFromDOM(editor) : null
      if (!view) throw new Error('editor not mounted')
      expect(view.state.doc.lineAt(view.state.selection.main.anchor).number).toBe(42)
    })
    const persisted = parseFileTabs(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.openTabs)
    expect(persisted.tabs[0]).toEqual(expect.objectContaining({ path: 'src/result.ts', line: 42 }))
  })
})
