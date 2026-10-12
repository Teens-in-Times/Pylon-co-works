import { describe, expect, it } from 'vitest'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT, normalizeCcLayout, type CcLayoutV3 } from '../ccLayoutState.ts'
import { CC_WIDGET_IDS } from '../widgetDefinitions.ts'

describe('Control Center layout v9（刀4 名单换代）', () => {
  it('默认布局覆盖全部可落槽控件，新增上下文控件使用稳定槽位', () => {
    expect(CC_LAYOUT_SCHEMA_VERSION).toBe(9)
    // 可落槽控件 = 内置轨 ∪ 注册轨中占槽位者（cc-send-button）
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements).sort()).toEqual([...CC_WIDGET_IDS, 'cc-send-button'].sort())
    // S11：pct 并入 tokens；用量控件默认排在权限控件右侧
    expect(DEFAULT_CC_LAYOUT.placements.tokens).toMatchObject({ order: 5 })
    // 刀4：legacy `send` 的槽位事实迁到注册轨 id
    expect(DEFAULT_CC_LAYOUT.placements['cc-send-button']).toMatchObject({ order: 0 })
    expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).not.toContain('pct')
    // 刀4 删除的 5 个 id 不得再出现在默认布局里
    for (const id of ['session', 'workspace', 'activity', 'ekg', 'send', 'tasks']) {
      expect(Object.keys(DEFAULT_CC_LAYOUT.placements)).not.toContain(id)
    }
  })

  it('v6 用户布局保留旧控件位置，legacy `send` 迁到 cc-send-button', () => {
    // v6 时代磁盘上只有 legacy `send`（没有 `cc-send-button` 这个键）
    const legacyPlacements: Record<string, unknown> = { ...DEFAULT_CC_LAYOUT.placements }
    delete legacyPlacements['cc-send-button']
    legacyPlacements.model = { slot: 'actions', order: 9, offsetX: 12, offsetY: -4 }
    legacyPlacements.send = { slot: 'actions', order: 7, offsetX: 4, offsetY: -2 }

    const normalized = normalizeCcLayout({ version: 6, placements: legacyPlacements } as unknown as Partial<CcLayoutV3>)
    expect(normalized.placements.model).toMatchObject({ order: 9, offsetX: 12, offsetY: -4 })
    // 刀4 数据迁移：键名换、位置不动
    expect(normalized.placements['cc-send-button']).toMatchObject({ order: 7, offsetX: 4, offsetY: -2 })
  })

  it('v8 老布局不被重置（版本白名单显式含 8）', () => {
    const v8 = {
      version: 8,
      placements: {
        model: { slot: 'actions' as const, order: 9, offsetX: 11, offsetY: -3 },
      },
    }
    const normalized = normalizeCcLayout(v8 as unknown as Partial<CcLayoutV3>)
    expect(normalized.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
    expect(normalized.placements.model).toMatchObject({ order: 9, offsetX: 11, offsetY: -3 })
    // 未提供的老键回落默认布局
    expect(normalized.placements.tokens).toEqual(DEFAULT_CC_LAYOUT.placements.tokens)
  })

  it('v7 老布局不被重置（版本白名单补 7，#197）', () => {
    // v7 时代磁盘上还是旧名单（含 session / ekg 等已删 id）与 legacy `send`
    const v7 = {
      version: 7,
      placements: {
        model: { slot: 'actions' as const, order: 9, offsetX: 11, offsetY: -3 },
        tokens: { slot: 'status-primary' as const, order: 1, offsetX: -2, offsetY: 4 },
        session: { slot: 'status-secondary' as const, order: 6, offsetX: 0, offsetY: 0 },
        ekg: { slot: 'status-primary' as const, order: 2, offsetX: 3, offsetY: 1 },
        send: { slot: 'actions' as const, order: 4, offsetX: 8, offsetY: -1 },
      },
    }
    const normalized = normalizeCcLayout(v7 as unknown as Partial<CcLayoutV3>)
    expect(normalized.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
    // 现役 id 的位置保留
    expect(normalized.placements.model).toMatchObject({ order: 9, offsetX: 11, offsetY: -3 })
    expect(normalized.placements.tokens).toMatchObject({ order: 1, offsetX: -2, offsetY: 4 })
    // legacy `send` 键名换、位置不动
    expect(normalized.placements['cc-send-button']).toMatchObject({ order: 4, offsetX: 8, offsetY: -1 })
    // ★ #266 CC-13 刀3：归一化语义改（「多余项忽略」→「未知键保留」）——
    //   已退场的 id（session / ekg）**留在数据里**（没有任何消费者 ⇒ 界面不可见；
    //   历史键的显式清理归 `domains/theme/migration.ts`，不在这条归一化里做）。
    expect(normalized.placements.session).toMatchObject({ order: 6, offsetX: 0, offsetY: 0 })
    expect(normalized.placements.ekg).toMatchObject({ order: 2, offsetX: 3, offsetY: 1 })
    // 唯一例外：legacy `send` 按别名并入真名，**不以 `send` 为键残留**
    expect(Object.keys(normalized.placements)).not.toContain('send')
  })

  // ★ #238 刀2 逐条点名：本用例的**样本一字未动**（版本 2 + 用户拖过的 model 位置），
  // 只把**期望**从「整份回落默认布局」改成「不再整份重置、按 id 合并保留用户位置」。
  // 改的原因：版本白名单整段退场 —— 旧写法把"磁盘上的版本号不在白名单里"当成
  // "这份数据不可用"，而白名单内插了「当前版本」这个变量 ⇒ 每次升版本号就自动少一项，
  // v7 就这么被漏掉过（磁盘上版本 7 的布局被整份丢弃、回落默认、不报错）。
  // 现在版本号不再参与"用不用老数据"；结构对齐每次读盘无条件跑。
  it('版本号是历史值/垃圾值也不再整份重置：按 id 合并并保留用户位置（#238 刀2）', () => {
    const v2 = { version: 2, placements: { model: { slot: 'actions' as const, order: 9, offsetX: 11, offsetY: -3 } } }
    const normalized = normalizeCcLayout(v2 as unknown as Partial<CcLayoutV3>)
    expect(normalized.placements.model).toEqual({ order: 9, offsetX: 11, offsetY: -3 })
    // 未提供的项仍补默认（"缺项补默认"是归一化的本职，与版本号无关）
    expect(normalized.placements.tokens).toEqual(DEFAULT_CC_LAYOUT.placements.tokens)
    expect(normalized.version).toBe(CC_LAYOUT_SCHEMA_VERSION)
  })
})
