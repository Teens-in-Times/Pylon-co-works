// @vitest-environment jsdom
/**
 * 刀1（#223 · 预设组装）：**区域引用表 + 逐区域装配**。
 *
 * 三条一起锁：
 * 1. 引用表**覆盖完整**（缺项抛错，不静默回落）；
 * 2. **新旧装配等价**——新路径（逐区域装配）与旧路径（`setGlobalPresetReducer` 整份 theme 一次性写）
 *    对 10 套出厂预设 + 2 套默认预设逐字段深度相等（旧路径保留为参考实现）；
 * 3. ★★ **不许串区**（用户点名）：引用解析出来的值只允许落在该区域自己的字段上，越区键**报错不静默丢弃**。
 *
 * ★ 本文件只新增断言，**不改**任何既有行为测试；`setGlobalPresetReducer` 在改造后仍留在
 * `presetReducer.ts` 里充当 B2 的参考实现（也是「无引用表 ⇒ 整份 theme」的回落路径）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PRESETS,
  GLOBAL_PRESETS,
  fallbackPresetChip,
  type GlobalPreset,
} from '../domains/theme/presets/index.ts'
import { BUILTIN_PRESENTATION_PROFILES } from '../plugins/core/renderer/builtinPresentationProfiles.ts'
import { applyGlobalPreset } from '../application/transactions/applyGlobalPreset.ts'
import {
  DEFAULT_CC_LAYOUT,
  cloneCcLayout,
  type CcLayoutV3,
} from '../domains/cc/ccLayoutState.ts'
import {
  PRESET_ZONES,
  applyZonePresetReducer,
  assembleGlobalPresetReducer,
  assertZoneSliceOwnership,
  clampPresetCcHeight,
  deriveGlobalStatus,
  filterPresetTheme,
  requireZoneRefs,
  setGlobalPresetReducer,
  type GlobalPresetZoneSlice,
  type ThemePresetState,
} from '../domains/theme/presetReducer.ts'
import { DEFAULTS } from '../domains/theme/themeDefaults.ts'
import { ZONE_FIELDS, THEME_PRESET_KEYS } from '../domains/theme/themeFieldDefs.ts'
import { ZONE_PRESET_POOL, effectivePresetTheme, pickZoneFields, resolveZonePresetEntryTheme } from '../domains/theme/zones/index.ts'
import { useThemeStore, type ThemeSettings } from '../domains/theme/themeStore.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { resetStores } from '../test/resetStores.ts'
import { expandGlobalPresetZoneRefs, planGlobalPreset } from '../application/transactions/applyGlobalPreset.ts'

const PROFILE_BY_ID = new Map(BUILTIN_PRESENTATION_PROFILES.map(profile => [profile.id, profile]))

/**
 * 三张 Agent 卡与呈现档案的绑定（测试侧真值）。
 *
 * ★ #607 刀3b：生产侧绑定已并入 `preset:*` 合并材料，`GlobalPreset` 类型不再带
 * `presentationProfileId` 字段 ⇒ 这条「旧路径」参考实现自持一份同样的绑定。
 */
const AGENT_CARD_PROFILES: Readonly<Record<string, string>> = {
  'agent-command': 'builtin.presentation.agent-command',
  'agent-map': 'builtin.presentation.agent-map',
  'focus-flow': 'builtin.presentation.focus-flow',
}

/** 预设带呈现方案时，旧路径拿到的输入是 `effectivePresetTheme(preset) ⊕ profile.tokens`（见 `planGlobalPreset`）。 */
function boxedTheme(preset: GlobalPreset): Partial<ThemeSettings> {
  const tokens = profileTokensOf(preset)
  return tokens ? { ...effectivePresetTheme(preset), ...tokens } : effectivePresetTheme(preset)
}

function profileTokensOf(preset: GlobalPreset): Partial<ThemeSettings> | undefined {
  const boundProfileId = AGENT_CARD_PROFILES[preset.name]
  const profile = boundProfileId ? PROFILE_BY_ID.get(boundProfileId) : undefined
  return profile?.tokens as Partial<ThemeSettings> | undefined
}

