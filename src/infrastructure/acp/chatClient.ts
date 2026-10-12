/**
 * chatClient — 聊天域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * send_message / set_config_option / set_mode 的
 * command/payload 收口；不吞业务错误。
 */
import { ClientTransport } from './agentClient'
import type { Channel } from '@tauri-apps/api/core'
import { tauriInvokeTransport } from './tauriTransport.ts'
import type { PylonStreamWireEvent } from '../events/pylonStreamWireEvents.ts'

/** B1：流式帧信封（与 src/components/chat/streamChannel.ts 的 StreamFrame 同构；事件名单一来源见 pylonStreamWireEvents）。 */
export type StreamFrame = { event: PylonStreamWireEvent; payload: unknown }

export interface SendMessagePayload {
  /** OWNER-02：Session owner 显式 agentId（路由到 owner runtime，绝不 fallback active） */
  agentId: string
  /** D3：允许 send_message 自动建槽位时仍保留完整 durable owner。 */
  profileId: string
  source: string
  content: string
  persona: string
  sessionPrompt: string
  attachments: string[]
  /** 持久化的远端会话 id：Pylon 重启后内存映射为空时，后端先 session/load 复活原会话。 */
  periId?: string
}

export interface CancelPromptPayload {
  agentId: string
  source: string
}

export interface SetModePayload {
  agentId: string
  source: string
  mode: string
}

export interface SetConfigOptionPayload {
  agentId: string
  source: string
  key: string
  value: unknown
}

export function createChatClient(transport: ClientTransport) {
  return {
    sendMessage: (payload: SendMessagePayload): Promise<unknown> => transport.invoke('send_message', payload),
    /** B1：流式发送——onUpdate 为 Channel 实例（openStreamChannel 产出），后端按注册走 Channel 推送。 */
    sendMessageStreaming: (payload: SendMessagePayload, onUpdate: Channel<StreamFrame>): Promise<unknown> =>
      transport.invoke('send_message_streaming', { ...payload, onUpdate }),
    cancelPrompt: (payload: CancelPromptPayload): Promise<unknown> => transport.invoke('cancel_prompt', payload),
    setConfigOption: (payload: SetConfigOptionPayload): Promise<unknown> => transport.invoke('set_config_option', payload),
    setMode: (payload: SetModePayload): Promise<unknown> => transport.invoke('set_mode', payload),
  }
}

/** Renderer-safe bridge for the desktop transport.  Tauri remains an
 * infrastructure concern; Workbench hosts consume the typed client only. */
export function createTauriChatClient() {
  return createChatClient({
    invoke: tauriInvokeTransport,
  })
}

export type ChatClient = ReturnType<typeof createChatClient>
