/**
 * presetReducer — 预设路由的纯计算层（A0 抽出，A1 改模型）。
 *
 * 六个预设 action 的全部状态转换从 store.ts 迁到这里，store 只留
 * set(reducer(state, args)) 薄壳。依赖全部显式 .ts：node --experimental-strip-types
 * 可直接 import 本模块 → 预设语义可做确定性行为测试（save 的 id/now 由 shell 注入）。
 *
 * A1 模型：appliedPreset（基准名，无 'custom' 值）+ custom（触碰标记，事件驱动）+
 * PRESET_ZONES（5 zone，layout 无字段排除）。字段写入只标 custom，不动基准。
 */

/** 参与预设路由的 zone：layout 无字段（实证 zone:'layout'=0）排除 */
export const PRESET_ZONES = ['global', 'sidebar', 'chat', 'cc', 'right'] as const
export type PresetZone = (typeof PRESET_ZONES)[number]
import type { CcLayoutV3 } from '../cc/ccLayoutState.ts'
import { normalizeCcLayout } from '../cc/ccLayoutState.ts'
import { clampCcHeight, ccMinHeightInputOf, clampInputTypography } from '../cc/ccHeightState.ts'
import {
  pickCustomPresetTheme,
  upsertCustomPreset,
  deleteCustomPreset,
  type CustomPreset,
} from './customPresets.ts'
import { normalizeThemeState, THEME_DEFAULTS, THEME_PRESET_KEYS, ZONE_FIELDS } from './themeFieldDefs.ts'
import { markZoneCustom } from './themePresetState.ts'
import type { ThemeSettings } from './themeStore.ts'
import type { PresetBundleV2 } from './presetBundle.ts'

const DEFAULTS = THEME_DEFAULTS as Record<string, string | number | boolean>
const PRESET_KEY_SET = new Set<string>(THEME_PRESET_KEYS)

export function filterPresetTheme(value: Record<string, unknown> | Partial<ThemeSettings>): Partial<ThemeSettings> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => PRESET_KEY_SET.has(key))) as Partial<ThemeSettings>
}

/**
 * ★★ #266 刀4（结构 C）：**"预设没写空态 ⇒ 抄它自己的常态表"这条回落已删除**（`inheritCcEmptySlice` 退场）。
 *
 * 旧口径（刀2 立）：预设没写 `ccHiddenEmpty` ⇒ 落值时抄该预设的 `ccHidden`。
 * 新口径：**读侧做并集**（`门开 ? 主管 ∪ 再藏 : 主管`，见 `resolveCcHiddenWidgetIds`）⇒
 * 不需要"缺省回落"这种东西；预设没写"再藏" ⇒ 该键不进 patch ⇒ 由 `DEFAULTS.ccHiddenEmpty`
 * （出厂那 6 件）兜底当**再藏基准**。
 *
 * ★ **口径变化（点名）**：老的自定义预设（不带 `ccHiddenEmpty` 键）的空态，从"抄常态表"变成
 *   "主管 ∪ 基准 6 件"。项目当前无用户（规范 §7.9-②），接受此变化。
 */

/** W2-15（F3-B）：全量主题 → 相对 DEFAULTS 的 delta（过滤与默认相等键；自定义预设存储用） */
export function toThemeDelta(theme: Record<string, unknown> | Partial<ThemeSettings>): Partial<ThemeSettings> {
  const delta: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(theme)) {
    if (key in DEFAULTS && value === DEFAULTS[key]) continue
    delta[key] = value
  }
  return delta as Partial<ThemeSettings>
}

/**
 * 预设路由所需的状态切片。字段类型与 ThemeState 兼容（结构可赋值）：
 * ThemeState → ThemePresetState 无需断言；patch 用 ThemePresetPatch（兼容 Partial<ThemeState>）。
 * #448 PR5：customPresets 拆独立 store 后为**可选**切片——themeStore 调用点
 * （主题路由：setZoneField/setGlobalPreset/assemble/applyZonePreset）不提供；
 * customPresetStore 的合成视图（含本字段）照常满足 save/apply/delete 事务。
 */
