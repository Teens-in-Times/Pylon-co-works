/** @jsxImportSource solid-js */
import { Show } from 'solid-js'
import type { AgentEntry } from '../../domains/identity/identityStore'
import { selectAgentStatus, statusLabel } from '../../contracts/agentTypes'
import { explainErrorCode } from '../../app/errorCodeExplanations.ts'
import type { AgentDetectionDiagnostic } from '../../domains/agent/agentDetector.ts'
import { builtinAgentCatalog } from '../../domains/agent/agentCatalog.ts'
import type { AgentDraftState } from '../../domains/agent/agentDraftMachine.ts'
import ArgumentListEditor from './ArgumentListEditor.solid.tsx'
import InvocationPreview from './InvocationPreview.solid.tsx'
import ConfirmArmButton from '../ui/ConfirmArmButton.solid.tsx'
import { pickAgentExecutable } from './pickAgentExecutable.ts'
import type { Draft } from './agentRuntimePanelDrafts'

/** 按 provider 给 exe/命令路径填写引导：文案由 catalog 派生，不在组件内 switch provider（A4）。 */
function pathHintForProvider(provider: string | null | undefined): string {
  return builtinAgentCatalog.executableHint(provider)
}

function activationLabel(state: AgentEntry['configActivationState']): string {
  return state === 'activated' ? '已生效' : state === 'pendingRestart' ? '待重启生效' : '已存储'
}

interface AgentRuntimeCardProps {
  agent: AgentEntry
  onOpenAgent: () => void
  activating: boolean
  expanded: boolean
  onToggleExpanded: () => void
  activeAgent: string
  status: ReturnType<typeof selectAgentStatus>
  isEditing: boolean
  draft: Draft
  onPatchDraft: (updater: (current: Draft) => Draft) => void
  draftLaunchPlan: { argv: string[] } | null
  draftMachinePhase: AgentDraftState['phase']
  probeFailure: AgentDetectionDiagnostic | undefined
  detecting: boolean
  onRedetect: () => void
  savingId: string | null
  testingId: string | null
  testResultText: string | undefined
  onStartEdit: () => void
  onSaveEdit: () => void
  onTestDraftConnection: () => void
  onCancelDraftTest: () => void
  onCancelEdit: () => void
  onSetDefault: () => void
  onTestConnection: () => void
  onRestartRuntime: () => void
  onDeleteAgent: () => void
}

/** A configured Agent starts as a compact row. Management is explicit and
 * its expansion is owned by the panel so registry refreshes preserve context. */
