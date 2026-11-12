/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useModalOverlayStore } from '../app/modalOverlayStore'
import { resolveUnresolvedSessionTransaction } from '../app/bootstrap/resolveUnresolvedSessionTransaction'
import type { LegacySession } from '../domains/identity/sessionPersistence'
import Select from './ui/Select.solid.tsx'
import { createDialogFocus } from './ui/dialogFocus'

/**
 * ISSUE-01：未决 Session 恢复入口。
 *
 * 取消只隐藏当前提示，不写回、不丢弃原始 envelope；store 发生变化后重新出现。
 *
 * 样式绞杀（P93）：原 SessionOwnerRecoveryDialog.css 的 utility 化；
 * `.session-owner-select .pylon-select` 的宽度规则以子级 arbitrary variant
 * 保留（不改动共享 Select 组件）。
 * #306：面板原消费 --settings-surface/--settings-shadow——这两个 token 只在
 * `.settings-surface` 作用域内定义，本弹窗挂 App 顶层（App.tsx）取不到，悬空引用使
 * 面板全透明、聊天正文穿透。改消费全局声明的 --surface-overlay 与 --shadow-float；
 * 遮罩同 PermissionDialog：固定 30% 黑（原「--bg-panel 取 60%」在基础方案只有
 * 约 1.9% 黑），不加模糊。
 */
const OVERLAY = 'fixed inset-0 z-[210] flex items-center justify-center bg-[rgba(0,0,0,0.3)]'
const DIALOG = 'w-[min(560px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-auto p-4 border border-border bg-[var(--surface-overlay)] shadow-[var(--shadow-float)] text-text font-[family-name:var(--font)]'
const H2 = 'm-0 mb-2 text-[16px]'
const P = 'm-0 mb-3 text-text-dim text-[13px] leading-[1.5]'
const UL = 'grid gap-2 m-0 mb-3 p-0 list-none'
const LI = 'grid grid-cols-[minmax(0,1fr)_160px_auto] items-center gap-2 max-[640px]:grid-cols-1'
const SELECT_WRAP = 'min-h-[32px] border border-border rounded-none bg-bg-input text-text [&_.pylon-select]:w-full'
const BTN = 'min-h-[32px] px-3 py-1.5 border border-border rounded-none bg-bg-input text-text [font:inherit] cursor-pointer disabled:cursor-not-allowed disabled:opacity-[var(--state-disabled-opacity)]'

/** SessionOwnerRecoveryDialog — 遗留会话归属恢复弹窗（#515 Solid 实体）。DOM/aria 契约：
 * div[role=dialog][aria-modal][aria-label="恢复遗留会话归属"]，逐会话一行（select +
 * 「解析」钮），错误行 role=alert，「稍后处理」收起弹窗。 */
export default function SessionOwnerRecoveryDialog() {
  const hydration = createZustandSignal(useIdentityStore, s => s.sessionHydration)
  const agents = createZustandSignal(useIdentityStore, s => s.agents)
  const hydrationUnresolved = createMemo(() => {
    const state = hydration()
    return state?.kind === 'needs-owner-resolution' ? state.unresolved : null
  })
  const [dismissed, setDismissed] = createSignal(false)
  const [selected, setSelected] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const unresolved = createMemo<readonly LegacySession[]>(() => hydrationUnresolved() ?? [])
  const unresolvedKey = createMemo(() => unresolved().map(session => session.id).join('\u0000'))

  createEffect(() => {
    void unresolvedKey()
    setDismissed(false)
  })

  createEffect(() => {
    const current = unresolved()
    if (current.length === 0) {
      setDismissed(false)
      return
    }
    setSelected(currentSelection => {
      const next = { ...currentSelection }
      for (const session of current) if (!next[session.id] && agents()[0]) next[session.id] = agents()[0].id
      return next
    })
  })

  // #309：本弹窗是覆盖主区的模态层——打开期间让原生子视图暂时隐藏（effect 须无条件
  // 挂在组件体，不能随 early return 消失；Solid 效果在 Show 之外常驻）。
  createEffect(() => {
    const open = unresolved().length > 0 && !dismissed()
    useModalOverlayStore.getState().setOverlayOpen('session-owner-recovery', open)
    onCleanup(() => useModalOverlayStore.getState().setOverlayOpen('session-owner-recovery', false))
  })

  const resolve = async (sessionId: string) => {
    const agentId = selected()[sessionId]
    if (!agentId) return
    setBusy(sessionId)
    setError(null)
    const result = await resolveUnresolvedSessionTransaction(sessionId, agentId, {
      getUnresolved: () => {
        const current = useIdentityStore.getState().sessionHydration
        return current?.kind === 'needs-owner-resolution' ? current.unresolved : []
      },
      getAgents: () => useIdentityStore.getState().agents,
      commit: async (session, owner) => {
        const ok = await useIdentityStore.getState().resolveSessionOwner(session.id, owner)
        if (!ok) throw new Error('保存会话归属失败')
      },
    })
    setBusy(null)
    if (!result.ok) setError(result.message)
  }

  let dialogRef: HTMLDivElement | undefined
  createDialogFocus(() => dialogRef, () => unresolved().length > 0 && !dismissed(), () => setDismissed(true))

  return (
    <Show when={unresolved().length > 0 && !dismissed()}>
      <div ref={node => { dialogRef = node }} class={OVERLAY} role="dialog" aria-modal="true" aria-label="恢复遗留会话归属">
        <div class={DIALOG}>
          <h2 class={H2}>恢复遗留会话归属</h2>
          <p class={P}>以下会话无法从持久化数据唯一判断所属 Agent。请选择后确认；稍后处理不会修改原始数据。</p>
          <ul class={UL}>
            <For each={unresolved()}>{session => (
              <li class={LI}>
                <span>{session.name}</span>
                <div class={SELECT_WRAP}>
                  <Select
                    ariaLabel={`${session.name}的 Agent`}
                    value={selected()[session.id] ?? ''}
                    disabled={busy() === session.id}
                    onChange={agentId => setSelected(current => ({ ...current, [session.id]: agentId }))}
                    options={agents().map(agent => ({ value: agent.id, label: agent.name }))}
                  />
                </div>
                <button type="button" class={BTN} disabled={busy() === session.id || !selected()[session.id]} onClick={() => void resolve(session.id)}>
                  {busy() === session.id ? '保存中…' : '确认恢复'}
                </button>
              </li>
            )}</For>
          </ul>
          <Show when={error()}><p role="alert" class={P}>{error()}</p></Show>
          <button type="button" class={BTN} onClick={() => setDismissed(true)}>稍后处理</button>
        </div>
      </div>
    </Show>
  )
}
