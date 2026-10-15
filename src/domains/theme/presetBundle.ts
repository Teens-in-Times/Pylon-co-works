import type { RendererSettingValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { THEME_PRESET_KEYS } from './themeFieldDefs.ts'

export type PresetJsonValue = null | boolean | number | string | readonly PresetJsonValue[] | { readonly [key: string]: PresetJsonValue }

export interface PresetContribution {
  readonly ownerPluginId: string
  readonly providerVersion: number
  readonly policy: 'complete' | 'partial'
  readonly payload: PresetJsonValue
}

export interface PresetBundleV2 {
  readonly manifestVersion: 2
  readonly id?: string
  readonly name: string
  readonly source: 'builtin' | 'user' | 'plugin'
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly contributions: Readonly<Record<string, PresetContribution>>
  readonly unavailable?: Readonly<Record<string, PresetJsonValue>>
}

export interface RendererPresetPayload {
  readonly values: Readonly<Record<string, RendererSettingValue>>
  readonly unavailable: Readonly<Record<string, RendererSettingValue>>
}

export interface PresetCaptureScope {
  /** Optional provider ids when capturing/applying a selected settings area. */
  readonly providerIds?: readonly string[]
  /** Optional semantic areas (for example `theme.chat` or `renderer.tools`). */
  readonly areas?: readonly string[]
}

export interface PresetApplyContext {
  readonly scope?: PresetCaptureScope
  readonly policy: 'complete' | 'partial'
  readonly bundleId?: string
}

export interface PresetCoverage {
  /** Stable UI key; kept alongside providerId for v1 callers. */
  readonly id: string
  readonly providerId: string
  readonly label: string
  readonly explicit: number
  readonly defaulted: number
  readonly unavailable: number
  readonly state: 'explicit' | 'defaulted' | 'unavailable' | 'missing' | 'excluded'
  readonly policy?: 'complete' | 'partial'
}

export interface PresetChangeSummary {
  readonly providerId: string
  readonly label: string
  readonly changed: number
}

export type PresetApplyResult =
  | {
      readonly status: 'applied'
      readonly id: string
      readonly providers: readonly string[]
      readonly revision: number
      readonly unavailable?: readonly string[]
    }
  | {
      readonly status: 'failed'
      readonly id: string
      readonly failedProvider: string
      readonly message: string
      readonly rolledBack: boolean
      readonly revision: number
    }

/** Error enriched with the provider/phase that rejected a bundle operation. */
export class PresetProviderTransactionError extends Error {
  readonly providerId: string
  readonly phase: 'prepare' | 'commit'
  readonly cause: unknown

  constructor(providerId: string, phase: 'prepare' | 'commit', cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(message)
    this.name = 'PresetProviderTransactionError'
    this.providerId = providerId
    this.phase = phase
    this.cause = cause
  }
}

export interface PresetPreparedApply {
  readonly summary: readonly PresetChangeSummary[]
  commit(): void | Promise<void>
  rollback(): void | Promise<void>
}

export interface PresetProvider {
  readonly id: string
  readonly ownerPluginId: string
  readonly schemaVersion: number
  readonly label: string
  capture(scope?: PresetCaptureScope): PresetJsonValue
  prepareApply(payload: PresetJsonValue, context?: PresetApplyContext): PresetPreparedApply
  defaults(scope?: PresetCaptureScope): PresetJsonValue
  migrate?(fromVersion: number, payload: PresetJsonValue): PresetJsonValue
  describeCoverage?(payload: PresetJsonValue): PresetCoverage
}

/** Small owner-neutral registry; values remain owned by providers, not Settings. */
export class PresetProviderRegistry {
  private readonly providers = new Map<string, PresetProvider>()

  register(provider: PresetProvider): () => void {
    if (!provider.id.trim() || this.providers.has(provider.id)) throw new Error(`Preset provider 重复：${provider.id}`)
    this.providers.set(provider.id, provider)
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id) }
  }

  list(): readonly PresetProvider[] { return Object.freeze([...this.providers.values()]) }
  resolve(id: string): PresetProvider | undefined { return this.providers.get(id) }
}

export interface PreparedPresetBundle {
  readonly summary: readonly PresetChangeSummary[]
  commit(): void | Promise<void>
  rollback(): void | Promise<void>
}

/**
 * Prepare every available contribution before mutating any owner. Missing
 * providers are kept in the bundle's unavailable map by the caller; a
 * malformed or rejected contribution aborts the transaction and rolls back
 * every provider that was already prepared.
 */