/** 参考实现：改造前那条路（整份 `theme` 一次性写）。 */
function legacyPatch(preset: GlobalPreset): ReturnType<typeof setGlobalPresetReducer> {
  return setGlobalPresetReducer(preset.name, boxedTheme(preset))
}

/** 新路径：引用表 → 逐区域取值切片 → 纯层装配。 */
function assembleFromRefs(state: ThemePresetState, preset: GlobalPreset) {
  const refs = requireZoneRefs(preset.zoneRefs, `出厂预设 ${preset.name}`)
  // ★ #607 刀3a：引用指向的是**落点材料 id**（不再是预设名）⇒ 生产路径显式传
  //   `appliedName` 把「取值用的引用」与「写进 appliedPreset 的名字」分开
  //   （否则全局预设 chip 会因认不出记名而亮兜底「自定义」）。这里与生产对齐。
  //   档案 token 的「装配后再叠」收口已退场（档案货物并进 `preset:*` 合并材料）。
  return assembleGlobalPresetReducer(
    state,
    expandGlobalPresetZoneRefs(preset.interfaceMode, refs),
    { appliedName: preset.name },
  )
}

/** 一条预设的五区取值切片（`zoneRefs` 缺省时用来构造「整份 theme 的 5 个切面」）。 */
function slicesOf(preset: GlobalPreset, presetName = preset.name): GlobalPresetZoneSlice[] {
  return PRESET_ZONES.map(zone => ({ zone, presetName, theme: pickZoneFields(effectivePresetTheme(preset), zone) }))
}

function baseState(): ThemePresetState {
  return {
    ...DEFAULTS,
    appliedPreset: { ...DEFAULTS.appliedPreset },
    custom: { ...DEFAULTS.custom },
    customPresets: [],
  } as unknown as ThemePresetState
}

/** `DEFAULTS` 的键值视图（`DEFAULTS` 的类型是 `ThemeSettings`，不能用任意字符串下标）。 */
const DEFAULTS_RECORD = DEFAULTS as unknown as Record<string, string | number | boolean | undefined>
function defaultOf(key: string): string | number | boolean | undefined {
  return DEFAULTS_RECORD[key]
}

/** 该预设**没有**写、且 `DEFAULTS` 有标量默认值的预设域字段（B3 用它构造「用户改过」的现场）。 */
function uncoveredScalarKeys(preset: GlobalPreset): string[] {
  const written = filterPresetTheme(boxedTheme(preset)) as Record<string, unknown>
  return THEME_PRESET_KEYS.filter(key => {
    const fallback = defaultOf(key)
    const scalar = typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean'
    return scalar && !(key in written)
  })
}

function dirtyValueFor(key: string): string | number | boolean {
  const fallback = defaultOf(key)
  if (typeof fallback === 'number') return fallback + 37
  if (typeof fallback === 'boolean') return !fallback
  return 'zz-刀1-dirty'
}

/** 用户拖拽过的中控排布（若装配路径不重新归一，它会原样留下）。 */
function dirtyCcLayout(): CcLayoutV3 {
  const layout = cloneCcLayout(DEFAULT_CC_LAYOUT)
  layout.placements.model = { order: 9, offsetX: 12, offsetY: 0 }
  return layout
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
  useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
})

// ── B1 引用表覆盖完整 ──────────────────────────────────────────────

