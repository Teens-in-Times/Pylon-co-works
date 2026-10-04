import { createEffect, onCleanup, onMount, untrack, type Accessor, type Setter } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { reportRuntimeError } from '../../app/runtimeError'
import { runtimeEventClient } from '../../infrastructure/tauri/runtimeEventClient.ts'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import type { BrowserSnapshot, BrowserToolId } from './browserSheetTypes.ts'

/**
 * wireBrowserSheetEffects — Browser Sheet 的 effect 编排（#520 S3-P0-3 自
 * BrowserSheetView 拆出）。
 *
 * 覆盖宿主原有的 7 个副作用：原生子 WebView 可见性、status 探测 + Tauri 事件订阅
 * （经 runtimeEventClient 传输层收口，#520 S1-P1）、bounds 重同步、开发预览
 * postMessage、预览 mock 状态投影、工具面板打开即刷新快照、卸载回收 WebView。
 * 各 effect 的依赖面、untrack 旁路与清理语义逐条保真；注册顺序与拆分前一致。
 *
 * 事件订阅改经 runtimeEventClient：dispose 语义与原 onCleanup 里的
 * `.then(stop => stop()).catch(() => {})` 逐条对应（dispose 前 settle → 立即注销；
 * settle 前 dispose → settle 后补注销；注册失败只在清理处吸收）。
 */
export interface BrowserSheetEffectsDeps {
  /** 环境探测结果（挂载期常量，非响应式）。 */
  browserPreview: boolean
  browserRuntimeAvailable: boolean
  /** 响应式读取（props.ctx 是 getter，测试经信号翻转 ctx）。 */
  ctx: Accessor<SheetContext>
  snapshot: Accessor<BrowserSnapshot>
  activeTool: Accessor<BrowserToolId | null>
  modalOverlayOpen: Accessor<boolean>
  viewportRef: { current: HTMLDivElement | null }
  applySnapshot(next: BrowserSnapshot): void
  syncBounds(): void
  recordCurrentPage(url: string | null | undefined, title?: string | null): void
  setAddress(url: string): void
  setSnapshot: Setter<BrowserSnapshot>
  setPreviewRevision: Setter<number>
  navigateTo(rawUrl: string): Promise<void>
  tabCommand(command: 'new' | 'select' | 'close' | 'open', tabId?: number, url?: string): Promise<void>
  inspectPage(): Promise<void>
  /** Agent 面板「页面已变化」提示（useBrowserAgentPanel 提供）。 */
  notifyPageChanged(): void
}

