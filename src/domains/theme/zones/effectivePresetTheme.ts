/**
 * 区域层 · 预设的「有效值」视图（刀3 / #223；#607 刀3a 换源）。
 *
 * 刀3 消灭了「值存两份」：`GlobalPreset.theme` 不再手写，10 套出厂预设**只写区域引用表**
 * （`zoneRefs`），它们的有效值由本函数**算出来**——按引用去**落点材料**
 * （`zones/factory/landingEntries.ts` 的 `LANDING_PRESET_ENTRIES`）取五区切片再并起来。
 *
 * ★ #607 刀3a 换源：解析入口从旧工厂池（`ZONE_PRESET_POOL`）换成 `presetReferencePlan`
 * 的纯解析（新材料同一份数据），且**消息流区是双引用**（样式单 + 配色单，两片并成一片）。
 * 旧池从此不再承担「预设应用」的取值。
 *
 * 语义（两条分支）：
 * - **写了 `theme`**（两条默认预设，走"直给"路径）⇒ 直接用；
 * - **只写 `zoneRefs`**（10 套出厂预设）⇒ 按引用取五区材料切片之并集。
 *
 * ★★ **本文件不得 import `src/presets/**` 的运行时导出** —— `presets/` → `zones/` 已是既有方向
 * （`zones/zonePresetPool.ts` 反过来 import 桶表），反向的**运行时**依赖会成模块环。
 * 所以入参是**调用方传进来的预设对象本身**（结构性类型），
 * 只做 `PresetInterfaceMode` / `ZoneRefMap` / `ThemeSettings` 这几个**类型**进口（`import type` 类型擦除，不产生运行时边）。
 */

import type { ThemeSettings } from '../themeStore.ts'
import type { PresetInterfaceMode } from '../presets/types.ts'
import {
  PRESET_ZONES,
  requireZoneRefs,
  type ZoneRefMap,
} from '../presetReducer.ts'
import { resolveLandingReference } from './presetReferencePlan.ts'
import { LANDING_PRESET_ENTRIES } from './factory/landingEntries.ts'

/**
 * 计算所需的最小输入面。结构性类型 ⇒ 调用方可以直接把 `GlobalPreset` 递进来，
 * 本模块不需要（也不许）依赖 `presets/` 的运行时导出。
 */
export interface ZoneRefBackedPreset {
  readonly interfaceMode: PresetInterfaceMode
  /** 5 个区域（消息流双轴）→ 落点材料 id。有值 ⇒ 有效值由引用表算出。 */
  readonly zoneRefs?: ZoneRefMap
  /** 直给的有效值（两条默认预设）。与 `zoneRefs` 至少有一个。 */
  readonly theme?: Partial<ThemeSettings>
}

/**
 * 这套预设的**有效值**（= 它实际会写进主题的那些字段）。
 *
 * 引用表里的 id 必须能在**同桶同区域（消息流还须同轴）**解析到（跨桶 / 跨区域 / 跨轴 /
 * 不存在的引用**抛错**，与 `resolveLandingReference` 同一口径、同一错误语义）。
 * 出厂数据的越区键在备料期（`assertLandingEntry`）已校验过，这里不重复。
 */
export function effectivePresetTheme(preset: ZoneRefBackedPreset): Partial<ThemeSettings> {
  if (!preset.zoneRefs) return preset.theme ?? {}

  const refs = requireZoneRefs(preset.zoneRefs, `预设 ${preset.interfaceMode} 的区域引用表`)
  const merged: Record<string, unknown> = {}
  for (const zone of PRESET_ZONES) {
    if (zone === 'chat') {
      Object.assign(merged, resolveLandingReference(preset.interfaceMode, 'chat', refs.chat.style, LANDING_PRESET_ENTRIES, 'style').values)
      Object.assign(merged, resolveLandingReference(preset.interfaceMode, 'chat', refs.chat.color, LANDING_PRESET_ENTRIES, 'color').values)
      continue
    }
    Object.assign(merged, resolveLandingReference(preset.interfaceMode, zone, refs[zone], LANDING_PRESET_ENTRIES).values)
  }
  return merged as Partial<ThemeSettings>
}
