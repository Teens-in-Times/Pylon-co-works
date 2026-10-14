import { GLOBAL_PRESETS, type GlobalPreset, type PresetInterfaceMode, type PresetName } from '../../domains/theme/presets/index.ts'
import {
  PRESET_ZONES,
  requireZoneRefs,
  type GlobalPresetZoneSlice,
  type ZoneRefMap,
} from '../../domains/theme/presetReducer.ts'
import { effectivePresetTheme } from '../../domains/theme/zones/index.ts'
import { resolveLandingReference } from '../../domains/theme/zones/presetReferencePlan.ts'
import { LANDING_PRESET_ENTRIES } from '../../domains/theme/zones/factory/landingEntries.ts'
import { legacyAssemblySlices } from '../../domains/theme/zones/modeLandingPlan.ts'
import { useThemeStore, type ThemeSettings } from '../../domains/theme/themeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import type { InterfaceModeTransactionPorts } from './activateInterfaceMode.ts'

export interface GlobalPresetTransactionPorts extends InterfaceModeTransactionPorts {}

/**
 * 一次全局预设应用的计划。它只描述「该不该写 / 该写什么 / 身份是什么」，
 * 不含执行能力：不持有 store、不持有注册表单例。
 */
export type GlobalPresetPlan =
  | { kind: 'skip' }
  | {
      kind: 'apply'
      presetName: GlobalPreset['name']
      /** 预设归属桶——区域引用表解析的桶边界（跨桶引用非法）。 */
      interfaceMode: PresetInterfaceMode
      theme: Partial<ThemeSettings>
      /**
       * 刀1（#223 · 预设组装）：区域引用表（已过完整性校验）。有值 = 走**逐区域装配**；
       * 无值（两条默认预设）⇒ 回落「整份 `theme`」路径。
       */
      zoneRefs?: ZoneRefMap
      /**
       * ★ #607 刀3a：生效的**消息流样式单身份**（`styleMaterial.profileId`）——
       * 应用后写进 `activeProfileId` 的唯一来源。取不到 ⇒ 不写（保持原值，
       * 与「区域预设不碰档案身份」同义）。
       */
      styleProfileId?: string
    }

/**
 * 生效的消息流样式单身份（#607 刀3a）：`activeProfileId` 的唯一来源。
 *
 * 身份挂在**材料**上（`styleMaterial`）；`GlobalPreset.presentationProfileId` 字段与数据
 * 已随刀3b 删除，不再是任何路径的读源。
 */
function styleProfileIdOf(bucket: PresetInterfaceMode, refs: ZoneRefMap): string | undefined {
  return resolveLandingReference(bucket, 'chat', refs.chat.style, LANDING_PRESET_ENTRIES, 'style')
    .styleMaterial?.profileId
}

/**
 * 纯函数：算出全局预设的应用计划。同样输入必得同样输出，不产生副作用。
 *
 * 刀1（#223）：带区域引用表的预设在这里过一次**完整性校验**——缺项 / 非区域键**抛错**，
 * 不静默回落（静默回落的症状是「预设装了但某个区域没跟上」，用户看不出原因）。
 *
 * ★ #607 刀3a：预设不再读呈现档案——档案货物已并进 `preset:*` 合并材料，
 * 这里只从材料取身份（`styleProfileId`）。
 */
export function planGlobalPreset(name: string): GlobalPresetPlan {
  const preset = GLOBAL_PRESETS.find(candidate => candidate.name === name)
  if (!preset) return { kind: 'skip' }

  const zoneRefs = preset.zoneRefs ? requireZoneRefs(preset.zoneRefs, `出厂预设 ${preset.name} 的区域引用表`) : undefined
  // 刀3（#223）：预设不再手写 `theme` ⇒ 有效值一律走视图（两条默认预设的视图就是它自己写的 theme）
  const theme = effectivePresetTheme(preset)
  const styleProfileId = zoneRefs ? styleProfileIdOf(preset.interfaceMode, zoneRefs) : undefined

  return {
    kind: 'apply',
    presetName: preset.name,
    interfaceMode: preset.interfaceMode,
    theme,
    ...(zoneRefs ? { zoneRefs } : {}),
    ...(styleProfileId ? { styleProfileId } : {}),
  }
}

