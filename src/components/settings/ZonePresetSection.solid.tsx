/** @jsxImportSource solid-js */
import { createMemo, For, Show, type JSX } from 'solid-js'
import { useThemeStore } from '../../domains/theme/themeStore'
import { deriveZoneStatus } from '../../domains/theme/presetReducer'
import { ZonePresetRow } from './settingsSectionShared.solid.tsx'
import type { ChatPresetAxis, ZonePresetEntry } from '../../domains/theme/zones/index.ts'
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
  onSaveZonePresetEntry: (zone: ZonePresetEntry['zone'], name: string, axis?: ChatPresetAxis) => void
  onRemoveZonePresetEntry: (id: string) => void
}

/** 消息流两行的行标签（#607 刀3a：两张单各一行）。 */
const CHAT_AXIS_ROWS = [
  { axis: 'style', title: '消息流样式单' },
  { axis: 'color', title: '消息流配色单' },
] as const

/**
 * ZonePresetSection — 区域分区（sidebar/chat/cc/right）的同构骨架（A-V3 拆分自
 * Settings.tsx 四段重复 JSX）：分区标题 + 可选头部组 + 局部预设行 + 声明式字段组
 * （fields 经 props 注入，renderCtx/density 保持单源）+ 可选尾部组（如 cc 的布局
 * 编辑器入口）。区域预设状态派生（appliedName/isCustom）在本组件内完成。
 *
 * ★ #607 刀3a：消息流区渲染**两行**（样式单 / 配色单，候选按轴取）；其余区仍一行。
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
        {/* 消息流两行共用同一份区域状态（`appliedPreset.chat` / `custom.chat` 各只有一个槽）；
            各自只展示/保存自己那一轴的候选与切片。 */}
        <Show
          when={props.zone === 'chat'}
          fallback={
            <ZonePresetRow zone={props.zone} interfaceMode={props.interfaceMode} activeName={status().appliedName} isDirty={status().isCustom}
              onApply={props.onApplyZonePreset} onSaveCurrent={props.onSaveZonePresetEntry} onRemoveEntry={props.onRemoveZonePresetEntry} />
          }
        >
          <For each={CHAT_AXIS_ROWS}>{row => (
            <ZonePresetRow zone="chat" axis={row.axis} title={row.title} interfaceMode={props.interfaceMode}
              activeName={status().appliedName} isDirty={status().isCustom}
              onApply={props.onApplyZonePreset} onSaveCurrent={props.onSaveZonePresetEntry} onRemoveEntry={props.onRemoveZonePresetEntry} />
          )}</For>
        </Show>
      </Show>
      {props.fields}
      {props.footer}
    </>
  )
}
