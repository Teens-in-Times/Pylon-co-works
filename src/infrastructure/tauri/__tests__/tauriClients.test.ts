/**
 * Tauri 域 typed clients 行为测试（报告阶段 4）：
 * normalize 后出边界、payload 收口、错误上抛。
 */
import { describe, expect, it } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { createWorkspaceClient } from '../workspaceClient'
import { createGatewayClient } from '../gatewayClient'
import { createBrowserClient } from '../browserClient'
import { normalizeStartupDiagnostics } from '../runtimeLogContracts'

describe('workspaceClient', () => {
  it('listEntries 宽容 normalize（损坏项过滤）', async () => {
    const invoke = new FakeInvoke().register('list_workspace_entries', () => [
      { name: 'b.ts', relativePath: '/a/b.ts', kind: 'file' },
      null,
      { name: 'no-kind', relativePath: '/a/x' },
    ])
    const client = createWorkspaceClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const target = { sessionId: 'session-a', agentId: 'agent-a', source: 'local:一' }
    const entries = (await client.listEntries(target, '/a')) as Array<{ path?: string }>
    expect(entries.some(entry => entry.path === '/a/b.ts')).toBe(true)
  })

  it('gitStatus 发送无参并 normalize', async () => {
    const invoke = new FakeInvoke().register('git_status', () => [
      { path: 'a.ts', status: 'M' },
    ])
    const client = createWorkspaceClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const target = { sessionId: 'session-a', agentId: 'agent-a', source: 'local:一' }
    const status = (await client.gitStatus(target)) as Array<{ path?: string }>
    expect(status[0]?.path).toBe('a.ts')
    expect(invoke.calls).toEqual([{ cmd: 'git_status', args: { target } }])
  })

  it('gitStatusWithBranch normalize branch + entries（ISSUE-15 W4）', async () => {
    const invoke = new FakeInvoke().register('git_status_with_branch', () => ({
      branch: { branch: 'feature/x', detached: false, head: 'abc123' },
      entries: [{ path: 'b.ts', status: ' M', staged: false }],
    }))
    const client = createWorkspaceClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const target = { sessionId: 'session-a', agentId: 'agent-a', source: 'local:一' }
    const result = (await client.gitStatusWithBranch(target)) as {
      branch: { branch: string | null; detached: boolean; head: string | null }
      entries: Array<{ path?: string }>
    }
    expect(result.branch.branch).toBe('feature/x')
    expect(result.branch.detached).toBe(false)
    expect(result.branch.head).toBe('abc123')
    expect(result.entries[0]?.path).toBe('b.ts')
    expect(invoke.calls).toEqual([{ cmd: 'git_status_with_branch', args: { target } }])
  })

  it('Git 写操作只映射受限命令与结构化 payload', async () => {
    const result = { summary: 'ok', status: { branch: { branch: 'main', detached: false, head: 'abc' }, entries: [] } }
    const invoke = new FakeInvoke()
      .register('git_stage', () => result)
      .register('git_unstage', () => result)
      .register('git_commit', () => result)
      .register('git_create_branch', () => result)
      .register('git_switch_branch', () => result)
      .register('git_pull', () => result)
      .register('git_push', () => result)
    const client = createWorkspaceClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const target = { sessionId: 'session-a', agentId: 'agent-a', source: 'source-a', legacyWorkdir: 'C:/repo' }
    await client.gitStage(target, ['a b.ts'])
    await client.gitUnstage(target, ['a b.ts'])
    await client.gitCommit(target, 'message')
    await client.gitCreateBranch(target, 'feature/a')
    await client.gitSwitchBranch(target, 'main')
    await client.gitPull(target)
    await client.gitPush(target)
    expect(invoke.calls).toEqual([
      { cmd: 'git_stage', args: { target, paths: ['a b.ts'] } },
      { cmd: 'git_unstage', args: { target, paths: ['a b.ts'] } },
      { cmd: 'git_commit', args: { target, message: 'message' } },
      { cmd: 'git_create_branch', args: { target, name: 'feature/a' } },
      { cmd: 'git_switch_branch', args: { target, name: 'main' } },
      { cmd: 'git_pull', args: { target } },
      { cmd: 'git_push', args: { target } },
    ])
  })

  it('#368 stash/删分支/log 图命令收口与宽容 normalize', async () => {
    const opResult = { summary: 'ok', status: { branch: { branch: 'main', detached: false, head: 'abc' }, entries: [] } }
    const invoke = new FakeInvoke()
      .register('git_stash_list', () => [{ id: 'stash@{0}', subject: 'WIP on main' }, { id: '', subject: 'broken' }])
      .register('git_stash_push', () => opResult)
      .register('git_stash_pop', () => opResult)
      .register('git_delete_branch', () => opResult)
      .register('git_log_graph', () => ({
        commits: [{ hash: 'a1b2c3d4e5', parents: ['f1e2d3c4b5a6'], author: 'P', date: 'not-a-number', subject: 's', refs: 'HEAD -> main' }],
        hasMore: true,
      }))
    const client = createWorkspaceClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const target = { sessionId: 'session-a', agentId: 'agent-a', source: 'source-a', legacyWorkdir: 'C:/repo' }
    const stashes = await client.gitStashList(target)
    expect(stashes).toEqual([{ id: 'stash@{0}', subject: 'WIP on main' }])
    await client.gitStashPush(target, { message: 'wip', includeUntracked: true })
    await client.gitStashPop(target, 2)
    await client.gitDeleteBranch(target, 'feature/a')
    const page = await client.gitLogGraph(target, { skip: 5, limit: 50, firstParent: true, path: 'a.ts' })
    expect(invoke.calls).toEqual([
      { cmd: 'git_stash_list', args: { target } },
      { cmd: 'git_stash_push', args: { target, message: 'wip', includeUntracked: true } },
      { cmd: 'git_stash_pop', args: { target, index: 2 } },
      { cmd: 'git_delete_branch', args: { target, name: 'feature/a' } },
      { cmd: 'git_log_graph', args: { target, skip: 5, limit: 50, firstParent: true, path: 'a.ts' } },
    ])
    expect(page.hasMore).toBe(true)
    expect(page.commits[0]?.hash).toBe('a1b2c3d4e5')
    expect(page.commits[0]?.refs).toBe('HEAD -> main')
    expect(page.commits[0]?.date).toBe(0)
  })
})

