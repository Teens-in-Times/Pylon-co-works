import { describe, expect, it, vi } from 'vitest'
import { cloneCcLayout } from '../../cc/ccLayoutState.ts'
import { DEFAULTS } from '../../theme/themeDefaults.ts'
import { GLOBAL_PRESETS } from '../../theme/presets/index.ts'
import { effectivePresetTheme } from '../../theme/zones/index.ts'
import type { ThemeSettings } from '../../theme/themeStore.ts'
import { selectWorkbenchAppearance } from '../appearance.ts'
import {
  createStaticWorkbenchAppearanceStore,
  createVanillaWorkbenchAppearanceStore,
} from '../workbenchAppearanceStore.ts'

function theme(overrides: Partial<ThemeSettings> = {}): ThemeSettings {
  return {
    ...structuredClone(DEFAULTS),
    ...structuredClone(overrides),
    ccLayout: cloneCcLayout(overrides.ccLayout ?? DEFAULTS.ccLayout),
  }
}

describe('CC-21 appearance input font', () => {
  it('follow font updates notify the appearance consumer without changing static typography', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({ inputFont: 'follow-message', msgFont: 'mono' }))
    const listener = vi.fn()
    store.subscribe(listener)
    store.setTheme(theme({ inputFont: 'follow-message', msgFont: 'serif' }))
    expect(store.getSnapshot().inputFontFamily).toBe('var(--font-serif-default, var(--serif))')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ inputFont: 'follow-message', inputHeight: 40, inputFontSize: 15, inputLineHeight: '1', ccHeight: DEFAULTS.ccHeight })
    store.destroy()
  })

  it('independent input font ignores message-only changes and preserves the plugin selection', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({ inputFont: 'vendor.input', msgFont: 'mono' }))
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSnapshot()
    store.setTheme(theme({ inputFont: 'vendor.input', msgFont: 'serif' }))
    expect(store.getSnapshot().inputFontFamily).toBe('var(--pylon-font-vendor-input, var(--font-system, var(--font)))')
    expect(store.getSnapshot().inputFont).toBe('vendor.input')
    expect(store.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    store.destroy()
  })
})

