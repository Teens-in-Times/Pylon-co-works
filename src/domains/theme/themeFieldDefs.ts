import type { ThemeSettings } from './themeStore'
import { resolveCcMinHeight, ccMinHeightInputOf } from '../cc/ccHeightState.ts'
import { CC_WIDGET_GROUPS } from '../cc/widgetDefinitions.ts'
import type { FontRole } from '../../contracts/fonts.ts'
import type { VisualSemanticRole } from './visualSemantics.ts'

/**
 * themeFieldDefs — 声明式主题字段定义（自定义系统骨架核心）。
 *
 * 每个字段携带类型元数据（color/number/select/boolean/text）+ label +
 * 范围/选项 + zone 归属 + cssVar 注入名。生成物：
 * - THEME_FIELD_KEYS（白名单，替代 THEME_SETTINGS_KEYS 手写并集）
 * - ZONE_FIELDS（zone → 字段，替代 THEME_FIELD_GROUPS）
 * - Settings UI 自动渲染（骨架3）
 * - cssVars 注入派生（App.tsx 从 defs 循环生成，替代手写 60+ 行）
 *
 * 新增字段：此处加一行 + store.ts 加类型/默认值即可，其余自动跟上。
 */

export const ZONES = ['global', 'layout', 'sidebar', 'chat', 'cc', 'right'] as const
export type ZoneName = (typeof ZONES)[number]

export type ThemeFieldType = 'color' | 'number' | 'select' | 'boolean' | 'text'

export interface ThemeFieldDef {
  type: ThemeFieldType
  label: string
  zone: ZoneName
  /** Settings 分组标题（声明式 UI 按 group 渲染） */
  group?: string
  /** 特殊控件标识（渲染器分发到专用组件） */
  control?: 'default' | 'bgImage' | 'spinnerMarker' | 'schemeChip' | 'fontPicker' | 'segmented' | 'toolIndicator'
  /** Dynamic font registries may add stable ids beyond the built-in options. */
  allowCustomOptions?: boolean
  fontRole?: FontRole
  /** number 范围/步长 */
  min?: number
  max?: number
  step?: number
  /** number 动态最小值（优先于 min，如 ccHeight 依赖布局状态） */
  minFn?: (t: ThemeSettings) => number
  /** number 单位后缀（'px' 等）；cssVar 注入时格式化 `${value}${unit}` */
  unit?: string
  /** 条件显示：返回 false 时 Settings 不渲染该字段（如 spinner 自定义帧依赖预设） */
  showIf?: (t: ThemeSettings) => boolean
  /** 高阶选项：渲染器折叠进组内"高级"子区，平时不占屏 */
  advanced?: boolean
  /** number 显示后缀（set-val，如 'px'/'%'/'ms'）；配合 percent 处理 0-1 值 */
  suffix?: string
  /** number 值为 0-1 时按百分比显示（*100） */
  percent?: boolean
  /** 字段提示文案（Row 内 set-hint） */
  hint?: string
  /** select 选项 */
  options?: readonly string[]
  /** 设置 UI 的人类可读标签；持久化与 Skin schema 仍只使用稳定字符串值。 */
  optionLabels?: Readonly<Record<string, string>>
  /** CSS 变量注入名；缺省 = `--${kebab(fieldName)}` */
  cssVar?: string
  /** 不注入 CSS 变量（逻辑/对象字段） */
  noCssVar?: boolean
  /** 不在 Settings UI 自动渲染（特殊控件或内部字段） */
  hidden?: boolean
  /** META 字段：仅持久化、不进预设白名单（ccEditMode/appliedPreset/dirty） */
  meta?: boolean
  /** 字段默认值（THEME_DEFAULTS 由 defs 派生；对象字段 ccLayout/ccHidden 及 appliedPreset/custom 无标量默认） */
  default?: string | number | boolean
  /** W2-13（F3-A）：快速层基础字段标记（basic 清单来自 defs，组件不硬编码） */
  tier?: 'basic'
  /** DF-03b：该字段投影到的宿主视觉角色；角色名真值来自 visualSemantics。 */
  semanticRole?: VisualSemanticRole
  /** 该字段是公共角色的 preset/source 候选；其余同角色字段只投影自己的 zone alias。 */
  semanticSource?: boolean
}

const C = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'color', label, zone })
const N = (zone: ZoneName, label: string, min?: number, max?: number, step?: number): ThemeFieldDef => ({ type: 'number', label, zone, min, max, step })
const S = (zone: ZoneName, label: string, options: readonly string[]): ThemeFieldDef => ({ type: 'select', label, zone, options })
const B = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'boolean', label, zone })
const T = (zone: ZoneName, label: string): ThemeFieldDef => ({ type: 'text', label, zone })
const H = (def: ThemeFieldDef): ThemeFieldDef => ({ ...def, hidden: true })

const TOOL_INDICATOR_OPTION_IDS = [
  'circle', 'dot-small', 'ring', 'double-ring', 'diamond', 'square', 'triangle', 'play',
  'chevron', 'branch', 'node', 'hex', 'asterisk', 'star', 'check', 'cross', 'warning', 'plus', 'slash', 'hourglass',
] as const
const TOOL_INDICATOR_OPTION_LABELS: Readonly<Record<string, string>> = {
  circle: '● 圆点', 'dot-small': '· 小圆点', ring: '○ 圆环', 'double-ring': '◎ 双环', diamond: '◆ 菱形', square: '■ 方块',
  triangle: '▲ 三角', play: '▶ 播放', chevron: '› 尖括号', branch: '├ 分支', node: '◇ 节点', hex: '⬡ 六边形',
  asterisk: '✱ 星号', star: '★ 星标', check: '✓ 对勾', cross: '× 叉号', warning: '! 警告', plus: '+ 加号', slash: '╱ 斜杠', hourglass: '⧗ 沙漏',
}

