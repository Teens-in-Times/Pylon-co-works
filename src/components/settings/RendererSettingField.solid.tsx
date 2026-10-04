/** @jsxImportSource solid-js */
import type { JSX } from 'solid-js'
import { For, Match, Show, Switch } from 'solid-js'
import { isSettingVisible, type RenderChoiceSettingField, type RenderColorSettingField, type RenderMultiChoiceSettingField, type RenderNumberSettingField, type RenderSettingField, type RendererSettingOption, type RendererPresentation, type RendererSettingValue, type RendererSettingsSchema, type RenderBooleanSettingField, type RenderTextSettingField, type SettingsValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { resolvePresentation, settingFieldKey } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import ColorPopover from '../ColorPopover.solid.tsx'
import Select from '../ui/Select.solid.tsx'

const RENDERER_SEMANTIC_COLORS = Object.freeze([
  { value: 'var(--text)', label: '主文字' },
  { value: 'var(--text-dim)', label: '次要文字' },
  { value: 'var(--surface-raised)', label: '抬升表面' },
  { value: 'var(--border)', label: '普通边界' },
  { value: 'var(--accent)', label: '强调色' },
  { value: 'transparent', label: '透明' },
])

export interface RendererSettingFieldProps {
  readonly field: RenderSettingField
  readonly value: RendererSettingValue | undefined
  readonly options?: readonly RendererSettingOption[]
  onChange(value: RendererSettingValue): void
  /** High-frequency controls may update an ephemeral preview while dragging. */
  onPreviewChange?(value: RendererSettingValue): void
  onPreviewCommit?(): void
  onReset?(): void
}

/** Framework-neutral schema host used by Plugin Page/Context Panel contributions.
 * The host owns field layout/conditions while the contribution owns only the
 * adapter-backed values. This keeps schema pages on the same control contract
 * as Renderer settings without teaching plugin components about global stores.
 *
 * #515：Solid 实体（schema 页与 Renderer 设置共用同一控件契约）。
 */
export function RendererSettingsSchemaHost(props: {
  readonly schema: RendererSettingsSchema
  readonly values: Readonly<Record<string, SettingsValue>>
  readonly unavailable?: Readonly<Record<string, { readonly value?: SettingsValue; readonly code: string; readonly message: string }>>
  readonly options?: Readonly<Record<string, readonly RendererSettingOption[]>>
  readonly density?: 'basic' | 'standard' | 'all'
  readonly anchorPrefix?: string
  onChange(fieldKey: string, value: SettingsValue): void
  onReset?(fieldKey: string): void
  onRestoreUnavailable?(fieldKey: string): void
}) {
  const density = () => props.density ?? 'all'
  return <div class="settings-schema-host">
    <For each={props.schema.groups}>{group => <section class="renderer-settings-group" data-group-anchor={group.id}>
      <h4 class="renderer-settings-group-heading"><span class="renderer-settings-group-copy"><strong>{group.label}</strong><Show when={group.description}><small>{group.description}</small></Show></span></h4>
      <div class="renderer-settings-fields">
        <For each={group.fields.filter(field => isSettingVisible(field, density()) && evaluateRenderSettingCondition(field.showIf, props.values))}>{field => {
          const key = settingFieldKey(field)
          return <div data-search-anchor={`${props.anchorPrefix ?? 'schema'}:${key}`}><RendererSettingField field={field} value={props.values[key]} options={props.options?.[key] ?? ('options' in field ? field.options : undefined)}
            onChange={value => props.onChange(key, value)} onReset={props.onReset ? () => props.onReset?.(key) : undefined} /></div>
        }}</For>
      </div>
    </section>}</For>
    <For each={Object.entries(props.unavailable ?? {})}>{([key, item]) => <div class="renderer-setting-unavailable">
      <span>{key}：{item.message}（{item.code}）</span>
      <Show when={props.onRestoreUnavailable}><button type="button" onClick={() => props.onRestoreUnavailable?.(key)}>恢复</button></Show>
    </div>}</For>
  </div>
}

export function evaluateRenderSettingCondition(condition: RenderSettingField['showIf'], values: Readonly<Record<string, RendererSettingValue>>): boolean {
  if (!condition) return true
  if ('equals' in condition) return Object.is(values[condition.equals.field], condition.equals.value)
  if ('oneOf' in condition) return condition.oneOf.values.some(value => Object.is(values[condition.oneOf.field], value))
  if ('not' in condition) return !evaluateRenderSettingCondition(condition.not, values)
  if ('all' in condition) return condition.all.every(item => evaluateRenderSettingCondition(item, values))
  return condition.any.some(item => evaluateRenderSettingCondition(item, values))
}

function labelOf(field: RenderSettingField): string {
  return field.label || settingFieldKey(field)
}

/** S2：segmented 按钮组（横排 chip，active 用 accent 底）。
 * 手写最小实现（指南 §3，不新增依赖）契约：容器 role=radiogroup、条目 role=radio +
 * aria-checked + data-state 样式钩子、方向键在可用条目间移动焦点并选中（roving 语义）。 */
function SegmentedControl(props: {
  options: readonly RendererSettingOption[]
  value: string
  onChange(value: string): void
  ariaLabel?: string
}) {
  let root: HTMLDivElement | undefined
  const select = (option: RendererSettingOption) => {
    if (!option.disabled && option.value !== props.value) props.onChange(option.value)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const directions: Record<string, -1 | 1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    const direction = directions[event.key]
    if (!direction) return
    event.preventDefault()
    const pool = props.options.filter(option => !option.disabled)
    if (pool.length === 0) return
    const current = pool.findIndex(option => option.value === props.value)
    const next = pool[(current + direction + pool.length) % pool.length]!
    select(next)
    root?.querySelector<HTMLButtonElement>(`[data-segmented-value="${CSS.escape(next.value)}"]`)?.focus()
  }
  return (
    // K-3：底座升级自 radix ToggleGroup——键盘导航/roving focus 由本实现承担，外观类名沿用
    <div ref={element => { root = element }} role="radiogroup" class="renderer-segmented" aria-label={props.ariaLabel} onKeyDown={onKeyDown}>
      <For each={props.options}>{option => {
        const active = () => option.value === props.value
        return <button
          type="button"
          role="radio"
          aria-checked={active()}
          disabled={option.disabled}
          data-state={active() ? 'on' : 'off'}
          data-segmented-value={option.value}
          class={`renderer-segmented-chip${active() ? ' active' : ''}`}
          onClick={() => select(option)}
        >
          {option.label ?? option.value}
        </button>
      }}</For>
    </div>
  )
}

/** S2：toggle 开关（role=switch）。
 * K-3 radix Switch 的手写最小 Solid 等价：role/aria-checked/键盘（原生 button 的
 * Space/Enter 触发 click）与 data-state 驱动样式逐项保持。 */
function ToggleSwitch(props: { checked: boolean; onChange(checked: boolean): void; ariaLabel: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      class={`set-toggle${props.checked ? ' on' : ''}`}
      data-state={props.checked ? 'on' : 'off'}
      onClick={() => props.onChange(!props.checked)}
    />
  )
}

const SLIDER_COMMIT_KEYS = ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']

/** 滑杆（horizontal）手写最小实现契约：
 * thumb role=slider + aria-valuemin/max/now + tabindex、方向键步进（keyup commit、
 * Home/End/PageUp/PageDown）、track 点按/拖动取值；DOM class renderer-slider*。 */
function Slider(props: {
  id?: string
  ariaLabel?: string
  min: number
  max: number
  step?: number
  value: number
  onValueChange(value: number): void
  onValueCommit(value: number): void
}) {
  let track: HTMLSpanElement | undefined
  const clamp = (value: number) => Math.min(Math.max(value, props.min), props.max)
  const percent = () => {
    const span = props.max - props.min
    if (!(span > 0)) return 0
    return Math.min(100, Math.max(0, ((props.value - props.min) / span) * 100))
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const step = props.step ?? 1
    const large = Math.max(step, step * 10)
    const moves: Record<string, number> = {
      ArrowRight: step,
      ArrowUp: step,
      ArrowLeft: -step,
      ArrowDown: -step,
      PageUp: large,
      PageDown: -large,
    }
    if (event.key in moves) {
      event.preventDefault()
      props.onValueChange(clamp(props.value + moves[event.key]!))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      props.onValueChange(props.min)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      props.onValueChange(props.max)
    }
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (SLIDER_COMMIT_KEYS.includes(event.key)) props.onValueCommit(props.value)
  }
  const valueFromPointer = (clientX: number): number => {
    if (!track) return props.value
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return props.value
    return clamp(props.min + ((clientX - rect.left) / rect.width) * (props.max - props.min))
  }
  const onPointerDown = (event: PointerEvent) => {
    if (!track) return
    event.preventDefault()
    track.setPointerCapture(event.pointerId)
    props.onValueChange(valueFromPointer(event.clientX))
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!track || !track.hasPointerCapture(event.pointerId)) return
    props.onValueChange(valueFromPointer(event.clientX))
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!track || !track.hasPointerCapture(event.pointerId)) return
    track.releasePointerCapture(event.pointerId)
    props.onValueCommit(props.value)
  }
  return (
    <span id={props.id} class="renderer-slider" aria-label={props.ariaLabel} data-orientation="horizontal">
      <span ref={element => { track = element }} class="renderer-slider-track" data-orientation="horizontal"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <span class="renderer-slider-range" style={{ left: '0px', right: `calc(100% - ${percent()}%)` }} />
      </span>
      <span class="renderer-slider-thumb" role="slider" tabindex={0} aria-label={`${props.ariaLabel}滑块`}
        aria-valuemin={props.min} aria-valuemax={props.max} aria-valuenow={props.value}
        data-orientation="horizontal" style={{ left: `${percent()}%` }}
        onKeyDown={onKeyDown} onKeyUp={onKeyUp} />
    </span>
  )
}