/**
 * 刀1（#223）：把一套预设的**区域引用表**展开成逐区域的装配输入。
 *
 * ★ #607 刀3a 换源：解析入口从旧工厂池换成 `presetReferencePlan` 的纯解析 + 落点材料
 * （`LANDING_PRESET_ENTRIES`，与有效值视图 `effectivePresetTheme` 同一份数据）；
 * 消息流区是双引用 ⇒ 样式单与配色单**并成一片**（配色后写，两单互不重叠）。
 *
 * 每个区域按 `(界面模式桶, 区域[, 轴], 引用 id)` 解析 ⇒ **跨桶 / 跨区域 / 跨轴 / 不存在的引用
 * 一律抛错**（不静默回落）。
 *
 * ★ 出来的是**待迁归属**的切片（`inputBorderColor` 还在 cc 材料里）⇒ 交旧装配前必须过
 * `legacyAssemblySlices` 还原成旧合同的 global 位置，否则 `assertZoneSliceOwnership` 会报越区。
 *
 * 纯函数：只读 `LANDING_PRESET_ENTRIES` 这张构建时求值的表，不改任何状态。
 */
export function expandGlobalPresetZoneRefs(
  bucket: PresetInterfaceMode,
  zoneRefs: ZoneRefMap,
): GlobalPresetZoneSlice[] {
  const refs = requireZoneRefs(zoneRefs, `区域引用表（${bucket}）`)
  const slices = PRESET_ZONES.map(zone => {
    if (zone === 'chat') {
      const style = resolveLandingReference(bucket, 'chat', refs.chat.style, LANDING_PRESET_ENTRIES, 'style')
      const color = resolveLandingReference(bucket, 'chat', refs.chat.color, LANDING_PRESET_ENTRIES, 'color')
      // 记名取样式单 id：它是两张单里唯一带身份（`styleMaterial`）的那张。
      return { zone, presetName: style.id, theme: { ...style.values, ...color.values } }
    }
    const entry = resolveLandingReference(bucket, zone, refs[zone], LANDING_PRESET_ENTRIES)
    return { zone, presetName: entry.id, theme: entry.values }
  })
  return legacyAssemblySlices(slices)
}

/**
 * 应用官方全局预设：写主题（逐区域装配）＋ 按材料身份更新 `activeProfileId`。
 *
 * 薄壳：只做三件事 —— 取全局单例、执行副作用（写主题、写身份）、回报成功与否。
 * 全部分支判断在 planGlobalPreset 里。
 *
 * ★ #607 刀3a 起**不再**激活呈现档案：档案的 token 叠加与模式切换都不再走这条路
 * （档案货物在合并材料里；界面模式由开关/选择器负责）。对外签名与返回值一字未变。
 */
export function applyGlobalPreset(name: PresetName | string, ports?: GlobalPresetTransactionPorts): boolean {
  const plan = planGlobalPreset(name)
  if (plan.kind === 'skip') return false
  const themeStore = (ports?.theme ?? useThemeStore).getState()
  if (plan.zoneRefs) {
    // 引用指向的是**材料 id**（不再是预设名）⇒ 显式传 appliedName，
    // 否则全局预设 chip 认不出记名、会亮兜底「自定义」。
    themeStore.assembleGlobalPreset(
      expandGlobalPresetZoneRefs(plan.interfaceMode, plan.zoneRefs),
      { appliedName: plan.presetName },
    )
  } else {
    themeStore.setGlobalPreset(plan.presetName, plan.theme)
  }
  if (plan.styleProfileId !== undefined) {
    (ports?.presentation ?? usePresentationPreferenceStore).getState().setActiveProfileId(plan.styleProfileId)
  }
  return true
}
