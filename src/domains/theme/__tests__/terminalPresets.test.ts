import { describe, expect, it } from 'vitest'
import { GLOBAL_PRESETS } from '../presets/index.ts'
import { effectivePresetTheme } from '../zones/index.ts'
import { THEME_PRESET_KEYS } from '../themeFieldDefs.ts'

const terminal = GLOBAL_PRESETS.filter(preset =>
  ['claude', 'nord', 'tokyo', 'solarized', 'amber'].includes(preset.name),
)

describe('Terminal-like preset snapshots', () => {
  it('覆盖所有主题字段，切换后不会继承旧预设的渲染器状态', () => {
    for (const preset of terminal) {
      const theme = effectivePresetTheme(preset)
      // ★ #607 刀3a：判据从 `THEME_SETTING_KEYS` 收窄到 `THEME_PRESET_KEYS`。
      //   后者 = 前者减去 `sidebarWidth`（owner = workspace-layout）与 `rightWidth`
      //   （owner = right-rail）—— 这两个字段**不归预设管**（见 themeFieldDefs 的
      //   `THEME_FIELD_OWNERS`）：预设落点材料自 #607 起不再携带它们，它们的值一律由
      //   `DEFAULTS` / 各自主管域给。断言强度不变（预设该覆盖的字段仍逐条要求覆盖）。
      for (const key of THEME_PRESET_KEYS) {
        // ★ #266 CC-21：`inputFont` 为后置字段，预设不显式声明 ⇒ 读时按字段默认值
        //   （follow-message，跟随消息字体）归属；其余字段仍要求预设显式覆盖。
        if (key === 'inputFont') {
          expect(theme.inputFont ?? 'follow-message', `${preset.name}.${key}`).toBe('follow-message')
          continue
        }
        expect(Object.prototype.hasOwnProperty.call(theme, key), `${preset.name}.${key}`).toBe(true)
      }
    }
  })

  it('保留 Claude / Solarized 的核心气质，同时让其他工作站显式启用终端契约', () => {
    const claude = effectivePresetTheme(GLOBAL_PRESETS.find(preset => preset.name === 'claude')!)
    const solarized = effectivePresetTheme(GLOBAL_PRESETS.find(preset => preset.name === 'solarized')!)
    expect(claude.globalBgColor).toBe('#000000')
    expect(claude.messageLayout).toBe('claude')
    expect(solarized.globalBgColor).toBe('#fdf6e3')
    expect(solarized.uiScheme).toBe('light')

    for (const name of ['nord', 'tokyo', 'amber'] as const) {
      const theme = effectivePresetTheme(GLOBAL_PRESETS.find(preset => preset.name === name)!)
      // ★ #266 刀9：原 `inputMode` / `inputVariant` 两条断言随字段删除（形态固定命令行，
      //   不再由预设区分）；终端契约的其余项仍逐条锁住。
      expect(theme.msgStyle, name).toBe('terminal')
      expect(theme.toolConnectorMode, name).toBe('follow')
    }
  })
})
