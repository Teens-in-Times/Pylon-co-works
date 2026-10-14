import { describe, expect, it } from 'vitest'
import { createPresetBundle, markUnavailablePresetProviders, normalizePresetBundle, preparePresetBundle, presetCoverage, PresetProviderRegistry } from '../presetBundle.ts'

describe('PresetBundle v2', () => {
  it('keeps owner contributions and reports legacy coverage gaps', () => {
    const bundle = createPresetBundle({ id: 'custom-1', name: 'Terminal', now: 1, theme: { accent: '#fff' } })
    expect(bundle.manifestVersion).toBe(2)
    expect(bundle.contributions['builtin.theme']).toBeTruthy()
    expect(presetCoverage(bundle).find(item => item.id === 'builtin.theme')?.state).toBe('explicit')
    expect(presetCoverage(bundle).find(item => item.id === 'builtin.theme')?.defaulted).toBeGreaterThan(0)
    expect(presetCoverage(undefined).every(item => item.state === 'missing')).toBe(true)
  })

  it('marks missing official providers as partial instead of implying complete coverage', () => {
    const bundle = createPresetBundle({ id: 'official:test', name: 'Official', now: 1, source: 'builtin', theme: { accent: '#fff' } })
    // ★ #607 刀3b：`builtin.presentation` 段已随档案私路退役 ⇒ 覆盖表里不再有它这一项。
    expect(presetCoverage(bundle).some(item => item.id === 'builtin.presentation')).toBe(false)
    expect(presetCoverage(bundle).find(item => item.id === 'builtin.renderer-settings')).toMatchObject({ state: 'missing', policy: 'partial' })
  })

  it('★ #607 刀3b：旧 bundle 的 `builtin.presentation` 段被静默忽略（未知 provider 不报错）', () => {
    const registry = new PresetProviderRegistry()
    const legacy = normalizePresetBundle({
      manifestVersion: 2, id: 'legacy-presentation', name: 'Legacy', source: 'user',
      contributions: {
        'builtin.theme': { ownerPluginId: 'builtin.pylon-shell', providerVersion: 1, policy: 'complete', payload: { accent: '#123456' } },
        // 旧数据里带着已退役的 Presentation 段
        'builtin.presentation': {
          ownerPluginId: 'builtin.pylon-shell', providerVersion: 1, policy: 'partial',
          payload: { activeProfileId: 'builtin.presentation.console-glass', rendererSuiteIdByMode: { 'modern-gui': 'builtin.solid' } },
        },
      },
    })!
    const classified = markUnavailablePresetProviders(legacy, registry)
    // 未注销、未报错：原 payload 原样留在 unavailable 里（信封可往返），且不被改写
    expect(classified.unavailable?.['builtin.presentation']).toEqual({
      activeProfileId: 'builtin.presentation.console-glass', rendererSuiteIdByMode: { 'modern-gui': 'builtin.solid' },
    })
    expect(classified.contributions['builtin.presentation']?.payload).toEqual(classified.unavailable?.['builtin.presentation'])
    // 未知 provider 不进 prepared、不抛错
    expect(() => preparePresetBundle(classified, registry)).not.toThrow()
  })

  it('drops malformed contribution entries without dropping the envelope', () => {
    const bundle = normalizePresetBundle({
      manifestVersion: 2,
      id: 'legacy',
      name: 'Legacy',
      source: 'user',
      contributions: {
        'builtin.theme': { ownerPluginId: 'builtin.pylon-shell', providerVersion: 1, policy: 'complete', payload: { accent: '#fff' } },
        bad: { ownerPluginId: 'x', providerVersion: 1, policy: 'unknown', payload: {} },
      },
    })
    expect(Object.keys(bundle?.contributions ?? {})).toEqual(['builtin.theme'])
  })

  it('keeps provider ownership outside the Settings compositor', () => {
    const registry = new PresetProviderRegistry()
    const provider = { id: 'builtin.theme', ownerPluginId: 'builtin.pylon-shell', schemaVersion: 1, label: 'Theme', capture: () => ({}), prepareApply: () => ({ summary: [], commit() {}, rollback() {} }), defaults: () => ({}) }
    const unregister = registry.register(provider)
    expect(registry.resolve('builtin.theme')).toBe(provider)
    unregister()
    expect(registry.resolve('builtin.theme')).toBeUndefined()
  })

  it('prepares all providers before commit and rolls back an earlier commit on failure', async () => {
    const registry = new PresetProviderRegistry()
    let value = 'before'
    registry.register({
      id: 'one', ownerPluginId: 'test', schemaVersion: 1, label: 'One',
      capture: () => ({}), defaults: () => ({}),
      prepareApply: () => ({ summary: [], commit() { value = 'one' }, rollback() { value = 'before' } }),
    })
    registry.register({
      id: 'two', ownerPluginId: 'test', schemaVersion: 1, label: 'Two',
      capture: () => ({}), defaults: () => ({}),
      prepareApply: () => ({ summary: [], commit() { throw new Error('commit failed') }, rollback() {} }),
    })
    const prepared = preparePresetBundle({
      manifestVersion: 2, id: 'bundle', name: 'Bundle', source: 'user',
      contributions: {
        one: { ownerPluginId: 'test', providerVersion: 1, policy: 'partial', payload: {} },
        two: { ownerPluginId: 'test', providerVersion: 1, policy: 'partial', payload: {} },
      },
    }, registry)
    await expect(prepared.commit()).rejects.toMatchObject({ providerId: 'two', phase: 'commit', message: 'commit failed' })
    expect(value).toBe('before')
  })

  it('preserves a missing plugin contribution in unavailable without rewriting its payload', () => {
    const registry = new PresetProviderRegistry()
    const bundle = normalizePresetBundle({
      manifestVersion: 2, id: 'plugin-bundle', name: 'Plugin', source: 'plugin',
      contributions: { 'plugin.remote': { ownerPluginId: 'plugin.remote', providerVersion: 3, policy: 'partial', payload: { tone: 'amber' } } },
    })!
    const classified = markUnavailablePresetProviders(bundle, registry)
    expect(classified.unavailable?.['plugin.remote']).toEqual({ tone: 'amber' })
    expect(classified.contributions['plugin.remote']?.payload).toEqual({ tone: 'amber' })
  })

  it('waits for asynchronous provider commits before reporting completion', async () => {
    let release!: () => void
    const order: string[] = []
    const registry = new PresetProviderRegistry()
    registry.register({
      id: 'async.provider', ownerPluginId: 'test', schemaVersion: 1, label: 'Async',
      capture: () => ({}), defaults: () => ({}),
      prepareApply: () => ({
        summary: [],
        commit: () => new Promise<void>(resolve => { order.push('started'); release = () => { order.push('released'); resolve() } }),
        rollback: () => { order.push('rollback') },
      }),
    })
    const prepared = preparePresetBundle({
      manifestVersion: 2, id: 'async-bundle', name: 'Async', source: 'user',
      contributions: { 'async.provider': { ownerPluginId: 'test', providerVersion: 1, policy: 'partial', payload: {} } },
    }, registry)
    const pending = Promise.resolve(prepared.commit())
    await Promise.resolve()
    expect(order).toEqual(['started'])
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await pending
    expect(order).toEqual(['started', 'released'])
  })
})
