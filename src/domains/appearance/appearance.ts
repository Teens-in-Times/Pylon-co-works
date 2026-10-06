import { cloneCcLayout, type CcLayoutV3 } from '../cc/ccLayoutState.ts'
import { cloneCcPluginProps, type CcPluginProps } from '../cc/ccPluginProps.ts'
import { getSpinnerAssetPreset, getSpinnerVerbPreset, type SpinnerAssetId } from '../chat/spinnerAssets.ts'
import { resolveSpinnerFrames, type SpinnerMarkerMode } from '../chat/spinnerFrames.ts'
import type { ThemeSettings } from '../theme/themeStore.ts'
import type { CcWidgetPlacement } from '../cc/ccLayoutState.ts'
import type { CcVisibilityTarget } from '../cc/ccLayoutState.ts'
import type { CcEditablePropertyKey, CcPropertyCommand } from '../cc/widgetDefinitions.ts'

export interface SpinnerAppearanceSnapshot {
  framePreset: SpinnerAssetId
  frames: readonly string[]
  motion: ReturnType<typeof getSpinnerAssetPreset>['motion']
  direction?: 'forward' | 'reverse' | 'alternate'
  intervalMs: number
  verbSet: string
  verbs: readonly string[]
  color: string
  stalledColor: string
  size: number
  doneMarker: string
  cancelledMarker: string
  errorMarker: string
  doneMarkerMode: SpinnerMarkerMode
  cancelledMarkerMode: SpinnerMarkerMode
  errorMarkerMode: SpinnerMarkerMode
}

export interface WorkbenchAppearanceSnapshot {
  revision: number
  uiScheme: 'light' | 'dark'
  msgStyle: string
  messageLayout: 'classic' | 'claude' | 'bubble'
  userName: string
  userPrefix: string
  userColor: string
  assistantDot: boolean
  assistantDotGlyph: string
  assistantDotColor: string
  assistantDotImage: string
  toolIndicator: string
  toolIndicatorRun: string
  toolIndicatorOk: string
  toolIndicatorErr: string
  toolIndicatorGlow: number
  toolIndicatorGlowColor: string
  toolConnectorMode: string
  toolConnectorColor: string
  toolConnectorStyle: string
  toolConnectorWidth: number
  toolConnectorOpacity: number
  inputOffsetTop: number
  inputHeight: number
  inputMarginX: number
  inputSurfaceBg: string
  inputSurfaceOpacity: number
  inputFocusRingEnabled: boolean
  inputFocusRingColor: string
  inputHighlightOpacity: number
  inputShadowEnabled: boolean
  inputBorder: string
  inputBorderWidth: number
  inputBorderOpacity: number
  inputRadius: number
  inputFontSize: number
  inputLineHeight: string
  inputTextColor: string
  inputPlaceholder: string
  inputShowHistoryHint: boolean
  inputSubmitButtonMode: string
  reasoningSwitchMode: string
  reasoningBgColor: string
  reasoningWidth: number
  reasoningHeight: number
  reasoningRadius: number
  reasoningFontSize: number
  reasoningTextColor: string
  sendButtonColor: string
  sendButtonRadius: string
  sendButtonBorderColor: string
  sendButtonIcon: string
  sendButtonIconGenerating: string
  sendButtonIconRound: string
  sendButtonIconColor: string
  modelSwitchMode: string
  modelBgColor: string
  modelWidth: number
  modelHeight: number
  modelRadius: number
  modelFontSize: number
  modelTextColor: string
  permissionSwitchMode: string
  permissionBgColor: string
  permissionWidth: number
  permissionHeight: number
  permissionRadius: number
  permissionFontSize: number
  permissionTextColor: string
  cliHintMode: string
  ccHeight: number
  ccBg: string
  ccBgImage: string
  ccSurfaceOpacity: number
  ccMarginX: number
  ccMarginBottom: number
  ccRadius: number
  ccLayout: CcLayoutV3
  /**
   * ★ #266 CC-13 刀4：**插件元件的属性值**（`Record<元件 id, Record<插件短键, string | number>>`）。
   * 深拷贝 + 深冻结（与 `ccLayout` 同款）—— 面板读它、`host:input` 的 `props` 段也读它。
   */
  ccPluginProps: CcPluginProps
  ccHidden: readonly string[]
  /** ★ #266 刀4（结构 C）：**空态再藏**（`ccHiddenEmpty` 字段名保留）—— 只在空态**再加一层**，只能加、不能抵消主管表 */
  ccHiddenEmpty: readonly string[]
  ccEditMode: boolean
  ccProperties: Readonly<Pick<ThemeSettings, CcEditablePropertyKey>>
  spinner: SpinnerAppearanceSnapshot
}