export const THEME_FIELD_DEFS = {
  // ── global ──
  accent: { ...C('global', '强调色'), tier: 'basic', default: '#3b82f6', cssVar: '--accent', group: "强调色", hint: '链接、用户前缀、选中与焦点，以及等待动画光扫的统一取色', semanticRole: 'accent', semanticSource: true },
  transparency: { ...N('global', '背景不透明度', 0, 1, 0.05), default: 0.85, group: "玻璃效果", cssVar: '--t', percent: true, suffix: '%', hint: '只改变背景材质，不会让文字和控件一起变淡；设为 0 可透出桌面' },
  bgBlur: { ...N('global', '模糊', 0, 40, 2), default: 16, group: "玻璃效果", unit: 'px', cssVar: '--blur', suffix: 'px' },
  globalFont: { ...S('global', '界面字体', ['system', 'serif', 'mono']), optionLabels: {
    system: '系统无衬线', serif: '阅读衬线', mono: '等宽代码体',
  }, default: 'system', group: "字体", control: 'fontPicker', fontRole: 'interface', allowCustomOptions: true, hint: '应用导航、设置与普通界面的字体；代码和路径仍保留等宽体' },
  codeFont: { ...S('global', '代码与路径字体', ['mono']), optionLabels: { mono: 'Consolas（VS Code 默认）' }, default: 'mono', group: "字体", control: 'fontPicker', fontRole: 'code', allowCustomOptions: true, hint: '代码、路径与终端输出专用；插件可以贡献新的等宽字体' },
  globalFontSize: { ...N('global', '基础字号', 12, 24), tier: 'basic', default: 18, group: "字体", unit: 'px' },
  globalBgImage: { ...T('global', '背景图'), default: '', control: 'bgImage', group: "玻璃效果", },
  globalBgColor: { ...C('global', '背景底色'), tier: 'basic', default: '#e8e8ec', group: "玻璃效果", hint: '背景图或透明材质下方使用的基础颜色', semanticRole: 'surface.canvas', semanticSource: true },
  uiScheme: { ...S('global', '界面明暗', ['light', 'dark']), tier: 'basic', default: 'light', group: "玻璃效果", control: 'schemeChip' },
  titlebarBg: { ...C('global', '标题栏背景'), default: '', group: '标题栏', cssVar: '--titlebar-bg', hint: '留空时跟随当前浅色/深色基础配色', semanticRole: 'surface.panel', semanticSource: true },
  titlebarTextColor: { ...C('global', '标题栏文字'), default: '', group: '标题栏', cssVar: '--titlebar-text', hint: '留空时跟随当前界面文字颜色', semanticRole: 'content.text' },
  userName: { ...T('global', '显示名'), default: '', group: "个人信息" },
  userPrefix: { ...T('global', '前缀'), default: '❯', group: "个人信息" },
  // ChatView 内联 style 应用（style={{color: userColor}}），不注入 CSS var
  userColor: { ...C('global', '名字颜色'), default: '', group: "个人信息", noCssVar: true },
  // 布局显隐并入 global zone（布局骨架组渲染在全局 tab），layout zone 无独立 tab/预设
  showTabBar: { ...B('global', '工作区标签栏'), default: true, group: "布局骨架" },
  showSidebar: { ...B('global', '左侧栏'), default: true, group: "布局骨架" },

  // ── sidebar ──
  sidebarBg: { ...C('sidebar', '侧栏背景色'), default: 'rgba(0,0,0,0.02)', group: "背景", semanticRole: 'surface.panel', semanticSource: true },
  sidebarBgImage: { ...T('sidebar', '侧栏背景图'), default: '', control: 'bgImage', group: "背景", },
  sidebarWidth: { ...N('sidebar', '左栏宽度', 160, 400), default: 250, group: "布局", unit: 'px', noCssVar: true, hint: '已迁移到左栏拖拽布局；旧主题值仅由工作区布局迁移读取' },
  sidebarTransparency: { ...N('sidebar', '侧栏背景不透明度', 0, 1, 0.05), default: 1, group: "玻璃效果", percent: true, suffix: '%' },
  sidebarBlur: { ...N('sidebar', '侧栏模糊', 0, 40, 2), default: 0, group: "玻璃效果", unit: 'px', suffix: 'px' },
  sidebarTextColor: { ...C('sidebar', '文字颜色'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: "文字", semanticRole: 'content.text' },
  sidebarNameSize: { ...N('sidebar', '会话名称字号', 11, 20), tier: 'basic', default: 14, group: "文字", unit: 'px' },
  // W2-10：侧栏平铺后无分组——字段保留兼容预设，不再注入 cssVar（防死注入）
  sidebarGroupSize: { ...N('sidebar', '分组标题字号', 10, 16), default: 12, group: "文字", unit: 'px', noCssVar: true, hidden: true },

  // ── chat ──
  chatBg: { ...C('chat', '消息流背景色'), default: '', group: "背景", semanticRole: 'surface.panel', semanticSource: true },
  chatBgImage: { ...T('chat', '消息流背景图'), default: '', control: 'bgImage', group: "背景", },
  chatTransparency: { ...N('chat', '消息流背景不透明度', 0, 1, 0.05), default: 1, group: "背景", percent: true, suffix: '%' },
  chatBlur: { ...N('chat', '消息流模糊', 0, 40, 2), default: 0, group: "背景", unit: 'px', suffix: 'px' },
  chatFont: { ...S('chat', '聊天区字体', ['mono', 'system', 'serif']), optionLabels: {
    mono: '终端等宽体', system: '系统无衬线', serif: '阅读衬线',
  }, default: 'mono', group: "字体", control: 'fontPicker', fontRole: 'content', allowCustomOptions: true, hint: '聊天记录流容器的基础字体（正文之外的提示行等沿用此项）；消息正文由「风格 › 正文渲染字体」决定，代码块始终使用等宽体' },
  chatFontSize: { ...N('chat', '字号', 12, 22), tier: 'basic', default: 15, group: "字体", unit: 'px' },
  chatLineHeight: { ...N('chat', '行高', 1.2, 2.5, 0.1), default: 1.4, group: "字体", },
  chatTextColor: { ...C('chat', '文字'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: "颜色", semanticRole: 'content.text', semanticSource: true },
  chatCodeColor: { ...C('chat', '内联代码'), default: '#b47814', group: "颜色", },
  chatCodeBg: { ...C('chat', '代码背景'), default: 'rgba(0,0,0,0.03)', group: "颜色", },
  synKeyword: { ...C('chat', '关键字'), default: '#b48ead', cssVar: '--syn-kw', group: "语法高亮", },
  synString: { ...C('chat', '字符串'), default: '#96b5b4', cssVar: '--syn-str', group: "语法高亮", },
  synComment: { ...C('chat', '注释'), default: '#65737e', cssVar: '--syn-cmt', group: "语法高亮", },
  synLiteral: { ...C('chat', '数字与常量'), default: '#d08770', cssVar: '--syn-lit', group: "语法高亮", },
  synEntity: { ...C('chat', '类型与实体'), default: '#ebcb8b', cssVar: '--syn-ent', group: "语法高亮", },
  synFunction: { ...C('chat', '函数'), default: '#8fa1b3', cssVar: '--syn-fn', group: "语法高亮", },
  synVariable: { ...C('chat', '变量'), default: '#c0c5ce', cssVar: '--syn-var', group: "语法高亮", },
  synProperty: { ...C('chat', '属性'), default: '#c0c5ce', cssVar: '--syn-prop', group: "语法高亮", },
  synRegex: { ...C('chat', '正则表达式'), default: '#d08770', cssVar: '--syn-re', group: "语法高亮", },
  synMarkupHeading: { ...C('chat', '文档标题'), default: '#65737e', cssVar: '--syn-mh', group: "语法高亮", },
  synCoReference: { ...C('chat', '语法·引用'), default: '#65737e', cssVar: '--syn-cor', hidden: true },
  synSupport: { ...C('chat', '模块与支持项'), default: '#8fa1b3', cssVar: '--syn-support', group: "语法高亮", },
  toolOk: { ...C('chat', '工具完成状态'), default: '#4EBA65', group: "指示器与连接线", semanticRole: 'state.success', semanticSource: true },
  toolRun: { ...C('chat', '工具运行状态'), default: '#93A5FF', group: "指示器与连接线", semanticRole: 'accent' },
  toolErr: { ...C('chat', '工具错误状态'), default: '#FF6B80', group: "指示器与连接线", semanticRole: 'state.danger', semanticSource: true },
  userTagBg: { ...C('chat', '用户标签背景'), default: 'rgba(168,85,247,0.08)', group: "用户标签", },
  userTagText: { ...C('chat', '用户标签文字'), default: '#a855f7', group: "用户标签", },
  diffAdded: { ...C('chat', '新增行'), default: '#4EBA65', group: "代码差异", semanticRole: 'state.success' },
  diffRemoved: { ...C('chat', '删除行'), default: '#FF6B80', group: "代码差异", semanticRole: 'state.danger' },
  diffAddedWord: { ...C('chat', '行内新增片段'), default: '#3EA15E', group: "代码差异", advanced: true },
  diffRemovedWord: { ...C('chat', '行内删除片段'), default: '#E0556B', group: "代码差异", advanced: true },
  // W2-01（F3-D/T4）：FileSheet 编辑器 8 字段预留（defs 先行、W2-04 消费；语法高亮复用 syn* 已有字段）
  editorFontSize: { ...N('chat', '编辑器字号', 10, 24), default: 13, group: "文件编辑器", unit: 'px' },
  editorLineHeight: { ...N('chat', '编辑器行高', 1.2, 2.5, 0.1), default: 1.5, group: "文件编辑器", },
  editorGutterColor: { ...C('chat', '行号文字'), default: '#65737e', group: "文件编辑器", },
  editorGutterBg: { ...C('chat', '行号栏底色'), default: 'rgba(0,0,0,0.03)', group: "文件编辑器", },
  editorSelection: { ...C('chat', '选中区背景'), default: 'rgba(59,130,246,0.25)', group: "文件编辑器", },
  editorActiveLine: { ...C('chat', '当前行高亮'), default: 'rgba(0,0,0,0.04)', group: "文件编辑器", },
  editorTabActive: { ...C('chat', '活动文件标签'), default: '#3b82f6', group: "文件编辑器", semanticRole: 'accent' },
  editorModifiedMark: { ...C('chat', '改动标记'), default: '#b47814', group: "文件编辑器", semanticRole: 'state.warning' },
  // toolIndicator 候选由 toolIndicatorOptions 单一真值提供；静态 options 仅供 schema/旧值归一化参考。
  toolIndicator: { ...S('chat', '兼容回退指示器', ['●', '■', '◆', '▶', '✦']), default: '●', control: 'toolIndicator', group: "指示器与连接线", hidden: true },
  // 三态独立字形：运行/完成/失败不再共享一个 glyph。值使用
  // toolIndicatorAssets 的稳定 id，旧的 toolIndicator 仍作为回退。
  toolIndicatorRun: { ...S('chat', '运行中指示器', TOOL_INDICATOR_OPTION_IDS), optionLabels: TOOL_INDICATOR_OPTION_LABELS, default: 'circle', control: 'toolIndicator', group: "指示器与连接线" },
  toolIndicatorOk: { ...S('chat', '完成时指示器', TOOL_INDICATOR_OPTION_IDS), optionLabels: TOOL_INDICATOR_OPTION_LABELS, default: 'check', control: 'toolIndicator', group: "指示器与连接线" },
  toolIndicatorErr: { ...S('chat', '失败时指示器', TOOL_INDICATOR_OPTION_IDS), optionLabels: TOOL_INDICATOR_OPTION_LABELS, default: 'cross', control: 'toolIndicator', group: "指示器与连接线" },
  // CSS 变量走 --pv-connector-*（ChatView 内联计算），字段不注入独立 var
  toolIndicatorGlow: { ...N('chat', '指示器光晕', 0, 20, 1), default: 0, group: "指示器与连接线", suffix: 'px', noCssVar: true },
  toolIndicatorGlowColor: { ...C('chat', '光晕颜色'), default: '', group: "指示器与连接线", noCssVar: true },
  toolConnectorMode: { ...S('chat', '连接线显示', ['none', 'fixed', 'follow']), optionLabels: { none: '关闭', fixed: '固定轨道', follow: '跟随工具' }, default: 'none', group: "指示器与连接线", },
  toolConnectorColor: { ...C('chat', '连接线颜色'), default: 'rgba(0,0,0,0.12)', group: "指示器与连接线", showIf: t => t.toolConnectorMode === 'fixed', semanticRole: 'connector.default', semanticSource: true },
  toolConnectorStyle: { ...S('chat', '连接线样式', ['solid', 'dotted', 'pulse']), optionLabels: { solid: '实线', dotted: '点线', pulse: '流动脉冲' }, default: 'solid', group: "指示器与连接线", },
  toolConnectorWidth: { ...N('chat', '连接线宽度', 1, 6), default: 2, group: "指示器与连接线", suffix: 'px' },
  toolConnectorOpacity: { ...N('chat', '连接线不透明度', 0.1, 1, 0.05), default: 1, group: "指示器与连接线", percent: true, suffix: '%' },
  spinnerFramePreset: { ...S('chat', '动画预设', ['sparkles', 'ascii-line', 'braille', 'dots', 'orbit', 'clock', 'wave', 'blocks', 'scan', 'cc', 'custom']), optionLabels: { sparkles: '星芒', 'ascii-line': 'ASCII 线', braille: '盲文流', dots: '圆点', orbit: '轨道', clock: '时钟', wave: '波形', blocks: '方块', scan: '扫描', cc: 'Claude Code', custom: '自定义' }, tier: 'basic', default: 'sparkles', group: "等待动画", },
  spinnerCustomFrames: { ...T('chat', '自定义动画帧'), default: '', group: "等待动画", showIf: t => t.spinnerFramePreset === 'custom' },
  spinnerVerbSet: { ...S('chat', '状态文案风格', ['zh', 'en', 'analysis', 'engineering', 'cc', 'custom']), optionLabels: { zh: '中文通用', en: '英文通用', analysis: '分析过程', engineering: '工程任务', cc: 'Claude Code', custom: '自定义' }, default: 'zh', group: "等待动画", },
  spinnerCustomVerbs: { ...T('chat', '自定义状态文案'), default: '', group: "等待动画", showIf: t => t.spinnerVerbSet === 'custom' },
  // CC stalled 渐变（3s 无响应后帧/文案趋向此色）；色值用户自定，不限定红
  spinnerStalledColor: { ...C('chat', '长时间等待颜色'), default: '#FF6B80', group: "等待动画", advanced: true, hint: '连续 3 秒没有新响应时，等待动画会渐变到此颜色', semanticRole: 'state.danger' },
  spinnerDoneMarker: { ...T('chat', '完成标记'), default: '✓', control: 'spinnerMarker', group: "等待动画", },
  spinnerCancelledMarker: { ...T('chat', '取消标记'), default: '■', control: 'spinnerMarker', group: "等待动画", },
  spinnerErrorMarker: { ...T('chat', '错误标记'), default: '!', control: 'spinnerMarker', group: "等待动画", },
  // 模式已内嵌于 spinnerMarker 控件（SpinnerMarkerControl 的 frame/custom 下拉），独立行冗余 → hidden
  spinnerDoneMarkerMode: { ...S('chat', '完成标记模式', ['frame', 'custom']), default: 'custom', group: "等待动画", hidden: true },
  spinnerCancelledMarkerMode: { ...S('chat', '取消标记模式', ['frame', 'custom']), default: 'custom', group: "等待动画", hidden: true },
  spinnerErrorMarkerMode: { ...S('chat', '错误标记模式', ['frame', 'custom']), default: 'custom', group: "等待动画", hidden: true },
  // 动画间隔 JS 驱动（setInterval），无 CSS var 消费 → 不注入
  spinnerIntervalMs: { ...N('chat', '动画帧间隔', 40, 1000, 10), default: 120, group: "等待动画", suffix: 'ms', noCssVar: true },
  spinnerColor: { ...C('chat', '等待动画颜色'), tier: 'basic', default: '', group: "等待动画", semanticRole: 'accent' },
  spinnerSize: { ...N('chat', '等待动画大小', 10, 32), default: 14, group: "等待动画", unit: 'px' },
  msgStyle: { ...S('chat', '消息风格', ['terminal', 'bubble']), optionLabels: { terminal: '终端记录流', bubble: '对话气泡' }, default: 'terminal', control: 'segmented', group: "风格", },
  msgFont: { ...S('chat', '正文渲染字体', ['mono', 'system', 'serif']), optionLabels: {
    mono: '跟随终端等宽体', system: '系统无衬线', serif: '阅读衬线',
  }, default: 'mono', group: "风格", control: 'fontPicker', fontRole: 'content', allowCustomOptions: true, hint: '消息正文（Markdown）的渲染字体，与插件可见的「内容字体」角色同源；不影响内联代码与代码块' },
  // 经 App.tsx 手写 --msg-text 注入，自动派生 --msg-text-color 冗余 → 不注入
  msgTextColor: { ...C('chat', '消息文字'), tier: 'basic', default: '', group: "风格", noCssVar: true, semanticRole: 'content.text' },
  msgLineHeight: { ...N('chat', '消息行距', 1.2, 2.5, 0.1), default: 1.8, group: "风格", },
  messageLayout: { ...S('chat', '消息布局', ['classic', 'claude', 'bubble']), optionLabels: { classic: '经典紧凑', claude: '阅读记录', bubble: '对话气泡' }, default: 'classic', control: 'segmented', group: "风格", },
  messageUserBg: { ...C('chat', '用户消息背景'), default: '', group: "消息外观", },
  messageAssistantBg: { ...C('chat', '助手消息背景'), default: '', group: "消息外观", },
  messageReasoningBg: { ...C('chat', '思考过程背景'), default: '', group: "消息外观", },
  messageBorderColor: { ...C('chat', '消息边框'), default: '', group: "消息外观", semanticRole: 'stroke.default', semanticSource: true },
  messageRadius: { ...N('chat', '消息圆角', 0, 28), default: 0, group: "消息外观", unit: 'px', suffix: 'px' },
  // CC 视觉还原（claude 预设启用）：助手消息 ● 圆点
  assistantDot: { ...B('chat', '显示助手消息标记'), default: false, group: "助手标记" },
  assistantDotGlyph: { ...S('chat', '标记图案', ['●', '■', '✦', '◆', '▶', '❯']), default: '●', group: "助手标记" },
  assistantDotColor: { ...C('chat', '标记颜色'), default: '', group: "助手标记", semanticRole: 'accent' },
  assistantDotImage: { ...T('chat', '自定义头像或图标'), default: '', control: 'bgImage', group: "助手标记", hint: '留空时使用上方图案；也可填写本地图片路径或网络图片地址' },

  // ── cc ──
  ccHeight: {
    ...N('cc', '中控区高度', 0, 500), default: 150,
    // ★ #266 刀3：最小高从"常量 64"改回**按边算取最大**（`ccHeightState.resolveCcMinHeight`）。
    //   设置页这条下界对**两态切面**各算一遍取 max（同落值侧 / 读盘侧口径，见该函数的"两种门态取 max"节）。
    minFn: t => resolveCcMinHeight(ccMinHeightInputOf(t)),
    group: "中控本体面",
  },
  ccMarginX: { ...N('cc', '左右边距（对称）', 0, 100), default: 15, group: "中控本体面", unit: 'px', suffix: 'px' },
  ccMarginBottom: { ...N('cc', '底边距', 0, 100), default: 15, group: "中控本体面", unit: 'px', suffix: 'px' },
  ccRadius: { ...N('cc', '圆角', 0, 30), default: 25, group: "中控本体面", unit: 'px', suffix: 'px' },
  // ★ #266 刀10 连带：中控区背景的**别名变量** `--cc-bg` 唯一 CSS 消费者是已删除的
  //   overlay 浮层面板 ⇒ 它成为死注入（字段本身照旧生效：值由 ControlCenter 内联写成
  //   `--cc-surface`，那是 CSS 真正消费的变量）。故本字段不再经 THEME_CSS_VAR_MAP 注入别名。
  ccBg: { ...C('cc', '中控区背景'), default: '#808080', group: "中控本体面", noCssVar: true },
  ccSurfaceOpacity: { ...N('cc', '透明度', 0, 1, 0.05), default: 1, group: "中控本体面", percent: true, suffix: '%' },
  ccBgImage: { ...T('cc', '中控区背景图'), default: '', control: 'bgImage', group: "中控本体面", },
  ccLayout: H({ type: 'text', label: '布局', zone: 'cc', noCssVar: true }),
  ccHidden: H({ type: 'text', label: '隐藏控件', zone: 'cc', noCssVar: true }),
  // ★ #266 刀4（结构 C）：**空态再藏**（字段键 `ccHiddenEmpty` 保留不改名 —— 改名要动持久化映射，不值）。
  //   它是 `ccHidden`（**主管表**，两种门态都生效）之下的**第二层**：只在空态**再藏**一批，
  //   **只能加、不能抵消** ⇒ 生效名单 = `门 ? 主管 ∪ 再藏 : 主管`（去重）。
  //   规则唯一出处 `domains/cc/widgetDefinitions.ts` 的 `resolveCcHiddenWidgetIds`。
  //   位置将来同样按"主管 + 空态再藏"两份承载（本刀不做，位置仍只有 `ccLayout` 一份）。
  ccHiddenEmpty: H({ type: 'text', label: '空态里再藏', zone: 'cc', noCssVar: true }),
  // A6 输入区：本轮新增字段不投影 semanticRole/semanticSource；旧 inputBg 等字段保留。
  inputOffsetTop: { ...N('cc', '输入栏上间距', 0, 120), default: 10, group: '输入框本体', unit: 'px', suffix: 'px', cssVar: '--cc-input-offset-top' },
  inputHeight: { ...N('cc', '输入栏高度', 0, 200), default: 40, group: '输入框本体', unit: 'px', suffix: 'px', cssVar: '--cc-input-height' },
  inputMarginX: { ...N('cc', '输入栏左右间距', 0, 120), default: 10, group: '输入框本体', unit: 'px', suffix: 'px', cssVar: '--cc-input-margin-x' },
  inputSurfaceBg: { ...C('cc', '输入栏背景色'), default: '#FFFFFF', group: '输入框本体', cssVar: '--cc-input-surface' },
  inputSurfaceOpacity: { ...N('cc', '输入栏背景透明度', 0, 1, 0.05), default: 1, group: '输入框本体', percent: true, suffix: '%', cssVar: '--cc-input-surface-opacity' },
  inputFocusRingEnabled: { ...S('cc', '焦点光环开关', ['shown', 'hidden']), optionLabels: { shown: '显示', hidden: '隐藏' }, default: 'shown', group: '输入框本体' },
  inputFocusRingColor: { ...C('cc', '焦点光环颜色'), default: 'var(--accent)', group: '输入框本体' },
  inputHighlightOpacity: { ...N('cc', '输入栏高光透明度', 0, 1, 0.05), default: 0, group: '输入框本体', percent: true, suffix: '%', cssVar: '--cc-input-highlight-opacity' },
  inputShadowEnabled: { ...S('cc', '输入栏阴影开关', ['shown', 'hidden']), optionLabels: { shown: '显示', hidden: '隐藏' }, default: 'shown', group: '输入框本体' },
  inputBg: { ...C('cc', '输入背景'), default: 'rgba(0,0,0,0.02)', group: "输入框本体", semanticRole: 'surface.raised', semanticSource: true },
  inputBgImage: { ...T('cc', '输入背景图'), default: '', control: 'bgImage', group: "输入框本体", },
  inputTextColor: { ...C('cc', '输入文字'), tier: 'basic', default: 'rgba(0,0,0,0.85)', group: '输入框本体', cssVar: '--cc-input-text' },
  inputPlaceholder: { ...C('cc', '占位提示颜色'), default: 'rgba(0,0,0,0.28)', group: '输入框本体', cssVar: '--cc-input-placeholder' },
  sendButtonColor: { ...C('cc', '发送按钮颜色'), default: '#000000', group: '按钮本体', noCssVar: true },
  sendButtonRadius: { ...S('cc', '发送按钮圆角', ['0', '0.25', '0.33', '0.5']), optionLabels: { '0': '直角', '0.25': '四分之一', '0.33': '三分之一', '0.5': '圆形' }, default: '0.5', group: '按钮本体', noCssVar: true },
  // ★ #266 遗留②：发送按钮的边框色 / 图标色（下方隔两行）也改自由选色 ⇒ 默认值取**等价色**，
  //   不是"纯白/纯黑"：边框原来白档就是**半透明** `rgba(255,255,255,.5)`（旧渲染侧翻出来的），
  //   顺手写成 `#fff` 会让边框静默变实心。老枚举字面量由读盘归一化搬（`domains/theme/migration.ts`）。
  sendButtonBorderColor: { ...C('cc', '发送按钮边框'), default: 'rgba(255,255,255,.5)', group: '按钮本体', noCssVar: true },
  sendButtonIcon: { ...S('cc', '图标形状', ['arrow', 'triangle', 'double-arrow']), optionLabels: { arrow: '箭头', triangle: '三角', 'double-arrow': '双箭头' }, default: 'arrow', group: '图标层', noCssVar: true },
  sendButtonIconGenerating: { ...S('cc', '生成中图标', ['square', 'cross']), optionLabels: { square: '方块', cross: '叉' }, default: 'square', group: '图标层', noCssVar: true },
  sendButtonIconRound: { ...S('cc', '图标圆角', ['on', 'off']), optionLabels: { on: '圆角', off: '直角' }, default: 'on', group: '图标层', noCssVar: true },
  sendButtonIconColor: { ...C('cc', '图标颜色'), default: '#ffffff', group: '图标层', noCssVar: true },
  // ★ #266 CC-29 连带：边框色的**派生变量** `--input-border-color`（缺省派生名）唯一第一方消费者
  //   是输入栏那层"被恒有值的内联 `--cc-input-border` 挡住"的兜底 ⇒ CC-29 删掉那层后它成为死注入。
  //   字段本身照旧生效：它是 `stroke.default` 角色的源（经角色 token 落地），角色解析读的是字段值、
  //   不是这个直投变量 ⇒ 这里只是不再经 THEME_CSS_VAR_MAP 重复注入（同上方 inputFocusBorder 一手）。
  inputBorderColor: { ...C('global', '通用边线色'), default: '', group: "边线", noCssVar: true, semanticRole: 'stroke.default', semanticSource: true, hint: '全应用边线（面板 / 卡片 / 控件）；输入栏不受它影响——输入栏用「输入栏边框色」' },
  // ★ #266 刀12 连带：焦点边框的**别名变量** `--input-focus-border` 唯一第一方消费者是已删除的
  //   replay 只读条 ⇒ 它成为死注入。字段本身照旧生效：它是 `state.focusRing` 角色的源
  //   （经角色 token `--border-focus` 落地），且该别名仍由 `themeCssSnapshot` 的兼容别名表
  //   产出供第三方皮肤消费 ⇒ 这里只是不再经 THEME_CSS_VAR_MAP 重复注入。
  inputFocusBorder: { ...C('cc', '焦点边框'), default: 'rgba(0,0,0,0.22)', group: "输入框本体", noCssVar: true, semanticRole: 'state.focusRing', semanticSource: true },
  inputBorder: { ...C('cc', '输入栏边框色'), default: 'transparent', group: '输入框本体', cssVar: '--cc-input-border' },
  inputBorderWidth: { ...N('cc', '输入栏边框粗细', 0, 8), default: 1, group: '输入框本体', unit: 'px', suffix: 'px', cssVar: '--cc-input-border-width' },
  inputBorderOpacity: { ...N('cc', '输入栏边框透明度', 0, 1, 0.05), default: 0, group: '输入框本体', percent: true, suffix: '%', cssVar: '--cc-input-border-opacity' },
  inputRadius: { ...N('cc', '输入栏圆角', 0, 28), default: 20, group: '输入框本体', unit: 'px', suffix: 'px', cssVar: '--cc-input-radius' },
  inputFontSize: { ...N('cc', '输入字号', 12, 22, 1), tier: 'basic', default: 15, group: '输入框本体', unit: 'px', cssVar: '--cc-input-font-size' },
  inputLineHeight: { ...S('cc', '输入行距', ['0.5', '1', '1.5']), default: '1', group: '输入框本体', cssVar: '--cc-input-line-height' },
  inputShowHistoryHint: { ...B('cc', '显示历史快捷提示'), default: true, group: "历史快捷提示", },
  inputSubmitButtonMode: { ...S('cc', '发送按钮位置', ['inline', 'external', 'hidden']), optionLabels: { inline: '输入栏内', external: '独立按钮', hidden: '隐藏' }, default: 'inline', group: '按钮本体', },
  cliLineWidth: { ...N('cc', '命令行边框宽度', 1, 4), default: 2, group: "上下两条线", unit: 'px' },
  cliLineColor: { ...C('cc', '命令行边框颜色'), default: '', group: "上下两条线", semanticRole: 'connector.default' },
  cliTextColor: { ...C('cc', '命令行文字颜色'), default: '', group: "输入框本体", semanticRole: 'content.text' },
  cliPromptColor: { ...C('cc', '提示符颜色'), default: '', group: "提示符 ❯", semanticRole: 'accent' },
  cliHintMode: { ...S('cc', '快捷提示详细程度', ['hidden', 'compact', 'full']), optionLabels: { hidden: '隐藏', compact: '仅常用项', full: '显示全部' }, default: 'full', group: "提示行", },
  // ★ #238 刀5：命令行提示的字号从「整条信息行」收窄到**它自己**（原来是整行继承
  // `ccStatusFontSize`，用 `0.86em` 折算）。默认 16 与原行字号同值 ⇒ 提示大小不变。
  ccHintFontSize: { ...N('cc', '快捷提示字号', 12, 22, 1), default: 16, group: "提示行", unit: 'px', cssVar: '--cc-hint-font-size' },
  modelSwitchMode: { ...S('cc', '模型切换方式', ['menu', 'cycle']), optionLabels: { menu: '弹菜单', cycle: '点击轮换' }, default: 'menu', group: '模型触发器', noCssVar: true },
  modelBgColor: { ...C('cc', '模型背景色'), default: '#ffffff', group: '模型触发器', noCssVar: true },
  modelWidth: { ...N('cc', '模型宽度', 40, 400, 1), default: 120, group: '模型触发器', noCssVar: true },
  modelHeight: { ...N('cc', '模型高度', 16, 80, 1), default: 28, group: '模型触发器', noCssVar: true },
  modelRadius: { ...N('cc', '模型圆角', 0, 40, 1), default: 0, group: '模型触发器', noCssVar: true },
  modelFontSize: { ...N('cc', '模型字号', 8, 32, 1), default: 12, group: '模型触发器', noCssVar: true },
  modelTextColor: { ...C('cc', '模型文字颜色'), default: '#000000', group: '模型触发器', noCssVar: true },
  reasoningSwitchMode: { ...S('cc', '思考强度切换方式', ['menu', 'cycle']), optionLabels: { menu: '弹菜单', cycle: '点击轮换' }, default: 'menu', group: '思考强度触发器', noCssVar: true },
  reasoningBgColor: { ...C('cc', '思考强度背景色'), default: '#ffffff', group: '思考强度触发器', noCssVar: true },
  reasoningWidth: { ...N('cc', '思考强度宽度', 40, 400, 1), default: 120, group: '思考强度触发器', noCssVar: true },
  reasoningHeight: { ...N('cc', '思考强度高度', 16, 80, 1), default: 28, group: '思考强度触发器', noCssVar: true },
  reasoningRadius: { ...N('cc', '思考强度圆角', 0, 40, 1), default: 0, group: '思考强度触发器', noCssVar: true },
  reasoningFontSize: { ...N('cc', '思考强度字号', 8, 32, 1), default: 12, group: '思考强度触发器', noCssVar: true },
  reasoningTextColor: { ...C('cc', '思考强度文字颜色'), default: '#000000', group: '思考强度触发器', noCssVar: true },
  permissionSwitchMode: { ...S('cc', '权限切换方式', ['menu', 'cycle']), optionLabels: { menu: '弹菜单', cycle: '点击轮换' }, default: 'menu', group: '权限触发器', noCssVar: true },
  permissionBgColor: { ...C('cc', '权限背景色'), default: '#ffffff', group: '权限触发器', noCssVar: true },
  permissionWidth: { ...N('cc', '权限宽度', 40, 400, 1), default: 120, group: '权限触发器', noCssVar: true },
  permissionHeight: { ...N('cc', '权限高度', 16, 80, 1), default: 28, group: '权限触发器', noCssVar: true },
  permissionRadius: { ...N('cc', '权限圆角', 0, 40, 1), default: 0, group: '权限触发器', noCssVar: true },
  permissionFontSize: { ...N('cc', '权限字号', 8, 32, 1), default: 12, group: '权限触发器', noCssVar: true },
  // ★ #266 遗留①：改成自由选色后，**留空 = 原来的「跟模式」档** —— 不写 inline color，交 CSS
  //   `[data-mode]` 的语义色。老数据里的 `'mode'` 由读盘归一化搬成 `''`（`domains/theme/migration.ts`）。
  permissionTextColor: { ...C('cc', '权限文字颜色'), default: '', group: '权限触发器', noCssVar: true, hint: '留空时跟随权限模式各自的语义色（自动 / 绕过 / 编辑）' },
  modeAutoColor: { ...C('cc', '自动模式颜色'), default: '#FFC107', group: "权限触发器", advanced: true, semanticRole: 'state.warning' },
  modeEditColor: { ...C('cc', '编辑模式颜色'), default: '#A2A9E4', group: "权限触发器", advanced: true, semanticRole: 'accent' },

  // ── right ──
  rightBg: { ...C('right', '右栏背景色'), default: 'rgba(0,0,0,0.02)', group: "外观", semanticRole: 'surface.panel', semanticSource: true },
  rightBgImage: { ...T('right', '右栏背景图'), default: '', control: 'bgImage', group: "外观" },
  // W2-12：宽度经 App 计算 rightInset inline 应用，不注入 cssVar
  // 已迁移到 domains/workspace/layoutRailsStore（应用级布局 store）；保留字段仅供旧主题读取，不在设置页渲染。
  rightWidth: { ...N('right', '右栏宽度', 200, 400), default: 260, group: "外观", unit: 'px', noCssVar: true, hidden: true, hint: '已迁移到标题栏右侧栏的拖拽布局' },
  rightTransparency: { ...N('right', '右栏背景不透明度', 0, 1, 0.05), default: 1, group: "玻璃效果", percent: true, suffix: '%' },
  rightBlur: { ...N('right', '右栏模糊', 0, 40, 2), default: 0, group: "玻璃效果", unit: 'px', suffix: 'px' },

  // ── META（持久化但非预设内容）──
  ccEditMode: { default: false, type: 'text', label: '编辑模式', zone: 'cc', noCssVar: true, hidden: true, meta: true },
  appliedPreset: { type: 'text', label: '活动预设', zone: 'global', noCssVar: true, hidden: true, meta: true },
  custom: { type: 'text', label: '脏标记', zone: 'global', noCssVar: true, hidden: true, meta: true },
} as const satisfies Record<keyof ThemeSettings, ThemeFieldDef>

export type ThemeFieldKey = keyof typeof THEME_FIELD_DEFS

export const THEME_FIELD_KEYS = Object.keys(THEME_FIELD_DEFS) as ThemeFieldKey[]

/** 预设白名单（非 META 字段）——替代 customPresets.ts 的 THEME_SETTINGS_KEYS 手写并集 */
export const THEME_SETTING_KEYS: readonly ThemeFieldKey[] = THEME_FIELD_KEYS.filter(key => !THEME_FIELD_DEFS[key].meta)

export const ZONE_FIELDS: Record<string, ThemeFieldKey[]> = ZONES.reduce((acc, zone) => {
  acc[zone] = THEME_FIELD_KEYS.filter(key => THEME_FIELD_DEFS[key].zone === zone && !THEME_FIELD_DEFS[key].meta)
  return acc
}, {} as Record<string, ThemeFieldKey[]>)

/**
 * Machine-readable field owner matrix used by theme persistence and migrations.
 *
 * Most fields remain owned by the theme store.  Layout values that were moved
 * out of ThemeSettings keep their legacy keys for migration compatibility, but
 * their current authority is recorded here so a new field cannot silently
 * become a second source of truth.
 */
export type ThemeFieldOwner = 'theme' | 'workspace-layout' | 'right-rail'

const THEME_FIELD_OWNER_OVERRIDES: Readonly<Partial<Record<ThemeFieldKey, ThemeFieldOwner>>> = Object.freeze({
  sidebarWidth: 'workspace-layout',
  rightWidth: 'right-rail',
})

export const THEME_FIELD_OWNERS: Readonly<Record<ThemeFieldKey, { readonly zone: ZoneName; readonly owner: ThemeFieldOwner }>> = Object.freeze(
  Object.fromEntries(THEME_FIELD_KEYS.map(key => [key, Object.freeze({
    zone: THEME_FIELD_DEFS[key].zone,
    owner: THEME_FIELD_OWNER_OVERRIDES[key] ?? 'theme',
  })])) as Record<ThemeFieldKey, { readonly zone: ZoneName; readonly owner: ThemeFieldOwner }>,
)

/** Preset-owned Theme fields. Workspace/right-rail authorities remain
 * persisted for compatibility but are never captured or overwritten by a
 * Theme preset. */
export const THEME_PRESET_KEYS: readonly ThemeFieldKey[] = THEME_SETTING_KEYS.filter(key =>
  THEME_FIELD_OWNERS[key].owner === 'theme',
)

/** cssVar 注入表：--xxx → 字段名（供 App.tsx 循环注入） */
export const THEME_CSS_VAR_MAP: Readonly<Record<string, ThemeFieldKey>> = THEME_FIELD_KEYS.reduce((acc, key) => {
  const def = THEME_FIELD_DEFS[key]
  if (def.noCssVar) return acc
  if (def.type === 'color' || def.type === 'number' || key === 'inputLineHeight') {
    const cssVar = def.cssVar ?? `--${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`
    acc[cssVar] = key
  }
  return acc
}, {} as Record<string, ThemeFieldKey>)

/** kebab-case 字段名 → cssVar（无显式声明时） */
export function fieldToCssVar(key: string): string {
  return `--${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`
}

/**
 * 成员 label → 它名下的字段键（★ #238 刀6 起**派生**，定义表里那份手写清单已删除）。
 *
 * 真值只有一处：**每个字段自己身上的 `group`**（用户口径「归属放在字段」= `def.group` 的值就是子部件名）。
 * 派生只能放在**这一侧**：定义表若要自己算，就得运行时 import 本文件 —— 那正是该表表头
 * 写明的「头号雷」（会成环，症状是静默的 undefined）。方向仍是一条：本文件 → 定义表。
 */
export const CC_MEMBER_FIELDS: Readonly<Record<string, readonly ThemeFieldKey[]>> = Object.freeze(
  Object.fromEntries(
    CC_WIDGET_GROUPS.flatMap(row => row.members.map(member => [
      member.label,
      THEME_FIELD_KEYS.filter(key => {
        const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
        return def.zone === 'cc' && def.group === member.label
      }),
    ])),
  ),
)

/** 该子部件名下**能在设置页渲染出来**的字段（`hidden` 的不算）—— 决定这个子部件要不要出现在分组表里。 */
function renderableMemberFields(label: string): readonly ThemeFieldKey[] {
  return (CC_MEMBER_FIELDS[label] ?? []).filter(key => !(THEME_FIELD_DEFS[key] as ThemeFieldDef).hidden)
}

/**
 * Settings 分组映射（声明式 UI 按此渲染字段组）。
 * 纯字段组由渲染器自动生成；含自定义内容的组（预设/强调色/布局骨架/
 * 窗口/配置备份/布局编辑）保留在 Settings 手写。
 *
 * ★ #238 刀6：`cc` 区改成**派生** —— 分区（h3）= 定义表里各**元件**的 label，
 *   组 = 该元件下**有可调项**的子部件 label（顺序同表）。其余 zone 仍是手写表。
 *   没有可调项的子部件**不进列表**（否则渲染出一个只有标题、点了没东西的分类 —— 那正是本刀要清的病）。
 */
export const GROUP_ORDER: Record<string, readonly { heading?: string; groups: readonly { title: string; compact?: boolean; defaultOpen?: boolean }[] }[]> = {
  global: [{ groups: [{ title: '个人信息' }, { title: '强调色' }, { title: '边线' }, { title: '布局骨架' }, { title: '玻璃效果' }, { title: '标题栏' }, { title: '字体' }] }],
  sidebar: [{ groups: [{ title: '背景' }, { title: '布局' }, { title: '玻璃效果' }, { title: '文字' }] }],
  chat: [
    // 高频组默认展开；低频组（语法高亮/代码差异/助手标记）默认折叠，搜索时强制展开
    { heading: '聊天区', groups: [{ title: '背景' }, { title: '字体' }, { title: '颜色', compact: true }, { title: '语法高亮', compact: true, defaultOpen: false }] },
    { heading: '工具调用', groups: [{ title: '指示器与连接线' }, { title: '用户标签', compact: true }, { title: '代码差异', defaultOpen: false }, { title: '等待动画' }] },
    { heading: '消息渲染', groups: [{ title: '风格', compact: true }, { title: '消息外观', compact: true }, { title: '助手标记', defaultOpen: false }, { title: '文件编辑器', defaultOpen: false }] },
  ],
  cc: CC_WIDGET_GROUPS
    .map(row => ({
      heading: row.label,
      groups: row.members
        .filter(member => renderableMemberFields(member.label).length > 0)
        .map(member => ({ title: member.label })),
    }))
    .filter(section => section.groups.length > 0),
  right: [{ groups: [{ title: '外观' }, { title: '玻璃效果' }] }],
}
/** W2-13（F3-A）：快速层基础字段清单（来自 defs 单一真值，组件不硬编码） */
export function resolveBasicThemeFields(): string[] {
  return THEME_FIELD_KEYS.filter(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).tier === 'basic')
}

export const THEME_DEFAULTS: Record<string, string | number | boolean> = Object.fromEntries(
  THEME_FIELD_KEYS
    .filter(key => (THEME_FIELD_DEFS[key] as ThemeFieldDef).default !== undefined)
    .map(key => [key, (THEME_FIELD_DEFS[key] as ThemeFieldDef).default as string | number | boolean]),
)

/**
 * defs 驱动的值归一化（声明式校验器）：
 * select 越枚举 → def.default；number 非有限/越界 → clamp 或 def.default；
 * boolean/color/text 类型不符 → def.default。
 */
export function normalizeThemeValue(def: ThemeFieldDef, value: unknown): string | number | boolean {
  switch (def.type) {
    case 'select':
      if (def.allowCustomOptions && typeof value === 'string' && value.trim()) return value
      return (def.options ?? []).includes(value as string) ? (value as string) : (def.default as string ?? '')
    case 'number': {
      if (value === null || value === undefined) return (def.default as number) ?? 0
      const n = Number(value)
      if (!Number.isFinite(n)) return (def.default as number) ?? 0
      const min = def.min ?? -Infinity
      const max = def.max ?? Infinity
      return Math.min(max, Math.max(min, n))
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : ((def.default as boolean) ?? false)
    case 'color':
    case 'text':
      return typeof value === 'string' ? value : (def.default as string ?? '')
  }
}

/**
 * 对持久化主题做全字段归一化（migrate 通用 pass）。
 * 跳过与 defs 类型不完全一致的历史字段（由调用方保留既有语义）：
 * - inputFocusRingEnabled/inputShadowEnabled：迁移阶段兼容 boolean，归一化为 shown/hidden
 * - toolIndicator：有效值来自 widgetRegistry 动态选项（defs 仅是展示子集）
 */
export function normalizeThemeState<T extends Record<string, unknown>>(state: T): T {
  const next = { ...state } as Record<string, unknown>
  for (const key of THEME_FIELD_KEYS) {
    if (key === 'inputFocusRingEnabled' || key === 'inputShadowEnabled' || key === 'toolIndicator') continue
    const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
    if (def.default === undefined) continue
    if (next[key] === undefined) continue
    // 持久化 select 可能来自运行时插件候选项；水合时插件 Registry 尚未激活，
    // 不得因静态 options 暂时不包含该值就悄悄改回默认。Presentation Profile
    // 注册仍直接调用 normalizeThemeValue，继续使用严格静态校验。
    const v = next[key]
    if (def.type === 'select' && typeof v === 'string' && v.trim()) continue
    next[key] = normalizeThemeValue(def, next[key])
  }
  return next as T
}
