import { CC_WIDGET_GROUPS } from './widgetDefinitions.ts'

export type { CcRegisteredSlotId, CcWidgetId } from './widgetDefinitions.ts'
export { CC_REGISTERED_SLOT_IDS } from './widgetDefinitions.ts'

/**
 * ★ #238 刀3：**槽位层整体拆除**。原来的 `CcSlot`（输入区/状态左/状态右/操作区）、
 * `SLOT_SET` 白名单、以及 `placement.slot` 字段都不存在了 ——
 * 位置改由定义表每行的 `layout`（x 轴贴谁 + y 轴贴谁 + 组内序号）声明，
 * 渲染按「落脚处 = (y.anchor, y.side)」自动成组（`ccWidgetLanding`）。
 * 详见 `domains/cc/widgetDefinitions.ts`。
 */

/**
 * 位置表的键 = 元件 id。
 *
 * ★★ #266 CC-13 刀3：**键空间放开** —— 从「内置轨 ∪ 注册轨」的编译期字面量 union
 * 降级为 `string`。为什么必须放开：插件元件的 id 在编译期不存在，原来的 union 会把
 * 插件件的位置**挡在数据之外**（读盘丢、写不进）。键的合法性改由运行时承担：
 * 写侧逐键 clamp（`normalizeCcLayout` / `updateCcPlacementState`）、读侧兜底
 * （`ccWidgetRoster.resolveCcWidgetPlacements`）。
 * ★ 保留这个名字（而不是全局改写成 `string`）是为了让「这是位置表的键」留在类型名里。
 */
export type CcLayoutWidgetId = string

/**
 * 一个元件在**用户数据**里的位置：只存可变部分（组内序号 + 两个方向的微调）。
 *
 * ★ #238 刀3：槽位层已拆，`slot` **不再是位置真值**（位置由定义表 `layout` 声明）。
 * ★ CC-05（#266）：历史键 `slot` 已从本类型**退场**——运行时本就一律不读它，
 * 出厂数据里残留的旧记录也已一并清掉。老用户 localStorage 里带着的 `slot`
 * 无需迁移：`normalizeCcLayout` 只取 `order` / `offsetX` / `offsetY`，
 * 其余键（含 `slot`）读盘时自然丢弃，因此无影响。
 */
export interface CcWidgetPlacement {
  order: number
  offsetX: number
  offsetY: number
}

export interface CcLayoutV3 {
  version: number
  /**
   * ★ CC-13 刀3：键 = 元件 id（`string`：内置 **与插件** 同一空间），值 = 用户手调的可变量。
   * 插件件的**默认值不写进这里** —— 默认由读取侧兜底算（`resolveCcWidgetPlacements`），
   * 数据里只留"用户真的动过"的那些键。
   */
  placements: Record<string, CcWidgetPlacement>
}

// v7：新增会话、工作区与运行状态控件；旧布局按 ID 保留并补入新增默认位置。
// v8：删除 pct 控件（并入「用量」tokens 控件）；用量控件默认移到状态区次行、紧跟权限控件。
// v9：中控名单换代（旧 11 → 新 7）——删 session/workspace/activity/ekg/tasks 五个 id；
// legacy `send` 的槽位事实迁到注册轨 id `cc-send-button`（老数据里的 `send` 键在
// 归一化时按别名读取，保留用户既有拖拽位置）。
// ★ #238 刀3：**槽位层退场** —— `slot` 字段不再存在；读盘时老数据里的 `slot` 一律不读、
// 其余（order/offsetX/offsetY）原样保留（不写迁移，用户口径）。序号从「槽内序号」变成
// 「同落脚处组内序号」——老数据的相对顺序不变 ⇒ 效果等价。
//
// ★★ 版本号职责（#238 刀2 起收窄 —— **后来者请勿再往这里塞东西**）：
// `CC_LAYOUT_SCHEMA_VERSION` **只表示「数据格式版本」**。★ **反例：加控件、改位置声明、
// 改 id 都不需要 bump** —— 结构对齐（补缺项/按 id 合并）由读盘路径每次无条件跑，
// 与版本号无关（`alignThemeStructure`，见 `domains/theme/migration.ts`）。
// 刀3 拆掉 slot 字段**也没有 bump**：消失的字段由「每次读盘归一化」自然消化。
export const CC_LAYOUT_SCHEMA_VERSION = 9

