import { toCssBackgroundImage } from '../../infrastructure/skin/backgroundImage.ts'
import { cloneCcLayout } from '../cc/ccLayoutState.ts'
import type { CustomPreset } from '../theme/customPresets.ts'
import { DEFAULTS } from '../theme/themeDefaults.ts'
import { GLOBAL_PRESETS } from '../theme/presets/index.ts'
import { effectivePresetTheme } from '../theme/zones/index.ts'
import {
  THEME_CSS_VAR_MAP,
  THEME_FIELD_DEFS,
  THEME_SETTING_KEYS,
  type ThemeFieldKey,
} from '../theme/themeFieldDefs.ts'
import { resolveFontToken, resolveInputFontToken } from '../theme/fontTokens.ts'
import type { ThemeSettings } from '../theme/themeStore.ts'

export const WORKBENCH_DATA_ATTRIBUTES = [
  'data-ui-scheme',
  'data-msg-style',
  'data-message-layout',
] as const

const WORKBENCH_THEME_KEYS = new Set<ThemeFieldKey>([
  ...THEME_SETTING_KEYS.filter(key => ['chat', 'cc'].includes(THEME_FIELD_DEFS[key].zone)),
  'accent',
  'globalFont',
  'codeFont',
  'globalFontSize',
  'uiScheme',
  'userName',
  'userPrefix',
  'userColor',
])

const WORKBENCH_DERIVED_CSS_VARIABLES = [
  '--chat-bg-image',
  '--input-bg-image',
  '--global-font',
  '--font',
  '--mono',
  '--chat-font',
  '--msg-font',
  '--cc-input-font-family',
  '--msg-text',
] as const

export const WORKBENCH_CSS_VARIABLES = Array.from(new Set([
  ...Object.entries(THEME_CSS_VAR_MAP)
    .filter(([, key]) => WORKBENCH_THEME_KEYS.has(key))
    .map(([cssVariable]) => cssVariable),
  ...WORKBENCH_DERIVED_CSS_VARIABLES,
])).sort() as readonly string[]

export interface WorkbenchThemeFixture {
  id: string
  label: string
  kind: 'default' | 'builtin' | 'custom' | 'mixed' | 'dirty' | 'boundary-min' | 'boundary-max'
  theme: ThemeSettings
  cssVariables: Record<string, string>
  dataAttributes: Record<(typeof WORKBENCH_DATA_ATTRIBUTES)[number], string>
}

export interface WorkbenchSkinFixtureSet {
  generatedAt: string
  source: {
    builtinPresetIds: string[]
    customPresetIds: string[]
    themeSettingCount: number
    cssVariableCount: number
  }
  fixtures: WorkbenchThemeFixture[]
}

function cloneTheme(theme: ThemeSettings): ThemeSettings {
  return {
    ...structuredClone(theme),
    ccLayout: cloneCcLayout(theme.ccLayout),
  }
}

function resolveDataAttributes(theme: ThemeSettings): WorkbenchThemeFixture['dataAttributes'] {
  // ★ #266 刀10/刀11：`data-footer-layout` / `data-cli-overflow-mode` 两个属性随
  //   `footerLayout` / `cliOverflowMode` 字段删除（形态固定，没有可切的分支）。
  return {
    'data-ui-scheme': theme.uiScheme || 'light',
    'data-msg-style': theme.msgStyle || 'terminal',
    'data-message-layout': theme.messageLayout || 'classic',
  }
}

function resolveCssVariables(theme: ThemeSettings): Record<string, string> {
  const state = theme as unknown as Record<string, unknown>
  const globalFont = resolveFontToken(theme.globalFont)
  const variables: Record<string, string> = {
    '--chat-bg-image': toCssBackgroundImage(theme.chatBgImage),
    '--input-bg-image': toCssBackgroundImage(theme.inputBgImage),
    '--global-font': globalFont,
    '--font': globalFont,
    '--mono': resolveFontToken(theme.codeFont ?? 'mono', 'code'),
    '--chat-font': resolveFontToken(theme.chatFont),
    '--msg-font': resolveFontToken(theme.msgFont),
    '--cc-input-font-family': resolveInputFontToken(theme.inputFont, theme.msgFont),
    '--msg-text': theme.msgTextColor || 'var(--chat-text-color,var(--text))',
  }

  for (const [cssVariable, key] of Object.entries(THEME_CSS_VAR_MAP)) {
    if (!WORKBENCH_THEME_KEYS.has(key) || cssVariable in variables) continue
    const definition = THEME_FIELD_DEFS[key]
    const value = state[key]
    if (value === undefined || (definition.type === 'color' && value === '')) continue
    variables[cssVariable] = definition.type === 'number' && definition.unit
      ? `${value}${definition.unit}`
      : String(value)
  }

  return variables
}

function makeFixture(
  id: string,
  label: string,
  kind: WorkbenchThemeFixture['kind'],
  theme: ThemeSettings,
): WorkbenchThemeFixture {
  const snapshot = cloneTheme(theme)
  return {
    id,
    label,
    kind,
    theme: snapshot,
    cssVariables: resolveCssVariables(snapshot),
    dataAttributes: resolveDataAttributes(snapshot),
  }
}

function mergeTheme(delta: Partial<ThemeSettings>): ThemeSettings {
  return cloneTheme({ ...DEFAULTS, ...structuredClone(delta) } as ThemeSettings)
}

