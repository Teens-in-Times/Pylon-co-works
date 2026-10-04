/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { LucideIcon } from '../LucideIcon.solid.tsx'

export interface SelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange(value: string): void
  id?: string
  className?: string
  disabled?: boolean
  ariaLabel?: string
}

function enabledIndex(options: readonly SelectOption[], from: number, direction: -1 | 1): number {
  if (options.length === 0) return -1
  for (let step = 1; step <= options.length; step += 1) {
    const index = (from + step * direction + options.length) % options.length
    if (!options[index]?.disabled) return index
  }
  return -1
}

/**
 * Select 的 Solid 实体（#515 收拢：原 settings/Select.solid.tsx 本地副本收拢至此；
 * radix @radix-ui/react-select 已由手写最小等价替代）。
 *
 * DOM 结构、class、role/aria 词汇（combobox/listbox/option、aria-activedescendant）、
 * 键盘行为（方向键/Home/End/Enter/空格/Escape/Tab/首字跳转）与弹层 portal 到
 * document.body 的形态逐项保持。
 * 无状态值语义的可访问 Select；弹层与滚动容器解耦，业务状态仍由调用方所有。
 */
export default function Select(props: SelectProps) {
  const triggerId = props.id ?? `pylon-select-${createUniqueId()}`
  const listboxId = `${triggerId}-listbox`
  let triggerRef: HTMLButtonElement | null = null
  let menuRef: HTMLDivElement | null = null
  const optionRefs = new Map<number, HTMLDivElement>()
  const [open, setOpen] = createSignal(false)
  const [activeIndex, setActiveIndex] = createSignal(0)
  const [position, setPosition] = createSignal({ left: 0, top: 0, width: 0, maxHeight: 280 })
  const selectedIndex = () => Math.max(0, props.options.findIndex(option => option.value === props.value))
  const selected = () => props.options.find(option => option.value === props.value) ?? props.options[0]

  const placeMenu = () => {
    const rect = triggerRef?.getBoundingClientRect()
    if (!rect) return
    const roomBelow = window.innerHeight - rect.bottom - 12
    const roomAbove = rect.top - 12
    const openAbove = roomBelow < 180 && roomAbove > roomBelow
    const maxHeight = Math.max(96, Math.min(320, openAbove ? roomAbove : roomBelow))
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8)),
      top: openAbove ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
      width: Math.max(rect.width, 180),
      maxHeight,
    })
  }

  const openMenu = () => {
    if (props.disabled || props.options.length === 0) return
    const current = selectedIndex()
    setActiveIndex(props.options[current]?.disabled ? enabledIndex(props.options, current, 1) : current)
    placeMenu()
    setOpen(true)
  }

  const choose = (index: number) => {
    const option = props.options[index]
    if (!option || option.disabled) return
    props.onChange(option.value)
    setOpen(false)
    requestAnimationFrame(() => triggerRef?.focus())
  }

  createEffect(() => {
    if (!open()) return
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef?.contains(target) && !menuRef?.contains(target)) setOpen(false)
    }
    const reposition = () => placeMenu()
    document.addEventListener('mousedown', dismiss)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    onCleanup(() => {
      document.removeEventListener('mousedown', dismiss)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    })
  })

  createEffect(() => {
    if (open()) optionRefs.get(activeIndex())?.scrollIntoView?.({ block: 'nearest' })
  })

  const activeOptionId = createMemo(() => `${listboxId}-option-${Math.max(0, activeIndex())}`)

  return <span class={`pylon-select ${props.className ?? ''}`.trim()}>
    <button
      ref={el => { triggerRef = el }}
      id={triggerId}
      type="button"
      class="pylon-select-trigger"
      role="combobox"
      aria-label={props.ariaLabel}
      aria-expanded={open()}
      aria-controls={listboxId}
      aria-activedescendant={open() && activeIndex() >= 0 ? activeOptionId() : undefined}
      aria-haspopup="listbox"
      disabled={props.disabled}
      onClick={() => open() ? setOpen(false) : openMenu()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open()) openMenu()
          else setActiveIndex(current => enabledIndex(props.options, current, event.key === 'ArrowDown' ? 1 : -1))
        } else if (event.key === 'Home' || event.key === 'End') {
          if (!open()) return
          event.preventDefault()
          const start = event.key === 'Home' ? -1 : 0
          setActiveIndex(enabledIndex(props.options, start, event.key === 'Home' ? 1 : -1))
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (open()) choose(activeIndex())
          else openMenu()
        } else if (event.key === 'Escape' && open()) {
          event.preventDefault()
          setOpen(false)
        } else if (event.key === 'Tab') {
          setOpen(false)
        } else if (event.key.length === 1 && /\S/.test(event.key)) {
          const key = event.key.toLocaleLowerCase()
          const match = props.options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(key))
          if (match >= 0) {
            event.preventDefault()
            if (!open()) openMenu()
            setActiveIndex(match)
          }
        }
      }}
    >
      <span class="pylon-select-value">{selected()?.label ?? '—'}</span>
      <LucideIcon name="ChevronDown" size={14} />
    </button>
    <Show when={open()}>
      <Portal>
        <div
          ref={el => { menuRef = el }}
          id={listboxId}
          class="pylon-select-listbox"
          role="listbox"
          aria-labelledby={props.ariaLabel ? undefined : triggerId}
          aria-label={props.ariaLabel}
          style={{
            left: `${position().left}px`,
            top: `${position().top}px`,
            width: `${position().width}px`,
            'max-height': `${position().maxHeight}px`,
          }}
        >
          <For each={props.options}>{(option, index) => <div
            ref={node => { if (node) optionRefs.set(index(), node); else optionRefs.delete(index()) }}
            id={`${listboxId}-option-${index()}`}
            class={`pylon-select-option${index() === activeIndex() ? ' active' : ''}`}
            role="option"
            aria-selected={option.value === props.value}
            aria-disabled={option.disabled || undefined}
            onMouseDown={event => { event.preventDefault(); choose(index()) }}
            onMouseEnter={() => { if (!option.disabled) setActiveIndex(index()) }}
          >
            <span class="pylon-select-option-copy"><span>{option.label}</span><Show when={option.description}><small>{option.description}</small></Show></span>
            <Show when={option.value === props.value}><LucideIcon name="Check" size={14} /></Show>
          </div>}</For>
        </div>
      </Portal>
    </Show>
  </span>
}