export type AppearanceCommand =
  | { type: 'set-cc-edit-mode'; enabled: boolean }
  /** ★ #266 刀4：`target` 指定写**哪份表**（主管 / 再藏）—— 写入不再"认门" */
  | { type: 'set-cc-hidden'; id: string; hidden: boolean; target: CcVisibilityTarget }
  | { type: 'set-cc-height'; height: number }
  | { type: 'update-cc-placement'; id: string; placement: Partial<CcWidgetPlacement> }
  /**
   * ★ #266 CC-13 刀4：**写一条插件元件的属性值**（编辑列属性面板的唯一落点）。
   * 值住在主题 cc 区的 `ccPluginProps`（随预设走）；幂等：写同值 ⇒ 不产生新对象。
   * ★ 面板侧已 clamp（number 取 min–max / chips 白名单 / color 只收字符串）；
   *   本命令侧只查类型（非 `string | number` 或不安全数字 ⇒ no-op）。
   */
  | { type: 'set-cc-plugin-prop'; id: string; key: string; value: string | number }
  /**
   * ★★ #266 CC-13 刀3 立、**刀4 泛化**：**清掉某元件的全部用户数据** —— 一次清三样：
   * 位置记录（`ccLayout.placements[id]`）、插件属性（`ccPluginProps[id]`）、
   * 两份显隐表（`ccHidden` / `ccHiddenEmpty`）里的该 id。
   * 派发时机 = 插件**撤下那一刻**（宿主比对活名单）；三样都不存在 ⇒ 两路都**原样不动**（幂等）。
   */
  | { type: 'clear-cc-widget-data'; id: string }
  | CcPropertyCommand
  | { type: 'reset-cc-layout' }

export interface WorkbenchAppearanceStore {
  getSnapshot(): WorkbenchAppearanceSnapshot
  subscribe(listener: () => void): () => void
  dispatch(command: AppearanceCommand): void
  destroy(): void
}

