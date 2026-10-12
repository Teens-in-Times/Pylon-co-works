/** 预设层 · 内置预设数据：RAW_GLOBAL_PRESETS → GLOBAL_PRESETS。 */

import type { GlobalPreset, PresetInterfaceMode } from './types.ts'
import type { ThemeSettings } from '../themeStore.ts'

const RAW_GLOBAL_PRESETS: GlobalPreset[] = [
  {
    name: 'claude',
    interfaceMode: 'terminal',
    label: 'Claude 风格',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id。现有状态下 5 项同名，
    // ★ 逐套**显式写出 5 项**（不靠「默认补全」——靠默认会掩盖漏写）。
    zoneRefs: { global: 'claude', sidebar: 'claude', chat: 'claude', cc: 'claude', right: 'claude' },
  },
  {
    name: 'glass',
    interfaceMode: 'gui',
    label: 'Glass Light',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'glass', sidebar: 'glass', chat: 'glass', cc: 'glass', right: 'glass' },
  },
  {
    name: 'nord',
    interfaceMode: 'terminal',
    label: 'Nord Frost',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'nord', sidebar: 'nord', chat: 'nord', cc: 'nord', right: 'nord' },
  },
  {
    name: 'tokyo',
    interfaceMode: 'terminal',
    label: 'Tokyo Night',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'tokyo', sidebar: 'tokyo', chat: 'tokyo', cc: 'tokyo', right: 'tokyo' },
  },
  {
    name: 'solarized',
    interfaceMode: 'gui',
    label: 'Solarized Light',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'solarized', sidebar: 'solarized', chat: 'solarized', cc: 'solarized', right: 'solarized' },
  },
  {
    name: 'amber',
    interfaceMode: 'terminal',
    label: 'Amber CRT',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'amber', sidebar: 'amber', chat: 'amber', cc: 'amber', right: 'amber' },
  },
  {
    name: 'matrix',
    interfaceMode: 'terminal',
    label: 'Matrix 磷绿',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'matrix', sidebar: 'matrix', chat: 'matrix', cc: 'matrix', right: 'matrix' },
  },
  {
    name: 'agent-command',
    interfaceMode: 'gui',
    label: 'Agent 指挥台',
    presentationProfileId: 'builtin.presentation.agent-command',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'agent-command', sidebar: 'agent-command', chat: 'agent-command', cc: 'agent-command', right: 'agent-command' },
  },
  {
    name: 'agent-map',
    interfaceMode: 'gui',
    label: 'Agent 关系图',
    presentationProfileId: 'builtin.presentation.agent-map',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'agent-map', sidebar: 'agent-map', chat: 'agent-map', cc: 'agent-map', right: 'agent-map' },
  },
  {
    name: 'focus-flow',
    interfaceMode: 'gui',
    label: '专注流程',
    presentationProfileId: 'builtin.presentation.focus-flow',
    // 刀1（#223 · 预设组装）：区域引用表——5 个区域各指向一条区域预设 id（显式写出 5 项）。
    zoneRefs: { global: 'focus-flow', sidebar: 'focus-flow', chat: 'focus-flow', cc: 'focus-flow', right: 'focus-flow' },
  }
]

/**
 * Public registry：10 套出厂预设。
 *
 * 刀3（#223）起它们**不再手写 `theme`** —— 有效值由区域引用表 + 工厂数据算出
 * （`src/zones/effectivePresetTheme.ts`）；这里只留身份（name / label / 桶 / 引用表 / 呈现方案）。
 * 刀3 同时拆掉了「终端补全」那层投影（原先还要过一层「补全」才成为快照）：
 * 补全烘入的值早已落在工厂数据里，机制本身没有存在的必要。
 */
export const GLOBAL_PRESETS: GlobalPreset[] = RAW_GLOBAL_PRESETS

/**
 * 刀5（#201）：界面模式 → 预设归属桶。
 * 归属表只有 GUI / 终端 两桶（用户 2026-09-19 拍板）；`tactical-blue` 是独立插入的
 * 界面模式、与预设轴零交集 ⇒ 不在映射内（其模式下预设菜单不出现），插件贡献的
 * 未登记模式同理不出现。
 */
