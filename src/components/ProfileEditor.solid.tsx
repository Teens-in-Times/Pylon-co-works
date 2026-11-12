/** @jsxImportSource solid-js */
import { createMemo, createSignal, Show } from 'solid-js'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import { LucideIcon } from './LucideIcon.solid.tsx'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import Select from './ui/Select.solid.tsx'
import { createDialogFocus } from './ui/dialogFocus'

// 样式绞杀（P93）：原 ProfileEditor.css 的 utility 化。settings-* 共享底座
// 类（Settings.css 供给）原样保留；pe-textarea 类保留为 :has() 锚点；
// rgba 遮罩与 --settings-* 域 token 均原样平移。
const OVERLAY = 'fixed inset-0 z-[100] flex items-center justify-center p-6 max-[640px]:p-3 bg-[rgba(18,22,32,0.36)] backdrop-blur-[8px]'
const EDITOR = 'settings-surface settings-dialog agent-settings-dialog w-[min(720px,calc(100vw-32px))] max-h-[min(88vh,860px)] flex flex-col'
const SECTION_TITLE = 'col-span-full mt-1 pt-4 border-t border-[var(--settings-border)] text-text text-[13px] font-[680] first-of-type:mt-0 first-of-type:pt-0 first-of-type:border-t-0 max-[640px]:col-span-1'
const FIELD = 'min-w-0 has-[.pe-textarea]:col-span-full max-[640px]:has-[.pe-textarea]:col-span-1'
const LABEL = 'block mb-1.5 text-text text-sm font-[620]'
const IDENTITY_PREVIEW = 'col-span-full flex items-center gap-3.5 px-4 py-3.5 border border-[var(--settings-border)] rounded-[var(--settings-radius-md)] bg-[var(--settings-subtle)] max-[640px]:col-span-1'

export interface ProfileEditorProps {
  onClose: () => void
}

/** ProfileEditor — 身份 Profile 编辑弹窗（#515 Solid 实体）。DOM/aria 契约：遮罩点击
 * 关闭；div[role=dialog][aria-modal][aria-labelledby=profile-editor-title]，标题
 * h3#profile-editor-title，字段 label[for] ↔ input/textarea#profile-*，关闭钮
 * aria-label="关闭 Profile 设置"。 */
