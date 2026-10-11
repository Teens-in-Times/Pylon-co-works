// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * 刀7（#214）：两套默认预设（`GUI-默认预设` / `终端-默认预设`）。
 *
 * 两条约束一起锁：
 * 1. **不显示**——预设菜单 chip 行与刀6 区域候选池里都找不到它们（列表/池仍各 5 条）；
 * 2. **重置落点**——`store.resetTheme` 回到「当前界面模式的默认预设」，未登记模式回落 `DEFAULTS`。
 */
// #515 改写点登记（迁移自 defaultPresets.test.ts，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library；显式 afterEach(cleanup)；文件随 solid 测试惯例
//   改名 .solid.test.tsx。
// - React act 包装（withInterfaceMode）改直调 setState；「区域行」断言等 ZonePresetSection
//   渲染落地（Solid effect 提交异步）再跑。断言集不缩减。
import { cleanup, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PRESETS,
  GLOBAL_PRESETS,
  defaultPresetForInterfaceMode,
  fallbackPresetChip,
  presetsForInterfaceMode,
} from '../domains/theme/presets/index.ts'
import { PRESET_ZONES, deriveGlobalStatus, filterPresetTheme } from '../domains/theme/presetReducer.ts'
import { THEME_PRESET_KEYS } from '../domains/theme/themeFieldDefs.ts'
import { DEFAULTS } from '../domains/theme/themeDefaults.ts'
import { ZONE_PRESET_POOL, effectivePresetTheme, pickZoneFields, zonePresetsFor } from '../domains/theme/zones/index.ts'
import { useThemeStore } from '../domains/theme/themeStore.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { activateInterfaceMode, resetThemeForActiveInterfaceMode } from '../application/transactions/activateInterfaceMode.ts'
import { lastSettingWriter } from '../domains/theme/settingProvenance.ts'
// 真实事务需要完整第一方注册表（界面模式 / 呈现风格 / 渲染器套件 / Shell 配方）
import '../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { mountSettingsSheet } from '../test/settingsSheetHarness.solid'
import { resetStores } from '../test/resetStores.ts'

