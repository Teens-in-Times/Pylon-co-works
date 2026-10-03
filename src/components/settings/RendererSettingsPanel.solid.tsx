/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { getPluginSettingOptionsRegistry, getPresentationProfileRegistry, getRendererRegistry, getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import type { PluginSettingOption } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'
import type { RendererSettingsStore } from '../../plugin-runtime/renderers/rendererSettingsStore.ts'
import { isSettingVisible, settingFieldKey, type RenderSettingField, type RendererSettingValue, type RendererSettingsPlacement, type RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { evaluateRenderSettingCondition, default as RendererSettingField } from './RendererSettingField.solid.tsx'
import RendererSuitePicker from './RendererSuitePicker.solid.tsx'
import { createRegistrySignal } from '../../infrastructure/state/solidSheetSupport.solid.tsx'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { findInterfaceModeContribution } from '../../app/interfaceModeLookup.ts'
import { resolveInterfaceModeSuite } from '../../application/transactions/activateInterfaceMode.ts'
import type { SettingsDensity } from '../../domains/appearance/settingsChromeStore.ts'
import { selectWorkbenchAppearance } from '../../domains/appearance/appearance.ts'
import { useThemeStore } from '../../domains/theme/themeStore.ts'
import { resolveProductionRendererSettingsScope } from '../../plugin-runtime/renderers/productionRenderAppearance.ts'
import { resolveFieldOptions, resolveRenderAppearance, type RenderAppearanceSource } from '../../plugin-runtime/renderers/renderAppearanceResolver.ts'
import { stringifySettingsTarget } from '../../plugin-runtime/settings/settingsTargetGrammar.ts'
import {
  projectRendererSettingsCatalog,
  rendererSettingsEntryKey,
  type RendererSettingsCatalogEntry,
} from './rendererSettingsCatalog.ts'
import type { SettingsContributionCatalog } from './settingsContributionCatalog.ts'

export interface RendererSettingsSchemaEntry {
  readonly id: string
  readonly label: string
  readonly schema: RendererSettingsSchema
  readonly namespace?: 'kind' | 'suite' | 'slot'
  readonly ownerPluginId?: string
  readonly placement?: RendererSettingsPlacement
}

interface RendererSettingsPanelProps {
  readonly schemas?: readonly RendererSettingsSchemaEntry[]
  readonly store?: RendererSettingsStore
  readonly search?: string
  readonly categoryId?: string
  readonly objectKey?: string
  readonly density?: SettingsDensity
  readonly onSelectionChange?: (entry: RendererSettingsCatalogEntry | undefined) => void
  readonly settingsCatalog?: SettingsContributionCatalog
}

function fieldMatches(field: RenderSettingField, query: string, options: readonly PluginSettingOption[]): boolean {
  if (!query) return true
  const haystack = [settingFieldKey(field), field.label, field.description, ...options.flatMap(option => [option.value, option.label, option.description])]
    .filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(query)
}

function optionTargetFor(entry: RendererSettingsCatalogEntry, fieldKey: string): string {
  // Keep first-party legacy keys stable; namespaced third-party owners use the
  // encoded structured grammar so dotted ids cannot collide.
  return entry.ownerPluginId && entry.ownerPluginId !== 'fixture' && !entry.ownerPluginId.startsWith('builtin.')
    ? stringifySettingsTarget({ namespace: entry.namespace, ownerId: entry.id, fieldKey, ownerPluginId: entry.ownerPluginId })
    : `${entry.namespace}.${entry.id}.${fieldKey}`
}

function entryMatches(
  entry: RendererSettingsCatalogEntry,
  query: string,
  optionEntries: Parameters<typeof resolvePluginSettingOptions>[2],
): boolean {
  if (!query) return true
  if ([entry.id, entry.label, entry.description, entry.ownerPluginId, entry.placement.categoryLabel]
    .filter(Boolean).join(' ').toLowerCase().includes(query)) return true
  return entry.schema.groups.some(group => group.fields.some(field => {
    const target = optionTargetFor(entry, settingFieldKey(field))
    const optionTarget = 'optionTarget' in field ? field.optionTarget ?? target : target
    const options = resolveFieldOptions(field, optionTarget, optionEntries)
    return fieldMatches(field, query, options)
  }))
}

function fixtureValues(
  entry: RendererSettingsCatalogEntry,
  snapshot: ReturnType<RendererSettingsStore['getSnapshot']>,
  hostDefaults: Readonly<Record<string, RendererSettingValue>>,
  optionEntries: Parameters<typeof resolvePluginSettingOptions>[2],
): { readonly values: Readonly<Record<string, RendererSettingValue>>; readonly sources: Readonly<Record<string, RenderAppearanceSource>> } {
  const namespace = entry.namespace + '.' + entry.id
  const scoped = (source: Readonly<Record<string, RendererSettingValue>>) => Object.fromEntries(Object.entries(source).flatMap(([key, value]) =>
    key.startsWith(namespace + '.') ? [[key.slice(namespace.length + 1), value] as const] : []))
  const availableOptions = Object.fromEntries(entry.schema.groups.flatMap(group => group.fields.flatMap(field => {
    if (field.type !== 'choice' && field.type !== 'multi-choice' && field.type !== 'color') return []
    const key = settingFieldKey(field)
    const target = optionTargetFor(entry, key)
    return [[key, resolveFieldOptions(field, target, optionEntries).map(option => option.value)] as const]
  })))
  return resolveRenderAppearance({
    schema: entry.schema,
    hostDefaults,
    userOverrides: scoped(snapshot.values),
    sessionPreview: scoped(snapshot.sessionPreview),
    availableOptions,
  })
}

const SOURCE_LABELS: Readonly<Record<RenderAppearanceSource, string>> = Object.freeze({
  'schema-default': '组件默认',
  'host-default': '宿主主题',
  'kind-default': '类型默认',
  profile: '呈现方案',
  'user-override': '你的覆盖',
  'session-preview': '临时预览',
})

function fixtureCatalog(entries: readonly RendererSettingsSchemaEntry[]): readonly RendererSettingsCatalogEntry[] {
  return entries.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    ownerPluginId: entry.ownerPluginId ?? 'fixture',
    namespace: entry.namespace ?? 'kind',
    schema: entry.schema,
    placement: entry.placement ?? {
      categoryId: 'fixture',
      categoryLabel: '示例',
      categoryOrder: 0,
      objectOrder: index,
      disclosure: 'essential',
    },
    active: true,
    fieldCount: entry.schema.groups.reduce((count, group) => count + group.fields.length, 0),
  }))
}

