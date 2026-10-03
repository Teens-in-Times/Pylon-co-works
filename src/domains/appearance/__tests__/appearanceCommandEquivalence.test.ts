// @vitest-environment jsdom
/**
 * appearance 双命令处理器等价守卫。
 *
 * `AppearanceCommand` 有两份同职责落点（#520 退役后的遗留收口）：
 * - **生产路径** `themeProjectedWorkbenchAppearanceStore.dispatchAppearanceCommand`——透传
 *   themeStore actions（clamp/settle 落在 themeStore / presetReducer）；
 * - **测试 / fixture 路径** `workbenchAppearanceStore.reduceAppearanceCommand`——纯 reducer，
 *   clamp/settle 内联，经 `createStaticWorkbenchAppearanceStore` 驱动。
 *
 * 两路当前语义对齐但此前无防漂移手段，本文件补上：对联合类型里**全部命令类型**
 * 各构造代表性序列，两路从**同一初始主题**出发（base 都取 `resetStores()` 后 themeStore
 * 的数据面），断言最终 WorkbenchAppearance 快照除 `revision` 外逐字段相等。
 *
 * 隔离方案：themeStore 是 Solid 内核单例，但 `resetStores()`（getInitialState 整体重置 +
 * 清持久化）可完整复原 —— 每条路径驱动前各 reset 一次，两路互不污染、也不污染其它测试，
 * 因此这里走**双路径真驱动**而不是对实现层做表驱动对账。
 *
 * 已知口径差（防误报，不是漂移）：四把 typography 键（inputHeight / inputOffsetTop /
 * inputFontSize / inputLineHeight）在「当前排版已越界」时两路收敛分支不同——reducer 把
 * `command.key` 作为 changedKey 传给 `clampInputTypography`，`setZoneFieldReducer` 不传
 * （⇒ 越界时 reducer 直降字号、themeStore 先降行距）。下列序列一律在排版适配态下驱动，
 * 该分支差不进入本守卫的断言面；若有人改动收敛口径，应同步更新此说明与两路实现。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppearanceCommand, WorkbenchAppearanceSnapshot } from '../appearance.ts'
import {
  createStaticWorkbenchAppearanceStore,
} from '../workbenchAppearanceStore.ts'
import { createThemeProjectedWorkbenchAppearanceStore } from '../themeProjectedWorkbenchAppearanceStore.ts'
import type { ThemeSettings } from '../../theme/themeStore.ts'
import { useThemeStore } from '../../theme/themeStore.ts'
import { resetStores } from '../../../test/resetStores.ts'

/** 起一片干净态：store 回初始 + 清持久化（与同目录 themeProjected 测试同款）。 */
beforeEach(() => {
  localStorage.clear()
  resetStores()
})

/** themeStore 当前状态的**数据面**（ThemeState = ThemeSettings & actions，滤掉函数即纯设置）。 */
function currentThemeSettings(): ThemeSettings {
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(useThemeStore.getState())) {
    if (typeof value !== 'function') data[key] = value
  }
  return structuredClone(data) as unknown as ThemeSettings
}

/** 快照可比化：剥掉 revision（两路的发布计数没有理由相等，内容相等即等价）。 */
function stripRevision(snapshot: WorkbenchAppearanceSnapshot): Omit<WorkbenchAppearanceSnapshot, 'revision'> {
  const { revision: _revision, ...appearance } = snapshot
  return appearance
}

/**
 * 等价断言本体：同一命令序列分别经两条路径驱动，最终快照逐字段相等。
 *
 * - 路径甲：static store —— `createStaticWorkbenchAppearanceStore` 内部逐条折叠
 *   `reduceAppearanceCommand`（纯 reducer 落点）；
 * - 路径乙：themeStore 真源 —— `createThemeProjectedWorkbenchAppearanceStore` 的
 *   `dispatchAppearanceCommand` 透传 actions（生产落点）。
 */
function expectCommandEquivalence(
  variant: Partial<ThemeSettings>,
  commands: readonly AppearanceCommand[],
): void {
  // 路径甲：static store（reduceAppearanceCommand）
  resetStores()
  const staticStore = createStaticWorkbenchAppearanceStore({
    ...currentThemeSettings(),
    ...structuredClone(variant),
  })
  for (const command of commands) staticStore.dispatch(command)
  const fromReducer = stripRevision(staticStore.getSnapshot())
  staticStore.destroy()

  // 路径乙：themeStore 真源 + dispatchAppearanceCommand
  resetStores()
  useThemeStore.setState(structuredClone(variant))
  const projected = createThemeProjectedWorkbenchAppearanceStore()
  for (const command of commands) projected.dispatch(command)
  const fromThemeStore = stripRevision(projected.getSnapshot())
  projected.destroy()

  expect(fromThemeStore).toEqual(fromReducer)
}

