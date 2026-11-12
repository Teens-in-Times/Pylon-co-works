// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import type { WorkbenchHostPort, WorkbenchMountInput, WorkbenchRendererFactory, WorkbenchRendererInstance } from '../../../renderers/solid-workbench/workbenchContracts.ts'
import type { RendererActivationSnapshot, RendererSuiteContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { RendererSuiteHost } from '../rendererSuiteHost.ts'

const input: WorkbenchMountInput = {
  sheetId: 'sheet-a', sessionOwnerKey: 'owner-a', sessionId: 'session-a', sessionSource: null,
  replayReadonly: false, reducedMotion: false, visibility: 'active', rightInset: 0, preview: true,
}

function fakeHost(): WorkbenchHostPort {
  const denied = async () => ({ ok: false as const, error: { code: 'renderer_not_active', message: 'inactive', recoverability: 'fallback' as const } })
  const sessionUi: WorkbenchHostPort['sessionUi'] = {
    get: (_, fallback) => fallback, set: () => {}, update: (_, fallback, updater) => updater(fallback), subscribe: () => () => {},
    capture: () => ({ get: sessionUi.get, set: sessionUi.set, update: sessionUi.update, subscribe: sessionUi.subscribe, clear: sessionUi.clear }),
    clear: () => {},
  }
  return {
    document: { getSnapshot: () => ({ revision: 5 } as never), subscribe: () => () => {}, getSlice: <T>() => undefined as T, subscribeSlice: () => () => {} },
    generation: { getSnapshot: () => ({}) as never, subscribe: () => () => {} },
    appearance: { getSnapshot: () => ({}) as never, subscribe: () => () => {} },
    sessionUi,
    commands: new Proxy({} as WorkbenchHostPort['commands'], { get: () => denied }),
    capabilities: { getSnapshot: () => ({}), has: () => true, subscribe: () => () => {} },
    diagnostics: { report: () => {}, getRecent: () => [], subscribe: () => () => {} },
  }
}

function activation(id: string, factory: WorkbenchRendererFactory): RendererActivationSnapshot {
  const suite: RendererSuiteContribution = {
    id, label: id, apiVersion: 1, runtime: { framework: 'solid', version: '1' },
    compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 }, requiredKinds: ['content.unknown'], factory,
  }
  const entry = { ownerPluginId: id, ownerRuntimeInstanceId: `${id}@runtime`, contributionId: id, layer: 'feature', priority: 1, value: suite } as RegistryEntry<RendererSuiteContribution>
  return { revision: 1, suite: entry, kinds: new Map(), slots: new Map(), diagnostics: [] }
}

function factory(id: string, options: { delay?: number; fail?: boolean; mountFail?: boolean; destroyFail?: boolean; readyFail?: boolean; runtimeFail?: boolean; synchronousPostReadyFail?: boolean; cachedRuntimeFail?: boolean; runtimeAction?: unknown; onMount?: () => void; onUpdate?: (input: WorkbenchMountInput) => void } = {}): WorkbenchRendererFactory {
  return {
    async prepare() {
      if (options.fail) throw new Error(`${id} prepare failed`)
      return {
        mount(container: HTMLElement) {
          if (options.mountFail) throw new Error(`${id} mount failed`)
          const listeners = new Map<string, Set<(payload: unknown) => void>>()
          let destroyed = false
          let readyEmitted = false
          const instance: WorkbenchRendererInstance = {
            update: nextInput => options.onUpdate?.(nextInput), pause: () => {}, resume: () => {},
            destroy: vi.fn(() => { destroyed = true; if (options.destroyFail) throw new Error(`${id} destroy failed`) }),
            on(event, listener) {
              const group = listeners.get(event) ?? new Set()
              group.add(listener); listeners.set(event, group)
              if (event === 'error' && options.cachedRuntimeFail && readyEmitted) listener(new Error(`${id} cached runtime failed`))
              return () => group.delete(listener)
            },
          }
          const handle = document.createElement('div'); handle.textContent = id; container.append(handle)
          options.onMount?.()
          ;(instance as WorkbenchRendererInstance & { __handle?: HTMLElement }).__handle = handle
          setTimeout(() => {
            if (!destroyed) {
              if (options.readyFail) for (const listener of listeners.get('error') ?? []) listener(new Error(`${id} slot failed`))
              else {
                readyEmitted = true
                for (const listener of listeners.get('ready') ?? []) listener({ id })
                if (options.synchronousPostReadyFail) {
                  for (const listener of listeners.get('error') ?? []) listener(new Error(`${id} synchronous post-ready failed`))
                }
                if (options.runtimeFail) setTimeout(() => {
                  for (const listener of listeners.get('error') ?? []) listener(new Error(`${id} runtime failed`))
                }, 0)
                if (options.runtimeAction) setTimeout(() => {
                  for (const listener of listeners.get('request-action') ?? []) listener(options.runtimeAction)
                }, 0)
              }
            }
          }, options.delay ?? 0)
          return instance
        },
      }
    },
  }
}

