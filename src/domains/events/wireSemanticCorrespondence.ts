/**
 * #315 P2：wire 判别符 → 语义事件方向的单源对应表。
 *
 * 同一条 ACP wire 有两个归一化消费栈（EVT-03 canonical / C 系列 workbench），
 * 此前各自维护 switch 且已出现口径漂移（session_info_update 一边映射
 * session.model-updated、一边映射 session.mode-updated）。本模块是对应关系的
 * 唯一权威：
 *
 * - `CANONICAL_TYPE_FOR_WIRE`：canonical 栈权威映射（canonicalNormalizer 委托）；
 * - `WORKBENCH_TYPE_FOR_WIRE`：workbench acpNormalizer 对同一 wire 判别符允许
 *   产出的语义事件类型集合——parity 测试（normalizers/__tests__）双向钉住：
 *   一侧改动不同步即红。
 *
 * 口径裁决：`session_info_update` 包是 mode/status/model/title 四个独立事实的载体，
 * canonical 侧曾整包映射 `session.model-updated`（漂移源）；现按 workbench 语义
 * 收敛为 `session.mode-updated`（mode 是包内必有事实，model/status/title 由
 * workbench 侧拆分产出，canonical 侧 typedPayload 仍保留原始字段不丢）。
 * `current_mode_update`（#557 翻案）两栈均语义化为 `session.mode-updated`——
 * canonical 侧自 #315 P2 在册；workbench 侧 #315 时曾落 unknown 兜底，实测打
 * 「未识别」卡（#556/#557），现由 acpNormalizer 拆 mode 事实。
 * `cancelled`（legacy 终态）仅 canonical 侧映射；workbench 侧落 unknown 兜底——
 * 对应表中显式声明，不是缺口。
 */

import type { CanonicalEventType } from './eventSchema.ts'

/** 标准 ACP session/update 判别符 + canonical 侧 legacy 别名 + 传输层终态。 */
export const STANDARD_WIRE_SESSION_UPDATE_KINDS = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage_update',
  'available_commands_update',
  'config_option_update',
  'session_info_update',
  'done',
  'error',
  'cancelled',
  'current_mode_update',
] as const

export type StandardWireSessionUpdateKind = (typeof STANDARD_WIRE_SESSION_UPDATE_KINDS)[number]

export const CANONICAL_TYPE_FOR_WIRE: Readonly<Record<StandardWireSessionUpdateKind, CanonicalEventType>> = Object.freeze({
  user_message_chunk: 'user.message',
  agent_message_chunk: 'assistant.text.delta',
  agent_thought_chunk: 'assistant.thinking.delta',
  tool_call: 'tool.call.started',
  tool_call_update: 'tool.call.updated',
  plan: 'plan.replaced',
  usage_update: 'usage.updated',
  available_commands_update: 'session.commands-updated',
  config_option_update: 'session.config-updated',
  session_info_update: 'session.mode-updated',
  done: 'turn.completed',
  error: 'turn.failed',
  cancelled: 'turn.failed',
  current_mode_update: 'session.mode-updated',
})

/** `tool_call_update` 按 status 细化（两栈同规则）；canonical 侧同享。 */
export function canonicalTypeForToolCallUpdate(status: unknown): CanonicalEventType {
  if (status === 'completed') return 'tool.call.completed'
  if (status === 'failed' || status === 'error') return 'tool.call.failed'
  return 'tool.call.updated'
}

export const WORKBENCH_TYPE_FOR_WIRE: Readonly<Record<StandardWireSessionUpdateKind, readonly string[]>> = Object.freeze({
  user_message_chunk: ['message.delta'],
  agent_message_chunk: ['message.delta'],
  agent_thought_chunk: ['reasoning.delta'],
  tool_call: ['tool.started'],
  tool_call_update: ['tool.progress', 'tool.completed', 'tool.failed'],
  plan: ['plan.replaced'],
  usage_update: ['usage.updated'],
  available_commands_update: ['session.commands-updated'],
  config_option_update: ['session.config-updated'],
  // session_info_update 包按事实拆分（mode/status/model/title 各自独立事件）；
  // 空包兜底产出 mode:undefined 的 mode-updated（见 acpNormalizer）。
  session_info_update: ['session.mode-updated', 'session.status-updated', 'session.model-updated', 'session.title-updated'],
  done: ['session.completed'],
  error: ['diagnostic.notice'],
  // legacy 变体：canonical 侧收敛 turn.failed，workbench 侧落 unknown 兜底
  // （标准 ACP 的取消语义经 done.stopReason 表达，wire 上不该出现该判别符）。
  cancelled: ['event.unknown'],
  // #557 翻案：官方 CurrentModeUpdate 变体两栈语义化（见文件头口径裁决）。
  current_mode_update: ['session.mode-updated'],
})

/** #315 Peri 私有扩展通道（`AcpKind::ProviderExtension` 包络后的判别符）。
 *  canonical 侧恒归 unknown（raw 保留）；workbench 侧由 periNormalizer 语义化。 */
export const PERI_EXTENSION_WIRE_KINDS = [
  'peri/agent_event',
  'peri/agent_event_done',
  'peri/unstable-event',
  'peri/prediction_ready',
] as const

export type PeriExtensionWireKind = (typeof PERI_EXTENSION_WIRE_KINDS)[number]