describe('selectWorkbenchAppearance', () => {
  it('fresh appearance 使用 A6-2 默认值', () => {
    expect(DEFAULTS).toMatchObject({
      ccBg: '#808080',
      ccMarginX: 15,
      ccMarginBottom: 15,
      ccRadius: 25,
      inputHeight: 40,
      inputFontSize: 15,
      inputLineHeight: '1',
      inputSurfaceBg: '#FFFFFF',
      inputSurfaceOpacity: 1,
      inputRadius: 20,
    })
  })

  it('只输出改变组件树/行为的结构字段，并冻结深层快照', () => {
    const source = theme({
      messageLayout: 'claude',
      inputOffsetTop: DEFAULTS.inputOffsetTop,
      inputHeight: DEFAULTS.inputHeight,
      inputMarginX: DEFAULTS.inputMarginX,
      inputSurfaceBg: DEFAULTS.inputSurfaceBg,
      inputSurfaceOpacity: DEFAULTS.inputSurfaceOpacity,
      inputBorder: DEFAULTS.inputBorder,
      inputBorderWidth: DEFAULTS.inputBorderWidth,
      inputBorderOpacity: DEFAULTS.inputBorderOpacity,
      inputRadius: DEFAULTS.inputRadius,
      inputFontSize: DEFAULTS.inputFontSize,
      inputTextColor: DEFAULTS.inputTextColor,
      inputPlaceholder: DEFAULTS.inputPlaceholder,
      assistantDot: true,
      ccHidden: ['send'],
      spinnerFramePreset: 'cc',
      spinnerVerbSet: 'engineering',
    })
    const snapshot = selectWorkbenchAppearance(source, 3)

    expect(snapshot).toMatchObject({
      revision: 3,
      messageLayout: 'claude',
      assistantDot: true,
      ccBg: DEFAULTS.ccBg,
      ccSurfaceOpacity: DEFAULTS.ccSurfaceOpacity,
      ccBgImage: DEFAULTS.ccBgImage,
      ccMarginX: DEFAULTS.ccMarginX,
      ccMarginBottom: DEFAULTS.ccMarginBottom,
      ccRadius: DEFAULTS.ccRadius,
      ccHidden: ['send'],
      spinner: { framePreset: 'cc', verbSet: 'engineering' },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.ccLayout)).toBe(true)
    expect(Object.isFrozen(snapshot.ccLayout.placements.input)).toBe(true)
    expect(Object.isFrozen(snapshot.ccHidden)).toBe(true)
    expect(Object.isFrozen(snapshot.ccProperties)).toBe(true)
    expect(Object.isFrozen(snapshot.spinner)).toBe(true)
  })

  it('开关字段按 shown/hidden 归一投影为布尔（A6-1-FIX 1.1/1.3）', () => {
    const snapshot = selectWorkbenchAppearance(theme({
      inputFocusRingEnabled: 'hidden',
      inputShadowEnabled: 'shown',
    }), 1)

    expect(snapshot.inputFocusRingEnabled).toBe(false)
    expect(snapshot.inputShadowEnabled).toBe(true)
  })

  it('custom spinner 使用自定义 frames/verbs，并收窄 interval', () => {
    const snapshot = selectWorkbenchAppearance(theme({
      spinnerFramePreset: 'custom',
      spinnerCustomFrames: '甲甲乙',
      spinnerVerbSet: 'custom',
      spinnerCustomVerbs: '读取, 验证\n构建',
      spinnerIntervalMs: 2,
    }), 0)

    expect(snapshot.spinner.frames).toEqual(['甲', '乙'])
    expect(snapshot.spinner.verbs).toEqual(['读取', '验证', '构建'])
    expect(snapshot.spinner.intervalMs).toBe(40)
  })

  it('动态枚举全部内置预设均可产生合法 snapshot', () => {
    for (const preset of GLOBAL_PRESETS) {
      const snapshot = selectWorkbenchAppearance(theme(preset.theme), 0)
      expect(snapshot.messageLayout, preset.name).toMatch(/classic|claude|bubble/)
      expect(snapshot.spinner.frames.length, preset.name).toBeGreaterThan(0)
    }
  })

  it('内置预设的非聊天界面统一使用系统字体', () => {
    for (const preset of GLOBAL_PRESETS) {
      expect(effectivePresetTheme(preset).globalFont ?? DEFAULTS.globalFont, preset.name).toBe('system')
    }
    expect(DEFAULTS.chatFont).toBe('mono')
    expect(DEFAULTS.msgFont).toBe('mono')
  })
})

