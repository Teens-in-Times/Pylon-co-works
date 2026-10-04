/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { FolderSearch } from 'lucide'
import { appClients } from '../../app/appClients.ts'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import { open } from '@tauri-apps/plugin-dialog'
import { useWorkspaceEntityStore } from '../../domains/workspace/workspaceEntityStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import type { Workspace } from '../../domains/workspace/workspaceEntities'
import { isAbsolutePath } from '../../domains/workspace/workspaceEntities'
import { buildCapabilityOptions } from '../../domains/workspace/capabilityOptions.ts'
import { getPluginRuntime } from '../../plugin-runtime/pluginCompositionRoot.ts'

interface CwdSettingsPanelProps {
  workspace: Workspace
  onClose: () => void
  showHeader?: boolean
}

interface McpOption { id?: string; name?: string; transport?: string; enabled?: boolean; disabled?: boolean }

function parseList(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function ListPreview(props: { value: string; onChange: (value: string) => void; empty: string }) {
  const items = () => parseList(props.value)
  return (
    <Show when={items().length > 0} fallback={<span class="cwd-tag-empty">{props.empty}</span>}>
      <div class="cwd-tag-list" role="list">
        <For each={items()}>{item => (
          <button type="button" role="listitem" class="cwd-tag" title={`移除 ${item}`} onClick={() => props.onChange(items().filter(candidate => candidate !== item).join(', '))}>
            <span>{item}</span><LucideIcon name="X" size={11} />
          </button>
        )}</For>
      </div>
    </Show>
  )
}

function StructuredIdField(props: { label: string; value: string; onChange: (value: string) => void; placeholder: string; empty: string }) {
  const items = () => parseList(props.value)
  return <>
    <input class="settings-control" aria-label={`${props.label}（逗号分隔）`} value={props.value} onInput={event => props.onChange(event.currentTarget.value)} placeholder={props.placeholder} />
    <small>可输入多个 id（逗号分隔），下面的标签可单独移除。</small>
    <ListPreview value={props.value} onChange={props.onChange} empty={props.empty} />
    <Show when={items().length > 0}><span class="set-hint" aria-live="polite">已选择 {items().length} 项</span></Show>
  </>
}

/** #515：CwdSettingsPanel 的 Solid 实体（原 .tsx 为 React 薄桥）。 */
export default function CwdSettingsPanel(props: CwdSettingsPanelProps) {
  const updateWorkspace = useWorkspaceEntityStore.getState().updateWorkspace
  const [name, setName] = createSignal(props.workspace.name)
  const [rootPath, setRootPath] = createSignal(props.workspace.rootPath)
  const [skills, setSkills] = createSignal(props.workspace.skills.join(', '))
  const [hookIds, setHookIds] = createSignal<string[]>([...props.workspace.hookPluginIds])
  // 已激活插件 id（hook opt-in picker 数据源；快照经字符串原语保持引用稳定）
  const runtime = getPluginRuntime()
  const [activePluginIdsRev, setActivePluginIdsRev] = createSignal(0)
  onCleanup(runtime.subscribe(() => setActivePluginIdsRev(n => n + 1)))
  const activePluginIds = createMemo(() => {
    void activePluginIdsRev()
    return runtime.snapshot().active.map(identity => identity.pluginId)
  })
  const [mcpIds, setMcpIds] = createSignal<Set<string>>(new Set(props.workspace.mcpServerIds))
  const [mcpOptions, setMcpOptions] = createSignal<McpOption[]>([])
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [saveErrorIsValidation, setSaveErrorIsValidation] = createSignal(false)

  // workspace 字段变化 → 本地编辑态整体重置（对齐原 useEffect 依赖组）
  createEffect(() => {
    void props.workspace.id
    setName(props.workspace.name)
    setRootPath(props.workspace.rootPath)
    setSkills(props.workspace.skills.join(', '))
    setHookIds([...props.workspace.hookPluginIds])
    setMcpIds(new Set(props.workspace.mcpServerIds))
    setSaveError(null)
    setSaveErrorIsValidation(false)
  })

  createEffect(() => {
    const workspaceId = props.workspace.id
    let disposed = false
    appClients.agent()
      .getMcpServers()
      .then(list => {
        if (!disposed) {
          setMcpOptions(list as McpOption[])
          resolveRuntimeErrors({ key: `cwd:${workspaceId}:mcp` })
        }
      })
      .catch(error => {
        if (!disposed) reportRuntimeError('读取 MCP 配置', error, undefined, {
          key: `cwd:${workspaceId}:mcp`, scope: { kind: 'operation', id: `cwd:${workspaceId}:mcp` }, source: 'settings.cwd',
        })
      })
    onCleanup(() => { disposed = true })
  })

  const dirty = createMemo(() => (
    name().trim() !== props.workspace.name
    || rootPath().trim() !== props.workspace.rootPath
    || parseList(skills()).join('\u0000') !== props.workspace.skills.join('\u0000')
    || [...hookIds()].sort().join('\u0000') !== [...props.workspace.hookPluginIds].sort().join('\u0000')
    || [...mcpIds()].sort().join('\u0000') !== [...props.workspace.mcpServerIds].sort().join('\u0000')
  ))

  const mcpCapabilities = createMemo(() => buildCapabilityOptions(
    'mcp',
    mcpOptions().flatMap(option => {
      const id = option.id ?? option.name ?? ''
      return id ? [{ id, label: option.name ?? id, source: 'agent' }] : []
    }),
    [...mcpIds()],
  ))

  const pickRootPath = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '更换工作区文件夹' })
      if (typeof selected === 'string') {
        setRootPath(selected)
        setSaveError(null)
        setSaveErrorIsValidation(false)
      }
    } catch (error) {
      setSaveErrorIsValidation(false)
      setSaveError('无法打开文件夹选择器，详情见右下角错误中心')
      reportRuntimeError('打开工作区选择器', error, undefined, {
        key: `cwd:${props.workspace.id}:picker`, scope: { kind: 'operation', id: `cwd:${props.workspace.id}:picker` }, source: 'settings.cwd',
      })
    }
  }

  const cancel = () => {
    if (dirty() && typeof window.confirm === 'function' && !window.confirm('放弃未保存的工作区设置？')) return
    props.onClose()
  }

  const save = async () => {
    if (!name().trim()) { setSaveErrorIsValidation(true); setSaveError('工作区名称不能为空'); return }
    if (!isAbsolutePath(rootPath().trim())) { setSaveErrorIsValidation(true); setSaveError('工作目录必须是绝对路径'); return }
    setSaving(true)
    setSaveError(null)
    setSaveErrorIsValidation(false)
    try {
      await updateWorkspace(props.workspace.id, {
        name: name().trim(),
        rootPath: rootPath().trim(),
        skills: parseList(skills()),
        mcpServerIds: [...mcpIds()],
        hookPluginIds: hookIds(),
      })
      resolveRuntimeErrors({ key: `cwd:${props.workspace.id}:save` })
      props.onClose()
    } catch (error) {
      setSaveErrorIsValidation(false)
      setSaveError('保存工作区设置失败，详情见右下角错误中心')
      reportRuntimeError('保存工作区设置', error, undefined, {
        key: `cwd:${props.workspace.id}:save`, scope: { kind: 'sheet', id: props.workspace.id }, source: 'settings.cwd',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="cwd-settings settings-surface">
      <Show when={props.showHeader !== false}>
        <div class="cwd-settings-head">
          <span class="cwd-group-name">{props.workspace.name}</span>
          <button class="cwd-settings-close" onClick={cancel} title="关闭工作区设置" aria-label="关闭工作区设置"><LucideIcon name="X" size={14} /></button>
        </div>
      </Show>

      <section class="cwd-settings-section" aria-labelledby="cwd-basic-title">
        <div class="cwd-settings-section-head">
          <div><h3 id="cwd-basic-title">基本信息</h3><p>名称用于识别；目录决定新会话的默认工作位置。</p></div>
        </div>
        <label class="sess-field">
          <span>工作区名称</span>
          <input aria-label="工作区名称" class="settings-control" value={name()} onInput={event => setName(event.currentTarget.value)} />
        </label>

        <label class="sess-field">
          <span>工作目录</span>
          <div class="cwd-path-control">
            <input aria-label="工作目录" class="settings-control cwd-root-input" value={rootPath()} onInput={event => setRootPath(event.currentTarget.value)} />
            <button type="button" class="settings-action cwd-path-picker" onClick={() => void pickRootPath()} aria-label="重新选择工作目录"><LucideIcon node={FolderSearch} name="FolderSearch" size={14} /><span>选择</span></button>
          </div>
          <small>更改后仅影响新建会话；已有会话保留自己的目录快照。</small>
        </label>
      </section>

      <section class="cwd-settings-section" aria-labelledby="cwd-capabilities-title">
        <div class="cwd-settings-section-head">
          <div><h3 id="cwd-capabilities-title">新会话能力</h3><p>由插件系统在创建会话时注入 Tool、MCP、Skill 等能力提示。</p><p><strong>仅在新建会话时生效；已有会话保持不变。</strong></p></div>
        </div>
        <label class="sess-field">
          <span>Skills（逗号分隔）</span>
          <StructuredIdField label="Skills" value={skills()} onChange={setSkills} placeholder="code-review, trpg-master" empty="尚未指定 Skill" />
        </label>

        <div class="sess-field">
          <span>Hook 插件（会话 opt-in）</span>
          <small>勾选的插件才有权在本工作区新建会话中执行钩子；快照随会话创建固定。</small>
          <For each={hookIds().filter(id => !activePluginIds().includes(id))}>{id => (
            <label class="cwd-check">
              <input type="checkbox" checked disabled readOnly aria-label={`保留未激活 Hook 插件 ${id}`} />
              <span>{id}（未激活，保留声明）</span>
              <button
                type="button"
                class="settings-action"
                aria-label={`移除未激活 Hook 插件 ${id}`}
                onClick={() => setHookIds(current => current.filter(candidate => candidate !== id))}
              >
                移除
              </button>
            </label>
          )}</For>
          <Show when={activePluginIds().length === 0 && hookIds().every(id => !activePluginIds().includes(id))}>
            <div class="set-hint">暂无已激活插件可供勾选。</div>
          </Show>
          <For each={activePluginIds()}>{id => (
            <label class="cwd-check">
              <input
                type="checkbox"
                checked={hookIds().includes(id)}
                aria-label={`Hook 插件 ${id}`}
                onChange={event => {
                  setHookIds(current => (
                    event.currentTarget.checked ? [...current, id] : current.filter(candidate => candidate !== id)
                  ))
                }}
              />
              <span>{id}</span>
            </label>
          )}</For>
        </div>

        <div class="sess-field">
          <span>MCP 服务</span>
          <Show when={mcpOptions().length === 0}>
            <div class="set-hint">
              当前 Agent 未提供可选 MCP 服务。
              <button
                type="button"
                class="settings-action"
                style={{ 'margin-left': '8px' }}
                onClick={() => window.dispatchEvent(new CustomEvent('pylon:open-settings', {
                  detail: { domain: 'agents-connections', section: 'agent' },
                }))}
              >
                配置 Agent
              </button>
            </div>
          </Show>
          <For each={mcpCapabilities()}>{option => {
            const key = option.id
            const checked = () => option.enabled
            return (
              <label class="cwd-check">
                <input type="checkbox" checked={checked()} onChange={e => {
                  const next = new Set(mcpIds())
                  if (e.currentTarget.checked) next.add(key)
                  else next.delete(key)
                  setMcpIds(next)
                }} />
                <span>{option.label}（{mcpOptions().find(candidate => (candidate.id ?? candidate.name) === key)?.transport ?? '不可用'}）{option.available ? '' : ` · ${option.diagnostic}`}</span>
              </label>
            )
          }}</For>
        </div>
      </section>

      <Show when={saveError()}>
        <Show when={saveErrorIsValidation()} fallback={<div class="set-hint cwd-settings-error" role="status">{saveError()}</div>}>
          <div class="set-hint cwd-settings-error" role="alert">{saveError()}</div>
        </Show>
      </Show>
      <div class="cwd-settings-footer">
        <span class={`cwd-settings-dirty ${dirty() ? 'active' : ''}`} role="status">{dirty() ? '有未保存的更改' : '所有更改已保存'}</span>
        <div class="sess-field-actions">
          <button class="settings-action" onClick={cancel}>取消</button>
          <button class="settings-action primary" disabled={saving() || !dirty()} onClick={() => void save()}>{saving() ? '保存中…' : '保存更改'}</button>
        </div>
      </div>
    </div>
  )
}
