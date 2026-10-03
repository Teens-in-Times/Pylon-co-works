/**
 * #448 PR5 customPresetRepository 测试——Tauri 后端权威接线：
 * - hydrate：后端有值且异于本地 → 以后端为准 setState（不回写）
 * - hydrate：后端无值 + 本地非空 → 一次性写穿（含旧 pylon-theme 搬家产物）
 * - 写穿桥：hydrate 后本地变更 → 盲写 user_data_save；对账落地不回写（guard）
 * - 后端不可用 → 吞错（不阻断启动）
 * - #463 前端 C-1：未同步标志（写穿失败置位）→ 对账本地赢 + 整份重发自愈
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { flushTask } from '../../../test/solidTestHelpers.ts'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('../../tauri/env', () => ({ IS_TAURI: true }))
vi.mock('../../../app/runtimeError.ts', () => ({
  reportRuntimeError: vi.fn(() => ({})),
  resolveRuntimeErrors: vi.fn(),
}))

const PRESET_A = { id: 'custom-a', name: 'A', theme: { chatFontSize: 14 }, createdAt: 1, updatedAt: 1 }
const PRESET_B = { id: 'custom-b', name: 'B', theme: { chatFontSize: 18 }, createdAt: 2, updatedAt: 2 }

// vi.resetModules 后 repository 与 store 必须同图取用（静态 import 会停留在
// reset 前的旧实例上，对账 setState 打到旧 store）——每用例动态 import。
async function load() {
  const { hydrateCustomPresetsFromBackend } = await import('../customPresetRepository')
  const { useCustomPresetStore } = await import('../../../domains/theme/customPresetStore.ts')
  return { hydrateCustomPresetsFromBackend, useCustomPresetStore }
}

let fakeInvoke: FakeInvoke

beforeEach(() => {
  vi.resetModules()
  fakeInvoke = new FakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  localStorage.clear()
})

describe('Tauri 模式（IS_TAURI=true）', () => {
  it('hydrate：后端有值且异于本地 → 以后端为准 setState，不回写', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 4, payload: { version: 1, customPresets: [PRESET_B], zonePresetEntries: [] },
    }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend()
    expect(useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-b'])
    // 对账落地不触发写穿（唯一一次 save 都不应出现）
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
  })

  it('hydrate：后端无值 + 本地非空 → 一次性写穿（envelope 形状带 version）', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend()
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'user_data_save',
      args: {
        key: 'custom-presets',
        payload: expect.objectContaining({ version: 1, customPresets: [PRESET_A] }),
        expectedRevision: null,
      },
    })
  })

  it('hydrate：后端无值 + 本地空 → 不写后端', async () => {
    fakeInvoke.register('user_data_load', () => null)
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend()
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
  })

  it('写穿桥：hydrate 后本地删除 → 盲写最新切片（latest-wins）', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend()
    // 桥已装：本地变更写穿
    fakeInvoke.calls.length = 0
    useCustomPresetStore.getState().removeCustomPreset('custom-a')
    await flushTask()
    const saveCalls = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saveCalls.length).toBeGreaterThanOrEqual(1)
    const last = saveCalls.at(-1)!
    expect((last.args as { payload: { customPresets: unknown[] } }).payload.customPresets).toHaveLength(0)
  })

  it('hydrate：后端不可用 → 吞错不抛（启动不降级）', async () => {
    fakeInvoke.register('user_data_load', () => { throw new Error('user_data_unavailable') })
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await expect(hydrateCustomPresetsFromBackend()).resolves.toBeUndefined()
    expect(useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-a'])
  })
})

describe('#463 前端 C-1：未同步标志对账', () => {
  const FLAG_KEY = 'pylon-custom-presets-unsynced'

  it('标志在场且本地非空 → 本地赢（后端值不落地）并整份重发后端，成功清标志', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 4, payload: { version: 1, customPresets: [PRESET_B], zonePresetEntries: [] },
    }))
    fakeInvoke.register('user_data_save', () => ({ revision: 5 }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    localStorage.setItem(FLAG_KEY, '1')
    await hydrateCustomPresetsFromBackend()
    // 本地赢：写穿失败会话里的新预设保留，后端旧值不落地
    expect(useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-a'])
    // 整份重发本地切片（跨会话自愈）
    const save = fakeInvoke.calls.find(call => call.cmd === 'user_data_save')
    expect(save).toBeDefined()
    expect((save!.args as { payload: { customPresets: unknown[] } }).payload.customPresets).toEqual([PRESET_A])
    // 成功 → 标志清除
    expect(localStorage.getItem(FLAG_KEY)).toBeNull()
  })

  it('标志在场但本地空 → 后端赢（宁复活不销毁）', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 4, payload: { version: 1, customPresets: [PRESET_B], zonePresetEntries: [] },
    }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [], zonePresetEntries: [] })
    localStorage.setItem(FLAG_KEY, '1')
    await hydrateCustomPresetsFromBackend()
    expect(useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-b'])
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
    expect(localStorage.getItem(FLAG_KEY)).toBeNull()
  })

  it('本地赢重发失败 → 可见上报、本地保留、标志保留（下次启动继续本地赢）', async () => {
    const { reportRuntimeError } = await import('../../../app/runtimeError.ts')
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 4, payload: { version: 1, customPresets: [PRESET_B], zonePresetEntries: [] },
    }))
    fakeInvoke.register('user_data_save', () => { throw new Error('user_data_unavailable') })
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    localStorage.setItem(FLAG_KEY, '1')
    await expect(hydrateCustomPresetsFromBackend()).resolves.toBeUndefined()
    expect(useCustomPresetStore.getState().customPresets.map(p => p.id)).toEqual(['custom-a'])
    expect(localStorage.getItem(FLAG_KEY)).toBe('1')
    expect(reportRuntimeError).toHaveBeenCalled()
  })

  it('写穿桥：保存失败置标志，后续成功清标志', async () => {
    fakeInvoke.register('user_data_load', () => null)
    let fail = true
    fakeInvoke.register('user_data_save', () => {
      if (fail) throw new Error('backend down')
      return { revision: 1 }
    })
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [], zonePresetEntries: [] })
    await hydrateCustomPresetsFromBackend() // 本地空：迁移腿不触发 save，仅装桥
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    await flushTask()
    expect(localStorage.getItem(FLAG_KEY)).toBe('1')
    fail = false
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never, PRESET_B as never], zonePresetEntries: [] })
    await flushTask()
    expect(localStorage.getItem(FLAG_KEY)).toBeNull()
  })

  it('标志在场但本地与后端已一致 → 清标志不重发（no-op 失败的自愈）', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 4, payload: { version: 1, customPresets: [PRESET_A], zonePresetEntries: [] },
    }))
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    localStorage.setItem(FLAG_KEY, '1')
    await hydrateCustomPresetsFromBackend()
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
    expect(localStorage.getItem(FLAG_KEY)).toBeNull()
  })

  it('审查轮收口：重发在飞期间的用户变更经桥入链，最终落库为最新切片', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 4, payload: { version: 1, customPresets: [PRESET_B], zonePresetEntries: [] },
    }))
    fakeInvoke.register('user_data_save', () => ({ revision: 5 }))
    fakeInvoke.setDelay('user_data_save', 10)
    const { hydrateCustomPresetsFromBackend, useCustomPresetStore } = await load()
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never], zonePresetEntries: [] })
    localStorage.setItem(FLAG_KEY, '1')
    const hydrating = hydrateCustomPresetsFromBackend()
    // 重发已入飞（10ms 延迟窗口），此刻用户改本地 → 桥把新变更排到链上
    await flushTask()
    expect(fakeInvoke.calls.some(call => call.cmd === 'user_data_save')).toBe(true)
    useCustomPresetStore.setState({ customPresets: [PRESET_A as never, PRESET_B as never], zonePresetEntries: [] })
    await hydrating
    // 排干链上重发之后的桥链接
    await new Promise(resolve => globalThis.setTimeout(resolve, 30))
    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves.length).toBeGreaterThanOrEqual(2)
    const last = saves.at(-1)!.args as { payload: { customPresets: { id: string }[] } }
    expect(last.payload.customPresets.map(preset => preset.id)).toEqual(['custom-a', 'custom-b'])
    expect(localStorage.getItem(FLAG_KEY)).toBeNull()
  })
})
