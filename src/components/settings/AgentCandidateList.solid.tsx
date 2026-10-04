/** @jsxImportSource solid-js */
import { For, Show, type JSX } from 'solid-js'
import type { AgentRuntimeCandidate, AgentDetectionDiagnostic, AgentProviderPreflight } from '../../domains/agent/agentDetector.ts'
import { candidateImportMode, candidateValidationDetails, type AgentCandidateValidationState } from '../../domains/agent/candidateValidation.ts'
import { presentDetectionDiagnostic } from './agentDetectionDiagnostics.ts'
import ArgumentListEditor from './ArgumentListEditor.solid.tsx'
import { describeInvocation } from '../../domains/agent/invocationDraft.ts'
import type { CandidateDraft } from './useAgentCandidateProvisioning.solid.ts'

const actionBase = 'inline-flex min-h-8 items-center justify-center rounded-sm border px-3 py-1 font-sans text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-50'
const actionButton = `${actionBase} border-stroke-default bg-surface-raised text-content-text hover:bg-hover-bg`
const primaryButton = `${actionBase} border-accent-edge bg-accent-soft text-content-text font-semibold hover:bg-accent-soft-strong`
const draftInput = 'w-full min-w-0 rounded-sm border border-stroke-default bg-surface-panel px-2 py-1 font-sans text-sm text-content-text focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-50'

function candidateProtocolLabel(validation: AgentCandidateValidationState | undefined): string {
  if (validation?.status === 'testing') return '验证中'
  if (validation?.status === 'ok') return '可用'
  if (validation?.status === 'failed') return '失败'
  return '未验证'
}

function candidateStartabilityLabel(startability: AgentRuntimeCandidate['startability']): string {
  if (startability === 'verified') return '可启动'
  if (startability === 'failed') return '启动失败'
  return '版本未确认'
}

