import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_PERSISTED_SHEET_STATE,
  SHEET_SCHEMA_VERSION,
  SHEET_STORAGE_KEY,
  parseSheetStateV2,
  persistSheetStateV2,
  serializeSheetStateV2,
  type PersistedSheetState,
} from '../src/domains/workspace/sheetPersistence.ts'
import { useLegacyCompatRuntime } from './legacyCompatHarness.mts'

useLegacyCompatRuntime()

// W1-01：schema v2——v1 清洗旧 kind、只输出 v2、损坏样本、showPet 反携带钉。
// #538：布局真源收敛为 layoutRailsStore（pylon-workspace-layout-v3），信封不再
// 读写 layout 键——旧信封的 layout 残留被静默忽略（防踩回，见用例 4）。

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const state: PersistedSheetState = {
  sheets: [{ id: 'agent-a', kind: 'agent', title: 'Profile A', agentId: 'profile-a', createdAt: 1, lastFocusedAt: 2 }],
  activeSheetId: 'agent-a',
  recentlyClosed: [],
  agentStates: {},
}

function loadSheetStateV2Safe(storage: MemoryStorage) {
  const raw = storage.getItem(SHEET_STORAGE_KEY)
  return parseSheetStateV2(raw)
}

describe('sheet persistence v2 legacy compat', () => {
  // 1. v2 roundtrip：state 往返一致（信封不携带布局）
  it('v2 roundtrip：state 往返一致、信封无 layout 键', () => {
    const serialized = serializeSheetStateV2(state)
    expect(JSON.parse(serialized).version).toBe(SHEET_SCHEMA_VERSION)
    expect(SHEET_SCHEMA_VERSION).toBe(2)
    const parsed = parseSheetStateV2(serialized)
    expect(parsed.migrated).toBe(false)
    expect(parsed.state).toEqual(state)
    expect(parsed, '#538：hydrate 结果不含 layout（真源在 layoutRailsStore）').not.toHaveProperty('layout')
  })

  // 2. 只输出 v2：serialize 不再生成 v1、不再写 layout
  it('只输出 v2：serialize 不再生成 v1 与 layout', () => {
    const serialized = serializeSheetStateV2(state)
    const envelope = JSON.parse(serialized) as { version: number; layout?: unknown }
    expect(envelope.version).toBe(2)
    expect(envelope.layout, '#538：v2 envelope 不含 layout').toBeUndefined()
  })

  // 3. v1→v2 迁移：旧 kind（diff/changes/git-history）清洗、migrated=true
  it('v1→v2 迁移：旧 kind 清洗、migrated=true', () => {
    const v1 = JSON.stringify({
      version: 1,
      state: {
        sheets: [
          { id: 'a', kind: 'agent', title: 'A', agentId: 'x', createdAt: 1, lastFocusedAt: 2 },
          { id: 'd', kind: 'diff', title: 'Diff', createdAt: 3, lastFocusedAt: 4 },
          { id: 'c', kind: 'changes', title: 'Changes', createdAt: 5, lastFocusedAt: 6 },
          { id: 'g', kind: 'git-history', title: 'Git History', createdAt: 7, lastFocusedAt: 8 },
        ],
        activeSheetId: 'a',
        recentlyClosed: [],
        agentStates: {},
      },
    })
    const result = parseSheetStateV2(v1)
    expect(result.migrated, 'v1 输入必须标记 migrated').toBe(true)
    expect(result.state.sheets.map(sheet => sheet.kind), '旧 kind 必须被清洗').toEqual(['agent'])
  })

  // 4. 旧信封 layout 残留：静默忽略（布局真源在 layoutRailsStore，不得被旧值踩回）
  it('旧信封 layout 残留被静默忽略', () => {
    const parsed = parseSheetStateV2(JSON.stringify({
      version: 2,
      state,
      layout: { sidebarWidth: 9999, sidebarCollapsed: 'yes', rightPanelCollapsed: true },
    }))
    expect(parsed.state).toEqual(state)
    expect(parsed, 'layout 残留不进结果').not.toHaveProperty('layout')
    const missing = parseSheetStateV2(JSON.stringify({ version: 2, state }))
    expect(missing.state).toEqual(state)
  })

  // 5. 损坏/未知版本样本
  it('损坏/未知版本样本：返回空状态不抛错', () => {
    expect(parseSheetStateV2(null)).toEqual({ state: EMPTY_PERSISTED_SHEET_STATE, migrated: false })
    expect(parseSheetStateV2('{not-json')).toEqual({ state: EMPTY_PERSISTED_SHEET_STATE, migrated: false })
    const unknown = parseSheetStateV2(JSON.stringify({ version: 99, state }))
    expect(unknown.state.sheets.length, '未知版本返回空状态').toBe(0)
  })

  // 6. 迁移写回路径：persistSheetStateV2 写盘后 loadSheetStateV2 读回 v2 一致
  it('迁移写回路径：persist 写盘后读回 v2 一致', () => {
    const storage = new MemoryStorage()
    persistSheetStateV2(storage, state)
    expect(storage.getItem(SHEET_STORAGE_KEY)).toBeTruthy()
    const loaded = loadSheetStateV2Safe(storage)
    expect(loaded.migrated).toBe(false)
    expect(loaded.state).toEqual(state)
  })

  // 7. showPet 曾随 A-V12 并入 layoutRailsStore（envelope v4）；#483 宠物链删除后字段退役，
  //    此处保留 envelope 侧断言：v2 envelope 持久化不携带 showPet（防死而复生）。
  it('sheet envelope 不携带 showPet（字段已随宠物链退役）', () => {
    const storage = new MemoryStorage()
    const serialized = serializeSheetStateV2(state)
    expect(serialized.includes("showPet")).toBe(false)
    expect(storage.getItem(SHEET_STORAGE_KEY)).toBeNull()
  })
})
