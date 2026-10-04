/**
 * rendererSettingsTypes — Renderer 设置 schema 兼容面（#520 S4-P0-3 破环件）。
 *
 * 框架中立 schema 正身已上移 `src/contracts/rendererSettingsSchema.ts`（照
 * fonts.ts 的 B-5 范式：正身住 contracts，两侧 re-export 保面）。本文件只做
 * 再出口：
 * - canonical 中立名（`SettingsSchema` / `normalizeSettingsSchema` 等）原样透传；
 * - 历史 `Renderer*` / `Render*` 前缀名以兼容别名保留（SDK 与存量消费面的
 *   现役出口，consumer 面覆盖 components/domains/plugin-runtime 三侧）。
 *
 * plugin-runtime/settings 侧现已直接依赖 contracts——renderers ⇄ settings 的
 * 运行时值互引环随正身上移解除；本文件不再承载任何实现。
 */
export {
  DISPLAY_DEFAULTS,
  isSettingVisible,
  normalizeSettingsPlacement as normalizeRendererSettingsPlacement,
  normalizeSettingsSchema as normalizeRendererSettingsSchema,
  resolvePresentation,
  settingFieldKey,
  settingOptionTarget,
  validateSettingsSchema as validateRendererSettingsSchema,
} from '../../contracts/rendererSettingsSchema.ts'

export type {
  BooleanSettingField as RenderBooleanSettingField,
  ChoicePresentation,
  ChoiceSettingField as RenderChoiceSettingField,
  ColorPresentation,
  ColorSettingField as RenderColorSettingField,
  MultiChoicePresentation,
  MultiChoiceSettingField as RenderMultiChoiceSettingField,
  NumberPresentation,
  NumberSettingField as RenderNumberSettingField,
  SettingCondition as RenderSettingCondition,
  SettingField as RenderSettingField,
  SettingGroup as RenderSettingGroup,
  SettingOption as RendererSettingOption,
  SettingValue as RendererSettingValue,
  SettingsDensity,
  SettingsField,
  SettingsPlacement as RendererSettingsPlacement,
  SettingsPresentation as RendererPresentation,
  SettingsSchema,
  SettingsSchema as RendererSettingsSchema,
  SettingsValue,
  SettingsValueAdapter,
  TextSettingField as RenderTextSettingField,
} from '../../contracts/rendererSettingsSchema.ts'
