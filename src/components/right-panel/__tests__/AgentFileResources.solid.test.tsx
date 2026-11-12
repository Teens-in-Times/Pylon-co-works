// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentFileResources from '../AgentFileResources.solid.tsx'
import { getFileWorkbenchRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import type { WorkspaceSession } from '../../../domains/session/workspaceSession.ts'
import type { WorkspaceTextPreview } from '../../../contracts/workspaceFiles.ts'
import { reportRuntimeError } from '../../../app/runtimeError.ts'

vi.mock('../../../app/runtimeError.ts', () => ({ reportRuntimeError: vi.fn(), resolveRuntimeErrors: vi.fn() }))

const registrations: AsyncDisposable[] = []
afterEach(async () => { cleanup(); await Promise.all(registrations.splice(0).map(entry => entry.dispose())); vi.clearAllMocks() })
const session = (id: string) => ({ id, source: id, agentId: 'test-agent', name: id, workdir: '/workspace' }) as WorkspaceSession
const preview = (content: string): WorkspaceTextPreview => ({ relativePath: 'notes.md', content, encoding: 'utf-8', totalBytes: content.length, bytesRead: content.length, truncated: false })

describe('Agent file resource preview', () => {
  it.each([
    { workspaceId: 'workspace-a', workdir: '' },
    { workspaceId: undefined, workdir: '/workspace' },
  ])('only requests files while the session has a directory target: %j', async binding => {
    const listEntries = vi.fn(async () => [{ kind: 'file' as const, label: 'notes.md', path: 'notes.md' }])
    const readText = vi.fn(async () => preview('Bound workspace preview'))
    registrations.push(getFileWorkbenchRegistry().register(createPluginIdentity('test.resource.files', 'binding'), {
      kind: 'file-provider', id: 'test.resources', priority: -100, fallback: false,
      provider: { id: 'test.resources', canHandle: () => true, listEntries, readText },
    }))
    const unbound = { ...session('a'), workdir: '', workspaceId: undefined }
    const [owner, setOwner] = createSignal<WorkspaceSession>(unbound)
    render(() => <AgentFileResources session={owner()} touchedFiles={[{ path: 'notes.md' }]} />)
    expect(screen.getByText('尚未绑定工作目录')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刷新文件树' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'notes.md' })).not.toBeInTheDocument()
    expect(listEntries).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
    expect(reportRuntimeError).not.toHaveBeenCalled()

    setOwner({ ...unbound, ...binding })
    await screen.findByRole('button', { name: '刷新文件树' })
    await waitFor(() => expect(listEntries).toHaveBeenCalledOnce())
    expect(listEntries).toHaveBeenCalledWith(expect.objectContaining(binding.workspaceId ? { workspaceId: binding.workspaceId } : { legacyWorkdir: binding.workdir }), '')
    fireEvent.click((await screen.findAllByRole('button', { name: 'notes.md' }))[0])
    expect(await screen.findByText('Bound workspace preview')).toBeInTheDocument()

    setOwner(unbound)
    expect(screen.getByText('尚未绑定工作目录')).toBeInTheDocument()
    expect(screen.queryByText('Bound workspace preview')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刷新文件树' })).not.toBeInTheDocument()
    expect(listEntries).toHaveBeenCalledOnce()
    expect(readText).toHaveBeenCalledOnce()
    expect(reportRuntimeError).not.toHaveBeenCalled()
  })

  it('keeps reporting real provider errors for a bound workspace', async () => {
    const error = new Error('工作目录访问被拒绝')
    const listEntries = vi.fn(async () => { throw error })
    registrations.push(getFileWorkbenchRegistry().register(createPluginIdentity('test.resource.files', 'error'), {
      kind: 'file-provider', id: 'test.resources', priority: -100, fallback: false,
      provider: { id: 'test.resources', canHandle: () => true, listEntries, readText: vi.fn() },
    }))
    render(() => <AgentFileResources session={session('a')} rootPath="/workspace" touchedFiles={[]} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('工作目录访问被拒绝')
    expect(listEntries).toHaveBeenCalledOnce()
    expect(reportRuntimeError).toHaveBeenCalledWith('读取工作区', error, undefined, expect.objectContaining({ source: 'file.tree' }))
  })

  it('reads the selected file through the registered provider without leaving chat or writing', async () => {
    const readText = vi.fn(async () => preview('Read me beside the chat'))
    const writeText = vi.fn()
    registrations.push(getFileWorkbenchRegistry().register(createPluginIdentity('test.resource.files', 'one'), {
      kind: 'file-provider', id: 'test.resources', priority: -100, fallback: false,
      provider: { id: 'test.resources', canHandle: () => true, listEntries: async () => [{ kind: 'file', label: 'notes.md', path: 'notes.md' }], readText, writeText },
    }))
    render(() => <AgentFileResources session={session('a')} rootPath="/workspace" touchedFiles={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'notes.md' }))
    expect(await screen.findByText('Read me beside the chat')).toBeInTheDocument()
    expect(screen.getByText('只读预览')).toBeInTheDocument()
    expect(writeText).not.toHaveBeenCalled()
    expect(readText).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '返回文件列表' }))
    expect(await screen.findByRole('button', { name: 'notes.md' })).toBeInTheDocument()
  })

  it('aborts old owner reads and ignores a provider that resolves after the session changed', async () => {
    let resolveRead!: (value: WorkspaceTextPreview) => void
    let requestSignal: AbortSignal | undefined
    registrations.push(getFileWorkbenchRegistry().register(createPluginIdentity('test.resource.files', 'two'), {
      kind: 'file-provider', id: 'test.resources', priority: -100, fallback: false,
      provider: { id: 'test.resources', canHandle: () => true, listEntries: async () => [{ kind: 'file', label: 'notes.md', path: 'notes.md' }], readText: (_target, _path, signal) => { requestSignal = signal; return new Promise(resolve => { resolveRead = resolve }) } },
    }))
    const [owner, setOwner] = createSignal(session('a'))
    render(() => <AgentFileResources session={owner()} rootPath="/workspace" touchedFiles={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'notes.md' }))
    await waitFor(() => expect(requestSignal).toBeDefined())
    setOwner(session('b'))
    expect(requestSignal?.aborted).toBe(true)
    resolveRead(preview('stale owner data'))
    await screen.findByRole('button', { name: 'notes.md' })
    expect(screen.queryByText('stale owner data')).not.toBeInTheDocument()
    expect(screen.queryByText('只读预览')).not.toBeInTheDocument()
  })
})
