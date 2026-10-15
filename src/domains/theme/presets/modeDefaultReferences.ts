/** 三模式隐藏默认只保存区域引用；未登记的模式没有默认成员。 */
import type { PresetInterfaceMode } from './types.ts'
import type { ModePresetDefinition } from '../zones/presetReferencePlan.ts'
import { defaultLandingEntryId } from '../zones/factory/landingEntries.ts'

function defaultDefinition(mode: PresetInterfaceMode, label: string): ModePresetDefinition {
  return Object.freeze({
    name: `${mode}-default`, label, mode, hidden: true,
    refs: Object.freeze({
      global: defaultLandingEntryId(mode, 'global'), sidebar: defaultLandingEntryId(mode, 'sidebar'),
      chat: Object.freeze({ style: defaultLandingEntryId(mode, 'chat', 'style'), color: defaultLandingEntryId(mode, 'chat', 'color') }),
      cc: defaultLandingEntryId(mode, 'cc'), right: defaultLandingEntryId(mode, 'right'),
    }),
  })
}

export const MODE_DEFAULT_REFERENCES: Readonly<Record<PresetInterfaceMode, ModePresetDefinition>> = Object.freeze({
  gui: defaultDefinition('gui', 'GUI-默认'),
  terminal: defaultDefinition('terminal', '终端-默认'),
  tactical: defaultDefinition('tactical', '蓝调-默认'),
})

export function modeDefaultForInterfaceMode(interfaceMode: string): ModePresetDefinition | undefined {
  switch (interfaceMode) {
    case 'modern-gui': return MODE_DEFAULT_REFERENCES.gui
    case 'terminal-like': return MODE_DEFAULT_REFERENCES.terminal
    case 'tactical-blue': return MODE_DEFAULT_REFERENCES.tactical
    default: return undefined
  }
}