function RendererSettingsGroup(props: {
  entry: RendererSettingsCatalogEntry
  group: RendererSettingsSchema['groups'][number]
  namespace: string
  values: Readonly<Record<string, RendererSettingValue>>
  sources: Readonly<Record<string, RenderAppearanceSource>>
  query: string
  density: SettingsDensity
  store: RendererSettingsStore
  storeSnapshot: ReturnType<RendererSettingsStore['getSnapshot']>
  optionEntries: Parameters<typeof resolvePluginSettingOptions>[2]
}) {
  const [open, setOpen] = createSignal(!props.group.collapsedByDefault)
  createEffect(() => {
    if (props.query) setOpen(true)
  })
  const fields = () => props.group.fields.filter(field => {
    if (!isSettingVisible(field, props.density)) return false
    const target = optionTargetFor(props.entry, settingFieldKey(field))
    const optionTarget = 'optionTarget' in field ? field.optionTarget ?? target : target
    const options = resolveFieldOptions(field, optionTarget, props.optionEntries)
    const matches = fieldMatches(field, props.query, options)
    return matches && (!field.showIf || evaluateRenderSettingCondition(field.showIf, props.values) || Boolean(props.query && matches))
  })
  // 搜索无命中 → 整组不渲染（原 React 面「early return null」的 Show 等价）
  const visible = () => !(props.query && fields().length === 0)
  const advancedCount = () => props.group.fields.filter(field => field.advanced).length
  const resetGroup = () => {
    for (const field of props.group.fields) {
      const target = `${props.entry.namespace}.${props.entry.id}.${settingFieldKey(field)}`
      props.store.removeOverride(target)
      props.store.clearSessionPreview(target)
    }
  }

  return <Show when={visible()}>
    <section
      class={'renderer-settings-group' + (props.group.layout ? ' layout-' + props.group.layout : '')}
      data-group-anchor={props.entry.label + ' · ' + props.group.label}
    >
      <button type="button" class="renderer-settings-group-heading" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="renderer-settings-group-caret" aria-hidden="true">{open() ? '−' : '+'}</span>
        <span class="renderer-settings-group-copy">
          <strong>{props.group.label}</strong>
          <Show when={props.group.description}><small>{props.group.description}</small></Show>
        </span>
        <Show when={!open() && advancedCount() > 0}><span class="renderer-settings-group-meta">含 {advancedCount()} 项高级设置</span></Show>
        <span class="renderer-settings-group-count">{fields().length}</span>
      </button>
      <Show when={open()}>
        <div class="renderer-settings-fields">
          <div class="renderer-settings-group-actions">
            <span>{props.namespace}</span>
            <button type="button" onClick={event => { event.stopPropagation(); resetGroup() }}>恢复本组</button>
          </div>
          <For each={fields()}>{field => {
            const key = settingFieldKey(field)
            const target = `${props.entry.namespace}.${props.entry.id}.${key}`
            const optionTarget = () => 'optionTarget' in field ? field.optionTarget ?? optionTargetFor(props.entry, key) : optionTargetFor(props.entry, key)
            const options = () => resolveFieldOptions(field, optionTarget(), props.optionEntries)
            const hiddenByCondition = () => Boolean(field.showIf && !evaluateRenderSettingCondition(field.showIf, props.values))
            const storedValue = () => props.storeSnapshot.values[target]
            const unavailableValues = (): readonly string[] => {
              if (!('options' in field)) return []
              const current = storedValue()
              if (typeof current === 'string') return options().some(option => option.value === current) ? [] : [current]
              if (Array.isArray(current)) return (current as readonly unknown[]).filter((item): item is string => typeof item === 'string' && !options().some(option => option.value === item))
              return []
            }
            const unavailableCurrent = () => unavailableValues().length > 0
            const displayOptions = () => unavailableCurrent()
              ? [...options(), ...unavailableValues().map(value => ({ value, label: `不可用：${value}`, disabled: true }))]
              : options()
            const displayValue = () => unavailableCurrent() ? storedValue() : props.values[key]
            return <div
              class={'renderer-settings-field-row' + (hiddenByCondition() ? ' renderer-settings-field-match' : '')}
              data-search-anchor={`renderer:${rendererSettingsEntryKey(props.entry)}:${props.group.id}:${key}`}>
              <Show when={hiddenByCondition()}><div class="set-hint">条件尚未满足；搜索临时揭示此字段</div></Show>
              <Show when={unavailableCurrent()}><div class="set-hint" role="status">当前值“{String(storedValue())}”已不可用；保留原值等待插件恢复。</div></Show>
              <RendererSettingField
                field={field}
                value={displayValue()}
                options={displayOptions()}
                onChange={value => {
                  props.store.setOverride(target, value)
                  props.store.clearSessionPreview(target)
                }}
                onPreviewChange={value => props.store.setSessionPreview({ ...props.store.getSnapshot().sessionPreview, [target]: value })}
                onPreviewCommit={() => props.store.clearSessionPreview(target)}
                onReset={() => {
                  props.store.removeOverride(target)
                  props.store.clearSessionPreview(target)
                }}
              />
              <div class="renderer-setting-provenance">
                <span>{SOURCE_LABELS[props.sources[key] ?? 'schema-default']}</span>
                <Show when={field.scope}><span data-setting-scope={field.scope}>scope: {field.scope}</span></Show>
                <Show when={field.inheritsFrom}><span>继承自 {field.inheritsFrom}</span></Show>
                <Show when={field.semanticKey}><span>semantic: {field.semanticKey}</span></Show>
                <code>{target}</code>
              </div>
            </div>
          }}</For>
        </div>
      </Show>
    </section>
  </Show>
}

