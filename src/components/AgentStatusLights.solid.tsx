/** @jsxImportSource solid-js */
import { For } from 'solid-js'
import { agentLightDisplay } from '../domains/agent/statusLight'
import { statusLabel, type AgentConnectionStatus } from '../contracts/agentTypes.ts'

/** Status semantics are shared; interface modes choose a compact indicator or the three-light motif. */
export default function AgentStatusLights(props: { status: string; size?: number }) {
  const display = () => agentLightDisplay(props.status)
  const size = () => props.size ?? 10
  const label = () => statusLabel(props.status as AgentConnectionStatus) || '状态未知'
  return (
    <div class="agent-status-lights" data-mode={display().mode} aria-label={`Agent 状态：${label()}`} title={label()} style={{ gap: `${Math.max(2, size() / 3)}px` }}>
      <For each={display().lights}>{(light, index) => (
        <span
          class={`agent-status-light agent-light-${light}`}
          style={{ width: `${size()}px`, height: `${size()}px`, '--light-i': String(index()) }}
        />
      )}</For>
      <span class="agent-status-label" aria-hidden="true">{label()}</span>
    </div>
  )
}