export interface ThemePresetState {
  appliedPreset: Record<string, string>
  custom: Record<string, boolean>
  customPresets?: CustomPreset[]
  ccLayout: CcLayoutV3
  ccHeight: number
  inputSubmitButtonMode: string
  cliHintMode: string
  ccHidden: string[]
}

/** reducer 返回的 patch：主题字段 + 预设路由/cc 同步字段（可赋值给 Partial<ThemeState>） */
export type ThemePresetPatch = Partial<ThemeSettings> & Partial<Pick<ThemePresetState, 'appliedPreset' | 'custom' | 'customPresets' | 'ccLayout' | 'ccHeight'>>

/**
 * cc 高度 clamp（迁自 store.ts，行为不变）：布局约束真值来自 ccHeightState。
 *
 * ★ #266 刀3：下界由"常量 64"换成**按边算取最大**（`resolveCcMinHeight`）⇒ 入参要先补上
 *   `DEFAULTS` 的数字字段（预设切面是**稀疏**的，缺项会让算式按 0 算、下界偏小）。
 * ★ 在场集合口径 = **两态各算一遍取 max**（`ccMinHeightInputOf` 交出常态 / 空态两份名单，
 *   `resolveCcMinHeight` 逐态各算一遍取大 ⇒ 下界由**要求更高的那一份**决定，两态都可能
 *   成为绑定项；见 `ccHeightState.resolveCcMinHeight` 的口径说明）。
 */
export function clampPresetCcHeight(theme: Partial<ThemeSettings>): number {
  const merged = { ...DEFAULTS, ...theme } as Partial<ThemeSettings>
  const value = typeof merged.ccHeight === 'number' ? merged.ccHeight : Number(DEFAULTS.ccHeight)
  return clampCcHeight(value, ccMinHeightInputOf(merged))
}

export function syncPresetCcHeight(theme: Partial<ThemeSettings>): { ccHeight: number } {
  return { ccHeight: clampPresetCcHeight(theme) }
}

/**
 * 单字段写入（D1 校验漏斗）：写入字段 +（`markCustom` 为真时）该 zone 标记 custom（基准不动）。
 *
 * `markCustom`（刀7 §六 / #214）：这次写入**算不算「用户触碰」**由调用方声明。呈现方案
 * （界面模式 / 呈现风格的 token）写字段是**模式自身的基准**，不是用户手改；若照旧置 custom，
 * 全局派生命中「任一 zone custom ⇒ custom」，预设行就亮出兜底的「自定义」chip
 *（重置主题、切换界面模式都会踩到）。默认 `true` ⇒ 既有调用点行为零变化。
 * 漏斗内聚两条布局不变量（此前只在 setCcHeight/预设 action/migrate 各自维护）：
 * - 输入字号/行高/高度的排版约束
 * - ccHeight clamp（≥ resolveCcMinHeight 布局约束真值）
 *
 * ★ #266 刀9：原先还有一条 `inputVariant`↔`inputMode` 联动不变量 —— 两个字段删除后，
 *   连带 `resolveInputMode` / `applyInputVariantInvariant` 两个导出一起退场（无声明方、无读者）。
 */
export function setZoneFieldReducer(
  state: ThemePresetState,
  zone: string,
  partial: Record<string, unknown>,
  markCustom = true,
): ThemePresetPatch {
  const patch = { ...partial }

  if (zone === 'cc' && ('inputHeight' in patch || 'inputOffsetTop' in patch || 'inputFontSize' in patch || 'inputLineHeight' in patch)) {
    const merged = clampInputTypography({ ...state, ...patch } as ThemePresetState & { inputHeight: number; inputFontSize: number; inputLineHeight: string; inputOffsetTop: number })
    if ('inputFontSize' in patch) patch.inputFontSize = merged.inputFontSize
    if ('inputLineHeight' in patch) patch.inputLineHeight = merged.inputLineHeight
    if ('inputHeight' in patch || 'inputFontSize' in patch || 'inputLineHeight' in patch) patch.inputHeight = merged.inputHeight
    const ccHeight = Number(merged.ccHeight)
    const inputHeight = Number(merged.inputHeight)
    const inputOffsetTop = Number(merged.inputOffsetTop)
    if (Number.isFinite(ccHeight) && Number.isFinite(inputHeight) && Number.isFinite(inputOffsetTop)
      && inputHeight + inputOffsetTop > ccHeight) {
      if ('inputHeight' in patch) patch.inputHeight = Math.max(0, ccHeight - inputOffsetTop)
      else patch.inputOffsetTop = Math.max(0, ccHeight - inputHeight)
    }
  }

  // cc 高度不变量：高度或影响最小高的结构字段被写时整组收敛。
  // 属性面板/设置页恢复控件后，状态高度必须与 CSS 实际最小高一致。
  // ★ #266 刀3：最小高改成算式（按边算取最大）⇒ 这里的下界随之；数字字段仍先补 DEFAULTS
  //   （`state` 若是稀疏夹具，缺项会让算式按 0 算）。
  if (zone === 'cc' || 'ccHeight' in patch) {
    const merged = { ...DEFAULTS, ...state, ...patch } as Partial<ThemeSettings>
    patch.ccHeight = clampCcHeight(Number(merged.ccHeight), ccMinHeightInputOf(merged))
  }

  return {
    ...patch,
    ...(markCustom ? markZoneCustom(state, zone) : {}),
  }
}

