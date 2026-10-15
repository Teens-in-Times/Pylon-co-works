// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 factoryZonePresets.test.ts，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library；显式 afterEach(cleanup)。
// - 局部预设组在 ZonePresetSection React 岛内（岛首渲异步）：presetGroup 改 async，
//   先等岛内容落地再取组（断言集不缩减）。
// - 文件随 solid 测试惯例改名 .solid.test.tsx；纯逻辑断言逐条未动。
/**
 * 刀2（#223 · 预设组装）：**出厂区域预设独立成数据**。
 *
 * 五条一起锁：
 * - **B1** 落盘数据 == 现场派生参考（50 条 × 全部字段逐条 `toEqual`，不是抽样），且池里的条目
 *   就是数据表里的那些**对象本身**（数据表是活数据源，不是被绕过的备份）；
 * - **B2** 出厂条目**不可删**（判据 `origin`、UI 不出删除入口、删除 reducer 是 no-op）；
 * - **B3** 出厂条目**不进** `zonePresetEntries`（用户不可删的结构性闸门）；
 * - **B4** 刀1 的区域引用解析**仍通**，且取到的值就是数据里的那份 `values`；
 * - **B5** 出厂数据里的**越区键报错**（不是静默丢弃）；
 * - **B6** **无折叠**（规范 §7 刀2「裁决 A」）：同形也各留一条、id 恒等于各自来源预设名。
 *
 * ★ 基线对拍用的「现场派生参考」= `deriveZonePresetPool` / `pickZoneFields`（刀2 起退为参考实现，
 * 只给生成脚本与本文件用）；外部基线是备份存档
 * `预设修正/备份/预设组装-前存档-20260921/`（与本文件的派生参考逐字节一致，见开发记录）。
 */
import { cleanup, fireEvent, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GLOBAL_PRESETS } from '../../presets/index.ts'
import { PRESET_ZONES, filterPresetTheme, requireZoneRefs } from '../../presetReducer.ts'
import { expandGlobalPresetZoneRefs } from '../../../../application/transactions/applyGlobalPreset.ts'
import { DEFAULTS } from '../../themeDefaults.ts'
import type { ThemeSettings } from '../../themeStore.ts'
import { useThemeStore } from '../../themeStore.ts'
import { useCustomPresetStore } from '../../customPresetStore.ts'
import { useInterfaceModeStore } from '../../../interface/interfaceModeStore.ts'
import { mountSettingsSheet } from '../../../../test/settingsSheetHarness.solid'
import { resetStores } from '../../../../test/resetStores.ts'
import { splitChatPresetValues } from '../chatPresetAxes.ts'
import { LANDING_PRESET_ENTRIES } from '../factory/landingEntries.ts'
import {
  FACTORY_ZONE_PRESET_ENTRIES,
  FACTORY_PROFILE_ZONE_PRESET_ENTRIES,
  ZONE_PRESET_POOL,
  assembleFactoryZonePresetPool,
  effectivePresetTheme,
  isCustomZonePresetEntry,
  removeZonePresetEntryReducer,
  zonePresetsFor,
  type ChatPresetAxis,
  type ZonePresetEntry,
} from '../index.ts'

