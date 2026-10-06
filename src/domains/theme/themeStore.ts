import { attachSolidPersist, createSolidStoreKernel, resolveLocalStorage, type SolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { clearCcPlacementState, DEFAULT_CC_LAYOUT, cloneCcLayout, setCcHiddenState, updateCcPlacementState } from '../cc/ccLayoutState.ts'
import { clearCcPluginPropsState, setCcPluginPropState } from '../cc/ccPluginProps.ts'
import type { CcVisibilityTarget } from '../cc/ccLayoutState.ts'
import type { CcWidgetPlacement } from '../cc/ccLayoutState.ts'
import { markZoneCustom } from './themePresetState.ts'
import { THEME_SETTING_KEYS, ZONE_FIELDS } from './themeFieldDefs.ts'
import { clampCcHeight, ccMinHeightInputOf } from '../cc/ccHeightState.ts'
import { THEME_SCHEMA_VERSION, alignThemeStructure, themeDomainMigrate } from './migration.ts'
import { stashLegacyPresets } from './legacyPresetStash.ts'
import { DEFAULTS } from './themeDefaults.ts'
import { useInterfaceModeStore } from '../interface/interfaceModeStore.ts'
import { defaultPresetForInterfaceMode } from './presets/index.ts'
import { reportLegacyProfilePayload } from '../../app/bootstrap/hydrateIdentityAndWorkspace.ts'
import {
  applyZonePresetReducer,
  assembleGlobalPresetReducer,
  setGlobalPresetReducer,
  setZoneFieldReducer,
  type AssembleGlobalPresetOptions,
  type GlobalPresetZoneSlice,
} from './presetReducer.ts'
import type { Profile } from '../identity/identityStore.ts'
import { recordSettingWrites, type SettingWriteSource } from './settingProvenance.ts'
import type { ThemeSettings } from './themeTypes.ts'

export type { ThemeSettings } from './themeTypes.ts'



/**
 * themeStore — 主题状态域。
 *
 * 持久化键 pylon-theme。身份/运行时/Workspace 状态已迁出到
 * identityStore / runtimeStore / workspaceStore（组合出口见文件尾；其中
 * workspaceStore 亦独立持久化 pylon-workspace-sheets，另有 interface-mode、
 * presentation-preferences 等独立 persist 域——「唯一持久化域」说法已废）。
 */
export type ThemeState = ThemeSettings & {
  setCcEditMode: (enabled: boolean) => void
  setCcHeight: (height: number) => void
  updateCcPlacement: (id: string, partial: Partial<CcWidgetPlacement>) => void
  /**
   * ★ #266 CC-13 刀4：写一条**插件元件的属性值**（编辑列属性面板的唯一落点）。
   * 值住 `ccPluginProps`（随预设走）；幂等：写同值 ⇒ 原样返回同一 state（不广播）。
   * ★ 与"用户改内置件参数 / 拖位置 / 动显隐"同类 ⇒ 置 cc zone 的 custom 标记
   *   （插件撤下清数据那条**不置** —— 那不是用户手改，见下）。
   */
  setCcPluginProp: (id: string, key: string, value: string | number) => void
  /**
   * ★★ #266 CC-13 刀3 立、**刀4 泛化**：清掉某元件的**全部用户数据**（插件**撤下那一刻**由宿主派发）
   * —— 一次清三样：位置记录 / 插件属性 / 两份显隐表里的该 id。
   * ★ 三样都不存在 ⇒ 原样返回同一 state（幂等、不广播）。
   * ★ 不置 zone custom：这是**插件侧事件**，不是用户手改该区域（口径见施工单 §4.4）。
   */
  clearCcWidgetData: (id: string) => void
  resetCcLayout: () => void
  /**
   * ★ #266 刀4（结构 C）：`target` = 写**哪一份表** —— `'base'` 主管（两种门态都生效）/
   * `'empty'` 空态再藏（只在空态再加一层，只能加、不能抵消）。写入因此**不认门**。
   */
  setCcHidden: (id: string, hidden: boolean, target: CcVisibilityTarget) => void
  resetTheme: () => void
  /** 重置单个 zone 的字段到默认值（不清其他 zone），并清该 zone 的 custom/appliedPreset */
  resetZone: (zone: string) => void
  applyZonePreset: (zone: string, presetName: string, presetTheme: Partial<ThemeSettings>) => void
  setZoneField: (zone: string, partial: Partial<ThemeSettings>, source?: SettingWriteSource) => void
  setGlobalPreset: (name: string, theme: Partial<ThemeSettings>) => void
  /**
   * 刀1（#223 · 预设组装）：**逐区域装配**一条全局预设。
   * `slices` = 5 个区域各自的 `{ zone, 引用 id, 取值切片 }`（由 `expandGlobalPresetZoneRefs` 展开）。
   * 与 `setGlobalPreset`（整份 `theme` 一次性写）是两条等价路径：带区域引用表的预设走这条，
   * 两条默认预设（无引用表）回落上面那条。
   */
  assembleGlobalPreset: (slices: readonly GlobalPresetZoneSlice[], options?: AssembleGlobalPresetOptions) => void
}

// clampPresetCcHeight / syncPresetCcHeight 已随预设动作迁入 domains/theme/presetReducer.ts

// DEFAULTS 定义移入 domains/theme/themeDefaults.ts（可被 node import → 完整性断言测试）

/**
 * 刀7 §六（#214）：哪些写入 source 算「用户触碰」⇒ 置该 zone 的 custom 标记。
 *
 * 呈现方案（界面模式的 token / 用户挑的呈现风格）是**方案自身的基准**，不是用户手改字段。
 * 此前它照旧置 custom，于是全局派生命中「任一 zone custom ⇒ `'custom'`」——点「重置主题」
 * 或切换界面模式之后，预设行会亮出兜底的「自定义」chip，把正当基准误报成用户改动。
 * 其余 source 语义一字不动（缺省 `user-edit` 仍然置 custom）。
 */
function sourceMarksZoneCustom(source: SettingWriteSource): boolean {
  return source !== 'presentation-profile'
}


/** 迁移 / 结构对齐共用的默认值包（base 传 DEFAULTS，避免域→store 循环）。 */
const THEME_MIGRATION_DEFAULTS = {
  base: DEFAULTS,
  appliedPreset: DEFAULTS.appliedPreset,
  custom: DEFAULTS.custom,
  ccLayout: DEFAULTS.ccLayout,
}

// #515 批0：zustand → Solid 内核置换（对外签名不变；hook shim 已随 R4 收口拆除）。
const themeKernel = createSolidStoreKernel<ThemeState>({
  ...DEFAULTS,

  // #448 PR5：customPresets/zonePresetEntries 已拆独立域 customPresetStore
  // （pylon-custom-presets 键 + 后端 custom-presets user_data 权威）。

  // D-trace：写入溯源——source 由调用方声明（用户编辑/呈现风格/界面模式…），
  // 记录在漏斗出口完成，reducer 保持纯函数。
  // 刀7 §六（#214）：source 同时决定**这次写入算不算「用户触碰」**（是否置该 zone 的 custom）
  setZoneField: (zone, partial, source = 'user-edit') => {
    recordSettingWrites(source, zone, Object.keys(partial))
    themeKernel.setState(state => setZoneFieldReducer(state, zone, partial, sourceMarksZoneCustom(source)))
  },
  setCcEditMode: (enabled) => themeKernel.setState({ ccEditMode: enabled }),
  setCcHeight: (height) => themeKernel.setState(state => {
    // D1：ccHeight 经布局约束漏斗归一化（★ #266 刀3：下界 = 按边算取最大，见 ccHeightState.resolveCcMinHeight）
    const ccHeight = clampCcHeight(height, ccMinHeightInputOf(state))
    return { ccHeight, ...markZoneCustom(state, 'cc') }
  }),
  updateCcPlacement: (id, partial) => themeKernel.setState(state => ({
    ccLayout: updateCcPlacementState(state.ccLayout, id, partial),
    ...markZoneCustom(state, 'cc'),
  })),
  // ★ #266 CC-13 刀4：插件件的属性写入 —— 与"用户改内置件参数"同类 ⇒ 置 cc zone custom。
  //   幂等：同值 ⇒ 原样返回同一 state（不产生发布 / 不重复置 custom）。
  setCcPluginProp: (id, key, value) => themeKernel.setState(state => {
    const ccPluginProps = setCcPluginPropState(state.ccPluginProps, id, key, value)
    return ccPluginProps === state.ccPluginProps ? state : { ccPluginProps, ...markZoneCustom(state, 'cc') }
  }),
  // ★★ #266 CC-13 刀3 立、刀4 泛化：撤下清数据 —— 一次清三样（位置 / 插件属性 / 两份显隐表）。
  //   三样都不存在 ⇒ 原样返回同一 state（幂等、不广播）。
  //   不置 custom：插件撤下不是"用户手改该区域"（见 ThemeState 上的类型注释）。
  clearCcWidgetData: (id) => themeKernel.setState(state => {
    const ccLayout = clearCcPlacementState(state.ccLayout, id)
    const ccPluginProps = clearCcPluginPropsState(state.ccPluginProps, id)
    // 显隐两份表先判 `includes`：`setCcHiddenState(…, false)` 的 filter 恒产新数组，
    // 不判会让"什么都没清"也变成一次新 state（幂等就废了）。
    const ccHidden = state.ccHidden.includes(id) ? setCcHiddenState(state.ccHidden, id, false) : state.ccHidden
    const ccHiddenEmpty = state.ccHiddenEmpty.includes(id) ? setCcHiddenState(state.ccHiddenEmpty, id, false) : state.ccHiddenEmpty
    return ccLayout === state.ccLayout && ccPluginProps === state.ccPluginProps
      && ccHidden === state.ccHidden && ccHiddenEmpty === state.ccHiddenEmpty
      ? state
      : { ccLayout, ccPluginProps, ccHidden, ccHiddenEmpty }
  }),
  resetCcLayout: () => themeKernel.setState(state => ({
    ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
    ...markZoneCustom(state, 'cc'),
  })),
  setCcHidden: (id, hidden, target) => themeKernel.setState(state => {
    // ★ #266 刀4（结构 C）：按 `target` 写对应那一份表（主管 / 再藏），两份互不覆盖。
    const next = target === 'base'
      ? { ...state, ccHidden: setCcHiddenState(state.ccHidden, id, hidden) }
      : { ...state, ccHiddenEmpty: setCcHiddenState(state.ccHiddenEmpty, id, hidden) }
    // ★ #266 刀3：显隐一变必须重过 clamp，且下界用**更新后**的两份表算。
    //   下界取「两态中要求更高的那一份」（见 ccHeightState.resolveCcMinHeight）⇒ 常态变矮**不一定**
    //   抬得动下界：另一份可能仍咬住，所以"藏一件 ⇒ 最小高变小"**不再必然成立**。
    const ccHeight = clampCcHeight(state.ccHeight, ccMinHeightInputOf(next))
    return {
      ...(target === 'base' ? { ccHidden: next.ccHidden } : { ccHiddenEmpty: next.ccHiddenEmpty }),
      ccHeight,
      ...markZoneCustom(state, 'cc'),
    }
  }),

  resetTheme: () => {
    recordSettingWrites('theme-reset', '*', Object.keys(DEFAULTS))
    // 刀7（#214）：重置落点 = **当前界面模式的默认预设**（GUI / 终端各一条，只存值不记基准）。
    // 未登记模式（tactical-blue、插件未登记模式）没有默认预设 ⇒ 回落整份 DEFAULTS（不报错、不悬空）。
    const target = defaultPresetForInterfaceMode(useInterfaceModeStore.getState().interfaceMode)
    if (!target) {
      themeKernel.setState(structuredClone(DEFAULTS))
      return
    }
    // 覆盖范围与原来的「整份 DEFAULTS」逐字一致（含非预设域字段 sidebarWidth / rightWidth），
    // 只把**预设域字段**换成默认预设的值；ccLayout 归一与 ccHeight 收敛沿用「应用预设」同一套算法。
    // 名字传空串 = 沿用 resetZone 的「无基准」态：默认预设不进列表，若记名，预设行会因认不出它
    // 而亮出兜底的「未知预设」chip——那正是刀6/07a 要避免的悬空。
    themeKernel.setState({ ...structuredClone(DEFAULTS), ...setGlobalPresetReducer('', target.theme) })
  },

  resetZone: (zone) => themeKernel.setState(state => {
    const fields = (ZONE_FIELDS[zone] ?? []) as (keyof ThemeSettings)[]
    // 只重置标量主题字段；ccLayout/ccHidden 等对象字段走专用动作（避免误清用户排布）
    const reset = Object.fromEntries(
      fields
        .filter(field => {
          const value = DEFAULTS[field]
          return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        })
        .map(field => [field, DEFAULTS[field]]),
    )
    recordSettingWrites('zone-reset', zone, Object.keys(reset))
    return {
      ...reset,
      appliedPreset: { ...state.appliedPreset, [zone]: '' },
      custom: { ...state.custom, [zone]: false },
    }
  }),

  // 六个预设动作：纯计算在 domains/theme/presetReducer.ts，此处只留 setState(reducer(state, args)) 薄壳
  applyZonePreset: (zone, presetName, presetTheme) => {
    recordSettingWrites('zone-preset', zone, Object.keys(presetTheme))
    themeKernel.setState(state => applyZonePresetReducer(state, zone, presetName, presetTheme))
  },
  setGlobalPreset: (name, theme) => {
    recordSettingWrites('global-preset', '*', Object.keys({ ...DEFAULTS, ...theme }))
    themeKernel.setState(() => setGlobalPresetReducer(name, theme))
  },
  // 刀1（#223）：逐区域装配薄壳——纯计算在 presetReducer，这里只记溯源 + setState(reducer(state, args))
  assembleGlobalPreset: (slices, options = {}) => {
    recordSettingWrites('global-preset', '*', Object.keys({
      ...DEFAULTS,
      ...Object.assign({}, ...slices.map(slice => slice.theme)),
      ...(options.profileTokens ?? {}),
    }))
    themeKernel.setState(state => assembleGlobalPresetReducer(state, slices, options))
  },
  // #448 PR5：saveCustomPreset/applyCustomPreset/removeCustomPreset/saveZonePresetEntry/
  // pruneZonePresetEntries/removeZonePresetEntry 已迁 customPresetStore（跨 store
  // 事务经 presetActions 合成视图注入，快照/回滚语义不变）。
})

attachSolidPersist(themeKernel, {
  name: 'pylon-theme', version: THEME_SCHEMA_VERSION,
  // G9（1C L1）：主题写盘失败可见（ErrorCenter 指纹去重聚合为一次性告警）
  storage: {
    getItem: key => resolveLocalStorage()?.getItem(key) ?? null,
    setItem: (key, value) => {
      const storage = resolveLocalStorage()
      if (!storage) return
      try {
        storage.setItem(key, value)
        resolveRuntimeErrors({ key: 'app:theme-persistence', source: 'theme.persistence' })
      } catch (error) {
        // 写盘失败可见（ErrorCenter 指纹去重聚合）；不 throw——内存态继续（1C）
        reportRuntimeError('保存主题配置', error, undefined, {
          key: 'app:theme-persistence',
          scope: { kind: 'app', id: 'theme' },
          source: 'theme.persistence',
        })
      }
    },
    removeItem: key => resolveLocalStorage()?.removeItem(key),
  },
  migrate: (persisted, version) => {
    // #448 PR5：旧 pylon-theme 内嵌的预设字段在 migrate 写回时会被 partialize
    // 白名单洗掉——先原样暂存（customPresetStore 的搬家读暂存，读序无关）。
    stashLegacyPresets(persisted)
    return themeDomainMigrate(persisted, THEME_MIGRATION_DEFAULTS, version)
  },
  /**
   * ★★ #238 刀2：读盘后的**结构对齐**每次读盘无条件跑（不依赖版本号）。
   *
   * 挂钩为什么选 `merge` 而不是 onRehydrateStorage：hydrate 用 merge 的返回值落
   * **原始 set**（不触发写盘），只有真的跑过 `migrate` 才 `setItem()` ——
   * 所以对齐**不产生任何额外写盘 / 订阅广播**；且 `migrate → merge` 的顺序保证
   * 它跑在一次性语义转换之后（attachSolidPersist 同款顺序）。
   *
   * 语义：缺项补默认、**未知键保留**（插件件 id 与白名单外的历史 id 都留着；历史废弃 id 的显式清理
   * 在 `migration.ts` 的 `REMOVED_CC_PLACEMENT_IDS`）、**用户手调的 offsetX/offsetY/order 与已设字段值
   * 一律保留**（既定口径：「布局归一化不是把用户排布拍平」）。幂等，见 `alignThemeStructure`。
   */
  merge: (persisted, current) => ({ ...current, ...alignThemeStructure(persisted, THEME_MIGRATION_DEFAULTS) }),
  partialize: (state) => {
    // A4 白名单：THEME_SETTING_KEYS（主题字段，含 ccLayout/ccHidden 对象）+ 显式 meta。
    // 取代"排除式 partialize"——杜绝新增 action/临时字段误持久化，并修剪迁移遗留的旧键。
    // #448 PR5：customPresets/zonePresetEntries 移出白名单——拆独立 customPresetStore
    // 后旧键内嵌的这两字段会在下一次主题写盘时被本白名单修剪（搬家在新 store 侧完成）。
    const persisted: Record<string, unknown> = {}
    for (const key of THEME_SETTING_KEYS) persisted[key] = state[key]
    persisted.appliedPreset = state.appliedPreset
    persisted.custom = state.custom
    return persisted
  },
  onRehydrateStorage: () => state => {
  // FE-AUD-002：旧 pylon-theme 内嵌 profile 一次性迁移到独立 pylon-profiles key
  // （迁移逻辑在 hydrateProfiles：新 key 存在时旧数据不反向覆盖）
  const legacy = state as unknown as { profiles?: Profile[]; activeProfileId?: string } | undefined
  const legacyArg =
    legacy?.profiles && Array.isArray(legacy.profiles) && legacy.profiles.length > 0
      ? { profiles: legacy.profiles, activeProfileId: typeof legacy.activeProfileId === 'string' ? legacy.activeProfileId : legacy.profiles[0].id }
      : undefined
  // P31：persist 只报告 legacy payload；跨域 hydration 唯一由 application bootstrap 触发。
  reportLegacyProfilePayload(legacyArg)
}})

export const useThemeStore: SolidStoreKernel<ThemeState> = themeKernel

