/**
 * #266 CC-13 刀4（小活③ · 数据卫生）：**历史废弃 placement id 的显式删键**。
 *
 * 来由：刀3 把布局键空间放开后，`normalizeCcLayout` 从「多余项忽略」改成「未知键保留」
 * （读盘发生在插件登记**之前** ⇒ 读盘丢会每次重启误删插件位置）。代价是已退场的内置 id
 * 也留在数据里 —— 本刀补一份**点名白名单**在结构对齐里显式删掉它们（幂等）。
 *
 * 锁四件事：
 * 1. 六个废弃 id（`pct` / `session` / `workspace` / `activity` / `ekg` / `tasks`）读盘后**不在数据里**；
 * 2. **插件件的 id 不受牵连**（未知键保留那条口径仍然管插件 —— 它有下游消费者）；
 * 3. 内置件的记录一字不动；`pct` 之外**白名单外的未知 id** 也照旧保留（白名单是清单，不是通配）；
 * 4. 幂等：连跑两次结果相同。
 */
import { describe, expect, it } from 'vitest'
import { alignThemeStructure, themeDomainMigrate } from '../migration.ts'
import { DEFAULTS } from '../themeDefaults.ts'
import { PRESET_ZONES } from '../presetReducer.ts'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT, normalizeCcLayout, type CcLayoutV3 } from '../../cc/ccLayoutState.ts'

const defaults = {
  base: DEFAULTS,
  appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])),
  custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  ccLayout: DEFAULTS.ccLayout,
}

type Aligned = { ccLayout: { version: number; placements: Record<string, unknown> }; ccHidden: unknown; ccHiddenEmpty: unknown }

const RETIRED_IDS = ['pct', 'session', 'workspace', 'activity', 'ekg', 'tasks'] as const

/** 一份老数据：六个废弃 id 全在 + 两个插件 id + 两个内置 id（内置值动过）。 */
const legacyLayout = (): Partial<CcLayoutV3> => ({
  version: 9,
  placements: {
    ...DEFAULT_CC_LAYOUT.placements,
    pct: { order: 2, offsetX: 0, offsetY: 0 },
    session: { order: 1, offsetX: 0, offsetY: 0 },
    workspace: { order: 1, offsetX: 0, offsetY: 0 },
    activity: { order: 3, offsetX: 0, offsetY: 0 },
    ekg: { order: 4, offsetX: 999, offsetY: 0 },
    tasks: { order: 5, offsetX: 0, offsetY: 0 },
    'probe.cc-alpha': { order: 8, offsetX: 6, offsetY: -2 },
    'vendor.other-widget': { order: 9, offsetX: 1, offsetY: 1 },
    model: { order: 7, offsetX: 12, offsetY: -3 },
  },
} as unknown as Partial<CcLayoutV3>)

describe('#266 CC-13 刀4 · 历史废弃 placement id 的显式清理', () => {
  it('读盘结构对齐：六个废弃 id 全部删掉，插件 id 与内置记录一字不动', () => {
    const aligned = alignThemeStructure({ ccLayout: legacyLayout() }, defaults) as unknown as Aligned
    for (const id of RETIRED_IDS) {
      expect(aligned.ccLayout.placements[id], id).toBeUndefined()
    }
    // 插件件 id：留下（读盘早于插件登记 —— "未知键保留"那条口径的目标）
    expect(aligned.ccLayout.placements['probe.cc-alpha']).toEqual({ order: 8, offsetX: 6, offsetY: -2 })
    expect(aligned.ccLayout.placements['vendor.other-widget']).toEqual({ order: 9, offsetX: 1, offsetY: 1 })
    // 内置记录：用户手调值原样
    expect(aligned.ccLayout.placements.model).toEqual({ order: 7, offsetX: 12, offsetY: -3 })
    expect(aligned.ccLayout.placements.reasoning).toEqual(DEFAULT_CC_LAYOUT.placements.reasoning)
  })

  it('白名单之外仍是"未知键保留"：别的历史形状 id 不会被顺手扫掉（清单不是通配）', () => {
    const withOutsiders = {
      ccLayout: { ...legacyLayout(), placements: { ...legacyLayout().placements, 'legacy.other-id': { order: 3, offsetX: 0, offsetY: 0 } } },
    } as unknown as { ccLayout: Partial<CcLayoutV3> }
    const aligned = alignThemeStructure(withOutsiders, defaults) as unknown as Aligned
    expect(aligned.ccLayout.placements['legacy.other-id']).toEqual({ order: 3, offsetX: 0, offsetY: 0 })
    expect(aligned.ccLayout.placements.pct).toBeUndefined()
  })

  it('幂等：连跑两次结果相同（第二次没有可删的键）', () => {
    const once = alignThemeStructure({ ccLayout: legacyLayout() }, defaults)
    const twice = alignThemeStructure(once, defaults)
    expect(twice).toEqual(once)
  })

  it('migrate 路径同样清（版本号不参与：每次读盘都跑）', () => {
    const migrated = themeDomainMigrate({ ccLayout: legacyLayout() }, defaults, 9) as unknown as Aligned
    expect(migrated.ccLayout.placements.pct).toBeUndefined()
    expect(migrated.ccLayout.placements.ekg).toBeUndefined()
    expect(migrated.ccLayout.placements['probe.cc-alpha']).toEqual({ order: 8, offsetX: 6, offsetY: -2 })
  })

  it('只清**位置**：显隐两份表里的废弃 id 不在本刀范围（口径点名）', () => {
    const aligned = alignThemeStructure({
      ccLayout: legacyLayout(),
      ccHidden: ['ekg', 'tokens'],
      ccHiddenEmpty: ['pct'],
    }, defaults) as unknown as Aligned
    expect(aligned.ccHidden).toEqual(['ekg', 'tokens'])
    expect(aligned.ccHiddenEmpty).toEqual(['pct'])
  })

  it('归一化本身不删（那一层保留未知键）；删键只在读盘对齐/migrate 这条迁移路径上', () => {
    const normalized = normalizeCcLayout(legacyLayout())
    expect(normalized.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
    expect(normalized.placements.pct).toEqual({ order: 2, offsetX: 0, offsetY: 0 })
  })
})
