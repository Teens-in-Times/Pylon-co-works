import { describe, expect, it } from 'vitest'
import { createSolidStoreKernel, type SolidStoreKernel } from '../../../infrastructure/state/solidStoreKernel'
import { attachApprovalModePersistence } from '../runtimeStore'
import { APPROVAL_MODE_STORAGE_KEY, type ApprovalMode } from '../../permission/approvalMode'

/**
 * #520 S2-P1：approvalMode 持久化收进 store 侧（原 App.solid 启动读一次手写键、
 * browser 模式不恢复）。attachApprovalModePersistence 契约：
 * - seed：存量 `pylon-approval-mode` 裸枚举字符串原地恢复（键名/值格式逐字兼容，老数据不丢）；
 * - mirror：值变化才写回，格式仍是裸枚举字符串（非 persist 信封）；
 * - 非法存量值不 seed，保持 default。
 *
 * 用注入 kernel + 注入 storage 的最小形态测试，不触碰全局 localStorage。
 */

function makeKernel(initial: ApprovalMode = 'default'): SolidStoreKernel<{ approvalMode: ApprovalMode }> {
  return createSolidStoreKernel<{ approvalMode: ApprovalMode }>({ approvalMode: initial })
}

function makeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  let writes = 0
  return {
    values,
    writeCount: () => writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { writes += 1; values.set(key, value) },
  }
}

describe('attachApprovalModePersistence（#520 S2-P1 store 侧持久化收口）', () => {
  it('存量裸字符串键原地 seed（老用户数据兼容，不迁移不改写）', () => {
    const storage = makeStorage({ [APPROVAL_MODE_STORAGE_KEY]: 'bypass' })
    const kernel = makeKernel()
    attachApprovalModePersistence(kernel, storage)
    expect(kernel.getState().approvalMode).toBe('bypass')
    // seed 是读取不是写回：存量值原样保留、零写入
    expect(storage.writeCount()).toBe(0)
    expect(storage.values.get(APPROVAL_MODE_STORAGE_KEY)).toBe('bypass')
  })

  it('无存量值时保持 default，不产生任何写', () => {
    const storage = makeStorage()
    const kernel = makeKernel()
    attachApprovalModePersistence(kernel, storage)
    expect(kernel.getState().approvalMode).toBe('default')
    expect(storage.writeCount()).toBe(0)
  })

  it('值变化镜像写回，格式保持裸枚举字符串（非 persist 信封）', () => {
    const storage = makeStorage()
    const kernel = makeKernel()
    attachApprovalModePersistence(kernel, storage)
    kernel.setState({ approvalMode: 'edit' })
    expect(storage.values.get(APPROVAL_MODE_STORAGE_KEY)).toBe('edit')
    expect(storage.values.get(APPROVAL_MODE_STORAGE_KEY)).not.toContain('state')
  })

  it('同值重复 set 不重复写（值级守卫，runtimeStore 高频写入不放大 IO）', () => {
    const storage = makeStorage()
    const kernel = makeKernel()
    attachApprovalModePersistence(kernel, storage)
    kernel.setState({ approvalMode: 'auto' })
    kernel.setState({ approvalMode: 'auto' })
    kernel.setState({ approvalMode: 'edit' })
    kernel.setState({ approvalMode: 'edit' })
    expect(storage.writeCount()).toBe(2)
    expect(storage.values.get(APPROVAL_MODE_STORAGE_KEY)).toBe('edit')
  })

  it('resetSessionRuntime 式的回落 default 同样被镜像（缓存 = 最近显示值）', () => {
    const storage = makeStorage({ [APPROVAL_MODE_STORAGE_KEY]: 'bypass' })
    const kernel = makeKernel()
    attachApprovalModePersistence(kernel, storage)
    kernel.setState({ approvalMode: 'default' })
    expect(storage.values.get(APPROVAL_MODE_STORAGE_KEY)).toBe('default')
  })

  it('非法存量值不 seed（保持 default），后续合法写入照常镜像', () => {
    const storage = makeStorage({ [APPROVAL_MODE_STORAGE_KEY]: 'plan' })
    const kernel = makeKernel()
    attachApprovalModePersistence(kernel, storage)
    expect(kernel.getState().approvalMode).toBe('default')
    kernel.setState({ approvalMode: 'bypass' })
    expect(storage.values.get(APPROVAL_MODE_STORAGE_KEY)).toBe('bypass')
  })
})