describe('gatewayClient', () => {
  it('status normalize 后出边界', async () => {
    const invoke = new FakeInvoke().register('gateway_status', () => ({
      adapters: ['qq'],
      routes: [{ source: 'qq:group:1', agentId: 'peri' }],
      inject: null,
    }))
    const client = createGatewayClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const status = (await client.status()) as { routes?: Array<{ source?: string }> }
    expect(status.routes?.[0]?.source).toBe('qq:group:1')
  })

  it('updateAgentsConfig 读取 revision 后执行 CAS 写入', async () => {
    const invoke = new FakeInvoke()
      .register('agent_config_snapshot', () => ({ revision: 'gateway-rev-1', agents: [] }))
      .register('update_agents_config', () => ({ revision: 'gateway-rev-2' }))
    const client = createGatewayClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    const payload = { scope: 'gateway', config: { gateway: { routes: [] } } }
    await client.updateAgentsConfig(payload)
    expect(invoke.calls).toEqual([
      { cmd: 'agent_config_snapshot', args: {} },
      { cmd: 'update_agents_config', args: { ...payload, expectedRevision: 'gateway-rev-1' } },
    ])
  })

  it('I12-W5 mutation 命令映射（create/update/start/stop/restart/remove/setCredentials）', async () => {
    const instance = { id: 'bot-a', platform: 'qq', label: 'A', enabled: true, autoStart: false, status: 'stopped', lastError: null, credentialStatus: 'missing', credentialRef: null }
    const invoke = new FakeInvoke()
      .register('gateway_instance_create', () => instance)
      .register('gateway_instance_update', () => ({ ...instance, label: 'B' }))
      .register('gateway_instance_start', () => ({ ...instance, status: 'starting' }))
      .register('gateway_instance_stop', () => instance)
      .register('gateway_instance_restart', () => ({ ...instance, status: 'starting' }))
      .register('gateway_instance_remove', () => null)
      .register('gateway_instance_set_credentials', () => ({ ...instance, credentialStatus: 'configured' }))
    const client = createGatewayClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })

    await client.createInstance({ id: 'bot-a', platform: 'qq', label: 'A', enabled: true, autoStart: false })
    expect(invoke.calls.at(-1)).toEqual({ cmd: 'gateway_instance_create', args: { input: { id: 'bot-a', platform: 'qq', label: 'A', enabled: true, autoStart: false } } })
    await client.updateInstance('bot-a', { label: 'B' })
    expect(invoke.calls.at(-1)).toEqual({ cmd: 'gateway_instance_update', args: { id: 'bot-a', input: { label: 'B' } } })
    await client.startInstance('bot-a')
    expect(invoke.calls.at(-1)).toEqual({ cmd: 'gateway_instance_start', args: { id: 'bot-a' } })
    await client.stopInstance('bot-a')
    expect(invoke.calls.at(-1)).toEqual({ cmd: 'gateway_instance_stop', args: { id: 'bot-a' } })
    await client.restartInstance('bot-a')
    expect(invoke.calls.at(-1)).toEqual({ cmd: 'gateway_instance_restart', args: { id: 'bot-a' } })
    await client.removeInstance('bot-a')
    expect(invoke.calls.at(-1)).toEqual({ cmd: 'gateway_instance_remove', args: { id: 'bot-a' } })
    const cred = await client.setInstanceCredentials('bot-a', 'app:secret')
    expect(invoke.calls.at(-1)).toEqual({ cmd: 'gateway_instance_set_credentials', args: { id: 'bot-a', secret: 'app:secret' } })
    expect(cred.credentialStatus).toBe('configured')
  })
})

