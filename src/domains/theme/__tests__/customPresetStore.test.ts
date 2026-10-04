// @vitest-environment jsdom
/**
 * #448 PR5 customPresetStore 测试——拆分后的独立持久化域：
 * - 归一职责承接（自 themeDomainMigrate 移交）：损坏项丢弃、id 命名空间重前缀
 * - 旧 pylon-theme 内嵌字段一次性搬家（新键有数据不反向覆盖）
 * - removeCustomPreset/removeZonePresetEntry 跨 store 路由（appliedPreset/custom 回写 themeStore）
 * - saveZonePresetEntry 快照读 themeStore 当前值
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { resetStores } from '../../../test/resetStores.ts'
import { flushTask } from '../../../test/solidTestHelpers.ts'

// 搬家用例需要控制 localStorage 先于 store 模块求值（zustand persist 在 import 时
// 同步 hydrate）——隔离模块图后按用例动态 import。
async function freshStores() {
  vi.resetModules()
  // 先 import customPresetStore：其模块求值（含搬家同步快照）与依赖 themeStore 的
  // 求值在同一条同步链上完成——快照先于 themeStore hydrate 的微任务写回（生产
  // import 图同序）。若先单独 await themeStore，await 的微任务空隙会让其 hydrate
  // 把旧 pylon-theme 修剪掉，搬家读到空。
  const { useThemeStore } = await import('../customPresetStore.ts').then(() => import('../themeStore.ts'))
  const { useCustomPresetStore, CUSTOM_PRESET_STORAGE_KEY } = await import('../customPresetStore.ts')
  // zustand persist 的 hydrate 经微任务链调度——等它落定后再断言
  await flushTask()
  return { useThemeStore, useCustomPresetStore, CUSTOM_PRESET_STORAGE_KEY }
}

beforeEach(() => {
  // 先重置 store（其 persist 写盘会把新键写脏），再清 localStorage——
  // 搬家用例需要「新键不存在」的现场（getItem 的 own 优先会短路搬家）。
  resetStores()
  localStorage.clear()
})

describe('归一职责承接（自 themeDomainMigrate 移交，#448 PR5）', () => {
  it('损坏项丢弃 + 非 custom- 前缀 id 重前缀（A1 语义等价）', async () => {
    const { normalizeCustomPresets } = await import('../customPresets.ts')
    const normalized = normalizeCustomPresets([
      { id: 'ok', name: ' Valid ', theme: { chatFontSize: 13 }, createdAt: 10, updatedAt: 11 },
      null,
      { id: '', name: 'bad', theme: {} },
      { id: 'missing-theme', name: 'bad' },
    ])
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({ id: 'custom-ok', name: 'Valid', createdAt: 10, updatedAt: 11 })
  })
})

describe('旧 pylon-theme 一次性搬家', () => {
  it('新键无数据 → 从旧 pylon-theme 内嵌字段提取（customPresets + zonePresetEntries）', async () => {
    localStorage.setItem('pylon-theme', JSON.stringify({
      state: {
        chatFontSize: 15,
        customPresets: [{ id: 'custom-old', name: '旧预设', theme: { chatFontSize: 14 }, createdAt: 1, updatedAt: 2 }],
        zonePresetEntries: [{ id: 'zone-gui-cc-1', mode: 'gui', zone: 'cc', label: '我的中控', values: { ccHeight: 120 } }],
      },
      version: 8,
    }))
    const { useCustomPresetStore } = await freshStores()
    const state = useCustomPresetStore.getState()
    expect(state.customPresets).toHaveLength(1)
    expect(state.customPresets[0].id).toBe('custom-old')
    expect(state.zonePresetEntries).toHaveLength(1)
    expect(state.zonePresetEntries[0].label).toBe('我的中控')
    // ★ B-1：搬家值当场落盘新键（不依赖本会话是否发生预设动作）
    expect(localStorage.getItem('pylon-custom-presets')).toBeTruthy()
  })

  it('★ B-1 回归：同版本升级态（v11 不跑 migrate，stash 不执行）→ 现场读搬家且当场落盘，重启不丢', async () => {
    const { THEME_SCHEMA_VERSION } = await import('../migration.ts')
    localStorage.setItem('pylon-theme', JSON.stringify({
      state: {
        chatFontSize: 15,
        customPresets: [{ id: 'custom-v11', name: '同版本预设', theme: { chatFontSize: 14 }, createdAt: 1, updatedAt: 1 }],
      },
      version: THEME_SCHEMA_VERSION,
    }))
    // 会话 1：同版本 → themeStore 不 migrate（stash 空）→ 搬家走现场读腿
    const first = await freshStores()
    expect(first.useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-v11'])
    // 搬家值已落盘新键——这是同版本态不丢数据的唯一保证（同版本 hydrate 不写回）
    const persisted = localStorage.getItem('pylon-custom-presets')
    expect(persisted, '搬家值必须当场落盘').toBeTruthy()
    // 模拟会话 1 内发生一次 theme 写盘（partialize 白名单修剪旧键内嵌字段）
    first.useThemeStore.getState().setZoneField('chat', { chatFontSize: 20 })
    // 会话 2（重启）：own 优先命中新键，与旧键是否被修剪无关
    const second = await freshStores()
    expect(second.useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-v11'])
  })

  it('新键有数据 → 不反向覆盖（旧键残留被忽略）', async () => {
    localStorage.setItem('pylon-custom-presets', JSON.stringify({
      state: {
        customPresets: [{ id: 'custom-new', name: '新键预设', theme: {}, createdAt: 5, updatedAt: 5 }],
        zonePresetEntries: [],
      },
      version: 1,
    }))
    localStorage.setItem('pylon-theme', JSON.stringify({
      state: { customPresets: [{ id: 'custom-old', name: '旧预设', theme: {}, createdAt: 1, updatedAt: 1 }] },
      version: 8,
    }))
    const { useCustomPresetStore } = await freshStores()
    expect(useCustomPresetStore.getState().customPresets.map(preset => preset.id)).toEqual(['custom-new'])
  })

  it('旧键损坏/缺字段 → 视同无数据（空态不抛）', async () => {
    localStorage.setItem('pylon-theme', '{not json')
    const { useCustomPresetStore } = await freshStores()
    expect(useCustomPresetStore.getState().customPresets).toEqual([])
  })
})

describe('跨 store 事务路由', () => {
  it('saveCustomPreset 快照读 themeStore 当前值，条目落新 store', async () => {
    const { useThemeStore, useCustomPresetStore } = await freshStores()
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 19 })
    const id = useCustomPresetStore.getState().saveCustomPreset('我的预设')
    const saved = useCustomPresetStore.getState().customPresets
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe(id)
    expect(saved[0].theme.chatFontSize).toBe(19)
    // themeStore 不再持有预设切片
    expect('customPresets' in useThemeStore.getState()).toBe(false)
  })

  it('写盘隔离：预设落新键，themeStore 的 pylon-theme 写盘值不再含预设字段', async () => {
    const { useThemeStore, useCustomPresetStore } = await freshStores()
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 19 })
    useCustomPresetStore.getState().saveCustomPreset('写盘隔离')
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 20 })
    const themeRaw = localStorage.getItem('pylon-theme')
    expect(themeRaw, '主题域必须已写盘').toBeTruthy()
    const themeState = (JSON.parse(themeRaw!) as { state: Record<string, unknown> }).state
    expect('customPresets' in themeState).toBe(false)
    expect('zonePresetEntries' in themeState).toBe(false)
    const presetRaw = localStorage.getItem('pylon-custom-presets')
    expect(presetRaw, '预设域必须已写盘').toBeTruthy()
    expect((JSON.parse(presetRaw!) as { state: { customPresets: unknown[] } }).state.customPresets).toHaveLength(1)
  })

  it('removeCustomPreset：条目删于新 store；被引用 zone 的 appliedPreset/custom 回写 themeStore', async () => {
    const { useThemeStore, useCustomPresetStore } = await freshStores()
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 19 })
    const id = useCustomPresetStore.getState().saveCustomPreset('被引用预设')
    await useCustomPresetStore.getState().applyCustomPreset(id)
    expect(useThemeStore.getState().appliedPreset.chat).toBe(id)

    useCustomPresetStore.getState().removeCustomPreset(id)
    expect(useCustomPresetStore.getState().customPresets).toHaveLength(0)
    // 引用该 id 的 zone 失去基准（appliedPreset=''）且 custom=true——字段保留现值
    expect(useThemeStore.getState().appliedPreset.chat).toBe('')
    expect(useThemeStore.getState().custom.chat).toBe(true)
    expect(useThemeStore.getState().chatFontSize).toBe(19)
  })

  it('saveZonePresetEntry 快照读 themeStore；removeZonePresetEntry 回写主题侧标记', async () => {
    const { useThemeStore, useCustomPresetStore } = await freshStores()
    useThemeStore.getState().setZoneField('sidebar', { sidebarBg: '#123456' })
    const id = useCustomPresetStore.getState().saveZonePresetEntry('gui', 'sidebar', '我的侧栏')!
    expect(id.startsWith('zone-gui-sidebar-')).toBe(true)
    expect(useCustomPresetStore.getState().zonePresetEntries[0].values?.sidebarBg).toBe('#123456')

    // 引用它后删除：失去基准 + 保留现值
    const entry = useCustomPresetStore.getState().zonePresetEntries[0]
    const { resolveZonePresetEntryTheme } = await import('../zones/index.ts')
    useThemeStore.getState().applyZonePreset('sidebar', id, resolveZonePresetEntryTheme(entry)!)
    useCustomPresetStore.getState().removeZonePresetEntry(id)
    expect(useCustomPresetStore.getState().zonePresetEntries).toHaveLength(0)
    expect(useThemeStore.getState().appliedPreset.sidebar).toBe('')
    expect(useThemeStore.getState().custom.sidebar).toBe(true)
    expect(useThemeStore.getState().sidebarBg).toBe('#123456')
  })
})
