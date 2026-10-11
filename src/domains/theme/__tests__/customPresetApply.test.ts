// @vitest-environment jsdom
// D-fix 回归：自定义预设"切换后未生效"——store 级应用链路（v2 bundle 提交 +
// 静默失败可见化）。三段：正常应用、持久化往返后应用、失效 id 必须可见报告。
// #448 PR5：预设列表/动作已拆 customPresetStore（主题字段仍在 themeStore）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from '../themeStore.ts'
import { useCustomPresetStore } from '../customPresetStore.ts'
import { resetStores } from '../../../test/resetStores.ts'
import { normalizeCustomPresets } from '../customPresets.ts'
import { createPresetBundle } from '../presetBundle.ts'
import { getRendererSettingsStore } from '../../../plugin-runtime/runtimeServices.ts'

function snapshotState() {
  const theme = useThemeStore.getState()
  const presets = useCustomPresetStore.getState()
  return JSON.parse(JSON.stringify({
    theme: Object.fromEntries([
      'chatFontSize', 'chatFont', 'toolIndicator', 'toolIndicatorRun', 'toolIndicatorOk',
      'toolIndicatorErr', 'assistantDot', 'assistantDotGlyph', 'appliedPreset', 'custom',
      'ccHeight',
    ].map(key => [key, (theme as unknown as Record<string, unknown>)[key]])),
    customPresets: presets.customPresets,
  }))
}

