/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup, For, Show } from 'solid-js'
import { LucideIcon } from '../../components/LucideIcon.solid.tsx'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { createStandardSwitchAgent, openOwnedSessionTransaction } from '../../application/transactions/openOwnedSessionTransaction'
import PylonMark from '../../components/PylonMark.solid.tsx'
import { sessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import { searchAllMessages, type SearchHitUi } from '../../domains/search/searchService'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/** Cross-session snapshot search. Query generations own results; navigation keeps message-location intent in session UI state. */
// #116 子项 2：本壳是 .layout（flex 容器）的直接子项，缺 flex-1 时按内容宽度
// 收缩（实测 528×988，而同排 File/Overview/Runtime/Gateway 都是 1920×988）。
const SHEET = 'search-sheet flex flex-1 min-w-0 overflow-hidden bg-surface-raised text-text font-[family-name:var(--font)]'
// #154：左列几何（宽度 / 竖直分割线 / 折叠可见性）归布局层的 .sidebar——本类只管内容样式。
const SIDEBAR = 'sidebar search-sidebar flex flex-col py-[var(--ui-space-5)] px-3 bg-surface-panel'
const SIDEBAR_HEAD = 'grid gap-2 mx-2 mb-4 pb-4 border-b border-stroke-subtle'
const HEAD_STRONG = 'text-[15px]'
const SCOPE = 'search-sidebar-scope grid grid-cols-[18px_minmax(0,1fr)_auto] items-center min-h-[var(--ui-control-standard)] px-3 mb-3 text-text bg-transparent text-[12px]'
const SCOPE_SVG = 'text-accent'
const SCOPE_SMALL = 'text-text-dim font-[family-name:var(--mono)] text-[10px]'
const SIDEBAR_ACTION = 'search-sidebar-action grid grid-cols-[18px_minmax(0,1fr)_auto] items-center min-h-[var(--ui-control-standard)] px-3 w-full text-text-dim border-0 border-l-[3px] border-l-transparent bg-transparent text-left cursor-pointer font-[family-name:var(--font)] text-[12px] enabled:hover:text-text enabled:hover:border-border enabled:hover:border-l-accent enabled:hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 disabled:cursor-not-allowed'
const SIDEBAR_SUMMARY = 'grid gap-1 mt-auto pt-4 px-3 border-t border-stroke-subtle text-text-dim'
const SUMMARY_STRONG = 'text-text font-semibold text-[16px]'
const SUMMARY_SPAN = 'text-[12px]'
const MAIN = 'flex-1 min-w-0 max-w-[1120px] mx-auto py-[var(--ui-space-6)] px-[clamp(var(--ui-space-5),4vw,var(--ui-space-7))] overflow-y-auto max-[720px]:py-[var(--ui-space-5)] max-[720px]:px-4'
const MAIN_TITLE = 'mt-1 mb-2 text-text text-[26px] font-semibold tracking-[-.025em]'
const DESCRIPTION = 'm-0 mb-6 text-text-dim text-[13px] leading-[1.5] [overflow-wrap:anywhere]'
const INPUT = 'search-sheet-input block w-[min(100%,640px)] h-[var(--ui-control-emphasis)] mb-4 px-4 border border-border rounded-none text-text bg-bg-input font-[family-name:var(--font)] text-[13px] outline-none transition-[border-color,box-shadow,background-color] duration-[120ms] hover:border-border-focus focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-text-placeholder'
const HINT = 'w-[min(100%,640px)] m-0 mb-4 px-4 py-3 border-0 rounded-none text-text-dim text-[12px] leading-[1.5]'
const EMPTY = 'search-empty-state sheet-empty-state w-[min(100%,960px)] mt-4 flex flex-col items-start gap-2 py-6 px-0 border-t border-stroke-subtle rounded-none text-text-dim bg-transparent text-left'
const EMPTY_STRONG = 'text-text text-[14px]'
const EMPTY_SPAN = 'max-w-[520px] text-[12px] leading-[1.5]'
const EMPTY_MARK = 'sheet-empty-mark grid w-[32px] h-[32px] place-items-center mb-1 text-accent bg-transparent font-bold text-[22px] font-[family-name:var(--mono)] [&>svg]:block'
const RESULTS = 'search-sheet-results grid gap-0 border-t border-stroke-subtle w-[min(100%,960px)] m-0 p-0 list-none'
const RESULTS_LI = 'border-b border-stroke-subtle last:border-b-0 bg-transparent transition-colors duration-[120ms] hover:bg-bg-hover'
const ROW = 'grid grid-cols-[minmax(120px,180px)_minmax(0,1fr)] max-[720px]:grid-cols-1 max-[720px]:gap-1 gap-4 items-center w-full min-h-[60px] px-4 py-3 border-0 border-l-[3px] border-l-transparent rounded-none text-text bg-transparent text-left cursor-pointer font-[family-name:var(--font)] transition-[background-color,border-color] duration-[120ms] hover:border-l-accent hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const ROW_PATH = 'min-w-0 text-text font-medium text-[13px] leading-[1.5] line-clamp-2'
const ROW_TEXT = 'min-w-0 text-text-dim text-[13px] leading-[1.6] line-clamp-2'

export interface SearchSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

export default function SearchSheetView(props: SearchSheetViewProps) {
  const [query, setQuery] = createSignal('')
  const [results, setResults] = createSignal<SearchHitUi[]>([])
  const [truncated, setTruncated] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [searchError, setSearchError] = createSignal<string | null>(null)
  const [retry, setRetry] = createSignal(0)
  const sessions = createZustandSignal(useIdentityStore, state => state.sessions)
  // I14-W4：request generation——旧响应不覆盖新 query
  let generation = 0
  let inputElement: HTMLInputElement | undefined

  createEffect(() => {
    const sheetId = props.sheet.id
    const needle = query().trim()
    retry()
    const currentGeneration = ++generation
    onCleanup(() => { generation++ })
    if (!needle) { setResults([]); setTruncated(false); setLoading(false); setSearchError(null); return }
    setResults([])
    setTruncated(false)
    setLoading(true)
    setSearchError(null)
    searchAllMessages(needle)
      .then(({ results: found, truncated: cut }) => {
        if (generation !== currentGeneration) return
        setResults(found)
        setTruncated(cut)
        setLoading(false)
        resolveRuntimeErrors({ key: `search:${sheetId}:${needle}` })
      })
      .catch(error => {
        if (generation !== currentGeneration) return
        setLoading(false)
        setSearchError(error instanceof Error ? error.message : String(error))
        reportRuntimeError('搜索会话消息', error, undefined, {
          key: `search:${sheetId}:${needle}`,
          scope: { kind: 'sheet', id: sheetId },
          source: 'search.sheet',
        })
      })
  })

  const openResult = async (result: SearchHitUi) => {
    const session = sessions().find(item => item.id === result.sessionId)
    if (!session) return
    // The workbench and resource panel both consume these per-session values,
    // including when the conversation is mounted after navigation.
    sessionUiStore.set(result.sessionId, 'search-open', true)
    sessionUiStore.set(result.sessionId, 'search-query', query().trim())
    sessionUiStore.set(result.sessionId, 'search-index', 0)
    // I01-W4：owner-aware 打开（Session owner 而非 active Agent）；切换失败保持原页面
    const opened = await openOwnedSessionTransaction(
      { targetId: session.id },
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
    if (!opened.ok) {
      // 切换失败保持原页面（不 selectSession 不开 sheet），仅可见提示
      reportRuntimeError('打开会话', opened.message, undefined, {
        key: `search-open:${props.sheet.id}:${session.id}`,
        scope: { kind: 'sheet', id: props.sheet.id },
        source: 'search.sheet',
      })
    }
  }

  return (
    <div class={SHEET}>
      <aside class={SIDEBAR} aria-label="搜索工具">
          <div class={SIDEBAR_HEAD}><strong class={HEAD_STRONG}>搜索范围</strong></div>
          <div class={SCOPE}><LucideIcon name="Database" size={15} class={SCOPE_SVG} /><span>本地会话快照</span><small class={SCOPE_SMALL}>{sessions().length}</small></div>
          <button type="button" class={SIDEBAR_ACTION} onClick={() => inputElement?.focus()}><LucideIcon name="Search" size={15} /><span>输入关键词</span></button>
          <button type="button" class={SIDEBAR_ACTION} disabled={!query()} onClick={() => { setQuery(''); inputElement?.focus() }}><LucideIcon name="X" size={15} /><span>清除查询</span></button>
          <div class={SIDEBAR_SUMMARY}><strong class={SUMMARY_STRONG}>{loading() ? '…' : results().length}</strong><span class={SUMMARY_SPAN}>当前结果</span><Show when={truncated()}><small class={SUMMARY_SPAN}>已达显示上限</small></Show></div>
        </aside>
      <main class={MAIN} aria-busy={loading()}>
        <h2 class={MAIN_TITLE}>跨会话搜索</h2>
        <p class={DESCRIPTION}>查找已保存在本机的消息，在会话中查看和切换匹配项。</p>
        <input
          ref={element => { inputElement = element }}
          class={INPUT}
          type="search"
          placeholder="搜索全部本地会话消息…"
          value={query()}
          onInput={event => setQuery(event.currentTarget.value)}
          aria-label="跨会话搜索"
        />
        <Show when={loading()}><p class={HINT} role="status">搜索中…</p></Show>
        <Show when={searchError()}><div class={HINT} role="status"><p class="search-error-reference">搜索失败，详情见右下角错误中心</p><button type="button" class="mt-2 cursor-pointer border border-border px-3 py-1 text-text hover:bg-bg-hover" onClick={() => setRetry(value => value + 1)}>重试搜索</button></div></Show>
        <Show when={truncated()}><p class={HINT} role="status">结果过多已截断（上限 {50} 条）</p></Show>
        <ul class={RESULTS}>
          <For each={results()}>{result => (
            <li class={RESULTS_LI}>
              <button type="button" class={ROW} onClick={() => void openResult(result)}>
                <span class={ROW_PATH}>{sessions().find(session => session.id === result.sessionId)?.name || result.sessionId}</span>
                <span class={ROW_TEXT}>{result.snippet}</span>
              </button>
            </li>
          )}</For>
        </ul>
        <Show when={query().trim() && results().length === 0 && !searchError() && !loading()}>
          <div class={EMPTY} role="status">
            <div class={EMPTY_MARK}><PylonMark size={30} title="Pylon 搜索" /></div>
            <strong class={EMPTY_STRONG}>没有匹配结果</strong>
            <span class={EMPTY_SPAN}>试试更短的关键词，或用会话中出现过的其他表述。</span>
          </div>
        </Show>
        <Show when={!query().trim()}>
          <div class={EMPTY} role="status">
            <div class={EMPTY_MARK}><PylonMark size={30} title="Pylon 搜索" /></div>
            <strong class={EMPTY_STRONG}>搜索本地会话消息</strong>
            <span class={EMPTY_SPAN}>输入关键词后，打开对应会话继续查看匹配内容。</span>
          </div>
        </Show>
      </main>
    </div>
  )
}
