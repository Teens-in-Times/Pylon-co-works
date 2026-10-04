// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A-V12：settingsChromeStore 的一次性旧 key 搬家与动作语义。
 * 旧 key（pylon-settings-{density,preview-collapsed,collapse,pinned}）由
 * components/settings/settingsChromeState.ts 的手写 localStorage 迁来，
 * 首次模块求值时搬入 pylon-settings-chrome envelope v1 并删除旧 key。
 */

const LEGACY_KEYS = [
  'pylon-settings-density',
  'pylon-settings-preview-collapsed',
  'pylon-settings-collapse',
  'pylon-settings-pinned',
] as const

beforeEach(() => {
  localStorage.clear()
})

async function importFreshStore() {
  vi.resetModules()
  return import('../settingsChromeStore.ts')
}

describe('settingsChromeStore（A-V12 持久化收敛）', () => {
  it('旧 key 一次性搬家：值入新 envelope、旧 key 删除', async () => {
    localStorage.setItem('pylon-settings-density', JSON.stringify('basic'))
    localStorage.setItem('pylon-settings-preview-collapsed', JSON.stringify(true))
    localStorage.setItem('pylon-settings-collapse', JSON.stringify({ '外观.颜色': true, 'invalid-entry': 'not-boolean' }))
    localStorage.setItem('pylon-settings-pinned', JSON.stringify(['a', 'b', 'a', 'c', 'd']))
    const { useSettingsChromeStore } = await importFreshStore()

    const state = useSettingsChromeStore.getState()
    expect(state.density).toBe('basic')
    expect(state.previewCollapsed).toBe(true)
    expect(state.collapsedMap).toEqual({ '外观.颜色': true })
    // 保序去重 + 上限 3
    expect(state.pinned).toEqual(['a', 'b', 'c'])
    for (const key of LEGACY_KEYS) expect(localStorage.getItem(key)).toBeNull()
    // 新 envelope 已写穿（含 version）
    const envelope = JSON.parse(localStorage.getItem('pylon-settings-chrome')!) as { state: unknown; version: number }
    expect(envelope.version).toBe(1)
    expect((envelope.state as { density: string }).density).toBe('basic')
  })

  it('无旧 key 时不动存储、缺省值生效', async () => {
    const { useSettingsChromeStore } = await importFreshStore()
    expect(useSettingsChromeStore.getState().density).toBe('standard')
    expect(useSettingsChromeStore.getState().previewCollapsed).toBe(false)
    expect(localStorage.getItem('pylon-settings-chrome')).toBeNull()
  })

  it('动作写穿：密度档、预览折叠、组折叠、置顶（保最后 3 个）', async () => {
    const { useSettingsChromeStore } = await importFreshStore()
    const store = useSettingsChromeStore.getState()
    store.setDensity('all')
    store.setPreviewCollapsed(true)
    store.setGroupCollapsed('外观.颜色', true)
    store.togglePinned('a')
    store.togglePinned('b')
    store.togglePinned('c')
    store.togglePinned('d')
    const state = useSettingsChromeStore.getState()
    expect(state.density).toBe('all')
    expect(state.previewCollapsed).toBe(true)
    expect(state.collapsedMap).toEqual({ '外观.颜色': true })
    expect(state.pinned).toEqual(['b', 'c', 'd'])
    store.togglePinned('c')
    expect(useSettingsChromeStore.getState().pinned).toEqual(['b', 'd'])
    const persisted = JSON.parse(localStorage.getItem('pylon-settings-chrome')!) as { state: { pinned: string[] } }
    expect(persisted.state.pinned).toEqual(['b', 'd'])
  })

  it('非法持久化值经 migrate 规范化（损坏 density/类型错位 collapse）', async () => {
    localStorage.setItem('pylon-settings-chrome', JSON.stringify({
      state: { density: 'extreme', previewCollapsed: 'yes', collapsedMap: [1, 2], pinned: 'nope' },
      version: 1,
    }))
    const { useSettingsChromeStore } = await importFreshStore()
    const state = useSettingsChromeStore.getState()
    expect(state.density).toBe('standard')
    expect(state.previewCollapsed).toBe(false)
    expect(state.collapsedMap).toEqual({})
    expect(state.pinned).toEqual([])
  })
})
