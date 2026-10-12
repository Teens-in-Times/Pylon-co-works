/**
 * themeDefaults — 主题默认值真值表（D2：从 store.ts 移入域，node 可 import）。
 *
 * 标量默认由 defs 派生（THEME_DEFAULTS）+ 对象/复合字段（ccLayout/ccHidden/ccHiddenEmpty/META 路由）显式声明。
 * 加标量字段：defs 加声明 + THEME_DEFAULTS 加默认值即可。
 * 完整性由 test-defaults-completeness.mts 运行时断言（Q1：不做类型体操）。
 */
import { THEME_DEFAULTS } from './themeFieldDefs.ts'
import { cloneCcLayout, DEFAULT_CC_LAYOUT } from '../cc/ccLayoutState.ts'
import { PRESET_ZONES } from './presetReducer.ts'
import type { ThemeSettings } from './themeStore.ts'

export const DEFAULTS: ThemeSettings = {
  ...THEME_DEFAULTS,
  ccHidden: [],
  // ★ #266 刀4（结构 C）：显隐的**空态再藏**基准。值 = 出厂空态（那 6 件）—— 也就是刀2 之前硬编码在
  //   `widgetDefinitions.ts` 里的那份名单，逐字搬到这里当**基准**：没套任何预设时（新装 / 未登记
  //   界面模式），空态仍保持「极简」（只有输入栏）。
  //   ★ 它是**"再藏"的基准**（叠在主管表 `ccHidden` 之上的第二层，只能加、不能抵消）——
  //     生效名单 = `门 ? 主管 ∪ 再藏 : 主管`，见 `resolveCcHiddenWidgetIds`。
  //     "预设没写这一项 ⇒ 抄该预设的常态表"这条回落**已随刀4 删除**（`inheritCcEmptySlice` 退场）：
  //     预设没写 ⇒ 该键不进 patch ⇒ 就是这里这 6 件当基准。
  //   ★ 为什么不是空数组：空数组 = "空态不再多藏任何件" ⇒ 新装的空态会突然多出状态行与发送按钮，
  //     那是**产品行为变化**，本刀只搬位置、不改变观感（原由 mountSolidControlCenterPreview
  //     预览基线锁定的「04b 空态极简」，该预览 harness 已随 #520 死代码二批退役）。
  ccHiddenEmpty: ['model', 'reasoning', 'mode', 'tokens', 'cc-send-button', 'cc-command-hint'],
  ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
  // ★ #266 CC-13 刀4：插件元件属性值的**基准**（空表 = 谁都没改过参数）。
  //   与 ccLayout 同款：它是**内部对象字段**，不进 THEME_DEFAULTS（标量派生），必须在这里显式给值 ——
  //   漏了它 `themeDefaults` 的完整性断言当场红（对象字段没有标量默认可兜）。
  ccPluginProps: {},
  ccEditMode: false,
  // appliedPreset/custom 键集由 PRESET_ZONES 派生（单一真值，不平行维护）
  appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])) as Record<string, string>,
  custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])) as Record<string, boolean>,
} as unknown as ThemeSettings
