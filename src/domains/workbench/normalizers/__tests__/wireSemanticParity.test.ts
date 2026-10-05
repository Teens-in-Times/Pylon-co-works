import { describe, expect, it } from 'vitest'
import {
  CANONICAL_TYPE_FOR_WIRE,
  PERI_EXTENSION_WIRE_KINDS,
  STANDARD_WIRE_SESSION_UPDATE_KINDS,
  WORKBENCH_TYPE_FOR_WIRE,
  canonicalTypeForToolCallUpdate,
  type StandardWireSessionUpdateKind,
} from '../../../events/wireSemanticCorrespondence.ts'
import { canonicalEventTypeFor } from '../../../events/canonicalNormalizer.ts'
import { normalizeAcpEvent } from '../acpNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

const base: NormalizeContext = {
  provider: 'some-acp',
  sessionId: 'parity-session',
  sourceId: 'live-1',
  sequence: 1,
  recordedAt: '2026-09-25T00:00:00.000Z',
  provenance: { origin: 'local-observed', trust: 'authoritative' },
}

/** 每个标准 wire 判别符的最小代表 payload（覆盖 acpNormalizer 各分支入口）。 */
const REPRESENTATIVE_PAYLOAD: Record<StandardWireSessionUpdateKind, Record<string, unknown>> = {
  user_message_chunk: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
  agent_message_chunk: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yo' } },
  agent_thought_chunk: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
  tool_call: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read a.ts' },
  tool_call_update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
  plan: { sessionUpdate: 'plan', entries: [{ content: 'step', priority: 1, status: 'pending' }] },
  usage_update: { sessionUpdate: 'usage_update', used: 10, size: 200 },
  available_commands_update: { sessionUpdate: 'available_commands_update', commands: [{ name: '/help' }] },
  config_option_update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', name: 'Mode', options: [] }] },
  session_info_update: { sessionUpdate: 'session_info_update', mode: 'build' },
  done: { sessionUpdate: 'done', stopReason: 'end_turn' },
  error: { sessionUpdate: 'error', error: 'boom' },
  cancelled: { sessionUpdate: 'cancelled' },
  current_mode_update: { sessionUpdate: 'current_mode_update', currentModeId: 'build' },
}

/** #315 P2：同一 wire 判别符在 canonical / workbench 两栈下的语义方向由
 *  wireSemanticCorrespondence 单源钉住——一侧 switch 改动不同步即红。 */
describe('canonical ↔ workbench wire 语义对应（单源表 parity）', () => {
  it.each(STANDARD_WIRE_SESSION_UPDATE_KINDS.map(kind => [kind]))('%s → canonical 侧映射与单源表一致', kind => {
    const status = kind === 'tool_call_update' ? 'running' : undefined
    expect(canonicalEventTypeFor(kind, status)).toBe(
      kind === 'tool_call_update' ? canonicalTypeForToolCallUpdate(status) : CANONICAL_TYPE_FOR_WIRE[kind],
    )
  })

  it.each(STANDARD_WIRE_SESSION_UPDATE_KINDS.map(kind => [kind]))('%s → workbench 侧产出落在对应表集合内', kind => {
    const result = normalizeAcpEvent({ update: REPRESENTATIVE_PAYLOAD[kind] }, base)
    const emitted = result.events.map(event => event.event.type)
    expect(emitted.length).toBeGreaterThan(0)
    for (const type of emitted) {
      expect(WORKBENCH_TYPE_FOR_WIRE[kind]).toContain(type)
    }
  })

  it('peri 扩展判别符：canonical 恒归 unknown（raw 保留），workbench 由 periNormalizer 语义化', () => {
    for (const kind of PERI_EXTENSION_WIRE_KINDS) {
      expect(canonicalEventTypeFor(kind, undefined)).toBe('unknown')
      expect(kind in WORKBENCH_TYPE_FOR_WIRE).toBe(false)
    }
  })
})