describe('AppearanceCommand 双落点等价（dispatchAppearanceCommand ⇔ reduceAppearanceCommand）', () => {
  it('set-cc-edit-mode：开关直写、无 clamp 介入', () => {
    expectCommandEquivalence({}, [
      { type: 'set-cc-edit-mode', enabled: true },
      { type: 'set-cc-edit-mode', enabled: false },
    ])
  })

  it('set-cc-hidden：主管 / 再藏两表各写各的，且每次显隐重过高度 clamp（settle 对账）', () => {
    // modelHeight 60 + ccHeight 20 ⇒ 显隐变动牵动算式下界（64/75 一带，见同目录刀3 用例）
    expectCommandEquivalence(
      { ccHeight: 20, modelHeight: 60, ccHidden: [], ccHiddenEmpty: [] },
      [
        { type: 'set-cc-hidden', id: 'model', hidden: true, target: 'base' },
        { type: 'set-cc-hidden', id: 'tokens', hidden: true, target: 'empty' },
        { type: 'set-cc-hidden', id: 'model', hidden: false, target: 'base' },
        { type: 'set-cc-hidden', id: 'mode', hidden: true, target: 'empty' },
      ],
    )
  })

  it('set-cc-height：算式下界与 400 上界两侧一致', () => {
    expectCommandEquivalence(
      { ccHeight: 20, modelHeight: 60, ccHidden: [], ccHiddenEmpty: [] },
      [
        { type: 'set-cc-height', height: 20 }, // 低于下界 ⇒ 抬到算式下界
        { type: 'set-cc-height', height: 200 }, // 区间内原样
        { type: 'set-cc-height', height: 999 }, // 高于上界 ⇒ 400
      ],
    )
  })

  it('update-cc-placement：order/offset 写入、clamp 边界与未知 id no-op 一致', () => {
    expectCommandEquivalence({}, [
      { type: 'update-cc-placement', id: 'model', placement: { order: 3, offsetX: 12, offsetY: -8 } },
      { type: 'update-cc-placement', id: 'input', placement: { offsetX: -20 } },
      // 越界值走 clamp（order 0..99 / offsetX ±48 / offsetY ±16）
      { type: 'update-cc-placement', id: 'model', placement: { offsetX: 999, offsetY: -999, order: -5 } },
      // 未知 id：两路同样原样不动
      { type: 'update-cc-placement', id: 'no-such-widget', placement: { order: 1 } },
    ])
  })

  it('set-cc-property · 数字键：排版收敛 + give-way + 高度 clamp 逐条一致，NaN 共同 no-op', () => {
    expectCommandEquivalence({}, [
      // 先垫高，保证后续排版键在「适配态」下驱动（见文件头「已知口径差」）
      { type: 'set-cc-height', height: 300 },
      { type: 'set-cc-property', key: 'inputHeight', value: 200 },
      { type: 'set-cc-property', key: 'inputFontSize', value: 20 },
      { type: 'set-cc-property', key: 'inputLineHeight', value: '1.5' },
      // 影响最小高算式的结构键 ⇒ ccHeight 随之收敛（两路各走各的 clamp，须同值）
      { type: 'set-cc-property', key: 'modelHeight', value: 60 },
      { type: 'set-cc-property', key: 'modelWidth', value: 260 },
      { type: 'set-cc-property', key: 'cliLineWidth', value: 3 },
      // 非有限数字：两路共同 no-op（reducer 原样返回 / 生产侧不透传）
      { type: 'set-cc-property', key: 'modelHeight', value: Number.NaN },
    ])
  })

  it('set-cc-property · give-way：输入栏与 ccHeight 争位时两路让位规则一致', () => {
    // 初始 90 + 10 = 100 恰好贴住 ccHeight ⇒ 一动 offset/height 就进 give-way 分支
    expectCommandEquivalence(
      { ccHeight: 100, inputHeight: 90, inputOffsetTop: 10 },
      [
        { type: 'set-cc-property', key: 'inputOffsetTop', value: 20 },
        { type: 'set-cc-property', key: 'inputHeight', value: 120 },
      ],
    )
  })

  it('set-cc-property · 字符串/颜色键：直写一致', () => {
    expectCommandEquivalence({}, [
      { type: 'set-cc-property', key: 'inputBg', value: '#112233' },
      { type: 'set-cc-property', key: 'modelSwitchMode', value: 'inline' },
      { type: 'set-cc-property', key: 'permissionTextColor', value: '#abcdef' },
    ])
  })

  it('reset-cc-layout：改动后重置回出厂布局', () => {
    expectCommandEquivalence({}, [
      { type: 'update-cc-placement', id: 'model', placement: { order: 7, offsetX: 30, offsetY: 12 } },
      { type: 'reset-cc-layout' },
    ])
  })

  it('全命令类型合并序列：一条长流水贯穿两表、clamp、give-way 与重置', () => {
    expectCommandEquivalence(
      { ccHeight: 20, modelHeight: 60, ccHidden: [], ccHiddenEmpty: [] },
      [
        { type: 'set-cc-edit-mode', enabled: true },
        { type: 'set-cc-hidden', id: 'model', hidden: true, target: 'base' },
        { type: 'set-cc-hidden', id: 'tokens', hidden: true, target: 'empty' },
        { type: 'set-cc-height', height: 200 },
        { type: 'update-cc-placement', id: 'model', placement: { order: 2, offsetX: 8 } },
        { type: 'set-cc-height', height: 300 },
        { type: 'set-cc-property', key: 'inputHeight', value: 200 },
        { type: 'set-cc-property', key: 'inputFontSize', value: 20 },
        { type: 'set-cc-property', key: 'modelHeight', value: 40 },
        { type: 'set-cc-property', key: 'inputBg', value: '#223344' },
        { type: 'set-cc-property', key: 'modelSwitchMode', value: 'inline' },
        { type: 'set-cc-hidden', id: 'mode', hidden: true, target: 'empty' },
        { type: 'update-cc-placement', id: 'input', placement: { offsetY: -4 } },
        { type: 'set-cc-edit-mode', enabled: false },
        { type: 'reset-cc-layout' },
      ],
    )
  })
})
