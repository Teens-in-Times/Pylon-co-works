import { describe, expect, it } from 'vitest'
import { alignThemeStructure, normalizeThemeMigrationState, themeDomainMigrate } from '../migration.ts'
import { DEFAULT_CC_LAYOUT } from '../../cc/ccLayoutState.ts'
import { GLOBAL_PRESETS } from '../presets/index.ts'
import { effectivePresetTheme } from '../zones/index.ts'
import { DEFAULTS } from '../themeDefaults.ts'

describe('CC-21 input font read-time alignment', () => {
  it('old themes receive follow-message and existing plugin selections survive normalization', () => {
    const completeDefaults = { ...defaults, base: DEFAULTS }
    const old = alignThemeStructure({ msgFont: 'serif', accent: '#123456' }, completeDefaults)
    expect(old.inputFont).toBe('follow-message')
    expect(old.msgFont).toBe('serif')
    expect(old.accent).toBe('#123456')
    const plugin = alignThemeStructure({ inputFont: 'vendor.input', msgFont: 'mono' }, completeDefaults)
    expect(plugin.inputFont).toBe('vendor.input')
    expect(plugin.msgFont).toBe('mono')
  })
})

// A1 迁移映射矩阵：旧键映射 + custom 值 + id 命名空间

// 注：脚本原以扁平 defaults 调用（无 base 键）；现 API 统一为 ThemeMigrationDefaults
// （base/appliedPreset/custom/ccLayout）。base: {} 与原调用运行时语义一致（原 spread 为空）。
const defaults = {
  base: {},
  transparency: 0.85,
  ccLayout: DEFAULT_CC_LAYOUT,
  appliedPreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
  custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
} as const

describe('normalizeThemeMigrationState A1 映射矩阵（迁移自 scripts/test-theme-migration.mts，P91 A1）', () => {
  const migrated = normalizeThemeMigrationState({
    transparency: 0.5,
    // 旧模型输入：activePreset/dirty 键 + 'custom' 值（基准丢失）+ 非法值 + 越界 zone 键
    activePreset: { global: 'custom', sidebar: 42, unknown: 'leak' },
    dirty: { global: true, chat: 'yes' },
    ccLayout: { version: 99, placements: {} },
  }, defaults)
  const view = migrated as { appliedPreset: Record<string, unknown>; custom: Record<string, unknown>; ccLayout: unknown }

  it('透明度保留', () => {
    expect(migrated.transparency).toBe(0.5)
  })

  it('A1 映射：旧 activePreset.global=custom → appliedPreset.global=\'\' + custom.global=true', () => {
    expect(view.appliedPreset).toEqual({ ...defaults.appliedPreset, global: '' })
    expect(view.custom).toEqual({ ...defaults.custom, global: true })
    expect(view.appliedPreset.sidebar).toBe('') // sidebar:42 非法值回退默认
    expect('unknown' in view.appliedPreset).toBe(false) // 越界 zone 键被 PRESET_ZONES 白名单丢弃
    expect(typeof view.appliedPreset.global).toBe('string')
    expect(typeof view.custom.global).toBe('boolean')
    expect(view.ccLayout).toEqual(DEFAULT_CC_LAYOUT)
  })

  it('跨版本迁移保留待搬移的预设和独立会话数据', () => {
    const customPresets = [
      { id: 'ok', name: ' Valid ', theme: { transparency: 0.7 }, createdAt: 10, updatedAt: 11 },
      null,
      { id: '', name: 'bad', theme: {} },
      { id: 'missing-theme', name: 'bad' },
    ]
    const sessions = [{ id: 'existing-session' }]
    const finalOutput = themeDomainMigrate({
      transparency: 0.5,
      customPresets,
      sessions,
    }, defaults, 0)
    expect(finalOutput.customPresets).toEqual(customPresets)
    expect(finalOutput.sessions).toEqual(sessions)
  })

  it('空状态：全默认 + 无 ccPositions + 规范 ccLayout', () => {
    const empty = normalizeThemeMigrationState({}, defaults)
    expect(empty.appliedPreset).toEqual(defaults.appliedPreset)
    expect(empty.custom).toEqual(defaults.custom)
    expect('customPresets' in empty).toBe(false) // 输入无该字段时不注入
    expect('ccPositions' in empty).toBe(false) // 空状态不得出现 ccPositions
    expect(empty.ccLayout).toEqual(DEFAULT_CC_LAYOUT)
  })
})

describe('废弃坐标字段已清除（v3 以 slot layout 为真值）', () => {
  it('预设主题不得再携带 ekg/pct/tokens/model/mode/send/attach 坐标对象', () => {
    const deprecated = ['ekg', 'pct', 'tokens', 'model', 'mode', 'send', 'attach']
    for (const preset of GLOBAL_PRESETS) {
      const theme = effectivePresetTheme(preset) as Record<string, unknown>
      for (const id of deprecated) {
        expect(theme, `${preset.label} 不得携带废弃坐标 ${id}`).not.toHaveProperty(id)
      }
    }
  })
})

describe('旧中控布局', () => {
  it.each([
    ['同版本读盘', alignThemeStructure],
    ['跨版本升级', themeDomainMigrate],
  ] as const)('%s 清除废弃坐标，保留已保存的控件位置', (_name, migrate) => {
    const placement = { order: 3, offsetX: 7, offsetY: -2 }
    const migrated = migrate({
      ccSizes: { ekg: 42 },
      ccPositions: { ekg: { x: 1, y: 2 } },
      ccCliCustomized: true,
      ccLayoutVersion: 2,
      ccLayout: { version: 2, placements: { send: placement } },
    }, defaults)
    expect(migrated).not.toHaveProperty('ccSizes')
    expect(migrated).not.toHaveProperty('ccPositions')
    expect(migrated).not.toHaveProperty('ccCliCustomized')
    expect(migrated).not.toHaveProperty('ccLayoutVersion')
    expect(migrated.ccLayout).toMatchObject({
      version: DEFAULT_CC_LAYOUT.version,
      placements: { 'cc-send-button': placement },
    })
  })
})

// ★ #266 CC-08：字段已归布尔，老数据里存过的枚举值读盘时必须纠偏
// （兼容行先于通用归一化落定，否则 'hidden' 会被通用 pass 的 boolean case 兜成 default true）。
describe('inputShowHistoryHint 布尔化：老枚举值读盘纠偏', () => {
  it('hidden → false；shown → true；布尔值原样保留', () => {
    expect(alignThemeStructure({ inputShowHistoryHint: 'hidden' }, defaults).inputShowHistoryHint).toBe(false)
    expect(alignThemeStructure({ inputShowHistoryHint: 'shown' }, defaults).inputShowHistoryHint).toBe(true)
    expect(alignThemeStructure({ inputShowHistoryHint: false }, defaults).inputShowHistoryHint).toBe(false)
    expect(alignThemeStructure({ inputShowHistoryHint: true }, defaults).inputShowHistoryHint).toBe(true)
  })
})
