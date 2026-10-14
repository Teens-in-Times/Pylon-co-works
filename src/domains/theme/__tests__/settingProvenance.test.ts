// @vitest-environment jsdom
// D-trace：设置项写入溯源——漏斗挂钩与贡献者区分。
import { beforeEach, describe, expect, it } from 'vitest'
import { useThemeStore } from '../themeStore.ts'
import { resetStores } from '../../../test/resetStores.ts'
import {
  lastSettingWriter,
  recentSettingWrites,
  recordSettingWrites,
  resetSettingProvenance,
  SETTING_WRITE_SOURCE_LABELS,
} from '../settingProvenance.ts'

describe('setting provenance ledger', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    resetSettingProvenance()
  })

  it('attributes user edits through the setZoneField funnel', () => {
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 19 })
    expect(lastSettingWriter('chatFontSize')).toMatchObject({ source: 'user-edit', zone: 'chat' })
  })

  it('records preset and reset actions with their own sources', () => {
    useThemeStore.getState().setZoneField('chat', { chatFontSize: 18 })
    useThemeStore.getState().setGlobalPreset('nord', {})
    expect(lastSettingWriter('chatFontSize')?.source).toBe('global-preset')

    useThemeStore.getState().setZoneField('chat', { chatFontSize: 18 })
    useThemeStore.getState().resetZone('chat')
    expect(lastSettingWriter('chatFontSize')?.source).toBe('zone-reset')

    useThemeStore.getState().setZoneField('chat', { chatFontSize: 18 })
    useThemeStore.getState().resetTheme()
    expect(lastSettingWriter('chatFontSize')?.source).toBe('theme-reset')
  })

  it('keeps a bounded ring buffer (newest first)', () => {
    for (let index = 0; index < 300; index += 1) {
      recordSettingWrites('user-edit', 'chat', ['chatFontSize'], index)
    }
    const recent = recentSettingWrites(10)
    expect(recent).toHaveLength(10)
    expect(recent[0]).toMatchObject({ at: 299 })
    expect(recent[9]).toMatchObject({ at: 290 })
  })

  it('exposes localized source labels for every source', () => {
    for (const label of Object.values(SETTING_WRITE_SOURCE_LABELS)) {
      expect(label.trim().length).toBeGreaterThan(0)
    }
  })
})
