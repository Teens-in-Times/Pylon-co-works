/** @jsxImportSource solid-js */
import { createSignal, Show, untrack } from 'solid-js'
import { browserReducer, createBrowserState, type BrowserAction } from '../../domains/browser/browserState.ts'
import {
  appendConsole,
  clearBrowserCollection,
  isBrowserLibraryUrl,
  loadBrowserLibrary,
  recordDownload,
  recordHistory,
  saveBrowserLibrary,
  toggleBookmark,
  type BrowserLibrary,
  type ConsoleEntry,
} from '../../domains/browser/browserLibrary.ts'
import { appClients } from '../../app/appClients.ts'
import { classifyBrowserStartError } from '../../infrastructure/tauri/browserContracts.ts'
import { hasTauriRuntime, isBrowserMockRuntime, IS_TAURI, type TauriWindow } from '../../infrastructure/tauri/env.ts'
import { useModalOverlayStore } from '../../app/modalOverlayStore'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { reportRuntimeError } from '../../app/runtimeError'
import { LucideIcon } from '../../components/LucideIcon.solid.tsx'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import { BROWSER_PHASE_LABELS, type BrowserPageSnapshot, type BrowserSnapshot, type BrowserToolId } from './browserSheetTypes.ts'
import { BrowserViewport } from './BrowserViewport.solid.tsx'
import { BrowserSidebar } from './BrowserSidebar.solid.tsx'
import { BrowserTabStrip } from './BrowserTabStrip.solid.tsx'
import { BrowserToolPanel } from './BrowserToolPanel.solid.tsx'
import { useBrowserAgentPanel } from './useBrowserAgentPanel.solid.ts'
import { wireBrowserSheetEffects } from './browserSheetEffects.solid.ts'

/**
 * BrowserSheetView — browser 壳（W4-03）。
 *
 * 纯状态机 idle/starting/ready/error + WebView bounds/导航控制；子 WebView 由后端创建并嵌入 viewport。
 * Sheet 卸载时调用 browser_close，确保 WebView2 子进程随 sheet 生命周期回收。
 *
 * #228 批次 D：工具面板 / 左列 / 标签条 / 预览容器拆分至 BrowserToolPanel /
 * BrowserSidebar / BrowserTabStrip / BrowserViewport（纯搬移，行为与默认导出不变）；
 * 地址栏工具条与缩放行留在本文件（BrowserSheet.css.test 门禁锁定其载体，#515 起载体
 * 为本 .solid.tsx 实体）。
 *
 * #515：Solid 实体，与 React 版逐行同构。IPC 调用与生命周期（挂载/清理对称）逐条保真：
 * useReducer → 信号 + 纯 reducer；effect deps 语义逐条对照（见各 createEffect 注释）；
 * 原生可见性判定消费 modalOverlayStore（createZustandSignal，不改 store）。
 * BrowserViewport / BrowserSidebar / BrowserTabStrip / BrowserToolPanel 四个子组件均为
 * Solid 实体（props 信号直读、响应式更新）——批7 起 React 岛与 DeferredIslandHost 已退役。
 *
 * #520 S3-P0-3：issue#82 Agent 面板拆至 useBrowserAgentPanel.solid.ts，effect 编排拆至
 * browserSheetEffects.solid.ts；本宿主保留状态机信号、数据投影与布局。Tauri 事件订阅
 * 改经 runtimeEventClient（S1-P1 传输层收口）；图标经共享 LucideIcon（S3-P2-1 表归一）。
 */

const DEFAULT_ZOOM_PERCENT = 90
const MIN_ZOOM_PERCENT = 50
const MAX_ZOOM_PERCENT = 200
const ZOOM_STEP = 10

