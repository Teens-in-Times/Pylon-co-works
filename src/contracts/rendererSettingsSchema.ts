/**
 * rendererSettingsSchema — 框架中立的 settings schema 正身（自
 * plugin-runtime/renderers/rendererSettingsTypes 上移，#520 S4-P0-3）。
 *
 * 中立落点：plugin-runtime/renderers（renderer catalog）与 plugin-runtime/settings
 * （settings page/options 注册表）双方都从这里取 schema 类型与 normalize/validate，
 * 打破「renderers ⇄ settings」目录级运行时值互引环（照 fonts.ts 的 B-5 破环范式：
 * 正身住 contracts，两侧 re-export 保面）。契约层零 import，保持 src/contracts/ 纪律
 * （isRecord 以本地守卫内联，同 utils/wireGuards 语义）。
 *
 * 命名：本文件是 canonical 名（Setting* / Settings*）；历史 Renderer*、Render* 前缀
 * 名保留在 renderers/rendererSettingsTypes.ts 作为兼容别名再出口。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type ChoicePresentation = 'select' | 'radio' | 'segmented'
export type MultiChoicePresentation = 'checklist' | 'listbox'
export type ColorPresentation = 'palette' | 'picker' | 'palette+picker'
export type NumberPresentation = 'slider' | 'input' | 'slider+input'

export type SettingValue = null | boolean | number | string | readonly SettingValue[] | {
  readonly [key: string]: SettingValue
}

/** Compositor-facing historical aliases; canonical names are above. */
export type SettingsValue = SettingValue
export type SettingsField = SettingField

export interface SettingsValueAdapter {
  readonly namespace: string
  readonly ownerPluginId?: string
  readonly contributionId?: string
  getSnapshot(): {
    readonly values: Readonly<Record<string, SettingsValue>>
    readonly unavailable: Readonly<Record<string, { value?: SettingsValue; code: string; message: string }>>
    readonly revision: number
  }
  setValue(fieldKey: string, value: SettingsValue): void | Promise<void>
  removeValue(fieldKey: string): void | Promise<void>
  reset(fieldKey: string): void | Promise<void>
  subscribe(listener: () => void): () => void
  /** Optional host-only unavailable bridge for dynamic option/plugin unload. */
  markUnavailable?(fieldKey: string, value: SettingsValue, code: string, message: string): void
  restoreUnavailable?(fieldKey: string): void
}

/**
 * Owner-provided placement metadata consumed by the Settings compositor.
 * It describes where a schema is presented, never the value/default/consumer.
 */
export interface SettingsPlacement {
  readonly categoryId: string
  readonly categoryLabel: string
  readonly categoryOrder?: number
  readonly objectOrder?: number
  readonly disclosure?: 'essential' | 'detail' | 'technical'
}

export function normalizeSettingsPlacement(placement: SettingsPlacement): SettingsPlacement {
  if (!placement || typeof placement !== 'object') fail('settingsPlacement 必须是对象')
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(placement.categoryId)) fail(`settingsPlacement categoryId 非法：${placement.categoryId}`)
  if (!placement.categoryLabel?.trim()) fail('settingsPlacement categoryLabel 不能为空')
  if (placement.categoryOrder !== undefined && !Number.isFinite(placement.categoryOrder)) fail('settingsPlacement categoryOrder 非法')
  if (placement.objectOrder !== undefined && !Number.isFinite(placement.objectOrder)) fail('settingsPlacement objectOrder 非法')
  if (placement.disclosure !== undefined && !['essential', 'detail', 'technical'].includes(placement.disclosure)) fail('settingsPlacement disclosure 非法')
  return Object.freeze({ ...placement })
}

export interface SettingOption {
  readonly value: string
  readonly label?: string
  readonly description?: string
  readonly disabled?: boolean
  readonly order?: number
  readonly tier?: 'basic'
}

export type SettingCondition =
  | { readonly equals: { readonly field: string; readonly value: SettingValue } }
  | { readonly oneOf: { readonly field: string; readonly values: readonly SettingValue[] } }
  | { readonly not: SettingCondition }
  | { readonly all: readonly SettingCondition[] }
  | { readonly any: readonly SettingCondition[] }

interface SettingFieldBase {
  /** `key` is the canonical name; `id` is accepted as a migration alias. */
  readonly key?: string
  readonly id?: string
  readonly label?: string
  readonly description?: string
  readonly advanced?: boolean
  readonly default?: SettingValue
  readonly showIf?: SettingCondition
  readonly resetLabel?: string
  /** Stable semantic metadata used by the Settings compositor. */
  readonly semanticKey?: string
  readonly scope?: 'theme' | 'renderer' | 'slot' | 'suite' | 'kind' | 'plugin'
  readonly inheritsFrom?: string
  readonly deprecated?: boolean
  readonly aliases?: readonly string[]
  readonly order?: number
  readonly tier?: 'basic'
}

