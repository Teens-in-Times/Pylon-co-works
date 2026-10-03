import { describe, expect, it, vi } from 'vitest'
import { TestPluginRuntime as PluginRuntime } from '../testing/pluginRuntimeHarness.ts'
import { getCommandRegistry, getHookRuntime } from '../runtimeServices'

describe('PluginRuntime 静态内置插件 Harness', () => {
  it('rejects direct activation when a required dependency is not active', async () => {
    const runtime = new PluginRuntime()
    const activate = vi.fn()

    await expect(runtime.activateBuiltin({
      id: 'feature.consumer',
      version: '1.0.0',
      dependencies: { 'service.missing': '*' },
      activate,
    })).rejects.toMatchObject({
      name: 'PluginContractBlockedError',
      code: 'plugin_contract_blocked',
      pluginId: 'feature.consumer',
    })
    expect(activate).not.toHaveBeenCalled()
  })

  it('rejects an update that would break an active dependent version range', async () => {
    const runtime = new PluginRuntime()
    await runtime.activateBuiltin({ id: 'service.clock', version: '1.5.0', activate: () => {} })
    await runtime.activateBuiltin({
      id: 'feature.consumer',
      version: '1.0.0',
      dependencies: { 'service.clock': '^1.0.0' },
      activate: () => {},
    })
    const candidateActivate = vi.fn()

    await expect(runtime.update({
      id: 'service.clock',
      version: '2.0.0',
      hotSwapMode: 'restart-required',
      activate: candidateActivate,
    })).rejects.toMatchObject({ code: 'plugin_contract_blocked' })

    expect(candidateActivate).not.toHaveBeenCalled()
    expect(runtime.snapshot().active.map(item => item.pluginId)).toEqual([
      'feature.consumer',
      'service.clock',
    ])
  })


  it('同步激活路径在返回前提交实例，并拒绝 async activate', async () => {
    const runtime = new PluginRuntime()
    const instance = runtime.activateBuiltinSync({
      id: 'builtin.sync-fixture',
      activate: ({ scope }) => {
        scope.add(() => {})
      },
    })

    expect(runtime.snapshot().active).toEqual([instance.identity])
    await expect(async () => runtime.activateBuiltinSync({
      id: 'builtin.async-fixture',
      activate: async () => {},
    })).rejects.toThrow('同步返回')
  })

  it('activate → snapshot → deactivate 完成单实例生命周期', async () => {
    const target = new EventTarget()
    const listener = vi.fn()
    const runtime = new PluginRuntime()
    const instance = await runtime.activateBuiltin({
      id: 'builtin.scope-fixture',
      activate: ({ scope }) => {
        scope.listen(target, 'ping', listener)
      },
    })

    target.dispatchEvent(new Event('ping'))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot().active).toEqual([instance.identity])

    const result = await runtime.deactivate(instance.identity.key)
    target.dispatchEvent(new Event('ping'))

    expect(result.scope.disposed).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot().active).toEqual([])
  })

  it('retains cleanup-failed instances and removes them only after retry succeeds', async () => {
    const runtime = new PluginRuntime()
    let cleanupBlocked = true
    const instance = await runtime.activateBuiltin({
      id: 'feature.cleanup-retry',
      activate: ({ scope }) => {
        scope.add(() => {
          if (cleanupBlocked) throw new Error('resource locked')
        }, { resourceId: 'locked-resource' })
      },
    })

    await expect(runtime.deactivate(instance.identity.key)).resolves.toMatchObject({ complete: false })
    expect(runtime.snapshot().active).toEqual([])
    expect(runtime.snapshot().instances).toEqual([expect.objectContaining({
      identity: instance.identity,
      status: 'cleanup-failed',
      cleanup: expect.objectContaining({
        scope: expect.objectContaining({ remaining: 1 }),
      }),
    })])

    cleanupBlocked = false
    await expect(runtime.retryCleanup(instance.identity.key)).resolves.toMatchObject({ complete: true })
    expect(runtime.snapshot().instances).toEqual([])
  })

  it('keeps a failed old-instance cleanup observable after a successful shadow update', async () => {
    const runtime = new PluginRuntime()
    let cleanupBlocked = true
    const old = await runtime.activateBuiltin({
      id: 'feature.shadow-cleanup',
      activate: ({ scope }) => {
        scope.add(() => {
          if (cleanupBlocked) throw new Error('old resource busy')
        }, { resourceId: 'old-resource' })
      },
    })

    const updated = await runtime.update({
      id: 'feature.shadow-cleanup',
      activate: () => {},
    })

    expect(runtime.snapshot().active.map(item => item.key)).toEqual([updated.runtimeInstanceId])
    expect(runtime.snapshot().instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: old.identity, status: 'cleanup-failed' }),
      expect.objectContaining({ status: 'active' }),
    ]))

    cleanupBlocked = false
    await runtime.retryCleanup(old.identity.key)
    expect(runtime.snapshot().instances).toHaveLength(1)
  })

  it('同 pluginId 活跃时拒绝重复实例', async () => {
    const runtime = new PluginRuntime()
    await runtime.activateBuiltin({ id: 'builtin.scope-fixture', activate: () => {} })
    await expect(runtime.activateBuiltin({ id: 'builtin.scope-fixture', activate: () => {} }))
      .rejects.toThrow('已激活')
  })

  it('activation 失败不写入 runtime snapshot', async () => {
    const runtime = new PluginRuntime()
    await expect(runtime.activateBuiltin({
      id: 'builtin.scope-fixture',
      activate: ({ scope }) => {
        scope.add(() => {})
        throw new Error('boom')
      },
    })).rejects.toMatchObject({ rollback: { disposed: 1, errors: [] } })
    expect(runtime.snapshot().active).toEqual([])
  })

  it('候选 activate 失败时旧命令、旧 snapshot 与旧资源保持可用', async () => {
    const runtime = new PluginRuntime()
    const disposed = vi.fn()
    const old = await runtime.activateBuiltin({
      id: 'phase9.failure',
      activate: ({ commands }) => {
        commands.register({ id: 'phase9.failure.command', name: 'phase9-failure', description: 'old', priority: 1, execute: () => 'old' })
      },
    })
    const before = runtime.snapshot()

    await expect(runtime.update({
      id: 'phase9.failure',
      activate: ({ commands, scope }) => {
        commands.register({ id: 'phase9.failure.command', name: 'phase9-failure', description: 'new', priority: 1, execute: () => 'new' })
        scope.add(disposed)
        throw new Error('candidate readiness failed')
      },
    })).rejects.toThrow('candidate readiness failed')

    expect(await getCommandRegistry().execute('phase9.failure.command')).toBe('old')
    expect(runtime.snapshot()).toBe(before)
    expect(disposed).toHaveBeenCalledOnce()
    await runtime.deactivate(old.identity.key)
  })

  it('commit 前旧命令可见，成功后请求原子切到候选并记录采用模式', async () => {
    const runtime = new PluginRuntime()
    const old = await runtime.activateBuiltin({
      id: 'phase9.success',
      activate: ({ commands }) => {
        commands.register({ id: 'phase9.success.command', name: 'phase9-success', description: 'old', priority: 1, execute: () => 'old' })
      },
    })
    let release!: () => void
    const readiness = new Promise<void>(resolve => { release = resolve })
    const updating = runtime.update({
      id: 'phase9.success',
      hotSwapMode: 'parallel',
      activate: async ({ commands }) => {
        commands.register({ id: 'phase9.success.command', name: 'phase9-success', description: 'new', priority: 1, execute: () => 'new' })
        await readiness
      },
    })

    await vi.waitFor(async () => {
      expect(await getCommandRegistry().execute('phase9.success.command')).toBe('old')
    })
    release()
    const result = await updating
    expect(await getCommandRegistry().execute('phase9.success.command')).toBe('new')
    expect(result).toMatchObject({
      previousRuntimeInstanceId: old.identity.key,
      declaredMode: 'parallel',
      adoptedMode: 'parallel',
    })
    expect(runtime.snapshot().active[0]?.key).toBe(result.runtimeInstanceId)
    expect(runtime.snapshot().switches[0]).toMatchObject(result)
    await runtime.deactivate(result.runtimeInstanceId)
  })

  it('active pointer 提交失败时 revert Shadow Registry 并恢复旧实例', async () => {
    const runtime = new PluginRuntime()
    const old = await runtime.activateBuiltin({
      id: 'phase9.pointer',
      activate: ({ commands }) => {
        commands.register({ id: 'phase9.pointer.command', name: 'phase9-pointer', description: 'old', priority: 1, execute: () => 'old' })
      },
    })
    const before = runtime.snapshot()
    await expect(runtime.update({
      id: 'phase9.pointer',
      activate: ({ commands }) => {
        commands.register({ id: 'phase9.pointer.command', name: 'phase9-pointer', description: 'new', priority: 1, execute: () => 'new' })
      },
    }, {
      commitActivePointer: () => { throw new Error('disk full') },
    })).rejects.toThrow('disk full')

    expect(await getCommandRegistry().execute('phase9.pointer.command')).toBe('old')
    expect(runtime.snapshot()).toBe(before)
    await runtime.deactivate(old.identity.key)
  })

  it('新请求切换后等待旧 Hook lease 排空，再停用旧实例', async () => {
    const runtime = new PluginRuntime()
    let release!: () => void
    let markStarted!: () => void
    const oldLease = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const deactivated = vi.fn()
    const old = await runtime.activateBuiltin({
      id: 'phase9.drain',
      activate: ({ hooks }) => {
        hooks.register('turn.started', {
          id: 'lease', mode: 'pipeline', execution: 'blocking', timeoutMs: 5000,
          handler: async () => { markStarted(); await oldLease; return { action: 'continue' } },
        })
      },
      deactivate: deactivated,
    })
    // fake timers 在 invoke 之前就位：hook watchdog（timeoutMs 5000）与 drain 的
    // 10s 超时全部落在假时钟上，负断言推进 20ms 真实时间窗后由 finally 还原，
    // 不会有 watchdog 泄漏到真实时钟。hook 派发是纯微任务（hookRuntime 的
    // Promise.resolve().then），await started / release 后的排空不依赖定时器。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const invocation = getHookRuntime().invoke('turn.started', { value: 'old' })
      await started

      let completed = false
      const updating = runtime.update({
        id: 'phase9.drain',
        activate: ({ hooks }) => {
          hooks.register('turn.started', {
            id: 'lease', mode: 'pipeline', execution: 'blocking',
            handler: () => ({ action: 'continue' }),
          })
        },
      }).then(result => { completed = true; return result })

      // 时间窗负断言：lease 未排空时，20ms 内更新不得完成、旧实例不得停用。
      await vi.advanceTimersByTimeAsync(20)
      expect(completed).toBe(false)
      expect(deactivated).not.toHaveBeenCalled()
      release()
      await invocation
      const result = await updating
      expect(deactivated).toHaveBeenCalledOnce()
      expect(result.previousRuntimeInstanceId).toBe(old.identity.key)
      await runtime.deactivate(result.runtimeInstanceId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('soft-remount 调用 Kernel 边界并在 snapshot 中显示 declared/adopted', async () => {
    const remount = vi.fn()
    const runtime = new PluginRuntime({ requestSoftRemount: remount })
    await runtime.activateBuiltin({ id: 'phase9.remount', activate: () => {} })
    const result = await runtime.update({
      id: 'phase9.remount',
      hotSwapMode: 'soft-remount',
      activate: () => {},
    })
    expect(remount).toHaveBeenCalledOnce()
    expect(result.declaredMode).toBe('soft-remount')
    expect(result.adoptedMode).toBe('soft-remount')
    await runtime.deactivate(result.runtimeInstanceId)
  })

  it('restart-required 拒绝进程内切换并明确记录 declared/adopted', async () => {
    const runtime = new PluginRuntime()
    const active = await runtime.activateBuiltin({ id: 'phase9.restart', activate: () => {} })
    await expect(runtime.update({
      id: 'phase9.restart', hotSwapMode: 'restart-required', activate: () => {},
    })).rejects.toMatchObject({ declaredMode: 'restart-required', adoptedMode: 'restart-required' })
    expect(runtime.snapshot().active).toEqual([active.identity])
    expect(runtime.snapshot().switches[0]).toMatchObject({
      pluginId: 'phase9.restart', declaredMode: 'restart-required', adoptedMode: 'restart-required',
    })
    await runtime.deactivate(active.identity.key)
  })

  it('exclusive 在 commit 前 suspend，指针失败时 resume 旧实例', async () => {
    const suspended = vi.fn()
    const resumed = vi.fn()
    const runtime = new PluginRuntime()
    const active = await runtime.activateBuiltin({
      id: 'phase9.exclusive', activate: () => {}, suspend: suspended, resume: resumed,
    })
    await expect(runtime.update({
      id: 'phase9.exclusive', hotSwapMode: 'exclusive', activate: () => {},
    }, {
      commitActivePointer: () => { throw new Error('pointer rejected') },
    })).rejects.toThrow('pointer rejected')
    expect(suspended).toHaveBeenCalledOnce()
    expect(resumed).toHaveBeenCalledOnce()
    expect(runtime.snapshot().active).toEqual([active.identity])
    await runtime.deactivate(active.identity.key)
  })

  it('同一 pluginId 的并发更新按提交顺序串行化', async () => {
    const runtime = new PluginRuntime()
    await runtime.activateBuiltin({ id: 'phase9.serial', activate: () => {} })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const order: string[] = []
    const first = runtime.update({
      id: 'phase9.serial',
      activate: async () => { order.push('first-start'); await gate; order.push('first-ready') },
    })
    const second = runtime.update({
      id: 'phase9.serial',
      activate: () => { order.push('second-start') },
    })
    await vi.waitFor(() => expect(order).toEqual(['first-start']))
    release()
    await first
    const result = await second
    expect(order).toEqual(['first-start', 'first-ready', 'second-start'])
    await runtime.deactivate(result.runtimeInstanceId)
  })

  it('CLI 生命周期入口可 disable/enable/reload 且复用已知定义', async () => {
    const runtime = new PluginRuntime()
    const activated = vi.fn()
    const first = await runtime.activateBuiltin({
      id: 'phase10.lifecycle',
      activate: activated,
    })
    await runtime.disable('phase10.lifecycle')
    expect(runtime.snapshot().active).toHaveLength(0)
    const enabled = await runtime.enable('phase10.lifecycle')
    expect(enabled.identity.key).not.toBe(first.identity.key)
    expect(activated).toHaveBeenCalledTimes(2)
    const reloaded = await runtime.reload('phase10.lifecycle', 'parallel')
    expect(reloaded.previousRuntimeInstanceId).toBe(enabled.identity.key)
    expect(reloaded.runtimeInstanceId).not.toBe(enabled.identity.key)
    expect(activated).toHaveBeenCalledTimes(3)
    await runtime.disable('phase10.lifecycle')
  })

  it('rejects ordinary disable for product-required plugins while recovery can deactivate by instance', async () => {
    const runtime = new PluginRuntime()
    const active = await runtime.activateBuiltin({
      id: 'builtin.product-required',
      criticality: 'product-required',
      activate: () => {},
    })

    await expect(runtime.disable('builtin.product-required')).rejects.toMatchObject({
      name: 'PluginDisableRejectedError',
      code: 'product_plugin_required',
      pluginId: 'builtin.product-required',
    })
    expect(runtime.snapshot().active).toEqual([active.identity])

    await runtime.deactivate(active.identity.key)
    expect(runtime.snapshot().active).toEqual([])
  })
})
