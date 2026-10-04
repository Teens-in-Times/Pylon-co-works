/**
 * FE-AUD-001 行为回归（阶段 0，先 RED）：Workspace Sheet action 持久化一致性。
 *
 * 目标行为：open/focus/pin/close/closeOthers/closeRight/reopen/metadata 任一
 * action 之后，`pylon-workspace-sheets` 的序列化内容必须与 store 内存 next state 一致。
 * 阶段 0 以 RED 锁定缺陷（持久化旧 state）；阶段 1（F07 commitWorkspaceMutation）后全绿。
 * #538 起信封不再承载 layout（布局真源在 layoutRailsStore），并锁定 hydrate 不回灌 rail。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { railPersistStorage, RAIL_PERSIST_KEY, useRightRailStore } from '../../domains/workspace/layoutRailsStore'
import { resetStores } from '../../test/resetStores'
import { MemoryStorage } from '../../test/memoryStorage'
import { SHEET_STORAGE_KEY, type PersistedSheetState } from '../../domains/workspace/sheetPersistence'
import type { SheetRecord } from '../sheetTypes'

const KEY = SHEET_STORAGE_KEY

interface PersistedEnvelope {
  version: number
  state: PersistedSheetState
}

function readPersisted(): PersistedEnvelope {
  const raw = localStorage.getItem(KEY)
  expect(raw).not.toBeNull()
  return JSON.parse(raw!) as PersistedEnvelope
}

function openAgentSheet(agentId = 'peri'): string {
  const id = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId, title: agentId })
  expect(id).not.toBeNull()
  return id!
}

function openToolSheet(kind: 'search' | 'history' | 'gateway', title: string): string {
  const id = useWorkspaceStore.getState().openSheet({ kind, title })
  expect(id).not.toBeNull()
  return id!
}

/** 内存 sheet 集合（含重开栈）与持久化集合的一致性断言 */
function expectPersistedMatchesMemory(): void {
  const memory = useWorkspaceStore.getState().workspaceSheets
  const persisted = readPersisted().state
  const ids = (sheets: readonly SheetRecord[]) => sheets.map(sheet => sheet.id).sort()
  expect(ids(persisted.sheets)).toEqual(ids(memory.sheets))
  expect(persisted.activeSheetId).toBe(memory.activeSheetId)
  expect(persisted.recentlyClosed.length).toBe(memory.recentlyClosed.length)
}

