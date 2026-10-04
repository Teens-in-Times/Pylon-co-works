/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { getContextPanelRegistry, getPluginSettingOptionsRegistry, getPluginSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginSettingsValueAdapter } from '../../plugin-runtime/settings/pluginSettingsStore.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import { settingFieldKey, type SettingsValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { selectContextPanels, resolveContextPanelDefault } from '../../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore } from '../../domains/workspace/layoutRailsStore.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { createRegistrySignal } from '../../infrastructure/state/solidSheetSupport.solid.tsx'
import { PluginContributionBody } from '../../plugin-runtime/ui/PluginContributionBody.solid.tsx'
import { RendererSettingsSchemaHost } from '../settings/RendererSettingField.solid.tsx'
import type { ContextPanelHostProps } from './rightPanelTypes.ts'

const EMPTY_ADAPTER_SNAPSHOT = Object.freeze({ values: Object.freeze({}), unavailable: Object.freeze({}), revision: 0 })

/**
 * ContextPanelHost — 右栏宿主（面板外壳：aside/头部/切换器；贡献体直连渲染）。
 *
 * #515 贡献面翻转：插件贡献体自本批起是 **Solid 组件**（React 岛 ContextPanelPluginIsland
 * 退役）。#520 S4-P1-5：贡献体分发（PluginContributionBoundary + isolated/first-party
 * 分支 + Suspense）收进 PluginContributionBody；schema 设置面直连
 * RendererSettingsSchemaHost（Solid 实体）并经 `prefix` 与贡献体共处同一错误边界。
 * 贡献标识（owner 运行实例 + 贡献 id）作为 keyed 粒度传入 body——热替换/停用换实例
 * 时整个边界（含错误态）重置。
 */
