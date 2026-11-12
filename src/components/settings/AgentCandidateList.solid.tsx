/** @jsxImportSource solid-js */
import { createSignal, For, Show, type JSX } from 'solid-js'
import type { AgentRuntimeCandidate, AgentDetectionDiagnostic, AgentProviderPreflight } from '../../domains/agent/agentDetector.ts'
import { candidateImportMode, candidateValidationDetails, type AgentCandidateValidationState } from '../../domains/agent/candidateValidation.ts'
import { presentDetectionDiagnostic } from './agentDetectionDiagnostics.ts'
import ArgumentListEditor from './ArgumentListEditor.solid.tsx'
import { describeInvocation } from '../../domains/agent/invocationDraft.ts'
import type { CandidateDraft } from './useAgentCandidateProvisioning.solid.ts'

const actionBase = 'inline-flex min-h-8 items-center justify-center rounded-[4px] border px-3 py-1 font-sans text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-50'
const actionButton = `${actionBase} border-stroke-default bg-surface-raised text-content-text hover:bg-hover-bg`
const primaryButton = `${actionBase} border-accent-edge bg-accent text-[color:var(--text-on-accent)] font-semibold hover:opacity-90`
const draftInput = 'w-full min-w-0 h-9 rounded-[4px] border border-stroke-default bg-bg-input px-3 font-sans text-[13px] text-content-text focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-50'

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
 * Candidate selection and one focused setup surface. The host owns all drafts,
 * validation receipts and persistence; this view only chooses what to reveal.
 */
export default function AgentCandidateList(props: AgentCandidateListProps) {
  const [reportOpen, setReportOpen] = createSignal(false)
  const selected = () => props.candidates.find(candidate => candidate.candidateId === props.selectedCandidateId)
  const importedId = (candidate: AgentRuntimeCandidate) => props.importedCandidateIds[candidate.candidateId] ?? props.resolveImportedAgentId(candidate)
  return (
    <section class="agent-runtime-discovery" aria-label="发现的运行时">
      <header class="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div><h4 class="m-0 text-[17px] font-semibold text-text">添加 Agent</h4><p class="m-0 mt-1 text-[13px] text-text-dim leading-relaxed">选择本机运行时，验证连接后即可开始对话。</p></div>
        <div class="flex items-center gap-2">
          <button class={actionButton} type="button" disabled={props.detecting || props.provisioningCandidateId !== null} onClick={props.onRedetect}>{props.detecting ? '正在发现…' : '重新探测'}</button>
          <Show when={props.detecting}><button class={actionButton} type="button" onClick={props.onCancelDetection}>取消探测</button></Show>
          <button class={actionButton} type="button" disabled={props.provisioningCandidateId !== null} onClick={props.onManualCreate}>手动添加</button>
        </div>
      </header>
      <Show when={props.detecting}><p class="set-hint" role="status">正在检查本机的 ACP 启动入口…</p></Show>
      <Show when={props.detectionCompleted && props.candidates.length === 0}>
        <div class="agent-runtime-empty" role="status"><strong>没有发现可直接导入的 Agent</strong><span>未发现可自动配置的 ACP Agent。已安装的程序不在 PATH 中时，可选择“手动添加”指定启动文件。</span></div>
      </Show>
      <Show when={props.candidates.length > 0}>
        <div class="agent-discovery-workspace">
          <div class="agent-candidate-picker" role="group" aria-label="选择 Agent 运行时">
            <For each={props.candidates}>{candidate => (
              <button type="button" class={`agent-candidate-row ${candidate.candidateId === props.selectedCandidateId ? 'active' : ''}`}
                disabled={props.provisioningCandidateId !== null && props.provisioningCandidateId !== candidate.candidateId}
                aria-pressed={candidate.candidateId === props.selectedCandidateId}
                onClick={() => props.onSelectCandidate(candidate.candidateId)}>
                <span><strong>{candidate.name}</strong><small>{candidate.provider}</small></span>
                <span>{candidateStatus(candidate, props.candidateValidation[candidate.candidateId], importedId(candidate))}</span>
              </button>
            )}</For>
          </div>
          <Show when={selected()} keyed>{candidate => <CandidateSetup candidate={candidate} state={props} />}</Show>
        </div>
      </Show>
      <div class="mt-5 pt-3 border-t border-stroke-subtle">
        <button type="button" class="agent-disclosure" aria-expanded={reportOpen()} onClick={() => setReportOpen(!reportOpen())}>扫描报告与安装帮助{props.detectionDiagnostics.length ? ` · ${props.detectionDiagnostics.length} 条提示` : ''}<span aria-hidden="true">{reportOpen() ? '−' : '+'}</span></button>
        <Show when={reportOpen()}>
          <Show when={props.detectionElapsedMs > 0 || props.detectionTruncated}><p class="set-hint">探测耗时：{props.detectionElapsedMs}ms{props.detectionTruncated ? ' · 结果已截断' : ''}</p></Show>
          <For each={props.detectionDiagnostics}>{diagnostic => <p class="set-hint" role="status">{presentDetectionDiagnostic(diagnostic).text}</p>}</For>
          <AgentInstallStatusList preflight={props.detectionPreflight} />
        </Show>
      </div>
    </section>
  )
}

