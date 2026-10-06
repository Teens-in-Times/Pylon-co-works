import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../themeDefaults.ts'
import { THEME_FIELD_DEFS } from '../themeFieldDefs.ts'
import { PRESET_ZONES } from '../presetReducer.ts'
import { THEME_SCHEMA_VERSION, themeDomainMigrate } from '../migration.ts'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT } from '../../cc/ccLayoutState.ts'

const defaults = {
  base: DEFAULTS,
  appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])),
  custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  ccLayout: DEFAULTS.ccLayout,
}

type Migrated = { ccLayout: { placements: Record<string, { slot: string; order: number }> } }

describe('theme schema v8：老安装补入 reasoning 控件', () => {
  // 回归锚点：不 bump 版本号，存量 v7 安装的 migrate 钩子不触发，
  // normalizeCcLayout 的补位逻辑就永远跑不到 —— 控件在老浏览器里永远不出现。
  it('持久化版本已推进到 11（刀4 名单换代的迁移仍然生效）', () => {
    expect(THEME_SCHEMA_VERSION).toBe(11)
  })

  it('存量 v7 布局缺 reasoning 时，migrate 后补入默认位置', () => {
    const legacyPlacements: Record<string, unknown> = { ...DEFAULT_CC_LAYOUT.placements }
    delete legacyPlacements.reasoning // 老浏览器存的清单里没有这一项
    const migrated = themeDomainMigrate({
      ccLayout: { version: CC_LAYOUT_SCHEMA_VERSION, placements: legacyPlacements },
    }, defaults, 7) as unknown as Migrated

    expect(migrated.ccLayout.placements.reasoning).toBeTruthy()
    expect(migrated.ccLayout.placements.reasoning).toMatchObject({ order: 3 })
    // 既有控件不被踩掉：补位是按 widget ID 合并，不是整表替换
    expect(migrated.ccLayout.placements.mode).toMatchObject({ order: 4 })
    expect(migrated.ccLayout.placements.model).toMatchObject({ order: 2 })
  })

  it('用户已拖过的 reasoning 位置不被默认值覆盖（迁移可重复执行）', () => {
    const placements = {
      ...DEFAULT_CC_LAYOUT.placements,
      reasoning: { slot: 'actions' as const, order: 9, offsetX: 7, offsetY: -3 },
    }
    const migrated = themeDomainMigrate({
      ccLayout: { version: CC_LAYOUT_SCHEMA_VERSION, placements },
    }, defaults, 8) as unknown as Migrated

    expect(migrated.ccLayout.placements.reasoning).toMatchObject({ order: 9 })
  })
})

describe('theme schema v9：老安装补入权限控件字段组（S10）', () => {
  // 回归锚点（2026-09-15）：控件 id `mode` 早已存在、布局无需补位，但 permission* 是新增
  // 字段。字段归一化只挂在 migrate 钩子上 —— 不 bump，存量安装里这 7 个键永远是
  // undefined，权限控件会按 NaN 尺寸渲染。
  it('存量 v8 主题缺 permission* 时，migrate 后补入默认值', () => {
    const legacy: Record<string, unknown> = { ...DEFAULTS }
    delete legacy.permissionSwitchMode
    delete legacy.permissionTextColor
    delete legacy.permissionWidth

    const migrated = themeDomainMigrate(legacy, defaults, 8)

    expect(migrated.permissionSwitchMode).toBe('menu')
    // ★ #266 遗留①：`permissionTextColor` 默认由 `'mode'`（跟模式枚举档）改成 **`''`** —— 自由选色下
    //   「留空」就是原来那一档的等价表达（不写 inline color，交 CSS `[data-mode]` 语义色）。
    //   这是**有意的语义变化**：老数据里的 `'mode'` 同样被归一化成 `''`（见开发记录）。
    expect(migrated.permissionTextColor).toBe('')
    expect(migrated.permissionWidth).toBe(120)
  })

  it('旧字段 pillBg 已从字段表移除（存量残留键不再被任何设置项/控件读取）', () => {
    // 迁移会原样保留未知的旧键（无害），真正的保证是字段表里已经没有它 ——
    // 设置面板不再暴露、主题变量注入不再生成 --pill-bg。
    expect(Object.keys(THEME_FIELD_DEFS)).not.toContain('pillBg')
    expect(Object.keys(DEFAULTS)).not.toContain('pillBg')
  })
})

