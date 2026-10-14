// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * 刀6（#206）区域预设池。
 *
 * 覆盖施工单 §四 的四类验收：派生（每格条数 / 切面 / 去重 / label 取舍 / sources）、
 * 未登记模式空池（整组不渲染）、出厂条目应用切片与现状一致、自定义条目存取与持久化、
 * Q8 已删字段键自动清理 + 行内占位。
 */
// #515 改写点登记（迁移自 zonePresetPool.test.ts，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library；显式 afterEach(cleanup)；文件随 solid 测试惯例
//   改名 .solid.test.tsx。
// - 局部预设组在 ZonePresetSection React 岛内（岛首渲异步）：presetGroup 改 async 先等
//   岛内容落地；「未登记模式空池」先等岛常驻内容（模块组）落地再断言缺席，不再空转绿。
// - React act 包装改直调 store；点击/切换后的 DOM 断言包 vi.waitFor（solid 的 DOM 更新
//   是微任务异步）；store 状态断言（同步写）保持同步。断言集不缩减。
import { cleanup, fireEvent, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GLOBAL_PRESETS, INTERFACE_MODE_PRESET_BUCKET } from '../../presets/index.ts'
import { PRESET_ZONES } from '../../presetReducer.ts'
import { ZONE_FIELDS } from '../../themeFieldDefs.ts'
import type { ThemeSettings } from '../../themeStore.ts'
import { useThemeStore } from '../../themeStore.ts'
import { useCustomPresetStore } from '../../customPresetStore.ts'
import { useInterfaceModeStore } from '../../../interface/interfaceModeStore.ts'
import { mountSettingsSheet } from '../../../../test/settingsSheetHarness.solid'
import { resetStores } from '../../../../test/resetStores.ts'
import { FACTORY_POOL_ENTRIES } from '../zonePresetPool.ts'
import { LANDING_PRESET_ENTRIES } from '../factory/landingEntries.ts'
import { usePresentationPreferenceStore } from '../../../presentation/presentationPreferenceStore.ts'
import {
  ZONE_PRESET_POOL,
  assembleFactoryZonePresetPool,
  createZonePresetEntryId,
  isCustomZonePresetEntry,
  normalizeZonePresetEntries,
  normalizeZonePresetValues,
  resolveZonePresetEntryTheme,
  zonePresetsFor,
  type ZonePresetEntry,
} from '../zonePresetPool.ts'

vi.mock('../../components/settings/AgentRuntimePanel.solid.tsx', () => ({ default: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const BUCKETS = ['gui', 'terminal'] as const

function bucketPresetNames(mode: (typeof BUCKETS)[number]): string[] {
  return GLOBAL_PRESETS.filter(preset => preset.interfaceMode === mode).map(preset => preset.name)
}

/** 施工单 §四要求「报告每格条数」：本条把 8 格（+global 一列）读数打进测试输出。 */
function census(): Record<string, Record<string, number>> {
  return Object.fromEntries(BUCKETS.map(mode => [
    mode,
    Object.fromEntries(PRESET_ZONES.map(zone => [zone, ZONE_PRESET_POOL[mode][zone].length])),
  ]))
}

function presetGroupSync(): HTMLElement {
  return screen.getByText('局部预设').closest('.set-group') as HTMLElement
}

/** 局部预设组由 ZonePresetSection React 岛承载，岛首渲异步——先等组标题落地。 */
async function presetGroup(): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(screen.getByText('局部预设')).toBeInTheDocument()
  })
  return presetGroupSync()
}

afterEach(async () => {
  cleanup()
})

