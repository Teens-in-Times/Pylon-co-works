/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, onCleanup, For, Show } from 'solid-js'
import { LucideIcon } from '../../components/LucideIcon.solid.tsx'
import { appClients } from '../../app/appClients.ts'
import { save } from '@tauri-apps/plugin-dialog'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { createStandardSwitchAgent, openOwnedSessionTransaction } from '../../application/transactions/openOwnedSessionTransaction'
import { useReplayPostureStore } from '../../domains/chat/replayPostureStore'
import { pagePersistedSessions, validateExportPath } from '../../domains/overview/persistedHistory.ts'
import { normalizePersistedSessions, type PersistedSessionSummary } from '../../domains/overview/persistedSessions.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/** Agent-owned archive browsing, filtering, read-only replay and local export. */
const SHEET = 'history-sheet flex flex-1 min-w-0 overflow-hidden bg-surface-raised text-text font-[family-name:var(--font)]'
// #154：左列几何归布局层的 .sidebar（见 SearchSheetView.solid 同处说明）；本类只管内容样式。
const SIDEBAR = 'sidebar history-sidebar flex flex-col py-[var(--ui-space-5)] px-3 bg-surface-panel'
const SIDEBAR_HEAD = 'grid gap-2 mx-2 mb-4 pb-4 border-b border-stroke-subtle'
const SIDEBAR_HEAD_STRONG = 'text-[15px]'
const SIDEBAR_TOTAL = 'history-sidebar-total flex items-center gap-2 mb-3 px-2 py-1 text-text-dim text-[12px]'
const SIDEBAR_TOTAL_SVG = 'text-accent'
const SIDEBAR_TOTAL_STRONG = 'text-text font-bold text-[14px] font-[family-name:var(--mono)]'
const NAV = 'grid gap-[3px]'
const NAV_BTN_INVARIANT = 'flex items-center gap-2 min-h-[var(--ui-control-compact)] px-3 text-left cursor-pointer font-[family-name:var(--font)] text-[12px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const NAV_BTN = `${NAV_BTN_INVARIANT} border border-transparent border-l-[3px] border-l-transparent bg-transparent text-text-dim enabled:hover:text-text enabled:hover:border-border enabled:hover:border-l-accent enabled:hover:bg-bg-hover`
const NAV_BTN_ACTIVE = `${NAV_BTN_INVARIANT} border border-border border-l-[3px] border-l-accent bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg-active))] text-text font-[650] enabled:hover:bg-bg-hover`
const NAV_BTN_DISABLED_EXTRA = 'opacity-40 cursor-not-allowed'
const SIDEBAR_FOOT = 'mt-auto pt-4 px-3 pb-0 border-t border-stroke-subtle text-text-dim text-[12px]'
const MAIN = 'flex-1 min-w-0 max-w-[1120px] mx-auto py-[var(--ui-space-6)] px-[clamp(var(--ui-space-5),4vw,var(--ui-space-7))] overflow-y-auto max-[720px]:py-[var(--ui-space-5)] max-[720px]:px-4'
const MAIN_TITLE = 'mt-1 mb-2 text-text text-[26px] font-semibold tracking-[-.025em]'
const TREE_ERROR = 'm-1 mb-4 p-2 border rounded-[var(--ui-radius-sm)] text-[12px] text-[var(--state-danger)] bg-[var(--state-danger-surface)] border-[color-mix(in_srgb,var(--state-danger)_34%,var(--stroke-default))]'
const HINT = 'text-[12px] text-text-dim'
const PAGER_HINT = 'min-w-[56px] px-2 text-text-dim font-mono text-[11px] leading-[var(--ui-control-compact)] text-center'
const RESULT_LIST = 'grid gap-0 border-t border-stroke-subtle m-0 p-0 list-none'
const RESULT_ITEM = 'border-b border-stroke-subtle last:border-b-0 bg-transparent transition-colors duration-[120ms] hover:bg-bg-hover'
const ROW = 'history-row flex flex-wrap items-center gap-3 min-h-[60px] px-4 py-3'
const ROW_PATH = 'flex-1 min-w-0 overflow-hidden text-text text-[13px] font-semibold truncate max-[720px]:basis-[calc(100%-var(--ui-space-3))] max-[720px]:whitespace-normal max-[720px]:[overflow-wrap:anywhere]'
const ROW_TEXT = 'shrink-0 max-w-[40%] text-text-dim font-mono text-[11px] whitespace-nowrap max-[720px]:mr-auto'
const ROW_BTN_NEUTRAL = 'min-w-[56px] h-[var(--ui-control-compact)] px-3 border border-stroke-subtle rounded-[3px] text-text-dim bg-transparent cursor-pointer font-[family-name:var(--font)] text-[12px] transition-[background-color,border-color,color] duration-[120ms] enabled:hover:border-border-focus enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const ROW_BTN_ACCENT = 'min-w-[56px] h-[var(--ui-control-compact)] px-3 rounded-[3px] cursor-pointer font-[family-name:var(--font)] text-[12px] transition-[background-color,border-color,color] duration-[120ms] border border-accent-edge text-accent bg-accent-soft enabled:hover:border-border-focus enabled:hover:text-text enabled:hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const PAGER_BTN = 'min-w-[56px] h-[var(--ui-control-compact)] px-3 border border-stroke-subtle rounded-[3px] text-text-dim bg-transparent cursor-pointer font-[family-name:var(--font)] text-[12px] transition-[background-color,border-color,color] duration-[120ms] enabled:hover:border-border-focus enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export interface HistorySheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