type ChoiceFieldProps = RendererSettingFieldProps & { field: RenderChoiceSettingField }
type MultiChoiceFieldProps = RendererSettingFieldProps & { field: RenderMultiChoiceSettingField }
type ColorFieldProps = RendererSettingFieldProps & { field: RenderColorSettingField }
type NumberFieldProps = RendererSettingFieldProps & { field: RenderNumberSettingField }
type BooleanFieldProps = RendererSettingFieldProps & { field: RenderBooleanSettingField }
type TextFieldProps = RendererSettingFieldProps & { field: RenderTextSettingField }

function ChoiceSettingField(props: ChoiceFieldProps) {
  const label = () => labelOf(props.field)
  const fieldId = () => `renderer-setting-${settingFieldKey(props.field)}`
  const presentation = (): RendererPresentation => resolvePresentation(props.field)
  const options = () => props.options ?? props.field.options
  const reset = (): JSX.Element => (
    <Show when={props.onReset && props.field.default !== undefined}>
      <button type="button" class="set-field-reset" aria-label={`${label()}恢复默认`} onClick={() => props.onReset?.()}>↺</button>
    </Show>
  )
  const description = (): JSX.Element => (
    <Show when={props.field.description}><small>{props.field.description}</small></Show>
  )
  const textValue = (): string => (typeof props.value === 'string' ? props.value : '')
  return (
    <Switch>
      <Match when={presentation() === 'radio'}>
        <fieldset class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)} aria-label={label()}>
          <legend>{label()}</legend>
          <For each={options()}>{option => <label>
            <input type="radio" name={fieldId()} value={option.value} checked={props.value === option.value}
              disabled={option.disabled} onChange={() => props.onChange(option.value)} />
            {option.label ?? option.value}
          </label>}</For>{reset()}
          {description()}
        </fieldset>
      </Match>
      <Match when={presentation() === 'segmented'}>
        <div class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
          <span class="renderer-setting-label">{label()}</span>
          <SegmentedControl options={options()} value={textValue()} onChange={props.onChange} ariaLabel={label()} />{reset()}
          {description()}
        </div>
      </Match>
      <Match when={true}>
        <div class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
          <label id={`${fieldId()}-label`}>{label()}</label>
          {/* K-3 优化：原生 select → ui/Select 弹层组件（键盘导航/portal 定位内建；
              #515 起直连 Select Solid 实体） */}
          <Select
            value={textValue()}
            options={options().map(o => ({ value: o.value, label: o.label ?? o.value, description: o.description, disabled: o.disabled }))}
            onChange={props.onChange}
            ariaLabel={label()}
          />{reset()}
          {description()}
        </div>
      </Match>
    </Switch>
  )
}

