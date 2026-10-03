/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'

import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { normalizeConfigOptions } from './configOptionState'
import ConfigOptionField from './ConfigOptionField.solid.tsx'
import { appClients } from '../../app/appClients.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import type { AgentContext } from '../../domains/agent/agentContext'
import { toAgentContextKey } from '../../domains/agent/agentContext'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'

interface ConfigOptionsPanelProps {
  context?: AgentContext
}

/** #515：ConfigOptionsPanel 的 Solid 实体（按 AgentContext 切片渲染/编辑会话配置 options）。 */
export default function ConfigOptionsPanel(props: ConfigOptionsPanelProps) {
  // 会话配置切片 + props.context 双响应轴：切片引用变化或 context 变化任一发生都重派生。
  const sessionConfig = createZustandSignal(useRuntimeStore, s => s.sessionConfig)
  const config = createMemo(() => {
    const context = props.context
    return context ? sessionConfig()[toAgentContextKey(context)] : undefined
  })
  const setSessionConfig = useRuntimeStore.getState().setSessionConfig
  const [pending, setPending] = createSignal<Record<string, boolean>>({})
  const [errors, setErrors] = createSignal<Record<string, string>>({})
  // 每 option 的请求序列号：仅最新请求可回滚/报错/清 pending——
  // 旧请求失败时其值已被更新的在途请求取代，回滚会把成功提交的新值覆盖回旧值。
  // （组件体只跑一次，普通可变对象即可充当 ref。）
  const latestReq: Record<string, number> = {}
  const options = createMemo(() => normalizeConfigOptions(config()?.raw))

  const update = async (id: string, value: unknown) => {
    const context = props.context
    if (!context) return
    const seq = (latestReq[id] ?? 0) + 1
    latestReq[id] = seq
    const previous = options().find(option => option.id === id)?.currentValue
    // 乐观更新与回滚都基于最新 store 的 raw 打补丁，而非渲染快照：
    // 快速连续更新时旧快照重建会把先成功字段的乐观值覆盖回旧值。
    const patch = (currentValue: unknown) => {
      const raw = useRuntimeStore.getState().sessionConfig[toAgentContextKey(context)]?.raw ?? []
      setSessionConfig(context, { raw: raw.map(option => option.id === id ? { ...option, currentValue } : option) })
    }
    setPending(state => ({ ...state, [id]: true }))
    setErrors(state => {
      const next = { ...state }
      delete next[id]
      return next
    })
    patch(value)
    try {
      await appClients.chat.setConfigOption({ agentId: context.agentId, source: context.source, key: id, value })
      resolveRuntimeErrors({ key: `session-config:${toAgentContextKey(context)}:${id}` })
    } catch (error) {
      if (latestReq[id] !== seq) return
      patch(previous)
      reportRuntimeError(`更新配置 ${id}`, error, context.agentId, {
        key: `session-config:${toAgentContextKey(context)}:${id}`,
        scope: { kind: 'operation', id: `session-config:${toAgentContextKey(context)}:${id}` },
        source: 'chat.config-option',
      })
      setErrors(state => ({ ...state, [id]: '保存失败，详情见右下角错误中心' }))
    } finally {
      if (latestReq[id] === seq) setPending(state => ({ ...state, [id]: false }))
    }
  }

  return (
    <Show
      when={props.context && options().length > 0}
      fallback={<div class="set-hint">当前会话暂无动态配置选项。</div>}
    >
      <div class="config-options-panel">
        <For each={options()}>{option => (
          <div class="set-row">
            <span class="set-row-label">{option.label}</span>
            <ConfigOptionField option={option} disabled={pending()[option.id] === true} onChange={value => update(option.id, value)} />
            <Show when={pending()[option.id]}><span class="set-hint" role="status">保存中…</span></Show>
            <Show when={errors()[option.id]}><span class="set-hint" role="status">{errors()[option.id]}（详情见右下角错误中心）</span></Show>
          </div>
        )}</For>
      </div>
    </Show>
  )
}