/**
 * 默认布局 —— 由定义表各行的 `layout.order` 派生（只取**可拖**的行：容器不占位）。
 * 元件**贴哪一行/哪一侧**不在用户数据里（它由定义表声明），这里只存可变部分：
 * 组内序号 + 两个方向的微调（默认 0）。
 *
 * ★ CC-13 刀3：本常量**只含内置件**（它是"内置默认"的唯一来源）。插件件的默认位置
 * 由读取侧算（`ccWidgetRoster.resolvePluginWidgetPlacement`：状态区末尾、按登记序连号），
 * **不写进这里** —— 否则每登记一个插件就往"默认布局"里塞一条，内置真值会被污染。
 */
const DEFAULT_PLACEMENTS: Record<string, CcWidgetPlacement> = {}
for (const row of CC_WIDGET_GROUPS) {
  if (row.draggable && row.layout) {
    DEFAULT_PLACEMENTS[row.id] = { order: row.layout.order, offsetX: 0, offsetY: 0 }
  }
}

export const DEFAULT_CC_LAYOUT: CcLayoutV3 = {
  version: CC_LAYOUT_SCHEMA_VERSION,
  placements: DEFAULT_PLACEMENTS,
}

// 非有限值落 0（persist 域语言：坏数值不抛，回中位安全值）——与 legacyKeyMigration 的 clampRound（先 round）语义不同，勿混用。
const clampFinite = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0))

/** 逐键 clamp（`order` 0–99 / `offsetX` ±48 / `offsetY` ±16）——内置件与插件件同一套规则。 */
function clampCcPlacement(candidate: Partial<CcWidgetPlacement>): CcWidgetPlacement {
  return {
    order: Math.round(clampFinite(candidate.order as number, 0, 99)),
    offsetX: clampFinite(candidate.offsetX as number, -48, 48),
    offsetY: clampFinite(candidate.offsetY as number, -16, 16),
  }
}

/** legacy 键名别名（v9）：`send` → 注册轨 id `cc-send-button`（键名换、位置不动）。 */
const LEGACY_CC_LAYOUT_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({ send: 'cc-send-button' })

export function cloneCcLayout(layout: CcLayoutV3): CcLayoutV3 {
  return {
    version: CC_LAYOUT_SCHEMA_VERSION,
    placements: Object.fromEntries(
      Object.entries(layout.placements).map(([id, placement]) => [id, { ...placement }]),
    ),
  }
}

/**
 * 布局归一化（**按 id 合并 + 保留未知键**）：缺项补默认、逐键 clamp、用户手调值一律保留。
 *
 * ★ #238 刀2：**不再按版本号决定"要不要采用老数据"** —— 版本号与结构对齐无关。
 * 本函数由读盘路径**每次读盘无条件跑一次**（`store.ts` 的 persist `merge` →
 * `alignThemeStructure`），所以「加了新控件但忘记 bump 版本号 ⇒ 控件永远不出现」
 * 这类静默事故在结构上不可能再发生；磁盘上版本号是垃圾值/未来值也不会整份重置。
 *
 * ★ #238 刀3：**槽位判定已整段删除** —— 老数据里读到的 `slot` 字段**一律不读**（不写迁移、
 * 不做适配，用户口径）；`order` / `offsetX` / `offsetY` 原样保留（键之外的字段照旧丢弃）。
 *
 * ★★ #266 CC-13 刀3：**"多余项忽略"改成"未知键保留"**（本线的**唯一**一次数据格式放开）。
 * 原因：读盘发生在**插件登记之前** —— 读盘时把"名单外的键"丢掉，等于**每次重启都误删插件位置**
 * ⇒「重启后仍在」直接失效。所以本函数只做两件事：补内置默认 + 对**数据里出现的每一个键**
 * 逐键 clamp，键本身（含插件件 id、历史遗留 id）一律原样保留。
 * ★ 历史键的**显式清理**仍归 `domains/theme/migration.ts` 的迁移（本函数不动它）。
 * ★ legacy `send` 是唯一的例外：它按别名并入 `cc-send-button`（真名在场则真名优先），
 * 不再以 `send` 为键残留。
 */
