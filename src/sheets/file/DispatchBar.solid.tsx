/** @jsxImportSource solid-js */
import { createMemo, createSignal, Show } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { reportRuntimeError } from '../../app/runtimeError'
import { buildDispatchMessage, type DispatchSelection } from '../../domains/file/dispatchMessage.ts'
import { resolveDispatchOwnerSession } from './dispatchOwnerSession.ts'

/**
 * DispatchBarProps — 名字承自历史 React 契约（DispatchBar.tsx，已退役）；本实体即唯一真源。
 */
interface DispatchBarProps {
  targetSource: string | null
  targetSessionId?: string | null
  context?: { agentId: string; source: string } | null
  filePath: string | null
  selection: DispatchSelection | null
  /** 0-A1：编辑事实在 CM 内核——宿主经取景器给发送时刻的全文，不再传内容 state。 */
  content?: string
  getContent?: () => string
  instruction: string
  onInstructionChange: (value: string) => void
  onClearSelection: () => void
}

/**
 * DispatchBar — 发令指令栏（W2-08，§4.1；#515 Solid 实体）。
 *
 * 选区事实来自 CM 内核 KernelSummary（0-A1 起旧 DOM data-line 捕获随投影退役）；
 * 发送调 send_message 显式 source + persona:''；
 * 调用发出后（invoke 同步创建成功）清 instruction 保留选区；错误内联。目标会话
 * 生成中仅提示不禁用（send_message 阻塞语义由后端串行化）。
 *
 * OWNER-02（§5.8）：send_message 载荷携带显式 agentId——优先取 context（sheet 绑定
 * Agent，I01-W3）；context 缺失时回退 Session owner（identityStore 中 source 唯一命中）；
 * 仍无法确定则拒绝发送（不串线）。
 */
export default function DispatchBar(props: DispatchBarProps) {
  const [error, setError] = createSignal('')
  // selector 只读 store 切片（返回数组引用，稳定）；targetSource 是 props 响应式状态，
  // 按 solidStoreBridge ⚠️ 约定在组件侧用 createMemo 并读（selector 内不读组件状态，
  // `|| []` 的 #185 引用稳定性语义由数组切片 + includes memo 承接）。
  const liveGeneratingSources = createZustandSignal(useRuntimeStore, s => s.liveGeneratingSources ?? [])
  const generating = createMemo(() => liveGeneratingSources().includes(props.targetSource || ''))

  const send = async () => {
    setError('')
    if (!props.targetSource || !props.filePath || !props.instruction.trim()) return
    // OWNER-02：owner agentId 从 sheet context 或 Session owner 解析（绝不取 activeAgent）。
    const ownerSession = resolveDispatchOwnerSession(
      useIdentityStore.getState().sessions,
      props.targetSource,
      props.context,
      props.targetSessionId,
    )
    if (!ownerSession) {
      setError('无法确定目标会话的完整归属')
      return
    }
    const message = buildDispatchMessage({
      filePath: props.filePath,
      selection: props.selection,
      instruction: props.instruction,
      content: props.getContent ? props.getContent() : (props.content ?? ''),
      truncated: false,
    })
    try {
      await appClients.chat.sendMessage({ agentId: ownerSession.agentId, profileId: ownerSession.profileId, source: props.targetSource, content: message, persona: '', sessionPrompt: '', attachments: [] })
      // invoke 已发出（同步创建成功即清）——不等 resolve，保留选区
      props.onInstructionChange('')
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err)
      setError(messageText)
      reportRuntimeError('发送指令', err)
    }
  }

  return (
    <Show
      when={props.filePath}
      fallback={
        <div class="dispatch-bar dispatch-bar-collapsed">
          <span class="dispatch-target">{props.targetSource || '未指向会话'}</span>
          <span class="dispatch-hint">先选中文件或框选代码</span>
        </div>
      }
    >
      <div class="dispatch-bar">
        <span class="dispatch-target">{props.targetSource || '未指向会话'}</span>
        <span class="dispatch-chip" title={props.filePath ?? undefined}>
          📄 {props.filePath}
          <Show when={props.selection} fallback={<span class="dispatch-chip-lines"> 整文件</span>}>
            <span class="dispatch-chip-lines"> L{props.selection!.startLine}-L{props.selection!.endLine}</span>
          </Show>
          <button type="button" class="dispatch-chip-clear" onClick={() => props.onClearSelection()} aria-label="清除选中">✕</button>
        </span>
        <input
          class="dispatch-input"
          type="text"
          placeholder="输入指令…"
          value={props.instruction}
          onInput={event => { props.onInstructionChange(event.currentTarget.value); setError('') }}
          onKeyDown={event => { if (event.key === 'Enter') void send() }}
          aria-label="发令指令"
        />
        <button
          type="button"
          class="dispatch-send"
          onClick={() => void send()}
          disabled={!props.targetSource || !props.instruction.trim()}
        >
          发送
        </button>
        <Show when={generating()}><span class="dispatch-generating">生成中，消息将排队</span></Show>
        <Show when={error()}><span class="dispatch-error" role="alert">{error()}</span></Show>
      </div>
    </Show>
  )
}
