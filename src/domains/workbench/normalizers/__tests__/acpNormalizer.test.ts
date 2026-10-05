import { afterEach, describe, expect, it } from 'vitest'
import { clearToolRegistryForTests, registerToolRegistryEntry } from '../../../tool/toolRegistry.ts'
import { normalizeAcpEvent } from '../acpNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

const context: NormalizeContext = {
  provider: 'peri',
  sessionId: 'session-1',
  sourceId: 'wire-1',
  sequence: 1,
  recordedAt: '2026-08-21T00:00:00.000Z',
  provenance: { origin: 'local-observed', trust: 'authoritative' },
}

afterEach(() => clearToolRegistryForTests())

describe('ACP normalizer', () => {
  it('normalizes text and tool wire shapes into A01 envelopes', () => {
    registerToolRegistryEntry({ provider: 'peri', name: 'read_file', kind: 'read', action: 'read' })
    const text = normalizeAcpEvent({
      source: 'peri',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello', messageId: 'm-1' } },
    }, context)
    expect(text.events[0].event).toMatchObject({
      type: 'message.delta',
      role: 'assistant',
      parts: [{ kind: 'text', text: 'hello' }],
    })
    expect(text.events[0].identity.messageId).toBe('m-1')

    const tool = normalizeAcpEvent({
      source: 'peri',
      update: { sessionUpdate: 'tool_call', toolCallId: 't-1', name: 'ProviderRead', title: '读取文件', _meta: { pylon: { toolName: 'read_file' } }, rawInput: { path: 'a.ts' } },
    }, { ...context, sequence: 2 })
    expect(tool.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: {
        toolCallId: 't-1', name: 'read_file', providerName: 'ProviderRead', kind: 'read', action: 'read',
        input: { path: 'a.ts' }, rawInput: { path: 'a.ts' },
      },
    })
  })

  it('narrows generic lifecycle metadata without making renderer read ACP raw', () => {
    const result = normalizeAcpEvent({
      update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'tool-progress', status: 'failed',
        progress: { completed: 1, total: 3, message: 'reading' },
        locations: [{ path: '/workspace/a.ts', line: 4 }],
        durationMs: 1250, error: { message: 'permission denied', code: 'EACCES', retryable: false },
      },
    }, context)

    expect(result.events[0].event).toMatchObject({
      type: 'tool.failed',
      tool: {
        progress: { completed: 1, total: 3, message: 'reading' },
        locations: [{ path: '/workspace/a.ts', line: 4 }],
        durationMs: 1250,
        error: { message: 'permission denied', code: 'EACCES', retryable: false },
      },
    })
  })

  it('keeps good blocks and turns malformed/unknown blocks into visible unknown content', () => {
    const result = normalizeAcpEvent({
      source: 'peri',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: [
          { type: 'text', text: 'good' },
          { type: 'future_block', payload: { value: 1 } },
          42,
        ],
      },
    }, context)
    expect(result.events[0].event).toMatchObject({
      type: 'message.delta',
      parts: [
        { kind: 'text', text: 'good' },
        { kind: 'unknown', originalType: 'future_block' },
        { kind: 'unknown', originalType: 'malformed' },
      ],
    })
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'peri', wireKind: 'agent_message_chunk', recoverable: true }),
    ]))
  })

  it('keeps structured blocks typed from ACP wire through the semantic event seam', () => {
    const result = normalizeAcpEvent({
      source: 'peri',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: [
          { type: 'progress', current: 2, total: 4, message: 'working' },
          { type: 'list', title: 'results', items: [{ type: 'code', text: 'const ok = true', language: 'ts' }] },
          { type: 'tool_result', name: 'Search', status: 'completed', content: [{ type: 'location', path: '/workspace/a.ts', line: 7 }] },
        ],
      },
    }, context)

    expect(result.events[0].event).toMatchObject({
      type: 'message.delta',
      role: 'assistant',
      parts: [
        { kind: 'progress', current: 2, total: 4, message: 'working' },
        { kind: 'list', items: [{ kind: 'code', text: 'const ok = true', language: 'ts' }] },
        { kind: 'tool-result', content: [{ kind: 'location', path: '/workspace/a.ts', line: 7 }] },
      ],
    })
    expect(result.diagnostics).toEqual([])
  })

  it('preserves unknown wire events and changes only provenance between live and replay', () => {
    const live = normalizeAcpEvent({ source: 'peri', update: { sessionUpdate: 'future_event', payload: { x: 1 } } }, context)
    const replay = normalizeAcpEvent({ source: 'peri', update: { sessionUpdate: 'future_event', payload: { x: 1 } } }, {
      ...context,
      provenance: { origin: 'recovery-import', trust: 'unverified', provider: 'peri', importId: 'import-1' },
    })
    expect(live.events[0].event).toEqual(replay.events[0].event)
    expect(live.events[0].provenance).not.toEqual(replay.events[0].provenance)
    expect(live.events[0].event.type).toBe('event.unknown')
  })

  it('normalizes ACP error as a provider.error semantic event so projection can settle the stream', () => {
    const result = normalizeAcpEvent({
      update: { sessionUpdate: 'error', errorCode: 'protocol_error', error: 'transport failed' },
    }, context)

    expect(result.events[0].event).toEqual({
      type: 'diagnostic.notice',
      level: 'error',
      message: 'transport failed',
      code: 'provider.error',
    })
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider.error', message: 'transport failed' }),
    ]))
  })

  it('uses a short summary for provider timeout prose while retaining technical metadata', () => {
    const result = normalizeAcpEvent({
      update: {
        sessionUpdate: 'error',
        error: 'ACP protocol: timed out after 180s (provider error)',
        failure: {
          source: 'provider', configuredTimeoutSecs: 180, actualElapsedMs: 24_000,
          providerMessage: 'ACP protocol: timed out after 180s (provider error)',
        },
      },
    }, context)
    const event = result.events[0]?.event
    expect(event).toMatchObject({ type: 'diagnostic.notice', message: 'Provider 返回错误', code: 'provider.error' })
    expect((event as { data?: { failure?: { source?: string } } }).data?.failure?.source).toBe('provider')
    expect(result.diagnostics[0]?.message).toBe('Provider 返回错误')
  })

  it.each([
    ['tool_call', undefined],
    ['tool_call_update', 'completed'],
  ])('uses _meta.pylon.toolName for %s and never treats localized title as machine identity', (sessionUpdate, status) => {
    registerToolRegistryEntry({ provider: 'claude-code', name: 'Agent', aliases: ['Task'], kind: 'execute', action: 'delegate', capabilities: ['delegate'] })
    const result = normalizeAcpEvent({
      update: {
        sessionUpdate,
        toolCallId: 'tool-meta',
        title: '启动子代理（本地化）',
        ...(status ? { status } : {}),
        _meta: { pylon: { toolName: 'Task' } },
      },
    }, { ...context, provider: 'claude-code', replay: sessionUpdate === 'tool_call_update' })
    expect(result.events[0].event).toMatchObject({
      tool: { name: 'Task', canonicalName: 'Agent', title: '启动子代理（本地化）', capabilities: ['delegate'] },
    })
  })

  it('falls back to generic tool semantics and a diagnostic when machine name is missing', () => {
    const result = normalizeAcpEvent({
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-missing', title: 'Read file.txt' },
    }, context)
    expect(result.events[0].event).toMatchObject({ tool: { name: 'unknown', title: 'Read file.txt', kind: 'other', action: 'unknown' } })
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'tool.name.missing' })]))
  })

  it('keeps Claude parentToolUseId out of identity.taskId (parent belongs to source/tool edge)', () => {
    const result = normalizeAcpEvent({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'child-tool',
        _meta: { claudeCode: { parentToolUseId: 'parent-tool' } },
        name: 'Bash',
      },
    }, { ...context, provider: 'claude-code' })

    expect(result.events[0]?.identity).not.toHaveProperty('taskId', 'parent-tool')
    expect(result.events[0]?.event).toMatchObject({
      type: 'tool.started',
      tool: { toolCallId: 'child-tool', parentToolUseId: 'parent-tool' },
    })
  })

  it('promotes only standard C14 wire fields into canonical usage/commands/config names', () => {
    const usage = normalizeAcpEvent({ update: {
      sessionUpdate: 'usage_update', used: 30, size: 200,
      cost: { amount: 0.01, currency: 'USD' },
      _meta: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 4 },
      usage: { cacheWriteTokens: 2, vendorFuture: 9 },
    } }, context)
    expect(usage.events[0].event).toEqual({
      type: 'usage.updated', usage: {
        inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2,
        contextUsed: 30, contextLimit: 200, costUsd: 0.01, currency: 'USD', vendorFuture: 9,
      },
    })

    const commands = normalizeAcpEvent({ update: { sessionUpdate: 'available_commands_update', commands: [
      { name: 'review', input_hint: ' <scope>', description: 'Review changes' },
    ] } }, context)
    expect(commands.events[0].event).toEqual({ type: 'session.commands-updated', commands: [
      { id: 'review', name: '/review', inputHint: ' <scope>', description: 'Review changes' },
    ] })

    const config = normalizeAcpEvent({ update: { sessionUpdate: 'config_option_update', configOptions: [
      { id: 'model', name: 'Model', currentValue: 'gpt-5', type: 'select', options: [{ value: 'gpt-5' }], version: 3 },
    ] } }, context)
    expect(config.events[0].event).toEqual({ type: 'session.config-updated', options: [
      { id: 'model', label: 'Model', value: 'gpt-5', valueType: 'select', editable: true, schema: { options: [{ value: 'gpt-5' }] }, version: 3 },
    ] })
  })

  // config 包同时声明"候选"和"当前值"：中控读后者（session.mode/model），配置面板读前者
  // （options[].value）。只产 config 事件会让同一界面上两块地方各说各话。
  it('states the current mode and model next to the options a config packet advertises', () => {
    const result = normalizeAcpEvent({ update: {
      sessionUpdate: 'config_option_update',
      configOptions: [
        { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'accept_edit',
          options: [{ value: 'default' }, { value: 'accept_edit' }] },
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fable',
          options: [{ value: 'fable' }, { value: 'haiku' }] },
      ],
    } }, context)

    expect(result.events[0].event.type).toBe('session.config-updated')
    expect(result.events.map(envelope => envelope.event)).toEqual(expect.arrayContaining([
      { type: 'session.mode-updated', mode: 'accept_edit' },
      { type: 'session.model-updated', model: 'fable' },
    ]))
  })

  it('defaults unknown config kinds to read-only while keeping ACP select/boolean editable', () => {
    const result = normalizeAcpEvent({ update: { sessionUpdate: 'config_option_update', configOptions: [
      { id: 'model', name: 'Model', currentValue: 'gpt-5', type: 'select', options: [{ value: 'gpt-5' }] },
      { id: 'thinking', name: 'Thinking', currentValue: true, type: 'boolean' },
      { id: 'vendor-shape', name: 'Vendor shape', currentValue: { mode: 'adaptive' }, type: 'provider.custom' },
    ] } }, context)

    expect(result.events[0].event).toMatchObject({ type: 'session.config-updated', options: [
      { id: 'model', value: 'gpt-5', valueType: 'select', editable: true },
      { id: 'thinking', value: true, valueType: 'boolean', editable: true },
      {
        id: 'vendor-shape', value: { mode: 'adaptive' }, valueType: 'provider.custom', editable: false,
        raw: { value: { mode: 'adaptive' }, valueType: 'provider.custom' },
      },
    ] })
  })

  it('normalizes snake-case config ids and nested value ids without losing machine choices', () => {
    const result = normalizeAcpEvent({ update: {
      session_update: 'config_option_update',
      config_options: [{
        config_id: 'thought_level',
        label: 'Thinking level',
        current_value: { value_id: { value: 'high' } },
        value_type: 'select',
        schema: { enum: [{ value_id: 'low', name: 'Low' }, { value_id: 'high', name: 'High' }] },
      }],
    } }, context)

    expect(result.events[0].event).toMatchObject({
      type: 'session.config-updated',
      options: [{
        id: 'thought_level',
        value: 'high',
        valueType: 'select',
        editable: true,
        schema: { options: [{ value_id: 'low', name: 'Low' }, { value_id: 'high', name: 'High' }] },
      }],
    })
  })

  it('preserves explicit lifecycle status when session_info_update also carries mode', () => {
    const result = normalizeAcpEvent({ update: {
      sessionUpdate: 'session_info_update', mode: 'running', status: 'completed',
    } }, context)
    expect(result.events.map(item => item.event)).toEqual([
      { type: 'session.mode-updated', mode: 'running' },
      { type: 'session.status-updated', status: 'completed' },
    ])
    expect(new Set(result.events.map(item => item.eventId)).size).toBe(2)
  })

  it('keeps session_info_update mode out of lifecycle status', () => {
    const result = normalizeAcpEvent({ update: { sessionUpdate: 'session_info_update', mode: 'running', usage: { inputTokens: 2 } } }, context)
    expect(result.events[0].event).toEqual({ type: 'session.mode-updated', mode: 'running' })
  })

  it('accepts only explicit allowlisted lifecycle status', () => {
    const terminal = normalizeAcpEvent({ update: { sessionUpdate: 'session_info_update', status: 'completed' } }, context)
    expect(terminal.events[0].event).toEqual({ type: 'session.status-updated', status: 'completed' })
    const unknown = normalizeAcpEvent({ update: { sessionUpdate: 'session_info_update', status: 'mystery' } }, context)
    expect(unknown.events[0].event.type).toBe('session.mode-updated')
  })

  // #110 F5：模型事实是 session_info_update 里的独立第三件事，必须成事件落地。
  it('emits session.model-updated for nested models.currentModelId (camel and snake)', () => {
    const camel = normalizeAcpEvent({ update: {
      sessionUpdate: 'session_info_update', models: { currentModelId: 'nous:hermes-4' },
    } }, context)
    expect(camel.events.map(item => item.event)).toEqual([
      { type: 'session.model-updated', model: 'nous:hermes-4' },
    ])
    const snake = normalizeAcpEvent({ update: {
      sessionUpdate: 'session_info_update', models: { current_model_id: 'snake:id' },
    } }, context)
    expect(snake.events[0].event).toEqual({ type: 'session.model-updated', model: 'snake:id' })
  })

  it('emits session.model-updated alongside mode and status without collapsing the three facts', () => {
    const result = normalizeAcpEvent({ update: {
      sessionUpdate: 'session_info_update', mode: 'running', status: 'completed', model: 'flat:id',
    } }, context)
    expect(result.events.map(item => item.event)).toEqual([
      { type: 'session.mode-updated', mode: 'running' },
      { type: 'session.status-updated', status: 'completed' },
      { type: 'session.model-updated', model: 'flat:id' },
    ])
    expect(new Set(result.events.map(item => item.eventId)).size).toBe(3)
  })

  it('does not manufacture a model event from non-model session_info_update payloads', () => {
    // Hermes 实测形状：只有 title/_meta/updatedAt，无模型维度。
    const result = normalizeAcpEvent({ update: {
      sessionUpdate: 'session_info_update', title: '会话标题', updatedAt: '2026-09-01T00:00:00.000Z',
    } }, context)
    expect(result.events.map(item => item.event.type)).not.toContain('session.model-updated')
    // 空白 model 值不算模型事实。
    const blank = normalizeAcpEvent({ update: { sessionUpdate: 'session_info_update', model: '   ' } }, context)
    expect(blank.events.map(item => item.event.type)).not.toContain('session.model-updated')
  })
})