vi.mock('../../components/settings/AgentRuntimePanel.solid.tsx', () => ({ default: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const BUCKETS = ['gui', 'terminal'] as const

function bucketPresetNames(mode: (typeof BUCKETS)[number]): string[] {
  return GLOBAL_PRESETS.filter(preset => preset.interfaceMode === mode).map(preset => preset.name)
}

async function presetGroup(): Promise<HTMLElement> {
  // 局部预设组由 ZonePresetSection React 岛承载，岛首渲异步——先等组标题落地。
  await vi.waitFor(() => {
    expect(screen.getByText('局部预设')).toBeInTheDocument()
  })
  return screen.getByText('局部预设').closest('.set-group') as HTMLElement
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
  useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
})

afterEach(async () => {
  cleanup()
})

// ── B1 数据 == 新材料里的工厂条目 ──────────────────────────────────

/**
 * 独立复算：工厂**原材料** → 工厂**材料** values 的两处规范化（`landingEntries` 的合同）：
 * 1. 只留预设管理字段（`filterPresetTheme`；`sidebarWidth` / `rightWidth` 不归预设管）；
 * 2. 待迁边线 `inputBorderColor`：global 去键、cc 收键（值取同级 global 原材料里的那份）。
 * 消息流按轴切两片（样式 / 配色）。
 */
function expectedFactoryMaterialValues(
  entry: ZonePresetEntry,
  zone: 'global' | 'sidebar' | 'cc' | 'right' | 'chat',
  axis?: ChatPresetAxis,
): Partial<ThemeSettings> {
  const values = filterPresetTheme(structuredClone(entry.values))
  if (zone === 'global') delete values.inputBorderColor
  if (zone === 'cc') {
    const sibling = FACTORY_ZONE_PRESET_ENTRIES.find(item => item.mode === entry.mode && item.zone === 'global' && item.id === entry.id)
    if (sibling?.values.inputBorderColor !== undefined) values.inputBorderColor = sibling.values.inputBorderColor
  }
  if (zone === 'chat') return splitChatPresetValues(values)[axis!]
  return values
}

function factoryMaterialOf(entry: ZonePresetEntry, zone: 'global' | 'sidebar' | 'cc' | 'right' | 'chat', axis?: ChatPresetAxis) {
  const id = zone === 'chat' ? `factory:${entry.id}:chat:${axis}` : `factory:${entry.id}:${zone}`
  const material = LANDING_PRESET_ENTRIES.find(item => item.id === id)
  expect(material, `${id} 材料必须存在`).toBeTruthy()
  return material!
}

describe('B1 落盘工厂数据 == 新材料里的工厂条目（50 条逐字段）', () => {
  it('50 条 × 每条全部字段与 factory: 材料逐字段相等（差异只有预设域过滤与待迁边线）', () => {
    expect(FACTORY_ZONE_PRESET_ENTRIES).toHaveLength(50)
    let checked = 0
    for (const entry of FACTORY_ZONE_PRESET_ENTRIES) {
      const at = `${entry.mode}/${entry.zone}/${entry.id}`
      expect(entry.origin, `${at} 出厂数据必须显式标 factory`).toBe('factory')
      expect(entry.source?.presetName, `${at} 来源可追溯`).toBe(entry.id)
      if (entry.zone === 'chat') {
        for (const axis of ['style', 'color'] as const) {
          const material = factoryMaterialOf(entry, 'chat', axis)
          expect(material.mode, `${at}/${axis} 同桶`).toBe(entry.mode)
          expect(material.axis, `${at}/${axis} 轴`).toBe(axis)
          expect(material.values, `${at}/${axis} 全部字段`).toEqual(expectedFactoryMaterialValues(entry, 'chat', axis))
          // 工厂条目无档案身份 ⇒ 样式单不带 styleMaterial（身份只属 Agent 卡合并材料）
          expect(material.styleMaterial, `${at}/${axis} 不带身份`).toBeUndefined()
        }
        checked += 1
        continue
      }
      const zone = entry.zone as 'global' | 'sidebar' | 'cc' | 'right'
      const material = factoryMaterialOf(entry, zone)
      expect(material.mode, `${at} 同桶`).toBe(entry.mode)
      // 刀3（#223）起预设不再自带 theme；#607 刀3a 起判据改对**工厂材料**本身
      // （旧断言 `== pickZoneFields(有效值视图, zone)` 在三张 Agent 卡上已不成立 ——
      //  它们的有效值视图是「工厂 ⊕ 档案」，比原材料多一批档案货物）。
      expect(material.values, `${at} 全部字段`).toEqual(expectedFactoryMaterialValues(entry, zone))
      checked += 1
    }
    expect(checked, '实际逐条对拍条数').toBe(50)
  })

  it('★ 落点材料是活数据源：池里的条目就是材料里的那些对象（不是重算出的副本）', () => {
    for (const mode of BUCKETS) {
      for (const zone of PRESET_ZONES) {
        for (const entry of ZONE_PRESET_POOL[mode][zone]) {
          expect(LANDING_PRESET_ENTRIES, `${mode}/${zone}/${entry.id} 必须是材料里的同一对象`).toContain(entry)
        }
      }
    }
  })

  it('每格条数 == 该桶预设数（消息流 ×2 轴），且候选恰好是该格的 `factory:*` 材料（顺序 = 材料顺序）', () => {
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        const cell = ZONE_PRESET_POOL[mode][zone]
        expect(cell, `${mode}/${zone} 条数`).toHaveLength(zone === 'chat' ? names.length * 2 : names.length)
        // 候选 = 材料里同桶同区的 `factory:*` 那批，顺序不变
        const expected = LANDING_PRESET_ENTRIES
          .filter(entry => entry.id.startsWith('factory:') && entry.mode === mode && entry.zone === zone)
          .map(entry => entry.id)
        expect(cell.map(entry => entry.id), `${mode}/${zone} 顺序`).toEqual(expected)
        // 且每套预设仍各留自己的那条（不折叠）
        for (const name of names) {
          expect(cell.filter(entry => entry.id.startsWith(`factory:${name}:`)), `${mode}/${zone}/${name}`)
            .toHaveLength(zone === 'chat' ? 2 : 1)
        }
      }
    }
  })
})

