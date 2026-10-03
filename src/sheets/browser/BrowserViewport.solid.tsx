/** @jsxImportSource solid-js */
import { Show } from 'solid-js'
import type { BrowserSnapshot } from './browserSheetTypes.ts'

function browserPreviewUrl(url: string): string {
  return `/__pylon_browser_proxy?url=${encodeURIComponent(url)}`
}

/** 接口名承自历史 React 契约（BrowserViewport.tsx，已退役）；本实体即唯一真源。 */
interface BrowserViewportProps {
  viewportRef: { current: HTMLDivElement | null }
  browserPreview: boolean
  snapshot: BrowserSnapshot
  previewRevision: number
  onStart: () => void
}

/** 预览 iframe 与未启动空态共用的 viewport 容器（#228 批次 D 纯搬移）。
 * `viewportRef` 仍归属主组件——bounds 同步、启动定位都读这个节点。
 * #515：Solid 实体；React 语义对照——条件渲染经 Show，iframe 的 React `key`
 * （revision 变化强制重挂、预览重新回到状态机 URL）由 keyed Show 承担。 */
export function BrowserViewport(props: BrowserViewportProps) {
  return (
    <div ref={element => { props.viewportRef.current = element }} class="browser-viewport relative flex flex-1 min-w-0 min-h-0 items-stretch justify-stretch overflow-hidden border-0 rounded-none bg-bg-panel">
      <Show when={props.browserPreview && props.snapshot.phase === 'ready' && props.snapshot.url && props.snapshot.url !== 'about:blank'}>
        <Show when={`${props.snapshot.activeTabId ?? 'tab'}:${props.snapshot.url}:${props.previewRevision}`} keyed>
          {_frameKey => (
            <iframe
              class="browser-preview-frame block w-full h-full flex-1 border-0 bg-white"
              src={browserPreviewUrl(props.snapshot.url!)}
              title={props.snapshot.title || props.snapshot.url!}
              referrerPolicy="no-referrer"
            />
          )}
        </Show>
      </Show>
      <div class={`browser-empty-state absolute inset-0 flex items-center justify-center flex-col gap-2 w-auto p-[var(--ui-space-7)] border-0 rounded-none text-text-dim bg-bg-panel text-center ${props.snapshot.phase === 'ready' ? 'invisible pointer-events-none' : ''}`} role="status">
        <div class="browser-empty-mark grid w-[46px] h-[46px] place-items-center mb-2 border border-[color-mix(in_srgb,var(--accent)_42%,var(--border))] rounded-full text-accent bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-panel))] font-bold text-[22px] font-[family-name:var(--mono)]" aria-hidden="true">◌</div>
        <strong class="text-text text-[15px]">{props.browserPreview ? '输入网址开始浏览' : '浏览器会话尚未启动'}</strong>
        <span class="max-w-[520px] text-[12px] leading-[1.5]">{props.browserPreview ? '开发预览加载真实网页；桌面端会切换为嵌入式 WebView2。' : '启动后，完整 WebView 将占据主工作区。'}</span>
        <span class="browser-empty-note mt-2 text-text-placeholder font-[family-name:var(--mono)] text-[10px] leading-[1.5]">{props.browserPreview ? 'preview runtime · 不伪装成桌面 WebView' : 'WebView2 子进程由 Browser Sheet 生命周期管理'}</span>
        <div class="browser-actions flex gap-[var(--ui-space-2)] mt-[var(--ui-space-4)]"><button type="button" class="template-apply" onClick={() => props.onStart()} disabled={props.snapshot.phase === 'starting'}>新建标签</button></div>
      </div>
    </div>
  )
}
