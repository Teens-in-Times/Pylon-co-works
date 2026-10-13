/**
 * 区域层 · 区域预设池（刀6 / #206 建池；刀2 / #223 出厂条目独立成数据；刀3 / #223 拆掉过渡工具）。
 *
 * **出厂条目**是**落盘数据**（`src/zones/factory/**`，刀2 由生成脚本从 `GLOBAL_PRESETS` 现场切出并逐条校验）；
 * **自定义条目**存值快照（`values`）——铁律「存引用不存值」的**唯一**字面例外
 * （自建条目没有来源预设可指）。
 *
 * 刀2 的三处变化（历史，仍生效）：
 * 1. ★ **判据换成显式来源字段 `origin`**：出厂与自定义**都带 `values`**，旧的
 *    `values !== undefined` 判据会立刻失效（出厂条目会变成"可删"、UI 亮「自定义」）。
 * 2. ★ **折叠退场**（规范 §7 刀2「裁决 A」）：刀1 的 `zoneRefs` 是逐套显式写自己的名字，
 *    而折叠会把内容相同的多条并成一条、只留排序最前的 id ⇒ 被折叠那套的引用指向不存在的 id
 *    ⇒ 那个预设**装不上**。两者互斥，去掉折叠。`sources` 字段与 UI 的同形悬停提示随之退场。
 * 3. `ZONE_PRESET_POOL` 的数据来源 = 落盘数据表（不再现场派生）。
 *
 * ★ 刀3（#223）已删掉刀2 的两个过渡产物：生成脚本与其依赖的 `deriveZonePresetPool` /
 * `deriveFactoryZonePresetEntries` 参考实现（预设不再自带 `theme`，它们的输入消失了）。
 * 出厂条目的"值"此后只有两个来源：**落盘数据表**（生产）与测试里手写的字面量。
 *
 * 规则唯一来源：`预设修正/预设系统V2/06-规则提案-区域预设池派生-待拍板.md` §三。
 * 本模块只消费 `INTERFACE_MODE_PRESET_BUCKET` / `PRESET_ZONES` / `ZONE_FIELDS`，
 * 不复制它们的任何真值。
 */

import type { ThemeSettings } from '../themeStore.ts'
import { ZONE_FIELDS, ZONES, type ZoneName } from '../themeFieldDefs.ts'
import { PRESET_ZONES, assertZoneSliceOwnership, type ChatPresetAxis, type PresetZone } from '../presetReducer.ts'
import {
  INTERFACE_MODE_PRESET_BUCKET,
  type PresetInterfaceMode,
} from '../presets/index.ts'
import { LANDING_PRESET_ENTRIES } from './factory/landingEntries.ts'

/**
 * 条目来源。**出厂与自定义的区分唯一真值**（不再看有没有 `values`——刀2 起两方都有）。
 * 缺省视为自定义：持久化通道里存的一律是用户条目。
 */
export type ZonePresetOrigin = 'factory' | 'custom'

// ★ #607 刀3a：轴类型的**唯一定义**下沉到 `presetReducer`（那里有 `CHAT_PRESET_AXES` 真值）；
// 本模块只转发，不另立第二份（历史定义位置在此，消费面因此保持不变）。
export type { ChatPresetAxis }
export type ZonePresetSource =
  | { presetName: string; profileId?: never }
  | { profileId: string; presetName?: never }

interface ZonePresetEntryBase {
  id: string
  mode: PresetInterfaceMode
  /** 出厂条目 = 来源预设 label；自定义条目 = 用户命名。 */
  label: string
  /** 刀2（#223）：条目来源。缺省 = 自定义（历史持久化条目与调用方直造的条目都没有该字段）。 */
  origin?: ZonePresetOrigin
  /** 该区域的字段值：出厂条目 = 落盘数据；自定义条目 = 用户存下的快照。 */
  values: Partial<ThemeSettings>
  /** 仅出厂条目：来源预设或呈现档案，不混用两种身份。 */
  source?: ZonePresetSource
  /**
   * 派生标记（不落盘）：Q8 清理后该条目**已无有效字段键** ⇒ 行内占位、不可应用。
   */
  stale?: boolean
}

