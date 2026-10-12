/**
 * 设置项溯源契约测试（D-trace）：声明式 IA 一致性 + 搜索覆盖不变量。
 *
 * 源自一次性审计脚本（scripts/audit-settings-trace）固化为契约：
 * - 每个 (zone, group) 都必须落在 GROUP_ORDER 内，否则字段对 ZoneGroupFields
 *   不可达（hidden 结构字段除外——它们经专用控件或迁移读写）。
 * - GROUP_ORDER 不得出现空组（渲染器会渲染空标题组）。
 * - 速搜索引必须覆盖全部可见字段（搜索命中是 IA 的第二入口）。
 */
import { describe, expect, it } from 'vitest'
import { GROUP_ORDER, THEME_FIELD_DEFS, THEME_FIELD_KEYS, type ThemeFieldDef } from '../themeFieldDefs'
import { buildSettingsSearchIndex } from '../../../components/settings/settingsDomains'

const defs = THEME_FIELD_DEFS as Record<string, ThemeFieldDef>
const keys = THEME_FIELD_KEYS as readonly string[]

describe('settings traceability contract (D-trace)', () => {
  it('every non-hidden field is reachable from its zone group order', () => {
    const orphans: string[] = []
    for (const key of keys) {
      const def = defs[key]
      if (def.hidden || def.group === undefined) continue
      const groupTitles = (GROUP_ORDER[def.zone] ?? []).flatMap(block => block.groups.map(group => group.title))
      if (!groupTitles.includes(def.group)) orphans.push(`${key} (zone=${def.zone}, group=${def.group})`)
    }
    expect(orphans, `不可达字段（zone+group 无 UI 归属）: ${orphans.join(', ')}`).toEqual([])
  })

  it('no empty groups in GROUP_ORDER (would render headerless field groups)', () => {
    const empty: string[] = []
    for (const [zone, blocks] of Object.entries(GROUP_ORDER)) {
      for (const block of blocks) {
        for (const group of block.groups) {
          const count = keys.filter(key => defs[key].zone === zone && defs[key].group === group.title && !defs[key].hidden).length
          if (count === 0) empty.push(`${zone}/${group.title}`)
        }
      }
    }
    expect(empty, `空组: ${empty.join(', ')}`).toEqual([])
  })

  it('quick-search index covers every visible field', () => {
    const index = buildSettingsSearchIndex(undefined, [], [])
    const indexed = new Set<string>()
    for (const item of index) {
      if (item.anchor?.startsWith('field:')) indexed.add(item.anchor.slice('field:'.length))
    }
    const missed = keys.filter(key => !defs[key].hidden && !indexed.has(key))
    expect(missed, `速搜未覆盖字段: ${missed.join(', ')}`).toEqual([])
  })

  it('hidden fields are structural carriers only (opt-in list, kept explicit)', () => {
    // hidden = 结构载体（ccLayout/appliedPreset/迁移遗留回退…），不允许悄悄增长：
    // 新增 hidden 字段必须在此登记并说明其读写方。
    const hidden = keys.filter(key => defs[key].hidden).sort()
    expect(hidden).toEqual([
      'appliedPreset',
      'ccEditMode',
      'ccHidden',
      // ★ #266 刀2：显隐空态切面（结构载体）—— 读方 = `resolveCcHiddenWidgetIds` 的门选一份，
      //   写方 = 预设数据（`zones/factory/**` / `presets/builtin.ts` 的 cc 切面）与持久化。
      'ccHiddenEmpty',
      'ccLayout',
      // ★ #266 CC-13 刀4：插件元件**属性值**（结构载体）—— 读方 = 编辑列属性面板与
      //   `CcIsolatedWidget` 的 `host:input.props` 段（`appearance().ccPluginProps`）；
      //   写方 = 属性面板（`set-cc-plugin-prop`）、预设数据（`zones/factory/**` 的 cc 切面）与持久化。
      'ccPluginProps',
      'custom',
      'rightWidth',
      'sidebarGroupSize',
      'spinnerCancelledMarkerMode',
      'spinnerDoneMarkerMode',
      'spinnerErrorMarkerMode',
      'synCoReference',
      'toolIndicator',
    ])
  })
})
