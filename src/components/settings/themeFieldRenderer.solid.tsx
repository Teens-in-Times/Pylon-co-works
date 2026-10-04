/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js'

import type { ThemeSettings } from '../../domains/theme/themeStore'
import { GROUP_ORDER, THEME_FIELD_DEFS, THEME_FIELD_KEYS, THEME_FIELD_OWNERS, type ThemeFieldDef, type ThemeFieldKey, type ZoneName } from '../../domains/theme/themeFieldDefs'
import ColorPopover from '../ColorPopover.solid.tsx'
import { useSettingsChromeStore } from '../../domains/appearance/settingsChromeStore.ts'
import { resolveBackgroundImage } from '../../infrastructure/skin/backgroundImage'
import { resolveSpinnerFrames } from '../../domains/chat/spinnerFrames'
import FontContributionPicker from './FontContributionPicker.solid.tsx'
import Select from '../ui/Select.solid.tsx'
import { getPluginSettingOptionsRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import type { PluginSettingOption, PluginSettingOptionsContribution } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'
import type { RegistryEntry } from '../../plugin-runtime/registry/types.ts'
import { resolveToolIndicatorAsset, toolIndicatorOptions } from '../../domains/chat/toolIndicatorAssets.ts'
import { lastSettingWriter, SETTING_WRITE_SOURCE_LABELS } from '../../domains/theme/settingProvenance.ts'
import { createZustandSignal } from '../../infrastructure/state/solidStoreBridge.ts'

/**
 * themeFieldRenderer — 声明式字段渲染器（自定义系统骨架）的 Solid 实体。
 *
 * 按 THEME_FIELD_DEFS 类型/控件标识 + GROUP_ORDER（分区/组/compact）渲染
 * Settings 字段区。能力：type 分发、特殊控件（bgImage/spinnerMarker/
 * schemeChip）、showIf 条件、advanced 折叠、suffix 后缀、hint 提示、
 * compact 紧凑行、h3 分区。
 */

export interface RenderCtx {
  t: ThemeSettings & { ccEditMode: boolean }
  onChange: (partial: Partial<ThemeSettings>) => void
  /** 设置搜索：按字段 label 过滤；非空时强制展开全部匹配组 */
  search?: string
  settingOptionEntries?: readonly RegistryEntry<PluginSettingOptionsContribution>[]
}

export interface ZoneGroupFieldsProps {
  zone: ZoneName
  ctx: RenderCtx
  density?: 'basic' | 'standard' | 'all'
}

export function Row(props: { label: string; children: JSX.Element; className?: string; anchor?: string; dataProv?: string }) {
  return <div class={`set-row${props.className ? ` ${props.className}` : ''}`} data-search-anchor={props.anchor} data-prov={props.dataProv}><span class="set-row-label">{props.label}</span>{props.children}</div>
}

export function Slider(props: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return <input type="range" min={props.min} max={props.max} step={props.step || 0.05} value={props.value}
    onInput={e => props.onChange(+e.currentTarget.value)} class="set-range" />
}

function Num(props: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return <input type="number" min={props.min} max={props.max} value={props.value} step={0.1}
    onInput={e => props.onChange(+e.currentTarget.value)} class="set-num" />
}

function Sel(props: { value: string; onChange: (v: string) => void; options: readonly (string | { value: string; label: string; description?: string; disabled?: boolean })[]; ariaLabel: string }) {
  return <Select ariaLabel={props.ariaLabel} className="set-select" value={props.value} onChange={props.onChange} options={props.options.map(option => typeof option === 'string' ? { value: option, label: option } : option)} />
}

function settingOptions(keyName: ThemeFieldKey, base: readonly PluginSettingOption[], ctx: RenderCtx) {
  return resolvePluginSettingOptions(`theme.${keyName}`, base, ctx.settingOptionEntries ?? [])
}

function withUnavailableCurrent(options: ReturnType<typeof settingOptions>, value: string) {
  return options.some(option => option.value === value)
    ? options
    : [{ value, label: `${value}（已不可用）`, disabled: true }, ...options]
}

function Txt(props: { value: string; onChange: (v: string) => void }) {
  return <input type="text" value={props.value} onInput={e => props.onChange(e.currentTarget.value)} class="set-input" />
}

// A-V12：折叠记忆统一走 settingsChromeStore（Solid 内核 persist 真值源，订阅式）。
function Group(props: { zone?: string; title: string; children: JSX.Element; defaultOpen?: boolean; forceOpen?: boolean }) {
  const collapseKey = props.zone ? `${props.zone}.${props.title}` : undefined
  // 挂载时捕获一次记忆值：折叠态记忆是「上次离开时的状态」，不随他组操作联动重放。
  const [open, setOpen] = createSignal((() => {
    if (!collapseKey) return props.defaultOpen ?? true
    const remembered = useSettingsChromeStore.getState().collapsedMap[collapseKey]
    return remembered === undefined ? (props.defaultOpen ?? true) : !remembered
  })())
  const visible = () => open() || props.forceOpen === true
  return (
    <div class="set-group" data-group-anchor={props.title}>
      <button type="button" class="set-group-title" aria-expanded={visible()}
        onClick={() => {
          const next = !visible()
          setOpen(next)
          if (collapseKey) useSettingsChromeStore.getState().setGroupCollapsed(collapseKey, !next)
        }}>
        <span class="set-group-arrow">{visible() ? '▾' : '▸'}</span>
        {props.title}
      </button>
      <Show when={visible()}>{props.children}</Show>
    </div>
  )
}

function BgImageControl(props: { value: string; onChange: (v: string) => void }) {
  const resolved = createMemo(() => resolveBackgroundImage(props.value))
  const openFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] })
      if (selected) props.onChange(selected as string)
    } catch { /* browser fallback */ }
  }
  return (
    <>
      <input type="text" value={props.value} onInput={e => props.onChange(e.currentTarget.value)} class="set-input" style={{ width: '160px' }} placeholder="路径或 URL" />
      <button class="ps-btn sm" onClick={openFile}>选择</button>
      <Show when={props.value}>
        <div class={`set-bg-preview ${resolved().error ? 'error' : ''}`} style={{ 'background-image': resolved().cssValue }}
          onClick={() => props.onChange('')} title={resolved().error ? `加载失败：${resolved().error}；点击清除` : '点击清除'} />
        <Show when={resolved().error}><span class="set-bg-error" role="alert">{resolved().error}</span></Show>
      </Show>
    </>
  )
}

