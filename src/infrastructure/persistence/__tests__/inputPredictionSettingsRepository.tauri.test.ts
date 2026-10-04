/**
 * #448 PR2 inputPredictionSettingsRepository 测试——Tauri 模式（后端权威源）：
 * - hydrate：后端有值 → 缓存镜像；后端无值 + 旧 key 在场 → 一次性迁移（写穿）
 * - 迁移写穿失败 → 旧 key 保留（幂等重试）、缓存先行
 * - 后端不可用 → localStorage 值兜底（等价旧行为）且不抛（不降级启动）
 * - persist：缓存立即更新 + 链式盲写 user_data_save（expectedRevision=null）+
 *   影子先行（#463：legacy key 保留作恢复日志）
 * - #463 前端 C-1：未同步标志（写穿失败置位）→ 对账影子赢 + 整份重发自愈
 * - browser 模式：hydrate no-op；persist 写 localStorage
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

import {
  hydrateInputPredictionSettingsFromBackend,
  persistInputPredictionSettings,
} from '../inputPredictionSettingsRepository'
import {
  cachedInputPredictionSettings,
  updateCachedInputPredictionSettings,
} from '../../../domains/inputPrediction/inputPredictionSettingsCache'
import { DEFAULT_INPUT_PREDICTION_SETTINGS, INPUT_PREDICTION_SETTINGS_KEY } from '../../../domains/inputPrediction/inputPredictionSettings'

let fakeInvoke: FakeInvoke

const UNSYNCED_FLAG_KEY = 'pylon-input-prediction-unsynced'

const LEGACY_VALUE = { ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'standalone' as const, enabled: true, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-legacy', model: 'test-model' }

function seedLegacyKey(): void {
  globalThis.localStorage.setItem(INPUT_PREDICTION_SETTINGS_KEY, JSON.stringify(LEGACY_VALUE))
}

beforeEach(() => {
  fakeInvoke = new FakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  updateCachedInputPredictionSettings(null)
  globalThis.localStorage.clear()
})

describe('Tauri 模式（IS_TAURI=true）', () => {
  it('hydrate：后端有值 → normalize 入缓存（同步读面立即可见）', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1,
      revision: 2,
      payload: { version: 1, mode: 'fork', enabled: true, apiKey: 'sk-backend' },
    }))
    await hydrateInputPredictionSettingsFromBackend()
    expect(cachedInputPredictionSettings().mode).toBe('fork')
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-backend')
  })

  it('hydrate：后端无值 + 旧 key 在场 → 写穿后端（#463 起旧 key 保留转影子）', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    seedLegacyKey()
    await hydrateInputPredictionSettingsFromBackend()
    // 写穿 payload 自带 envelope version
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'user_data_save',
      args: {
        key: 'input-prediction',
        payload: expect.objectContaining({ version: 1, apiKey: 'sk-legacy', mode: 'standalone' }),
        expectedRevision: null,
      },
    })
    // #463：迁移成功后旧 key 保留（影子日志），写穿成功清未同步标志
    expect(globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)).not.toBeNull()
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-legacy')
  })

  it('hydrate：后端无值 + 旧 key 缺席 → 默认入缓存，不写后端', async () => {
    fakeInvoke.register('user_data_load', () => null)
    await hydrateInputPredictionSettingsFromBackend()
    expect(cachedInputPredictionSettings()).toEqual(DEFAULT_INPUT_PREDICTION_SETTINGS)
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
  })

  it('hydrate：迁移写穿失败 → 旧 key 保留（下次幂等重试），缓存先行', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => { throw new Error('user_data_unavailable') })
    seedLegacyKey()
    await expect(hydrateInputPredictionSettingsFromBackend()).resolves.toBeUndefined()
    expect(globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)).not.toBeNull()
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-legacy')
  })

  it('hydrate：后端不可用 → localStorage 值兜底入缓存且不抛（启动不降级）', async () => {
    fakeInvoke.register('user_data_load', () => { throw new Error('backend down') })
    seedLegacyKey()
    await expect(hydrateInputPredictionSettingsFromBackend()).resolves.toBeUndefined()
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-legacy')
  })

  it('persist：缓存立即更新 + 链式盲写 user_data_save（latest-wins）+ 影子先行', async () => {
    fakeInvoke.register('user_data_save', () => ({ revision: 3 }))
    const next = { ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'off' as const }
    persistInputPredictionSettings(next)
    // 缓存同步生效（保存路径 fire-and-forget 不阻塞 UI）
    expect(cachedInputPredictionSettings().mode).toBe('off')
    await flushTask()
    expect(fakeInvoke.calls).toContainEqual({
      cmd: 'user_data_save',
      args: { key: 'input-prediction', payload: expect.objectContaining({ version: 1, mode: 'off' }), expectedRevision: null },
    })
    // #463：Tauri 模式写影子日志（恢复源；权威仍是后端）
    const shadow = globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)
    expect(shadow).not.toBeNull()
    expect(JSON.parse(shadow!)).toMatchObject({ mode: 'off' })
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
  })

  it('persist：后端写穿失败 → 缓存不回滚 + 未同步标志置位（影子可证较新）', async () => {
    fakeInvoke.register('user_data_save', () => { throw new Error('db busy') })
    persistInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, apiKey: 'sk-keep' })
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-keep')
    await flushTask()
    expect(cachedInputPredictionSettings().apiKey).toBe('sk-keep')
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBe('1')
    expect(cachedInputPredictionSettings()).toMatchObject({ apiKey: 'sk-keep' })
  })

  it('persist：后端写穿失败且影子写不进（quota）→ 仍置标志（审查轮修正：宁可多置待自愈）', async () => {
    const setItem = globalThis.localStorage.setItem.bind(globalThis.localStorage)
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === INPUT_PREDICTION_SETTINGS_KEY) throw new DOMException('quota', 'QuotaExceededError')
      setItem(key, value)
    })
    fakeInvoke.register('user_data_save', () => { throw new Error('db busy') })
    persistInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, apiKey: 'sk-unrecoverable' })
    await flushTask()
    expect(globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)).toBeNull()
    // 失败一律置位：若影子恰与后端一致属 no-op 失败多置，hydrate 等值检查自愈清除
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBe('1')
    vi.restoreAllMocks()
  })
})

describe('#463 前端 C-1：未同步标志对账', () => {
  it('标志在场且影子异于后端 → 影子赢入缓存并整份重发，成功清标志', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 2, payload: { version: 1, mode: 'fork', enabled: true },
    }))
    fakeInvoke.register('user_data_save', () => ({ revision: 3 }))
    const lost = { ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'off' as const, apiKey: 'sk-lost' }
    globalThis.localStorage.setItem(INPUT_PREDICTION_SETTINGS_KEY, JSON.stringify(lost))
    globalThis.localStorage.setItem(UNSYNCED_FLAG_KEY, '1')
    await hydrateInputPredictionSettingsFromBackend()
    // 影子赢：写穿失败会话里的较新值恢复
    expect(cachedInputPredictionSettings()).toMatchObject({ mode: 'off', apiKey: 'sk-lost' })
    const save = fakeInvoke.calls.find(call => call.cmd === 'user_data_save')
    expect(save).toBeDefined()
    expect((save!.args as { payload: { mode: string } }).payload.mode).toBe('off')
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
  })

  it('标志在场但影子缺席 → 后端赢并清标志（无恢复源宁信后端）', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 2, payload: { version: 1, mode: 'fork', enabled: true },
    }))
    globalThis.localStorage.setItem(UNSYNCED_FLAG_KEY, '1')
    await hydrateInputPredictionSettingsFromBackend()
    expect(cachedInputPredictionSettings().mode).toBe('fork')
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
  })

  it('标志在场但影子与后端一致 → 后端赢并清标志（失败的是 no-op 保存）', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 2, payload: { version: 1, mode: 'fork', enabled: true },
    }))
    globalThis.localStorage.setItem(INPUT_PREDICTION_SETTINGS_KEY, JSON.stringify({ version: 1, mode: 'fork', enabled: true }))
    globalThis.localStorage.setItem(UNSYNCED_FLAG_KEY, '1')
    await hydrateInputPredictionSettingsFromBackend()
    expect(cachedInputPredictionSettings().mode).toBe('fork')
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
  })

  it('后端赢时影子对齐权威值（下次写穿失败才作恢复源）', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 2, payload: { version: 1, mode: 'fork', enabled: true, apiKey: 'sk-backend' },
    }))
    await hydrateInputPredictionSettingsFromBackend()
    const shadow = globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)
    expect(shadow).not.toBeNull()
    expect(JSON.parse(shadow!)).toMatchObject({ mode: 'fork', apiKey: 'sk-backend' })
  })

  it('影子赢重发失败 → 可见上报、缓存保留影子、标志保留', async () => {
    const { reportRuntimeError } = await import('../../../app/runtimeError.ts')
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 2, payload: { version: 1, mode: 'fork', enabled: true },
    }))
    fakeInvoke.register('user_data_save', () => { throw new Error('user_data_unavailable') })
    const lost = { ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'off' as const, apiKey: 'sk-lost' }
    globalThis.localStorage.setItem(INPUT_PREDICTION_SETTINGS_KEY, JSON.stringify(lost))
    globalThis.localStorage.setItem(UNSYNCED_FLAG_KEY, '1')
    await expect(hydrateInputPredictionSettingsFromBackend()).resolves.toBeUndefined()
    expect(cachedInputPredictionSettings()).toMatchObject({ mode: 'off', apiKey: 'sk-lost' })
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBe('1')
    expect(reportRuntimeError).toHaveBeenCalled()
  })

  it('标志在场但影子损坏 → 后端赢并清标志（不恢复垃圾）', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 2, payload: { version: 1, mode: 'fork', enabled: true },
    }))
    globalThis.localStorage.setItem(INPUT_PREDICTION_SETTINGS_KEY, '{broken json')
    globalThis.localStorage.setItem(UNSYNCED_FLAG_KEY, '1')
    await hydrateInputPredictionSettingsFromBackend()
    expect(cachedInputPredictionSettings().mode).toBe('fork')
    expect(fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')).toHaveLength(0)
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
  })

  it('审查轮收口：迁移写穿入链——标志在场时迁移成功清标志', async () => {
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    seedLegacyKey()
    globalThis.localStorage.setItem(UNSYNCED_FLAG_KEY, '1')
    await hydrateInputPredictionSettingsFromBackend()
    expect(fakeInvoke.calls.some(call => call.cmd === 'user_data_save')).toBe(true)
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
  })

  it('审查轮收口：影子赢重发在飞期间的用户保存入链串行，最终落库为较新的用户值', async () => {
    fakeInvoke.register('user_data_load', () => ({
      version: 1, revision: 2, payload: { version: 1, mode: 'fork', enabled: true },
    }))
    // 完成计数：handler 在延迟窗结束后才执行——「派发数==完成数」才是链排干的真终态
    // （calls 在派发时即记录，链长配合标志判据存在 save#1 完成与 save#2 完成间的瞬态真窗，#545）
    const completedSaves: unknown[] = []
    fakeInvoke.register('user_data_save', args => {
      completedSaves.push(args)
      return { revision: 9 }
    })
    fakeInvoke.setDelay('user_data_save', 10)
    const lost = { ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'off' as const, apiKey: 'sk-lost' }
    globalThis.localStorage.setItem(INPUT_PREDICTION_SETTINGS_KEY, JSON.stringify(lost))
    globalThis.localStorage.setItem(UNSYNCED_FLAG_KEY, '1')
    const hydrating = hydrateInputPredictionSettingsFromBackend()
    // 重发已入飞（10ms 延迟窗口），此刻用户保存较新值 → 排到链上重发之后
    await flushTask()
    expect(fakeInvoke.calls.some(call => call.cmd === 'user_data_save')).toBe(true)
    persistInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'fork' as const, apiKey: 'sk-new' })
    await hydrating
    // 排干链上重发之后的桥链接：条件等待，且以「未同步标志已清」为终态——
    // 链尾最后一次保存成功才会清标志，仅等链长会把尾部副作用泄漏进下一用例（#545）
    const saves = await vi.waitFor(() => {
      const chain = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
      expect(chain.length).toBeGreaterThanOrEqual(2)
      expect(completedSaves).toHaveLength(chain.length)
      expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
      return chain
    })
    expect((saves[0]!.args as { payload: { apiKey: string } }).payload.apiKey).toBe('sk-lost')
    expect((saves.at(-1)!.args as { payload: { apiKey: string } }).payload.apiKey).toBe('sk-new')
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBeNull()
  })

  it('审查轮修正：影子写失败的后续保存不清先前合法置位的标志（恢复源保留）', async () => {
    fakeInvoke.register('user_data_save', () => { throw new Error('backend down') })
    // 第一次保存：影子写成功、后端失败 → 标志置位（shadow=V1 可证较新）
    persistInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'off' as const, apiKey: 'sk-v1' })
    await flushTask()
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBe('1')
    // 第二次保存：影子写失败（quota）、后端也失败 → 标志必须保持（V1 仍是恢复源）
    const setItem = globalThis.localStorage.setItem.bind(globalThis.localStorage)
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === INPUT_PREDICTION_SETTINGS_KEY) throw new DOMException('quota', 'QuotaExceededError')
      setItem(key, value)
    })
    persistInputPredictionSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, mode: 'fork' as const, apiKey: 'sk-v2' })
    await flushTask()
    vi.restoreAllMocks()
    expect(globalThis.localStorage.getItem(UNSYNCED_FLAG_KEY)).toBe('1')
    expect(JSON.parse(globalThis.localStorage.getItem(INPUT_PREDICTION_SETTINGS_KEY)!)).toMatchObject({ mode: 'off' })
  })
})
