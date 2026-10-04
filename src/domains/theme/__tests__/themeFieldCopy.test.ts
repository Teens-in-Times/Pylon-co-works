import { describe, expect, it } from 'vitest'
import { WIDGET_PROPERTY_FIELDS } from '../../cc/widgetDefinitions.ts'
import { GROUP_ORDER, THEME_FIELD_DEFS, type ThemeFieldDef } from '../themeFieldDefs.ts'

const IMPLEMENTATION_TERMS = /AgentSheet|FileSheet|Spinner|Placeholder|Footer|Diff|\bCLI\b|\bCC\b|\s&\s/

describe('主题设置展示文案契约', () => {
  it('用户可见字段不泄露组件名或内部缩写', () => {
    for (const [key, field] of Object.entries(THEME_FIELD_DEFS)) {
      const def = field as ThemeFieldDef
      if (def.hidden) continue
      expect(def.label, `${key}.label`).not.toMatch(IMPLEMENTATION_TERMS)
      if (def.hint) expect(def.hint, `${key}.hint`).not.toMatch(IMPLEMENTATION_TERMS)
      if (def.group) expect(def.group, `${key}.group`).not.toMatch(IMPLEMENTATION_TERMS)
    }
  })

  it('每个可见字段组都在对应设置区注册', () => {
    const registered = new Map(
      Object.entries(GROUP_ORDER).map(([zone, sections]) => [
        zone,
        new Set(sections.flatMap(section => section.groups.map(group => group.title))),
      ]),
    )

    for (const [key, field] of Object.entries(THEME_FIELD_DEFS)) {
      const def = field as ThemeFieldDef
      if (def.hidden || !def.group) continue
      expect(registered.get(def.zone)?.has(def.group), `${key} 的字段组“${def.group}”未注册`).toBe(true)
    }
  })

  it('可见主题字段使用唯一 canonical 标签，作用域写入名称而非靠重复上下文猜测', () => {
    const labels = new Map<string, string>()
    for (const [key, field] of Object.entries(THEME_FIELD_DEFS)) {
      const def = field as ThemeFieldDef
      if (def.hidden) continue
      const previous = labels.get(def.label)
      expect(previous, `${key} 与 ${previous ?? '未知字段'} 共享重复标签“${def.label}”`).toBeUndefined()
      labels.set(def.label, key)
    }
  })

  it('关键枚举保留稳定值，并为每个值提供人类可读名称', () => {
    const expectedOptions = {
      inputSubmitButtonMode: ['inline', 'external', 'hidden'],
      cliHintMode: ['hidden', 'compact', 'full'],
      modelSwitchMode: ['menu', 'cycle'],
      permissionSwitchMode: ['menu', 'cycle'],
      // ★ #266 遗留①：`permissionBgColor` / `permissionTextColor` 已由「白/黑(+跟模式) 枚举」改成
      //   **自由选色**（`type: 'color'`，无 options）⇒ 不再属于「关键枚举」这一组。
      // ★ #266 CC-07：`inputShowPlaceholder` / `sendVariant` 两字段真的删除 ⇒ 样本同步移除。
      // ★ #266 刀9~11：`inputMode` / `footerLayout` / `cliOverflowMode` 三字段真的删除 ⇒ 同步移除。
      // ★ #266 CC-08：`inputShowHistoryHint` 字段仍在，但由 shown/hidden 枚举归布尔
      //   （`type: 'boolean'`，无 options）⇒ 不再属于「关键枚举」这一组。
    } as const

    for (const [key, options] of Object.entries(expectedOptions)) {
      const def = THEME_FIELD_DEFS[key as keyof typeof expectedOptions] as ThemeFieldDef
      expect(def.options, `${key}.options`).toEqual(options)
      for (const value of options) expect(def.optionLabels?.[value], `${key}.${value} 缺展示名称`).toBeTruthy()
    }
  })

  it('诊断中点名的模糊字段表达真实作用域', () => {
    expect(THEME_FIELD_DEFS.assistantDot.label).toBe('显示助手消息标记')
    // ★ #266 刀11：原样本 `footerLayout`（底部信息布局）已删除 ⇒ 换成仍在的同类字段
    expect(THEME_FIELD_DEFS.cliHintMode.label).toBe('快捷提示详细程度')
    // ★ #238 刀8：原「整体风格」（ccVariant）已整套删除 ⇒ 本条样本换成另一个 noCssVar 布尔/文本类字段
    expect(THEME_FIELD_DEFS.ccLayout.label).toBe('布局')
  })

  it('中控属性面板与设置页使用同一套用户语言', () => {
    const visibleCopy = Object.values(WIDGET_PROPERTY_FIELDS).flatMap(fields => fields.flatMap(field => {
      if (field.kind === 'section') return [field.title]
      if (field.kind === 'chips') return [field.label, ...field.options.map(option => option.label)]
      return [field.label]
    }))

    for (const copy of visibleCopy) expect(copy).not.toMatch(IMPLEMENTATION_TERMS)
  })
})

// 归并自 spinnerThemeFields.test.ts（P91 A5：同为 THEME_FIELD_DEFS 静态元数据断言）
describe('spinner 主题字段（spinner-preview-wiring 契约）', () => {
  it('spinnerIntervalMs 定义为 number 字段且默认 120ms', () => {
    const def = THEME_FIELD_DEFS.spinnerIntervalMs
    expect(def).toBeTruthy()
    expect(def.type).toBe('number')
    expect(def.default).toBe(120)
  })

  it('三个终态标记模式均为 select 字段且默认 custom', () => {
    for (const key of ['spinnerDoneMarkerMode', 'spinnerCancelledMarkerMode', 'spinnerErrorMarkerMode'] as const) {
      const def = THEME_FIELD_DEFS[key]
      expect(def).toBeTruthy()
      expect(def.type).toBe('select')
      expect(def.default).toBe('custom')
    }
  })
})