function MultiChoiceSettingField(props: MultiChoiceFieldProps) {
  const label = () => labelOf(props.field)
  const fieldId = () => `renderer-setting-${settingFieldKey(props.field)}`
  const presentation = (): RendererPresentation => resolvePresentation(props.field)
  const options = () => props.options ?? props.field.options
  const reset = (): JSX.Element => (
    <Show when={props.onReset && props.field.default !== undefined}>
      <button type="button" class="set-field-reset" aria-label={`${label()}恢复默认`} onClick={() => props.onReset?.()}>↺</button>
    </Show>
  )
  const multiSelected = (): string[] =>
    Array.isArray(props.value) ? props.value.filter((item): item is string => typeof item === 'string') : []
  return (
    <Switch>
      <Match when={presentation() === 'listbox'}>
        <div class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
          <label for={fieldId()}>{label()}</label>
          <select id={fieldId()} multiple size={Math.max(1, Math.min(6, options().length))} aria-label={label()}
            onChange={event => props.onChange(Array.from(event.currentTarget.selectedOptions).map(option => option.value))}>
            {/* Solid 无 React 式多选 value 绑定——逐 option 写 selected，DOM 语义一致 */}
            <For each={options()}>{option => <option value={option.value} disabled={option.disabled} selected={multiSelected().includes(option.value)}>{option.label ?? option.value}</option>}</For>
          </select>{reset()}
        </div>
      </Match>
      <Match when={true}>
        <fieldset class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)} aria-label={label()}>
          <legend>{label()}</legend>
          <For each={options()}>{option => <label>
            <input type="checkbox" checked={multiSelected().includes(option.value)} disabled={option.disabled}
              onChange={event => props.onChange(event.currentTarget.checked ? [...multiSelected(), option.value] : multiSelected().filter(item => item !== option.value))} />
            {option.label ?? option.value}
          </label>}</For>{reset()}
        </fieldset>
      </Match>
    </Switch>
  )
}