export type ZonePresetEntry = ZonePresetEntryBase & (
  | { zone: 'chat'; axis?: ChatPresetAxis }
  | { zone: Exclude<ZoneName, 'chat'>; axis?: never }
)

/** 池 = 模式桶 → 区域 → 条目；仅 chat 条目可声明样式/配色轴。 */
export type ZonePresetPool = Record<PresetInterfaceMode, Record<PresetZone, ZonePresetEntry[]>>

const PRESET_INTERFACE_MODES = ['gui', 'terminal', 'tactical'] as const satisfies readonly PresetInterfaceMode[]

// ── 出厂数据 → 池（刀2 的生产读路径） ───────────────────────────────

/**
 * 把**落盘出厂数据**装配成池。
 *
 * ★ 两件事在这里发生，且都必须在构建时报错而不是静默降级：
 * - **越区键**：每条的值键必须全部属于它自己那个区域（判据 `ZONE_FIELDS`，复用刀1 的
 *   `assertZoneSliceOwnership`）。静默丢弃的症状是「我这个区域该改的没改」，用户看不出原因。
 * - 条目**原对象直接入池**（不复制、不重算）——「数据表就是活数据源」这件事因此可被断言钉住。
 */
export function assembleFactoryZonePresetPool(entries: readonly ZonePresetEntry[]): ZonePresetPool {
  const pool = {} as ZonePresetPool
  for (const mode of PRESET_INTERFACE_MODES) {
    const zones = {} as Record<PresetZone, ZonePresetEntry[]>
    for (const zone of PRESET_ZONES) {
      const cell = entries.filter(entry => entry.mode === mode && entry.zone === zone)
      for (const entry of cell) {
        if (entry.axis !== undefined && (zone !== 'chat' || !['style', 'color'].includes(entry.axis))) {
          throw new Error(`出厂区域预设 ${mode}/${zone}/${entry.id}：非法 chat 轴 ${entry.axis}`)
        }
        // ★ #607 刀3a：`inputBorderColor` 是**唯一**允许待在 cc 材料里的待迁边线
        //   （字段归属表里它仍写 global；与 `presetReferencePlan.assertLandingEntry` 同一条例外）。
        //   其余键的越区判据一字不动。
        const values = entry.values as Record<string, unknown>
        const checked = zone === 'cc' && Object.hasOwn(values, 'inputBorderColor')
          ? (Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'inputBorderColor')) as Partial<ThemeSettings>)
          : entry.values
        assertZoneSliceOwnership(zone, checked, `出厂区域预设 ${mode}/${zone}/${entry.id}`)
      }
      zones[zone] = Object.freeze(cell.map(entry => Object.freeze(entry))) as ZonePresetEntry[]
    }
    pool[mode] = Object.freeze(zones)
  }
  return Object.freeze(pool)
}

/** 显式查询传入池的 chat 轴；未标轴的旧条目按配色解释，不改写条目。 */
export function chatPresetsForAxis(
  pool: ZonePresetPool,
  mode: PresetInterfaceMode,
  axis: ChatPresetAxis,
): ZonePresetEntry[] {
  return pool[mode].chat.filter(entry => (entry.axis ?? 'color') === axis)
}

/**
 * 出厂池的**条目来源**（#607 刀3a）：落点材料里 `factory:*` 的那一批。
 *
 * ★ `preset:*`（三张 Agent 卡的**合并落点**）不进池——它是「预设整体落点」，
 * 不是单区候选；要不要在区域行里出现，取决于它是哪一区的单区材料。
 * ★ 消息流区在这里就是**两条单**（`axis` 显式标 style / color）⇒ 设置页据此渲染两行。
 */
export const FACTORY_POOL_ENTRIES: readonly ZonePresetEntry[] = Object.freeze(
  LANDING_PRESET_ENTRIES.filter(entry => entry.id.startsWith('factory:')),
)

