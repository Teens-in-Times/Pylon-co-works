/** @jsxImportSource solid-js */
import { createSignal } from 'solid-js'
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
  onCreate: (draft: AgentCreateDraftInput) => Promise<void>
}

/**
 * AgentCreateForm — 新建 Agent 表单（A-V4 自 AgentRuntimePanel 拆出）。
 * 草稿自持，随表单卸载重置（创建成功后收起=清空；用户手动「收起新建」
 * 也会重置——非「收起保留草稿」，见 #454 PR 披露）；提交经 onCreate 走面板侧事务
 * （校验/CAS/嵌入式降级在面板，成功后面板收起表单即重置草稿）。
 *
 * #515 W1：Solid 实体。DOM/aria 契约：div.agent-runtime-create
 * [aria-label="新建 Agent 配置"] > input.set-input ×4（aria-label 新建 Agent
 * id/name/exe/provider）+「选择可执行文件」「创建」钮（.ps-btn.sm）。
 */
export default function AgentCreateForm(props: AgentCreateFormProps) {
  const [createDraft, setCreateDraft] = createSignal<AgentCreateDraftInput>(EMPTY_CREATE_DRAFT)
  return (
    <div class="agent-runtime-create" aria-label="新建 Agent 配置">
      <input class="set-input" value={createDraft().id} onInput={event => setCreateDraft({ ...createDraft(), id: event.currentTarget.value })} placeholder="id（字母开头，可含 . _ -）" aria-label="新建 Agent id" />
      <input class="set-input" value={createDraft().name} onInput={event => setCreateDraft({ ...createDraft(), name: event.currentTarget.value })} placeholder="name" aria-label="新建 Agent name" />
      <input class="set-input" value={createDraft().exe} onInput={event => setCreateDraft({ ...createDraft(), exe: event.currentTarget.value })} placeholder="exe 绝对路径或命令名" aria-label="新建 Agent exe" />
      <input class="set-input" value={createDraft().provider} onInput={event => setCreateDraft({ ...createDraft(), provider: event.currentTarget.value })} placeholder="provider" aria-label="新建 Agent provider" />
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
      <ArgumentListEditor args={createDraft().args} label="新建 Agent" onChange={args => setCreateDraft({ ...createDraft(), args })} />
      <InvocationPreview executable={createDraft().exe} args={createDraft().args} />
      <div class="set-hint" role="note">{pathHintForProvider(null)}</div>
      <button class="ps-btn sm primary" type="button" disabled={props.busy} onClick={() => { void props.onCreate(createDraft()) }}>{props.busy ? '创建中…' : '创建'}</button>
    </div>
  )
}