function ColorSettingField(props: ColorFieldProps) {
  const label = () => labelOf(props.field)
  const presentation = (): RendererPresentation => resolvePresentation(props.field)
  // color 字段的 palette 候选只来自调用方注入的 options（schema 契约）
  const options = () => props.options ?? []
  const reset = (): JSX.Element => (
    <Show when={props.onReset && props.field.default !== undefined}>
      <button type="button" class="set-field-reset" aria-label={`${label()}恢复默认`} onClick={() => props.onReset?.()}>↺</button>
    </Show>
  )
  const description = (): JSX.Element => (
    <Show when={props.field.description}><small>{props.field.description}</small></Show>
  )
  return (
    <div class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
      <span class="renderer-setting-label">{label()}</span>
      {/* palette→色板为主；picker→直接原生取色；palette+picker→默认（chips+自定义入口） */}
      <ColorPopover value={typeof props.value === 'string' ? props.value : typeof props.field.default === 'string' ? props.field.default : 'transparent'}
        chips={presentation() !== 'picker'} ariaLabel={label()}
        allowCustom={presentation() !== 'palette'}
        allowAlpha={props.field.alpha}
        semanticTokens={RENDERER_SEMANTIC_COLORS}
        palette={options().length > 0 ? options().map(option => ({ value: option.value, label: option.label, disabled: option.disabled })) : undefined}
        onChange={v => props.onChange(v)} />{reset()}
      {description()}
    </div>
  )
}

function NumberSettingField(props: NumberFieldProps) {
  const label = () => labelOf(props.field)
  const fieldId = () => `renderer-setting-${settingFieldKey(props.field)}`
  const presentation = (): RendererPresentation => resolvePresentation(props.field)
  const reset = (): JSX.Element => (
    <Show when={props.onReset && props.field.default !== undefined}>
      <button type="button" class="set-field-reset" aria-label={`${label()}恢复默认`} onClick={() => props.onReset?.()}>↺</button>
    </Show>
  )
  const numericValue = (): number | undefined =>
    typeof props.value === 'number' ? props.value : typeof props.field.default === 'number' ? props.field.default : undefined
  return (
    <Switch>
      <Match when={presentation() === 'slider+input'}>
        <div class="renderer-setting-field renderer-number-duo" data-setting-key={settingFieldKey(props.field)}>
          <label for={fieldId()}>{label()}</label>
          {/* K-3：range 半边 radix Slider 手写等价（键盘/焦点管理内建）；数值半边保留原生 */}
          <Slider id={fieldId()} ariaLabel={label()}
            min={props.field.min ?? 0} max={props.field.max ?? 100} step={props.field.step}
            value={numericValue() ?? 0}
            onValueChange={next => {
              if (props.onPreviewChange) props.onPreviewChange(next)
              else props.onChange(next)
            }}
            onValueCommit={next => {
              props.onChange(next)
              props.onPreviewCommit?.()
            }} />
          <input type="number" aria-label={`${label()}数值`} min={props.field.min ?? 0} max={props.field.max ?? 100} value={numericValue() ?? 0}
            onInput={event => {
              props.onPreviewCommit?.()
              props.onChange(Number(event.currentTarget.value))
            }} />
          <Show when={props.field.unit}><span>{props.field.unit}</span></Show>{reset()}
        </div>
      </Match>
      <Match when={true}>
        <div class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
          <label for={fieldId()}>{label()}</label>
          <input id={fieldId()} aria-label={label()} type={presentation() === 'slider' ? 'range' : 'number'}
            min={props.field.min} max={props.field.max} step={props.field.step}
            value={numericValue() ?? ''}
            onInput={event => props.onChange(Number(event.currentTarget.value))} />{reset()}
          <Show when={props.field.unit}><span>{props.field.unit}</span></Show>
        </div>
      </Match>
    </Switch>
  )
}

