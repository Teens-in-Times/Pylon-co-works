// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { useIdentityStore } from '../../../domains/identity/identityStore.ts'
import { useWorkspaceEntityStore } from '../../../domains/workspace/workspaceEntityStore.ts'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore.ts'
import { createSheetState } from '../../../domains/workspace/sheetState.ts'
import {
  FILE_NAVIGATION_METADATA_KEY,
  openFileLinkFromEvent,
  openResourceInFileSheet,
  parsePendingFileNavigation,
  resolveFileNavigationTarget,
} from '../fileSheetNavigation.ts'

describe('FileSheet resource navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    useWorkspaceStore.setState({ workspaceSheets: createSheetState(), lastPersistError: null })
    useWorkspaceEntityStore.setState({
      workspaces: [{ id: 'workspace-a', agentId: 'agent-a', name: 'Repo', rootPath: 'C:\\repo', createdAt: 1, lastActiveAt: 1, skills: [], mcpServerIds: [], hookPluginIds: [] }],
      hydrated: true,
    })
    useIdentityStore.setState({
      sessions: [{
        id: 'session-a', agentId: 'agent-a', name: 'Task', source: 'source-a', profileId: 'profile-a',
        createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: 'C:\\stale', workspaceId: 'workspace-a',
        sessionPrompt: '', skills: [], hooks: [], autoName: '',
      }],
    })
  })

  it('resolves relative, in-root absolute and file URI paths with line locations', () => {
    expect(resolveFileNavigationTarget('./src/main.ts#L12', 'C:\\repo')).toEqual({ path: 'src/main.ts', line: 12 })
    expect(resolveFileNavigationTarget({ path: 'c:\\REPO\\src\\main.ts', selection: { start: { line: 7 } } }, 'C:\\repo')).toEqual({ path: 'src/main.ts', line: 7 })
    expect(resolveFileNavigationTarget({ path: 'src/first.ts', selection: { start: { line: 0 } } }, 'C:\\repo')).toEqual({ path: 'src/first.ts', line: 1 })
    expect(resolveFileNavigationTarget({ uri: 'file:///C:/repo/docs/a%20b.md:4' }, 'C:\\repo')).toEqual({ path: 'docs/a b.md', line: 4 })
  })

  it('rejects traversal, external protocols and absolute paths outside the workspace', () => {
    expect(resolveFileNavigationTarget('../secret.txt', 'C:\\repo')).toBeNull()
    expect(resolveFileNavigationTarget('https://example.com/a.ts', 'C:\\repo')).toBeNull()
    expect(resolveFileNavigationTarget('C:\\other\\a.ts', 'C:\\repo')).toBeNull()
    expect(resolveFileNavigationTarget('/repo-prefix/a.ts', '/repo')).toBeNull()
  })

  it('opens one FileSheet per session and queues each navigation instead of mutating tabs externally', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    expect(openResourceInFileSheet('session-a', { path: 'C:\\repo\\src\\a.ts', line: 3 })).toBe(true)
    const first = useWorkspaceStore.getState().workspaceSheets
    expect(first.sheets).toHaveLength(1)
    expect(first.sheets[0]).toMatchObject({ kind: 'file', singletonKey: 'file:session:session-a' })
    expect(first.sheets[0]?.metadata?.openTabs).toBeUndefined()
    expect(parsePendingFileNavigation(first.sheets[0]?.metadata?.[FILE_NAVIGATION_METADATA_KEY])).toMatchObject({
      sessionId: 'session-a', path: 'src/a.ts', line: 3,
    })

    expect(openResourceInFileSheet('session-a', './src/b.ts#L9')).toBe(true)
    const second = useWorkspaceStore.getState().workspaceSheets
    expect(second.sheets).toHaveLength(1)
    expect(parsePendingFileNavigation(second.sheets[0]?.metadata?.[FILE_NAVIGATION_METADATA_KEY])).toMatchObject({
      sessionId: 'session-a', path: 'src/b.ts', line: 9,
    })
  })

  it('does not externally rebind a reused FileSheet that was manually retargeted', () => {
    const sheet = {
      id: 'file-a', kind: 'file', title: 'Files', singletonKey: 'file:session:session-a',
      createdAt: 1, lastFocusedAt: 1, metadata: { targetSessionId: 'session-b', openTabs: 'old-tabs' },
    }
    useWorkspaceStore.setState({ workspaceSheets: createSheetState([sheet], 'file-a') })

    expect(openResourceInFileSheet('session-a', 'src/a.ts')).toBe(true)
    const metadata = useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata
    expect(metadata?.targetSessionId).toBe('session-b')
    expect(metadata?.openTabs).toBe('old-tabs')
    expect(parsePendingFileNavigation(metadata?.[FILE_NAVIGATION_METADATA_KEY])).toMatchObject({
      sessionId: 'session-a', path: 'src/a.ts',
    })
  })

  it('intercepts workspace Markdown anchors but leaves external links to the browser', () => {
    const local = document.createElement('a')
    local.href = './src/main.ts#L6'
    const localChild = document.createElement('span')
    local.append(localChild)
    const preventLocal = vi.fn()
    expect(openFileLinkFromEvent({ target: localChild, preventDefault: preventLocal }, 'session-a')).toBe(true)
    expect(preventLocal).toHaveBeenCalledOnce()
    expect(parsePendingFileNavigation(useWorkspaceStore.getState().workspaceSheets.sheets[0]?.metadata?.[FILE_NAVIGATION_METADATA_KEY]))
      .toMatchObject({ path: 'src/main.ts', line: 6 })

    const external = document.createElement('a')
    external.href = 'https://example.com/docs'
    const preventExternal = vi.fn()
    expect(openFileLinkFromEvent({ target: external, preventDefault: preventExternal }, 'session-a')).toBe(false)
    expect(preventExternal).not.toHaveBeenCalled()
  })
})