/** 应用 zone 预设：写字段 + 记基准名 + 清该 zone custom（A2：不再手写 global 标记，全局由 deriveGlobalStatus 派生） */
export function applyZonePresetReducer(
  state: ThemePresetState,
  zone: string,
  presetName: string,
  presetTheme: Partial<ThemeSettings>,
): ThemePresetPatch {
  const theme = filterPresetTheme(presetTheme)
  return {
    ...theme,
    // cc zone 预设即恢复规范排布（预设不携带 ccLayout → 默认布局），与其他 zone 预设一致
    ...(zone === 'cc' ? { ccLayout: normalizeCcLayout(theme.ccLayout) } : {}),
    // ★ #266 刀3：最小高按**装配后的有效值**算（预设切面是稀疏的 —— 只按切面算，下界会漏掉
    //   用户当前那份输入栏高 / 件高，与渲染侧算出的 `--cc-min-height` 不一致）
    ...(zone === 'cc' && theme.ccHeight !== undefined ? syncPresetCcHeight({ ...state, ...theme } as Partial<ThemeSettings>) : {}),
    appliedPreset: { ...state.appliedPreset, [zone]: presetName },
    custom: { ...state.custom, [zone]: false },
  }
}

/** 切换全局预设：全 PRESET_ZONES 记名 + 全 custom 清零 + 恢复规范排布 */
export function setGlobalPresetReducer(name: string, theme: Partial<ThemeSettings>): ThemePresetPatch {
  const filteredTheme = filterPresetTheme(theme)
  const presetDefaults = filterPresetTheme(DEFAULTS)
  return {
    ...presetDefaults,
    ...filteredTheme,
    ccLayout: normalizeCcLayout(filteredTheme.ccLayout),
    // ★ #266 刀3：同上 —— 用装配后的有效值（= 这份 patch 本身）算下界
    ...(filteredTheme.ccHeight !== undefined ? syncPresetCcHeight({ ...presetDefaults, ...filteredTheme }) : {}),
    appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, name])),
    custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  }
}

// ── 刀1（#223 · 预设组装）：区域引用表 + 逐区域装配 ────────────────
//
// 方向倒置：旧路径「整套预设 → 按区域切一刀 → 5 块」，新路径「5 块区域预设 → 拼成一套预设」。
// 本段与 `setGlobalPresetReducer`（旧的一次性全量路径，保留为参考实现）**必须逐字段等价**——
// 等价性由 `src/__tests__/presetAssembly.test.ts` 对 10 套出厂预设 + 2 套默认预设逐套对拍。

/**
 * 区域引用表：5 个区域各指向一条**落点材料 id**（工厂 / 档案 / 默认 / 合并四族之一）。
 * 消息流区是**双引用**（`{ style, color }`）——它有两张单（样式单 + 配色单）；其余四区各一张。
 * `PRESET_ZONES` 是唯一真值——不许另立第二份区域清单。
 *
 * ★ #607 刀3a：消息流从「一条单」改成「两条单」后，指向它的引用形状随之从 `string`
 * 变成 `{ style, color }`；旧形状**不留兼容分支**（引用表是内部合同，不是持久化数据）。
 */
