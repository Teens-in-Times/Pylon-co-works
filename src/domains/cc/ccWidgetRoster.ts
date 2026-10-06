/**
 * ccWidgetRoster — 中控元件的**活名单**合成（#266 CC-13 刀2 · 画面开闸）+
 * **工位派生**（刀3 · 工位开闸：可拖件 id 序 / 插件件默认落点 / 位置兜底解析）。
 *
 * 一份真值、两处来源，本文件是**唯一的合并点**：
 * - **内置**：定义表 8 行（`CC_WIDGET_GROUPS`）。渲染体按约定推导为
 *   `{ kind: 'host-renderer', rendererKey: id }` —— 内置件的组件住在渲染层组件表
 *   （`renderers/solid-workbench/input/createCcWidgetRenderers.solid.tsx`），本文件不 import 它。
 * - **插件**：注册表快照条目（`CcWidgetContribution`），`render` 原样透传。
 *
 * ★ 依赖方向（规范 §4.2）：本文件住 `domains/cc`，**只 type-import** 插件契约的形状
 *   （`plugin-runtime/cc-widget`）——不 import 注册表实现、不 import 任何组件。
 *   注册表快照由调用方（渲染层）递进来，本函数是**纯函数**（同输入同输出，可被测试直接钉死）。
 *
 * ★ 顺序：**表序在前、插件在后**（插件按传入顺序追加）。传入序 = 注册表快照序
 *   （注册表自身按 层/优先级/插件 id/贡献 id 确定性排序 ⇒ 同一插件的件天然连成一块）。
 *
 * ★ 拒绝（不静默丢，规范 §4.3）：id 与内置件冲突 / 缺 `render` ⇒ 进 `rejected`，
 *   由调用方走诊断口。插件件之间不会重 id：注册表以 `contributionId` = 元件 id 保证唯一，
 *   重复登记在注册表侧当场抛错。
 *
 * ★★ #266 CC-13 刀4：本文件另立**插件能写的属性字段契约**（`CcWidgetPropertyFieldDecl` =
 *   契约里 `propertyFields` 那块不透明声明的**定形处**，见 `plugin-runtime/cc-widget/ccWidgetTypes.ts`
 *   的指针注释）：合成时逐条校验，非法声明 ⇒ 丢弃该字段 + 记进 `propertyFieldRejections`
 *   （诊断由调用方走诊断口，**不静默**）。
 */
import { CC_WIDGET_GROUPS, ccWidgetLanding, resolveCcWidgetGroup } from './widgetDefinitions.ts'
import { DEFAULT_CC_LAYOUT } from './ccLayoutState.ts'
import type { CcLayoutV3, CcWidgetPlacement } from './ccLayoutState.ts'
import type { CcWidgetContribution, CcWidgetRenderSpec } from '../../plugin-runtime/cc-widget/ccWidgetTypes.ts'

/**
 * 注册表快照条目的**结构子集**（只取合成用得到的两个字段）。
 * 刻意不 import `plugin-runtime/registry` 的类型：本模块只认「值 + 归属插件」这两件事，
 * 结构上兼容 `RegistryEntry<CcWidgetContribution>`。
 */
export interface CcWidgetRosterSourceEntry {
  readonly value: CcWidgetContribution
  readonly ownerPluginId: string
}

/** 一件（内置或插件）在活名单里的行。 */
export interface CcWidgetRosterEntry {
  readonly id: string
  readonly label: string
  readonly category?: string
  readonly source: 'builtin' | 'plugin'
  /** 画法判别式：`host-renderer` 查渲染层组件表；`isolated-surface` 挂隔离面 */
  readonly render: CcWidgetRenderSpec
  /** 插件件：登记它的插件 id（诊断归因用；内置件恒缺省） */
  readonly ownerPluginId?: string
  /**
   * ★★ CC-13 刀4：**插件自报的属性字段**（已过校验；`key` 为插件自定义短键）。
   * 空 / 未声明 ⇒ **键不出现**（条目形状与"没声明"同形，不给每条登记白添一个空数组）。
   * 内置件的属性表单不在这里 —— 它来自定义表行（`WIDGET_PROPERTY_FIELDS`）。
   */
  readonly propertyFields?: readonly CcWidgetPropertyFieldDecl[]
}