export const INTERFACE_MODE_PRESET_BUCKET: Readonly<Record<string, PresetInterfaceMode>> = Object.freeze({
  'modern-gui': 'gui',
  'terminal-like': 'terminal',
})

/**
 * 刀7（#214）：两条「默认预设」——GUI / 终端各一条。
 *
 * **同定位、不同按键**（用户 2026-09-20 拍板）：它们与普通预设是同一个 `GlobalPreset`
 * 形状、走同一条应用路径，唯一区别是**触达方式**——唯一入口是「重置主题」。
 *
 * **为什么是独立表而不是往 `GLOBAL_PRESETS` 里加标记**：「不显示」若靠过滤分支实现，
 * 就得同时改「列表」（`presetsForInterfaceMode`）与「区域池」（`zonePresetPool` 的派生表），
 * 漏一处它们就漏进候选菜单。独立表让两处排除变成**结构性保证**（谁都不读它），
 * 且 `GLOBAL_PRESETS` 仍是 10 套——`docs/说明书` 里「当前 10 套内置预设」不失真。
 *
 * 外观来源（用户拍板）：
 * - GUI：取 `glass` 的四区切面（刀3 起是**字面量快照**，值等于 glass 的有效值）；
 * - 终端：**复制** `glass`（最早那款浅色；深色的 nord/tokyo/amber/matrix/claude 用户已否决）
 *   + 终端契约字段（`msgStyle` / `messageLayout`，
 *   即刀3 拆掉的那层终端补全里的同一组契约字段）。★ #238 刀8：原第 5 项
 *   「整体风格」已整套删除（字段不存在了，不再是契约字段）。
 *   ★ #266 刀9：原第 6/7 项 `inputMode` / `inputVariant` 已随「固定命令行」删除
 *   （连同那条「两者必须同写」的联动不变量）。
 *   ★ #266 CC-18：终端默认另有一处**有意差异** —— `ccMarginX: 0`（中控左右边距的右零点改挂
 *   滚动条左缘，0 = 中控右缘与滚动条左缘齐平）。**它不是**「终端契约字段」那一组里的，
 *   而是单独定的取值；出厂预设那 6 处 15 与字段默认值本件不动。
 */
/**
 * 两条默认预设的**值来源**（刀3 改）：
 *
 * 以前是 `requireGlobalPreset('glass').theme` —— 一个指向 glass 的 `theme` 对象的**引用**。
 * 刀3 之后 glass 不再手写 `theme`，而 `presets/` **不能** import `zones/`（`zones/zonePresetPool.ts` 反过来
 * import 本文件的桶表 ⇒ 反向的运行时依赖会成模块环，停手条件 6 的那类问题）⇒ 这里落成**字面量快照**。
 *
 * ★ 这不是"值存两份"的回潮，而是把**本来就有的语义**写明：这两条默认预设按定义就是 glass 的
 * **拷贝**（刀1 的原话「终端默认是 `glass` 的拷贝而不是引用，用引用表达错了语义」），
 * 所以它们各自持有一份自己的值是正确的表达。漂移由测试钉住（★ 守卫在 `defaultPresets.test.ts`
 * 的 `:85` 与 `:209`，不在 `effectivePresetTheme.test.ts` —— 那里只断言"视图对默认预设 == 它自己的 theme"）：
 * `DEFAULT_PRESETS.gui.theme` 必须逐字段等于 glass 的有效值，终端默认 = 它 + 4 个终端契约字段
 * （★ #238 刀8：原为 5 个，其中「整体风格」已整套删除）。
 * ★ #266 CC-18：终端默认在该集合之上**再多一个 `ccMarginX: 0`**（有意差异，理由见本块末条与
 * `TERMINAL_DEFAULT_THEME`）—— 守卫的比对集随之把这一键算作"契约字段"（`defaultPresets.solid.test.tsx`
 * 的 `TERMINAL_CONTRACT`）。
 *
 * 值取自刀2 落盘的工厂数据（glass 的 5 个区域切面之并集，键序 = `PRESET_ZONES` 顺序）。
 */