export default function HistorySheetView(props: HistorySheetViewProps) {
  const [raw, setRaw] = createSignal<unknown>(null)
  const [page, setPage] = createSignal(1)
  const [exportError, setExportError] = createSignal('')
  const [replayError, setReplayError] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
  const [query, setQuery] = createSignal('')
  const agentId = createZustandSignal(useIdentityStore, state =>
    state.agents.some(agent => agent.id === state.activeAgent) ? state.activeAgent : '',
  )

  createEffect(() => {
    const sheetId = props.sheet.id
    const owner = agentId()
    refresh()
    let disposed = false
    setRaw(null)
    setPage(1)
    setLoading(!!owner)
    setLoadFailed(false)
    if (!owner) return
    const client = appClients.session()
    client.listPersistedSessions().then(value => {
      if (!disposed) {
        setRaw(value)
        setLoading(false)
        resolveRuntimeErrors({ key: `history:${sheetId}:list` })
      }
    }).catch(error => {
      if (disposed) return
      setLoading(false)
      setLoadFailed(true)
      if (!disposed) reportRuntimeError('读取存档会话', error, undefined, {
        key: `history:${sheetId}:list`,
        scope: { kind: 'sheet', id: sheetId },
        source: 'history.sheet',
      })
    })
    onCleanup(() => { disposed = true })
  })

  const allEntries = createMemo(() => normalizePersistedSessions(raw()))
  const paged = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase()
    return pagePersistedSessions(allEntries().filter(entry => !needle || `${entry.title ?? ''} ${entry.source ?? ''} ${entry.id}`.toLocaleLowerCase().includes(needle)), page())
  })
  const sidebarPages = createMemo(() => {
    const current = paged()
    const start = Math.max(1, Math.min(current.page - 3, current.pages - 6))
    return Array.from({ length: Math.min(7, current.pages) }, (_, index) => start + index)
  })

  const exportSession = async (periId: string) => {
    setExportError('')
    setReplayError('')
    // OWNER-02：export owner agentId 从 Session owner 解析（identityStore 按 periId 定位），
    // 绝不取 activeAgent；未定位到 owner 时明确报错（不静默 fallback 串线）。
    const owner = useIdentityStore.getState().sessions.find(s => s.periId === periId)
    if (!owner) { setExportError('无法确定会话归属 Agent，请先在会话中打开再导出'); return }
    let outputPath: string | null
    try {
      outputPath = await save({ defaultPath: `session-${periId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    } catch (error) {
      reportRuntimeError('打开导出保存对话框', error, undefined, {
        key: `history:${props.sheet.id}:export-dialog`,
        scope: { kind: 'sheet', id: props.sheet.id },
        source: 'history.sheet',
      })
      return
    }
    if (!outputPath) return
    const validation = validateExportPath(outputPath)
    if (validation) { setExportError(validation); return }
    try {
      const client = appClients.session()
      await client.exportSession({ agentId: owner.agentId, periId, format: 'markdown', outputPath })
      resolveRuntimeErrors({ key: `history:${props.sheet.id}:export:${periId}` })
    } catch (error) {
      setExportError('')
      reportRuntimeError('导出会话', error, undefined, {
        key: `history:${props.sheet.id}:export:${periId}`,
        scope: { kind: 'sheet', id: props.sheet.id },
        source: 'history.sheet',
      })
    }
  }

  // W4-02（姿态二）：复用 Overview 的找/建 identity 行机制（resumePersistedSessionTransaction，
  // FE-AUD-010），进入只读姿态后开 agent sheet；load 由 agentWorkbenchLifecycle 承担（ChatView 已退役）
  const openReplay = async (entry: PersistedSessionSummary) => {
    setExportError('')
    setReplayError('')
    if (!entry.periId) return
    // I01-W4：owner-aware 打开——owner 无法确定（存档无归属）时 blocked，不静默归 active Agent
    const result = await openOwnedSessionTransaction(
      { source: entry.source, periId: entry.periId, title: entry.title, updatedAt: entry.updatedAt },
      {
        getSessions: () => useIdentityStore.getState().sessions,
        activeAgent: useIdentityStore.getState().activeAgent,
        addSession: (name, agentId) => useIdentityStore.getState().addSession(name, agentId),
        updateSession: (id, partial) => useIdentityStore.getState().updateSession(id, partial),
        switchAgent: createStandardSwitchAgent(id => useIdentityStore.getState().agents.find(a => a.id === id)?.name),
        selectSession: id => props.ctx.selectSession(id),
        openAgentSheet: ({ title, agentId }) => props.ctx.openSheet({ kind: 'agent', title, agentId }),
      },
    )
    if (!result.ok) {
      // Owner-switch transport failures are already recorded in the central
      // tray by createStandardSwitchAgent. Keep a quiet contextual status;
      // ownership/validation facts remain assertive and actionable here.
      if (result.kind === 'transport') setReplayError('回放失败，详情见右下角错误中心')
      else setExportError(result.message)
      return
    }
    useReplayPostureStore.getState().enter(result.value)
  }

  return (
    <div class={SHEET}>
      <aside class={SIDEBAR} aria-label="存档导航">
          <div class={SIDEBAR_HEAD}><strong class={SIDEBAR_HEAD_STRONG}>存档导航</strong></div>
          <div class={SIDEBAR_TOTAL}><LucideIcon name="Archive" size={16} class={SIDEBAR_TOTAL_SVG} /><span><strong class={SIDEBAR_TOTAL_STRONG}>{paged().total}</strong> 个存档</span></div>
          <Show when={paged().pages > 1}>
            <nav class={NAV} aria-label="存档分页">
              <button type="button" class={`${NAV_BTN} ${NAV_BTN_DISABLED_EXTRA}`} disabled={paged().page === 1} onClick={() => setPage(1)} aria-label="第一页"><LucideIcon name="ChevronFirst" size={15} /><span>第一页</span></button>
              <For each={sidebarPages()}>{pageNumber => <button type="button" class={pageNumber === paged().page ? NAV_BTN_ACTIVE : NAV_BTN} aria-current={pageNumber === paged().page ? 'page' : undefined} onClick={() => setPage(pageNumber)}><span>第 {pageNumber} 页</span></button>}</For>
              <button type="button" class={`${NAV_BTN} ${NAV_BTN_DISABLED_EXTRA}`} disabled={paged().page === paged().pages} onClick={() => setPage(paged().pages)} aria-label="最后一页"><LucideIcon name="ChevronLast" size={15} /><span>最后一页</span></button>
            </nav>
          </Show>
          <div class={SIDEBAR_FOOT}>第 {paged().page} / {paged().pages} 页</div>
        </aside>
      <main class={MAIN} aria-busy={loading()}>
        <h2 class={MAIN_TITLE}>存档会话（{paged().total}）</h2>
        <p class="m-0 mb-6 text-[13px] leading-relaxed text-text-dim">回看已保存的对话，或将记录导出到本地。</p>
        <div class="mb-5 flex items-center gap-3">
          <label class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[3px] border border-stroke-subtle bg-transparent px-3 focus-within:border-accent">
            <LucideIcon name="Search" size={15} class="shrink-0 text-text-dim" />
            <input type="search" aria-label="筛选存档" placeholder="按名称或来源筛选…" value={query()} onInput={event => { setQuery(event.currentTarget.value); setPage(1) }} class="w-full min-w-0 border-0 bg-transparent text-[13px] text-text outline-none" />
          </label>
          <button type="button" class={PAGER_BTN} disabled={loading() || !agentId()} onClick={() => setRefresh(value => value + 1)} aria-label="刷新存档"><LucideIcon name="RefreshCw" size={15} /></button>
        </div>
        <Show when={loading()}><p class={HINT} role="status">正在读取存档…</p></Show>
        <Show when={loadFailed()}><div class="mb-4 border border-border p-4" role="status"><p class={HINT}>读取存档失败，详情见右下角错误中心。</p><button type="button" class={`${PAGER_BTN} mt-3`} onClick={() => setRefresh(value => value + 1)}>重新加载存档</button></div></Show>
        <Show when={!loading() && !loadFailed() && paged().total === 0}><div class="border-t border-stroke-subtle px-0 py-6 text-text-dim" role="status"><h3 class="mb-2 text-sm font-semibold text-text">{query().trim() ? '没有匹配的存档' : '还没有存档会话'}</h3><p class={HINT}>{query().trim() ? '换一个名称或来源关键词，或清空筛选查看全部存档。' : '完成的会话会显示在这里，可随时回放或导出。'}</p><Show when={!agentId()}><button type="button" class={`${ROW_BTN_ACCENT} mt-4`} onClick={() => window.dispatchEvent(new CustomEvent('pylon:open-settings', { detail: { domain: 'agents-connections', section: 'agent' } }))}>连接 Agent</button></Show></div></Show>
        <Show when={exportError()}>
          <div class={TREE_ERROR} role="alert">{exportError()}{exportError().includes('归属不明') && <button type="button" onClick={() => props.ctx.openProfileEdit()}>打开 Agent 设置</button>}</div>
        </Show>
        <Show when={replayError()}><p class={`${HINT} history-error-reference`} role="status">{replayError()}</p></Show>
        <ul class={RESULT_LIST}>
          <For each={paged().entries}>{entry => (
            <li class={RESULT_ITEM}>
              <div class={ROW}>
                <span class={ROW_PATH}>{entry.title || entry.source || entry.id}</span>
                <span class={ROW_TEXT}>{new Date(entry.updatedAt).toLocaleString()}</span>
                <button type="button" class={ROW_BTN_ACCENT} disabled={!entry.periId} title={entry.periId ? '只读回放，点击继续转 live' : '该存档无 periId，无法回放'} onClick={() => void openReplay(entry)}>回放</button>
                <button type="button" class={ROW_BTN_NEUTRAL} onClick={() => void exportSession(entry.periId || entry.id)}>导出</button>
              </div>
            </li>
          )}</For>
        </ul>
        <Show when={paged().pages > 1}>
          <div class="mt-4 flex items-center gap-2">
            <button type="button" class={PAGER_BTN} disabled={paged().page <= 1} onClick={() => setPage(page() - 1)}>上一页</button>
            <span class={PAGER_HINT}>{paged().page}/{paged().pages}</span>
            <button type="button" class={PAGER_BTN} disabled={paged().page >= paged().pages} onClick={() => setPage(page() + 1)}>下一页</button>
          </div>
        </Show>
      </main>
    </div>
  )
}