describe('zonePresetPool · 派生（刀6 #206）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('每格条数（消息流两轴各一份）与逐套覆盖（刀2 起不折叠）', () => {
    const cells = census()
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        const entries = ZONE_PRESET_POOL[mode][zone]
        // ★ #607 刀3a：池的来源换成落点材料 ⇒ 消息流区是两条单（样式 / 配色各一份）。
        const perPreset = zone === 'chat' ? 2 : 1
        expect(entries, `${mode}/${zone} 条数`).toHaveLength(names.length * perPreset)
        // 覆盖性（不折叠）：每套预设各留自己那条（消息流两轴各一条）
        for (const name of names) {
          expect(entries.filter(entry => entry.id.startsWith(`factory:${name}:`)), `${mode}/${zone}/${name}`)
            .toHaveLength(perPreset)
        }
      }
    }
    console.debug('[刀6] 每格条数', JSON.stringify(cells))
  })

  it('不折叠（刀2 / #223 裁决 A）：同形切面各留一条，各自 id 与 label 取自己的来源；sources 已退场', () => {
    // 刀3（#223）：刀2 的 `deriveZonePresetPool` 参考实现已删（预设不再自带 theme）⇒ 夹具改为**手写条目**
    const twinEntries: ZonePresetEntry[] = [
      // 前两条侧栏切面同形（且字段书写顺序不同）
      { id: 'glass', mode: 'gui', zone: 'sidebar', label: 'A1', origin: 'factory', source: { presetName: 'glass' }, values: { sidebarBg: '#111', sidebarNameSize: 14 } },
      { id: 'solarized', mode: 'gui', zone: 'sidebar', label: 'A2', origin: 'factory', source: { presetName: 'solarized' }, values: { sidebarNameSize: 14, sidebarBg: '#111' } },
      { id: 'nord', mode: 'gui', zone: 'sidebar', label: 'A3', origin: 'factory', source: { presetName: 'nord' }, values: { sidebarBg: '#222' } },
    ]
    const entries = assembleFactoryZonePresetPool(twinEntries).gui.sidebar
    // 折叠若复活：同形的两条会并成一条 ⇒ 长度 2、且 solarized 这条消失（它的引用就装不上了）
    expect(entries).toHaveLength(3)
    expect(entries.map(entry => entry.id)).toEqual(['glass', 'solarized', 'nord'])
    expect(entries.map(entry => entry.label)).toEqual(['A1', 'A2', 'A3'])
    expect(entries[0].source).toEqual({ presetName: 'glass' })
    expect(entries[1].source).toEqual({ presetName: 'solarized' })
    for (const entry of entries) expect(entry).not.toHaveProperty('sources')
  })

  it('蓝调桶已登记 ⇒ 区域行以家族唯一成员（默认单）出候选；未登记模式仍空池、整组不渲染', async () => {
    // ★ #607 刀3a：桶表补入 tactical-blue（规范 §三）⇒ 蓝调的区域行可见、可切换/重置/存自定义。
    //   蓝调家族里只有隐藏默认一员（没有工厂材料）⇒ 候选就是那条默认单。
    expect(INTERFACE_MODE_PRESET_BUCKET['tactical-blue']).toBe('tactical')
    expect(zonePresetsFor('tactical-blue', 'sidebar').map(entry => entry.id)).toEqual(['default:tactical:sidebar'])
    for (const axis of ['style', 'color'] as const) {
      expect(zonePresetsFor('tactical-blue', 'chat', [], axis).map(entry => entry.id))
        .toEqual([`default:tactical:chat:${axis}`])
    }
    // 未登记模式仍整组不渲染；未登记到池的区域轴（layout 无字段）同样是空
    expect(zonePresetsFor('not-registered', 'sidebar')).toEqual([])
    expect(zonePresetsFor('modern-gui', 'layout')).toEqual([])

    useInterfaceModeStore.setState({ interfaceMode: 'not-registered' })
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    // 先等侧栏岛常驻内容（「模块」组）落地，再断言「局部预设」整组不渲染（防缺席断言空转绿）
    await vi.waitFor(() => {
      expect(screen.getAllByText('模块').length).toBeGreaterThan(0)
    })
    expect(screen.queryByText('局部预设')).not.toBeInTheDocument()
  })

  it('出厂条目 = 材料里的同 id 条目（活数据源），且值过该区归属闸门', () => {
    // ★ #607 刀3a：判据从「来源预设有效值视图的该区切面」换成「**落点材料**里同 id 的那条」。
    //   视图自本刀起 = 工厂 ⊕ 档案、且不再携带非预设管理字段；池只装工厂材料 ⇒ 两者不再逐字段相等
    //   是合同变更，不是回归。「材料 == 规范化(原材料)」的强对拍在 factoryZonePresets.solid 的 B1。
    for (const mode of BUCKETS) {
      for (const zone of PRESET_ZONES) {
        for (const entry of ZONE_PRESET_POOL[mode][zone]) {
          const material = FACTORY_POOL_ENTRIES.find(item => item.id === entry.id)
          expect(material, `${mode}/${zone}/${entry.id} 必须是材料里的同 id 条目`).toBeTruthy()
          expect(entry, `${mode}/${zone}/${entry.id} 就是材料对象本身`).toBe(material)
          expect(resolveZonePresetEntryTheme(entry), `${mode}/${zone}/${entry.id}`).toEqual(material!.values)
        }
      }
    }
  })

  it('池按 (模式桶, 区域) 隔离：终端格的自定义条目不出现在 GUI 格', () => {
    const entry: ZonePresetEntry = {
      id: 'zone-terminal-sidebar-1', mode: 'terminal', zone: 'sidebar', label: '终端侧栏',
      values: { sidebarBg: '#000000' },
    }
    expect(zonePresetsFor('modern-gui', 'sidebar', [entry]).some(item => item.id === entry.id)).toBe(false)
    expect(zonePresetsFor('terminal-like', 'sidebar', [entry]).some(item => item.id === entry.id)).toBe(true)
    // 区域轴同理：同一模式、别的区不出现
    expect(zonePresetsFor('terminal-like', 'chat', [entry]).some(item => item.id === entry.id)).toBe(false)
  })
})

