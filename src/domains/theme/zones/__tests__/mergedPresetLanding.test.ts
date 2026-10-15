/**
 * #607 刀3a · **合并落点材料**（`preset:<预设名>:<区>`）逐字段对拍。
 *
 * 三张 Agent 卡（Agent 指挥台 / Agent 关系图 / 专注流程）在本单之前的外观 = 工厂数据 **⊕**
 * 绑定档案的 tokens（档案值覆盖同键、装配最后叠加）。刀3a 把这份叠加结果预先写成材料
 * ⇒ 应用时不再现场叠档案。本文件锁三件事：
 *
 * 1. **逐字段相等**：材料 = 工厂材料 ⊕ 档案材料（消息流按轴两张单、中控单含待迁边线）；
 * 2. **合并方向**：同键冲突时**档案值覆盖工厂值**（写反了这三张卡的对拍必红）；
 * 3. **不进区域行候选**：`preset:*` 是「预设整体落点」，不是单区候选（区域行只吃 `factory:*`）。
 *
 * 期望值由**原材料真值**独立算出（工厂表 + 档案 tokens / 档案材料表），不复用落点材料的构建过程。
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESENTATION_PROFILES } from '../../../../plugins/core/renderer/builtinPresentationProfiles.ts'
import { filterPresetTheme } from '../../presetReducer.ts'
import type { ThemeSettings } from '../../themeStore.ts'
import { GLOBAL_PRESETS } from '../../presets/index.ts'
import { splitChatPresetValues } from '../chatPresetAxes.ts'
import { FACTORY_ZONE_PRESET_ENTRIES } from '../factory/index.ts'
import { FACTORY_PROFILE_CC } from '../factory/profile-cc.ts'
import { FACTORY_PROFILE_CHAT } from '../factory/profile-chat.ts'
import { LANDING_PRESET_ENTRIES } from '../factory/landingEntries.ts'
import { zonePresetsFor } from '../zonePresetPool.ts'

const AGENT_CARDS = [
  ['agent-command', 'builtin.presentation.agent-command'],
  ['agent-map', 'builtin.presentation.agent-map'],
  ['focus-flow', 'builtin.presentation.focus-flow'],
] as const

function materialOf(id: string) {
  const entry = LANDING_PRESET_ENTRIES.find(item => item.id === id)
  if (!entry) throw new Error(`缺少材料：${id}`)
  return entry
}

/** 档案的待迁边线值 —— 真值取自档案 tokens（刀2 的 `PROFILE_INPUT_BORDERS` 与之同源）。 */
function profileBorder(profileId: string): string {
  const value = BUILTIN_PRESENTATION_PROFILES.find(item => item.id === profileId)?.tokens?.inputBorderColor
  if (typeof value !== 'string') throw new Error(`档案缺少待迁边线：${profileId}`)
  return value
}

describe('#607 刀3a · 合并落点材料（factory ⊕ profile）', () => {
  it('消息流两张单逐字段 == 工厂材料 ⊕ 档案材料（按轴切分后）', () => {
    for (const [presetName, profileId] of AGENT_CARDS) {
      const preset = GLOBAL_PRESETS.find(item => item.name === presetName)!
      const factoryChat = FACTORY_ZONE_PRESET_ENTRIES.find(item => item.id === presetName && item.zone === 'chat')!
      const profileChat = FACTORY_PROFILE_CHAT.find(item => item.id === profileId)!
      const expected = splitChatPresetValues({
        ...filterPresetTheme(factoryChat.values),
        ...filterPresetTheme(profileChat.values),
      })
      for (const axis of ['style', 'color'] as const) {
        expect(materialOf(`preset:${presetName}:chat:${axis}`).values, `${presetName}/chat:${axis}`).toEqual(expected[axis])
        expect(materialOf(`preset:${presetName}:chat:${axis}`).axis).toBe(axis)
        expect(materialOf(`preset:${presetName}:chat:${axis}`).mode).toBe(preset.interfaceMode)
      }
      // 身份链的唯一来源：样式单带 `styleMaterial`，配色单不带
      expect(materialOf(`preset:${presetName}:chat:style`).styleMaterial).toEqual({ profileId })
      expect(materialOf(`preset:${presetName}:chat:color`).styleMaterial).toBeUndefined()
    }
  })

  it('中控单逐字段 == 工厂 cc ⊕ 档案 cc（含待迁边线 inputBorderColor）', () => {
    for (const [presetName, profileId] of AGENT_CARDS) {
      const factoryCc = FACTORY_ZONE_PRESET_ENTRIES.find(item => item.id === presetName && item.zone === 'cc')!
      const profileCc = FACTORY_PROFILE_CC.find(item => item.id === profileId)!
      const expected: Partial<ThemeSettings> = {
        ...filterPresetTheme(factoryCc.values),
        ...filterPresetTheme(profileCc.values),
        inputBorderColor: profileBorder(profileId),
      }
      expect(Object.hasOwn(factoryCc.values, 'inputBorderColor'), `${presetName} 工厂 cc 不带边线`).toBe(false)
      expect(materialOf(`preset:${presetName}:cc`).values, `${presetName}/cc`).toEqual(expected)
    }
  })

  it('★ 合并方向：同键冲突时**档案值覆盖工厂值**（写反必红）', () => {
    let conflicts = 0
    for (const [presetName, profileId] of AGENT_CARDS) {
      const factoryChat = FACTORY_ZONE_PRESET_ENTRIES.find(item => item.id === presetName && item.zone === 'chat')!
      const profileChat = FACTORY_PROFILE_CHAT.find(item => item.id === profileId)!
      for (const [key, profileValue] of Object.entries(profileChat.values)) {
        const factoryValue = (factoryChat.values as Record<string, unknown>)[key]
        if (factoryValue === undefined || JSON.stringify(factoryValue) === JSON.stringify(profileValue)) continue
        conflicts += 1
        const landed = { ...materialOf(`preset:${presetName}:chat:style`).values, ...materialOf(`preset:${presetName}:chat:color`).values } as Record<string, unknown>
        expect(landed[key], `${presetName}/${key} 应取档案值`).toEqual(profileValue)
      }
    }
    expect(conflicts, '三张卡上必须真的存在「工厂值与档案值不同」的同键，否则方向断言是空洞的').toBeGreaterThan(0)
  })

  it('合并材料不进区域行候选（区域行只吃 factory:*）', () => {
    expect(LANDING_PRESET_ENTRIES.filter(entry => entry.id.startsWith('preset:'))).toHaveLength(9)
    for (const interfaceMode of ['modern-gui', 'terminal-like']) {
      for (const zone of ['global', 'sidebar', 'chat', 'cc', 'right'] as const) {
        for (const entry of zonePresetsFor(interfaceMode, zone)) {
          expect(entry.id.startsWith('preset:'), `${interfaceMode}/${zone}/${entry.id} 合并材料不得进候选`).toBe(false)
        }
      }
    }
  })
})