export default function ContextPanelHost(props: ContextPanelHostProps) {
  const rightWidth = createZustandSignal(useRightRailStore, state => state.width)
  const registry = getContextPanelRegistry()
  const store = getPluginSettingsStore()
  const optionsRegistry = getPluginSettingOptionsRegistry()
  const snapshot = createRegistrySignal(registry, () => registry.getSnapshot())
  // 可切换的面板 = 通过 `when` 闸门的全部面板（与 Sheet 种类无关）；种类只影响「没选过时默认看谁」。
  const entries = createMemo(() => selectContextPanels(snapshot().entries, {
    workspaceKind: props.sheet.kind,
    sheetId: props.sheet.id,
    activeSessionId: props.ctx.activeSession,
  }))
  const [activeId, setActiveId] = createSignal<string>(props.activePanelId ?? '')
  createEffect(() => {
    if (props.activePanelId !== undefined) setActiveId(props.activePanelId ?? '')
  })
  const active = createMemo(() => entries().find(entry => entry.contributionId === activeId())
    ?? resolveContextPanelDefault(entries(), props.sheet.kind))

  const adapter = createMemo(() => {
    const current = active()
    return current?.value.schema
      ? current.value.valueAdapter ?? (current.ownerPluginId
        ? createPluginSettingsValueAdapter({ store, ownerPluginId: current.ownerPluginId, contributionId: current.contributionId, namespace: 'context-panel' })
        : undefined)
      : undefined
  })
  const [adapterSnapshot, setAdapterSnapshot] = createSignal(adapter()?.getSnapshot() ?? EMPTY_ADAPTER_SNAPSHOT)
  createEffect(() => {
    const current = adapter()
    setAdapterSnapshot(current?.getSnapshot() ?? EMPTY_ADAPTER_SNAPSHOT)
    if (current) {
      onCleanup(current.subscribe(() => setAdapterSnapshot(current.getSnapshot())))
    }
  })
  const optionSnapshot = createRegistrySignal(optionsRegistry, () => optionsRegistry.getSnapshot())

  // choice/multi-choice/color 字段的 option 投影（框架无关计算留在宿主侧）。
  const schemaOptions = createMemo(() => {
    const current = active()
    if (!current?.value.schema || !adapter()) return {}
    return Object.fromEntries(current.value.schema.groups.flatMap(group => group.fields.map(field => {
      const key = settingFieldKey(field)
      if (field.type !== 'choice' && field.type !== 'multi-choice' && field.type !== 'color') return []
      const target = 'optionTarget' in field && field.optionTarget
        ? field.optionTarget
        : `context-panel.${encodeURIComponent(current.ownerPluginId ?? '').replaceAll('.', '%2E')}.${encodeURIComponent(current.contributionId).replaceAll('.', '%2E')}.${encodeURIComponent(key).replaceAll('.', '%2E')}`
      const base = 'options' in field ? field.options : []
      return [[key, resolvePluginSettingOptions(target, base, optionSnapshot().entries)]] as const
    })))
  })

  const onSurfaceEvent = (event: string, detail: unknown) => {
    if (event === 'host:collapse') {
      useRightRailStore.getState().setCollapsed(true)
    }
    if (event === 'host:select-session' && (typeof detail === 'string' || detail === null)) props.ctx.selectSession(detail)
    if (event === 'settings:set' && detail && typeof detail === 'object') {
      const current = adapter()
      if (current) {
        const { key, value } = detail as { key?: unknown; value?: unknown }
        if (typeof key === 'string') void current.setValue(key, value as SettingsValue)
      }
    }
    if (event === 'settings:remove' && typeof detail === 'string') {
      const current = adapter()
      if (current) void current.removeValue(detail)
    }
  }

  /** 激活面板贡献体：schema 设置面 + 贡献内容（first-party 组件 / isolated surface）。 */
  const PanelBody = () => (
    // #520 S4-P1-5：分发块收敛进 PluginContributionBody——schema 设置面经 `prefix`
    // 留在同一错误边界内、贡献体之前；keyed 粒度 = 贡献对象（body 内建）：热替换/
    // 停用换实例时整个边界（含错误态）重置。
    <PluginContributionBody
      contributionId={active()?.contributionId ?? ''}
      contribution={active()?.value}
      prefix={() => {
        const current = active()
        if (!current?.value.schema || !adapter()) return null
        return (
          <RendererSettingsSchemaHost
            schema={current.value.schema}
            anchorPrefix={`schema:${current.contributionId}`}
            values={adapterSnapshot().values}
            unavailable={adapterSnapshot().unavailable}
            options={schemaOptions()}
            onChange={(key, value) => { void adapter()?.setValue(key, value) }}
            onReset={key => { void adapter()?.reset(key) }}
            onRestoreUnavailable={key => { adapter()?.restoreUnavailable?.(key) }}
          />
        )
      }}
      surfaceClass="context-panel-plugin-surface"
      surfaceInput={() => ({
        workspaceKind: props.sheet.kind,
        sheet: { id: props.sheet.id, kind: props.sheet.kind, title: props.sheet.title, agentId: props.sheet.agentId, metadata: props.sheet.metadata },
        activeSessionId: props.ctx.activeSession,
        values: adapterSnapshot().values,
      })}
      onSurfaceEvent={onSurfaceEvent}
      componentProps={() => ({ sheet: props.sheet, ctx: props.ctx })}
    />
  )

  return (
    <Show when={active()}>{current => (
      // aria-label 用稳定文案（#250）：sheet.title 是建会话时刻的快照，会话切换/
      // 重命名后陈旧，实机 a11y 树出现指向过期会话的右栏名；归属上下文已由页签与
      // 下方面板 tablist 承载，这里不需要会话名。
      <aside class="context-panel" data-sheet-kind={props.sheet.kind} aria-label="右栏" style={{ '--right-width': `${rightWidth()}px` }}>
        <div class="context-panel-head">
          {/* 切换器列出**所有可显示的面板**（`when` 闸门之上的全部），不再按 Sheet 种类裁剪：
              按种类裁剪时，单面板的 Sheet 只剩一个撑满的标签，看上去是标题而不是切换器
              （用户实机报「侧栏内部没有切换侧栏种类的按钮」）。 */}
          <div class="context-panel-tabs" role="tablist" aria-label="右栏面板">
            <For each={entries()}>{entry => (
              <button
                type="button"
                role="tab"
                aria-selected={entry.contributionId === current().contributionId}
                class={`context-panel-mode ${entry.contributionId === current().contributionId ? 'active' : ''}`}
                title={entry.value.label}
                onClick={() => {
                  // 选择要落到 store（而不仅是本地 state）：它是「用户显式选过」的唯一凭据——
                  // 决定跨 Sheet 是否保持、重载后是否还记得。只写本地 state 的话，切一次 Sheet
                  // 就会被亲和默认值抢回去。
                  setActiveId(entry.contributionId)
                  useRightRailStore.getState().setActivePanel(entry.contributionId)
                }}
              >
                {entry.value.label}
              </button>
            )}</For>
          </div>
        </div>
        <div class="context-panel-body">
          <PanelBody />
        </div>
      </aside>
    )}</Show>
  )
}
