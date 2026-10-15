// 迁移自 scripts/test-cc-status-font-size.mts（P91 A1）
// 只迁 presets.ts 相关纯函数断言（zone 归属 + pickZoneFields）；
// 原脚本 store/defs/App/CSS/skin/settingsDomains 的源码文本段由 css-var 审计覆盖，不迁。
import { describe, expect, it } from 'vitest'
import { GLOBAL_PRESETS, INTERFACE_MODE_PRESET_BUCKET, fallbackPresetChip, presetsForInterfaceMode } from '../domains/theme/presets/index.ts'
import { effectivePresetTheme, pickZoneFields } from '../domains/theme/zones/index.ts'
import { ZONE_FIELDS } from '../domains/theme/themeFieldDefs.ts'

// ★ #238 刀5：原样本字段 `ccStatusFontSize` 已删除（设置页三项收尾之一），
//   故改用它旁边仍存在的 `inputFontSize` 作**同形样本** —— 下面锁的仍然是
//   「cc zone 归属唯一 + pickZoneFields 只切本区 + 字段序契约」这三件事。
const field = 'inputFontSize'

describe('cc zone 归属契约（样本字段 inputFontSize；#238 刀5 换样本）', () => {
  it('built-in 与 custom preset 路径都把字段保留在 cc zone，且不重复归属', () => {
    expect(ZONE_FIELDS.cc.includes(field)).toBe(true)
    expect(ZONE_FIELDS.cc.filter(item => item === field).length).toBe(1)
  })

  it('cc zone 字段顺序契约：ccBgImage < inputTextColor < inputFontSize', () => {
    const ccIndexes = ZONE_FIELDS.cc.map(item => String(item))
    const bg = ccIndexes.indexOf('ccBgImage')
    const mid = ccIndexes.indexOf('inputTextColor')
    const size = ccIndexes.indexOf('inputFontSize')
    expect(bg >= 0 && mid > bg && size > mid).toBe(true)
  })

  it('pickZoneFields 从 cc zone 提取 inputFontSize，不提取 chat 字段', () => {
    const explicitPresetTheme = pickZoneFields({ inputFontSize: 17, chatFontSize: 99 }, 'cc')
    expect(explicitPresetTheme.inputFontSize).toBe(17)
    expect('chatFontSize' in explicitPresetTheme).toBe(false)
    expect(pickZoneFields({ inputFontSize: 17 }, 'chat').inputFontSize).toBeUndefined()
  })

  it('built-in preset 应用提取子集后保留而非抹除 inputFontSize', () => {
    // built-in preset 未覆写时可继承 DEFAULTS 的值；
    // 因此应用提取子集必须保留默认值而不是擦除它。
    for (const preset of GLOBAL_PRESETS) {
      const subset = pickZoneFields(effectivePresetTheme(preset), 'cc')
      const applied = { inputFontSize: 12, ...subset }
      expect(typeof applied.inputFontSize).toBe('number')
    }
  })
})

describe('fallbackPresetChip（#116 子项 7）', () => {
  it('内置预设 name 不产生兜底 chip', () => {
    expect(fallbackPresetChip(GLOBAL_PRESETS[0].name, [])).toBeNull()
  })

  it('自定义预设 id 不产生兜底 chip（具名列表负责渲染，避免重复点亮）', () => {
    expect(fallbackPresetChip('custom-1788421103162', ['custom-1788421103162'])).toBeNull()
  })

  it("'custom' 哨兵显示为「自定义」而不是原样输出", () => {
    expect(fallbackPresetChip('custom', ['custom-1'])).toEqual({
      label: '自定义',
      title: '当前外观已偏离预设基准',
    })
  })

  it('未识别的值显示为「未知预设」，原值只留在 title 里', () => {
    const chip = fallbackPresetChip('ghost-preset-7', ['custom-1'])
    expect(chip?.label).toBe('未知预设')
    expect(chip?.label).not.toContain('ghost-preset-7')
    expect(chip?.title).toContain('ghost-preset-7')
  })

  it('空状态无 chip', () => {
    expect(fallbackPresetChip('', ['custom-1'])).toBeNull()
  })
})

describe('刀5 预设归属（#201，拍板归属表 2026-09-19）', () => {
  it('10 个出厂预设全部有归属，且与拍板归属表逐条一致', () => {
    const expected = {
      claude: 'terminal', nord: 'terminal', tokyo: 'terminal', amber: 'terminal', matrix: 'terminal',
      glass: 'gui', solarized: 'gui', 'agent-command': 'gui', 'agent-map': 'gui', 'focus-flow': 'gui',
    } as const
    expect(GLOBAL_PRESETS).toHaveLength(10)
    expect(new Set(GLOBAL_PRESETS.map(preset => preset.name))).toEqual(new Set(Object.keys(expected)))
    for (const [name, bucket] of Object.entries(expected)) {
      expect(GLOBAL_PRESETS.find(preset => preset.name === name)?.interfaceMode, name).toBe(bucket)
    }
  })

  it('presetsForInterfaceMode 按归属桶过滤：GUI / 终端各 5 个，theme 数据零改动', () => {
    expect(presetsForInterfaceMode('modern-gui').map(preset => preset.name).sort())
      .toEqual(['agent-command', 'agent-map', 'focus-flow', 'glass', 'solarized'])
    expect(presetsForInterfaceMode('terminal-like').map(preset => preset.name).sort())
      .toEqual(['amber', 'claude', 'matrix', 'nord', 'tokyo'])
  })

  it('★ #607 刀3a：蓝调战术补入归属桶，但家族内暂无公开预设；未登记模式仍无预设', () => {
    expect(INTERFACE_MODE_PRESET_BUCKET['tactical-blue']).toBe('tactical')
    // 「家族内暂只有默认一员」⇒ 没有公开 chips（默认成员不进 chips；蓝调的区域行由那条默认单供给）
    expect(presetsForInterfaceMode('tactical-blue')).toEqual([])
    expect(presetsForInterfaceMode('third-party.mode')).toEqual([])
  })
})
