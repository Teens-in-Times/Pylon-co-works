/**
 * presetActions — 自定义预设的「保存 / 应用」事务动作（原 themeStore 内嵌实现）。
 *
 * store 只留 set/get 注入薄壳；事务骨架（provider registry 组装、快照、提交/回滚、
 * 失败分类、应用期串行队列）集中在本模块，可脱离 zustand 实例做确定性行为测试
 * （结构审查 A-V5：130 行事务逻辑不再内嵌 store 文件）。
 */
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { createCustomPresetId, normalizeCustomPresetId, pickCustomPresetTheme } from './customPresets.ts'
import { THEME_PRESET_KEYS } from './themeFieldDefs.ts'
import { applyCustomPresetReducer, saveCustomPresetReducer, toThemeDelta } from './presetReducer.ts'
import { getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import {
  adaptLegacyThemePreset,
  createPresetBundle,
  markUnavailablePresetProviders,
  normalizePresetBundle,
  preparePresetBundle,
  PresetProviderTransactionError,
  recordPayload,
  type PresetApplyResult,
  type PresetJsonValue,
  type RendererPresetPayload,
} from './presetBundle.ts'
import { createFirstPartyPresetProviderRegistry } from './firstPartyPresetProviders.ts'
import { recordSettingWrites } from './settingProvenance.ts'
import type { ThemeState } from './themeStore.ts'
import type { CustomPresetState } from './customPresetStore.ts'

/**
 * store 注入面：与 zustand set/get 形态结构等价（不引运行时，只约束用法子集）。
 * #448 PR5：预设切片拆独立 store 后，这里是**合成视图**——get 合并 themeStore 与
 * customPresetStore，set 由注入方按字段路由（customPresets/zonePresetEntries 落
 * customPresetStore，主题字段落 themeStore）；事务骨架（快照/回滚/串行队列）零改动。
 */
export interface PresetStoreApi {
  get: () => ThemeState & CustomPresetState
  set: (partial: Partial<ThemeState & CustomPresetState> | ((state: ThemeState & CustomPresetState) => Partial<ThemeState & CustomPresetState>)) => void
}

let customPresetApplyRevision = 0
let customPresetApplyTail: Promise<void> = Promise.resolve()

export function saveCustomPresetAction(name: string, id: string | undefined, api: PresetStoreApi): string {
  const { get, set } = api
    const state = get()
    const now = Date.now()
    // id/now 由 shell 注入：reducer 保持确定性（A0 起，预设逻辑可做确定性行为测试）
    const requestedId = typeof id === 'string' && id.trim() ? id.trim() : undefined
    const existing = requestedId
      ? state.customPresets.find(preset => preset.id === requestedId)
      : undefined
    // An explicit id means “overwrite this preset”.  Silently falling back to
    // a new id makes a stale row look like a no-op (and can create duplicates)
    // after persisted data has been migrated or a mode switch rebuilt the UI.
    if (requestedId && !existing) throw new Error('要覆盖的自定义预设不存在')
    const resolvedId = existing?.id
      ?? createCustomPresetId(now, state.customPresets.map(preset => preset.id))
    const cleanName = name.trim()
    if (!cleanName) throw new Error('预设名称不能为空')
    const rendererStore = getRendererSettingsStore()
    const captureProviders = createFirstPartyPresetProviderRegistry({
      captureTheme: () => toPresetJson(toThemeDelta(pickCustomPresetTheme(get()))) as PresetJsonValue,
      applyTheme: () => {}, restoreTheme: () => {},
      captureRenderer: () => {
        const snapshot = rendererStore.getSnapshot()
        return { values: snapshot.values, unavailable: snapshot.unavailable }
      },
      applyRenderer: () => {}, restoreRenderer: () => {},
    })
    const bundle = createPresetBundle({
      id: resolvedId,
      name: cleanName.slice(0, 40),
      now,
      ...(existing ? { createdAt: existing.createdAt } : {}),
      theme: captureProviders.resolve('builtin.theme')!.capture(),
      renderer: captureProviders.resolve('builtin.renderer-settings')!.capture() as unknown as RendererPresetPayload,
    })
    const { patch, savedId } = saveCustomPresetReducer(state, { id: resolvedId, name, now, bundle })
    set(patch)
    return savedId
  
}

export function applyCustomPresetAction(id: string, api: PresetStoreApi): Promise<PresetApplyResult> {
  const { get, set } = api
    const revision = ++customPresetApplyRevision
    const run = async (): Promise<PresetApplyResult> => {
      const canonicalId = normalizeCustomPresetId(id)
      const preset = get().customPresets.find(item => normalizeCustomPresetId(item.id) === canonicalId)
      const presetId = canonicalId
      // D-fix：查不到预设必须可见地报告（此前静默 return——持久化引用漂移时
      // 表现为"切换了但什么都没发生"）。
      if (!preset) {
        const message = `自定义预设不存在：${canonicalId}`
        reportRuntimeError('应用自定义预设', new Error(message), undefined, {
          key: `preset:${presetId}`, scope: { kind: 'operation', id: `preset:${presetId}` }, source: 'theme.preset',
        })
        return { status: 'failed', id: canonicalId, failedProvider: 'preset', message, rolledBack: true, revision }
      }

      const bundle = normalizePresetBundle(preset.bundle) ?? adaptLegacyThemePreset({
        id: preset.id,
        name: preset.name,
        theme: toPresetJson(preset.theme),
        createdAt: preset.createdAt,
        updatedAt: preset.updatedAt,
      })
      const themeContribution = bundle.contributions['builtin.theme']
      const themePayloadValue = themeContribution?.payload
      if (!themeContribution || !themePayloadValue || typeof themePayloadValue !== 'object' || Array.isArray(themePayloadValue)) {
        const message = `自定义预设主题缺失：${presetId}`
        reportRuntimeError('准备应用预设', new Error(message), undefined, {
          key: `preset-prepare:${presetId}`, scope: { kind: 'operation', id: `preset:${presetId}` }, source: 'theme.preset',
        })
        return { status: 'failed', id: presetId, failedProvider: 'builtin.theme', message, rolledBack: true, revision }
      }
      // 主题 payload 单一真值：bundle 里的保存态 delta（免疫 appliedPreset 引用
      // 与列表 id 的漂移），回退用 preset.theme 本体。
      const themePayload = recordPayload(themePayloadValue) as Record<string, unknown>
      const state = get()
      const beforeTheme = Object.fromEntries([
        ...THEME_PRESET_KEYS.map(key => [key, state[key]] as const),
        ['appliedPreset', structuredClone(state.appliedPreset)],
        ['custom', structuredClone(state.custom)],
        ['customPresets', structuredClone(state.customPresets)],
      ])
      const rendererStore = getRendererSettingsStore()
      const beforeRenderer = rendererStore.getSnapshot()
      const registry = createFirstPartyPresetProviderRegistry({
        captureTheme: () => toPresetJson(toThemeDelta(pickCustomPresetTheme(get()))) as PresetJsonValue,
        applyTheme: () => set(current => {
          const patch = applyCustomPresetReducer(current, presetId, themePayload)
          if (!patch) throw new Error(`自定义预设主题缺失：${presetId}`)
          recordSettingWrites('custom-preset', presetId, Object.keys(patch))
          return patch
        }),
        restoreTheme: () => set(beforeTheme),
        captureRenderer: () => ({ values: beforeRenderer.values, unavailable: beforeRenderer.unavailable }),
        applyRenderer: (payload, context) => {
          const current = rendererStore.getSnapshot()
          const incomingValues = payload.values ?? {}
          const incomingUnavailable = payload.unavailable ?? {}
          if (context.policy === 'complete') {
            rendererStore.replaceOverrides(incomingValues, incomingUnavailable)
            return
          }
          // Partial bundles only own the keys they declare. Merge values and
          // unavailable independently so an omitted override is preserved;
          // an explicit unavailable entry clears the corresponding value.
          const values = { ...current.values, ...incomingValues }
          const unavailable = { ...current.unavailable, ...incomingUnavailable }
          for (const key of Object.keys(incomingValues)) delete unavailable[key]
          for (const key of Object.keys(incomingUnavailable)) delete values[key]
          rendererStore.replaceOverrides(values, unavailable)
        },
        restoreRenderer: () => rendererStore.replaceOverrides(beforeRenderer.values, beforeRenderer.unavailable),
      })
      const classified = markUnavailablePresetProviders(bundle, registry)
      const expectedProviderIds = ['builtin.theme', 'builtin.renderer-settings']
      const unavailable = [...new Set([
        ...expectedProviderIds.filter(providerId => !bundle.contributions[providerId] || !registry.resolve(providerId)),
        ...Object.keys(bundle.contributions).filter(providerId => !registry.resolve(providerId)),
      ])]
      const providerIds = Object.keys(bundle.contributions).filter(providerId => registry.resolve(providerId))
      let prepared
      try {
        prepared = preparePresetBundle(classified, registry)
        await prepared.commit()
      } catch (error) {
        const failedProvider = error instanceof PresetProviderTransactionError ? error.providerId : 'unknown'
        const message = error instanceof Error ? error.message : String(error)
        reportRuntimeError('应用预设', error, undefined, {
          key: `preset:${presetId}`, scope: { kind: 'operation', id: `preset:${presetId}` }, source: 'theme.preset',
        })
        return { status: 'failed', id: presetId, failedProvider, message, rolledBack: true, revision }
      }
      resolveRuntimeErrors({ key: `preset:${presetId}` })
      resolveRuntimeErrors({ key: `preset-prepare:${presetId}` })
      return {
        status: 'applied', id: presetId, providers: Object.freeze(providerIds), revision,
        ...(unavailable.length > 0 ? { unavailable: Object.freeze(unavailable) } : {}),
      }
    }

    const safeRun = async (): Promise<PresetApplyResult> => {
      try {
        return await run()
      } catch (error) {
        const canonicalId = normalizeCustomPresetId(id)
        const message = error instanceof Error ? error.message : String(error)
        reportRuntimeError('应用预设', error, undefined, {
          key: `preset:${canonicalId}`, scope: { kind: 'operation', id: `preset:${canonicalId}` }, source: 'theme.preset',
        })
        return { status: 'failed', id: canonicalId, failedProvider: 'unknown', message, rolledBack: false, revision }
      }
    }
    const pending = customPresetApplyTail.then(safeRun, safeRun)
    customPresetApplyTail = pending.then(() => undefined, () => undefined)
    return pending
  
}

function toPresetJson(value: unknown): import('./presetBundle.ts').PresetJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(item => toPresetJson(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPresetJson(item)]))
  return null
}