/**
 * ★★ CC-13 刀4：**插件能写的四种字段**（与内置件属性表单同构；二者共用面板的渲染分支）。
 *
 * - `key` = 插件自定义**短键**（不是主题字段键）⇒ 值只进 `ccPluginProps`（`domains/cc/ccPluginProps.ts`）；
 * - `section` 无 `key`（纯分组标题）；其余三种必带 `key` 与 `label`。
 * - 声明非法（kind 不在四种内 / 缺 label / 非 section 缺 key / number 缺合法 min·max / chips 缺合法 options）
 *   ⇒ **该字段丢弃** + 进 `propertyFieldRejections`（不静默）。可选装饰（`step` / `suffix`）类型不合法
 *   时只丢装饰、字段保留：它们不参与取值语义（`step` 只影响步进、`suffix` 只影响显示）。
 */
export type CcWidgetPropertyFieldDecl =
  | { readonly kind: 'section'; readonly title: string }
  | { readonly kind: 'number'; readonly key: string; readonly label: string; readonly min: number; readonly max: number; readonly step?: number; readonly suffix?: string }
  | { readonly kind: 'color'; readonly key: string; readonly label: string }
  | { readonly kind: 'chips'; readonly key: string; readonly label: string; readonly options: readonly { readonly value: string; readonly label: string }[] }

/**
 * **有值**的字段声明（`section` 只是分组标题，不承载值）—— 属性面板的读写口只认这三种。
 */
export type CcValuedPropertyFieldDecl = Exclude<CcWidgetPropertyFieldDecl, { readonly kind: 'section' }>

export type CcWidgetPropertyFieldRejectionReason =
  | 'unknown-kind'
  | 'missing-label'
  | 'missing-key'
  | 'invalid-number-range'
  | 'invalid-options'

export interface CcWidgetPropertyFieldRejection {
  readonly widgetId: string
  readonly ownerPluginId: string
  /** 声明在 `propertyFields` 里的下标（定位是哪一条） */
  readonly index: number
  readonly reason: CcWidgetPropertyFieldRejectionReason
}

export type CcWidgetRosterRejectionReason = 'id-collision' | 'missing-render'

export interface CcWidgetRosterRejection {
  readonly id: string
  readonly ownerPluginId: string
  readonly reason: CcWidgetRosterRejectionReason
}

export interface CcWidgetRoster {
  readonly entries: readonly CcWidgetRosterEntry[]
  readonly rejected: readonly CcWidgetRosterRejection[]
  /** ★ CC-13 刀4：被丢弃的插件属性字段声明（每条都已连带丢了它自己那个字段，不是整件被拒） */
  readonly propertyFieldRejections: readonly CcWidgetPropertyFieldRejection[]
}

/** 非空字符串判据（短键 / 标签 / 标题共用）。 */
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** 有限数字（min / max / step 共用）。 */
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * 单条字段声明的校验：合法 ⇒ 定形后的声明；非法 ⇒ 拒绝原因（调用方丢弃该字段并记诊断）。
 * ★ 纯函数：不读全局、不抛错（坏声明是**数据**，不是程序错误）。
 */