describe('B1 引用表覆盖完整（缺项必须抛错，不是静默回落）', () => {
  it('10 套出厂预设的 zoneRefs 精确覆盖 PRESET_ZONES 全部 5 项，且每一项都能在同桶同区域内解析到', () => {
    expect(GLOBAL_PRESETS).toHaveLength(10)
    for (const preset of GLOBAL_PRESETS) {
      const refs = requireZoneRefs(preset.zoneRefs, `出厂预设 ${preset.name}`)
      expect(Object.keys(refs).sort(), preset.name).toEqual([...PRESET_ZONES].sort())
      // 解析：跨桶 / 跨区域 / 不存在的引用都会在这里抛错
      const slices = expandGlobalPresetZoneRefs(preset.interfaceMode, refs)
      expect(slices.map(slice => slice.zone), preset.name).toEqual([...PRESET_ZONES])
      for (const slice of slices) {
        expect(slice.theme, `${preset.name}/${slice.zone} 必须有可应用的取值`).toBeTruthy()
        expect(Object.keys(slice.theme).length, `${preset.name}/${slice.zone} 不能是空切片`).toBeGreaterThan(0)
      }
    }
  })

  it('缺任意一项都抛错，缺表 / 空值 / 非区域键同样抛错', () => {
    // ★ #607 刀3a：消息流区是**双引用**（`{ style, color }`）——引用表的合法形状。
    const complete = {
      global: 'factory:glass:global',
      sidebar: 'factory:glass:sidebar',
      chat: { style: 'factory:glass:chat:style', color: 'factory:glass:chat:color' },
      cc: 'factory:glass:cc',
      right: 'factory:glass:right',
    }
    expect(() => requireZoneRefs(complete, 'X')).not.toThrow()
    expect(() => requireZoneRefs(undefined, 'X')).toThrow(/缺少区域引用表/)
    for (const zone of PRESET_ZONES) {
      const partial = Object.fromEntries(Object.entries(complete).filter(([key]) => key !== zone))
      expect(() => requireZoneRefs(partial, 'X'), `缺 ${zone} 必须抛错`).toThrow(new RegExp(`缺项.*${zone}`))
    }
    expect(() => requireZoneRefs({ ...complete, cc: '   ' }, 'X')).toThrow(/缺项/)
    expect(() => requireZoneRefs({ ...complete, layout: 'glass' }, 'X')).toThrow(/非区域键/)
    // 消息流双引用自身的缺项 / 空值 / 多余键：同样抛错，不静默降级成单引用
    expect(() => requireZoneRefs({ ...complete, chat: 'factory:glass:chat:style' }, 'X')).toThrow(/缺项.*chat/)
    expect(() => requireZoneRefs({ ...complete, chat: { style: 'x' } }, 'X')).toThrow(/消息流双引用缺项/)
    expect(() => requireZoneRefs({ ...complete, chat: { style: 'x', color: '  ' } }, 'X')).toThrow(/消息流双引用缺项/)
    expect(() => requireZoneRefs({ ...complete, chat: { style: 'x', color: 'y', extra: 'z' } }, 'X')).toThrow(/消息流双引用含非轴键/)
  })

  it('两条默认预设没有引用表（结构性保证：它们走「整份 theme」回落路径）', () => {
    for (const bucket of ['gui', 'terminal'] as const) {
      const preset = DEFAULT_PRESETS[bucket]
      expect(preset.zoneRefs, `${preset.name} 本刀不加引用表`).toBeUndefined()
      // 它们不在 GLOBAL_PRESETS 里 ⇒ planGlobalPreset 根本不会给它们排装配计划
      expect(planGlobalPreset(preset.name)).toEqual({ kind: 'skip' })
    }
  })

  it('planGlobalPreset 给 10 套出厂预设排出的计划都带上完整引用表', () => {
    for (const preset of GLOBAL_PRESETS) {
      const plan = planGlobalPreset(preset.name)
      if (plan.kind !== 'apply') throw new Error(`${preset.name} 应可应用`)
      expect(plan.interfaceMode, preset.name).toBe(preset.interfaceMode)
      expect(plan.zoneRefs ? Object.keys(plan.zoneRefs).sort() : null, preset.name).toEqual([...PRESET_ZONES].sort())
    }
  })
})

// ── B2 新旧装配等价 ───────────────────────────────────────────────

