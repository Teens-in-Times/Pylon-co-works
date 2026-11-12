/** @jsxImportSource solid-js */
import { createMemo, Show } from 'solid-js'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { selectAgentStatus, statusLabel } from '../../contracts/agentTypes'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import AgentRuntimePanel from './AgentRuntimePanel.solid.tsx'
import AgentConfigEditor from './AgentConfigEditor.solid.tsx'
import ConfigOptionsPanel from './ConfigOptionsPanel.solid.tsx'
import { Group } from './settingsSectionShared.solid.tsx'
import { createSettingsAgentActions } from './settingsAgentActions.solid.ts'

interface AgentSettingsSectionProps {
  initialAgentId?: string
  activeSessionContext?: { agentId: string; source: string }
}

/** Connection status, onboarding and advanced configuration share one page.
 * Empty installations start directly at discovery; runtime mutations stay in
 * their existing action and panel owners. */
export default function AgentSettingsSection(props: AgentSettingsSectionProps) {
  const agents = createZustandSignal(useIdentityStore, s => s.agents)
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const agentStatuses = createZustandSignal(useRuntimeStore, s => s.agentStatuses)
  const { reconnectPending, reconnectCommandError, reloading, dictFeedback, reconnectAgent, reloadAgents } = createSettingsAgentActions(activeAgent)
  const currentStatus = createMemo(() => selectAgentStatus(activeAgent(), activeAgent(), agentStatuses()))
  // #326：零 Agent 是合法首跑状态。此前这里回落硬编码 'peri'——会在没有该 Agent 时
  // 显示一个不存在的名字/ID（与「预置必然失败的占位 Agent」同一类病），改为如实空态。
  const activeAgentEntry = createMemo(() => agents().find(agent => agent.id === activeAgent()))

  return (
    <>
      <div class="agent-settings-heading">
        <div><h3>Agent</h3><p>连接你常用的 Agent，管理本机运行时。</p></div>
      </div>
      <Show when={activeAgentEntry()}>
      <section class="agent-settings-overview" aria-label="当前 Agent 概况">
        <div class="agent-settings-overview-main">
          <span class={`agent-status-indicator is-${currentStatus().status}`} aria-hidden="true" />
          <div>
            <span class="agent-settings-kicker">当前 Agent</span>
            <strong>{activeAgentEntry()?.name}</strong>
            <span class="agent-settings-status-copy">状态：{activeAgent() ? statusLabel(currentStatus().status) : '未配置'}</span>
          </div>
        </div>
        <div class="agent-settings-actions">
          <button type="button" class="ps-btn sm primary" disabled={reconnectPending() || !activeAgent()} onClick={reconnectAgent}>{reconnectPending() ? '重连中…' : '重新连接'}</button>
          <button type="button" class="ps-btn sm" disabled={reloading()} onClick={reloadAgents}>{reloading() ? '重载中…' : '重载配置'}</button>
        </div>
        <dl class="agent-settings-facts">
          <div><dt>传输方式</dt><dd>{currentStatus().transport || '未报告'}</dd></div>
          <div><dt>工作目录</dt><dd title={currentStatus().cwd}>{currentStatus().cwd || '跟随会话'}</dd></div>
        </dl>
        {/* This is an authoritative Agent status fact, not a dismissible
            runtime toast; keep the alert semantics for assistive tech. */}
        <Show when={currentStatus().recentError}>
          <div class="agent-settings-notice error" role="alert">最近错误：{currentStatus().recentError}</div>
        </Show>
        <Show when={reconnectCommandError()}>
          <div class="agent-settings-notice error" role="status">重连失败，详情见右下角错误中心</div>
        </Show>
        <Show when={dictFeedback()}>
          <div class="agent-settings-notice" role="status">{dictFeedback()}</div>
        </Show>
      </section>
      </Show>
      <AgentRuntimePanel initialAgentId={props.initialAgentId} />
      <Group title="高级：YAML 配置" defaultOpen={false}>
        <AgentConfigEditor agentId={activeAgent()} />
        <div class="set-hint">保存会原子写回生效配置并刷新 Agent 列表；当前 active agent 不可被删除。</div>
      </Group>
      <Group title="高级：会话动态配置" defaultOpen={false}>
        <ConfigOptionsPanel context={props.activeSessionContext} />
      </Group>
    </>
  )
}