function boundaryValue(key: ThemeFieldKey, edge: 'min' | 'max'): unknown {
  const definition = THEME_FIELD_DEFS[key]
  const current = DEFAULTS[key]

  if (definition.type === 'number') {
    return edge === 'min'
      ? definition.min ?? current
      : definition.max ?? current
  }
  if (definition.type === 'select') {
    const options = definition.options ?? []
    return edge === 'min' ? options[0] ?? current : options.at(-1) ?? current
  }
  if (definition.type === 'boolean') return edge === 'max'
  if (definition.type === 'color') return edge === 'min' ? '' : '#abcdef'
  if (key === 'ccLayout') return cloneCcLayout(DEFAULTS.ccLayout)
  // ★ #266 刀2：显隐的两份切面同形（常态 / 空态）⇒ 边界夹具一视同仁给 id 名单
  if (key === 'ccHidden' || key === 'ccHiddenEmpty') return edge === 'min' ? [] : ['model', 'tokens']
  return edge === 'min' ? '' : `fixture-${key}`
}

function createBoundaryTheme(edge: 'min' | 'max'): ThemeSettings {
  const theme = cloneTheme(DEFAULTS)
  for (const key of THEME_SETTING_KEYS) {
    ;(theme as unknown as Record<string, unknown>)[key] = boundaryValue(key, edge)
  }
  theme.ccLayout = cloneCcLayout(DEFAULTS.ccLayout)
  theme.ccHeight = Number.isFinite(theme.ccHeight) ? theme.ccHeight : DEFAULTS.ccHeight
  return theme
}

function createMixedTheme(): ThemeSettings {
  // 刀3（#223）：预设不再自带 `theme` ⇒ 取有效值视图（各套自己的那份）
  const byName = new Map(GLOBAL_PRESETS.map(preset => [preset.name, effectivePresetTheme(preset)]))
  return mergeTheme({
    ...byName.get('glass'),
    ...Object.fromEntries(
      Object.entries(byName.get('tokyo') ?? {}).filter(([key]) => THEME_FIELD_DEFS[key as ThemeFieldKey]?.zone === 'chat'),
    ),
    ...Object.fromEntries(
      Object.entries(byName.get('amber') ?? {}).filter(([key]) => THEME_FIELD_DEFS[key as ThemeFieldKey]?.zone === 'cc'),
    ),
  })
}

function createDirtyTheme(): ThemeSettings {
  // ★ #266 刀9：原样本里还有 `inputVariant: 'composer'` / `inputMode: 'default'`（用来制造
  //   "非命令行的脏态"）；两个字段已删除 ⇒ 样本同步去掉，其余逐字段调整项不变。
  return mergeTheme({
    msgStyle: DEFAULTS.msgStyle === 'terminal' ? 'bubble' : 'terminal',
    messageLayout: 'bubble',
    assistantDot: true,
    assistantDotGlyph: '✦',
    ccHidden: ['model'],
  })
}

export function createWorkbenchSkinFixtureSet(
  customPresets: readonly CustomPreset[] = [],
  generatedAt = new Date().toISOString(),
): WorkbenchSkinFixtureSet {
  const fixtures: WorkbenchThemeFixture[] = [
    makeFixture('default', '默认主题', 'default', DEFAULTS),
    ...GLOBAL_PRESETS.map(preset => makeFixture(`builtin-${preset.name}`, preset.label, 'builtin', mergeTheme(effectivePresetTheme(preset)))),
    ...customPresets.map(preset => makeFixture(`custom-${preset.id}`, preset.name, 'custom', mergeTheme(preset.theme))),
    makeFixture('mixed-zones', '分区混合主题', 'mixed', createMixedTheme()),
    makeFixture('dirty-custom', '逐字段调整主题', 'dirty', createDirtyTheme()),
    makeFixture('schema-boundary-min', 'Schema 最小边界', 'boundary-min', createBoundaryTheme('min')),
    makeFixture('schema-boundary-max', 'Schema 最大边界', 'boundary-max', createBoundaryTheme('max')),
  ]

  return {
    generatedAt,
    source: {
      builtinPresetIds: GLOBAL_PRESETS.map(preset => preset.name),
      customPresetIds: customPresets.map(preset => preset.id),
      themeSettingCount: THEME_SETTING_KEYS.length,
      cssVariableCount: WORKBENCH_CSS_VARIABLES.length,
    },
    fixtures,
  }
}

export function validateWorkbenchSkinFixtureSet(fixtureSet: WorkbenchSkinFixtureSet): string[] {
  const errors: string[] = []
  const fixtureIds = new Set<string>()

  for (const fixture of fixtureSet.fixtures) {
    if (fixtureIds.has(fixture.id)) errors.push(`fixture id 重复：${fixture.id}`)
    fixtureIds.add(fixture.id)

    for (const attribute of WORKBENCH_DATA_ATTRIBUTES) {
      if (!fixture.dataAttributes[attribute]) errors.push(`${fixture.id} 缺少 ${attribute}`)
    }
    for (const key of THEME_SETTING_KEYS) {
      if ((fixture.theme as unknown as Record<string, unknown>)[key] === undefined) {
        errors.push(`${fixture.id} 缺少主题字段 ${key}`)
      }
    }
    for (const cssVariable of WORKBENCH_CSS_VARIABLES) {
      const mappedKey = THEME_CSS_VAR_MAP[cssVariable]
      const definition = mappedKey ? THEME_FIELD_DEFS[mappedKey] : undefined
      const mayUseCssFallback = definition?.type === 'color'
        && (fixture.theme as unknown as Record<string, unknown>)[mappedKey] === ''
      if (!(cssVariable in fixture.cssVariables) && !mayUseCssFallback) {
        errors.push(`${fixture.id} 缺少 CSS variable ${cssVariable}`)
      }
    }
  }

  for (const preset of GLOBAL_PRESETS) {
    if (!fixtureIds.has(`builtin-${preset.name}`)) errors.push(`缺少内置预设 fixture：${preset.name}`)
  }

  return errors
}