describe('B2 新旧装配等价（旧路径保留为参考实现）', () => {
  it('10 套出厂预设：新路径 patch 与旧路径逐键逐值深度相等', () => {
    const state = baseState()
    for (const preset of GLOBAL_PRESETS) {
      const reference = legacyPatch(preset)
      const assembled = assembleFromRefs(state, preset)
      expect(Object.keys(assembled).sort(), `${preset.name} 键集`).toEqual(Object.keys(reference).sort())
      expect(assembled, `${preset.name} 逐字段`).toEqual(reference)
    }
  })

  it('带呈现方案的三套：档案货物由合并材料给出（值与本单前逐字段相同）', () => {
    const state = baseState()
    for (const name of ['agent-command', 'agent-map', 'focus-flow'] as const) {
      const preset = GLOBAL_PRESETS.find(candidate => candidate.name === name)!
      const tokens = profileTokensOf(preset)
      expect(tokens, `${name} 必须绑定呈现方案`).toBeTruthy()
      const assembled = assembleFromRefs(state, preset)
      // ★ #607 刀3a：档案 token 不再「装配后叠」——它们已并进 `preset:*` 合并材料，
      //   所以这些键的值仍必须在装配结果里（只是来源从覆盖层换成材料）。
      for (const [key, value] of Object.entries(tokens!)) {
        expect((assembled as Record<string, unknown>)[key], `${name}/${key}`).toBe(value)
      }
      // 且仍与「改造前那条路」（effectivePresetTheme ⊕ profile.tokens 整份写）等价
      expect(assembled).toEqual(legacyPatch(preset))
    }
  })

  it('两条默认预设：五区切面拼起来等于整份主题 ⇒ 「无引用表就整份写」与逐区域装配等价', () => {
    const state = baseState()
    for (const bucket of ['gui', 'terminal'] as const) {
      const preset = DEFAULT_PRESETS[bucket]
      const union = Object.assign({}, ...slicesOf(preset).map(slice => slice.theme))
      expect(filterPresetTheme(union), `${preset.name} 切面并集`).toEqual(filterPresetTheme(effectivePresetTheme(preset)))
      // 真的装一遍：取值与旧路径一致，记名统一为空串（见 B6）
      expect(assembleGlobalPresetReducer(state, slicesOf(preset), { appliedName: '' }))
        .toEqual(setGlobalPresetReducer('', effectivePresetTheme(preset)))
    }
  })

  it('切面不丢字段：10 套出厂预设逐个对拍「并集 == filterPresetTheme(整份 theme)」', () => {
    // 比的是**预设自带的那份 theme**：呈现方案的 token 不走切面，它在装配之后单独叠加（见上一条用例）
    for (const preset of GLOBAL_PRESETS) {
      const union = Object.assign({}, ...slicesOf(preset).map(slice => slice.theme))
      expect(filterPresetTheme(union), `${preset.name} 切面并集`).toEqual(filterPresetTheme(effectivePresetTheme(preset)))
    }
  })
})

// ── B3 全量换装语义 ───────────────────────────────────────────────

describe('B3 全量换装语义（预设没覆盖的字段回默认值，不保留用户当前值）', () => {
  it('纯层：先把字段改成非默认值，装配后必须回到 DEFAULTS', () => {
    // ★ 终端那 6 套在出厂数据里就已补满全字段（191/191）⇒「预设未覆盖的字段」为 0，
    //   铺底在那条路上无从观测；GUI 桶（glass 69 / solarized 191 / 三套 agent 各 36）覆盖面参差，
    //   才有可观测的未覆盖字段。这条用例专门盯 GUI 桶。
    const guiPresets = GLOBAL_PRESETS.filter(preset => preset.interfaceMode === 'gui')
    expect(guiPresets.length, 'GUI 桶应有 5 套').toBe(5)
    let observed = 0
    for (const preset of guiPresets) {
      const keys = uncoveredScalarKeys(preset).slice(0, 5)
      if (keys.length === 0) continue
      observed += 1
      const dirtied = Object.fromEntries(keys.map(key => [key, dirtyValueFor(key)]))
      const state = { ...baseState(), ...dirtied } as ThemePresetState
      for (const key of keys) expect((state as unknown as Record<string, unknown>)[key], `${preset.name}/${key} 前置脏值`).not.toBe(defaultOf(key))

      const assembled = assembleFromRefs(state, preset) as Record<string, unknown>
      for (const key of keys) expect(assembled[key], `${preset.name}/${key} 必须回默认值`).toBe(defaultOf(key))
    }
    expect(observed, '至少要有一套 GUI 预设存在未被覆盖的标量字段，否则这条断言是空洞的').toBeGreaterThan(0)
  })

  it('真实事务：用户改过的字段在 applyGlobalPreset 之后回默认值', () => {
    const preset = GLOBAL_PRESETS.find(candidate => candidate.name === 'glass')!
    const keys = uncoveredScalarKeys(preset).slice(0, 3)
    const dirtied = Object.fromEntries(keys.map(key => [key, dirtyValueFor(key)]))
    useThemeStore.setState(dirtied as unknown as Partial<ThemeSettings>)
    for (const key of keys) expect((useThemeStore.getState() as unknown as Record<string, unknown>)[key], key).not.toBe(defaultOf(key))

    expect(applyGlobalPreset('glass')).toBe(true)

    for (const key of keys) {
      expect((useThemeStore.getState() as unknown as Record<string, unknown>)[key], `${key} 必须回默认值`).toBe(defaultOf(key))
    }
  })
})