vi.mock('../components/settings/AgentRuntimePanel.solid.tsx', () => ({ default: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const GLASS = GLOBAL_PRESETS.find(preset => preset.name === 'glass')!
/**
 * 终端契约字段（原「终端补全」层里的同一组字段；刀3 起该层已无）。
 * ★ #266 刀9：原第 3/4 项 `inputMode` / `inputVariant` 已随「固定命令行」删除
 *   （形态不再由预设区分）。
 * ★ #266 CC-18：`ccMarginX: 0` 进这一组 —— 终端默认与 GUI 默认在这一字段上**有意不同**
 *   （中控右零点改挂滚动条左缘后，0 = 中控右缘与滚动条左缘齐平）。本文件两处比对都以本表为准：
 *   `重置后 == GUI 默认 + 终端契约字段`（下方那条用例）与同处的 glass 切面过滤。
 */
const TERMINAL_CONTRACT = {
  msgStyle: 'terminal',
  messageLayout: 'classic',
  ccMarginX: 0,
} as const
const DEFAULT_NAMES: string[] = [DEFAULT_PRESETS.gui.name, DEFAULT_PRESETS.terminal.name]
/**
 * 出厂预设内容的**模块加载时**快照。必须在这里取：若在被测用例内部取基准，同文件里
 * 先跑过的用例一旦已经把预设内容写脏（例如重置顺手改了共享 theme 对象），基准就被污染，
 * 「重置不写出厂预设」这条会变成永远绿——与测试顺序耦合的假测试。
 */
const PRISTINE_PRESET_THEMES = structuredClone(GLOBAL_PRESETS.map(preset => effectivePresetTheme(preset)))

/** 预设域字段快照（用于「重置 == 应用默认预设」的逐字段比对；标记另测）。 */
function themeSnapshot(): Record<string, unknown> {
  const state = useThemeStore.getState() as unknown as Record<string, unknown>
  return Object.fromEntries(THEME_PRESET_KEYS.map(key => [key, state[key]]))
}

function withInterfaceMode(mode: string): void {
  useInterfaceModeStore.setState({ interfaceMode: mode })
}

afterEach(async () => {
  cleanup()
})

describe('刀7 · 两条默认预设不显示（#214）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('不进列表、不进池：两桶各 5 条，池每格 5 条，GLOBAL_PRESETS 仍是 10 套', () => {
    for (const interfaceMode of ['modern-gui', 'terminal-like']) {
      const listed = presetsForInterfaceMode(interfaceMode)
      expect(listed, `${interfaceMode} 列表条数`).toHaveLength(5)
      expect(listed.some(preset => DEFAULT_NAMES.includes(preset.name))).toBe(false)
    }
    for (const [bucket, interfaceMode] of [['gui', 'modern-gui'], ['terminal', 'terminal-like']] as const) {
      for (const zone of PRESET_ZONES) {
        const entries = (ZONE_PRESET_POOL[bucket] as Record<string, { id: string }[]>)[zone]
        expect(entries, `${bucket}/${zone} 池条数`).toHaveLength(5)
        expect(entries.some(entry => DEFAULT_NAMES.includes(entry.id))).toBe(false)
      }
      expect(zonePresetsFor(interfaceMode, 'sidebar').some(entry => DEFAULT_NAMES.includes(entry.id))).toBe(false)
    }
    // 默认预设住在独立表里 ⇒ 出厂预设总数不变（docs「当前 10 套」不失真）
    expect(GLOBAL_PRESETS).toHaveLength(10)
    // 刀3：glass 不再自带 theme 对象 ⇒ 比的从"同一个对象"改为"同一份值"（有效值视图）
    expect(DEFAULT_PRESETS.gui.theme).toEqual(effectivePresetTheme(GLASS))
  })

  it('预设菜单里没有「默认预设」这类按钮（全局行 5 条 chip）', () => {
    mountSettingsSheet()
    const group = within(screen.getByText('全局预设').closest('.set-group') as HTMLElement)
    const row = within(group.getByText('全局预设').closest('.set-group')?.querySelector('.set-preset-row') as HTMLElement)
    expect(row.getAllByRole('button')).toHaveLength(5)
    for (const label of [DEFAULT_PRESETS.gui.label, DEFAULT_PRESETS.terminal.label]) {
      expect(group.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('区域行里也没有它们（候选仍是该格 5 条出厂条目）', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    // 局部预设组由 ZonePresetSection（Solid 直连）承载，渲染提交异步——先等组标题落地
    await vi.waitFor(() => {
      expect(screen.getByText('局部预设')).toBeInTheDocument()
    })
    const group = within(screen.getByText('局部预设').closest('.set-group') as HTMLElement)
    for (const entry of ZONE_PRESET_POOL.gui.sidebar) {
      expect(group.getByRole('button', { name: entry.label })).toBeInTheDocument()
    }
    for (const label of [DEFAULT_PRESETS.gui.label, DEFAULT_PRESETS.terminal.label]) {
      expect(group.queryByText(label)).not.toBeInTheDocument()
    }
  })
})

describe('刀7 · 「重置主题」落点（#214）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('modern-gui 模式：重置后 == 应用 GUI-默认预设（内容即 glass），且覆盖范围与原来一致', () => {
    // 参照基准：直接应用 glass 全局预设
    useThemeStore.getState().setGlobalPreset('glass', effectivePresetTheme(GLASS))
    const appliedGlass = themeSnapshot()

    resetStores()
    withInterfaceMode('modern-gui')
    useThemeStore.setState({ sidebarWidth: 333, accent: '#000000', chatBgImage: 'junk.png' })
    useThemeStore.getState().resetTheme()

    expect(themeSnapshot()).toEqual(appliedGlass)
    // 覆盖范围未缩水：非预设域字段（归属工作区布局）也被打回默认
    expect(useThemeStore.getState().sidebarWidth).toBe(DEFAULTS.sidebarWidth)
    // 四区逐一切面确实等于 glass 的对应切面（按「可应用」白名单：rightWidth/sidebarWidth
    // 归属工作区布局与右栏，任何预设路径都不写它们，glass 的这两条值本来就不落地）
    const glassApplicable = filterPresetTheme(effectivePresetTheme(GLASS))
    for (const zone of PRESET_ZONES) {
      expect(pickZoneFields(useThemeStore.getState() as never, zone), `重置后 ${zone} 切面`).toMatchObject(pickZoneFields(glassApplicable, zone))
    }
  })

  it('terminal-like 模式：重置后 == GUI 默认 + 终端契约字段', () => {
    withInterfaceMode('modern-gui')
    useThemeStore.getState().resetTheme()
    const guiDefault = themeSnapshot()

    withInterfaceMode('terminal-like')
    useThemeStore.setState({ accent: '#000000', msgStyle: 'bubble' })
    useThemeStore.getState().resetTheme()

    expect(themeSnapshot()).toEqual({ ...guiDefault, ...TERMINAL_CONTRACT })
    for (const [key, value] of Object.entries(TERMINAL_CONTRACT)) {
      expect((useThemeStore.getState() as unknown as Record<string, unknown>)[key], key).toEqual(value)
    }
    // 且确实落在了 glass 的外观上（不是「只带契约字段的 DEFAULTS」——否则这条测试
    // 在「重置忽略默认预设」的改坏下也能通过，等于没锁住终端那半）
    for (const zone of PRESET_ZONES) {
      // glass 侧先摘掉契约字段（那是终端默认要覆盖过去的那几个）
      const glassSlice = Object.fromEntries(
        Object.entries(pickZoneFields(filterPresetTheme(effectivePresetTheme(GLASS)), zone))
          .filter(([key]) => !(key in TERMINAL_CONTRACT)),
      )
      expect(pickZoneFields(useThemeStore.getState() as never, zone), `终端重置后 ${zone} 切面`)
        .toMatchObject(glassSlice)
    }
  })

  it('★ #266 CC-18：中控右零点挂滚动条 —— 终端默认落 0，GUI 默认与 6 条出厂条目不动', () => {
    // 1) 终端默认（本件唯一改动的落点）：右零点挂滚动条左缘 ⇒ 0 = 中控右缘与滚动条左缘齐平
    expect(DEFAULT_PRESETS.terminal.theme.ccMarginX).toBe(0)
    withInterfaceMode('terminal-like')
    useThemeStore.getState().resetTheme()
    expect(useThemeStore.getState().ccMarginX).toBe(0)

    // 2) GUI-默认不含该键 ⇒ 生效值回落字段默认（本件未动 GUI 默认 ⇒ GUI 重置后仍 15）
    expect(DEFAULT_PRESETS.gui.theme.ccMarginX).toBeUndefined()
    withInterfaceMode('modern-gui')
    useThemeStore.getState().resetTheme()
    expect(useThemeStore.getState().ccMarginX).toBe(DEFAULTS.ccMarginX)

    // 3) 出厂预设里已写的 6 处仍是 15（用户 2026-10-09：「那几个都不管」）—— 逐条点名，防漏防多
    const carrying = GLOBAL_PRESETS
      .map(preset => ({
        name: preset.name,
        value: (pickZoneFields(effectivePresetTheme(preset) as never, 'cc') as Record<string, unknown>).ccMarginX,
      }))
      .filter(entry => entry.value !== undefined)
    expect(carrying.map(entry => entry.name).sort()).toEqual(['amber', 'claude', 'matrix', 'nord', 'solarized', 'tokyo'])
    for (const entry of carrying) expect(entry.value, entry.name).toBe(15)
  })

  it('未登记模式（tactical-blue）：回落 DEFAULTS、不报错、不悬空', () => {
    withInterfaceMode('tactical-blue')
    expect(defaultPresetForInterfaceMode('tactical-blue')).toBeUndefined()
    expect(defaultPresetForInterfaceMode('plugin-registered-unknown')).toBeUndefined()

    useThemeStore.setState({ accent: '#000000', chatBg: '#000000' })
    expect(() => useThemeStore.getState().resetTheme()).not.toThrow()

    expect(useThemeStore.getState().accent).toBe(DEFAULTS.accent)
    expect(useThemeStore.getState().chatBg).toBe(DEFAULTS.chatBg)
    for (const zone of PRESET_ZONES) {
      expect(useThemeStore.getState().appliedPreset[zone]).toBe('')
      expect(useThemeStore.getState().custom[zone]).toBe(false)
    }
  })

  it('重置后四区标记不悬空：基准留空、custom 清零，且不亮「未知预设」兜底 chip', () => {
    withInterfaceMode('terminal-like')
    useThemeStore.getState().resetTheme()

    for (const zone of PRESET_ZONES) {
      expect(useThemeStore.getState().appliedPreset[zone]).toBe('')
      expect(useThemeStore.getState().custom[zone]).toBe(false)
    }
    const status = deriveGlobalStatus(useThemeStore.getState())
    expect(status).toBe('')
    expect(fallbackPresetChip(status, [])).toBeNull()
  })

  it('铁律 1 不变：重置不修改任何出厂预设的内容', () => {
    for (const mode of ['modern-gui', 'terminal-like', 'tactical-blue']) {
      withInterfaceMode(mode)
      useThemeStore.getState().resetTheme()
    }
    // 刀3：预设不再自带 theme ⇒ 比有效值视图（否则两边都是 undefined，这条守卫会变成永远绿）
    expect(GLOBAL_PRESETS.map(preset => effectivePresetTheme(preset))).toEqual(PRISTINE_PRESET_THEMES)
    expect(GLOBAL_PRESETS).toHaveLength(10)
  })

  it('两条默认预设的形状：名字/标签/桶归属，且解析器按桶取', () => {
    expect(DEFAULT_PRESETS.gui).toMatchObject({ name: 'gui-default', label: 'GUI-默认预设', interfaceMode: 'gui' })
    expect(DEFAULT_PRESETS.terminal).toMatchObject({ name: 'terminal-default', label: '终端-默认预设', interfaceMode: 'terminal' })
    expect(defaultPresetForInterfaceMode('modern-gui')).toBe(DEFAULT_PRESETS.gui)
    expect(defaultPresetForInterfaceMode('terminal-like')).toBe(DEFAULT_PRESETS.terminal)
    // 终端默认 = glass 副本 + 契约（浅色那款；深色预设一条都不用）
    expect(DEFAULT_PRESETS.terminal.theme).toMatchObject({ ...effectivePresetTheme(GLASS), ...TERMINAL_CONTRACT })
  })
})