export function selectWorkbenchAppearance(
  theme: Readonly<ThemeSettings>,
  revision: number,
): WorkbenchAppearanceSnapshot {
  const asset = getSpinnerAssetPreset(theme.spinnerFramePreset)
  const verbPreset = getSpinnerVerbPreset(theme.spinnerVerbSet)
  const frames = resolveSpinnerFrames(theme.spinnerFramePreset, theme.spinnerCustomFrames)
  const customVerbs = theme.spinnerCustomVerbs
    .split(/[\n,，]+/)
    .map(verb => verb.trim())
    .filter(Boolean)

  return freezeAppearanceSnapshot({
    revision,
    uiScheme: theme.uiScheme === 'dark' ? 'dark' : 'light',
    msgStyle: theme.msgStyle || 'terminal',
    messageLayout: theme.messageLayout,
    userName: theme.userName,
    userPrefix: theme.userPrefix,
    userColor: theme.userColor,
    assistantDot: theme.assistantDot,
    assistantDotGlyph: theme.assistantDotGlyph,
    assistantDotColor: theme.assistantDotColor,
    assistantDotImage: theme.assistantDotImage,
    toolIndicator: theme.toolIndicator,
    toolIndicatorRun: theme.toolIndicatorRun || theme.toolIndicator,
    toolIndicatorOk: theme.toolIndicatorOk || theme.toolIndicator,
    toolIndicatorErr: theme.toolIndicatorErr || theme.toolIndicator,
    toolIndicatorGlow: theme.toolIndicatorGlow,
    toolIndicatorGlowColor: theme.toolIndicatorGlowColor,
    toolConnectorMode: theme.toolConnectorMode,
    toolConnectorColor: theme.toolConnectorColor,
    toolConnectorStyle: theme.toolConnectorStyle,
    toolConnectorWidth: theme.toolConnectorWidth,
    toolConnectorOpacity: theme.toolConnectorOpacity,
    inputOffsetTop: theme.inputOffsetTop,
    inputHeight: theme.inputHeight,
    inputMarginX: theme.inputMarginX,
    inputSurfaceBg: theme.inputSurfaceBg,
    inputSurfaceOpacity: theme.inputSurfaceOpacity,
    inputFocusRingEnabled: theme.inputFocusRingEnabled !== 'hidden',
    inputFocusRingColor: theme.inputFocusRingColor || 'var(--accent)',
    inputHighlightOpacity: theme.inputHighlightOpacity,
    inputShadowEnabled: theme.inputShadowEnabled !== 'hidden',
    inputBorder: theme.inputBorder,
    inputBorderWidth: theme.inputBorderWidth,
    inputBorderOpacity: theme.inputBorderOpacity,
    inputRadius: theme.inputRadius,
    inputFontSize: theme.inputFontSize,
    inputLineHeight: theme.inputLineHeight,
    inputTextColor: theme.inputTextColor,
    inputPlaceholder: theme.inputPlaceholder,
    inputShowHistoryHint: theme.inputShowHistoryHint !== false,
    inputSubmitButtonMode: theme.inputSubmitButtonMode,
    sendButtonColor: theme.sendButtonColor,
    sendButtonRadius: theme.sendButtonRadius,
    sendButtonBorderColor: theme.sendButtonBorderColor,
    sendButtonIcon: theme.sendButtonIcon,
    sendButtonIconGenerating: theme.sendButtonIconGenerating,
    sendButtonIconRound: theme.sendButtonIconRound,
    sendButtonIconColor: theme.sendButtonIconColor,
    modelSwitchMode: theme.modelSwitchMode,
    modelBgColor: theme.modelBgColor,
    modelWidth: theme.modelWidth,
    modelHeight: theme.modelHeight,
    modelRadius: theme.modelRadius,
    modelFontSize: theme.modelFontSize,
    modelTextColor: theme.modelTextColor,
    reasoningSwitchMode: theme.reasoningSwitchMode,
    reasoningBgColor: theme.reasoningBgColor,
    reasoningWidth: theme.reasoningWidth,
    reasoningHeight: theme.reasoningHeight,
    reasoningRadius: theme.reasoningRadius,
    reasoningFontSize: theme.reasoningFontSize,
    reasoningTextColor: theme.reasoningTextColor,
    permissionSwitchMode: theme.permissionSwitchMode,
    permissionBgColor: theme.permissionBgColor,
    permissionWidth: theme.permissionWidth,
    permissionHeight: theme.permissionHeight,
    permissionRadius: theme.permissionRadius,
    permissionFontSize: theme.permissionFontSize,
    permissionTextColor: theme.permissionTextColor,
    cliHintMode: theme.cliHintMode,
    ccHeight: theme.ccHeight,
    ccBg: theme.ccBg,
    ccBgImage: theme.ccBgImage,
    ccSurfaceOpacity: theme.ccSurfaceOpacity,
    ccMarginX: theme.ccMarginX,
    ccMarginBottom: theme.ccMarginBottom,
    ccRadius: theme.ccRadius,
    ccLayout: cloneCcLayout(theme.ccLayout),
    // ★ #266 CC-13 刀4：插件属性值与 ccLayout 同款（深拷贝 + 深冻结，见 freezeAppearanceSnapshot）
    ccPluginProps: cloneCcPluginProps(theme.ccPluginProps),
    ccHidden: [...theme.ccHidden],
    // ★ #266 刀4：两份表（主管 / 再藏）同形平铺 —— "合并成生效名单"在 `resolveCcHiddenWidgetIds` 里做，
    //   快照不预先选边（渲染侧要按门决定，工具栏两个开关还要各读各自那一份）
    ccHiddenEmpty: [...theme.ccHiddenEmpty],
    ccEditMode: theme.ccEditMode,
    ccProperties: selectCcProperties(theme),
    spinner: {
      framePreset: theme.spinnerFramePreset,
      frames: [...frames],
      motion: asset.motion,
      direction: asset.direction,
      intervalMs: Math.max(40, Math.min(1000, theme.spinnerIntervalMs || asset.defaultIntervalMs)),
      verbSet: theme.spinnerVerbSet,
      verbs: theme.spinnerVerbSet === 'custom' && customVerbs.length > 0 ? customVerbs : [...verbPreset.verbs],
      color: theme.spinnerColor,
      stalledColor: theme.spinnerStalledColor,
      size: theme.spinnerSize,
      doneMarker: theme.spinnerDoneMarker,
      cancelledMarker: theme.spinnerCancelledMarker,
      errorMarker: theme.spinnerErrorMarker,
      doneMarkerMode: theme.spinnerDoneMarkerMode,
      cancelledMarkerMode: theme.spinnerCancelledMarkerMode,
      errorMarkerMode: theme.spinnerErrorMarkerMode,
    },
  })
}

