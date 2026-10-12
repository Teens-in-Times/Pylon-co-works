/**
 * 区域层 · 出厂区域预设数据 —— terminal 桶 / cc 区域（刀2 / #223）。
 *
 * ★ **本文件是出厂区域预设的落盘数据（刀2 / #223 产出）；生成脚本已于刀3 删除——本文件即真值本体，手改即生效（#488 批⑥）。**
 *   它是**唯一真值**：10 套出厂预设的有效值由它算出（`effectivePresetTheme`）——
 *   改这里的任何一个值，等于改掉所有引用它的预设。历史来源见 `.agents/records/issue-223-factory-zone-presets-as-data.md`。
 * 值 = 生成时刻的 `pickZoneFields(GLOBAL_PRESETS[来源].theme, 'cc')`，逐字段照抄
 * （含终端补全烘入的默认值；cc 区含 ccLayout / ccHidden / ccHiddenEmpty **名单字段**与
 *   ccPluginProps **插件属性值**—— `ccHidden` = 主管表、`ccHiddenEmpty` = 空态再藏，语义见 #266 刀4 与
 *   `resolveCcHiddenWidgetIds`；`ccPluginProps` 出厂一律 `{}`：预设不携带插件参数，切预设即清空
 *   （与「参数随预设走」同一条规矩，语义见 `domains/cc/ccPluginProps.ts`）。
 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_TERMINAL_CC: readonly ZonePresetEntry[] = [
  {
    id: 'claude',
    mode: 'terminal',
    zone: 'cc',
    label: 'Claude 风格',
    origin: 'factory',
    source: { presetName: 'claude' },
    values: {
      ccHeight: 76,
      ccMarginX: 15,
      ccMarginBottom: 15,
      ccRadius: 25,
      ccBg: "#000000",
      ccSurfaceOpacity: 1,
      ccBgImage: "",
      ccLayout: {
        "version": 9,
        "placements": {
          "input": {
            "order": 1,
            "offsetX": 0,
            "offsetY": 0
          },
          "model": {
            "order": 2,
            "offsetX": 0,
            "offsetY": 0
          },
          "reasoning": {
            "order": 3,
            "offsetX": 0,
            "offsetY": 0
          },
          "mode": {
            "order": 4,
            "offsetX": 0,
            "offsetY": 0
          },
          "tokens": {
            "order": 5,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-command-hint": {
            "order": 6,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-send-button": {
            "order": 0,
            "offsetX": 0,
            "offsetY": 0
          }
        }
      },
      ccPluginProps: {},
      ccHidden: [
        "cc-send-button"
      ],
      ccHiddenEmpty: [
        "model",
        "reasoning",
        "mode",
        "tokens",
        "cc-send-button",
        "cc-command-hint"
      ],
      inputOffsetTop: 10,
      inputHeight: 40,
      inputMarginX: 10,
      inputSurfaceBg: "#FFFFFF",
      inputSurfaceOpacity: 1,
      inputFocusRingEnabled: "shown",
      inputFocusRingColor: "var(--accent)",
      inputHighlightOpacity: 0,
      inputShadowEnabled: "shown",
      inputBg: "transparent",
      inputBgImage: "",
      inputTextColor: "#FFFFFF",
      inputPlaceholder: "#999999",
      sendButtonColor: "#000000",
      sendButtonRadius: "0.5",
      sendButtonBorderColor: "rgba(255,255,255,.5)",
      sendButtonIcon: "arrow",
      sendButtonIconGenerating: "square",
      sendButtonIconRound: "on",
      sendButtonIconColor: "#ffffff",
      inputFocusBorder: "#505050",
      inputBorder: "transparent",
      inputBorderWidth: 1,
      inputBorderOpacity: 0,
      inputRadius: 20,
      inputFontSize: 15,
      inputLineHeight: "1",
      inputShowHistoryHint: true,
      inputSubmitButtonMode: "inline",
      cliLineWidth: 2,
      cliLineColor: "#888888",
      cliTextColor: "#FFFFFF",
      cliPromptColor: "#999999",
      cliHintMode: "full",
      ccHintFontSize: 16,
      modelSwitchMode: "cycle",
      modelBgColor: "#ffffff",
      modelWidth: 120,
      modelHeight: 28,
      modelRadius: 0,
      modelFontSize: 12,
      modelTextColor: "#000000",
      reasoningSwitchMode: "menu",
      reasoningBgColor: "#ffffff",
      reasoningWidth: 120,
      reasoningHeight: 28,
      reasoningRadius: 0,
      reasoningFontSize: 12,
      reasoningTextColor: "#000000",
      permissionSwitchMode: "cycle",
      permissionBgColor: "#ffffff",
      permissionWidth: 120,
      permissionHeight: 28,
      permissionRadius: 0,
      permissionFontSize: 12,
      permissionTextColor: "",
      modeAutoColor: "#FFC107",
      modeEditColor: "#A2A9E4",
    },
  },
  {
    id: 'nord',
    mode: 'terminal',
    zone: 'cc',
    label: 'Nord Frost',
    origin: 'factory',
    source: { presetName: 'nord' },
    values: {
      ccHeight: 96,
      ccMarginX: 15,
      ccMarginBottom: 15,
      ccRadius: 25,
      ccBg: "#252838",
      ccSurfaceOpacity: 1,
      ccBgImage: "",
      ccLayout: {
        "version": 9,
        "placements": {
          "input": {
            "order": 1,
            "offsetX": 0,
            "offsetY": 0
          },
          "model": {
            "order": 2,
            "offsetX": 0,
            "offsetY": 0
          },
          "reasoning": {
            "order": 3,
            "offsetX": 0,
            "offsetY": 0
          },
          "mode": {
            "order": 4,
            "offsetX": 0,
            "offsetY": 0
          },
          "tokens": {
            "order": 5,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-command-hint": {
            "order": 6,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-send-button": {
            "order": 0,
            "offsetX": 0,
            "offsetY": 0
          }
        }
      },
      ccPluginProps: {},
      ccHidden: [
        "cc-send-button"
      ],
      ccHiddenEmpty: [
        "model",
        "reasoning",
        "mode",
        "tokens",
        "cc-send-button",
        "cc-command-hint"
      ],
      inputOffsetTop: 10,
      inputHeight: 40,
      inputMarginX: 10,
      inputSurfaceBg: "#FFFFFF",
      inputSurfaceOpacity: 1,
      inputFocusRingEnabled: "shown",
      inputFocusRingColor: "var(--accent)",
      inputHighlightOpacity: 0,
      inputShadowEnabled: "shown",
      inputBg: "rgba(255,255,255,0.03)",
      inputBgImage: "",
      inputTextColor: "#e5e9f0",
      inputPlaceholder: "rgba(229,233,240,0.20)",
      sendButtonColor: "#000000",
      sendButtonRadius: "0.5",
      sendButtonBorderColor: "rgba(255,255,255,.5)",
      sendButtonIcon: "arrow",
      sendButtonIconGenerating: "square",
      sendButtonIconRound: "on",
      sendButtonIconColor: "#ffffff",
      inputFocusBorder: "rgba(136,192,208,0.45)",
      inputBorder: "transparent",
      inputBorderWidth: 1,
      inputBorderOpacity: 0,
      inputRadius: 20,
      inputFontSize: 15,
      inputLineHeight: "1",
      inputShowHistoryHint: true,
      inputSubmitButtonMode: "inline",
      cliLineWidth: 2,
      cliLineColor: "#7f8ea3",
      cliTextColor: "#e5e9f0",
      cliPromptColor: "#9aa7bd",
      cliHintMode: "compact",
      ccHintFontSize: 16,
      modelSwitchMode: "cycle",
      modelBgColor: "#ffffff",
      modelWidth: 120,
      modelHeight: 28,
      modelRadius: 0,
      modelFontSize: 12,
      modelTextColor: "#000000",
      reasoningSwitchMode: "menu",
      reasoningBgColor: "#ffffff",
      reasoningWidth: 120,
      reasoningHeight: 28,
      reasoningRadius: 0,
      reasoningFontSize: 12,
      reasoningTextColor: "#000000",
      permissionSwitchMode: "menu",
      permissionBgColor: "#ffffff",
      permissionWidth: 120,
      permissionHeight: 28,
      permissionRadius: 0,
      permissionFontSize: 12,
      permissionTextColor: "",
      modeAutoColor: "#ebcb8b",
      modeEditColor: "#88c0d0",
    },
  },
  {
    id: 'tokyo',
    mode: 'terminal',
    zone: 'cc',
    label: 'Tokyo Night',
    origin: 'factory',
    source: { presetName: 'tokyo' },
    values: {
      ccHeight: 96,
      ccMarginX: 15,
      ccMarginBottom: 15,
      ccRadius: 25,
      ccBg: "#1a1b26",
      ccSurfaceOpacity: 1,
      ccBgImage: "",
      ccLayout: {
        "version": 9,
        "placements": {
          "input": {
            "order": 1,
            "offsetX": 0,
            "offsetY": 0
          },
          "model": {
            "order": 2,
            "offsetX": 0,
            "offsetY": 0
          },
          "reasoning": {
            "order": 3,
            "offsetX": 0,
            "offsetY": 0
          },
          "mode": {
            "order": 4,
            "offsetX": 0,
            "offsetY": 0
          },
          "tokens": {
            "order": 5,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-command-hint": {
            "order": 6,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-send-button": {
            "order": 0,
            "offsetX": 0,
            "offsetY": 0
          }
        }
      },
      ccPluginProps: {},
      ccHidden: [
        "cc-send-button"
      ],
      ccHiddenEmpty: [
        "model",
        "reasoning",
        "mode",
        "tokens",
        "cc-send-button",
        "cc-command-hint"
      ],
      inputOffsetTop: 10,
      inputHeight: 40,
      inputMarginX: 10,
      inputSurfaceBg: "#FFFFFF",
      inputSurfaceOpacity: 1,
      inputFocusRingEnabled: "shown",
      inputFocusRingColor: "var(--accent)",
      inputHighlightOpacity: 0,
      inputShadowEnabled: "shown",
      inputBg: "transparent",
      inputBgImage: "",
      inputTextColor: "#c0caf5",
      inputPlaceholder: "#565f89",
      sendButtonColor: "#000000",
      sendButtonRadius: "0.5",
      sendButtonBorderColor: "rgba(255,255,255,.5)",
      sendButtonIcon: "arrow",
      sendButtonIconGenerating: "square",
      sendButtonIconRound: "on",
      sendButtonIconColor: "#ffffff",
      inputFocusBorder: "#7aa2f7",
      inputBorder: "transparent",
      inputBorderWidth: 1,
      inputBorderOpacity: 0,
      inputRadius: 20,
      inputFontSize: 15,
      inputLineHeight: "1",
      inputShowHistoryHint: true,
      inputSubmitButtonMode: "inline",
      cliLineWidth: 2,
      cliLineColor: "#565f89",
      cliTextColor: "#c0caf5",
      cliPromptColor: "#7f89b0",
      cliHintMode: "compact",
      ccHintFontSize: 16,
      modelSwitchMode: "cycle",
      modelBgColor: "#ffffff",
      modelWidth: 120,
      modelHeight: 28,
      modelRadius: 0,
      modelFontSize: 12,
      modelTextColor: "#000000",
      reasoningSwitchMode: "menu",
      reasoningBgColor: "#ffffff",
      reasoningWidth: 120,
      reasoningHeight: 28,
      reasoningRadius: 0,
      reasoningFontSize: 12,
      reasoningTextColor: "#000000",
      permissionSwitchMode: "cycle",
      permissionBgColor: "#ffffff",
      permissionWidth: 120,
      permissionHeight: 28,
      permissionRadius: 0,
      permissionFontSize: 12,
      permissionTextColor: "",
      modeAutoColor: "#e0af68",
      modeEditColor: "#7aa2f7",
    },
  },
  {
    id: 'amber',
    mode: 'terminal',
    zone: 'cc',
    label: 'Amber CRT',
    origin: 'factory',
    source: { presetName: 'amber' },
    values: {
      ccHeight: 96,
      ccMarginX: 15,
      ccMarginBottom: 15,
      ccRadius: 25,
      ccBg: "#120b00",
      ccSurfaceOpacity: 1,
      ccBgImage: "",
      ccLayout: {
        "version": 9,
        "placements": {
          "input": {
            "order": 1,
            "offsetX": 0,
            "offsetY": 0
          },
          "model": {
            "order": 2,
            "offsetX": 0,
            "offsetY": 0
          },
          "reasoning": {
            "order": 3,
            "offsetX": 0,
            "offsetY": 0
          },
          "mode": {
            "order": 4,
            "offsetX": 0,
            "offsetY": 0
          },
          "tokens": {
            "order": 5,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-command-hint": {
            "order": 6,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-send-button": {
            "order": 0,
            "offsetX": 0,
            "offsetY": 0
          }
        }
      },
      ccPluginProps: {},
      ccHidden: [
        "cc-send-button"
      ],
      ccHiddenEmpty: [
        "model",
        "reasoning",
        "mode",
        "tokens",
        "cc-send-button",
        "cc-command-hint"
      ],
      inputOffsetTop: 10,
      inputHeight: 40,
      inputMarginX: 10,
      inputSurfaceBg: "#FFFFFF",
      inputSurfaceOpacity: 1,
      inputFocusRingEnabled: "shown",
      inputFocusRingColor: "var(--accent)",
      inputHighlightOpacity: 0,
      inputShadowEnabled: "shown",
      inputBg: "transparent",
      inputBgImage: "",
      inputTextColor: "#ffcc55",
      inputPlaceholder: "#7a5200",
      sendButtonColor: "#000000",
      sendButtonRadius: "0.5",
      sendButtonBorderColor: "rgba(255,255,255,.5)",
      sendButtonIcon: "arrow",
      sendButtonIconGenerating: "square",
      sendButtonIconRound: "on",
      sendButtonIconColor: "#ffffff",
      inputFocusBorder: "#ffb000",
      inputBorder: "transparent",
      inputBorderWidth: 1,
      inputBorderOpacity: 0,
      inputRadius: 20,
      inputFontSize: 15,
      inputLineHeight: "1",
      inputShowHistoryHint: true,
      inputSubmitButtonMode: "inline",
      cliLineWidth: 2,
      cliLineColor: "#9b6b00",
      cliTextColor: "#ffcc55",
      cliPromptColor: "#cc8c00",
      cliHintMode: "compact",
      ccHintFontSize: 16,
      modelSwitchMode: "cycle",
      modelBgColor: "#ffffff",
      modelWidth: 120,
      modelHeight: 28,
      modelRadius: 0,
      modelFontSize: 12,
      modelTextColor: "#000000",
      reasoningSwitchMode: "menu",
      reasoningBgColor: "#ffffff",
      reasoningWidth: 120,
      reasoningHeight: 28,
      reasoningRadius: 0,
      reasoningFontSize: 12,
      reasoningTextColor: "#000000",
      permissionSwitchMode: "cycle",
      permissionBgColor: "#ffffff",
      permissionWidth: 120,
      permissionHeight: 28,
      permissionRadius: 0,
      permissionFontSize: 12,
      permissionTextColor: "",
      modeAutoColor: "#ffb000",
      modeEditColor: "#ffcc55",
    },
  },
  {
    id: 'matrix',
    mode: 'terminal',
    zone: 'cc',
    label: 'Matrix 磷绿',
    origin: 'factory',
    source: { presetName: 'matrix' },
    values: {
      ccHeight: 96,
      ccMarginX: 15,
      ccMarginBottom: 15,
      ccRadius: 25,
      ccBg: "#050f05",
      ccSurfaceOpacity: 1,
      ccBgImage: "",
      ccLayout: {
        "version": 9,
        "placements": {
          "input": {
            "order": 1,
            "offsetX": 0,
            "offsetY": 0
          },
          "model": {
            "order": 2,
            "offsetX": 0,
            "offsetY": 0
          },
          "reasoning": {
            "order": 3,
            "offsetX": 0,
            "offsetY": 0
          },
          "mode": {
            "order": 4,
            "offsetX": 0,
            "offsetY": 0
          },
          "tokens": {
            "order": 5,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-command-hint": {
            "order": 6,
            "offsetX": 0,
            "offsetY": 0
          },
          "cc-send-button": {
            "order": 0,
            "offsetX": 0,
            "offsetY": 0
          }
        }
      },
      ccPluginProps: {},
      ccHidden: [
        "cc-send-button"
      ],
      ccHiddenEmpty: [
        "model",
        "reasoning",
        "mode",
        "tokens",
        "cc-send-button",
        "cc-command-hint"
      ],
      inputOffsetTop: 10,
      inputHeight: 40,
      inputMarginX: 10,
      inputSurfaceBg: "#FFFFFF",
      inputSurfaceOpacity: 1,
      inputFocusRingEnabled: "shown",
      inputFocusRingColor: "var(--accent)",
      inputHighlightOpacity: 0,
      inputShadowEnabled: "shown",
      inputBg: "transparent",
      inputBgImage: "",
      inputTextColor: "#b8ffb8",
      inputPlaceholder: "#1a5c1a",
      sendButtonColor: "#000000",
      sendButtonRadius: "0.5",
      sendButtonBorderColor: "rgba(255,255,255,.5)",
      sendButtonIcon: "arrow",
      sendButtonIconGenerating: "square",
      sendButtonIconRound: "on",
      sendButtonIconColor: "#ffffff",
      inputFocusBorder: "#39ff14",
      inputBorder: "transparent",
      inputBorderWidth: 1,
      inputBorderOpacity: 0,
      inputRadius: 20,
      inputFontSize: 15,
      inputLineHeight: "1",
      inputShowHistoryHint: true,
      inputSubmitButtonMode: "inline",
      cliLineWidth: 2,
      cliLineColor: "#1a5c1a",
      cliTextColor: "#b8ffb8",
      cliPromptColor: "#39ff14",
      cliHintMode: "compact",
      ccHintFontSize: 16,
      modelSwitchMode: "cycle",
      modelBgColor: "#ffffff",
      modelWidth: 120,
      modelHeight: 28,
      modelRadius: 0,
      modelFontSize: 12,
      modelTextColor: "#000000",
      reasoningSwitchMode: "menu",
      reasoningBgColor: "#ffffff",
      reasoningWidth: 120,
      reasoningHeight: 28,
      reasoningRadius: 0,
      reasoningFontSize: 12,
      reasoningTextColor: "#000000",
      permissionSwitchMode: "cycle",
      permissionBgColor: "#ffffff",
      permissionWidth: 120,
      permissionHeight: 28,
      permissionRadius: 0,
      permissionFontSize: 12,
      permissionTextColor: "",
      modeAutoColor: "#39ff14",
      modeEditColor: "#7fff00",
    },
  },
]

// 本文件 5 条 / 345 个字段值（★ #266 CC-32：5 桶各删 1 处 inputBorderColor，搬去 terminal-global.ts；
//   旧计数 420 在更早的字段删除中未同步、早已过时，本次按实际重数 345 − 5 = 340；
//   ★ CC-13 刀4：五条各补 ccPluginProps ⇒ 340 + 5 = 345）
