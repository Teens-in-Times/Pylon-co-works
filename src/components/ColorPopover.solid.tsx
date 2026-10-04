/** @jsxImportSource solid-js */
import { createEffect, createSignal, For, on, Show } from 'solid-js'

const COLOR_CHIPS = ['#a855f7', '#3b82f6', '#34d399', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#ffffff', '#000000']
const RECENT_LIMIT = 6
let recentColors: string[] = []

export interface ColorChoice {
  readonly value: string
  readonly label?: string
  readonly disabled?: boolean
}

interface Props {
  value: string
  onChange: (value: string) => void
  /** false = 直接原生取色器，不弹预设板（紧凑场景用） */
  chips?: boolean
  /** 字段级候选色；插件设置选项贡献不修改全局色板。 */
  palette?: readonly ColorChoice[]
  /** 可继承的宿主语义色。仅由确认支持 CSS token 的 owner 传入。 */
  semanticTokens?: readonly ColorChoice[]
  /** 允许编辑 alpha。CSS token 的 alpha 由 token owner 控制。 */
  allowAlpha?: boolean
  /** 字段语义标签（渲染器设置按字段命名触发按钮，供 label 关联与读屏）。 */
  ariaLabel?: string
  /** palette presentation is selection-only; picker/palette+picker may edit. */
  allowCustom?: boolean
}

function pickerColor(value: string): string {
  const normalized = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized
  const short = normalized.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const alphaHex = normalized.match(/^#([0-9a-f]{6})[0-9a-f]{2}$/i)
  if (alphaHex) return `#${alphaHex[1]}`
  return '#000000'
}

function alphaOf(value: string): number | undefined {
  const normalized = value.trim()
  const alphaHex = normalized.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i)
  if (alphaHex) return Math.round((Number.parseInt(alphaHex[1], 16) / 255) * 100)
  const rgba = normalized.match(/^rgba?\(\s*\d+[ ,]+\d+[ ,]+\d+(?:\s*[,/]\s*(0|1|0?\.\d+|\d+%))?\s*\)$/i)
  if (!rgba?.[1]) return normalized === 'transparent' ? 0 : /^#[0-9a-f]{3,6}$/i.test(normalized) ? 100 : undefined
  return rgba[1].endsWith('%') ? Number.parseFloat(rgba[1]) : Number.parseFloat(rgba[1]) * 100
}

function withAlpha(value: string, alphaPercent: number): string | undefined {
  const alpha = Math.max(0, Math.min(100, alphaPercent))
  const raw = value.trim()
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})[ ,]+(\d{1,3})[ ,]+(\d{1,3})(?:\s*[,/]\s*(?:0|1|0?\.\d+|\d+%))?\s*\)$/i)
  const base = pickerColor(raw)
  if (!rgb && base === '#000000' && !/^#(?:000|000000|000000[0-9a-f]{2})$/i.test(raw) && raw !== 'transparent') return undefined
  const red = rgb ? Number(rgb[1]) : Number.parseInt(base.slice(1, 3), 16)
  const green = rgb ? Number(rgb[2]) : Number.parseInt(base.slice(3, 5), 16)
  const blue = rgb ? Number(rgb[3]) : Number.parseInt(base.slice(5, 7), 16)
  return `rgb(${red} ${green} ${blue} / ${Number((alpha / 100).toFixed(2))})`
}