export default function ProfileEditor(props: ProfileEditorProps) {
  const profiles = createZustandSignal(useIdentityStore, s => s.profiles)
  const activeProfileId = createZustandSignal(useIdentityStore, s => s.activeProfileId)
  const sessionConfig = createZustandSignal(useRuntimeStore, s => s.sessionConfig)
  // activeProfileId 失效时不回退 profiles[0]：否则 save 走编辑分支、覆写第一个 profile。
  // find 不到即进入新建分支（Date.now 新 id）。
  const profile = createMemo(() => profiles().find(p => p.id === activeProfileId()))

  const [name, setName] = createSignal(profile()?.name || '')
  const [avatar, setAvatar] = createSignal(profile()?.avatar || '')
  const [persona, setPersona] = createSignal(profile()?.persona || '')
  const [model, setModel] = createSignal(profile()?.model || '')
  // 新建模式：清空表单，save 走 addProfile 新 id（FE-AUD-002 新增入口）
  const [creating, setCreating] = createSignal(false)
  const startCreate = () => {
    setName('')
    setAvatar('')
    setPersona('')
    setModel('')
    setCreating(true)
  }

  // 从任意session的config里拿model列表，否则用fallback
  const models = createMemo(() => {
    for (const cfg of Object.values(sessionConfig())) {
      if (cfg.models?.length) return cfg.models
    }
    return []
  })

  const save = () => {
    if (!name().trim()) return
    const current = profile()
    const id = creating() ? Date.now().toString(36) : (current && profiles().includes(current) ? current.id : Date.now().toString(36))
    useIdentityStore.getState().addProfile({ id, name: name(), avatar: avatar(), persona: persona(), model: model() })
    useIdentityStore.getState().setActiveProfile(id)
    setCreating(false)
    props.onClose()
  }

  const dirty = createMemo(() => name() !== (profile()?.name || '')
    || avatar() !== (profile()?.avatar || '')
    || persona() !== (profile()?.persona || '')
    || model() !== (profile()?.model || ''))

  const requestClose = () => {
    if (dirty() && !window.confirm('放弃未保存的 Profile 修改？')) return
    props.onClose()
  }

  let dialogRef: HTMLDivElement | undefined
  createDialogFocus(() => dialogRef, () => true, requestClose)

  return (
    <div class={OVERLAY} onClick={e => { if (e.target === e.currentTarget) requestClose() }}>
      <div ref={node => { dialogRef = node }} class={EDITOR} role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
        <div class="pe-header settings-dialog-header shrink-0">
          <div>
            <h3 id="profile-editor-title" class="settings-dialog-title">{creating() ? '新建 Profile' : '编辑 Profile'}</h3>
            <p class="settings-dialog-description">定义这个 Profile 的身份信息、Persona 与默认模型。</p>
          </div>
          <div class="pe-header-actions flex shrink-0 items-center gap-2">
            <button type="button" class="settings-action inline-flex items-center gap-2" onClick={startCreate} disabled={creating()}><LucideIcon name="Plus" size={14} />新建 Profile</button>
            <button type="button" class="pe-close settings-dialog-close" onClick={requestClose} aria-label="关闭 Profile 设置"><LucideIcon name="X" size={16} /></button>
          </div>
        </div>
        <div class="min-h-0 overflow-y-auto pt-[22px] px-6 pb-7 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-y-4 gap-x-[18px] max-[640px]:grid-cols-1 max-[640px]:px-[18px]">
          <div class={IDENTITY_PREVIEW}>
            <div class="w-[52px] h-[52px] shrink-0 basis-[52px] grid place-items-center overflow-hidden border border-[var(--settings-border)] rounded-[var(--settings-radius-lg)] bg-bg-active text-accent font-bold text-[18px] font-[family-name:var(--mono)]">
              <Show when={avatar()} fallback={<>{(name().trim()[0] || '?').toUpperCase()}</>}>
                <img src={avatar()} alt="" class="w-full h-full object-cover" onError={e => { e.currentTarget.style.display = 'none' }} />
              </Show>
            </div>
            <div class="min-w-0"><strong class="block truncate text-text text-lg">{name().trim() || '未命名 Profile'}</strong><span class="block mt-1 truncate text-text-dim text-[11px] font-[family-name:var(--mono)]">{model() || '未选择默认模型'}</span></div>
          </div>
          <div class={SECTION_TITLE}>身份信息</div>
          <div class={FIELD}>
            <label class={LABEL} for="profile-name">名称</label>
            <input id="profile-name" class="pe-input settings-control" value={name()} onInput={e => setName(e.currentTarget.value)}
              placeholder="Profile 名称" autofocus />
          </div>
          <div class={FIELD}>
            <label class={LABEL} for="profile-avatar">头像 URL <span class="text-text-dim font-normal">可选</span></label>
            <input id="profile-avatar" class="pe-input settings-control" value={avatar()} onInput={e => setAvatar(e.currentTarget.value)}
              placeholder="https://... 或留空" />
          </div>
          <div class={SECTION_TITLE}>Persona</div>
          <div class={FIELD}>
            <label class={LABEL} for="profile-persona">系统提示词</label>
            <textarea id="profile-persona" class="pe-textarea settings-control min-h-[210px] font-[family-name:var(--mono)]" rows={8} value={persona()} onInput={e => setPersona(e.currentTarget.value)}
              placeholder="输入系统提示词..." />
            <p class="mt-[7px] text-text-dim text-sm leading-[1.5]">{persona().length} 字 · {persona() ? persona().split(/\r?\n/).length : 0} 行。新会话会冻结此 Persona；会话提示词将在其后叠加。</p>
          </div>
          <div class={SECTION_TITLE}>默认运行配置</div>
          <div class={FIELD}>
            <label class={LABEL} for="profile-model">默认模型</label>
            <Select id="profile-model" className="pe-select settings-control" value={model()} onChange={setModel} options={models().map(value => ({ value, label: value }))} />
          </div>
        </div>
        <div class="settings-dialog-footer shrink-0">
          <span class={dirty() ? 'text-accent text-sm' : 'text-text-dim text-sm'}>
            {dirty() ? '有未保存修改' : '所有修改已保存'}
          </span>
          <div class="settings-dialog-actions flex gap-2">
            <button class="min-w-[72px] settings-action" onClick={requestClose}>取消</button>
            <button class="min-w-[72px] settings-action primary" onClick={save} disabled={!name().trim()}>保存</button>
          </div>
        </div>
      </div>
    </div>
  )
}
