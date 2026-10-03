import { describe, expect, it } from 'vitest'
import {
  EMPTY_PERSISTED_SHEET_STATE,
  loadSheetStateV2,
  parseSheetStateV1,
  serializeSheetStateV1,
  type PersistedSheetState,
} from '../src/domains/workspace/sheetPersistence.ts'
import { useLegacyCompatRuntime } from './legacyCompatHarness.mts'

// W1-01：v1 parser 保留为迁移源（细化路线 §4 步骤 1），本 describe 锁定 v1 normalize/roundtrip 输出
// （P91 A1/A5：原 scripts/test-sheet-persistence.mts 顶层断言转正为 expect()，原脚本已退役。）
describe('F0.2 Sheet 持久化 v1 迁移源（compat 转正）', () => {
  useLegacyCompatRuntime()

  class MemoryStorage {
    private values = new Map<string, string>()
    getItem(key: string): string | null { return this.values.get(key) ?? null }
    setItem(key: string, value: string): void { this.values.set(key, value) }
    removeItem(key: string): void { this.values.delete(key) }
  }

  const state: PersistedSheetState = {
    sheets: [
      {
        id: 'agent-a',
        kind: 'agent',
        title: 'Profile A',
        agentId: 'profile-a',
        singletonKey: 'agent:profile-a',
        pinned: true,
        createdAt: 10,
        lastFocusedAt: 20,
      },
      {
        id: 'file-a',
        kind: 'file',
        title: 'App.tsx',
        singletonKey: 'file:App.tsx',
        createdAt: 11,
        lastFocusedAt: 21,
        metadata: { path: 'src/App.tsx' },
      },
    ],
    activeSheetId: 'file-a',
    recentlyClosed: [],
    agentStates: {
      'profile-a': { activeProfileId: 'default', activeSessionId: 'session-a' },
      obsolete: { activeSessionId: 'must-drop' },
    },
  }

  it('v1 serialize/parse roundtrip 与 agentStates 按 allowlist 过滤、损坏样本', () => {
    const serialized = serializeSheetStateV1(state)
    expect(JSON.parse(serialized).version).toBe(1)
    expect(parseSheetStateV1(serialized, ['profile-a'])).toEqual({
      ...state,
      agentStates: { 'profile-a': state.agentStates['profile-a'] },
    })
    expect(parseSheetStateV1(serialized, ['profile-a']).sheets.find(sheet => sheet.id === 'agent-a')?.pinned).toBe(true)
    expect(parseSheetStateV1(serialized, ['other']).sheets.map(sheet => sheet.agentId)).toEqual([undefined])
    expect(parseSheetStateV1(serialized, ['profile-a']).agentStates).toEqual({ 'profile-a': state.agentStates['profile-a'] })
    expect(parseSheetStateV1(JSON.stringify({ version: 999, state }))).toEqual(EMPTY_PERSISTED_SHEET_STATE)
    expect(parseSheetStateV1('{not-json')).toEqual(EMPTY_PERSISTED_SHEET_STATE)
  })

  it('重复 id 去重', () => {
    const duplicate = {
      ...state,
      sheets: [state.sheets[0], { ...state.sheets[0], id: 'agent-duplicate' }],
      activeSheetId: 'agent-duplicate',
    }
    expect(parseSheetStateV1(serializeSheetStateV1(duplicate)).sheets.length).toBe(1)
  })

  it('v1 存储经 loadSheetStateV2 迁移：migrated=true（#538 起布局不随信封迁移）', () => {
    const serialized = serializeSheetStateV1(state)
    const storage = new MemoryStorage()
    storage.setItem('pylon-workspace-sheets', serialized)
    const migrated = loadSheetStateV2(storage, ['profile-a'])
    expect(migrated.migrated, 'v1 输入必须标记 migrated').toBe(true)
    expect(migrated.state).toEqual({ ...state, agentStates: { 'profile-a': state.agentStates['profile-a'] } })
    expect(migrated, '#538：hydrate 结果不含 layout（真源在 layoutRailsStore 的 legacy 快照播种）').not.toHaveProperty('layout')
  })
})