function validatePluginPropertyField(raw: unknown): CcWidgetPropertyFieldDecl | CcWidgetPropertyFieldRejectionReason {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown-kind'
  const decl = raw as Record<string, unknown>
  switch (decl.kind) {
    case 'section':
      return isNonEmptyString(decl.title) ? { kind: 'section', title: decl.title } : 'missing-label'
    case 'number': {
      if (!isNonEmptyString(decl.label)) return 'missing-label'
      if (!isNonEmptyString(decl.key)) return 'missing-key'
      if (!isFiniteNumber(decl.min) || !isFiniteNumber(decl.max) || decl.min > decl.max) return 'invalid-number-range'
      return {
        kind: 'number', key: decl.key, label: decl.label, min: decl.min, max: decl.max,
        ...(isFiniteNumber(decl.step) ? { step: decl.step } : {}),
        ...(typeof decl.suffix === 'string' ? { suffix: decl.suffix } : {}),
      }
    }
    case 'color':
      if (!isNonEmptyString(decl.label)) return 'missing-label'
      if (!isNonEmptyString(decl.key)) return 'missing-key'
      return { kind: 'color', key: decl.key, label: decl.label }
    case 'chips': {
      if (!isNonEmptyString(decl.label)) return 'missing-label'
      if (!isNonEmptyString(decl.key)) return 'missing-key'
      if (!Array.isArray(decl.options) || decl.options.length === 0) return 'invalid-options'
      const options: { value: string; label: string }[] = []
      for (const option of decl.options) {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return 'invalid-options'
        const candidate = option as Record<string, unknown>
        if (!isNonEmptyString(candidate.value) || !isNonEmptyString(candidate.label)) return 'invalid-options'
        // 同一字段内 value 重复 ⇒ 选中态无法判定（面板按 value 比对）⇒ 视为非法声明
        if (options.some(existing => existing.value === candidate.value)) return 'invalid-options'
        options.push({ value: candidate.value, label: candidate.label })
      }
      return { kind: 'chips', key: decl.key, label: decl.label, options }
    }
    default:
      return 'unknown-kind'
  }
}

/**
 * 一个元件的字段声明校验（登记 → 面板的**唯一**入口）。
 * 返回定形后的字段表 + 被丢弃的下标与原因（顺序保留：合法字段按声明序进面板）。
 */
export function resolvePluginPropertyFields(
  widgetId: string,
  ownerPluginId: string,
  raw: readonly unknown[] | undefined,
): { readonly fields: readonly CcWidgetPropertyFieldDecl[]; readonly rejected: readonly CcWidgetPropertyFieldRejection[] } {
  const fields: CcWidgetPropertyFieldDecl[] = []
  const rejected: CcWidgetPropertyFieldRejection[] = []
  raw?.forEach((candidate, index) => {
    const validated = validatePluginPropertyField(candidate)
    if (typeof validated === 'string') rejected.push({ widgetId, ownerPluginId, index, reason: validated })
    else fields.push(validated)
  })
  return { fields, rejected }
}

/**
 * 字段的**声明缺省值**（面板读不到用户值时用它，与内置件的取值口径同款）：
 * `number` ⇒ `min`；`chips` ⇒ 第一项；`color` ⇒ `''`（空串 = 未设色，与内置颜色字段同款）。
 */
export function resolveCcPropertyFieldDefault(field: CcWidgetPropertyFieldDecl): string | number {
  if (field.kind === 'number') return field.min
  if (field.kind === 'chips') return field.options[0]?.value ?? ''
  return ''
}

/** 内置件的渲染约定：组件表键 = 定义表行的 id（见 `createCcWidgetRenderers.solid.tsx`）。 */
function builtinRenderSpec(id: string): CcWidgetRenderSpec {
  return { kind: 'host-renderer', rendererKey: id }
}

export function resolveCcWidgetRoster(registered: readonly CcWidgetRosterSourceEntry[]): CcWidgetRoster {
  const entries: CcWidgetRosterEntry[] = CC_WIDGET_GROUPS.map(row => ({
    id: row.id,
    label: row.label,
    category: row.category,
    source: 'builtin' as const,
    render: builtinRenderSpec(row.id),
  }))
  const builtinIds = new Set(entries.map(entry => entry.id))
  const rejected: CcWidgetRosterRejection[] = []
  const propertyFieldRejections: CcWidgetPropertyFieldRejection[] = []
  for (const source of registered) {
    const contribution = source.value
    if (builtinIds.has(contribution.id)) {
      rejected.push({ id: contribution.id, ownerPluginId: source.ownerPluginId, reason: 'id-collision' })
      continue
    }
    if (!contribution.render) {
      rejected.push({ id: contribution.id, ownerPluginId: source.ownerPluginId, reason: 'missing-render' })
      continue
    }
    // ★ CC-13 刀4：属性字段声明逐条校验（非法 ⇒ 丢该字段 + 记诊断；合法的定形进条目）
    const propertyFields = resolvePluginPropertyFields(contribution.id, source.ownerPluginId, contribution.propertyFields)
    propertyFieldRejections.push(...propertyFields.rejected)
    entries.push({
      id: contribution.id,
      label: contribution.label,
      ...(contribution.category === undefined ? {} : { category: contribution.category }),
      source: 'plugin',
      render: contribution.render,
      ownerPluginId: source.ownerPluginId,
      ...(propertyFields.fields.length === 0 ? {} : { propertyFields: propertyFields.fields }),
    })
  }
  return { entries, rejected, propertyFieldRejections }
}