describe('FE-AUD-001 Workspace action 持久化一致性', () => {
  beforeEach(() => {
    resetStores()
    // 每个用例独立的干净 MemoryStorage（可注入故障，且不污染其他用例）
    Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true })
  })

  it('openSheet 后持久化与内存一致', () => {
    openAgentSheet()
    expectPersistedMatchesMemory()
  })

  it('连续 openSheet 后持久化与内存一致', () => {
    openAgentSheet('peri')
    openToolSheet('search', '搜索')
    openToolSheet('history', '历史')
    expectPersistedMatchesMemory()
  })

  it('focusSheet 后持久化 activeSheetId 与内存一致', () => {
    const a = openAgentSheet('peri')
    const b = openToolSheet('search', '搜索')
    useWorkspaceStore.getState().focusSheet(a)
    expect(useWorkspaceStore.getState().workspaceSheets.activeSheetId).toBe(a)
    expect(readPersisted().state.activeSheetId).toBe(a)
    useWorkspaceStore.getState().focusSheet(b)
    expect(useWorkspaceStore.getState().workspaceSheets.activeSheetId).toBe(b)
    expect(readPersisted().state.activeSheetId).toBe(b)
  })

  it('toggleSheetPin 后持久化 pin 与内存一致', () => {
    const id = openToolSheet('search', '搜索')
    useWorkspaceStore.getState().toggleSheetPin(id)
    const memory = useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === id)
    const persisted = readPersisted().state.sheets.find(sheet => sheet.id === id)
    expect(memory?.pinned).toBe(true)
    expect(persisted?.pinned).toBe(true)
  })

  it('closeSheet 后持久化与内存一致（不再含已关 sheet）', () => {
    openAgentSheet('peri')
    openToolSheet('search', '搜索')
    const closeTarget = openToolSheet('history', '历史')
    useWorkspaceStore.getState().closeSheet(closeTarget)
    const memory = useWorkspaceStore.getState().workspaceSheets
    expect(memory.sheets.some(sheet => sheet.id === closeTarget)).toBe(false)
    const persisted = readPersisted().state
    expect(persisted.sheets.some(sheet => sheet.id === closeTarget)).toBe(false)
    expect(persisted.sheets.length).toBe(memory.sheets.length)
  })

  it('closeOtherSheets 后持久化与内存一致', () => {
    openAgentSheet('peri')
    const keep = openToolSheet('search', '搜索')
    openToolSheet('history', '历史')
    useWorkspaceStore.getState().closeOtherSheets(keep)
    const memory = useWorkspaceStore.getState().workspaceSheets
    expect(memory.sheets.map(sheet => sheet.id).sort()).toEqual([keep])
    expect(readPersisted().state.sheets.map(sheet => sheet.id).sort()).toEqual([keep])
  })

  it('closeRightSheets 后持久化与内存一致', () => {
    const anchor = openAgentSheet('peri')
    openToolSheet('search', '搜索')
    const right = openToolSheet('history', '历史')
    // closeRightSheets(anchor) 关闭 anchor 右侧的 sheet（不含 anchor 本身）
    useWorkspaceStore.getState().closeRightSheets(anchor)
    const memory = useWorkspaceStore.getState().workspaceSheets
    expect(memory.sheets.some(sheet => sheet.id === right)).toBe(false)
    expect(memory.sheets.some(sheet => sheet.id === anchor)).toBe(true)
    expect(readPersisted().state.sheets.some(sheet => sheet.id === right)).toBe(false)
    expect(readPersisted().state.sheets.some(sheet => sheet.id === anchor)).toBe(true)
  })

  it('reopenSheet 后持久化与内存一致', () => {
    openAgentSheet('peri')
    const closed = openToolSheet('search', '搜索')
    useWorkspaceStore.getState().closeSheet(closed)
    const reopened = useWorkspaceStore.getState().reopenSheet()
    expect(reopened).not.toBeNull()
    expectPersistedMatchesMemory()
  })

  it('patchSheetMetadata 后持久化 metadata 与内存一致（基线：当前已正确）', () => {
    const id = openToolSheet('search', '搜索')
    useWorkspaceStore.getState().patchSheetMetadata(id, { activeFile: '/a/b.ts' })
    const memory = useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === id)
    const persisted = readPersisted().state.sheets.find(sheet => sheet.id === id)
    expect(memory?.metadata).toEqual({ activeFile: '/a/b.ts' })
    expect(persisted?.metadata).toEqual({ activeFile: '/a/b.ts' })
  })

  it('patchSheetState 经 workspace codec 更新并持久化 Agent 左栏整页状态', () => {
    const id = openAgentSheet('peri')
    useWorkspaceStore.getState().patchSheetState(id, { activePageId: 'builtin.sidebar.module.search' })
    const expected = { activePageId: 'builtin.sidebar.module.search' }
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === id)?.state).toEqual(expected)
    expect(readPersisted().state.sheets.find(sheet => sheet.id === id)?.state).toEqual(expected)

    useWorkspaceStore.getState().hydrateWorkspaceSheets(['peri'])
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === id)?.state).toEqual(expected)
  })

  it('上一代形状（折叠映射同住 Sheet 状态）经 codec 收敛：折叠不再出现在 Sheet 状态（零迁移，issue #202）', () => {
    const id = openAgentSheet('peri')
    useWorkspaceStore.getState().patchSheetState(id, { blockCollapsed: { 'builtin.sidebar.module.sessions': true }, activePageId: 'builtin.sidebar.module.search' })
    const expected = { activePageId: 'builtin.sidebar.module.search' }
    expect(readPersisted().state.sheets.find(sheet => sheet.id === id)?.state).toEqual(expected)

    useWorkspaceStore.getState().hydrateWorkspaceSheets(['peri'])
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === id)?.state).toEqual(expected)
  })

  it('旧模型的 sidebarMode 落盘值经 codec 收敛为空状态（零迁移）', () => {
    const id = openAgentSheet('peri')
    useWorkspaceStore.getState().patchSheetState(id, { sidebarMode: 'chat' })
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === id)?.state).toEqual({ activePageId: null })
  })

  it('#538 信封不再承载 layout：v3 键在场时旧 layout 残留被忽略、不踩 rail', () => {
    // 先让 rail 产生自己的 v3 持久化（writeBack），再预置带 layout 残留的旧 v2 信封
    useRightRailStore.getState().setLeftRailWidth(300)
    localStorage.setItem(KEY, JSON.stringify({
      version: 2,
      state: { sheets: [], activeSheetId: null, recentlyClosed: [], agentStates: {} },
      layout: { sidebarWidth: 480, sidebarCollapsed: true, rightPanelCollapsed: true },
    }))
    // v3 键在场 = rail 权威：hydrate 不得用信封残留踩掉 300
    useWorkspaceStore.getState().hydrateWorkspaceSheets()
    expect(useRightRailStore.getState().leftRailWidth).toBe(300)

    // 任意 action 后信封不含 layout 键，其余字段照常持久化
    openAgentSheet()
    expect('layout' in readPersisted()).toBe(false)
    expectPersistedMatchesMemory()
  })

  it('#538 升级缝：v3 键缺席时信封 legacy 残留播种一次并物化 v3 键（复查 R1-P1-2）', () => {
    // 跨版本升级用户：迁移标记已在、v3 键从未落盘，旧信封 layout 是其真实偏好。
    // 前序用例可能在同源存储留下 v3 键——本用例模拟「缺席」先摘除。
    railPersistStorage?.removeItem(RAIL_PERSIST_KEY)
    localStorage.setItem(KEY, JSON.stringify({
      version: 2,
      state: { sheets: [], activeSheetId: null, recentlyClosed: [], agentStates: {} },
      layout: { sidebarWidth: 480, sidebarCollapsed: true, rightPanelCollapsed: true },
    }))
    useWorkspaceStore.getState().hydrateWorkspaceSheets()
    expect(useRightRailStore.getState().leftRailWidth).toBe(480)
    expect(useRightRailStore.getState().leftRailCollapsed).toBe(true)
    // 播种必须经 writeBack 物化 v3 键（与 persist 同源存储）——否则重启后二次回落默认
    expect(railPersistStorage?.getItem(RAIL_PERSIST_KEY)).not.toBeNull()
    // 第二次 hydrate（v3 已在场）：不再被信封重播
    useWorkspaceStore.getState().hydrateWorkspaceSheets()
    expect(useRightRailStore.getState().leftRailWidth).toBe(480)
  })

  it('openSheet 后模拟重启（hydrate）不丢失最近操作（当前实现丢失）', () => {
    openAgentSheet('peri')
    openToolSheet('search', '搜索')
    const memSheets = useWorkspaceStore.getState().workspaceSheets.sheets.length
    expect(memSheets).toBe(2)
    // 模拟重启：从持久化重新 hydrate
    useWorkspaceStore.getState().hydrateWorkspaceSheets()
    const afterReload = useWorkspaceStore.getState().workspaceSheets.sheets.length
    expect(afterReload).toBe(memSheets)
  })

  it('写盘失败时内存操作继续且 lastPersistError 可见（报告 1A.5）', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage({ quotaExceeded: true }),
      configurable: true,
      writable: true,
    })
    openAgentSheet('peri')
    const state = useWorkspaceStore.getState()
    expect(state.workspaceSheets.sheets.length).toBe(1)
    expect(state.lastPersistError).not.toBeNull()
  })

  it('写盘恢复后 lastPersistError 清空', () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
    openAgentSheet('peri')
    expect(useWorkspaceStore.getState().lastPersistError).toBeNull()
    storage.setQuotaExceeded(true)
    openToolSheet('search', '搜索')
    expect(useWorkspaceStore.getState().lastPersistError).not.toBeNull()
    storage.setQuotaExceeded(false)
    openToolSheet('history', '历史')
    expect(useWorkspaceStore.getState().lastPersistError).toBeNull()
  })
})
