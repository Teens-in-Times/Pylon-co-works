/** @jsxImportSource solid-js */
/** Read-only browser inspector. The Browser Sheet owns native viewport and browser lifetime. */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { runtimeEventClient } from '../../infrastructure/tauri/runtimeEventClient.ts'
import { isBrowserMockRuntime } from '../../infrastructure/tauri/env.ts'
import { BROWSER_PHASE_LABELS, type BrowserPageSnapshot, type BrowserSnapshot } from '../../sheets/browser/browserSheetTypes.ts'
import { LucideIcon } from '../LucideIcon.solid.tsx'

export default function AgentBrowserResources(props: { onOpen: (url?: string) => void }) {
  const [snapshot, setSnapshot] = createSignal<BrowserSnapshot | null>(null)
  const [page, setPage] = createSignal<BrowserPageSnapshot | null>(null)
  const [address, setAddress] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  let disposed = false
  let generation = 0

  const applySnapshot = (next: BrowserSnapshot) => {
    if (disposed || !next || !Array.isArray(next.tabs)) return
    const previous = snapshot()
    if (previous?.instanceId !== next.instanceId || previous?.activeTabId !== next.activeTabId || previous?.url !== next.url || (previous?.phase === 'ready' && next.phase !== 'ready')) {
      generation += 1
      setPage(null)
    }
    setSnapshot(next)
    setError(next.error || '')
  }
  const refresh = async () => {
    if (loading()) return
    const request = ++generation
    setLoading(true)
    setError('')
    try {
      const next = await appClients.browser.status() as BrowserSnapshot
      if (!disposed && request === generation) applySnapshot(next)
    } catch (reason) {
      if (!disposed && request === generation) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (!disposed) setLoading(false) }
  }
  const inspectPage = async () => {
    if (loading() || snapshot()?.phase !== 'ready') return
    const request = ++generation
    const tabId = snapshot()?.activeTabId
    setLoading(true)
    setError('')
    try {
      const value = await appClients.browser.snapshot() as BrowserPageSnapshot
      if (!disposed && request === generation && snapshot()?.activeTabId === tabId) setPage(value)
    } catch (reason) {
      if (!disposed && request === generation) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (!disposed) setLoading(false) }
  }
  const selectTab = async (tabId: number) => {
    if (loading()) return
    setLoading(true)
    try {
      const next = await appClients.browser.selectTab(tabId) as BrowserSnapshot
      if (disposed) return
      applySnapshot(next)
      props.onOpen()
    } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (!disposed) setLoading(false) }
  }
  const openAddress = () => {
    const raw = address().trim()
    if (!raw) { props.onOpen(); return }
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('请输入 http 或 https 网址')
      setError('')
      props.onOpen(url.href)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '网址格式不正确') }
  }

  onMount(() => {
    void refresh()
    // Visibility, zoom and title broadcasts do not change the page being read.
    const onStatus = (next: BrowserSnapshot) => applySnapshot(next)
    const status = runtimeEventClient.subscribe<BrowserSnapshot>('pylon:browser-status', onStatus)
    const pageEvent = runtimeEventClient.subscribe<{ tabId: number; active: boolean; url?: string; title?: string }>('pylon:browser-page', value => {
      const current = snapshot()
      if (!current) return
      const active = value.active && value.tabId === current.activeTabId
      if (active) {
        generation += 1
        setPage(null)
      }
      applySnapshot({ ...current, ...(active ? { url: value.url, title: value.title } : {}), tabs: current.tabs.map(tab => tab.id === value.tabId ? { ...tab, url: value.url, title: value.title } : tab) })
    })
    const onMockStatus = (event: Event) => onStatus((event as CustomEvent<BrowserSnapshot>).detail)
    if (isBrowserMockRuntime()) window.addEventListener('pylon:browser-status', onMockStatus)
    onCleanup(() => {
      disposed = true
      generation += 1
      status.dispose()
      pageEvent.dispose()
      window.removeEventListener('pylon:browser-status', onMockStatus)
    })
  })

  return (
    <div class="agent-browser-resources">
      <div class="mb-3 flex items-center justify-between"><strong class="text-xs font-semibold">内置浏览器</strong><button type="button" class="workspace-resource-icon" aria-label="刷新浏览器状态" disabled={loading()} onClick={() => void refresh()}><LucideIcon name="RefreshCw" size={14} /></button></div>
      <form class="mb-4 flex min-w-0 items-center gap-1 border border-border bg-bg-input p-1 focus-within:border-accent" onSubmit={event => { event.preventDefault(); openAddress() }}>
        <LucideIcon name="Globe" size={14} class="ml-1 shrink-0 text-text-dim" />
        <input class="min-w-0 flex-1 border-0 bg-transparent p-1 text-xs text-text outline-none" aria-label="在内置浏览器打开网址" placeholder="输入网址…" value={address()} onInput={event => setAddress(event.currentTarget.value)} />
        <button type="submit" class="workspace-resource-icon" aria-label="打开网址"><LucideIcon name="ChevronRight" size={14} /></button>
      </form>
      <div class="mb-3 flex items-center justify-between text-[11px] text-text-dim"><span role="status">{loading() ? '正在读取…' : snapshot() ? BROWSER_PHASE_LABELS[snapshot()!.phase] : '状态未读取'}</span><span>{snapshot()?.tabs.length ?? 0} 个标签页</span></div>
      <Show when={error()}><p class="mb-3 break-words text-xs leading-relaxed text-danger" role="alert">{error()}</p></Show>
      <Show when={(snapshot()?.tabs.length ?? 0) > 0} fallback={
        <div class="agent-context-empty flex flex-col gap-3 px-1 py-5 text-text-dim"><LucideIcon name="Globe" size={25} strokeWidth={1.5} /><strong class="text-sm font-medium text-text">让网页留在工作区</strong><p class="text-xs leading-relaxed">打开文档、调试本地页面或查看网页资料，浏览器中可随时返回当前对话。</p></div>
      }>
        <For each={snapshot()?.tabs ?? []}>{tab => (
          <button type="button" class="workspace-resource-row workspace-resource-entry text-text" aria-current={snapshot()?.activeTabId === tab.id ? 'page' : undefined} disabled={loading()} onClick={() => void selectTab(tab.id)} title={tab.url ?? undefined}>
            <LucideIcon name="Globe" size={15} /><span class="min-w-0 flex-1"><strong class="block truncate text-xs font-medium">{tab.title || (tab.url && tab.url !== 'about:blank' ? tab.url : '新标签页')}</strong><span class="mt-1 block truncate text-[10px] text-text-dim">{tab.url || 'about:blank'}</span></span><LucideIcon name="ArrowUpRight" size={13} />
          </button>
        )}</For>
      </Show>
      <button type="button" class="workspace-resource-row mt-3 text-accent" onClick={() => props.onOpen()}><LucideIcon name="ArrowUpRight" size={14} />{snapshot()?.phase === 'ready' ? '打开浏览器工作台' : '启动内置浏览器'}</button>
      <Show when={snapshot()?.phase === 'ready'}>
        <button type="button" class="workspace-resource-row text-text-dim" disabled={loading()} onClick={() => void inspectPage()}><LucideIcon name="FileText" size={14} />预览当前网页文本</button>
      </Show>
      <Show when={page()}>{value => (
        <section class="mt-4 border-t border-border pt-3" aria-label="当前网页文本预览"><strong class="mb-2 block text-xs font-semibold">{value().title || '当前页面'}</strong><pre class="workspace-resource-preview">{value().text?.slice(0, 12_000) || '该页面没有可读取的文本。'}</pre><Show when={(value().text?.length ?? 0) > 12_000}><p class="mt-2 text-xs text-text-dim">显示前 12,000 个字符，完整页面可在浏览器中查看。</p></Show></section>
      )}</Show>
    </div>
  )
}
