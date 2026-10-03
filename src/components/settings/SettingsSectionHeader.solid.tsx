/** @jsxImportSource solid-js */
import { Show } from 'solid-js'
import {
  isPageOwnedSection,
  SECTION_OWNER_LABELS,
  SECTION_OWNERS,
  SETTINGS_SECTION_LABELS,
  type SettingsSectionId,
} from './settingsDomains.ts'
import Select from '../ui/Select.solid.tsx'
import type { SettingsDensity } from '../../domains/appearance/settingsChromeStore.ts'
import type { JSX } from 'solid-js'

const DENSITY_LABELS: Readonly<Record<SettingsDensity, string>> = {
  basic: '基础',
  standard: '标准',
  all: '全部',
}

interface SettingsSectionHeaderProps {
  section: SettingsSectionId
  density: SettingsDensity
  onDensity: (density: SettingsDensity) => void
}

/**
 * Owner 头（施工书 09 §K-1，设计书 07 §4.2）：
 * 内容区顶部显示「正在调哪个部件」。已登记 owner 显示其可读名（#116 子项 4d，
 * 原始 owner id 仍在 data-owner 上），未登记的按「设置页」徽标处理。
 * 页面自有/未登记 section 显示「设置页」徽标（PAGE_OWNED_SECTIONS + isPageOwnedSection 派生）。
 * 密度档三选（拍板 D3-A 全局一档）：basic 只显 tier:'basic'；standard 非 advanced；all 全量。
 *
 * #515 W1：Solid 实体；下拉经 ui/Select 的 Solid 实体直连。DOM/aria 契约：
 * div.settings-section-header > .settings-owner-badge[data-owner]（aria-hidden 菱形 +
 * .settings-owner-id 名牌，页面自有/未登记 section 按「设置页」徽标处理）+
 * 密度档 .settings-density-select（Select）。
 */
export default function SettingsSectionHeader(props: SettingsSectionHeaderProps) {
  // ⚠️ Solid 组件体只跑一次：owner/pageOwned 是 props 派生值，必须收成 accessor——
  // 否则首挂后的 section 切换只更新 LABEL，owner 徽标永远停在首挂分区（F1 回归）。
  const owner = () => (props.section in SECTION_OWNERS)
    ? SECTION_OWNERS[props.section as keyof typeof SECTION_OWNERS]
    : undefined
  const pageOwned = () => owner() === undefined || isPageOwnedSection(props.section)

  return (
    <div class="settings-section-header">
      <span class="settings-owner-badge" data-testid="settings-owner-badge"
        data-owner={pageOwned() ? undefined : owner()}>
        <span class="settings-owner-diamond" aria-hidden="true">◇</span>
        {' '}
        <strong>{SETTINGS_SECTION_LABELS[props.section]}</strong>
        {pageOwned()
          ? <em class="settings-owner-id settings-owner-page">设置页</em>
          : <em class="settings-owner-id">· {SECTION_OWNER_LABELS[owner()!] ?? owner()}</em>}
      </span>
      {/* F3 边界修复：密度档只对含字段的组件 section 有意义，pageOwned 动作面板不显示 */}
      <Show when={!pageOwned()}>
        <label class="settings-density-label">
          显示详细度
          {/* K-3 优化：原生 select → ui/Select（combobox trigger + listbox 弹层） */}
          <span class="settings-density-select">
            <Select
              value={props.density}
              options={(Object.keys(DENSITY_LABELS) as SettingsDensity[])
                .map(d => ({ value: d, label: DENSITY_LABELS[d] }))}
              onChange={props.onDensity}
              ariaLabel="显示详细度"
            />
          </span>
        </label>
      </Show>
    </div>
  ) satisfies JSX.Element
}
