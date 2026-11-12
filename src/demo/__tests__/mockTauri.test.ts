// 迁移自 scripts/test-demo-mock-backend.mts（P91 A1）。
// 浏览器模式假 Tauri 后端（静态演示全景）：mockInvokeCommand 纯命令路由——
// 已知命令返回兼容 normalize 的形状；未知命令/browser_start（CDP 组）reject 走「待后端」。
// 注意：mock 后端有状态（update_agents_config revision 递增），本文件按原脚本顺序执行。
import { describe, expect, it } from 'vitest'
import { mockInvokeCommand } from '../mockTauri.ts'
import { createGatewayClient } from '../../infrastructure/tauri/gatewayClient.ts'

describe('demo mock backend 命令路由（原 test-demo-mock-backend.mts）', () => {
  it('Gateway typed client routes catalog and instance mutations through the preview model', async () => {
    const client = createGatewayClient({ invoke: (command, args) => mockInvokeCommand(command, args as Record<string, unknown> | undefined) })
    expect((await client.catalog()).find(item => item.platform === 'qq')?.availability).toBe('builtIn')
    const input = { id: 'qq-integration', platform: 'qq', label: '集成测试', enabled: true, autoStart: false }
    await client.createInstance(input)
    expect(await client.instances()).toEqual(expect.arrayContaining([expect.objectContaining({ id: input.id })]))
    await client.updateInstance(input.id, { label: '已更新' })
    await client.setInstanceCredentials(input.id, 'app:preview-secret')
    expect(await client.startInstance(input.id)).toMatchObject({ status: 'error', lastError: expect.stringContaining('浏览器预览') })
    expect(await client.restartInstance(input.id)).toMatchObject({ status: 'error' })
    await client.stopInstance(input.id)
    await client.removeInstance(input.id)
    expect((await client.instances()).some(instance => instance.id === input.id)).toBe(false)
  })

  it('数据类命令形状', async () => {
    const agents = await mockInvokeCommand('list_agents') as Array<{ id: string; name: string }>
    expect(Array.isArray(agents) && agents.length >= 2, 'list_agents 必须返回 agent 数组').toBe(true)
    for (const agent of agents) {
      expect(typeof agent.id).toBe('string')
      expect(typeof agent.name).toBe('string')
    }

    const entries = await mockInvokeCommand('list_workspace_entries', { relativePath: '' }) as Array<{ name: string; relativePath: string; kind: string }>
    expect(entries.some(e => e.kind === 'directory' && e.relativePath === 'src'), '根目录必须含 src 目录').toBe(true)
    const srcEntries = await mockInvokeCommand('list_workspace_entries', { relativePath: 'src' }) as Array<{ kind: string }>
    expect(srcEntries.length > 0, 'src 必须有子项').toBe(true)
    expect(await mockInvokeCommand('list_workspace_entries', { relativePath: 'no-such-dir' }), '未知目录返回空（FileTree 空目录态）').toEqual([])

    const text = await mockInvokeCommand('read_workspace_text', { relativePath: 'src/sheets/AgentSheetView.tsx' }) as { bytesRead: number; totalBytes: number; truncated: boolean; encoding?: string; content: string }
    expect(typeof text.bytesRead, 'read_workspace_text 必须带 bytesRead').toBe('number')
    expect(typeof text.totalBytes).toBe('number')
    expect(typeof text.truncated).toBe('boolean')
    expect(text.content.length > 0).toBe(true)

    const git = await mockInvokeCommand('git_status') as Array<{ path: string; status: string; staged: boolean }>
    expect(git.length > 0, 'git_status 必须有条目').toBe(true)
    for (const entry of git) {
      expect(['M', 'A', 'D', 'R', '??'].includes(entry.status), `porcelain 码原样保留（${entry.status}）`).toBe(true)
      expect(typeof entry.staged).toBe('boolean')
    }
    const history = await mockInvokeCommand('git_history') as Array<{ hash: string; subject: string }>
    expect(Boolean(history[0]?.hash && history[0]?.subject), 'git_history 条目必须含 hash/subject').toBe(true)
    expect(typeof await mockInvokeCommand('git_diff')).toBe('string')

    const gateway = await mockInvokeCommand('gateway_status') as { adapters: string[]; routes: unknown[]; qq: unknown; inject: unknown }
    expect(Array.isArray(gateway.adapters), 'gateway adapters 必须为数组').toBe(true)
    expect(Array.isArray(gateway.routes) && gateway.routes.length > 0, 'gateway routes 必须有路由').toBe(true)
    expect('inject' in gateway, 'gateway 必须含 inject').toBe(true)
    const platformSessions = await mockInvokeCommand('gateway_sessions') as Array<{ agentId: string; source: string; periId: string }>
    expect(platformSessions.length >= 2, 'gateway_sessions 必须有平台会话行').toBe(true)
    for (const row of platformSessions) {
      expect(typeof row.agentId).toBe('string')
      expect(typeof row.source).toBe('string')
      expect(typeof row.periId).toBe('string')
    }

    const sessions = await mockInvokeCommand('list_persisted_sessions') as Array<{ id: string; updatedAt: number }>
    expect(sessions.length >= 4, '存档列表必须≥4 条').toBe(true)
    for (const s of sessions) {
      expect(typeof s.id === 'string' && s.id.length > 0).toBe(true)
      expect(typeof s.updatedAt).toBe('number')
    }

    const logs = await mockInvokeCommand('list_runtime_logs') as Array<{ id: number; level: string; source: string; message: string }>
    expect(logs.length > 0, '运行日志必须有条目').toBe(true)
    for (const entry of logs) {
      expect(typeof entry.id).toBe('number')
      expect(['trace', 'debug', 'info', 'warn', 'error'].includes(entry.level), `level 必须合法（${entry.level}）`).toBe(true)
      expect(entry.message.length > 0).toBe(true)
    }

    const diag = await mockInvokeCommand('startup_diagnostics') as { agentConfig: { status: string }; gatewayConfig: { status: string }; prism: { status: string } }
    expect(typeof diag.agentConfig.status).toBe('string')
    expect(typeof diag.prism.status).toBe('string')

    const search = await mockInvokeCommand('workspace_search', { query: 'AgentSheetView' }) as Array<{ path: string; line: number; lineText: string }>
    expect(search.length > 0 && Boolean(search[0]?.path), 'workspace_search 必须返回 path 命中').toBe(true)
  })

  it('会话类命令：SessionResponse 兼容（configOptions 含 model/mode）', async () => {
    const res = await mockInvokeCommand('load_persisted_session', { periId: 'peri-demo-1' }) as { sessionId: string; configOptions: Array<{ id: string; currentValue: unknown }> }
    expect(typeof res.sessionId).toBe('string')
    const ids = res.configOptions.map(option => option.id)
    expect(ids.includes('model') && ids.includes('mode'), 'configOptions 必须含 model/mode').toBe(true)
    const fresh = await mockInvokeCommand('new_session', {}) as { sessionId: string; configOptions: Array<{ id: string }> }
    expect(typeof fresh.sessionId).toBe('string')
    expect(fresh.configOptions.map(option => option.id), 'new_session 走同一 configOptions 形状').toEqual(ids)
  })

  it('ack 类命令不 reject（防错误噪音）', async () => {
    for (const cmd of ['send_message', 'switch_agent', 'set_approval_mode', 'close_session', 'export_session', 'clear_runtime_logs']) {
      await mockInvokeCommand(cmd, {}).catch(() => { throw new Error(`${cmd} 不应 reject`) })
    }
    await mockInvokeCommand('update_agents_config', { expectedRevision: 'demo-config-1', config: {} })
  })

  it('诚实保留：browser_start 返回可观察状态，未知命令 reject 含 not found', async () => {
    const browserStart = await mockInvokeCommand('browser_start', { lazy: true }) as { phase?: string }
    expect(typeof browserStart.phase, 'browser_start 在演示后端返回可观察状态').toBe('string')
    await expect(mockInvokeCommand('totally_unknown_cmd')).rejects.toThrow(/not found/i)
  })

  it('plugin:dialog|save 返回绝对路径（HistorySheet 导出预检可过）', async () => {
    const savePath = await mockInvokeCommand('plugin:dialog|save', { defaultPath: 'session-peri-demo-1.md' })
    expect(typeof savePath).toBe('string')
    expect(String(savePath), '导出路径必须为绝对路径').toMatch(/^[A-Za-z]:[\\/]/)
  })
})
