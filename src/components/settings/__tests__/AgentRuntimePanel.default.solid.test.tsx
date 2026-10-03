// @vitest-environment jsdom
// #515 W1：迁移自 AgentRuntimePanel.default.test.tsx（React RTL → Solid 实体直连）。
// 断言改写点登记（断言集零缩减）：
// 1. render(<X/>) → render(() => <X/>)；显式 afterEach(cleanup())。
// 2. 文本输入的 fireEvent.change → fireEvent.input（Solid onInput 等价 React onChange
//    的即时输入流）；启动入口 <select> 保留 fireEvent.change（原生 change 事件）。
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import AgentRuntimePanel from '../AgentRuntimePanel.solid.tsx'
import { useIdentityStore } from '../../../domains/identity/identityStore'
import { useWorkspaceStore } from '../../../domains/workspace/workspaceStore'
import { resetStores } from '../../../test/resetStores'
import { explainErrorCode } from '../../../app/errorCodeExplanations.ts'

afterEach(() => cleanup())

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})
// P91 §9 夹具收敛：invoke 桥接到共享 FakeInvoke。未注册命令 resolve null
//（对齐原 mockImplementation 的兜底返回）；断言面全部经由桥接 vi.fn，保持原样。
// per-test 整体重接 = 重新赋值 fakeInvoke（桥接闭包读取外层变量，等价原整体替换 mockImplementation）。
class NullFallbackFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return null
      throw error
    })
  }
}

let fakeInvoke: NullFallbackFakeInvoke