describe('zonePresetPool · 自定义条目（刀6 #206）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('存当前 → 入池（键含模式 + 区域）→ 应用恢复值；写盘可见且可按读入路径还原', () => {
    useThemeStore.getState().setZoneField('sidebar', { sidebarBg: '#123456', sidebarNameSize: 17 })
    const id = useCustomPresetStore.getState().saveZonePresetEntry('gui', 'sidebar', '我的侧栏')
    expect(id, '存当前必须返回条目 id').toBeTruthy()
    // 「键含模式 + 区域」
    expect(id!.startsWith('zone-gui-sidebar-')).toBe(true)

    const saved = useCustomPresetStore.getState().zonePresetEntries
    expect(saved).toHaveLength(1)
    expect(saved[0].label).toBe('我的侧栏')
    expect(saved[0].source, '自定义条目存值快照，不存引用').toBeUndefined()
    // 快照 = 该 zone 的 ZONE_FIELDS 字段集
    expect(Object.keys(saved[0].values ?? {}).sort()).toEqual([...ZONE_FIELDS.sidebar].sort())
    expect(saved[0].values?.sidebarBg).toBe('#123456')

    // 池：自定义条目接在出厂条目之后
    const entries = zonePresetsFor('modern-gui', 'sidebar', saved)
    const custom = entries.find(entry => entry.id === id)
    expect(custom, '自定义条目必须出现在该格').toBeTruthy()
    expect(entries.indexOf(custom!)).toBeGreaterThan(entries.length - 2)
    expect(custom!.label).toBe('我的侧栏')

    // 应用：改走再恢复
    useThemeStore.getState().setZoneField('sidebar', { sidebarBg: '#000000' })
    expect(useThemeStore.getState().sidebarBg).toBe('#000000')
    const theme = resolveZonePresetEntryTheme(custom!)
    expect(theme?.sidebarBg).toBe('#123456')
    useThemeStore.getState().applyZonePreset('sidebar', custom!.id, theme!)
    expect(useThemeStore.getState().sidebarBg).toBe('#123456')
    expect(useThemeStore.getState().sidebarNameSize).toBe(17)
    expect(useThemeStore.getState().appliedPreset.sidebar).toBe(id)
    expect(useThemeStore.getState().custom.sidebar).toBe(false)

    // 持久化：#448 PR5 起写独立键 pylon-custom-presets（拆出自 pylon-theme），读入路径可原样还原
    const raw = localStorage.getItem('pylon-custom-presets')
    expect(raw, '自定义预设域必须已写盘').toBeTruthy()
    const persisted = JSON.parse(raw!) as { state: { zonePresetEntries?: unknown } }
    expect(persisted.state.zonePresetEntries).toEqual(saved)
    expect(normalizeZonePresetEntries(persisted.state.zonePresetEntries)).toEqual(saved)
  })

  it('存当前：名称为空不建条目；id 撞号加后缀', () => {
    expect(useCustomPresetStore.getState().saveZonePresetEntry('gui', 'sidebar', '   ')).toBeNull()
    expect(useCustomPresetStore.getState().zonePresetEntries).toHaveLength(0)

    const existing = ['zone-gui-sidebar-1']
    expect(createZonePresetEntryId('gui', 'sidebar', 1, existing)).toBe('zone-gui-sidebar-1-1')
    expect(createZonePresetEntryId('terminal', 'cc', 2, existing)).toBe('zone-terminal-cc-2')
  })
})