export interface ChoiceSettingField extends SettingFieldBase {
  readonly type: 'choice'
  readonly presentation?: ChoicePresentation
  readonly options: readonly SettingOption[]
  readonly optionTarget?: string
}

export interface MultiChoiceSettingField extends SettingFieldBase {
  readonly type: 'multi-choice'
  readonly presentation?: MultiChoicePresentation
  readonly options: readonly SettingOption[]
  readonly minSelected?: number
  readonly maxSelected?: number
  readonly optionTarget?: string
}

export interface ColorSettingField extends SettingFieldBase {
  readonly type: 'color'
  readonly presentation?: ColorPresentation
  readonly alpha?: boolean
  readonly paletteTarget?: string
}

export interface NumberSettingField extends SettingFieldBase {
  readonly type: 'number'
  readonly presentation?: NumberPresentation
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly unit?: string
}

export interface BooleanSettingField extends SettingFieldBase {
  readonly type: 'boolean'
  readonly presentation?: 'toggle' | 'checkbox'
}

export interface TextSettingField extends SettingFieldBase {
  readonly type: 'text'
  readonly presentation?: 'input' | 'textarea'
  readonly pattern?: string
  readonly placeholder?: string
  readonly maxLength?: number
}

export type SettingField =
  | ChoiceSettingField
  | MultiChoiceSettingField
  | ColorSettingField
  | NumberSettingField
  | BooleanSettingField
  | TextSettingField

export interface SettingGroup {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly layout?: 'stack' | 'grid' | 'inline' | 'tabs'
  readonly collapsedByDefault?: boolean
  readonly order?: number
  readonly fields: readonly SettingField[]
}

export interface SettingsSchema {
  readonly schemaVersion: number
  readonly groups: readonly SettingGroup[]
}

// Renderer targets keep their historical dotted compatibility form; plugin
// page/context-panel targets include an encoded plugin owner and contribution
// segment so options remain isolated by (plugin, contribution, field).
const OPTION_TARGET_PATTERN = /^(?:kind|suite|slot)\.[A-Za-z0-9_.%~-]+\.[A-Za-z0-9_%~-]+(?:\.[A-Za-z0-9_%~-]+)?$|^(?:plugin-page|context-panel)\.[A-Za-z0-9_%~-]+\.[A-Za-z0-9_%~-]+\.[A-Za-z0-9_%~-]+$/

function fail(message: string): never {
  throw new Error(`Renderer settings schema 无效：${message}`)
}

function isSerializable(value: unknown, seen = new Set<unknown>()): value is SettingValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every(item => isSerializable(item, seen))
  return Object.values(value).every(item => isSerializable(item, seen))
}

function fieldKey(field: SettingField): string {
  const key = field.key ?? field.id
  if (!key || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) fail(`field key 非法：${String(key)}`)
  return key
}

function validateCondition(condition: SettingCondition, fields: ReadonlySet<string>): void {
  if (!isRecord(condition)) fail('showIf 必须是可序列化 condition')
  if ('equals' in condition) {
    const item = condition.equals
    if (!isRecord(item) || typeof item.field !== 'string' || !fields.has(item.field) || !isSerializable(item.value)) fail(`showIf equals 引用非法字段：${String((item as Record<string, unknown>)?.field)}`)
    return
  }
  if ('oneOf' in condition) {
    const item = condition.oneOf
    if (!isRecord(item) || typeof item.field !== 'string' || !fields.has(item.field) || !Array.isArray(item.values) || item.values.length === 0 || !item.values.every(value => isSerializable(value))) fail(`showIf oneOf 引用非法字段：${String((item as Record<string, unknown>)?.field)}`)
    return
  }
  if ('not' in condition) {
    validateCondition(condition.not, fields)
    return
  }
  if ('all' in condition || 'any' in condition) {
    const list = 'all' in condition ? condition.all : condition.any
    if (!Array.isArray(list) || list.length === 0) fail('showIf all/any 不能为空')
    list.forEach(item => validateCondition(item, fields))
    return
  }
  fail('showIf condition 类型未知')
}