/**
 * ★ 蓝调战术那一桶的条目来源：它的**家族里只有隐藏默认一员**（没有出厂工厂材料）。
 *
 * 施工单 §4.4 只说「候选 = `factory:*` 条目」，但蓝调桶一条工厂材料也没有 ⇒ 按字面实现
 * 它的区域行会**整组不渲染**，与验收 §5.6「蓝调区域行可见、可切换、可重置、可存自定义」
 * 直接冲突。故：**没有工厂材料的桶以它的默认单为家族内容**（默认成员不进 chips 的口径不变，
 * 只是这一桶的默认成员同时是它唯一的区域行候选）。此项已在回单「阻断与新增」点名待裁。
 */
export const MODE_DEFAULT_POOL_ENTRIES: readonly ZonePresetEntry[] = Object.freeze(
  LANDING_PRESET_ENTRIES.filter(entry => entry.id.startsWith('default:')),
)

/** 池的装配输入 = 工厂材料 ＋ 各桶的默认单（后者只在**该桶没有工厂材料**时被用到）。 */
const POOL_ENTRIES: readonly ZonePresetEntry[] = Object.freeze([
  ...FACTORY_POOL_ENTRIES,
  ...MODE_DEFAULT_POOL_ENTRIES,
])

/**
 * 构建时装配的出厂池。
 *
 * 入池规则（#607 刀3a）：工厂材料全入；**默认单只在它那一桶没有工厂材料时才入池**
 * （gui / terminal 两桶的默认成员照旧不进候选 —— 刀7 的「默认预设不进列表、不进池」不变；
 * 蓝调那一桶没有工厂材料 ⇒ 它的默认单就是家族内容）。
 */
export const ZONE_PRESET_POOL: ZonePresetPool = assembleFactoryZonePresetPool(
  POOL_ENTRIES.filter(entry => !entry.id.startsWith('default:')
    || !FACTORY_POOL_ENTRIES.some(item => item.mode === entry.mode)),
)

// ── 自定义条目（值快照） ───────────────────────────────────────────

/** 该 zone 合法的字段键集（`ZONE_FIELDS` 单一真值；META 字段已在表里排除）。 */
function zoneFieldKeys(zone: string): Set<string> {
  return new Set<string>(ZONE_FIELDS[zone] ?? [])
}

/**
 * Q8：把值快照收敛到该 zone 的字段集——**已删字段键/越区键一律丢弃**。
 * 返回丢弃键清单供调用方判定该条目是否已经「无有效字段」。
 */
export function normalizeZonePresetValues(
  zone: string,
  values: Partial<ThemeSettings>,
): { values: Partial<ThemeSettings>; droppedKeys: string[] } {
  const allowed = zoneFieldKeys(zone)
  const record = values as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  const droppedKeys: string[] = []
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) kept[key] = record[key]
    else droppedKeys.push(key)
  }
  return { values: kept as Partial<ThemeSettings>, droppedKeys }
}

/**
 * 出厂条目 vs 自定义条目的唯一判据：**显式来源字段 `origin`**（刀2 起）。
 *
 * ★ 不能再判 `values !== undefined`——出厂条目也带 `values` 了，那样出厂条目会变成「可删」、
 * UI 会亮「自定义」、删除闸门也挡不住。缺省（无 `origin`）= 自定义：持久化通道只存用户条目。
 */
export function isCustomZonePresetEntry(entry: ZonePresetEntry): boolean {
  return entry.origin !== 'factory'
}

/** 清理后是否已无任何有效字段（⇒ 该条目退化为行内占位）。出厂数据不参与。 */
function isEntryStale(entry: ZonePresetEntry): boolean {
  if (entry.origin === 'factory') return false
  return Object.keys(entry.values ?? {}).length === 0
}

/**
 * Q8 自动清理：把每条自定义条目的值快照收敛到该 zone 的字段集。
 * **保留记录本身**（清的是键，不是条目）——条目留作行内占位，避免静默删用户数据；
 * 无变化时返回原引用，便于调用方做「要不要写回」的判据。
 */
