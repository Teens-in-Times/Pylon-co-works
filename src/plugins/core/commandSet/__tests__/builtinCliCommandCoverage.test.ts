import { describe, expect, it } from 'vitest'
import { createBuiltinCommandDefinitions } from '../builtinCommandExecutors.ts'
import { createBuiltinFileCommandDefinitions } from '../../file/builtinFileCommands.ts'
import { createBuiltinWorkspaceCommandDefinitions } from '../../sheet/builtinWorkspaceCommands.ts'
import { createBuiltinShellCommandDefinitions } from '../../shell/builtinShellCommands.ts'
import { createSkinCommandDefinitions } from '../../../../plugin-runtime/skin/skinCommandApi.ts'
import { getSkinRuntime } from '../../../../infrastructure/skin/skinRuntimeServices.ts'

const EXPECTED = [
  'model', 'compact', 'new', 'export', 'clear', 'mode',
  'file.entries.list', 'file.text.read', 'file.text.write', 'file.search', 'git.status', 'git.history', 'git.diff',
  'layout.inspect', 'layout.sidebar.set', 'layout.sidebar-width.set', 'layout.right-panel.set', 'layout.agent-sidebar.block.set',
  'workspace.sheet.focus', 'workspace.sheet.pin.toggle', 'workspace.sheet.close-others', 'workspace.sheet.close-right', 'workspace.sheet.reopen',
  'interface.tactical-blue.activate',
  'plugin-settings.pages', 'plugin-settings.get', 'plugin-settings.set', 'plugin-settings.remove',
  'theme.inspect', 'theme.patch', 'theme.reset-zone', 'theme.reset', 'config.export', 'config.import.preflight',
  'skin.schema', 'skin.inspect', 'skin.draft.create', 'skin.draft.patch', 'skin.validate', 'skin.preview', 'skin.preview.patch',
  'skin.inspect-computed', 'skin.capture', 'skin.rollback', 'skin.commit',
]

describe('built-in CLI command coverage', () => {
  it('registers every documented built-in command as executable with a unique id', () => {
    const commands = [
      ...createBuiltinCommandDefinitions(),
      ...createBuiltinFileCommandDefinitions(),
      ...createBuiltinWorkspaceCommandDefinitions(),
      ...createBuiltinShellCommandDefinitions(),
      ...createSkinCommandDefinitions(getSkinRuntime()),
    ]
    expect(commands.map(command => command.id).sort()).toEqual([...EXPECTED].sort())
    expect(new Set(commands.map(command => command.id))).toHaveLength(EXPECTED.length)
    expect(commands.every(command => typeof command.execute === 'function')).toBe(true)
  })
})