// #557：官方 CurrentModeUpdate 变体两栈语义化，不再落 unknown 兜底打「未识别」卡。
describe('ACP current_mode_update 模式事实（#557）', () => {
  it('官方字段 currentModeId → session.mode-updated，无 wire.unknown 诊断', () => {
    const result = normalizeAcpEvent({ update: {
      sessionUpdate: 'current_mode_update', currentModeId: 'high',
    } }, context)
    expect(result.events.map(item => item.event)).toEqual([
      { type: 'session.mode-updated', mode: 'high' },
    ])
    expect(result.diagnostics.map(item => item.code)).not.toContain('wire.unknown')
  })

  it('modeId 别名与内核 state.rs 同集消费', () => {
    const result = normalizeAcpEvent({ update: {
      sessionUpdate: 'current_mode_update', modeId: 'balanced',
    } }, context)
    expect(result.events[0].event).toEqual({ type: 'session.mode-updated', mode: 'balanced' })
  })

  it('缺 mode id（schema 违约）→ mode:undefined 的 mode-updated，不落 event.unknown', () => {
    const result = normalizeAcpEvent({ update: { sessionUpdate: 'current_mode_update' } }, context)
    expect(result.events.map(item => item.event)).toEqual([
      { type: 'session.mode-updated', mode: undefined },
    ])
    expect(result.events.map(item => item.event.type)).not.toContain('event.unknown')
  })
})