export function cleanupZonePresetEntries(entries: readonly ZonePresetEntry[]): ZonePresetEntry[] {
  let changed = false
  const next = entries.map(entry => {
    if (entry.origin === 'factory' || !entry.values) return entry
    const { values, droppedKeys } = normalizeZonePresetValues(entry.zone, entry.values)
    if (droppedKeys.length === 0) return entry
    changed = true
    return { ...entry, values }
  })
  return changed ? next : (entries as ZonePresetEntry[])
}

/** 持久化读入的容错归一（键含模式 + 区域；无 `values` 的条目不是自定义条目 ⇒ 丢弃）。 */
export function normalizeZonePresetEntries(value: unknown): ZonePresetEntry[] {
  if (!Array.isArray(value)) return []
  const entries: ZonePresetEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<ZonePresetEntry>
    if (typeof candidate.id !== 'string' || !candidate.id.trim()) continue
    // ★ #607 刀3a：蓝调战术有桶之后，它的自定义条目也必须能读回来（原先只认 gui/terminal）。
    if (!(PRESET_INTERFACE_MODES as readonly string[]).includes(candidate.mode as string)) continue
    const zone = typeof candidate.zone === 'string' && candidate.zone ? candidate.zone : undefined
    if (zone === undefined || !(ZONES as readonly string[]).includes(zone)) continue
    if (typeof candidate.label !== 'string' || !candidate.label.trim()) continue
    if (!candidate.values || typeof candidate.values !== 'object') continue
    const origin: ZonePresetOrigin | undefined = candidate.origin === 'factory' || candidate.origin === 'custom'
      ? candidate.origin
      : undefined
    // ★ #607 刀3a：轴只属消息流区（其余区不保留）；来源身份按既有两形态原样留。
    const axis: ChatPresetAxis | undefined = zone === 'chat'
      && (candidate.axis === 'style' || candidate.axis === 'color') ? candidate.axis : undefined
    const source: ZonePresetSource | undefined = validZonePresetSource(candidate.source)
    const base = {
      id: candidate.id.trim(),
      mode: candidate.mode as PresetInterfaceMode,
      label: candidate.label.trim().slice(0, 40),
      ...(origin ? { origin } : {}),
      ...(source ? { source } : {}),
      values: { ...(candidate.values as Partial<ThemeSettings>) },
    }
    if (zone === 'chat') entries.push({ ...base, zone: 'chat', ...(axis ? { axis } : {}) })
    else entries.push({ ...base, zone })
  }
  return entries
}

/** 来源身份的两形态（预设名 / 档案 id），二选一且非空；其余一律丢弃。 */
function validZonePresetSource(value: unknown): ZonePresetSource | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const presetName = typeof record.presetName === 'string' && record.presetName.trim() ? record.presetName : undefined
  const profileId = typeof record.profileId === 'string' && record.profileId.trim() ? record.profileId : undefined
  if (presetName && !profileId) return { presetName }
  if (profileId && !presetName) return { profileId }
  return undefined
}

const generatedZonePresetEntryIds = new Set<string>()

/** 自定义条目 id：**键含模式 + 区域**（`zone-<mode>-<zone>-<now>`），撞号加后缀。 */
export function createZonePresetEntryId(
  mode: PresetInterfaceMode,
  zone: string,
  now: number,
  existingIds: readonly string[] = [],
): string {
  const baseId = `zone-${mode}-${zone}-${now}`
  const occupied = new Set([...existingIds, ...generatedZonePresetEntryIds])
  if (!occupied.has(baseId)) {
    generatedZonePresetEntryIds.add(baseId)
    return baseId
  }
  let suffix = 1
  while (occupied.has(`${baseId}-${suffix}`)) suffix += 1
  const id = `${baseId}-${suffix}`
  generatedZonePresetEntryIds.add(id)
  return id
}

// ── 删除（刀7 前置 / #211） ─────────────────────────────────────────

export interface ZonePresetRemovalState {
  zonePresetEntries: readonly ZonePresetEntry[]
  appliedPreset: Record<string, string>
  custom: Record<string, boolean>
}

