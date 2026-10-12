import { describe, expect, it } from 'vitest'
import { GLOBAL_PRESETS } from '../../theme/presets/index.ts'
import { THEME_SETTING_KEYS } from '../../theme/themeFieldDefs.ts'
import {
  WORKBENCH_CSS_VARIABLES,
  WORKBENCH_DATA_ATTRIBUTES,
  createWorkbenchSkinFixtureSet,
  validateWorkbenchSkinFixtureSet,
} from '../workbenchSkinContract.ts'

const FIXED_TIME = '2026-08-11T00:00:00.000Z'

describe('CC-21 workbench input font contract', () => {
  it('lists the input variable and resolves follow, independent and plugin fixtures without raw ids', () => {
    expect(WORKBENCH_CSS_VARIABLES).toContain('--cc-input-font-family')
    const set = createWorkbenchSkinFixtureSet([
      { id: 'custom-follow', name: 'follow', theme: { msgFont: 'serif' }, createdAt: 1, updatedAt: 1 },
      { id: 'custom-independent', name: 'independent', theme: { inputFont: 'mono', msgFont: 'serif' }, createdAt: 1, updatedAt: 1 },
      { id: 'custom-plugin', name: 'plugin', theme: { inputFont: 'vendor.input', msgFont: 'mono' }, createdAt: 1, updatedAt: 1 },
    ], FIXED_TIME)
    const values = set.fixtures.filter(item => item.kind === 'custom').map(item => item.cssVariables['--cc-input-font-family'])
    expect(values).toEqual([
      'var(--font-serif-default, var(--serif))',
      'var(--font-mono-default, var(--mono))',
      'var(--pylon-font-vendor-input, var(--font-system, var(--font)))',
    ])
    expect(set.fixtures.find(item => item.id === 'custom-custom-follow')?.theme.inputFont).toBe('follow-message')
  })
})

describe('Workbench 皮肤迁移 contract', () => {
  it('从源码动态枚举全部内置预设，不硬编码数量', () => {
    const fixtureSet = createWorkbenchSkinFixtureSet([], FIXED_TIME)
    expect(fixtureSet.source.builtinPresetIds).toEqual(GLOBAL_PRESETS.map(preset => preset.name))
    expect(fixtureSet.fixtures.filter(fixture => fixture.kind === 'builtin')).toHaveLength(GLOBAL_PRESETS.length)
  })

  it('包含默认、混合、dirty 与 schema 双边界 fixture', () => {
    const fixtureSet = createWorkbenchSkinFixtureSet([], FIXED_TIME)
    expect(fixtureSet.fixtures.map(fixture => fixture.kind)).toEqual(expect.arrayContaining([
      'default',
      'mixed',
      'dirty',
      'boundary-min',
      'boundary-max',
    ]))
  })

  it('每个 fixture 覆盖全部主题字段、data attrs 与 Workbench CSS variable contract', () => {
    const fixtureSet = createWorkbenchSkinFixtureSet([], FIXED_TIME)
    expect(fixtureSet.source.themeSettingCount).toBe(THEME_SETTING_KEYS.length)
    expect(fixtureSet.source.cssVariableCount).toBe(WORKBENCH_CSS_VARIABLES.length)
    expect(validateWorkbenchSkinFixtureSet(fixtureSet)).toEqual([])

    for (const fixture of fixtureSet.fixtures) {
      for (const key of THEME_SETTING_KEYS) expect(fixture.theme[key], `${fixture.id}.${key}`).not.toBeUndefined()
      for (const attribute of WORKBENCH_DATA_ATTRIBUTES) expect(fixture.dataAttributes[attribute], `${fixture.id}.${attribute}`).toBeTruthy()
      for (const variable of ['--global-font', '--font', '--mono', '--chat-font', '--msg-font']) {
        expect(fixture.cssVariables[variable], `${fixture.id}.${variable}`).toBeTruthy()
      }
    }
  })

  it('自定义界面/代码字体 fixture 保留插件变量与代码 fallback', () => {
    const fixtureSet = createWorkbenchSkinFixtureSet([{
      id: 'custom-fonts',
      name: '字体贡献',
      theme: { globalFont: 'vendor.ui', codeFont: 'vendor.code', chatFont: 'vendor.chat', msgFont: 'vendor.chat' },
      createdAt: 1,
      updatedAt: 2,
    }], FIXED_TIME)
    const fixture = fixtureSet.fixtures.find(item => item.id === 'custom-custom-fonts')!
    expect(fixture.cssVariables['--global-font']).toContain('--pylon-font-vendor-ui')
    expect(fixture.cssVariables['--mono']).toContain('--pylon-font-vendor-code')
    expect(fixture.cssVariables['--mono']).toContain('var(--font-mono-default')
    expect(fixture.cssVariables['--chat-font']).toContain('--pylon-font-vendor-chat')
  })

  it('自定义预设按输入基线动态加入 fixture', () => {
    const fixtureSet = createWorkbenchSkinFixtureSet([{
      id: 'custom-real-baseline',
      name: '真实迁移基线',
      theme: { messageLayout: 'bubble', spinnerSize: 18 },
      createdAt: 1,
      updatedAt: 2,
    }], FIXED_TIME)

    expect(fixtureSet.source.customPresetIds).toEqual(['custom-real-baseline'])
    expect(fixtureSet.fixtures.find(fixture => fixture.kind === 'custom')).toMatchObject({
      id: 'custom-custom-real-baseline',
      label: '真实迁移基线',
      dataAttributes: { 'data-message-layout': 'bubble' },
      cssVariables: { '--spinner-size': '18px' },
    })
  })
})