describe('zonePresetPool · Q8 无效条目清理（刀6 #206）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('自定义快照里的已删字段键 ⇒ 自动清理 + 行内占位（灰显不可应用、不给开关）', async () => {
    // 刀4 已删字段（ekgWidth / barFillColor）+ 一个越区键
    const brokenValues = { ekgWidth: 3, barFillColor: '#ff0000', chatBg: '#ffffff' } as unknown as Partial<ThemeSettings>
    const broken: ZonePresetEntry = {
      id: 'zone-gui-sidebar-1', mode: 'gui', zone: 'sidebar', label: '失效条目', values: brokenValues,
    }

    // 数据层：清理键
    const cleaned = normalizeZonePresetValues('sidebar', brokenValues)
    expect(cleaned.droppedKeys.sort()).toEqual(['barFillColor', 'chatBg', 'ekgWidth'])
    expect(cleaned.values).toEqual({})

    // 查询层：条目退化为行内占位，且不可应用
    const entry = zonePresetsFor('modern-gui', 'sidebar', [broken]).find(item => item.id === broken.id)
    expect(entry?.stale).toBe(true)
    expect(resolveZonePresetEntryTheme(entry!)).toBeNull()

    // store：自动清理落盘（清的是键，不是用户条目）
    useCustomPresetStore.setState({ zonePresetEntries: [broken] })
    useCustomPresetStore.getState().pruneZonePresetEntries()
    expect(useCustomPresetStore.getState().zonePresetEntries).toHaveLength(1)
    expect(useCustomPresetStore.getState().zonePresetEntries[0].values).toEqual({})

    // UI：行内占位（灰显 + 不可点），且没有「是否清理」的用户开关
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(await presetGroup())
    const chip = group.getByRole('button', { name: '失效条目' })
    expect(chip).toBeDisabled()
    expect(chip.getAttribute('title')).toContain('字段已被删除')
    expect(group.queryByRole('switch')).not.toBeInTheDocument()
    expect(group.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('清理后仍有有效字段的条目照常可应用（只丢无效键）', () => {
    const entry: ZonePresetEntry = {
      id: 'zone-gui-sidebar-2', mode: 'gui', zone: 'sidebar', label: '半失效条目',
      values: { sidebarBg: '#abcdef', ekgWidth: 3 } as unknown as Partial<ThemeSettings>,
    }
    const [custom] = zonePresetsFor('modern-gui', 'sidebar', [entry]).filter(item => item.id === entry.id)
    expect(custom.stale).toBeUndefined()
    expect(custom.values).toEqual({ sidebarBg: '#abcdef' })
    expect(resolveZonePresetEntryTheme(custom)).toEqual({ sidebarBg: '#abcdef' })
  })
})

