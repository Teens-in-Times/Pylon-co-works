import { describe, expect, it } from 'vitest'
import { createWorkbenchDocument, projectWorkbench } from '../../domains/workbench/workbenchProjector.ts'
import { normalizeSessionConfigOptions } from '../../domains/workbench/session/sessionSurface.ts'
import { createCanonicalEvent } from '../../domains/events/eventSchema.ts'
import { messageSnapshotToWorkbenchEnvelopes } from '../../application/agent-workbench/messageSnapshotProjection.ts'
import type { Message } from '../../domains/chat/messageTypes.ts'
import { persistMessageSnapshot } from '../../domains/chat/messagePersistence.ts'
import { createAgentWorkbenchSessionRuntime } from '../../application/agent-workbench/agentWorkbenchSession.ts'
import type { Session } from '../../domains/identity/identityStore.ts'
import { MOCK_MESSAGES } from '../../demo/chatMockData.ts'

/** The shape an ACP provider advertises: every option carries its own choices. */
const PROVIDER_OPTIONS = [
  { id: 'model', name: 'Model', type: 'select', currentValue: 'haiku',
    options: [{ value: 'fable' }, { value: 'opus' }, { value: 'haiku' }] },
  { id: 'mode', name: 'Session Mode', type: 'select', currentValue: 'default',
    options: [{ value: 'default' }, { value: 'accept_edit' }, { value: 'auto' }] },
  { id: 'thinking_effort', name: 'Thinking Effort', type: 'select', currentValue: 'max',
    options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] },
]

function demoSession(id: string, name: string): Session {
  return {
    id, agentId: 'peri', profileId: 'default', source: `local:${id}`,
    name, createdAt: 1, lastActiveAt: 2, platform: 'local', workdir: '/tmp',
    sessionPrompt: '', skills: [], hooks: [], autoName: '',
  }
}

/** Put the provider's advertised surface into the document, as a bind/replay does. */
function seedProviderOptions(runtime: ReturnType<typeof createAgentWorkbenchSessionRuntime>, session: Session): void {
  const base = createWorkbenchDocument(session.source)
  runtime.runtime.replaceDocument({
    ...base,
    session: { ...base.session, model: 'haiku', options: normalizeSessionConfigOptions(PROVIDER_OPTIONS) },
  })
}

