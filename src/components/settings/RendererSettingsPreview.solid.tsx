/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { createPreviewWorkbenchServices } from '../../renderers/solid-workbench/preview/previewWorkbenchServices.ts'
import { THEME_DEFAULTS, THEME_SETTING_KEYS } from '../../domains/theme/themeFieldDefs.ts'
import { useThemeStore } from '../../domains/theme/themeStore.ts'
import { getPluginSettingOptionsRegistry, getPresentationProfileRegistry, getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { resolveProductionRenderAppearance } from '../../plugin-runtime/renderers/productionRenderAppearance.ts'
import { resolveRendererSlot } from '../../plugin-runtime/renderers/rendererActivationResolver.ts'
import { createRegistrySignal } from '../../infrastructure/state/solidSheetSupport.solid.tsx'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import type { RenderAppearanceSnapshot, RenderCommandPort, RenderNodeSnapshot, RenderSurface } from '../../contracts/messageRenderer.ts'
import type { RendererRegistrySnapshot } from '../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RendererSettingsCatalogEntry } from './rendererSettingsCatalog.ts'
import type { SettingsContributionCatalog } from './settingsContributionCatalog.ts'

function contributionForEntry(entry: RendererSettingsCatalogEntry, catalog: RendererRegistrySnapshot) {
  if (entry.namespace === 'kind') return catalog.renderKinds.find(item => item.value.id === entry.id)?.value
  if (entry.namespace === 'suite') return catalog.rendererSuites.find(item => item.value.id === entry.id)?.value
  return catalog.rendererSlots.find(item => item.value.id === entry.id)?.value
}

function fixtureForKind(kind: string, catalog: RendererRegistrySnapshot): unknown {
  return catalog.renderKinds.find(item => item.value.id === kind)?.value.fixture ?? { text: `Fixture: ${kind}` }
}

const PREVIEW_KIND_PRIORITY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'markdown-text': ['content.markdown', 'content.text', 'content.search-result', 'content.link'],
  'code-terminal': ['content.code', 'content.terminal', 'content.ansi', 'content.log', 'content.diff'],
  reasoning: ['content.reasoning', 'content.redacted-reasoning'],
  'tool-activity': ['tool.output', 'tool.progress', 'tool.error', 'tool.generic'],
  workflow: ['activity.workflow', 'activity.subagent', 'activity.process'],
  'files-resources': ['content.file-reference', 'content.document', 'content.image'],
  'interaction-diagnostic': ['interaction.questions', 'diagnostic.lsp', 'session.usage'],
})

type PreviewState = 'default' | 'running' | 'completed' | 'failed' | 'streaming'

function previewStates(kind: string): readonly { readonly id: PreviewState; readonly label: string }[] {
  if (kind.startsWith('tool.')) return [
    { id: 'running', label: '运行中' },
    { id: 'completed', label: '已完成' },
    { id: 'failed', label: '失败' },
  ]
  if (kind === 'content.reasoning' || kind === 'content.redacted-reasoning') return [
    { id: 'running', label: '思考中' },
    { id: 'completed', label: '已完成' },
  ]
  if (kind === 'content.text' || kind === 'content.markdown') return [
    { id: 'default', label: '静态' },
    { id: 'streaming', label: '流式' },
  ]
  return []
}

function previewPayload(kind: string, payload: unknown, state: PreviewState): { readonly payload: unknown; readonly streaming: boolean } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { payload, streaming: state === 'streaming' }
  const value = payload as Record<string, unknown>
  if (kind.startsWith('tool.')) {
    if (state === 'running') return { payload: { ...value, status: 'running', result: undefined }, streaming: false }
    if (state === 'failed') return {
      payload: {
        ...value,
        status: 'failed',
        result: {
          status: 'failed',
          error: { userSummary: '预览工具失败', technicalMessage: 'preview failure', recoverability: 'none' },
        },
      },
      streaming: false,
    }
    if (state === 'completed') return {
      payload: {
        ...value,
        status: 'completed',
        result: { status: 'completed', parts: [{ kind: 'text', text: '预览工具输出已完成' }], durationMs: 420 },
      },
      streaming: false,
    }
  }
  if (kind === 'content.reasoning' || kind === 'content.redacted-reasoning') {
    return { payload: { ...value, state: state === 'running' ? 'running' : 'complete', durationMs: state === 'running' ? undefined : 3800 }, streaming: false }
  }
  return { payload, streaming: state === 'streaming' }
}