export interface ZonePresetRemovalPatch {
  zonePresetEntries: ZonePresetEntry[]
  appliedPreset?: Record<string, string>
  custom?: Record<string, boolean>
}

/**
 * 删除一条**自定义**区域预设条目。形态对齐全局先例 `removeCustomPresetReducer`：
 *
 * - 出厂条目**不可删**：它们由落盘的出厂数据表持有（`src/zones/factory/**`）、
 *   从不进入 `zonePresetEntries`，故传出厂预设名（即条目 id）是 no-op——同一份闸门
 *   同时挡住 UI 与任意调用方。
 * - 引用它的区域**失去基准**：`appliedPreset[zone]=''` + `custom[zone]=true`，
 *   **字段保留现值**（与全局删除链同语义：不是回默认态，是「无基准的自定义快照」）。
 * - 未命中 ⇒ 原样返回 `zonePresetEntries` 引用，调用方据此跳过写状态。
 */
export function removeZonePresetEntryReducer(
  state: ZonePresetRemovalState,
  id: string,
): ZonePresetRemovalPatch {
  const entries = state.zonePresetEntries.filter(entry => entry.id !== id)
  if (entries.length === state.zonePresetEntries.length) {
    return { zonePresetEntries: state.zonePresetEntries as ZonePresetEntry[] }
  }
  const appliedPreset = { ...state.appliedPreset }
  const custom = { ...state.custom }
  for (const [zone, value] of Object.entries(appliedPreset)) {
    if (value === id) {
      appliedPreset[zone] = ''
      custom[zone] = true
    }
  }
  return { zonePresetEntries: entries, appliedPreset, custom }
}

// ── 查询与消费 ─────────────────────────────────────────────────────

/**
 * 该 (界面模式, 区域) 的候选条目：出厂条目（落点材料里的 `factory:*`）+ 自定义条目（已过 Q8 清理）。
 * 界面模式**未登记归属桶**（如插件模式）⇒ 空数组 ⇒ 调用方整组不渲染。
 *
 * ★ #607 刀3a：消息流区有**两条单** ⇒ 传 `axis` 表示「只要该轴那一行」的候选；
 *   不传 = 该区全部条目（整区视图，供非分行场景/测试用）。
 */
export function zonePresetsFor(
  interfaceMode: string,
  zone: string,
  customEntries: readonly ZonePresetEntry[] = [],
  axis?: ChatPresetAxis,
): ZonePresetEntry[] {
  const bucket = INTERFACE_MODE_PRESET_BUCKET[interfaceMode]
  if (!bucket) return []
  const chatAxis = zone === 'chat' ? axis : undefined
  const factory = chatAxis
    ? chatPresetsForAxis(ZONE_PRESET_POOL, bucket, chatAxis)
    : (ZONE_PRESET_POOL[bucket] as Record<string, ZonePresetEntry[] | undefined>)[zone] ?? []
  const custom = normalizeZonePresetEntries(customEntries)
    .filter(entry => entry.mode === bucket && entry.zone === zone)
    .filter(entry => chatAxis === undefined || (entry.axis ?? 'color') === chatAxis)
    .map(entry => {
      const { values } = normalizeZonePresetValues(entry.zone, entry.values ?? {})
      // ★ 持久化通道里的一律是**用户自建**条目 ⇒ 显式标 custom（挡住"手改 localStorage 塞 factory"）
      const cleaned: ZonePresetEntry = { ...entry, origin: 'custom', values }
      return isEntryStale(cleaned) ? { ...cleaned, stale: true } : cleaned
    })
  if (factory.length === 0 && custom.length === 0) return []
  return [...factory, ...custom]
}

/**
 * 条目 → 应用用的主题切片。
 * - 出厂条目：直接给落盘数据里的 `values`（刀2 起不再现场切——切法退为参考实现）
 * - 自定义条目：直接给清理后的值快照
 * - 行内占位条目 ⇒ `null`（不可应用）
 */
export function resolveZonePresetEntryTheme(entry: ZonePresetEntry): Partial<ThemeSettings> | null {
  if (entry.stale) return null
  return entry.values ?? null
}