describe('normalizeStartupDiagnostics', () => {
  it('缺失/损坏域保持缺省（不抛错）', () => {
    const diagnostics = normalizeStartupDiagnostics({
      agentConfig: { status: 'ready' },
      gatewayConfig: { status: 'ready' },
      prism: { status: 'ready' },
    })
    expect(diagnostics.agentConfig).toEqual({ status: 'ready' })
    // #482：storage 模式诊断已退役，多余字段不得混入归一结果。
    const withUnknownFields = normalizeStartupDiagnostics({ agentConfig: null, gatewayConfig: null, prism: null, storage: 'bad' })
    expect(Object.keys(withUnknownFields).sort()).toEqual(['agentConfig', 'gatewayConfig', 'prism'])
  })
})

describe('browserClient', () => {
  it('browser commands use the Rust command argument contract', async () => {
    const invoke = new FakeInvoke()
    invoke.register('browser_new_tab', () => null)
    invoke.register('browser_select_tab', () => null)
    invoke.register('browser_close_tab', () => null)
    invoke.register('browser_set_zoom', () => null)
    invoke.register('browser_set_bounds', () => null)
    invoke.register('browser_scroll', () => null)
    invoke.register('browser_download', () => ({ status: 'started' }))
    invoke.register('browser_close', () => null)
    const client = createBrowserClient({ invoke: (cmd, args) => invoke.invoke(cmd, args) })
    await client.newTab()
    await client.selectTab(2)
    await client.closeTab(2)
    await client.setZoom(90)
    await client.setBounds({ x: 0, y: 0, width: 100, height: 100 })
    await client.scroll({ deltaX: 4, deltaY: 120 })
    await client.download('https://example.com/archive.zip', 'archive.zip')
    await client.download('https://example.com/readme.txt')
    await client.close()
    expect(invoke.calls).toEqual([
      { cmd: 'browser_new_tab', args: {} },
      { cmd: 'browser_select_tab', args: { tabId: 2 } },
      { cmd: 'browser_close_tab', args: { tabId: 2 } },
      { cmd: 'browser_set_zoom', args: { zoomPercent: 90 } },
      { cmd: 'browser_set_bounds', args: { bounds: { x: 0, y: 0, width: 100, height: 100 } } },
      { cmd: 'browser_scroll', args: { deltaX: 4, deltaY: 120 } },
      { cmd: 'browser_download', args: { url: 'https://example.com/archive.zip', filename: 'archive.zip' } },
      { cmd: 'browser_download', args: { url: 'https://example.com/readme.txt' } },
      { cmd: 'browser_close', args: {} },
    ])
  })
})
