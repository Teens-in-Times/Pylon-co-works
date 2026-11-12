/** @jsxImportSource solid-js */
import { createEffect, createMemo, on, onCleanup, Show } from 'solid-js'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useModalOverlayStore } from '../app/modalOverlayStore'
import { getPermissionController } from '../infrastructure/acp/permissionController'
import { activeForAgent } from '../domains/permission/permissionState.ts'
import { resolvePermissionButtons } from '../domains/permission/permissionButtons.ts'
import { createDialogFocus } from './ui/dialogFocus'
import ElicitationRequestCard from './ElicitationRequestCard.solid.tsx'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'

/**
 * PermissionDialog — 动态权限弹窗（P0-03）。
 *
 * App 单例挂载，读当前 agent 的权限切片 active（P1-1：activeForAgent）：
 * 无 active 返回 null；后台 agent 请求停放不展示。
 * options[] 按 wire 顺序动态生成按钮，optionId 原样回传 controller.choose
 * （D15——不硬编码 Peri/Hermes 按钮集）；answering 禁用全部按钮防双击。
 * P1 结构化 diff 未落地前仅展示 prompt，不阻塞审批（后续增强）。
 *
 * 样式绞杀（P93）：原 PermissionDialog.css 的 utility 化。
 * #306：原面板消费 --settings-surface/--settings-shadow，但这两个 token 只在
 * `.settings-surface` 作用域内定义，本弹窗挂 App 顶层（App.tsx）取不到——悬空引用在
 * computed-value time 无效，background/box-shadow 落到 initial，面板全透明、聊天正文
 * 穿透。改消费全局声明的 --surface-overlay（与 `.dialog-content` 以 --dialog-bg 兜底到
 * --surface-overlay 是同一先例）与 --shadow-float。
 * 遮罩同理：原「--bg-panel 取 60%」的写法里 --bg-panel 是面板内层叠的 3~4% 着色 token，
 * 在基础方案只剩约 1.9% 黑，故改用与 `.dialog-overlay` 基线一致的固定 30% 黑（不加模糊）。
 *
 * #515：Solid 实体（App.solid 直连）。模态覆盖契约（#309）：active 期间经
 * useModalOverlayStore.setOverlayOpen('permission', true) 让宿主隐藏原生子视图
 * （浏览器 WebView2，否则审批按钮被原生页面吃掉点击）；关闭/卸载回 false。
 */
const OVERLAY = 'fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(0,0,0,0.3)]'
const DIALOG = 'w-[min(480px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-y-auto p-4 border border-border rounded-none bg-[var(--surface-overlay)] shadow-[var(--shadow-float)] text-text font-[family-name:var(--font)]'
const TITLE = 'font-semibold text-md mb-2'
const META = 'font-mono text-[11px] text-text-dim mb-2 break-all'
const PROMPT = 'text-[13px] text-text bg-bg-input border border-border rounded-none px-2.5 py-2 mb-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words'
const OPTIONS = 'flex flex-wrap gap-2'
const ERROR = 'text-[12px] text-[var(--danger,#c0392b)] mb-2 break-all'
const DISMISS = 'flex-[0_0_auto] min-w-[60px] px-3 py-1.5 text-[13px] font-[family-name:var(--font)] text-text-dim bg-transparent border border-border rounded-none cursor-pointer hover:text-text hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const BTN = 'flex-[1_1_auto] min-w-[96px] px-3 py-1.5 text-[13px] font-[family-name:var(--font)] text-text bg-bg-active border border-border rounded-none cursor-pointer enabled:hover:bg-bg-hover enabled:hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-[var(--state-disabled-opacity)] disabled:cursor-not-allowed'