function BooleanSettingField(props: BooleanFieldProps) {
  const label = () => labelOf(props.field)
  const presentation = (): RendererPresentation => resolvePresentation(props.field)
  const reset = (): JSX.Element => (
    <Show when={props.onReset && props.field.default !== undefined}>
      <button type="button" class="set-field-reset" aria-label={`${label()}恢复默认`} onClick={() => props.onReset?.()}>↺</button>
    </Show>
  )
  return (
    <Switch>
      <Match when={presentation() === 'toggle'}>
        <div class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
          <ToggleSwitch checked={props.value === true} onChange={props.onChange} ariaLabel={label()} />
          <span class="renderer-setting-label">{label()}</span>{reset()}
        </div>
      </Match>
      <Match when={true}>
        <label class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
          <input aria-label={label()} type="checkbox" checked={props.value === true} onChange={event => props.onChange(event.currentTarget.checked)} />
          {label()}{reset()}
        </label>
      </Match>
    </Switch>
  )
}

function TextSettingField(props: TextFieldProps) {
  const label = () => labelOf(props.field)
  const fieldId = () => `renderer-setting-${settingFieldKey(props.field)}`
  const presentation = (): RendererPresentation => resolvePresentation(props.field)
  const reset = (): JSX.Element => (
    <Show when={props.onReset && props.field.default !== undefined}>
      <button type="button" class="set-field-reset" aria-label={`${label()}恢复默认`} onClick={() => props.onReset?.()}>↺</button>
    </Show>
  )
  const textValue = (): string => (typeof props.value === 'string' ? props.value : '')
  return (
    <div class="renderer-setting-field" data-setting-key={settingFieldKey(props.field)}>
      <label for={fieldId()}>{label()}</label>
      <Show when={presentation() === 'textarea'}
        fallback={<input id={fieldId()} aria-label={label()} value={textValue()} placeholder={props.field.placeholder} maxLength={props.field.maxLength} onInput={event => props.onChange(event.currentTarget.value)} />}
      ><textarea id={fieldId()} aria-label={label()} value={textValue()} placeholder={props.field.placeholder} maxLength={props.field.maxLength} onInput={event => props.onChange(event.currentTarget.value)} /></Show>
      {reset()}
    </div>
  )
}

export default function RendererSettingField(props: RendererSettingFieldProps) {
  return (
    // Solid 的 Match 不向 children 传导判别收窄（组件体只跑一次），各形态子组件在
    // props 类型上收紧 field（schema 字段引用稳定，语义与原 switch 分发一致）。
    <Switch>
      <Match when={props.field.type === 'choice'}><ChoiceSettingField {...props} field={props.field as RenderChoiceSettingField} /></Match>
      <Match when={props.field.type === 'multi-choice'}><MultiChoiceSettingField {...props} field={props.field as RenderMultiChoiceSettingField} /></Match>
      <Match when={props.field.type === 'color'}><ColorSettingField {...props} field={props.field as RenderColorSettingField} /></Match>
      <Match when={props.field.type === 'number'}><NumberSettingField {...props} field={props.field as RenderNumberSettingField} /></Match>
      <Match when={props.field.type === 'boolean'}><BooleanSettingField {...props} field={props.field as RenderBooleanSettingField} /></Match>
      <Match when={props.field.type === 'text'}><TextSettingField {...props} field={props.field as RenderTextSettingField} /></Match>
    </Switch>
  )
}