// 并入自 acpPlanNormalizer.test.ts（P91 A6：同 SUT 合并；游离 afterEach 收敛到文件级）
describe('ACP normalizer plan entries (C08)', () => {
  const hermesContext: NormalizeContext = {
    provider: 'hermes',
    sessionId: 'session-1',
    sourceId: 'wire-1',
    sequence: 1,
    recordedAt: '2026-08-21T00:00:00.000Z',
    provenance: { origin: 'local-observed', trust: 'authoritative' },
  }

  it('keeps cancelled entries and unknown statuses with raw status instead of collapsing to completed', () => {
    const result = normalizeAcpEvent({
      source: 'hermes',
      update: { sessionUpdate: 'plan', entries: [
        { content: '已完成', status: 'completed', priority: 'high' },
        { content: '进行中', status: 'in_progress' },
        { content: '已取消', status: 'cancelled' },
        { content: '被阻塞', status: 'blocked' },
        { content: '未知状态', status: 'waiting_review' },
      ] },
    }, hermesContext)
    const event = result.events[0].event
    if (event.type !== 'plan.replaced') throw new Error(`expected plan.replaced, got ${event.type}`)
    expect(event.entries).toEqual([
      { id: '已完成', content: '已完成', status: 'completed', priority: 'high' },
      { id: '进行中', content: '进行中', status: 'in_progress' },
      { id: '已取消', content: '已取消', status: 'cancelled' },
      { id: '被阻塞', content: '被阻塞', status: 'blocked' },
      { id: '未知状态', content: '未知状态', status: 'unknown', rawStatus: 'waiting_review' },
    ])
  })

  it('derives stable ids from explicit id, itemId or content fallback and drops non-object entries', () => {
    const result = normalizeAcpEvent({
      source: 'hermes',
      update: { sessionUpdate: 'plan', entries: [
        { id: 't-9', content: '显式 id', status: 'pending' },
        { itemId: 'i-2', content: 'item id 兜底', status: 'pending' },
        { content: '内容兜底', status: 'pending' },
        'garbage',
        { noContent: true, status: 'pending' },
      ] },
    }, hermesContext)
    const event = result.events[0].event
    if (event.type !== 'plan.replaced') throw new Error(`expected plan.replaced, got ${event.type}`)
    expect(event.entries).toEqual([
      { id: 't-9', content: '显式 id', status: 'pending' },
      { id: 'i-2', content: 'item id 兜底', status: 'pending' },
      { id: '内容兜底', content: '内容兜底', status: 'pending' },
    ])
  })
})