// ── B2 出厂条目不可删 ─────────────────────────────────────────────

describe('B2 出厂条目不可删', () => {
  it('判据（origin）对全部 50 条出厂条目一律为「非自定义」', () => {
    for (const entry of FACTORY_ZONE_PRESET_ENTRIES) {
      expect(isCustomZonePresetEntry(entry), `${entry.mode}/${entry.zone}/${entry.id}`).toBe(false)
    }
  })

  it('删除 reducer 传出厂预设名是 no-op（不动条目、不写标记）', () => {
    const state = {
      zonePresetEntries: [] as ZonePresetEntry[],
      appliedPreset: { ...DEFAULTS.appliedPreset },
      custom: { ...DEFAULTS.custom },
    }
    const patch = removeZonePresetEntryReducer(state, 'glass')
    expect(patch.zonePresetEntries, '未命中 ⇒ 原引用返回').toBe(state.zonePresetEntries)
    expect(patch.appliedPreset, '未命中 ⇒ 不写状态').toBeUndefined()
    expect(patch.custom).toBeUndefined()
  })

  it('UI：出厂 chip 被选中也不出删除入口（判据没被 values 接管）', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(await presetGroup())
    fireEvent.click(group.getByRole('button', { name: 'Glass Light' }))
    expect(group.queryAllByRole('button', { name: '删除' })).toHaveLength(0)
  })

  it('判据没有把两方都吞掉：自定义条目仍判为自定义，且入池时被显式标 custom', () => {
    const custom: ZonePresetEntry = {
      id: 'zone-gui-sidebar-1', mode: 'gui', zone: 'sidebar', label: '我的侧栏',
      values: { sidebarBg: '#123456' },
    }
    expect(isCustomZonePresetEntry(custom), '没有 origin ⇒ 按自定义').toBe(true)
    const [inPool] = zonePresetsFor('modern-gui', 'sidebar', [custom]).filter(entry => entry.id === custom.id)
    expect(inPool.origin, '持久化通道里的一律标 custom').toBe('custom')
    expect(isCustomZonePresetEntry(inPool)).toBe(true)
  })
})

// ── B3 出厂条目不进 zonePresetEntries ─────────────────────────────

describe('B3 出厂条目不进 zonePresetEntries（结构性闸门）', () => {
  it('存/删自定义条目的整条流程跑完，50 条出厂条目始终不在该数组里', () => {
    const factoryIds = new Set(FACTORY_ZONE_PRESET_ENTRIES.map(entry => entry.id))
    expect(factoryIds.size, '出厂条目 id 去重后 = 10 套预设名').toBe(10)

    const profileFactoryIds = new Set(FACTORY_PROFILE_ZONE_PRESET_ENTRIES.map(entry => entry.id))
    const assertNoFactoryIds = (stage: string) => {
      for (const entry of useCustomPresetStore.getState().zonePresetEntries) {
        expect(factoryIds.has(entry.id), `${stage}：出厂条目 ${entry.id} 混进了用户条目数组`).toBe(false)
        expect(profileFactoryIds.has(entry.id), `${stage}：档案出厂条目 ${entry.id} 混进了用户条目数组`).toBe(false)
      }
    }

    assertNoFactoryIds('起点')
    useThemeStore.getState().setZoneField('sidebar', { sidebarBg: '#123456' })
    const id = useCustomPresetStore.getState().saveZonePresetEntry('gui', 'sidebar', '我的侧栏')!
    expect(useCustomPresetStore.getState().zonePresetEntries.map(entry => entry.id)).toEqual([id])
    assertNoFactoryIds('存之后')

    useCustomPresetStore.getState().removeZonePresetEntry(id)
    expect(useCustomPresetStore.getState().zonePresetEntries).toHaveLength(0)
    assertNoFactoryIds('删之后')
  })
})

// ── B4 引用解析仍通 ───────────────────────────────────────────────

