import { BUILTIN_PYLON_SHELL_ID } from '../plugins/product/productPluginIds.ts'
import type { ApplicationMountPort } from '../application/applicationMountPort.ts'
import { reportRuntimeError } from '../app/runtimeError.ts'
import { startupMark } from '../app/startupTiming.ts'

export type PluginBootstrapStage = 'activate' | 'dependency' | 'capability-consent' | 'user-packages' | 'mount'

export interface PluginBootstrapFailure {
  readonly pluginId: string
  readonly stage: PluginBootstrapStage
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  /** capability-consent 专属：授权卡据此绑定 grant 的版本失效语义。 */
  readonly pluginVersion?: string
  readonly capabilities?: readonly string[]
}

export interface BuiltinBootstrapResult {
  readonly activePluginIds: readonly string[]
  readonly failures: readonly PluginBootstrapFailure[]
  readonly skippedPluginIds: readonly string[]
}

export type KernelBootstrapState =
  | { readonly kind: 'idle' | 'starting' }
  | { readonly kind: 'ready'; readonly activePluginIds: readonly string[] }
  | {
    readonly kind: 'degraded'
    readonly activePluginIds: readonly string[]
    readonly failures: readonly PluginBootstrapFailure[]
    readonly skippedPluginIds: readonly string[]
  }
  | { readonly kind: 'safe-mode'; readonly skippedPluginIds: readonly string[] }

export interface KernelBootstrapActions {
  bootstrapBuiltins(mode: 'normal' | 'safe-mode'): Promise<BuiltinBootstrapResult>
  initializeUserPackages(): Promise<{
    activated: readonly string[]
    failed: readonly {
      pluginId: string
      message: string
      code?: string
      version?: string
      capabilities?: readonly string[]
    }[]
  }>
  applicationMount?: ApplicationMountPort
  retryBuiltin(pluginId: string): Promise<BuiltinBootstrapResult>
}

export interface KernelBootstrap {
  getSnapshot(): KernelBootstrapState
  subscribe(listener: () => void): () => void
  startNormal(): Promise<void>
  startSafeMode(): Promise<void>
  retryPlugin(pluginId: string): Promise<void>
}