/** 候选卡内的启动命令预览（与共享 InvocationPreview 同构；候选卡用它自己的 issues 面）。 */
function InvocationPreview(props: { executable: string; args: string[] }): JSX.Element {
  const invocation = () => describeInvocation({ executable: props.executable, args: props.args })
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

function AgentInstallStatusList(props: { preflight: readonly AgentProviderPreflight[] }): JSX.Element {
  return (
    <Show when={props.preflight.length > 0}>
      <div class="agent-install-status" aria-label="本机 Agent 安装状态">
        <For each={props.preflight}>{entry => {
          const cause = entry.cause
          const reason = cause
            ? (cause.level === 'ok' ? '' : cause.summary)
            : agentInstallStatusReason(entry.status)
          const adapter = entry.adapter
          return <div class={`agent-install-row ${installStatusClass(entry.status)}`} role="status">
            <span><strong>{entry.provider}</strong><small>{agentInstallStatusLabel(entry.status)}</small></span>
            <Show when={reason}><span>{reason}</span></Show>
            <Show when={adapter}>
              <span class="set-hint">
                {`ACP：${adapter!.acpPresent ? '已找到' : '未找到'} · ${adapter!.nativeLabel}（${adapter!.nativeCmd}）：${adapter!.nativePresent ? '已找到' : '未找到'} · 共享配置目录 ${adapter!.sharedConfigDir}：${adapter!.sharedConfigPresent ? '存在' : '不存在'}`}
              </span>
            </Show>
            <For each={entry.checks.filter(check => check.status !== 'PASS')}>{check => (
              <span class="set-hint" role="status">{`${check.label}：${check.message}（${check.status}）`}</span>
            )}</For>
          </div>
        }}</For>
      </div>
    </Show>
  )
}

import {
  agentInstallStatusLabel,
  agentInstallStatusReason,
} from '../../domains/agent/agentDetector.ts'

function installStatusClass(status: AgentProviderPreflight['status']): string {
  if (status === 'installed') return 'ok'
  if (status === 'versionTooOld' || status === 'adapterMissing') return 'failed'
  return 'warn'
}

interface AgentCandidateListProps {
  candidates: readonly AgentRuntimeCandidate[]
  /** 当前 Agent 注册表里的导入解析（id 精确匹配，回落 provider 匹配；未配置为 undefined）。 */
  resolveImportedAgentId: (candidate: AgentRuntimeCandidate) => string | undefined
  selectedCandidateId: string | null
  onSelectCandidate: (candidateId: string) => void
  detectionDiagnostics: readonly AgentDetectionDiagnostic[]
  detectionElapsedMs: number
  detectionPreflight: readonly AgentProviderPreflight[]
  detectionTruncated: boolean
  detectionCompleted: boolean
  detecting: boolean
  onRedetect: () => void
  onCancelDetection: () => void
  onManualCreate: () => void
  candidateDrafts: Record<string, CandidateDraft>
  candidateValidation: Record<string, AgentCandidateValidationState>
  importedCandidateIds: Record<string, string>
  candidateErrors: Record<string, string>
  provisioningCandidateId: string | null
  provisioningPhase: 'testing' | 'saving' | 'activating' | null
  onCancelValidation: () => void
  onValidateAndImport: (candidate: AgentRuntimeCandidate) => void
  onImportUnverified: (candidate: AgentRuntimeCandidate) => void
  onActivateImported: (candidate: AgentRuntimeCandidate) => void
  onUpdateCandidateDraft: (candidate: AgentRuntimeCandidate, patch: Partial<CandidateDraft>) => void
}

/**
 * 设置页发现入口：优先展示候选与导入动作，报告、草稿和诊断按需展开。
 * 状态与副作用由宿主提供，此组件只呈现状态并转发操作。
 *
 * #515 W1：Solid 实体。DOM/class/aria 契约：section.agent-runtime-discovery
 * [aria-label="发现的运行时"] > .set-preset-row 动作行 + details 探测报告 +
 * .agent-candidate-row[aria-expanded] 候选卡；候选卡内的派生值（草稿/验证/导入态）
 * 全部收进 per-candidate accessor，读取时求值。
 */
export default function AgentCandidateList(props: AgentCandidateListProps) {
  return (
    <section class="agent-runtime-discovery" aria-label="发现的运行时">
      <div class="set-preset-row mt-3">
        <strong>发现的运行时（{props.candidates.length}）</strong>
        <button class={actionButton} type="button" disabled={props.detecting || props.provisioningCandidateId !== null} onClick={props.onRedetect}>{props.detecting ? '探测中…' : '重新探测'}</button>
        <Show when={props.detecting}><button class={actionButton} type="button" onClick={props.onCancelDetection}>取消探测</button></Show>
        <button class={actionButton} type="button" disabled={props.provisioningCandidateId !== null} onClick={props.onManualCreate}>手动添加</button>
      </div>
      <p class="set-hint">选择启动入口后验证并导入。导入会保存配置，点击“使用此 Agent”再连接并打开工作区。</p>
      <Show when={props.detecting}><div class="set-hint" role="status">正在检查本机的 ACP 启动入口…</div></Show>
      <Show when={props.detectionCompleted && props.candidates.length === 0}>
        <div class="agent-runtime-empty" role="status">
          未发现可自动配置的 ACP Agent。若 Agent 已安装但不在 PATH 中，可以手动选择其可执行文件。
        </div>
      </Show>
      <details class="my-2">
        <summary class="cursor-pointer text-sm text-muted">探测报告与安装状态{props.detectionDiagnostics.length > 0 ? `（${props.detectionDiagnostics.length} 条提示）` : ''}</summary>
        <Show when={props.detectionElapsedMs > 0 || props.detectionTruncated}>
          <div class="set-hint">探测耗时：{props.detectionElapsedMs}ms{props.detectionTruncated ? ' · 结果已截断' : ''}</div>
        </Show>
        <For each={props.detectionDiagnostics}>{diagnostic => {
          // #116 子项 10：UI 只呈现「哪条探测 · 哪个候选 · 本地化原因」；
          // 内部码与系统级原文由 presentDetectionDiagnostic 的 raw 进运行日志。
          const presented = presentDetectionDiagnostic(diagnostic)
          return (
            <div class="set-hint" role="status">
              {presented.text}
            </div>
          )
        }}</For>
        <AgentInstallStatusList preflight={props.detectionPreflight} />
      </details>
      <For each={props.candidates}>{candidate => {
        const discoveredDraft = () => props.candidateDrafts[candidate.candidateId] ?? { id: candidate.suggestedAgentId, name: candidate.name, executable: candidate.executable, args: [...candidate.args], provider: candidate.provider }
        const validation = () => props.candidateValidation[candidate.candidateId]
        const importMode = () => candidateImportMode(candidate, validation())
        const validationDetails = () => validation() ? candidateValidationDetails(validation()!) : null
        const selected = () => candidate.candidateId === props.selectedCandidateId
        // 导入态：本面板的导入凭据优先，其次注册表现状解析。
        const importedId = () => props.importedCandidateIds[candidate.candidateId] ?? props.resolveImportedAgentId(candidate)
        const busy = () => props.provisioningCandidateId === candidate.candidateId
        const alternatives = () => [{ candidateId: candidate.candidateId, executable: candidate.executable, args: candidate.args, startability: candidate.startability }, ...(candidate.alternatives ?? [])]
        const invocation = () => alternatives().find(entry => entry.executable === discoveredDraft().executable && JSON.stringify(entry.args) === JSON.stringify(discoveredDraft().args))
        const readiness = () => validation()?.status === 'ok' ? '连接验证通过' : candidateStartabilityLabel(invocation()?.startability)
        return <div class="agent-candidate-option">
          <button type="button" class={`agent-candidate-row ${selected() ? 'active' : ''}`} disabled={props.provisioningCandidateId !== null && !busy()} aria-expanded={selected()} onClick={() => props.onSelectCandidate(candidate.candidateId)}>
            <span><strong>{candidate.name}</strong><small>{candidate.provider}</small></span>
            <span>{importedId() ? `已导入 · ${importedId()}` : `${readiness()} · ${candidateProtocolLabel(validation())}`}</span>
          </button>
          <Show when={selected()}>
            <div class="agent-runtime-card">
              <div class="set-hint"><strong>{candidate.name}</strong> · ACP：{candidateProtocolLabel(validation())} · {importedId() ? `已导入为 ${importedId()}` : '尚未导入'}</div>
              <Show when={!importedId() && alternatives().length > 1}>
                <label class="flex flex-col gap-1 text-sm">
                  启动入口
                  <select class={draftInput} aria-label={`${candidate.name} 启动入口`} disabled={props.provisioningCandidateId !== null} value={invocation()?.candidateId ?? ''} onChange={event => {
                    const entry = alternatives().find(item => item.candidateId === event.currentTarget.value)
                    if (entry) props.onUpdateCandidateDraft(candidate, { executable: entry.executable, args: [...entry.args] })
                  }}>
                    <Show when={!invocation()}>
                      <option value="">自定义启动入口</option>
                    </Show>
                    <For each={alternatives()}>{entry => <option value={entry.candidateId}>{describeInvocation(entry).display}</option>}</For>
                  </select>
                </label>
              </Show>
              <InvocationPreview executable={discoveredDraft().executable} args={discoveredDraft().args} />
              <Show when={!importedId()}>
                <details class="my-2">
                  <summary class="cursor-pointer text-sm text-muted">调整导入配置</summary>
                  <fieldset class="m-0 min-w-0 border-0 p-0" disabled={busy() && props.provisioningPhase === 'saving'}>
                    <div class="agent-runtime-edit">
                      <label>标识<input class={draftInput} value={discoveredDraft().id} onInput={event => props.onUpdateCandidateDraft(candidate, { id: event.currentTarget.value })} aria-label={`${candidate.name} Agent id`} /></label>
                      <label>名称<input class={draftInput} value={discoveredDraft().name} onInput={event => props.onUpdateCandidateDraft(candidate, { name: event.currentTarget.value })} aria-label={`${candidate.name} Agent name`} /></label>
                      <label>可执行文件<input class={draftInput} value={discoveredDraft().executable} onInput={event => props.onUpdateCandidateDraft(candidate, { executable: event.currentTarget.value })} aria-label={`${candidate.name} executable`} /></label>
                      <ArgumentListEditor args={discoveredDraft().args} label={candidate.name} onChange={args => props.onUpdateCandidateDraft(candidate, { args })} />
                      <label>提供方<input class={draftInput} value={discoveredDraft().provider} onInput={event => props.onUpdateCandidateDraft(candidate, { provider: event.currentTarget.value })} aria-label={`${candidate.name} provider`} /></label>
                    </div>
                  </fieldset>
                </details>
              </Show>
              <details class="my-2">
                <summary class="cursor-pointer text-sm text-muted">发现依据与其他入口（{candidate.evidence.length}）</summary>
                <For each={candidate.evidence}>{evidence => <div class="set-hint">{evidence.kind}：{evidence.detail}</div>}</For>
                <For each={candidate.warnings}>{warning => <div class="set-hint" role="status">{warning}</div>}</For>
              </details>
              <Show when={props.candidateErrors[candidate.candidateId]}>
                <div class="set-hint" role="alert">{props.candidateErrors[candidate.candidateId]}</div>
              </Show>
              <div class="set-preset-row">
                <Show when={importedId()} fallback={
                  <>
                    <button class={primaryButton} type="button" aria-busy={busy()} disabled={props.provisioningCandidateId !== null} onClick={() => props.onValidateAndImport(candidate)}>{busy() ? props.provisioningPhase === 'saving' ? '保存配置中…' : '验证连接中…' : validation()?.status === 'ok' ? '导入已验证配置' : validation()?.status === 'failed' ? '重新验证并导入' : '验证并导入'}</button>
                    <Show when={importMode() === 'unverified'}>
                      <button class={actionButton} type="button" disabled={props.provisioningCandidateId !== null} onClick={() => props.onImportUnverified(candidate)}>仍然导入（未验证）</button>
                    </Show>
                  </>
                }>
                  <button class={primaryButton} type="button" aria-busy={busy()} disabled={props.provisioningCandidateId !== null} onClick={() => props.onActivateImported(candidate)}>{busy() ? props.provisioningPhase === 'activating' ? '连接中…' : '刷新配置中…' : '使用此 Agent'}</button>
                </Show>
                <Show when={busy() && props.provisioningPhase === 'testing'}>
                  <button class={actionButton} type="button" onClick={props.onCancelValidation}>取消验证</button>
                  <span class="set-hint">正在验证连接，最长 15 秒</span>
                </Show>
              </div>
              <Show when={validationDetails()}>
                <div class={`agent-candidate-validation ${validation()?.status === 'failed' ? 'failed' : 'ok'}`} role="status">
                  <strong>{validationDetails()!.headline}</strong>
                  <span>耗时：{validationDetails()!.duration}{validation()?.status === 'failed' ? ` · 阶段：${validationDetails()!.stage}` : ''}</span>
                  <Show when={validationDetails()!.message}><span>{validationDetails()!.message}</span></Show>
                  <Show when={validation()?.status === 'failed'}>
                    <details><summary class="cursor-pointer">错误详情</summary><span>退出码：{validationDetails()!.exitCode}</span><pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words">stderr：{validationDetails()!.stderr}</pre></details>
                  </Show>
                  <Show when={importMode() === 'unverified'}><span>高置信候选可继续导入，导入后标记为未验证。</span></Show>
                  <Show when={validation()?.status === 'failed' && importMode() === 'blocked'}><span>当前置信度必须通过验证后才能导入。</span></Show>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      }}</For>
    </section>
  )
}