function pickPreviewKind(entry: RendererSettingsCatalogEntry, catalog: RendererRegistrySnapshot, activeSuiteId?: string): string {
  if (entry.namespace === 'kind') return entry.id
  const contribution = contributionForEntry(entry, catalog)
  const candidates = entry.namespace === 'suite'
    ? [...(contribution && 'requiredKinds' in contribution ? contribution.requiredKinds : []), ...(contribution && 'optionalKinds' in contribution ? contribution.optionalKinds ?? [] : [])]
    : [...(contribution && 'kinds' in contribution ? contribution.kinds : [])]
  const preferred = PREVIEW_KIND_PRIORITY[entry.placement.categoryId] ?? []
  const priority = new Map(preferred.map((kind, index) => [kind, index]))
  candidates.sort((left, right) => (priority.get(left) ?? preferred.length + 1) - (priority.get(right) ?? preferred.length + 1))
  const active = activeSuiteId ? catalog.rendererSuites.find(item => item.value.id === activeSuiteId)?.value : undefined
  const supported = active ? new Set([...active.requiredKinds, ...(active.optionalKinds ?? [])]) : undefined
  return candidates.find(kind => (!supported || supported.has(kind)) && catalog.renderKinds.some(item => {
    if (item.value.id !== kind) return false
    try { return item.value.validateInput(item.value.fixture) } catch { return false }
  }))
    ?? candidates.find(kind => catalog.renderKinds.some(item => item.value.id === kind))
    ?? 'content.unknown'
}

/** #520 S4-P1：预览选中 slot 与生产同序——套件上下文可用时直接走生产侧
 * resolveRendererSlot（fallback → priority → id 稳定序）；仅 kind 命名空间且无激活
 * 套件的退化态保持全套件视图（生产没有「无套件」形态，此处只保证成员不丢）。 */
function pickSlot(kind: string, catalog: RendererRegistrySnapshot, activeSuiteId?: string, preferredSlotId?: string) {
  const ordered = activeSuiteId
    ? resolveRendererSlot(activeSuiteId, kind, catalog.rendererSlots)
    : catalog.rendererSlots.filter(entry => entry.value.kinds.includes(kind))
  return ordered.find(entry => entry.value.id === preferredSlotId) ?? ordered[0]
}

function previewSuiteForEntry(entry: RendererSettingsCatalogEntry, catalog: RendererRegistrySnapshot, activeSuiteId?: string): string | undefined {
  if (entry.namespace === 'suite') return entry.id
  if (activeSuiteId) return activeSuiteId
  if (entry.namespace === 'slot') {
    const slot = catalog.rendererSlots.find(item => item.value.id === entry.id)?.value
    return slot?.targetSuites.find(suiteId => suiteId !== '*')
  }
  return undefined
}

/**
 * RendererSettingsPreview — Renderer 设置页真实示例预览（#515 Solid 实体；
 * 原同名 React 薄桥已随批7 退役，本实体为唯一形态）。surface 挂载 effect（依赖
 * entry/kind/suite/catalog/状态/选项贡献）以 createEffect + onCleanup 逐路回收，
 * 与原 React useEffect 的双 return 清理路径语义一致。
 */