export default function AgentRuntimeCard(props: AgentRuntimeCardProps) {
  return (
    <div class="agent-runtime-card">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div class="min-w-0"><strong class="text-[14px] font-semibold">{props.agent.name}</strong><span class="ml-3 text-[12px] text-text-dim">{statusLabel(props.status.status)}{props.agent.id === props.activeAgent ? ' · 当前' : ''}{props.agent.default ? ' · 默认' : ''}</span><p class="m-0 mt-1 text-[12px] text-text-dim">{props.agent.provider || props.agent.id}</p></div>
        <div class="flex items-center gap-2">
          <button class="ps-btn sm" type="button" disabled={props.activating || props.savingId !== null} onClick={props.onOpenAgent}>{props.activating ? '连接中…' : '打开对话'}</button>
          <button class="ps-btn sm" type="button" aria-expanded={props.expanded || props.isEditing} onClick={props.onToggleExpanded}>{props.expanded || props.isEditing ? '收起管理' : '管理'}</button>
        </div>
      </div>
      <Show when={props.expanded || props.isEditing}>
      <div class="set-hint">id：{props.agent.id} · provider：{props.agent.provider ?? '—'} · transport：{props.agent.transport ?? 'subprocess'}</div>
      <div class="set-hint">状态：{statusLabel(props.status.status)} · 配置：{activationLabel(props.agent.configActivationState)} · exe：{props.isEditing ? '' : (props.agent.exe ?? '—')}</div>
      {/* #325：探测失败的原因必须落到**这张卡**上——此前只有「未激活」，
          真实原因（version_probe_spawn_failed os error 193 等）只进控制台。
          归因走结构化字段：诊断带 candidateId，候选带 alreadyImportedAgentId。 */}
      <Show when={props.probeFailure && props.status.status !== 'connected'}>
        <div class="set-hint agent-runtime-failure" role="status">
          探测失败：<code>{props.probeFailure!.code}</code>
          <span> {explainErrorCode(props.probeFailure!.code)?.summary ?? '原因见运行日志'}</span>
          {/* 归因可能来自同 provider 的另一个可执行形式：把被测路径写出来，用户才
              知道失败的不是卡片上那个 exe。 */}
          <Show when={props.probeFailure!.executable}>
            <span class="agent-runtime-failure-path">{props.probeFailure!.executable}</span>
          </Show>
          <button class="ps-btn sm" type="button" disabled={props.detecting} onClick={props.onRedetect}>
            {props.detecting ? '探测中…' : '重试探测'}
          </button>
        </div>
      </Show>
      {/* 与探测失败各自独立：探测失败是「能不能启动」的事实，recentError 是运行期事实，
          两者可以同时成立，不能互相顶掉。 */}
      <Show when={props.status.recentError}>
        <div class="set-hint agent-runtime-failure" role="status">最近错误：{props.status.recentError}</div>
      </Show>

      <Show when={props.isEditing}>
        <fieldset class="agent-runtime-edit border-0 p-0 min-w-0" disabled={props.savingId !== null}>
          <label class="agent-form-field">显示名称<input class="set-input" value={props.draft.name} onInput={event => props.onPatchDraft(d => ({ ...d, name: event.currentTarget.value }))} placeholder="显示名称" aria-label="Agent name" /></label>
          <label class="agent-form-field">启动入口<input class="set-input" value={props.draft.exe} onInput={event => props.onPatchDraft(d => ({ ...d, exe: event.currentTarget.value }))} placeholder="可执行文件路径或命令名" aria-label="Agent exe" /></label>
          <div class="set-hint" role="note">{pathHintForProvider(props.draft.provider || props.agent.provider)}</div>
          <div class="set-preset-row">
            <button class="ps-btn sm" type="button" onClick={() => pickAgentExecutable().then(path => { if (path) props.onPatchDraft(d => ({ ...d, exe: path })) })}>选择可执行文件</button>
            <label class="agent-form-field">提供方<input class="set-input" value={props.draft.provider} onInput={event => props.onPatchDraft(d => ({ ...d, provider: event.currentTarget.value }))} placeholder="可留空" aria-label="Agent provider" /></label>
          </div>
          <ArgumentListEditor args={props.draft.args} label={props.agent.id} onChange={args => props.onPatchDraft(d => ({ ...d, args, argsKnown: true }))} />
          <InvocationPreview executable={props.draft.exe} args={props.draft.args} effectiveArgs={[...props.draft.args, ...props.draft.effectiveSuffix]} />
        </fieldset>
      </Show>

      <Show when={props.testResultText}>
        <div class="set-hint" role="status">{props.testResultText}</div>
      </Show>
      <Show when={props.isEditing && props.draftLaunchPlan?.argv}>
        <div class="set-hint" role="note">{`启动计划：${props.draftLaunchPlan!.argv.join(' ')}（env 值已隐藏）`}</div>
      </Show>

      <div class="set-preset-row">
        <Show when={props.isEditing} fallback={
          <button class="ps-btn sm" type="button" disabled={props.savingId !== null} onClick={props.onStartEdit}>编辑</button>
        }>
          <button class="ps-btn sm primary" type="button" disabled={props.savingId !== null || props.draftMachinePhase === 'testing'} onClick={props.onSaveEdit}>{props.savingId === props.agent.id ? '保存中…' : '保存'}</button>
          <button class="ps-btn sm" type="button" disabled={props.testingId !== null || props.savingId !== null} onClick={props.onTestDraftConnection}>{props.testingId === props.agent.id ? '测试中…' : '先测试连接'}</button>
          <Show when={props.draftMachinePhase === 'testing'}>
            <button class="ps-btn sm" type="button" onClick={props.onCancelDraftTest}>取消验证</button>
          </Show>
          <button class="ps-btn sm" type="button" disabled={props.savingId !== null || props.draftMachinePhase === 'testing'} onClick={props.onCancelEdit}>取消</button>
        </Show>
        <button class="ps-btn sm" type="button" disabled={props.savingId !== null || props.agent.default === true} onClick={props.onSetDefault}>设为默认</button>
        <button class="ps-btn sm" type="button" disabled={props.testingId !== null || props.savingId !== null} onClick={props.onTestConnection}>{props.testingId === props.agent.id ? '测试中…' : '测试连接'}</button>
        <Show when={props.agent.configActivationState === 'pendingRestart'}>
          <button class="ps-btn sm primary" type="button" disabled={props.savingId !== null} onClick={props.onRestartRuntime}>
            {props.savingId === props.agent.id ? '正在重启…' : '立即重启应用此配置'}
          </button>
        </Show>
        {/* issue #67A：删除入口。active agent 禁用（禁用按钮不弹 tooltip，故用内联说明）。
            #520 K 域：确认交互由 ui/ConfirmArmButton 承载（原 window.confirm 式退役）；
            armed 态旁注影响面（移除什么/保留什么），3s 未确认自动回弹。 */}
        <ConfirmArmButton
          label={props.savingId === props.agent.id ? '删除中…' : '删除'}
          confirmLabel="确认删除"
          class="ps-btn sm"
          confirmClass="ps-btn sm danger"
          disabled={props.savingId !== null || props.testingId !== null || props.agent.id === props.activeAgent}
          hint={`将移除：配置条目 ${props.agent.id}（agents.yaml）与运行中的 runtime 实例（若在运行，将停止）；保留不动：该 Agent 的历史会话与记录数据、其它 Agent 配置`}
          onConfirm={props.onDeleteAgent}
        />
        <Show when={props.agent.id === props.activeAgent}>
          <span class="set-hint" role="note">当前正在使用的 Agent 不能删除，请先切换到其它 Agent</span>
        </Show>
      </div>
      </Show>
    </div>
  )
}
