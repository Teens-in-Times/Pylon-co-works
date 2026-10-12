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
import { PRESET_ZONES, requireZoneRefs } from '../../presetReducer.ts'
import { expandGlobalPresetZoneRefs } from '../../../../application/transactions/applyGlobalPreset.ts'
import { DEFAULTS } from '../../themeDefaults.ts'
import { useThemeStore } from '../../themeStore.ts'
import { useCustomPresetStore } from '../../customPresetStore.ts'
import { useInterfaceModeStore } from '../../../interface/interfaceModeStore.ts'
import { mountSettingsSheet } from '../../../../test/settingsSheetHarness.solid'
import { resetStores } from '../../../../test/resetStores.ts'
import {
  FACTORY_ZONE_PRESET_ENTRIES,
  FACTORY_PROFILE_ZONE_PRESET_ENTRIES,
  ZONE_PRESET_POOL,
  assembleFactoryZonePresetPool,
  effectivePresetTheme,
  isCustomZonePresetEntry,
  pickZoneFields,
  removeZonePresetEntryReducer,
  resolveZonePresetEntryTheme,
  zonePresetsFor,
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

// ── B1 数据 == 派生参考 ────────────────────────────────────────────

describe('B1 落盘数据 == 来源预设有效值在该区的切面（50 条逐字段）', () => {
  it('50 条 × 每条全部字段与 pickZoneFields(有效值视图, zone) 逐字段相等', () => {
    expect(FACTORY_ZONE_PRESET_ENTRIES).toHaveLength(50)
    let checked = 0
    for (const entry of FACTORY_ZONE_PRESET_ENTRIES) {
      const at = `${entry.mode}/${entry.zone}/${entry.id}`
      const preset = GLOBAL_PRESETS.find(candidate => candidate.name === entry.id)
      expect(preset, `${at} 来源预设必须存在（id = 来源预设名）`).toBeTruthy()
      expect(entry.origin, `${at} 出厂数据必须显式标 factory`).toBe('factory')
      expect(entry.source?.presetName, `${at} 来源可追溯`).toBe(entry.id)
      // 刀3（#223）：预设不再自带 theme ⇒ 参考值改由有效值视图取（= 该预设五区切面之并集）。
      // 这条锁的是「切片 → 并集 → 再切回该区」这条往返无损（没有哪一区的值在合并里被别的区盖掉）。
      expect(entry.values, `${at} 全部字段`).toEqual(pickZoneFields(effectivePresetTheme(preset!), entry.zone))
      checked += 1
    }
    expect(checked, '实际逐条对拍条数').toBe(50)
  })

  it('★ 数据表是活数据源：池里的条目就是数据表里的那些对象（不是重算出的副本）', () => {
    for (const mode of BUCKETS) {
      for (const zone of PRESET_ZONES) {
        for (const entry of ZONE_PRESET_POOL[mode][zone]) {
          expect(FACTORY_ZONE_PRESET_ENTRIES, `${mode}/${zone}/${entry.id} 必须是数据表里的同一对象`).toContain(entry)
        }
      }
    }
  })

  it('每格条数 == 该桶预设数，且候选恰好是该格出厂条目（顺序 = 桶内预设顺序）', () => {
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        expect(ZONE_PRESET_POOL[mode][zone], `${mode}/${zone} 条数`).toHaveLength(names.length)
        expect(ZONE_PRESET_POOL[mode][zone].map(entry => entry.id), `${mode}/${zone} 顺序`).toEqual(names)
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
  it('全部解析成功，取到的值 = 有效值视图在该区的切面，且就是数据里的那份 values', () => {
    for (const preset of GLOBAL_PRESETS) {
      const refs = requireZoneRefs(preset.zoneRefs, preset.name)
      const slices = expandGlobalPresetZoneRefs(preset.interfaceMode, refs)
      expect(slices.map(slice => slice.zone), `${preset.name} 区域覆盖`).toEqual([...PRESET_ZONES])
      for (const slice of slices) {
        const at = `${preset.name}/${slice.zone}`
        // 刀3：预设不再自带 theme ⇒ 参考值改由有效值视图取
        expect(slice.theme, `${at} 等于视图的该区切面`).toEqual(pickZoneFields(effectivePresetTheme(preset), slice.zone))
        // 且来源是落盘数据里的那份 values（同一个对象 ⇒ 生产路径没有回头重算）
        const entry = ZONE_PRESET_POOL[preset.interfaceMode][slice.zone].find(candidate => candidate.id === slice.presetName)!
        expect(entry, `${at} 池里必须能解析到 ${slice.presetName}`).toBeTruthy()
        expect(slice.theme, `${at} 就是数据里的 values`).toBe(resolveZonePresetEntryTheme(entry))
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
  it('每格条目 id 恰好等于桶内预设名——同形也各留一条，池里不再有 sources', () => {
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        const cell = ZONE_PRESET_POOL[mode][zone]
        // 折叠若复活：同形的另一条会被折进来 ⇒ 少了 id ⇒ 该套预设的 zoneRefs 解析不到
        expect(cell.map(entry => entry.id), `${mode}/${zone} 每套预设各留一条`).toEqual(names)
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
