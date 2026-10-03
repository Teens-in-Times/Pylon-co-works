/** @jsxImportSource solid-js */
import { createEffect, createSignal, createUniqueId, Match, Switch } from 'solid-js'
import type { NormalizedConfigOption } from './configOptionState'
import { parseConfigNumberInput } from './configOptionState'
import Select from '../ui/Select.solid.tsx'

interface ConfigOptionFieldProps {
  option: NormalizedConfigOption
  disabled?: boolean
  onChange: (value: unknown) => void
}

function safeIdPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '-')
  return sanitized || 'unknown'
}

export function configOptionControlId(optionId: string, reactId: string): string {
  return `config-option-${safeIdPart(optionId)}-${safeIdPart(reactId)}`
}

/** #515：ConfigOptionField 的 Solid 实体（原 ConfigOptionField.tsx 为 React 薄桥）。 */
export default function ConfigOptionField(props: ConfigOptionFieldProps) {
  const controlId = configOptionControlId(props.option.id, createUniqueId())
  const [numberInput, setNumberInput] = createSignal(props.option.currentValue === '' ? '' : String(props.option.currentValue))

  createEffect(() => {
    if (props.option.type === 'number') setNumberInput(props.option.currentValue === '' ? '' : String(props.option.currentValue))
  })

  return (
    <Switch>
      <Match when={props.option.type === 'select'}>
        <label for={controlId}>
          {props.option.label}
          <Select id={controlId} className="set-select" value={String(props.option.currentValue)} disabled={props.disabled} onChange={props.onChange} options={props.option.options.map(choice => ({ value: choice.id, label: choice.label }))} />
        </label>
      </Match>
      <Match when={props.option.type === 'boolean'}>
        <label for={controlId}>
          {props.option.label}
          <input id={controlId} type="checkbox" checked={Boolean(props.option.currentValue)} disabled={props.disabled} onChange={event => props.onChange(event.currentTarget.checked)} />
        </label>
      </Match>
      <Match when={props.option.type === 'number'}>
        <label for={controlId}>
          {props.option.label}
          <input id={controlId} class="set-num" type="number" value={numberInput()} onInput={event => {
            const rawValue = event.currentTarget.value
            setNumberInput(rawValue)
            const parsedValue = parseConfigNumberInput(rawValue)
            if (parsedValue !== undefined) props.onChange(parsedValue)
          }} />
        </label>
      </Match>
      <Match when={props.option.type === 'string'}>
        <label for={controlId}>
          {props.option.label}
          <input id={controlId} class="set-input" type="text" value={String(props.option.currentValue)} onInput={event => props.onChange(event.currentTarget.value)} />
        </label>
      </Match>
      <Match when={true}>
        <label for={controlId}>
          {props.option.label}
          <code id={controlId} class="config-option-raw">{JSON.stringify(props.option.currentValue)}</code>
        </label>
      </Match>
    </Switch>
  )
}
