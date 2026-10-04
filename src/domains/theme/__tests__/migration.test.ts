// 迁移自 scripts/test-theme-migration.mts（P91 A1）
// ★ #266 刀9：`themeDomainMigrate` 的 `inputVariant↔inputMode` 联动用例已随字段删除退场。
//   #448 PR5 起该函数重新入列（钉住「预设字段不进最终 migrate 输出」的拆分契约）。
import { describe, expect, it } from 'vitest'
import { alignThemeStructure, normalizeThemeMigrationState, themeDomainMigrate } from '../migration.ts'
import { DEFAULT_CC_LAYOUT } from '../../cc/ccLayoutState.ts'
import { GLOBAL_PRESETS } from '../presets/index.ts'
import { effectivePresetTheme } from '../zones/index.ts'
import { PROFILE_SCHEMA_VERSION } from '../../identity/profilePersistence.ts'
import { readFileSync } from 'node:fs'
import { CC_LAYOUT_SCHEMA_VERSION } from '../../cc/ccLayoutState.ts'

const migrationSource = readFileSync('src/domains/theme/migration.ts', 'utf8')

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
    ccSizes: { stale: true },
    // 旧模型输入：activePreset/dirty 键 + 'custom' 值（基准丢失）+ 非法值 + 越界 zone 键
    activePreset: { global: 'custom', sidebar: 42, unknown: 'leak' },
    dirty: { global: true, chat: 'yes' },
    ccPositions: { ekg: { x: 12, y: 18, w: 999 }, bogus: { x: 1, y: 2 } },
    ccCliCustomized: true,
    ccLayoutVersion: 2,
    ccLayout: { version: 99, placements: {} },
    customPresets: [
      { id: 'ok', name: ' Valid ', theme: { transparency: 0.7 }, createdAt: 10, updatedAt: 11 },
      null,
      { id: '', name: 'bad', theme: {} },
      { id: 'missing-theme', name: 'bad' },
    ],
    sessions: [{ id: 'must remain outside theme conclusion' }],
  }, defaults)
  const view = migrated as { appliedPreset: Record<string, unknown>; custom: Record<string, unknown>; ccLayout: unknown; customPresets: unknown }

  it('透明度保留；旧键（ccSizes/ccPositions/ccCliCustomized/ccLayoutVersion）不得保留', () => {
    expect(migrated.transparency).toBe(0.5)
    expect('ccSizes' in migrated).toBe(false)
    expect('ccPositions' in migrated).toBe(false) // 迁移结果不得保留 ccPositions
    expect('ccCliCustomized' in migrated).toBe(false) // 迁移结果不得保留 ccCliCustomized
    expect('ccLayoutVersion' in migrated).toBe(false) // 迁移结果不得保留 ccLayoutVersion
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

  it('A1 命名空间：migrate 函数输出无损透传预设字段（#448 PR5——写回由 partialize 洗、搬家由 stash 保）', () => {
    // 契约分工：themeDomainMigrate 的输出（normalizeThemeValues 是 Object.assign
    // 原地合并，非白名单重建）无损透传 customPresets；「pylon-theme 不再持久化预设」
    // 由 themeStore 的 partialize 白名单保证；搬家数据源由 migrate 钩子暂存
    // （legacyPresetStash——写回发生在读取之后时现场值已被洗，暂存兜底）。
    const finalOutput = themeDomainMigrate({
      transparency: 0.5,
      customPresets: [{ id: 'ok', name: 'Valid', theme: { transparency: 0.7 }, createdAt: 10, updatedAt: 11 }],
    }, { ...defaults, ccLayout: DEFAULT_CC_LAYOUT } as never, 0)
    expect(Array.isArray(finalOutput.customPresets)).toBe(true)
    expect(migrated.sessions).toEqual([{ id: 'must remain outside theme conclusion' }])
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

  it('迁移不再调用 normalizeCcPositions；profile schema 停在 v4', () => {
    expect(migrationSource).not.toContain('normalizeCcPositions(')
    expect(PROFILE_SCHEMA_VERSION).toBe(4)
  })
})

// 下沉自 scripts/test-legacy-cc-layout.mts（P91 A2）：legacy cc 布局状态迁移行为。
describe('legacy cc 布局状态迁移（废弃键删除 + v3 归一）', () => {
  it('迁移删除 ccSizes/ccPositions/ccCliCustomized/ccLayoutVersion 并保留归一布局', () => {
    const legacyState: Record<string, unknown> = {
      ccSizes: { ekg: 42 },
      ccPositions: { ekg: { x: 1, y: 2 } },
      ccCliCustomized: true,
      ccLayoutVersion: 2,
      ccLayout: { version: 2, placements: {} },
    }
    const migrated = normalizeThemeMigrationState(legacyState, {
      base: {},
      appliedPreset: defaults.appliedPreset,
      custom: defaults.custom,
      ccLayout: DEFAULT_CC_LAYOUT,
    })
    expect(migrated).not.toHaveProperty('ccSizes')
    expect(migrated).not.toHaveProperty('ccPositions')
    expect(migrated).not.toHaveProperty('ccCliCustomized')
    expect(migrated).not.toHaveProperty('ccLayoutVersion')
    expect((migrated.ccLayout as { version: number }).version).toBe(CC_LAYOUT_SCHEMA_VERSION)
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