describe('刀7 §六 · 呈现方案写入不置 custom（#214）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  /** 全局预设组的兜底 chip（`fallbackPresetChipView.label === '自定义'`）在不在。 */
  function fallbackCustomChipRendered(): boolean {
    mountSettingsSheet()
    const group = within(screen.getByText('全局预设').closest('.set-group') as HTMLElement)
    return group.queryByText('自定义') !== null
  }

  it('★ 真实事务 resetThemeForActiveInterfaceMode：全空 + 无 custom + 兜底「自定义」chip 不渲染', () => {
    // 事务必须真的生效——返回 false 时它连 resetTheme 都不跑，后面全是假绿
    expect(resetThemeForActiveInterfaceMode()).toBe(true)

    expect(deriveGlobalStatus(useThemeStore.getState())).toBe('')
    for (const zone of PRESET_ZONES) expect(useThemeStore.getState().custom[zone], `${zone}.custom`).toBe(false)
    // 被呈现方案 token 写过的两区单独点名（本 bug 的直接现场）
    expect(useThemeStore.getState().custom.chat).toBe(false)
    expect(useThemeStore.getState().custom.cc).toBe(false)
    expect(fallbackCustomChipRendered()).toBe(false)
    // 施工单 §六 原话口径：界面上 queryByText('自定义') 为 null（整屏，不只预设组内）
    expect(screen.queryByText('自定义')).not.toBeInTheDocument()
  })

  it('切换界面模式（modern-gui ⇄ terminal-like）同样不误标', () => {
    expect(activateInterfaceMode('terminal-like')).toBe(true)
    expect(activateInterfaceMode('modern-gui')).toBe(true)

    expect(deriveGlobalStatus(useThemeStore.getState())).not.toBe('custom')
    for (const zone of PRESET_ZONES) expect(useThemeStore.getState().custom[zone], `${zone}.custom`).toBe(false)
    expect(fallbackCustomChipRendered()).toBe(false)
  })

  it('其余 source 语义一字不动：user-edit / field-reset 仍置 custom，只有呈现方案例外', () => {
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 18 })                       // 缺省 user-edit
    expect(useThemeStore.getState().custom.chat).toBe(true)

    useThemeStore.getState().setZoneField('sidebar', { sidebarBg: '#123456' }, 'field-reset')
    expect(useThemeStore.getState().custom.sidebar).toBe(true)

    useThemeStore.getState().setZoneField('right', { rightBg: '#123456' }, 'presentation-profile')
    expect(useThemeStore.getState().custom.right).toBe(false)
    // 溯源账本照旧记录该来源（D-trace 语义不变，只改 custom 标记）
    expect(lastSettingWriter('rightBg')?.source).toBe('presentation-profile')
  })
})