export default function BrowserSheetView(props: { sheet: SheetRecord; ctx: SheetContext }) {
  // 纯 reducer 状态机：原 useReducer → 信号 + 同一纯函数。
  const [state, setState] = createSignal(createBrowserState())
  const dispatch = (action: BrowserAction) => setState(previous => browserReducer(previous, action))
  // 部分旧的组件测试只 mock env.ts 的两个旧导出；保留函数存在性守卫，
  // 不让预览探测成为它们的隐式新依赖。
  const browserPreview = !IS_TAURI && typeof isBrowserMockRuntime === 'function' && isBrowserMockRuntime()
  // 浏览器 Dev Mock 在静态 import 之后安装 Tauri globals，故运行时再探测一次；
  // 原生环境仍走模块级 IS_TAURI 快路径。
  const browserRuntimeAvailable = IS_TAURI || browserPreview || (typeof window !== 'undefined' && hasTauriRuntime(window as Window & TauriWindow))
  const [snapshot, setSnapshot] = createSignal<BrowserSnapshot>({ instanceId: 0, phase: 'idle', zoomPercent: DEFAULT_ZOOM_PERCENT, activeTabId: null, tabs: [], runtime: browserPreview ? 'iframe-preview' : 'tauri-webview' })
  const [zoomSettingsOpen, setZoomSettingsOpen] = createSignal(false)
  // I09-A-FE-02（D-01/D-08）：折叠状态唯一来源 ctx.sidebarCollapsed（titlebar 统一控制），
  // 不再维护独立折叠布尔——browser-sidebar-collapsed 类直连全局状态
  const sidebarCollapsed = () => props.ctx.sidebarCollapsed
  // 原生子 WebView 是独立于 DOM 的窗口，父节点 display:none 不会将其隐藏。
  // SheetLayout 对 keep-alive Browser 显式传 isActive=false；旧上下文省略时按 active 处理。
  const isSheetActive = () => props.ctx.isActive !== false
  // #309：模态覆盖层（启动器/权限请求等）打开期间原生子视图必须让位——原生层盖不住
  // DOM 覆盖层，否则覆盖层上的按钮被原生页面吃掉点击。页面在隐藏期间继续运行。
  const modalOverlayOpen = createZustandSignal(useModalOverlayStore, state => state.openKeys.size > 0)
  const [activeTool, setActiveTool] = createSignal<BrowserToolId | null>(null)
  const [address, setAddress] = createSignal('')
  const [library, setLibrary] = createSignal<BrowserLibrary>(loadBrowserLibrary())
  const [pageSnapshot, setPageSnapshot] = createSignal<BrowserPageSnapshot | null>(null)
  // `browser_snapshot` is an expensive cross-process call.  Tool-panel effects
  // can run more than once (rapid panel changes, or a status replay), so keep
  // one in-flight request and let concurrent callers share it.
  let inspectPageInFlight: Promise<void> | null = null
  const [downloadUrlInput, setDownloadUrlInput] = createSignal('')
  const [consoleFilter, setConsoleFilter] = createSignal<'all' | ConsoleEntry['level']>('all')
  // 跨域 iframe 的页面自身导航无法被父文档读取；命令导航/刷新时递增 key，
  // 让预览重新回到 Browser 状态机记录的 URL，避免地址栏与画面脱节。
  const [previewRevision, setPreviewRevision] = createSignal(0)
  const viewportRef: { current: HTMLDivElement | null } = { current: null }

  // ── Agent 面板（issue #82）：状态与动作在 useBrowserAgentPanel（#520 拆出）。 ──
  const agentPanel = useBrowserAgentPanel({
    activeTool,
    browserRuntimeAvailable,
    browserPreview,
    snapshot,
    pageSnapshot,
    activeSession: () => props.ctx.activeSession,
  })

  const updateLibrary = (updater: (current: BrowserLibrary) => BrowserLibrary) => {
    setLibrary(current => {
      const next = updater(current)
      saveBrowserLibrary(next)
      return next
    })
  }

  const logConsole = (command: string, level: ConsoleEntry['level'] = 'info', detail?: string) => {
    updateLibrary(current => appendConsole(current, { command, level, detail }))
  }

  const recordCurrentPage = (url: string | null | undefined, title?: string | null) => {
    if (!url || url === 'about:blank' || !isBrowserLibraryUrl(url)) return
    const previous = untrack(library).history[0]
    // Page-load callbacks can arrive twice (URL then title).  Avoid moving an entry
    // on every duplicate callback while still refreshing a changed title.
    if (previous?.url === url && previous.title === (title?.trim() || previous.title)) return
    updateLibrary(current => recordHistory(current, { url, title: title ?? undefined }))
  }

  const applySnapshot = (next: BrowserSnapshot) => {
    const normalized: BrowserSnapshot = {
      ...next,
      runtime: next.runtime ?? (browserPreview ? 'iframe-preview' : 'tauri-webview'),
      zoomPercent: next.zoomPercent ?? DEFAULT_ZOOM_PERCENT,
      activeTabId: next.activeTabId ?? (next.instanceId || null),
      tabs: next.tabs ?? (next.instanceId ? [{ id: next.instanceId, url: next.url, title: next.title }] : []),
      visible: next.visible ?? isSheetActive(),
    }
    setSnapshot(normalized)
    if (normalized.phase === 'ready') dispatch({ type: 'started', instanceId: String(normalized.instanceId) })
    else if (normalized.phase === 'idle') dispatch({ type: 'stop' })
    else if (normalized.phase === 'error') dispatch({ type: 'failed', error: normalized.error || '浏览器启动失败' })
    else if (normalized.error) dispatch({ type: 'failed', error: normalized.error })
    setAddress(normalized.url && normalized.url !== 'about:blank' ? normalized.url : '')
    if (normalized.url && normalized.url !== 'about:blank') {
      recordCurrentPage(normalized.url, normalized.title)
    }
  }

  const syncBounds = () => {
    const element = viewportRef.current
    if (!element || !browserRuntimeAvailable || snapshot().phase !== 'ready' || props.ctx.isActive === false) return
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    void appClients.browser.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }).catch(error => reportRuntimeError('调整浏览器区域', error))
  }

  const start = async () => {
    dispatch({ type: 'start' })
    try {
      const element = viewportRef.current
      const rect = element?.getBoundingClientRect()
      const next = await appClients.browser.start({
        x: Math.round(rect?.left ?? 0),
        y: Math.round(rect?.top ?? 0),
        width: Math.max(1, Math.round(rect?.width ?? 1)),
        height: Math.max(1, Math.round(rect?.height ?? 1)),
      }) as BrowserSnapshot
      if (browserPreview) setPreviewRevision(revision => revision + 1)
      applySnapshot(next)
    } catch (error) {
      const classified = classifyBrowserStartError(error)
      dispatch({ type: 'failed', error: classified.kind === 'blocked' ? '浏览器 WebView 命令不可用' : classified.message })
      setSnapshot(previous => ({ ...previous, phase: 'error', error: classified.kind === 'blocked' ? '浏览器 WebView 命令不可用' : classified.message }))
      if (classified.kind === 'error') reportRuntimeError('启动浏览器 WebView', error)
    }
  }

  const navigateTo = async (rawUrl: string) => {
    const value = rawUrl.trim()
    if (!value) return
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`
    agentPanel.notifyUserActivity()
    try {
      const next = await appClients.browser.navigate(url) as BrowserSnapshot
      if (browserPreview) setPreviewRevision(revision => revision + 1)
      applySnapshot(next)
    } catch (error) {
      reportRuntimeError('浏览器导航', error)
    }
  }

  const navigate = () => { void navigateTo(untrack(address)) }

  const browserCommand = async (command: 'browser_back' | 'browser_forward' | 'browser_reload') => {
    agentPanel.notifyUserActivity()
    try {
      const bc = appClients.browser
      const next = await (command === 'browser_back' ? bc.back() : command === 'browser_forward' ? bc.forward() : bc.reload()) as BrowserSnapshot
      if (browserPreview) setPreviewRevision(revision => revision + 1)
      applySnapshot(next)
    } catch (error) {
      reportRuntimeError('浏览器操作', error)
    }
  }

  const tabCommand = async (command: 'new' | 'select' | 'close' | 'open', tabId?: number, url?: string) => {
    agentPanel.notifyUserActivity()
    try {
      const client = appClients.browser
      const next = await (command === 'new'
        ? client.newTab()
        : command === 'open'
          ? client.openTab(url!)
          : command === 'select'
            ? client.selectTab(tabId!)
            : client.closeTab(tabId!)) as BrowserSnapshot
      if (browserPreview) setPreviewRevision(revision => revision + 1)
      applySnapshot(next)
    } catch (error) {
      reportRuntimeError(command === 'new' || command === 'open' ? '新建浏览器标签' : command === 'select' ? '切换浏览器标签' : '关闭浏览器标签', error)
    }
  }

  const setZoom = async (zoomPercent: number) => {
    const nextZoom = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, zoomPercent))
    agentPanel.notifyUserActivity()
    try {
      const next = await appClients.browser.setZoom(nextZoom) as BrowserSnapshot
      applySnapshot({ ...next, zoomPercent: next.zoomPercent ?? nextZoom })
    } catch (error) {
      reportRuntimeError('调整浏览器缩放', error)
    }
  }

  const inspectPage = () => {
    if (snapshot().phase !== 'ready') return Promise.resolve()
    const inFlight = inspectPageInFlight
    if (inFlight) return inFlight

    const command = 'browser_snapshot'
    const request = (async () => {
      logConsole(command, 'info')
      try {
        const result = await appClients.browser.snapshot() as BrowserPageSnapshot
        setPageSnapshot(result)
        const detail = typeof result.text === 'string' ? `${result.url ?? ''} · ${result.text.length} chars · ${result.links?.length ?? 0} links` : String(result.url ?? '')
        logConsole(command, 'success', detail)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logConsole(command, 'error', message)
        reportRuntimeError('读取浏览器页面快照', error)
      }
    })()
    inspectPageInFlight = request
    void request.finally(() => {
      if (inspectPageInFlight === request) inspectPageInFlight = null
    })
    return request
  }

  const toggleCurrentBookmark = () => {
    const url = snapshot().url
    if (!url || url === 'about:blank' || !isBrowserLibraryUrl(url)) return
    const currentLibrary = untrack(library)
    const currentlyBookmarked = currentLibrary.bookmarks.some(item => item.url === url)
    updateLibrary(current => toggleBookmark(current, { url, title: snapshot().title ?? undefined }).library)
    logConsole(currentlyBookmarked ? 'bookmark.remove' : 'bookmark.add', 'success', url)
  }

  const downloadUrl = async (rawUrl: string, filename?: string) => {
    const url = rawUrl.trim()
    if (!isBrowserLibraryUrl(url)) {
      logConsole('browser_download', 'error', '仅允许 http/https URL')
      return
    }
    logConsole('browser_download', 'info', url)
    try {
      const result = await appClients.browser.download(url, filename) as Record<string, unknown>
      const status = result?.status === 'failed' ? 'failed' : 'started'
      const error = typeof result?.error === 'string' ? result.error : undefined
      updateLibrary(current => recordDownload(current, { url, filename: typeof result?.filename === 'string' ? result.filename : filename, status, error }))
      logConsole('browser_download', status === 'failed' ? 'error' : 'success', error || `${url}${filename ? ` → ${filename}` : ''}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateLibrary(current => recordDownload(current, { url, filename, status: 'failed', error: message }))
      logConsole('browser_download', 'error', message)
      reportRuntimeError('下载浏览器资源', error)
    }
  }

  const chooseTool = (tool: BrowserToolId) => {
    setActiveTool(current => current === tool ? null : tool)
    // The activeTool effect owns snapshot refresh. Keeping one trigger
    // avoids issuing two browser_snapshot commands when opening Downloads or
    // Console (the old callback + effect race was visible as duplicate log
    // entries and unnecessary WebView work).
  }

  // ── effect 编排（可见性 / status+事件订阅 / bounds / 预览桥 / 快照刷新 / 卸载回收）──
  wireBrowserSheetEffects({
    browserPreview,
    browserRuntimeAvailable,
    ctx: () => props.ctx,
    snapshot,
    activeTool,
    modalOverlayOpen,
    viewportRef,
    applySnapshot,
    syncBounds,
    recordCurrentPage,
    setAddress,
    setSnapshot,
    setPreviewRevision,
    navigateTo,
    tabCommand,
    inspectPage,
    notifyPageChanged: agentPanel.notifyPageChanged,
  })

  const currentBookmarked = () => library().bookmarks.some(item => item.url === snapshot().url)

  const toolbarButtonClass = 'browser-toolbar-button grid w-[30px] h-[30px] shrink-0 basis-[30px] place-items-center border border-transparent rounded-[4px] text-text-dim bg-transparent cursor-pointer enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.35] disabled:cursor-not-allowed'

  return (
    <div class={`browser-sheet ${sidebarCollapsed() ? 'browser-sidebar-collapsed' : ''} flex flex-1 min-w-0 min-h-0 overflow-hidden text-text font-[family-name:var(--font)] bg-[var(--global-bg-color,var(--bg))]`} data-browser-mode={browserPreview ? 'preview' : 'runtime'}>
      <BrowserSidebar
        sidebarCollapsed={sidebarCollapsed()}
        activeTool={activeTool()}
        onSelectTool={chooseTool}
        phase={snapshot().phase}
      />
      <main class="browser-main flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden">
        {/* 保留语义节点供旧主题/可访问性选择器兼容；视觉上 Browser Sheet 不再重复显示
            BROWSER + Browser 两层标题，浏览器 chrome 直接成为主区入口。 */}
        <div class="browser-header browser-header-legacy hidden">
          <div>
            <div class="file-main-kicker">BROWSER</div>
            <h2 class="file-main-title">Browser</h2>
          </div>
          <span class="browser-status" data-phase={snapshot().phase}>{snapshot().phase}</span>
        </div>
        <Show when={snapshot().tabs.length > 0}>
          <BrowserTabStrip
            tabs={snapshot().tabs}
            activeTabId={snapshot().activeTabId}
            onTabCommand={(command, tabId, url) => void tabCommand(command, tabId, url)}
          />
        </Show>
        <div class="browser-toolbar flex shrink-0 min-w-0 min-h-[44px] items-center gap-1 m-0 py-1.5 px-2 border-0 border-b border-border rounded-none bg-bg-panel max-[720px]:px-[5px]" aria-label="浏览器导航栏">
          <button type="button" class={toolbarButtonClass} onClick={() => void browserCommand('browser_back')} disabled={snapshot().phase !== 'ready'} aria-label="后退"><LucideIcon name="ChevronLeft" size={18} /></button>
          <button type="button" class={toolbarButtonClass} onClick={() => void browserCommand('browser_forward')} disabled={snapshot().phase !== 'ready'} aria-label="前进"><LucideIcon name="ChevronRight" size={18} /></button>
          <button type="button" class={toolbarButtonClass} onClick={() => void browserCommand('browser_reload')} disabled={snapshot().phase !== 'ready'} aria-label="刷新"><LucideIcon name="RefreshCw" size={15} /></button>
          <div class="browser-address-wrap flex min-w-0 flex-1 items-center gap-[7px] h-[30px] px-2.5 border border-border rounded-[5px] text-text-dim bg-bg-input focus-within:border-border-focus focus-within:shadow-[inset_0_-2px_0_var(--accent)]"><LucideIcon name="Search" size={14} /><input class="browser-address min-w-0 flex-1 h-[28px] p-0 border-0 outline-none text-text bg-transparent font-[family-name:var(--mono)] text-[12px] placeholder:text-text-placeholder focus-visible:outline-[1px] focus-visible:outline-offset-[-1px] focus-visible:outline-[var(--state-focus-ring)]" value={address()} onInput={event => setAddress(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') void navigate() }} placeholder="输入网址…" aria-label="网址" /></div>
          <button
            type="button"
            class={`browser-toolbar-button browser-bookmark-button grid w-[30px] h-[30px] shrink-0 basis-[30px] place-items-center border border-transparent rounded-[4px] text-text-dim bg-transparent cursor-pointer enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.35] disabled:cursor-not-allowed ${currentBookmarked() ? 'active' : ''}`}
            onClick={toggleCurrentBookmark}
            disabled={!snapshot().url || snapshot().url === 'about:blank'}
            aria-label={currentBookmarked() ? '移除当前页书签' : '添加当前页书签'}
            title={currentBookmarked() ? '移除书签' : '添加书签'}
          >
            <Show when={currentBookmarked()} fallback={<LucideIcon name="Bookmark" size={16} />}><LucideIcon name="BookmarkCheck" size={16} /></Show>
          </button>
          <button
            type="button"
            class="browser-zoom-toggle min-w-[52px] h-[30px] shrink-0 px-2 border border-transparent rounded-[4px] text-text-dim bg-transparent font-[family-name:var(--mono)] text-[11px] cursor-pointer hover:border-border hover:text-text hover:bg-bg-hover aria-expanded:border-border aria-expanded:text-text aria-expanded:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            onClick={() => setZoomSettingsOpen(open => !open)}
            aria-expanded={zoomSettingsOpen()}
            aria-controls="browser-zoom-settings"
            aria-label={`页面缩放，当前 ${snapshot().zoomPercent}%`}
          >
            {snapshot().zoomPercent}%
          </button>
          <span class={`browser-status browser-status-inline inline-flex min-w-[58px] h-[26px] items-center justify-center px-[7px] border rounded-[4px] text-text-dim bg-bg-panel font-[family-name:var(--mono)] text-[10px] tracking-[.04em] uppercase max-[720px]:min-w-[50px] ${snapshot().phase === 'ready' ? 'text-[var(--tool-ok)] border-[color-mix(in_srgb,var(--tool-ok)_38%,var(--border))]' : snapshot().phase === 'starting' ? 'text-[var(--tool-run)] border-[color-mix(in_srgb,var(--tool-run)_38%,var(--border))]' : snapshot().phase === 'error' ? 'text-[var(--tool-err,var(--danger))] border-[color-mix(in_srgb,var(--tool-err,var(--danger))_38%,var(--border))]' : ''} ${snapshot().runtime === 'iframe-preview' ? 'text-accent border-[color-mix(in_srgb,var(--accent)_38%,var(--border))]' : ''}`} data-phase={snapshot().phase} data-runtime={snapshot().runtime} title={browserPreview ? '开发预览：页面由 iframe 加载' : '桌面 WebView2 会话'}>
            {browserPreview ? '预览' : BROWSER_PHASE_LABELS[snapshot().phase]}
          </span>
        </div>
        <Show when={zoomSettingsOpen()}>
          <div id="browser-zoom-settings" class="browser-zoom-settings flex min-h-[38px] shrink-0 items-center gap-2 m-0 py-1 px-2 border-0 border-b border-border text-text-dim bg-bg-panel" role="group" aria-label="页面缩放设置">
            <button type="button" class="browser-zoom-button grid w-7 h-7 shrink-0 basis-7 place-items-center border border-border rounded-[4px] text-text bg-bg-input cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:border-accent enabled:hover:text-text enabled:hover:bg-bg-hover" onClick={() => void setZoom(snapshot().zoomPercent - ZOOM_STEP)} disabled={snapshot().phase !== 'ready' || snapshot().zoomPercent <= MIN_ZOOM_PERCENT} aria-label="缩小页面"><LucideIcon name="Minus" size={14} /></button>
            <input
              class="browser-zoom-range min-w-[100px] flex-1 accent-accent cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              type="range"
              min={MIN_ZOOM_PERCENT}
              max={MAX_ZOOM_PERCENT}
              step={ZOOM_STEP}
              value={snapshot().zoomPercent}
              onInput={event => void setZoom(Number(event.currentTarget.value))}
              disabled={snapshot().phase !== 'ready'}
              aria-label="页面缩放"
            />
            <output class="browser-zoom-value w-[44px] text-text font-[family-name:var(--mono)] text-[11px] text-right" aria-live="polite">{snapshot().zoomPercent}%</output>
            <button type="button" class="browser-zoom-button grid w-7 h-7 shrink-0 basis-7 place-items-center border border-border rounded-[4px] text-text bg-bg-input cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:border-accent enabled:hover:text-text enabled:hover:bg-bg-hover" onClick={() => void setZoom(snapshot().zoomPercent + ZOOM_STEP)} disabled={snapshot().phase !== 'ready' || snapshot().zoomPercent >= MAX_ZOOM_PERCENT} aria-label="放大页面"><LucideIcon name="Plus" size={14} /></button>
            <button type="button" class="browser-zoom-reset inline-flex h-7 items-center gap-[5px] px-2 border border-border rounded-[4px] text-text-dim bg-bg-input font-[family-name:var(--mono)] text-[10px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:border-accent enabled:hover:text-text enabled:hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent" onClick={() => void setZoom(DEFAULT_ZOOM_PERCENT)} disabled={snapshot().phase !== 'ready' || snapshot().zoomPercent === DEFAULT_ZOOM_PERCENT} aria-label="恢复默认缩放"><LucideIcon name="RotateCcw" size={13} />默认 90%</button>
          </div>
        </Show>
        <Show when={activeTool()}>
          {tool => (
            <BrowserToolPanel
              activeTool={tool()}
              library={library()}
              pageSnapshot={pageSnapshot()}
              consoleFilter={consoleFilter()}
              onConsoleFilterChange={setConsoleFilter}
              onClose={() => setActiveTool(null)}
              onClear={collection => updateLibrary(current => clearBrowserCollection(current, collection))}
              onNavigate={url => void navigateTo(url)}
              onDownload={(url, filename) => void downloadUrl(url, filename)}
              onInspect={() => void inspectPage()}
              downloadUrlInput={downloadUrlInput()}
              onDownloadUrlInputChange={setDownloadUrlInput}
              browserPreview={browserPreview}
              agentSettings={agentPanel.agentSettings()}
              agentClaim={agentPanel.agentClaim()}
              agentOps={agentPanel.agentOps()}
              agentBlocklistDraft={agentPanel.agentBlocklistDraft()}
              onAgentBlocklistDraftChange={agentPanel.setAgentBlocklistDraft}
              agentBusy={agentPanel.agentBusy()}
              agentError={agentPanel.agentError()}
              pageChangedAt={agentPanel.pageChangedAt()}
              askAiDraft={agentPanel.askAiDraft()}
              onAskAiDraftChange={agentPanel.setAskAiDraft}
              canSendAskAi={Boolean(props.ctx.activeSession)}
              onRefreshAgent={() => void agentPanel.refreshAgentPanel()}
              onAgentModeChange={mode => void agentPanel.saveAgentSettings({ defaultMode: mode })}
              onAgentAdFilterChange={enabled => void agentPanel.saveAgentSettings({ adFilterEnabled: enabled })}
              onAgentBlocklistSave={agentPanel.saveAgentBlocklist}
              onBuildAskAi={agentPanel.buildAskAi}
              onSendAskAi={() => void agentPanel.sendAskAi()}
            />
          )}
        </Show>
        <BrowserViewport
          viewportRef={viewportRef}
          browserPreview={browserPreview}
          snapshot={snapshot()}
          previewRevision={previewRevision()}
          onStart={() => void start()}
        />
        <Show when={state().error}><div class="file-tree-error browser-error" role="alert">{state().error}</div></Show>
      </main>
    </div>
  )
}
