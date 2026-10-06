/**
 * themeTypes — ThemeSettings 单一真值（原 store.ts 内嵌接口）。
 *
 * 落位 domains/theme 后，themeFieldDefs / customPresets / presets / zones 与各域消费方
 * 单向仰望本类型，不再形成 store⇄defs⇄presets 类型环（结构审查 A-V5/B-13）。
 */
import type { CcLayoutV3 } from '../cc/ccLayoutState.ts'
import type { CcPluginProps } from '../cc/ccPluginProps.ts'

export interface ThemeSettings {
  /** 全局强调色（--accent）：链接/前缀/焦点/选中态统一取色，此前硬编码 #3b82f6 无法主题化 */
  accent: string
  /** 布局骨架显隐（CC 单流模式入口）：tab 条 / 侧栏（#483：showPet 随宠物链删除退役） */
  showTabBar: boolean; showSidebar: boolean
  transparency: number; bgBlur: number; globalFont: string; codeFont: string; globalFontSize: number
  globalBgImage: string; globalBgColor: string; uiScheme: string
  titlebarBg: string; titlebarTextColor: string
  sidebarBg: string; sidebarBgImage: string; sidebarWidth: number; sidebarTextColor: string; sidebarNameSize: number; sidebarGroupSize: number
  chatBg: string; chatBgImage: string; chatFont: string; chatFontSize: number; chatLineHeight: number; chatTextColor: string; chatCodeColor: string; chatCodeBg: string
  // 语法高亮 `--syn-*`（Lezer tag → `pl-*` 类的配色；默认值沿用 base16-ocean.dark）
  synKeyword: string; synString: string; synComment: string; synLiteral: string; synEntity: string; synFunction: string
  synVariable: string; synProperty: string; synRegex: string; synMarkupHeading: string; synCoReference: string; synSupport: string
  toolOk: string; toolRun: string; toolErr: string; userTagBg: string
  /** diff 块级色（此前复用 toolOk/toolErr，CC 系为独立柔和色） */
  diffAdded: string; diffRemoved: string
  /** diff 词级高亮色（CC 双层：整行背景 + 变更词背景） */
  diffAddedWord: string; diffRemovedWord: string
  /** W2-01（F3-D）：FileSheet 编辑器 8 字段（defs 先行，W2-04 消费） */
  editorFontSize: number; editorLineHeight: number
  editorGutterColor: string; editorGutterBg: string; editorSelection: string; editorActiveLine: string
  editorTabActive: string; editorModifiedMark: string
  toolIndicatorGlow: number; toolIndicatorGlowColor: string
  toolConnectorMode: string; toolConnectorColor: string
  toolConnectorStyle: 'solid' | 'dotted' | 'pulse'; toolConnectorWidth: number; toolConnectorOpacity: number
  inputOffsetTop: number; inputHeight: number; inputMarginX: number
  inputSurfaceBg: string; inputSurfaceOpacity: number
  inputBorder: string; inputBorderWidth: number; inputBorderOpacity: number
  inputFocusRingEnabled: 'shown' | 'hidden'; inputFocusRingColor: string; inputHighlightOpacity: number; inputShadowEnabled: 'shown' | 'hidden'
  inputBg: string; inputBgImage: string; inputTextColor: string; inputPlaceholder: string; sendButtonColor: string; sendButtonRadius: string; sendButtonBorderColor: string; sendButtonIcon: string; sendButtonIconGenerating: string; sendButtonIconRound: string; sendButtonIconColor: string; inputBorderColor: string; inputFocusBorder: string; inputRadius: number; inputFontSize: number; inputLineHeight: string
  inputShowHistoryHint: boolean; inputSubmitButtonMode: 'inline' | 'external' | 'hidden'; cliLineWidth: number; cliLineColor: string; cliTextColor: string; cliPromptColor: string
  cliHintMode: 'hidden' | 'compact' | 'full'
  /** #238 刀5：命令行提示自己的字号（原为整条信息行继承 `ccStatusFontSize`，已删除） */
  ccHintFontSize: number
  rightBg: string; rightBgImage: string; rightWidth: number
  sidebarTransparency: number; sidebarBlur: number; chatTransparency: number; chatBlur: number; rightTransparency: number; rightBlur: number
  userName: string; userPrefix: string; userColor: string
  toolIndicator: string
  /** Terminal tool glyphs by semantic state; toolIndicator remains legacy fallback. */
  toolIndicatorRun: string; toolIndicatorOk: string; toolIndicatorErr: string
  spinnerFramePreset: 'sparkles' | 'ascii-line' | 'braille' | 'dots' | 'orbit' | 'clock' | 'wave' | 'blocks' | 'scan' | 'cc' | 'custom'
  spinnerCustomFrames: string
  spinnerVerbSet: 'zh' | 'en' | 'analysis' | 'engineering' | 'cc' | 'custom'
  spinnerCustomVerbs: string
  spinnerDoneMarker: string
  spinnerCancelledMarker: string
  spinnerErrorMarker: string
  spinnerDoneMarkerMode: 'frame' | 'custom'
  spinnerCancelledMarkerMode: 'frame' | 'custom'
  spinnerErrorMarkerMode: 'frame' | 'custom'
  spinnerIntervalMs: number
  spinnerColor: string; spinnerSize: number
  /** CC stalled 渐变红（3s 无响应后帧/文案趋向此色） */
  spinnerStalledColor: string
  msgStyle: string; msgFont: string; msgTextColor: string; msgLineHeight: number
  messageUserBg: string; messageAssistantBg: string; messageReasoningBg: string; messageBorderColor: string; messageRadius: number
  messageLayout: 'classic' | 'claude' | 'bubble'
  /** CC 视觉还原：助手消息 ● 圆点 */
  assistantDot: boolean; assistantDotGlyph: string; assistantDotColor: string
  /** 自定义头像/图标路径（非空时替代圆点字形，列宽随图） */
  assistantDotImage: string
  ccHeight: number; ccBg: string; ccSurfaceOpacity: number
  ccBgImage: string
  ccMarginX: number; ccMarginBottom: number; ccRadius: number
  reasoningSwitchMode: string; reasoningBgColor: string; reasoningWidth: number; reasoningHeight: number; reasoningRadius: number; reasoningFontSize: number; reasoningTextColor: string
  modelSwitchMode: string; modelBgColor: string; modelWidth: number; modelHeight: number; modelRadius: number; modelFontSize: number; modelTextColor: string
  permissionSwitchMode: string; permissionBgColor: string; permissionWidth: number; permissionHeight: number; permissionRadius: number; permissionFontSize: number; permissionTextColor: string
  /** 权限模式徽标色（此前硬编码 #FFC107/#A2A9E4） */
  modeAutoColor: string; modeEditColor: string
  ccHidden: string[]
  /**
   * ★ #266 刀4（结构 C）：显隐的**空态再藏**（字段键保留不改名）。它是 `ccHidden`（**主管表**，
   * 两种门态都生效）之下的**第二层**：只在空态**再加一层**，**只能加、不能抵消**主管表 ⇒
   * 生效名单 = `门 ? 主管 ∪ 再藏 : 主管`（去重；规则唯一出处：
   * `domains/cc/widgetDefinitions.ts` 的 `resolveCcHiddenWidgetIds`）。
   * ★ 预设**没写这一项** ⇒ 该键不进 patch ⇒ 由 `DEFAULTS.ccHiddenEmpty`（出厂那 6 件）当基准
   * （刀2 那条"缺省抄常态表"的落值回落已随刀4 删除）。
   */
  ccHiddenEmpty: string[]
  ccLayout: CcLayoutV3
  /**
   * ★ #266 CC-13 刀4：**插件元件的属性值**（`Record<widgetId, Record<短键, string | number>>`）。
   * 与内置件的参数同规矩：住 cc 区 ⇒ **随预设走**；插件**撤下那一刻**由 `clear-cc-widget-data`
   * 一并清（与位置 / 显隐记录同一时刻）。形状与读写规则见 `domains/cc/ccPluginProps.ts`。
   */
  ccPluginProps: CcPluginProps
  ccEditMode: boolean
  appliedPreset: Record<string, string>
  custom: Record<string, boolean>
}