export function preparePresetBundle(
  bundle: PresetBundleV2,
  registry: PresetProviderRegistry,
  scope?: PresetCaptureScope,
): PreparedPresetBundle {
  const prepared: PresetPreparedApply[] = []
  const preparedProviderIds: string[] = []
  const summaries: PresetChangeSummary[] = []
  try {
    for (const [providerId, contribution] of Object.entries(bundle.contributions)) {
      const provider = registry.resolve(providerId)
      if (!provider) continue
      try {
        const payload = provider.migrate && contribution.providerVersion !== provider.schemaVersion
          ? provider.migrate(contribution.providerVersion, contribution.payload)
          : contribution.payload
        const item = provider.prepareApply(payload, { policy: contribution.policy, scope, bundleId: bundle.id })
        prepared.push(item)
        preparedProviderIds.push(providerId)
        summaries.push(...item.summary)
      } catch (error) {
        throw new PresetProviderTransactionError(providerId, 'prepare', error)
      }
    }
  } catch (error) {
    // Best effort rollback; preserve the original prepare error.
    for (let index = prepared.length - 1; index >= 0; index--) {
      try { void prepared[index].rollback() } catch { /* owner cleanup must not mask prepare failure */ }
    }
    throw error
  }

  let settled = false
  return {
    summary: Object.freeze(summaries),
    commit: async () => {
      if (settled) return
      try {
        for (let index = 0; index < prepared.length; index += 1) {
          try { await prepared[index]!.commit() }
          catch (error) {
            throw new PresetProviderTransactionError(preparedProviderIds[index] ?? 'unknown', 'commit', error)
          }
        }
        settled = true
      } catch (error) {
        for (let index = prepared.length - 1; index >= 0; index--) {
          try { await prepared[index].rollback() } catch { /* retain original commit failure */ }
        }
        settled = true
        throw error
      }
    },
    rollback: async () => {
      if (settled) return
      for (let index = prepared.length - 1; index >= 0; index--) await prepared[index].rollback()
      settled = true
    },
  }
}

/** Mark contributions whose owner is currently absent without dropping their
 * original payload. The envelope remains round-trippable for a later plugin
 * reload. */
export function markUnavailablePresetProviders(
  bundle: PresetBundleV2,
  registry: PresetProviderRegistry,
): PresetBundleV2 {
  const unavailable: Record<string, PresetJsonValue> = { ...(bundle.unavailable ?? {}) }
  for (const [providerId, contribution] of Object.entries(bundle.contributions)) {
    if (!registry.resolve(providerId)) unavailable[providerId] = contribution.payload
  }
  return Object.keys(unavailable).length === 0
    ? bundle
    : Object.freeze({ ...bundle, unavailable: Object.freeze(unavailable) })
}

/** Adapt the pre-v2 Theme-only custom preset without rewriting persisted data. */
export function adaptLegacyThemePreset(input: {
  readonly id: string
  readonly name: string
  readonly theme: PresetJsonValue
  readonly createdAt?: number
  readonly updatedAt?: number
}): PresetBundleV2 {
  return Object.freeze({
    manifestVersion: 2,
    id: input.id,
    name: input.name,
    source: 'user',
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    contributions: Object.freeze({
      'builtin.theme': Object.freeze({
        ownerPluginId: 'builtin.pylon-shell',
        providerVersion: 1,
        policy: 'complete' as const,
        payload: input.theme,
      }),
    }),
  })
}

function isJsonValue(value: unknown, seen = new Set<unknown>()): value is PresetJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : Object.values(value).every(item => isJsonValue(item, seen))
}

export function normalizePresetBundle(value: unknown): PresetBundleV2 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<PresetBundleV2>
  if (candidate.manifestVersion !== 2 || typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return undefined
  if (!candidate.contributions || typeof candidate.contributions !== 'object' || Array.isArray(candidate.contributions)) return undefined
  const contributions: Record<string, PresetContribution> = {}
  for (const [providerId, raw] of Object.entries(candidate.contributions)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Partial<PresetContribution>
    if (typeof item.ownerPluginId !== 'string' || typeof item.providerVersion !== 'number'
      || (item.policy !== 'complete' && item.policy !== 'partial') || !isJsonValue(item.payload)) continue
    contributions[providerId] = {
      ownerPluginId: item.ownerPluginId,
      providerVersion: item.providerVersion,
      policy: item.policy,
      payload: item.payload,
    }
  }
  const unavailable: Record<string, PresetJsonValue> = {}
  if (candidate.unavailable && typeof candidate.unavailable === 'object' && !Array.isArray(candidate.unavailable)) {
    for (const [key, item] of Object.entries(candidate.unavailable)) if (isJsonValue(item)) unavailable[key] = item
  }
  return {
    manifestVersion: 2,
    id: candidate.id,
    name: candidate.name,
    source: candidate.source === 'builtin' || candidate.source === 'plugin' ? candidate.source : 'user',
    ...(typeof candidate.createdAt === 'number' ? { createdAt: candidate.createdAt } : {}),
    ...(typeof candidate.updatedAt === 'number' ? { updatedAt: candidate.updatedAt } : {}),
    contributions: Object.freeze(contributions),
    ...(Object.keys(unavailable).length > 0 ? { unavailable: Object.freeze(unavailable) } : {}),
  }
}