export default function RendererSettingsPanel(props: RendererSettingsPanelProps) {
  // store 注入（fixture/integration）在挂载期定型；宿主面走单例。
  const store = props.store ?? getRendererSettingsStore()
  const storeSnapshot = createRegistrySignal(store, () => store.getSnapshot())
  const liveRegistrySnapshot = createRegistrySignal(getRendererRegistry(), () => getRendererRegistry().snapshot())
  const registrySnapshot = () => props.settingsCatalog?.rendererSnapshot ?? liveRegistrySnapshot()
  const optionSnapshot = createRegistrySignal(getPluginSettingOptionsRegistry(), () => getPluginSettingOptionsRegistry().getSnapshot())
  const presentationProfileRegistry = getPresentationProfileRegistry()
  const presentationProfiles = createRegistrySignal(presentationProfileRegistry, () => presentationProfileRegistry.getSnapshot())
  const interfaceMode = createZustandSignal(useInterfaceModeStore, state => state.interfaceMode)
  // selector 不读组件局部信号（solidStoreBridge ⚠️）——suite 偏好并成整片信号后在此处索引
  const rendererSuiteIdByMode = createZustandSignal(usePresentationPreferenceStore, state => state.rendererSuiteIdByMode)
  const activeProfileId = createZustandSignal(usePresentationPreferenceStore, state => state.activeProfileId)
  const activeSuiteId = createMemo(() => {
    const mode = findInterfaceModeContribution(interfaceMode())
    return mode?.workbench.renderKind === 'renderer-suite'
      ? resolveInterfaceModeSuite(mode, rendererSuiteIdByMode()[interfaceMode()], registrySnapshot().rendererSuites.map(entry => entry.value.id)).activeSuiteId
      : undefined
  })
  const entries = createMemo(() => props.schemas
    ? fixtureCatalog(props.schemas)
    : (props.settingsCatalog?.renderer ?? projectRendererSettingsCatalog(registrySnapshot(), activeSuiteId())).entries)
  const query = () => props.search?.trim().toLowerCase() ?? ''
  const categoryId = () => props.categoryId ?? (props.schemas ? 'fixture' : 'foundation')
  const density = () => props.density ?? 'standard'
  const candidates = createMemo(() => entries().filter(entry => {
    const needle = query()
    if (needle) return entryMatches(entry, needle, optionSnapshot().entries)
    if (categoryId() === 'advanced-catalog') return true
    return entry.active && entry.placement.categoryId === categoryId()
  }))
  const [selectedKey, setSelectedKey] = createSignal('')
  const selected = createMemo(() => candidates().find(entry => rendererSettingsEntryKey(entry) === selectedKey()) ?? candidates()[0])
  const activeObjectKey = () => selected() ? rendererSettingsEntryKey(selected()!) : ''
  const selectedResolution = createMemo(() => {
    if (!selected()) return { values: {}, sources: {} }
    if (props.schemas) return fixtureValues(selected()!, storeSnapshot(), selectWorkbenchAppearance(useThemeStore.getState(), 0) as unknown as Readonly<Record<string, RendererSettingValue>>, optionSnapshot().entries)
    const profile = presentationProfiles().entries.find(entry => entry.contributionId === activeProfileId())?.value
    return resolveProductionRendererSettingsScope({
      hostAppearance: selectWorkbenchAppearance(useThemeStore.getState(), 0),
      catalog: registrySnapshot(),
      settings: storeSnapshot(),
      namespace: selected()!.namespace,
      id: selected()!.id,
      profileKindTokens: profile?.kindTokens?.[selected()!.id],
      optionEntries: optionSnapshot().entries,
    })
  })

  // objectKey 外部定位（sheet 持久化路由 / 速搜命中）优先，回退首项
  createEffect(() => {
    const objectKey = props.objectKey
    const list = candidates()
    if (objectKey && list.some(entry => rendererSettingsEntryKey(entry) === objectKey)) {
      setSelectedKey(objectKey)
      return
    }
    const nextKey = list[0] ? rendererSettingsEntryKey(list[0]) : ''
    if (!list.some(entry => rendererSettingsEntryKey(entry) === selectedKey())) setSelectedKey(nextKey)
  })
  createEffect(() => { props.onSelectionChange?.(selected()) })

  return <section class="renderer-settings-panel" aria-label="渲染器设置">
    <Show when={!props.schemas}><RendererSuitePicker /></Show>
    <Show when={candidates().length > 0}>
      <div class="renderer-settings-ledger">
        <nav class="renderer-settings-object-index" aria-label="Renderer 设置对象">
          <div class="renderer-settings-object-index-head">
            <span>{query() ? 'SEARCH RESULTS' : selected()?.placement.categoryLabel}</span>
            <strong>{candidates().length} objects</strong>
          </div>
          <For each={candidates()}>{entry => {
            const key = rendererSettingsEntryKey(entry)
            return <button type="button"
              class={'renderer-settings-object' + (key === activeObjectKey() ? ' active' : '')}
              onClick={() => setSelectedKey(key)}>
              <span>{entry.label}</span>
              <small>{entry.namespace} · {entry.fieldCount}</small>
            </button>
          }}</For>
        </nav>
        <Show when={selected()}>
          <div class="renderer-settings-inspector">
            <header class="renderer-settings-object-header">
              <div>
                <span>{selected()!.namespace.toUpperCase()} / {selected()!.id}</span>
                <h3>{selected()!.label}</h3>
                <Show when={selected()!.description}><p>{selected()!.description}</p></Show>
              </div>
              <div class="renderer-settings-owner">
                <span>{selected()!.active ? 'ACTIVE' : 'AVAILABLE'}</span>
                <small>{selected()!.ownerPluginId}</small>
                <Show when={!selected()!.compatibilityOnly}>
                  <button type="button" onClick={() => store.reset(selected()!.namespace + '.' + selected()!.id)}>恢复当前对象</button>
                </Show>
              </div>
            </header>
            <Show when={selected()!.compatibilityOnly} fallback={
              <For each={selected()!.schema.groups}>{group => <RendererSettingsGroup
                entry={selected()!}
                group={group}
                namespace={selected()!.namespace + '.' + selected()!.id}
                values={selectedResolution().values}
                sources={selectedResolution().sources}
                query={query()}
                density={density()}
                store={store}
                storeSnapshot={storeSnapshot()}
                optionEntries={optionSnapshot().entries}
              />}</For>
            }>
              <div class="set-hint renderer-settings-compatibility" role="status">
                该 Kind 设置已迁移至共享 Slot；此处仅保留旧 key 的兼容读取与诊断，不提供重复编辑表单。
                <Show when={selected()!.compatibilityFieldCount}>（兼容字段 {selected()!.compatibilityFieldCount} 项）</Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
    <For each={Object.entries(storeSnapshot().unavailable)}>{([key, value]) => <div class="renderer-setting-unavailable">
      <span>{key}：{String(value)}（不可用，等待插件恢复）</span>
      <button type="button" onClick={() => store.restoreUnavailable(key)}>恢复</button>
    </div>}</For>
    <Show when={candidates().length === 0 && Object.keys(storeSnapshot().unavailable).length === 0}>
      <div class="settings-empty-state renderer-settings-empty">
        <span class="settings-empty-kicker">Renderer catalog</span>
        <h3>{query() ? '没有匹配的 Renderer 设置' : '当前类别暂无可配置对象'}</h3>
        <p>{query() ? '换一个关键词，或进入高级目录查看完整 Suite / Slot / Kind。' : '参数所有者尚未为此类别贡献 schema。'}</p>
      </div>
    </Show>
  </section>
}