export type ZoneRefMap = Readonly<Record<Exclude<PresetZone, 'chat'>, string> & {
  chat: Readonly<Record<ChatPresetAxis, string>>
}>

/** 消息流两轴的唯一真值（`zones/zonePresetPool.ts` 只转发本类型，不另立第二份）。 */
export const CHAT_PRESET_AXES = ['style', 'color'] as const
export type ChatPresetAxis = (typeof CHAT_PRESET_AXES)[number]

/**
 * 引用表完整性校验：**缺项 / 空值 / 多余键一律抛错**（缺项不得静默回落）。
 * 覆盖 `PRESET_ZONES` 全部 5 项、消息流两轴齐才算过。
 */
export function requireZoneRefs(value: unknown, context: string): ZoneRefMap {
  if (value === undefined || value === null) throw new Error(`${context}：缺少区域引用表`)
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context}：区域引用表不是键值表`)
  const record = value as Record<string, unknown>
  const missing = PRESET_ZONES.filter(zone => {
    const item = record[zone]
    // 消息流区的合法形态是 `{ style, color }` 键值表；缺表 / 给了单字符串都算**缺项**。
    if (zone === 'chat') return !item || typeof item !== 'object' || Array.isArray(item)
    return typeof item !== 'string' || !(item as string).trim()
  })
  if (missing.length > 0) throw new Error(`${context}：区域引用表缺项（${missing.join(' / ')}）`)
  const unknown = Object.keys(record).filter(key => !(PRESET_ZONES as readonly string[]).includes(key))
  if (unknown.length > 0) throw new Error(`${context}：区域引用表含非区域键（${unknown.join(' / ')}）`)

  const chatRecord = record.chat as Record<string, unknown>
  const chatMissing = CHAT_PRESET_AXES.filter(axis => typeof chatRecord[axis] !== 'string' || !(chatRecord[axis] as string).trim())
  if (chatMissing.length > 0) throw new Error(`${context}：消息流双引用缺项（${chatMissing.join(' / ')}）`)
  const chatUnknown = Object.keys(chatRecord).filter(axis => !(CHAT_PRESET_AXES as readonly string[]).includes(axis))
  if (chatUnknown.length > 0) throw new Error(`${context}：消息流双引用含非轴键（${chatUnknown.join(' / ')}）`)

  return {
    global: String(record.global),
    sidebar: String(record.sidebar),
    chat: { style: String(chatRecord.style), color: String(chatRecord.color) },
    cc: String(record.cc),
    right: String(record.right),
  }
}

/** 该区域合法的字段键集（判据用 `ZONE_FIELDS` 单一真值，不另写一份区域归属判断）。 */
function zoneFieldKeys(zone: string): Set<string> {
  return new Set<string>(ZONE_FIELDS[zone] ?? [])
}

/**
 * 越区键校验：切片里任何**不属于该区域**的键 → 抛错（**不静默丢弃**）。
 *
 * 静默丢弃的症状是「我这个区域该改的没改」，而用户完全看不出原因（规范 §4.1 硬约束 4）；
 * 出厂的派生条目按构造不可能越区，这道闸门真正拦的是**手写/持久化的区域预设数据**。
 */
export function assertZoneSliceOwnership(zone: string, slice: Partial<ThemeSettings>, context: string): void {
  const allowed = zoneFieldKeys(zone)
  const foreign = Object.keys(slice).filter(key => !allowed.has(key))
  if (foreign.length > 0) {
    throw new Error(`${context}：区域 ${zone} 的取值含越区/未知字段（${foreign.join(' / ')}）`)
  }
}

/** 一条区域引用展开后的装配输入：哪个区域、记什么名字、取哪些值。 */
export interface GlobalPresetZoneSlice {
  zone: PresetZone
  /** 该区域引用的**落点材料 id**（#607 刀3a 起；此前是来源预设名）。 */
  presetName: string
  /** 该区域引用的取值切片。 */
  theme: Partial<ThemeSettings>
}

export interface AssembleGlobalPresetOptions {
  /**
   * 统一改写写进 `appliedPreset` 的名字（重置主题路径传 `''`）。省略 = 逐区域记各区域的引用 id。
   *
   * ★「用来取值的引用」与「写进 `appliedPreset` 的名字」是两件事：重置主题取的是**默认预设的值**，
   * 但名字必须是空串——默认预设不进列表，按它的名字记名会让预设行认不出它而亮出兜底 chip「未知预设」。
   */
  appliedName?: string
}

/**
 * 刀1（#223）：逐区域装配一套全局预设，返回可 `set(...)` 的 patch。
 *
 * 与旧的一次性全量路径（`setGlobalPresetReducer`）等价，差别只在「值从哪来」：
 * 旧 = 整份 `preset.theme`；新 = 5 个区域各按引用取自己那一片。三条必须守住的语义：
 *
 * 1. ★ **先铺 `filterPresetTheme(DEFAULTS)`**（全量换装）：逐区域装配只写「区域预设有的字段」，
 *    不铺底的话，预设没覆盖的字段会**残留用户当前值**，而不是回到默认值；
 * 2. ★ **复用 `applyZonePresetReducer`**：cc 区的 `ccLayout` 归一与 `ccHeight` 收敛都在它里面，新写一份合并逻辑必漏；
 * 3. ★ **按 `PRESET_ZONES` 顺序逐区域累积**：把上一步结果并进下一步的输入再算——5 个区域各算一份 patch
 *    最后一起合并，`appliedPreset` 会互相覆盖（后写的 patch 带着它自己那份完整 `appliedPreset`）。
 *
 * 缺区域 / 重复区域 / 越区键一律抛错，不静默回落、不静默丢弃。
 */
export function assembleGlobalPresetReducer(
  state: ThemePresetState,
  slices: readonly GlobalPresetZoneSlice[],
  options: AssembleGlobalPresetOptions = {},
): ThemePresetPatch {
  const byZone = new Map<string, GlobalPresetZoneSlice>()
  for (const slice of slices) {
    if (byZone.has(slice.zone)) throw new Error(`逐区域装配出现重复区域：${slice.zone}`)
    byZone.set(slice.zone, slice)
  }
  const missing = PRESET_ZONES.filter(zone => !byZone.has(zone))
  if (missing.length > 0) throw new Error(`逐区域装配缺区域（${missing.join(' / ')}）`)
  if (byZone.size !== PRESET_ZONES.length) {
    throw new Error(`逐区域装配含非区域项（${[...byZone.keys()].filter(key => !(PRESET_ZONES as readonly string[]).includes(key)).join(' / ')}）`)
  }

  // 1. 铺底：预设没覆盖的字段回到默认值（不是「保留用户当前值」）
  let patch: ThemePresetPatch = { ...filterPresetTheme(DEFAULTS) }

  for (const zone of PRESET_ZONES) {
    const slice = byZone.get(zone)!
    assertZoneSliceOwnership(zone, slice.theme, `区域 ${zone}（引用 ${slice.presetName}）`)
    // 2 + 3：逐步把上一步结果并进输入，复用既有 reducer（cc 特殊处理在其内）
    patch = { ...patch, ...applyZonePresetReducer({ ...state, ...patch } as ThemePresetState, zone, slice.presetName, slice.theme) }
  }

  // 记名与取值解耦；键集恒等于 PRESET_ZONES，不夹带 state 的额外键（与旧路径逐字节同形）
  const appliedName = options.appliedName
  patch.appliedPreset = Object.fromEntries(PRESET_ZONES.map(zone => [zone, appliedName ?? byZone.get(zone)!.presetName]))
  patch.custom = Object.fromEntries(PRESET_ZONES.map(zone => [zone, false]))

  // ★ #607 刀3a：原先这里还有一个「呈现方案 token 覆盖层」收口（`profileTokens`）——
  //   档案货物已并进 `preset:*` 合并材料，取值不再有第二段叠加 ⇒ 该选项连同收口一并退场。
  return patch
}

export interface SavePresetCommand {
  /** 已存在的预设 id（更新场景由调用方传入） */
  id: string
  name: string
  /** 由 store shell 注入，reducer 保持确定性 */
  now: number
  /** Optional v2 owner contributions captured by the shell. */
  bundle?: PresetBundleV2
}

/** 保存自定义预设：命名强制；捕获当前全主题；upsert；返回 savedId */
export function saveCustomPresetReducer(
  state: ThemePresetState,
  command: SavePresetCommand,
): { patch: ThemePresetPatch; savedId: string } {
  const { id, now } = command
  const cleanName = command.name.trim()
  if (!cleanName) throw new Error('预设名称不能为空')
  const existing = (state.customPresets ?? []).find(preset => preset.id === id)
  const preset = existing
    ? { ...existing, name: cleanName.slice(0, 40), theme: toThemeDelta(pickCustomPresetTheme(state)), updatedAt: now, ...(command.bundle ? { bundle: command.bundle } : {}) }
    : { id, name: cleanName.slice(0, 40), theme: structuredClone(toThemeDelta(pickCustomPresetTheme(state))), createdAt: now, updatedAt: now, ...(command.bundle ? { bundle: command.bundle } : {}) }
  return { patch: { customPresets: upsertCustomPreset(state.customPresets ?? [], preset) }, savedId: preset.id }
}

/**
 * 应用自定义预设：防御性归一化 + 全 PRESET_ZONES 记 id + 全 custom 清零。
 * theme 显式传入时直接消费（bundle 驱动，免疫 id 漂移）；否则按 id 回查
 * customPresets（旧路径）。两者都落空返回 null（调用方必须可见地报告，
 * 不得静默吞掉）。
 */
export function applyCustomPresetReducer(
  state: ThemePresetState,
  id: string,
  explicitTheme?: Record<string, unknown>,
): ThemePresetPatch | null {
  const source = explicitTheme
    ?? (state.customPresets ?? []).find(item => item.id === id)?.theme
  if (!source) return null
  const theme = filterPresetTheme(normalizeThemeState(pickCustomPresetTheme(source) as Record<string, unknown>) as Record<string, unknown>)
  return {
    ...filterPresetTheme(DEFAULTS),
    ...theme,
    ccLayout: normalizeCcLayout(theme.ccLayout),
    // ★ #266 刀3：同上 —— 用装配后的有效值（= 这份 patch 本身）算下界
    ...(theme.ccHeight !== undefined ? syncPresetCcHeight({ ...filterPresetTheme(DEFAULTS), ...theme }) : {}),
    appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, id])),
    custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  }
}

/**
 * 全局预设状态派生（A2，覆盖规则 1/2 的单一真值）：
 * - 全空且无触碰 → ''
 * - 任一 zone 触碰（custom=true）→ 'custom'（规则 1：改字段 → 全局变 custom）
 * - 所有非空基准一致且无空 zone → 跟随该基准（空 zone 视为偏离 → custom，规则 2）
 */
export function deriveGlobalStatus(state: Pick<ThemePresetState, 'appliedPreset' | 'custom'>): string {
  const zones = PRESET_ZONES
  if (zones.every(zone => state.appliedPreset[zone] === '' && state.custom[zone] === false)) return ''
  if (zones.some(zone => state.custom[zone])) return 'custom'
  const first = state.appliedPreset[zones[0]]
  if (first !== '' && zones.every(zone => state.appliedPreset[zone] === first)) return first
  return 'custom'
}

/** 单 zone 状态派生：基准名 + 是否自定义 */
export function deriveZoneStatus(
  state: Pick<ThemePresetState, 'appliedPreset' | 'custom'>,
  zone: PresetZone,
): { appliedName: string; isCustom: boolean } {
  return { appliedName: state.appliedPreset[zone] ?? '', isCustom: state.custom[zone] === true }
}

/**
 * 删除自定义预设：引用该 id 的 zone 失去基准（appliedPreset=''）且 custom=true——
 * 字段保留已删预设的值 = 失去基准的自定义快照（不是默认态）。
 */
export function removeCustomPresetReducer(state: ThemePresetState, id: string): ThemePresetPatch {
  const appliedPreset = { ...state.appliedPreset }
  const custom = { ...state.custom }
  for (const [zone, value] of Object.entries(appliedPreset)) {
    if (value === id) {
      appliedPreset[zone] = ''
      custom[zone] = true
    }
  }
  return { customPresets: deleteCustomPreset(state.customPresets ?? [], id), appliedPreset, custom }
}
