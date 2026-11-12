/** @jsxImportSource solid-js */
import { createSignal, onMount, Show } from 'solid-js'
import { builtinAgentCatalog } from '../../domains/agent/agentCatalog.ts'
import ArgumentListEditor from './ArgumentListEditor.solid.tsx'
import InvocationPreview from './InvocationPreview.solid.tsx'
import { pickAgentExecutable } from './pickAgentExecutable.ts'

/** 按 provider 给 exe/命令路径填写引导：文案由 catalog 派生，不在组件内 switch provider（A4）。 */
function pathHintForProvider(provider: string | null | undefined): string {
  return builtinAgentCatalog.executableHint(provider)
}

function executableIdentity(path: string): { id: string; name: string } {
  const fileName = path.trim().split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '').trim() ?? ''
  const id = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'agent'
  return { id, name: fileName || 'Agent' }
}

export interface AgentCreateDraftInput {
  id: string
  name: string
  exe: string
  provider: string
  args: string[]
}

const EMPTY_CREATE_DRAFT: AgentCreateDraftInput = { id: '', name: '', exe: '', provider: 'custom', args: ['acp'] }

interface AgentCreateFormProps {
  busy: boolean
  phase?: 'testing' | 'saving' | null
  onCreate: (draft: AgentCreateDraftInput) => Promise<void>
}

/** Manual setup owns its draft until cancelled or successfully stored.
 * The panel validates the exact launch configuration before persistence. */
export default function AgentCreateForm(props: AgentCreateFormProps) {
  const [createDraft, setCreateDraft] = createSignal<AgentCreateDraftInput>(EMPTY_CREATE_DRAFT)
  const [advanced, setAdvanced] = createSignal(false)
  let executableInput: HTMLInputElement | undefined
  onMount(() => executableInput?.focus())
  return (
    <div class="agent-runtime-create" aria-label="新建 Agent 配置">
      <p class="m-0 text-[13px] text-text-dim leading-relaxed">指定支持 ACP 的程序。验证通过后保存，启动参数与标识可在高级配置中调整。</p>
      <fieldset class="m-0 p-0 border-0 min-w-0 grid gap-4" disabled={props.busy}>
      <label class="agent-form-field">可执行文件或命令<input ref={element => { executableInput = element }} class="set-input" value={createDraft().exe} onInput={event => {
        const exe = event.currentTarget.value
        const suggested = executableIdentity(exe)
        setCreateDraft(current => {
          const previous = executableIdentity(current.exe)
          return { ...current, exe, id: !current.id || current.id === previous.id ? suggested.id : current.id, name: !current.name || current.name === previous.name ? suggested.name : current.name }
        })
      }} placeholder="选择文件，或输入完整路径" aria-label="新建 Agent exe" /></label>
      <button class="ps-btn sm" type="button" onClick={() => {
        void pickAgentExecutable().then(path => {
          if (!path) return
          const suggested = executableIdentity(path)
          const catalogMatch = builtinAgentCatalog.matchExecutable(path)
          setCreateDraft(current => ({
            ...current,
            exe: path,
            id: current.id || catalogMatch?.provider || suggested.id,
            name: current.name || catalogMatch?.displayName || suggested.name,
            provider: catalogMatch?.provider ?? current.provider,
            args: catalogMatch?.args ?? current.args,
          }))
        })
      }}>选择可执行文件</button>
      <label class="agent-form-field">显示名称<input class="set-input" value={createDraft().name} onInput={event => setCreateDraft({ ...createDraft(), name: event.currentTarget.value })} placeholder="在工作区中显示的名称" aria-label="新建 Agent name" /></label>
      <button class="agent-disclosure" type="button" aria-expanded={advanced()} onClick={() => setAdvanced(!advanced())}>高级配置<span aria-hidden="true">{advanced() ? '−' : '+'}</span></button>
      <Show when={advanced()}>
      <label class="agent-form-field">Agent 标识<input class="set-input" value={createDraft().id} onInput={event => setCreateDraft({ ...createDraft(), id: event.currentTarget.value })} placeholder="字母开头，可含 . _ -" aria-label="新建 Agent id" /></label>
      <label class="agent-form-field">提供方<input class="set-input" value={createDraft().provider} onInput={event => setCreateDraft({ ...createDraft(), provider: event.currentTarget.value })} placeholder="如 custom" aria-label="新建 Agent provider" /></label>
      <ArgumentListEditor args={createDraft().args} label="新建 Agent" onChange={args => setCreateDraft({ ...createDraft(), args })} />
      <InvocationPreview executable={createDraft().exe} args={createDraft().args} />
      <div class="set-hint" role="note">{pathHintForProvider(null)}</div>
      </Show>
      </fieldset>
      <div><button class="ps-btn sm primary" type="button" disabled={props.busy || !createDraft().exe.trim() || !createDraft().name.trim()} onClick={() => { void props.onCreate(createDraft()) }}>{props.phase === 'testing' ? '验证连接中…' : props.busy ? '保存配置中…' : '验证并创建'}</button></div>
    </div>
  )
}