describe('browser message snapshot bridge', () => {
  it('retains the demo structured content in canonical parts and skips a completed empty placeholder', () => {
    const source = MOCK_MESSAGES.find(message => message.id === 'mock-assistant-structured')!
    const document = projectWorkbench(messageSnapshotToWorkbenchEnvelopes('demo-rich', [
      source,
      { id: 'empty', role: 'assistant', sender: 'assistant', content: '', time: '' },
    ])).document
    expect(document.messages).toHaveLength(1)
    expect(document.messages[0].parts).toEqual([{ kind: 'markdown', text: source.content }, ...source.semanticParts!])
    expect(document.messages[0].parts.map(part => part.kind)).toEqual(['markdown', 'location', 'progress', 'list', 'key-value', 'json', 'tool-use', 'tool-result', 'artifact', 'document', 'resource'])
  })

  it('normalizes wire blocks, preserves media-only messages, and does not duplicate mirrored body text', () => {
    const document = projectWorkbench(messageSnapshotToWorkbenchEnvelopes('snapshot-parts', [
      { id: 'mirrored', role: 'assistant', sender: 'assistant', content: 'hello world', time: '',
        semanticParts: [{ kind: 'text', text: 'hello ' }, { kind: 'text', text: 'world' }] },
      { id: 'media', role: 'assistant', sender: 'assistant', content: '', time: '',
        contentBlocks: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' }, mimeType: 'image/png' }] },
    ])).document
    expect(document.messages).toHaveLength(2)
    expect(document.messages[0].content).toBe('hello world')
    expect(document.messages[1].parts).toEqual([expect.objectContaining({ kind: 'image', source: 'https://example.com/image.png' })])
  })

  it('preserves unsupported structured evidence as unknown rather than dropping or throwing', () => {
    const document = projectWorkbench(messageSnapshotToWorkbenchEnvelopes('snapshot-invalid', [{
      id: 'bad-structure', role: 'assistant', sender: 'assistant', content: '', time: '',
      semanticParts: [null, { kind: 'image', source: 42 }] as never,
    }])).document
    expect(document.messages[0].parts.map(part => part.kind)).toEqual(['unknown', 'unknown'])
  })

  it('preserves adjacent complete assistant messages and their Markdown boundaries verbatim', () => {
    const texts = ['A fenced example:\n\n```ts\nexport type ToolState = "completed"\n```', 'Plain text after the code.\nSecond line.']
    const messages: Message[] = texts.map((content, index) => ({
      id: `assistant-${index}`, role: 'assistant', sender: 'assistant', content, time: '',
    }))
    const envelopes = messageSnapshotToWorkbenchEnvelopes('demo-boundaries', messages, 'peri')
    expect(envelopes.every(event => event.source.provider === 'peri' && event.provenance.trust === 'unverified' && event.provenance.provider === 'browser-demo')).toBe(true)
    const document = projectWorkbench(envelopes).document
    expect(document.messages.map(message => message.content)).toEqual(texts)
    expect(document.messages.map(message => message.parts)).toEqual(texts.map(text => [{ kind: 'markdown', text }]))
    expect(document.messages.every(message => !message.running)).toBe(true)
  })

  it('projects legacy visual messages into the terminal Workbench document', () => {
    const messages: Message[] = [
      { id: 'u-1', role: 'user', sender: 'user', content: '检查渲染', time: '' },
      { id: 't-1', role: 'tool', sender: 'assistant', content: '', time: '', toolName: 'Browser', toolKind: 'browser', toolInput: 'capture', toolOutput: 'PASS', toolStatus: 'completed' },
      { id: 'a-1', role: 'assistant', sender: 'assistant', content: '渲染已恢复。', time: '' },
    ]
    const envelopes = messageSnapshotToWorkbenchEnvelopes('demo', messages)
    const document = projectWorkbench(envelopes).document

    expect(document.messages.map(message => [message.role, message.content])).toEqual([
      ['user', '检查渲染'],
      ['assistant', '渲染已恢复。'],
    ])
    expect(document.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', title: 'Browser', status: 'completed' }),
    ]))
  })

  it('binds the browser Session.id snapshot into the Solid runtime', async () => {
    const session: Session = {
      id: 'demo-visual-matrix', agentId: 'peri', profileId: 'default', source: 'local:demo-visual-matrix',
      name: '渲染状态全景', createdAt: 1, lastActiveAt: 2, platform: 'local', workdir: '/path/to/pylon',
      sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }
    persistMessageSnapshot(session.id, [{ id: 'assistant-1', role: 'assistant', sender: 'assistant', content: 'Solid 已读取 mock', time: '' }], localStorage)
    expect(localStorage.getItem(`pylon-msgs-${session.id}`)).toContain('Solid 已读取 mock')
    const runtime = createAgentWorkbenchSessionRuntime({ subscribe: () => () => {} })
    await runtime.bind(session)
    expect(runtime.runtime.getSnapshot().document?.messages.map(message => message.content)).toEqual(['Solid 已读取 mock'])
    expect(runtime.runtime.getSnapshot().document?.messages[0].source.provider).toBe('peri')
    runtime.destroy()
  })

  it('recovers snapshots written under the legacy provider source key', async () => {
    const session: Session = {
      id: 'demo-source-key', agentId: 'peri', profileId: 'default', source: 'local:demo-source-key',
      name: '旧 key', createdAt: 1, lastActiveAt: 2, platform: 'local', workdir: '/tmp',
      sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }
    persistMessageSnapshot(session.source, [{ id: 'legacy-1', role: 'assistant', sender: 'peri', content: 'legacy source key', time: '' }], localStorage)
    const runtime = createAgentWorkbenchSessionRuntime({ subscribe: () => () => {} })
    await runtime.bind(session)
    expect(runtime.runtime.getSnapshot().document?.messages.map(message => message.content)).toEqual(['legacy source key'])
    runtime.destroy()
  })

  // A provider may accept a write without notifying clients at all (Hermes never
  // emits `current_mode_update`), so the confirmed value has to be published
  // locally. It goes in as a document fact rather than as a synthetic session
  // response: that shape replaces the whole `session.options` surface, which used
  // to drop the others (a model switch emptied the mode and reasoning catalogues).
  it('publishes a confirmed mode switch into both the session field and its option', async () => {
    const session = demoSession('demo-mode-fact', '模式镜像')
    const runtime = createAgentWorkbenchSessionRuntime({ subscribe: () => () => {} })
    await runtime.bind(session)
    seedProviderOptions(runtime, session)
    expect(runtime.runtime.getSnapshot().document?.session.mode).not.toBe('dont_ask')

    runtime.applyLocalSessionFact({ kind: 'mode', mode: 'dont_ask' }, session.id)

    const document = runtime.runtime.getSnapshot().document
    expect(document?.session.mode).toBe('dont_ask')
    expect(document?.session.options.map(option => option.id)).toEqual(['model', 'mode', 'thinking_effort'])
    // 中控读 session.mode、配置面板读 options[].value —— 本地写入必须两处都写，
    // 否则点完之后两块地方对同一件事给出两个答案。
    expect(document?.session.mode).toBe(document?.session.options.find(option => option.id === 'mode')?.value)
    runtime.destroy()
  })

  it('keeps the whole provider catalogue when a model switch is confirmed locally', async () => {
    const session = demoSession('demo-model-fact', '模型镜像')
    const runtime = createAgentWorkbenchSessionRuntime({ subscribe: () => () => {} })
    await runtime.bind(session)
    seedProviderOptions(runtime, session)

    runtime.applyLocalSessionFact({ kind: 'model', model: 'opus' }, session.id)

    const document = runtime.runtime.getSnapshot().document
    expect(document?.session.model).toBe('opus')
    expect(document?.session.options.map(option => option.id)).toEqual(['model', 'mode', 'thinking_effort'])
    expect(document?.session.model).toBe(document?.session.options.find(option => option.id === 'model')?.value)
    runtime.destroy()
  })

  it('writes one config option without shrinking the rest of the catalogue', async () => {
    const session = demoSession('demo-option-fact', '配置项镜像')
    const runtime = createAgentWorkbenchSessionRuntime({ subscribe: () => () => {} })
    await runtime.bind(session)
    seedProviderOptions(runtime, session)

    runtime.applyLocalSessionFact({ kind: 'option', id: 'thinking_effort', value: 'high' }, session.id)

    const document = runtime.runtime.getSnapshot().document
    expect(document?.session.options.find(option => option.id === 'thinking_effort')?.value).toBe('high')
    expect(document?.session.options.map(option => option.id)).toEqual(['model', 'mode', 'thinking_effort'])
    runtime.destroy()
  })

  // 重放（bind/refresh）要从 journal 行把文档重建出来：一个 config 包会产出**多条**语义
  // 事件（options + 当前 mode/model）。它们必须全部进文档 —— 只进一条的话，重载后中控
  // （读 session.mode/model）与配置面板（读 options[].value）就又会各说各话。
  it('keeps every event a journal config row carries when replaying', async () => {
    const session = demoSession('demo-replay-config', '重放一致性')
    const row = createCanonicalEvent({
      owner: { profileId: 'default', agentId: 'peri', localSessionId: session.source },
      clientGeneration: 1,
      sequence: 1,
      occurredAt: '2026-09-18T00:00:00.000Z',
      eventType: 'session.config-updated',
      payloadVersion: 1,
      rawPayload: { sessionId: 'remote-1', update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'accept_edit',
            options: [{ value: 'default' }, { value: 'accept_edit' }] },
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fable',
            options: [{ value: 'fable' }, { value: 'haiku' }] },
        ],
      } },
    })
    const runtime = createAgentWorkbenchSessionRuntime({ subscribe: () => () => {}, loadAll: async () => [row] })
    await runtime.bind(session)

    const document = runtime.runtime.getSnapshot().document
    const modeOption = document?.session.options.find(option => option.id === 'mode')
    const modelOption = document?.session.options.find(option => option.id === 'model')
    expect(document?.session.mode).toBe(modeOption?.value)
    expect(document?.session.model).toBe(modelOption?.value)
    expect(document?.session.mode).toBe('accept_edit')
    expect(document?.session.model).toBe('fable')
    runtime.destroy()
  })
})
