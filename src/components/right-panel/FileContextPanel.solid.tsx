/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { useIdentityStore, type Session } from '../../domains/identity/identityStore'
import { normalizeFilePath, sourcesForPath } from '../../domains/file/fileRelations'
import { toAgentContextKey } from '../../domains/agent/agentContext.ts'
import { openOwnedSessionTransaction } from '../../application/transactions/openOwnedSessionTransaction.ts'
import { activateAgentSheet, isAgentSheetRuntimeReady } from '../../workspace-sheets/activateAgentSheet.ts'
import { reportRuntimeError } from '../../app/runtimeError.ts'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'

/**
 * FileContextPanel — file 右栏（W2-12，FE-AUD-022 反查）。
 *
 * 读取当前 FileSheet 的 activeFile（metadata），反查所有改动过它的会话
 * （path → sources，Windows 路径统一 normalize）；点击关联会话 → 返回
 * Agent Sheet：先完成 owner 切换，再选会话；失败留在文件页。不猜全局 activeSession。
 *
 * #515 贡献面翻转：Solid 实体。
 * props 形状 = ContextPanelContributionProps（contextPanelTypes 契约）。
 */
export default function FileContextPanel(props: { ctx: SheetContext }) {
  // 当前 FileSheet 的 activeFile（不猜全局 activeSession——报告 5D.2）
  const activeFile = createZustandSignal(useWorkspaceStore, state => {
    const fileSheets = state.workspaceSheets.sheets.filter(sheet => sheet.kind === 'file')
    const active = fileSheets.find(sheet => sheet.id === state.workspaceSheets.activeSheetId) ?? fileSheets[0]
    return active?.metadata?.activeFile ?? null
  })
  // 选整个 record（引用稳定），派生留组件体（Solid 组件体只跑一次，createMemo 承担派生）。
  const touchedFilesRecord = createZustandSignal(useWorkspaceStore, s => s.touchedFiles)
  const relatedSources = createMemo(() => activeFile() ? sourcesForPath(touchedFilesRecord(), activeFile()!) : [])
  const sessions = createZustandSignal(useIdentityStore, s => s.sessions)
  const relatedEntries = createMemo(() => relatedSources().flatMap<{ source: string; session: Session | undefined }>(source => {
    const matches = sessions().filter(session => session.source === source
      && (touchedFilesRecord()[toAgentContextKey(session)] ?? []).some(file => normalizeFilePath(file.path) === normalizeFilePath(activeFile()!)))
    return matches.length > 0
      ? matches.map(session => ({ source, session }))
      : [{ source, session: undefined }]
  }))
  const [opening, setOpening] = createSignal(false)
  const [openError, setOpenError] = createSignal('')
  const openRelatedSession = async (sessionId: string) => {
    if (opening()) return
    setOpening(true)
    setOpenError('')
    try {
      const target = useIdentityStore.getState().sessions.find(session => session.id === sessionId)
      const opened = await openOwnedSessionTransaction({ targetId: sessionId }, {
        getSessions: () => useIdentityStore.getState().sessions,
        activeAgent: target && isAgentSheetRuntimeReady(target.agentId) ? target.agentId : null,
        addSession: (name, agentId) => useIdentityStore.getState().addSession(name, agentId),
        updateSession: (id, partial) => useIdentityStore.getState().updateSession(id, partial),
        switchAgent: async owner => await activateAgentSheet(owner, useIdentityStore.getState().agents.find(agent => agent.id === owner)?.name ?? owner, () => {})
          ? { ok: true, value: owner } : { ok: false, kind: 'transport', message: 'Agent 尚未就绪，请重试。' },
        selectSession: id => {
          const identity = useIdentityStore.getState()
          const selected = identity.sessions.find(session => session.id === id)
          if (selected && selected.profileId !== identity.activeProfileId) identity.setActiveProfile(selected.profileId)
          props.ctx.selectSession(id)
        },
        openAgentSheet: ({ title, agentId }) => props.ctx.openSheet({ kind: 'agent', title, agentId }),
      })
      if (!opened.ok) {
        setOpenError(opened.message)
        reportRuntimeError('打开文件关联会话', opened.message, undefined, { key: `file-related-session:${sessionId}`, source: 'file.context' })
      }
    } finally { setOpening(false) }
  }

  return (
    <div class="context-panel-contribution">
      <div class="file-section-title">关联会话（{activeFile() ?? '无文件'}）</div>
      <Show when={openError()}><p class="file-section-hint" role="alert">{openError()}</p></Show>
      <Show when={activeFile()} fallback={<p class="file-section-hint">打开一个文件后显示改动过它的会话</p>}>
        <Show when={relatedSources().length > 0} fallback={<p class="file-section-hint">暂无会话改动此文件</p>}>
          <ul class="search-result-list">
            <For each={relatedEntries()}>{entry => {
              return (
                <li>
                  <button
                    type="button"
                    class="search-result-row"
                    disabled={opening() || !entry.session}
                    title={entry.session ? undefined : '此会话不在当前本地记录中，无法确认归属'}
                    onClick={() => { if (entry.session) void openRelatedSession(entry.session.id) }}
                  >
                    <span class="search-result-path">{entry.source}</span>
                    <span class="search-result-text">{entry.session?.name ?? '外部会话'}</span>
                  </button>
                </li>
              )
            }}</For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