// ── ★★ #266 CC-13 刀3：工位（位置 / 拖动 / 编辑列）─────────────────────────────

/**
 * 可拖件 id 序 —— **编辑列 / 拖动名单 / 碰撞障碍集的唯一来源**。
 *
 * 内置按**表序**在前（以定义表行的 `draggable` 声明为准 ⇒ 容器 `cc-surface` 不进），
 * 插件按**登记序**在后（同一插件的件天然连着成一块）。
 * ★ 它取代了渲染层那个编译期常量 `CC_EDIT_TOOLBAR_IDS`（后者已退场）：插件件不在编译期
 * 名单里，任何"再平行维护一份名单"的写法都会把它们漏掉。
 */
export function resolveCcDraggableWidgetIds(roster: CcWidgetRoster): string[] {
  return roster.entries
    .filter(entry => entry.source === 'plugin' || resolveCcWidgetGroup(entry.id)?.draggable === true)
    .map(entry => entry.id)
}

/** 插件件的落脚处 = **状态区**（与 model / reasoning / mode / tokens / cc-command-hint 同一落脚处）。 */
const STATUS_LANDING = ccWidgetLanding('model')

/**
 * 该落脚处**内置件**的最大 `order` —— 插件件默认排它之后（`+ 1 + 登记序`）。
 * 从 `DEFAULT_CC_LAYOUT` 派生（内置默认位置的唯一真值），不另写一份序号。
 */
const STATUS_LANDING_MAX_ORDER = Math.max(
  0,
  ...Object.entries(DEFAULT_CC_LAYOUT.placements)
    .filter(([id]) => ccWidgetLanding(id) === STATUS_LANDING)
    .map(([, placement]) => placement.order),
)

/**
 * 插件件的**计算默认位置**：状态区末尾，按登记序连号
 * ⇒ 同一插件的件连着成一块、新加入的在更下（用户口径 2026-10-05）。
 *
 * ★ 它**不写进数据**（`DEFAULT_CC_LAYOUT` 只含内置件）：用户真的改动过之后才落盘，此后以数据为准。
 */
export function resolvePluginWidgetPlacement(registrationIndex: number): CcWidgetPlacement {
  return { order: STATUS_LANDING_MAX_ORDER + 1 + registrationIndex, offsetX: 0, offsetY: 0 }
}

/**
 * 位置兜底解析（#266 CC-13 刀3 的**唯一**读取入口）：`placements[id] ?? 计算默认`。
 *
 * - 内置件缺项 ⇒ `DEFAULT_CC_LAYOUT`（定义表派生，与归一化补缺同源）；
 * - 插件件缺项 ⇒ `resolvePluginWidgetPlacement`（`pluginIds` 的下标 = 登记序）。
 *
 * ⇒ 插件件在**未落盘前**也不会读到 `undefined.order`（排序会 NaN、编辑列输入框会抛错）。
 * ★ 纯函数：只读入参，不碰 store / 全局。
 */
export function resolveCcWidgetPlacements(
  layout: CcLayoutV3,
  pluginIds: readonly string[],
): Record<string, CcWidgetPlacement> {
  const resolved: Record<string, CcWidgetPlacement> = { ...layout.placements }
  for (const [id, placement] of Object.entries(DEFAULT_CC_LAYOUT.placements)) {
    if (!resolved[id]) resolved[id] = { ...placement }
  }
  pluginIds.forEach((id, index) => {
    if (!resolved[id]) resolved[id] = resolvePluginWidgetPlacement(index)
  })
  return resolved
}