const GLASS_THEME: Partial<ThemeSettings> = {
  accent: "#6366f1",
  transparency: 0.9,
  bgBlur: 24,
  globalFontSize: 17,
  globalBgColor: "#f0f0f5",
  titlebarBg: "rgba(245,245,250,0.72)",
  titlebarTextColor: "rgba(0,0,0,0.78)",
  userColor: "#6366f1",
  sidebarBg: "rgba(245,245,250,0.55)",
  sidebarTextColor: "rgba(0,0,0,0.75)",
  sidebarNameSize: 14,
  sidebarGroupSize: 12,
  chatBg: "rgba(255,255,255,0.28)",
  chatFont: "system",
  chatFontSize: 15,
  chatLineHeight: 1.65,
  chatTextColor: "rgba(0,0,0,0.82)",
  chatCodeColor: "#7c3aed",
  chatCodeBg: "rgba(124,58,237,0.06)",
  synKeyword: "#7c3aed",
  synString: "#15803d",
  synComment: "rgba(0,0,0,0.45)",
  synLiteral: "#b45309",
  synEntity: "#0f766e",
  synFunction: "#1d4ed8",
  synVariable: "rgba(0,0,0,0.82)",
  synProperty: "rgba(0,0,0,0.82)",
  synRegex: "#b45309",
  synMarkupHeading: "#7c3aed",
  synSupport: "#1d4ed8",
  toolOk: "#22c55e",
  toolRun: "#6366f1",
  toolErr: "#f43f5e",
  userTagBg: "rgba(99,102,241,0.08)",
  diffAdded: "#22c55e",
  diffRemoved: "#f43f5e",
  diffAddedWord: "#16a34a",
  diffRemovedWord: "#e11d48",
  toolIndicatorGlow: 2,
  toolConnectorMode: "follow",
  spinnerFramePreset: "clock",
  spinnerStalledColor: "#ef4444",
  spinnerColor: "#f59e0b",
  msgFont: "system",
  msgLineHeight: 1.75,
  ccHeight: 96,
  ccBg: "rgba(255,255,255,0.20)",
  // ★ #266 CC-13 刀4：插件元件属性值的载体字段 —— 与 glass 的出厂 cc 条目逐字一致（空表 = 不携带插件参数）。
  ccPluginProps: {},
  ccHidden: [
    "cc-send-button"
  ],
  // ★ #266 刀4（结构 C）：**空态再藏**（叠在主管表 `ccHidden` 之上的第二层，只能加不能抵消）。
  //   空态没有会话 ⇒ 会话相关的件再藏一批（原先这份名单硬编码在 `widgetDefinitions.ts`，现在由预设携带）。
  //   ★ 值一个字没动：它的父集关系（再藏 ⊇ 主管）与刀2 逐字相同 ⇒ 并集结果与改造前一致。
  ccHiddenEmpty: [
    "model",
    "reasoning",
    "mode",
    "tokens",
    "cc-send-button",
    "cc-command-hint"
  ],
  inputBg: "rgba(0,0,0,0.03)",
  inputTextColor: "rgba(0,0,0,0.80)",
  inputPlaceholder: "rgba(0,0,0,0.22)",
  inputFocusBorder: "rgba(99,102,241,0.35)",
  inputFontSize: 15,
  cliLineWidth: 2,
  cliLineColor: "#9a9a9a",
  cliTextColor: "rgba(0,0,0,0.80)",
  cliPromptColor: "#6b7280",
  modelSwitchMode: "cycle",
  modeAutoColor: "#f59e0b",
  modeEditColor: "#6366f1",
  rightBg: "rgba(245,245,250,0.55)",
  rightWidth: 250,
}

/** 终端默认 = `glass` 的副本 + 终端契约字段（★ #266 刀9：`inputVariant` / `inputMode` 已删）
 *  + `ccMarginX: 0`（★ #266 CC-18：右零点挂滚动条左缘后的"贴齐"取值，有意与 GUI 默认不同）。 */
