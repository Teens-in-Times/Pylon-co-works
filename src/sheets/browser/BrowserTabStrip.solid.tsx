/** @jsxImportSource solid-js */
import { For } from 'solid-js'
import { LucideIcon } from '../../components/LucideIcon.solid.tsx'
import type { BrowserTabSnapshot } from './browserSheetTypes.ts'
import { navigateTabStrip } from '../tabNavigation.ts'

function browserTabLabel(tab: BrowserTabSnapshot): string {
  const title = tab.title?.trim()
  if (title) return title
  const rawUrl = tab.url?.trim()
  if (!rawUrl || rawUrl === 'about:blank') return '新标签'
  try {
    return new URL(rawUrl).hostname || rawUrl
  } catch {
    return rawUrl
  }
}

/** Browser tab selection remains reactive; keyboard navigation shares the file-tab interaction contract. */
export function BrowserTabStrip(props: { tabs: BrowserTabSnapshot[]; activeTabId: number | null; onTabCommand: (command: 'new' | 'select' | 'close' | 'open', tabId?: number, url?: string) => void }) {
  return (
    <div class="browser-tab-strip flex min-w-0 min-h-9 shrink-0 items-stretch gap-[3px] m-0 pt-1 px-2 overflow-x-auto border-0 border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_88%,var(--global-bg-color)_12%)] [scrollbar-width:thin]" role="tablist" aria-label="浏览器标签">
      <For each={props.tabs}>
        {tab => {
          const active = () => props.activeTabId === tab.id
          return (
            <div class={`browser-tab flex min-w-[112px] max-w-[240px] basis-[190px] shrink grow-0 items-center border border-transparent border-b-0 text-text-dim bg-transparent max-[720px]:min-w-[100px] ${active() ? 'border-[color-mix(in_srgb,var(--accent)_46%,var(--border))] text-text bg-bg-active shadow-[inset_0_-2px_var(--accent)]' : 'hover:text-text hover:bg-bg-hover'}`}>
              <button type="button" class="browser-tab-select flex min-w-0 h-[30px] flex-1 items-center gap-1.5 pt-0 pr-1 pb-0 pl-[9px] overflow-hidden border-0 text-inherit bg-transparent font-[family-name:var(--font)] text-[11px] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent" role="tab" aria-selected={active()} tabIndex={active() || (props.activeTabId === null && props.tabs[0]?.id === tab.id) ? 0 : -1} onKeyDown={navigateTabStrip} onClick={() => void props.onTabCommand('select', tab.id)} title={tab.title || tab.url || '新标签'}>
                <LucideIcon name="Globe2" size={13} aria-hidden="true" />
                <span class="overflow-hidden text-ellipsis whitespace-nowrap">{browserTabLabel(tab)}</span>
              </button>
              <button type="button" class="browser-tab-close grid w-[26px] h-[26px] shrink-0 basis-[26px] place-items-center border border-transparent rounded-[4px] text-text-placeholder bg-transparent cursor-pointer hover:border-border hover:text-text hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent" onClick={() => void props.onTabCommand('close', tab.id)} aria-label={`关闭 ${browserTabLabel(tab)}`}><LucideIcon name="X" size={12} /></button>
            </div>
          )
        }}
      </For>
      <button type="button" class="browser-tab-new self-center mr-0.5 mb-1 ml-px grid w-[26px] h-[26px] shrink-0 basis-[26px] place-items-center border border-transparent rounded-[4px] text-text-placeholder bg-transparent cursor-pointer hover:border-border hover:text-text hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent" onClick={() => void props.onTabCommand('new')} aria-label="新建浏览器标签"><LucideIcon name="Plus" size={14} /></button>
    </div>
  )
}