describe('B4 刀1 的区域引用解析仍通（10 套 × 5 区域）', () => {
  it('全部解析成功，切片并集 == 有效值视图，且切片与材料隔离（不是材料对象本体）', () => {
    for (const preset of GLOBAL_PRESETS) {
      const refs = requireZoneRefs(preset.zoneRefs, preset.name)
      const slices = expandGlobalPresetZoneRefs(preset.interfaceMode, refs)
      expect(slices.map(slice => slice.zone), `${preset.name} 区域覆盖`).toEqual([...PRESET_ZONES])
      for (const slice of slices) {
        expect(slice.theme, `${preset.name}/${slice.zone} 必须可应用`).toBeTruthy()
        expect(Object.keys(slice.theme).length, `${preset.name}/${slice.zone} 不能是空切片`).toBeGreaterThan(0)
      }
      // ★ #607 刀3a：两个消费入口（有效值视图 / 装配切片）必须同源同值。
      //   逐区切片对拍「view 的该区切面」这条形式已退场：视图按**字段归属**投影，
      //   而材料把待迁边线放在 cc、字段归属仍写 global（`legacyAssemblySlices` 只搬不改值）
      //   ⇒ 两边的区域投影天然差一个键。改成对拍「并集 == 视图」——它才是取值等价的正题。
      const union = Object.assign({}, ...slices.map(slice => slice.theme))
      expect(union, `${preset.name} 切片并集 == 有效值视图`).toEqual(effectivePresetTheme(preset))
      // 隔离：交出去的切片是克隆（改切片不得回写材料）
      for (const slice of slices) {
        expect(LANDING_PRESET_ENTRIES.some(entry => entry.values === slice.theme), `${preset.name}/${slice.zone} 不得是材料本体`).toBe(false)
      }
    }
  })
})

// ── B5 越区键报错 ─────────────────────────────────────────────────

describe('B5 出厂数据里的越区键必须报错（不是静默丢弃）', () => {
  it('真实数据装配为池不报错', () => {
    expect(() => assembleFactoryZonePresetPool(FACTORY_ZONE_PRESET_ENTRIES)).not.toThrow()
  })

  it('往 cc 区域塞一个左栏字段 ⇒ 构造期抛错，且报出越区键名', () => {
    const poisoned: ZonePresetEntry = {
      id: 'glass', mode: 'gui', zone: 'cc', label: '毒条目', origin: 'factory',
      values: { ccBg: '#000000', sidebarBg: '#000000' },
    }
    expect(() => assembleFactoryZonePresetPool([poisoned])).toThrow(/越区/)
    expect(() => assembleFactoryZonePresetPool([poisoned])).toThrow(/sidebarBg/)
  })
})

// ── B6 无折叠 ─────────────────────────────────────────────────────

describe('B6 无折叠（规范 §7 刀2「裁决 A」）', () => {
  it('每套预设各留自己那条（消息流两轴各一条）——同形也不折叠，池里不再有 sources', () => {
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        const cell = ZONE_PRESET_POOL[mode][zone]
        // 折叠若复活：同形的另一条会被折进来 ⇒ 少了 id ⇒ 该套预设的引用解析不到
        expect(cell.map(entry => entry.id), `${mode}/${zone} 每套预设各留一条`)
          .toEqual(names.flatMap(name => zone === 'chat'
            ? [`factory:${name}:chat:style`, `factory:${name}:chat:color`]
            : [`factory:${name}:${zone}`]))
        for (const entry of cell) expect(entry, `${mode}/${zone}/${entry.id}`).not.toHaveProperty('sources')
      }
    }
  })

  it('合成两块同形切面：仍是 2 条，各自 id = 各自的来源预设名', () => {
    // 刀3（#223）：刀2 的 `deriveZonePresetPool` 参考实现已删 ⇒ 夹具改为**手写条目**
    const twins: ZonePresetEntry[] = [
      // 内容同形、字段书写顺序不同
      { id: 'nord', mode: 'gui', zone: 'sidebar', label: '双胞胎甲', origin: 'factory', source: { presetName: 'nord' }, values: { sidebarBg: '#111', sidebarNameSize: 14 } },
      { id: 'tokyo', mode: 'gui', zone: 'sidebar', label: '双胞胎乙', origin: 'factory', source: { presetName: 'tokyo' }, values: { sidebarNameSize: 14, sidebarBg: '#111' } },
    ]
    const cell = assembleFactoryZonePresetPool(twins).gui.sidebar
    expect(cell).toHaveLength(2)
    expect(cell.map(entry => entry.id)).toEqual(['nord', 'tokyo'])
    expect(cell.map(entry => entry.label)).toEqual(['双胞胎甲', '双胞胎乙'])
    for (const entry of cell) {
      expect(entry.source, '来源仍可追溯').toEqual({ presetName: entry.id })
      expect(entry.values).toEqual({ sidebarBg: '#111', sidebarNameSize: 14 })
      expect(entry).not.toHaveProperty('sources')
    }
  })
})