function SpinnerMarkerControl(props: {
  mode: () => string
  value: () => string
  frames: () => string[]
  onModeChange: (v: string) => void
  onValueChange: (v: string) => void
}) {
  const safeFrames = () => props.frames().length > 0 ? props.frames() : ['·']
  return (
    <>
      <Sel ariaLabel="标记模式" value={props.mode()} onChange={props.onModeChange} options={['frame', 'custom']} />
      <Show when={props.mode() === 'frame'} fallback={<Txt value={props.value()} onChange={props.onValueChange} />}>
        <Sel ariaLabel="标记帧" value={safeFrames().includes(props.value()) ? props.value() : safeFrames()[0]} onChange={props.onValueChange} options={safeFrames()} />
      </Show>
    </>
  )
}

/** spinner 完成/取消/错误标记配套的 mode 字段名 */
function spinnerMarkerModeKey(key: string): ThemeFieldKey | null {
  const map: Record<string, ThemeFieldKey> = {
    spinnerDoneMarker: 'spinnerDoneMarkerMode',
    spinnerCancelledMarker: 'spinnerCancelledMarkerMode',
    spinnerErrorMarker: 'spinnerErrorMarkerMode',
  }
  return map[key] ?? null
}

/** number 显示后缀（percent 时值 *100） */
function formatDisplayValue(value: unknown, def: ThemeFieldDef): string {
  const num = Number(value ?? 0)
  const display = def.percent ? Math.round(num * 100) : num
  return `${display}${def.suffix ?? ''}`
}

