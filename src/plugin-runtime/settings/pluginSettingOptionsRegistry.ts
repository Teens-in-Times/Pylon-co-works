import { THEME_FIELD_DEFS, type ThemeFieldKey } from '../../domains/theme/themeFieldDefs.ts'
import { resolveSettingOptions, type ResolvedSettingOption } from '../../contracts/settingOptions.ts'
import { ValidatedContributionRegistry } from '../registry/validatedContributionRegistry.ts'
import type { RegistryEntry } from '../registry/types.ts'
import type { PluginSettingOption, PluginSettingOptionsContribution } from './pluginSettingsTypes.ts'
import { stringifySettingsTarget } from './settingsTargetGrammar.ts'

const TARGET_PATTERN = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9_%~-]+)+$/
// Legacy targets may contain dotted third-party Kind owners. Structured
// targets are canonical; this compatibility validator only rejects empty
// segments and preserves the original string for migration.
const RENDERER_TARGET_PATTERN = /^(suite|slot)\.[A-Za-z0-9_.%~-]+\.[A-Za-z0-9_%~-]+(?:\.[A-Za-z0-9_%~-]+)?$|^kind\.[A-Za-z0-9_.%~-]+(?:\.[A-Za-z0-9_%~-]+){2,}$/

function themeFieldFromTarget(target: string): ThemeFieldKey | null {
  if (!target.startsWith('theme.')) return null
  const field = target.slice('theme.'.length) as ThemeFieldKey
  return field in THEME_FIELD_DEFS ? field : null
}

function validateOption(option: PluginSettingOption, contributionId: string): PluginSettingOption {
  if (!option.value || option.value !== option.value.trim()) {
    throw new Error(`Plugin setting option value 非法：${contributionId}`)
  }
  if (option.label !== undefined && !option.label.trim()) {
    throw new Error(`Plugin setting option label 不能为空：${contributionId}.${option.value}`)
  }
  if (option.order !== undefined && !Number.isFinite(option.order)) {
    throw new Error(`Plugin setting option order 非法：${contributionId}.${option.value}`)
  }
  return Object.freeze({ ...option })
}

export function validatePluginSettingOptionsContribution(
  contribution: PluginSettingOptionsContribution,
): PluginSettingOptionsContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) {
    throw new Error('Plugin setting options contribution id 非法')
  }
  const structuredTarget = typeof contribution.target !== 'string'
  const target = structuredTarget ? stringifySettingsTarget(contribution.target) : contribution.target
  if (!TARGET_PATTERN.test(target) || (!structuredTarget && (target.startsWith('kind.') || target.startsWith('suite.') || target.startsWith('slot.')) && !RENDERER_TARGET_PATTERN.test(target))) {
    throw new Error(`Plugin setting options target 非法：${contribution.id}`)
  }
  const themeField = themeFieldFromTarget(target)
  if (target.startsWith('theme.') && !themeField) {
    throw new Error(`Plugin setting options target 不存在：${target}`)
  }
  if (themeField) {
    const definition = THEME_FIELD_DEFS[themeField]
    if (definition.type !== 'select' && definition.type !== 'color') {
      throw new Error(`Plugin setting options target 不支持候选项：${target}`)
    }
  }
  const remove = [...new Set(contribution.remove ?? [])]
  if (remove.some(value => !value || value !== value.trim())) {
    throw new Error(`Plugin setting options remove 包含非法值：${contribution.id}`)
  }
  const upsert = (contribution.upsert ?? []).map(option => validateOption(option, contribution.id))
  if (new Set(upsert.map(option => option.value)).size !== upsert.length) {
    throw new Error(`Plugin setting options upsert 包含重复值：${contribution.id}`)
  }
  if (remove.length === 0 && upsert.length === 0) {
    throw new Error(`Plugin setting options contribution 不能为空：${contribution.id}`)
  }
  return Object.freeze({
    ...contribution,
    target,
    remove: Object.freeze(remove),
    upsert: Object.freeze(upsert),
  })
}

export class PluginSettingOptionsRegistry extends ValidatedContributionRegistry<PluginSettingOptionsContribution> {
  constructor() { super(validatePluginSettingOptionsContribution) }
}

/**
 * Pure resolver shared by Settings controls and contract tests.
 *
 * 正身住 `src/contracts/settingOptions.ts`（#520 S4-P0-3：renderers⇄settings 值环
 * 破除件——renderers/renderAppearanceResolver 直接取 contracts 算法，本文件只保留
 * `RegistryEntry<PluginSettingOptionsContribution>` 签名的兼容出口；registry 校验
 * 已把 structured target 归一为 dotted string，结构上满足 EntryLike 约束）。
 */
export function resolvePluginSettingOptions(
  target: string,
  base: readonly PluginSettingOption[],
  entries: readonly RegistryEntry<PluginSettingOptionsContribution>[],
): readonly ResolvedSettingOption[] {
  return resolveSettingOptions(target, base, entries)
}