// ── B4 cc 区特殊处理保留 ──────────────────────────────────────────

describe('B4 cc 区特殊处理在逐区域路径上仍生效', () => {
  it('ccLayout 归一：用户拖过的排布被打回规范排布（预设不携带 ccLayout）', () => {
    for (const preset of GLOBAL_PRESETS) {
      const state = { ...baseState(), ccLayout: dirtyCcLayout(), ccHeight: 99999 } as ThemePresetState
      const assembled = assembleFromRefs(state, preset)
      expect(assembled.ccLayout, `${preset.name} ccLayout 应归一`).toEqual(DEFAULT_CC_LAYOUT)
      expect(assembled.ccLayout, `${preset.name} 与旧路径一致`).toEqual(legacyPatch(preset).ccLayout)
    }
  })

  it('ccHeight 收敛：装配必过 clamp 漏斗（★ 刀9~11：下界已是常量 64，上界 400）', () => {
    const claude = GLOBAL_PRESETS.find(candidate => candidate.name === 'claude')!
    const ccSlice = filterPresetTheme(pickZoneFields(effectivePresetTheme(claude), 'cc')) as Partial<ThemeSettings>
    expect(ccSlice.ccHeight, 'claude 预设里的裸 ccHeight').toBe(76)
    // ★ #266 刀9~11：形态固定 ⇒ 最小高为常量 64。76 在 [64,400] 区间内 ⇒ 原样穿过
    //   （原先"裸值必被抬高"是因为 peri 形态的下界 84/109，该形态已删除）。
    expect(clampPresetCcHeight(ccSlice), '区间内原样').toBe(76)
    expect(clampPresetCcHeight({ ...ccSlice, ccHeight: 0 }), '低于下界必被抬到常量 64').toBe(64)

    const assembled = assembleFromRefs(baseState(), claude)
    expect(assembled.ccHeight).toBe(clampPresetCcHeight(ccSlice))
    expect(assembled.ccHeight).toBe(legacyPatch(claude).ccHeight)
    expect(assembled.ccHeight).not.toBe(99999)
  })
})

// ── B5 不许串区 ───────────────────────────────────────────────────