function colorKind(value: string): string {
  if (value.trim() === 'transparent') return '透明'
  if (/^var\(--[A-Za-z0-9_-]+\)$/.test(value.trim())) return '语义令牌'
  if (/^#/.test(value.trim())) return '十六进制'
  if (/^(?:rgb|hsl|oklch|color)\(/i.test(value.trim())) return 'CSS 颜色'
  return '原始 CSS'
}

/**
 * ColorPopover 的 Solid 实体（#515 收拢：原 settings/ColorPopover.solid.tsx 本地副本
 * 收拢至此）。DOM 结构、class、role/aria 与键盘行为
 * （Enter 提交 / Escape 还原并收起）逐项保持；recent 色板沿用模块级共享态。
 */
export default function ColorPopover(props: Props) {
  const [open, setOpen] = createSignal(false)
  const [draft, setDraft] = createSignal(props.value)
  const [recent, setRecent] = createSignal<readonly string[]>(recentColors)
  let pickerRef: HTMLInputElement | null = null
  const choices = () => props.palette ?? COLOR_CHIPS.map(color => ({ value: color, label: color }))
  const alpha = () => alphaOf(props.value)

  createEffect(on(() => props.value, value => setDraft(value)))

  const commit = (next: string) => {
    const normalized = next.trim()
    if (!normalized) {
      setDraft(props.value)
      return
    }
    props.onChange(normalized)
    setDraft(normalized)
    recentColors = [normalized, ...recentColors.filter(item => item !== normalized)].slice(0, RECENT_LIMIT)
    setRecent(recentColors)
  }
  const commitDraft = () => commit(draft())
  const handleDraftKey = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitDraft()
    }
    if (event.key === 'Escape') {
      setDraft(props.value)
      setOpen(false)
    }
  }
  const choose = (next: string) => {
    commit(next)
    setOpen(false)
  }

  const directPicker = () => <div class="set-color-direct">
    <button type="button" class="set-swatch" aria-label={props.ariaLabel ?? '选择颜色'} style={{ background: props.value || 'transparent' }} onClick={() => pickerRef?.click()} />
    <code title={props.value}>{props.value}</code>
    <input ref={el => { pickerRef = el }} type="color" value={pickerColor(props.value)} onInput={event => commit(event.currentTarget.value)} class="set-swatch-input" />
  </div>

  return (
    <Show when={props.chips !== false} fallback={directPicker()}>
      <div class="set-color-wrap">
        <button type="button" class="set-color-trigger" aria-label={props.ariaLabel ?? '打开颜色选择器'} aria-expanded={open()} onClick={() => setOpen(!open())}>
          <span class="set-swatch" style={{ background: props.value || 'transparent' }} />
          <span class="set-color-trigger-copy"><code>{props.value}</code><small>{colorKind(props.value)}</small></span>
        </button>
        <Show when={open()}>
          <div class="set-color-popover" role="dialog" aria-label={`${props.ariaLabel ?? '颜色'}设置`}>
            <div class="set-color-current">
              <span class="set-color-current-sample" style={{ background: props.value || 'transparent' }} />
              <div><small>当前值</small><strong>{colorKind(props.value)}</strong></div>
            </div>
            <Show when={props.allowCustom !== false}>
              <label class="set-color-value-input">
                <span>CSS / HEX / RGBA</span>
                <input value={draft()} spellcheck={false} onInput={event => { setDraft(event.currentTarget.value) }} onBlur={commitDraft} onKeyDown={handleDraftKey} />
              </label>
            </Show>
            <Show when={props.semanticTokens && props.semanticTokens.length > 0}>
              <ColorChoiceRow label="跟随语义色" choices={props.semanticTokens!} value={props.value} onChoose={choose} />
            </Show>
            <ColorChoiceRow label="调色板" choices={choices()} value={props.value} onChoose={choose} />
            <Show when={props.allowCustom !== false && recent().length > 0}>
              <ColorChoiceRow label="最近使用" choices={recent().map(item => ({ value: item }))} value={props.value} onChoose={choose} />
            </Show>
            <Show when={props.allowAlpha === true}>
              <label class="set-color-alpha">
                <span>透明度</span>
                <Show when={alpha() === undefined} fallback={
                  <>
                    <input type="range" min="0" max="100" step="1" value={alpha()} onInput={event => {
                      const next = withAlpha(props.value, Number(event.currentTarget.value))
                      if (next) commit(next)
                    }} /><output>{Math.round(alpha() ?? 0)}%</output>
                  </>
                }>
                  <small>语义 token 的透明度由其 owner 控制</small>
                </Show>
              </label>
            </Show>
            <Show when={props.allowCustom !== false}>
              <button type="button" class="set-color-custom" onClick={() => pickerRef?.click()}>打开系统色盘</button>
            </Show>
          </div>
          <button type="button" class="set-color-backdrop" aria-label="关闭颜色选择器" onClick={() => setOpen(false)} />
        </Show>
        <input ref={el => { pickerRef = el }} type="color" value={pickerColor(props.value)} onInput={event => { commit(event.currentTarget.value); setOpen(false) }} class="set-swatch-input" />
      </div>
    </Show>
  )
}

function ColorChoiceRow(props: {
  readonly label: string
  readonly choices: readonly ColorChoice[]
  readonly value: string
  onChoose(value: string): void
}) {
  return <div class="set-color-choice-group">
    <span>{props.label}</span>
    <div class="set-color-row">
      <For each={props.choices}>{choice => <button type="button"
        class={`set-color-chip ${props.value === choice.value ? 'active' : ''}`}
        aria-label={`选择颜色 ${choice.label ?? choice.value}`}
        title={choice.label ?? choice.value}
        disabled={choice.disabled}
        style={{ background: choice.value }}
        onClick={() => props.onChoose(choice.value)} />}</For>
    </div>
  </div>
}
