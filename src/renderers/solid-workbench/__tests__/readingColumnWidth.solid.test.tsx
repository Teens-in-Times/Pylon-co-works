// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { readingColumnMaxWidth } from '../chat/readingColumnWidth.ts'
import { createBuiltinSolidContentSlot, createBuiltinSolidRendererSuite } from '../builtinSolidRendererSuite.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../domains/rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import type { RendererActivationSnapshot } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { createPreviewWorkbenchServices } from '../preview/previewWorkbenchServices.ts'
import { createWorkbenchHostPort } from '../../../plugin-runtime/renderers/workbenchHostPort.ts'
import { mountSolidWorkbenchFromHostPort } from '../mountSolidWorkbench.solid.tsx'
import { normalizeWorkbenchMountInput } from '../workbenchContracts.ts'

function entry<T extends { id: string }>(value: T): RegistryEntry<T> {
  return { ownerPluginId: 'test.reading-column', ownerRuntimeInstanceId: 'test', contributionId: value.id, layer: 'feature', priority: 1, value }
}

function activation(): RendererActivationSnapshot {
  const slot = entry(createBuiltinSolidContentSlot())
  const kinds = [...BUILTIN_TEXT_RENDER_KINDS, ...BUILTIN_TOOL_RENDER_KINDS]
  return {
    revision: 1, suite: entry(createBuiltinSolidRendererSuite()),
    kinds: new Map(kinds.map(kind => [kind.id, entry(kind)])),
    slots: new Map(slot.value.kinds.map(kind => [kind, [slot]])), diagnostics: [],
  }
}

describe('#566 shared reading column', () => {
  it('uses the widest active configured surface while honoring each smaller cap', () => {
    const active = activation()
    expect(readingColumnMaxWidth(active)).toBe(960)
    const resolve = vi.fn(({ kind }: { kind: string }) => ({ maxWidth: kind === 'content.markdown' ? 1200 : 600 }))
    expect(readingColumnMaxWidth(active, resolve)).toBe(1200)
    expect(resolve).toHaveBeenCalledWith({ kind: 'content.markdown', suiteId: 'builtin.solid', slotId: 'builtin.solid.content.base' })
    // Reducing every configured cap also reduces the shared column.
    expect(readingColumnMaxWidth(active, () => ({ maxWidth: 600 }))).toBe(600)
  })

  it('ignores kinds without an active surface and invalid width values', () => {
    const active = activation()
    const markdown = active.kinds.get('content.markdown')!
    const unused = { ...markdown, value: { ...markdown.value, id: 'test.unused', defaultTokens: { maxWidth: 2000 } } }
    const withUnused = { ...active, kinds: new Map([...active.kinds, ['test.unused', unused]]) }
    expect(readingColumnMaxWidth(withUnused)).toBe(960)
    for (const maxWidth of [NaN, Infinity, 0, -1, '1600']) {
      expect(readingColumnMaxWidth(active, () => ({ maxWidth }))).toBe(960)
    }
    expect(readingColumnMaxWidth(undefined)).toBe(960)
  })

  it('updates the mounted column on renderer setting notifications, independent of messages', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const services = createPreviewWorkbenchServices()
    let maxWidth = 960
    const listeners = new Set<() => void>()
    const hostPort = createWorkbenchHostPort({
      ...services, suiteId: 'builtin.solid', sheetId: 'reading-column', sessionId: 'preview-session', sessionOwnerKey: null,
      renderAppearance: {
        resolve: (_, snapshot) => ({ ...snapshot, maxWidth }),
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    })
    const lifecycle = mountSolidWorkbenchFromHostPort({ host, input: normalizeWorkbenchMountInput({ sheetId: 'reading-column', sessionId: 'preview-session', preview: true }), hostPort, activation: activation() })
    try {
      const column = host.querySelector<HTMLElement>('.solid-workbench-reading-column')!
      expect(column.style.maxWidth).toBe('960px')
      maxWidth = 640
      for (const listener of listeners) listener()
      expect(column.style.maxWidth).toBe('640px')
      const base = services.runtime.getSnapshot().document!
      services.runtime.replaceDocument({ ...base, messages: [] }, { ownerKey: 'preview', generation: 1 })
      expect(host.querySelector('.solid-workbench-reading-column')).toBe(column)
      expect(column.style.maxWidth).toBe('640px')
    } finally {
      lifecycle.destroy()
      services.destroy()
      host.remove()
    }
  })
})