// ── #315 P0-4：peri tokenStats _meta 深消费 + _meta.skillNames 接线 ─────────

describe('peri _meta deep consumption (#315)', () => {
  it('usage_update._meta 深消费 token 键与身份证据键，非法数值不伪造', () => {
    const result = normalizeAcpEvent({
      source: 'peri',
      update: {
        sessionUpdate: 'usage_update',
        used: 53000,
        size: 200000,
        _meta: {
          inputTokens: 12000,
          outputTokens: 3400,
          cacheCreationTokens: 512,
          cacheReadTokens: 780,
          model: 'deepseek-v4',
          requestId: 'req-42',
          stopReason: 'end_turn',
          inputTokensBad: '12',
        },
      },
    }, context)
    const usage = result.events[0]?.event.type === 'usage.updated'
      ? (result.events[0].event as { usage: Record<string, unknown> }).usage
      : undefined
    expect(usage).toBeDefined()
    expect(usage).toMatchObject({
      inputTokens: 12000,
      outputTokens: 3400,
      cacheCreationTokens: 512,
      cacheReadTokens: 780,
      model: 'deepseek-v4',
      requestId: 'req-42',
      providerStopReason: 'end_turn',
      contextUsed: 53000,
      contextLimit: 200000,
    })
  })

  it('available_commands_update 透传 _meta.skillNames；空集与非字符串不产出', () => {
    const withSkills = normalizeAcpEvent({
      source: 'peri',
      update: {
        sessionUpdate: 'available_commands_update',
        commands: [{ name: '/help' }],
        _meta: { skillNames: ['review', '  ', 'deploy'] },
      },
    }, context)
    expect(withSkills.events[0]?.event).toMatchObject({
      type: 'session.commands-updated',
      skillNames: ['review', 'deploy'],
    })

    const empty = normalizeAcpEvent({
      source: 'peri',
      update: {
        sessionUpdate: 'available_commands_update',
        commands: [{ name: '/help' }],
        _meta: { skillNames: ['   '] },
      },
    }, context)
    expect((empty.events[0]?.event as { skillNames?: unknown }).skillNames).toBeUndefined()
  })
})

