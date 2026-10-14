import type {
  PresetApplyContext,
  PresetCaptureScope,
  PresetChangeSummary,
  PresetJsonValue,
  PresetPreparedApply,
  PresetProvider,
  PresetProviderRegistry,
  RendererPresetPayload,
} from './presetBundle.ts'
import { PresetProviderRegistry as ProviderRegistry } from './presetBundle.ts'

export interface FirstPartyPresetProviderDeps {
  readonly captureTheme: (scope?: PresetCaptureScope) => PresetJsonValue
  readonly applyTheme: (payload: PresetJsonValue, context: PresetApplyContext) => void
  readonly restoreTheme: () => void
  readonly captureRenderer: (scope?: PresetCaptureScope) => RendererPresetPayload
  readonly applyRenderer: (payload: Partial<RendererPresetPayload>, context: PresetApplyContext) => void
  readonly restoreRenderer: () => void
}

function objectPayload(value: PresetJsonValue, providerId: string): Readonly<Record<string, PresetJsonValue>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${providerId} 预设 payload 必须是对象`)
  return value as Readonly<Record<string, PresetJsonValue>>
}

function summary(providerId: string, label: string, payload: PresetJsonValue): readonly PresetChangeSummary[] {
  const object = objectPayload(payload, providerId)
  return [{ providerId, label, changed: Object.keys(object).length }]
}

function prepared(
  changeSummary: readonly PresetChangeSummary[],
  commit: () => void,
  rollback: () => void,
): PresetPreparedApply {
  let applied = false
  return {
    summary: changeSummary,
    commit() {
      if (applied) return
      // Mark before invoking owner code so a partially-mutating commit that
      // throws is still eligible for the coordinator's rollback pass.
      applied = true
      commit()
    },
    rollback() { if (applied) { rollback(); applied = false } },
  }
}

function themeProvider(deps: FirstPartyPresetProviderDeps): PresetProvider {
  return {
    id: 'builtin.theme', ownerPluginId: 'builtin.pylon-shell', schemaVersion: 1, label: 'Theme',
    capture: deps.captureTheme,
    defaults: () => ({}),
    describeCoverage: payload => ({ id: 'builtin.theme', providerId: 'builtin.theme', label: 'Theme', explicit: Object.keys(objectPayload(payload, 'builtin.theme')).length, defaulted: 0, unavailable: 0, state: 'explicit' }),
    prepareApply(payload, context = { policy: 'complete' }) {
      objectPayload(payload, 'builtin.theme')
      return prepared(summary('builtin.theme', 'Theme', payload), () => deps.applyTheme(payload, context), deps.restoreTheme)
    },
  }
}

function rendererProvider(deps: FirstPartyPresetProviderDeps): PresetProvider {
  return {
    id: 'builtin.renderer-settings', ownerPluginId: 'builtin.pylon-renderers', schemaVersion: 1, label: 'Renderer overrides',
    capture: scope => deps.captureRenderer(scope) as unknown as PresetJsonValue,
    defaults: () => ({ values: {}, unavailable: {} }),
    describeCoverage: payload => ({ id: 'builtin.renderer-settings', providerId: 'builtin.renderer-settings', label: 'Renderer overrides', explicit: Object.keys(objectPayload(payload, 'builtin.renderer-settings')).length, defaulted: 0, unavailable: 0, state: 'explicit' }),
    prepareApply(payload, context = { policy: 'partial' }) {
      const value = objectPayload(payload, 'builtin.renderer-settings') as unknown as Partial<RendererPresetPayload>
      if (value.values !== undefined && (typeof value.values !== 'object' || Array.isArray(value.values))) {
        throw new Error('builtin.renderer-settings values 无效')
      }
      if (value.unavailable !== undefined && (typeof value.unavailable !== 'object' || Array.isArray(value.unavailable))) {
        throw new Error('builtin.renderer-settings 预设 payload 无效')
      }
      return prepared(summary('builtin.renderer-settings', 'Renderer overrides', payload), () => deps.applyRenderer(value, context), deps.restoreRenderer)
    },
  }
}

export function createFirstPartyPresetProviderRegistry(deps: FirstPartyPresetProviderDeps): PresetProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(themeProvider(deps))
  registry.register(rendererProvider(deps))
  return registry
}