describe('B5 不许串区（用户点名）', () => {
  it('出厂区域预设的**全部值键**都属于它自己那个区域（判据 ZONE_FIELDS）', () => {
    let checked = 0
    for (const bucket of ['gui', 'terminal'] as const) {
      for (const zone of PRESET_ZONES) {
        for (const entry of ZONE_PRESET_POOL[bucket][zone]) {
          const values = resolveZonePresetEntryTheme(entry)
          expect(values, `${bucket}/${zone}/${entry.id} 必须可解析`).toBeTruthy()
          // ★ #607 刀3a：池的来源换成落点材料 ⇒ 条目 = `factory:*` 那批（60 条）。
          //   ★ 待迁边线 `inputBorderColor`（字段归属表里仍写 global）按合同归 **cc 材料**
          //   ⇒ 它是唯一允许出现在非 global 切片里的键；其余越区键照样红。
          const foreign = Object.keys(values!).filter(key => key !== 'inputBorderColor' && !ZONE_FIELDS[zone].includes(key as never))
          expect(foreign, `${bucket}/${zone}/${entry.id} 出现越区键`).toEqual([])
          if (Object.hasOwn(values!, 'inputBorderColor')) {
            expect(zone, `${bucket}/${entry.id} 待迁边线只归 cc`).toBe('cc')
          }
          checked += 1
        }
      }
    }
    expect(checked, '出厂区域预设条目数（40 非 chat + 10×2 轴）').toBe(60)
  })

  it('装配 zone = X 时，X 区以外的字段一个都没变（逐区逐字段对拍）', () => {
    for (const preset of GLOBAL_PRESETS) {
      const refs = requireZoneRefs(preset.zoneRefs, `出厂预设 ${preset.name}`)
      for (const zone of PRESET_ZONES) {
        // 现场：每个区域都先放上「非默认」的值，改动才看得见
        const initialState = baseState() as unknown as Record<string, unknown>
        for (const key of THEME_PRESET_KEYS) {
          if (typeof defaultOf(key) === 'string' || typeof defaultOf(key) === 'number' || typeof defaultOf(key) === 'boolean') {
            initialState[key] = dirtyValueFor(key)
          }
        }
        const slice = expandGlobalPresetZoneRefs(preset.interfaceMode, refs).find(item => item.zone === zone)!
        const patch = applyZonePresetReducer(initialState as unknown as ThemePresetState, zone, slice.presetName, slice.theme)
        const after = { ...initialState, ...patch } as Record<string, unknown>

        for (const other of PRESET_ZONES.filter(candidate => candidate !== zone)) {
          for (const field of ZONE_FIELDS[other]) {
            expect(after[field], `${preset.name}：装配 ${zone} 时动了 ${other} 区的 ${field}`).toBe(initialState[field])
          }
        }
      }
    }
  })

  it('装配整套之后，各区域切面逐区等于旧路径的对应切面（没有一块串到别人身上）', () => {
    const state = baseState()
    for (const preset of GLOBAL_PRESETS) {
      const reference = legacyPatch(preset) as Record<string, unknown>
      const assembled = assembleFromRefs(state, preset) as unknown as Record<string, unknown>
      for (const zone of PRESET_ZONES) {
        expect(pickZoneFields(assembled as never, zone), `${preset.name}/${zone}`).toEqual(pickZoneFields(reference as never, zone))
      }
    }
  })

  it('越区键必须**报错**，不是静默丢弃', () => {
    expect(() => assertZoneSliceOwnership('cc', { ccBg: '#000' }, 'X')).not.toThrow()
    expect(() => assertZoneSliceOwnership('cc', { sidebarBg: '#000' }, 'X')).toThrow(/越区/)
    expect(() => assertZoneSliceOwnership('cc', { ccBg: '#000', sidebarBg: '#000' }, 'X')).toThrow(/sidebarBg/)

    // 走完整装配也一样报错（引用解析出来的切片直接被校验）
    const claude = GLOBAL_PRESETS.find(candidate => candidate.name === 'claude')!
    const refs = requireZoneRefs(claude.zoneRefs, 'X')
    const slices = expandGlobalPresetZoneRefs(claude.interfaceMode, refs)
    const poisoned = slices.map(slice => slice.zone === 'cc' ? { ...slice, theme: { ...slice.theme, sidebarBg: '#000' } } : slice)
    expect(() => assembleGlobalPresetReducer(baseState(), poisoned)).toThrow(/越区/)
  })

  it('区域引用指向别的区域 / 别的桶 / 不存在 ⇒ 报错（不是静默回落）', () => {
    const claude = GLOBAL_PRESETS.find(candidate => candidate.name === 'claude')!
    const refs = requireZoneRefs(claude.zoneRefs, 'X')
    // 别的桶：claude 只属于终端桶，拿它当 GUI 桶的引用解析不到
    expect(() => expandGlobalPresetZoneRefs('gui', refs)).toThrow(/解析不到/)
    // 不存在 / 别的区域：left 栏没有这条条目
    expect(() => expandGlobalPresetZoneRefs('terminal', { ...refs, cc: 'glass' })).toThrow(/解析不到/)
    expect(() => expandGlobalPresetZoneRefs('terminal', { ...refs, cc: 'zone-terminal-cc-1' })).toThrow(/解析不到/)
  })
})

