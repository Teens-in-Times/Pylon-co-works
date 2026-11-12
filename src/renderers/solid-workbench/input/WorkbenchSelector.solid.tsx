/** Shared workbench selector presentation. Controllers retain command ownership. */
import { For, Show, onCleanup, onMount, type JSX } from 'solid-js'
import { LucideIcon } from '../../../components/LucideIcon.solid.tsx'
import type { WorkbenchOptionEntry } from '../../../plugin-runtime/renderers/workbenchRendererFactory.ts'
import { optionLabel, type WorkbenchOptionKind } from './workbenchOptionCatalog.ts'

export function WorkbenchSelector(props: {
  kind: WorkbenchOptionKind
  id: string
  label: string
  value: string
  entries: readonly WorkbenchOptionEntry[]
  open: boolean
  pending: boolean
  disabled?: boolean
  cycle?: boolean
  style: JSX.CSSProperties
  rootStyle?: JSX.CSSProperties
  error?: string
  errorDetail?: string
  onTrigger(element: HTMLButtonElement): void
  onOpen(open: boolean): void
  onClose(focus?: boolean): void
  onChoose(value: string): void
  onCycle(): void
}) {
  let root: HTMLDivElement | undefined
  let menu: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  const kindClass = () => props.kind === 'mode' ? 'permission' : props.kind
  const icon = () => props.kind === 'model' ? 'Bot' : props.kind === 'reasoning' ? 'Sparkles' : 'SlidersHorizontal'
  const shown = (entry: WorkbenchOptionEntry) => optionLabel(props.kind, entry.id, entry.label)
  const currentLabel = () => optionLabel(props.kind, props.value, props.entries.find(entry => entry.id === props.value)?.label) || (props.kind === 'model' ? '未提供模型' : '未提供选项')
  const options = () => Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
  const openMenu = () => {
    if (props.disabled || props.pending) return
    props.onOpen(true)
    queueMicrotask(() => {
      const rows = options()
      ;(rows.find(row => row.getAttribute('aria-selected') === 'true') ?? rows[0])?.focus()
    })
  }
  const move = (key: string) => {
    const rows = options()
    if (!rows.length) return
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = key === 'Home' ? 0 : key === 'End' ? rows.length - 1 : (index + (key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length
    rows[next]?.focus()
    rows[next]?.scrollIntoView({ block: 'nearest' })
  }
  onMount(() => {
    const dismiss = (event: PointerEvent) => { if (props.open && !root?.contains(event.target as Node)) props.onClose() }
    document.addEventListener('pointerdown', dismiss)
    onCleanup(() => document.removeEventListener('pointerdown', dismiss))
  })
  return <div ref={root} class={`solid-${kindClass()}-widget`} style={props.rootStyle}>
    <Show when={props.error}>{error => <span class="cc-widget-error" role="alert" title={props.errorDetail || error()}>{error()}</span>}</Show>
    <div class="cc-model-root">
      <button ref={element => { trigger = element; props.onTrigger(element) }} type="button" class={`cc-${kindClass()}-trigger`} data-mode={props.kind === 'mode' ? props.value : undefined}
        style={props.style} disabled={props.disabled} aria-busy={props.pending || undefined}
        title={props.disabled ? `该 Agent 未提供${props.label}选项` : `${props.label}：${currentLabel()}`}
        aria-haspopup={props.cycle ? undefined : 'listbox'} aria-expanded={props.cycle ? undefined : props.open}
        aria-controls={props.cycle ? undefined : props.id}
        onClick={() => props.cycle ? props.onCycle() : props.open ? props.onClose() : openMenu()}
        onKeyDown={event => {
          if (!props.cycle && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); openMenu() }
        }}>
        <span class="cc-selector-icon" aria-hidden="true"><LucideIcon name={icon()} size={14} strokeWidth={1.6} /></span>
        <span class="cc-trigger-label">{props.pending ? '切换中…' : currentLabel()}</span>
        <Show when={!props.cycle}><span class="cc-selector-chevron" aria-hidden="true"><LucideIcon name="ChevronDown" size={12} strokeWidth={1.6} /></span></Show>
      </button>
      <Show when={!props.cycle && props.open}>
        <div ref={menu} id={props.id} class="cc-model-menu" role="listbox" aria-label={props.kind === 'model' ? '模型列表' : props.kind === 'reasoning' ? '思考强度选项' : '权限模式选项'} data-popover="control-center"
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); props.onClose(true) }
            else if (event.key === 'Tab') { trigger?.focus(); props.onClose() }
            else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); move(event.key) }
          }}>
          <div class="cc-selector-heading" role="presentation">{props.label}</div>
          <Show when={props.entries.length > 0} fallback={<div class="cc-model-empty">当前 Agent 未提供可选项</div>}>
            <For each={props.entries}>{entry => <button type="button" role="option" class="cc-model-item" aria-selected={entry.id === props.value}
              title={shown(entry)} onClick={() => entry.id === props.value ? props.onClose(true) : props.onChoose(entry.id)}>
              <span>{shown(entry)}</span><span class="cc-selector-check" aria-hidden="true">{entry.id === props.value ? '✓' : ''}</span>
            </button>}</For>
          </Show>
        </div>
      </Show>
    </div>
  </div>
}
