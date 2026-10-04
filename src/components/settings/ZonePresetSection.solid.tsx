/** @jsxImportSource solid-js */
import { createMemo, Show, type JSX } from 'solid-js'
import { useThemeStore } from '../../domains/theme/themeStore'
import { deriveZoneStatus } from '../../domains/theme/presetReducer'
import { ZonePresetRow } from './settingsSectionShared.solid.tsx'
import type { ZonePresetEntry } from '../../domains/theme/zones/index.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'

interface ZonePresetSectionProps {
  /** 区域分区骨架只服务具名 section 区（global 的组合不同，走 GlobalPresetSection）。 */
  zone: 'sidebar' | 'chat' | 'cc' | 'right'
  label?: string
  isSearching: boolean
  interfaceMode: string
  fields: JSX.Element
  header?: JSX.Element
  footer?: JSX.Element
  onApplyZonePreset: (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => void
  onSaveZonePresetEntry: (zone: ZonePresetEntry['zone'], name: string) => void
  onRemoveZonePresetEntry: (id: string) => void
}

/**
 * ZonePresetSection — 区域分区（sidebar/chat/cc/right）的同构骨架（A-V3 拆分自
 * Settings.tsx 四段重复 JSX）：分区标题 + 可选头部组 + 局部预设行 + 声明式字段组
 * （fields 经 props 注入，renderCtx/density 保持单源）+ 可选尾部组（如 cc 的布局
 * 编辑器入口）。区域预设状态派生（appliedName/isCustom）在本组件内完成。
 *
 * #515 W1：Solid 实体——Settings.solid 的 React 岛（fields/header/footer React 元素位
 * + ReactIslandHost）随本实体直连退役；props 不解构（fields/header/footer 保持响应式
 * 注入）。
 */
export default function ZonePresetSection(props: ZonePresetSectionProps) {
  const appliedPreset = createZustandSignal(useThemeStore, s => s.appliedPreset)
  const custom = createZustandSignal(useThemeStore, s => s.custom)

  const status = createMemo(() => deriveZoneStatus({ appliedPreset: appliedPreset(), custom: custom() }, props.zone))
  return (
    <>
      <Show when={!props.isSearching && props.label != null}><h3>{props.label}</h3></Show>
      {props.header}
      <Show when={!props.isSearching}>
        <ZonePresetRow zone={props.zone} interfaceMode={props.interfaceMode} activeName={status().appliedName} isDirty={status().isCustom}
          onApply={props.onApplyZonePreset} onSaveCurrent={props.onSaveZonePresetEntry} onRemoveEntry={props.onRemoveZonePresetEntry} />
      </Show>
      {props.fields}
      {props.footer}
    </>
  )
}