describe('zonePresetPool · ZonePresetRow 消费（刀6 #206）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('候选 = 该 (界面模式, 区域) 的池条目（同形折叠后有 sources 备注），自定义条目接在其后', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(await presetGroup())
    for (const entry of ZONE_PRESET_POOL.gui.sidebar) {
      expect(group.getByRole('button', { name: entry.label })).toBeInTheDocument()
    }
    // GUI 桶的侧栏格不含终端桶的预设标签
    expect(group.queryByRole('button', { name: 'Claude 风格' })).not.toBeInTheDocument()
    // 存当前入口（与全局预设的另存交互对齐）
    expect(group.getByPlaceholderText('区域预设名称')).toBeInTheDocument()
    expect(group.getByRole('button', { name: '存当前' })).toBeDisabled()
  })

  it('界面模式切到 terminal-like ⇒ 四个区的候选整批换桶', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    expect(within(await presetGroup()).getByRole('button', { name: 'Glass Light' })).toBeInTheDocument()
    useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' })
    await vi.waitFor(() => {
      const group = within(presetGroupSync())
      for (const entry of ZONE_PRESET_POOL.terminal.sidebar) {
        expect(group.getByRole('button', { name: entry.label })).toBeInTheDocument()
      }
      expect(group.queryByRole('button', { name: 'Glass Light' })).not.toBeInTheDocument()
    })
  })

  // 施工单 §八-3：选中的预设 chip 带 aria-current（本轮唯一的追加断言）
  it('选中的区域预设 chip 带 aria-current', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    fireEvent.click(within(await presetGroup()).getByRole('button', { name: 'Glass Light' }))
    await vi.waitFor(() => {
      expect(within(presetGroupSync()).getByRole('button', { name: 'Glass Light' })).toHaveAttribute('aria-current', 'true')
    })
  })
})

