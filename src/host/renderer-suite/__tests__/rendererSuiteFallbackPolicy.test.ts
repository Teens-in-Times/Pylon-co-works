import { describe, expect, it } from 'vitest'
import { resolveRendererSuiteFallback } from '../rendererSuiteFallbackPolicy.ts'
import type { RendererActivationSnapshot } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'

const activation = (id: string, fallbackSuiteId?: string): RendererActivationSnapshot => ({
  revision: 1,
  suite: { value: { id, label: id, apiVersion: 1, runtime: { framework: 'solid', version: '1' }, compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 }, requiredKinds: ['content.unknown'], fallbackSuiteId, factory: { prepare: async () => { throw new Error('not mounted in test') } } }, ownerPluginId: id, ownerRuntimeInstanceId: `${id}@r`, contributionId: id, layer: 'feature', priority: 1 },
  kinds: new Map(), slots: new Map(), diagnostics: [],
})

describe('RendererSuiteFallbackPolicy', () => {
  it('uses explicit current Suite fallback before built-in/React fallback', () => {
    const current = activation('suite.third-party', 'suite.explicit')
    const explicit = activation('suite.explicit')
    const builtin = activation('suite.builtin')
    const react = activation('suite.react-fatal')
    expect(resolveRendererSuiteFallback({ current, explicitFallback: explicit, builtInSolid: builtin, reactFatal: react })).toBe(explicit)
  })
})
