/** @jsxImportSource solid-js */
import { createSignal, For, Show } from 'solid-js'
import { collectElicitationValues, parseElicitationFields, type ElicitationValues } from './elicitationSchema.ts'

// 解析/收集纯函数与相关类型住 elicitationSchema.ts（框架无关模块），消费方直连原模块。

const FIELD_ROW = 'flex items-center gap-2 mb-2'
const LABEL = 'flex-[0_0_110px] text-[12px] text-text-dim break-all'
const INPUT = 'flex-1 min-w-0 px-2 py-1 text-[13px] text-text bg-bg-input border border-border rounded-none focus-visible:outline-2 focus-visible:outline-accent'
const NOTICE = 'text-[12px] text-[var(--warning,#b8860b)] bg-bg-input border border-border rounded-none px-2 py-1.5 mb-2'
const URL_NOTICE = 'text-[12px] text-[var(--danger,#c0392b)] bg-bg-input border border-border rounded-none px-2 py-1.5 mb-2 break-all'

/**
 * ElicitationRequestCard — ACP elicitation/create（form 模式）表单卡（#316）。
 *
 * 官方契约要点：requestedSchema 是受限 JSON Schema（扁平 properties，原语
 * string/number/boolean/enum + default），客户端应预填默认值并允许用户修改后
 * 提交；form 模式不得用于索要密钥（后端/agent 侧责任）。三值应答：
 * accept（带 values）/ decline / cancel —— 经 respond_interaction 后端白名单
 * 原样进 wire content。
 *
 * 超出原语子集的 schema（object/array/无 type 属性）降级：卡片明示不支持，
 * 仅提供 拒绝/取消 —— 不猜测语义、不静默丢字段。
 * url 模式（payload 带 url）本期不支持：仅 拒绝/取消（不打开任何外部地址）。
 */
export default function ElicitationRequestCard(props: {
  request: {
    elicitMessage?: string
    requestedSchema?: Record<string, unknown>
    elicitUrl?: string
  }
  answering: boolean
  onSubmit: (values: ElicitationValues) => void
  onDecline: () => void
  onCancel: () => void
}) {
  // 初值只需首帧：schema 在卡片生命周期内不变（请求对象随交互固化）。
  const parsed = () => props.request.requestedSchema
    ? parseElicitationFields(props.request.requestedSchema)
    : { fields: [], unsupported: false }
  const urlMode = () => typeof props.request.elicitUrl === 'string' && props.request.elicitUrl.length > 0
  // 初值只需首帧：schema 在卡片生命周期内不变（请求对象随交互固化）。
  const [raw, setRaw] = createSignal<Record<string, string | boolean>>((() => {
    const initial: Record<string, string | boolean> = {}
    for (const field of parsed().fields) {
      if (field.type === 'boolean') initial[field.name] = field.defaultValue === true
      else if (field.defaultValue !== undefined) initial[field.name] = String(field.defaultValue)
      else initial[field.name] = ''
    }
    return initial
  })())
  const [missing, setMissing] = createSignal(false)

  const submit = () => {
    if (props.answering) return
    const values = collectElicitationValues(parsed().fields, raw())
    if (values === null) {
      setMissing(true)
      return
    }
    props.onSubmit(values)
  }

  return (
    <div>
      <Show when={urlMode()}>
        <div class={URL_NOTICE} role="alert">
          该请求要求打开外部地址完成授权（{props.request.elicitUrl}）。当前版本不支持外部授权流程，可选择拒绝或取消。
        </div>
      </Show>
      <Show when={!urlMode() && parsed().unsupported}>
        <div class={NOTICE}>该表单包含暂不支持的字段类型（对象/数组等），无法在本表单中填写；可选择拒绝或取消。</div>
      </Show>
      <Show when={!urlMode() && !parsed().unsupported && parsed().fields.length === 0}>
        <div class={NOTICE}>该请求不要求填写任何字段，可直接提交确认。</div>
      </Show>
      <For each={parsed().fields}>{field => (
        <div class={FIELD_ROW}>
          <label class={LABEL} for={`elicit-${field.name}`}>
            {field.name}
            {field.required ? ' *' : ''}
            {field.description ? `（${field.description}）` : ''}
          </label>
          {field.type === 'boolean' ? (
            <input
              id={`elicit-${field.name}`}
              type="checkbox"
              class="accent-[var(--accent)]
              checked:bg-accent"
              checked={raw()[field.name] === true}
              disabled={props.answering}
              onChange={event => setRaw(state => ({ ...state, [field.name]: event.currentTarget.checked }))}
            />
          ) : field.type === 'enum' ? (
            <select
              id={`elicit-${field.name}`}
              class={INPUT}
              value={String(raw()[field.name] ?? '')}
              disabled={props.answering}
              onChange={event => setRaw(state => ({ ...state, [field.name]: event.currentTarget.value }))}
            >
              <For each={field.enumValues ?? []}>{value => (
                <option value={value}>{value}</option>
              )}</For>
            </select>
          ) : (
            <input
              id={`elicit-${field.name}`}
              type={field.type === 'number' ? 'text' : 'text'}
              inputMode={field.type === 'number' ? 'decimal' : undefined}
              class={INPUT}
              value={String(raw()[field.name] ?? '')}
              disabled={props.answering}
              onInput={event => setRaw(state => ({ ...state, [field.name]: event.currentTarget.value }))}
            />
          )}
        </div>
      )}</For>
      <Show when={missing()}>
        <div class="text-[12px] text-[var(--danger,#c0392b)] mb-2" role="alert">必填字段未填写或数字格式不正确。</div>
      </Show>
      <div class="flex flex-wrap gap-2">
        <Show when={!urlMode() && !parsed().unsupported}>
          <button
            autofocus
            type="button"
            class="flex-[1_1_auto] min-w-[96px] px-3 py-1.5 text-[13px] font-[family-name:var(--font)] text-text bg-bg-active border border-border rounded-none cursor-pointer enabled:hover:bg-bg-hover enabled:hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-[var(--state-disabled-opacity)] disabled:cursor-not-allowed"
            disabled={props.answering}
            onClick={submit}
          >提交</button>
        </Show>
        <button
          type="button"
          class="flex-[1_1_auto] min-w-[96px] px-3 py-1.5 text-[13px] font-[family-name:var(--font)] text-text bg-bg-active border border-border rounded-none cursor-pointer enabled:hover:bg-bg-hover enabled:hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-[var(--state-disabled-opacity)] disabled:cursor-not-allowed"
          disabled={props.answering}
          onClick={() => props.onDecline()}
        >拒绝</button>
        <button
          type="button"
          class="flex-[0_0_auto] min-w-[60px] px-3 py-1.5 text-[13px] font-[family-name:var(--font)] text-text-dim bg-transparent border border-border rounded-none cursor-pointer hover:text-text hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => props.onCancel()}
        >取消</button>
      </div>
    </div>
  )
}