export function wireBrowserSheetEffects(deps: BrowserSheetEffectsDeps): void {
  const { browserPreview, browserRuntimeAvailable, viewportRef } = deps

  // 同步原生子 WebView 的可见性。不能用 CSS 代替：Tauri child WebView 位于
  // 宿主窗口的原生层，DOM 树上的 display:none 对它没有效果。
  // 原 useEffect [browserPreview, browserRuntimeAvailable, ctx.isActive, isSheetActive,
  // snapshot.phase, modalOverlayOpen]。
  createEffect(() => {
    const rawActive = deps.ctx().isActive
    const active = rawActive !== false
    const overlayOpen = deps.modalOverlayOpen()
    const phase = deps.snapshot().phase
    // 旧的独立组件调用方没有 isActive 字段；不向它们引入一个额外的
    // 未 mock 命令，SheetLayout（生产路径）会始终提供显式布尔值。
    if (!browserRuntimeAvailable || browserPreview || typeof rawActive !== 'boolean' || phase !== 'ready') return
    const nativeVisible = active && !overlayOpen
    void appClients.browser
      .setVisible(nativeVisible)
      .catch(error => reportRuntimeError('切换浏览器可见性', error))
  })

  // status 探测 + Tauri 事件订阅（原 useEffect [applySnapshot, browserPreview,
  // browserRuntimeAvailable, ctx.isActive, isSheetActive, recordCurrentPage]——回调身份
  // 依赖链收敛到 ctx.isActive 一处，其余为模块级常量）。
  createEffect(() => {
    if (!browserRuntimeAvailable) return
    const rawActive = deps.ctx().isActive
    let disposed = false
    const client = appClients.browser
    const commit = (next: BrowserSnapshot) => {
      if (!disposed) deps.applySnapshot(next)
    }
    const startSessionIfNeeded = async (raw: BrowserSnapshot) => {
      commit(raw)
      // Browser Sheet 进入活动主区后自动建立会话；开发预览同样走真实 iframe，
      // 不再注入静态 ready 快照。没有显式活动态的旧独立调用方保持原来的手动启动语义。
      const canAutoStart = browserPreview || rawActive === true
      if (canAutoStart && raw.phase === 'idle' && !disposed) {
        const rect = viewportRef.current?.getBoundingClientRect()
        try {
          const started = await client.start({
            x: Math.round(rect?.left ?? 0),
            y: Math.round(rect?.top ?? 0),
            width: Math.max(1, Math.round(rect?.width ?? 1)),
            height: Math.max(1, Math.round(rect?.height ?? 1)),
          }) as BrowserSnapshot
          deps.setPreviewRevision(revision => revision + 1)
          commit(started)
        } catch {
          // 真实错误会由用户点击“新建标签”时再次显示；这里不让一次
          // 启动竞态阻塞整个 Sheet 的其它 chrome。
        }
      }
    }
    void client.status().then(raw => void startSessionIfNeeded(raw as BrowserSnapshot)).catch(() => {})
    const status = runtimeEventClient.subscribe<BrowserSnapshot>('pylon:browser-status', payload => commit(payload))
    const page = runtimeEventClient.subscribe<{ tabId: number; active: boolean; url?: string | null; title?: string | null }>('pylon:browser-page', payload => {
      if (disposed) return
      deps.setSnapshot(previous => ({
        ...previous,
        ...(payload.active ? { url: payload.url, title: payload.title } : {}),
        tabs: previous.tabs.map(tab => tab.id === payload.tabId ? { ...tab, url: payload.url, title: payload.title } : tab),
      }))
      if (payload.active) {
        deps.setAddress(payload.url && payload.url !== 'about:blank' ? payload.url : '')
        deps.recordCurrentPage(payload.url, payload.title)
      }
      deps.notifyPageChanged()
    })
    onCleanup(() => {
      disposed = true
      status.dispose()
      page.dispose()
    })
  })

  // 原 useEffect [syncBounds, sidebarCollapsed]：syncBounds 身份随 (browserRuntimeAvailable,
  // isSheetActive, snapshot.phase) 变化，叠加折叠变化即时重同步 WebView bounds。
  createEffect(() => {
    // 依赖面（读取即注册）：活动态、phase、折叠。
    const active = deps.ctx().isActive !== false
    const phase = deps.snapshot().phase
    const collapsed = deps.ctx().sidebarCollapsed
    void active
    void phase
    void collapsed
    const element = viewportRef.current
    if (!element) return
    const observer = new ResizeObserver(() => deps.syncBounds())
    observer.observe(element)
    window.addEventListener('resize', deps.syncBounds)
    deps.syncBounds()
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener('resize', deps.syncBounds)
    })
  })

  // 开发代理页会把跨域页面中的链接点击通过 postMessage 交回这里；
  // 原生 Tauri WebView 则由 Rust 的初始化脚本处理同一语义。
  // （原 effect deps [browserPreview, navigateTo, tabCommand]——回调身份依赖链收敛到
  // 环境常量，闭包读信号恒最新，onMount 一次性注册等价。）
  onMount(() => {
    if (!browserPreview) return
    const onPreviewMessage = (event: MessageEvent<unknown>) => {
      const frame = viewportRef.current?.querySelector<HTMLIFrameElement>('.browser-preview-frame')
      if (!frame || event.source !== frame.contentWindow) return
      const payload = event.data
      if (!payload || typeof payload !== 'object') return
      const message = payload as { source?: unknown; action?: unknown; href?: unknown }
      if (message.source !== 'pylon-browser-preview' || typeof message.href !== 'string') return
      if (message.action === 'open-tab') void deps.tabCommand('open', undefined, message.href)
      else if (message.action === 'navigate') void deps.navigateTo(message.href)
    }
    window.addEventListener('message', onPreviewMessage)
    onCleanup(() => window.removeEventListener('message', onPreviewMessage))
  })

  // 开发预览没有 Tauri event plugin；mock transport 会把命令结果投影成
  // 同名 DOM 事件。这样 Agent 在预览中执行 browser.* 时，标签栏/地址栏/iframe
  // 仍与返回的状态保持一致。原生 WebView 继续只消费 Tauri 事件。
  onMount(() => {
    if (!browserPreview) return
    const onMockStatus = (event: Event) => {
      const payload = (event as CustomEvent<unknown>).detail
      if (!payload || typeof payload !== 'object') return
      const next = payload as BrowserSnapshot
      if (typeof next.phase !== 'string' || !Array.isArray(next.tabs)) return
      const previous = untrack(deps.snapshot)
      if (previous.activeTabId !== next.activeTabId || previous.url !== next.url) {
        deps.setPreviewRevision(revision => revision + 1)
      }
      deps.applySnapshot(next)
    }
    window.addEventListener('pylon:browser-status', onMockStatus)
    onCleanup(() => window.removeEventListener('pylon:browser-status', onMockStatus))
  })

  // 原 useEffect [activeTool, inspectPage, snapshot.phase]：面板打开即刷新页面快照。
  createEffect(() => {
    const tool = deps.activeTool()
    const phase = deps.snapshot().phase
    if ((tool === 'downloads' || tool === 'console') && phase === 'ready') void deps.inspectPage()
  })

  onMount(() => {
    onCleanup(() => {
      // Sheet 可能在 WebView 仍处于 starting/error（但已创建子视图）时卸载；
      // 只在 ready 清理会留下后台 WebView。browser_close 对 idle 也是幂等的，
      // 因而这里覆盖所有非 idle 状态。
      if (browserRuntimeAvailable && untrack(deps.snapshot).phase !== 'idle') {
        void appClients.browser.close().catch(() => {})
      }
    })
  })
}