function candidateStatus(candidate: AgentRuntimeCandidate, validation: AgentCandidateValidationState | undefined, importedId?: string): string {
  if (importedId) return '已添加'
  if (validation?.status === 'testing') return '验证中'
  if (validation?.status === 'ok') return '验证通过'
  if (validation?.status === 'failed') return '连接未通过'
  if (candidate.startability === 'failed') return '启动异常'
  return '待验证'
}

function shortEntry(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.slice(-2).join('/') || path
}

function CandidateSetup(props: { candidate: AgentRuntimeCandidate; state: AgentCandidateListProps }) {
  const candidate = props.candidate
  const state = props.state
  const [advanced, setAdvanced] = createSignal(false)
  const [diagnostics, setDiagnostics] = createSignal(false)
  const draft = () => state.candidateDrafts[candidate.candidateId] ?? { id: candidate.suggestedAgentId, name: candidate.name, executable: candidate.executable, args: [...candidate.args], provider: candidate.provider }
  const validation = () => state.candidateValidation[candidate.candidateId]
  const details = () => validation() ? candidateValidationDetails(validation()!) : null
  const importedId = () => state.importedCandidateIds[candidate.candidateId] ?? state.resolveImportedAgentId(candidate)
  const busy = () => state.provisioningCandidateId === candidate.candidateId
  const alternatives = () => [{ candidateId: candidate.candidateId, executable: candidate.executable, args: candidate.args, startability: candidate.startability }, ...(candidate.alternatives ?? [])]
  const invocation = () => alternatives().find(entry => entry.executable === draft().executable && JSON.stringify(entry.args) === JSON.stringify(draft().args))
  const importMode = () => candidateImportMode(candidate, validation())
  const step = () => importedId() ? 3 : busy() || validation()?.status === 'failed' || validation()?.status === 'ok' ? 2 : 1

  return (
    <div class="agent-runtime-card agent-candidate-detail" role="region" aria-label={`${candidate.name} 导入设置`} aria-busy={busy()}>
      <ol class="agent-import-steps" aria-label="导入进度">
        <For each={['确认入口', '验证并导入', '开始对话']}>{(label, index) => <li aria-current={step() === index() + 1 ? 'step' : undefined}><span>{index() + 1}</span>{label}</li>}</For>
      </ol>
      <Show when={!importedId()} fallback={
        <div class="py-3">
          <h4 class="m-0 text-[20px] font-semibold text-text">{draft().name} 已添加</h4>
          <p class="m-0 mt-2 text-[13px] leading-relaxed text-text-dim">{validation()?.status === 'ok' ? '连接验证已通过。现在可以打开工作区，开始第一段对话。' : '配置已保存。使用时将连接该 Agent，连接结果以实际运行状态为准。'}</p>
        </div>
      }>
        <div class="mb-4"><h4 class="m-0 text-[20px] font-semibold text-text">准备 {candidate.name}</h4><p class="m-0 mt-1 text-[13px] leading-relaxed text-text-dim">确认启动入口。验证成功后会保存配置，不会自动切换当前对话。</p></div>
        <fieldset class="m-0 p-0 border-0 min-w-0 grid gap-4" disabled={busy() && state.provisioningPhase === 'saving'}>
          <label class="agent-form-field">显示名称<input class={draftInput} value={draft().name} onInput={event => state.onUpdateCandidateDraft(candidate, { name: event.currentTarget.value })} aria-label={`${candidate.name} Agent name`} /></label>
          <Show when={alternatives().length > 1} fallback={
            <div class="agent-form-field"><span>启动入口</span><strong class="text-[13px] font-medium text-text" title={draft().executable}>{shortEntry(draft().executable)}</strong></div>
          }>
            <label class="agent-form-field">启动入口
              <select class={draftInput} aria-label={`${candidate.name} 启动入口`} disabled={state.provisioningCandidateId !== null} value={invocation()?.candidateId ?? ''} onChange={event => {
                const entry = alternatives().find(item => item.candidateId === event.currentTarget.value)
                if (entry) state.onUpdateCandidateDraft(candidate, { executable: entry.executable, args: [...entry.args] })
              }}>
                <Show when={!invocation()}><option value="">自定义启动入口</option></Show>
                <For each={alternatives()}>{(entry, index) => <option value={entry.candidateId}>{shortEntry(entry.executable)}{index() === 0 ? ' · 默认入口' : ''}{entry.startability === 'failed' ? ' · 启动异常' : ''}</option>}</For>
              </select>
            </label>
          </Show>
          <Show when={invocation()?.startability === 'failed' && !validation()}><p class="m-0 text-[13px] text-warning leading-relaxed" role="status">此入口未能启动。可尝试其他入口，或在高级配置中修正路径后验证。</p></Show>
          <button type="button" class="agent-disclosure" aria-expanded={advanced()} onClick={() => setAdvanced(!advanced())}>高级配置<span aria-hidden="true">{advanced() ? '−' : '+'}</span></button>
          <Show when={advanced()}>
            <div class="grid gap-4">
              <label class="agent-form-field">Agent 标识<input class={draftInput} value={draft().id} onInput={event => state.onUpdateCandidateDraft(candidate, { id: event.currentTarget.value })} aria-label={`${candidate.name} Agent id`} /></label>
              <label class="agent-form-field">可执行文件<input class={draftInput} value={draft().executable} onInput={event => state.onUpdateCandidateDraft(candidate, { executable: event.currentTarget.value })} aria-label={`${candidate.name} executable`} /></label>
              <div class="agent-form-field"><span>启动参数</span><ArgumentListEditor args={draft().args} label={candidate.name} onChange={args => state.onUpdateCandidateDraft(candidate, { args })} /></div>
              <label class="agent-form-field">提供方<input class={draftInput} value={draft().provider} onInput={event => state.onUpdateCandidateDraft(candidate, { provider: event.currentTarget.value })} aria-label={`${candidate.name} provider`} /></label>
              <InvocationPreview executable={draft().executable} args={draft().args} />
            </div>
          </Show>
        </fieldset>
      </Show>

      <Show when={validation()?.status === 'failed' && !importedId()}>
        <div class="agent-candidate-validation failed" role="status">
          <strong>连接验证未通过</strong><span>{details()?.message || '请检查启动入口与参数后重试。'}</span>
          <span>配置尚未导入，你的修改已保留。</span>
        </div>
      </Show>
      <Show when={state.candidateErrors[candidate.candidateId]}><p class="text-[13px] text-danger leading-relaxed" role="alert">{state.candidateErrors[candidate.candidateId]}</p></Show>
      <div class="agent-import-actions">
        <Show when={importedId()} fallback={
          <button class={primaryButton} type="button" aria-busy={busy()} disabled={state.provisioningCandidateId !== null} onClick={() => state.onValidateAndImport(candidate)}>{busy() ? state.provisioningPhase === 'saving' ? '保存配置中…' : '验证连接中…' : validation()?.status === 'ok' ? '导入已验证配置' : validation()?.status === 'failed' ? '重新验证并导入' : '验证并导入'}</button>
        }>
          <button class={primaryButton} type="button" aria-busy={busy()} disabled={state.provisioningCandidateId !== null} onClick={() => state.onActivateImported(candidate)}>{busy() ? '连接中…' : '使用此 Agent'}</button>
        </Show>
        <Show when={busy() && state.provisioningPhase === 'testing'}><button class={actionButton} type="button" onClick={state.onCancelValidation}>取消验证</button><span class="text-[12px] text-text-dim">正在进行 ACP 握手，最长 15 秒</span></Show>
      </div>
      <button type="button" class="agent-disclosure mt-4" aria-expanded={diagnostics()} onClick={() => setDiagnostics(!diagnostics())}>{validation()?.status === 'failed' ? '查看失败详情与恢复选项' : '查看启动详情'}<span aria-hidden="true">{diagnostics() ? '−' : '+'}</span></button>
      <Show when={diagnostics()}>
        <div class="grid gap-2 mt-3 text-[12px] leading-relaxed text-text-dim">
          <code class="break-all">{describeInvocation({ executable: draft().executable, args: draft().args }).display}</code>
          <For each={candidate.evidence}>{evidence => <span>{evidence.kind}：{evidence.detail}</span>}</For>
          <For each={candidate.warnings}>{warning => <span role="status">{warning}</span>}</For>
          <Show when={details()}><span>{details()!.headline} · {details()!.duration}</span></Show>
          <Show when={validation()?.status === 'failed'}>
            <span>阶段：{details()?.stage} · 退出码：{details()?.exitCode}</span>
            <pre class="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all">{details()?.stderr}</pre>
            <Show when={!importedId()}>
            <Show when={importMode() === 'unverified'} fallback={<span>此候选需要成功验证后才能导入。</span>}>
              <p class="m-0">已确认程序身份，但尚未确认 ACP 连接。可先保存配置，稍后修复启动问题。</p>
              <button class={actionButton} type="button" disabled={state.provisioningCandidateId !== null} onClick={() => state.onImportUnverified(candidate)}>仍然导入（未验证）</button>
            </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  )
}
