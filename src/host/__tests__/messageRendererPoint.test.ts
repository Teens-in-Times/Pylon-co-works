import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type MessageRenderer,
  type RenderSurface,
} from '../../contracts/messageRenderer'
import { deactivatePluginInstance, type PluginInstance } from '../../plugin-runtime/pluginInstance'
import { activateTestBuiltinPlugin as activateBuiltinPlugin } from '../../plugin-runtime/testing/pluginRuntimeHarness.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity'
import { bootstrapBuiltins } from '../../plugin-runtime/pluginCompositionRoot'
import {
  resolveActiveMessageRenderers,
  resolveDefaultMessageRenderer,
  resolveMessageRenderer,
  resolveMessageRendererIds,
} from '../messageRendererResolver'

const temporaryInstances: PluginInstance[] = []

beforeAll(async () => { await bootstrapBuiltins('normal') })

afterEach(async () => {
  while (temporaryInstances.length > 0) await deactivatePluginInstance(temporaryInstances.pop()!)
})

function createDummySurface(rendererId: string): RenderSurface {
  return {
    rendererId,
    kind: 'unknown',
    mount: () => ({ rendererId }),
    update: () => undefined,
    destroy: () => undefined,
    on: () => () => {},
  }
}

async function installTestRenderer(id: string, priority = 1000, canRender = true): Promise<PluginInstance> {
  const rendererImpl: MessageRenderer = {
    rendererId: id,
    kind: 'unknown',
    renderMessage: () => createDummySurface(id),
    renderTool: () => createDummySurface(id),
    renderReasoning: () => createDummySurface(id),
  }
  const instance = await activateBuiltinPlugin(createPluginIdentity(id, 'one'), ({ renderer }) => {
    renderer.registerMessageRenderer({
      id: `${id}.renderer`, renderer: rendererImpl, priority, fallback: false,
      canRender: () => canRender,
      onError: () => 'fallback',
    })
  })
  temporaryInstances.push(instance)
  return instance
}

describe('v2 Message Renderer Registry', () => {
  it('core solid 由统一 renderer registry 持有', () => {
    expect(resolveMessageRendererIds()).toEqual(['core.renderer.solid'])
    expect(resolveDefaultMessageRenderer()?.rendererId).toBe('core.renderer.solid')
  })

  it('core renderer 贡献完整能力面', () => {
    expect(resolveMessageRenderer('core.renderer.solid')?.kind).toBe('solid')
  })

  it('priority、canRender、fallback 与作用域停用生效', async () => {
    const incapable = await installTestRenderer('test.renderer.incapable', 10, false)
    const selected = await installTestRenderer('test.renderer.priority', 100, true)
    expect(resolveDefaultMessageRenderer()?.rendererId).toBe('test.renderer.priority')
    expect(resolveMessageRendererIds()[0]).toBe('test.renderer.incapable')

    await deactivatePluginInstance(selected)
    temporaryInstances.splice(temporaryInstances.indexOf(selected), 1)
    expect(resolveDefaultMessageRenderer()?.rendererId).toBe('core.renderer.solid')
    expect(resolveActiveMessageRenderers().map(renderer => renderer.rendererId)).toEqual(resolveMessageRendererIds())

    await deactivatePluginInstance(incapable)
    temporaryInstances.splice(temporaryInstances.indexOf(incapable), 1)
  })
})
