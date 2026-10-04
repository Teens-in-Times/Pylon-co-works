/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js'
import { useCustomPresetStore } from '../../domains/theme/customPresetStore'
import { zonePresetsFor, isCustomZonePresetEntry, type ZonePresetEntry } from '../../domains/theme/zones/index.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'

/**
 * settingsSectionShared.solid — Settings 共享呈现原语的 Solid 实体（#515）。
 *
 * #515 W1 收口：`Group`（折叠组）与 error key 口径在本实体落地面；error key 纯函数
 * 拆至 `settingsErrorReports.ts`（`.ts` 面不得静态引用 .solid.tsx，实体侧转发保持
 * 既有消费接口）。React 面 settingsSectionShared.tsx 已随该域 Solid 化删除——本文件
 * 是唯一事实。
 */
export { reportSettingsError, resolveSettingsError } from './settingsErrorReports.ts'

export function Group(props: { title: string; children: JSX.Element; defaultOpen?: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? true)
  return (
    <div class="set-group">
      <button type="button" class="set-group-title" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="set-group-arrow">{open() ? '▾' : '▸'}</span>
        {props.title}
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  )
}

interface ZonePresetRowProps {
  zone: ZonePresetEntry['zone']; interfaceMode: string; activeName: string; isDirty: boolean
  onApply: (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => void
  onSaveCurrent: (zone: ZonePresetEntry['zone'], name: string) => void
  onRemoveEntry: (id: string) => void
}

/**
 * 刀6（#206）：区域预设行。候选不再是「平铺 10 个整体预设」，而是该
 * (界面模式桶, 区域) 的池条目——出厂条目（存引用，应用时现场切）+ 自定义条目（存值快照）。
 * 未登记归属桶的界面模式（如 tactical-blue）⇒ 池为空 ⇒ **整组不渲染**（与刀5 同口径）。
 */
export function ZonePresetRow(props: ZonePresetRowProps) {
  const customEntries = createZustandSignal(useCustomPresetStore, s => s.zonePresetEntries)
  const entries = createMemo(() => zonePresetsFor(props.interfaceMode, props.zone, customEntries()))
  const [entryName, setEntryName] = createSignal('')
  // 刀7 前置（#211）：行内两段式确认的待删条目（照全局自定义预设先例，不常驻、不开模态）
  const [pendingDeleteEntryId, setPendingDeleteEntryId] = createSignal<string | null>(null)
  return (
    <Show when={entries().length > 0} fallback={null}>
      <Group title="局部预设">
        <div class="set-preset-row">
          <For each={entries()}>{entry => {
            const selected = () => props.activeName === entry.id && !props.isDirty
            // 刀7 前置（#211）出现条件：**只在自定义条目**上；普通条目「被选中才出现」
            // （那排 chip 本来就挤），Q8 灰显占位条目常驻——那是它唯一的自然出口。
            // 刀2（#223）起判据是显式来源字段 `origin`：出厂条目（`origin:'factory'`）**任何情况下**
            // 都不进入这一段（铁律 1：出厂件不可改、不可删）。
            const deletable = () => isCustomZonePresetEntry(entry) && (entry.stale === true || selected())
            return (
              <>
                <button type="button"
                  class={`set-preset-chip ${selected() ? 'active' : ''}`}
                  aria-current={selected() ? 'true' : undefined}
                  // Q8：清理后已无有效字段的自定义条目 = 行内占位（灰显、不可应用）；不给用户开关。
                  disabled={entry.stale === true}
                  title={entry.stale
                    ? '该条目引用的字段已被删除，值已自动清理，不能再应用'
                    : undefined}
                  onClick={() => props.onApply(props.zone, entry)}>{entry.label}</button>
                {/* 刀7 前置（#211）：删除钮只渲染在 deletable 条目上，确认态
                    （pending ? confirm : 删除）在条目内联表达——不得放进外层
                    fallback，否则出厂/未选中条目也会出现删除钮。 */}
                <Show when={deletable()}>
                  <Show when={pendingDeleteEntryId() === entry.id} fallback={
                    <button type="button" class="ps-btn sm danger"
                      onClick={() => setPendingDeleteEntryId(entry.id)}>删除</button>
                  }>
                    <div class="set-confirm set-confirm-inline" role="alertdialog" aria-label={`确认删除区域预设 ${entry.label}`}>
                      <span class="set-confirm-text">删除后不可恢复；将移除本区的自定义条目「{entry.label}」，本区保留现值但失去该预设基准。</span>
                      <div class="set-confirm-actions">
                        <button type="button" class="ps-btn sm danger"
                          onClick={() => { setPendingDeleteEntryId(null); props.onRemoveEntry(entry.id) }}>确认删除</button>
                        <button type="button" class="ps-btn sm" onClick={() => setPendingDeleteEntryId(null)}>取消</button>
                      </div>
                    </div>
                  </Show>
                </Show>
              </>
            )
          }}</For>
          <Show when={props.isDirty}><span class="set-preset-chip active">自定义</span></Show>
        </div>
        <div class="set-hint">只改本区外观参数，自动切换为自定义；改动后可存成属于本区的自定义条目</div>
        <div class="set-custom-preset-save">
          <input class="set-input" value={entryName()} onInput={event => setEntryName(event.currentTarget.value)} placeholder="区域预设名称" />
          <button type="button" class="ps-btn sm" disabled={!entryName().trim()} title={entryName().trim() ? undefined : '保存必须命名'}
            onClick={() => { props.onSaveCurrent(props.zone, entryName()); setEntryName('') }}>存当前</button>
        </div>
      </Group>
    </Show>
  )
}
