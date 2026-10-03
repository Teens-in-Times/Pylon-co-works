// @vitest-environment jsdom
import { afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PluginManager from '../PluginManager.solid.tsx'
import type { InstalledPluginPackage } from '../../../infrastructure/plugins/pluginPackageClient.ts'
import type { PackageInstallationService } from '../../../plugin-runtime/packageInstallationService.ts'
import type { KernelBootstrap } from '../../../kernel/kernelBootstrap.ts'
import {
  bootstrapBuiltins,
  getBuiltinPluginCriticality,
  getBuiltinPluginIds,
  getPluginRuntime,
} from '../../../plugin-runtime/pluginCompositionRoot.ts'

// 全局 afterEach(cleanup) 已由 vitest.setup.ts 统一接通（@solidjs/testing-library）；此处显式注册为冗余保险。
afterEach(cleanup)

/**
 * PluginManager v2-only 行为契约（#515 随实体迁移为 Solid 直连测试）。
 * 断言改写点登记：render(() => JSX) 函数形态 + afterEach(cleanup)；断言集逐条原样。
 */

function installedPackage(enabled = true): InstalledPluginPackage {
  return {
    enabled,
    package: {
      pluginId: 'feature.demo',
      version: '1.2.3',
      packageInstanceId: 'feature.demo@1.2.3-a1',
      active: true,
      files: [],
      totalBytes: 0,
      manifest: {
        schema: 1,
        id: 'feature.demo',
        name: 'Demo',
        version: '1.2.3',
        api: '1.0',
        kind: 'feature',
        web: { entry: './dist/entry.js' },
      },
    },
  }
}

function fakeService(items: InstalledPluginPackage[] = []) {
  const contractSnapshot = {
    revision: 0,
    eligibleIds: [] as readonly string[],
    diagnostics: [] as readonly {
      pluginId: string
      code: 'waiting_activation'
      message: string
      blocking: boolean
      relatedPluginIds: readonly string[]
    }[],
  }
  return {
    initialize: vi.fn(async () => ({ activated: [], failed: [] })),
    list: vi.fn(async () => items),
    installOrUpdate: vi.fn(async () => ({ ok: true as const })),
    setEnabled: vi.fn(async () => ({ ok: true as const })),
    reload: vi.fn(async () => ({ ok: true as const })),
    uninstall: vi.fn(async () => ({ ok: true as const })),
    getContractSnapshot: vi.fn(() => contractSnapshot),
    subscribeContracts: vi.fn(() => () => undefined),
  }
}

beforeEach(async () => {
  await bootstrapBuiltins('normal')
})

afterEach(async () => {
  const runtime = getPluginRuntime()
  for (const instance of runtime.snapshot().instances.filter(item => (
    item.identity.pluginId === 'phase12.ui-mode' || item.identity.pluginId === 'feature.cleanup-ui'
  ))) {
    await runtime.retryCleanup(instance.identity.key)
  }
})

describe('PluginManager v2-only', () => {
  it('只显示 api=1.0 Runtime 与 v2 安装入口', async () => {
    const service = fakeService()
    render(() => <PluginManager service={service as unknown as PackageInstallationService} />)

    expect(await screen.findByText('builtin.pylon-shell')).toBeInTheDocument()
    expect(screen.getByText(/Pylon Plugin API 1.0/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装/更新 api=1.0 包…' })).toBeInTheDocument()
    expect(screen.queryByText(/0\.1\.0/)).toBeNull()
    expect(screen.queryByLabelText('pylon-plugin.json')).toBeNull()
  })

  it('目录安装只调用 v2 package service', async () => {
    const service = fakeService()
    render(() => <PluginManager
      service={service as unknown as PackageInstallationService}
      pickDirectory={async () => 'C:\\plugins\\feature.demo'}
    />)

    fireEvent.click(screen.getByRole('button', { name: '安装/更新 api=1.0 包…' }))
    expect(await screen.findByText('安装/更新成功')).toBeInTheDocument()
    expect(service.installOrUpdate).toHaveBeenCalledWith('C:\\plugins\\feature.demo')
  })

  it('外置包启停、重载和卸载全部走 v2 service', async () => {
    const service = fakeService([installedPackage(false)])
    render(() => <PluginManager service={service as unknown as PackageInstallationService} />)

    expect(await screen.findByText('feature.demo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '启用 feature.demo' }))
    expect(await screen.findByText('启用 feature.demo成功')).toBeInTheDocument()
    expect(service.setEnabled).toHaveBeenCalledWith('feature.demo', true)
  })

  it('显示 Runtime 实际采用的 Shadow Update 模式', async () => {
    const runtime = getPluginRuntime()
    const initial = await runtime.activateBuiltin({ id: 'phase12.ui-mode', activate: () => {} })
    const result = await runtime.update({ id: 'phase12.ui-mode', hotSwapMode: 'parallel', activate: () => {} })
    const service = fakeService()
    render(() => <PluginManager service={service as unknown as PackageInstallationService} />)

    expect(screen.getByText('phase12.ui-mode')).toBeInTheDocument()
    expect(screen.getByText('声明 parallel · 实际采用 parallel')).toBeInTheDocument()
    expect(result.previousRuntimeInstanceId).toBe(initial.identity.key)
  })

  it('does not offer ordinary disable for product-required builtins', async () => {
    await bootstrapBuiltins('normal')
    const service = fakeService()

    render(() => <PluginManager service={service as unknown as PackageInstallationService} />)

    // P53 D2（施工书 §6 例外 1）：builtin.pylon-plugin-manager 同为 product-required
    // P77：builtin.pylon-gateway 亦为 product-required（gateway 由 core 摘除后改由包贡献）
    // 断言遍历 criticality 注册表派生的 product-required 集合，不写死包数
    const productRequiredIds = getBuiltinPluginIds()
      .filter(id => getBuiltinPluginCriticality(id) === 'product-required')
    expect(productRequiredIds).toContain('builtin.pylon-shell')
    expect(productRequiredIds.length).toBeGreaterThan(1)
    expect(screen.getAllByText('产品运行必需')).toHaveLength(productRequiredIds.length)
    // 处于激活态（按钮为「停用」）的 product-required 内置一律禁用普通停用
    for (const id of productRequiredIds) {
      const disableButton = screen.queryByRole('button', { name: `停用 ${id}` })
      if (disableButton) expect(disableButton).toBeDisabled()
    }
    expect(screen.getByRole('button', { name: '停用 builtin.pylon-shell' })).toBeDisabled()
  })

  it('shows degraded bootstrap failures and delegates explicit retry to the Kernel supervisor', async () => {
    const failure = {
      pluginId: 'builtin.pylon-shell',
      stage: 'activate' as const,
      code: 'plugin_activation_failed',
      message: 'shell entry rejected',
      retryable: true,
    }
    const retryPlugin = vi.fn(async () => undefined)
    const snapshot = {
      kind: 'degraded' as const,
      activePluginIds: [],
      failures: [failure],
      skippedPluginIds: [],
    }
    const bootstrap: KernelBootstrap = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      startNormal: vi.fn(async () => undefined),
      startSafeMode: vi.fn(async () => undefined),
      retryPlugin,
    }

    render(() => <PluginManager
      service={fakeService() as unknown as PackageInstallationService}
      bootstrap={bootstrap}
    />)

    expect(screen.getByText(/shell entry rejected/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试 builtin.pylon-shell' }))
    expect(retryPlugin).toHaveBeenCalledWith('builtin.pylon-shell')
  })

  it('routes builtin enable through the Kernel dependency-closure retry action', async () => {
    const retryPlugin = vi.fn(async () => undefined)
    const snapshot = {
      kind: 'safe-mode' as const,
      skippedPluginIds: ['builtin.skin'],
    }
    const bootstrap: KernelBootstrap = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      startNormal: vi.fn(async () => undefined),
      startSafeMode: vi.fn(async () => undefined),
      retryPlugin,
    }
    await bootstrapBuiltins('safe-mode')

    render(() => <PluginManager
      service={fakeService() as unknown as PackageInstallationService}
      bootstrap={bootstrap}
    />)
    fireEvent.click(screen.getByRole('button', { name: '启用 builtin.skin' }))

    expect(await screen.findByText('启用 builtin.skin成功')).toBeInTheDocument()
    expect(retryPlugin).toHaveBeenCalledWith('builtin.skin')
  })

  it('distinguishes an enabled package waiting for an activation event', async () => {
    const service = fakeService([installedPackage()])
    service.getContractSnapshot.mockReturnValue({
      revision: 1,
      eligibleIds: [],
      diagnostics: [{
        pluginId: 'feature.demo',
        code: 'waiting_activation',
        message: '等待激活事件：workspace.opened',
        blocking: false,
        relatedPluginIds: [],
      }],
    })

    render(() => <PluginManager service={service as unknown as PackageInstallationService} />)

    expect(await screen.findByText('等待激活事件')).toBeInTheDocument()
    expect(screen.getByText('等待激活事件：workspace.opened')).toBeInTheDocument()
  })

  it('shows cleanup residuals and retries the failed runtime instance', async () => {
    const runtime = getPluginRuntime()
    let cleanupAttempts = 0
    const instance = await runtime.activateBuiltin({
      id: 'feature.cleanup-ui',
      activate: ({ scope }) => {
        scope.add(() => {
          cleanupAttempts += 1
          if (cleanupAttempts === 1) throw new Error('resource is busy')
        }, { resourceId: 'locked-resource' })
      },
    })
    await runtime.deactivate(instance.identity.key)
    const original = installedPackage()
    const item: InstalledPluginPackage = {
      ...original,
      package: {
        ...original.package,
        pluginId: 'feature.cleanup-ui',
        manifest: { ...original.package.manifest, id: 'feature.cleanup-ui' },
      },
    }

    render(() => <PluginManager service={fakeService([item]) as unknown as PackageInstallationService} />)

    expect(await screen.findByText('清理失败')).toBeInTheDocument()
    expect(screen.getByText(/locked-resource: resource is busy/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试清理 feature.cleanup-ui' }))
    expect(await screen.findByText('重试清理 feature.cleanup-ui成功')).toBeInTheDocument()
    expect(runtime.snapshot().instances.some(value => value.identity.key === instance.identity.key)).toBe(false)
  })

  // P53 D2：授权卡（capability-consent 失败 → 批准/拒绝 → grant store）
  it('renders the capability consent card for capability-consent bootstrap failures and grants on approval', async () => {
    const { getPluginCapabilityGrantStore, resetPluginCapabilityGrantStoreForTests } = await import(
      '../../../plugin-runtime/management/pluginManagementWiring.ts'
    )
    resetPluginCapabilityGrantStoreForTests()
    const failure = {
      pluginId: 'builtin.pylon-plugin-manager',
      stage: 'capability-consent' as const,
      code: 'plugin_capability_denied',
      message: '等待能力授权：plugin.management',
      retryable: true,
      pluginVersion: '1.0.0',
      capabilities: ['plugin.management'],
    }
    const retryPlugin = vi.fn(async () => undefined)
    // 快照订阅要求 getSnapshot 引用稳定：缓存快照对象，避免订阅循环
    const bootstrapSnapshot = {
      kind: 'degraded' as const,
      activePluginIds: [] as readonly string[],
      failures: [failure],
      skippedPluginIds: [] as readonly string[],
    }
    const bootstrap: KernelBootstrap = {
      getSnapshot: () => bootstrapSnapshot,
      subscribe: () => () => undefined,
      startNormal: vi.fn(async () => undefined),
      startSafeMode: vi.fn(async () => undefined),
      retryPlugin,
    }

    render(() => <PluginManager
      service={fakeService() as unknown as PackageInstallationService}
      bootstrap={bootstrap}
    />)

    expect(screen.getByText('能力授权')).toBeInTheDocument()
    expect(screen.getAllByText(/等待能力授权：plugin\.management/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '批准 builtin.pylon-plugin-manager 的 plugin.management 能力' }))
    await screen.findByText('已授权')
    expect(getPluginCapabilityGrantStore().getGrant('builtin.pylon-plugin-manager', 'plugin.management', '1.0.0'))
      .toEqual(expect.objectContaining({ pluginVersion: '1.0.0', apiVersion: '1.2' }))
    expect(retryPlugin).toHaveBeenCalledWith('builtin.pylon-plugin-manager')
    resetPluginCapabilityGrantStoreForTests()
  })


  // P53 默认页切换：宿主"插件管理"分区在管理器贡献存在时渲染包页面
  //（renderSection 分支）——入口按钮已随默认页化移除，该行为由 Settings
  // 域测试与浏览器反馈环覆盖。
})
