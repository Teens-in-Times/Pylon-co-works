/** @jsxImportSource solid-js */
import { Index } from 'solid-js'
import {
  appendArgument,
  moveArgument,
  removeArgument,
  updateArgument,
} from '../../domains/agent/invocationDraft.ts'

interface ArgumentListEditorProps {
  args: readonly string[]
  label: string
  onChange: (args: string[]) => void
  disabled?: boolean
}

/**
 * ArgumentListEditor — 启动参数列表编辑器（实参增删改/上下移）。
 * #515 W1：Solid 实体。DOM/aria 契约：div.agent-argument-list[role=group]
 * [aria-label="{label} 启动参数"] > .set-preset-row 行（input.set-input
 * [aria-label="{label} 参数 N"] + 上移/下移/删除钮）+「添加参数」。
 * 行用 `<Index>` 按位复用（行号即键）：逐键编辑不重挂行、输入框不丢焦点。
 */
export default function ArgumentListEditor(props: ArgumentListEditorProps) {
  const disabled = () => props.disabled ?? false
  return (
    <div class="agent-argument-list" role="group" aria-label={`${props.label} 启动参数`}>
      <Index each={props.args}>{(argument, index) => (
        <div class="set-preset-row">
          <input
            class="set-input"
            value={argument()}
            onInput={event => props.onChange(updateArgument(props.args, index, event.currentTarget.value))}
            placeholder="单个启动参数（可为空字符串）"
            aria-label={`${props.label} 参数 ${index + 1}`}
            disabled={disabled()}
          />
          <button class="ps-btn sm" type="button" disabled={disabled() || index === 0} onClick={() => props.onChange(moveArgument(props.args, index, index - 1))} aria-label={`${props.label} 参数 ${index + 1} 上移`}>↑</button>
          <button class="ps-btn sm" type="button" disabled={disabled() || index === props.args.length - 1} onClick={() => props.onChange(moveArgument(props.args, index, index + 1))} aria-label={`${props.label} 参数 ${index + 1} 下移`}>↓</button>
          <button class="ps-btn sm" type="button" disabled={disabled()} onClick={() => props.onChange(removeArgument(props.args, index))} aria-label={`删除 ${props.label} 参数 ${index + 1}`}>删除</button>
        </div>
      )}</Index>
      <button class="ps-btn sm" type="button" disabled={disabled()} onClick={() => props.onChange(appendArgument(props.args))}>添加参数</button>
    </div>
  )
}
