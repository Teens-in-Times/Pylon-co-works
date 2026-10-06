import { describe, expect, it } from 'vitest'
import { alignThemeStructure } from '../migration.ts'
import { DEFAULTS } from '../themeDefaults.ts'
import { PRESET_ZONES } from '../presetReducer.ts'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT, normalizeCcLayout, type CcLayoutV3 } from '../../cc/ccLayoutState.ts'

/**
 * #238 刀2 · 结构对齐（`alignThemeStructure`）的等价性 / 幂等 / 不覆盖用户值。
 *
 * 本刀把「结构对齐」从 migrate 钩子搬到**每次读盘无条件跑**（挂钩在 `store.ts` 的
 * persist `merge`），并删掉 `normalizeCcLayout` 的版本白名单。
 * 这里钉住三件事：**等价性**（老数据结果可见不变）、**幂等**（连跑两次结果相同）、
 * **不覆盖用户手调值**（既定口径：「布局归一化不是把用户排布拍平」）。
 */

const defaults = {
  base: DEFAULTS,
  appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])),
  custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  ccLayout: DEFAULTS.ccLayout,
}

/**
 * 用户手调过的一把值：offset/order + 若干已设字段。
 * ★ 样本**保留 legacy `slot`** —— 这是老数据的真实形状；#238 刀3 起读盘**一律不读**它，
 * 所以下面断言的是「slot 被丢掉、其余原样」。
 */
const USER_PLACEMENT = { slot: 'status-secondary' as const, order: 7, offsetX: 12, offsetY: -3 }
/** 读盘对齐后应该剩下的东西（`slot` 已丢） */
const USER_EXPECTED = { order: 7, offsetX: 12, offsetY: -3 }

/** 造一份"只有部分控件项"的旧布局（老浏览器里存的真实形状就是缺项）。 */
const partialLayout = (version: number, placements: Record<string, unknown>): Partial<CcLayoutV3> =>
  ({ version, placements }) as unknown as Partial<CcLayoutV3>

type Aligned = {
  ccLayout: { version: number; placements: Record<string, unknown> }
  ccHidden: unknown
  ccHeight: number
  modelWidth: number
  ccBgImage: string
}

describe('#238 刀2 · (a) 缺项的旧版数据 ⇒ 自动补齐，用户 offset/order/已设字段原样保留', () => {
  const legacy = {
    // 老浏览器里存下的清单：只有 model 一项，其余控件项都缺（新增控件时代没 bump）
    ccLayout: { version: 9, placements: { model: { ...USER_PLACEMENT } } },
    ccHidden: ['tokens'],
    // ★ 刀7：这里原本放的是 `ccScale: { model: 120 }`（"已设对象字段原样保留"的样本）。
    //   缩放已删 ⇒ 改用一个**存活的 cc 区用户值**当样本，覆盖（"已设字段不拍平"）不丢。
    ccBgImage: 'url(fixture.png)',
    ccHeight: 220,
    modelWidth: 150,
  }

  it('缺项补默认（按当前控件全集逐 id 合并）', () => {
    const aligned = alignThemeStructure(legacy, defaults) as unknown as Aligned
    expect(Object.keys(aligned.ccLayout.placements).sort())
      .toEqual(Object.keys(DEFAULT_CC_LAYOUT.placements).sort())
    expect(aligned.ccLayout.placements.reasoning).toEqual(DEFAULT_CC_LAYOUT.placements.reasoning)
    expect(aligned.ccLayout.placements.tokens).toEqual(DEFAULT_CC_LAYOUT.placements.tokens)
    expect(aligned.ccLayout.placements['cc-send-button']).toEqual(DEFAULT_CC_LAYOUT.placements['cc-send-button'])
  })

  it('用户手调值一律保留（offset / order / 已设字段值；不拍平）', () => {
    const aligned = alignThemeStructure(legacy, defaults) as unknown as Aligned
    expect(aligned.ccLayout.placements.model).toEqual(USER_EXPECTED)
    expect(aligned.ccHeight).toBe(220)
    expect(aligned.modelWidth).toBe(150)
    expect(aligned.ccHidden).toEqual(['tokens'])
    expect(aligned.ccBgImage).toBe('url(fixture.png)')
  })

  // ★ #266 CC-13 刀3 语义改：「多余项忽略」→「**未知键保留**」——读盘不再丢名单外的键。
  //   原因：读盘发生在**插件登记之前**，读盘丢会在每次重启时误删插件位置（「重启后仍在」失效）。
  //   代价（点名）：已退场的内置 id（session / ekg）也随之**留在数据里**（无消费者 ⇒ 界面不可见）；
  //   要清它们得在 `migration.ts` 写显式迁移，不在这条归一化里做。
  it('未知键保留（名单外的旧 id 留在数据里，逐键 clamp；用户值仍不拍平）', () => {
    const withLegacyIds = {
      ccLayout: {
        version: 9,
        placements: {
          model: { ...USER_PLACEMENT },
          session: { slot: 'status-secondary', order: 1, offsetX: 0, offsetY: 0 },
          ekg: { slot: 'status-primary', order: 2, offsetX: 999, offsetY: 0 },
        },
      },
    }
    const aligned = alignThemeStructure(withLegacyIds, defaults) as unknown as Aligned
    expect(aligned.ccLayout.placements.session).toEqual({ order: 1, offsetX: 0, offsetY: 0 })
    // 未知键同过 clamp（offsetX 999 → 48）
    expect(aligned.ccLayout.placements.ekg).toEqual({ order: 2, offsetX: 48, offsetY: 0 })
    expect(aligned.ccLayout.placements.model).toEqual(USER_EXPECTED)
  })
})