describe('RendererSuiteHost', () => {
  it('keeps the renderer mount root connected for post-ready DOM updates', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    let mountRoot!: HTMLElement
    const host = new RendererSuiteHost({ container, hostPort: fakeHost(), input })
    await host.mount(activation('suite.root', {
      async prepare() {
        return {
          mount(root) {
            mountRoot = root
            root.textContent = 'initial'
            return {
              update: value => { root.textContent = value.sessionId },
              pause() {}, resume() {}, destroy: () => root.replaceChildren(),
              on(event, listener) { if (event === 'ready') listener(undefined); return () => {} },
            }
          },
        }
      },
    }))
    expect(mountRoot.isConnected).toBe(true)
    host.update({ ...input, sessionId: 'updated session' })
    expect(container.textContent).toBe('updated session')
    await host.destroy()
    expect(mountRoot.isConnected).toBe(false)
    container.remove()
  })

  it('ignores a superseded preparation rejection after a newer suite commits', async () => {
    let rejectPrepare!: (error: unknown) => void
    const pendingPrepare = new Promise<never>((_, reject) => { rejectPrepare = reject })
    const container = document.createElement('div')
    const port = fakeHost()
    const diagnostic = vi.spyOn(port.diagnostics, 'report')
    const host = new RendererSuiteHost({ container, hostPort: port, input })
    await host.mount(activation('suite.a', factory('A')))
    const stale = host.switchTo(activation('suite.b', { prepare: () => pendingPrepare }))
    await host.switchTo(activation('suite.c', factory('C')))
    rejectPrepare(new Error('late preparation failure'))
    await stale
    expect(host.getState()).toMatchObject({ phase: 'active', suiteId: 'suite.c' })
    expect(container.textContent).toContain('C')
    expect(diagnostic).not.toHaveBeenCalled()
    await host.destroy()
  })

  it('does not revive a destroyed host when an initial preparation rejects late', async () => {
    let rejectPrepare!: (error: unknown) => void
    const pendingPrepare = new Promise<never>((_, reject) => { rejectPrepare = reject })
    const container = document.createElement('div')
    const host = new RendererSuiteHost({ container, hostPort: fakeHost(), input })
    const mounting = host.mount(activation('suite.a', { prepare: () => pendingPrepare }))
    await host.destroy()
    rejectPrepare(new Error('late failure'))
    await mounting
    expect(host.getState().phase).toBe('destroyed')
    expect(container.childElementCount).toBe(0)
  })

  it('keeps old Suite visible until candidate ready, then swaps and destroys old', async () => {
    const container = document.createElement('div')
    const host = new RendererSuiteHost({ container, hostPort: fakeHost(), input })
    await host.mount(activation('suite.a', factory('A')))
    expect(container.textContent).toContain('A')
    const switching = host.switchTo(activation('suite.b', factory('B', { delay: 10 })))
    expect(container.textContent).toContain('A')
    await switching
    expect(container.textContent).toContain('B')
    expect(container.textContent).not.toContain('A')
    await host.destroy()
  })

  it('keeps old Suite and reports diagnostic when candidate fails', async () => {
    const container = document.createElement('div')
    const diagnostics: unknown[] = []
    const port = fakeHost(); port.diagnostics.report = value => diagnostics.push(value)
    const host = new RendererSuiteHost({ container, hostPort: port, input })
    await host.mount(activation('suite.a', factory('A')))
    await host.switchTo(activation('suite.b', factory('B', { fail: true })))
    expect(container.textContent).toContain('A')
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'renderer.suite.switch.failed', phase: 'prepare', recoverability: 'none',
      oldSuiteId: 'suite.a', newSuiteId: 'suite.b',
    })])
  })

  it('reports an active renderer runtime fatal after ready so the product host can fall back', async () => {
    const container = document.createElement('div')
    const diagnostics: unknown[] = []
    const port = fakeHost(); port.diagnostics.report = value => diagnostics.push(value)
    const host = new RendererSuiteHost({ container, hostPort: port, input })

    await host.mount(activation('suite.a', factory('A', { runtimeFail: true })))
    await vi.waitFor(() => expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'renderer.suite.runtime.failed', suiteId: 'suite.a', recoverability: 'fallback',
    })))
  })

  it('does not lose a cached runtime fatal replayed between ready and active commit', async () => {
    const container = document.createElement('div')
    const diagnostics: unknown[] = []
    const port = fakeHost(); port.diagnostics.report = value => diagnostics.push(value)
    const host = new RendererSuiteHost({ container, hostPort: port, input })

    await host.mount(activation('suite.a', factory('A', { cachedRuntimeFail: true })))

    expect(host.getState().phase).toBe('degraded')
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'renderer.suite.switch.failed', suiteId: 'suite.a', phase: 'mount',
    }))
  })

  it('does not lose a non-cached fatal emitted synchronously after ready', async () => {
    const container = document.createElement('div')
    const diagnostics: unknown[] = []
    const port = fakeHost(); port.diagnostics.report = value => diagnostics.push(value)
    const host = new RendererSuiteHost({ container, hostPort: port, input })

    await host.mount(activation('suite.a', factory('A', { synchronousPostReadyFail: true })))

    expect(host.getState().phase).toBe('degraded')
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'renderer.suite.switch.failed', suiteId: 'suite.a', phase: 'mount',
      message: 'A synchronous post-ready failed',
    }))
  })

  it('routes active Suite request-action through the semantic Host command gate', async () => {
    const container = document.createElement('div')
    const port = fakeHost()
    const copy = vi.fn(async () => ({ ok: true as const, value: { ok: true } }))
    Object.defineProperty(port, 'commands', { value: new Proxy({ copy } as unknown as WorkbenchHostPort['commands'], {
      get: (target, property) => property === 'copy' ? target.copy : async () => ({ ok: false as const, error: { code: 'denied', message: 'denied', recoverability: 'none' as const } }),
    }) })
    const host = new RendererSuiteHost({ container, hostPort: port, input })

    await host.mount(activation('suite.a', factory('A', {
      runtimeAction: { type: 'clipboard.write', payload: { text: 'from suite' } },
    })))

    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith('session-a', 'from suite'))
  })

  it('only activates latest request and destroys stale candidate', async () => {
    const container = document.createElement('div')
    const host = new RendererSuiteHost({ container, hostPort: fakeHost(), input })
    await host.mount(activation('suite.a', factory('A')))
    const b = host.switchTo(activation('suite.b', factory('B', { delay: 20 })))
    const c = host.switchTo(activation('suite.c', factory('C', { delay: 0 })))
    await Promise.all([b, c])
    expect(container.textContent).toContain('C')
    expect(container.textContent).not.toContain('B')
  })

  it('converges a preparing candidate to the latest session input before commit', async () => {
    const container = document.createElement('div')
    const candidateUpdates: WorkbenchMountInput[] = []
    let candidateMounted!: () => void
    const mounted = new Promise<void>(resolve => { candidateMounted = resolve })
    const host = new RendererSuiteHost({ container, hostPort: fakeHost(), input })
    await host.mount(activation('suite.a', factory('A')))

    const switching = host.switchTo(activation('suite.b', factory('B', {
      delay: 20,
      onMount: candidateMounted,
      onUpdate: next => candidateUpdates.push(next),
    })))
    await mounted
    host.update({ ...input, sessionOwnerKey: 'owner-b', sessionId: 'session-b' })
    await switching

    expect(candidateUpdates.at(-1)).toMatchObject({
      sessionOwnerKey: 'owner-b', sessionId: 'session-b',
    })
  })

  it('cancels a candidate waiting for ready when host is destroyed', async () => {
    const container = document.createElement('div')
    const host = new RendererSuiteHost({ container, hostPort: fakeHost(), input })
    const pending = host.switchTo(activation('suite.pending', factory('P', { delay: 10_000 })))
    await host.destroy()
    await pending
    expect(host.getState().phase).toBe('destroyed')
  })

  it('reports mount failure and keeps the previous instance as fallback', async () => {
    const container = document.createElement('div')
    const diagnostics: unknown[] = []
    const port = fakeHost(); port.diagnostics.report = value => diagnostics.push(value)
    const host = new RendererSuiteHost({ container, hostPort: port, input })
    await host.mount(activation('suite.a', factory('A')))
    await host.switchTo(activation('suite.b', factory('B', { mountFail: true })))
    expect(container.textContent).toContain('A')
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'renderer.suite.switch.failed', phase: 'mount' })])
  })

  it('treats slot/ready throw as mount failure with structured recoverability and revisions', async () => {
    const container = document.createElement('div')
    const diagnostics: unknown[] = []
    const port = fakeHost(); port.diagnostics.report = value => diagnostics.push(value)
    const host = new RendererSuiteHost({ container, hostPort: port, input, readyTimeoutMs: 20 })
    await host.mount(activation('suite.a', factory('A')))
    await host.switchTo(activation('suite.b', factory('B', { readyFail: true })))
    expect(container.textContent).toContain('A')
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 'renderer.suite.switch.failed', phase: 'mount', recoverability: 'none',
      registryRevision: 1, documentRevision: 5,
    })])
  })

  it('reports destroy failure without leaking the active DOM', async () => {
    const container = document.createElement('div')
    const diagnostics: unknown[] = []
    const port = fakeHost(); port.diagnostics.report = value => diagnostics.push(value)
    const host = new RendererSuiteHost({ container, hostPort: port, input })
    await host.mount(activation('suite.a', factory('A', { destroyFail: true })))
    await host.destroy()
    expect(container.childElementCount).toBe(0)
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'renderer.suite.destroy.failed', phase: 'destroy', recoverability: 'none', registryRevision: 1, documentRevision: 5 })])
  })
})
