/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { LucideIcon } from '../../components/LucideIcon.solid.tsx'
import type { DocsSheetSnapshot } from '../../infrastructure/tauri/docsClient'
import { useModalOverlayStore } from '../../app/modalOverlayStore'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { reportRuntimeError } from '../../app/runtimeError'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * DocsSheetView — 离线文档站壳（#371）。
 *
 * 子 WebView 由后端创建并嵌进 viewport（`pylon-docs://` scheme），前端只做三件事：
 * 进入活动主区自动 start（keep-alive 复活为幂等）、bounds/可见性随布局与覆盖层同步、
 * 卸载时 close 回收 WebView2 子进程。导航 chrome 保持最小（回首页/后退/前进/刷新）——
 * VitePress 自带 navbar/sidebar/搜索，不复制浏览器语义。
 *
 * 原生子 WebView 是独立于宿主 DOM 的窗口：display:none 盖不住它，可见性必须走
 * docs_sheet_set_visible（与 Browser Sheet 同一约束）；外链在 Rust on_navigation
 * fail-closed 取消，壳层不代开系统浏览器。
 *
 * #515：Solid 实体，行为与 React 版逐行同构——覆盖层事实经 createZustandSignal，
 * 原版以 effect deps 表达的重同步时机逐条对照（见各 createEffect 处注释）。
 */

const DOCS_CLIENT = appClients.docs

const IDLE_SNAPSHOT: DocsSheetSnapshot = { phase: 'idle', error: null, visible: true }

interface DocsSheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

// ---- #520 S3-P2-1：本地 DOCS_ICONS 表与 DocsIcon 自绘已退役，图标统一经共享 LucideIcon
// （BookOpen/ChevronLeft/ChevronRight/House/RotateCw 均已登记其中）。 ----

