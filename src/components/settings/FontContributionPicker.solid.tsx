/** @jsxImportSource solid-js */
import { createMemo, Show } from 'solid-js'
import { fontContributionCssVariable } from '../../plugin-runtime/fonts/fontContributionRegistry.ts'
import type { FontRole } from '../../contracts/fonts.ts'
import { getFontContributionRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { resolveFontToken } from '../../domains/theme/fontTokens.ts'
import Select from '../ui/Select.solid.tsx'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import type { RegistryEntry } from '../../plugin-runtime/registry/types.ts'
import type { PluginSettingOptionsContribution } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'

interface FontContributionPickerProps {
  value: string
  role: FontRole
  ariaLabel: string
  onChange(value: string): void
  optionContributions?: readonly RegistryEntry<PluginSettingOptionsContribution>[]
  settingTarget: string
  /**
   * CC-21：可选的「跟随」首项（仅 inputFont 传入）。value 是哨兵（如 follow-message），
   * 不是字体注册表 id；previewFamily 实时求值（跟随时示例随消息字体变）。
   * 固定在菜单最前，不可被插件选项贡献顶替或伪装；不传时行为与旧版完全一致。
   */
  followOption?: { label: string; value: string; previewFamily: () => string }
}

const FALLBACK_LABELS: Record<string, string> = {
  system: '系统无衬线',
  serif: '低对比阅读衬线',
  mono: 'Consolas（VS Code 默认）',
}

/** #515：FontContributionPicker 的 Solid 实体（原 FontContributionPicker.tsx 为 React 薄桥）。 */
export default function FontContributionPicker(props: FontContributionPickerProps) {
  const registry = getFontContributionRegistry()
  const snapshot = createZustandSignal(
    { getState: () => registry.getSnapshot(), subscribe: listener => registry.subscribe(() => listener(registry.getSnapshot())) },
    // registry 的 subscribe 回调不传快照，selector 自取。
    () => registry.getSnapshot(),
  )
  const entries = createMemo(() => snapshot().entries.filter(entry => entry.value.roles.includes(props.role)))
  const selected = () => entries().find(entry => entry.value.id === props.value)?.value
  const resolved = () => resolvePluginSettingOptions(props.settingTarget, entries().map(entry => ({
    value: entry.value.id,
    label: entry.value.label,
    description: entry.value.description,
    order: entry.value.order,
  })), props.optionContributions ?? [])
  const choices = () => {
    const follow = props.followOption
    // 跟随项固定在前；贡献里出现同 value 的项一律剔除（不可被插件选项顶替/伪装）。
    const base = follow ? resolved().filter(option => option.value !== follow.value) : resolved()
    const head = follow ? [{ value: follow.value, label: follow.label, description: undefined, disabled: false }] : []
    const options = [...head, ...base]
    if (options.some(option => option.value === props.value)) return options
    // 当前选择不在清单（插件字体已不可用）：置顶展示并保留 id，不自动改成跟随。
    return [...options.slice(0, head.length), { value: props.value, label: `${FALLBACK_LABELS[props.value] ?? props.value}（已不可用）`, disabled: true }, ...options.slice(head.length)]
  }
  const sample = () => selected()?.sample ?? (props.role === 'code' ? 'const pylon = await connect()' : 'Pylon 让 Agent 工作变得清晰')
  // An unloaded contribution must preview the same role-safe fallback that
  // production CSS uses. #129 子项 3：回退真值直接取 resolveFontToken——上次只修了
  // code 角色且写成 `var(--mono)`（生产真值是 `var(--font-mono-default, var(--mono))`），
  // interface 角色仍是 `inherit`（生产真值是 `var(--font-system, var(--font))`），
  // 与 resolveFontToken 对不可用贡献的回退各说各话。同一函数 ⇒ 结构上不可能再漂移。
  // CC-21：跟随态示例直接取 followOption.previewFamily()（实时读当前消息字体），
  // 不把哨兵当字体 id 计算变量。
  const previewFamily = () => {
    if (props.followOption && props.value === props.followOption.value) return props.followOption.previewFamily()
    if (selected()) return `var(${fontContributionCssVariable(selected()!.id)}, ${selected()!.family})`
    return resolveFontToken(undefined, props.role === 'code' ? 'code' : 'system')
  }

  return (
    <div class="font-contribution-picker">
      <Select ariaLabel={props.ariaLabel} className="set-select" value={props.value} onChange={props.onChange} options={choices().map(option => ({ value: option.value, label: option.label, description: option.description, disabled: option.disabled }))} />
      <span class="font-contribution-sample" style={{ 'font-family': previewFamily() }}>{sample()}</span>
      <Show when={selected()?.description}><small>{selected()?.description}</small></Show>
    </div>
  )
}