// ── B6 重置路径记名 ──────────────────────────────────────────────

describe('B6 重置路径记名（取值用引用、记名用空串）', () => {
  it('装配层把「取值的引用」与「写进 appliedPreset 的名字」分开', () => {
    const preset = DEFAULT_PRESETS.gui
    const slices = slicesOf(preset, preset.name)
    const diffKey = THEME_PRESET_KEYS.find(
      key => effectivePresetTheme(preset)[key] !== undefined && effectivePresetTheme(preset)[key] !== defaultOf(key),
    )
    expect(diffKey, '默认预设至少有一个字段与 DEFAULTS 不同，否则这条断言是空洞的').toBeTruthy()

    // appliedName = ''（重置路径）：值仍取自默认预设，但 5 个区域一律不记名
    const reset = assembleGlobalPresetReducer(baseState(), slices, { appliedName: '' })
    for (const zone of PRESET_ZONES) {
      expect(reset.appliedPreset?.[zone], `${zone}.appliedPreset`).toBe('')
      expect(reset.custom?.[zone], `${zone}.custom`).toBe(false)
    }
    expect((reset as Record<string, unknown>)[diffKey!]).toBe(effectivePresetTheme(preset)[diffKey!])

    // 省略 appliedName（刀4 的用法）：逐区域记各自的引用 id
    const named = assembleGlobalPresetReducer(baseState(), slices)
    for (const zone of PRESET_ZONES) expect(named.appliedPreset?.[zone], `${zone}.appliedPreset`).toBe(preset.name)
  })

  it('store.resetTheme：5 区基准留空 + 值确实取自当前模式的默认预设', () => {
    for (const mode of ['modern-gui', 'terminal-like'] as const) {
      resetStores()
      useInterfaceModeStore.setState({ interfaceMode: mode })
      useThemeStore.getState().resetTheme()

      for (const zone of PRESET_ZONES) {
        expect(useThemeStore.getState().appliedPreset[zone], `${mode}/${zone}`).toBe('')
        expect(useThemeStore.getState().custom[zone], `${mode}/${zone}`).toBe(false)
      }

      // 值与「只留空标记」不同：确实取了当前模式默认预设的值
      const preset = DEFAULT_PRESETS[mode === 'modern-gui' ? 'gui' : 'terminal']
      const diffKey = THEME_PRESET_KEYS.find(
        key => effectivePresetTheme(preset)[key] !== undefined && effectivePresetTheme(preset)[key] !== defaultOf(key),
      )!
      expect(
        (useThemeStore.getState() as unknown as Record<string, unknown>)[diffKey],
        `${mode}/${diffKey} 应等于默认预设的值`,
      ).toBe(effectivePresetTheme(preset)[diffKey])
    }
  })

  it('store.resetTheme：不亮兜底 chip（按默认预设名记名就会亮出「未知预设」）', () => {
    for (const mode of ['modern-gui', 'terminal-like'] as const) {
      resetStores()
      useInterfaceModeStore.setState({ interfaceMode: mode })
      useThemeStore.getState().resetTheme()

      const status = deriveGlobalStatus(useThemeStore.getState())
      // 先断言 chip：这条才是「按默认预设名记名」的直接症状
      expect(fallbackPresetChip(status, []), `${mode} 不得亮兜底 chip`).toBeNull()
      expect(status, mode).toBe('')
    }
  })
})