export function normalizeCcLayout(layout: Partial<CcLayoutV3> | null | undefined): CcLayoutV3 {
  const placements = cloneCcLayout(DEFAULT_CC_LAYOUT).placements
  if (!layout?.placements) return { version: CC_LAYOUT_SCHEMA_VERSION, placements }

  const persisted = layout.placements as Record<string, Partial<CcWidgetPlacement> | undefined>
  for (const [id, candidate] of Object.entries(persisted)) {
    if (id in LEGACY_CC_LAYOUT_KEY_ALIASES) continue // 别名在下面单独处理（真名优先）
    if (!candidate || typeof candidate !== 'object') continue
    placements[id] = clampCcPlacement(candidate)
  }
  // v9 旧键名迁移：legacy `send` → `cc-send-button`，只补真名缺席的那条
  for (const [alias, id] of Object.entries(LEGACY_CC_LAYOUT_KEY_ALIASES)) {
    const candidate = persisted[alias]
    if (!candidate || typeof candidate !== 'object') continue
    if (persisted[id] && typeof persisted[id] === 'object') continue
    placements[id] = clampCcPlacement(candidate)
  }
  return { version: CC_LAYOUT_SCHEMA_VERSION, placements }
}

/**
 * 写一条位置（拖动 / 顺序输入 / 微调的唯一落点）。
 *
 * ★ CC-13 刀3：**"未知 id = no-op"这条守卫已撤** —— 键空间放开后，插件件 id 与错字在这一层
 * 无法区分，而插件件的**首写**（数据里还没有它）必须落得下去。缺记录时的基准 = 调用方给的
 * 完整值（渲染侧提交前先用 `resolveCcWidgetPlacements` 补齐），缺项按 0 兜底 ⇒ 不会写出 NaN。
 * ★ 计算默认（状态区末尾）只在**读取侧**兜底，不写进数据（见 `DEFAULT_CC_LAYOUT` 头注）。
 */
export function updateCcPlacementState(
  layout: CcLayoutV3,
  id: string,
  partial: Partial<CcWidgetPlacement>,
): CcLayoutV3 {
  const current = layout.placements[id] ?? { order: 0, offsetX: 0, offsetY: 0 }
  const next: CcWidgetPlacement = {
    order: partial.order == null || !Number.isFinite(partial.order) ? current.order : Math.round(clampFinite(partial.order, 0, 99)),
    offsetX: partial.offsetX == null || !Number.isFinite(partial.offsetX) ? current.offsetX : clampFinite(partial.offsetX, -48, 48),
    offsetY: partial.offsetY == null || !Number.isFinite(partial.offsetY) ? current.offsetY : clampFinite(partial.offsetY, -16, 16),
  }
  return {
    version: CC_LAYOUT_SCHEMA_VERSION,
    placements: { ...layout.placements, [id]: next },
  }
}

/**
 * ★★ #266 CC-13 刀3：**删掉一条位置记录**（插件**撤下那一刻**由宿主派发 `clear-cc-placement`）。
 *
 * 为什么落点是"撤下时清"而不是"读盘顺手丢"：读盘发生在插件登记**之前** ⇒ 读盘丢会在
 * 每次重启时误删插件位置（「重启后仍在」直接失效）。
 * ★ 幂等：记录不存在 ⇒ **原样返回同一个对象**（不产生无谓的发布 / 重渲）。
 * ★ 只删数据；"回到计算默认（状态区末尾）"由读取侧兜底实现 ⇒ 重装回来 = 新加入、排最后。
 */
export function clearCcPlacementState(layout: CcLayoutV3, id: string): CcLayoutV3 {
  if (!layout.placements[id]) return layout
  const placements = { ...layout.placements }
  delete placements[id]
  return { version: CC_LAYOUT_SCHEMA_VERSION, placements }
}

/**
 * ★★ #266 刀4（结构 C）：显隐的**两份表**各有名字 —— 写哪一份由调用方**显式**给出。
 *
 * - `'base'` = **主管表**（`ccHidden`）：两种门态都生效（"藏了就是藏了"）；
 * - `'empty'` = **空态再藏**（`ccHiddenEmpty`）：只在空态再加一层，**只能加、不能抵消**主管表
 *   ⇒ 生效名单 = `门 ? 主管 ∪ 再藏 : 主管`（去重，见 `resolveCcHiddenWidgetIds`）。
 *
 * ★ 为什么把"写哪份"做成命令参数而不是让写入侧"认门"：刀 2 那版的两份表是**平权**的、
 *   由门二选一读取 ⇒ 写入必须知道你此刻处在哪个状态，于是"在空态里改的显隐一开会话就变回去"。
 *   开关各自写自己那一份之后，写入与门**解耦**，没有"我在哪个状态改的"这种隐性依赖。
 */
export type CcVisibilityTarget = 'base' | 'empty'

export function setCcHiddenState(hiddenIds: string[], id: string, hidden: boolean): string[] {
  return hidden
    ? Array.from(new Set([...hiddenIds, id]))
    : hiddenIds.filter(widgetId => widgetId !== id)
}