describe('zonePresetPool · 自定义条目删除（刀7 前置 #211）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  /** 播一条自定义条目并让它成为 sidebar 的当前基准（= 被选中态）。 */
  function seedSelectedCustomEntry(label = '我的侧栏'): string {
    useThemeStore.getState().setZoneField('sidebar', { sidebarBg: '#123456' })
    const id = useCustomPresetStore.getState().saveZonePresetEntry('gui', 'sidebar', label)!
    const entry = useCustomPresetStore.getState().zonePresetEntries.find(item => item.id === id)!
    useThemeStore.getState().applyZonePreset('sidebar', id, resolveZonePresetEntryTheme(entry)!)
    return id
  }

  it('删除闭环 + 持久化：条目从池与写盘内容里同时消失', () => {
    const id = seedSelectedCustomEntry()
    expect(zonePresetsFor('modern-gui', 'sidebar', useCustomPresetStore.getState().zonePresetEntries).some(e => e.id === id)).toBe(true)
    expect(localStorage.getItem('pylon-theme')).toContain(id)

    useCustomPresetStore.getState().removeZonePresetEntry(id)

    expect(useCustomPresetStore.getState().zonePresetEntries).toHaveLength(0)
    expect(zonePresetsFor('modern-gui', 'sidebar', useCustomPresetStore.getState().zonePresetEntries).some(e => e.id === id)).toBe(false)
    // 写回可见：重载后不复活
    expect(localStorage.getItem('pylon-theme')).not.toContain(id)
    expect(normalizeZonePresetEntries(
      (JSON.parse(localStorage.getItem('pylon-theme')!) as { state: { zonePresetEntries?: unknown } }).state.zonePresetEntries,
    )).toEqual([])
  })

  it('删除被引用的条目：该区失去基准但保留现值（与全局删除链同语义）', () => {
    const id = seedSelectedCustomEntry()
    expect(useThemeStore.getState().appliedPreset.sidebar).toBe(id)
    expect(useThemeStore.getState().sidebarBg).toBe('#123456')

    useCustomPresetStore.getState().removeZonePresetEntry(id)

    expect(useThemeStore.getState().appliedPreset.sidebar).toBe('')
    expect(useThemeStore.getState().custom.sidebar).toBe(true)
    expect(useThemeStore.getState().sidebarBg).toBe('#123456')
  })

  it('出厂条目不可删：把出厂预设名当 id 传进去是 no-op（不动条目、不写状态）', () => {
    const id = seedSelectedCustomEntry()
    const entriesBefore = useCustomPresetStore.getState().zonePresetEntries
    const appliedBefore = useThemeStore.getState().appliedPreset

    useCustomPresetStore.getState().removeZonePresetEntry('glass')

    expect(useCustomPresetStore.getState().zonePresetEntries).toBe(entriesBefore)
    expect(useThemeStore.getState().appliedPreset).toBe(appliedBefore)
    expect(useCustomPresetStore.getState().zonePresetEntries.map(entry => entry.id)).toEqual([id])
    expect(isCustomZonePresetEntry(ZONE_PRESET_POOL.gui.sidebar[0])).toBe(false)
  })

  it('两段式确认：点删除 → 行内 alertdialog → 确认删除后条目消失', async () => {
    seedSelectedCustomEntry()
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(await presetGroup())

    fireEvent.click(group.getByRole('button', { name: '删除' }))
    await vi.waitFor(() => {
      expect(group.getByRole('alertdialog')).toBeInTheDocument()
    })
    const dialog = group.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleName('确认删除区域预设 我的侧栏')
    expect(dialog).toHaveTextContent('将移除本区的自定义条目「我的侧栏」，本区保留现值但失去该预设基准')

    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    expect(useCustomPresetStore.getState().zonePresetEntries).toHaveLength(0)
    await vi.waitFor(() => {
      expect(within(presetGroupSync()).queryByRole('button', { name: '我的侧栏' })).not.toBeInTheDocument()
      expect(within(presetGroupSync()).queryByRole('alertdialog')).not.toBeInTheDocument()
    })
  })

  it('取消路径：点取消不删、无残留确认框、删除入口回到常规态', async () => {
    seedSelectedCustomEntry()
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(await presetGroup())

    fireEvent.click(group.getByRole('button', { name: '删除' }))
    await vi.waitFor(() => {
      expect(group.getByRole('alertdialog')).toBeInTheDocument()
    })
    fireEvent.click(within(group.getByRole('alertdialog')).getByRole('button', { name: '取消' }))

    expect(useCustomPresetStore.getState().zonePresetEntries).toHaveLength(1)
    await vi.waitFor(() => {
      expect(within(presetGroupSync()).queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(within(presetGroupSync()).getByRole('button', { name: '我的侧栏' })).toBeInTheDocument()
    expect(within(presetGroupSync()).queryAllByRole('button', { name: '删除' })).toHaveLength(1)
  })

  it('出现条件三态：出厂条目 0 个、自定义未选中 0 个、自定义被选中恰好 1 个', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const deletes = () => within(presetGroupSync()).queryAllByRole('button', { name: '删除' })

    // ① 出厂条目被选中 ⇒ 0 个（铁律 1：出厂件不可改、不可删）
    fireEvent.click(within(await presetGroup()).getByRole('button', { name: 'Glass Light' }))
    expect(deletes()).toHaveLength(0)

    // ② 自定义条目已存在但未被选中 ⇒ 0 个
    const id = useCustomPresetStore.getState().saveZonePresetEntry('gui', 'sidebar', '未选中的条目')!
    await vi.waitFor(() => {
      expect(within(presetGroupSync()).getByRole('button', { name: '未选中的条目' })).toBeInTheDocument()
    })
    expect(deletes()).toHaveLength(0)

    // ③ 选中该自定义条目 ⇒ 恰好 1 个
    const entry = useCustomPresetStore.getState().zonePresetEntries.find(item => item.id === id)!
    useThemeStore.getState().applyZonePreset('sidebar', id, resolveZonePresetEntryTheme(entry)!)
    await vi.waitFor(() => {
      expect(deletes()).toHaveLength(1)
    })
  })

  it('Q8 灰显占位条目可被删除（那是它唯一的自然出口）', async () => {
    const broken: ZonePresetEntry = {
      id: 'zone-gui-sidebar-9', mode: 'gui', zone: 'sidebar', label: '失效条目',
      values: { ekgWidth: 3 } as unknown as Partial<ThemeSettings>,
    }
    useCustomPresetStore.setState({ zonePresetEntries: [broken] })
    useCustomPresetStore.getState().pruneZonePresetEntries()
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(await presetGroup())

    // 占位条目本身灰显不可点，但删除入口常驻
    expect(group.getByRole('button', { name: '失效条目' })).toBeDisabled()
    fireEvent.click(group.getByRole('button', { name: '删除' }))
    await vi.waitFor(() => {
      expect(group.getByRole('alertdialog')).toBeInTheDocument()
    })
    fireEvent.click(within(group.getByRole('alertdialog')).getByRole('button', { name: '确认删除' }))
    expect(useCustomPresetStore.getState().zonePresetEntries).toHaveLength(0)
    await vi.waitFor(() => {
      expect(within(presetGroupSync()).queryByRole('button', { name: '失效条目' })).not.toBeInTheDocument()
    })
  })
})

// ── #607 刀3b：档案外观接入消息流样式行 ─────────────────────────────

describe('zonePresetPool · 档案外观候选（#607 刀3b）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('样式行候选 = 工厂条在前 + 档案条在后，且排除被预设用到的全部档案', () => {
    const factoryOf = (mode: string) => zonePresetsFor(mode, 'chat', [], 'style')
      .filter(entry => entry.id.startsWith('factory:'))
    const profileOf = (mode: string) => zonePresetsFor(mode, 'chat', [], 'style')
      .filter(entry => entry.id.startsWith('profile:'))

    for (const [mode, factoryCount, profileIds] of [
      ['modern-gui', 5, []],
      ['terminal-like', 5, [
        'profile:builtin.presentation.terminal-modern:chat:style',
        'profile:builtin.presentation.paper-low-contrast:chat:style',
        'profile:builtin.presentation.console-glass:chat:style',
      ]],
    ] as const) {
      const candidates = zonePresetsFor(mode, 'chat', [], 'style')
      expect(new Set(candidates.map(entry => entry.label)).size, `${mode} 无同名对`).toBe(candidates.length)
      expect(factoryOf(mode), `${mode} 工厂条数`).toHaveLength(factoryCount)
      expect(profileOf(mode).map(entry => entry.id), `${mode} 档案条`).toEqual([...profileIds])
      // 工厂条在前、档案条在后
      expect(candidates.map(entry => entry.id.startsWith('factory:')))
        .toEqual([...Array(factoryCount).fill(true), ...Array(profileIds.length).fill(false)])
      const defaultProfileId = mode === 'modern-gui'
        ? 'builtin.presentation.modern-gui' : 'builtin.presentation.terminal-classic'
      expect(candidates.some(entry => entry.id.includes(defaultProfileId)), `${mode} 默认档案不进候选`).toBe(false)
    }

    // 蓝调桶：1 工厂（无工厂材料 ⇒ 家族唯一成员 = 默认单）+ 0 档案
    expect(zonePresetsFor('tactical-blue', 'chat', [], 'style').map(entry => entry.id))
      .toEqual(['default:tactical:chat:style'])
  })

  it('排除集取默认单和预设样式材料的档案，未被使用的档案仍可作区域候选', () => {
    const used = new Set(LANDING_PRESET_ENTRIES
      .filter(entry => (entry.id.startsWith('default:') || entry.id.startsWith('preset:'))
        && entry.zone === 'chat' && entry.axis === 'style')
      .map(entry => entry.styleMaterial?.profileId)
      .filter((profileId): profileId is string => Boolean(profileId)))
    expect([...used].sort()).toEqual([
      'builtin.presentation.agent-command', 'builtin.presentation.agent-map',
      'builtin.presentation.focus-flow', 'builtin.presentation.modern-gui',
      'builtin.presentation.tactical-blue', 'builtin.presentation.terminal-classic',
    ])
    for (const [mode, bucket] of [
      ['modern-gui', 'gui'], ['terminal-like', 'terminal'], ['tactical-blue', 'tactical'],
    ] as const) {
      for (const zone of ['chat', 'cc'] as const) {
        const expected = LANDING_PRESET_ENTRIES.filter(entry => entry.id.startsWith('profile:')
          && entry.mode === bucket && entry.zone === zone
          && (zone === 'cc' || entry.axis === 'style')
          && !used.has(entry.source?.profileId ?? ''))
        const actual = zonePresetsFor(mode, zone, [], zone === 'chat' ? 'style' : undefined)
          .filter(entry => entry.id.startsWith('profile:'))
        expect(actual, `${mode}/${zone} 档案排除集`).toEqual(expected)
      }
    }
  })

  it('中控行候选 = 工厂条在前 + 终端三套档案条在后，GUI 和蓝调不加档案', () => {
    for (const [mode, bucket, profileIds] of [
      ['terminal-like', 'terminal', [
        'profile:builtin.presentation.terminal-modern:cc',
        'profile:builtin.presentation.paper-low-contrast:cc',
        'profile:builtin.presentation.console-glass:cc',
      ]],
      ['modern-gui', 'gui', []],
      ['tactical-blue', 'tactical', []],
    ] as const) {
      const candidates = zonePresetsFor(mode, 'cc')
      expect(candidates.map(entry => entry.id)).toEqual([
        ...ZONE_PRESET_POOL[bucket].cc.map(entry => entry.id), ...profileIds,
      ])
      expect(new Set(candidates.map(entry => entry.label)).size, `${mode} 中控无同名对`).toBe(candidates.length)
    }
    expect(zonePresetsFor('not-registered', 'cc')).toEqual([])
  })

  it.each(['terminal-modern', 'paper-low-contrast', 'console-glass'])(
    '档案中控条 %s 可点击应用：材料逐键落值，其他区域和身份不变', async profileName => {
      useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' })
      const id = `profile:builtin.presentation.${profileName}:cc`
      const material = LANDING_PRESET_ENTRIES.find(entry => entry.id === id)!
      const before = useThemeStore.getState()
      const profileBefore = usePresentationPreferenceStore.getState().activeProfileId
      mountSettingsSheet({ domain: 'appearance', section: 'cc' })
      const chip = await screen.findByRole('button', { name: material.label })
      fireEvent.click(chip)
      const after = useThemeStore.getState()
      expect(after.appliedPreset.cc).toBe(id)
      for (const [key, value] of Object.entries(material.values)) {
        expect(after[key as keyof ThemeSettings], `${id}/${key}`).toEqual(value)
      }
      for (const zone of PRESET_ZONES.filter(zone => zone !== 'cc')) {
        for (const key of ZONE_FIELDS[zone]) {
          if (Object.hasOwn(material.values, key)) continue
          expect(after[key as keyof ThemeSettings], `${id} 不改 ${zone}/${key}`).toEqual(before[key as keyof ThemeSettings])
        }
        expect(after.appliedPreset[zone]).toBe(before.appliedPreset[zone])
        expect(after.custom[zone]).toBe(before.custom[zone])
      }
      expect(usePresentationPreferenceStore.getState().activeProfileId).toBe(profileBefore)
    },
  )

  it('配色行不加档案条（只有样式行接）', () => {
    for (const mode of ['modern-gui', 'terminal-like']) {
      expect(zonePresetsFor(mode, 'chat', [], 'color').every(entry => !entry.id.startsWith('profile:'))).toBe(true)
    }
  })

  it('终端三套档案外观可应用：账记材料 id，生效值就是材料值', async () => {
    useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' })
    mountSettingsSheet({ domain: 'appearance', section: 'chat' })
    // 消息流两条行（样式单 / 配色单）由该组承载，档案条只在样式单那一行
    await vi.waitFor(() => {
      expect(screen.getByText('消息流样式单')).toBeInTheDocument()
    })

    const chip = await screen.findByRole('button', { name: '低对比纸张' })
    fireEvent.click(chip)

    expect(useThemeStore.getState().appliedPreset.chat)
      .toBe('profile:builtin.presentation.paper-low-contrast:chat:style')
    expect(useThemeStore.getState()).toMatchObject({
      msgStyle: 'bubble', messageLayout: 'claude', chatFont: 'serif', msgFont: 'serif', messageRadius: 4,
    })
    // 出厂件：不可删（删除钮只在自定义条目上出现）
    const styleRow = within(screen.getByText('消息流样式单').closest('.set-group') as HTMLElement)
    expect(styleRow.queryAllByRole('button', { name: '删除' })).toHaveLength(0)
  })
})
