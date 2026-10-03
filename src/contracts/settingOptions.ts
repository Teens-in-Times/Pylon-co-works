/**
 * settingOptions — 插件 setting 候选项解析契约（纯解析算法，自
 * plugin-runtime/settings/pluginSettingOptionsRegistry 上移，#520 S4-P0-3）。
 *
 * 中立落点：plugin-runtime/renderers（renderAppearanceResolver 的选项/调色板解析）
 * 与 plugin-runtime/settings（PluginSettingOptionsRegistry 兼容出口）双方都从这里
 * 取算法，打破「renderers ⇄ settings」目录级运行时值互引环的最后一跳。
 * 契约层只依赖同层的 rendererSettingsSchema，保持 src/contracts/ 纪律。
 */
import type { SettingOption } from './rendererSettingsSchema.ts'

/**
 * Structural view of one validated option contribution — the resolver only
 * reads these fields. Registry validation normalizes structured targets to
 * dotted strings before entries reach the resolver, so only the string form
 * ever matches `target`.
 */
export interface SettingOptionsEntryLike {
  readonly contributionId: string
  readonly value: {
    readonly target: unknown
    readonly remove?: readonly string[]
    readonly upsert?: readonly SettingOption[]
  }
}

export interface ResolvedSettingOption extends SettingOption {
  readonly label: string
  readonly contributionId?: string
}

interface MutableResolvedOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
  order?: number
  contributionId?: string
  sequence: number
}

/** Pure option/palette merge: base options, then remove-then-upsert per contribution. */
export function resolveSettingOptions(
  target: string,
  base: readonly SettingOption[],
  entries: readonly SettingOptionsEntryLike[],
): readonly ResolvedSettingOption[] {
  const values = new Map<string, MutableResolvedOption>()
  let sequence = 0
  for (const option of base) {
    values.set(option.value, { ...option, label: option.label ?? option.value, sequence: sequence++ })
  }
  for (const entry of entries) {
    if (entry.value.target !== target) continue
    for (const value of entry.value.remove ?? []) values.delete(value)
    for (const option of entry.value.upsert ?? []) {
      const current = values.get(option.value)
      values.set(option.value, {
        ...(current ?? { value: option.value, label: option.value, sequence: sequence++ }),
        ...option,
        label: option.label ?? current?.label ?? option.value,
        contributionId: entry.contributionId,
      })
    }
  }
  return Object.freeze([...values.values()]
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.sequence - b.sequence)
    .map(({ sequence: _sequence, ...option }) => Object.freeze(option)))
}
