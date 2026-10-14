/** 预设层 · 类型定义：PresetName / GlobalPreset。 */

import type { ThemeSettings } from '../themeStore.ts'
// 引用表形状的唯一真值是 `ZoneRefMap`（domains/theme/presetReducer.ts）；`import type`
// 类型擦除、零运行时依赖 ⇒ 不构成模块环，也不在这里另立第二份形状定义。
import type { ZoneRefMap } from '../presetReducer.ts'

// ── 预设定义 ─────────────────────────────────────────────────────

export type PresetName =
  | 'claude'
  | 'glass'
  | 'nord'
  | 'tokyo'
  | 'solarized'
  | 'amber'
  | 'matrix'
  | 'agent-command'
  | 'agent-map'
  | 'focus-flow'
  // 刀7：两条「默认预设」——与预设同定位（同形状、同应用路径），唯一触达是
  // 「重置主题」；**不进 GLOBAL_PRESETS**，故列表与区域池都看不到它们。
  | 'gui-default'
  | 'terminal-default'

export interface GlobalPreset {
  name: PresetName
  label: string
  /** 刀5（#201）：预设归属桶——预设菜单第一级只有 GUI / 终端 两桶（用户拍板归属表）。 */
  interfaceMode: PresetInterfaceMode
  /**
   * 有效值（刀3 / #223 起**可选**）。
   *
   * 10 套出厂预设**不写它** —— 它们的有效值由 `zoneRefs` + 工厂数据算出
   * （`src/zones/effectivePresetTheme.ts`）。两条默认预设仍写它（"直给"路径）。
   * 读值请一律走 `effectivePresetTheme(preset)`，不要直接读这个字段。
   */
  theme?: Partial<ThemeSettings>
  /**
   * 刀1（#223 · 预设组装）：**区域引用表**——5 个区域各指向一条区域预设 id。
   * 有则「应用整套预设」走**逐区域装配**；无则回落现在的「整份 `theme`」路径。
   *
   * ★ #607 刀3a：引用指向的不再是「预设名」，而是**落点材料 id**（`factory:*` / `preset:*`），
   * 消息流区从单引用变**双引用** `{ style, color }`（两张单：样式单 + 配色单）。
   * 现在不变量（由 `requireZoneRefs` 在消费点强制）：**5 项必须齐 + 消息流两轴齐**，
   * 缺项 = 非法（抛错，不静默回落）。
   * 两条默认预设（`DEFAULT_PRESETS`）刀1 不写它：终端默认是 `glass` 的**拷贝**而非引用，
   * 且引 `glass` 会成跨桶引用。
   */
  zoneRefs?: ZoneRefMap
}

/** tactical 桶先用于独立数据装配，生产界面模式映射另行接入。 */
export type PresetInterfaceMode = 'gui' | 'terminal' | 'tactical'