/** 控件本体（不含 Row 包装；compact 行内联复用）。
 *  def/keyName 来自静态字段目录（挂载后不变），控件类型分支只在装配时求值一次；
 *  字段值经 value() 访问器保持响应式。 */
function FieldControl(props: { def: ThemeFieldDef; ctx: RenderCtx; keyName: ThemeFieldKey }) {
  const def = props.def
  const keyName = props.keyName
  const value = () => props.ctx.t[keyName]
  const emitKey = (v: unknown) => props.ctx.onChange({ [keyName]: v } as Partial<ThemeSettings>)

  if (def.control === 'bgImage') {
    return <BgImageControl value={String(value() ?? '')} onChange={v => emitKey(v)} />
  }

  if (def.control === 'spinnerMarker') {
    const modeKey = spinnerMarkerModeKey(keyName)
    const frames = () => resolveSpinnerFrames(props.ctx.t.spinnerFramePreset, props.ctx.t.spinnerCustomFrames)
    return (
      <SpinnerMarkerControl
        mode={() => modeKey ? String(props.ctx.t[modeKey] ?? 'frame') : 'custom'}
        value={() => String(value() ?? '')}
        frames={frames}
        onModeChange={v => { if (modeKey) props.ctx.onChange({ [modeKey]: v } as Partial<ThemeSettings>) }}
        onValueChange={v => emitKey(v)}
      />
    )
  }

  if (def.control === 'schemeChip') {
    return (
      <div class="set-preset-row">
        <button type="button" class={`set-preset-chip ${value() === 'light' ? 'active' : ''}`} onClick={() => emitKey('light')}>浅色</button>
        <button type="button" class={`set-preset-chip ${value() === 'dark' ? 'active' : ''}`} onClick={() => emitKey('dark')}>深色</button>
      </div>
    )
  }

  if (def.control === 'fontPicker' && def.fontRole) {
    return <FontContributionPicker ariaLabel={def.label} value={String(value() ?? '')} role={def.fontRole} settingTarget={`theme.${keyName}`} optionContributions={props.ctx.settingOptionEntries} onChange={v => emitKey(v)} />
  }

  if (def.control === 'toolIndicator') {
    const current = () => resolveToolIndicatorAsset(String(value() ?? '')).id
    const options = () => settingOptions(keyName, toolIndicatorOptions(), props.ctx)
    return <Sel
      ariaLabel={def.label}
      value={current()}
      onChange={next => emitKey(next)}
      options={withUnavailableCurrent(options(), current())}
    />
  }

  switch (def.type) {
    case 'color':
      return <ColorPopover value={String(value() ?? '')} onChange={v => emitKey(v)} chips={settingOptions(keyName, [], props.ctx).length > 0} palette={settingOptions(keyName, [], props.ctx)} />
    case 'number': {
      const min = () => def.minFn ? def.minFn(props.ctx.t as ThemeSettings) : (def.min ?? 0)
      return (
        <>
          <Slider value={Number(value() ?? 0)} onChange={v => emitKey(v)} min={min()} max={def.max ?? 100} step={def.step} />
          <Num value={Number(value() ?? 0)} onChange={v => emitKey(v)} min={min()} max={def.max} />
          <Show when={def.suffix}><span class="set-val">{formatDisplayValue(value(), def)}</span></Show>
        </>
      )
    }
    case 'select':
      if (def.control === 'segmented') {
        // T1-B：segmented 覆盖——2~3 值互斥选项用按钮组（radix ToggleGroup 的最小
        // Solid 等价：radiogroup/radio + data-state 词汇与键盘可聚焦按钮保持）。
        const current = () => String(value() ?? '')
        const options = createMemo(() => settingOptions(keyName, (def.options ?? []).map(option => ({ value: option, label: def.optionLabels?.[option] ?? option })), props.ctx))
        return (
          <div role="radiogroup" class="renderer-segmented" aria-label={def.label}>
            <For each={withUnavailableCurrent(options(), current())}>{option => (
              <button type="button" role="radio"
                disabled={option.disabled}
                aria-checked={option.value === current()}
                data-state={option.value === current() ? 'on' : 'off'}
                class={`renderer-segmented-chip${option.value === current() ? ' active' : ''}`}
                onClick={() => { if (option.value !== current()) emitKey(option.value) }}>
                {option.label}
              </button>
            )}</For>
          </div>
        )
      }
      {
        const current = () => String(value() ?? '')
        const options = () => settingOptions(keyName, (def.options ?? []).map(option => ({ value: option, label: def.optionLabels?.[option] ?? option })), props.ctx)
        return <Sel
          ariaLabel={def.label}
          value={current()}
          onChange={v => emitKey(v)}
          options={withUnavailableCurrent(options(), current())}
        />
      }
    case 'boolean':
      return <Sel ariaLabel={def.label} value={value() ? 'on' : 'off'} onChange={v => emitKey(v === 'on')} options={[{ value: 'on', label: '开' }, { value: 'off', label: '关' }]} />
    case 'text':
      return <Txt value={String(value() ?? '')} onChange={v => emitKey(v)} />
  }
}

