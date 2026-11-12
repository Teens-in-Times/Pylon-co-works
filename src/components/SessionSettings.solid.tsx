/** @jsxImportSource solid-js */
import { createDialogFocus } from './ui/dialogFocus'
import { createEffect, createMemo, createSignal, on, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { appClients } from '../app/appClients.ts'
import { LucideIcon } from './LucideIcon.solid.tsx'
import { useIdentityStore, refreshSessionsBackend } from '../domains/identity/identityStore'
import { reportRuntimeError } from '../app/runtimeError'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../application/transactions/removeSessionTransaction'
import { runSessionNotificationHook } from '../application/transactions/sessionHookTransactions'

import { getCanonicalEventFeed } from '../infrastructure/events/canonicalEventFeed.ts'
import { clearMessageStorage } from '../domains/chat/messagePersistence'
import { createSessionSettingsValues, isSessionSettingsDirty } from './sessionSettingsForm'

export interface SessionSettingsProps { sessionId: string; open: boolean; onClose: () => void; onDeleted?: () => void }

/**
 * SessionSettings — 会话设置弹窗（#515 Solid 实体）。
 * 对话框契约（指南 §3，SessionsPanel 同款）：Portal 到 body、遮罩点击/Esc 走
 * onOpenChange(false) → beforeClose，role=dialog + aria-modal + aria-describedby。
 */
export default function SessionSettings(props: SessionSettingsProps) {
  const updateSession = useIdentityStore.getState().updateSession
  // 只订阅目标会话对象：其他会话的更新（消息/改名/活跃时间）不再重渲染本对话框。
  // ⚠️ 不能把 props.sessionId 读进 createZustandSignal 的 selector——selector 只在 store
  // 通知时重跑（solidStoreBridge 头注），会话切换（props 变化）不会触发重算；改为
  // 组件侧 memo 同时追踪会话表信号与 props.sessionId。
  const sessions = createZustandSignal(useIdentityStore, state => state.sessions)
  const session = createMemo(() => props.sessionId ? sessions().find(item => item.id === props.sessionId) : undefined)
  // createSessionSettingsValues 只读 name/platform/workdir/sessionPrompt；追踪粒度与
  // React deps 对齐——session 整体引用变化（任何会话更新）不重建表单值，只有四个字段
  // 变化才重置（原 useEffect [sessionId, session?.name, …] 语义）。
  const initialValues = createMemo(() => createSessionSettingsValues(session()), undefined, {
    equals: (a, b) => a === b
      || (a.name === b.name && a.platform === b.platform && a.workdir === b.workdir && a.sessionPrompt === b.sessionPrompt),
  })
  const [name, setName] = createSignal(initialValues().name)
  const [platform, setPlatform] = createSignal(initialValues().platform)
  const [workdir, setWorkdir] = createSignal(initialValues().workdir)
  const [sessionPrompt, setSessionPrompt] = createSignal(initialValues().sessionPrompt)
  // CWD-03：Workspace 实体绑定（方案 C）

  createEffect(on(() => [props.sessionId, session()?.name, session()?.platform, session()?.workdir, session()?.sessionPrompt], () => {
    setName(session()?.name || '')
    setPlatform(session()?.platform || 'local')
    setWorkdir(session()?.workdir || '')
    setSessionPrompt(session()?.sessionPrompt || '')
  }))

  const currentValues = () => ({ name: name(), platform: platform(), workdir: workdir(), sessionPrompt: sessionPrompt() })
  const dirty = createMemo(() => isSessionSettingsDirty(currentValues(), initialValues()))

  const closeWithoutSaving = () => {
    setName(initialValues().name)
    setPlatform(initialValues().platform)
    setWorkdir(initialValues().workdir)
    setSessionPrompt(initialValues().sessionPrompt)
    props.onClose()
  }

  const beforeClose = () => {
    if (dirty() && !window.confirm('放弃未保存的会话设置？')) return
    closeWithoutSaving()
  }

  const save = () => {
    updateSession(props.sessionId, {
      name: name(),
      platform: platform(),
      sessionPrompt: sessionPrompt(),
      lastActiveAt: Date.now(),
    })
    props.onClose()
  }

  const del = async () => {
    const current = session()
    if (!current) return
    if (!window.confirm(`删除会话“${current.name}”？此操作无法撤销。`)) return
    const sessionClient = appClients.session()
    const result = await removeSessionTransaction(props.sessionId, {
      findSession: id => useIdentityStore.getState().sessions.find(s => s.id === id),
      // DEL-03（§5.13 本地优先）：OwnerKey = [profileId, agentId, localSessionId]（与 eventSchema 同纪律）
      deleteSessionLocal: s => sessionClient.deleteUserSessionLocal({ sessionId: s.id, ownerKey: sessionDurableOwnerKey(s) }),
      refreshSessionsBackend,
      // tombstone 成功后立即封住在途 canonical 写；revision 刷新可能仍在等待。
      markSessionDeleting: id => {
        const target = useIdentityStore.getState().sessions.find(item => item.id === id)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
        }
      },
      // DEL-04（§5.13）删除终态：丢弃 canonical 未落盘事件（不复活；messages 表已停写）
      markSessionDeleted: id => {
        const target = useIdentityStore.getState().sessions.find(item => item.id === id)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
        }
      },
      // OWNER-02：close 目标 owner 由 session 携带（agentId + source）；best effort，失败仅报告
      closeSession: s => sessionClient.closeSession({ agentId: s.agentId, source: s.source }),
      // #398：agent 侧 session/delete（close 之后）；periId 缺失（从未连接 agent）跳过。
      deleteSessionRemote: s => s.periId
        ? sessionClient.deleteSessionAgentSide({ agentId: s.agentId, source: s.source, periId: s.periId })
        : Promise.resolve(),
      // DEL-03 终态化：deleting → deleted（best effort）
      finalizeSessionDelete: s => sessionClient.finalizeUserSessionDelete({ sessionId: s.id, ownerKey: sessionDurableOwnerKey(s) }),
      removeSession: id => useIdentityStore.getState().removeSession(id),
      clearMessages: id => clearMessageStorage(id, localStorage),
      reportError: (action, error) => reportRuntimeError(action, error),
      // API 1.3 生命周期通知:closing→deleting→deleted→closed(观察语义)。
      notifySessionHook: runSessionNotificationHook,
    })
    if (!result.ok) return
    props.onClose()
    props.onDeleted?.()
  }

  let contentRef: HTMLDivElement | null = null
  createDialogFocus(() => contentRef, () => props.open && session(), beforeClose)

  return (
    <Show when={props.open && session()}>
      <Portal>
        <div class="dialog-overlay" onClick={() => beforeClose()} />
        <div
          ref={el => { contentRef = el }}
          class="dialog-content settings-surface settings-dialog agent-settings-dialog session-settings w-[min(760px,calc(100vw-32px))] max-w-[760px] max-h-[min(88vh,860px)] flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label="会话设置"
          aria-describedby="session-settings-description"
          tabindex="-1"
        >
          <header class="settings-dialog-header shrink-0">
            <div>
              <h3 class="settings-dialog-title">会话设置</h3>
              <p id="session-settings-description" class="settings-dialog-description">管理当前会话的名称与基础操作。</p>
            </div>
            <button type="button" class="modal-close settings-dialog-close" onClick={event => {
              event.preventDefault()
              beforeClose()
            }} aria-label="关闭会话设置"><LucideIcon name="X" size={16} /></button>
          </header>

          <div class="min-h-0 overflow-y-auto pt-[22px] px-6 pb-7 flex flex-col gap-4 max-[640px]:px-[18px]">
            <section class="session-settings-section shrink-0 p-[18px] border border-[var(--settings-border)] rounded-[var(--settings-radius-md)] bg-[var(--settings-raised)]" aria-labelledby="session-basic-title">
              <div class="flex items-start justify-between gap-4 mb-3.5">
                <div>
                  <h4 id="session-basic-title" class="settings-section-title">基本信息</h4>
                  <p class="session-settings-section-description settings-section-description">用于侧栏识别。</p>
                </div>
              </div>
              <div class="grid grid-cols-1 gap-3.5">
                <div class="sess-field min-w-0">
                  <label for="session-name">名称</label>
                  <input id="session-name" class="settings-control" value={name()} onInput={event => setName(event.currentTarget.value)} />
                </div>
              </div>
            </section>

            <section class="session-settings-danger shrink-0 flex items-center justify-between gap-4 p-4 border border-danger-edge rounded-[var(--settings-radius-md)] bg-danger-soft max-[640px]:items-stretch max-[640px]:flex-col" aria-labelledby="session-danger-title">
              <div>
                <h4 id="session-danger-title" class="m-0 text-danger text-[13px] font-[680]">危险区域</h4>
                <p class="mt-[5px] mb-0 text-text-dim text-sm leading-[1.5]">删除后会关闭后端会话并清理本地消息缓存，无法撤销。</p>
              </div>
              <button type="button" class="ps-btn danger shrink-0" onClick={() => void del()}>删除会话</button>
            </section>
          </div>

          <footer class="settings-dialog-footer static shrink-0">
            <span class={`session-settings-dirty settings-dirty-state ${dirty() ? 'active' : ''}`} role="status">
              {dirty() ? '有未保存修改' : '所有修改已保存'}
            </span>
            <div class="flex gap-2 max-[640px]:justify-end">
              <button type="button" class="ps-btn settings-action" onClick={beforeClose}>取消</button>
              <button type="button" class="ps-btn primary settings-action primary" onClick={save} disabled={!dirty()}>保存修改</button>
            </div>
          </footer>
        </div>
      </Portal>
    </Show>
  )
}