export default function PermissionDialog() {
  // P1-1：permission 状态按 agent 切片隔离——只展示当前 agent 的 active（后台 agent 停放）
  // #326：空串 = 没有 Agent；空串下 activeForAgent 不命中任何切片（首跑无权限可展示）。
  // selector ⚠️ 约定（solidStoreBridge 头注）：selector 只读 store；activeAgent 在组件侧
  // memo 组合，避免切片读旧值。
  const permission = createZustandSignal(useRuntimeStore, s => s.permission)
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const active = createMemo(() => activeForAgent(permission(), activeAgent()))
  // #309：权限弹窗是覆盖主区的模态层——打开期间让原生子视图（浏览器 WebView2）暂时
  // 隐藏，否则审批按钮被原生页面吃掉点击。
  createEffect(on(() => active() != null, isActive => {
    useModalOverlayStore.getState().setOverlayOpen('permission', isActive)
    onCleanup(() => useModalOverlayStore.getState().setOverlayOpen('permission', false))
  }, { defer: true }))

  const onChoose = (requestId: string, optionId: string, answering: boolean) => {
    if (answering) return
    void getPermissionController()?.choose(requestId, optionId)
  }
  // #209：本地收口出口。`choose` 失败会退回 pending 以便重试，但请求在**后端已不存在**
  // （回合被取消/截断）时重试永不成功——那时弹窗会永久占屏并挡住输入区，而当时代码里
  // 既没有 Esc 也没有任何关闭入口（真机实测只能 reload）。
  // 这条路只清前端状态（reducer 的 `reject` 不 invoke、不宣称 agent 已收到应答）。
  const onAbandon = (requestId: string) => {
    getPermissionController()?.abandon(requestId)
  }

  let dialogRef: HTMLDivElement | undefined
  createDialogFocus(() => dialogRef, active, () => {
    const current = active()
    if (current) onAbandon(current.request.requestId)
  })

  return (
    <Show when={active()} keyed>
      {current => {
        const { request, status } = current
        const answering = status === 'answering'
        const buttons = resolvePermissionButtons(request)
        return (
          <div
            ref={node => { dialogRef = node }}
            class={OVERLAY}
            role="dialog"
            aria-modal="true"
            aria-label="工具权限请求"

          >
            <div class={DIALOG}>
              <div class={TITLE}>
                {request.title
                  || (request.interactionKind === 'elicitation' ? 'Agent 信息请求' : '工具权限请求')}
              </div>
              <Show when={request.toolCallId}>
                <div class={META}>toolCallId: {request.toolCallId}</div>
              </Show>
              <Show when={request.prompt}>
                <div class={PROMPT}>{request.prompt}</div>
              </Show>
              <Show when={request.interactionKind === 'elicitation' && request.elicitMessage}>
                <div class={PROMPT}>{request.elicitMessage}</div>
              </Show>
              {/* 失败原因必须可见：此前 `choose` 失败只把状态退回 pending，界面上「点了没反应」。 */}
              <Show when={current.lastError}>
                <div class={ERROR} role="alert">上次应答失败：{current.lastError}</div>
              </Show>
              <Show
                when={request.interactionKind === 'elicitation'}
                fallback={
                  <div class={OPTIONS}>
                    {buttons.map(button => (
                      <button
                        autofocus={buttons.indexOf(button) === 0 || undefined}
                        type="button"
                        class={BTN}
                        disabled={answering}
                        onClick={() => onChoose(request.requestId, button.optionId, answering)}
                      >
                        {button.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      class={DISMISS}
                      title="只关闭这个弹窗；agent 那一侧的真实状态由它自己的终态事件收敛"
                      onClick={() => onAbandon(request.requestId)}
                    >关闭</button>
                  </div>
                }
              >
                {/* #316：标准 elicitation form 卡——三值应答（accept 带表单值/decline/cancel）。 */}
                <ElicitationRequestCard
                  request={request}
                  answering={answering}
                  onSubmit={values => {
                    if (answering) return
                    void getPermissionController()?.choose(request.requestId, 'accept', values)
                  }}
                  onDecline={() => onChoose(request.requestId, 'declined', answering)}
                  onCancel={() => onChoose(request.requestId, 'cancel', answering)}
                />
              </Show>
            </div>
          </div>
        )
      }}
    </Show>
  )
}