export default function DocsSheetView(props: DocsSheetViewProps) {
  const [snapshot, setSnapshot] = createSignal<DocsSheetSnapshot>(IDLE_SNAPSHOT)
  // 任一模态覆盖层打开（原 useModalOverlayOpen 的 Solid 等价消费）。
  const modalOverlayOpen = createZustandSignal(useModalOverlayStore, state => state.openKeys.size > 0)
  let viewport!: HTMLDivElement
  const ready = () => snapshot().phase === 'ready'

  const start = async () => {
    const rect = viewport?.getBoundingClientRect()
    try {
      const next = await DOCS_CLIENT.start({
        x: Math.round(rect?.left ?? 0),
        y: Math.round(rect?.top ?? 0),
        width: Math.max(1, Math.round(rect?.width ?? 1)),
        height: Math.max(1, Math.round(rect?.height ?? 1)),
      }) as DocsSheetSnapshot
      setSnapshot(next)
    } catch (error) {
      setSnapshot(previous => ({ ...previous, phase: 'error', error: error instanceof Error ? error.message : String(error) }))
      reportRuntimeError('打开文档站', error)
    }
  }

  // 进入活动主区自动建会话；对已就绪/启动中的 keep-alive 复活是幂等的（后端去重）。
  // 原 useEffect [ctx.isActive, start]：snapshot.phase 经 untrack 旁路读取（原 ref 语义，不进依赖）。
  createEffect(() => {
    if (props.ctx.isActive !== true) return
    if (untrack(() => snapshot()).phase !== 'idle') return
    void start()
  })

  // phase 进入 ready 后 syncBounds 身份变化 → bounds 效果重跑一次，把原生 WebView
  // 边界与 DOM 布局收敛（与 BrowserSheetView 同一依赖形态）。
  const syncBounds = () => {
    const element = viewport
    if (!element || snapshot().phase !== 'ready' || props.ctx.isActive === false) return
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    void DOCS_CLIENT.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }).catch(error => reportRuntimeError('调整文档区域', error))
  }

  // 同步原生子 WebView 可见性（Sheet 切换 keep-alive + 模态覆盖层让位）；
  // 依赖 phase：start 完成后补发一次与当前活动态一致的可见性。
  // 原 useEffect [ctx.isActive, isSheetActive, modalOverlayOpen, snapshot.phase]。
  createEffect(() => {
    const rawActive = props.ctx.isActive
    const active = rawActive !== false
    const overlayOpen = modalOverlayOpen()
    const phase = snapshot().phase
    if (typeof rawActive !== 'boolean' || phase !== 'ready') return
    void DOCS_CLIENT.setVisible(active && !overlayOpen)
      .catch(error => reportRuntimeError('切换文档可见性', error))
  })

  // 原 useEffect [syncBounds, sidebarCollapsed]：syncBounds 身份随 (isSheetActive,
  // snapshot.phase) 变化，叠加折叠变化（ctx.sidebarCollapsed）即时重同步 bounds。
  createEffect(() => {
    // 依赖面（读取即注册）：活动态、phase、折叠。
    const active = props.ctx.isActive !== false
    const phase = snapshot().phase
    const collapsed = props.ctx.sidebarCollapsed
    void active
    void phase
    void collapsed
    const element = viewport
    if (!element) return
    const observer = new ResizeObserver(() => syncBounds())
    observer.observe(element)
    window.addEventListener('resize', syncBounds)
    syncBounds()
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    })
  })

  onMount(() => {
    onCleanup(() => {
      // Sheet 可能在 WebView 已创建但未 ready 时卸载；close 对 idle 幂等，覆盖所有状态。
      if (snapshot().phase !== 'idle') {
        void DOCS_CLIENT.close().catch(() => {})
      }
    })
  })

  const runCommand = async (command: 'back' | 'forward' | 'reload' | 'home') => {
    try {
      const next = await DOCS_CLIENT[command]() as DocsSheetSnapshot
      setSnapshot(previous => ({ ...previous, ...next }))
    } catch (error) {
      reportRuntimeError('文档站导航', error)
    }
  }

  const toolbarButtonClass = 'docs-toolbar-button grid w-[30px] h-[30px] shrink-0 basis-[30px] place-items-center border border-transparent rounded-[4px] text-text-dim bg-transparent cursor-pointer enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.35] disabled:cursor-not-allowed'

  return (
    <div class="docs-sheet flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden text-text font-[family-name:var(--font)] bg-[var(--global-bg-color,var(--bg))]">
      <div class="docs-toolbar flex shrink-0 min-w-0 min-h-[40px] items-center gap-1 m-0 py-1 px-2 border-0 border-b border-border rounded-none bg-bg-panel" aria-label="文档工具栏">
        <button type="button" class={toolbarButtonClass} onClick={() => void runCommand('home')} disabled={!ready()} aria-label="回首页" title="回首页"><LucideIcon name="House" size={16} /></button>
        <button type="button" class={toolbarButtonClass} onClick={() => void runCommand('back')} disabled={!ready()} aria-label="后退"><LucideIcon name="ChevronLeft" size={18} /></button>
        <button type="button" class={toolbarButtonClass} onClick={() => void runCommand('forward')} disabled={!ready()} aria-label="前进"><LucideIcon name="ChevronRight" size={18} /></button>
        <button type="button" class={toolbarButtonClass} onClick={() => void runCommand('reload')} disabled={!ready()} aria-label="刷新"><LucideIcon name="RotateCw" size={15} /></button>
        <span class="docs-title min-w-0 flex-1 px-1 text-[12px] text-text-dim truncate">Pylon 文档</span>
        <span class={`docs-status inline-flex h-[24px] items-center justify-center px-[7px] border rounded-[4px] font-[family-name:var(--mono)] text-[10px] tracking-[.04em] uppercase ${ready() ? 'text-[var(--tool-ok)] border-[color-mix(in_srgb,var(--tool-ok)_38%,var(--border))]' : snapshot().phase === 'error' ? 'text-[var(--tool-err,var(--danger))] border-[color-mix(in_srgb,var(--tool-err,var(--danger))_38%,var(--border))]' : 'text-text-dim border-border'}`} data-phase={snapshot().phase}>{snapshot().phase}</span>
      </div>
      <div ref={element => { viewport = element }} class="docs-viewport relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
        <Show when={!ready()}>
          <div class="docs-placeholder absolute inset-0 grid place-content-center justify-items-center gap-2 p-6 text-text-dim" data-phase={snapshot().phase}>
            <LucideIcon name="BookOpen" size={28} />
            <p class="m-0 text-[13px]">
              {snapshot().phase === 'error' ? (snapshot().error || '文档站加载失败') : snapshot().phase === 'idle' ? '文档站尚未启动' : '正在打开文档站…'}
            </p>
            <Show when={snapshot().phase === 'error'}><p class="m-0 text-[11px] text-text-placeholder">离线文档站需随发行包分发的 docs-site 资源；开发构建可先运行 bun run docs:build:offline</p></Show>
            <Show when={snapshot().phase === 'idle'}><button type="button" class="docs-retry px-3 h-[28px] border border-border rounded-[5px] text-[12px] text-text bg-bg-input cursor-pointer hover:border-accent hover:text-text hover:bg-bg-hover" onClick={() => void start()}>打开文档</button></Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