function validateOptions(fieldKeyValue: string, options: readonly SettingOption[], defaultValue: SettingValue | undefined, target?: string): void {
  if (!Array.isArray(options) || options.length === 0) fail(`${fieldKeyValue} options 不能为空`)
  const values = new Set<string>()
  for (const option of options) {
    if (!isRecord(option) || typeof option.value !== 'string' || !option.value.trim()) fail(`${fieldKeyValue} option value 非法`)
    if (values.has(option.value)) fail(`${fieldKeyValue} option 重复：${option.value}`)
    values.add(option.value)
    if (option.label !== undefined && (typeof option.label !== 'string' || !option.label.trim())) fail(`${fieldKeyValue} option label 非法`)
    if (option.order !== undefined && (typeof option.order !== 'number' || !Number.isFinite(option.order))) fail(`${fieldKeyValue} option order 非法`)
  }
  if (target !== undefined && !OPTION_TARGET_PATTERN.test(target)) fail(`${fieldKeyValue} optionTarget 非法：${target}`)
  if (defaultValue !== undefined && !values.has(String(defaultValue))) fail(`${fieldKeyValue} default 不在 options 中`)
}

function validateField(field: SettingField, fields: ReadonlySet<string>): void {
  const key = fieldKey(field)
  if (field.semanticKey !== undefined && !field.semanticKey.trim()) fail(`${key} semanticKey 不能为空`)
  if (field.scope !== undefined && !['theme', 'renderer', 'slot', 'suite', 'kind', 'plugin'].includes(field.scope)) fail(`${key} scope 非法`)
  if (field.inheritsFrom !== undefined && !field.inheritsFrom.trim()) fail(`${key} inheritsFrom 不能为空`)
  if (field.order !== undefined && (!Number.isFinite(field.order))) fail(`${key} order 非法`)
  if (field.aliases !== undefined) {
    if (!Array.isArray(field.aliases) || field.aliases.some(alias => typeof alias !== 'string' || !alias.trim())) fail(`${key} aliases 非法`)
    if (field.aliases.includes(key)) fail(`${key} aliases 不得包含 canonical key`)
    if (new Set(field.aliases).size !== field.aliases.length) fail(`${key} aliases 重复`)
  }
  if (field.label !== undefined && !field.label.trim()) fail(`${key} label 不能为空`)
  if (field.description !== undefined && typeof field.description !== 'string') fail(`${key} description 非法`)
  if (field.default !== undefined && !isSerializable(field.default)) fail(`${key} default 必须可序列化`)
  if (field.showIf) validateCondition(field.showIf, fields)
  switch (field.type) {
    case 'choice':
      validateOptions(key, field.options, field.default, field.optionTarget)
      if (field.presentation !== undefined && !['select', 'radio', 'segmented'].includes(field.presentation)) fail(`${key} choice presentation 非法`)
      if (field.default !== undefined && typeof field.default !== 'string') fail(`${key} choice default 必须是 string`)
      return
    case 'multi-choice': {
      validateOptions(key, field.options, undefined, field.optionTarget)
      const values = new Set(field.options.map(option => option.value))
      if (field.minSelected !== undefined && (!Number.isInteger(field.minSelected) || field.minSelected < 0)) fail(`${key} minSelected 非法`)
      if (field.maxSelected !== undefined && (!Number.isInteger(field.maxSelected) || field.maxSelected < 0)) fail(`${key} maxSelected 非法`)
      if (field.minSelected !== undefined && field.maxSelected !== undefined && field.minSelected > field.maxSelected) fail(`${key} minSelected 大于 maxSelected`)
      if (field.maxSelected !== undefined && field.maxSelected > field.options.length) fail(`${key} maxSelected 超出 options`)
      if (field.default !== undefined && (!Array.isArray(field.default) || !field.default.every(value => typeof value === 'string' && values.has(value)))) fail(`${key} multi-choice default 非法`)
      return
    }
    case 'color':
      if (field.presentation !== undefined && !['palette', 'picker', 'palette+picker'].includes(field.presentation)) fail(`${key} color presentation 非法`)
      if (field.paletteTarget !== undefined && !OPTION_TARGET_PATTERN.test(field.paletteTarget)) fail(`${key} paletteTarget 非法：${field.paletteTarget}`)
      if (field.default !== undefined && typeof field.default !== 'string') fail(`${key} color default 必须是 string`)
      return
    case 'number':
      if (field.presentation !== undefined && !['slider', 'input', 'slider+input'].includes(field.presentation)) fail(`${key} number presentation 非法`)
      if (field.min !== undefined && !Number.isFinite(field.min)) fail(`${key} min 非法`)
      if (field.max !== undefined && !Number.isFinite(field.max)) fail(`${key} max 非法`)
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail(`${key} min 大于 max`)
      if (field.step !== undefined && (!Number.isFinite(field.step) || field.step <= 0)) fail(`${key} step 非法`)
      if (field.default !== undefined && (typeof field.default !== 'number' || (field.min !== undefined && field.default < field.min) || (field.max !== undefined && field.default > field.max))) fail(`${key} number default 超出范围`)
      return
    case 'boolean':
      if (field.default !== undefined && typeof field.default !== 'boolean') fail(`${key} boolean default 非法`)
      return
    case 'text':
      if (field.presentation !== undefined && !['input', 'textarea'].includes(field.presentation)) fail(`${key} text presentation 非法`)
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 0)) fail(`${key} maxLength 非法`)
      if (field.pattern !== undefined) {
        try { new RegExp(field.pattern) } catch { fail(`${key} pattern 非法`) }
      }
      if (field.default !== undefined && typeof field.default !== 'string') fail(`${key} text default 必须是 string`)
      return
    default:
      fail(`${key} type 未知`)
  }
}