/** #393：ACP `SessionInfoUpdate.title` 是 `MaybeUndefined` 三态——「缺席 = 不修改」
 *  由「不产出事件」表达，`null` 必须产出**清空**事实而不是被吞掉，否则 Agent 撤回
 *  标题后界面会一直挂着旧名字。 */
describe('ACP session_info_update 标题事实', () => {
  const sessionInfo = (update: Record<string, unknown>, sequence = 21) => normalizeAcpEvent({
    source: 'peri',
    update: { sessionUpdate: 'session_info_update', ...update },
  }, { ...context, sequence })

  it('带值（含 mode 同包）→ 产出 session.title-updated', () => {
    const result = sessionInfo({ title: 'Riccati 助手介绍', mode: 'build' })
    expect(result.events.map(event => event.event)).toContainEqual({
      type: 'session.title-updated',
      title: 'Riccati 助手介绍',
    })
    expect(result.events.map(event => event.event)).toContainEqual({ type: 'session.mode-updated', mode: 'build' })
  })

  it('显式 null → 产出清空事实（title: null）', () => {
    const result = sessionInfo({ title: null })
    expect(result.events.map(event => event.event)).toContainEqual({ type: 'session.title-updated', title: null })
  })

  it('键缺席 → 不产出标题事实（「不改」不得冒充「清空」）', () => {
    const result = sessionInfo({ mode: 'build' })
    expect(result.events.some(event => event.event.type === 'session.title-updated')).toBe(false)
  })

  it('空白串按清空收敛（空标题不是标题）', () => {
    const result = sessionInfo({ title: '   ' })
    expect(result.events.map(event => event.event)).toContainEqual({ type: 'session.title-updated', title: null })
  })
})
