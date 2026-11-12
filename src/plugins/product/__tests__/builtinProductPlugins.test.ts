import { describe, expect, it } from 'vitest'
import { createBuiltinProductPluginDefinitions, loadFirstPartyProductPackages } from '../builtinProductPlugins.ts'
import { BUILTIN_PYLON_PRODUCT_PLUGIN_IDS } from '../productPluginIds.ts'
import { BUILTIN_CONTEXT_PANEL_CONTRIBUTIONS } from '../builtinPylonWorkspace.ts'
import { selectContextPanels } from '../../../plugin-runtime/context-panel/contextPanelSelection.ts'
import type { ContextPanelContribution, ContextPanelRegistryEntry } from '../../../plugin-runtime/context-panel/contextPanelTypes.ts'

const asEntry = (value: ContextPanelContribution): ContextPanelRegistryEntry => ({
  ownerPluginId: 'test.workspace', ownerRuntimeInstanceId: 'test-run', contributionId: value.id,
  layer: 'feature', priority: 0, value,
})

describe('first-party product plugin contracts', () => {
  it('preserves manifest dependency ranges, conflicts and activation events in runtime definitions', () => {
    const shell = createBuiltinProductPluginDefinitions()
      .find(definition => definition.id === 'builtin.pylon-shell')

    expect(shell).toMatchObject({
      dependencies: {
        'builtin.pylon-workspace': '^1.0.0',
        'builtin.pylon-renderers': '^1.0.0',
        'builtin.pylon-agent-adapters': '^1.0.0',
        'builtin.pylon-tools': '^1.0.0',
      },
      optionalDependencies: {},
      conflicts: [],
      activationEvents: ['kernel.ready'],
    })
  })

  it('keeps the loaded package id set equal to the closed product plugin id list', () => {
    expect(loadFirstPartyProductPackages().map(pkg => pkg.manifest.id).sort())
      .toEqual([...BUILTIN_PYLON_PRODUCT_PLUGIN_IDS].sort())
  })

  it.each([
    ['agent', ['builtin.context-panel.agent', 'global-inspector']],
    ['file', ['builtin.context-panel.file', 'global-inspector']],
    ['overview', ['global-inspector']],
    ['runtime', ['global-inspector']],
    ['gateway', ['global-inspector']],
    [undefined, ['global-inspector']],
  ])('limits built-in inspectors to their matching workspace (%s), keeping global plugins', (workspaceKind, expected) => {
    const entries = [...BUILTIN_CONTEXT_PANEL_CONTRIBUTIONS, {
      id: 'global-inspector', label: 'Global', scope: 'global', renderKind: 'isolated-surface', surfaceId: 'global-surface',
    } satisfies ContextPanelContribution].map(asEntry)
    expect(selectContextPanels(entries, {
      workspaceKind, sheetId: workspaceKind ? `sheet-${workspaceKind}` : null,
      activeSessionId: 'previously-selected-session', activeAgent: 'peri',
    }).map(entry => entry.value.id)).toEqual(expected)
  })
})