describe('AgentRuntimePanel 默认 Agent', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [
        { id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', args: ['acp', 'work space'], effectiveArgs: ['acp', 'work space', '--model', 'demo'], default: true },
        { id: 'hermes', name: 'Hermes', transport: 'subprocess', exe: 'hermes', args: ['acp'], effectiveArgs: ['acp'], default: false },
      ],
    })
    fakeInvoke = new NullFallbackFakeInvoke()
    invoke.mockReset()
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => fakeInvoke.invoke(command, args))
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [], diagnostics: [], elapsedMs: 0, truncated: false }),
      agent_config_snapshot: () => Promise.reject({ code: 'config_read_only', message: 'Config error: 当前为嵌入配置' }),
      update_agents_config: () => Promise.reject({ code: 'config_read_only', message: 'Config error: 当前为嵌入配置' }),
      initialize_agents_config: () => Promise.resolve({ applied: true }),
      list_agents: () => Promise.resolve([
        { id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', default: false },
        { id: 'hermes', name: 'Hermes', transport: 'subprocess', exe: 'hermes', default: true },
      ]),
    })
  })

  it('首次打开配置页会自动探测本机 Agent，不要求用户先理解重新探测入口', async () => {
    render(() => <AgentRuntimePanel />)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('detect_agent_runtimes', {
      detectorIds: ['builtin.detector.claude-code', 'builtin.detector.codex', 'builtin.detector.hermes', 'builtin.detector.peri'],
      // 自动扫描不强制（可吃 TTL 缓存）；用户点「重新探测」才 force=true。
      force: false,
    }))
  })

  it('自动探测没有结果时解释下一步，并可直接进入手动添加', async () => {
    render(() => <AgentRuntimePanel />)

    expect(await screen.findByText(/未发现可自动配置的 ACP Agent/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '手动添加' }))
    expect(screen.getByLabelText('新建 Agent 配置')).toBeInTheDocument()
  })

  it('嵌入配置只读时物化当前配置后设置默认 Agent', async () => {
    render(() => <AgentRuntimePanel />)

    const hermesCard = screen.getByText('Hermes').closest('.agent-runtime-card')
    expect(hermesCard).not.toBeNull()
    fireEvent.click(within(hermesCard as HTMLElement).getByRole('button', { name: '设为默认' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('initialize_agents_config', {
      agentId: 'hermes',
      config: { default: true },
    }))
    expect(await screen.findByText('已将 hermes 设为默认')).toBeInTheDocument()
  })

  it('外部配置新建 Agent 时发送结构化单 Agent DTO，而不是嵌套 agents 文档', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.input(screen.getByLabelText('新建 Agent id'), { target: { value: 'custom-agent' } })
    fireEvent.input(screen.getByLabelText('新建 Agent name'), { target: { value: 'Agent: #1' } })
    fireEvent.input(screen.getByLabelText('新建 Agent exe'), { target: { value: 'C:\\Program Files\\Agent\\agent.exe' } })
    fireEvent.input(screen.getByLabelText('新建 Agent 参数 1'), { target: { value: '--profile' } })
    const createForm = screen.getByLabelText('新建 Agent 配置')
    fireEvent.click(within(createForm).getByRole('button', { name: '添加参数' }))
    fireEvent.input(screen.getByLabelText('新建 Agent 参数 2'), { target: { value: 'work space' } })
    fireEvent.click(within(createForm).getByRole('button', { name: '添加参数' }))
    fireEvent.input(screen.getByLabelText('新建 Agent 参数 3'), { target: { value: '' } })
    fireEvent.click(within(createForm).getByRole('button', { name: '添加参数' }))
    fireEvent.input(screen.getByLabelText('新建 Agent 参数 4'), { target: { value: 'a"b' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_create',
      agentId: 'custom-agent',
      config: {
        name: 'Agent: #1',
        provider: 'custom',
        transport: 'subprocess',
        exe: 'C:\\Program Files\\Agent\\agent.exe',
        args: ['--profile', 'work space', '', 'a"b'],
        default: false,
      },
      expectedRevision: 'rev-1',
    }))
  })

  it('嵌入配置首次新建时使用结构化 whole document 初始化', async () => {
    render(() => <AgentRuntimePanel />)

    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.input(screen.getByLabelText('新建 Agent id'), { target: { value: 'new-agent' } })
    fireEvent.input(screen.getByLabelText('新建 Agent name'), { target: { value: 'New: #1' } })
    fireEvent.input(screen.getByLabelText('新建 Agent exe'), { target: { value: 'C:\\Agent Files\\agent.exe' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    const node = {
      name: 'New: #1',
      provider: 'custom',
      transport: 'subprocess',
      exe: 'C:\\Agent Files\\agent.exe',
      args: ['acp'],
      default: false,
    }
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_create',
      agentId: 'new-agent',
      config: node,
    }))
    expect(invoke).toHaveBeenCalledWith('initialize_agents_config', {
      agentId: 'new-agent',
      config: { agents: { 'new-agent': node } },
    })
  })

  it('手动创建写盘期间禁用主动作，避免重复 CAS 请求', async () => {
    let finishWrite: (() => void) | undefined
    const writePending = new Promise<void>(resolve => { finishWrite = resolve })
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [], diagnostics: [], elapsedMs: 0, truncated: false }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => writePending.then(() => ({ applied: true, revision: 'rev-2' })),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)
    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.input(screen.getByLabelText('新建 Agent id'), { target: { value: 'manual' } })
    fireEvent.input(screen.getByLabelText('新建 Agent name'), { target: { value: 'Manual' } })
    fireEvent.input(screen.getByLabelText('新建 Agent exe'), { target: { value: 'manual.exe' } })

    const create = screen.getByRole('button', { name: '创建' })
    fireEvent.click(create)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', expect.anything()))
    expect(create).toBeDisabled()
    fireEvent.click(create)
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(1)
    finishWrite?.()
  })

  it('手动选择可执行文件时会预填首个 Agent 的路径、id 和名称', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('C:\\Agent Files\\My ACP Agent.exe')
    render(() => <AgentRuntimePanel />)

    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    const createForm = screen.getByLabelText('新建 Agent 配置')
    fireEvent.click(within(createForm).getByRole('button', { name: '选择可执行文件' }))

    await waitFor(() => expect(screen.getByLabelText('新建 Agent exe')).toHaveValue('C:\\Agent Files\\My ACP Agent.exe'))
    expect(screen.getByLabelText('新建 Agent id')).toHaveValue('my-acp-agent')
    expect(screen.getByLabelText('新建 Agent name')).toHaveValue('My ACP Agent')
    prompt.mockRestore()
  })

  it('手动选择已知可执行文件时复用 Catalog provider 与 ACP 参数', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('C:\\Agents\\peri.exe')
    render(() => <AgentRuntimePanel />)
    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.click(within(screen.getByLabelText('新建 Agent 配置')).getByRole('button', { name: '选择可执行文件' }))

    await waitFor(() => expect(screen.getByLabelText('新建 Agent exe')).toHaveValue('C:\\Agents\\peri.exe'))
    expect(screen.getByLabelText('新建 Agent id')).toHaveValue('peri')
    expect(screen.getByLabelText('新建 Agent name')).toHaveValue('Peri')
    expect(screen.getByLabelText('新建 Agent provider')).toHaveValue('peri')
    expect(screen.getByLabelText('新建 Agent 参数 1')).toHaveValue('acp')
    prompt.mockRestore()
  })

  it('编辑现有 Agent 时先测试连接再保存参数数组，并预览后端追加的 effective 参数', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      // 新契约（5b43c183：require verified agent edits）：保存前必须先测试连接成功。
      test_agent_candidate: () => Promise.resolve({ ok: true, agentId: 'peri', durationMs: 12 }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    const periCard = screen.getByText('Peri').closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(periCard).getByRole('button', { name: '编辑' }))

    expect(within(periCard).getByText('peri acp "work space" --model demo')).toBeInTheDocument()
    fireEvent.input(within(periCard).getByLabelText('peri 参数 2'), { target: { value: 'new work space' } })
    fireEvent.click(within(periCard).getByRole('button', { name: '添加参数' }))

    // 未验证直接保存 → 拒绝并提示先测试（新契约的 fail-closed 面）
    fireEvent.click(within(periCard).getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/请先测试连接成功/)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('update_agents_config', expect.anything())

    // 验证使用**草稿当前值**（含新增的空参数）
    fireEvent.click(within(periCard).getByRole('button', { name: '先测试连接' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('test_agent_candidate', {
      agentId: 'peri',
      agent: { name: 'Peri', provider: '', transport: 'subprocess', exe: 'peri', args: ['acp', 'new work space', ''] },
    }))
    expect(await within(periCard).findByText(/连接成功/)).toBeInTheDocument()

    fireEvent.click(within(periCard).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_fields',
      agentId: 'peri',
      config: {
        name: 'Peri',
        exe: 'peri',
        provider: null,
        args: ['acp', 'new work space', ''],
      },
      expectedRevision: 'rev-1',
    }))
  })

  // #325：探测失败的真实原因必须落到**那张 Agent 卡**上——此前卡片只有「未激活」，
  // 原因（version_probe_spawn_failed / os error 193）只进控制台。
  it('探测失败的原因按候选归因显示在 Agent 卡上，且「重试探测」强制重跑', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    invoke.mockReset()
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => fakeInvoke.invoke(command, args))
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({
        candidates: [{
          candidateId: 'detected:peri',
          detectorId: 'builtin.detector.peri',
          provider: 'peri',
          suggestedAgentId: 'peri',
          name: 'Peri',
          executable: 'C:\\broken\\peri.exe',
          args: [],
          evidence: [],
          identityConfidence: 'medium',
          protocolAvailability: 'not_tested',
          alreadyImportedAgentId: 'peri',
          warnings: [],
        }],
        diagnostics: [{
          code: 'version_probe_spawn_failed',
          stage: 'version_probe',
          detectorId: 'builtin.detector.peri',
          candidateId: 'detected:peri',
          executable: 'C:\\broken\\peri.exe',
          message: '无法执行 C:\\broken\\peri.exe 版本探针: os error 193',
          retryable: false,
        }],
        elapsedMs: 12,
        truncated: false,
      }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
    })
    render(() => <AgentRuntimePanel />)

    const failure = await screen.findByText(/探测失败/)
    const card = failure.closest('.agent-runtime-card') as HTMLElement
    expect(card).not.toBeNull()
    expect(within(card).getByText('version_probe_spawn_failed')).toBeInTheDocument()
    expect(within(card).getByText(new RegExp(explainErrorCode('version_probe_spawn_failed')!.summary))).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: '重试探测' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('detect_agent_runtimes', expect.objectContaining({ force: true })))
  })

  it('候选编辑后的参数数组在验证与导入之间保持一致', async () => {
    const candidate = {
      candidateId: 'detected:one',
      detectorId: 'detector.test',
      provider: 'custom',
      suggestedAgentId: 'detected',
      name: 'Detected',
      executable: 'C:\\Agent Files\\agent.exe',
      args: ['--profile', 'work space'],
      evidence: [{ kind: 'version', detail: 'fixture 9.9.9' }],
      identityConfidence: 'high',
      protocolAvailability: 'not_tested',
      warnings: [],
    }
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({
        candidates: [candidate],
        diagnostics: [{ code: 'version_probe_timeout', stage: 'version_probe', detectorId: 'detector.test', message: 'version timeout', retryable: true }],
        elapsedMs: 101,
        truncated: false,
      }),
      test_agent_candidate: () => Promise.resolve({ ok: true, agentId: 'detected', durationMs: 12 }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    const candidateCard = (await screen.findByLabelText('Detected executable')).closest('.agent-runtime-card') as HTMLElement
    expect(within(candidateCard).getByText(/ACP：未验证/)).toBeInTheDocument()
    // #116 子项 10：诊断在 UI 上只呈现「哪条探测 · 哪个候选 · 本地化原因」；
    // 内部码与后端原文改由运行日志 / Runtime sheet 承载（见 agentDetectionDiagnostics 单测）。
    expect(screen.queryByText(/version_probe_timeout/)).not.toBeInTheDocument()
    expect(screen.getByText(`版本探测 · test · ${explainErrorCode('version_probe_timeout')!.summary}（可重试）`)).toBeInTheDocument()
    fireEvent.click(within(candidateCard).getByRole('button', { name: '添加参数' }))
    fireEvent.click(within(candidateCard).getByRole('button', { name: '添加参数' }))
    fireEvent.input(within(candidateCard).getByLabelText('Detected 参数 4'), { target: { value: 'a"b' } })
    fireEvent.click(within(candidateCard).getByRole('button', { name: '验证并导入' }))

    const expectedArgs = ['--profile', 'work space', '', 'a"b']
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('test_agent_candidate', {
      agentId: 'detected',
      agent: {
        name: 'Detected',
        provider: 'custom',
        transport: 'subprocess',
        exe: 'C:\\Agent Files\\agent.exe',
        args: expectedArgs,
      },
    }))
    // invoke 记录先于验证结果落卡（await 续体晚一个微任务）；React 版靠 act 冲刷掩盖，
    // Solid 侧直接等「ACP：可用」这个真条件。
    await waitFor(() => expect(within(candidateCard).getByText(/ACP：可用/)).toBeInTheDocument())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_create',
      agentId: 'detected',
      config: {
        name: 'Detected',
        provider: 'custom',
        transport: 'subprocess',
        exe: 'C:\\Agent Files\\agent.exe',
        args: expectedArgs,
        default: false,
      },
      expectedRevision: 'rev-1',
    }))
  })

  it('权威配置列表删除 Agent 后，旧发现报告不阻止重新导入', async () => {
    const candidate = {
      candidateId: 'detected:hermes', detectorId: 'builtin.detector.hermes', provider: 'hermes',
      suggestedAgentId: 'hermes', name: 'Hermes', executable: 'hermes.exe', args: ['acp'],
      alreadyImportedAgentId: 'hermes', identityConfidence: 'high', protocolAvailability: 'not_tested', evidence: [], warnings: [],
    }
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [candidate], diagnostics: [], elapsedMs: 10, truncated: false }),
      test_agent_candidate: () => Promise.resolve({ ok: true, agentId: 'hermes', durationMs: 12 }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
    })
    render(() => <AgentRuntimePanel />)
    expect(await screen.findByRole('button', { name: '使用此 Agent' })).toBeInTheDocument()
    // Solid：store 写入即信号传播（原 React act 包装的等价直调）。
    useIdentityStore.getState().setAgents([])
    fireEvent.click(await screen.findByRole('button', { name: '验证并导入' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', expect.objectContaining({ scope: 'agent_create', agentId: 'hermes' })))
  })

  it('选择折叠的备用入口后，验证和保存使用同一可执行文件与参数', async () => {
    const candidate = {
      candidateId: 'detected:alt', detectorId: 'detector.test', provider: 'custom',
      suggestedAgentId: 'custom', name: 'Alternative', executable: 'agent.exe', args: ['acp'],
      identityConfidence: 'high', protocolAvailability: 'not_tested', evidence: [], warnings: [],
      alternatives: [{ candidateId: 'detected:acp', executable: 'agent-acp.exe', args: [], startability: 'not_tested' }],
    }
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [candidate], diagnostics: [], elapsedMs: 10, truncated: false }),
      test_agent_candidate: () => Promise.resolve({ ok: true, agentId: 'custom', durationMs: 12 }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
    })
    render(() => <AgentRuntimePanel />)
    fireEvent.change(await screen.findByLabelText('Alternative 启动入口'), { target: { value: 'detected:acp' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并导入' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('test_agent_candidate', expect.objectContaining({
      agent: expect.objectContaining({ exe: 'agent-acp.exe', args: [] }),
    })))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', expect.objectContaining({
      config: expect.objectContaining({ exe: 'agent-acp.exe', args: [] }),
    })))
  })

  /**
   * A5① Claude 侧候选渲染：wrapper provider 的候选必须展示自己的 ACP 入口与身份，
   * 且不得把 vendor CLI 当成可导入的候选执行文件。
   */
  it('把 claude-code wrapper 候选渲染成适配器入口，而不是 vendor CLI', async () => {
    const claude = {
      candidateId: 'detected:ccb', detectorId: 'builtin.detector.claude-code', provider: 'claude-code',
      suggestedAgentId: 'claude-code', name: 'Claude Code',
      executable: 'F:\\A-I\\Agent\\bin\\ccb.cmd', args: ['--acp'],
      evidence: [{ kind: 'path', detail: 'F:\\A-I\\Agent\\bin\\ccb.cmd' }],
      identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [],
    }
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.register('detect_agent_runtimes', () => Promise.resolve({
      candidates: [claude], diagnostics: [], elapsedMs: 2, truncated: false,
      providers: [{
        provider: 'claude-code', detectorId: 'builtin.detector.claude-code',
        adapterRelationDeclared: true,
        acpCommands: [{ kind: 'acp-command', path: 'F:\\A-I\\Agent\\bin\\ccb.cmd', source: 'path' }],
        nativeCommands: [],
        sharedConfigPresent: true,
      }],
      preflight: [{
        provider: 'claude-code', status: 'nativeMissing', passed: false,
        adapter: {
          nativeCmd: 'claude', nativeLabel: 'Claude Code CLI', nativePresent: false, acpPresent: true,
          sharedConfigDir: '~/.claude', sharedConfigPresent: true,
        },
        checks: [],
      }],
    }))
    render(() => <AgentRuntimePanel />)

    // 候选行列出 provider 与置信度，展开后默认填 ACP 入口 `ccb --acp`。
    const row = await screen.findByRole('button', { name: /Claude Code.*claude-code/ })
    fireEvent.click(row)
    expect(screen.getByLabelText('Claude Code executable')).toHaveValue('F:\\A-I\\Agent\\bin\\ccb.cmd')
    expect(screen.getByLabelText('Claude Code provider')).toHaveValue('claude-code')
    // 候选执行文件不得被替换成 vendor CLI `claude`。
    expect(screen.getByLabelText('Claude Code executable')).not.toHaveValue('claude')
    // 同一屏上 wrapper 两侧证据分开，且安装状态给出可行动原因。
    expect(within(await screen.findByLabelText('本机 Agent 安装状态')).getByText(/缺官方 CLI/)).toBeInTheDocument()
  })

  it('多个候选使用紧凑选择列表，仅展开当前候选的高级参数', async () => {
    const makeCandidate = (id: string, name: string) => ({
      candidateId: `detected:${id}`, detectorId: 'detector.test', provider: id,
      suggestedAgentId: id, name, executable: `C:\\Agents\\${id}.exe`, args: ['acp'],
      evidence: [], identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [],
    })
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.register('detect_agent_runtimes', () =>
      Promise.resolve({ candidates: [makeCandidate('first', 'First Agent'), makeCandidate('second', 'Second Agent')], diagnostics: [], elapsedMs: 2, truncated: false }))
    render(() => <AgentRuntimePanel />)

    expect(await screen.findByRole('button', { name: /First Agent.*first/ })).toBeInTheDocument()
    expect(screen.getByLabelText('First Agent executable')).toBeInTheDocument()
    expect(screen.queryByLabelText('Second Agent executable')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Second Agent.*second/ }))
    expect(screen.queryByLabelText('First Agent executable')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Second Agent executable')).toBeInTheDocument()
  })

  it('已导入候选提供立即使用动作，而不是只显示禁用的导入按钮', async () => {
    const openSheet = vi.fn(() => 'agent-hermes')
    useWorkspaceStore.setState({ openSheet })
    const candidate = {
      candidateId: 'detected:hermes', detectorId: 'detector.test', provider: 'hermes',
      suggestedAgentId: 'hermes', name: 'Hermes Detected', executable: 'hermes', args: ['acp'], evidence: [],
      identityConfidence: 'high', protocolAvailability: 'verified', alreadyImportedAgentId: 'hermes', warnings: [],
    }
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [candidate], diagnostics: [], elapsedMs: 2, truncated: false }),
      switch_agent: () => Promise.resolve(null),
      agent_status: () => Promise.resolve({ agent: 'hermes', status: 'connected', generation: 2 }),
    })
    render(() => <AgentRuntimePanel />)

    fireEvent.click(await screen.findByRole('button', { name: '使用此 Agent' }))

    await waitFor(() => expect(openSheet).toHaveBeenCalledWith({ kind: 'agent', title: 'Hermes', agentId: 'hermes' }))
    expect(useIdentityStore.getState().activeAgent).toBe('hermes')
  })

  it('验证成功后可由一个主动作直接导入候选', async () => {
    const candidate = {
      candidateId: 'detected:quick-start',
      detectorId: 'detector.test',
      provider: 'peri',
      suggestedAgentId: 'quick-start',
      name: 'Quick Start',
      executable: 'C:\\Agents\\quick-start.exe',
      args: ['acp'],
      evidence: [{ kind: 'path', detail: 'PATH' }],
      identityConfidence: 'high',
      protocolAvailability: 'not_tested',
      warnings: [],
    }
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [candidate], diagnostics: [], elapsedMs: 4, truncated: false }),
      test_agent_candidate: () => Promise.resolve({ ok: true, agentId: 'quick-start', durationMs: 8 }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    const candidateCard = (await screen.findByLabelText('Quick Start executable')).closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(candidateCard).getByRole('button', { name: '验证并导入' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('test_agent_candidate', {
      agentId: 'quick-start',
      agent: {
        name: 'Quick Start',
        provider: 'peri',
        transport: 'subprocess',
        exe: 'C:\\Agents\\quick-start.exe',
        args: ['acp'],
      },
    }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_create',
      agentId: 'quick-start',
      config: {
        name: 'Quick Start',
        provider: 'peri',
        transport: 'subprocess',
        exe: 'C:\\Agents\\quick-start.exe',
        args: ['acp'],
        default: false,
      },
      expectedRevision: 'rev-1',
    }))
  })

  it('导入留在配置页，显式使用才切换并打开 Agent Sheet', async () => {
    const openSheet = vi.fn(() => 'agent-ready')
    useWorkspaceStore.setState({ openSheet })
    const candidate = {
      candidateId: 'detected:ready', detectorId: 'detector.test', provider: 'peri',
      suggestedAgentId: 'ready-agent', name: 'Ready Agent', executable: 'C:\\Agents\\ready.exe',
      args: ['acp'], evidence: [], identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [],
    }
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [candidate], diagnostics: [], elapsedMs: 4, truncated: false }),
      test_agent_candidate: () => Promise.resolve({ ok: true, agentId: 'ready-agent', durationMs: 8 }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([{ id: 'ready-agent', name: 'Ready Agent', exe: candidate.executable, default: true }]),
      switch_agent: () => Promise.resolve(null),
      agent_status: () => Promise.resolve({ agent: 'ready-agent', status: 'connected', generation: 1 }),
    })
    render(() => <AgentRuntimePanel />)

    const candidateCard = (await screen.findByLabelText('Ready Agent executable')).closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(candidateCard).getByRole('button', { name: '验证并导入' }))

    const useAgent = await within(candidateCard).findByRole('button', { name: '使用此 Agent' })
    await waitFor(() => expect(useAgent).toBeEnabled())
    expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(1)
    expect(invoke).not.toHaveBeenCalledWith('switch_agent', { name: 'ready-agent' })
    expect(openSheet).not.toHaveBeenCalled()
    fireEvent.click(useAgent)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('switch_agent', { name: 'ready-agent' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('agent_status', undefined)
      expect(useIdentityStore.getState().activeAgent).toBe('ready-agent')
      expect(openSheet).toHaveBeenCalledWith({ kind: 'agent', title: 'Ready Agent', agentId: 'ready-agent' })
    })
  })

  /** B1：验证期间可取消；取消后在途结果不落地，保存仍被 fail-closed 挡住。 */
  it('草稿验证可取消，取消后旧结果不落地且保存仍被拒绝', async () => {
    let finishTest: ((value: { ok: boolean; agentId: string; durationMs: number }) => void) | undefined
    const testPending = new Promise<{ ok: boolean; agentId: string; durationMs: number }>(resolve => { finishTest = resolve })
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      test_agent_candidate: () => testPending,
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    const periCard = screen.getByText('Peri').closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(periCard).getByRole('button', { name: '编辑' }))
    fireEvent.click(within(periCard).getByRole('button', { name: '先测试连接' }))

    // 验证中：出现取消验证按钮，保存被禁用。
    expect(within(periCard).getByRole('button', { name: '取消验证' })).toBeInTheDocument()
    expect(within(periCard).getByRole('button', { name: '保存' })).toBeDisabled()

    fireEvent.click(within(periCard).getByRole('button', { name: '取消验证' }))
    // 取消后：回到可编辑，验证按钮恢复。
    expect(within(periCard).getByRole('button', { name: '先测试连接' })).toBeInTheDocument()

    // 在途结果此刻到达：不得落地为已验证。
    finishTest?.({ ok: true, agentId: 'peri', durationMs: 5 })
    await waitFor(() => expect(testPending).resolves.toBeTruthy())
    fireEvent.click(within(periCard).getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/请先测试连接成功/)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('update_agents_config', expect.anything())
  })

  /** B1：验证成功后修改任一草稿字段，旧验证立即失效，必须重新验证才能保存。 */
  it('验证成功后再改草稿字段必须重新验证才能保存', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      test_agent_candidate: () => Promise.resolve({ ok: true, agentId: 'peri', durationMs: 9 }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    const periCard = screen.getByText('Peri').closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(periCard).getByRole('button', { name: '编辑' }))
    fireEvent.click(within(periCard).getByRole('button', { name: '先测试连接' }))
    expect(await within(periCard).findByText(/连接成功/)).toBeInTheDocument()

    // 改 name：验证作废。
    fireEvent.input(within(periCard).getByLabelText('Agent name'), { target: { value: 'Peri draft' } })
    fireEvent.click(within(periCard).getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/请先测试连接成功/)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('update_agents_config', expect.anything())
  })

  /** B1：连接测试返回的启动计划与结果一并展示（与真实 spawn 同源，env 已掩码）。 */
  it('草稿验证成功后展示后端下发的启动计划', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      test_agent_candidate: () => Promise.resolve({
        ok: true, agentId: 'peri', durationMs: 7,
        launchPlan: { provider: 'peri', executable: 'peri', argv: ['peri', 'acp'], cwd: null, env: [{ name: 'PERI_TOKEN', value: 'value withheld' }], diagnostics: [] },
      }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    const periCard = screen.getByText('Peri').closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(periCard).getByRole('button', { name: '编辑' }))
    fireEvent.click(within(periCard).getByRole('button', { name: '先测试连接' }))
    expect(await within(periCard).findByText(/启动计划：peri acp（env 值已隐藏）/)).toBeInTheDocument()
    expect(within(periCard).queryByText(/value withheld/)).toBeNull()
  })

  /** B1：自定义 profile 复用 Codeg 规则——id 借用内置 provider 名而 provider 另指他处时拒绝创建。 */
  it('新建 Agent 拒绝内置 provider id 冲突并给出可行动原因', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.input(screen.getByLabelText('新建 Agent id'), { target: { value: 'peri' } })
    fireEvent.input(screen.getByLabelText('新建 Agent name'), { target: { value: 'Fake Peri' } })
    fireEvent.input(screen.getByLabelText('新建 Agent exe'), { target: { value: 'C:\\fake\\peri.exe' } })
    fireEvent.input(screen.getByLabelText('新建 Agent provider'), { target: { value: 'hermes' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    expect(await screen.findByText(/与内置 provider 同名/)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('update_agents_config', expect.anything())
  })

  it('CAS 冲突保留编辑草稿，并允许显式重新载入 revision', async () => {
    let snapshotCalls = 0
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      // 新契约（5b43c183）：CAS 冲突路径同样需先通过连接验证才能到达保存。
      test_agent_candidate: () => Promise.resolve({ ok: true, agentId: 'peri', durationMs: 12 }),
      agent_config_snapshot: () => {
        snapshotCalls += 1
        return Promise.resolve({ revision: `rev-${snapshotCalls}`, agents: [] })
      },
      update_agents_config: () => Promise.reject({ code: 'config_revision_conflict', message: 'expected rev-1 actual rev-2' }),
      list_agents: () => Promise.resolve([]),
    })
    render(() => <AgentRuntimePanel />)

    const periCard = screen.getByText('Peri').closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(periCard).getByRole('button', { name: '编辑' }))
    const nameInput = within(periCard).getByLabelText('Agent name') as HTMLInputElement
    fireEvent.input(nameInput, { target: { value: 'Peri draft' } })
    // 先验证（新契约），否则保存会被 fail-closed 拒绝，到不了 CAS 冲突分支。
    fireEvent.click(within(periCard).getByRole('button', { name: '先测试连接' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('test_agent_candidate', expect.anything()))
    // invoke 记录 ≠ 验证状态机已到 verified；保存是 fail-closed 的，提前点只会得到
    // 「请先测试连接成功」。等卡片上的「连接成功」状态文本（verified 的可观察产物）
    // 再保存——React 版靠 act 冲刷掩盖了这个微任务间隙。
    await within(periCard).findByText(/连接成功（\d+ms），现在可以保存/)
    fireEvent.click(within(periCard).getByRole('button', { name: '保存' }))

    expect(await screen.findByText(/配置已被其他进程修改/)).toBeInTheDocument()
    expect((within(periCard).getByLabelText('Agent name') as HTMLInputElement).value).toBe('Peri draft')
    fireEvent.click(screen.getByRole('button', { name: '重新载入配置' }))
    await waitFor(() => expect(snapshotCalls).toBe(2))
    expect(screen.getByText(/配置已重新载入；未提交草稿仍保留/)).toBeInTheDocument()
  })

  it('PendingRestart 显示显式重启按钮，成功后刷新为 Activated', async () => {
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [{
        id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', args: ['acp'],
        effectiveArgs: ['acp'], default: true, configActivationState: 'pendingRestart',
      }],
    })
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      restart_agent_runtime: () => Promise.resolve({ agentId: 'peri', configActivationState: 'activated' }),
      list_agents: () => Promise.resolve([{
        id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', args: ['acp'],
        effectiveArgs: ['acp'], default: true, configActivationState: 'activated',
      }]),
    })
    render(() => <AgentRuntimePanel />)

    expect(screen.getByText(/配置：待重启生效/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '立即重启应用此配置' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('restart_agent_runtime', { agentId: 'peri' }))
    expect(await screen.findByText(/配置：已生效/)).toBeInTheDocument()
  })

  it('runtime 重启失败时保留 PendingRestart', async () => {
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [{ id: 'peri', name: 'Peri', exe: 'peri', configActivationState: 'pendingRestart' }],
    })
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.register('restart_agent_runtime', () => Promise.reject({ code: 'agent_initialize_failed', message: 'bad initialize' }))
    render(() => <AgentRuntimePanel />)
    fireEvent.click(screen.getByRole('button', { name: '立即重启应用此配置' }))

    expect(await screen.findByText(/重启 Agent runtime失败/)).toBeInTheDocument()
    expect(screen.getByText(/配置：待重启生效/)).toBeInTheDocument()
  })

  /**
   * A4 验收：安装状态与可行动原因。nativeMissing 必须能解释「适配器在、官方 CLI
   * 不在」，而不是只说一句“未验证”。数据来自后端 preflight，不在组件里重新推断。
   */
  it('把后端 preflight 渲染成可行动的安装状态，而不是空白或“未验证”', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.register('detect_agent_runtimes', () => Promise.resolve({
      candidates: [],
      diagnostics: [],
      elapsedMs: 3,
      truncated: false,
      providers: [{
        provider: 'claude-code',
        detectorId: 'builtin.detector.claude-code',
        adapterRelationDeclared: true,
        acpCommands: [{ kind: 'acp-command', path: 'C:/x/ccb.cmd', source: 'path' }],
        nativeCommands: [],
        sharedConfigPresent: true,
      }],
      preflight: [{
        provider: 'claude-code',
        status: 'nativeMissing',
        passed: false,
        adapter: {
          nativeCmd: 'claude', nativeLabel: 'Claude Code CLI',
          nativePresent: false, acpPresent: true,
          sharedConfigDir: '~/.claude', sharedConfigPresent: true,
        },
        checks: [{ checkId: 'version-gate:steering-prompt-required', label: 'adapter version', status: 'PASS', message: 'adapter version >= 0.65.0', fixes: [] }],
      }],
    }))
    render(() => <AgentRuntimePanel />)

    const section = await screen.findByLabelText('本机 Agent 安装状态')
    expect(within(section).getByText('claude-code')).toBeInTheDocument()
    expect(within(section).getByText('缺官方 CLI')).toBeInTheDocument()
    expect(within(section).getByText(/未找到该适配器包装的官方 CLI/)).toBeInTheDocument()
    // wrapper 两侧证据分开呈现：ACP 已找到、官方 CLI 未找到。
    expect(within(section).getByText(/ACP：已找到 · Claude Code CLI（claude）：未找到/)).toBeInTheDocument()
    // 只有非 PASS 的 check 才展开；PASS 的版本 gate 不占位。
    expect(within(section).queryByText(/adapter version >= 0.65.0/)).toBeNull()
  })

  /**
   * C3：原因用后端下发的 `cause.summary`（本机实测），而不是只看状态名的静态文案。
   *
   * 静态文案对 `notInstalled` 只会说“请先安装”，而本机真实原因可能是“装在了
   * Pylon 看不见的目录”。这条测试把“面板消费 cause”钉住。
   */
  it('优先渲染后端下发的本机原因，而不是只看状态名的静态文案', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.register('detect_agent_runtimes', () => Promise.resolve({
      candidates: [], diagnostics: [], elapsedMs: 2, truncated: false, providers: [],
      preflight: [{
        provider: 'gemini',
        status: 'notInstalled',
        passed: false,
        adapter: null,
        checks: [],
        cause: {
          level: 'warn',
          code: 'path_gap_restart_required',
          summary: '未检测到该 Agent；但你的 PATH 中有 1 个目录是本进程看不到的（如 C:\\Users\\me\\AppData\\Roaming\\npm）。若你刚安装过它，重启 Pylon 即可。',
        },
      }],
    }))
    render(() => <AgentRuntimePanel />)

    const section = await screen.findByLabelText('本机 Agent 安装状态')
    expect(within(section).getByText(/重启 Pylon 即可/)).toBeInTheDocument()
    // 静态文案不得同时出现：两者并存会给出互相矛盾的行动建议。
    expect(within(section).queryByText('未检测到该 Agent；请先安装，或在下方手动添加')).toBeNull()
  })

  /**
   * C3：`level === 'ok'` 时不占行。
   *
   * 工作正常的 provider 不需要用户读任何东西；否则每个正常项都带一行解释，
   * 真实问题就会被噪声淹没。
   */
  it('level 为 ok 的本机原因不占行，避免给正常 provider 加噪声', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.register('detect_agent_runtimes', () => Promise.resolve({
      candidates: [], diagnostics: [], elapsedMs: 2, truncated: false, providers: [],
      preflight: [{
        provider: 'peri',
        status: 'installed',
        passed: true,
        adapter: null,
        checks: [],
        cause: {
          level: 'ok',
          code: 'ok_absolute_path',
          summary: '该 Agent 可用：命令位于 F:\\A-I\\Agent\\bin\\peri.cmd，不在 PATH 上。',
        },
      }],
    }))
    render(() => <AgentRuntimePanel />)

    const section = await screen.findByLabelText('本机 Agent 安装状态')
    expect(within(section).getByText('peri')).toBeInTheDocument()
    expect(within(section).queryByText(/不在 PATH 上/)).toBeNull()
  })

  /** 已安装的 provider 不给可行动原因，避免噪声。 */
  it('已安装的 provider 不显示故障原因', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.register('detect_agent_runtimes', () => Promise.resolve({
      candidates: [], diagnostics: [], elapsedMs: 1, truncated: false,
      providers: [],
      preflight: [{ provider: 'peri', status: 'installed', passed: true, adapter: null, checks: [] }],
    }))
    render(() => <AgentRuntimePanel />)

    const section = await screen.findByLabelText('本机 Agent 安装状态')
    expect(within(section).getByText('已安装')).toBeInTheDocument()
    expect(within(section).queryByText(/请先安装|请升级|请指定/)).toBeNull()
  })

  /** 不可解释的状态不得渲染成看起来正常的行（归一化阶段即丢弃）。 */
  it('未知安装状态不会渲染成空白行', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.register('detect_agent_runtimes', () => Promise.resolve({
      candidates: [], diagnostics: [], elapsedMs: 1, truncated: false,
      providers: [],
      preflight: [{ provider: 'future', status: 'somethingNew', passed: false, checks: [] }],
    }))
    render(() => <AgentRuntimePanel />)

    expect(await screen.findByText(/未发现可自动配置的 ACP Agent/)).toBeInTheDocument()
    expect(screen.queryByLabelText('本机 Agent 安装状态')).toBeNull()
  })

  // ── issue #67A：删除已连接 agent runtime（仅摘配置 + 停 runtime；会话/记录保留） ──
  // #520 K 域：确认交互由 ui/ConfirmArmButton 承载（原 window.confirm 式退役）——
  // 首次点击只进入 armed（旁注影响面、不发请求），二次点击「确认删除」才写配置。

  it('删除非 active Agent 需二段确认，armed 态旁注影响面，确认后按 agent_delete scope 写配置', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [], diagnostics: [], elapsedMs: 0, truncated: false }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.resolve({ applied: true, scope: 'agent_delete', agentCount: 1, revision: 'rev-2' }),
      list_agents: () => Promise.resolve([
        { id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', args: ['acp'], effectiveArgs: ['acp'], default: true },
      ]),
    })
    render(() => <AgentRuntimePanel />)

    const hermesCard = (await screen.findByText('Hermes')).closest('.agent-runtime-card') as HTMLElement
    // 首次点击：仅进入确认态，不发任何配置写请求
    fireEvent.click(within(hermesCard).getByRole('button', { name: '删除' }))
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toEqual([])
    // armed 态：确认按钮 + 影响面旁注（移除什么/保留什么）
    expect(within(hermesCard).getByRole('button', { name: '确认删除' })).toBeInTheDocument()
    expect(within(hermesCard).getByRole('note')).toHaveTextContent('将移除：')
    expect(within(hermesCard).getByRole('note')).toHaveTextContent('agents.yaml')
    expect(within(hermesCard).getByRole('note')).toHaveTextContent('保留不动：')
    expect(within(hermesCard).getByRole('note')).toHaveTextContent('该 Agent 的历史会话与记录数据')

    fireEvent.click(within(hermesCard).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', expect.objectContaining({ scope: 'agent_delete', agentId: 'hermes' })))
    expect(await screen.findByText(/已删除 Hermes（hermes）/)).toBeInTheDocument()
    expect(screen.queryByText('Hermes')).toBeNull()
  })

  it('未确认（仅 armed）时不发送任何配置写请求', async () => {
    render(() => <AgentRuntimePanel />)

    const hermesCard = (await screen.findByText('Hermes')).closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(hermesCard).getByRole('button', { name: '删除' }))

    expect(within(hermesCard).getByRole('button', { name: '确认删除' })).toBeInTheDocument()
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toEqual([])
    expect(screen.getByText('Hermes')).toBeInTheDocument()
  })

  it('active Agent 不可删除，并直接给出切换原因', async () => {
    render(() => <AgentRuntimePanel />)

    const periCard = (await screen.findByText('Peri')).closest('.agent-runtime-card') as HTMLElement
    expect(within(periCard).getByRole('button', { name: '删除' })).toBeDisabled()
    expect(within(periCard).getByText(/当前正在使用的 Agent 不能删除/)).toBeInTheDocument()
    const hermesCard = screen.getByText('Hermes').closest('.agent-runtime-card') as HTMLElement
    expect(within(hermesCard).getByRole('button', { name: '删除' })).toBeEnabled()
  })

  it('删除失败时展示可行动提示且列表不变', async () => {
    fakeInvoke = new NullFallbackFakeInvoke()
    fakeInvoke.registerMany({
      detect_agent_runtimes: () => Promise.resolve({ candidates: [], diagnostics: [], elapsedMs: 0, truncated: false }),
      agent_config_snapshot: () => Promise.resolve({ revision: 'rev-1', agents: [] }),
      update_agents_config: () => Promise.reject({ code: 'config_active_agent_protected', message: 'config_active_agent_protected: 候选配置删除了当前 active agent: hermes' }),
    })
    render(() => <AgentRuntimePanel />)

    const hermesCard = (await screen.findByText('Hermes')).closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(hermesCard).getByRole('button', { name: '删除' }))
    fireEvent.click(within(hermesCard).getByRole('button', { name: '确认删除' }))

    expect(await screen.findByText(/删除 Agent失败，详情见右下角错误中心/)).toBeInTheDocument()
    expect(screen.getByText('Hermes')).toBeInTheDocument()
  })
})