export function createPresetBundle(input: {
  id: string
  name: string
  now: number
  /** Preserve the original creation time when an existing preset is updated. */
  createdAt?: number
  theme: PresetJsonValue
  renderer?: RendererPresetPayload
  source?: PresetBundleV2['source']
}): PresetBundleV2 {
  const contributions: Record<string, PresetContribution> = {
    'builtin.theme': { ownerPluginId: 'builtin.pylon-shell', providerVersion: 1, policy: 'complete', payload: input.theme },
  }
  if (input.renderer) contributions['builtin.renderer-settings'] = {
    ownerPluginId: 'builtin.pylon-renderers', providerVersion: 1, policy: 'partial', payload: input.renderer as unknown as PresetJsonValue,
  }
  return Object.freeze({
    manifestVersion: 2,
    id: input.id,
    name: input.name,
    source: input.source ?? 'user',
    createdAt: input.createdAt ?? input.now,
    updatedAt: input.now,
    contributions: Object.freeze(contributions),
  })
}

/** Read a contribution payload as a record (empty when absent/malformed). */
export function recordPayload(value: PresetJsonValue | undefined): Readonly<Record<string, PresetJsonValue>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, PresetJsonValue>> : {}
}

function coverageCounts(providerId: string, contribution: PresetContribution | undefined, unavailablePayload: PresetJsonValue | undefined): Pick<PresetCoverage, 'explicit' | 'defaulted' | 'unavailable'> {
  const payload = recordPayload(contribution?.payload)
  const unavailableRecord = recordPayload(unavailablePayload)
  const unavailable = providerId === 'builtin.renderer-settings'
    ? Object.keys(recordPayload(unavailableRecord.values)).length + Object.keys(recordPayload(unavailableRecord.unavailable)).length
    : Object.keys(unavailableRecord).length
  if (!contribution) return { explicit: 0, defaulted: 0, unavailable }
  if (providerId === 'builtin.theme') {
    const known = new Set<string>(THEME_PRESET_KEYS as readonly string[])
    const explicit = Object.keys(payload).filter(key => known.has(key)).length
    return {
      explicit,
      defaulted: contribution.policy === 'complete' ? Math.max(0, THEME_PRESET_KEYS.length - explicit) : 0,
      unavailable,
    }
  }
  if (providerId === 'builtin.renderer-settings') {
    const values = recordPayload(payload.values)
    const storedUnavailable = recordPayload(payload.unavailable)
    return { explicit: Object.keys(values).length, defaulted: 0, unavailable: unavailable + (unavailablePayload === undefined ? Object.keys(storedUnavailable).length : 0) }
  }
  return { explicit: Object.keys(payload).length, defaulted: 0, unavailable }
}

export function presetCoverage(bundle: PresetBundleV2 | undefined): readonly PresetCoverage[] {
  const labels: Readonly<Record<string, string>> = {
    'builtin.theme': 'Theme',
    'builtin.renderer-settings': 'Renderer overrides',
  }
  const coverage: PresetCoverage[] = Object.entries(labels).map(([id, label]) => {
    const contribution = bundle?.contributions[id]
    const unavailablePayload = bundle?.unavailable?.[id]
    const counts = coverageCounts(id, contribution, unavailablePayload)
    const state = unavailablePayload !== undefined
      ? 'unavailable' as const
      : !contribution
        ? 'missing' as const
        : counts.explicit > 0
          ? 'explicit' as const
          : counts.defaulted > 0
            ? 'defaulted' as const
            : 'explicit' as const
    return {
      id,
      providerId: id,
      label,
      ...counts,
      state,
      ...(contribution ? { policy: contribution.policy } : bundle?.source === 'builtin' ? { policy: 'partial' as const } : {}),
    }
  })
  // Plugin Page/Context Panel schemas have no approved preset provider in
  // this bundle version; make that exclusion visible to avoid implying that
  // Theme/Renderer providers captured plugin-owned values.
  if (bundle) coverage.push({ id: 'plugin-schema', providerId: 'plugin-schema', label: 'Plugin schema', explicit: 0, defaulted: 0, unavailable: 0, state: 'excluded', policy: 'partial' })
  return coverage
}