export function validateSettingsSchema(schema: SettingsSchema): void {
  if (!isRecord(schema) || !Number.isInteger(schema.schemaVersion) || schema.schemaVersion < 1) fail('schemaVersion 必须是正整数')
  if (!Array.isArray(schema.groups)) fail('groups 必须是数组')
  const groups = new Set<string>()
  const fields = new Set<string>()
  const aliases = new Set<string>()
  for (const group of schema.groups) {
    if (!isRecord(group) || typeof group.id !== 'string' || !group.id.trim()) fail('group id 非法')
    if (groups.has(group.id)) fail(`group id 重复：${group.id}`)
    groups.add(group.id)
    if (typeof group.label !== 'string' || !group.label.trim()) fail(`group label 非法：${group.id}`)
    if (group.order !== undefined && !Number.isFinite(group.order)) fail(`group order 非法：${group.id}`)
    if (!Array.isArray(group.fields)) fail(`group fields 非法：${group.id}`)
    for (const field of group.fields) {
      const key = fieldKey(field)
      if (fields.has(key)) fail(`field key 重复：${key}`)
      fields.add(key)
      for (const alias of field.aliases ?? []) {
        if (fields.has(alias) || aliases.has(alias)) fail(`field alias 与 schema key 冲突：${alias}`)
        aliases.add(alias)
      }
    }
  }
  for (const alias of aliases) if (fields.has(alias)) fail(`field alias 与 schema key 冲突：${alias}`)
  for (const group of schema.groups) for (const field of group.fields) validateField(field, fields)
}

function freeze(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) value.forEach(item => freeze(item, seen))
  else Object.values(value).forEach(item => freeze(item, seen))
  return Object.freeze(value)
}

export function normalizeSettingsSchema(schema: SettingsSchema): SettingsSchema {
  validateSettingsSchema(schema)
  const copy = structuredClone(schema) as SettingsSchema
  // Metadata order is consumer-visible: keep declaration order as the stable
  // tie-breaker while honoring explicit group/field order values.
  const ordered: SettingsSchema = {
    ...copy,
    groups: copy.groups
      .map(group => ({ ...group, fields: [...group.fields].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)) }))
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)),
  }
  return freeze(ordered) as SettingsSchema
}

export function settingFieldKey(field: Pick<SettingField, 'key' | 'id'>): string {
  return field.key ?? field.id ?? ''
}

export function settingOptionTarget(fieldNamespace: 'kind' | 'suite' | 'slot', ownerId: string, fieldKeyValue: string): string {
  const target = `${fieldNamespace}.${ownerId}.${fieldKeyValue}`
  if (!OPTION_TARGET_PATTERN.test(target)) fail(`setting option target 非法：${target}`)
  return target
}
/** 类型 → 默认显示形态（设置页侧的惯例真值；组件 schema 的显式 presentation 优先）。 */
export const DISPLAY_DEFAULTS = Object.freeze({
  choice: 'select',
  'multi-choice': 'checklist',
  color: 'palette+picker',
  number: 'slider+input',
  boolean: 'toggle',
  text: 'input',
} satisfies Record<SettingField['type'], string>) as Readonly<Record<SettingField['type'], SettingsPresentation>>

export type SettingsPresentation = ChoicePresentation | MultiChoicePresentation | ColorPresentation | NumberPresentation | 'toggle' | 'checkbox' | 'input' | 'textarea'

export type SettingsDensity = 'basic' | 'standard' | 'all'

/** Shared visibility predicate for Theme and Renderer field surfaces. */
export function isSettingVisible(field: Pick<SettingField, 'advanced' | 'tier'>, density: SettingsDensity): boolean {
  if (density === 'all') return true
  if (density === 'basic') return field.tier === 'basic'
  return field.advanced !== true
}

/** 显示方式单点解析：schema 显式声明优先，未声明走类型默认（设计书 §3.6/§3.7）。 */
export function resolvePresentation(field: SettingField): SettingsPresentation {
  return field.presentation ?? DISPLAY_DEFAULTS[field.type]
}