export function areWorkbenchAppearancesEqual(
  left: WorkbenchAppearanceSnapshot,
  right: WorkbenchAppearanceSnapshot,
): boolean {
  return appearanceSignature(left) === appearanceSignature(right)
}

function appearanceSignature(snapshot: WorkbenchAppearanceSnapshot): string {
  const { revision: _revision, ...appearance } = snapshot
  return JSON.stringify(appearance)
}

function freezeAppearanceSnapshot(snapshot: WorkbenchAppearanceSnapshot): WorkbenchAppearanceSnapshot {
  Object.freeze(snapshot.ccLayout.placements)
  for (const placement of Object.values(snapshot.ccLayout.placements)) Object.freeze(placement)
  Object.freeze(snapshot.ccLayout)
  // ★ #266 CC-13 刀4：插件属性值同样深冻结（外层表 + 每个元件的记录）——
  //   快照是给渲染层读的只读面，浅冻结会让"随手改一条"从后门改到快照上。
  Object.freeze(snapshot.ccPluginProps)
  for (const record of Object.values(snapshot.ccPluginProps)) Object.freeze(record)
  Object.freeze(snapshot.ccHidden)
  Object.freeze(snapshot.ccHiddenEmpty)
  Object.freeze(snapshot.ccProperties)
  Object.freeze(snapshot.spinner.frames)
  Object.freeze(snapshot.spinner.verbs)
  Object.freeze(snapshot.spinner)
  return Object.freeze(snapshot)
}

export function selectCcProperties(theme: Readonly<ThemeSettings>): Pick<ThemeSettings, CcEditablePropertyKey> {
  return {
    inputBg: theme.inputBg,
    inputTextColor: theme.inputTextColor,
    inputFontSize: theme.inputFontSize,
    inputHeight: theme.inputHeight,
    inputOffsetTop: theme.inputOffsetTop,
    inputLineHeight: theme.inputLineHeight,
    cliLineWidth: theme.cliLineWidth,
    cliLineColor: theme.cliLineColor,
    modelSwitchMode: theme.modelSwitchMode,
    modelBgColor: theme.modelBgColor,
    modelWidth: theme.modelWidth,
    modelHeight: theme.modelHeight,
    modelRadius: theme.modelRadius,
    modelFontSize: theme.modelFontSize,
    modelTextColor: theme.modelTextColor,
    reasoningSwitchMode: theme.reasoningSwitchMode,
    reasoningBgColor: theme.reasoningBgColor,
    reasoningWidth: theme.reasoningWidth,
    reasoningHeight: theme.reasoningHeight,
    reasoningRadius: theme.reasoningRadius,
    reasoningFontSize: theme.reasoningFontSize,
    reasoningTextColor: theme.reasoningTextColor,
    permissionSwitchMode: theme.permissionSwitchMode,
    permissionBgColor: theme.permissionBgColor,
    permissionWidth: theme.permissionWidth,
    permissionHeight: theme.permissionHeight,
    permissionRadius: theme.permissionRadius,
    permissionFontSize: theme.permissionFontSize,
    permissionTextColor: theme.permissionTextColor,
  }
}
