/** @jsxImportSource solid-js */
import { createMemo, For } from 'solid-js'
import { describeInvocation } from '../../domains/agent/invocationDraft.ts'

interface InvocationPreviewProps {
  executable: string
  args: string[]
  effectiveArgs?: string[]
}

/**
 * 草稿启动命令预览（实际启动串 + 校验 issue 行；编辑/候选/新建三处共用）。
 * #515 W1：Solid 实体。DOM/role 契约：div.agent-invocation-preview > .set-hint
 * 「实际启动：<code>」行，issue 行按严重度 role=alert|note。
 */
export default function InvocationPreview(props: InvocationPreviewProps) {
  const invocation = createMemo(() => describeInvocation(
    { executable: props.executable, args: props.args },
    props.effectiveArgs ?? props.args,
  ))
  return (
    <div class="agent-invocation-preview">
      <div class="set-hint">实际启动：<code>{invocation().display}</code></div>
      <For each={invocation().validation.issues}>{issue => (
        <div class="set-hint" role={issue.severity === 'error' ? 'alert' : 'note'}>
          {issue.severity === 'error' ? '错误' : '提示'}：{issue.message}
        </div>
      )}</For>
    </div>
  )
}