describe('theme schema v10：用量控件（S11）', () => {
  // 回归锚点（2026-09-15）：pct 控件并入 tokens，用量控件的默认槽位也从
  // status-primary/3 挪到 status-secondary/5。布局补位只挂在 migrate 钩子上 ——
  // 不 bump 主题版本，存量安装的用量控件会一直停在旧位置，老 pct 键也清不掉。
  it('存量 v7 布局（pct 时代）迁移后：用量控件补位到权限控件右侧（pct 键随新归一化留在数据里）', () => {
    // v7 只有 pct、没有 tokens（tokens 随 v8 才出现）；#197 起 v7 进入白名单、
    // 用户布局不再整份重置，tokens 的新默认位由「缺失 id 补位」达成。
    const legacyPlacements: Record<string, unknown> = { ...DEFAULT_CC_LAYOUT.placements }
    delete legacyPlacements.tokens
    legacyPlacements.pct = { slot: 'status-primary', order: 2, offsetX: 0, offsetY: 0 }
    const legacy = { version: 7, placements: legacyPlacements }
    const migrated = themeDomainMigrate({ ccLayout: legacy }, defaults, 9) as unknown as Migrated

    // ★ #266 CC-13 刀3：归一化改「未知键保留」⇒ `pct` **不再被读盘丢掉**（它没有消费者 ⇒ 界面不可见）。
    //   本用例真正锚定的仍是下面那条：tokens 由「缺失 id 补位」拿到默认位。
    expect(migrated.ccLayout.placements.pct).toMatchObject({ order: 2 })
    expect(migrated.ccLayout.placements.tokens).toMatchObject({ order: 5 })
  })
})

describe('theme schema v11：中控名单换代（刀4）', () => {
  // 回归锚点（2026-09-18）：被删元件的字段键与 legacy `send` 键都只挂在 migrate 钩子上
  // 清理/改名 —— 不 bump 则老安装的 localStorage 里它们会一直留着。
  it('被删元件的 cc 字段键在迁移中清掉（ekg 四形态 + 用量条参数 + ccStyle）', () => {
    const legacy: Record<string, unknown> = {
      ...DEFAULTS,
      ccStyle: 'numeric', ekgWidth: 140, ekgGreen: '#4ade80', ekgYellow: '#fbbf24', ekgRed: '#f87171',
      barTrackColor: '#353117', barFillColor: '#22c55e', barFillFollow: true, barHeight: 8,
    }

    const migrated = themeDomainMigrate(legacy, defaults, 10)

    for (const key of ['ccStyle', 'ekgWidth', 'ekgGreen', 'ekgYellow', 'ekgRed', 'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight']) {
      expect(migrated).not.toHaveProperty(key)
    }
    // 保留项不受牵连
    // ★ #266 CC-07：原样本 `pillText` / `prismOnColor` 已随「用量胶囊」两字段删除
    //   ⇒ 换成仍在的中控字段锁同一件事（保留下来的值原样穿过、不被这次删键牵连）。
    expect(migrated.inputShowHistoryHint).toBe(DEFAULTS.inputShowHistoryHint)
    expect(migrated.ccBg).toBe(DEFAULTS.ccBg)
  })

  it('legacy `send` 的 ccHidden 键迁移到注册轨 id；已删的 `ccScale` 不再被改名', () => {
    const legacy: Record<string, unknown> = {
      ...DEFAULTS,
      ccHidden: ['send', 'tokens'],
      ccScale: { send: 120, model: 90 },
    }

    const migrated = themeDomainMigrate(legacy, defaults, 10)

    expect(migrated.ccHidden).toEqual(['cc-send-button', 'tokens'])
    // ★ #238 刀7：`ccScale` 字段整体删除 ⇒ 它的 legacy 键改名（`renameLegacyCcScaleKeys`）随之退场。
    //   这条**不**断言旧值被清掉：读盘路径不做键清（`store.ts` 的 `partialize` 是白名单式，
    //   下次写盘自然修剪）⇒ 这里如实锁住"值原样穿过、不再被改名"这一现状。
    expect(migrated.ccScale).toEqual({ send: 120, model: 90 })
  })
})