function FieldRow(props: { def: ThemeFieldDef; ctx: RenderCtx; keyName: ThemeFieldKey }) {
  const value = () => props.ctx.t[props.keyName]
  const atDefault = () => props.def.default !== undefined && Object.is(value(), props.def.default)
  // D-trace：字段行暴露最近写入贡献者（title + data 属性，无布局影响）。
  // lastSettingWriter 是外部可变投影，追踪本字段值以便写入后重算（对齐 React 每渲染重取）。
  const provenance = createMemo(() => {
    void value()
    return lastSettingWriter(props.keyName)
  })
  const provenanceTitle = () => provenance()
    ? `（最后写入：${SETTING_WRITE_SOURCE_LABELS[provenance()!.source]}）`
    : ''
  return (
    <Row label={props.def.label} anchor={`field:${props.keyName}`} className={props.def.control === 'fontPicker' ? 'font-setting-row' : ''} dataProv={provenance()?.source}>
      <FieldControl def={props.def} ctx={props.ctx} keyName={props.keyName} />
      <Show when={props.def.default !== undefined && !atDefault()}>
        <button type="button" class="set-field-reset" aria-label="恢复默认"
          title={`恢复默认${provenanceTitle()}`} onClick={() => props.ctx.onChange({ [props.keyName]: props.def.default } as Partial<ThemeSettings>)}>↺</button>
      </Show>
      <Show when={props.def.hint}><div class="set-hint">{props.def.hint}</div></Show>
    </Row>
  )
}