const TERMINAL_DEFAULT_THEME: Partial<ThemeSettings> = {
  ...structuredClone(GLASS_THEME),
  msgStyle: 'terminal',
  messageLayout: 'classic',
  // ★ #266 CC-18：中控「左右边距」的**右零点**改挂滚动条左缘后（见 `ControlCenter.css` 的
  //   `.control-center` margin-right），0 = 中控右缘与滚动条左缘齐平 —— 终端默认取 0（用户
  //   2026-10-09 定：「零点」就是给贴齐用的）。这是终端默认与 GUI 默认**唯一有意不同的取值**
  //   （GUI 默认不含该键 ⇒ 回落字段默认）。★ 出厂预设里已写的 6 处 15 与字段默认值本刀一律
  //   不动 ⇒ 其它预设（含 GUI-默认）仍是 15。
  ccMarginX: 0,
}

/**
 * 两条「默认预设」的**类型**：在 `GlobalPreset` 之上把 `theme` 收回**必填**。
 *
 * `GlobalPreset.theme` 从刀3 起是可选（10 套出厂预设由区域引用表算值），但这两条按定义
 * 走"直给 `theme`"路径 ⇒ 用类型把这条不变量钉住：消费方（`store.resetTheme`）拿到的一定是
 * 有值的 theme，不需要 `?? {}` 之类的兜底（那种兜底会把默认预设的值悄悄清空）。
 */
export interface DefaultPreset extends GlobalPreset {
  theme: Partial<ThemeSettings>
}

export const DEFAULT_PRESETS: Readonly<Record<PresetInterfaceMode, DefaultPreset>> = Object.freeze({
  gui: Object.freeze({
    name: 'gui-default',
    label: 'GUI-默认预设',
    interfaceMode: 'gui',
    theme: GLASS_THEME,
  }),
  terminal: Object.freeze({
    name: 'terminal-default',
    label: '终端-默认预设',
    interfaceMode: 'terminal',
    theme: TERMINAL_DEFAULT_THEME,
  }),
})

/** 当前界面模式对应的默认预设（**未登记模式 ⇒ undefined** ⇒ 调用方回落 `DEFAULTS`）。 */
export function defaultPresetForInterfaceMode(interfaceMode: string): DefaultPreset | undefined {
  const bucket = INTERFACE_MODE_PRESET_BUCKET[interfaceMode]
  return bucket ? DEFAULT_PRESETS[bucket] : undefined
}

/** 当前界面模式下可出现在预设菜单第二级的预设（桶未登记 ⇒ 空数组 = 菜单不出现）。 */
export function presetsForInterfaceMode(interfaceMode: string): GlobalPreset[] {
  const bucket = INTERFACE_MODE_PRESET_BUCKET[interfaceMode]
  return bucket ? GLOBAL_PRESETS.filter(preset => preset.interfaceMode === bucket) : []
}

/**
 * #116 子项 7：「全局预设」行的兜底 chip 判据（从 Settings.tsx 抽出以便单测）。
 *
 * `deriveGlobalStatus` 可能返回三种值：内置预设的 name、`'custom'` 哨兵（任一 zone
 * 被手动改过）、自定义预设的 id。原先的兜底判据只排除内置 name，于是后两种都会把
 * **原文**渲染成一个 chip —— 用户看到 `custom-1788421103162` 这类内部标识，且与
 * `.set-custom-presets` 里的具名 chip 同时点亮。
 *
 * 现在的口径：
 * - 内置预设 name → 无兜底（上面那排 chip 自己就是选中态）
 * - 自定义预设 id → 无兜底（交给具名列表渲染，避免重复点亮）
 * - `'custom'` 哨兵 → 显示为「自定义」
 * - 其余无法识别的值 → 显示为「未知预设」，原值只在 title 里留作排查线索
 */
export function fallbackPresetChip(
  globalStatus: string,
  customPresetIds: readonly string[],
): { label: string; title: string } | null {
  if (!globalStatus) return null
  if (GLOBAL_PRESETS.some(preset => preset.name === globalStatus)) return null
  if (customPresetIds.includes(globalStatus)) return null
  if (globalStatus === 'custom') return { label: '自定义', title: '当前外观已偏离预设基准' }
  return { label: '未知预设', title: `未识别的预设标识：${globalStatus}` }
}
