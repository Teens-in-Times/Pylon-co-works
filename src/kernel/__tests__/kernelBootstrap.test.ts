import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_PYLON_SHELL_ID } from '../../plugins/product/productPluginIds.ts'
import { createKernelBootstrap, type BuiltinBootstrapResult } from '../kernelBootstrap.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Kernel bootstrap supervisor', () => {
  it('publishes starting before mounting the application after explicit builtin activation', async () => {
    const builtins = deferred<BuiltinBootstrapResult>()
    const order: string[] = []
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(() => builtins.promise),
      initializeUserPackages: vi.fn(async () => ({ activated: [], failed: [] })),
      applicationMount: { mount: vi.fn(() => { order.push('mount') }), unmount: vi.fn() },
      retryBuiltin: vi.fn(async () => ({ activePluginIds: [], failures: [], skippedPluginIds: [] })),
    })

    const starting = bootstrap.startNormal()

    expect(bootstrap.getSnapshot()).toMatchObject({ kind: 'starting' })
    expect(order).toEqual([])

    order.push('activated')
    builtins.resolve({
      activePluginIds: [BUILTIN_PYLON_SHELL_ID],
      failures: [],
      skippedPluginIds: [],
    })
    await starting

    expect(order).toEqual(['activated', 'mount'])
    expect(bootstrap.getSnapshot()).toEqual({
      kind: 'ready',
      activePluginIds: [BUILTIN_PYLON_SHELL_ID],
    })
  })

  it('keeps the recovery surface degraded when the shell did not activate', async () => {
    const initializeUserPackages = vi.fn(async () => ({ activated: [], failed: [] }))
    const mount = vi.fn()
    const shellFailure = {
      pluginId: BUILTIN_PYLON_SHELL_ID,
      stage: 'activate' as const,
      code: 'plugin_activation_failed',
      message: 'shell boom',
      retryable: true,
    }
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => ({
        activePluginIds: ['builtin.pylon-workspace'],
        failures: [shellFailure],
        skippedPluginIds: [],
      })),
      initializeUserPackages,
      applicationMount: { mount, unmount: vi.fn() },
      retryBuiltin: vi.fn(async () => ({ activePluginIds: [], failures: [], skippedPluginIds: [] })),
    })

    await bootstrap.startNormal()

    expect(mount).not.toHaveBeenCalled()
    expect(initializeUserPackages).not.toHaveBeenCalled()
    expect(bootstrap.getSnapshot()).toEqual({
      kind: 'degraded',
      activePluginIds: ['builtin.pylon-workspace'],
      failures: [shellFailure],
      skippedPluginIds: [],
    })
  })

  it('keeps user package initialization failures observable after mounting the shell', async () => {
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => ({
        activePluginIds: [BUILTIN_PYLON_SHELL_ID],
        failures: [],
        skippedPluginIds: [],
      })),
      initializeUserPackages: vi.fn(async () => ({
        activated: [],
        failed: [{ pluginId: 'user.broken', message: 'entry rejected' }],
      })),
      applicationMount: { mount: vi.fn(), unmount: vi.fn() },
      retryBuiltin: vi.fn(async () => ({ activePluginIds: [], failures: [], skippedPluginIds: [] })),
    })

    await bootstrap.startNormal()

    expect(bootstrap.getSnapshot()).toEqual({
      kind: 'degraded',
      activePluginIds: [BUILTIN_PYLON_SHELL_ID],
      failures: [{
        pluginId: 'user.broken',
        stage: 'user-packages',
        code: 'user_plugin_initialization_failed',
        message: 'entry rejected',
        retryable: true,
      }],
      skippedPluginIds: [],
    })
  })

  it('turns a user package discovery rejection into a degraded snapshot', async () => {
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => ({
        activePluginIds: [BUILTIN_PYLON_SHELL_ID],
        failures: [],
        skippedPluginIds: [],
      })),
      initializeUserPackages: vi.fn(async () => { throw new Error('plugin directory unavailable') }),
      applicationMount: { mount: vi.fn(), unmount: vi.fn() },
      retryBuiltin: vi.fn(async () => ({ activePluginIds: [], failures: [], skippedPluginIds: [] })),
    })

    await expect(bootstrap.startNormal()).resolves.toBeUndefined()

    expect(bootstrap.getSnapshot()).toMatchObject({
      kind: 'degraded',
      failures: [{
        pluginId: 'user-packages',
        stage: 'user-packages',
        code: 'user_package_discovery_failed',
        message: 'plugin directory unavailable',
        retryable: true,
      }],
    })
  })

  it('retries one failed builtin and mounts the shell after recovery succeeds', async () => {
    const shellFailure = {
      pluginId: BUILTIN_PYLON_SHELL_ID,
      stage: 'activate' as const,
      code: 'plugin_activation_failed',
      message: 'shell boom',
      retryable: true,
    }
    const mount = vi.fn()
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => ({
        activePluginIds: [],
        failures: [shellFailure],
        skippedPluginIds: [],
      })),
      initializeUserPackages: vi.fn(async () => ({ activated: [], failed: [] })),
      applicationMount: { mount, unmount: vi.fn() },
      retryBuiltin: vi.fn(async () => ({
        activePluginIds: [BUILTIN_PYLON_SHELL_ID],
        failures: [],
        skippedPluginIds: [],
      })),
    })
    await bootstrap.startNormal()

    await bootstrap.retryPlugin(BUILTIN_PYLON_SHELL_ID)

    expect(mount).toHaveBeenCalledWith(BUILTIN_PYLON_SHELL_ID)
    expect(bootstrap.getSnapshot()).toEqual({
      kind: 'ready',
      activePluginIds: [BUILTIN_PYLON_SHELL_ID],
    })
  })

  it('enters safe mode without user packages and unmounts any product application', async () => {
    const initializeUserPackages = vi.fn(async () => ({ activated: [], failed: [] }))
    const unmount = vi.fn()
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async mode => ({
        activePluginIds: [],
        failures: [],
        skippedPluginIds: mode === 'safe-mode' ? ['builtin.pylon-shell'] : [],
      })),
      initializeUserPackages,
      applicationMount: { mount: vi.fn(), unmount },
      retryBuiltin: vi.fn(async () => ({ activePluginIds: [], failures: [], skippedPluginIds: [] })),
    })

    await bootstrap.startSafeMode()

    expect(unmount).toHaveBeenCalledOnce()
    expect(initializeUserPackages).not.toHaveBeenCalled()
    expect(bootstrap.getSnapshot()).toEqual({
      kind: 'safe-mode',
      skippedPluginIds: ['builtin.pylon-shell'],
    })
  })

  it('starts an explicitly selected safe-mode builtin closure without initializing user packages', async () => {
    const initializeUserPackages = vi.fn(async () => ({ activated: [], failed: [] }))
    const mount = vi.fn()
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => ({
        activePluginIds: [],
        failures: [],
        skippedPluginIds: [BUILTIN_PYLON_SHELL_ID],
      })),
      initializeUserPackages,
      applicationMount: { mount, unmount: vi.fn() },
      retryBuiltin: vi.fn(async () => ({
        activePluginIds: [BUILTIN_PYLON_SHELL_ID],
        failures: [],
        skippedPluginIds: [],
      })),
    })
    await bootstrap.startSafeMode()

    await bootstrap.retryPlugin(BUILTIN_PYLON_SHELL_ID)

    expect(mount).toHaveBeenCalledWith(BUILTIN_PYLON_SHELL_ID)
    expect(initializeUserPackages).not.toHaveBeenCalled()
    expect(bootstrap.getSnapshot()).toEqual({ kind: 'safe-mode', skippedPluginIds: [] })
  })

  it('keeps unrelated bootstrap failures after retrying one plugin', async () => {
    const shellFailure = {
      pluginId: BUILTIN_PYLON_SHELL_ID,
      stage: 'activate' as const,
      code: 'plugin_activation_failed',
      message: 'shell failed',
      retryable: true,
    }
    const optionalFailure = {
      pluginId: 'builtin.optional',
      stage: 'activate' as const,
      code: 'plugin_activation_failed',
      message: 'optional failed',
      retryable: true,
    }
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => ({
        activePluginIds: [],
        failures: [shellFailure, optionalFailure],
        skippedPluginIds: [],
      })),
      initializeUserPackages: vi.fn(async () => ({ activated: [], failed: [] })),
      applicationMount: { mount: vi.fn(), unmount: vi.fn() },
      retryBuiltin: vi.fn(async () => ({
        activePluginIds: [BUILTIN_PYLON_SHELL_ID],
        failures: [],
        skippedPluginIds: ['builtin.optional'],
      })),
    })
    await bootstrap.startNormal()

    await bootstrap.retryPlugin(BUILTIN_PYLON_SHELL_ID)

    expect(bootstrap.getSnapshot()).toMatchObject({
      kind: 'degraded',
      failures: [optionalFailure],
    })
  })

  it('retries user package discovery without sending its synthetic id to the builtin resolver', async () => {
    let packageAttempt = 0
    const retryBuiltin = vi.fn(async () => ({ activePluginIds: [], failures: [], skippedPluginIds: [] }))
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => ({
        activePluginIds: [BUILTIN_PYLON_SHELL_ID],
        failures: [],
        skippedPluginIds: [],
      })),
      initializeUserPackages: vi.fn(async () => {
        packageAttempt += 1
        if (packageAttempt === 1) throw new Error('directory unavailable')
        return { activated: ['user.recovered'], failed: [] }
      }),
      applicationMount: { mount: vi.fn(), unmount: vi.fn() },
      retryBuiltin,
    })
    await bootstrap.startNormal()

    await bootstrap.retryPlugin('user-packages')

    expect(retryBuiltin).not.toHaveBeenCalled()
    expect(bootstrap.getSnapshot()).toEqual({
      kind: 'ready',
      activePluginIds: [BUILTIN_PYLON_SHELL_ID, 'user.recovered'],
    })
  })

  it('turns a bootstrap transaction rejection into a recoverable degraded snapshot', async () => {
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => { throw new Error('host construction failed') }),
      initializeUserPackages: vi.fn(async () => ({ activated: [], failed: [] })),
      applicationMount: { mount: vi.fn(), unmount: vi.fn() },
      retryBuiltin: vi.fn(async () => ({ activePluginIds: [], failures: [], skippedPluginIds: [] })),
    })

    await expect(bootstrap.startNormal()).resolves.toBeUndefined()

    expect(bootstrap.getSnapshot()).toEqual({
      kind: 'degraded',
      activePluginIds: [],
      failures: [{
        pluginId: 'plugin-host',
        stage: 'activate',
        code: 'plugin_bootstrap_failed',
        message: 'host construction failed',
        retryable: true,
      }],
      skippedPluginIds: [],
    })
  })

  it('turns safe-mode entry and retry rejections into retryable degraded snapshots', async () => {
    const retryBuiltin = vi.fn(async () => { throw new Error('retry transport failed') })
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async mode => {
        if (mode === 'safe-mode') throw new Error('safe-mode teardown failed')
        return { activePluginIds: [], failures: [], skippedPluginIds: [] }
      }),
      initializeUserPackages: vi.fn(async () => ({ activated: [], failed: [] })),
      applicationMount: { mount: vi.fn(), unmount: vi.fn() },
      retryBuiltin,
    })

    await expect(bootstrap.startSafeMode()).resolves.toBeUndefined()
    expect(bootstrap.getSnapshot()).toMatchObject({
      kind: 'degraded',
      failures: [{
        pluginId: 'plugin-host',
        code: 'safe_mode_entry_failed',
        message: 'safe-mode teardown failed',
        retryable: true,
      }],
    })

    await expect(bootstrap.retryPlugin(BUILTIN_PYLON_SHELL_ID)).resolves.toBeUndefined()
    expect(bootstrap.getSnapshot()).toMatchObject({
      kind: 'degraded',
      failures: expect.arrayContaining([expect.objectContaining({
        pluginId: BUILTIN_PYLON_SHELL_ID,
        code: 'plugin_retry_failed',
        message: 'retry transport failed',
        retryable: true,
      })]),
    })
  })

  it('uses the injected application mount port once across idempotent starts', async () => {
    const mount = vi.fn()
    const unmount = vi.fn()
    const bootstrap = createKernelBootstrap({
      bootstrapBuiltins: vi.fn(async () => ({
        activePluginIds: [BUILTIN_PYLON_SHELL_ID], failures: [], skippedPluginIds: [],
      })),
      initializeUserPackages: vi.fn(async () => ({ activated: [], failed: [] })),
      applicationMount: { mount, unmount },
      retryBuiltin: vi.fn(async () => ({ activePluginIds: [BUILTIN_PYLON_SHELL_ID], failures: [], skippedPluginIds: [] })),
    })

    await bootstrap.startNormal()
    await bootstrap.startNormal()
    expect(mount).toHaveBeenCalledOnce()

    await bootstrap.startSafeMode()
    expect(unmount).toHaveBeenCalledOnce()
  })
})