describe('custom preset apply (D-fix)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('CC-21 saves and restores input fonts through custom and cc presets without chat-zone overwrite', async () => {
    useThemeStore.getState().setZoneField('cc', { inputFont: 'vendor.input' })
    const id = useCustomPresetStore.getState().saveCustomPreset('CC-21字体往返')
    const persisted = JSON.parse(localStorage.getItem('pylon-custom-presets')!).state
    expect(persisted.customPresets.find((preset: { id: string }) => preset.id === id).theme.inputFont).toBe('vendor.input')
    useCustomPresetStore.setState({ customPresets: normalizeCustomPresets(persisted.customPresets) })
    useThemeStore.getState().setZoneField('cc', { inputFont: 'follow-message' })
    await useCustomPresetStore.getState().applyCustomPreset(id)
    expect(useThemeStore.getState().inputFont).toBe('vendor.input')
    useThemeStore.getState().applyZonePreset('chat', 'font-chat', { msgFont: 'serif' })
    expect(useThemeStore.getState().inputFont).toBe('vendor.input')
    expect(useThemeStore.getState().msgFont).toBe('serif')
    useThemeStore.getState().applyZonePreset('cc', 'font-cc', { inputFont: 'mono' })
    expect(useThemeStore.getState().inputFont).toBe('mono')
    expect(useThemeStore.getState().msgFont).toBe('serif')
  })

  it('applies the saved theme delta back when switching to a custom preset', async () => {
    const store = useThemeStore.getState()
    store.setZoneField('chat', {
      chatFontSize: 19,
      toolIndicatorRun: 'star',
      toolIndicatorOk: 'check',
      toolIndicatorErr: 'cross',
      assistantDot: true,
      assistantDotGlyph: '◆',
    })
    const id = useCustomPresetStore.getState().saveCustomPreset('指示器回归')

    // 漂移现场：改字段 + 应用一个内置全局预设（与真实"切换"路径一致）
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 12, assistantDotGlyph: '■' })
    useThemeStore.getState().setGlobalPreset('nord', { chatFontSize: 14 })

    await useCustomPresetStore.getState().applyCustomPreset(id)

    const state = useThemeStore.getState()
    expect(state.chatFontSize).toBe(19)
    expect(state.toolIndicatorRun).toBe('star')
    expect(state.toolIndicatorOk).toBe('check')
    expect(state.toolIndicatorErr).toBe('cross')
    expect(state.assistantDot).toBe(true)
    expect(state.assistantDotGlyph).toBe('◆')
    expect(state.appliedPreset.chat).toBe(id)
    expect(state.appliedPreset.global).toBe(id)
    expect(state.custom.chat).toBe(false)
  })

  it('returns an applied result after the complete provider transaction settles', async () => {
    const store = useThemeStore.getState()
    store.setZoneField('chat', { chatFontSize: 21 })
    const id = useCustomPresetStore.getState().saveCustomPreset('结果回归')

    const result = await useCustomPresetStore.getState().applyCustomPreset(id)
    expect(result).toMatchObject({ status: 'applied', id })
    if (result.status !== 'applied') throw new Error('custom preset unexpectedly failed')
    expect(result.providers).toEqual(expect.arrayContaining(['builtin.theme', 'builtin.presentation', 'builtin.renderer-settings']))
    expect(result.revision).toBeGreaterThan(0)
  })

  it('rejects a custom bundle without a valid Theme contribution instead of resetting to defaults', async () => {
    useCustomPresetStore.setState({ customPresets: [{
      id: 'custom-invalid-bundle', name: '损坏预设', theme: { chatFontSize: 29 }, createdAt: 1, updatedAt: 1,
      bundle: {
        manifestVersion: 2, id: 'custom-invalid-bundle', name: '损坏预设', source: 'user',
        contributions: {
          'builtin.renderer-settings': { ownerPluginId: 'builtin.pylon-renderers', providerVersion: 1, policy: 'partial', payload: {} },
        },
      },
    }] as never })
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 29 })

    const result = await useCustomPresetStore.getState().applyCustomPreset('custom-invalid-bundle')
    expect(result).toMatchObject({ status: 'failed', id: 'custom-invalid-bundle', failedProvider: 'builtin.theme', rolledBack: true })
    expect(useThemeStore.getState().chatFontSize).toBe(29)
  })

  it('rolls back Theme and Presentation when a Renderer provider commit fails', async () => {
    const rendererStore = getRendererSettingsStore()
    const beforeRenderer = rendererStore.getSnapshot()
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 17 })
    useCustomPresetStore.setState({ customPresets: [{
      id: 'custom-renderer-failure', name: '渲染器失败', theme: { chatFontSize: 29 }, createdAt: 1, updatedAt: 1,
      bundle: createPresetBundle({
        id: 'custom-renderer-failure', name: '渲染器失败', now: 1, theme: { chatFontSize: 29 },
        presentation: { activeProfileId: 'profile-after', rendererSuiteIdByMode: { 'terminal-like': 'suite-after' } },
        renderer: { values: {}, unavailable: {} },
      }),
    }] as never })
    const originalReplace = rendererStore.replaceOverrides.bind(rendererStore)
    let replaceCalls = 0
    const replace = vi.spyOn(rendererStore, 'replaceOverrides').mockImplementation((values, unavailable) => {
      replaceCalls += 1
      if (replaceCalls === 1) throw new Error('renderer commit failed')
      originalReplace(values, unavailable)
    })
    try {
      const result = await useCustomPresetStore.getState().applyCustomPreset('custom-renderer-failure')
      expect(result).toMatchObject({ status: 'failed', failedProvider: 'builtin.renderer-settings', rolledBack: true })
      expect(useThemeStore.getState().chatFontSize).toBe(17)
      expect(rendererStore.getSnapshot()).toMatchObject({ values: beforeRenderer.values, unavailable: beforeRenderer.unavailable })
      expect(replaceCalls).toBeGreaterThanOrEqual(2)
    } finally {
      replace.mockRestore()
    }
  })

  it('applies after a persistence roundtrip (customPresetStore rehydrate + merge 归一)', async () => {
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 20, toolIndicatorRun: 'hourglass' })
    const id = useCustomPresetStore.getState().saveCustomPreset('往返回归')

    // 模拟新键持久化往返：序列化 → 反序列化 → store merge 的领域归一
    // （#448 PR5：customPresets 归一职责自 themeDomainMigrate 移交本 store）
    const persisted = JSON.parse(JSON.stringify(useCustomPresetStore.getState().customPresets))
    useCustomPresetStore.setState({ customPresets: normalizeCustomPresets(persisted) })
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 12 })

    await useCustomPresetStore.getState().applyCustomPreset(id)
    expect(useThemeStore.getState().chatFontSize).toBe(20)
    expect(useThemeStore.getState().toolIndicatorRun).toBe('hourglass')
    expect(useThemeStore.getState().appliedPreset.chat).toBe(id)
  })

  it('merges partial Renderer payloads by key and honors explicit unavailable clears', async () => {
    const rendererStore = getRendererSettingsStore()
    rendererStore.setOverride('kind.tool.read.maxWidth', 640)
    rendererStore.setOverride('kind.tool.read.density', 'compact')
    rendererStore.markUnavailable('kind.tool.read.status', 'legacy')
    const id = 'custom-partial-renderer'
    useCustomPresetStore.setState({ customPresets: [{
      id, name: '局部 Renderer', theme: { chatFontSize: 18 }, createdAt: 1, updatedAt: 1,
      bundle: createPresetBundle({
        id, name: '局部 Renderer', now: 1, theme: { chatFontSize: 18 },
        renderer: { values: { 'kind.tool.read.maxWidth': 720, 'kind.tool.read.status': 'ok' }, unavailable: {} },
      }),
    }] as never })

    const result = await useCustomPresetStore.getState().applyCustomPreset(id)
    expect(result.status).toBe('applied')
    expect(rendererStore.getSnapshot().values).toMatchObject({
      'kind.tool.read.maxWidth': 720,
      'kind.tool.read.density': 'compact',
      'kind.tool.read.status': 'ok',
    })
    expect(rendererStore.getSnapshot().unavailable['kind.tool.read.status']).toBeUndefined()
  })

  it('normalizes a legacy bare id at the click boundary', async () => {
    useCustomPresetStore.setState({ customPresets: [{
      id: 'custom-legacy-id', name: '旧 id', theme: { chatFontSize: 21 }, createdAt: 1, updatedAt: 1,
    }] })
    const result = await useCustomPresetStore.getState().applyCustomPreset('legacy-id')
    expect(result).toMatchObject({ status: 'applied', id: 'custom-legacy-id' })
    expect(useThemeStore.getState().chatFontSize).toBe(21)
  })

  it('serializes rapid custom preset clicks so the later revision wins', async () => {
    useCustomPresetStore.setState({ customPresets: [
      { id: 'custom-first', name: '先', theme: { chatFontSize: 16 }, createdAt: 1, updatedAt: 1 },
      { id: 'custom-second', name: '后', theme: { chatFontSize: 22 }, createdAt: 2, updatedAt: 2 },
    ] })
    const first = useCustomPresetStore.getState().applyCustomPreset('custom-first')
    const second = useCustomPresetStore.getState().applyCustomPreset('custom-second')
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.status).toBe('applied')
    expect(secondResult.status).toBe('applied')
    expect(secondResult.revision).toBeGreaterThan(firstResult.revision)
    expect(useThemeStore.getState().chatFontSize).toBe(22)
    expect(useThemeStore.getState().appliedPreset.global).toBe('custom-second')
  })

  it('reports a missing custom preset id instead of failing silently', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const before = snapshotState()
      await useCustomPresetStore.getState().applyCustomPreset('custom-does-not-exist')
      expect(spy).toHaveBeenCalled()
      expect(snapshotState()).toEqual(before)
    } finally {
      spy.mockRestore()
    }
  })
})