describe('createStaticWorkbenchAppearanceStore', () => {
  it('非结构颜色变化不 bump revision，结构变化只通知一次', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())
    const listener = vi.fn()
    store.subscribe(listener)
    const initial = store.getSnapshot()

    store.setTheme(theme({ chatBg: '#123456' }))
    expect(store.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()

    store.setTheme(theme({ messageLayout: 'bubble' }))
    expect(store.getSnapshot().revision).toBe(1)
    expect(store.getSnapshot().messageLayout).toBe('bubble')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('中控背景色与背景图投影到快照并触发 Solid 外观更新', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())
    const listener = vi.fn()
    store.subscribe(listener)

    store.setTheme(theme({
      ccBg: '#123456',
      ccBgImage: 'data:image/png;base64,fixture',
      ccSurfaceOpacity: 72,
      ccMarginX: 32,
      ccMarginBottom: 14,
      ccRadius: 12,
    }))

    expect(store.getSnapshot()).toMatchObject({
      ccBg: '#123456',
      ccBgImage: 'data:image/png;base64,fixture',
      ccSurfaceOpacity: 72,
      ccMarginX: 32,
      ccMarginBottom: 14,
      ccRadius: 12,
      revision: 1,
    })
    expect(listener).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('appearance command 更新 fake theme，destroy 后停止通知', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())
    const listener = vi.fn()
    store.subscribe(listener)

    store.dispatch({ type: 'set-cc-hidden', id: 'tasks', hidden: true, target: 'base' })
    store.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(store.getSnapshot()).toMatchObject({
      ccHidden: ['tasks'],
      ccEditMode: true,
      // ★ 刀7：原先这里还有一次 `set-cc-scale`（三条命令 ⇒ revision 3 / 通知 3 次）。
      //   缩放命令已删 ⇒ 只剩两条命令，revision 与通知次数各随之下调 1。
      revision: 2,
    })

    store.destroy()
    store.dispatch({ type: 'set-cc-edit-mode', enabled: false })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().ccEditMode).toBe(true)
  })

  it('编辑命令更新高度、placement 与 schema 属性，并维持约束', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())

    store.dispatch({ type: 'set-cc-height', height: 160 })
    store.dispatch({ type: 'update-cc-placement', id: 'model', placement: { offsetX: 99, offsetY: -99 } })
    store.dispatch({ type: 'set-cc-property', key: 'modelSwitchMode', value: 'cycle' })

    expect(store.getSnapshot()).toMatchObject({ ccHeight: 160, modelSwitchMode: 'cycle' })
    expect(store.getSnapshot().ccProperties.modelSwitchMode).toBe('cycle')
    expect(store.getSnapshot().ccLayout.placements.model).toMatchObject({ offsetX: 48, offsetY: -16 })
    store.destroy()
  })

  it('clamps the edited input dimension against control-center height', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({ ccHeight: 150, inputOffsetTop: 20, inputHeight: 100 }))

    store.dispatch({ type: 'set-cc-property', key: 'inputHeight', value: 200 })
    expect(store.getSnapshot()).toMatchObject({ inputOffsetTop: 20, inputHeight: 130 })

    store.dispatch({ type: 'set-cc-property', key: 'inputOffsetTop', value: 140 })
    expect(store.getSnapshot()).toMatchObject({ inputHeight: 130, inputOffsetTop: 20 })

    store.dispatch({ type: 'set-cc-height', height: 100 })
    expect(store.getSnapshot().ccHeight).toBe(150)
    store.destroy()
  })

  it('applies input typography clamp priority and the height floor', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({ ccHeight: 150, inputHeight: 40, inputFontSize: 16, inputLineHeight: '1' }))
    store.dispatch({ type: 'set-cc-property', key: 'inputFontSize', value: 16 })
    expect(store.getSnapshot()).toMatchObject({ inputFontSize: 15, inputLineHeight: '1' })

    store.dispatch({ type: 'set-cc-property', key: 'inputLineHeight', value: '1.5' })
    expect(store.getSnapshot().inputLineHeight).toBe('1')

    store.dispatch({ type: 'set-cc-property', key: 'inputHeight', value: 25 })
    expect(store.getSnapshot().inputHeight).toBeGreaterThanOrEqual(30)
    store.destroy()
  })

  it('preserves fitting default typography and clamps each edit direction', () => {
    const defaults = theme({ inputHeight: 40, inputFontSize: 15, inputLineHeight: '1' })
    const store = createStaticWorkbenchAppearanceStore(defaults)

    // Default 15/1/40 already fits and must not be downgraded to line-height 0.5.
    store.dispatch({ type: 'set-cc-property', key: 'inputHeight', value: 40 })
    expect(store.getSnapshot()).toMatchObject({ inputFontSize: 15, inputLineHeight: '1', inputHeight: 40 })

    // Changing the font size preserves the selected line height while reducing
    // the size to the largest fitting integer.
    store.dispatch({ type: 'set-cc-property', key: 'inputFontSize', value: 16 })
    expect(store.getSnapshot()).toMatchObject({ inputFontSize: 15, inputLineHeight: '1', inputHeight: 40 })

    // Changing line height lowers the line-height first when the new value does
    // not fit, then falls back to font-size only if necessary.
    store.dispatch({ type: 'set-cc-property', key: 'inputLineHeight', value: '1.5' })
    expect(store.getSnapshot()).toMatchObject({ inputFontSize: 15, inputLineHeight: '1', inputHeight: 40 })

    store.setTheme(theme({ inputHeight: 40, inputFontSize: 18, inputLineHeight: '1.5' }))
    store.dispatch({ type: 'set-cc-height', height: 149 })
    expect(store.getSnapshot()).toMatchObject({ inputLineHeight: '0.5', inputFontSize: 18, inputHeight: 40 })
    store.destroy()
  })

  it('raises input height against the effective-area floor without changing typography', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({
      ccHeight: 150,
      inputOffsetTop: 5,
      inputHeight: 25,
      inputFontSize: 15,
      inputLineHeight: '1',
    }))

    store.dispatch({ type: 'set-cc-property', key: 'inputHeight', value: 25 })
    expect(store.getSnapshot()).toMatchObject({ inputHeight: 38, inputFontSize: 15, inputLineHeight: '1' })

    store.setTheme(theme({
      ccHeight: 150,
      inputOffsetTop: 5,
      inputHeight: 25,
      inputFontSize: 18,
      inputLineHeight: '0.5',
    }))
    store.dispatch({ type: 'set-cc-property', key: 'inputHeight', value: 25 })
    expect(store.getSnapshot()).toMatchObject({ inputHeight: 34, inputFontSize: 18, inputLineHeight: '0.5' })
    store.destroy()
  })

  it('raises control-center height to contain the input bounds', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({
      ccHeight: 25,
      inputOffsetTop: 10,
      inputHeight: 38,
      inputFontSize: 15,
      inputLineHeight: '1',
    }))

    store.dispatch({ type: 'set-cc-height', height: 25 })
    // The control-center's existing structural minimum (64px) still applies;
    // the input-bound requirement is satisfied because 64 >= 10 + 38.
    expect(store.getSnapshot()).toMatchObject({ ccHeight: 64, inputHeight: 38, inputFontSize: 15, inputLineHeight: '1' })
    store.destroy()
  })

  it('uses the strict effective-area floor for fractional typography occupancy', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({
      ccHeight: 150,
      inputHeight: 22,
      inputFontSize: 15,
      inputLineHeight: '0.5',
    }))

    store.dispatch({ type: 'set-cc-property', key: 'inputHeight', value: 22 })
    expect(store.getSnapshot()).toMatchObject({ inputHeight: 29, inputFontSize: 15, inputLineHeight: '0.5' })
    store.destroy()
  })

  it('非法数字编辑命令保留最后有效的中控布局', () => {
    const store = createStaticWorkbenchAppearanceStore(theme())
    store.dispatch({ type: 'update-cc-placement', id: 'model', placement: { order: 7, offsetX: 12 } })

    store.dispatch({ type: 'update-cc-placement', id: 'model', placement: { order: Number.NaN, offsetX: Number.NaN } })

    expect(store.getSnapshot().ccLayout.placements.model).toMatchObject({ order: 7, offsetX: 12 })
    store.destroy()
  })

  it('显隐切换后 ccHeight 仍走最小高 clamp（★ 刀9~11：最小高已是常量 64）', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({
      cliHintMode: 'full',
      ccHeight: 20,
      ccHidden: ['tokens'],
    }))

    store.dispatch({ type: 'set-cc-hidden', id: 'tokens', hidden: false, target: 'base' })

    // ★ #266 刀9~11：形态固定（命令行 + 独立状态行 + 随内容增高）⇒ 最小高退化为常量 64，
    //   不再随 peri / 详细档 / 可见控件数走高（改造前 free 形态走的就是这一支）。
    expect(store.getSnapshot()).toMatchObject({ ccHeight: 64 })
    store.destroy()
  })

  it('★ #266 刀3：显隐一变最小高跟着变 —— 下界 = 按边算取最大（藏 / 显那件高的前后各一读数）', () => {
    // 下边组里有一件高 60（其余两件 28）⇒ 它在场时下边组需求 = ccMarginBottom 15 + 60 = 75
    const store = createStaticWorkbenchAppearanceStore(theme({ ccHeight: 20, modelHeight: 60 }))

    // 藏掉那件高的 ⇒ 行高回落到 28 ⇒ 下界 = max(64, 10+40, 15+28) = **64**
    store.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: true, target: 'base' })
    expect(store.getSnapshot()).toMatchObject({ ccHidden: ['model'], ccHeight: 64 })

    // 放出来 ⇒ 下边组需求 75 成为绑定项 ⇒ 下界 = **75**（同一条 ccHeight 被抬上去）
    store.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: false, target: 'base' })
    expect(store.getSnapshot()).toMatchObject({ ccHidden: [], ccHeight: 75 })
    store.destroy()
  })

  it('★ #266 刀4（结构 C）：两个开关**各写各表** —— 主管表与再藏表互不覆盖', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({ ccHidden: [], ccHiddenEmpty: [] }))

    // 开关①「隐藏」⇒ 只写主管表（两种门态都生效）
    store.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: true, target: 'base' })
    expect(store.getSnapshot()).toMatchObject({ ccHidden: ['model'], ccHiddenEmpty: [] })

    // 开关②「空态里再藏」⇒ 只写再藏表（主管表一个字节不动）
    store.dispatch({ type: 'set-cc-hidden', id: 'tokens', hidden: true, target: 'empty' })
    expect(store.getSnapshot()).toMatchObject({ ccHidden: ['model'], ccHiddenEmpty: ['tokens'] })

    // 各退各的：退主管表不影响再藏表
    store.dispatch({ type: 'set-cc-hidden', id: 'model', hidden: false, target: 'base' })
    expect(store.getSnapshot()).toMatchObject({ ccHidden: [], ccHiddenEmpty: ['tokens'] })
    store.destroy()
  })

  it('属性命令写入 cc 字段后 ccHeight 仍按最小高 clamp', () => {
    const store = createStaticWorkbenchAppearanceStore(theme({ cliHintMode: 'full', ccHeight: 12 }))

    store.dispatch({ type: 'set-cc-property', key: 'inputHeight', value: 40 })

    // ★ #266 刀9~11：原用例锁「切 CLI 后高度抬到 109」——那两个字段已删除、最小高成常量
    //   ⇒ 改为锁同一漏斗的另一条路径（属性命令写入后仍收敛到 ≥64）。
    expect(store.getSnapshot().ccHeight).toBeGreaterThanOrEqual(64)
    store.destroy()
  })
})

describe('createVanillaWorkbenchAppearanceStore', () => {
  it('订阅外部 vanilla source，忽略非结构变化并正确 unsubscribe', () => {
    let state = theme()
    const listeners = new Set<(next: ThemeSettings, previous: ThemeSettings) => void>()
    const source = {
      getState: () => state,
      subscribe(listener: (next: ThemeSettings, previous: ThemeSettings) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const dispatch = vi.fn()
    const store = createVanillaWorkbenchAppearanceStore(source, dispatch)
    const listener = vi.fn()
    store.subscribe(listener)

    const previousColor = state
    state = theme({ chatBg: '#abcdef' })
    for (const notify of listeners) notify(state, previousColor)
    expect(listener).not.toHaveBeenCalled()

    const previousStructure = state
    state = theme({ messageLayout: 'claude' })
    for (const notify of listeners) notify(state, previousStructure)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().revision).toBe(1)

    store.dispatch({ type: 'reset-cc-layout' })
    expect(dispatch).toHaveBeenCalledWith({ type: 'reset-cc-layout' })

    store.destroy()
    expect(listeners.size).toBe(0)
  })
})