describe('#238 刀2 · (b) 版本号是垃圾值 / 未来值 ⇒ 不再整份重置', () => {
  // 「缺 7」那类事故的根治证据：白名单退场后，版本号**完全不参与**"用不用老数据"。
  const placements = { model: { ...USER_PLACEMENT } }

  it('版本 7（发布过、曾被白名单漏掉）⇒ 位置保留', () => {
    const normalized = normalizeCcLayout(partialLayout(7, placements))
    expect(normalized.placements.model).toEqual(USER_EXPECTED)
    expect(normalized.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
  })

  it('版本 0 / 未来值 999 / 非数字 ⇒ 位置一律保留', () => {
    for (const version of [0, 1, 999, -1]) {
      const normalized = normalizeCcLayout(partialLayout(version, placements))
      expect(normalized.placements.model, `version=${version}`).toEqual(USER_EXPECTED)
    }
  })

  it('走完整对齐链路同样不重置（版本号不参与判定）', () => {
    for (const version of [7, 999]) {
      const aligned = alignThemeStructure({ ccLayout: { version, placements } }, defaults) as unknown as Aligned
      expect(aligned.ccLayout.placements.model, `version=${version}`).toEqual(USER_EXPECTED)
      expect(aligned.ccLayout.placements.reasoning).toEqual(DEFAULT_CC_LAYOUT.placements.reasoning)
    }
  })
})

describe('#238 刀2 · (c) 干净新装 ⇒ 与今天逐字段相同', () => {
  it('无持久化数据时，对齐结果 = 既有 DEFAULTS（逐个字段）', () => {
    const fresh = alignThemeStructure(undefined, defaults) as Record<string, unknown>
    for (const key of Object.keys(DEFAULTS)) {
      expect(fresh[key], `DEFAULTS.${key}`).toEqual((DEFAULTS as unknown as Record<string, unknown>)[key])
    }
  })

  it('空对象（有 key 但没内容）同样落在 DEFAULTS 上，且 ccLayout 完整', () => {
    const fresh = alignThemeStructure({}, defaults) as unknown as Aligned
    expect(fresh.ccLayout.placements).toEqual(DEFAULT_CC_LAYOUT.placements)
    expect(fresh.ccLayout.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
  })
})

describe('#238 刀2 · 幂等（连跑两次结果相同）', () => {
  const legacy = {
    ccLayout: {
      version: 9,
      placements: {
        model: { ...USER_PLACEMENT },
        reasoning: { slot: 'actions', order: 3, offsetX: -5, offsetY: 4 },
      },
    },
    ccHidden: ['tokens', 'tokens'],
    ccHeight: 300,
    modelWidth: 150,
  }

  it('alignThemeStructure 两次 = 一次', () => {
    const once = alignThemeStructure(legacy, defaults)
    const twice = alignThemeStructure(once, defaults)
    expect(twice).toEqual(once)
  })

  it('normalizeCcLayout 两次 = 一次', () => {
    const once = normalizeCcLayout(partialLayout(legacy.ccLayout.version, legacy.ccLayout.placements))
    expect(normalizeCcLayout(once)).toEqual(once)
  })

  it('对齐不修改入参（读盘路径拿到的是同一份磁盘数据）', () => {
    const snapshot = JSON.parse(JSON.stringify(legacy))
    alignThemeStructure(legacy, defaults)
    expect(legacy).toEqual(snapshot)
  })

  it('用户值处在合法范围内时不被 clamp 改动（第二次跑也不会漂）', () => {
    const once = alignThemeStructure(legacy, defaults) as unknown as Aligned
    expect(once.ccLayout.placements.model).toEqual(USER_EXPECTED)
    expect(once.ccLayout.placements.reasoning).toEqual({ order: 3, offsetX: -5, offsetY: 4 })
    expect(once.ccHeight).toBe(300)
  })
})