const IDLE: KernelBootstrapState = Object.freeze({ kind: 'idle' })

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createKernelBootstrap(actions: KernelBootstrapActions): KernelBootstrap {
  const listeners = new Set<() => void>()
  let snapshot = IDLE
  let operation: Promise<void> | undefined
  let safeModeActive = false
  let mountedApplicationId: string | null = null

  const mountApplication = (applicationId: string): void => {
    const mount = actions.applicationMount?.mount
    if (!mount) throw new Error('Application mount port 未配置')
    mount(applicationId)
  }
  const unmountApplication = (): void => {
    const unmount = actions.applicationMount?.unmount
    if (!unmount) throw new Error('Application mount port 未配置')
    unmount()
  }

  const publish = (next: KernelBootstrapState) => {
    snapshot = Object.freeze(next)
    for (const listener of [...listeners]) listener()
  }

  const runExclusive = (run: () => Promise<void>): Promise<void> => {
    if (operation) return operation
    operation = run().finally(() => { operation = undefined })
    return operation
  }

  const finishNormalBootstrap = async (builtins: BuiltinBootstrapResult): Promise<void> => {
    const activePluginIds = Object.freeze([...builtins.activePluginIds])
    const skippedPluginIds = Object.freeze([...builtins.skippedPluginIds])
    if (!activePluginIds.includes(BUILTIN_PYLON_SHELL_ID)) {
      publish({
        kind: 'degraded',
        activePluginIds,
        failures: Object.freeze([...builtins.failures]),
        skippedPluginIds,
      })
      return
    }
    try {
      if (mountedApplicationId !== BUILTIN_PYLON_SHELL_ID) {
        mountApplication(BUILTIN_PYLON_SHELL_ID)
        mountedApplicationId = BUILTIN_PYLON_SHELL_ID
        startupMark('shell_mounted')
      }
    } catch (error) {
      const detail = reportRuntimeError('挂载 Kernel 应用', error)
      publish({
        kind: 'degraded',
        activePluginIds,
        failures: Object.freeze([
          ...builtins.failures,
          {
            pluginId: BUILTIN_PYLON_SHELL_ID,
            stage: 'mount',
            code: 'application_mount_failed',
            message: detail.message,
            retryable: true,
          },
        ]),
        skippedPluginIds,
      })
      return
    }
    let packages: Awaited<ReturnType<KernelBootstrapActions['initializeUserPackages']>>
    try {
      packages = await actions.initializeUserPackages()
    } catch (error) {
      publish({
        kind: 'degraded',
        activePluginIds,
        failures: Object.freeze([
          ...builtins.failures,
          {
            pluginId: 'user-packages',
            stage: 'user-packages',
            code: 'user_package_discovery_failed',
            message: messageOf(error),
            retryable: true,
          },
        ]),
        skippedPluginIds,
      })
      return
    }
    const failures: PluginBootstrapFailure[] = [
      ...builtins.failures,
      ...packages.failed.map(failure => Object.freeze({
        pluginId: failure.pluginId,
        stage: 'user-packages' as const,
        code: failure.code ?? 'user_plugin_initialization_failed',
        message: failure.message,
        retryable: true,
        ...(failure.version ? { pluginVersion: failure.version } : {}),
        ...(failure.capabilities ? { capabilities: failure.capabilities } : {}),
      })),
    ]
    const allActivePluginIds = Object.freeze([...new Set([
      ...activePluginIds,
      ...packages.activated,
    ])].sort())
    if (failures.length > 0) {
      publish({
        kind: 'degraded',
        activePluginIds: allActivePluginIds,
        failures: Object.freeze(failures),
        skippedPluginIds,
      })
      return
    }
    publish({ kind: 'ready', activePluginIds: allActivePluginIds })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    startNormal() {
      return runExclusive(async () => {
        startupMark('kernel_bootstrap_start')
        safeModeActive = false
        publish({ kind: 'starting' })
        let builtins: BuiltinBootstrapResult
        try {
          builtins = await actions.bootstrapBuiltins('normal')
          startupMark('builtins_activated')
        } catch (error) {
          publish({
            kind: 'degraded',
            activePluginIds: Object.freeze([]),
            failures: Object.freeze([{
              pluginId: 'plugin-host',
              stage: 'activate',
              code: 'plugin_bootstrap_failed',
              message: messageOf(error),
              retryable: true,
            }]),
            skippedPluginIds: Object.freeze([]),
          })
          return
        }
        await finishNormalBootstrap(builtins)
      })
    },
    startSafeMode() {
      return runExclusive(async () => {
        const previousSnapshot = snapshot
        safeModeActive = true
        publish({ kind: 'starting' })
        try {
          unmountApplication()
          mountedApplicationId = null
          const builtins = await actions.bootstrapBuiltins('safe-mode')
          publish({ kind: 'safe-mode', skippedPluginIds: Object.freeze([...builtins.skippedPluginIds]) })
        } catch (error) {
          publish({
            kind: 'degraded',
            activePluginIds: previousSnapshot.kind === 'ready' || previousSnapshot.kind === 'degraded'
              ? previousSnapshot.activePluginIds
              : Object.freeze([]),
            failures: Object.freeze([{
              pluginId: 'plugin-host',
              stage: 'activate',
              code: 'safe_mode_entry_failed',
              message: messageOf(error),
              retryable: true,
            }]),
            skippedPluginIds: previousSnapshot.kind === 'degraded' || previousSnapshot.kind === 'safe-mode'
              ? previousSnapshot.skippedPluginIds
              : Object.freeze([]),
          })
        }
      })
    },
    retryPlugin(pluginId) {
      return runExclusive(async () => {
        const previousSnapshot = snapshot
        const selectingInSafeMode = safeModeActive
        publish({ kind: 'starting' })
        const retryingUserPackages = previousSnapshot.kind === 'degraded'
          && previousSnapshot.failures.some(failure => (
            failure.stage === 'user-packages' && failure.pluginId === pluginId
          ))
        if (retryingUserPackages) {
          await finishNormalBootstrap({
            activePluginIds: previousSnapshot.activePluginIds,
            failures: previousSnapshot.failures.filter(failure => failure.stage !== 'user-packages'),
            skippedPluginIds: previousSnapshot.skippedPluginIds,
          })
          return
        }
        let retryResult: BuiltinBootstrapResult
        try {
          retryResult = await actions.retryBuiltin(pluginId)
        } catch (error) {
          const retainedFailures = previousSnapshot.kind === 'degraded'
            ? previousSnapshot.failures.filter(failure => failure.pluginId !== pluginId)
            : []
          publish({
            kind: 'degraded',
            activePluginIds: previousSnapshot.kind === 'ready' || previousSnapshot.kind === 'degraded'
              ? previousSnapshot.activePluginIds
              : Object.freeze([]),
            failures: Object.freeze([
              ...retainedFailures,
              {
                pluginId,
                stage: 'activate',
                code: 'plugin_retry_failed',
                message: messageOf(error),
                retryable: true,
              },
            ]),
            skippedPluginIds: previousSnapshot.kind === 'degraded' || previousSnapshot.kind === 'safe-mode'
              ? previousSnapshot.skippedPluginIds
              : Object.freeze([]),
          })
          return
        }
        const active = new Set(retryResult.activePluginIds)
        const retriedFailureIds = new Set(retryResult.failures.map(failure => failure.pluginId))
        const retainedFailures = previousSnapshot.kind === 'degraded'
          ? previousSnapshot.failures.filter(failure => (
            failure.stage !== 'user-packages'
            && !active.has(failure.pluginId)
            && !retriedFailureIds.has(failure.pluginId)
          ))
          : []
        const builtins: BuiltinBootstrapResult = {
          ...retryResult,
          failures: Object.freeze([...retainedFailures, ...retryResult.failures]),
        }
        if (selectingInSafeMode) {
          if (builtins.failures.length > 0) {
            publish({
              kind: 'degraded',
              activePluginIds: Object.freeze([...builtins.activePluginIds]),
              failures: Object.freeze([...builtins.failures]),
              skippedPluginIds: Object.freeze([...builtins.skippedPluginIds]),
            })
            return
          }
          if (builtins.activePluginIds.includes(BUILTIN_PYLON_SHELL_ID)) {
            if (mountedApplicationId !== BUILTIN_PYLON_SHELL_ID) {
              mountApplication(BUILTIN_PYLON_SHELL_ID)
              mountedApplicationId = BUILTIN_PYLON_SHELL_ID
            }
          }
          publish({
            kind: 'safe-mode',
            skippedPluginIds: Object.freeze([...builtins.skippedPluginIds]),
          })
          return
        }
        await finishNormalBootstrap(builtins)
      })
    },
  }
}