export default function RendererSettingsPreview(props: {
  readonly entry?: RendererSettingsCatalogEntry
  readonly catalog: RendererRegistrySnapshot
  readonly activeSuiteId?: string
  readonly settingsCatalog?: SettingsContributionCatalog
}) {
  let host: HTMLDivElement | undefined
  const [error, setError] = createSignal<string | null>(null)
  const [previewState, setPreviewState] = createSignal<PreviewState>('default')
  const profileId = createZustandSignal(usePresentationPreferenceStore, state => state.activeProfileId)
  const optionRegistry = getPluginSettingOptionsRegistry()
  const optionSnapshot = createRegistrySignal(optionRegistry, () => optionRegistry.getSnapshot())
  const rendererSnapshot = () => props.settingsCatalog?.rendererSnapshot ?? props.catalog
  const previewSuiteId = () => props.entry ? previewSuiteForEntry(props.entry, rendererSnapshot(), props.activeSuiteId) : undefined
  const previewKind = () => props.entry ? pickPreviewKind(props.entry, rendererSnapshot(), previewSuiteId()) : ''
  const previewStateOptions = createMemo(() => previewStates(previewKind()))
  const effectivePreviewState = (): PreviewState => previewStateOptions().some(option => option.id === previewState())
    ? previewState()
    : previewStateOptions()[0]?.id ?? 'default'

  // 状态钮随预览对象切换回归默认档
  createEffect(() => {
    void previewKind()
    void props.entry?.id
    setPreviewState('default')
  })

  createEffect(() => {
    const hostElement = host
    const entry = props.entry
    if (!hostElement || !entry) return
    const kind = previewKind()
    const suiteId = previewSuiteId()
    const catalog = rendererSnapshot()
    const state = effectivePreviewState()
    const optionEntries = optionSnapshot().entries
    const profile = getPresentationProfileRegistry().resolve(profileId())?.value
    setError(null)
    const services = createPreviewWorkbenchServices()
    const themeSnapshot = () => Object.fromEntries(THEME_SETTING_KEYS.map(key => [key, useThemeStore.getState()[key]]))
    const applyHostTheme = () => {
      services.appearance.setTheme({ ...THEME_DEFAULTS, ...themeSnapshot() } as unknown as Parameters<typeof services.appearance.setTheme>[0])
    }
    applyHostTheme()
    let disposed = false
    let surface: RenderSurface | undefined
    let handle: unknown
    let unsubscribeError: (() => void) | undefined
    let unsubscribeSettings: (() => void) | undefined
    // 统一回收：原 React effect 的成功/失败两路 return 清理并作一路
    onCleanup(() => {
      disposed = true
      unsubscribeError?.()
      unsubscribeSettings?.()
      try { surface?.destroy(handle) } catch { /* renderer owns cleanup */ }
      services.destroy()
      hostElement.replaceChildren()
    })
    const activeSuite = catalog.rendererSuites.find(item => item.value.id === suiteId)?.value
    const slot = pickSlot(kind, catalog, suiteId, entry.namespace === 'slot' ? entry.id : undefined)
    if (!slot) {
      setError(`没有找到可渲染 ${kind} 的 Slot`)
      return
    }
    const variant = previewPayload(kind, fixtureForKind(kind, catalog), state)
    const node: RenderNodeSnapshot = {
      nodeId: `settings-preview:${entry.namespace}:${entry.id}`,
      kind,
      revision: 1,
      payload: variant.payload,
      streaming: variant.streaming,
    }
    const resolvedAppearance: RenderAppearanceSnapshot = resolveProductionRenderAppearance({
      hostAppearance: services.appearance.getSnapshot(),
      catalog,
      settings: getRendererSettingsStore().getSnapshot(),
      suiteId: suiteId ?? activeSuite?.id ?? '',
      slotId: slot.value.id,
      kind,
      profileKindTokens: profile?.kindTokens?.[kind],
      optionEntries,
    })
    const commands: RenderCommandPort = {
      execute: async command => {
        if (command.type === 'copy' && typeof command.payload === 'string') await services.commands.copy('preview-session', command.payload)
      },
      canExecute: () => false,
    }
    try {
      surface = slot.value.createSurface(node)
      handle = surface.mount(hostElement, node, resolvedAppearance, commands)
      unsubscribeError = surface.on('error', payload => setError(payload instanceof Error ? payload.message : String(payload)))
      const refreshSurface = () => {
        if (disposed || !surface) return
        try {
          const nextAppearance = resolveProductionRenderAppearance({
            hostAppearance: services.appearance.getSnapshot() as never,
            catalog,
            settings: getRendererSettingsStore().getSnapshot(),
            suiteId: suiteId ?? activeSuite?.id ?? '',
            slotId: slot.value.id,
            kind,
            profileKindTokens: profile?.kindTokens?.[kind],
            optionEntries,
          })
          surface.update(handle, node, nextAppearance)
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }
      unsubscribeSettings = getRendererSettingsStore().subscribe(refreshSurface)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  })

  return (
    <Show when={props.entry} fallback={<div class="renderer-settings-preview-empty">选择一个渲染对象查看真实示例。</div>}>
      <div class="renderer-settings-preview">
        <div class="renderer-settings-preview-head"><span>实时示例 / {props.entry!.namespace}</span><strong>{props.entry!.label}</strong></div>
        <Show when={previewStateOptions().length > 0}>
          <div class="renderer-settings-preview-states" aria-label="预览状态">
            <For each={previewStateOptions()}>{option => (
              <button type="button"
                class={effectivePreviewState() === option.id ? 'active' : ''}
                aria-pressed={effectivePreviewState() === option.id}
                onClick={() => setPreviewState(option.id)}>{option.label}</button>
            )}</For>
          </div>
        </Show>
        <div class="renderer-settings-preview-surface" ref={element => { host = element }} aria-label={`${props.entry!.label}真实预览`} />
        <Show when={error()}><div class="renderer-settings-preview-error" role="alert">预览回退：{error()}</div></Show>
        <small class="renderer-settings-preview-note">预览使用真实工作台示例与生产外观解析器；只读，不写入会话。</small>
      </div>
    </Show>
  )
}
