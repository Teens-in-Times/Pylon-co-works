/**
 * ccPluginProps — 插件元件**属性值**的家（#266 CC-13 刀4 · 工具开闸）。
 *
 * 形状：`Record<widgetId, Record<fieldKey, string | number>>`；缺省 `{}`。
 *
 * - **住主题 `cc` 区**（`themeFieldDefs.ts` 的 `ccPluginProps`，内部字段）：不在 Settings 渲染、
 *   **随预设走**（预设携带 / 全局预设换装时随 cc 切片一起换）、写盘白名单照收 —— 与内置件的参数
 *   **同一条规矩**；插件**撤下那一刻**由宿主一并清（`clear-cc-widget-data`，与位置同一时刻）。
 * - `fieldKey` 是**插件自定义短键**（不是主题字段键 —— 后者由内置件的属性面板写）；
 *   字段能力（四种 kind + 声明校验）见 `ccWidgetRoster.ts` 的 `CcWidgetPropertyFieldDecl`。
 * - **保留未知 widgetId / fieldKey**（读盘不丢、撤下才清）：与位置表（`ccLayoutState.ts`）
 *   同一口径 —— 读盘发生在插件登记**之前**，读盘顺手丢会在每次重启时误删用户的插件参数。
 *
 * ★ 依赖方向：本文件住 `domains/cc`，**不 import** 渲染器 / 注册表 / store（纯数据 + 纯函数）。
 */

/** 一个属性值：插件字段只写这两种（`number` 进数据前已过面板 clamp；字符串原样）。 */
export type CcPluginPropValue = string | number

/** 一个插件元件的属性表（fieldKey → 值）。 */
export type CcPluginPropsWidgetRecord = Record<string, CcPluginPropValue>

/** 全部插件元件的属性表（widgetId → 属性表）。 */
export type CcPluginProps = Record<string, CcPluginPropsWidgetRecord>

/** 深拷贝一份（快照发布用；条目数 = 有属性的插件件数，量级极小）。 */
export function cloneCcPluginProps(props: CcPluginProps): CcPluginProps {
  return Object.fromEntries(
    Object.entries(props).map(([id, record]) => [id, { ...record }]),
  )
}

/** 值是否被本表接受：`string` 原样；`number` 必须有限（NaN/Infinity 不进数据）。 */
function isAcceptedValue(value: unknown): value is CcPluginPropValue {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * 归一化（**逐层兜底 + 保留未知键**）：
 * - 非对象整体（null / 数组 / 标量）⇒ `{}`；
 * - 每个 widgetId 下非对象的值（含数组）⇒ 丢弃该条；
 * - 值只留 `string | number`（有限）——其余类型（布尔 / null / 嵌套对象）逐键丢弃；
 * - 过滤后**空**的 widgetId 记录不保留（空表与缺项等价，数据里不养空壳）。
 *
 * 幂等（跑两次结果相同）；不修改入参。读盘路径每次读盘跑一次（`migration.ts` 的结构对齐）。
 */
export function normalizeCcPluginProps(raw: unknown): CcPluginProps {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const normalized: CcPluginProps = {}
  for (const [widgetId, record] of Object.entries(raw as Record<string, unknown>)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    const values: CcPluginPropsWidgetRecord = {}
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      if (isAcceptedValue(value)) values[key] = value
    }
    if (Object.keys(values).length > 0) normalized[widgetId] = values
  }
  return normalized
}

/**
 * 写一条属性值（属性面板的唯一落点）。
 *
 * ★ 幂等：值相同时**原样返回同一个对象**（不产生无谓的发布 / 重渲）；
 * ★ 非有限数字一律 no-op（与 `set-cc-property` 的数字分支同口径）；
 * ★ 缺记录 ⇒ 现建（插件件第一次改参数就是这条路）。
 */
export function setCcPluginPropState(
  props: CcPluginProps,
  id: string,
  key: string,
  value: CcPluginPropValue,
): CcPluginProps {
  if (!isAcceptedValue(value)) return props
  const current = props[id]
  if (current?.[key] === value) return props
  return { ...props, [id]: { ...(current ?? {}), [key]: value } }
}

/**
 * 删掉**一个元件**的全部属性值（插件撤下那一刻由宿主派发；`clear-cc-widget-data` 三样之一）。
 *
 * ★ 幂等：本来就没有该元件的记录 ⇒ **原样返回同一个对象**（不产生无谓的发布）。
 */
export function clearCcPluginPropsState(props: CcPluginProps, id: string): CcPluginProps {
  if (!(id in props)) return props
  const next = { ...props }
  delete next[id]
  return next
}