function renderGroupFields(fields: ThemeFieldKey[], ctx: () => RenderCtx) {
  const regular = () => fields.filter(key => !(THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced)
  const advanced = () => fields.filter(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced)
  // 搜索时 advanced 字段内联展开（不藏进"高级…"，否则命中项不可见）
  const searching = () => (ctx().search?.trim() ?? '').length > 0
  const advancedRows = () => advanced().map(key => {
    const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
    return <FieldRow keyName={key} def={def} ctx={ctx()} />
  })
  return (
    <>
      <For each={regular()}>{key => {
        const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
        return <FieldRow keyName={key} def={def} ctx={ctx()} />
      }}</For>
      <Show when={advanced().length > 0}>
        <Show when={searching()} fallback={
          <details class="set-advanced">
            <summary>高级…</summary>
            {advancedRows()}
          </details>
        }>
          {advancedRows()}
        </Show>
      </Show>
    </>
  )
}

function renderCompactGroup(fields: ThemeFieldKey[], ctx: () => RenderCtx) {
  const regular = () => fields.filter(key => !(THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced)
  return (
    <div class="set-compact-row">
      <For each={regular()}>{key => {
        const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
        const value = () => ctx().t[key]
        const atDefault = () => def.default !== undefined && Object.is(value(), def.default)
        return (
          <>
            <span class="set-compact-label">{def.label}</span>
            <FieldControl def={def} ctx={ctx()} keyName={key} />
            <Show when={def.default !== undefined && !atDefault()}>
              <button type="button" class="set-field-reset compact" aria-label="恢复默认"
                onClick={() => ctx().onChange({ [key]: def.default } as Partial<ThemeSettings>)}>↺</button>
            </Show>
          </>
        )
      }}</For>
      <Show when={fields.some(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced)}>
        <details class="set-advanced">
          <summary>高级…</summary>
          <For each={fields.filter(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).advanced)}>{key => {
            const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
            return <FieldRow keyName={key} def={def} ctx={ctx()} />
          }}</For>
        </details>
      </Show>
    </div>
  )
}

interface GroupView { title: string; compact?: boolean; defaultOpen?: boolean; fields: ThemeFieldKey[] }

/**
 * 渲染某 zone 的字段区：GROUP_ORDER 提供 分区（h3）→ 组（可 compact）两级。
 * 字段从 defs 按 group 自动收集；hidden 跳过、showIf 条件过滤。
 */
export function ZoneGroupFields(props: ZoneGroupFieldsProps) {
  const optionRegistry = getPluginSettingOptionsRegistry()
  const optionSnapshot = createZustandSignal(
    { getState: () => optionRegistry.getSnapshot(), subscribe: listener => optionRegistry.subscribe(() => listener(optionRegistry.getSnapshot())) },
    // registry 的 subscribe 回调不传快照，selector 自取。
    () => optionRegistry.getSnapshot(),
  )
  const resolvedCtx = createMemo<RenderCtx>(() => ({ ...props.ctx, settingOptionEntries: optionSnapshot().entries }))
  const sections = createMemo(() => GROUP_ORDER[props.zone])
  const query = () => props.ctx.search?.trim().toLowerCase() ?? ''
  const searching = () => query().length > 0
  return (
    <Show when={sections()}>
      <For each={sections()!}>{section => {
        // 只渲染**有字段**的组（空组会画出一个只有标题、点了没东西的分类）。
        // 组视图按 title 复用旧引用：For 按引用判等，重算字段清单时已挂载的
        // Group 实例（及其折叠态）保持稳定——对齐 React 按 key 调和的语义。
        const groups = createMemo<(GroupView[])>(prev => {
          const next = section.groups
            .map(group => {
              const fields = THEME_FIELD_KEYS.filter(key => {
                const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
                return def.zone === props.zone && def.group === group.title && !def.hidden
                  && THEME_FIELD_OWNERS[key].owner === 'theme'
                  && (props.density !== 'basic' || def.tier === 'basic')
                  && (!def.showIf || def.showIf(props.ctx.t as ThemeSettings))
                  && (!searching() || def.label.toLowerCase().includes(query()))
              })
              return { ...group, fields }
            })
            .filter(group => group.fields.length > 0)
          return next.map(group => prev.find(candidate => candidate.title === group.title) ?? group)
        }, [])
        return (
          <Show when={groups().length > 0} fallback={
            section.heading
              ? <h3 data-group-anchor={section.heading}>{section.heading}</h3>
              : null
          }>
            {/* ★ #266 CC-09：元件标题也挂锚点 —— 左栏「中控台」的二级项是**元件名**，
                点击要能滚到这里（原先只有组挂锚点，元件标题点了没落点）。 */}
            {section.heading && <h3 data-group-anchor={section.heading}>{section.heading}</h3>}
            <For each={groups()}>{group => (
              <Group zone={props.zone} title={group.title} defaultOpen={group.defaultOpen} forceOpen={searching()}>
                <Show when={group.compact} fallback={renderGroupFields(group.fields, resolvedCtx)}>
                  {renderCompactGroup(group.fields, resolvedCtx)}
                </Show>
              </Group>
            )}</For>
          </Show>
        )
      }}</For>
    </Show>
  )
}
