/** @jsxImportSource solid-js */
import { createSignal, Show } from 'solid-js'

import { appClients } from '../../app/appClients.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { classifyAgentConfigSaveError, validateAgentConfig, type AgentConfigSaveStatus } from './agentConfigStatus.ts'
import type { createAgentClient } from '../../infrastructure/acp/agentClient'
import { errorCode as wireErrorCode } from '../../infrastructure/tauri/errorPayload.ts'
import { useIdentityStore } from '../../domains/identity/identityStore'

interface AgentConfigEditorProps {
  agentId: string
}

/**
 * AgentConfigEditor — Agent 配置编辑入口（W1-07）。
 *
 * #515：Solid 实体（原 AgentConfigEditor.tsx 为 React 薄桥）。
 *
 * scope="agent" 的 YAML 整块替换：调用 update_agents_config 写回生效配置，
 * 成功后刷新前端 agent 列表（写盘与内存提交均由后端事务完成，无需 reload_agents）。
 *
 * #422：后端对 launch 指纹变更的保存强制连接测试凭证（config_verification_required）。
 * 本入口无三道门状态机，保存被拦时自动对该 YAML 补一次真实连接测试并重试——
 * 指纹未变更的保存不触发此分支，零额外探测。
 */
export default function AgentConfigEditor(props: AgentConfigEditorProps) {
  const [config, setConfig] = createSignal('')
  const [status, setStatus] = createSignal<AgentConfigSaveStatus>({ kind: 'idle' })
  const [validationError, setValidationError] = createSignal<string | null>(null)

  const save = async () => {
    const invalid = validateAgentConfig(config())
    if (invalid) {
      // Form validation is a local, actionable fact rather than a runtime
      // failure. Keep its original message and assertive semantics; only
      // transport/configuration failures are summarized in ErrorCenter.
      setValidationError(invalid)
      setStatus({ kind: 'idle' })
      return
    }
    setValidationError(null)
    setStatus({ kind: 'saving' })
    try {
      const client = appClients.agent()
      await saveWithVoucherRetry(client, props.agentId, config())
      // 后端事务已原子提交 agents 域；前端刷新 agent 列表与工具字典，保持设置页一致。
      const list = await client.listAgents()
      useIdentityStore.getState().setAgents(list)
      setStatus({ kind: 'ok' })
      resolveRuntimeErrors({ key: `agent-config:${props.agentId}` })
    } catch (error) {
      const classified = classifyAgentConfigSaveError(error)
      setStatus(classified)
      if (classified.kind === 'error') {
        reportRuntimeError('保存 Agent 配置', error, props.agentId, {
          key: `agent-config:${props.agentId}`,
          scope: { kind: 'agent', id: props.agentId },
          source: 'settings.agent-config',
        })
      }
    }
  }

  return (
    <div class="agent-config-editor">
      <textarea
        class="agent-config-textarea"
        value={config()}
        onInput={event => { setConfig(event.currentTarget.value); setValidationError(null); setStatus({ kind: 'idle' }) }}
        placeholder="粘贴 Agent 配置（YAML）…"
        rows={8}
        aria-label="Agent 配置"
      />
      <div class="agent-config-actions">
        <button type="button" class="agent-config-save" onClick={save} disabled={status().kind === 'saving'}>
          {status().kind === 'saving' ? '保存中…' : '保存配置'}
        </button>
        <Show when={status().kind === 'blocked'}>
          <span class="agent-config-blocked" role="status">保存命令不可用：请检查应用版本是否包含 update_agents_config</span>
        </Show>
        <Show when={validationError()}><span class="agent-config-error" role="alert">{validationError()}</span></Show>
        <Show when={status().kind === 'error'}>
          <span class="agent-config-error" role="status">保存失败，详情见右下角错误中心</span>
        </Show>
        <Show when={status().kind === 'ok'}>
          <span class="agent-config-ok" role="status">配置已保存，Agent 列表已刷新</span>
        </Show>
      </div>
    </div>
  )
}

/** #422：保存 + 凭证补测重试。
 *  首次保存被 config_verification_required 拦（launch 指纹变更）时，对该 YAML
 *  做一次真实连接测试（后端按整块替换语义解析并签发凭证），通过后重试保存；
 *  测试失败则不保存，把连接失败原因抛给调用方展示。 */
async function saveWithVoucherRetry(
  client: ReturnType<typeof createAgentClient>,
  agentId: string,
  config: string,
): Promise<unknown> {
  try {
    return await client.updateAgentsConfig({ scope: 'agent', agentId, config })
  } catch (error) {
    if (wireErrorCode(error) !== 'config_verification_required') throw error
    // agentYaml 模式下后端以 YAML 为测试对象；agent 字段仅满足命令参数形状（旧后端
    // 不识别 agentYaml 时会拿它测试并失败，降级为「测试未通过」提示，不会误保存）。
    const probe = await client.testAgentCandidate(
      agentId,
      { name: agentId, provider: '', transport: 'subprocess', exe: '-', args: [] },
      config,
    )
    if (!probe.ok) {
      throw new Error(`连接测试未通过，未保存：${probe.error?.message ?? '未知错误'}`, { cause: error })
    }
    return await client.updateAgentsConfig({ scope: 'agent', agentId, config })
  }
}
